import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import IntermediaryList from "../src/pages/dashboard/intermediaries/IntermediaryList";
import IntermediaryDetail from "../src/pages/dashboard/intermediaries/IntermediaryDetail";
import { refreshForScope } from "../src/pages/dashboard/intermediaries/intermediary-scope";
import { api } from "../src/lib/api";
import appI18n from "../src/lib/i18n";

vi.mock("../src/lib/api", () => ({ api: { get: vi.fn(), post: vi.fn() } }));

const INTERMEDIARY_ID = "11111111-1111-4111-8111-111111111111";
const LOAN_ID = "22222222-2222-4222-8222-222222222222";

const profile = {
    publicId: INTERMEDIARY_ID,
    name: "Mae Mali",
    aliases: ["Mali Agent"],
    notes: "Northern route",
    status: "active",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    bankAccounts: [{
        publicId: "33333333-3333-4333-8333-333333333333",
        bankCode: "KTB",
        bankName: "Krungthai",
        accountName: "Mae Mali",
        maskedAccountNumber: "•••• 2233",
        status: "active",
        note: null,
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
    }],
    assignments: [{
        publicId: "44444444-4444-4444-8444-444444444444",
        intermediaryPublicId: INTERMEDIARY_ID,
        loanPublicId: LOAN_ID,
        loanStatus: "active",
        borrowerPublicId: "55555555-5555-4555-8555-555555555555",
        borrowerName: "Somchai Exact",
        role: "both",
        effectiveFrom: "2026-08-01T00:00:00.000Z",
        effectiveTo: null,
        status: "active",
        note: null,
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
    }, {
        publicId: "66666666-6666-4666-8666-666666666666",
        intermediaryPublicId: INTERMEDIARY_ID,
        loanPublicId: "77777777-7777-4777-8777-777777777777",
        loanStatus: "closed",
        borrowerPublicId: "88888888-8888-4888-8888-888888888888",
        borrowerName: "Historical Borrower",
        role: "collection",
        effectiveFrom: "2026-01-01T00:00:00.000Z",
        effectiveTo: "2026-06-01T00:00:00.000Z",
        status: "ended",
        note: "Route reassigned",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:00:00.000Z",
    }],
};

const managedLoans = [{
    publicId: LOAN_ID,
    borrowerPublicId: profile.assignments[0]!.borrowerPublicId,
    borrowerName: "Somchai Exact",
    principalAmount: "9007199254740993.01",
    outstandingPrincipal: "9007199254740000.01",
    outstandingInterest: "600.00",
    outstandingFees: "10.00",
    repaymentType: "floating",
    startDate: "2026-08-01",
    nextDueDate: null,
    status: "active",
    roles: ["both"],
    assignments: [profile.assignments[0]],
}];

const groups = [{
    publicId: "99999999-9999-4999-8999-999999999999",
    loanPublicId: LOAN_ID,
    intermediaryPublicId: INTERMEDIARY_ID,
    expectedFunding: "5000.00",
    expectedBorrowerPayout: "4400.00",
    expectedAdvanceInterestReturn: "600.00",
    retainedBalance: "123.45",
    status: "needs_review",
    note: null,
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
    events: [],
}];
const heldBalance = {
    intermediaryPublicId: INTERMEDIARY_ID,
    fundingReceived: "5000.00",
    borrowerPayout: "4400.00",
    advanceInterestReturned: "600.00",
    disbursementHeldBalance: "0.00",
    collectionHeldBalance: "123.45",
    totalHeldBalance: "123.45",
};

function renderList() {
    return render(<MemoryRouter><Routes><Route path="*" element={<IntermediaryList />} /></Routes></MemoryRouter>);
}

function renderDetail() {
    return render(<MemoryRouter initialEntries={[`/intermediaries/${INTERMEDIARY_ID}`]}><Routes>
        <Route path="/intermediaries/:id" element={<IntermediaryDetail />} />
        <Route path="/loans/:id" element={<div>Loan detail destination</div>} />
    </Routes></MemoryRouter>);
}

