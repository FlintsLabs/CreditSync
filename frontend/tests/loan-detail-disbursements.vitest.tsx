import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import LoanDetail from "../src/pages/dashboard/loans/LoanDetail";
import { api } from "../src/lib/api";

vi.mock("../src/lib/api", () => ({ api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }));

const LOAN_ID = "11111111-1111-4111-8111-111111111111";
const PROFILE_ID = "22222222-2222-4222-8222-222222222222";
const DISBURSEMENT_ID = "33333333-3333-4333-8333-333333333333";

const loan = {
    id: LOAN_ID, publicId: LOAN_ID, borrowerPublicId: null,
    principalAmount: "1000.00", interestRate: "0.00", repaymentType: "daily", termMonths: 1,
    installmentAmount: "120.00", totalInstallments: 10, startDate: "2026-08-10", nextDueDate: "2026-08-11",
    outstandingPrincipal: "1000.00", outstandingInterest: "200.00", outstandingFees: "0.00", status: "active",
    bankProfilePublicId: PROFILE_ID, bankLoanPublicId: null,
    dailyLoanCalculation: { durationUnit: "days", durationValue: 10, totalInstallments: 10, installmentAmount: "120.00", totalInterest: "200.00", dailyInterest: "20.00", flatDailyRatePercent: "2.0000" },
};

function renderDetail() {
    return render(<MemoryRouter initialEntries={[`/loans/${LOAN_ID}`]}><Routes><Route path="/loans/:id" element={<LoanDetail />} /></Routes></MemoryRouter>);
}

describe("LoanDetail disbursements", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(api.get).mockImplementation(async (url) => {
            if (url === `/loans/${LOAN_ID}`) return { data: loan };
            if (url === `/loans/${LOAN_ID}/schedule`) return { data: [] };
            if (url === `/loans/${LOAN_ID}/funding-allocations`) return { data: [] };
            if (url === `/loans/${LOAN_ID}/allocation-state`) return { data: { state: "funded", netAllocatedPrincipal: "1000.00", remainingGap: "0.00", overfundedAmount: "0.00" } };
            if (url === `/loans/${LOAN_ID}/disbursements`) return { data: { approvedPrincipal: "1000.00", netDisbursed: "0.00", variance: "-1000.00", status: "under_disbursed", items: [] } };
            throw new Error(`Unexpected GET ${url}`);
        });
    });

    it("shows fixed daily terms and identifies own capital without calling it a drawdown", async () => {
        renderDetail();

        expect(await screen.findByRole("heading", { name: /daily repayment terms/i })).toBeInTheDocument();
        expect(screen.getByText("Agreed instalment")).toBeInTheDocument();
        expect(screen.getByText("Own capital")).toBeInTheDocument();
        expect(screen.queryByText(/this loan has not been matched to any funding drawdown/i)).not.toBeInTheDocument();
    });

    it("creates a draft, only enables posting after a saved draft, and reverses a posted record with a reason", async () => {
        vi.mocked(api.post).mockImplementation(async (url, body) => {
            if (url === `/loans/${LOAN_ID}/disbursements`) return { data: { publicId: DISBURSEMENT_ID, status: "draft", ...body } };
            if (url === `/loans/${LOAN_ID}/disbursements/${DISBURSEMENT_ID}/post`) return { data: { publicId: DISBURSEMENT_ID, status: "posted" } };
            if (url === `/loans/${LOAN_ID}/disbursements/${DISBURSEMENT_ID}/reverse`) return { data: { publicId: DISBURSEMENT_ID, status: "reversed" } };
            throw new Error(`Unexpected POST ${url}`);
        });
        const user = userEvent.setup();
        renderDetail();

        await user.click(await screen.findByRole("button", { name: /add disbursement/i }));
        await user.clear(screen.getByLabelText(/gross amount/i));
        await user.type(screen.getByLabelText(/gross amount/i), "700.00");
        await user.clear(screen.getByLabelText(/attributed amount/i));
        await user.type(screen.getByLabelText(/attributed amount/i), "600.00");
        expect(screen.getByRole("button", { name: /save draft/i })).toBeDisabled();
        await user.type(screen.getByLabelText(/grouped transfer explanation/i), "Shared transfer");
        await user.click(screen.getByRole("button", { name: /save draft/i }));

        await waitFor(() => expect(api.post).toHaveBeenCalledWith(`/loans/${LOAN_ID}/disbursements`, expect.objectContaining({ grossAmount: "700.00", loanAttributedAmount: "600.00" })));
        expect(await screen.findByRole("button", { name: /post disbursement/i })).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: /post disbursement/i }));
        await waitFor(() => expect(api.post).toHaveBeenCalledWith(`/loans/${LOAN_ID}/disbursements/${DISBURSEMENT_ID}/post`, expect.any(Object)));
        expect(await screen.findByRole("button", { name: /reverse disbursement/i })).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /edit disbursement/i })).not.toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: /reverse disbursement/i }));
        await user.type(screen.getByLabelText(/reversal reason/i), "Transfer cancelled");
        await user.click(screen.getByRole("button", { name: /confirm reversal/i }));
        await waitFor(() => expect(api.post).toHaveBeenCalledWith(`/loans/${LOAN_ID}/disbursements/${DISBURSEMENT_ID}/reverse`, expect.objectContaining({ reason: "Transfer cancelled" })));
    });
});
