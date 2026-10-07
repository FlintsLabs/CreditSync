import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { LoanAccrualsTab, type LoanAccrualRow } from "./LoanAccrualsTab";

let testLanguage: "en" | "th" = "en";
const testTranslations: Record<"en" | "th", Record<string, string>> = {
    en: {
        "loanDetail.accrualPayment.pay": "Pay",
        "payments.preview": "Preview",
        "loanDetail.accrualPayment.continueRecovery": "Continue receipt recovery",
        "loanDetail.accrualPayment.retry": "Retry payment",
        "loanDetail.accrualPayment.recoveryAvailable": "A posted receipt is saved and needs loan history recovery.",
        "loanDetail.accrualPayment.errors.historicalConflict": "This historical receipt conflicts with a later live payment.",
        "loanDetail.accrualPayment.errors.futureReceipt": "The actual receipt time cannot be in the future.",
        "loanDetail.accrualPayment.errors.accrualAfterReceipt": "This interest date is later than the actual receipt date.",
        "loanDetail.accrualPayment.errors.retryAccessRecovery": "Access could not be verified. This saved payment may already be posted; restore access and retry this same payment.",
        "loanDetail.accrualPayment.errors.previewStale": "This preview is stale. Review the dates and create a fresh preview.",
        "loanDetail.accrualPayment.blockers.duplicateReview": "A matching payment needs review before this receipt can proceed.",
        "loanDetail.accrualPayment.blockers.allocationWarning": "The proposed amount does not match an eligible obligation.",
    },
    th: {
        "loanDetail.accrualPayment.pay": "รับชำระ",
        "payments.preview": "ตรวจสอบ",
        "loanDetail.accrualPayment.continueRecovery": "ดำเนินการกู้คืนรายการรับชำระ",
        "loanDetail.accrualPayment.retry": "ลองตรวจสอบรายการเดิมอีกครั้ง",
        "loanDetail.accrualPayment.recoveryAvailable": "บันทึกรายการรับชำระแล้วและต้องกู้คืนประวัติสินเชื่อ",
        "loanDetail.accrualPayment.errors.historicalConflict": "วันรับชำระย้อนหลังขัดกับรายการภายหลังที่ยังมีผล โปรดกระทบยอดก่อน",
        "loanDetail.accrualPayment.errors.futureReceipt": "เวลารับเงินจริงต้องไม่อยู่ในอนาคต",
        "loanDetail.accrualPayment.errors.accrualAfterReceipt": "วันที่เกิดดอกเบี้ยต้องไม่อยู่หลังวันที่รับเงินจริง",
        "loanDetail.accrualPayment.errors.retryAccessRecovery": "ตรวจสอบสิทธิ์ไม่ได้ รายการที่บันทึกไว้อาจลงบัญชีแล้ว โปรดคืนสิทธิ์และลองรายการเดิมอีกครั้ง",
        "loanDetail.accrualPayment.errors.previewStale": "ผลตรวจสอบหมดอายุ โปรดตรวจวันที่และสร้างผลตรวจใหม่",
        "loanDetail.accrualPayment.blockers.duplicateReview": "พบรายการรับชำระที่อาจซ้ำ ต้องตรวจสอบก่อนทำต่อ",
        "loanDetail.accrualPayment.blockers.allocationWarning": "ยอดที่เสนอไม่ตรงกับภาระที่รับชำระได้",
    },
};

vi.mock("../../../lib/api", () => ({ api: { post: vi.fn() } }));
import { api } from "../../../lib/api";

vi.mock("react-i18next", () => ({
    useTranslation: () => ({
        t: (key: string, fallback?: string) => testTranslations[testLanguage][key] ?? (typeof fallback === "string" ? fallback : key),
        i18n: { get language() { return testLanguage; } },
    }),
}));

