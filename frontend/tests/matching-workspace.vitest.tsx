import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import MatchingWorkspace from "../src/pages/dashboard/loans/MatchingWorkspace";
import { api } from "../src/lib/api";
import i18n from "../src/lib/i18n";

vi.mock("../src/lib/api", () => ({ api: { get: vi.fn(), post: vi.fn() } }));

const LOAN_ID = "11111111-1111-4111-8111-111111111111";
const DRAWDOWN_ID = "22222222-2222-4222-8222-222222222222";
const CAPITAL_ID = "44444444-4444-4444-8444-444444444444";

function mockWorkspaceApi() {
    vi.mocked(api.get).mockImplementation(async (url) => {
        if (url === "/loans") return { data: [{
            id: LOAN_ID,
            borrowerId: "33333333-3333-4333-8333-333333333333",
            borrowerName: "Exact borrower",
            principal: "9007199254741000.00",
            status: "active",
            repaymentType: "monthly",
            createdAt: "2026-08-14T00:00:00.000Z",
            interestRate: "0.00",
        }] };
        if (url === "/bank-loans") return { data: [{
            id: 1,
            publicId: DRAWDOWN_ID,
            bankProfileId: 7,
            amount: "9007199254741000.00",
            outstandingPrincipal: "9007199254741000.00",
            nextDueDate: null,
            status: "active",
        }] };
        if (url === "/bank-profiles") return { data: [
            { id: 7, publicId: "55555555-5555-4555-8555-555555555555", name: "Exact bank", accountingMode: "external_liability", status: "active", creditLimit: "9007199254741000.00" },
            { id: 8, publicId: CAPITAL_ID, name: "Owner capital", accountingMode: "capital_pool", status: "active", creditLimit: "10.00" },
        ] };
        if (url === `/bank-profiles/${CAPITAL_ID}/funding-usage`) return { data: {
            accountingMode: "capital_pool",
            creditLimit: "10.00",
            netAllocatedPrincipal: "3.10",
            availableAmount: "6.90",
            linkedBorrowerCashCollected: "0.00",
            utilizationPercent: "31.00",
            allocations: [],
        } };
        if (url === `/loans/${LOAN_ID}/allocation-state`) return { data: {
            loanId: LOAN_ID,
            principalAmount: "9007199254741000.00",
            netAllocatedPrincipal: "9007199254740993.10",
            remainingGap: "6.90",
            overfundedAmount: "0.00",
            state: "partially_funded",
        } };
        if (url === `/bank-loans/${DRAWDOWN_ID}/allocation-state`) return { data: {
            bankLoanId: DRAWDOWN_ID,
            drawdownAmount: "9007199254741000.00",
            netAllocatedPrincipal: "9007199254740993.10",
            remainingCapacity: "6.90",
            overallocatedAmount: "0.00",
            state: "partially_allocated",
        } };
        if (url === `/loans/${LOAN_ID}/funding-allocations`) return { data: [] };
        if (url === `/loans/${LOAN_ID}/profitability`) return { data: {
            borrowerRevenueCollected: "0.00",
            fundCostPaid: "0.00",
            realizedSpread: "0.00",
            unrealizedSpread: "0.00",
            fundedPrincipal: "9007199254740993.10",
            unallocatedPrincipalGap: "6.90",
        } };
        throw new Error(`Unexpected GET ${url}`);
    });
    vi.mocked(api.post).mockResolvedValue({ data: {} });
}

function renderWorkspace() {
    return render(<MemoryRouter><MatchingWorkspace /></MemoryRouter>);
}

async function allocationInput() {
    await screen.findAllByText("Exact borrower");
    return screen.getByRole("spinbutton", { name: `Allocate Amount ${DRAWDOWN_ID}` });
}

