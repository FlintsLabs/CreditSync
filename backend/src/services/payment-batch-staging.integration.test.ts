import { expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { borrowers, paymentBatches, paymentBatchOperationReceipts, paymentBatchStagingEvidence, paymentBatchStagingItems, paymentIntakes, transactions, users } from "../db/schema";
import type { CommandContext } from "./command-context";
import type { EvidenceStorageGateway } from "./payment-service";
import { stagePaymentBatchItems, preparePaymentBatchStagingEvidence, finalizePaymentBatchStagingEvidence, reviewPaymentBatchStagingItem, previewPaymentBatch, cancelPaymentBatch, capturePaymentBatch, getPaymentBatchWorkspace } from "./payment-batch-service";

const integration = process.env.TEST_DATABASE_URL ? test : test.skip;
async function fixture() {
    const tenantId = `staging-safety-${crypto.randomUUID()}`;
    const [user] = await db.insert(users).values({ tenantId, email: `${crypto.randomUUID()}@example.test`, role: "owner" }).returning();
    const [borrower] = await db.insert(borrowers).values({ tenantId, ownerUserId: user!.id, name: "Synthetic staging borrower" }).returning();
    const ctx: CommandContext = { tenantId, actorUserId: user!.id, actorSource: "web", requestId: crypto.randomUUID(), correlationId: crypto.randomUUID() };
    const input = { idempotencyKey: "stage", borrowerPublicId: borrower!.publicId, items: [{ clientItemKey: "a" }, { clientItemKey: "b" }] };
    const staged = await stagePaymentBatchItems(ctx, input);
    let putCount = 0;
    const heads = new Map<string, Awaited<ReturnType<EvidenceStorageGateway["head"]>>>();
    const gateway: EvidenceStorageGateway = {
        preparePut: async (request) => {
            putCount++;
            heads.set(request.key, { exists: true, contentType: request.contentType, contentLength: request.contentLength, checksumSha256: request.checksumSha256, metadata: request.metadata ?? {} });
            return { uploadUrl: "https://upload.invalid/synthetic", expiresAt: new Date(Date.now() + 60_000), requiredHeaders: {} };
        },
        head: async (key) => heads.get(key) ?? { exists: false, contentType: null, contentLength: null, checksumSha256: null, metadata: {} },
    };
    const evidenceInput = { stagingItemPublicId: staged.items[0]!.publicId, mimeType: "image/png", size: 32, sha256: "a".repeat(64) };
    return { ctx, input, staged, gateway, evidenceInput, putCount: () => putCount };
}

integration("stage retry is order independent and rejects changed membership without inserting another item", async () => {
    const f = await fixture();
    expect(await stagePaymentBatchItems(f.ctx, { ...f.input, items: [...f.input.items].reverse() })).toEqual(f.staged);
    await expect(stagePaymentBatchItems(f.ctx, { ...f.input, items: [...f.input.items, { clientItemKey: "c" }] })).rejects.toThrow("idempotency");
    expect(await db.select().from(paymentBatchStagingItems).where(eq(paymentBatchStagingItems.tenantId, f.ctx.tenantId))).toHaveLength(2);
    expect(await db.select().from(paymentIntakes).where(eq(paymentIntakes.tenantId, f.ctx.tenantId))).toHaveLength(0);
});

integration("workspace resumes upload-first staging with evidence and review links", async () => {
    const f = await fixture();
    const workspace = await getPaymentBatchWorkspace(f.ctx, f.staged.batchPublicId);
    expect(workspace.batchPublicId).toBe(f.staged.batchPublicId);
    expect(workspace.items).toHaveLength(2);
    expect(workspace.items.map((item) => item.clientItemKey)).toEqual(["a", "b"]);
    expect(workspace.items[0]).toMatchObject({ status: "staged", revision: 1, evidenceStatus: null, paymentIntakePublicId: null, batchItemPublicId: null });
    expect(workspace.items[0]).not.toHaveProperty("fileId");
});

integration("a restricted actor cannot stage slips against a borrower outside their portfolio", async () => {
    const f = await fixture();
    const [viewer] = await db.insert(users).values({ tenantId: f.ctx.tenantId, email: `${crypto.randomUUID()}@example.test`, role: "viewer" }).returning();
    await expect(stagePaymentBatchItems({ ...f.ctx, actorUserId: viewer!.id }, { ...f.input, idempotencyKey: "outside-portfolio" })).rejects.toThrow();
    expect(await db.select().from(paymentBatches).where(eq(paymentBatches.tenantId, f.ctx.tenantId))).toHaveLength(1);
});

integration("concurrent stage retries return one stable batch receipt", async () => {
    const f = await fixture();
    const input = { ...f.input, idempotencyKey: "concurrent" };
    const [a, b] = await Promise.all([stagePaymentBatchItems(f.ctx, input), stagePaymentBatchItems(f.ctx, input)]);
    expect(a).toEqual(b);
    expect(await db.select().from(paymentBatches).where(and(eq(paymentBatches.tenantId, f.ctx.tenantId), eq(paymentBatches.createIdempotencyKey, "concurrent")))).toHaveLength(1);
});

integration("capture retries bind the entire payload and return the same audited receipt in stable key order", async () => {
    const f = await fixture();
    const input = { idempotencyKey: "capture", borrowerPublicId: f.input.borrowerPublicId, notes: "reviewed", items: [
        { clientItemKey: "b", intakeIdempotencyKey: "capture-b", amount: "120.00", receivedAt: "2026-09-08T03:00:00Z" },
        { clientItemKey: "a", intakeIdempotencyKey: "capture-a", amount: "120.00", receivedAt: "2026-09-07T03:00:00Z" },
    ] };
    const [a, b] = await Promise.all([capturePaymentBatch(f.ctx, input), capturePaymentBatch({ ...f.ctx, correlationId: crypto.randomUUID() }, { ...input, items: [...input.items].reverse() })]);
    expect(a).toEqual(b);
    await expect(capturePaymentBatch(f.ctx, { ...input, notes: "changed" })).rejects.toThrow();
    const [viewer] = await db.insert(users).values({ tenantId: f.ctx.tenantId, email: `${crypto.randomUUID()}@example.test`, role: "viewer" }).returning();
    await expect(capturePaymentBatch({ ...f.ctx, actorUserId: viewer!.id }, input)).rejects.toThrow();
    expect(await db.select().from(paymentIntakes).where(eq(paymentIntakes.tenantId, f.ctx.tenantId))).toHaveLength(2);
    expect(await db.select().from(transactions).where(eq(transactions.tenantId, f.ctx.tenantId))).toHaveLength(0);
});

integration("finalize retry returns the same audited receipt and ready prepare never signs another PUT", async () => {
    const f = await fixture();
    const prepared = await preparePaymentBatchStagingEvidence(f.ctx, f.evidenceInput, f.gateway);
    const first = await finalizePaymentBatchStagingEvidence(f.ctx, f.evidenceInput.stagingItemPublicId, prepared.evidencePublicId, f.gateway);
    const retry = await finalizePaymentBatchStagingEvidence({ ...f.ctx, correlationId: crypto.randomUUID() }, f.evidenceInput.stagingItemPublicId, prepared.evidencePublicId, f.gateway);
    expect(retry).toEqual(first);
    expect(first).toHaveProperty("auditPublicId");
    const ready = await preparePaymentBatchStagingEvidence(f.ctx, f.evidenceInput, f.gateway);
    expect(ready).not.toHaveProperty("uploadUrl");
    expect(f.putCount()).toBe(1);
    await expect(preparePaymentBatchStagingEvidence(f.ctx, { ...f.evidenceInput, size: 33 }, f.gateway)).rejects.toThrow();
});

integration("review preserves public receipt, rejects changed payload and leaves the whole batch blocked by an unreviewed member", async () => {
    const f = await fixture();
    const evidence = await preparePaymentBatchStagingEvidence(f.ctx, f.evidenceInput, f.gateway);
    await finalizePaymentBatchStagingEvidence(f.ctx, f.evidenceInput.stagingItemPublicId, evidence.evidencePublicId, f.gateway);
    const input = { stagingItemPublicId: f.evidenceInput.stagingItemPublicId, amount: "120.00", receivedAt: "2026-09-07T10:00:00+07:00", intakeIdempotencyKey: "review-a" };
    const [a, b] = await Promise.all([reviewPaymentBatchStagingItem(f.ctx, input), reviewPaymentBatchStagingItem(f.ctx, input)]);
    expect(a).toEqual(b);
    expect(a).toHaveProperty("paymentIntakePublicId");
    expect(a).toHaveProperty("auditPublicId");
    await expect(reviewPaymentBatchStagingItem(f.ctx, { ...input, amount: "121.00" })).rejects.toThrow();
    await expect(previewPaymentBatch(f.ctx, f.staged.batchPublicId, { borrowerPublicId: f.input.borrowerPublicId })).rejects.toThrow("Every staged batch member");
    expect(await db.select().from(paymentIntakes).where(eq(paymentIntakes.tenantId, f.ctx.tenantId))).toHaveLength(1);
    expect(await db.select().from(transactions).where(eq(transactions.tenantId, f.ctx.tenantId))).toHaveLength(0);
    expect(await db.select().from(paymentBatchOperationReceipts).where(and(eq(paymentBatchOperationReceipts.tenantId, f.ctx.tenantId), eq(paymentBatchOperationReceipts.operationType, "staging.review")))).toHaveLength(1);
});

integration("restricted same-tenant actor cannot inspect or mutate another batch through staging or replay", async () => {
    const f = await fixture();
    const [other] = await db.insert(users).values({ tenantId: f.ctx.tenantId, email: `${crypto.randomUUID()}@example.test`, role: "viewer" }).returning();
    const stranger = { ...f.ctx, actorUserId: other!.id };
    await expect(stagePaymentBatchItems(stranger, f.input)).rejects.toThrow("not found");
    await expect(preparePaymentBatchStagingEvidence(stranger, f.evidenceInput, f.gateway)).rejects.toThrow("not found");
    await cancelPaymentBatch(f.ctx, f.staged.batchPublicId, { reason: "operator cancelled synthetic batch", revision: 1, idempotencyKey: "cancel-synthetic-batch" });
    expect(await db.query.paymentBatches.findFirst({ where: eq(paymentBatches.publicId, f.staged.batchPublicId) })).toMatchObject({ status: "cancelled" });
    await expect(stagePaymentBatchItems(f.ctx, { ...f.input, items: [{ clientItemKey: "new" }] })).rejects.toThrow();
    await expect(preparePaymentBatchStagingEvidence(f.ctx, f.evidenceInput, f.gateway)).rejects.toThrow();
});

integration("database refuses receipt replacement/deletion and finalized evidence replacement", async () => {
    const f = await fixture();
    const [receipt] = await db.select().from(paymentBatchOperationReceipts).where(eq(paymentBatchOperationReceipts.tenantId, f.ctx.tenantId));
    await expect(db.update(paymentBatchOperationReceipts).set({ result: { forged: true } }).where(eq(paymentBatchOperationReceipts.id, receipt!.id)).execute()).rejects.toThrow();
    await expect(db.delete(paymentBatchOperationReceipts).where(eq(paymentBatchOperationReceipts.id, receipt!.id)).execute()).rejects.toThrow();
    const prepared = await preparePaymentBatchStagingEvidence(f.ctx, f.evidenceInput, f.gateway);
    await finalizePaymentBatchStagingEvidence(f.ctx, f.evidenceInput.stagingItemPublicId, prepared.evidencePublicId, f.gateway);
    await expect(db.update(paymentBatchStagingEvidence).set({ status: "pending" }).where(eq(paymentBatchStagingEvidence.publicId, prepared.evidencePublicId)).execute()).rejects.toThrow();
    await expect(db.delete(paymentBatchStagingEvidence).where(eq(paymentBatchStagingEvidence.publicId, prepared.evidencePublicId)).execute()).rejects.toThrow();
});

integration("expired and mismatched storage metadata cannot finalize; one failed member does not finalize its sibling", async () => {
    const f = await fixture();
    await expect(preparePaymentBatchStagingEvidence(f.ctx, { ...f.evidenceInput, mimeType: "text/html" }, f.gateway)).rejects.toThrow();
    await expect(preparePaymentBatchStagingEvidence(f.ctx, { ...f.evidenceInput, size: 30 * 1024 * 1024 }, f.gateway)).rejects.toThrow();
    const prepared = await preparePaymentBatchStagingEvidence(f.ctx, f.evidenceInput, f.gateway);
    await expect(finalizePaymentBatchStagingEvidence(f.ctx, f.evidenceInput.stagingItemPublicId, prepared.evidencePublicId, { ...f.gateway, head: async () => ({ exists: true, contentType: "image/png", contentLength: 32, checksumSha256: "b".repeat(64), metadata: { tenant: f.ctx.tenantId, staging: f.evidenceInput.stagingItemPublicId } }) })).rejects.toThrow();
    await db.update(paymentBatchStagingEvidence).set({ uploadExpiresAt: new Date(0) }).where(eq(paymentBatchStagingEvidence.publicId, prepared.evidencePublicId));
    await expect(finalizePaymentBatchStagingEvidence(f.ctx, f.evidenceInput.stagingItemPublicId, prepared.evidencePublicId, f.gateway)).rejects.toThrow("expired");
    const secondInput = { ...f.evidenceInput, stagingItemPublicId: f.staged.items[1]!.publicId, sha256: "c".repeat(64) };
    const second = await preparePaymentBatchStagingEvidence(f.ctx, secondInput, f.gateway);
    await finalizePaymentBatchStagingEvidence(f.ctx, secondInput.stagingItemPublicId, second.evidencePublicId, f.gateway);
    expect(await db.query.paymentBatchStagingEvidence.findFirst({ where: eq(paymentBatchStagingEvidence.publicId, prepared.evidencePublicId) })).toMatchObject({ status: "pending" });
    expect(await db.select().from(transactions).where(eq(transactions.tenantId, f.ctx.tenantId))).toHaveLength(0);
});