describe("LoanAccrualsTab", () => {
    beforeEach(() => { testLanguage = "en"; });
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
        expect(screen.getByRole("cell", { name: "Oct 7, 2026" })).toBeTruthy();
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

    test("recovers an expired 900-second preview by re-previewing the same intake", async () => {
        vi.mocked(api.post).mockClear();
        const loanPublicId = "loan-expired-preview";
        const storageKey = `creditsync:selected-accrual:${loanPublicId}`;
        localStorage.removeItem(storageKey);
        const rows: LoanAccrualRow[] = [{ publicId: "expired-day", accrualDate: "2026-10-02", periodStartDate: "2026-10-02", periodEndDate: null, periodUnit: "day", periodDayIndex: 1, interestAmount: "80.00", paidAmount: "0.00", remainingAmount: "80.00", status: "accrued" }];
        vi.mocked(api.post).mockImplementation(async (url) => {
            if (String(url).endsWith("/preview")) return { data: { publicId: "fresh-proposal", paymentIntakePublicId: "same-intake", status: "ready", warnings: [], totalAllocated: "80.00", targets: [{ accrualDate: "2026-10-02", amount: "80.00" }] } } as never;
            return { data: { publicId: "same-intake", receiptPublicId: "ttl-receipt", auditPublicId: "ttl-audit", correlationId: "ttl-corr", status: "posted" } } as never;
        });
        const view = render(<MemoryRouter><LoanAccrualsTab rows={rows} loanPublicId={loanPublicId} /></MemoryRouter>);
        fireEvent.click(screen.getByRole("button", { name: "Pay" }));
        fireEvent.click(screen.getByRole("button", { name: "Preview" }));
        await screen.findByRole("button", { name: "Confirm payment" });
        vi.mocked(api.post).mockRejectedValueOnce({ response: { status: 409, data: { code: "STALE_PAYMENT_PROPOSAL", error: "expired" } } });
        fireEvent.click(screen.getByRole("button", { name: "Confirm payment" }));
        await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("This preview is stale. Review the dates and create a fresh preview."));
        expect(screen.queryByRole("button", { name: "Retry payment" })).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "Preview" }));
        await screen.findByRole("button", { name: "Confirm payment" });
        const previewCalls = vi.mocked(api.post).mock.calls.filter(([url]) => String(url).endsWith("/preview"));
        expect(previewCalls).toHaveLength(2);
        expect(previewCalls[1]?.[1]).toMatchObject({ paymentIntakePublicId: "same-intake", targets: [{ accrualDate: "2026-10-02", amount: "80.00" }] });
        fireEvent.click(screen.getByRole("button", { name: "Confirm payment" }));
        await waitFor(() => expect(localStorage.getItem(storageKey)).toBeNull());
        expect(vi.mocked(api.post).mock.calls.filter(([url]) => String(url).endsWith("/post"))).toHaveLength(2);
        view.unmount();
    });

    test("recovers a committed post after a lost response without rotating identity across reload or edits", async () => {
        vi.mocked(api.post).mockClear();
        const loanPublicId = "00000000-0000-4000-8000-000000000101";
        const storageKey = `creditsync:selected-accrual:${loanPublicId}`;
        localStorage.removeItem(storageKey);
        const rows: LoanAccrualRow[] = [{ publicId: "lost-response-day", accrualDate: "2026-10-02", periodStartDate: "2026-10-02", periodEndDate: null, periodUnit: "day", periodDayIndex: 1, interestAmount: "80.00", paidAmount: "0.00", remainingAmount: "80.00", status: "accrued" }];
        const paidRows = [{ ...rows[0]!, paidAmount: "80.00", remainingAmount: "0.00", status: "paid" }];
        let postedReceipt: string | undefined;
        let deniedAttempts = 0;
        let accessRestored = false;
        let postCount = 0;
        const postKeys: string[] = [];
        const postBodies: unknown[] = [];
        vi.mocked(api.post).mockImplementation(async (url, body, config) => {
            if (String(url).endsWith("/preview")) return { data: { publicId: "proposal-lost", paymentIntakePublicId: "intake-lost", status: "ready", warnings: [], totalAllocated: "80.00", targets: [{ accrualDate: "2026-10-02", amount: "80.00" }] } } as never;
            postCount += 1;
            postKeys.push(String(config?.headers?.["Idempotency-Key"]));
            postBodies.push(body);
            if (!postedReceipt) {
                const pending = JSON.parse(localStorage.getItem(storageKey) ?? "null") as { postStatus?: string; postKey?: string; preview?: { publicId?: string } } | null;
                expect(pending).toMatchObject({ postStatus: "pending", preview: { publicId: "proposal-lost" } });
                postedReceipt = "receipt-once";
                throw new Error("connection reset after server commit");
            }
            if (!accessRestored && deniedAttempts === 0) { deniedAttempts += 1; throw { response: { status: 401, data: { code: "UNAUTHORIZED", error: "raw auth detail" } } }; }
            if (!accessRestored && deniedAttempts === 1) { deniedAttempts += 1; throw { response: { status: 404, data: { code: "PAYMENT_INTAKE_NOT_FOUND", error: "raw access detail" } } }; }
            return { data: { publicId: "intake-lost", receiptPublicId: postedReceipt, auditPublicId: "audit-lost", correlationId: "corr-lost", status: "posted" } } as never;
        });
        const onRefresh = vi.fn().mockResolvedValue(undefined);
        const firstView = render(<MemoryRouter><LoanAccrualsTab rows={rows} loanPublicId={loanPublicId} onRefresh={onRefresh} /></MemoryRouter>);
        fireEvent.click(screen.getByRole("button", { name: "Pay" }));
        fireEvent.click(screen.getByRole("button", { name: "Preview" }));
        await screen.findByRole("button", { name: "Confirm payment" });
        fireEvent.click(screen.getByRole("button", { name: "Confirm payment" }));
        await screen.findByRole("button", { name: "Retry payment" });
        expect(screen.getByText(/status is unknown/i)).toBeTruthy();
        const persisted = JSON.parse(localStorage.getItem(storageKey)!) as { postKey: string; postStatus: string; preview: { publicId: string } };
        expect(screen.queryByRole("textbox")).toBeNull();
        firstView.rerender(<MemoryRouter><LoanAccrualsTab rows={paidRows} loanPublicId={loanPublicId} onRefresh={onRefresh} /></MemoryRouter>);
        expect(screen.getByText(/status is unknown/i)).toBeTruthy();
        fireEvent.click(await screen.findByRole("button", { name: "Retry payment" }));
        await waitFor(() => expect(screen.getByText(/restore access and retry this same payment/i)).toBeTruthy());
        fireEvent.click(await screen.findByRole("button", { name: "Retry payment" }));
        await waitFor(() => expect(screen.getByText(/restore access and retry this same payment/i)).toBeTruthy());
        expect(JSON.parse(localStorage.getItem(storageKey)!).postKey).toBe(persisted.postKey);
        expect(postCount).toBe(3);
        fireEvent.click(screen.getAllByRole("button", { name: "Close" }).at(-1)!);
        expect(screen.getByRole("button", { name: "Continue receipt recovery" })).toBeTruthy();
        firstView.unmount();
        accessRestored = true;
        render(<MemoryRouter><LoanAccrualsTab rows={paidRows} loanPublicId={loanPublicId} onRefresh={onRefresh} /></MemoryRouter>);
        fireEvent.click(screen.getByRole("button", { name: "Continue receipt recovery" }));
        fireEvent.click(await screen.findByRole("button", { name: "Retry payment" }));
        await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
        expect(postCount).toBe(4);
        expect(postKeys).toEqual([persisted.postKey, persisted.postKey, persisted.postKey, persisted.postKey]);
        expect(postBodies[0]).toEqual(postBodies[1]);
        expect(postBodies[1]).toEqual(postBodies[2]);
        expect(postBodies[2]).toEqual(postBodies[3]);
        expect(postedReceipt).toBe("receipt-once");
        expect(localStorage.getItem(storageKey)).toBeNull();
    });

    test("translates safe date errors and warnings without rendering server detail", async () => {
        const rows: LoanAccrualRow[] = [{ publicId: "day-safe-errors", accrualDate: "2026-10-02", periodStartDate: "2026-10-02", periodEndDate: null, periodUnit: "day", periodDayIndex: 1, interestAmount: "80.00", paidAmount: "0.00", remainingAmount: "80.00", status: "accrued" }];
        for (const language of ["en", "th"] as const) {
            testLanguage = language;
            localStorage.removeItem(`creditsync:selected-accrual:loan-translations-${language}`);
            vi.mocked(api.post).mockRejectedValueOnce({ response: { status: 409, data: { code: "ACCRUAL_AFTER_RECEIPT", error: "SECRET SERVER DETAIL", details: { bankReference: "SECRET-REFERENCE" } } } });
            const view = render(<MemoryRouter><LoanAccrualsTab rows={rows} loanPublicId={`loan-translations-${language}`} /></MemoryRouter>);
            fireEvent.click(screen.getByRole("button", { name: language === "en" ? "Pay" : "รับชำระ" }));
            fireEvent.click(screen.getByRole("button", { name: language === "en" ? "Preview" : "ตรวจสอบ" }));
            await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(testTranslations[language]["loanDetail.accrualPayment.errors.accrualAfterReceipt"]));
            expect(screen.queryByText(/SECRET/)).toBeNull();
            view.unmount();
        }
        testLanguage = "en";
    });

    test("renders known warnings in the active language without server identifiers", async () => {
        const rows: LoanAccrualRow[] = [{ publicId: "day-warning", accrualDate: "2026-10-02", periodStartDate: "2026-10-02", periodEndDate: null, periodUnit: "day", periodDayIndex: 1, interestAmount: "80.00", paidAmount: "0.00", remainingAmount: "80.00", status: "accrued" }];
        for (const language of ["en", "th"] as const) {
            testLanguage = language;
            vi.mocked(api.post).mockResolvedValueOnce({ data: { publicId: "warning-proposal", paymentIntakePublicId: "warning-intake", status: "review_required", warnings: [{ code: "POSSIBLE_SEMANTIC_DUPLICATE", intakePublicIds: ["SECRET-ID"] }], totalAllocated: "80.00" } } as never);
            const view = render(<MemoryRouter><LoanAccrualsTab rows={rows} loanPublicId={`loan-warning-${language}`} /></MemoryRouter>);
            fireEvent.click(screen.getByRole("button", { name: language === "en" ? "Pay" : "รับชำระ" }));
            fireEvent.click(screen.getByRole("button", { name: language === "en" ? "Preview" : "ตรวจสอบ" }));
            const expected = language === "en" ? "A matching payment needs review before this receipt can proceed." : "พบรายการรับชำระที่อาจซ้ำ ต้องตรวจสอบก่อนทำต่อ";
            await waitFor(() => expect(screen.getByText(expected)).toBeTruthy());
            expect(screen.queryByText(/POSSIBLE_SEMANTIC_DUPLICATE|SECRET-ID/)).toBeNull();
            expect(screen.queryByRole("button", { name: language === "en" ? "Confirm payment" : "ยืนยันรับชำระ" })).toBeNull();
            view.unmount();
        }
        testLanguage = "en";
    });
});
