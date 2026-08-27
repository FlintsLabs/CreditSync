import { describe, expect, test } from "bun:test";
import { buildDashboardCollectionSummary } from "./dashboard-collection-summary-service";

describe("dashboard collection summary", () => {
    test("groups only amounts due today by repayment cadence and active collection intermediary", () => {
        const summary = buildDashboardCollectionSummary({
            businessDate: "2026-08-11",
            loans: [
                { loanId: 1, loanPublicId: "loan-float-day", borrowerName: "Floating Daily", repaymentType: "floating", interestPeriodUnit: "day", floatingAccrualCycle: "daily", dueTodayAmount: "75.00" },
                { loanId: 2, loanPublicId: "loan-float-week", borrowerName: "Floating Weekly", repaymentType: "floating", interestPeriodUnit: "week", floatingAccrualCycle: "weekly", dueTodayAmount: "200.00" },
                { loanId: 3, loanPublicId: "loan-daily", borrowerName: "Daily Installment", repaymentType: "daily", dueTodayAmount: "120.00" },
                { loanId: 4, loanPublicId: "loan-weekly", borrowerName: "Weekly Installment", repaymentType: "weekly", dueTodayAmount: "140.00" },
                { loanId: 5, loanPublicId: "loan-monthly", borrowerName: "Monthly Installment", repaymentType: "monthly", dueTodayAmount: "100.00" },
                { loanId: 6, loanPublicId: "loan-other", borrowerName: "Single Payment", repaymentType: "single_payment", dueTodayAmount: "90.00" },
                { loanId: 7, loanPublicId: "loan-overdue", borrowerName: "Overdue Only", repaymentType: "daily", dueTodayAmount: "0.00" },
            ],
            assignments: [
                { loanId: 3, intermediaryPublicId: "agent-alice", intermediaryName: "Alice", role: "collection", status: "active", effectiveFrom: "2026-08-01", effectiveTo: null },
                { loanId: 4, intermediaryPublicId: "agent-bob", intermediaryName: "Bob", role: "both", status: "active", effectiveFrom: "2026-08-01", effectiveTo: null },
                { loanId: 5, intermediaryPublicId: "agent-charlie", intermediaryName: "Charlie", role: "disbursement", status: "active", effectiveFrom: "2026-08-01", effectiveTo: null },
                { loanId: 6, intermediaryPublicId: "agent-ended", intermediaryName: "Ended", role: "collection", status: "ended", effectiveFrom: "2026-08-01", effectiveTo: "2026-08-10" },
            ],
        });

        expect(summary.totalDueToday).toBe("725.00");
        expect(summary.categories).toEqual([
            { key: "floating_daily_interest", totalDueToday: "75.00", items: [{ loanPublicId: "loan-float-day", borrowerName: "Floating Daily", dueTodayAmount: "75.00" }] },
            { key: "floating_weekly_interest", totalDueToday: "200.00", items: [{ loanPublicId: "loan-float-week", borrowerName: "Floating Weekly", dueTodayAmount: "200.00" }] },
            { key: "daily_installment", totalDueToday: "120.00", items: [{ loanPublicId: "loan-daily", borrowerName: "Daily Installment", dueTodayAmount: "120.00" }] },
            { key: "weekly_installment", totalDueToday: "140.00", items: [{ loanPublicId: "loan-weekly", borrowerName: "Weekly Installment", dueTodayAmount: "140.00" }] },
            { key: "monthly_installment", totalDueToday: "100.00", items: [{ loanPublicId: "loan-monthly", borrowerName: "Monthly Installment", dueTodayAmount: "100.00" }] },
            { key: "other", totalDueToday: "90.00", items: [{ loanPublicId: "loan-other", borrowerName: "Single Payment", dueTodayAmount: "90.00" }] },
        ]);
        expect(summary.intermediaries).toEqual([
            { intermediaryPublicId: "agent-bob", intermediaryName: "Bob", totalDueToday: "140.00", items: [{ loanPublicId: "loan-weekly", borrowerName: "Weekly Installment", dueTodayAmount: "140.00" }] },
            { intermediaryPublicId: "agent-alice", intermediaryName: "Alice", totalDueToday: "120.00", items: [{ loanPublicId: "loan-daily", borrowerName: "Daily Installment", dueTodayAmount: "120.00" }] },
        ]);
    });
});
