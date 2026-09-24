import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { db } from "../db";
import { auditLogs, borrowers, loanSchedules, loans, paymentBatchAllocations, paymentEvidence, paymentIntakes, transactions, users } from "../db/schema";
import type { CommandContext } from "./command-context";
import { cancelPaymentIntake, getPaymentCancellationCapability } from "./payment-cancellation-service";
import { createPaymentIntake, finalizePaymentEvidence, postPayment, preparePaymentEvidence, previewPaymentMatch, type EvidenceStorageGateway } from "./payment-service";
import { addPaymentBatchItem, createPaymentBatch, executePaymentBatch, previewPaymentBatch } from "./payment-batch-service";
import { executePaymentDuplicateReview, previewPaymentDuplicateReview } from "./payment-duplicate-review-service";
import { createPaymentReplacement, inspectPaymentReplacement } from "./payment-replacement-service";
import { lockPaymentWorkflowTenant } from "./payment-workflow-locks";

const integration = process.env.TEST_DATABASE_URL ? test : test.skip;
const ITERATIONS = 20;
const timeoutMs = 15_000;
setDefaultTimeout(120_000);

type Actor = { id: number; tenantId: string };
type Seed = { actor: Actor; borrower: typeof borrowers.$inferSelect; loan: typeof loans.$inferSelect; schedule: typeof loanSchedules.$inferSelect };
type Deferred<T> = { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void; reject: (reason?: unknown) => void };

function deferred<T>(): Deferred<T> {
    let resolve!: Deferred<T>["resolve"];
    let reject!: Deferred<T>["reject"];
    const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
    return { promise, resolve, reject };
}

function ctx(actor: Actor, key = crypto.randomUUID()): CommandContext {
    return { tenantId: actor.tenantId, actorUserId: actor.id, actorSource: "web", requestId: crypto.randomUUID(), correlationId: crypto.randomUUID(), idempotencyKey: key };
}

async function reset() {
    await db.execute(sql`TRUNCATE TABLE users CASCADE`);
}

async function seed(tenant = `concurrency-${crypto.randomUUID()}`): Promise<Seed> {
    const actor = await db.insert(users).values({ tenantId: tenant, email: `${crypto.randomUUID()}@example.invalid`, role: "owner" }).returning().then(([row]) => ({ id: row!.id, tenantId: tenant }));
    const borrower = await db.insert(borrowers).values({ tenantId: tenant, ownerUserId: actor.id, name: "Concurrency payer" }).returning().then(([row]) => row!);
    const loan = await db.insert(loans).values({ tenantId: tenant, ownerUserId: actor.id, borrowerId: borrower.id, principalAmount: "100.00", interestRate: "0.00", repaymentType: "monthly", outstandingPrincipal: "100.00", outstandingInterest: "0.00", outstandingFees: "0.00", status: "active" }).returning().then(([row]) => row!);
    const schedule = await db.insert(loanSchedules).values({ tenantId: tenant, loanId: loan.id, installmentNo: 1, dueDate: "2026-09-24", scheduledPrincipal: "10.00", scheduledInterest: "0.00", scheduledFee: "0.00", scheduledTotal: "10.00", paidTotal: "0.00", paidPenalty: "0.00", remainingDue: "10.00", status: "pending" }).returning().then(([row]) => row!);
    return { actor, borrower, loan, schedule };
}

async function readyPayment(f: Seed, receivedAt = "2026-09-24T03:00:00.000Z") {
    const intake = await createPaymentIntake(ctx(f.actor), { amount: "10.00", receivedAt, payerName: "Concurrency payer", originLoanPublicId: f.loan.publicId });
    const preview = await previewPaymentMatch(ctx(f.actor), intake.publicId, { allocations: [{ borrowerPublicId: f.borrower.publicId, loanPublicId: f.loan.publicId, schedulePublicId: f.schedule.publicId, amount: "10.00" }] });
    expect(preview.status).toBe("ready");
    return { intake, preview };
}

async function bounded<T>(promise: Promise<T>) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`concurrency operation exceeded ${timeoutMs}ms`)), timeoutMs); })]);
    } finally { if (timer) clearTimeout(timer); }
}

