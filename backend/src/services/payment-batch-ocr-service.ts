import { createHash } from "node:crypto";
import { Decimal } from "decimal.js";
import { and, eq, sql } from "drizzle-orm";
import { db, type DbExecutor } from "../db";
import { files, paymentBatchOperationReceipts, paymentBatchStagingEvidence, paymentBatchStagingItems, paymentBatches, users } from "../db/schema";
import { canAccessTenantWideData } from "../lib/access";
import { downloadFile } from "../lib/storage";
import { extractTextFromImage } from "../lib/ocr";
import { createAuditLog } from "../lib/audit-log";
import type { CommandContext } from "./command-context";
import { DomainError } from "./domain-error";

export type PaymentSlipOcrCandidate = {
    status: "needs_human_review";
    reviewRequired: true;
    amount: string | null;
    transferredAt: string | null;
    payerName: string | null;
    receiverName: string | null;
    fee: string | null;
    referenceHash: string | null;
    evidenceSha256: string;
};

type OcrDependencies = {
    download?: (key: string, bucket: string) => Promise<Buffer>;
    extract?: (bytes: Buffer) => Promise<string>;
};

function requestDigest(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function requireUuid(value: string, field: string) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new DomainError("INVALID_PUBLIC_ID", `${field} must be a UUID`, 400);
}

async function accessibleStaging(ctx: CommandContext, executor: DbExecutor, publicId: string) {
    requireUuid(publicId, "stagingItemPublicId");
    const staging = await executor.query.paymentBatchStagingItems.findFirst({ where: and(eq(paymentBatchStagingItems.tenantId, ctx.tenantId), eq(paymentBatchStagingItems.publicId, publicId)) });
    if (!staging) throw new DomainError("PAYMENT_BATCH_STAGING_NOT_FOUND", "Staging item not found", 404);
    const batch = await executor.query.paymentBatches.findFirst({ where: and(eq(paymentBatches.tenantId, ctx.tenantId), eq(paymentBatches.id, staging.batchId)) });
    if (!batch) throw new DomainError("PAYMENT_BATCH_NOT_FOUND", "Payment batch not found", 404);
    if (ctx.actorUserId !== null) {
        const user = await executor.query.users.findFirst({ where: and(eq(users.tenantId, ctx.tenantId), eq(users.id, ctx.actorUserId)) });
        if (!user || (!canAccessTenantWideData({ role: user.role ?? "viewer" }) && batch.createdByUserId !== user.id)) throw new DomainError("PAYMENT_BATCH_NOT_FOUND", "Payment batch not found", 404);
    }
    return { staging, batch };
}

