import { createHash } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { db, type DbExecutor } from "../db";
import { paymentBatchItems, paymentBatches, paymentIntakeCancellations, paymentIntakes, paymentMatchProposals, paymentReconciliationProposals, users } from "../db/schema";
import { canAccessTenantWideData } from "../lib/access";
import { createAuditLog } from "../lib/audit-log";
import { lockPaymentBorrowers, paymentIntakeBorrowerIds } from "./payment-chronology-service";
import type { CommandContext } from "./command-context";
import { DomainError } from "./domain-error";

type Executor = DbExecutor;
type Intake = typeof paymentIntakes.$inferSelect;
const eligible = new Set(["draft", "needs_review", "ready"]);

function normalizeReason(reason: string) {
    const normalized = String(reason ?? "").replace(/[\u0000-\u001f\u007f]/gu, " ").trim();
    if (normalized.length < 1 || normalized.length > 2000) throw new DomainError("PAYMENT_CANCEL_REASON_INVALID", "Cancellation reason must be between 1 and 2000 characters", 400);
    return normalized;
}
function requestHash(publicId: string, reason: string, key: string, expectedStateHash: string) {
    return createHash("sha256").update(JSON.stringify({ paymentIntakePublicId: publicId, reason, idempotencyKey: key, expectedStateHash })).digest("hex");
}
function requireKey(key: string) {
    if (!key || key.trim().length < 1 || key.trim().length > 200) throw new DomainError("PAYMENT_CANCEL_IDEMPOTENCY_REQUIRED", "Cancellation requires an idempotency key", 400);
    return key.trim();
}
async function actor(ctx: CommandContext, executor: Executor = db) {
    const row = ctx.actorUserId === null ? null : await executor.query.users.findFirst({ where: and(eq(users.id, ctx.actorUserId), eq(users.tenantId, ctx.tenantId)) });
    if (!row) throw new DomainError("UNAUTHORIZED", "Unauthorized", 401);
    return row;
}
async function accessible(ctx: CommandContext, publicId: string, executor: Executor = db) {
    const user = await actor(ctx, executor);
    const row = await executor.query.paymentIntakes.findFirst({ where: and(eq(paymentIntakes.tenantId, ctx.tenantId), eq(paymentIntakes.publicId, publicId)) });
    if (!row || (!canAccessTenantWideData({ role: user.role ?? "viewer" }) && row.ownerUserId !== user.id)) throw new DomainError("PAYMENT_INTAKE_NOT_FOUND", "Payment intake not found", 404);
    return { row, user };
}

function assertMutationRole(user: typeof users.$inferSelect, row: Intake) {
    // Tenant-wide read access and mutation access are deliberately different.
    // In particular, an owned viewer must never acquire a write capability.
    const role = user.role ?? "viewer";
    const mutationRole = role === "owner" || role === "manager" || role === "collector";
    if (!mutationRole || (!canAccessTenantWideData({ role }) && row.ownerUserId !== user.id)) {
        throw new DomainError("PAYMENT_CANCEL_FORBIDDEN", "You are not authorized to cancel this payment intake", 403);
    }
}