function fakeStorage(tenantId: string, intakePublicId: string, entered: Deferred<void>, release: Promise<void>): EvidenceStorageGateway {
    return {
        preparePut: async () => ({ uploadUrl: "https://storage.invalid/concurrency", expiresAt: new Date(Date.now() + 60_000) }),
        head: async () => { entered.resolve(); await release; return { exists: true, contentType: "image/png", contentLength: 8, checksumSha256: "a".repeat(64), metadata: { tenant: tenantId, intake: intakePublicId } }; },
    };
}

async function waitForTenantAdvisoryLock(holderPid: number, connection: ReturnType<typeof postgres>) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const waiting = await connection<{ waiting: boolean }[]>`
            SELECT EXISTS (
                SELECT 1
                FROM pg_locks waiting
                JOIN pg_stat_activity activity ON activity.pid = waiting.pid
                WHERE waiting.locktype = 'advisory'
                  AND waiting.granted = false
                  AND activity.wait_event_type = 'Lock'
                  AND waiting.pid <> ${holderPid}
            ) AS waiting`;
        if (waiting[0]?.waiting) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`second transaction did not wait for tenant advisory lock within ${timeoutMs}ms`);
}

/**
 * Start the second real service first, prove it is blocked on the tenant
 * advisory lock from a third connection, then execute the requested winner in
 * the holder transaction. This is deliberately independent of Promise order.
 */
async function forceTransactionOrder(f: Seed, intakePublicId: string, first: "cancel" | "post", cancelInput: { reason: string; idempotencyKey: string; expectedStateHash: string }, proposalPublicId: string) {
    const observer = postgres(process.env.TEST_DATABASE_URL!, { max: 1 });
    const holderReady = deferred<void>();
    const secondStarted = deferred<void>();
    const second = (async () => {
        await holderReady.promise;
        secondStarted.resolve();
        return first === "cancel"
            ? postPayment(ctx(f.actor), intakePublicId, { proposalPublicId }).catch((error) => { throw error; })
            : cancelPaymentIntake(ctx(f.actor), intakePublicId, cancelInput).catch((error) => { throw error; });
    })();
    const holder = db.transaction(async (tx) => {
        await lockPaymentWorkflowTenant(f.actor, tx);
        const holderPid = Number((await tx.execute(sql`SELECT pg_backend_pid() AS pid`))[0]?.pid);
        holderReady.resolve();
        await secondStarted.promise;
        await waitForTenantAdvisoryLock(holderPid, observer);
        try {
            return first === "cancel"
                ? await cancelPaymentIntake(ctx(f.actor), intakePublicId, cancelInput, tx)
                : await postPayment(ctx(f.actor), intakePublicId, { proposalPublicId }, tx);
        } catch (error) {
            return error;
        }
    });
    const holderResult = await bounded(holder);
    const secondResult = await bounded(second).catch((error) => error);
    await observer.end({ timeout: 5 });
    return { holderResult, secondResult };
}

async function pendingEvidence(f: Seed) {
    const intake = await createPaymentIntake(ctx(f.actor), { amount: "10.00", receivedAt: "2026-09-24T03:00:00.000Z", payerName: "Concurrency payer" });
    const input = { mimeType: "image/png", size: 8, sha256: "a".repeat(64) };
    const storage: EvidenceStorageGateway = {
        preparePut: async () => ({ uploadUrl: "https://storage.invalid/concurrency", expiresAt: new Date(Date.now() + 60_000) }),
        head: async () => ({ exists: true, contentType: input.mimeType, contentLength: input.size, checksumSha256: input.sha256, metadata: { tenant: f.actor.tenantId, intake: intake.publicId } }),
    };
    const prepared = await preparePaymentEvidence(ctx(f.actor), intake.publicId, input, storage);
    return { intake, evidence: prepared };
}

async function cancellationInput(actor: Actor, publicId: string) {
    const capability = await getPaymentCancellationCapability(ctx(actor), publicId);
    return { reason: "concurrency regression", idempotencyKey: crypto.randomUUID(), expectedStateHash: capability.stateHash };
}

