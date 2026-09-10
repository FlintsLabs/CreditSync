import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { auditLogs, paymentBatchStagingEvidence, paymentBatchStagingItems, paymentBatchOperationReceipts, transactions, users } from "../db/schema";
import { extractPaymentBatchStagingItem, parsePaymentSlipOcrCandidate } from "./payment-batch-ocr-service";
import type { CommandContext } from "./command-context";
import { finalizePaymentBatchStagingEvidence, preparePaymentBatchStagingEvidence, stagePaymentBatchItems } from "./payment-batch-service";

const integrationTest = process.env.TEST_DATABASE_URL ? test : test.skip;

describe("payment batch OCR candidate boundary", () => {
    test("exposes an evidence-bound extraction command that remains review-only", () => {
        expect(typeof extractPaymentBatchStagingItem).toBe("function");
    });

    test("normalizes a Thai slip into review-only safe candidate fields", () => {
        const result = parsePaymentSlipOcrCandidate(
            "โอนเงินสำเร็จ 12 เม.ย. 69 18:55 น. จาก คุณสมชาย ถึง CreditSync จำนวน 1,200.50 บาท ค่าธรรมเนียม 0.00 บาท เลขที่รายการ ABC-123",
            "e".repeat(64),
        );

        expect(result).toMatchObject({
            status: "needs_human_review",
            amount: "1200.50",
            transferredAt: "2026-04-12T11:55:00.000Z",
            payerName: "คุณสมชาย",
            receiverName: "CreditSync",
            fee: "0.00",
            evidenceSha256: "e".repeat(64),
        });
        expect(result).not.toHaveProperty("rawText");
        expect(result).not.toHaveProperty("reference");
    });

    test("fails closed when amount or transfer time is not confidently parseable", () => {
        expect(parsePaymentSlipOcrCandidate("โอนเงินสำเร็จ จำนวน ??? บาท", "f".repeat(64))).toMatchObject({
            status: "needs_human_review",
            amount: null,
            transferredAt: null,
            reviewRequired: true,
        });
    });

    test("validates Bangkok local calendar before converting early morning and year-boundary timestamps", () => {
        expect(parsePaymentSlipOcrCandidate("01 ม.ค. 69 00:30 จาก คุณเอ ถึง CreditSync จำนวน 1.00 บาท", "a".repeat(64))).toMatchObject({
            transferredAt: "2025-12-31T17:30:00.000Z",
        });
        expect(parsePaymentSlipOcrCandidate("31 ธ.ค. 69 00:30 จาก คุณเอ ถึง CreditSync จำนวน 1.00 บาท", "a".repeat(64))).toMatchObject({
            transferredAt: "2026-12-30T17:30:00.000Z",
        });
        expect(parsePaymentSlipOcrCandidate("29 ก.พ. 67 12:00 จาก คุณเอ ถึง CreditSync จำนวน 1.00 บาท", "a".repeat(64))).toMatchObject({
            transferredAt: "2024-02-29T05:00:00.000Z",
        });
        expect(parsePaymentSlipOcrCandidate("29 ก.พ. 69 12:00 จาก คุณเอ ถึง CreditSync จำนวน 1.00 บาท", "a".repeat(64))).toMatchObject({ transferredAt: null });
        expect(parsePaymentSlipOcrCandidate("01 ม.ค. 2569 จาก คุณเอ ถึง CreditSync จำนวน 1.00 บาท", "a".repeat(64))).toMatchObject({ transferredAt: null });
        expect(parsePaymentSlipOcrCandidate("01 ม.ค. 2026 00:30 จาก คุณเอ ถึง CreditSync จำนวน 1.00 บาท", "a".repeat(64))).toMatchObject({ transferredAt: null });
    });

    test("does not persist unlabeled account numbers or QR/reference layout as names", () => {
        const result = parsePaymentSlipOcrCandidate(
            "โอนสำเร็จ 12 เม.ย. 69 18:55 0812345678 1234567890123 QR123456789012345678 ถึง 9876543210 จำนวน 1,200.50 บาท",
            "b".repeat(64),
        );
        expect(result.payerName).toBeNull();
        expect(result.receiverName).toBeNull();
        expect(result).not.toHaveProperty("rawText");
    });

    integrationTest("extracts after finalized staging evidence, retries without duplicate membership, and never posts", async () => {
        const tenantId = `batch-ocr-${crypto.randomUUID()}`;
        const actor = await db.insert(users).values({ tenantId, email: `${crypto.randomUUID()}@example.test`, role: "owner" }).returning().then((rows) => rows[0]!);
        const ctx: CommandContext = { tenantId, actorUserId: actor.id, actorSource: "web", requestId: crypto.randomUUID(), correlationId: crypto.randomUUID() };
        const staged = await stagePaymentBatchItems(ctx, { idempotencyKey: "ocr-stage", items: [{ clientItemKey: "slip-ocr-1", payerName: "Synthetic payer" }] });
        const stagingPublicId = staged.items[0]!.publicId;
        const imageBytes = Buffer.from("synthetic-image");
        const imageSha256 = createHash("sha256").update(imageBytes).digest("hex");
        const gateway = {
            preparePut: async () => ({ uploadUrl: "https://upload.invalid/ocr", expiresAt: new Date(Date.now() + 60_000), requiredHeaders: {} }),
            head: async () => ({ exists: true, contentType: "image/png", contentLength: imageBytes.length, checksumSha256: imageSha256, metadata: { tenant: tenantId, staging: stagingPublicId } }),
        };
        const prepared = await preparePaymentBatchStagingEvidence(ctx, { stagingItemPublicId: stagingPublicId, mimeType: "image/png", size: imageBytes.length, sha256: imageSha256 }, gateway);
        await finalizePaymentBatchStagingEvidence(ctx, stagingPublicId, prepared.evidencePublicId, gateway);
        let attempts = 0;
        let downloads = 0;
        const dependencies = { download: async () => { downloads += 1; return downloads === 1 ? Buffer.from("wrong-bytes") : imageBytes; }, extract: async () => { attempts += 1; if (attempts === 1) throw new Error("synthetic OCR unavailable"); return "12 เม.ย. 69 18:55 น. จาก คุณสมชาย ถึง CreditSync จำนวน 1,200.50 บาท"; } };
        await expect(extractPaymentBatchStagingItem(ctx, { stagingItemPublicId: stagingPublicId, idempotencyKey: "ocr-checksum" }, dependencies)).rejects.toMatchObject({ code: "STAGING_EVIDENCE_CHECKSUM_MISMATCH" });
        await expect(extractPaymentBatchStagingItem(ctx, { stagingItemPublicId: stagingPublicId, idempotencyKey: "ocr-extract" }, dependencies)).rejects.toThrow("synthetic OCR unavailable");
        const result = await extractPaymentBatchStagingItem(ctx, { stagingItemPublicId: stagingPublicId, idempotencyKey: "ocr-extract" }, dependencies);
        const replay = await extractPaymentBatchStagingItem({ ...ctx, correlationId: crypto.randomUUID(), requestId: crypto.randomUUID() }, { stagingItemPublicId: stagingPublicId, idempotencyKey: "ocr-extract" }, dependencies);
        expect(replay).toEqual(result);
        expect(result.proposal).toMatchObject({ amount: "1200.50", status: "needs_human_review", transferredAt: "2026-04-12T11:55:00.000Z" });
        expect(result.proposal).not.toHaveProperty("rawText");
        expect(await db.select().from(paymentBatchStagingItems).where(eq(paymentBatchStagingItems.publicId, stagingPublicId))).toHaveLength(1);
        expect(await db.select().from(paymentBatchStagingEvidence).where(eq(paymentBatchStagingEvidence.stagingItemId, (await db.query.paymentBatchStagingItems.findFirst({ where: eq(paymentBatchStagingItems.publicId, stagingPublicId) }))!.id))).toHaveLength(1);
        expect(await db.select().from(paymentBatchOperationReceipts).where(and(eq(paymentBatchOperationReceipts.tenantId, tenantId), eq(paymentBatchOperationReceipts.operationType, "staging.extract")))).toHaveLength(1);
        expect(await db.select().from(transactions).where(eq(transactions.tenantId, tenantId))).toHaveLength(0);
    });

    integrationTest("serializes concurrent extraction and replays the exact receipt for one key", async () => {
        const tenantId = `batch-ocr-concurrent-${crypto.randomUUID()}`;
        const actor = await db.insert(users).values({ tenantId, email: `${crypto.randomUUID()}@example.test`, role: "owner" }).returning().then((rows) => rows[0]!);
        const ctx = (correlationId: string): CommandContext => ({ tenantId, actorUserId: actor.id, actorSource: "web", requestId: crypto.randomUUID(), correlationId });
        const firstCtx = ctx(crypto.randomUUID());
        const staged = await stagePaymentBatchItems(firstCtx, { idempotencyKey: "ocr-concurrent-stage", items: [{ clientItemKey: "concurrent-slip", payerName: "Synthetic payer" }] });
        const stagingPublicId = staged.items[0]!.publicId;
        const imageBytes = Buffer.from("concurrent-synthetic-image");
        const imageSha256 = createHash("sha256").update(imageBytes).digest("hex");
        const gateway = {
            preparePut: async () => ({ uploadUrl: "https://upload.invalid/ocr", expiresAt: new Date(Date.now() + 60_000), requiredHeaders: {} }),
            head: async () => ({ exists: true, contentType: "image/png", contentLength: imageBytes.length, checksumSha256: imageSha256, metadata: { tenant: tenantId, staging: stagingPublicId } }),
        };
        const prepared = await preparePaymentBatchStagingEvidence(firstCtx, { stagingItemPublicId: stagingPublicId, mimeType: "image/png", size: imageBytes.length, sha256: imageSha256 }, gateway);
        await finalizePaymentBatchStagingEvidence(firstCtx, stagingPublicId, prepared.evidencePublicId, gateway);
        let downloadCount = 0;
        let release!: () => void;
        const bothDownloaded = new Promise<void>((resolve) => { release = resolve; });
        const dependencies = {
            download: async () => { downloadCount += 1; if (downloadCount === 2) release(); await bothDownloaded; return imageBytes; },
            extract: async () => "12 เม.ย. 69 18:55 น. จาก คุณสมชาย ถึง CreditSync จำนวน 1,200.50 บาท",
        };
        const [left, right] = await Promise.all([
            extractPaymentBatchStagingItem(ctx("ocr-left"), { stagingItemPublicId: stagingPublicId, idempotencyKey: "same-concurrent-key" }, dependencies),
            extractPaymentBatchStagingItem(ctx("ocr-right"), { stagingItemPublicId: stagingPublicId, idempotencyKey: "same-concurrent-key" }, dependencies),
        ]);
        expect(left).toEqual(right);
        expect(await db.select().from(paymentBatchOperationReceipts).where(and(eq(paymentBatchOperationReceipts.tenantId, tenantId), eq(paymentBatchOperationReceipts.operationType, "staging.extract")))).toHaveLength(1);
        expect(await db.select().from(auditLogs).where(and(eq(auditLogs.tenantId, tenantId), eq(auditLogs.action, "staging.extract")))).toHaveLength(1);
        expect(await db.select().from(transactions).where(eq(transactions.tenantId, tenantId))).toHaveLength(0);
    });
});