async function assertCancellationDependencies(tx: Executor, ctx: CommandContext, row: Intake, allowRestoreChild = false) {
    if (row.repostOfIntakeId !== null && !allowRestoreChild) {
        throw new DomainError("PAYMENT_CANCEL_DEPENDENCY_REQUIRED", "Restore drafts must use the restore workflow", 409);
    }
    const dependency = await tx.execute(sql`SELECT 1 FROM transactions WHERE tenant_id = ${ctx.tenantId} AND payment_intake_id = ${row.id}
        UNION ALL SELECT 1 FROM payment_intakes WHERE tenant_id = ${ctx.tenantId} AND repost_of_intake_id = ${row.id}
        UNION ALL SELECT 1 FROM payment_reconciliation_proposals WHERE tenant_id = ${ctx.tenantId} AND payment_intake_id = ${row.id}
        UNION ALL SELECT 1 FROM payment_reconciliation_groups WHERE tenant_id = ${ctx.tenantId} AND (payment_intake_id = ${row.id} OR posted_intake_id = ${row.id})
        UNION ALL SELECT 1 FROM payment_allocation_correction_previews WHERE tenant_id = ${ctx.tenantId} AND payment_intake_id = ${row.id}
        UNION ALL SELECT 1 FROM payment_allocation_correction_groups WHERE tenant_id = ${ctx.tenantId} AND payment_intake_id = ${row.id}
        UNION ALL SELECT 1 FROM intermediary_collections WHERE tenant_id = ${ctx.tenantId} AND posted_payment_intake_id = ${row.id}
        LIMIT 1`);
    if (dependency.length) throw new DomainError("PAYMENT_CANCEL_DEPENDENCY_REQUIRED", "This intake has a linked workflow and must be cancelled by its owning workflow", 409);
}
async function snapshot(executor: Executor, row: Intake) {
    const proposal = await executor.query.paymentMatchProposals.findFirst({ where: and(eq(paymentMatchProposals.tenantId, row.tenantId), eq(paymentMatchProposals.paymentIntakeId, row.id)), orderBy: [desc(paymentMatchProposals.version)] });
    const membership = await executor.select({ batchPublicId: paymentBatches.publicId, revision: paymentBatches.version }).from(paymentBatchItems).innerJoin(paymentBatches, and(eq(paymentBatches.tenantId, paymentBatchItems.tenantId), eq(paymentBatches.id, paymentBatchItems.batchId))).where(and(eq(paymentBatchItems.tenantId, row.tenantId), eq(paymentBatchItems.paymentIntakeId, row.id))).limit(1);
    const value = { status: row.status, updatedAt: row.updatedAt.toISOString(), proposal: proposal ? { version: proposal.version, status: proposal.status, proposalHash: proposal.proposalHash } : null, batch: membership[0] ?? null };
    return { hash: createHash("sha256").update(JSON.stringify(value)).digest("hex"), batch: membership[0]?.batchPublicId ?? null };
}
function result(row: Intake, cancellationPublicId: string, auditPublicId: string, correlationId: string, reason: string, cancelledAt: Date) {
    return { paymentIntakePublicId: row.publicId, status: "cancelled" as const, reason, cancelledAt: cancelledAt.toISOString(), cancellationPublicId, auditPublicId, correlationId };
}

export async function getPaymentCancellationCapability(ctx: CommandContext, publicId: string, executor: Executor = db) {
    const { row, user } = await accessible(ctx, publicId, executor);
    const state = await snapshot(executor, row);
    const role = user.role ?? "viewer";
    const allowedRole =
        (role === "owner" || role === "manager" || role === "collector") &&
        (canAccessTenantWideData({ role }) || row.ownerUserId === user.id);
    let blockedReason: string | null = null;
    if (!allowedRole) blockedReason = "PAYMENT_CANCEL_FORBIDDEN";
    else if (state.batch) blockedReason = "PAYMENT_CANCEL_BATCH_REQUIRED";
    else if (!eligible.has(row.status)) blockedReason = row.status === "posted" ? "PAYMENT_REVERSE_REQUIRED" : "PAYMENT_CANCEL_NOT_ALLOWED";
    else {
        try { await assertCancellationDependencies(executor, ctx, row); }
        catch (error) { if (error instanceof DomainError) blockedReason = error.code; else throw error; }
    }
    return { allowed: !blockedReason, stateHash: state.hash, blockedReason, batchPublicId: state.batch };
}

