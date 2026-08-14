import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import IntermediaryList from "../src/pages/dashboard/intermediaries/IntermediaryList";
import IntermediaryDetail from "../src/pages/dashboard/intermediaries/IntermediaryDetail";
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
            if (url === "/intermediated-disbursements") return { data: groups };
            throw new Error(`Unexpected GET ${url}`);
        });
    });

    // Break caught: the directory stops querying canonical intermediary search or cannot create a profile from the same workspace.
    it("searches and creates intermediary profiles", async () => {
        vi.mocked(api.post).mockResolvedValue({ data: { ...profile, publicId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "New Agent" } });
        const user = userEvent.setup();
        renderList();

        expect(await screen.findByRole("link", { name: /Mae Mali/i })).toHaveAttribute("href", `/intermediaries/${INTERMEDIARY_ID}`);
        await user.type(screen.getByRole("searchbox", { name: /search intermediaries/i }), "Mali Agent");
        await user.click(screen.getByRole("button", { name: /search/i }));
        await waitFor(() => expect(api.get).toHaveBeenLastCalledWith("/intermediaries", { params: { q: "Mali Agent" } }));

        await user.click(screen.getByRole("button", { name: /new intermediary/i }));
        await user.type(screen.getByLabelText(/name/i), "New Agent");
        await user.click(screen.getByRole("button", { name: /create profile/i }));
        await waitFor(() => expect(api.post).toHaveBeenCalledWith("/intermediaries", { name: "New Agent" }));
    });

    // Break caught: managed loans lose their Loan Detail destination, totals are rounded through JS numbers, or review groups disappear.
    it("shows exact portfolio totals, managed-loan links, and unreconciled warnings", async () => {
        renderDetail();

        expect(await screen.findByRole("heading", { name: "Mae Mali" })).toBeInTheDocument();
        const overview = screen.getByRole("region", { name: /portfolio overview/i });
        expect(within(overview).getByText(/9,007,199,254,740,000\.01/)).toBeInTheDocument();
        expect(within(overview).getByText(/600\.00/)).toBeInTheDocument();
        expect(within(overview).getByText(/10\.00/)).toBeInTheDocument();
        expect(within(overview).getByText(/123\.45/)).toBeInTheDocument();
        expect(screen.getAllByRole("link", { name: /Somchai Exact/i })).toHaveLength(2);
        for (const link of screen.getAllByRole("link", { name: /Somchai Exact/i })) expect(link).toHaveAttribute("href", `/loans/${LOAN_ID}`);
        expect(screen.getByRole("alert")).toHaveTextContent(/1 disbursement group needs review/i);
        expect(screen.getByText(/Krungthai.*•••• 2233/)).toBeInTheDocument();
        expect(screen.queryByText(/1111222233/)).not.toBeInTheDocument();
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
