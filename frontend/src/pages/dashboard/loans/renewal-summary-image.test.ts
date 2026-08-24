import { afterEach, describe, expect, test, vi } from "vitest";
import { buildRenewalSummarySvg, renewalSummaryFilename, renewalSummaryPng, type LoanRenewalSummary } from "./renewal-summary-image";

export const summaryFixture: LoanRenewalSummary = {
    status: "preview", watermark: "preview_not_executed", renewalPublicId: "01a01eaf-fdec-79a1-9e0c-fa66a5efa4cc", borrower: { displayName: "Customer <safe>" },
    oldContract: { publicId: "019ff2b2-15e2-7df7-a594-eb836ff388f0", startDate: "2026-08-01", dueDate: "2026-08-24" },
    replacement: { publicId: null, principal: "2000.00", installmentAmount: "100.00", totalInstallments: 24 }, generatedAt: "2026-08-10T10:00:00.000Z",
    composition: { settlementPolicy: "full_contract_interest", contractStartDate: "2026-08-01", contractDueDate: "2026-08-24", renewalDate: "2026-08-10", requestedPrincipal: "2000.00", originalPrincipal: "2000.00", totalScheduledAmount: "2400.00", contractualInterest: "400.00", totalPaid: "1000.00", receivedPrincipal: "833.33", receivedInterest: "166.67", remainingContractInterest: "233.33", accruedDueInterest: "0.00", dueFees: "0.00", duePenalties: "0.00", recoveredBeforeAdjustments: "600.00", manualCharges: "0.00", manualWaivers: "0.00", settlementAmount: "233.33", cashDirection: "payout", cashAmount: "600.00", payments: Array.from({ length: 12 }, (_, index) => ({ transactionPublicId: `payment-${index}`, paidAt: `2026-08-${String(index + 1).padStart(2, "0")}T09:00:00.000Z`, amount: "100.00", principal: "83.33", interest: "16.67", fee: "0.00", penalty: "0.00" })), adjustments: [] },
};

describe("deterministic renewal summary SVG", () => {
    const originalImage = globalThis.Image;
    afterEach(() => { globalThis.Image = originalImage; vi.restoreAllMocks(); });
    test("uses fixed dimensions, escaped safe fields, exact backend values, watermark, and bounded history", () => {
        const svg = buildRenewalSummarySvg(summaryFixture, "en");
        expect(svg).toContain('width="1080" height="1350"');
        for (const value of ["1000.00", "400.00", "233.33", "600.00"]) expect(svg).toContain(value);
        expect(svg).toContain("PREVIEW — NOT EXECUTED");
        expect(svg).toContain("Customer &lt;safe&gt;");
        expect(svg).toContain("Payment history: 12");
        expect(svg).not.toContain("payment-11");
    });

    test("adds a subtle finance watermark and visually separates net cash", () => {
        const svg = buildRenewalSummarySvg(summaryFixture, "th");
        expect(svg).toContain('href="/renewal-finance-watermark.png"');
        expect(svg).toContain('opacity="0.16"');
        expect(svg).toContain('data-summary="net-cash"');
        expect(svg).toContain('stroke="#cbd5e1"');
        expect(svg).toContain('fill="#f8fbff"');
        expect(svg).toContain('y="742" width="930" height="84"');
    });

    test("distinguishes executed export names", () => {
        expect(buildRenewalSummarySvg({ ...summaryFixture, status: "executed", watermark: "renewal_executed" }, "en")).toContain("RENEWAL EXECUTED");
        expect(renewalSummaryFilename({ ...summaryFixture, status: "executed" })).toMatch(/-executed\.png$/);
    });

    test("converts the SVG to PNG through canvas without financial summation", async () => {
        class LoadedImage { onload: null | (() => void) = null; onerror: null | (() => void) = null; set src(_value: string) { queueMicrotask(() => this.onload?.()); } }
        globalThis.Image = LoadedImage as unknown as typeof Image;
        const originalFetch = globalThis.fetch;
        globalThis.fetch = vi.fn(async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([137, 80, 78, 71]).buffer })) as unknown as typeof fetch;
        let sourceBlob: Blob | null = null;
        Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn((blob: Blob) => { sourceBlob = blob; return "blob:summary"; }) });
        Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
        const originalCreate = document.createElement.bind(document);
        vi.spyOn(document, "createElement").mockImplementation(((tag: string) => tag === "canvas"
            ? { width: 0, height: 0, getContext: () => ({ drawImage: vi.fn() }), toBlob: (callback: (blob: Blob | null) => void) => callback(new Blob(["png"], { type: "image/png" })) }
            : originalCreate(tag)) as typeof document.createElement);
        await expect(renewalSummaryPng(summaryFixture, "en")).resolves.toBeInstanceOf(Blob);
        expect(fetch).toHaveBeenCalledWith("/renewal-finance-watermark.png");
        expect(await sourceBlob!.text()).toContain("data:image/png;base64,iVBORw==");
        const source = buildRenewalSummarySvg.toString();
        expect(source).not.toContain("new Decimal");
        expect(source).not.toContain("Number(");
        globalThis.fetch = originalFetch;
    });
});