export async function getPaymentRestoreCancellationCapability(
    ctx: CommandContext,
    publicId: string,
    validateRestoreDraft: (executor: Executor, ctx: CommandContext, row: Intake) => Promise<unknown>,
    executor: Executor = db,
) {
    const { row, user } = await accessible(ctx, publicId, executor);
    const state = await snapshot(executor, row);
    const role = user.role ?? "viewer";
    const allowedRole = (role === "owner" || role === "manager" || role === "collector")
        && (canAccessTenantWideData({ role }) || row.ownerUserId === user.id);
    let blockedReason: string | null = null;
    if (row.repostOfIntakeId === null) blockedReason = "PAYMENT_RESTORE_CANCEL_NOT_RESTORE_DRAFT";
    else if (!allowedRole) blockedReason = "PAYMENT_CANCEL_FORBIDDEN";
    else if (state.batch) blockedReason = "PAYMENT_CANCEL_BATCH_REQUIRED";
    else if (row.status !== "draft") blockedReason = row.status === "posted" ? "PAYMENT_REVERSE_REQUIRED" : "PAYMENT_CANCEL_NOT_ALLOWED";
    else {
        try {
            await assertCancellationDependencies(executor, ctx, row, true);
            await validateRestoreDraft(executor, ctx, row);
        } catch (error) {
            if (error instanceof DomainError) blockedReason = error.code;
            else throw error;
        }
    }
    return { allowed: !blockedReason, stateHash: state.hash, blockedReason };
}

export type NormalizedPaymentCancellationRequest = {
    reason: string;
    idempotencyKey: string;
    expectedStateHash: string;
    requestHash: string;
};

export type PaymentCancellationGuard = (tx: Executor, ctx: CommandContext, current: Intake) => Promise<void>;

/**
 * Shared mutation kernel. Callers that already own the canonical borrower,
 * batch and intake locks use this to keep single and batch cancellation equal.
 */
export async function cancelLockedPaymentIntake(
    ctx: CommandContext,
    tx: Executor,
    current: Intake,
    request: NormalizedPaymentCancellationRequest,
    batchPublicId: string | null = null,
    guard: PaymentCancellationGuard = async (tx, guardCtx, current) => assertCancellationDependencies(tx, guardCtx, current),
) {
    const user = await actor(ctx, tx);
    assertMutationRole(user, current);
    const membership = await tx.select({ batchPublicId: paymentBatches.publicId, batchId: paymentBatches.id, batchStatus: paymentBatches.status, batchVersion: paymentBatches.version })
        .from(paymentBatchItems).innerJoin(paymentBatches, and(eq(paymentBatches.tenantId, paymentBatchItems.tenantId), eq(paymentBatches.id, paymentBatchItems.batchId)))
        .where(and(eq(paymentBatchItems.tenantId, ctx.tenantId), eq(paymentBatchItems.paymentIntakeId, current.id))).limit(1);
    if (membership.length && membership[0]!.batchPublicId !== batchPublicId) {
        throw new DomainError("PAYMENT_CANCEL_BATCH_REQUIRED", "Cancel the containing payment batch instead", 409, { batchPublicId: membership[0]!.batchPublicId });
    }
    const state = await snapshot(tx, current);
    if (state.hash !== request.expectedStateHash && !batchPublicId) throw new DomainError("PAYMENT_CANCEL_STALE", "Payment intake changed; inspect it again before cancelling", 409);
    if (!eligible.has(current.status)) {
        if (current.status === "posted") throw new DomainError("PAYMENT_CANCEL_NOT_ALLOWED", "Posted payments must use the existing reversal workflow", 409, { action: "reverse" });
        throw new DomainError("PAYMENT_CANCEL_NOT_ALLOWED", "This payment intake cannot be cancelled", 409);
    }
    await guard(tx, ctx, current);
    const now = new Date();
    const audit = await createAuditLog(tx, { tenantId: ctx.tenantId, actorUserId: ctx.actorUserId, actorSource: ctx.actorSource, requestId: ctx.requestId, correlationId: ctx.correlationId, entityType: "payment_intake", entityId: current.publicId, action: "cancelled", payload: { reason: request.reason, originalStatus: current.status, cancellationRequestHash: request.requestHash } });
    const cancelled = await tx.update(paymentIntakes).set({ status: "cancelled", cancellationReason: request.reason, cancelledAt: now, cancelledByUserId: ctx.actorUserId, cancellationActorSource: ctx.actorSource, cancellationRequestId: ctx.requestId, cancellationCorrelationId: ctx.correlationId, cancellationIdempotencyKey: request.idempotencyKey, cancellationRequestHash: request.requestHash, cancellationAuditPublicId: audit.publicId, updatedByUserId: ctx.actorUserId, updatedAt: now }).where(and(eq(paymentIntakes.tenantId, ctx.tenantId), eq(paymentIntakes.id, current.id))).returning().then((rows: Intake[]) => rows[0]!);
    await tx.update(paymentMatchProposals).set({ status: "stale", updatedByUserId: ctx.actorUserId, updatedAt: now }).where(and(eq(paymentMatchProposals.tenantId, ctx.tenantId), eq(paymentMatchProposals.paymentIntakeId, current.id), eq(paymentMatchProposals.status, "ready")));
    await tx.update(paymentReconciliationProposals).set({ status: "expired" }).where(and(eq(paymentReconciliationProposals.tenantId, ctx.tenantId), eq(paymentReconciliationProposals.paymentIntakeId, current.id), eq(paymentReconciliationProposals.status, "ready")));
    const cancellationPublicId = crypto.randomUUID();
    const final = result(cancelled, cancellationPublicId, audit.publicId, ctx.correlationId, request.reason, now);
    await tx.insert(paymentIntakeCancellations).values({ publicId: cancellationPublicId, tenantId: ctx.tenantId, paymentIntakeId: current.id, operationKey: request.idempotencyKey, requestHash: request.requestHash, reason: request.reason, originalStatus: current.status, actorUserId: ctx.actorUserId, actorSource: ctx.actorSource, requestId: ctx.requestId, correlationId: ctx.correlationId, auditPublicId: audit.publicId, originalResult: final });
    return final;
}

