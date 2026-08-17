import type Decimal from "decimal.js";
import { FinancialDecimal } from "./financial-decimal";

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
        dueDate?: string | null;
        periodEndDate?: string | null;
        interestAmount: string;
        paidAmount: string;
        penaltyDue?: string;
        status: string;
    }>;
}

const zero = () => new FinancialDecimal(0);

function calendarDays(from: string, to: string) {
    const start = Date.parse(`${from}T00:00:00Z`);
    const end = Date.parse(`${to}T00:00:00Z`);
    return Math.max(0, Math.floor((end - start) / 86_400_000));
}

function money(value: Decimal) {
    return value.toDecimalPlaces(2, FinancialDecimal.ROUND_HALF_UP).toFixed(2);
}

function scheduledPenalty(input: LoanPaymentHealthInput, remainingDue: Decimal, overdueDays: number, paidPenalty: Decimal) {
    if (remainingDue.lte(0) || overdueDays <= 0) return zero();

    const lateFeeMode = input.lateFeeMode ?? "none";
    const lateFeeAmount = new FinancialDecimal(input.lateFeeAmount ?? "0");
    let accrued = zero();
    if (lateFeeMode === "fixed" || lateFeeMode === "fixed_plus_percent") {
        accrued = accrued.plus(lateFeeAmount);
    }
    if (lateFeeMode === "daily_percent" || lateFeeMode === "fixed_plus_percent") {
        accrued = accrued.plus(remainingDue.times(lateFeeAmount).div(100).times(overdueDays));
    }
    return FinancialDecimal.max(accrued.toDecimalPlaces(2, FinancialDecimal.ROUND_HALF_UP).minus(paidPenalty), 0);
}

export function computeScheduledOutstandingPenalty(
    input: Pick<
        LoanPaymentHealthInput,
        "businessDate" | "gracePeriodDays" | "lateFeeMode" | "lateFeeAmount" | "schedules"
    >,
): string {
    const gracePeriodDays = Math.max(0, input.gracePeriodDays ?? 0);
    const total = input.schedules.reduce((sum, schedule) => {
        const remainingDue = FinancialDecimal.max(new FinancialDecimal(schedule.remainingDue), 0);
        if (remainingDue.isZero() || schedule.dueDate > input.businessDate) return sum;
        const overdueDays = Math.max(0, calendarDays(schedule.dueDate, input.businessDate) - gracePeriodDays);
        return sum.plus(scheduledPenalty(
            { ...input, lifecycleStatus: "active", repaymentType: "scheduled", accruals: [] },
            remainingDue,
            overdueDays,
            new FinancialDecimal(schedule.paidPenalty),
        ));
    }, zero());
    return money(total);
}

export function computeLoanPaymentHealth(input: LoanPaymentHealthInput): LoanPaymentHealth {
    let dueNow = zero();
    let overdue = zero();
    let overdueItemCount = 0;
    let maxOverdueDays = 0;
    let accruingInterest = zero();

    if (input.repaymentType === "floating") {
        const payableByDueDate = new Map<string, { interest: Decimal; penalty: Decimal }>();
        for (const accrual of input.accruals) {
            if (accrual.status === "reversed" || accrual.accrualDate > input.businessDate) continue;
            const unpaid = FinancialDecimal.max(new FinancialDecimal(accrual.interestAmount).minus(accrual.paidAmount), 0);
            const penalty = FinancialDecimal.max(new FinancialDecimal(accrual.penaltyDue ?? "0"), 0);
            if (accrual.status === "accruing") {
                accruingInterest = accruingInterest.plus(unpaid);
                continue;
            }
            const dueDate = accrual.dueDate
                ?? (["accrued", "partial"].includes(accrual.status)
                    ? accrual.accrualDate
                    : accrual.periodEndDate ?? accrual.accrualDate);
            if ((unpaid.isZero() && penalty.isZero()) || dueDate > input.businessDate) continue;
            const current = payableByDueDate.get(dueDate) ?? { interest: zero(), penalty: zero() };
            payableByDueDate.set(dueDate, {
                interest: current.interest.plus(unpaid),
                penalty: current.penalty.plus(penalty),
            });
        }
        for (const [dueDate, payable] of payableByDueDate) {
            const amount = payable.interest.plus(payable.penalty);
            if (dueDate === input.businessDate) {
                dueNow = dueNow.plus(amount);
                continue;
            }
            const overdueDays = calendarDays(dueDate, input.businessDate);
            overdue = overdue.plus(amount);
            overdueItemCount += 1;
            maxOverdueDays = Math.max(maxOverdueDays, overdueDays);
        }
    } else {
        const gracePeriodDays = Math.max(0, input.gracePeriodDays ?? 0);
        for (const schedule of input.schedules) {
            const remainingDue = FinancialDecimal.max(new FinancialDecimal(schedule.remainingDue), 0);
            if (remainingDue.isZero() || schedule.dueDate > input.businessDate) continue;

            const overdueDays = Math.max(0, calendarDays(schedule.dueDate, input.businessDate) - gracePeriodDays);
            const penalty = scheduledPenalty(input, remainingDue, overdueDays, new FinancialDecimal(schedule.paidPenalty));
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
