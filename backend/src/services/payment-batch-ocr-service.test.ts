import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { paymentBatchStagingEvidence, paymentBatchStagingItems, paymentBatchOperationReceipts, transactions, users } from "../db/schema";
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

    integrationTest("extracts after finalized staging evidence, retries without duplicate membership, and never posts", async () => {
        const tenantId = `batch-ocr-${crypto.randomUUID()}`;
        const actor = await db.insert(users).values({ tenantId, email: `${crypto.randomUUID()}@example.test`, role: "owner" }).returning().then((rows) => rows[0]!);
        const ctx: CommandContext = { tenantId, actorUserId: actor.id, actorSource: "web", requestId: crypto.randomUUID(), correlationId: crypto.randomUUID() };
        const staged = await stagePaymentBatchItems(ctx, { idempotencyKey: "ocr-stage", items: [{ clientItemKey: "slip-ocr-1", payerName: "Synthetic payer" }] });
        const stagingPublicId = staged.items[0]!.publicId;
        const gateway = {
            preparePut: async () => ({ uploadUrl: "https://upload.invalid/ocr", expiresAt: new Date(Date.now() + 60_000), requiredHeaders: {} }),
            head: async () => ({ exists: true, contentType: "image/png", contentLength: 32, checksumSha256: "a".repeat(64), metadata: { tenant: tenantId, staging: stagingPublicId } }),
        };
        const prepared = await preparePaymentBatchStagingEvidence(ctx, { stagingItemPublicId: stagingPublicId, mimeType: "image/png", size: 32, sha256: "a".repeat(64) }, gateway);
        await finalizePaymentBatchStagingEvidence(ctx, stagingPublicId, prepared.evidencePublicId, gateway);
        let attempts = 0;
        const dependencies = { download: async () => Buffer.from("synthetic-image"), extract: async () => { attempts += 1; if (attempts === 1) throw new Error("synthetic OCR unavailable"); return "12 เม.ย. 69 18:55 น. จาก คุณสมชาย ถึง CreditSync จำนวน 1,200.50 บาท"; } };
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
});
