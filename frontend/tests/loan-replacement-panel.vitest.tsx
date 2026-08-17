import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import appI18n from "../src/lib/i18n";
import { api } from "../src/lib/api";
import { LoanReplacementPanel } from "../src/pages/dashboard/loans/LoanReplacementPanel";

vi.mock("../src/lib/api", () => ({ api: { post: vi.fn() } }));

const OLD_LOAN_ID = "019ff023-fd64-7d41-9aae-723d2a458a8a";
const DRAFT_LOAN_ID = "019ff023-fd64-7d41-9aae-723d2a458a8b";
const REPLACEMENT_ID = "019ff023-fd64-7d41-9aae-723d2a458a8c";

const preview = {
    schemaVersion: 1,
    publicId: REPLACEMENT_ID,
    previewHash: "v1:preview",
    oldBalanceVersion: "v1:old-balance",
    replacementDraftVersion: "v1:draft-version",
    expiresAt: "2099-07-11T09:00:00.000Z",
    asOfDate: "2026-07-11",
    reason: "Correct duplicated agreement",
    fundingSourceName: "TTB",
    oldLoan: {
        loanPublicId: OLD_LOAN_ID, statusBefore: "active", statusAfter: "replaced", principal: "36000.00",
        collectibleBefore: { principal: "36000.00", interest: "0.00", fee: "0.00", penalty: "0.00", nextDueDate: "2026-07-12" },
        collectibleAfter: { principal: "0.00", interest: "0.00", fee: "0.00", penalty: "0.00", nextDueDate: null },
    },
    cash: { direction: "none", amount: "0.00" },
    correction: { principal: "0.00", interest: "4200.00", fee: "0.00", penalty: "0.00" },
    replacement: {
        loanPublicId: DRAFT_LOAN_ID, statusBefore: "draft", statusAfter: "active", principal: "36000.00", interestRate: "12.00",
        repaymentType: "daily", termMonths: 3, totalInstallments: 90, installmentAmount: "446.67",
        startDate: "2026-07-11", firstDueDate: "2026-07-12", lastDueDate: "2026-10-08", totalRepayment: "40200.00",
        fundingSourceKind: "drawdown", fundingSourcePublicId: "019ff023-fd64-7d41-9aae-723d2a458a8d",
    },
    warnings: ["Funding allocation will move with the replacement draft."],
};

