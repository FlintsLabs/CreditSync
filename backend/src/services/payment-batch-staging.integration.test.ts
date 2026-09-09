import { expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { borrowers, loans, loanSchedules, paymentBatches, paymentBatchDependencies, paymentBatchItems, paymentBatchOperationReceipts, paymentBatchStagingEvidence, paymentBatchStagingItems, paymentIntakes, paymentMatchProposals, transactions, users } from "../db/schema";
import type { CommandContext } from "./command-context";
import type { EvidenceStorageGateway } from "./payment-service";
import { assertNoOlderPendingPayment } from "./payment-chronology-service";
import { createPaymentIntake, postPayment, previewPaymentMatch } from "./payment-service";
import { stagePaymentBatchItems, preparePaymentBatchStagingEvidence, finalizePaymentBatchStagingEvidence, reviewPaymentBatchStagingItem, previewPaymentBatch, executePaymentBatch, cancelPaymentBatch, capturePaymentBatch, getPaymentBatchWorkspace, editPaymentBatchStagingItem, splitPaymentBatch } from "./payment-batch-service";

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

integration("a draft staging edit is revision-bound, idempotent, and invalidates previews without financial writes", async () => {
    const f = await fixture();
    const item = f.staged.items[0]!;
    const edited = await editPaymentBatchStagingItem(f.ctx, {
        stagingItemPublicId: item.publicId,
        expectedRevision: 1,
        idempotencyKey: "edit-a",
        reason: "synthetic reviewed correction",
        amount: "120.00",
        receivedAt: "2026-09-07T10:00:00+07:00",
    });
    expect(edited.status).toBe("staged");
    expect(edited.revision).toBe(2);
    expect(await editPaymentBatchStagingItem({ ...f.ctx, correlationId: crypto.randomUUID() }, {
        stagingItemPublicId: item.publicId, expectedRevision: 1, idempotencyKey: "edit-a", reason: "synthetic reviewed correction", amount: "120.00", receivedAt: "2026-09-07T10:00:00+07:00",
    })).toEqual(edited);
    await expect(editPaymentBatchStagingItem(f.ctx, { stagingItemPublicId: item.publicId, expectedRevision: 1, idempotencyKey: "edit-b", reason: "stale", amount: "121.00", receivedAt: "2026-09-07T10:00:00+07:00" })).rejects.toThrow("revision");
    expect(await db.select().from(transactions).where(eq(transactions.tenantId, f.ctx.tenantId))).toHaveLength(0);
});

integration("split moves selected unresolved staging members atomically with provenance and no duplicated intake or evidence", async () => {
    const f = await fixture();
    const selected = f.staged.items[0]!;
    const result = await splitPaymentBatch(f.ctx, f.staged.batchPublicId, {
        selectedItemPublicIds: [selected.publicId], expectedSourceRevision: 1, idempotencyKey: "split-a", reason: "synthetic chronology hold",
    });
    expect(result.movedItemPublicIds).toEqual([selected.publicId]);
    expect(result.sourceBatchPublicId).toBe(f.staged.batchPublicId);
    expect(result.destinationBatchPublicId).not.toBe(f.staged.batchPublicId);
    expect(await db.query.paymentBatchDependencies.findFirst({ where: eq(paymentBatchDependencies.publicId, result.dependencyPublicId) })).toMatchObject({ relation: "split", reason: "synthetic chronology hold" });
    expect((await getPaymentBatchWorkspace(f.ctx, f.staged.batchPublicId)).items.map((x) => x.publicId)).toEqual([f.staged.items[1]!.publicId]);
    expect((await getPaymentBatchWorkspace(f.ctx, result.destinationBatchPublicId)).items.map((x) => x.publicId)).toEqual([selected.publicId]);
    expect(await db.select().from(paymentIntakes).where(eq(paymentIntakes.tenantId, f.ctx.tenantId))).toHaveLength(0);
    expect(await db.select().from(transactions).where(eq(transactions.tenantId, f.ctx.tenantId))).toHaveLength(0);
    const replay = await splitPaymentBatch({ ...f.ctx, correlationId: crypto.randomUUID() }, f.staged.batchPublicId, { selectedItemPublicIds: [selected.publicId], expectedSourceRevision: 1, idempotencyKey: "split-a", reason: "synthetic chronology hold" });
    expect(replay).toEqual(result);
});

integration("split by a reviewed batch-item public id carries its linked staging provenance", async () => {
    const f = await fixture();
    const evidence = await preparePaymentBatchStagingEvidence(f.ctx, f.evidenceInput, f.gateway);
    await finalizePaymentBatchStagingEvidence(f.ctx, f.evidenceInput.stagingItemPublicId, evidence.evidencePublicId, f.gateway);
    const reviewed = await reviewPaymentBatchStagingItem(f.ctx, { stagingItemPublicId: f.evidenceInput.stagingItemPublicId, amount: "120.00", receivedAt: "2026-09-07T10:00:00+07:00", intakeIdempotencyKey: "review-for-split" });
    const result = await splitPaymentBatch(f.ctx, f.staged.batchPublicId, { selectedItemPublicIds: [reviewed.batchItemPublicId as string], expectedSourceRevision: 2, idempotencyKey: "split-reviewed-item", reason: "synthetic reviewed split" });
    expect((await getPaymentBatchWorkspace(f.ctx, result.destinationBatchPublicId)).items[0]).toMatchObject({ publicId: f.evidenceInput.stagingItemPublicId, paymentIntakePublicId: reviewed.paymentIntakePublicId, evidence: { status: "ready" } });
    expect((await getPaymentBatchWorkspace(f.ctx, f.staged.batchPublicId)).items.map((item) => item.publicId)).toEqual([f.staged.items[1]!.publicId]);
    expect(await db.select().from(paymentBatchItems).where(eq(paymentBatchItems.tenantId, f.ctx.tenantId))).toHaveLength(1);
});

integration("split reloads source revision after a queued lock and cannot pass with stale state", async () => {
    const f = await fixture();
    const source = await db.query.paymentBatches.findFirst({ where: eq(paymentBatches.publicId, f.staged.batchPublicId) });
    let queued: Promise<unknown> | undefined;
    await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT id FROM payment_batches WHERE tenant_id = ${f.ctx.tenantId} AND id = ${source!.id} FOR UPDATE`);
        queued = splitPaymentBatch(f.ctx, f.staged.batchPublicId, { selectedItemPublicIds: [f.staged.items[0]!.publicId], expectedSourceRevision: 1, idempotencyKey: "queued-split", reason: "synthetic queued split" });
        await new Promise((resolve) => setTimeout(resolve, 20));
        await tx.update(paymentBatches).set({ version: 2 }).where(eq(paymentBatches.id, source!.id));
    });
    await expect(queued!).rejects.toThrow("revision");
});

integration("review keeps per-item borrowers in a multi-borrower staging batch", async () => {
    const f = await fixture();
    const [secondBorrower] = await db.insert(borrowers).values({ tenantId: f.ctx.tenantId, ownerUserId: f.ctx.actorUserId, name: "Synthetic second staging borrower" }).returning();
    const first = f.staged.items[0]!;
    const second = f.staged.items[1]!;
    for (const item of [first, second]) {
        const evidenceInput = { ...f.evidenceInput, stagingItemPublicId: item.publicId, sha256: item.publicId === first.publicId ? "d".repeat(64) : "e".repeat(64) };
        const prepared = await preparePaymentBatchStagingEvidence(f.ctx, evidenceInput, f.gateway);
        await finalizePaymentBatchStagingEvidence(f.ctx, item.publicId, prepared.evidencePublicId, f.gateway);
    }
    await editPaymentBatchStagingItem(f.ctx, {
        stagingItemPublicId: first.publicId,
        expectedRevision: 1,
        idempotencyKey: "map-second-borrower",
        reason: "synthetic multi-borrower mapping",
        mapping: { borrowerPublicId: secondBorrower!.publicId },
    });
    const reviewedFirst = await reviewPaymentBatchStagingItem(f.ctx, { stagingItemPublicId: first.publicId, amount: "120.00", receivedAt: "2026-09-07T10:00:00+07:00", intakeIdempotencyKey: "review-second-borrower" });
    const reviewedSecond = await reviewPaymentBatchStagingItem(f.ctx, { stagingItemPublicId: second.publicId, amount: "120.00", receivedAt: "2026-09-08T10:00:00+07:00", intakeIdempotencyKey: "review-first-borrower" });
    expect(reviewedFirst.paymentIntakePublicId).toBeString();
    expect(reviewedSecond.paymentIntakePublicId).toBeString();
});

integration("review rejects a mapping expanded while its preliminary borrower lock is queued", async () => {
    const f = await fixture();
    const [secondBorrower] = await db.insert(borrowers).values({ tenantId: f.ctx.tenantId, ownerUserId: f.ctx.actorUserId, name: "Synthetic queued review borrower" }).returning();
    const item = f.staged.items[0]!;
    const evidence = await preparePaymentBatchStagingEvidence(f.ctx, f.evidenceInput, f.gateway);
    await finalizePaymentBatchStagingEvidence(f.ctx, item.publicId, evidence.evidencePublicId, f.gateway);
    await editPaymentBatchStagingItem(f.ctx, { stagingItemPublicId: item.publicId, expectedRevision: 1, idempotencyKey: "queued-review-old", reason: "synthetic old mapping", mapping: { borrowerPublicId: f.input.borrowerPublicId! } });
    const staging = await db.query.paymentBatchStagingItems.findFirst({ where: eq(paymentBatchStagingItems.publicId, item.publicId) });
    const batch = await db.query.paymentBatches.findFirst({ where: eq(paymentBatches.publicId, f.staged.batchPublicId) });
    let queued: Promise<unknown> | undefined;
    await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT id FROM borrowers WHERE tenant_id = ${f.ctx.tenantId} AND id = ${(await db.query.borrowers.findFirst({ where: eq(borrowers.publicId, f.input.borrowerPublicId!) }))!.id} FOR UPDATE`);
        queued = reviewPaymentBatchStagingItem(f.ctx, { stagingItemPublicId: item.publicId, amount: "120.00", receivedAt: "2026-09-07T10:00:00+07:00", intakeIdempotencyKey: "queued-review-current" });
        await new Promise((resolve) => setTimeout(resolve, 20));
        await tx.update(paymentBatchStagingItems).set({ reviewedMapping: { borrowerPublicId: secondBorrower!.publicId } }).where(eq(paymentBatchStagingItems.id, staging!.id));
        await tx.update(paymentBatches).set({ version: batch!.version + 1 }).where(eq(paymentBatches.id, batch!.id));
    });
    await expect(queued!).rejects.toThrow("changed while review");
    expect(await db.select().from(paymentIntakes).where(eq(paymentIntakes.tenantId, f.ctx.tenantId))).toHaveLength(0);
});