describe("MatchingWorkspace exact allocation contract", () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        await i18n.changeLanguage("en");
        mockWorkspaceApi();
    });

    // Break caught: string allocation-state responses are coerced through Number before display or posting.
    it("reviews exact money strings before posting the normalized allocation unchanged", async () => {
        const user = userEvent.setup();
        renderWorkspace();

        expect((await screen.findAllByText(/9,007,199,254,741,000\.00/)).length).toBeGreaterThan(0);
        expect(screen.getAllByText(/6\.90/).length).toBeGreaterThan(0);

        await user.type(await allocationInput(), "0.20");
        expect(screen.getAllByText(/6\.70/).length).toBeGreaterThan(0);
        await user.click(screen.getByRole("button", { name: "Next: Review Allocation" }));

        expect(api.post).not.toHaveBeenCalled();
        expect(await screen.findByRole("heading", { name: "Review Allocation" })).toBeInTheDocument();
        expect(screen.getAllByText("Exact borrower").length).toBeGreaterThan(0);
        expect(screen.getByText(DRAWDOWN_ID)).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Confirm and Save Allocation" }));

        await waitFor(() => expect(api.post).toHaveBeenCalledWith(`/loans/${LOAN_ID}/funding-allocations`, {
            bankLoanPublicId: DRAWDOWN_ID,
            allocatedAmount: "0.20",
            allocationDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
            allocationType: "initial",
        }, { headers: { "Idempotency-Key": expect.any(String) } }));
    });

    // Break caught: transient or malformed number-input text reaches strict money arithmetic and crashes render.
    it.each(["1.234", "1e3", ""])("rejects raw allocation %j without crashing or posting", async (rawValue) => {
        const user = userEvent.setup();
        renderWorkspace();
        const input = await allocationInput();

        fireEvent.change(input, { target: { value: rawValue } });
        await user.click(screen.getByRole("button", { name: "Next: Review Allocation" }));

        expect(await screen.findByText("Enter allocation amounts with at most two decimal places.")).toBeInTheDocument();
        expect(api.post).not.toHaveBeenCalled();
    });

    it("blocks an allocation that exceeds the contract gap or source capacity", async () => {
        const user = userEvent.setup();
        renderWorkspace();

        await user.type(await allocationInput(), "7.00");
        await user.click(screen.getByRole("button", { name: "Next: Review Allocation" }));

        expect(await screen.findByText("Allocation total cannot exceed the remaining contract gap or source capacity.")).toBeInTheDocument();
        expect(screen.queryByRole("heading", { name: "Review Allocation" })).not.toBeInTheDocument();
        expect(api.post).not.toHaveBeenCalled();
    });

    it("reviews and posts an active own-capital pool with bankProfilePublicId", async () => {
        const user = userEvent.setup();
        renderWorkspace();

        expect(await screen.findByText("Owner capital")).toBeInTheDocument();
        expect(screen.getByText("Own capital")).toBeInTheDocument();
        await user.type(screen.getByRole("spinbutton", { name: `Allocate Amount ${CAPITAL_ID}` }), "6.90");
        await user.click(screen.getByRole("button", { name: "Next: Review Allocation" }));
        expect(await screen.findByRole("heading", { name: "Review Allocation" })).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Confirm and Save Allocation" }));

        await waitFor(() => expect(api.post).toHaveBeenCalledWith(`/loans/${LOAN_ID}/funding-allocations`, {
            bankProfilePublicId: CAPITAL_ID,
            allocatedAmount: "6.90",
            allocationDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
            allocationType: "initial",
        }, { headers: { "Idempotency-Key": expect.any(String) } }));
    });

    it("reuses the allocation idempotency key when confirmation is retried", async () => {
        const user = userEvent.setup();
        vi.mocked(api.post).mockRejectedValue(new Error("temporary failure"));
        renderWorkspace();

        await user.type(await allocationInput(), "0.20");
        await user.click(screen.getByRole("button", { name: "Next: Review Allocation" }));
        const confirm = await screen.findByRole("button", { name: "Confirm and Save Allocation" });
        await user.click(confirm);
        await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
        await user.click(confirm);
        await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));

        const firstKey = vi.mocked(api.post).mock.calls[0]?.[2]?.headers?.["Idempotency-Key"];
        const retryKey = vi.mocked(api.post).mock.calls[1]?.[2]?.headers?.["Idempotency-Key"];
        expect(firstKey).toEqual(expect.any(String));
        expect(retryKey).toBe(firstKey);
    });

    // Break caught: the contract rail cannot narrow a long queue by borrower or contract id.
    it("filters the contract rail by borrower name or contract id", async () => {
        const user = userEvent.setup();
        renderWorkspace();

        expect((await screen.findAllByText("Exact borrower")).length).toBeGreaterThan(0);
        await user.type(screen.getByRole("searchbox", { name: "Search borrower or contract ID" }), "missing contract");
        const contractRail = screen.getByRole("complementary");
        expect(within(contractRail).queryByText("Exact borrower")).not.toBeInTheDocument();
        expect(within(contractRail).getByText("No contracts match this search.")).toBeInTheDocument();

        await user.clear(screen.getByRole("searchbox", { name: "Search borrower or contract ID" }));
        await user.type(screen.getByRole("searchbox", { name: "Search borrower or contract ID" }), LOAN_ID.slice(0, 8));
        expect(screen.getAllByText("Exact borrower").length).toBeGreaterThan(0);
    });
});
