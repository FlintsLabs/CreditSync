import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/lib/api";
import appI18n from "../src/lib/i18n";
import { LoanRestructurePanel } from "../src/pages/dashboard/loans/LoanRestructurePanel";

vi.mock("../src/lib/api", () => ({ api: { post: vi.fn() } }));
const LOAN_ID = "019ff023-fd64-7d41-9aae-723d2a458a8a";
const preview = {
    publicId: "019ff023-fd64-7d41-9aae-723d2a458a8b", status: "preview", settlementDate: "2026-08-19",
    oldBalanceVersion: "v1:balance", previewHash: "v1:preview", expiresAt: "2099-08-19T12:00:00.000Z",
    balance: { grossPrincipal: "5000.00", grossInterest: "500.00", grossFees: "50.00", grossPenalty: "20.00", waivedInterest: "100.00", waivedFees: "0.00", waivedPenalty: "20.00", netPrincipal: "5000.00", netInterest: "400.00", netFees: "50.00", netPenalty: "0.00", fixedInterestCandidate: "500.00", retroactiveInterestCandidate: "450.00", selectedInterest: "500.00", selectedInterestBranch: "fixed", exposureTrace: [{ amount: "5000.00", fromDate: "2026-08-10", toDate: "2026-08-19", days: 9, rateType: "percent_per_day", rate: "1.0000", unroundedInterest: "450.000000", roundedInterest: "450.00" }] },
    replacementPrincipal: "6000.00", externalCreditAllocation: { principal: "100.00", interest: "75.00", fee: "25.00", penalty: "0.00", unallocated: "0.00" },
    replacementTerms: { repaymentType: "monthly", startDate: "2026-08-19", interestRate: "12.00", termMonths: 12 },
    schedule: [{ installmentNo: 1, dueDate: "2026-09-19", amount: "560.00", principalComponent: "500.00", interestComponent: "60.00" }],
    cash: { direction: "payout", amount: "1000.00" }, reason: "ช่วยปรับโครงสร้าง",
};