integration("mapping edits require portfolio access and feed review into the preview mapping", async () => {
    const f = await fixture();
    const loan = await db.insert(loans).values({ tenantId: f.ctx.tenantId, ownerUserId: f.ctx.actorUserId!, borrowerId: (await db.query.borrowers.findFirst({ where: eq(borrowers.publicId, f.input.borrowerPublicId!) }))!.id, principalAmount: "240.00", interestRate: "0.00", repaymentType: "monthly", outstandingPrincipal: "240.00", outstandingInterest: "0.00", outstandingFees: "0.00", status: "active" }).returning().then((rows) => rows[0]!);
    const schedule = await db.insert(loanSchedules).values({ tenantId: f.ctx.tenantId, loanId: loan.id, installmentNo: 1, dueDate: "2026-09-07", scheduledPrincipal: "240.00", scheduledInterest: "0.00", scheduledFee: "0.00", scheduledTotal: "240.00", paidTotal: "0.00", paidPenalty: "0.00", remainingDue: "240.00", status: "pending" }).returning().then((rows) => rows[0]!);
    const [viewer] = await db.insert(users).values({ tenantId: f.ctx.tenantId, email: `${crypto.randomUUID()}@example.test`, role: "viewer" }).returning();
    await expect(editPaymentBatchStagingItem({ ...f.ctx, actorUserId: viewer!.id }, { stagingItemPublicId: f.staged.items[0]!.publicId, expectedRevision: 1, idempotencyKey: "unauthorized-loan-map", reason: "synthetic", mapping: { loanPublicId: loan.publicId } })).rejects.toThrow();
    const evidence = await preparePaymentBatchStagingEvidence(f.ctx, f.evidenceInput, f.gateway);
    await finalizePaymentBatchStagingEvidence(f.ctx, f.evidenceInput.stagingItemPublicId, evidence.evidencePublicId, f.gateway);
    await editPaymentBatchStagingItem(f.ctx, { stagingItemPublicId: f.staged.items[0]!.publicId, expectedRevision: 1, idempotencyKey: "map-a", reason: "synthetic mapping", amount: "120.00", receivedAt: "2026-09-07T10:00:00+07:00", mapping: { borrowerPublicId: f.input.borrowerPublicId!, loanPublicId: loan.publicId, schedulePublicId: schedule.publicId } });
    const mappedReview = await reviewPaymentBatchStagingItem(f.ctx, { stagingItemPublicId: f.evidenceInput.stagingItemPublicId, amount: "120.00", receivedAt: "2026-09-07T10:00:00+07:00", intakeIdempotencyKey: "review-mapped" });
    const matchPreview = await previewPaymentMatch(f.ctx, mappedReview.paymentIntakePublicId as string, { allocations: [{ borrowerPublicId: f.input.borrowerPublicId!, loanPublicId: loan.publicId, amount: "120.00" }] });
    const mappedRevision = (await db.query.paymentBatchStagingItems.findFirst({ where: eq(paymentBatchStagingItems.publicId, f.evidenceInput.stagingItemPublicId) }))!.revision;
    await editPaymentBatchStagingItem(f.ctx, { stagingItemPublicId: f.evidenceInput.stagingItemPublicId, expectedRevision: mappedRevision, idempotencyKey: "stale-match-after-edit", reason: "synthetic amount correction", amount: "121.00" });
    expect(await db.query.paymentMatchProposals.findFirst({ where: eq(paymentMatchProposals.publicId, matchPreview.publicId) })).toMatchObject({ status: "stale" });
    const correctedRevision = (await db.query.paymentBatchStagingItems.findFirst({ where: eq(paymentBatchStagingItems.publicId, f.evidenceInput.stagingItemPublicId) }))!.revision;
    await editPaymentBatchStagingItem(f.ctx, { stagingItemPublicId: f.evidenceInput.stagingItemPublicId, expectedRevision: correctedRevision, idempotencyKey: "restore-mapped-amount", reason: "synthetic correction", amount: "120.00" });
    const secondEvidence = await preparePaymentBatchStagingEvidence(f.ctx, { ...f.evidenceInput, stagingItemPublicId: f.staged.items[1]!.publicId, sha256: "b".repeat(64) }, f.gateway);
    await finalizePaymentBatchStagingEvidence(f.ctx, f.staged.items[1]!.publicId, secondEvidence.evidencePublicId, f.gateway);
    await reviewPaymentBatchStagingItem(f.ctx, { stagingItemPublicId: f.staged.items[1]!.publicId, amount: "120.00", receivedAt: "2026-09-07T11:00:00+07:00", intakeIdempotencyKey: "review-unmapped-b" });
    await expect(previewPaymentBatch(f.ctx, f.staged.batchPublicId, { borrowerPublicId: f.input.borrowerPublicId! })).rejects.toThrow("complete mapping");
    await editPaymentBatchStagingItem(f.ctx, { stagingItemPublicId: f.staged.items[1]!.publicId, expectedRevision: 2, idempotencyKey: "map-b", reason: "synthetic mapping", mapping: { borrowerPublicId: f.input.borrowerPublicId!, loanPublicId: loan.publicId, schedulePublicId: schedule.publicId } });
    await expect(previewPaymentBatch(f.ctx, f.staged.batchPublicId, { borrowerPublicId: f.input.borrowerPublicId! })).resolves.toMatchObject({ status: "ready" });
});

