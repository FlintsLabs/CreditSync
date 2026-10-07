import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { LoanAccrualsTab, type LoanAccrualRow } from "./LoanAccrualsTab";

vi.mock("../../../lib/api", () => ({ api: { post: vi.fn() } }));
import { api } from "../../../lib/api";

vi.mock("react-i18next", () => ({
    useTranslation: () => ({
        t: (_key: string, fallback?: string) => typeof fallback === "string" ? fallback : _key,
        i18n: { language: "th-TH" },
    }),
}));

describe("LoanAccrualsTab", () => {
    // Break caught: missing projected rows, double-counted reversals, or incorrect current totals.
    test("renders every daily row and exact totals while preserving reversal history", () => {
        const dates = ["2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30",
            "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07"];
        const rows: LoanAccrualRow[] = dates.map((date, index) => ({
            publicId: index === 0 ? "first-paid-row" : `projected:loan:${date}`,
            accrualDate: date, periodStartDate: date, periodEndDate: null, periodUnit: "day", periodDayIndex: 1,
            interestAmount: "80.00", paidAmount: index === 0 ? "80.00" : "0.00",
            remainingAmount: index === 0 ? "0.00" : "80.00", status: index === 0 ? "paid" : "accrued",
        }));
        rows.push({ ...rows[0], publicId: "reversed-row", interestAmount: "100.00", paidAmount: "0.00", remainingAmount: "100.00", status: "reversed" });
        render(<MemoryRouter><LoanAccrualsTab rows={rows} /></MemoryRouter>);
        expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(16);
        expect(screen.getByRole("cell", { name: "7 ต.ค. 2569" })).toBeTruthy();
        expect(screen.getByText("total").parentElement?.textContent).toContain("1,120.00");
        const summary = screen.getByText("total").parentElement!.parentElement!;
        expect(within(summary).getByText("paid").parentElement?.textContent).toContain("80.00");
        expect(screen.getByText("remaining").parentElement?.textContent).toContain("1,040.00");
        expect(screen.getByText("reversed")).toBeTruthy();
    });

    test("shows actual receipt provenance and opens selected-date preview before confirmation", async () => {
        const rows: LoanAccrualRow[] = [{ publicId: "day-2", accrualDate: "2026-10-02", periodStartDate: "2026-10-02", periodEndDate: null, periodUnit: "day", periodDayIndex: 1, interestAmount: "80.00", paidAmount: "30.00", remainingAmount: "50.00", status: "partially_paid", receiptHistory: [{ amount: "30.00", receivedAt: "2026-10-02T02:00:00.000Z", recordedAt: "2026-10-02T02:01:00.000Z", paymentIntakePublicId: "00000000-0000-4000-8000-000000000001", transactionPublicId: "transaction-1", status: "posted", sourceKind: "receipt", href: "/payments?intake=00000000-0000-4000-8000-000000000001&loanId=00000000-0000-4000-8000-000000000002" }] }];
        vi.mocked(api.post).mockResolvedValueOnce({ data: { publicId: "proposal-1", paymentIntakePublicId: "intake-1", status: "ready", warnings: [], totalAllocated: "50.00", remainingDebt: { principal: "4000.00", fees: "0.00", interest: "80.00", penalty: "0.00" } } } as never);
        render(<MemoryRouter><LoanAccrualsTab rows={rows} loanPublicId="00000000-0000-4000-8000-000000000002" /></MemoryRouter>);
        expect(screen.getByRole("link", { name: "Open payment review" }).getAttribute("href")).toContain("/payments?intake=");
        fireEvent.click(screen.getByRole("button", { name: "Pay" }));
        expect(screen.getByLabelText("Actual received time (Bangkok)")).toBeTruthy();
        fireEvent.click(screen.getByRole("button", { name: "Preview" }));
        await waitFor(() => expect(api.post).toHaveBeenCalled());
        expect((api.post as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toContain("/accrual-payments/preview");
        expect(screen.getByRole("button", { name: "Confirm payment" })).toBeTruthy();
    });

    test("sums full public precision without dropping integer digits or cents", () => {
        const amount = "246913578024691357802469135.79";
        const rows: LoanAccrualRow[] = ["2026-10-02", "2026-10-03"].map((date, index) => ({ publicId: `large-${index}`, accrualDate: date, periodStartDate: date, periodEndDate: null, periodUnit: "day", periodDayIndex: 1, interestAmount: amount, paidAmount: "0.00", remainingAmount: amount, status: "accrued" }));
        render(<MemoryRouter><LoanAccrualsTab rows={rows} /></MemoryRouter>);
        expect(screen.getByText("total").parentElement?.textContent).toContain("493,827,156,049,382,715,604,938,271.58");
    });

    test("disables draft editors during preview and canonicalizes strict target money before request", async () => {
        let resolvePreview!: (value: unknown) => void;
        vi.mocked(api.post).mockImplementationOnce(() => new Promise((resolve) => { resolvePreview = resolve; }) as never);
        const rows: LoanAccrualRow[] = [{ publicId: "day-2", accrualDate: "2026-10-02", periodStartDate: "2026-10-02", periodEndDate: null, periodUnit: "day", periodDayIndex: 1, interestAmount: "80.00", paidAmount: "0.00", remainingAmount: "80.00", status: "accrued" }];
        localStorage.removeItem("creditsync:selected-accrual:loan-precision-test");
        render(<MemoryRouter><LoanAccrualsTab rows={rows} loanPublicId="loan-precision-test" /></MemoryRouter>);
        fireEvent.click(screen.getByRole("button", { name: "Pay" }));
        const amount = screen.getAllByRole("textbox")[0]!;
        fireEvent.change(amount, { target: { value: "80" } });
        fireEvent.click(screen.getByRole("button", { name: "Preview" }));
        await waitFor(() => expect(api.post).toHaveBeenCalled());
        expect((api.post as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1]).toMatchObject({ amount: "80.00", targets: [{ accrualDate: "2026-10-02", amount: "80.00" }] });
        expect(screen.getAllByRole("textbox")[0]).toHaveProperty("disabled", true);
        resolvePreview({ data: { publicId: "proposal-1", paymentIntakePublicId: "intake-1", status: "ready", warnings: [], totalAllocated: "80.00", receivedAt: "2026-10-02T02:00:00.000Z", targets: [{ accrualDate: "2026-10-02", amount: "80.00" }], remainingDebt: { principal: "4000.00", fees: "0.00", interest: "80.00", penalty: "0.00" } } });
        await waitFor(() => expect(screen.getByRole("button", { name: "Confirm payment" })).toBeTruthy());
        expect(screen.getByText(/Variance/).textContent).toContain("0.00");
    });

    test("labels reversed receipts explicitly and hides payment actions without explicit daily capability", () => {
        const rows: LoanAccrualRow[] = [{ publicId: "day-1", accrualDate: "2026-10-01", periodStartDate: "2026-10-01", periodEndDate: null, periodUnit: "day", periodDayIndex: 1, interestAmount: "80.00", paidAmount: "0.00", remainingAmount: "80.00", status: "accrued", receiptHistory: [{ amount: "80.00", receivedAt: "2026-10-01T02:00:00.000Z", recordedAt: "2026-10-01T02:01:00.000Z", paymentIntakePublicId: "intake", transactionPublicId: "tx", status: "reversed", sourceKind: "receipt", href: null }] }];
        render(<MemoryRouter><LoanAccrualsTab rows={rows} loanPublicId="loan-1" canPaySelectedAccrual={false} /></MemoryRouter>);
        expect(screen.getByText("Reversed receipt")).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Pay" })).toBeNull();
    });

    test("rejects negative or over-precision targets without silently rounding or sending a preview", async () => {
        const rows: LoanAccrualRow[] = [{ publicId: "day-invalid", accrualDate: "2026-10-02", periodStartDate: "2026-10-02", periodEndDate: null, periodUnit: "day", periodDayIndex: 1, interestAmount: "80.00", paidAmount: "0.00", remainingAmount: "80.00", status: "accrued" }];
        localStorage.removeItem("creditsync:selected-accrual:loan-invalid-money");
        render(<MemoryRouter><LoanAccrualsTab rows={rows} loanPublicId="loan-invalid-money" /></MemoryRouter>);
        fireEvent.click(screen.getByRole("button", { name: "Pay" }));
        fireEvent.change(screen.getAllByRole("textbox")[0]!, { target: { value: "-1.239" } });
        const before = (api.post as ReturnType<typeof vi.fn>).mock.calls.length;
        fireEvent.click(screen.getByRole("button", { name: "Preview" }));
        expect(await screen.findByRole("alert")).toHaveTextContent("Enter a positive amount with at most two decimal places.");
        expect((api.post as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(before);
    });

    test("persists posted recovery before refresh and allows a later date after successful refresh", async () => {
        const loanPublicId = "00000000-0000-4000-8000-000000000099";
        localStorage.removeItem(`creditsync:selected-accrual:${loanPublicId}`);
        const rows: LoanAccrualRow[] = ["2026-10-02", "2026-10-03"].map((date) => ({ publicId: date, accrualDate: date, periodStartDate: date, periodEndDate: null, periodUnit: "day", periodDayIndex: 1, interestAmount: "80.00", paidAmount: "0.00", remainingAmount: "80.00", status: "accrued" }));
        vi.mocked(api.post).mockResolvedValueOnce({ data: { publicId: "proposal", paymentIntakePublicId: "intake", status: "ready", warnings: [], totalAllocated: "80.00", receivedAt: "2026-10-02T02:00:00.000Z", targets: [{ accrualDate: "2026-10-02", amount: "80.00" }] } } as never);
        vi.mocked(api.post).mockResolvedValueOnce({ data: { publicId: "intake", status: "posted", receiptPublicId: "receipt-tx", auditPublicId: "audit", correlationId: "corr", transactions: [] } } as never);
        const onRefresh = vi.fn().mockResolvedValue(undefined);
        render(<MemoryRouter><LoanAccrualsTab rows={rows} loanPublicId={loanPublicId} onRefresh={onRefresh} /></MemoryRouter>);
        fireEvent.click(screen.getAllByRole("button", { name: "Pay" })[0]!);
        fireEvent.click(screen.getByRole("button", { name: "Preview" }));
        await screen.findByRole("button", { name: "Confirm payment" });
        fireEvent.click(screen.getByRole("button", { name: "Confirm payment" }));
        await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
        expect(localStorage.getItem(`creditsync:selected-accrual:${loanPublicId}`)).toBeNull();
        expect(screen.getAllByRole("button", { name: "Pay" })).toHaveLength(2);
    });
});
