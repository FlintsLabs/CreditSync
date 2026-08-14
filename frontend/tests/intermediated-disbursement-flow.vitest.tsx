import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/lib/api";
import { IntermediatedDisbursementPanel, TransferGroupView } from "../src/pages/dashboard/loans/IntermediatedDisbursementPanel";
import { IntermediaryTransferLedger } from "../src/pages/dashboard/intermediaries/IntermediaryTransferLedger";
import { LoanDisbursements, type LoanDisbursementsHandle } from "../src/pages/dashboard/loans/LoanDisbursements";
import { refreshForScope, useActiveScope } from "../src/pages/dashboard/intermediaries/intermediary-scope";

vi.mock("../src/lib/api", () => ({ api: { get: vi.fn(), post: vi.fn() } }));

const GROUP_ID = "11111111-1111-4111-8111-111111111111";
const LOAN_ID = "22222222-2222-4222-8222-222222222222";
const INTERMEDIARY_ID = "33333333-3333-4333-8333-333333333333";

const events = [
    {
        publicId: "41111111-1111-4111-8111-111111111111", role: "funding_to_intermediary", channel: "bank_transfer", amount: "5000.00",
        senderHint: "Own capital", payeeHint: "Mae Mali", bankReference: "FUND-5000", transferredAt: "2026-08-13T17:30:00.000Z", status: "ready",
        evidence: { status: "ready", count: 1, items: [{ publicId: "51111111-1111-4111-8111-111111111111", filePublicId: "61111111-1111-4111-8111-111111111111", status: "ready", mimeType: "image/png" }] },
    },
    {
        publicId: "42222222-2222-4222-8222-222222222222", role: "borrower_net_payout", channel: "bank_transfer", amount: "2000.00",
        senderHint: "Mae Mali", payeeHint: "Somchai", bankReference: "PAY-2000", transferredAt: "2026-08-14T02:00:00.000Z", status: "ready",
        evidence: { status: "ready", count: 2, items: [
            { publicId: "52222222-2222-4222-8222-222222222221", filePublicId: "62222222-2222-4222-8222-222222222221", status: "ready", mimeType: "image/jpeg" },
            { publicId: "52222222-2222-4222-8222-222222222222", filePublicId: "62222222-2222-4222-8222-222222222222", status: "ready", mimeType: "application/pdf" },
        ] },
    },
    {
        publicId: "43333333-3333-4333-8333-333333333333", role: "borrower_net_payout", channel: "bank_transfer", amount: "2400.00",
        senderHint: "Mae Mali", payeeHint: "Somchai", bankReference: "PAY-2400", transferredAt: "2026-08-14T02:05:00.000Z", status: "ready",
        evidence: { status: "none", count: 0, items: [] },
    },
    {
        publicId: "44444444-4444-4444-8444-444444444444", role: "advance_interest_return", channel: "bank_transfer", amount: "600.00",
        senderHint: "Mae Mali", payeeHint: "Own capital", bankReference: "RETURN-600", transferredAt: "2026-08-14T02:10:00.000Z", status: "ready",
        evidence: { status: "ready", count: 1, items: [{ publicId: "54444444-4444-4444-8444-444444444444", filePublicId: "64444444-4444-4444-8444-444444444444", status: "ready", mimeType: "image/png" }] },
    },
];

const group = {
    publicId: GROUP_ID, loanPublicId: LOAN_ID, intermediaryPublicId: INTERMEDIARY_ID, status: "ready", retainedBalance: "0.00", events,
    latestPreview: { publicId: "71111111-1111-4111-8111-111111111111", previewHash: "a".repeat(64), status: "ready", variance: "0.00", evidenceReady: true, warnings: [] as Array<{ code: string; amount?: string }>, expiresAt: "2099-08-14T02:15:00.000Z" },
};