integration("known mapped staging without an intake blocks a later payment for the same borrower", async () => {
    const f = await fixture();
    await editPaymentBatchStagingItem(f.ctx, { stagingItemPublicId: f.staged.items[0]!.publicId, expectedRevision: 1, idempotencyKey: "staged-known", reason: "synthetic known staged transfer", receivedAt: "2026-09-07T10:00:00+07:00", mapping: { borrowerPublicId: f.input.borrowerPublicId! } });
    const borrower = await db.query.borrowers.findFirst({ where: eq(borrowers.publicId, f.input.borrowerPublicId!) });
    await expect(assertNoOlderPendingPayment(db, f.ctx.tenantId, borrower!.id, new Date("2026-09-08T10:00:00+07:00"), [])).rejects.toThrow("older pending");
});

integration("mapping null is a distinct clear mutation from an omitted mapping", async () => {
    const f = await fixture();
    await editPaymentBatchStagingItem(f.ctx, { stagingItemPublicId: f.staged.items[0]!.publicId, expectedRevision: 1, idempotencyKey: "mapping-omitted", reason: "synthetic", mapping: undefined });
    await expect(editPaymentBatchStagingItem(f.ctx, { stagingItemPublicId: f.staged.items[0]!.publicId, expectedRevision: 1, idempotencyKey: "mapping-omitted", reason: "synthetic", mapping: null })).rejects.toThrow("different");
    await editPaymentBatchStagingItem(f.ctx, { stagingItemPublicId: f.staged.items[0]!.publicId, expectedRevision: 2, idempotencyKey: "mapping-clear", reason: "synthetic clear", mapping: null });
    expect((await db.query.paymentBatchStagingItems.findFirst({ where: eq(paymentBatchStagingItems.publicId, f.staged.items[0]!.publicId) }))?.reviewedMapping).toBeNull();
});

