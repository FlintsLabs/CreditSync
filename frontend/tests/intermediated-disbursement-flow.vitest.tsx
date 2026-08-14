import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/lib/api";
import { IntermediatedDisbursementPanel } from "../src/pages/dashboard/loans/IntermediatedDisbursementPanel";
import { IntermediaryTransferLedger } from "../src/pages/dashboard/intermediaries/IntermediaryTransferLedger";

vi.mock("../src/lib/api", () => ({ api: { get: vi.fn(), post: vi.fn() } }));

const GROUP_ID = "11111111-1111-4111-8111-111111111111";
const LOAN_ID = "22222222-2222-4222-8222-222222222222";
const INTERMEDIARY_ID = "33333333-3333-4333-8333-333333333333";

const events = [
    {
        publicId: "41111111-1111-4111-8111-111111111111", role: "funding_to_intermediary", channel: "bank_transfer", amount: "4400.00",
        senderHint: "Own capital", payeeHint: "Mae Mali", bankReference: "FUND-4400", transferredAt: "2026-08-13T17:30:00.000Z", status: "posted",
        evidence: { status: "ready", count: 1, items: [{ publicId: "51111111-1111-4111-8111-111111111111", filePublicId: "61111111-1111-4111-8111-111111111111", status: "ready", mimeType: "image/png" }] },
    },
    {
        publicId: "42222222-2222-4222-8222-222222222222", role: "borrower_net_payout", channel: "bank_transfer", amount: "2000.00",
        senderHint: "Mae Mali", payeeHint: "Somchai", bankReference: "PAY-2000", transferredAt: "2026-08-14T02:00:00.000Z", status: "posted",
        evidence: { status: "ready", count: 2, items: [
            { publicId: "52222222-2222-4222-8222-222222222221", filePublicId: "62222222-2222-4222-8222-222222222221", status: "ready", mimeType: "image/jpeg" },
            { publicId: "52222222-2222-4222-8222-222222222222", filePublicId: "62222222-2222-4222-8222-222222222222", status: "ready", mimeType: "application/pdf" },
        ] },
    },
    {
        publicId: "43333333-3333-4333-8333-333333333333", role: "borrower_net_payout", channel: "bank_transfer", amount: "2400.00",
        senderHint: "Mae Mali", payeeHint: "Somchai", bankReference: "PAY-2400", transferredAt: "2026-08-14T02:05:00.000Z", status: "posted",
        evidence: { status: "none", count: 0, items: [] },
    },
    {
        publicId: "44444444-4444-4444-8444-444444444444", role: "advance_interest_return", channel: "bank_transfer", amount: "600.00",
        senderHint: "Mae Mali", payeeHint: "Own capital", bankReference: "RETURN-600", transferredAt: "2026-08-14T02:10:00.000Z", status: "posted",
        evidence: { status: "ready", count: 1, items: [{ publicId: "54444444-4444-4444-8444-444444444444", filePublicId: "64444444-4444-4444-8444-444444444444", status: "ready", mimeType: "image/png" }] },
    },
];

const group = {
    publicId: GROUP_ID, loanPublicId: LOAN_ID, intermediaryPublicId: INTERMEDIARY_ID, status: "ready", retainedBalance: "0.00", events,
    latestPreview: { publicId: "71111111-1111-4111-8111-111111111111", status: "ready", variance: "0.00", evidenceReady: true, warnings: [] },
};