/** Extracts transient OCR text locally and stores only a review receipt, never raw text or financial state. */
export async function extractPaymentBatchStagingItem(ctx: CommandContext, input: { stagingItemPublicId: string; idempotencyKey: string }, dependencies: OcrDependencies = {}) {
    const key = input.idempotencyKey.trim();
    if (!key) throw new DomainError("INVALID_IDEMPOTENCY_KEY", "idempotencyKey must not be blank", 400);
    const metadata = await db.transaction(async (tx) => {
        const { staging, batch } = await accessibleStaging(ctx, tx, input.stagingItemPublicId);
        await tx.execute(sql`SELECT id FROM payment_batches WHERE tenant_id = ${ctx.tenantId} AND id = ${batch.id} FOR SHARE`);
        const evidence = await tx.query.paymentBatchStagingEvidence.findFirst({ where: and(eq(paymentBatchStagingEvidence.tenantId, ctx.tenantId), eq(paymentBatchStagingEvidence.stagingItemId, staging.id), eq(paymentBatchStagingEvidence.status, "ready")) });
        if (!evidence || !evidence.finalizedAt) throw new DomainError("EVIDENCE_REQUIRED_NOT_READY", "Finalize staging evidence before extraction", 409);
        const file = await tx.query.files.findFirst({ where: and(eq(files.tenantId, ctx.tenantId), eq(files.id, evidence.fileId)) });
        if (!file) throw new DomainError("STAGING_EVIDENCE_FILE_NOT_FOUND", "Staging evidence file not found", 404);
        const requestHash = requestDigest({ stagingItemPublicId: staging.publicId, revision: staging.revision, evidencePublicId: evidence.publicId, evidenceSha256: evidence.evidenceHash });
        const prior = await tx.query.paymentBatchOperationReceipts.findFirst({ where: and(eq(paymentBatchOperationReceipts.tenantId, ctx.tenantId), eq(paymentBatchOperationReceipts.operationType, "staging.extract"), eq(paymentBatchOperationReceipts.operationKey, key)) });
        if (prior) {
            if (prior.requestHash !== requestHash) throw new DomainError("IDEMPOTENCY_CONFLICT", "Extraction idempotency key was reused with different evidence or revision", 409);
            return { prior: prior.result, bytes: null as Buffer | null, file: null, staging, batch, evidence, requestHash };
        }
        if (file.mimeType === "application/pdf") throw new DomainError("OCR_UNSUPPORTED_MIME", "Local slip OCR currently supports image evidence only; review the PDF manually", 409);
        return { prior: null, bytes: null as Buffer | null, file, staging, batch, evidence, requestHash };
    });
    if (metadata.prior) return metadata.prior;
    const bytes = await (dependencies.download ?? downloadFile)(metadata.file!.key, metadata.file!.bucket);
    const text = await (dependencies.extract ?? ((buffer: Buffer) => extractTextFromImage(buffer)))(bytes);
    const proposal = parsePaymentSlipOcrCandidate(text, metadata.evidence.evidenceHash);
    return db.transaction(async (tx) => {
        const { staging, batch } = await accessibleStaging(ctx, tx, input.stagingItemPublicId);
        const currentEvidence = await tx.query.paymentBatchStagingEvidence.findFirst({ where: and(eq(paymentBatchStagingEvidence.tenantId, ctx.tenantId), eq(paymentBatchStagingEvidence.stagingItemId, staging.id), eq(paymentBatchStagingEvidence.status, "ready")) });
        if (!currentEvidence || staging.revision !== metadata.staging.revision || currentEvidence.publicId !== metadata.evidence.publicId || currentEvidence.evidenceHash !== metadata.evidence.evidenceHash) throw new DomainError("STALE_STAGING_EVIDENCE", "Evidence or staging revision changed during extraction; retry review", 409);
        const prior = await tx.query.paymentBatchOperationReceipts.findFirst({ where: and(eq(paymentBatchOperationReceipts.tenantId, ctx.tenantId), eq(paymentBatchOperationReceipts.operationType, "staging.extract"), eq(paymentBatchOperationReceipts.operationKey, key)) });
        if (prior) {
            if (prior.requestHash !== metadata.requestHash) throw new DomainError("IDEMPOTENCY_CONFLICT", "Extraction idempotency key was reused with different evidence or revision", 409);
            return prior.result;
        }
        const audit = await createAuditLog(tx, { tenantId: ctx.tenantId, actorUserId: ctx.actorUserId, actorSource: ctx.actorSource, requestId: ctx.requestId, correlationId: ctx.correlationId, entityType: "payment_batch_staging", entityId: staging.publicId, action: "staging.extract", payload: { stagingItemPublicId: staging.publicId, revision: staging.revision, evidencePublicId: currentEvidence.publicId, evidenceSha256: currentEvidence.evidenceHash, status: proposal.status } });
        const result = { stagingItemPublicId: staging.publicId, batchPublicId: batch.publicId, stagingRevision: staging.revision, evidencePublicId: currentEvidence.publicId, evidenceSha256: currentEvidence.evidenceHash, proposal, auditPublicId: audit.publicId, correlationId: ctx.correlationId };
        await tx.insert(paymentBatchOperationReceipts).values({ tenantId: ctx.tenantId, batchId: batch.id, stagingItemId: staging.id, operationType: "staging.extract", operationKey: key, requestHash: metadata.requestHash, result, createdByUserId: ctx.actorUserId });
        return result;
    });
}

