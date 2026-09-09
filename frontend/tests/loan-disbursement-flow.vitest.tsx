import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import LoanDetail from "../src/pages/dashboard/loans/LoanDetail";
import { LoanDisbursements } from "../src/pages/dashboard/loans/LoanDisbursements";
import { api, resolveFileAccess } from "../src/lib/api";

vi.mock("../src/lib/api", () => ({ api: { get: vi.fn(), post: vi.fn(), put: vi.fn() }, resolveFileAccess: vi.fn() }));

const LOAN_ID = "11111111-1111-4111-8111-111111111111";
const EVENT_ID = "33333333-3333-4333-8333-333333333333";
const REVERSAL_ID = "44444444-4444-4444-8444-444444444444";
const FILE_ID = "55555555-5555-4555-8555-555555555555";
const loan = { id: LOAN_ID, publicId: LOAN_ID, borrowerPublicId: null, principalAmount: "1000.00", interestRate: "0.00", repaymentType: "daily", termMonths: 1, installmentAmount: "120.00", totalInstallments: 10, startDate: "2026-08-10", nextDueDate: null, outstandingPrincipal: "1000.00", outstandingInterest: "200.00", outstandingFees: "0.00", status: "active", bankProfilePublicId: null, bankLoanPublicId: null, dailyLoanCalculation: { durationUnit: "days", durationValue: 10, totalInstallments: 10, installmentAmount: "120.00", totalInterest: "200.00", dailyInterest: "20.00", flatDailyRatePercent: "2.0000" } };

function ledger(events = [{ publicId: EVENT_ID, status: "posted", grossAmount: "700.00", loanAttributedAmount: "600.00", channel: "bank_transfer", sourceBankProfilePublicId: "66666666-6666-4666-8666-666666666666", payeeHint: "Borrower wallet", note: "Shared transfer", disbursedAt: "2026-08-10T10:00:00.000Z", evidenceFilePublicIds: [FILE_ID] }]) {
    return { loanPublicId: LOAN_ID, summary: { approvedPrincipal: "1000.00", netDisbursed: "600.00", variance: "-400.00", status: "under_disbursed" }, events };
}
function renderDetail() { return render(<MemoryRouter initialEntries={[`/loans/${LOAN_ID}`]}><Routes><Route path="/loans/:id" element={<LoanDetail />} /></Routes></MemoryRouter>); }