describe("intermediary profile workspace", () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        await appI18n.changeLanguage("en");
        vi.mocked(api.get).mockImplementation(async (url, config) => {
            if (url === "/intermediaries") {
                return { data: config?.params?.q ? [profile] : [profile] };
            }
            if (url === `/intermediaries/${INTERMEDIARY_ID}`) return { data: profile };
            if (url === `/intermediaries/${INTERMEDIARY_ID}/managed-loans`) return { data: managedLoans };
            if (url === `/intermediaries/${INTERMEDIARY_ID}/held-balance`) return { data: heldBalance };
            if (url === "/intermediated-disbursements") return { data: groups };
            throw new Error(`Unexpected GET ${url}`);
        });
    });

    it("does not install deferred post-A balance after navigation to profile B", async () => {
        let finish!: (value: typeof heldBalance) => void;
        const request = () => new Promise<typeof heldBalance>((resolve) => { finish = resolve; });
        const active = { current: INTERMEDIARY_ID };
        const install = vi.fn();
        const pending = refreshForScope(INTERMEDIARY_ID, active, request, install);
        active.current = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
        finish(heldBalance);
        await pending;
        expect(install).not.toHaveBeenCalled();
    });

    // Break caught: profile creation can bypass the canonical/alias candidate search, or editing searched identity retains stale approval.
    it("requires candidate review for the exact proposed name and aliases before creation", async () => {
        vi.mocked(api.post).mockResolvedValue({ data: { ...profile, publicId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "New Agent" } });
        const user = userEvent.setup();
        renderList();

        expect(await screen.findByRole("link", { name: /Mae Mali/i })).toHaveAttribute("href", `/intermediaries/${INTERMEDIARY_ID}`);
        await user.click(screen.getByRole("button", { name: /new intermediary/i }));
        await user.type(screen.getByLabelText(/name/i), "New Agent");
        await user.type(screen.getByLabelText(/aliases/i), "Agent New, N. Agent");
        expect(screen.getByRole("button", { name: /create profile/i })).toBeDisabled();
        await user.click(screen.getByRole("button", { name: /search proposed identity/i }));
        await waitFor(() => {
            expect(api.get).toHaveBeenCalledWith("/intermediaries", { params: { q: "New Agent", status: "all" } });
            expect(api.get).toHaveBeenCalledWith("/intermediaries", { params: { q: "Agent New", status: "all" } });
            expect(api.get).toHaveBeenCalledWith("/intermediaries", { params: { q: "N. Agent", status: "all" } });
        });
        await user.click(screen.getByRole("checkbox", { name: /reviewed these candidates/i }));
        await user.click(screen.getByRole("button", { name: /create profile/i }));
        await waitFor(() => expect(api.post).toHaveBeenCalledWith("/intermediaries", { name: "New Agent", aliases: ["Agent New", "N. Agent"] }));

        await user.click(screen.getByRole("button", { name: /new intermediary/i }));
        await user.type(screen.getByLabelText(/^name/i), "Unsearched Agent");
        expect(screen.getByRole("button", { name: /create profile/i })).toBeDisabled();
    });

    // Break caught: inactive canonical/alias matches are hidden during candidate review even though create will silently reuse them.
    it("shows inactive exact candidates with localized status before creation", async () => {
        const inactiveCandidate = { ...profile, publicId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", name: "Dormant Agent", aliases: ["Dormant Alias"], status: "inactive" };
        vi.mocked(api.get).mockImplementation(async (url, config) => {
            if (url === "/intermediaries" && config?.params?.status === "all") return { data: [inactiveCandidate] };
            if (url === "/intermediaries") return { data: [profile] };
            throw new Error(`Unexpected GET ${url}`);
        });
        const user = userEvent.setup();
        renderList();
        await screen.findByText("Mae Mali");
        await user.click(screen.getByRole("button", { name: /new intermediary/i }));
        await user.type(screen.getByLabelText(/^name/i), "Dormant Alias");
        await user.click(screen.getByRole("button", { name: /search proposed identity/i }));
        expect(await screen.findByRole("link", { name: /Dormant Agent/i })).toBeInTheDocument();
        expect(screen.getByText("Inactive")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: /create profile/i })).toBeDisabled();
    });

    // Break caught: editing a reviewed canonical name or alias leaves the old candidate approval actionable.
    it("invalidates reviewed candidates after any proposed identity edit", async () => {
        const user = userEvent.setup();
        renderList();
        await screen.findByText("Mae Mali");
        await user.click(screen.getByRole("button", { name: /new intermediary/i }));
        const name = screen.getByLabelText(/^name/i);
        const aliases = screen.getByLabelText(/aliases/i);
        await user.type(name, "Reviewed Agent");
        await user.type(aliases, "Reviewed Alias");
        await user.click(screen.getByRole("button", { name: /search proposed identity/i }));
        await user.click(await screen.findByRole("checkbox", { name: /reviewed these candidates/i }));
        expect(screen.getByRole("button", { name: /create profile/i })).toBeEnabled();

        await user.type(name, " Changed");
        expect(screen.queryByRole("checkbox", { name: /reviewed these candidates/i })).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: /create profile/i })).toBeDisabled();
        await user.click(screen.getByRole("button", { name: /search proposed identity/i }));
        await user.click(await screen.findByRole("checkbox", { name: /reviewed these candidates/i }));
        expect(screen.getByRole("button", { name: /create profile/i })).toBeEnabled();
        await user.type(aliases, " Changed");
        expect(screen.queryByRole("checkbox", { name: /reviewed these candidates/i })).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: /create profile/i })).toBeDisabled();
    });

    // Break caught: managed loans lose their Loan Detail destination, totals are rounded through JS numbers, or review groups disappear.
    it("shows exact portfolio totals, managed-loan links, and unreconciled warnings", async () => {
        renderDetail();

        expect(await screen.findByRole("heading", { name: "Mae Mali" })).toBeInTheDocument();
        const overview = screen.getByRole("region", { name: /portfolio overview/i });
        expect(within(overview).getByText(/9,007,199,254,740,000\.01/)).toBeInTheDocument();
        expect(within(overview).getAllByText(/600\.00/)).toHaveLength(2);
        expect(within(overview).getByText(/10\.00/)).toBeInTheDocument();
        expect(within(overview).getAllByText(/123\.45/)).toHaveLength(2);
        expect(within(overview).getByText(/5,000\.00/)).toBeInTheDocument();
        expect(within(overview).getByText(/4,400\.00/)).toBeInTheDocument();
        expect(screen.getAllByRole("link", { name: /Somchai Exact/i })).toHaveLength(2);
        for (const link of screen.getAllByRole("link", { name: /Somchai Exact/i })) expect(link).toHaveAttribute("href", `/loans/${LOAN_ID}`);
        expect(screen.getByRole("alert")).toHaveTextContent(/1 disbursement group needs review/i);
        expect(screen.getByText(/Krungthai.*•••• 2233/)).toBeInTheDocument();
        expect(screen.queryByText(/1111222233/)).not.toBeInTheDocument();
    });

    // Break caught: default decimal.js precision rounds a valid 29-digit maximum, or summing multiple loans loses cents.
    it("totals max-bound and multi-loan public money without precision loss", async () => {
        const exactLoans = [{ ...managedLoans[0], outstandingPrincipal: "99999999999999999999999999999.99", outstandingInterest: "0.00", outstandingFees: "0.00" }];
        vi.mocked(api.get).mockImplementation(async (url) => {
            if (url === `/intermediaries/${INTERMEDIARY_ID}`) return { data: profile };
            if (url === `/intermediaries/${INTERMEDIARY_ID}/managed-loans`) return { data: exactLoans };
            if (url === `/intermediaries/${INTERMEDIARY_ID}/held-balance`) return { data: heldBalance };
            if (url === "/intermediated-disbursements") return { data: [] };
            throw new Error(`Unexpected GET ${url}`);
        });
        const first = renderDetail();
        expect(await screen.findAllByText(/99,999,999,999,999,999,999,999,999,999\.99/)).toHaveLength(3);
        first.unmount();

        vi.mocked(api.get).mockImplementation(async (url) => {
            if (url === `/intermediaries/${INTERMEDIARY_ID}`) return { data: profile };
            if (url === `/intermediaries/${INTERMEDIARY_ID}/managed-loans`) return { data: [
                { ...managedLoans[0], publicId: LOAN_ID, outstandingPrincipal: "10000000000000000000.01" },
                { ...managedLoans[0], publicId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", borrowerName: "Second Borrower", outstandingPrincipal: "20000000000000000000.02" },
            ] };
            if (url === `/intermediaries/${INTERMEDIARY_ID}/held-balance`) return { data: heldBalance };
            if (url === "/intermediated-disbursements") return { data: [] };
            throw new Error(`Unexpected GET ${url}`);
        });
        renderDetail();
        expect(await screen.findByText(/30,000,000,000,000,000,000\.03/)).toBeInTheDocument();
    });

    // Break caught: failed list/detail requests disappear into an unhandled promise or a server outage is mislabeled as not found.
    it("shows localized retryable list errors and distinguishes detail 404 from server failure", async () => {
        vi.mocked(api.get).mockRejectedValueOnce({ response: { status: 503 } });
        const user = userEvent.setup();
        const list = renderList();
        expect(await screen.findByRole("alert")).toHaveTextContent(/could not load intermediaries/i);
        await user.click(screen.getByRole("button", { name: /retry/i }));
        expect(await screen.findByRole("link", { name: /Mae Mali/i })).toBeInTheDocument();
        list.unmount();

        vi.mocked(api.get).mockRejectedValue({ response: { status: 404 } });
        const missing = renderDetail();
        expect(await screen.findByText(/profile not found/i)).toBeInTheDocument();
        missing.unmount();

        vi.mocked(api.get).mockRejectedValue({ response: { status: 500 } });
        renderDetail();
        expect(await screen.findByRole("alert")).toHaveTextContent(/could not load intermediary profile/i);
        expect(screen.queryByText(/profile not found/i)).not.toBeInTheDocument();
    });

    // Break caught: directory lifecycle statuses leak raw English enum values in either locale.
    it("localizes directory active and inactive statuses", async () => {
        vi.mocked(api.get).mockResolvedValue({ data: [profile, { ...profile, publicId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "Retired Agent", status: "inactive" }] });
        await appI18n.changeLanguage("th");
        renderList();
        expect(await screen.findByText("ใช้งานอยู่")).toBeInTheDocument();
        expect(screen.getByText("ปิดใช้งาน")).toBeInTheDocument();
    });

    // Break caught: ended assignments are filtered out or the profile redesign removes the established collections/remittances access.
    it("retains assignment history and remittance access", async () => {
        renderDetail();

        expect(await screen.findByText("Historical Borrower")).toBeInTheDocument();
        expect(screen.getByText("Ended")).toBeInTheDocument();
        expect(screen.getByRole("link", { name: /collections and remittances/i })).toHaveAttribute("href", `/intermediaries/remittances?intermediaryPublicId=${INTERMEDIARY_ID}`);
    });

    // Break caught: new intermediary screens fall back to English while the active product language is Thai.
    it("localizes the profile workspace in Thai", async () => {
        await appI18n.changeLanguage("th");
        renderDetail();

        expect(await screen.findByRole("region", { name: "ภาพรวมพอร์ต" })).toBeInTheDocument();
        expect(screen.getByRole("link", { name: /ยอดเก็บและรายการนำส่ง/i })).toBeInTheDocument();
    });
});
