import { createElement } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BorrowerQueueMeta } from "../src/pages/dashboard/Dashboard";
import { buildBorrowerRepaymentHref, buildDashboardPriorities, compareMoney, type BorrowerDueItem, type DashboardInputs } from "../src/pages/dashboard/dashboard-model";
import i18n from "../src/lib/i18n";

const input: DashboardInputs = {
    summary: {
        dueFromBorrowersToday: "9007199254740993.01",
        dueToFundsToday: "0.02",
        netPositionToday: "9007199254740992.99",
        overdueBorrowerCount: 3,
        overdueFundCount: 2,
        underfundedLoanCount: 4,
        unallocatedDrawdownCount: 1,
    },
    reconciliation: {
        unreconciledBorrowerPayments: 0,
        recordedFundRepayments: 8,
        fundRepaymentsMissingScheduleLink: 5,
        pendingBankImports: 0,
        pendingManualReviews: 6,
        borrowerPaymentsMissingSlip: 7,
    },
};

describe("dashboard command center model", () => {
    it("orders only actionable priorities by operational severity", () => {
        expect(buildDashboardPriorities(input).map((item) => [item.key, item.count, item.href])).toEqual([
            ["overdueBorrowers", 3, "/transactions/new"],
            ["overdueFunds", 2, "/funds"],
            ["underfundedLoans", 4, "/matching"],
            ["missingFundSchedule", 5, "/reconciliation"],
            ["unallocatedDrawdowns", 1, "/funds"],
            ["pendingReviews", 6, "/payments"],
            ["missingSlips", 7, "/payments"],
        ]);
    });

    it("compares exact decimal strings beyond the JavaScript safe integer range", () => {
        expect(compareMoney("9007199254740993.01", "9007199254740993.00")).toBe(1);
        expect(compareMoney("-0.01", "0.00")).toBe(-1);
    });

    it("omits scheduleId from floating repayment navigation", () => {
        const floating: BorrowerDueItem = {
            scheduleId: null, dueDate: null, remainingDue: "375.00", totalDueNow: "375.00",
            overdueItemCount: 4, overdueDays: 4, status: "overdue", installmentNo: null,
            loanId: 7, loanPublicId: "loan-public-id", borrowerName: "Floating Borrower", repaymentType: "floating",
        };
        const scheduled: BorrowerDueItem = {
            ...floating, scheduleId: 8, schedulePublicId: "schedule-public-id", dueDate: "2026-08-10",
            installmentNo: 1, repaymentType: "daily",
        };

        expect(buildBorrowerRepaymentHref(floating)).toBe("/transactions/new?loanId=loan-public-id");
        expect(buildBorrowerRepaymentHref(scheduled)).toBe("/transactions/new?loanId=loan-public-id&scheduleId=schedule-public-id");
    });

    it("renders one floating row with its overdue item count and maximum age", async () => {
        await i18n.changeLanguage("th");
        const floating: BorrowerDueItem = {
            scheduleId: null, dueDate: null, remainingDue: "375.00", totalDueNow: "375.00",
            overdueItemCount: 4, overdueDays: 4, status: "overdue", installmentNo: null,
            loanId: 7, loanPublicId: "loan-public-id", borrowerName: "Floating Borrower", repaymentType: "floating",
        };

        render(createElement(BorrowerQueueMeta, { item: floating }));

        expect(screen.getByText("ค้าง 4 รายการ")).toBeInTheDocument();
        expect(screen.getByText("สูงสุด 4 วัน")).toBeInTheDocument();
    });
});
