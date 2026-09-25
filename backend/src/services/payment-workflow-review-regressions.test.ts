import { and, eq, sql } from "drizzle-orm";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { db } from "../db";
import { auditLogs, borrowers, files, financialEvidenceRequirements, loanSchedules, loans, paymentEvidence, paymentIntakes, paymentMatchAllocations, paymentIdentityDecisions, transactions, users } from "../db/schema";
import type { CommandContext } from "./command-context";
import { createPaymentIntake, postPayment, previewPaymentMatch } from "./payment-service";
import { cancelPaymentIntake, getPaymentCancellationCapability } from "./payment-cancellation-service";
import { executePaymentDuplicateReview, previewPaymentDuplicateReview } from "./payment-duplicate-review-service";
import { createPaymentReplacement, inspectPaymentReplacement } from "./payment-replacement-service";
import { executePaymentIdentityDecision, identityDecisionAuthorizesPair, inspectPaymentIdentity, previewPaymentIdentityDecision } from "./payment-identity-decision-service";
import { lockPaymentWorkflowTenant } from "./payment-workflow-locks";

const integration = process.env.TEST_DATABASE_URL ? test : test.skip;
setDefaultTimeout(120_000);

type Fixture = { actor: { id: number; tenantId: string }; borrower: typeof borrowers.$inferSelect; schedules: Array<typeof loanSchedules.$inferSelect> };
type Deferred<T> = { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void };
function deferred<T>(): Deferred<T> { let resolve!: Deferred<T>["resolve"]; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
function context(actor: Fixture["actor"], key = crypto.randomUUID()): CommandContext {
    return { tenantId: actor.tenantId, actorUserId: actor.id, actorSource: "web", requestId: crypto.randomUUID(), correlationId: crypto.randomUUID(), idempotencyKey: key };
}
async function reset() { await db.execute(sql`TRUNCATE TABLE users CASCADE`); }
async function fixture(count = 3): Promise<Fixture> {
    const tenantId = `identity-${crypto.randomUUID()}`;
    const actor = await db.insert(users).values({ tenantId, email: `${crypto.randomUUID()}@example.invalid`, role: "owner" }).returning().then(([row]) => ({ id: row!.id, tenantId }));
    const borrower = await db.insert(borrowers).values({ tenantId, ownerUserId: actor.id, name: "Identity payer" }).returning().then(([row]) => row!);
    const schedules: Array<typeof loanSchedules.$inferSelect> = [];
    for (let index = 0; index < count; index += 1) {
        const loan = await db.insert(loans).values({ tenantId, ownerUserId: actor.id, borrowerId: borrower.id, principalAmount: "100.00", interestRate: "0.00", repaymentType: "monthly", outstandingPrincipal: "100.00", outstandingInterest: "0.00", outstandingFees: "0.00", status: "active" }).returning().then(([row]) => row!);
        schedules.push(await db.insert(loanSchedules).values({ tenantId, loanId: loan.id, installmentNo: 1, dueDate: "2026-09-24", scheduledPrincipal: "10.00", scheduledInterest: "0.00", scheduledFee: "0.00", scheduledTotal: "10.00", paidTotal: "0.00", paidPenalty: "0.00", remainingDue: "10.00", status: "pending" }).returning().then(([row]) => row!));
    }
    return { actor, borrower, schedules };
}
async function createReady(f: Fixture, scheduleIndex: number, receivedAt: string) {
    const schedule = f.schedules[scheduleIndex]!;
    const loan = await db.query.loans.findFirst({ where: eq(loans.id, schedule.loanId) });
    const intake = await createPaymentIntake(context(f.actor), { amount: "10.00", receivedAt, payerName: "Identity payer", originLoanPublicId: loan!.publicId });
    return { intake, preview: await matchReady(f, scheduleIndex, intake.publicId) };
}
async function createRaw(f: Fixture, scheduleIndex: number, receivedAt: string) {
    const schedule = f.schedules[scheduleIndex]!;
    const loan = await db.query.loans.findFirst({ where: eq(loans.id, schedule.loanId) });
    return createPaymentIntake(context(f.actor), { amount: "10.00", receivedAt, payerName: "Identity payer", originLoanPublicId: loan!.publicId });
}
async function matchReady(f: Fixture, scheduleIndex: number, intakePublicId: string) {
    const schedule = f.schedules[scheduleIndex]!;
    const loan = await db.query.loans.findFirst({ where: eq(loans.id, schedule.loanId) });
    const preview = await previewPaymentMatch(context(f.actor), intakePublicId, { allocations: [{ borrowerPublicId: f.borrower.publicId, loanPublicId: loan!.publicId, schedulePublicId: schedule.publicId, amount: "10.00" }] });
    expect(preview.status).toBe("ready");
    return preview;
}
async function decide(f: Fixture, ids: string[], decision: "same_payment" | "distinct_payment", key = crypto.randomUUID()) {
    const preview = await previewPaymentIdentityDecision(context(f.actor), { participantPaymentIntakePublicIds: ids, decision, reason: `identity ${decision}`, idempotencyKey: key });
    return executePaymentIdentityDecision(context(f.actor), { identityDecisionPreviewPublicId: preview.identityDecisionPreviewPublicId, previewHash: preview.previewHash, confirmed: true, reason: `identity ${decision}`, idempotencyKey: `${key}-execute` });
}
async function errorCode(promise: Promise<unknown>) {
    try { await promise; throw new Error("expected rejection"); } catch (error) { return (error as { code?: string }).code; }
}


import { executePaymentEvidenceRecovery, previewPaymentEvidenceRecovery } from "./payment-evidence-recovery-service";
import { resolveWorkflowFromBackend } from "../mcp/workflow-resolver-service";

async function attachReady(f: Fixture, publicId: string) {
    const row = (await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.publicId, publicId) }))!;
    const file = (await db.insert(files).values({ tenantId: f.actor.tenantId, ownerUserId: f.actor.id, bucket: "test", key: crypto.randomUUID(), originalName: "synthetic.png", mimeType: "image/png", size: 8, url: "storage:test" }).returning())[0]!;
    await db.insert(paymentEvidence).values({ tenantId: f.actor.tenantId, paymentIntakeId: row.id, fileId: file.id, status: "ready", evidenceType: "slip", evidenceHash: crypto.randomUUID(), mimeType: "image/png", declaredSize: 8, finalizedAt: new Date(), createdByUserId: f.actor.id, updatedByUserId: f.actor.id });
}
async function cancelIntake(f: Fixture, publicId: string) {
    const cap = await getPaymentCancellationCapability(context(f.actor), publicId);
    await cancelPaymentIntake(context(f.actor), publicId, { reason: "synthetic recovery", expectedStateHash: cap.stateHash, idempotencyKey: crypto.randomUUID() });
}