integration("borrower-only staging mappings reject an explicit allocation to another borrower", async () => {
    const f = await fixture();
    const [secondBorrower] = await db.insert(borrowers).values({ tenantId: f.ctx.tenantId, ownerUserId: f.ctx.actorUserId, name: "Synthetic constraint borrower" }).returning();
    const [firstLoan] = await db.insert(loans).values({ tenantId: f.ctx.tenantId, ownerUserId: f.ctx.actorUserId!, borrowerId: (await db.query.borrowers.findFirst({ where: eq(borrowers.publicId, f.input.borrowerPublicId!) }))!.id, principalAmount: "120.00", interestRate: "0.00", repaymentType: "monthly", outstandingPrincipal: "120.00", outstandingInterest: "0.00", outstandingFees: "0.00", status: "active" }).returning();
    const [secondLoan] = await db.insert(loans).values({ tenantId: f.ctx.tenantId, ownerUserId: f.ctx.actorUserId!, borrowerId: secondBorrower!.id, principalAmount: "120.00", interestRate: "0.00", repaymentType: "monthly", outstandingPrincipal: "120.00", outstandingInterest: "0.00", outstandingFees: "0.00", status: "active" }).returning();
    const [firstSchedule] = await db.insert(loanSchedules).values({ tenantId: f.ctx.tenantId, loanId: firstLoan!.id, installmentNo: 1, dueDate: "2026-09-07", scheduledPrincipal: "120.00", scheduledInterest: "0.00", scheduledFee: "0.00", scheduledTotal: "120.00", paidTotal: "0.00", paidPenalty: "0.00", remainingDue: "120.00", status: "pending" }).returning();
    const [secondSchedule] = await db.insert(loanSchedules).values({ tenantId: f.ctx.tenantId, loanId: secondLoan!.id, installmentNo: 1, dueDate: "2026-09-08", scheduledPrincipal: "120.00", scheduledInterest: "0.00", scheduledFee: "0.00", scheduledTotal: "120.00", paidTotal: "0.00", paidPenalty: "0.00", remainingDue: "120.00", status: "pending" }).returning();
    for (const item of f.staged.items) {
        const evidence = await preparePaymentBatchStagingEvidence(f.ctx, { ...f.evidenceInput, stagingItemPublicId: item.publicId, sha256: item.publicId === f.staged.items[0]!.publicId ? "f".repeat(64) : "0".repeat(64) }, f.gateway);
        await finalizePaymentBatchStagingEvidence(f.ctx, item.publicId, evidence.evidencePublicId, f.gateway);
    }
    await editPaymentBatchStagingItem(f.ctx, { stagingItemPublicId: f.staged.items[0]!.publicId, expectedRevision: 1, idempotencyKey: "borrower-only-first", reason: "synthetic borrower constraint", mapping: { borrowerPublicId: f.input.borrowerPublicId! } });
    await editPaymentBatchStagingItem(f.ctx, { stagingItemPublicId: f.staged.items[1]!.publicId, expectedRevision: 1, idempotencyKey: "borrower-only-second", reason: "synthetic borrower constraint", mapping: { borrowerPublicId: secondBorrower!.publicId } });
    const reviewedFirst = await reviewPaymentBatchStagingItem(f.ctx, { stagingItemPublicId: f.staged.items[0]!.publicId, amount: "120.00", receivedAt: "2026-09-07T10:00:00+07:00", intakeIdempotencyKey: "review-borrower-only-first" });
    const reviewedSecond = await reviewPaymentBatchStagingItem(f.ctx, { stagingItemPublicId: f.staged.items[1]!.publicId, amount: "120.00", receivedAt: "2026-09-08T10:00:00+07:00", intakeIdempotencyKey: "review-borrower-only-second" });
    await expect(previewPaymentBatch(f.ctx, f.staged.batchPublicId, {
        borrowerPublicId: f.input.borrowerPublicId!,
        allocations: [
            { itemPublicId: reviewedFirst.batchItemPublicId as string, borrowerPublicId: secondBorrower!.publicId, loanPublicId: secondLoan!.publicId, schedulePublicId: secondSchedule!.publicId, amount: "120.00", targetDueDate: "2026-09-08", intent: "on_time" },
            { itemPublicId: reviewedSecond.batchItemPublicId as string, borrowerPublicId: f.input.borrowerPublicId!, loanPublicId: firstLoan!.publicId, schedulePublicId: firstSchedule!.publicId, amount: "120.00", targetDueDate: "2026-09-07", intent: "on_time" },
        ],
    })).rejects.toThrow("mapping");
    expect(await db.select().from(transactions).where(eq(transactions.tenantId, f.ctx.tenantId))).toHaveLength(0);
    const validPreview = await previewPaymentBatch(f.ctx, f.staged.batchPublicId, {
        borrowerPublicId: f.input.borrowerPublicId!,
        allocations: [
            { itemPublicId: reviewedFirst.batchItemPublicId as string, borrowerPublicId: f.input.borrowerPublicId!, loanPublicId: firstLoan!.publicId, schedulePublicId: firstSchedule!.publicId, amount: "120.00", targetDueDate: "2026-09-07", intent: "on_time" },
            { itemPublicId: reviewedSecond.batchItemPublicId as string, borrowerPublicId: secondBorrower!.publicId, loanPublicId: secondLoan!.publicId, schedulePublicId: secondSchedule!.publicId, amount: "120.00", targetDueDate: "2026-09-08", intent: "on_time" },
        ],
    });
    expect(validPreview.status).toBe("ready");
    await executePaymentBatch(f.ctx, f.staged.batchPublicId, { previewPublicId: validPreview.publicId, previewHash: validPreview.previewHash, confirmationHash: validPreview.confirmationHash, confirmed: true, idempotencyKey: "execute-borrower-constraints" });
    expect(await db.select().from(transactions).where(eq(transactions.tenantId, f.ctx.tenantId))).toHaveLength(2);
});