const thaiMonths: Record<string, number> = {
    "ม.ค.": 1, "ก.พ.": 2, "มี.ค.": 3, "เม.ย.": 4, "พ.ค.": 5, "มิ.ย.": 6,
    "ก.ค.": 7, "ส.ค.": 8, "ก.ย.": 9, "ต.ค.": 10, "พ.ย.": 11, "ธ.ค.": 12,
};

function money(value: string | null | undefined) {
    if (!value) return null;
    try {
        const normalized = value.replace(/,/g, "").replace(/[๐-๙]/g, (digit) => String("๐๑๒๓๔๕๖๗๘๙".indexOf(digit)));
        const parsed = new Decimal(normalized);
        if (!parsed.isFinite() || parsed.isNegative()) return null;
        return parsed.toFixed(2);
    } catch { return null; }
}

function bangkokIso(day: string | null | undefined, month: string | null | undefined, year: string | null | undefined, hour: string | null | undefined, minute: string | null | undefined) {
    const monthNumber = month ? thaiMonths[month] : undefined;
    const dayNumber = Number(day);
    const rawYear = Number(year);
    const yearNumber = rawYear < 100 ? 2500 + rawYear : rawYear;
    const hourNumber = Number(hour);
    const minuteNumber = Number(minute);
    const ceYear = yearNumber - 543;
    if (!monthNumber || !Number.isInteger(dayNumber) || dayNumber < 1 || dayNumber > 31 || !Number.isInteger(ceYear) || ceYear < 1900 || ceYear > 2200 || hourNumber < 0 || hourNumber > 23 || minuteNumber < 0 || minuteNumber > 59) return null;
    const value = new Date(Date.UTC(ceYear, monthNumber - 1, dayNumber, hourNumber - 7, minuteNumber));
    if (value.getUTCFullYear() !== ceYear || value.getUTCMonth() !== monthNumber - 1 || value.getUTCDate() !== dayNumber) return null;
    return value.toISOString();
}

function field(text: string, pattern: RegExp) {
    return text.match(pattern)?.[1]?.trim().replace(/\s+/g, " ") || null;
}

export function parsePaymentSlipOcrCandidate(text: string, evidenceSha256: string): PaymentSlipOcrCandidate {
    const date = text.match(/(\d{1,2})\s+(ม\.ค\.|ก\.พ\.|มี\.ค\.|เม\.ย\.|พ\.ค\.|มิ\.ย\.|ก\.ค\.|ส\.ค\.|ก\.ย\.|ต\.ค\.|พ\.ย\.|ธ\.ค\.)\s+(\d{2,4})\s+(\d{1,2}):(\d{2})/) ?? [];
    const reference = field(text, /เลขที่รายการ\s*:?\s*([A-Za-z0-9-]+)/i);
    return {
        status: "needs_human_review",
        reviewRequired: true,
        amount: money(field(text, /จำนวน\s*:?\s*([๐-๙0-9,]+(?:\.\d{1,2})?)/)),
        transferredAt: bangkokIso(date[1], date[2], date[3], date[4], date[5]),
        payerName: field(text, /จาก\s+(.+?)\s+ถึง/),
        receiverName: field(text, /ถึง\s+(.+?)\s+จำนวน/),
        fee: money(field(text, /ค่าธรรมเนียม\s*:?\s*([๐-๙0-9,]+(?:\.\d{1,2})?)/)),
        referenceHash: reference ? createHash("sha256").update(reference).digest("hex") : null,
        evidenceSha256: evidenceSha256.toLowerCase(),
    };
}
