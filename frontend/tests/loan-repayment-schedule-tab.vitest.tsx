import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LoanRepaymentScheduleTab } from "../src/pages/dashboard/loans/LoanRepaymentScheduleTab";
import { api } from "../src/lib/api";
import i18n from "../src/lib/i18n";

vi.mock("../src/lib/api", () => ({ api: { get: vi.fn() } }));

describe("LoanRepaymentScheduleTab", () => {
    beforeEach(async () => { vi.clearAllMocks(); await i18n.changeLanguage("en"); });

    it("renders the backend-owned exact commission amount for each schedule row", async () => {
        vi.mocked(api.get).mockImplementation(async (url) => url.endsWith("/schedule")
            ? { data: [{ id: "schedule-1", publicId: "schedule-1", installmentNo: 1, dueDate: "2026-08-31", remainingDue: "90.00", commissionAmount: "6.25", status: "partial" }] }
            : { data: { commissionSummary: { totalCommission: "6.25" } } });
        render(<LoanRepaymentScheduleTab loanPublicId="loan-1" />);

        const table = await screen.findByRole("table");
        expect(within(table).getByRole("columnheader", { name: "Commission" })).toBeInTheDocument();
        expect(within(table).getByText(/6\.25/)).toBeInTheDocument();
    });
});
