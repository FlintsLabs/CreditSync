import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import LoanDetail from "../src/pages/dashboard/loans/LoanDetail";
import { api } from "../src/lib/api";
import appI18n from "../src/lib/i18n";

vi.mock("../src/lib/api", () => ({ api: { get: vi.fn(), post: vi.fn(), put: vi.fn() }, resolveFileAccess: vi.fn() }));
vi.mock("../src/lib/session", () => ({ getStoredUser: () => null, isTenantAdminUser: () => false }));
vi.mock("../src/pages/dashboard/loans/LoanRenewalPanel", () => ({ LoanRenewalPanel: () => null }));
vi.mock("../src/pages/dashboard/loans/LoanRepaymentHistory", () => ({ LoanRepaymentHistory: () => null }));
vi.mock("../src/pages/dashboard/loans/LoanRestructurePanel", () => ({ LoanRestructurePanel: () => null }));
vi.mock("../src/pages/dashboard/loans/FloatingInterestRateCard", () => ({ FloatingInterestRateCard: () => null }));
vi.mock("../src/pages/dashboard/loans/IntermediatedDisbursementPanel", () => ({ IntermediatedDisbursementPanel: () => null }));

const LOAN_ID = "019ffb21-f852-7375-8605-5adc6f0beb51";
const loan = {
    id: LOAN_ID,
    publicId: LOAN_ID,
    borrowerPublicId: null,
    principalAmount: "5000.00",
    interestRate: "0.00",
    repaymentType: "floating",
    termMonths: null,
    installmentAmount: null,
    totalInstallments: null,
    startDate: "2026-08-13",
    nextDueDate: "2026-08-20",
    outstandingPrincipal: "5000.00",
    outstandingInterest: "0.00",
    outstandingFees: "0.00",
    status: "active",
    floatingInterestPolicy: {
        periodUnit: "week",
        periodLength: 1,
        rateMode: "percent",
        rate: "12.0000",
        advanceInterestPeriods: 1,
        advanceInterestRefundPolicy: "non_refundable",
    },
    floatingPayoutSummary: {
        fullPeriodInterest: "600.00",
        advanceInterest: "600.00",
        netBorrowerPayout: "4400.00",
        periodDays: 7,
        firstPeriodStartDate: "2026-08-13",
        firstPeriodDueDate: "2026-08-20",
    },
};

function renderDetail(summary: { postedGrossAmount: string; postedEventCount: number }) {
    vi.mocked(api.get).mockImplementation(async (url) => {
        if (url === `/loans/${LOAN_ID}`) return { data: loan };
        if (url === `/loans/${LOAN_ID}/schedule` || url === `/loans/${LOAN_ID}/funding-allocations`) return { data: [] };
        if (url === `/loans/${LOAN_ID}/allocation-state`) return { data: { principalAmount: "5000.00", netAllocatedPrincipal: "0.00", remainingGap: "5000.00", overfundedAmount: "0.00", state: "unfunded" } };
        if (url === `/loans/${LOAN_ID}/disbursements`) return { data: { loanPublicId: LOAN_ID, summary: { approvedPrincipal: "5000.00", netDisbursed: "5000.00", variance: "0.00", status: "matched", ...summary }, events: [] } };
        throw new Error(`Unexpected GET ${url}`);
    });
    return render(<MemoryRouter initialEntries={[`/loans/${LOAN_ID}`]}><Routes><Route path="/loans/:id" element={<LoanDetail />} /></Routes></MemoryRouter>);
}

describe("floating advance-interest loan detail", () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        await appI18n.changeLanguage("th");
    });

    it("renders the backend-owned advance interest and net borrower payout", async () => {
        renderDetail({ postedGrossAmount: "4400.00", postedEventCount: 1 });

        expect(await screen.findByText("ดอกเบี้ยล่วงหน้า")).toBeInTheDocument();
        expect(screen.getAllByText(/600\.00/)).toHaveLength(2);
        expect(screen.getByText("ยอดสุทธิที่จ่ายให้ผู้กู้")).toBeInTheDocument();
        expect(screen.getAllByText(/4,400\.00/).length).toBeGreaterThan(0);
    });

    it("warns only when an effective posted gross payout differs from the contract net payout", async () => {
        const first = renderDetail({ postedGrossAmount: "4300.00", postedEventCount: 1 });
        expect(await screen.findByRole("status")).toHaveTextContent(/4,300\.00/);
        expect(screen.getByRole("status")).toHaveTextContent(/4,400\.00/);

        first.unmount();
        renderDetail({ postedGrossAmount: "0.00", postedEventCount: 0 });
        expect(await screen.findByText("ดอกเบี้ยล่วงหน้า")).toBeInTheDocument();
        expect(screen.queryByRole("status")).not.toBeInTheDocument();
    });
});