integration("review: a single incomplete participant cannot authorize itself", async () => {
    await reset(); const f = await fixture(2);
    const a = await createRaw(f, 0, "2026-09-24T03:00:00Z");
    const b = await createPaymentIntake(context(f.actor), { amount: "10.00", payerName: "Identity payer", receivedAt: "2026-09-24T03:01:00Z", attachmentRequirement: { expectedCount: 1 } });
    await expect(decide(f, [a.publicId, b.publicId], "same_payment")).rejects.toMatchObject({ code: "PAYMENT_IDENTITY_EVIDENCE_INCOMPLETE" });
    expect(await db.select().from(paymentIdentityDecisions)).toHaveLength(0);
    expect(await db.select().from(transactions)).toHaveLength(0);
});

for (const generations of [1, 2]) integration(`review: confirmed recovery chain of ${generations} covers immutable sources through real posting`, async () => {
    await reset(); const f = await fixture(1);
    const source = await createPaymentIntake(context(f.actor), { amount: "10.00", payerName: "Identity payer", receivedAt: "2026-09-24T03:00:00Z", attachmentRequirement: { expectedCount: 1 } });
    await cancelIntake(f, source.publicId);
    let sourceId = source.publicId;
    let recovered!: Awaited<ReturnType<typeof executePaymentEvidenceRecovery>>;
    for (let generation = 0; generation < generations; generation++) {
    const preview = await previewPaymentEvidenceRecovery(context(f.actor), { sourcePaymentIntakePublicId: sourceId, reason: "recover synthetic missing evidence", expectedCount: 1, reuseEvidence: false, idempotencyKey: crypto.randomUUID() });
    recovered = await executePaymentEvidenceRecovery(context(f.actor), { recoveryPreviewPublicId: preview.recoveryPreviewPublicId, previewHash: preview.previewHash, confirmed: true, reason: "recover synthetic missing evidence", idempotencyKey: crypto.randomUUID() });
    sourceId = recovered.recoveryIntakePublicId;
    if (generation + 1 < generations) await cancelIntake(f, sourceId);
    }
    await attachReady(f, recovered.recoveryIntakePublicId);
    const candidate = await createRaw(f, 0, "2026-09-24T03:01:00Z");
    await decide(f, [recovered.recoveryIntakePublicId, candidate.publicId], "same_payment");
    const matched = await matchReady(f, 0, recovered.recoveryIntakePublicId);
    await postPayment(context(f.actor), recovered.recoveryIntakePublicId, { proposalPublicId: matched.publicId });
    expect(await db.select().from(transactions)).toHaveLength(1);
    expect((await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.publicId, source.publicId) }))?.status).toBe("cancelled");
});