type RestoreDraftValidator = (executor: Executor, ctx: CommandContext, row: Intake) => Promise<number>;

async function cancelPaymentIntakeInternal(
    ctx: CommandContext,
    publicId: string,
    input: { reason: string; idempotencyKey: string; expectedStateHash: string },
    executor: Executor | undefined,
    restoreDraftValidator: RestoreDraftValidator | null,
) {
    const reason = normalizeReason(input.reason);
    const key = requireKey(input.idempotencyKey);
    if (!input.expectedStateHash || !/^[0-9a-f]{64}$/iu.test(input.expectedStateHash)) throw new DomainError("PAYMENT_CANCEL_STALE", "A current cancellation state hash is required", 409);
    const run = async (tx: Executor) => {
        const found = await accessible(ctx, publicId, tx);
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`payment-intake-cancel:${ctx.tenantId}:${key}`}, 0))`);
        const existingKey = await tx.query.paymentIntakeCancellations.findFirst({ where: and(eq(paymentIntakeCancellations.tenantId, ctx.tenantId), eq(paymentIntakeCancellations.operationKey, key)) });
        const expectedHash = requestHash(publicId, reason, key, input.expectedStateHash);
        if (existingKey) {
            const current = await tx.query.paymentIntakes.findFirst({ where: and(eq(paymentIntakes.tenantId, ctx.tenantId), eq(paymentIntakes.id, existingKey.paymentIntakeId)) });
            if (!current) throw new DomainError("PAYMENT_INTAKE_NOT_FOUND", "Payment intake not found", 404);
            const user = await actor(ctx, tx);
            assertMutationRole(user, current);
            if (existingKey.paymentIntakeId !== found.row.id || existingKey.requestHash !== expectedHash) throw new DomainError("IDEMPOTENCY_CONFLICT", "Idempotency key was used with a different cancellation request", 409);
            return existingKey.originalResult;
        }
        let sourceId: number | null = null;
        if (restoreDraftValidator) {
            if (found.row.status !== "draft" || found.row.repostOfIntakeId === null) throw new DomainError("PAYMENT_RESTORE_CANCEL_NOT_ALLOWED", "Only an unposted restore draft can be cancelled by this workflow", 409);
            sourceId = await restoreDraftValidator(tx, ctx, found.row);
        }
        const intakeIds = [found.row.id, ...(sourceId === null ? [] : [sourceId])];
        const borrowerIds = (await Promise.all(intakeIds.map((intakeId) => paymentIntakeBorrowerIds(tx, ctx.tenantId, intakeId)))).flat();
        await lockPaymentBorrowers(tx, ctx.tenantId, borrowerIds);
        await tx.execute(sql`SELECT b.id FROM payment_batches b
            JOIN payment_batch_items bi ON bi.tenant_id = b.tenant_id AND bi.batch_id = b.id
            WHERE b.tenant_id = ${ctx.tenantId} AND bi.payment_intake_id = ${found.row.id}
            ORDER BY b.id FOR UPDATE OF b`);
        const lockedIntakeIds = [...new Set(intakeIds)].sort((left, right) => left - right);
        await tx.execute(sql`SELECT id FROM payment_intakes WHERE tenant_id = ${ctx.tenantId} AND id IN (${sql.join(lockedIntakeIds.map((intakeId) => sql`${intakeId}`), sql`, `)}) ORDER BY id FOR UPDATE`);
        const current = await tx.query.paymentIntakes.findFirst({ where: and(eq(paymentIntakes.tenantId, ctx.tenantId), eq(paymentIntakes.id, found.row.id)) });
        if (!current) throw new DomainError("PAYMENT_INTAKE_NOT_FOUND", "Payment intake not found", 404);
        const currentUser = await actor(ctx, tx);
        assertMutationRole(currentUser, current);
        const lockedBorrowerIds = (await Promise.all(intakeIds.map((intakeId) => paymentIntakeBorrowerIds(tx, ctx.tenantId, intakeId)))).flat();
        if (lockedBorrowerIds.length !== borrowerIds.length || lockedBorrowerIds.some((id) => !borrowerIds.includes(id))) throw new DomainError("PAYMENT_CANCEL_STALE", "Payment borrower mapping changed; inspect it again before cancelling", 409);
        const state = await snapshot(tx, current);
        if (state.hash !== input.expectedStateHash) throw new DomainError("PAYMENT_CANCEL_STALE", "Payment intake changed; inspect it again before cancelling", 409);
        if (state.batch) throw new DomainError("PAYMENT_CANCEL_BATCH_REQUIRED", "Cancel the containing payment batch instead", 409, { batchPublicId: state.batch });
        if (restoreDraftValidator) {
            if (current.status !== "draft" || current.repostOfIntakeId === null) throw new DomainError("PAYMENT_RESTORE_CANCEL_NOT_ALLOWED", "Only an unposted restore draft can be cancelled by this workflow", 409);
            const lockedSourceId = await restoreDraftValidator(tx, ctx, current);
            if (lockedSourceId !== sourceId) throw new DomainError("PAYMENT_CANCEL_STALE", "Restore source changed; inspect it again before cancelling", 409);
        }
        const guard: PaymentCancellationGuard = restoreDraftValidator
            ? async (guardTx, guardCtx, guardRow) => {
                await assertCancellationDependencies(guardTx, guardCtx, guardRow, true);
                const lockedSourceId = await restoreDraftValidator(guardTx, guardCtx, guardRow);
                if (lockedSourceId !== sourceId) throw new DomainError("PAYMENT_CANCEL_STALE", "Restore source changed; inspect it again before cancelling", 409);
            }
            : async (guardTx, guardCtx, guardRow) => assertCancellationDependencies(guardTx, guardCtx, guardRow);
        return cancelLockedPaymentIntake(ctx, tx, current, { reason, idempotencyKey: key, expectedStateHash: input.expectedStateHash, requestHash: expectedHash }, null, guard);
    };
    return executor ? run(executor) : db.transaction(run);
}

export async function cancelPaymentIntake(ctx: CommandContext, publicId: string, input: { reason: string; idempotencyKey: string; expectedStateHash: string }, executor?: Executor) {
    return cancelPaymentIntakeInternal(ctx, publicId, input, executor, null);
}

export async function cancelPaymentRestoreIntake(
    ctx: CommandContext,
    publicId: string,
    input: { reason: string; idempotencyKey: string; expectedStateHash: string },
    validateRestoreDraft: RestoreDraftValidator,
    executor?: Executor,
) {
    return cancelPaymentIntakeInternal(ctx, publicId, input, executor, validateRestoreDraft);
}
