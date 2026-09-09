import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LoanRepaymentScheduleTab } from "../src/pages/dashboard/loans/LoanRepaymentScheduleTab";
import { api } from "../src/lib/api";
import i18n from "../src/lib/i18n";

vi.mock("../src/lib/api", () => ({ api: { get: vi.fn() } }));

describe("LoanRepaymentScheduleTab", () => {
    beforeEach(async () => { vi.clearAllMocks(); await i18n.changeLanguage("en"); });

    it("renders the backend-owned exact commission amount for each schedule row", async () => {
        vi.mocked(api.get).mockImplementation(async (url) => {
            if (url === "/loans/loan-1/schedule") return {
                data: [{ id: "schedule-1", publicId: "schedule-1", installmentNo: 1, dueDate: "2026-08-31", paidTotal: "10.00", remainingDue: "90.00", commissionAmount: "6.25", status: "partial" }],
            };
            if (url === "/loans/loan-1/schedule-summary") return {
                data: {
                    businessDate: "2026-08-31", totalInstallments: 1, deferralCount: 0,
                    paidInstallments: 0, overdueInstallments: 0, dueTodayInstallments: 1,
                    dueTodayAmount: "90.00", pendingInstallments: 1,
                },
            };
            if (url === "/loans/loan-1") return { data: { commissionSummary: { totalCommission: "6.25" } } };
            throw new Error(`Unexpected GET: ${url}`);
        });
        render(<LoanRepaymentScheduleTab loanPublicId="loan-1" />);

        const table = await screen.findByRole("table");
        expect(within(table).getByRole("columnheader", { name: "Commission" })).toBeInTheDocument();
        expect(within(table).getByText(/6\.25/)).toBeInTheDocument();
        expect(screen.getByText(/^1 installments · THB\s90\.00$/)).toBeInTheDocument();
    });
});