describe("loan disbursement view", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(api.get).mockImplementation(async (url) => {
            if (url === `/loans/${LOAN_ID}`) return { data: loan };
            if (url === `/loans/${LOAN_ID}/schedule` || url === `/loans/${LOAN_ID}/funding-allocations`) return { data: [] };
            if (url === `/loans/${LOAN_ID}/allocation-state`) return { data: { state: "unallocated", netAllocatedPrincipal: "0.00", remainingGap: "1000.00", overfundedAmount: "0.00" } };
            if (url === `/loans/${LOAN_ID}/disbursements`) return { data: ledger() };
            throw new Error(`Unexpected GET ${url}`);
        });
    });

    it("resolves a public evidence UUID only after opening the in-page preview", async () => {
        vi.mocked(api.get).mockImplementation(async (url) => {
            if (url === `/loans/${LOAN_ID}`) return { data: loan };
            if (url === `/loans/${LOAN_ID}/schedule` || url === `/loans/${LOAN_ID}/funding-allocations`) return { data: [] };
            if (url === `/loans/${LOAN_ID}/allocation-state`) return { data: { state: "unallocated", netAllocatedPrincipal: "0.00", remainingGap: "1000.00", overfundedAmount: "0.00" } };
            if (url === `/loans/${LOAN_ID}/disbursements`) return { data: ledger() };
            throw new Error(`Unexpected GET ${url}`);
        });
        vi.mocked(resolveFileAccess).mockResolvedValue({ url: "https://signed.example/evidence", mimeType: "image/png" });
        renderDetail();
        expect((await screen.findAllByText(/THB\s*600\.00/)).length).toBeGreaterThan(0);
        expect(screen.getByText("Borrower wallet")).toBeInTheDocument();
        expect(screen.getByText(/66666666-6666-4666-8666-666666666666/)).toBeInTheDocument();
        expect(resolveFileAccess).not.toHaveBeenCalled();
        await userEvent.setup().click(screen.getByRole("button", { name: /preview evidence/i }));
        await waitFor(() => expect(resolveFileAccess).toHaveBeenCalledWith(FILE_ID));
        expect(await screen.findByRole("img", { name: /preview evidence/i })).toHaveAttribute("src", "https://signed.example/evidence");
    });

    it("posts a draft with an Idempotency-Key and refreshes the posted summary", async () => {
        const draft = { ...ledger().events[0], status: "draft", evidenceFilePublicIds: [] };
        let reads = 0;
        vi.mocked(api.get).mockImplementation(async (url) => {
            if (url === `/loans/${LOAN_ID}/disbursements`) {
                reads += 1;
                return { data: reads === 1 ? ledger([draft]) : { ...ledger([{ ...draft, status: "posted" }]), summary: { approvedPrincipal: "1000.00", netDisbursed: "600.00", variance: "-400.00", status: "under_disbursed" } } };
            }
            if (url === `/loans/${LOAN_ID}`) return { data: loan };
            if (url === `/loans/${LOAN_ID}/schedule` || url === `/loans/${LOAN_ID}/funding-allocations`) return { data: [] };
            if (url === `/loans/${LOAN_ID}/allocation-state`) return { data: { state: "unallocated", netAllocatedPrincipal: "0.00", remainingGap: "1000.00", overfundedAmount: "0.00" } };
            throw new Error(`Unexpected GET ${url}`);
        });
        vi.mocked(api.post).mockResolvedValue({ data: { ...draft, status: "posted" } });
        const user = userEvent.setup();
        renderDetail();
        await user.click(await screen.findByRole("button", { name: /bank transfer.*draft/i }));
        await user.click(screen.getByRole("button", { name: /post disbursement/i }));
        await waitFor(() => expect(api.post).toHaveBeenCalledWith(`/loans/${LOAN_ID}/disbursements/${EVENT_ID}/post`, {}, expect.objectContaining({ headers: expect.objectContaining({ "Idempotency-Key": expect.any(String) }) })));
        expect(await screen.findByRole("button", { name: /bank transfer.*posted/i })).toBeInTheDocument();
        expect(api.get.mock.calls.filter(([url]) => url === `/loans/${LOAN_ID}/disbursements`)).toHaveLength(2);
    });

    it("posts and reverses with retained Idempotency-Key headers and refreshes the event history", async () => {
        let reads = 0;
        vi.mocked(api.get).mockImplementation(async (url) => {
            if (url === `/loans/${LOAN_ID}/disbursements`) {
                reads += 1;
                return { data: reads < 2 ? ledger() : ledger([{ ...ledger().events[0], status: "posted" }, { ...ledger().events[0], publicId: REVERSAL_ID, status: "reversed", reversedEventPublicId: EVENT_ID, evidenceFilePublicIds: [] }]) };
            }
            if (url === `/loans/${LOAN_ID}`) return { data: loan };
            if (url === `/loans/${LOAN_ID}/schedule` || url === `/loans/${LOAN_ID}/funding-allocations`) return { data: [] };
            if (url === `/loans/${LOAN_ID}/allocation-state`) return { data: { state: "unallocated", netAllocatedPrincipal: "0.00", remainingGap: "1000.00", overfundedAmount: "0.00" } };
            throw new Error(`Unexpected GET ${url}`);
        });
        vi.mocked(api.post).mockImplementation(async (url) => {
            if (url.endsWith("/reverse")) return { data: { publicId: REVERSAL_ID, status: "reversed", reversedEventPublicId: EVENT_ID } };
            throw new Error(`Unexpected POST ${url}`);
        });
        const user = userEvent.setup();
        renderDetail();
        await user.click(await screen.findByRole("button", { name: /bank transfer.*posted/i }));
        await user.click(await screen.findByRole("button", { name: /reverse disbursement/i }));
        await user.type(screen.getByLabelText(/reversal reason/i), "Transfer cancelled");
        await user.click(screen.getByRole("button", { name: /confirm reversal/i }));
        await waitFor(() => expect(api.post).toHaveBeenCalledWith(`/loans/${LOAN_ID}/disbursements/${EVENT_ID}/reverse`, { reason: "Transfer cancelled" }, expect.objectContaining({ headers: expect.objectContaining({ "Idempotency-Key": expect.any(String) }) })));
        expect(await screen.findByText(/reversed/i)).toBeInTheDocument();
    });

    it("shows exact gross and attributed amounts for grouped posted and reversed history", async () => {
        const groupedHistory = [
            ledger().events[0],
            { ...ledger().events[0], publicId: REVERSAL_ID, status: "reversed", reversedEventPublicId: EVENT_ID, evidenceFilePublicIds: [] },
        ];
        vi.mocked(api.get).mockResolvedValue({ data: ledger(groupedHistory) });

        render(<LoanDisbursements loanPublicId={LOAN_ID} />);

        expect(await screen.findAllByText(/Grouped transfer: gross THB\s+700\.00, attributed to this loan THB\s+600\.00\./)).toHaveLength(2);
    });

    it("keeps an unsafe-integer disbursement amount exact in the draft payload", async () => {
        const exactAmount = "9007199254740992.01";
        vi.mocked(api.get).mockResolvedValue({ data: ledger([]) });
        vi.mocked(api.post).mockResolvedValue({ data: {
            publicId: EVENT_ID, status: "draft", grossAmount: exactAmount, loanAttributedAmount: exactAmount,
            channel: "cash", evidenceFilePublicIds: [],
        } });
        const user = userEvent.setup();

        render(<LoanDisbursements loanPublicId={LOAN_ID} />);
        await user.click(await screen.findByRole("button", { name: /add disbursement/i }));
        const inputs = screen.getAllByRole("textbox");
        await user.type(inputs[0]!, exactAmount);
        await user.type(inputs[1]!, exactAmount);
        await user.selectOptions(screen.getByRole("combobox"), "cash");
        await user.click(screen.getByRole("button", { name: /save draft/i }));

        await waitFor(() => expect(api.post).toHaveBeenCalledWith(
            `/loans/${LOAN_ID}/disbursements`,
            expect.objectContaining({ grossAmount: exactAmount, loanAttributedAmount: exactAmount }),
        ));
    });

    it("requires a grouped-transfer explanation for distinct unsafe-integer amounts", async () => {
        vi.mocked(api.get).mockResolvedValue({ data: ledger([]) });
        const user = userEvent.setup();

        render(<LoanDisbursements loanPublicId={LOAN_ID} />);
        await user.click(await screen.findByRole("button", { name: /add disbursement/i }));
        const inputs = screen.getAllByRole("textbox");
        await user.type(inputs[0]!, "9007199254740992.01");
        await user.type(inputs[1]!, "9007199254740992.00");

        expect(screen.getByLabelText(/grouped transfer explanation/i)).toBeInTheDocument();
        expect(screen.getByRole("button", { name: /save draft/i })).toBeDisabled();
    });
});
