import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import LoanDetail from "../src/pages/dashboard/loans/LoanDetail";
import { api } from "../src/lib/api";
import appI18n from "../src/lib/i18n";

vi.mock("../src/lib/api", () => ({ api: { get: vi.fn(), post: vi.fn() } }));
vi.mock("../src/lib/session", () => ({ getStoredUser: () => null, isTenantAdminUser: () => false }));
vi.mock("../src/pages/dashboard/loans/FloatingInterestRateCard", () => ({ FloatingInterestRateCard: () => null }));
vi.mock("../src/pages/dashboard/loans/LoanRenewalPanel", () => ({ LoanRenewalPanel: () => null }));
vi.mock("../src/pages/dashboard/loans/LoanDisbursements", () => ({ LoanDisbursements: () => null }));
vi.mock("../src/pages/dashboard/loans/LoanRepaymentHistory", () => ({ LoanRepaymentHistory: () => null }));

const LOAN_ID = "019ff023-fd64-7d41-9aae-723d2a458a8a";
const BORROWER_ID = "019fea17-6068-7ccb-b267-9f39880bb762";
const PREVIEW_1 = "019fea17-6068-7ccb-b267-9f39880bb763";
const PREVIEW_2 = "019fea17-6068-7ccb-b267-9f39880bb764";
const HASH_1 = `v1:${"a".repeat(64)}`;
const HASH_2 = `v1:${"b".repeat(64)}`;

const loan = {
    id: LOAN_ID,
    publicId: LOAN_ID,
    borrowerPublicId: BORROWER_ID,
    principalAmount: "9007199254740993.01",
    interestRate: "0.00",
    repaymentType: "floating",
    termMonths: null,
    installmentAmount: null,
    totalInstallments: null,
    startDate: "2026-08-14",
    nextDueDate: null,
    outstandingPrincipal: "9007199254740993.01",
    outstandingInterest: "600.00",
    outstandingFees: "10.00",
    status: "active",
    floatingInterestPolicy: {
        periodUnit: "week",
        periodLength: 1,
        rateMode: "percent",
        rate: "12.0000",
        advanceInterestPeriods: 1,
        advanceInterestRefundPolicy: "non_refundable",
    },
};

function settlementPreview(publicId: string, previewHash: string, total: string) {
    return {
        id: publicId,
        publicId,
        loanPublicId: LOAN_ID,
        status: "ready",
        asOfDate: "2026-08-17",
        outstandingPrincipal: "9007199254740993.01",
        dueInterest: "600.00",
        accruedNotDueInterest: "257.14",
        outstandingFees: total.endsWith("70.15") ? "15.00" : "10.00",
        outstandingPenalties: "5.00",
        nonRefundableAdvanceInterest: "600.00",
        settlementTotal: total,
        balanceVersion: `v1:${"c".repeat(64)}`,
        previewHash,
        expiresAt: "2026-08-17T10:15:00.000Z",
    };
}

function renderLoanDetail() {
    return render(
        <MemoryRouter initialEntries={[`/loans/${LOAN_ID}`]}>
            <Routes><Route path="/loans/:id" element={<LoanDetail />} /></Routes>
        </MemoryRouter>,
    );
}

