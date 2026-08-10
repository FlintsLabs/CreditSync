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
    // Break caught: today's installment is merged into arrears or arrears lose precedence.
    test("separates due-now installments from overdue installments", () => {
        expect(computeLoanPaymentHealth({
            ...base,
            schedules: [
                { dueDate: "2026-08-10", remainingDue: "125.25", paidPenalty: "0.00", baseStatus: "partial" },
                { dueDate: "2026-08-11", remainingDue: "50.10", paidPenalty: "0.00", baseStatus: "pending" },
            ],
        })).toEqual({
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
        })).toEqual({
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
        })).toEqual({
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

        expect(computeLoanPaymentHealth({ ...floating, businessDate: "2026-08-11", accruals })).toEqual({
            status: "due_today",
            dueTodayAmount: "15.00",
            overdueAmount: "0.00",
            overdueItemCount: 0,
            maxOverdueDays: 0,
        });
        expect(computeLoanPaymentHealth({ ...floating, businessDate: "2026-08-12", accruals })).toEqual({
            status: "overdue",
            dueTodayAmount: "0.00",
            overdueAmount: "15.00",
            overdueItemCount: 1,
            maxOverdueDays: 1,
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
        })).toEqual({
            status: "overdue",
            dueTodayAmount: "0.00",
            overdueAmount: "7.50",
            overdueItemCount: 1,
            maxOverdueDays: 2,
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
        expect(computeLoanPaymentHealth({ ...base, lifecycleStatus: "paid" })).toEqual({
            status: "settled",
            dueTodayAmount: "0.00",
            overdueAmount: "0.00",
            overdueItemCount: 0,
            maxOverdueDays: 0,
        });
    });
});
