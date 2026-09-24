import { and, eq, sql } from "drizzle-orm";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { db } from "../db";
import postgres from "postgres";
import { auditLogs, borrowers, files, loanSchedules, loans, paymentEvidence, paymentIntakes, paymentMatchAllocations, paymentIdentityDecisions, transactions, users } from "../db/schema";
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

async function forceIdentityExecutionOrder(f: Fixture, first: "ab" | "bc", previews: { ab: Awaited<ReturnType<typeof previewPaymentIdentityDecision>>; bc: Awaited<ReturnType<typeof previewPaymentIdentityDecision>> }) {
    const observer = postgres(process.env.TEST_DATABASE_URL!, { max: 1 });
    const ready = deferred<void>();
    const started = deferred<void>();
    const command = (preview: typeof previews.ab, reason: string) => ({ identityDecisionPreviewPublicId: preview.identityDecisionPreviewPublicId, previewHash: preview.previewHash, confirmed: true as const, reason, idempotencyKey: crypto.randomUUID() });
    const secondaryPreview = first === "ab" ? previews.bc : previews.ab;
    const secondaryReason = first === "ab" ? "shared BC" : "shared AB";
    const secondary = (async () => { await ready.promise; started.resolve(); return executePaymentIdentityDecision(context(f.actor), command(secondaryPreview, secondaryReason)); })();
    const holder = db.transaction(async (tx) => {
        await lockPaymentWorkflowTenant(f.actor, tx);
        const holderPid = Number((await tx.execute(sql`SELECT pg_backend_pid() AS pid`))[0]?.pid);
        ready.resolve();
        await started.promise;
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
            const waiting = await observer<{ waiting: boolean }[]>`SELECT EXISTS (SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE l.locktype = 'advisory' AND NOT l.granted AND l.pid <> ${holderPid}) AS waiting`;
            if (waiting[0]?.waiting) break;
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        const holderPreview = first === "ab" ? previews.ab : previews.bc;
        const holderReason = first === "ab" ? "shared AB" : "shared BC";
        return executePaymentIdentityDecision(context(f.actor), command(holderPreview, holderReason), tx);
    });
    const result = await Promise.allSettled([holder, secondary]);
    await observer.end({ timeout: 5 });
    return result;
}

async function cancel(f: Fixture, publicId: string) {
    const capability = await getPaymentCancellationCapability(context(f.actor), publicId);
    return cancelPaymentIntake(context(f.actor), publicId, { reason: "identity graph regression", idempotencyKey: crypto.randomUUID(), expectedStateHash: capability.stateHash });
}

async function readyEvidence(f: Fixture, intakeId: number) {
    const file = await db.insert(files).values({ tenantId: f.actor.tenantId, ownerUserId: f.actor.id, bucket: "test", key: crypto.randomUUID(), originalName: "slip.png", mimeType: "image/png", size: 8, url: "storage:test" }).returning().then(([row]) => row!);
    await db.insert(paymentEvidence).values({ tenantId: f.actor.tenantId, paymentIntakeId: intakeId, fileId: file.id, status: "ready", evidenceType: "slip", evidenceHash: crypto.randomUUID().replaceAll("-", "").padEnd(64, "a"), mimeType: "image/png", declaredSize: 8, finalizedAt: new Date(), createdByUserId: f.actor.id, updatedByUserId: f.actor.id });
}