integration("review: collector distinct execution and receipt replay reauthorize expanded ownership", async () => {
    await reset(); const f = await fixture(1);
    const collector = (await db.insert(users).values({ tenantId: f.actor.tenantId, email: `${crypto.randomUUID()}@example.invalid`, role: "collector" }).returning())[0]!;
    const other = (await db.insert(users).values({ tenantId: f.actor.tenantId, email: `${crypto.randomUUID()}@example.invalid`, role: "collector" }).returning())[0]!;
    const a = await createPaymentIntake(context(collector), { amount: "10.00", payerName: "Pair", receivedAt: "2026-09-24T03:00:00Z" });
    const b = await createPaymentIntake(context(collector), { amount: "10.00", payerName: "Pair", receivedAt: "2026-09-24T03:30:00Z" });
    const c = await createPaymentIntake(context(other), { amount: "10.00", payerName: "Pair", receivedAt: "2026-09-24T04:00:00Z" });
    const first = await previewPaymentIdentityDecision(context(collector), { participantPaymentIntakePublicIds: [a.publicId, b.publicId], decision: "distinct_payment", reason: "collector reviewed pair", idempotencyKey: crypto.randomUUID() });
    const command = { identityDecisionPreviewPublicId: first.identityDecisionPreviewPublicId, previewHash: first.previewHash, confirmed: true as const, reason: "collector reviewed pair", idempotencyKey: crypto.randomUUID() };
    await executePaymentIdentityDecision(context(collector), command);
    const second = await previewPaymentIdentityDecision(context(collector), { participantPaymentIntakePublicIds: [a.publicId, b.publicId], decision: "distinct_payment", reason: "pending collector pair", idempotencyKey: crypto.randomUUID() });
    await decide(f, [b.publicId, c.publicId], "same_payment");
    const before = (await db.select().from(paymentIdentityDecisions)).length;
    await expect(executePaymentIdentityDecision(context(collector), command)).rejects.toMatchObject({ code: "PAYMENT_IDENTITY_DECISION_FORBIDDEN" });
    await expect(executePaymentIdentityDecision(context(collector), { identityDecisionPreviewPublicId: second.identityDecisionPreviewPublicId, previewHash: second.previewHash, confirmed: true, reason: "pending collector pair", idempotencyKey: crypto.randomUUID() })).rejects.toMatchObject({ code: "PAYMENT_IDENTITY_DECISION_FORBIDDEN" });
    expect(await db.select().from(paymentIdentityDecisions)).toHaveLength(before);
});

