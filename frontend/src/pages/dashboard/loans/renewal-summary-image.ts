import { formatMoneyExact } from "../../../lib/workflow-model";
import type { RenewalComposition } from "./loan-renewal-model";

export interface LoanRenewalSummary {
    status: "preview" | "executed" | "reversed" | "expired";
    watermark: "preview_not_executed" | "renewal_executed" | "renewal_reversed";
    renewalPublicId: string;
    borrower: { displayName: string };
    oldContract: { publicId: string; startDate: string; dueDate: string };
    replacement: { publicId: string | null; principal: string; installmentAmount: string | null; totalInstallments: number | null };
    composition: RenewalComposition;
    generatedAt: string;
}

const escapeXml = (value: string) => value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[character]!));
const maskUuid = (value: string) => `${value.slice(0, 8)}…${value.slice(-4)}`;

function date(value: string, locale: string) {
    return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "Asia/Bangkok" }).format(new Date(`${value.slice(0, 10)}T12:00:00+07:00`));
}

export function buildRenewalSummarySvg(summary: LoanRenewalSummary, locale: string): string {
    const th = locale.toLowerCase().startsWith("th");
    const c = summary.composition;
    const money = (value: string) => escapeXml(formatMoneyExact(value, locale));
    const watermark = th
        ? ({ preview_not_executed: "พรีวิว — ยังไม่ดำเนินการ", renewal_executed: "ดำเนินการต่อสัญญาแล้ว", renewal_reversed: "กลับรายการแล้ว" } as const)[summary.watermark]
        : ({ preview_not_executed: "PREVIEW — NOT EXECUTED", renewal_executed: "RENEWAL EXECUTED", renewal_reversed: "RENEWAL REVERSED" } as const)[summary.watermark];
    const labels = th
        ? ["รับชำระรวม", "ดอกเต็มสัญญาเดิม", "ดอกที่รับแล้ว", "ดอกสัญญาเดิมที่เหลือ", "เงินคืนก่อนปรับ", "ยอดหักสัญญาเดิม", "เงินสดสุทธิ"]
        : ["Total received", "Full old-contract interest", "Interest received", "Remaining contract interest", "Recovered before adjustments", "Old-contract settlement", "Net cash"];
    const values = [c.totalPaid, c.contractualInterest, c.receivedInterest, c.remainingContractInterest, c.recoveredBeforeAdjustments, c.settlementAmount, c.cashAmount];
    const paymentFirst = c.payments[0]?.paidAt;
    const paymentLast = c.payments.at(-1)?.paidAt;
    const adjustmentRows = c.adjustments.slice(0, 5).map((line, index) => `<text x="100" y="${890 + index * 44}" class="small">${escapeXml(`${line.lineNo}. ${line.kind} — ${line.reason}`)}</text><text x="980" y="${890 + index * 44}" text-anchor="end" class="small">${money(line.amount)}</text>`).join("");
    const rows = labels.slice(0, -1).map((label, index) => `<text x="100" y="${400 + index * 62}" class="label">${escapeXml(label)}</text><text x="980" y="${400 + index * 62}" text-anchor="end" class="value" data-exact="${values[index]}">${money(values[index]!)}</text>`).join("");
    const netCashY = 794;
    const netCashRow = `<line x1="100" y1="730" x2="980" y2="730" stroke="#d9e4f2" stroke-width="2"/><rect x="75" y="742" width="930" height="84" rx="16" fill="#f8fbff" stroke="#cbd5e1" stroke-width="2" data-summary="net-cash"/><text x="100" y="${netCashY}" class="net-cash-label">${escapeXml(labels.at(-1)!)}</text><text x="980" y="${netCashY}" text-anchor="end" class="net-cash-value" data-exact="${values.at(-1)}">${money(values.at(-1)!)}</text>`;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1350" viewBox="0 0 1080 1350"><style>text{font-family:Sarabun,"Noto Sans Thai",Arial,sans-serif;fill:#10233f}.title{font-size:44px;font-weight:700}.watermark{font-size:34px;font-weight:700;fill:#b45309}.label,.small{font-size:25px}.value{font-size:29px;font-weight:700}.net-cash-label{font-size:28px;font-weight:700;fill:#0f5ea8}.net-cash-value{font-size:35px;font-weight:800;fill:#0f5ea8}.muted{font-size:21px;fill:#5b6778}</style><rect width="1080" height="1350" fill="#f4f8ff"/><rect x="55" y="55" width="970" height="1240" rx="34" fill="#fff" stroke="#d9e4f2" stroke-width="3"/><image href="/renewal-finance-watermark.png" x="55" y="55" width="970" height="1240" preserveAspectRatio="xMidYMid slice" opacity="0.16"/><text x="100" y="130" class="title">CreditSync · ${th ? "สรุปการต่อสัญญา" : "Renewal summary"}</text><text x="100" y="188" class="watermark">${escapeXml(watermark)}</text><text x="100" y="250" class="label">${escapeXml(summary.borrower.displayName)}</text><text x="100" y="294" class="muted">${escapeXml(maskUuid(summary.oldContract.publicId))} · ${date(summary.oldContract.startDate, locale)} – ${date(summary.oldContract.dueDate, locale)}</text><line x1="100" y1="330" x2="980" y2="330" stroke="#d9e4f2" stroke-width="2"/>${rows}${netCashRow}<line x1="100" y1="878" x2="980" y2="878" stroke="#d9e4f2" stroke-width="2"/><text x="100" y="852" class="muted">${th ? "ทิศทางเงินสด" : "Cash direction"}: ${escapeXml(c.cashDirection)}</text>${adjustmentRows}<text x="100" y="1140" class="label">${th ? "ประวัติรับชำระ" : "Payment history"}: ${c.payments.length}</text><text x="100" y="1184" class="muted">${paymentFirst ? date(paymentFirst, locale) : "—"} — ${paymentLast ? date(paymentLast, locale) : "—"}</text><text x="100" y="1245" class="muted">${th ? "สัญญาใหม่" : "Replacement"}: ${escapeXml(summary.replacement.publicId ? maskUuid(summary.replacement.publicId) : "—")} · ${money(summary.replacement.principal)}</text></svg>`;
}

export async function renewalSummaryPng(summary: LoanRenewalSummary, locale: string): Promise<Blob> {
    const svg = buildRenewalSummarySvg(summary, locale);
    const image = new Image();
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
    try {
        await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error("RENEWAL_SUMMARY_IMAGE_LOAD_FAILED")); image.src = url; });
        const canvas = document.createElement("canvas"); canvas.width = 1080; canvas.height = 1350;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("RENEWAL_SUMMARY_CANVAS_UNAVAILABLE");
        context.drawImage(image, 0, 0, 1080, 1350);
        return await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("RENEWAL_SUMMARY_EXPORT_FAILED")), "image/png"));
    } finally { URL.revokeObjectURL(url); }
}

export function renewalSummaryFilename(summary: LoanRenewalSummary) {
    return `renewal-${maskUuid(summary.renewalPublicId).replace("…", "-")}-${summary.status === "executed" ? "executed" : "preview"}.png`;
}