describe("intermediated disbursement money paths", () => {
    beforeEach(() => vi.clearAllMocks());

    it("renders all roles, exact split payouts, transfer metadata, and one action for every finalized slip", async () => {
        vi.mocked(api.get).mockImplementation(async (url) => url === "/intermediated-disbursements" ? { data: [{ ...group, latestPreview: undefined }] } : { data: group });
        vi.mocked(api.post).mockResolvedValue({ data: { ...group, status: "posted" } });
        const user = userEvent.setup();
        render(<MemoryRouter><IntermediatedDisbursementPanel loanPublicId={LOAN_ID} /></MemoryRouter>);

        const panel = await screen.findByRole("region", { name: /intermediary money path/i });
        expect(within(panel).getByText("Funding to intermediary")).toBeInTheDocument();
        expect(within(panel).getAllByText("Borrower net payout")).toHaveLength(2);
        expect(within(panel).getByText("Advance interest return")).toBeInTheDocument();
        expect(within(panel).getByText(/4,400\.00/)).toBeInTheDocument();
        expect(within(panel).getByText(/2,000\.00/)).toBeInTheDocument();
        expect(within(panel).getByText(/2,400\.00/)).toBeInTheDocument();
        expect(within(panel).getAllByText("Own capital")).toHaveLength(2);
        expect(within(panel).getAllByText("Somchai")).toHaveLength(2);
        expect(within(panel).getByText("PAY-2000")).toBeInTheDocument();
        expect(within(panel).getAllByText(/Status/, { selector: "p" })).toHaveLength(4);
        expect(within(panel).getAllByRole("button", { name: /view slip/i })).toHaveLength(4);
        const confirmation = within(panel).getByRole("checkbox", { name: /confirm.*zero variance.*ready evidence/i });
        expect(confirmation).toBeEnabled();
        const post = within(panel).getByRole("button", { name: /post confirmed transfer/i });
        expect(post).toBeDisabled();
        await user.click(confirmation);
        await user.click(post);
        expect(api.get).toHaveBeenCalledWith("/intermediated-disbursements", { params: { loanPublicId: LOAN_ID } });
        expect(api.get).toHaveBeenCalledWith(`/intermediated-disbursements/${GROUP_ID}`);
        expect(api.post).toHaveBeenCalledWith(`/intermediated-disbursements/${GROUP_ID}/post`, { proposalPublicId: group.latestPreview.publicId, confirmed: true }, { headers: { "Idempotency-Key": expect.any(String) } });
    });

    it("fetches a signed descriptor only after View slip and never exposes it in the ledger", async () => {
        vi.mocked(api.get).mockImplementation(async (url) => {
            if (url === "/intermediated-disbursements") return { data: [group] };
            if (url === `/intermediated-disbursements/${GROUP_ID}`) return { data: group };
            if (url.endsWith("/access")) return { data: { url: "https://signed.example/one.png", mimeType: "image/png" } };
            throw new Error(`Unexpected GET ${url}`);
        });
        const user = userEvent.setup();
        render(<MemoryRouter><IntermediatedDisbursementPanel loanPublicId={LOAN_ID} /></MemoryRouter>);
        const buttons = await screen.findAllByRole("button", { name: /view slip/i });
        expect(vi.mocked(api.get).mock.calls.some(([url]) => String(url).endsWith("/access"))).toBe(false);
        expect(screen.queryByText(/signed\.example/)).not.toBeInTheDocument();

        await user.click(buttons[1]!);
        expect(await screen.findByRole("img", { name: /view slip 2/i })).toHaveAttribute("src", "https://signed.example/one.png");
        expect(api.get).toHaveBeenLastCalledWith(`/intermediated-disbursements/${GROUP_ID}/events/${events[1]!.publicId}/evidence/${events[1]!.evidence.items[0]!.publicId}/access`);
    });

    it("blocks explicit confirmation for variance or any supplied evidence that is not ready", async () => {
        const unsafe = { ...group, latestPreview: { ...group.latestPreview, variance: "0.01", evidenceReady: false }, events: events.map((event, index) => index === 0 ? { ...event, evidence: { ...event.evidence, status: "pending", items: [{ ...event.evidence.items[0]!, status: "pending" }] } } : event) };
        vi.mocked(api.get).mockImplementation(async (url) => url === "/intermediated-disbursements" ? { data: [unsafe] } : { data: unsafe });
        render(<MemoryRouter><IntermediatedDisbursementPanel loanPublicId={LOAN_ID} /></MemoryRouter>);
        expect(await screen.findByRole("checkbox", { name: /confirm.*zero variance.*ready evidence/i })).toBeDisabled();
        expect(screen.getByRole("alert")).toHaveTextContent(/cannot confirm.*variance.*evidence/i);
        expect(screen.getAllByRole("button", { name: /view slip/i })).toHaveLength(3);
    });

    it("preserves the posting idempotency key across a safe retry", async () => {
        vi.mocked(api.get).mockImplementation(async (url) => url === "/intermediated-disbursements" ? { data: [group] } : { data: group });
        vi.mocked(api.post).mockRejectedValueOnce(new Error("temporary")).mockResolvedValueOnce({ data: { ...group, status: "posted" } });
        const user = userEvent.setup();
        render(<MemoryRouter><IntermediatedDisbursementPanel loanPublicId={LOAN_ID} /></MemoryRouter>);
        await user.click(await screen.findByRole("checkbox", { name: /confirm.*zero variance.*ready evidence/i }));
        const post = screen.getByRole("button", { name: /post confirmed transfer/i });
        await user.click(post);
        expect(await screen.findByRole("alert")).toHaveTextContent(/unable to post/i);
        await user.click(post);
        expect(api.post).toHaveBeenCalledTimes(2);
        expect(vi.mocked(api.post).mock.calls[1]![2]).toEqual(vi.mocked(api.post).mock.calls[0]![2]);
    });

    it("provides a profile-scoped transfer ledger linked to each loan", async () => {
        vi.mocked(api.get).mockImplementation(async (url) => url === "/intermediated-disbursements" ? { data: [group] } : { data: group });
        render(<MemoryRouter><IntermediaryTransferLedger intermediaryPublicId={INTERMEDIARY_ID} /></MemoryRouter>);
        const ledger = await screen.findByRole("region", { name: /transfer ledger/i });
        expect(within(ledger).getByRole("link", { name: /open loan/i })).toHaveAttribute("href", `/loans/${LOAN_ID}`);
        expect(api.get).toHaveBeenCalledWith("/intermediated-disbursements", { params: { intermediaryPublicId: INTERMEDIARY_ID } });
    });
});