integration("batch preview holds a unique amount sum spanning multiple contracts for human selection", async () => {
    const f = await fixture();
    const borrower = await db.query.borrowers.findFirst({ where: eq(borrowers.publicId, f.input.borrowerPublicId!) });
    const [firstLoan, secondLoan] = await db.insert(loans).values([
        { tenantId: f.ctx.tenantId, ownerUserId: f.ctx.actorUserId!, borrowerId: borrower!.id, principalAmount: "75.00", interestRate: "0.00", repaymentType: "monthly", outstandingPrincipal: "75.00", outstandingInterest: "0.00", outstandingFees: "0.00", status: "active" },
        { tenantId: f.ctx.tenantId, ownerUserId: f.ctx.actorUserId!, borrowerId: borrower!.id, principalAmount: "45.00", interestRate: "0.00", repaymentType: "monthly", outstandingPrincipal: "45.00", outstandingInterest: "0.00", outstandingFees: "0.00", status: "active" },
    ]).returning();
    await db.insert(loanSchedules).values([
        { tenantId: f.ctx.tenantId, loanId: firstLoan!.id, installmentNo: 1, dueDate: "2026-09-07", scheduledPrincipal: "75.00", scheduledInterest: "0.00", scheduledFee: "0.00", scheduledTotal: "75.00", paidTotal: "0.00", paidPenalty: "0.00", remainingDue: "75.00", status: "pending" },
        { tenantId: f.ctx.tenantId, loanId: secondLoan!.id, installmentNo: 1, dueDate: "2026-09-08", scheduledPrincipal: "45.00", scheduledInterest: "0.00", scheduledFee: "0.00", scheduledTotal: "45.00", paidTotal: "0.00", paidPenalty: "0.00", remainingDue: "45.00", status: "pending" },
    ]);
    const captured = await capturePaymentBatch(f.ctx, { idempotencyKey: "unique-sum-capture", borrowerPublicId: f.input.borrowerPublicId!, items: [{ clientItemKey: "unique-sum", intakeIdempotencyKey: "unique-sum-intake", amount: "120.00", receivedAt: "2026-09-09T03:00:00Z" }] });
    const preview = await previewPaymentBatch(f.ctx, captured.publicId, { borrowerPublicId: f.input.borrowerPublicId! });
    expect(preview.status).toBe("needs_review");
});

integration("never-mapped reviewed items retain the captured batch borrower chronology", async () => {
    const f = await fixture();
    const [secondary] = await db.insert(borrowers).values({ tenantId: f.ctx.tenantId, ownerUserId: f.ctx.actorUserId, name: "Synthetic remapped chronology borrower" }).returning();
    const item = f.staged.items[0]!;
    const evidence = await preparePaymentBatchStagingEvidence(f.ctx, f.evidenceInput, f.gateway);
    await finalizePaymentBatchStagingEvidence(f.ctx, item.publicId, evidence.evidencePublicId, f.gateway);
    await editPaymentBatchStagingItem(f.ctx, { stagingItemPublicId: item.publicId, expectedRevision: 1, idempotencyKey: "public-remap-secondary", reason: "synthetic remap", mapping: { borrowerPublicId: secondary!.publicId } });
    await reviewPaymentBatchStagingItem(f.ctx, { stagingItemPublicId: item.publicId, amount: "120.00", receivedAt: "2026-09-07T10:00:00+07:00", intakeIdempotencyKey: "public-remap-review" });
    const laterA = await capturePaymentBatch(f.ctx, { idempotencyKey: "later-header-borrower", borrowerPublicId: f.input.borrowerPublicId!, items: [{ clientItemKey: "later-a", intakeIdempotencyKey: "later-a-intake", amount: "1.00", receivedAt: "2026-09-08T10:00:00+07:00" }] });
    await expect(previewPaymentBatch(f.ctx, laterA.publicId, { borrowerPublicId: f.input.borrowerPublicId! })).resolves.toMatchObject({ status: "needs_review" });
    const laterB = await capturePaymentBatch(f.ctx, { idempotencyKey: "later-secondary-borrower", borrowerPublicId: secondary!.publicId, items: [{ clientItemKey: "later-b", intakeIdempotencyKey: "later-b-intake", amount: "1.00", receivedAt: "2026-09-08T10:00:00+07:00" }] });
    await expect(previewPaymentBatch(f.ctx, laterB.publicId, { borrowerPublicId: secondary!.publicId })).rejects.toThrow("chronology");
});

