import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import MatchingWorkspace from "../src/pages/dashboard/loans/MatchingWorkspace";
import { api } from "../src/lib/api";
import i18n from "../src/lib/i18n";

vi.mock("../src/lib/api", () => ({ api: { get: vi.fn(), post: vi.fn() } }));

const LOAN_ID = "11111111-1111-4111-8111-111111111111";
const DRAWDOWN_ID = "22222222-2222-4222-8222-222222222222";

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
        if (url === "/bank-profiles") return { data: [{ id: 7, name: "Exact bank" }] };
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
    const inputs = screen.getAllByRole("spinbutton");
    return inputs[inputs.length - 1]!;
}

describe("MatchingWorkspace exact allocation contract", () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        await i18n.changeLanguage("en");
        mockWorkspaceApi();
    });

    // Break caught: string allocation-state responses are coerced through Number before display or posting.
    it("consumes exact backend money strings and posts the normalized allocation unchanged", async () => {
        const user = userEvent.setup();
        renderWorkspace();

        expect((await screen.findAllByText(/9,007,199,254,741,000\.00/)).length).toBeGreaterThan(0);
        expect(screen.getAllByText(/6\.90/).length).toBeGreaterThan(0);

        await user.type(await allocationInput(), "0.20");
        expect(screen.getAllByText(/6\.70/).length).toBeGreaterThan(0);
        await user.click(screen.getByRole("button", { name: "Save Allocations" }));

        await waitFor(() => expect(api.post).toHaveBeenCalledWith(`/loans/${LOAN_ID}/funding-allocations`, {
            bankLoanPublicId: DRAWDOWN_ID,
            allocatedAmount: "0.20",
            allocationDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
            allocationType: "initial",
        }));
    });

    // Break caught: transient or malformed number-input text reaches strict money arithmetic and crashes render.
    it.each(["1.234", "1e3", ""])("rejects raw allocation %j without crashing or posting", async (rawValue) => {
        const user = userEvent.setup();
        renderWorkspace();
        const input = await allocationInput();

        fireEvent.change(input, { target: { value: rawValue } });
        await user.click(screen.getByRole("button", { name: "Save Allocations" }));

        expect(await screen.findByText("Enter allocation amounts with at most two decimal places.")).toBeInTheDocument();
        expect(api.post).not.toHaveBeenCalled();
    });
});
