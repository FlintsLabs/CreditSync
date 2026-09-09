import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import FundDetail from "../src/pages/dashboard/funds/FundDetail";
import { api } from "../src/lib/api";
import en from "../src/locales/en.json";
import th from "../src/locales/th.json";

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
        expect(screen.getByText("Contract-attributed revenue").closest("div")).toHaveTextContent(/1,466\.67/);
        expect(screen.getByText("Ledger-recorded revenue").closest("div")).toHaveTextContent(/510\.00/);
        expect(screen.getByText("Difference").closest("div")).toHaveTextContent(/956\.67/);
        const status = screen.getByText("Needs reconciliation");
        expect(status).toHaveClass("bg-amber-100", "text-amber-800");
        expect(screen.getByText("This status does not alter financial records.")).toBeInTheDocument();
        expect(screen.getByText(/9,007,199,254,740,993\.01/)).toBeInTheDocument();
    });

    it("opens an accessible metric definition from the information control", async () => {
        const user = userEvent.setup();
        renderDetail();

        const info = await screen.findByRole("button", { name: "About Realized spread" });
        await user.click(info);

        expect(await screen.findByRole("tooltip")).toHaveTextContent(
            "Revenue already recognized after cash source costs.",
        );
    });

    it("gives every summary metric a decorative semantic icon and localized information control", async () => {
        const { container } = renderDetail();

        expect(await screen.findByText("Cumulative net cash received")).toBeInTheDocument();
        expect(screen.getByText("Cumulative net cash paid")).toBeInTheDocument();
        expect(screen.getAllByRole("button", { name: /^About / })).toHaveLength(14);

        const icons = container.querySelectorAll("[data-fund-metric-icon]");
        expect(icons).toHaveLength(14);
        for (const icon of icons) expect(icon).toHaveAttribute("aria-hidden", "true");
    });

    it("keeps English and Thai fund metric definitions in parity", () => {
        expect(Object.keys(th.fundDetail.metricInfo).sort()).toEqual(
            Object.keys(en.fundDetail.metricInfo).sort(),
        );
    });

    // Break caught: FundDetail still types allocation-state money as numbers and rounds the backend's string contract for display.
    it("renders selected drawdown allocation-state strings without native-number rounding", async () => {
        const user = userEvent.setup();
        const debtFund = { ...fund, type: "bank", accountingMode: "debt_facility" };
        const drawdown = {
            id: 9,
            amount: "1000.00",
            interestRate: "12.00",
            startDate: "2026-08-01",
            termMonths: 12,
            repaymentCycle: "monthly",
            repaymentMode: "fixed_installment",
            installmentAmount: "100.00",
            totalInstallments: 12,
            nextDueDate: "2026-09-01",
            outstandingPrincipal: "1000.00",
            outstandingInterest: "0.00",
            outstandingFees: "0.00",
            status: "active",
        };
        vi.mocked(api.get).mockImplementation(async (url) => {
            if (url === `/bank-profiles/${FUND_ID}`) return { data: debtFund };
            if (url === "/bank-loans") return { data: [drawdown] };
            if (url === "/bank-profiles") return { data: [debtFund] };
            if (url === `/bank-profiles/${FUND_ID}/settlement-summary`) return { data: { realizedSpread: "0.00", unrealizedSpread: "0.00", surplusBalance: "0.00", deficitBalance: "0.00", carryForwardAvailable: "0.00" } };
            if (url === `/bank-profiles/${FUND_ID}/profitability`) return { data: { borrowerCashCollected: "0.00", borrowerRevenueCollected: "0.00", fundCostPaid: "0.00", realizedSpread: "0.00", unrealizedSpread: "0.00", deployedPrincipal: "0.00", netCashPosition: "0.00", realizedRoiPercent: "0.00", carryForwardAvailable: "0.00", reconciliation: { contractAttributedRevenue: "0.00", ledgerRecordedRevenue: "0.00", difference: "0.00", status: "matched" } } };
            if (url === "/fund-rollovers") return { data: [] };
            if (url === `/bank-profiles/${FUND_ID}/funding-usage`) return { data: fundingUsage };
            if (url === "/bank-loans/9/schedule" || url === "/bank-loans/9/repayments" || url === "/bank-loans/9/allocations") return { data: [] };
            if (url === "/bank-loans/9/profitability") return { data: { borrowerRevenueCollected: 0, fundCostPaid: 0, realizedSpread: 0, unrealizedSpread: 0, deployedPrincipal: 0, netCashPosition: 0, realizedRoiPercent: 0, carryForwardAvailable: 0, outstandingCost: 0, surplusBalance: 0, deficitBalance: 0 } };
            if (url === "/bank-loans/9/allocation-state") return { data: {
                bankLoanId: 9,
                drawdownAmount: "99999999999999999999999999999.99",
                netAllocatedPrincipal: "99999999999999999999999999999.98",
                remainingCapacity: "0.01",
                overallocatedAmount: "0.00",
                state: "partially_allocated",
            } };
            throw new Error(`Unexpected GET ${url}`);
        });

        renderDetail();
        await user.click(await screen.findByRole("button", { name: /Withdrawal #9/ }));

        const allocated = await screen.findByText("Allocated principal");
        expect(allocated.parentElement).toHaveTextContent(/99,999,999,999,999,999,999,999,999,999\.98/);
        expect(screen.getByText("Remaining capacity").parentElement).toHaveTextContent(/0\.01/);
    });
});
