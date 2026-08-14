import Decimal from "decimal.js";

export type LoanPaymentHealthStatus = "current" | "due_today" | "overdue" | "settled";

export interface LoanPaymentHealth {
    status: LoanPaymentHealthStatus;
    dueTodayAmount: string;
    overdueAmount: string;
    overdueItemCount: number;
    maxOverdueDays: number;
    accruingInterestAmount?: string;
}

export interface LoanPaymentHealthInput {
    lifecycleStatus: string;
    repaymentType: string;
    businessDate: string;
    gracePeriodDays?: number | null;
    lateFeeMode?: string | null;
    lateFeeAmount?: string | null;
    schedules: Array<{
        dueDate: string;
        remainingDue: string;
        paidPenalty: string;
        baseStatus: string;
    }>;
    accruals: Array<{
        accrualDate: string;
        periodEndDate?: string | null;
        interestAmount: string;
        paidAmount: string;
        penaltyDue?: string;
        status: string;
    }>;
}

const zero = () => new Decimal(0);

function calendarDays(from: string, to: string) {
    const start = Date.parse(`${from}T00:00:00Z`);
    const end = Date.parse(`${to}T00:00:00Z`);
    return Math.max(0, Math.floor((end - start) / 86_400_000));
}

function money(value: Decimal) {
    return value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

function scheduledPenalty(input: LoanPaymentHealthInput, remainingDue: Decimal, overdueDays: number, paidPenalty: Decimal) {
    if (remainingDue.lte(0) || overdueDays <= 0) return zero();

    const lateFeeMode = input.lateFeeMode ?? "none";
    const lateFeeAmount = new Decimal(input.lateFeeAmount ?? "0");
    let accrued = zero();
    if (lateFeeMode === "fixed" || lateFeeMode === "fixed_plus_percent") {
        accrued = accrued.plus(lateFeeAmount);
    }
    if (lateFeeMode === "daily_percent" || lateFeeMode === "fixed_plus_percent") {
        accrued = accrued.plus(remainingDue.times(lateFeeAmount).div(100).times(overdueDays));
    }
    return Decimal.max(accrued.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).minus(paidPenalty), 0);
}

export function computeLoanPaymentHealth(input: LoanPaymentHealthInput): LoanPaymentHealth {
    let dueNow = zero();
    let overdue = zero();
    let overdueItemCount = 0;
    let maxOverdueDays = 0;
    let accruingInterest = zero();

    if (input.repaymentType === "floating") {
        const payableByDueDate = new Map<string, Decimal>();
        for (const accrual of input.accruals) {
            if (["reversed", "paid", "accruing"].includes(accrual.status)) continue;
            const unpaid = Decimal.max(new Decimal(accrual.interestAmount).minus(accrual.paidAmount), 0);
            const dueDate = ["accrued", "partial"].includes(accrual.status)
                ? accrual.accrualDate
                : accrual.periodEndDate ?? accrual.accrualDate;
            if (unpaid.isZero() || dueDate > input.businessDate) continue;
            payableByDueDate.set(dueDate, (payableByDueDate.get(dueDate) ?? zero()).plus(unpaid));
        }
        for (const [dueDate, unpaid] of payableByDueDate) {
            if (dueDate === input.businessDate) {
                dueNow = dueNow.plus(unpaid);
                continue;
            }
            const overdueDays = calendarDays(dueDate, input.businessDate);
            overdue = overdue.plus(unpaid);
            overdueItemCount += 1;
            maxOverdueDays = Math.max(maxOverdueDays, overdueDays);
        }
    } else {
        const gracePeriodDays = Math.max(0, input.gracePeriodDays ?? 0);
        for (const schedule of input.schedules) {
            const remainingDue = Decimal.max(new Decimal(schedule.remainingDue), 0);
            if (remainingDue.isZero() || schedule.dueDate > input.businessDate) continue;

            const overdueDays = Math.max(0, calendarDays(schedule.dueDate, input.businessDate) - gracePeriodDays);
            const penalty = scheduledPenalty(input, remainingDue, overdueDays, new Decimal(schedule.paidPenalty));
            const totalDue = remainingDue.plus(penalty);
            if (overdueDays > 0) {
                overdue = overdue.plus(totalDue);
                overdueItemCount += 1;
                maxOverdueDays = Math.max(maxOverdueDays, overdueDays);
            } else {
                dueNow = dueNow.plus(totalDue);
            }
        }
    }

    const status: LoanPaymentHealthStatus = overdue.gt(0)
        ? "overdue"
        : dueNow.gt(0)
            ? "due_today"
            : ["paid", "closed"].includes(input.lifecycleStatus)
                ? "settled"
                : "current";

    const health: LoanPaymentHealth = {
        status,
        dueTodayAmount: money(dueNow),
        overdueAmount: money(overdue),
        overdueItemCount,
        maxOverdueDays,
    };
    if (input.repaymentType === "floating" && input.accruals.some((row) => ["accruing", "due", "partially_paid"].includes(row.status))) {
        health.accruingInterestAmount = money(accruingInterest);
    }
    return health;
}