integration("public remapping after a batch preview replaces the prior borrower authority", async () => {
    const f = await fixture();
    const header = await db.query.borrowers.findFirst({ where: eq(borrowers.publicId, f.input.borrowerPublicId!) });
    const [secondary] = await db.insert(borrowers).values({ tenantId: f.ctx.tenantId, ownerUserId: f.ctx.actorUserId, name: "Synthetic post-preview remap borrower" }).returning();
    const [loan] = await db.insert(loans).values({ tenantId: f.ctx.tenantId, ownerUserId: f.ctx.actorUserId!, borrowerId: header!.id, principalAmount: "121.00", interestRate: "0.00", repaymentType: "monthly", outstandingPrincipal: "121.00", outstandingInterest: "0.00", outstandingFees: "0.00", status: "active" }).returning();
    const schedules = await db.insert(loanSchedules).values([
        { tenantId: f.ctx.tenantId, loanId: loan!.id, installmentNo: 1, dueDate: "2026-09-07", scheduledPrincipal: "120.00", scheduledInterest: "0.00", scheduledFee: "0.00", scheduledTotal: "120.00", paidTotal: "0.00", paidPenalty: "0.00", remainingDue: "120.00", status: "pending" },
        { tenantId: f.ctx.tenantId, loanId: loan!.id, installmentNo: 2, dueDate: "2026-09-07", scheduledPrincipal: "1.00", scheduledInterest: "0.00", scheduledFee: "0.00", scheduledTotal: "1.00", paidTotal: "0.00", paidPenalty: "0.00", remainingDue: "1.00", status: "pending" },
    ]).returning();
    for (const [index, item] of f.staged.items.entries()) {
        const evidence = await preparePaymentBatchStagingEvidence(f.ctx, { ...f.evidenceInput, stagingItemPublicId: item.publicId, sha256: `${index}`.repeat(64) }, f.gateway);
        await finalizePaymentBatchStagingEvidence(f.ctx, item.publicId, evidence.evidencePublicId, f.gateway);
    }
    await editPaymentBatchStagingItem(f.ctx, { stagingItemPublicId: f.staged.items[0]!.publicId, expectedRevision: 1, idempotencyKey: "post-preview-map-a", reason: "synthetic initial mapping", mapping: { borrowerPublicId: header!.publicId, loanPublicId: loan!.publicId, schedulePublicId: schedules[0]!.publicId } });
    const first = await reviewPaymentBatchStagingItem(f.ctx, { stagingItemPublicId: f.staged.items[0]!.publicId, amount: "120.00", receivedAt: "2026-09-07T10:00:00+07:00", intakeIdempotencyKey: "post-preview-review-a" });
    const second = await reviewPaymentBatchStagingItem(f.ctx, { stagingItemPublicId: f.staged.items[1]!.publicId, amount: "1.00", receivedAt: "2026-09-07T10:01:00+07:00", intakeIdempotencyKey: "post-preview-review-b" });
    const sourcePreview = await previewPaymentBatch(f.ctx, f.staged.batchPublicId, { borrowerPublicId: header!.publicId, allocations: [
        { itemPublicId: first.batchItemPublicId as string, borrowerPublicId: header!.publicId, loanPublicId: loan!.publicId, schedulePublicId: schedules[0]!.publicId, amount: "120.00", targetDueDate: "2026-09-07", intent: "on_time" },
        { itemPublicId: second.batchItemPublicId as string, borrowerPublicId: header!.publicId, loanPublicId: loan!.publicId, schedulePublicId: schedules[1]!.publicId, amount: "1.00", targetDueDate: "2026-09-07", intent: "on_time" },
    ] });
    expect(sourcePreview.status).toBe("ready");
    const firstRevisionAfterPreview = (await db.query.paymentBatchStagingItems.findFirst({ where: eq(paymentBatchStagingItems.publicId, f.staged.items[0]!.publicId) }))!.revision;
    await editPaymentBatchStagingItem(f.ctx, { stagingItemPublicId: f.staged.items[0]!.publicId, expectedRevision: firstRevisionAfterPreview, idempotencyKey: "post-preview-clear-first", reason: "synthetic clear after preview", mapping: null });
    const secondRevisionAfterPreview = (await db.query.paymentBatchStagingItems.findFirst({ where: eq(paymentBatchStagingItems.publicId, f.staged.items[1]!.publicId) }))!.revision;
    await editPaymentBatchStagingItem(f.ctx, { stagingItemPublicId: f.staged.items[1]!.publicId, expectedRevision: secondRevisionAfterPreview, idempotencyKey: "post-preview-clear-second", reason: "synthetic clear after preview", mapping: null });
    expect(await db.query.paymentBatches.findFirst({ where: eq(paymentBatches.publicId, f.staged.batchPublicId) })).toMatchObject({ status: "needs_review" });
    await expect(previewPaymentBatch(f.ctx, f.staged.batchPublicId, { borrowerPublicId: header!.publicId })).rejects.toThrow("Cleared resolution");
    await expect(executePaymentBatch(f.ctx, f.staged.batchPublicId, { previewPublicId: sourcePreview.publicId, previewHash: sourcePreview.previewHash, confirmationHash: sourcePreview.confirmationHash, confirmed: true, idempotencyKey: "post-preview-clear-old-execute" })).rejects.toThrow("preview");
    expect(await db.select().from(transactions).where(eq(transactions.tenantId, f.ctx.tenantId))).toHaveLength(0);
    const laterAfterClear = await capturePaymentBatch(f.ctx, { idempotencyKey: "post-preview-clear-later", borrowerPublicId: header!.publicId, items: [{ clientItemKey: "later-clear", intakeIdempotencyKey: "post-preview-clear-later-intake", amount: "1.00", receivedAt: "2026-09-08T09:00:00+07:00" }] });
    await expect(previewPaymentBatch(f.ctx, laterAfterClear.publicId, { borrowerPublicId: header!.publicId })).resolves.toMatchObject({ status: "ready" });
    const laterAfterClearRevision = (await db.query.paymentBatches.findFirst({ where: eq(paymentBatches.publicId, laterAfterClear.publicId) }))!.version;
    await cancelPaymentBatch(f.ctx, laterAfterClear.publicId, { reason: "synthetic clear dependency cleanup", revision: laterAfterClearRevision, idempotencyKey: "post-preview-clear-cancel" });
    const reselected = await previewPaymentBatch(f.ctx, f.staged.batchPublicId, { borrowerPublicId: header!.publicId, allocations: [
        { itemPublicId: first.batchItemPublicId as string, borrowerPublicId: header!.publicId, loanPublicId: loan!.publicId, schedulePublicId: schedules[0]!.publicId, amount: "120.00", targetDueDate: "2026-09-07", intent: "on_time" },
        { itemPublicId: second.batchItemPublicId as string, borrowerPublicId: header!.publicId, loanPublicId: loan!.publicId, schedulePublicId: schedules[1]!.publicId, amount: "1.00", targetDueDate: "2026-09-07", intent: "on_time" },
    ] });
    expect(reselected.status).toBe("ready");
    const laterAfterReselect = await capturePaymentBatch(f.ctx, { idempotencyKey: "post-preview-reselect-later", borrowerPublicId: header!.publicId, items: [{ clientItemKey: "later-reselect", intakeIdempotencyKey: "post-preview-reselect-later-intake", amount: "1.00", receivedAt: "2026-09-08T09:30:00+07:00" }] });
    await expect(previewPaymentBatch(f.ctx, laterAfterReselect.publicId, { borrowerPublicId: header!.publicId })).rejects.toThrow("chronology");
    const laterAfterReselectRevision = (await db.query.paymentBatches.findFirst({ where: eq(paymentBatches.publicId, laterAfterReselect.publicId) }))!.version;
    await cancelPaymentBatch(f.ctx, laterAfterReselect.publicId, { reason: "synthetic reselect dependency cleanup", revision: laterAfterReselectRevision, idempotencyKey: "post-preview-reselect-cancel" });
    const firstRevisionAfterClear = (await db.query.paymentBatchStagingItems.findFirst({ where: eq(paymentBatchStagingItems.publicId, f.staged.items[0]!.publicId) }))!.revision;
    await editPaymentBatchStagingItem(f.ctx, { stagingItemPublicId: f.staged.items[0]!.publicId, expectedRevision: firstRevisionAfterClear, idempotencyKey: "post-preview-map-b", reason: "synthetic remap after preview", mapping: { borrowerPublicId: secondary!.publicId } });
    const secondRevisionAfterClear = (await db.query.paymentBatchStagingItems.findFirst({ where: eq(paymentBatchStagingItems.publicId, f.staged.items[1]!.publicId) }))!.revision;
    await editPaymentBatchStagingItem(f.ctx, { stagingItemPublicId: f.staged.items[1]!.publicId, expectedRevision: secondRevisionAfterClear, idempotencyKey: "post-preview-map-b-second", reason: "synthetic remap after preview", mapping: { borrowerPublicId: secondary!.publicId } });
    const laterA = await capturePaymentBatch(f.ctx, { idempotencyKey: "post-preview-later-a", borrowerPublicId: header!.publicId, items: [{ clientItemKey: "later-a", intakeIdempotencyKey: "post-preview-later-a-intake", amount: "1.00", receivedAt: "2026-09-08T10:00:00+07:00" }] });
    await expect(previewPaymentBatch(f.ctx, laterA.publicId, { borrowerPublicId: header!.publicId })).resolves.toMatchObject({ status: "ready" });
    const laterB = await capturePaymentBatch(f.ctx, { idempotencyKey: "post-preview-later-b", borrowerPublicId: secondary!.publicId, items: [{ clientItemKey: "later-b", intakeIdempotencyKey: "post-preview-later-b-intake", amount: "1.00", receivedAt: "2026-09-08T10:00:00+07:00" }] });
    await expect(previewPaymentBatch(f.ctx, laterB.publicId, { borrowerPublicId: secondary!.publicId })).rejects.toThrow("chronology");
});