integration("review: held tenant mutex times out without writes and retry resumes one intake", async () => {
    await reset(); const f = await fixture(1);
    const held = deferred<void>(); const release = deferred<void>();
    const holder = db.transaction(async (tx) => { await lockPaymentWorkflowTenant(f.actor, tx); held.resolve(); await release.promise; });
    await held.promise;
    const input = { amount: "10.00", payerName: "Timeout", receivedAt: "2026-09-24T03:00:00Z", bankReference: "synthetic-timeout-reference" };
    const ctx = context(f.actor); const started = Date.now();
    try {
        await expect(createPaymentIntake(ctx, input)).rejects.toMatchObject({ code: "PAYMENT_WORKFLOW_LOCK_TIMEOUT" });
        expect(Date.now() - started).toBeLessThan(8000);
        expect(await db.select().from(paymentIntakes)).toHaveLength(0);
    } finally { release.resolve(); await holder; }
    const created = await createPaymentIntake(ctx, input);
    const replay = await createPaymentIntake(ctx, input);
    expect(replay.publicId).toBe(created.publicId);
    expect(await db.select().from(paymentIntakes)).toHaveLength(1);
});

integration("review: mutable target duplicate resolves to identity review instead of preview loop", async () => {
    await reset(); const f = await fixture(2);
    const a = await createRaw(f, 0, "2026-09-24T03:00:00Z");
    await createRaw(f, 1, "2026-09-24T03:01:00Z");
    await expect(matchReady(f, 0, a.publicId)).rejects.toMatchObject({ code: "PAYMENT_DUPLICATE_REQUIRES_REVIEW" });
    const result = await resolveWorkflowFromBackend(context(f.actor), { intent: "receive_payment", target: { kind: "payment_intake", publicId: a.publicId }, attachments: "none" }, "payments", "review-catalog", "review-workflow");
    expect(result.nextSteps.map((step) => step.toolName)).toContain("payment.identity-decision.preview");
});

integration("review: two independently recovered groups can merge without losing per-source evidence coverage", async () => {
    await reset(); const f = await fixture(2);
    const recoveredIds: string[] = [];
    for (const minute of [0, 1]) {
        const source = await createPaymentIntake(context(f.actor), { amount: "10.00", payerName: "Identity payer", receivedAt: `2026-09-24T03:0${minute}:00Z`, attachmentRequirement: { expectedCount: 1 } });
        await cancelIntake(f, source.publicId);
        const preview = await previewPaymentEvidenceRecovery(context(f.actor), { sourcePaymentIntakePublicId: source.publicId, reason: "independent recovery", expectedCount: 1, reuseEvidence: false, idempotencyKey: crypto.randomUUID() });
        const child = await executePaymentEvidenceRecovery(context(f.actor), { recoveryPreviewPublicId: preview.recoveryPreviewPublicId, previewHash: preview.previewHash, confirmed: true, reason: "independent recovery", idempotencyKey: crypto.randomUUID() });
        await attachReady(f, child.recoveryIntakePublicId);
        recoveredIds.push(child.recoveryIntakePublicId);
    }
    await decide(f, recoveredIds, "same_payment");
    const matched = await matchReady(f, 0, recoveredIds[0]!);
    await postPayment(context(f.actor), recoveredIds[0]!, { proposalPublicId: matched.publicId });
    await expect(matchReady(f, 1, recoveredIds[1]!)).rejects.toMatchObject({ code: "PAYMENT_DUPLICATE_REQUIRES_REVIEW" });
    expect(await db.select().from(transactions)).toHaveLength(1);
});
