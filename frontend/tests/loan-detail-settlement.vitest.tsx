import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import LoanDetail from "../src/pages/dashboard/loans/LoanDetail";
import { api } from "../src/lib/api";
import appI18n from "../src/lib/i18n";

vi.mock("../src/lib/api", () => ({ api: { get: vi.fn(), post: vi.fn() } }));
const sessionMocks = vi.hoisted(() => ({ isTenantAdminUser: vi.fn(() => false) }));

vi.mock("../src/lib/session", () => ({ getStoredUser: () => null, isTenantAdminUser: sessionMocks.isTenantAdminUser }));
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

const paidLoan = {
    ...loan,
    status: "paid",
    outstandingPrincipal: "0.00",
    outstandingInterest: "0.00",
    outstandingFees: "0.00",
};

const initialProfitability = {
    borrowerRevenueCollected: "600.00",
    fundCostPaid: "0.00",
    realizedSpread: "600.00",
    unrealizedSpread: "857.14",
    fundedPrincipal: "0.00",
    unallocatedPrincipalGap: loan.principalAmount,
    estimatedOutstandingFundingCost: "0.00",
    fundingShare: 0,
    fundingComposition: [],
};

const paidProfitability = {
    ...initialProfitability,
    borrowerRevenueCollected: "857.14",
    realizedSpread: "857.14",
    unrealizedSpread: "0.00",
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
        sessionMocks.isTenantAdminUser.mockReturnValue(false);
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
        sessionMocks.isTenantAdminUser.mockReturnValue(true);
        let previewCount = 0;
        let executeCount = 0;
        let loanReadCount = 0;
        let profitabilityReadCount = 0;
        const first = settlementPreview(PREVIEW_1, HASH_1, "9007199254741865.15");
        const refreshed = settlementPreview(PREVIEW_2, HASH_2, "9007199254741870.15");
        vi.mocked(api.get).mockImplementation(async (url) => {
            if (url === `/loans/${LOAN_ID}`) {
                loanReadCount += 1;
                return { data: loanReadCount === 2 ? paidLoan : loan };
            }
            if (url === `/loans/${LOAN_ID}/profitability`) {
                profitabilityReadCount += 1;
                return { data: profitabilityReadCount === 2 ? paidProfitability : initialProfitability };
            }
            if (url === `/borrowers/${BORROWER_ID}`) return { data: { id: BORROWER_ID, publicId: BORROWER_ID, name: "Exact Borrower" } };
            if (url.endsWith("/schedule") || url.endsWith("/funding-allocations")) return { data: [] };
            if (url.endsWith("/allocation-state")) return { data: { principalAmount: loan.principalAmount, netAllocatedPrincipal: "0.00", remainingGap: loan.principalAmount, overfundedAmount: "0.00", state: "unfunded" } };
            throw new Error(`Unexpected GET ${url}`);
        });
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
            if (url === `/loan-settlements/${PREVIEW_2}/reverse`) {
                expect(body).toEqual({ reason: "Correct duplicate close-out" });
                return { data: { publicId: PREVIEW_2, status: "reversed", auditPublicId: BORROWER_ID, correlationId: "settlement-reversal-correlation" } };
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
        const firstKey = (executeCalls[0]?.[2] as { headers?: { "Idempotency-Key"?: string } })?.headers?.["Idempotency-Key"];
        const refreshedKey = (executeCalls[1]?.[2] as { headers?: { "Idempotency-Key"?: string } })?.headers?.["Idempotency-Key"];
        expect(refreshedKey).not.toBe(firstKey);
        expect(await screen.findByRole("status")).toHaveTextContent("Settlement executed");
        expect(screen.getByText(/^paid$/i)).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Preview settlement" })).not.toBeInTheDocument();
        await waitFor(() => expect(loanReadCount).toBe(2));
        expect(profitabilityReadCount).toBe(2);
        expect(screen.getByText("Borrower Revenue Collected").parentElement).toHaveTextContent(/857\.14/);
        expect(within(summary).queryByText("Due interest")).not.toBeInTheDocument();
        expect(within(summary).queryByText("Accruing interest")).not.toBeInTheDocument();

        await user.type(within(dialog).getByLabelText("Settlement reversal reason"), "Correct duplicate close-out");
        const reverse = within(dialog).getByRole("button", { name: "Reverse settlement" });
        expect(reverse).toBeDisabled();
        await user.click(within(dialog).getByRole("checkbox", { name: "I confirm this compensating settlement reversal" }));
        await user.click(reverse);
        await waitFor(() => expect(screen.queryByRole("dialog", { name: "Confirm exact settlement" })).not.toBeInTheDocument());
        const reverseCall = vi.mocked(api.post).mock.calls.find(([url]) => String(url).endsWith("/reverse"));
        expect(reverseCall?.[2]).toEqual({ headers: { "Idempotency-Key": expect.any(String) } });
        expect(await screen.findByText(/^active$/i)).toBeInTheDocument();
        expect(loanReadCount).toBe(3);
    }, 10_000);

    // Break caught: an initial preview failure is invisible because its message exists only in a dialog that never opened.
    it("shows a localized preview failure beside the settlement trigger", async () => {
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
        vi.mocked(api.post).mockRejectedValueOnce(new Error("preview unavailable"));
        const user = userEvent.setup();
        renderLoanDetail();

        const summary = await screen.findByRole("region", { name: "Floating interest summary" });
        await user.click(within(summary).getByRole("button", { name: "Preview settlement" }));

        expect(await within(summary).findByRole("alert")).toHaveTextContent("Unable to preview settlement.");
        expect(within(summary).getByRole("button", { name: "Preview settlement" })).toBeEnabled();
        expect(screen.queryByRole("dialog", { name: "Confirm exact settlement" })).not.toBeInTheDocument();
        consoleError.mockRestore();
    });

    // Break caught: a successful write followed by a failed authoritative refresh must not leave pre-settlement accounting visible.
    it("hides stale loan accounting if the post-settlement refetch fails", async () => {
        let loanReadCount = 0;
        vi.mocked(api.get).mockImplementation(async (url) => {
            if (url === `/loans/${LOAN_ID}`) {
                loanReadCount += 1;
                if (loanReadCount === 1) return { data: loan };
                throw new Error("authoritative refetch unavailable");
            }
            if (url === `/borrowers/${BORROWER_ID}`) return { data: { id: BORROWER_ID, publicId: BORROWER_ID, name: "Exact Borrower" } };
            if (url.endsWith("/schedule") || url.endsWith("/funding-allocations")) return { data: [] };
            if (url.endsWith("/allocation-state")) return { data: { principalAmount: loan.principalAmount, netAllocatedPrincipal: "0.00", remainingGap: loan.principalAmount, overfundedAmount: "0.00", state: "unfunded" } };
            throw new Error(`Unexpected GET ${url}`);
        });
        vi.mocked(api.post).mockImplementation(async (url) => {
            if (url === "/loan-settlements/preview") return { data: settlementPreview(PREVIEW_1, HASH_1, "9007199254741865.15") };
            if (url.endsWith("/execute")) return { data: { ...settlementPreview(PREVIEW_1, HASH_1, "9007199254741865.15"), status: "executed" } };
            throw new Error(`Unexpected POST ${url}`);
        });
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const user = userEvent.setup();
        renderLoanDetail();

        const summary = await screen.findByRole("region", { name: "Floating interest summary" });
        await user.click(within(summary).getByRole("button", { name: "Preview settlement" }));
        const dialog = await screen.findByRole("dialog", { name: "Confirm exact settlement" });
        await user.type(within(dialog).getByLabelText("Settlement reason"), "Close with refresh guard");
        await user.click(within(dialog).getByRole("checkbox", { name: "I confirm this exact settlement preview" }));
        await user.click(within(dialog).getByRole("button", { name: "Execute settlement" }));

        expect(await within(dialog).findByRole("alert")).toHaveTextContent(/settlement was executed, but the latest loan detail could not be loaded/i);
        expect(summary).not.toBeInTheDocument();
        expect(await screen.findByRole("status")).toHaveTextContent("Settlement executed");
        consoleError.mockRestore();
    });

    // Break caught: a transient execute failure must reuse the same command key, while only a stale preview creates a new intent.
    it("reuses the settlement idempotency key for a generic retry", async () => {
        let executeCount = 0;
        vi.mocked(api.post).mockImplementation(async (url) => {
            if (url === "/loan-settlements/preview") return { data: settlementPreview(PREVIEW_1, HASH_1, "9007199254741865.15") };
            if (url.endsWith("/execute")) {
                executeCount += 1;
                if (executeCount === 1) throw new Error("temporary execute failure");
                return { data: { ...settlementPreview(PREVIEW_1, HASH_1, "9007199254741865.15"), status: "executed" } };
            }
            throw new Error(`Unexpected POST ${url}`);
        });
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const user = userEvent.setup();
        renderLoanDetail();

        const summary = await screen.findByRole("region", { name: "Floating interest summary" });
        await user.click(within(summary).getByRole("button", { name: "Preview settlement" }));
        const dialog = await screen.findByRole("dialog", { name: "Confirm exact settlement" });
        await user.type(within(dialog).getByLabelText("Settlement reason"), "Retry exact close-out");
        await user.click(within(dialog).getByRole("checkbox", { name: "I confirm this exact settlement preview" }));
        await user.click(within(dialog).getByRole("button", { name: "Execute settlement" }));
        expect(await within(dialog).findByRole("alert")).toHaveTextContent(/unable to execute settlement/i);
        await user.click(within(dialog).getByRole("button", { name: "Execute settlement" }));
        await waitFor(() => expect(executeCount).toBe(2));

        const executeCalls = vi.mocked(api.post).mock.calls.filter(([url]) => String(url).endsWith("/execute"));
        const firstKey = (executeCalls[0]?.[2] as { headers?: { "Idempotency-Key"?: string } })?.headers?.["Idempotency-Key"];
        const retryKey = (executeCalls[1]?.[2] as { headers?: { "Idempotency-Key"?: string } })?.headers?.["Idempotency-Key"];
        expect(firstKey).toEqual(expect.any(String));
        expect(retryKey).toBe(firstKey);
        consoleError.mockRestore();
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
        expect(screen.getByText("ใช้งานอยู่")).toBeInTheDocument();
        await user.click(within(summary).getByRole("button", { name: "พรีวิวยอดปิดบัญชี" }));

        const dialog = await screen.findByRole("dialog", { name: "ยืนยันยอดปิดบัญชีที่แน่นอน" });
        expect(within(dialog).getByLabelText("เหตุผลการปิดบัญชี")).toBeInTheDocument();
        expect(within(dialog).getByRole("button", { name: "ดำเนินการปิดบัญชี" })).toBeDisabled();
    });
});