describe("LoanReplacementPanel", () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        localStorage.setItem("user", JSON.stringify({ id: 1, role: "owner" }));
        await appI18n.changeLanguage("en");
    });

    // Break caught: UI derives replacement accounting itself or allows an unconfirmed preview to execute.
    it("renders backend-owned preview values and requires explicit confirmation of its latest preview", async () => {
        vi.mocked(api.post).mockImplementation(async (url) => url === "/loans/replacements/preview"
            ? { data: preview }
            : { data: { status: "executed", replacementPublicId: REPLACEMENT_ID, oldLoanPublicId: OLD_LOAN_ID, replacementLoanPublicId: DRAFT_LOAN_ID } });
        const user = userEvent.setup();
        render(<MemoryRouter><LoanReplacementPanel oldLoanPublicId={OLD_LOAN_ID} /></MemoryRouter>);

        await user.type(screen.getByLabelText(/replacement draft/i), DRAFT_LOAN_ID);
        await user.type(screen.getByLabelText(/^reason$/i), preview.reason);
        await user.click(screen.getByRole("button", { name: /preview replacement/i }));

        expect((await screen.findAllByText(/36,000\.00/)).length).toBeGreaterThan(0);
        expect(screen.getByText(/4,200\.00/)).toBeInTheDocument();
        expect(screen.getByText(/cash movement/i).parentElement).toHaveTextContent(/0\.00/);
        expect(screen.getAllByText("7/11/2026")).toHaveLength(2);
        expect(screen.getByText("7/12/2026")).toBeInTheDocument();
        expect(screen.getByText("Funding").parentElement).toHaveTextContent("Drawdown · TTB");
        const execute = screen.getByRole("button", { name: /execute replacement/i });
        expect(execute).toBeDisabled();

        await user.click(screen.getByLabelText(/confirm this exact replacement preview/i));
        await user.click(execute);
        await waitFor(() => expect(api.post).toHaveBeenLastCalledWith(`/loans/replacements/${REPLACEMENT_ID}/execute`, {
            confirmed: true,
            previewHash: preview.previewHash,
            expectedOldBalanceVersion: preview.oldBalanceVersion,
            expectedReplacementDraftVersion: preview.replacementDraftVersion,
            reason: preview.reason,
        }, expect.objectContaining({ headers: expect.objectContaining({ "Idempotency-Key": expect.any(String) }) })));
    });

    // Break caught: a stale/blocked lifecycle failure is hidden and an operator cannot safely recover.
    it("surfaces backend review-required errors and invalidates confirmation", async () => {
        vi.mocked(api.post).mockResolvedValueOnce({ data: preview }).mockRejectedValueOnce({ response: { data: { code: "REPLACEMENT_PREVIEW_STALE" } } });
        const user = userEvent.setup();
        render(<MemoryRouter><LoanReplacementPanel oldLoanPublicId={OLD_LOAN_ID} /></MemoryRouter>);
        await user.type(screen.getByLabelText(/replacement draft/i), DRAFT_LOAN_ID);
        await user.type(screen.getByLabelText(/^reason$/i), preview.reason);
        await user.click(screen.getByRole("button", { name: /preview replacement/i }));
        await user.click(await screen.findByLabelText(/confirm this exact replacement preview/i));
        await user.click(screen.getByRole("button", { name: /execute replacement/i }));
        expect(await screen.findByRole("alert")).toHaveTextContent(/changed|stale/i);
        expect(screen.queryByRole("button", { name: /execute replacement/i })).not.toBeInTheDocument();
    });

    // Break caught: a posted replacement can be reversed without an explicit compensating reason and confirmation.
    it("requires a separate reason and confirmation before reversal", async () => {
        vi.mocked(api.post).mockImplementation(async (url) => {
            if (url === "/loans/replacements/preview") return { data: preview };
            if (String(url).endsWith("/execute")) return { data: { status: "executed", replacementPublicId: REPLACEMENT_ID, oldLoanPublicId: OLD_LOAN_ID, replacementLoanPublicId: DRAFT_LOAN_ID } };
            return { data: { status: "reversed", replacementPublicId: REPLACEMENT_ID, oldLoanPublicId: OLD_LOAN_ID, replacementLoanPublicId: DRAFT_LOAN_ID } };
        });
        const user = userEvent.setup();
        render(<MemoryRouter><LoanReplacementPanel oldLoanPublicId={OLD_LOAN_ID} /></MemoryRouter>);
        await user.type(screen.getByLabelText(/replacement draft/i), DRAFT_LOAN_ID);
        await user.type(screen.getByLabelText(/^reason$/i), preview.reason);
        await user.click(screen.getByRole("button", { name: /preview replacement/i }));
        await user.click(await screen.findByLabelText(/confirm this exact replacement preview/i));
        await user.click(screen.getByRole("button", { name: /execute replacement/i }));
        const reverse = await screen.findByRole("button", { name: /reverse replacement/i });
        expect(reverse).toBeDisabled();
        await user.type(screen.getByLabelText(/reversal reason/i), "Undo duplicate replacement");
        await user.click(screen.getByLabelText(/confirm this compensating replacement reversal/i));
        await user.click(reverse);
        await waitFor(() => expect(api.post).toHaveBeenLastCalledWith(`/loans/replacements/${REPLACEMENT_ID}/reverse`, { reason: "Undo duplicate replacement" }, expect.objectContaining({ headers: expect.objectContaining({ "Idempotency-Key": expect.any(String) }) })));
    });
});