integration("a current explicit batch preview resolves an unmapped reviewed intake for chronology", async () => {
    const f = await fixture();
    const [secondary] = await db.insert(borrowers).values({ tenantId: f.ctx.tenantId, ownerUserId: f.ctx.actorUserId, name: "Synthetic preview-resolved borrower" }).returning();
    const [loan, headerLoan] = await db.insert(loans).values([
        { tenantId: f.ctx.tenantId, ownerUserId: f.ctx.actorUserId!, borrowerId: secondary!.id, principalAmount: "120.00", interestRate: "0.00", repaymentType: "monthly", outstandingPrincipal: "120.00", outstandingInterest: "0.00", outstandingFees: "0.00", status: "active" },
        { tenantId: f.ctx.tenantId, ownerUserId: f.ctx.actorUserId!, borrowerId: (await db.query.borrowers.findFirst({ where: eq(borrowers.publicId, f.input.borrowerPublicId!) }))!.id, principalAmount: "1.00", interestRate: "0.00", repaymentType: "monthly", outstandingPrincipal: "1.00", outstandingInterest: "0.00", outstandingFees: "0.00", status: "active" },
    ]).returning();
    const [schedule] = await db.insert(loanSchedules).values({ tenantId: f.ctx.tenantId, loanId: loan!.id, installmentNo: 1, dueDate: "2026-09-07", scheduledPrincipal: "120.00", scheduledInterest: "0.00", scheduledFee: "0.00", scheduledTotal: "120.00", paidTotal: "0.00", paidPenalty: "0.00", remainingDue: "120.00", status: "pending" }).returning();
    const [headerSchedule] = await db.insert(loanSchedules).values({ tenantId: f.ctx.tenantId, loanId: headerLoan!.id, installmentNo: 1, dueDate: "2026-09-07", scheduledPrincipal: "1.00", scheduledInterest: "0.00", scheduledFee: "0.00", scheduledTotal: "1.00", paidTotal: "0.00", paidPenalty: "0.00", remainingDue: "1.00", status: "pending" }).returning();
    const evidence = await preparePaymentBatchStagingEvidence(f.ctx, f.evidenceInput, f.gateway);
    await finalizePaymentBatchStagingEvidence(f.ctx, f.evidenceInput.stagingItemPublicId, evidence.evidencePublicId, f.gateway);
    const reviewed = await reviewPaymentBatchStagingItem(f.ctx, { stagingItemPublicId: f.evidenceInput.stagingItemPublicId, amount: "120.00", receivedAt: "2026-09-07T10:00:00+07:00", intakeIdempotencyKey: "preview-resolved-review" });
    const secondItem = f.staged.items[1]!;
    const secondEvidence = await preparePaymentBatchStagingEvidence(f.ctx, { ...f.evidenceInput, stagingItemPublicId: secondItem.publicId, sha256: "b".repeat(64) }, f.gateway);
    await finalizePaymentBatchStagingEvidence(f.ctx, secondItem.publicId, secondEvidence.evidencePublicId, f.gateway);
    const reviewedHeader = await reviewPaymentBatchStagingItem(f.ctx, { stagingItemPublicId: secondItem.publicId, amount: "1.00", receivedAt: "2026-09-07T10:01:00+07:00", intakeIdempotencyKey: "preview-resolved-header-review" });
    const sourcePreview = await previewPaymentBatch(f.ctx, f.staged.batchPublicId, {
        borrowerPublicId: f.input.borrowerPublicId!,
        allocations: [
            { itemPublicId: reviewed.batchItemPublicId as string, borrowerPublicId: secondary!.publicId, loanPublicId: loan!.publicId, schedulePublicId: schedule!.publicId, amount: "120.00", targetDueDate: "2026-09-07", intent: "on_time" },
            { itemPublicId: reviewedHeader.batchItemPublicId as string, borrowerPublicId: f.input.borrowerPublicId!, loanPublicId: headerLoan!.publicId, schedulePublicId: headerSchedule!.publicId, amount: "1.00", targetDueDate: "2026-09-07", intent: "on_time" },
        ],
    });
    expect(sourcePreview.status).toBe("ready");
    const secondaryRow = await db.query.borrowers.findFirst({ where: eq(borrowers.publicId, secondary!.publicId) });
    const resolvedBatchAllocation = await db.execute(sql`SELECT a.id FROM payment_batch_allocations a JOIN payment_batch_items bi ON bi.tenant_id = a.tenant_id AND bi.id = a.item_id JOIN payment_batches b ON b.tenant_id = bi.tenant_id AND b.id = bi.batch_id JOIN payment_batch_previews p ON p.tenant_id = a.tenant_id AND p.id = a.preview_id WHERE bi.payment_intake_id = (SELECT bi2.payment_intake_id FROM payment_batch_items bi2 WHERE bi2.tenant_id = ${f.ctx.tenantId} AND bi2.public_id = ${reviewed.batchItemPublicId}) AND a.borrower_id = ${secondaryRow!.id} AND p.status = 'ready' AND p.id = (SELECT latest.id FROM payment_batch_previews latest WHERE latest.tenant_id = p.tenant_id AND latest.batch_id = p.batch_id ORDER BY latest.version DESC LIMIT 1)`);
    expect(resolvedBatchAllocation).toHaveLength(1);
    await expect(assertNoOlderPendingPayment(db, f.ctx.tenantId, secondaryRow!.id, new Date("2026-09-08T10:00:00+07:00"), [])).rejects.toThrow("chronology");
    const standalone = await createPaymentIntake(f.ctx, { originLoanPublicId: loan!.publicId, amount: "1.00", receivedAt: "2026-09-08T10:00:00+07:00" });
    const standaloneProposal = await previewPaymentMatch(f.ctx, standalone.publicId, { allocations: [{ borrowerPublicId: secondary!.publicId, loanPublicId: loan!.publicId, amount: "1.00" }] });
    await expect(postPayment(f.ctx, standalone.publicId, { proposalPublicId: standaloneProposal.publicId })).rejects.toThrow("chronology");
    expect(await db.select().from(transactions).where(eq(transactions.tenantId, f.ctx.tenantId))).toHaveLength(0);
    const later = await capturePaymentBatch(f.ctx, { idempotencyKey: "preview-resolved-later", borrowerPublicId: secondary!.publicId, items: [{ clientItemKey: "later", intakeIdempotencyKey: "preview-resolved-later-intake", amount: "1.00", receivedAt: "2026-09-08T10:00:00+07:00" }] });
    await expect(previewPaymentBatch(f.ctx, later.publicId, { borrowerPublicId: secondary!.publicId })).rejects.toThrow("chronology");
});
