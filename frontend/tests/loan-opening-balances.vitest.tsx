import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/lib/api";
import appI18n from "../src/lib/i18n";
import { LoanOpeningBalances } from "../src/pages/dashboard/loans/LoanOpeningBalances";

vi.mock("../src/lib/api", () => ({ api: { get: vi.fn() } }));
const LOAN_ID = "019ff023-fd64-7d41-9aae-723d2a458a8c";
const RESTRUCTURE_ID = "019ff023-fd64-7d41-9aae-723d2a458a8b";
const component = { publicId: "c1", kind: "additional_principal", amount: "1000.00", status: "executed", sourceType: "loan_restructure", sourcePublicId: RESTRUCTURE_ID };

describe("LoanOpeningBalances payout ledger", () => {
    beforeEach(async () => { vi.clearAllMocks(); await appI18n.changeLanguage("en"); });

    it.each(["draft", "posted", "reversed"] as const)("shows the related additional-principal %s event and link", async status => {
        vi.mocked(api.get).mockResolvedValue({ data: { loanPublicId: LOAN_ID, summary: {}, events: [{ publicId: `event-${status}`, status, grossAmount: "1000.00", loanAttributedAmount: "1000.00", channel: "adjustment", note: `Additional principal approved by restructure ${RESTRUCTURE_ID}; payout not yet posted`, evidenceFilePublicIds: [] }] } });
        render(<MemoryRouter><LoanOpeningBalances loanPublicId={LOAN_ID} components={[component]} /></MemoryRouter>);
        expect(await screen.findByText(new RegExp(status, "i"))).toBeInTheDocument();
        expect(screen.getByRole("link", { name: new RegExp(status, "i") })).toHaveAttribute("href", `/loans/${LOAN_ID}#disbursement-event-${status}`);
    });

    it("labels reversed opening components as history and excludes them from active balances", async () => {
        vi.mocked(api.get).mockResolvedValue({ data: { loanPublicId: LOAN_ID, summary: {}, events: [] } });
        render(<MemoryRouter><LoanOpeningBalances loanPublicId={LOAN_ID} components={[component, { ...component, publicId: "c2", status: "reversed" }]} /></MemoryRouter>);
        expect(await screen.findByText(/no related payout/i)).toBeInTheDocument();
        expect(screen.getByText(/reversed.*history/i)).toBeInTheDocument();
        expect(screen.getAllByText(/1,000\.00/)).toHaveLength(2);
    });
});
