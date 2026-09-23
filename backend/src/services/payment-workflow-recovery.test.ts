import { expect, test } from "bun:test";
import { and, eq, sql as drizzleSql } from "drizzle-orm";
import { db } from "../db";
import { paymentEvidenceRecoveryExecutions, paymentEvidenceRecoveryPreviews, paymentIdentityDecisions, paymentIdentityDecisionPreviews, paymentIntakes, users } from "../db/schema";
import type { CommandContext } from "./command-context";
import { executePaymentEvidenceRecovery, previewPaymentEvidenceRecovery } from "./payment-evidence-recovery-service";
import { executePaymentIdentityDecision, identityDecisionAuthorizesPair, previewPaymentIdentityDecision } from "./payment-identity-decision-service";
import { cancelPaymentIntake, getPaymentCancellationCapability } from "./payment-cancellation-service";
import { createPaymentIntake } from "./payment-service";

const integrationTest = process.env.TEST_DATABASE_URL ? test : test.skip;
function context(tenantId: string, actorUserId: number): CommandContext { return { tenantId, actorUserId, actorSource: "web", requestId: crypto.randomUUID(), correlationId: crypto.randomUUID() }; }
async function intake(tenantId: string, ownerUserId: number, receivedAt: string, bankReferenceHash: string | null = null) {
    return (await db.insert(paymentIntakes).values({ tenantId, ownerUserId, amount: "200.00", receivedAt: new Date(receivedAt), payerName: "Synthetic payment payer", status: "draft", bankReferenceHash, createdByUserId: ownerUserId, updatedByUserId: ownerUserId }).returning())[0]!;
}