describe("floating-loan detail and exact settlement", () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        await appI18n.changeLanguage("en");
        vi.mocked(api.get).mockImplementation(async (url) => {
            if (url === `/loans/${LOAN_ID}`) return { data: loan };
            if (url === `/borrowers/${BORROWER_ID}`) return { data: { id: BORROWER_ID, publicId: BORROWER_ID, name: "Exact Borrower" } };
            if (url.endsWith("/schedule") || url.endsWith("/funding-allocations")) return { data: [] };
            if (url.endsWith("/allocation-state")) return { data: { principalAmount: loan.principalAmount, netAllocatedPrincipal: "0.00", remainingGap: loan.principalAmount, overfundedAmount: "0.00", state: "unfunded" } };
            throw new Error(`Unexpected GET ${url}`);
        });
    });

    // Break caught: a stale settlement can execute under an old confirmation, omit a component, or lose cents beyond Number.MAX_SAFE_INTEGER.
    it("shows every exact component and requires reconfirmation after an automatic stale refresh", async () => {
        let previewCount = 0;
        let executeCount = 0;
        const first = settlementPreview(PREVIEW_1, HASH_1, "9007199254741865.15");
        const refreshed = settlementPreview(PREVIEW_2, HASH_2, "9007199254741870.15");
        vi.mocked(api.post).mockImplementation(async (url, body) => {
            if (url === "/loan-settlements/preview") {
                previewCount += 1;
                expect(body).toEqual({ loanPublicId: LOAN_ID, asOfDate: "2026-08-17" });
                return { data: previewCount === 1 ? first : refreshed };
            }
            if (url.endsWith("/execute")) {
                executeCount += 1;
                if (executeCount === 1) {
                    throw { response: { status: 409, data: { code: "STALE_SETTLEMENT_PREVIEW" } } };
                }
                return { data: { ...refreshed, status: "executed", auditPublicId: BORROWER_ID, correlationId: "settlement-correlation" } };
            }
            throw new Error(`Unexpected POST ${url}`);
        });

        const user = userEvent.setup();
        renderLoanDetail();

        expect((await screen.findByText("Principal")).parentElement).toHaveTextContent(/9,007,199,254,740,993\.01/);
        const summary = await screen.findByRole("region", { name: "Floating interest summary" });
        expect(within(summary).getByText("Weekly")).toBeInTheDocument();
        expect(within(summary).getByText("12.0000% per week")).toBeInTheDocument();
        expect(within(summary).getByText("Accruing interest")).toBeInTheDocument();
        expect(within(summary).getByText("Due interest")).toBeInTheDocument();
        expect(within(summary).getByText(/advance interest is non-refundable/i)).toBeInTheDocument();

        await user.clear(within(summary).getByLabelText("Settlement date"));
        await user.type(within(summary).getByLabelText("Settlement date"), "2026-08-17");
        await user.click(within(summary).getByRole("button", { name: "Preview settlement" }));

        const dialog = await screen.findByRole("dialog", { name: "Confirm exact settlement" });
        expect(within(dialog).getByText("Outstanding principal").parentElement).toHaveTextContent(/9,007,199,254,740,993\.01/);
        expect(within(dialog).getByText("Due interest").parentElement).toHaveTextContent(/600\.00/);
        expect(within(dialog).getByText("Accruing interest (not yet due)").parentElement).toHaveTextContent(/257\.14/);
        expect(within(dialog).getByText("Outstanding fees").parentElement).toHaveTextContent(/10\.00/);
        expect(within(dialog).getByText("Outstanding penalties").parentElement).toHaveTextContent(/5\.00/);
        expect(within(dialog).getByText("Non-refundable advance-interest history").parentElement).toHaveTextContent(/600\.00/);
        expect(within(dialog).getByText("Settlement total").parentElement).toHaveTextContent(/9,007,199,254,741,865\.15/);

        const execute = within(dialog).getByRole("button", { name: "Execute settlement" });
        await user.type(within(dialog).getByLabelText("Settlement reason"), "Borrower approved exact close-out");
        expect(execute).toBeDisabled();
        await user.click(within(dialog).getByRole("checkbox", { name: "I confirm this exact settlement preview" }));
        expect(execute).toBeEnabled();
        await user.click(execute);

        expect(await within(dialog).findByRole("alert")).toHaveTextContent(/review the refreshed settlement preview and confirm it again/i);
        await waitFor(() => expect(previewCount).toBe(2));
        expect(within(dialog).getByText("Settlement total").parentElement).toHaveTextContent(/9,007,199,254,741,870\.15/);
        expect(within(dialog).getByRole("checkbox", { name: "I confirm this exact settlement preview" })).not.toBeChecked();
        expect(within(dialog).getByRole("button", { name: "Execute settlement" })).toBeDisabled();

        await user.click(within(dialog).getByRole("checkbox", { name: "I confirm this exact settlement preview" }));
        await user.click(within(dialog).getByRole("button", { name: "Execute settlement" }));
        await waitFor(() => expect(executeCount).toBe(2));

        const executeCalls = vi.mocked(api.post).mock.calls.filter(([url]) => String(url).endsWith("/execute"));
        expect(executeCalls[0]?.[1]).toEqual({ previewHash: HASH_1, confirmed: true, reason: "Borrower approved exact close-out" });
        expect(executeCalls[1]?.[0]).toBe(`/loan-settlements/${PREVIEW_2}/execute`);
        expect(executeCalls[1]?.[1]).toEqual({ previewHash: HASH_2, confirmed: true, reason: "Borrower approved exact close-out" });
        expect(executeCalls[1]?.[2]).toEqual({ headers: { "Idempotency-Key": expect.any(String) } });
        expect(await screen.findByText("Settlement executed")).toBeInTheDocument();
        expect(screen.getByText(/^paid$/i)).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Preview settlement" })).not.toBeInTheDocument();
    });

    // Break caught: the destructive settlement action or its due/accruing labels fall back to English in the Thai application flow.
    it("localizes due, accruing, and settlement actions in Thai", async () => {
        await appI18n.changeLanguage("th");
        vi.mocked(api.post).mockResolvedValue({ data: settlementPreview(PREVIEW_1, HASH_1, "9007199254741865.15") });
        const user = userEvent.setup();
        renderLoanDetail();

        const summary = await screen.findByRole("region", { name: "สรุปดอกเบี้ยลอยตัว" });
        expect(within(summary).getByText("ดอกเบี้ยถึงกำหนด")).toBeInTheDocument();
        expect(within(summary).getByText("ดอกเบี้ยกำลังสะสม")).toBeInTheDocument();
        await user.click(within(summary).getByRole("button", { name: "พรีวิวยอดปิดบัญชี" }));

        const dialog = await screen.findByRole("dialog", { name: "ยืนยันยอดปิดบัญชีที่แน่นอน" });
        expect(within(dialog).getByLabelText("เหตุผลการปิดบัญชี")).toBeInTheDocument();
        expect(within(dialog).getByRole("button", { name: "ดำเนินการปิดบัญชี" })).toBeDisabled();
    });
});