async function assertNoPartialPayment(f: Seed, intakePublicId: string) {
    const rows = await db.select().from(transactions).where(eq(transactions.tenantId, f.actor.tenantId));
    const intake = await db.query.paymentIntakes.findFirst({ where: and(eq(paymentIntakes.tenantId, f.actor.tenantId), eq(paymentIntakes.publicId, intakePublicId)) });
    expect(rows.length).toBeLessThanOrEqual(1);
    expect(intake?.status).toMatch(/^(cancelled|posted)$/);
}

describe("payment workflow DB concurrency regressions", () => {
    integration("cancel vs post on a ready scheduled payment serializes in either order", async () => {
        await reset();
        for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
            for (const first of ["cancel", "post"] as const) {
                const f = await seed();
                const { intake, preview } = await readyPayment(f);
                const cancel = await cancellationInput(f.actor, intake.publicId);
                const outcomes = await forceTransactionOrder(f, intake.publicId, first, cancel, preview.publicId);
                const errors = [outcomes.holderResult, outcomes.secondResult].filter((value): value is Error => value instanceof Error);
                expect(errors.length).toBe(1);
                expect(errors[0]).toMatchObject({ code: first === "cancel" ? "PAYMENT_CANCEL_NOT_ALLOWED" : "PAYMENT_CANCEL_STALE" });
                await assertNoPartialPayment(f, intake.publicId);
                const rows = await db.select().from(transactions).where(eq(transactions.tenantId, f.actor.tenantId));
                expect(rows).toHaveLength(first === "cancel" ? 0 : 1);
            }
        }
    });

    integration("evidence finalize vs cancel uses a real pending-upload transition in either order", async () => {
        await reset();
        for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
            for (const first of ["finalize", "cancel"] as const) {
                const f = await seed();
                const pending = await pendingEvidence(f);
                // The storage HEAD is a real synchronization point: finalize cannot enter
                // its DB transition until the adapter confirms that both sides can proceed.
                const entered = deferred<void>();
                const release = deferred<void>();
                const storage = fakeStorage(f.actor.tenantId, pending.intake.publicId, entered, release.promise);
                const finalize = finalizePaymentEvidence(ctx(f.actor), pending.intake.publicId, pending.evidence.publicId, storage);
                await bounded(entered.promise);
                const cancelInput = await cancellationInput(f.actor, pending.intake.publicId);
                if (first === "cancel") {
                    const cancel = cancelPaymentIntake(ctx(f.actor), pending.intake.publicId, cancelInput);
                    const cancelResult = await bounded(cancel);
                    release.resolve();
                    const finalizeResult = await bounded(finalize).catch((error) => error);
                    expect(cancelResult.status).toBe("cancelled");
                    expect(finalizeResult).toMatchObject({ code: "PAYMENT_INTAKE_IMMUTABLE" });
                } else {
                    release.resolve();
                    const finalizeResult = await bounded(finalize);
                    const cancelResult = await bounded(cancelPaymentIntake(ctx(f.actor), pending.intake.publicId, cancelInput)).catch((error) => error);
                    expect(finalizeResult.status).toBe("ready");
                    expect(cancelResult).toMatchObject({ code: "PAYMENT_CANCEL_STALE" });
                }
                const evidence = await db.query.paymentEvidence.findFirst({ where: eq(paymentEvidence.publicId, pending.evidence.publicId) });
                expect(evidence?.status).toBe(first === "finalize" ? "ready" : "pending");
            }
        }
    });

    integration("preview vs batch post has one durable outcome for the shared intake", async () => {
        await reset();
        // The batch path is intentionally exercised through its public service in the
        // existing atomic suite; this regression keeps the shared single-intake race
        // explicit and repeats it under the same database mutex.
        for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
            const f = await seed();
            const intake = await createPaymentIntake(ctx(f.actor), { amount: "10.00", receivedAt: "2026-09-23T03:00:00.000Z", payerName: "Concurrency payer" });
            const batch = await createPaymentBatch(ctx(f.actor), { idempotencyKey: crypto.randomUUID(), borrowerPublicId: f.borrower.publicId });
            const added = await addPaymentBatchItem(ctx(f.actor), batch.publicId, { paymentIntakePublicId: intake.publicId, itemOrder: 1 });
            const item = added.items.find((candidate) => candidate.paymentIntakePublicId === intake.publicId)!;
            const batchPreview = await previewPaymentBatch(ctx(f.actor), batch.publicId, { borrowerPublicId: f.borrower.publicId, allocations: [{ itemPublicId: item.publicId, borrowerPublicId: f.borrower.publicId, loanPublicId: f.loan.publicId, schedulePublicId: f.schedule.publicId, amount: "10.00", targetDueDate: f.schedule.dueDate, intent: "on_time" }] });
            const nextPreview = previewPaymentMatch(ctx(f.actor), intake.publicId, { allocations: [{ borrowerPublicId: f.borrower.publicId, loanPublicId: f.loan.publicId, schedulePublicId: f.schedule.publicId, amount: "10.00" }] });
            const post = executePaymentBatch(ctx(f.actor), batch.publicId, { previewPublicId: batchPreview.publicId, previewHash: batchPreview.previewHash, confirmationHash: batchPreview.confirmationHash, confirmed: true, idempotencyKey: crypto.randomUUID() });
            const outcomes = await bounded(Promise.allSettled([nextPreview, post]));
            if (outcomes[1]?.status === "fulfilled") expect(outcomes[1].value.status).toBe("posted");
            else expect(outcomes[1]?.reason).toMatchObject({ code: "BATCH_CONFIRMATION_STALE" });
            if (outcomes[0]?.status === "rejected") expect(outcomes[0].reason).toMatchObject({ code: "PAYMENT_INTAKE_IMMUTABLE" });
            else expect(outcomes[0]?.value.status).toBe("ready");
            const finalIntake = await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.publicId, intake.publicId) });
            expect(finalIntake?.status).toMatch(/^(ready|posted)$/);
            const ledger = await db.select().from(transactions).where(eq(transactions.tenantId, f.actor.tenantId));
            expect(ledger).toHaveLength(finalIntake?.status === "posted" ? 1 : 0);
            expect(await db.select().from(paymentBatchAllocations).where(eq(paymentBatchAllocations.tenantId, f.actor.tenantId))).toHaveLength(1);
            expect((await db.select().from(auditLogs).where(eq(auditLogs.tenantId, f.actor.tenantId))).length).toBeGreaterThan(0);
        }
    });

    integration("overlapping identity group executions have one winner", async () => {
        await reset();
        for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
            const f = await seed();
            const canonical = await createPaymentIntake(ctx(f.actor), { amount: "10.00", receivedAt: "2026-09-24T03:00:00.000Z", payerName: "Concurrency payer" });
            const candidate = await createPaymentIntake(ctx(f.actor), { amount: "10.00", receivedAt: "2026-09-24T03:00:00.000Z", payerName: "Concurrency payer" });
            const canonicalCancel = await cancelPaymentIntake(ctx(f.actor), canonical.publicId, await cancellationInput(f.actor, canonical.publicId));
            const candidateCancel = await cancelPaymentIntake(ctx(f.actor), candidate.publicId, await cancellationInput(f.actor, candidate.publicId));
            expect(canonicalCancel.status).toBe("cancelled"); expect(candidateCancel.status).toBe("cancelled");
            const previews = await Promise.all([1, 2].map((n) => previewPaymentDuplicateReview(ctx(f.actor), { canonicalPaymentIntakePublicId: canonical.publicId, candidatePaymentIntakePublicIds: [candidate.publicId], reason: `overlap-${n}`, idempotencyKey: crypto.randomUUID() })));
            const executions = await bounded(Promise.allSettled(previews.map((preview) => executePaymentDuplicateReview(ctx(f.actor), { duplicateReviewPublicId: preview.duplicateReviewPublicId, previewHash: preview.previewHash, confirmed: true, reason: "concurrency", idempotencyKey: crypto.randomUUID() }))));
            expect(executions.filter((item) => item.status === "fulfilled")).toHaveLength(1);
        }
    });

    integration("same-identity create vs post at an adjacent minute has one post and a reviewed create", async () => {
        await reset();
        for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
            const f = await seed();
            const original = await readyPayment(f, "2026-09-24T03:00:00.000Z");
            const create = createPaymentIntake(ctx(f.actor), { amount: "10.00", receivedAt: "2026-09-24T03:01:00.000Z", payerName: "Concurrency payer", originLoanPublicId: f.loan.publicId });
            const post = postPayment(ctx(f.actor), original.intake.publicId, { proposalPublicId: original.preview.publicId });
            const outcomes = await bounded(Promise.allSettled([create, post]));
            expect(outcomes.some((item) => item.status === "fulfilled")).toBe(true);
            expect((await db.select().from(transactions).where(eq(transactions.tenantId, f.actor.tenantId))).length).toBe(1);
            const created = outcomes[0]!.status === "fulfilled" ? outcomes[0]!.value : null;
            if (created) expect(created.warnings?.some((warning: { code?: string }) => warning.code === "POSSIBLE_SEMANTIC_DUPLICATE")).toBe(true);
        }
    });

    integration("replacement creation vs group extension never creates two successors", async () => {
        await reset();
        for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
            const f = await seed();
            const source = await createPaymentIntake(ctx(f.actor), { amount: "10.00", receivedAt: "2026-09-24T03:00:00.000Z", payerName: "Concurrency payer" });
            await cancelPaymentIntake(ctx(f.actor), source.publicId, await cancellationInput(f.actor, source.publicId));
            const candidate = await createPaymentIntake(ctx(f.actor), { amount: "10.00", receivedAt: "2026-09-24T03:00:00.000Z", payerName: "Concurrency payer" });
            await cancelPaymentIntake(ctx(f.actor), candidate.publicId, await cancellationInput(f.actor, candidate.publicId));
            // The replacement path is an actual create command and is blocked by the
            // missing required evidence; the competing group extension only previews.
            // Whichever reaches the tenant mutex first must leave no successor child.
            const inspection = await inspectPaymentReplacement(ctx(f.actor), source.publicId);
            const replacement = createPaymentReplacement(ctx(f.actor), { paymentIntakePublicId: source.publicId, reason: "concurrency replacement", idempotencyKey: crypto.randomUUID(), expectedStateHash: inspection.stateHash });
            const group = previewPaymentDuplicateReview(ctx(f.actor), { canonicalPaymentIntakePublicId: source.publicId, candidatePaymentIntakePublicIds: [candidate.publicId], reason: "group extension race", idempotencyKey: crypto.randomUUID() });
            const outcomes = await bounded(Promise.allSettled([replacement, group]));
            expect(outcomes.some((item) => item.status === "fulfilled")).toBe(true);
            expect(await db.select().from(paymentIntakes).where(and(eq(paymentIntakes.tenantId, f.actor.tenantId), eq(paymentIntakes.replacementOfIntakeId, (await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.publicId, source.publicId) }))!.id)))).toHaveLength(0);
        }
    });

    integration("a lost response replays the committed cancellation/post without a second effect", async () => {
        await reset();
        for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
            const cancelFixture = await seed();
            const cancelled = await createPaymentIntake(ctx(cancelFixture.actor), { amount: "10.00", receivedAt: "2026-09-24T03:00:00.000Z", payerName: "Replay payer" });
            const cancelRequest = await cancellationInput(cancelFixture.actor, cancelled.publicId);
            const firstCancel = await cancelPaymentIntake(ctx(cancelFixture.actor), cancelled.publicId, cancelRequest);
            const replayCancel = await cancelPaymentIntake({ ...ctx(cancelFixture.actor), correlationId: crypto.randomUUID() }, cancelled.publicId, cancelRequest);
            expect(replayCancel).toEqual(firstCancel);

            const postFixture = await seed();
            const posted = await readyPayment(postFixture);
            const firstPost = await postPayment(ctx(postFixture.actor), posted.intake.publicId, { proposalPublicId: posted.preview.publicId });
            const replayPost = await postPayment({ ...ctx(postFixture.actor), correlationId: crypto.randomUUID() }, posted.intake.publicId, { proposalPublicId: posted.preview.publicId });
            expect(replayPost).toEqual(firstPost);
            expect((await db.select().from(transactions).where(eq(transactions.tenantId, postFixture.actor.tenantId))).length).toBe(1);
        }
    });
});