integrationTest("identity decisions authorize only reviewed participants and reject two active same-payment postings", async () => {
    const tenantId = `identity-regression-${crypto.randomUUID()}`;
    const owner = (await db.insert(users).values({ tenantId, email: `${crypto.randomUUID()}@test.invalid`, role: "owner" }).returning())[0]!;
    const first = await intake(tenantId, owner.id, "2026-09-23T01:00:00Z", "bank-a");
    const second = await intake(tenantId, owner.id, "2026-09-23T01:01:00Z", "bank-b");
    const third = await intake(tenantId, owner.id, "2026-09-23T01:02:00Z", "bank-c");
    const ctx = context(tenantId, owner.id);
    const preview = await previewPaymentIdentityDecision(ctx, { participantPaymentIntakePublicIds: [first.publicId, second.publicId], decision: "distinct_payment", reason: "Two distinct transfer references", idempotencyKey: "identity-preview-1" });
    const decision = await executePaymentIdentityDecision(ctx, { identityDecisionPreviewPublicId: preview.identityDecisionPreviewPublicId, previewHash: preview.previewHash, confirmed: true, reason: "Two distinct transfer references", idempotencyKey: "identity-execute-1" });
    expect(decision.decision).toBe("distinct_payment");
    expect(await identityDecisionAuthorizesPair(ctx, first.publicId, second.publicId)).toBe(true);
    expect(await identityDecisionAuthorizesPair(ctx, first.publicId, third.publicId)).toBe(false);
    await expect(executePaymentIdentityDecision(ctx, { identityDecisionPreviewPublicId: preview.identityDecisionPreviewPublicId, previewHash: preview.previewHash, confirmed: true, reason: "Changed command", idempotencyKey: "identity-execute-1" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

    const samePreview = await previewPaymentIdentityDecision(ctx, { participantPaymentIntakePublicIds: [first.publicId, third.publicId], decision: "same_payment", reason: "Reviewed as one receipt", idempotencyKey: "identity-preview-2" });
    await executePaymentIdentityDecision(ctx, { identityDecisionPreviewPublicId: samePreview.identityDecisionPreviewPublicId, previewHash: samePreview.previewHash, confirmed: true, reason: "Reviewed as one receipt", idempotencyKey: "identity-execute-2" });
    expect(await identityDecisionAuthorizesPair(ctx, first.publicId, third.publicId)).toBe(true);
    await db.update(paymentIntakes).set({ status: "posted", postedAt: new Date() }).where(and(eq(paymentIntakes.tenantId, tenantId), eq(paymentIntakes.publicId, third.publicId)));
    await db.update(paymentIntakes).set({ status: "posted", postedAt: new Date() }).where(and(eq(paymentIntakes.tenantId, tenantId), eq(paymentIntakes.publicId, first.publicId)));
    expect(await identityDecisionAuthorizesPair(ctx, first.publicId, third.publicId)).toBe(false);
    expect(await db.select().from(paymentIdentityDecisions).where(eq(paymentIdentityDecisions.tenantId, tenantId))).toHaveLength(2);
    const correctionPreview = await previewPaymentIdentityDecision(ctx, { participantPaymentIntakePublicIds: [first.publicId, third.publicId], decision: "same_payment", reason: "Correction confirms the reviewed pair", idempotencyKey: "identity-preview-correction" });
    await expect(executePaymentIdentityDecision(ctx, { identityDecisionPreviewPublicId: correctionPreview.identityDecisionPreviewPublicId, previewHash: correctionPreview.previewHash, confirmed: true, reason: "Correction confirms the reviewed pair", idempotencyKey: "identity-execute-correction" })).rejects.toMatchObject({ code: "PAYMENT_IDENTITY_GROUP_FINANCIAL_CONFLICT" });
    const decisions = await db.select().from(paymentIdentityDecisions).where(eq(paymentIdentityDecisions.tenantId, tenantId));
    expect(decisions).toHaveLength(2);
    const concurrentResults = await Promise.all(Array.from({ length: 20 }, () => previewPaymentIdentityDecision(context(tenantId, owner.id), { participantPaymentIntakePublicIds: [first.publicId, second.publicId], decision: "distinct_payment", reason: "Concurrent replay-safe preview", idempotencyKey: "identity-preview-concurrent" })));
    expect(new Set(concurrentResults.map((row) => row.identityDecisionPreviewPublicId)).size).toBe(1);
    expect(await db.select().from(paymentIdentityDecisionPreviews).where(and(eq(paymentIdentityDecisionPreviews.tenantId, tenantId), eq(paymentIdentityDecisionPreviews.idempotencyKey, "identity-preview-concurrent")))).toHaveLength(1);
});

integrationTest("evidence recovery requires an explicit preview, preserves the floor, and replays one receipt", async () => {
    const tenantId = `recovery-regression-${crypto.randomUUID()}`;
    const owner = (await db.insert(users).values({ tenantId, email: `${crypto.randomUUID()}@test.invalid`, role: "owner" }).returning())[0]!;
    const source = await intake(tenantId, owner.id, "2026-09-23T02:00:00Z");
    const ctx = context(tenantId, owner.id);
    const cancellation = await getPaymentCancellationCapability(ctx, source.publicId);
    await cancelPaymentIntake(ctx, source.publicId, { reason: "Synthetic failed evidence upload", expectedStateHash: cancellation.stateHash, idempotencyKey: "recovery-cancel-1" });
    const preview = await previewPaymentEvidenceRecovery(ctx, { sourcePaymentIntakePublicId: source.publicId, reason: "Recover failed upload", expectedCount: 1, reuseEvidence: false, idempotencyKey: "recovery-preview-1" });
    const result = await executePaymentEvidenceRecovery(ctx, { recoveryPreviewPublicId: preview.recoveryPreviewPublicId, previewHash: preview.previewHash, confirmed: true, reason: "Recover failed upload", idempotencyKey: "recovery-execute-1" });
    expect(result.resumed).toBe(false);
    const replay = await executePaymentEvidenceRecovery(ctx, { recoveryPreviewPublicId: preview.recoveryPreviewPublicId, previewHash: preview.previewHash, confirmed: true, reason: "Recover failed upload", idempotencyKey: "recovery-execute-1" });
    expect(replay).toMatchObject({ resumed: true, recoveryIntakePublicId: result.recoveryIntakePublicId });
    await expect(executePaymentEvidenceRecovery(ctx, { recoveryPreviewPublicId: preview.recoveryPreviewPublicId, previewHash: preview.previewHash, confirmed: true, reason: "Different recovery", idempotencyKey: "recovery-execute-1" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(await db.select().from(paymentEvidenceRecoveryPreviews).where(eq(paymentEvidenceRecoveryPreviews.tenantId, tenantId))).toHaveLength(1);
    expect(await db.select().from(paymentEvidenceRecoveryExecutions).where(eq(paymentEvidenceRecoveryExecutions.tenantId, tenantId))).toHaveLength(1);
});

integrationTest("serializes real create-vs-create duplicate inspection behind a tenant barrier", async () => {
    const tenantId = `create-barrier-${crypto.randomUUID()}`;
    const owner = (await db.insert(users).values({ tenantId, email: `${crypto.randomUUID()}@test.invalid`, role: "owner" }).returning())[0]!;
    const release = (() => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; })();
    let acquired!: () => void;
    const holderAcquired = new Promise<void>((resolve) => { acquired = resolve; });
    const holder = db.transaction(async (tx) => {
        await tx.execute(drizzleSql`SELECT pg_advisory_xact_lock(hashtextextended(${`payment-workflow-tenant:${tenantId}`}, 0))`);
        acquired();
        await release.promise;
    });
    await holderAcquired;
    const outcomePromise = Promise.all(Array.from({ length: 20 }, async (_, index) => {
        const receivedAt = new Date(Date.UTC(2026, 8, 23, 4, index, 0));
        const [first, second] = await Promise.all([
            createPaymentIntake(context(tenantId, owner.id), { amount: "20.00", receivedAt: receivedAt.toISOString(), payerName: `barrier-${index}`, bankReference: `barrier-ref-${index}` }),
            createPaymentIntake(context(tenantId, owner.id), { amount: "20.00", receivedAt: receivedAt.toISOString(), payerName: `barrier-${index}`, bankReference: `barrier-ref-${index}` }),
        ]);
        return [first, second];
    }));
    release.resolve();
    const outcomes = await outcomePromise;
    await holder;
    const flattened = outcomes.flat();
    expect(flattened.filter((row) => row.duplicate === false)).toHaveLength(20);
    expect(flattened.filter((row) => row.duplicate === true)).toHaveLength(20);
    expect(await db.select().from(paymentIntakes).where(eq(paymentIntakes.tenantId, tenantId))).toHaveLength(20);
});