describe("payment identity decisions preserve financial invariants", () => {
    integration("same-payment receipts six minutes apart block the second real post without partial effects", async () => {
        await reset();
        const f = await fixture(2);
        const first = await createReady(f, 0, "2026-09-24T03:00:00.000Z");
        const second = await createReady(f, 1, "2026-09-24T03:06:00.000Z");
        await decide(f, [first.intake.publicId, second.intake.publicId], "same_payment");
        await postPayment(context(f.actor), first.intake.publicId, { proposalPublicId: first.preview.publicId });
        const before = await Promise.all([
            db.select().from(transactions).where(eq(transactions.tenantId, f.actor.tenantId)),
            db.select().from(paymentMatchAllocations).where(eq(paymentMatchAllocations.tenantId, f.actor.tenantId)),
            db.select().from(auditLogs).where(eq(auditLogs.tenantId, f.actor.tenantId)),
        ]);
        expect(await errorCode(postPayment(context(f.actor), second.intake.publicId, { proposalPublicId: second.preview.publicId }))).toBe("PAYMENT_DUPLICATE_REQUIRES_REVIEW");
        const after = await Promise.all([
            db.select().from(transactions).where(eq(transactions.tenantId, f.actor.tenantId)),
            db.select().from(paymentMatchAllocations).where(eq(paymentMatchAllocations.tenantId, f.actor.tenantId)),
            db.select().from(auditLogs).where(eq(auditLogs.tenantId, f.actor.tenantId)),
        ]);
        expect(after.map((rows) => rows.length)).toEqual(before.map((rows) => rows.length));
    });

    integration("a distinct identity decision lets two receipts within five minutes post to separate obligations", async () => {
        await reset();
        const f = await fixture(2);
        const firstIntake = await createRaw(f, 0, "2026-09-24T03:00:00.000Z");
        const secondIntake = await createRaw(f, 1, "2026-09-24T03:04:00.000Z");
        await decide(f, [firstIntake.publicId, secondIntake.publicId], "distinct_payment");
        const first = { intake: firstIntake, preview: await matchReady(f, 0, firstIntake.publicId) };
        const second = { intake: secondIntake, preview: await matchReady(f, 1, secondIntake.publicId) };
        expect(await identityDecisionAuthorizesPair(context(f.actor), first.intake.publicId, second.intake.publicId)).toBe(true);
        const firstRow = await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.publicId, first.intake.publicId) });
        await postPayment(context(f.actor), first.intake.publicId, { proposalPublicId: first.preview.publicId });
        expect(await identityDecisionAuthorizesPair(context(f.actor), first.intake.publicId, second.intake.publicId)).toBe(true);
        await postPayment(context(f.actor), second.intake.publicId, { proposalPublicId: second.preview.publicId });
        expect(await db.select().from(transactions).where(eq(transactions.tenantId, f.actor.tenantId))).toHaveLength(2);
        expect((await db.select().from(paymentIntakes).where(eq(paymentIntakes.tenantId, f.actor.tenantId))).filter((row) => row.status === "posted")).toHaveLength(2);
    });

    integration("same-payment identity is transitive and blocks a later post with zero extra ledger effect", async () => {
        await reset();
        const f = await fixture(3);
        const a = await createReady(f, 0, "2026-09-24T03:00:00.000Z");
        const b = await createReady(f, 1, "2026-09-24T03:30:00.000Z");
        const c = await createReady(f, 2, "2026-09-24T04:00:00.000Z");
        await decide(f, [a.intake.publicId, b.intake.publicId], "same_payment");
        await decide(f, [b.intake.publicId, c.intake.publicId], "same_payment");
        expect((await inspectPaymentIdentity(context(f.actor), [a.intake.publicId, c.intake.publicId])).connected).toBe(true);
        await postPayment(context(f.actor), a.intake.publicId, { proposalPublicId: a.preview.publicId });
        const transactionCount = (await db.select().from(transactions).where(eq(transactions.tenantId, f.actor.tenantId))).length;
        expect(await errorCode(postPayment(context(f.actor), c.intake.publicId, { proposalPublicId: c.preview.publicId }))).toBe("PAYMENT_DUPLICATE_REQUIRES_REVIEW");
        expect((await db.select().from(transactions).where(eq(transactions.tenantId, f.actor.tenantId))).length).toBe(transactionCount);
    });

    integration("a superseding distinct decision removes the old same-payment edge without mutating immutable decisions", async () => {
        await reset();
        const f = await fixture(2);
        const a = await createReady(f, 0, "2026-09-24T03:00:00.000Z");
        const b = await createReady(f, 1, "2026-09-24T03:30:00.000Z");
        await decide(f, [a.intake.publicId, b.intake.publicId], "same_payment");
        expect((await inspectPaymentIdentity(context(f.actor), [a.intake.publicId, b.intake.publicId])).connected).toBe(true);
        await decide(f, [a.intake.publicId, b.intake.publicId], "distinct_payment");
        expect((await inspectPaymentIdentity(context(f.actor), [a.intake.publicId, b.intake.publicId])).connected).toBe(false);
        const decisions = (await db.select().from(paymentIdentityDecisions).where(eq(paymentIdentityDecisions.tenantId, f.actor.tenantId))).sort((left, right) => left.id - right.id);
        expect(decisions).toHaveLength(2);
        expect(decisions[1]!.supersedesDecisionId).toBe(decisions[0]!.id);
    });

    integration("overlapping identity decisions on shared members commit one transitive group in both forced orders", async () => {
        for (let iteration = 0; iteration < 20; iteration += 1) for (const first of ["ab", "bc"] as const) {
            await reset();
            const f = await fixture(3);
            const a = await createRaw(f, 0, "2026-09-24T03:00:00.000Z");
            const b = await createRaw(f, 1, "2026-09-24T03:30:00.000Z");
            const c = await createRaw(f, 2, "2026-09-24T04:00:00.000Z");
            const previews = {
                ab: await previewPaymentIdentityDecision(context(f.actor), { participantPaymentIntakePublicIds: [a.publicId, b.publicId], decision: "same_payment", reason: "shared AB", idempotencyKey: crypto.randomUUID() }),
                bc: await previewPaymentIdentityDecision(context(f.actor), { participantPaymentIntakePublicIds: [b.publicId, c.publicId], decision: "same_payment", reason: "shared BC", idempotencyKey: crypto.randomUUID() }),
            };
            const results = await forceIdentityExecutionOrder(f, first, previews);
            expect(results.every((result) => result.status === "fulfilled")).toBe(true);
            expect((await db.select().from(paymentIdentityDecisions).where(eq(paymentIdentityDecisions.tenantId, f.actor.tenantId)))).toHaveLength(2);
            expect((await inspectPaymentIdentity(context(f.actor), [a.publicId, c.publicId])).connected).toBe(true);
        }
    });

    integration("expands an executed legacy membership when a later identity edge reaches its candidate", async () => {
        await reset();
        const f = await fixture(3);
        const a = await createRaw(f, 0, "2026-09-24T03:00:00.000Z");
        const b = await createRaw(f, 1, "2026-09-24T03:00:00.000Z");
        const c = await createRaw(f, 2, "2026-09-24T03:30:00.000Z");
        await cancel(f, a.publicId);
        await cancel(f, b.publicId);
        const legacyPreview = await previewPaymentDuplicateReview(context(f.actor), { canonicalPaymentIntakePublicId: a.publicId, candidatePaymentIntakePublicIds: [b.publicId], reason: "historical same receipt", idempotencyKey: crypto.randomUUID() });
        await executePaymentDuplicateReview(context(f.actor), { duplicateReviewPublicId: legacyPreview.duplicateReviewPublicId, previewHash: legacyPreview.previewHash, confirmed: true, reason: "historical same receipt", idempotencyKey: crypto.randomUUID() });
        await decide(f, [b.publicId, c.publicId], "same_payment");
        const inspection = await inspectPaymentIdentity(context(f.actor), [a.publicId, c.publicId]);
        expect(inspection.connected).toBe(true);
        expect(inspection.participantPublicIds).toEqual(expect.arrayContaining([a.publicId, b.publicId, c.publicId]));
    });

    integration("rejects merging two identity components that each contain a posted replacement descendant", async () => {
        await reset();
        const f = await fixture(4);
        const firstSource = await createPaymentIntake(context(f.actor), { amount: "10.00", receivedAt: "2026-09-24T03:00:00.000Z", payerName: "Identity payer", originLoanPublicId: f.schedules[0] ? (await db.query.loans.findFirst({ where: eq(loans.id, f.schedules[0]!.loanId) }))!.publicId : undefined, attachmentRequirement: { expectedCount: 1 } });
        const secondSource = await createPaymentIntake(context(f.actor), { amount: "10.00", receivedAt: "2026-09-24T03:10:00.000Z", payerName: "Identity payer", originLoanPublicId: (await db.query.loans.findFirst({ where: eq(loans.id, f.schedules[1]!.loanId) }))!.publicId, attachmentRequirement: { expectedCount: 1 } });
        const firstRow = await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.publicId, firstSource.publicId) });
        const secondRow = await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.publicId, secondSource.publicId) });
        await readyEvidence(f, firstRow!.id); await readyEvidence(f, secondRow!.id);
        await cancel(f, firstSource.publicId); await cancel(f, secondSource.publicId);
        await decide(f, [firstSource.publicId, secondSource.publicId], "distinct_payment");
        const firstInspection = await inspectPaymentReplacement(context(f.actor), firstSource.publicId);
        const secondInspection = await inspectPaymentReplacement(context(f.actor), secondSource.publicId);
        const firstReplacement = await createPaymentReplacement(context(f.actor), { paymentIntakePublicId: firstSource.publicId, reason: "posted replacement one", idempotencyKey: crypto.randomUUID(), expectedStateHash: firstInspection.stateHash });
        const secondReplacement = await createPaymentReplacement(context(f.actor), { paymentIntakePublicId: secondSource.publicId, reason: "posted replacement two", idempotencyKey: crypto.randomUUID(), expectedStateHash: secondInspection.stateHash });
        const firstPreview = await matchReady(f, 0, firstReplacement.replacementPaymentIntakePublicId);
        const secondPreview = await matchReady(f, 1, secondReplacement.replacementPaymentIntakePublicId);
        await postPayment(context(f.actor), firstReplacement.replacementPaymentIntakePublicId, { proposalPublicId: firstPreview.publicId });
        await postPayment(context(f.actor), secondReplacement.replacementPaymentIntakePublicId, { proposalPublicId: secondPreview.publicId });
        const preview = await previewPaymentIdentityDecision(context(f.actor), { participantPaymentIntakePublicIds: [firstSource.publicId, secondSource.publicId], decision: "same_payment", reason: "two posted replacement descendants", idempotencyKey: crypto.randomUUID() });
        const rejection = await errorCode(executePaymentIdentityDecision(context(f.actor), { identityDecisionPreviewPublicId: preview.identityDecisionPreviewPublicId, previewHash: preview.previewHash, confirmed: true, reason: "two active financial effects", idempotencyKey: crypto.randomUUID() }));
        expect(["PAYMENT_IDENTITY_GROUP_FINANCIAL_CONFLICT", "PAYMENT_IDENTITY_PREVIEW_STALE"]).toContain(rejection ?? "");
        expect(await db.select().from(paymentIdentityDecisions).where(eq(paymentIdentityDecisions.tenantId, f.actor.tenantId))).toHaveLength(1);
        expect(await db.select().from(transactions).where(eq(transactions.tenantId, f.actor.tenantId))).toHaveLength(2);
    });
});