describe("LoanRestructurePanel", () => {
    beforeEach(async () => { vi.clearAllMocks(); await appI18n.changeLanguage("en"); });
    afterEach(() => vi.useRealTimers());

    it("collects distinct waivers, external payment, added principal, and all replacement types", async () => {
        vi.mocked(api.post).mockResolvedValue({ data: preview });
        const user = userEvent.setup();
        render(<LoanRestructurePanel loan={{ publicId: LOAN_ID, status: "active", repaymentType: "single_payment", principalAmount: "5000.00" }} />);
        expect(screen.getByRole("combobox", { name: /replacement type/i })).toHaveTextContent(/single payment.*daily.*weekly.*monthly.*floating/i);
        fireEvent.change(screen.getByLabelText(/interest waiver amount/i), { target: { value: "100" } });
        expect(screen.getByRole("button", { name: /preview restructure/i })).toBeDisabled();
        fireEvent.change(screen.getByLabelText(/interest waiver reason/i), { target: { value: "assistance" } });
        fireEvent.change(screen.getByLabelText(/external payment amount/i), { target: { value: "200" } });
        fireEvent.change(screen.getByLabelText(/payer/i), { target: { value: "Charity" } });
        fireEvent.change(screen.getByLabelText(/payment source/i), { target: { value: "support fund" } });
        fireEvent.change(screen.getByLabelText(/additional principal/i), { target: { value: "1000" } });
        fireEvent.change(screen.getByLabelText(/^reason$/i), { target: { value: "agreed restructure" } });
        await user.click(screen.getByRole("button", { name: /preview restructure/i }));
        expect(api.post).toHaveBeenCalledWith(`/loans/${LOAN_ID}/restructures/preview`, expect.objectContaining({
            waivers: { interest: { amount: "100.00", reason: "assistance" } },
            externalSettlementCredit: { amount: "200.00", payer: "Charity", source: "support fund" }, additionalPrincipal: "1000.00",
        }));
        expect((await screen.findAllByText(/5,000\.00/)).length).toBeGreaterThan(0);
        expect(screen.getByText(/additional cash is only an approved payout/i)).toBeInTheDocument();
        expect(screen.getByText(/Charity.*support fund/i)).toBeInTheDocument();
        expect(screen.getByText(/principal allocation/i).parentElement).toHaveTextContent(/100\.00/);
        expect(screen.getByText(/8\/10\/2026.*8\/19\/2026/i)).toBeInTheDocument();
        expect(screen.getByText(/1\.0000.*9 days.*450\.00/i)).toBeInTheDocument();
    });

    it("expires a displayed preview while the panel remains open and removes execution authority", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-08-19T12:00:00.000Z"));
        vi.mocked(api.post).mockResolvedValue({ data: { ...preview, expiresAt: "2026-08-19T12:00:01.000Z" } });
        render(<LoanRestructurePanel loan={{ publicId: LOAN_ID, status: "active", repaymentType: "single_payment", principalAmount: "5000.00" }} />);
        fireEvent.change(screen.getByLabelText(/^reason$/i), { target: { value: "agreed restructure" } });
        await act(async () => { fireEvent.click(screen.getByRole("button", { name: /preview restructure/i })); await Promise.resolve(); });
        expect(screen.getByRole("button", { name: /execute restructure/i })).toBeInTheDocument();
        await act(async () => { await vi.advanceTimersByTimeAsync(1001); });
        const alert = screen.getByRole("alert");
        expect(alert).toHaveTextContent(/expired/i);
        expect(alert).toHaveFocus();
        expect(screen.queryByRole("button", { name: /execute restructure/i })).not.toBeInTheDocument();
        vi.useRealTimers();
    });

    it.each([
        ["single_payment", { singlePayment: { dueDate: "2026-09-19", fixedAgreedInterest: "250.00", interestPolicy: "fixed_only", latePenalty: { mode: "none" } } }],
        ["daily", { dailyEntry: { durationUnit: "months", durationValue: 2, entryMode: "daily_payment", dailyPayment: "125.00" } }],
        ["weekly", { totalInstallments: 8, installmentAmount: "800.00" }],
        ["monthly", { totalInstallments: 6, installmentAmount: "1100.00" }],
        ["floating", { floatingDailyInterest: { mode: "per_thousand", rate: "15", firstDayTreatment: "deduct", accrualCycle: "weekly" } }],
    ])("submits complete %s replacement terms", async (type, expected) => {
        vi.mocked(api.post).mockResolvedValue({ data: preview });
        render(<LoanRestructurePanel loan={{ publicId: LOAN_ID, status: "active", repaymentType: "single_payment", principalAmount: "5000.00" }} />);
        fireEvent.change(screen.getByLabelText(/replacement type/i), { target: { value: type } });
        fireEvent.change(screen.getByLabelText(/^reason$/i), { target: { value: "complete terms" } });
        if (type === "single_payment") {
            fireEvent.change(screen.getByLabelText(/due date/i), { target: { value: "2026-09-19" } });
            fireEvent.change(screen.getByLabelText(/fixed agreed interest/i), { target: { value: "250" } });
        } else if (type === "daily") {
            fireEvent.change(screen.getByLabelText(/duration unit/i), { target: { value: "months" } });
            fireEvent.change(screen.getByLabelText(/^duration$/i), { target: { value: "2" } });
            fireEvent.change(screen.getByLabelText(/daily payment/i), { target: { value: "125" } });
        } else if (type === "weekly" || type === "monthly") {
            fireEvent.change(screen.getByLabelText(/number of installments/i), { target: { value: type === "weekly" ? "8" : "6" } });
            fireEvent.change(screen.getByLabelText(/amount per installment/i), { target: { value: type === "weekly" ? "800" : "1100" } });
        } else {
            fireEvent.change(screen.getByLabelText(/daily interest method/i), { target: { value: "per_thousand" } });
            fireEvent.change(screen.getByLabelText(/^interest value$/i), { target: { value: "15" } });
            fireEvent.change(screen.getByLabelText(/accrual cycle/i), { target: { value: "weekly" } });
            fireEvent.change(screen.getByLabelText(/first-day interest/i), { target: { value: "deduct" } });
        }
        fireEvent.click(screen.getByRole("button", { name: /preview restructure/i }));
        await waitFor(() => expect(api.post).toHaveBeenCalled());
        const body = vi.mocked(api.post).mock.calls[0]![1] as { replacementTerms: Record<string, unknown> };
        expect(body.replacementTerms).toMatchObject({ repaymentType: type, ...expected });
    });

    it("executes only the exact displayed unexpired preview after explicit confirmation", async () => {
        vi.mocked(api.post).mockImplementation(async url => url.endsWith("/preview") ? { data: preview } : { data: { status: "executed", newLoanPublicId: "019ff023-fd64-7d41-9aae-723d2a458a8c", disbursementDraftPublicId: "019ff023-fd64-7d41-9aae-723d2a458a8d" } });
        const user = userEvent.setup();
        render(<LoanRestructurePanel loan={{ publicId: LOAN_ID, status: "active", repaymentType: "single_payment", principalAmount: "5000.00" }} />);
        await user.type(screen.getByLabelText(/^reason$/i), "agreed restructure");
        await user.click(screen.getByRole("button", { name: /preview restructure/i }));
        const execute = await screen.findByRole("button", { name: /execute restructure/i });
        expect(execute).toBeDisabled();
        await user.click(screen.getByLabelText(/confirm this exact preview/i));
        await user.click(execute);
        await waitFor(() => expect(api.post).toHaveBeenLastCalledWith(`/loans/restructures/${preview.publicId}/execute`, { confirmed: true, previewHash: preview.previewHash, expectedBalanceVersion: preview.oldBalanceVersion, reason: "agreed restructure" }, expect.objectContaining({ headers: expect.objectContaining({ "Idempotency-Key": expect.any(String) }) })));
        expect(await screen.findByRole("status")).toHaveTextContent(/disbursement draft/i);
    });

    it("blocks an expired preview and surfaces stale backend conflicts as an alert", async () => {
        vi.mocked(api.post).mockResolvedValue({ data: { ...preview, expiresAt: "2020-01-01T00:00:00.000Z" } });
        const user = userEvent.setup();
        render(<LoanRestructurePanel loan={{ publicId: LOAN_ID, status: "active", repaymentType: "single_payment", principalAmount: "5000.00" }} />);
        await user.type(screen.getByLabelText(/^reason$/i), "agreed restructure");
        await user.click(screen.getByRole("button", { name: /preview restructure/i }));
        expect(await screen.findByRole("alert")).toHaveTextContent(/expired/i);
        expect(screen.queryByRole("button", { name: /execute restructure/i })).not.toBeInTheDocument();
    });
});
