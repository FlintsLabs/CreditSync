import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import FundDetail from "../src/pages/dashboard/funds/FundDetail";
import { api } from "../src/lib/api";

vi.mock("../src/lib/api", () => ({ api: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }));

const FUND_ID = "11111111-1111-4111-8111-111111111111";
const LOAN_ID = "22222222-2222-4222-8222-222222222222";

const fund = {
    id: 1,
    publicId: FUND_ID,
    name: "Owner Capital",
    type: "personal",
    accountingMode: "capital_pool",
    creditLimit: "60000.00",
    status: "active",
};

const fundingUsage = {
    accountingMode: "capital_pool",
    creditLimit: "60000.00",
    netAllocatedPrincipal: "7000.00",
    availableAmount: "53000.00",
    utilizationPercent: "11.67",
    allocations: [{
        loanPublicId: LOAN_ID,
        borrowerPublicId: "33333333-3333-4333-8333-333333333333",
        borrowerName: "Current borrower",
        loanStatus: "active",
        principalAmount: "7000.00",
        outstandingPrincipal: "5000.00",
        netAllocatedAmount: "7000.00",
        collectedInterest: "23.33",
        latestAllocationDate: "2026-08-07",
        fundingRoutes: [{ type: "direct", bankLoanPublicId: null, netAllocatedAmount: "7000.00" }],
    }],
};

function renderDetail() {
    return render(
        <MemoryRouter initialEntries={[`/funds/${FUND_ID}`]}>
            <Routes><Route path="/funds/:id" element={<FundDetail />} /></Routes>
        </MemoryRouter>,
    );
}

describe("FundDetail funding usage", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(api.get).mockImplementation(async (url, config) => {
            if (url === `/bank-profiles/${FUND_ID}`) return { data: fund };
            if (url === "/bank-loans") return { data: [] };
            if (url === "/bank-profiles") return { data: [fund] };
            if (url === `/bank-profiles/${FUND_ID}/settlement-summary`) return { data: { realizedSpread: "1466.67", unrealizedSpread: "0.00", surplusBalance: "3800.00", deficitBalance: "0.00", carryForwardAvailable: "3800.00" } };
            if (url === `/bank-profiles/${FUND_ID}/profitability`) return { data: {
                borrowerCashCollected: "3800.00",
                borrowerRevenueCollected: "1466.67",
                fundCostPaid: "0.00",
                realizedSpread: "1466.67",
                unrealizedSpread: "0.00",
                deployedPrincipal: "21500.00",
                netCashPosition: "3800.00",
                realizedRoiPercent: "6.82",
                carryForwardAvailable: "3800.00",
                opportunityCostAccrued: "7.25",
                economicSpread: "9007199254740993.01",
                reconciliation: {
                    contractAttributedRevenue: "1466.67",
                    ledgerRecordedRevenue: "510.00",
                    difference: "956.67",
                    status: "needs_reconciliation",
                },
            } };
            if (url === "/fund-rollovers") return { data: [] };
            if (url === `/bank-profiles/${FUND_ID}/funding-usage`) {
                return { data: config?.params?.includeSettled === "true" ? fundingUsage : fundingUsage };
            }
            throw new Error(`Unexpected GET ${url}`);
        });
    });

    // Break caught: direct own-capital allocations are omitted from the available-capital card and source loan list.
    it("shows net own-capital availability and the borrower loan using the source", async () => {
        renderDetail();

        expect(await screen.findByText(/53,000\.00/)).toBeInTheDocument();
        expect(screen.getByText(/12%.*used/i)).toBeInTheDocument();
        expect(screen.getByText("Loans using this funding source")).toBeInTheDocument();
        expect(screen.getAllByText("Current borrower")).toHaveLength(1);
        expect(screen.getAllByText(/7,000\.00/).length).toBeGreaterThan(0);
        expect(screen.getAllByText("Direct own-capital allocation")).toHaveLength(2);
        expect(screen.queryByRole("button", { name: /add drawdown/i })).not.toBeInTheDocument();
    });

    // Break caught: nested allocation cards obscure hierarchy, raw statuses lack semantics, or source interest is omitted.
    it("uses a flat responsive list with source interest and a semantic status badge", async () => {
        renderDetail();

        const summary = await screen.findByTestId("funding-summary-grid");
        expect(summary).toHaveClass("md:grid-cols-2", "2xl:grid-cols-3");
        expect(screen.getByTestId("funding-available-amount")).toHaveClass("min-w-0", "tabular-nums", "text-2xl");

        const list = screen.getByTestId("funding-usage-list");
        expect(screen.queryByTestId("funding-usage-cards")).not.toBeInTheDocument();
        expect(list).toHaveClass("divide-y");
        expect(list).toHaveTextContent("Current borrower");
        expect(list).toHaveTextContent("Direct own-capital allocation");
        expect(list).toHaveTextContent("Interest collected for this funding source");
        expect(list).toHaveTextContent(/23\.33/);
        const status = screen.getByText("Active");
        expect(status).toHaveClass("bg-emerald-100", "text-emerald-800");
        expect(screen.getByRole("link", { name: /Current borrower/ })).toHaveAttribute("href", `/loans/${LOAN_ID}`);
    });

    // Break caught: operators cannot reveal settled allocations from a capital-source page.
    it("reloads source usage when settled loans are included", async () => {
        const user = userEvent.setup();
        renderDetail();

        await user.click(await screen.findByRole("checkbox", { name: /include settled loans/i }));
        await waitFor(() => expect(api.get).toHaveBeenCalledWith(
            `/bank-profiles/${FUND_ID}/funding-usage`,
            { params: { includeSettled: "true" } },
        ));
    });

    it("shows exact contract-to-ledger revenue reconciliation with semantic status", async () => {
        renderDetail();

        expect(await screen.findByText("Data reconciliation")).toBeInTheDocument();
        expect(screen.getByText("Contract-attributed revenue").parentElement).toHaveTextContent(/1,466\.67/);
        expect(screen.getByText("Ledger-recorded revenue").parentElement).toHaveTextContent(/510\.00/);
        expect(screen.getByText("Difference").parentElement).toHaveTextContent(/956\.67/);
        const status = screen.getByText("Needs reconciliation");
        expect(status).toHaveClass("bg-amber-100", "text-amber-800");
        expect(screen.getByText("This status does not alter financial records.")).toBeInTheDocument();
        expect(screen.getByText(/9,007,199,254,740,993\.01/)).toBeInTheDocument();
    });
});
