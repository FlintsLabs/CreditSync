import { render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import LoanDetail from "../src/pages/dashboard/loans/LoanDetail";
import { api } from "../src/lib/api";
import appI18n from "../src/lib/i18n";

vi.mock("../src/lib/api", () => ({ api: { get: vi.fn(), post: vi.fn() } }));
vi.mock("../src/lib/session", () => ({ getStoredUser: () => null, isTenantAdminUser: () => false }));
vi.mock("../src/pages/dashboard/loans/LoanRenewalPanel", () => ({ LoanRenewalPanel: () => null }));
vi.mock("../src/pages/dashboard/loans/LoanDisbursements", () => ({ LoanDisbursements: () => null }));
vi.mock("../src/pages/dashboard/loans/LoanRepaymentHistory", () => ({ LoanRepaymentHistory: () => null }));
vi.mock("../src/pages/dashboard/loans/LoanRestructurePanel", () => ({ LoanRestructurePanel: () => <div data-testid="restructure-panel" /> }));

const LOAN_ID = "019ff023-fd64-7d41-9aae-723d2a458a8a";
const BORROWER_ID = "019fea17-6068-7ccb-b267-9f39880bb762";
const loan = {
    id: LOAN_ID,
    publicId: LOAN_ID,
    borrowerPublicId: BORROWER_ID,
    principalAmount: "47000.00",
    interestRate: "0.00",
    repaymentType: "monthly",
    termMonths: 12,
    installmentAmount: "200.00",
    totalInstallments: 12,
    startDate: "2026-07-01",
    nextDueDate: "2026-07-01",
    outstandingPrincipal: "47000.00",
    outstandingInterest: "0.00",
    outstandingFees: "0.00",
    status: "active",
};

function renderLoanDetail(tags: string[] | null) {
    vi.mocked(api.get).mockImplementation(async (url) => {
        if (url === `/loans/${LOAN_ID}`) {
            return { data: loan };
        }
        if (url === `/borrowers/${BORROWER_ID}`) {
            return { data: { id: BORROWER_ID, publicId: BORROWER_ID, name: "ภัทรภร วงษ์สุวรรณ", phone: "0812345678", tags } };
        }
        if (url.endsWith("/schedule") || url.endsWith("/funding-allocations")) {
            return { data: [] };
        }
        if (url.endsWith("/allocation-state")) {
            return {
                data: {
                    principalAmount: "47000.00",
                    netAllocatedPrincipal: "0.00",
                    remainingGap: "47000.00",
                    overfundedAmount: "0.00",
                    state: "unfunded",
                },
            };
        }
        throw new Error(`Unexpected GET ${url}`);
    });

    return render(
        <MemoryRouter initialEntries={[`/loans/${LOAN_ID}`]}>
            <Routes>
                <Route path="/loans/:id" element={<LoanDetail />} />
            </Routes>
        </MemoryRouter>,
    );
}

describe("Loan detail borrower tags", () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        await appI18n.changeLanguage("th");
    });

    it("shows the first three borrower tags and the hidden count", async () => {
        renderLoanDetail(["VIP", "Facebook", "แนะนำต่อ", "ติดตามพิเศษ"]);

        const tags = await screen.findByTestId("loan-borrower-tags");
        expect(within(tags).getByText("VIP")).toBeInTheDocument();
        expect(within(tags).getByText("Facebook")).toBeInTheDocument();
        expect(within(tags).getByText("แนะนำต่อ")).toBeInTheDocument();
        expect(within(tags).getByText("+1")).toBeInTheDocument();
        expect(within(tags).queryByText("ติดตามพิเศษ")).not.toBeInTheDocument();
    });

    it("omits the tag row when the borrower has no tags", async () => {
        renderLoanDetail(null);

        await screen.findByText("ภัทรภร วงษ์สุวรรณ");
        expect(screen.queryByTestId("loan-borrower-tags")).not.toBeInTheDocument();
    });
});
