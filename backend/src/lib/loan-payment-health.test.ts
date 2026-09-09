import { describe, expect, test } from "bun:test";
import { computeLoanPaymentHealth, type LoanPaymentHealthInput } from "./loan-payment-health";

const base: LoanPaymentHealthInput = {
    lifecycleStatus: "active",
    repaymentType: "daily",
    businessDate: "2026-08-11",
    gracePeriodDays: 0,
    lateFeeMode: "none",
    lateFeeAmount: "0.00",
    schedules: [],
    accruals: [],
};

describe("computeLoanPaymentHealth", () => {
    test("reports daily and weekly floating overdue obligation semantics", () => {
        const daily = computeLoanPaymentHealth({
            ...base,
            repaymentType: "floating",
            overdueObligationUnit: "day",
            businessDate: "2026-08-13",
            accruals: [
                { accrualDate: "2026-08-10", interestAmount: "15.00", paidAmount: "0.00", status: "accrued" },
                { accrualDate: "2026-08-11", interestAmount: "15.00", paidAmount: "0.00", status: "accrued" },
            ],
        });
        const weekly = computeLoanPaymentHealth({
            ...base,
            repaymentType: "floating",
            overdueObligationUnit: "week",
            businessDate: "2026-08-13",
            accruals: [
                { accrualDate: "2026-07-20", dueDate: "2026-07-27", periodEndDate: "2026-07-27", interestAmount: "600.00", paidAmount: "0.00", status: "due" },
                { accrualDate: "2026-07-21", dueDate: "2026-07-27", periodEndDate: "2026-07-27", interestAmount: "0.00", paidAmount: "0.00", status: "due" },
                { accrualDate: "2026-07-28", dueDate: "2026-08-04", periodEndDate: "2026-08-04", interestAmount: "600.00", paidAmount: "0.00", status: "due" },
                { accrualDate: "2026-08-05", dueDate: "2026-08-12", periodEndDate: "2026-08-12", interestAmount: "600.00", paidAmount: "0.00", status: "due" },
            ],
        });

        expect(daily).toMatchObject({ overdueAmount: "30.00", overdueObligationUnit: "day", overdueObligationCount: 2 });
        expect(weekly).toMatchObject({ overdueAmount: "1800.00", overdueObligationUnit: "week", overdueObligationCount: 3, maxOverdueDays: 17 });
    });

    // Break caught: today's installment is merged into arrears or arrears lose precedence.
    test("separates due-now installments from overdue installments", () => {
        expect(computeLoanPaymentHealth({
            ...base,
            schedules: [
                { dueDate: "2026-08-10", remainingDue: "125.25", paidPenalty: "0.00", baseStatus: "partial" },
                { dueDate: "2026-08-11", remainingDue: "50.10", paidPenalty: "0.00", baseStatus: "pending" },
            ],
        })).toMatchObject({
            status: "overdue",
            dueTodayAmount: "50.10",
            overdueAmount: "125.25",
            overdueItemCount: 1,
            maxOverdueDays: 1,
        });
    });

    // Break caught: a grace-period installment is marked overdue before its effective boundary.
    test("keeps an unpaid installment due-now while it is inside grace", () => {
        expect(computeLoanPaymentHealth({
            ...base,
            gracePeriodDays: 2,
            schedules: [
                { dueDate: "2026-08-10", remainingDue: "80.00", paidPenalty: "0.00", baseStatus: "pending" },
            ],
        })).toMatchObject({
            status: "due_today",
            dueTodayAmount: "80.00",
            overdueAmount: "0.00",
            overdueItemCount: 0,
            maxOverdueDays: 0,
        });
    });

    // Break caught: Number conversion loses cents when large overdue rows and fixed penalties are summed.
    test("aggregates overdue money exactly beyond Number safe integer range", () => {
        expect(computeLoanPaymentHealth({
            ...base,
            lateFeeMode: "fixed",
            lateFeeAmount: "0.10",
            schedules: [
                { dueDate: "2026-08-09", remainingDue: "9007199254740993.01", paidPenalty: "0.00", baseStatus: "pending" },
                { dueDate: "2026-08-10", remainingDue: "0.20", paidPenalty: "0.00", baseStatus: "pending" },
            ],
        })).toMatchObject({
            status: "overdue",
            dueTodayAmount: "0.00",
            overdueAmount: "9007199254740993.41",
            overdueItemCount: 2,
            maxOverdueDays: 2,
        });
    });

    // Break caught: paid penalty is ignored or daily-percent penalty drifts in binary floating point.
    test("subtracts paid daily-percent penalties exactly", () => {
        expect(computeLoanPaymentHealth({
            ...base,
            businessDate: "2026-08-13",
            lateFeeMode: "daily_percent",
            lateFeeAmount: "0.10",
            schedules: [
                { dueDate: "2026-08-10", remainingDue: "1000.00", paidPenalty: "1.00", baseStatus: "partial" },
            ],
        })).toMatchObject({ status: "overdue", overdueAmount: "1002.00", maxOverdueDays: 3 });
    });

    // Break caught: floating interest is labeled overdue on the same Bangkok business date.
    test("marks floating interest overdue only from the following Bangkok date", () => {
        const floating = { ...base, repaymentType: "floating", schedules: [] };
        const accruals = [
            { accrualDate: "2026-08-11", interestAmount: "15.00", paidAmount: "0.00", status: "accrued" },
        ];

        expect(computeLoanPaymentHealth({ ...floating, businessDate: "2026-08-11", accruals })).toMatchObject({
            status: "due_today",
            dueTodayAmount: "15.00",
            overdueAmount: "0.00",
            overdueItemCount: 0,
            maxOverdueDays: 0,
        });
        expect(computeLoanPaymentHealth({ ...floating, businessDate: "2026-08-12", accruals })).toMatchObject({
            status: "overdue",
            dueTodayAmount: "0.00",
            overdueAmount: "15.00",
            overdueItemCount: 1,
            maxOverdueDays: 1,
        });
    });

    // Break caught: legacy daily rows backfilled with period metadata move their payable date one day later.
    test("uses the accrual date for legacy accrued rows even when backfill added a period end", () => {
        expect(computeLoanPaymentHealth({
            ...base,
            repaymentType: "floating",
            businessDate: "2026-08-11",
            schedules: [],
            accruals: [{
                accrualDate: "2026-08-11",
                periodEndDate: "2026-08-12",
                interestAmount: "15.00",
                paidAmount: "0.00",
                status: "accrued",
            }],
        })).toMatchObject({
            status: "due_today",
            dueTodayAmount: "15.00",
            overdueAmount: "0.00",
            overdueItemCount: 0,
            maxOverdueDays: 0,
        });
    });

    // Break caught: seven daily snapshots for one weekly obligation are counted as seven overdue items or become due before the weekly boundary.
    test("groups a completed weekly period at its due boundary and skips the current accruing period", () => {
        const weekly = { ...base, repaymentType: "floating", overdueObligationUnit: "week" as const, schedules: [] };
        const duePeriod = ["85.71", "85.72", "85.71", "85.72", "85.71", "85.72", "85.71"].map((interestAmount, index) => ({
            accrualDate: `2026-08-${String(13 + index).padStart(2, "0")}`,
            periodEndDate: "2026-08-20",
            interestAmount,
            paidAmount: "0.00",
            status: "due",
        }));
        const currentPeriod = [{
            accrualDate: "2026-08-20",
            periodEndDate: "2026-08-27",
            interestAmount: "85.71",
            paidAmount: "0.00",
            status: "accruing",
        }];

        expect(computeLoanPaymentHealth({ ...weekly, businessDate: "2026-08-20", accruals: [...duePeriod, ...currentPeriod] })).toMatchObject({
            status: "due_today",
            dueTodayAmount: "600.00",
            overdueAmount: "0.00",
            overdueItemCount: 0,
            maxOverdueDays: 0,
            accruingInterestAmount: "85.71",
        });
        expect(computeLoanPaymentHealth({ ...weekly, businessDate: "2026-08-21", accruals: [...duePeriod, ...currentPeriod] })).toMatchObject({
            status: "overdue",
            dueTodayAmount: "0.00",
            overdueAmount: "600.00",
            overdueItemCount: 1,
            maxOverdueDays: 1,
            accruingInterestAmount: "85.71",
        });
    });

    // Break caught: paid/partial accruals use gross interest rather than their exact unpaid remainder.
    test("counts only positive unpaid floating accrual remainders", () => {
        expect(computeLoanPaymentHealth({
            ...base,
            repaymentType: "floating",
            schedules: [],
            accruals: [
                { accrualDate: "2026-08-09", interestAmount: "12.00", paidAmount: "4.50", status: "partial" },
                { accrualDate: "2026-08-10", interestAmount: "10.00", paidAmount: "10.00", status: "paid" },
            ],
        })).toMatchObject({
            status: "overdue",
            dueTodayAmount: "0.00",
            overdueAmount: "7.50",
            overdueItemCount: 1,
            maxOverdueDays: 2,
        });
    });

    // Break caught: an append-only reversed accrual is counted alongside its active replacement on Dashboard.
    test("excludes reversed floating accruals from payable health", () => {
        expect(computeLoanPaymentHealth({
            ...base,
            repaymentType: "floating",
            businessDate: "2026-08-12",
            schedules: [],
            accruals: [
                { accrualDate: "2026-08-12", interestAmount: "59.10", paidAmount: "0.00", status: "reversed" },
                { accrualDate: "2026-08-12", interestAmount: "60.00", paidAmount: "0.00", status: "accrued" },
            ],
        })).toMatchObject({
            status: "due_today",
            dueTodayAmount: "60.00",
            overdueAmount: "0.00",
            overdueItemCount: 0,
            maxOverdueDays: 0,
        });
    });

    // Break caught: outstanding floating principal is treated as overdue without a dated payable accrual.
    test("does not invent floating arrears from principal alone", () => {
        expect(computeLoanPaymentHealth({ ...base, repaymentType: "floating" })).toMatchObject({
            status: "current",
            dueTodayAmount: "0.00",
            overdueAmount: "0.00",
        });
    });

    // Break caught: a fully paid lifecycle remains current rather than receiving the settled health state.
    test("returns settled only for a settled lifecycle with no payable amount", () => {
        expect(computeLoanPaymentHealth({ ...base, lifecycleStatus: "paid" })).toMatchObject({
            status: "settled",
            dueTodayAmount: "0.00",
            overdueAmount: "0.00",
            overdueItemCount: 0,
            maxOverdueDays: 0,
        });
    });

    test("returns settled for a renewed lifecycle even when legacy schedules remain open", () => {
        expect(computeLoanPaymentHealth({
            ...base,
            lifecycleStatus: "renewed",
            businessDate: "2026-08-24",
            schedules: [
                { dueDate: "2026-08-22", remainingDue: "380.00", paidPenalty: "0.00", baseStatus: "pending" },
            ],
        })).toMatchObject({
            status: "settled",
            dueTodayAmount: "0.00",
            overdueAmount: "0.00",
            overdueItemCount: 0,
            maxOverdueDays: 0,
        });
    });
});