describe("intermediated disbursement money paths", () => {
    beforeEach(() => vi.resetAllMocks());
    afterEach(() => vi.useRealTimers());

    it("renders all roles, exact split payouts, transfer metadata, and one action for every finalized slip", async () => {
        vi.mocked(api.get).mockImplementation(async (url) => url === "/intermediated-disbursements" ? { data: [{ ...group, latestPreview: undefined }] } : { data: group });
        vi.mocked(api.post).mockResolvedValue({ data: { ...group, status: "posted" } });
        const user = userEvent.setup();
        render(<MemoryRouter><IntermediatedDisbursementPanel loanPublicId={LOAN_ID} /></MemoryRouter>);

        const panel = await screen.findByRole("region", { name: /intermediary money path/i });
        expect(within(panel).getByText("Funding to intermediary")).toBeInTheDocument();
        expect(within(panel).getAllByText("Borrower net payout")).toHaveLength(2);
        expect(within(panel).getByText("Advance interest return")).toBeInTheDocument();
        expect(within(panel).getByText(/5,000\.00/)).toBeInTheDocument();
        expect(within(panel).getByText(/2,000\.00/)).toBeInTheDocument();
        expect(within(panel).getByText(/2,400\.00/)).toBeInTheDocument();
        expect(within(panel).getAllByText("Own capital")).toHaveLength(2);
        expect(within(panel).getAllByText("Somchai")).toHaveLength(2);
        expect(within(panel).getByText("PAY-2000")).toBeInTheDocument();
        expect(within(panel).getByText("Aug 14, 2026, 12:30 AM")).toBeInTheDocument();
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

    it("clears old profile groups synchronously when intermediary scope changes", async () => {
        let finishB!: (value: { data: unknown }) => void;
        const groupB = { ...group, publicId: "99999999-9999-4999-8999-999999999999", loanPublicId: "88888888-8888-4888-8888-888888888888", intermediaryPublicId: "77777777-7777-4777-8777-777777777777" };
        vi.mocked(api.get).mockImplementation(async (url, config) => {
            if (url === "/intermediated-disbursements" && config?.params?.intermediaryPublicId === INTERMEDIARY_ID) return { data: [group] };
            if (url === `/intermediated-disbursements/${GROUP_ID}`) return { data: group };
            if (url === "/intermediated-disbursements") return new Promise((done) => { finishB = done; });
            if (url === `/intermediated-disbursements/${groupB.publicId}`) return { data: groupB };
            throw new Error(`Unexpected GET ${url}`);
        });
        const view = render(<MemoryRouter><IntermediaryTransferLedger intermediaryPublicId={INTERMEDIARY_ID} /></MemoryRouter>);
        expect(await screen.findByRole("link", { name: /open loan/i })).toHaveAttribute("href", `/loans/${LOAN_ID}`);
        view.rerender(<MemoryRouter><IntermediaryTransferLedger intermediaryPublicId={groupB.intermediaryPublicId} /></MemoryRouter>);
        expect(screen.queryByRole("link", { name: /open loan/i })).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /post confirmed transfer/i })).not.toBeInTheDocument();
        finishB({ data: [groupB] });
        expect(await screen.findByRole("link", { name: /open loan/i })).toHaveAttribute("href", `/loans/${groupB.loanPublicId}`);
    });

    it("does not confirm an expired proposal", () => {
        const expired = { ...group, latestPreview: { ...group.latestPreview, expiresAt: "2026-08-13T00:00:00.000Z" } };
        render(<MemoryRouter><TransferGroupView group={expired} /></MemoryRouter>);
        expect(screen.getByRole("checkbox", { name: /confirm.*zero variance.*ready evidence/i })).toBeDisabled();
    });

    it("refreshes a stale proposal and requires explicit reconfirmation with a new command key", async () => {
        const refreshedPreview = { ...group.latestPreview, publicId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", previewHash: "b".repeat(64), expiresAt: "2099-08-14T02:30:00.000Z" };
        vi.mocked(api.post)
            .mockRejectedValueOnce({ response: { data: { code: "STALE_INTERMEDIATED_DISBURSEMENT_PROPOSAL" } } })
            .mockResolvedValueOnce({ data: refreshedPreview })
            .mockResolvedValueOnce({ data: { ...group, status: "posted" } });
        const user = userEvent.setup();
        render(<MemoryRouter><TransferGroupView group={group} /></MemoryRouter>);
        const confirmation = screen.getByRole("checkbox", { name: /confirm.*zero variance.*ready evidence/i });
        await user.click(confirmation);
        await user.click(screen.getByRole("button", { name: /post confirmed transfer/i }));
        await waitFor(() => expect(api.post).toHaveBeenCalledWith(`/intermediated-disbursements/${GROUP_ID}/preview`, {}));
        expect(confirmation).not.toBeChecked();
        expect(screen.getByText(/proposal changed.*confirm again/i)).toBeInTheDocument();
        await user.click(confirmation);
        await user.click(screen.getByRole("button", { name: /post confirmed transfer/i }));
        const postCalls = vi.mocked(api.post).mock.calls.filter(([url]) => String(url).endsWith("/post"));
        expect(postCalls[1]![1]).toEqual({ proposalPublicId: refreshedPreview.publicId, confirmed: true });
        expect(postCalls[1]![2]).not.toEqual(postCalls[0]![2]);
    });

    it("does not carry proposal A confirmation into proposal B", async () => {
        const user = userEvent.setup();
        const proposalB = { ...group, latestPreview: { ...group.latestPreview, publicId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", previewHash: "b".repeat(64) } };
        const view = render(<MemoryRouter><TransferGroupView group={group} /></MemoryRouter>);
        await user.click(screen.getByRole("checkbox", { name: /confirm.*zero variance.*ready evidence/i }));
        expect(screen.getByRole("button", { name: /post confirmed transfer/i })).toBeEnabled();
        view.rerender(<MemoryRouter><TransferGroupView group={proposalB} /></MemoryRouter>);
        expect(screen.getByRole("checkbox", { name: /confirm.*zero variance.*ready evidence/i })).not.toBeChecked();
        expect(screen.getByRole("button", { name: /post confirmed transfer/i })).toBeDisabled();
    });

    it("recomputes expiry from current time when proposal identity changes", () => {
        vi.useFakeTimers();
        vi.setSystemTime("2026-08-14T00:00:00.000Z");
        const proposalA = { ...group, latestPreview: { ...group.latestPreview, expiresAt: "2026-08-14T00:00:10.000Z" } };
        const view = render(<MemoryRouter><TransferGroupView group={proposalA} /></MemoryRouter>);
        act(() => { vi.advanceTimersByTime(8_000); });
        const proposalB = { ...group, latestPreview: { ...group.latestPreview, publicId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", previewHash: "c".repeat(64), expiresAt: "2026-08-14T00:00:20.000Z" } };
        view.rerender(<MemoryRouter><TransferGroupView group={proposalB} /></MemoryRouter>);
        expect(screen.getByRole("checkbox", { name: /confirm.*zero variance.*ready evidence/i })).toBeEnabled();
        act(() => { vi.advanceTimersByTime(12_001); });
        expect(screen.getByRole("checkbox", { name: /confirm.*zero variance.*ready evidence/i })).toBeDisabled();
        vi.useRealTimers();
    });

    it("refreshes an already-expired proposal for explicit re-review", async () => {
        const refreshedPreview = { ...group.latestPreview, publicId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", previewHash: "d".repeat(64) };
        vi.mocked(api.post).mockResolvedValue({ data: refreshedPreview });
        const user = userEvent.setup();
        render(<MemoryRouter><TransferGroupView group={{ ...group, latestPreview: { ...group.latestPreview, expiresAt: "2026-08-13T00:00:00.000Z" } }} /></MemoryRouter>);
        expect(screen.getByText(/proposal expired/i)).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: /refresh proposal/i }));
        expect(api.post).toHaveBeenCalledWith(`/intermediated-disbursements/${GROUP_ID}/preview`, {});
        expect(screen.getByRole("checkbox", { name: /confirm.*zero variance.*ready evidence/i })).not.toBeChecked();
    });

    it("refreshes authoritative group and parent projections after posting", async () => {
        const postedDetail = { ...group, status: "posted", events: events.map((event) => ({ ...event, status: "posted" })), latestPreview: { ...group.latestPreview, status: "executed" } };
        vi.mocked(api.post).mockResolvedValue({ data: { status: "posted" } });
        vi.mocked(api.get).mockResolvedValue({ data: postedDetail });
        const refreshParents = vi.fn().mockResolvedValue(undefined);
        const user = userEvent.setup();
        render(<MemoryRouter><TransferGroupView group={group} onPosted={refreshParents} /></MemoryRouter>);
        await user.click(screen.getByRole("checkbox", { name: /confirm.*zero variance.*ready evidence/i }));
        await user.click(screen.getByRole("button", { name: /post confirmed transfer/i }));
        await waitFor(() => expect(api.get).toHaveBeenCalledWith(`/intermediated-disbursements/${GROUP_ID}`));
        expect(refreshParents).toHaveBeenCalledWith(postedDetail);
        expect(await screen.findByText(/transfer posted/i)).toBeInTheDocument();
    });

    it("blocks stale financial presentation when post refresh fails", async () => {
        vi.mocked(api.post).mockResolvedValue({ data: { status: "posted" } });
        vi.mocked(api.get).mockRejectedValue(new Error("refresh failed"));
        const user = userEvent.setup();
        render(<MemoryRouter><TransferGroupView group={group} onPosted={vi.fn()} /></MemoryRouter>);
        await user.click(screen.getByRole("checkbox", { name: /confirm.*zero variance.*ready evidence/i }));
        await user.click(screen.getByRole("button", { name: /post confirmed transfer/i }));
        expect(await screen.findByRole("alert")).toHaveTextContent(/posted.*refresh.*do not rely/i);
    });

    it("awaits installation of the refreshed actual-disbursement ledger", async () => {
        const ref = createRef<LoanDisbursementsHandle>();
        const oldLedger = { loanPublicId: LOAN_ID, summary: { approvedPrincipal: "5000.00", netDisbursed: "0.00", variance: "-5000.00", status: "under_disbursed" }, events: [] };
        const newLedger = { loanPublicId: LOAN_ID, summary: { approvedPrincipal: "5000.00", netDisbursed: "4400.00", variance: "-600.00", status: "under_disbursed" }, events: [] };
        vi.mocked(api.get).mockResolvedValueOnce({ data: oldLedger }).mockResolvedValueOnce({ data: newLedger });
        render(<MemoryRouter><LoanDisbursements ref={ref} loanPublicId={LOAN_ID} /></MemoryRouter>);
        expect((await screen.findByText("Net disbursed")).parentElement).toHaveTextContent(/THB.*0\.00/);
        await act(async () => { await ref.current!.refresh(); });
        expect(screen.getByText("Net disbursed").parentElement).toHaveTextContent(/THB.*4,400\.00/);
    });

    it("never lets an older initial ledger response overwrite a newer refresh", async () => {
        const ref = createRef<LoanDisbursementsHandle>();
        let finishOld!: (value: { data: unknown }) => void;
        const oldLedger = { loanPublicId: LOAN_ID, summary: { approvedPrincipal: "5000.00", netDisbursed: "0.00", variance: "-5000.00", status: "under_disbursed" }, events: [] };
        const newLedger = { loanPublicId: LOAN_ID, summary: { approvedPrincipal: "5000.00", netDisbursed: "4400.00", variance: "-600.00", status: "under_disbursed" }, events: [] };
        vi.mocked(api.get).mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; })).mockResolvedValueOnce({ data: newLedger });
        render(<MemoryRouter><LoanDisbursements ref={ref} loanPublicId={LOAN_ID} /></MemoryRouter>);
        await act(async () => { await ref.current!.refresh(); });
        expect(screen.getByText("Net disbursed").parentElement).toHaveTextContent(/4,400\.00/);
        finishOld({ data: oldLedger });
        await act(async () => { await Promise.resolve(); });
        expect(screen.getByText("Net disbursed").parentElement).toHaveTextContent(/4,400\.00/);
    });

    it("rejects a superseded post refresh when its newer authoritative refresh fails", async () => {
        const ref = createRef<LoanDisbursementsHandle>();
        const initial = { loanPublicId: LOAN_ID, summary: { approvedPrincipal: "5000.00", netDisbursed: "0.00", variance: "-5000.00", status: "under_disbursed" }, events: [] };
        let finishPost!: (value: { data: unknown }) => void;
        let failNewest!: (error: Error) => void;
        vi.mocked(api.get).mockResolvedValueOnce({ data: initial })
            .mockImplementationOnce(() => new Promise((resolve) => { finishPost = resolve; }))
            .mockImplementationOnce(() => new Promise((_resolve, reject) => { failNewest = reject; }));
        render(<MemoryRouter><LoanDisbursements ref={ref} loanPublicId={LOAN_ID} /></MemoryRouter>);
        await screen.findByText("Net disbursed");
        const postRefresh = ref.current!.refresh();
        const newestRefresh = ref.current!.refresh();
        const postExpectation = expect(postRefresh).rejects.toThrow(/superseded/i);
        const newestExpectation = expect(newestRefresh).rejects.toThrow("newest failed");
        finishPost({ data: { ...initial, summary: { ...initial.summary, netDisbursed: "4400.00" } } });
        failNewest(new Error("newest failed"));
        await postExpectation;
        await newestExpectation;
        expect(screen.getByText("Net disbursed").parentElement).toHaveTextContent(/0\.00/);
    });

    it("ignores stale initial errors and clears an earlier current error after successful refresh", async () => {
        const ref = createRef<LoanDisbursementsHandle>();
        let failInitial!: (error: Error) => void;
        const ledger = { loanPublicId: LOAN_ID, summary: { approvedPrincipal: "5000.00", netDisbursed: "4400.00", variance: "-600.00", status: "under_disbursed" }, events: [] };
        vi.mocked(api.get).mockImplementationOnce(() => new Promise((_resolve, reject) => { failInitial = reject; })).mockResolvedValueOnce({ data: ledger });
        render(<MemoryRouter><LoanDisbursements ref={ref} loanPublicId={LOAN_ID} /></MemoryRouter>);
        await act(async () => { await ref.current!.refresh(); });
        failInitial(new Error("stale initial failure"));
        await act(async () => { await Promise.resolve(); });
        expect(screen.queryByText(/unable to load disbursements/i)).not.toBeInTheDocument();
        expect(screen.getByText("Net disbursed").parentElement).toHaveTextContent(/4,400\.00/);
    });

    it("clears blocking refresh failure only after same-key retry fully refreshes", async () => {
        const postedDetail = { ...group, status: "posted", events: events.map((event) => ({ ...event, status: "posted" })) };
        vi.mocked(api.post).mockResolvedValue({ data: { status: "posted" } });
        vi.mocked(api.get).mockRejectedValueOnce(new Error("refresh failed")).mockResolvedValueOnce({ data: postedDetail });
        const parentRefresh = vi.fn().mockResolvedValue(undefined);
        const user = userEvent.setup();
        render(<MemoryRouter><TransferGroupView group={group} onPosted={parentRefresh} /></MemoryRouter>);
        const check = screen.getByRole("checkbox", { name: /confirm.*zero variance.*ready evidence/i });
        await user.click(check); await user.click(screen.getByRole("button", { name: /post confirmed transfer/i }));
        expect(await screen.findByRole("alert")).toHaveTextContent(/do not rely/i);
        await user.click(screen.getByRole("button", { name: /post confirmed transfer/i }));
        await waitFor(() => expect(screen.queryByText(/do not rely/i)).not.toBeInTheDocument());
        const posts = vi.mocked(api.post).mock.calls.filter(([url]) => String(url).endsWith("/post"));
        expect(posts[1]![2]).toEqual(posts[0]![2]);
        expect(parentRefresh).toHaveBeenCalledWith(postedDetail);
    });

    it("provides a profile-scoped transfer ledger linked to each loan", async () => {
        vi.mocked(api.get).mockImplementation(async (url) => url === "/intermediated-disbursements" ? { data: [group] } : { data: group });
        render(<MemoryRouter><IntermediaryTransferLedger intermediaryPublicId={INTERMEDIARY_ID} /></MemoryRouter>);
        const ledger = await screen.findByRole("region", { name: /transfer ledger/i });
        expect(within(ledger).getByRole("link", { name: /open loan/i })).toHaveAttribute("href", `/loans/${LOAN_ID}`);
        expect(api.get).toHaveBeenCalledWith("/intermediated-disbursements", { params: { intermediaryPublicId: INTERMEDIARY_ID } });
    });

    it("invalidates a deferred post balance refresh when the routed scope unmounts", async () => {
        let finishBalance!: (value: string) => void;
        const install = vi.fn();
        function Harness() {
            const active = useActiveScope(INTERMEDIARY_ID);
            return <IntermediaryTransferLedger intermediaryPublicId={INTERMEDIARY_ID} onPosted={() => refreshForScope(
                INTERMEDIARY_ID,
                active,
                () => new Promise<string>((resolve) => { finishBalance = resolve; }),
                install,
            )} />;
        }
        vi.mocked(api.get).mockImplementation(async (url) => url === "/intermediated-disbursements" ? { data: [group] } : { data: group });
        vi.mocked(api.post).mockResolvedValue({ data: { status: "posted" } });
        const user = userEvent.setup();
        const view = render(<MemoryRouter><Harness /></MemoryRouter>);
        await user.click(await screen.findByRole("checkbox", { name: /confirm.*zero variance.*ready evidence/i }));
        await user.click(screen.getByRole("button", { name: /post confirmed transfer/i }));
        await waitFor(() => expect(finishBalance).toBeTypeOf("function"));
        view.unmount();
        finishBalance("999.00");
        await act(async () => { await Promise.resolve(); });
        expect(install).not.toHaveBeenCalled();
    });
});
