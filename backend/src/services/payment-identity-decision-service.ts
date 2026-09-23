import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db, type DbExecutor } from "../db";
import { paymentIdentityDecisionPreviews, paymentIdentityDecisions, paymentIntakes, users } from "../db/schema";
import { createAuditLog } from "../lib/audit-log";
import type { CommandContext } from "./command-context";
import { DomainError } from "./domain-error";
import { lockPaymentWorkflowIdentity } from "./payment-workflow-locks";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const operators = new Set(["owner", "manager", "collector"]);

async function requireOperator(ctx: CommandContext, tx: DbExecutor) {
    const user = ctx.actorUserId === null ? null : await tx.query.users.findFirst({ where: and(eq(users.tenantId, ctx.tenantId), eq(users.id, ctx.actorUserId)) });
    if (!user || !operators.has(user.role ?? "viewer")) throw new DomainError("PAYMENT_IDENTITY_DECISION_FORBIDDEN", "Only a financial operator may decide payment identity", 403);
    return user;
}

export async function previewPaymentIdentityDecision(ctx: CommandContext, input: { participantPaymentIntakePublicIds: string[]; decision: "same_payment" | "distinct_payment"; reason: string; idempotencyKey: string }, executor?: DbExecutor) {
    const run = async (tx: DbExecutor) => {
        await requireOperator(ctx, tx);
        const participantPublicIds = [...new Set(input.participantPaymentIntakePublicIds)].sort();
        if (participantPublicIds.length < 2 || !input.reason?.trim() || !input.idempotencyKey?.trim()) throw new DomainError("PAYMENT_IDENTITY_DECISION_INVALID", "At least two participants, a reason, and an idempotency key are required", 400);
        await lockPaymentWorkflowIdentity(ctx, tx, participantPublicIds);
        const rows = await tx.query.paymentIntakes.findMany({ where: and(eq(paymentIntakes.tenantId, ctx.tenantId), inArray(paymentIntakes.publicId, participantPublicIds)) });
        if (rows.length !== participantPublicIds.length) throw new DomainError("PAYMENT_INTAKE_NOT_FOUND", "Every payment participant must belong to the tenant", 404);
        const snapshots = rows.map((row) => ({ publicId: row.publicId, amount: row.amount, payerName: row.payerName, receivedAt: row.receivedAt.toISOString(), bankReferenceHash: row.bankReferenceHash, qrPayloadHash: row.qrPayloadHash, status: row.status })).sort((a, b) => a.publicId.localeCompare(b.publicId));
        if (input.decision === "distinct_payment" && snapshots.some((row) => row.bankReferenceHash || row.qrPayloadHash)) throw new DomainError("PAYMENT_IDENTITY_HARD_CONFLICT", "Hard payment identity prevents a distinct decision", 409);
        const participantSnapshotHash = digest(snapshots);
        const previewHash = digest({ participantPublicIds, participantSnapshotHash, decision: input.decision, reason: input.reason.trim() });
        const existing = await tx.query.paymentIdentityDecisionPreviews.findFirst({ where: and(eq(paymentIdentityDecisionPreviews.tenantId, ctx.tenantId), eq(paymentIdentityDecisionPreviews.idempotencyKey, input.idempotencyKey.trim())) });
        if (existing) { if (existing.previewHash !== previewHash) throw new DomainError("IDEMPOTENCY_CONFLICT", "Idempotency key was used for a different identity preview", 409); return { identityDecisionPreviewPublicId: existing.publicId, previewHash: existing.previewHash, participantSnapshotHash: existing.participantSnapshotHash, participantPaymentIntakePublicIds: participantPublicIds, decision: existing.decision as typeof input.decision, expiresAt: existing.expiresAt.toISOString(), correlationId: existing.correlationId }; }
        const preview = await tx.insert(paymentIdentityDecisionPreviews).values({ tenantId: ctx.tenantId, participantPublicIds, participantSnapshotHash, decision: input.decision, reason: input.reason.trim(), previewHash, expiresAt: new Date(Date.now() + 15 * 60 * 1000), requestId: ctx.requestId, correlationId: ctx.correlationId, idempotencyKey: input.idempotencyKey.trim(), createdByUserId: ctx.actorUserId! }).returning().then((rows) => rows[0]!);
        return { identityDecisionPreviewPublicId: preview.publicId, previewHash, participantSnapshotHash, participantPaymentIntakePublicIds: participantPublicIds, decision: input.decision, expiresAt: preview.expiresAt.toISOString(), correlationId: ctx.correlationId };
    };
    return executor ? run(executor) : db.transaction(run);
}

export async function executePaymentIdentityDecision(ctx: CommandContext, input: { identityDecisionPreviewPublicId: string; previewHash: string; confirmed: true; reason: string; idempotencyKey: string }, executor?: DbExecutor) {
    const run = async (tx: DbExecutor) => {
        const user = await requireOperator(ctx, tx);
        const preview = await tx.query.paymentIdentityDecisionPreviews.findFirst({ where: and(eq(paymentIdentityDecisionPreviews.tenantId, ctx.tenantId), eq(paymentIdentityDecisionPreviews.publicId, input.identityDecisionPreviewPublicId)) });
        if (!preview) throw new DomainError("PAYMENT_IDENTITY_PREVIEW_NOT_FOUND", "Identity decision preview not found", 404);
        await lockPaymentWorkflowIdentity(ctx, tx, preview.participantPublicIds);
        const requestHash = digest({ preview: input.identityDecisionPreviewPublicId, previewHash: input.previewHash, reason: input.reason.trim(), idempotencyKey: input.idempotencyKey.trim() });
        const existing = await tx.query.paymentIdentityDecisions.findFirst({ where: and(eq(paymentIdentityDecisions.tenantId, ctx.tenantId), eq(paymentIdentityDecisions.idempotencyKey, input.idempotencyKey.trim())) });
        if (existing) return { decisionPublicId: existing.publicId, auditPublicId: existing.auditPublicId, correlationId: existing.correlationId, decision: existing.decision };
        if (input.confirmed !== true || preview.previewHash !== input.previewHash || preview.expiresAt.getTime() <= Date.now() || preview.reason !== input.reason.trim()) throw new DomainError("PAYMENT_IDENTITY_PREVIEW_STALE", "Fresh identity preview confirmation is required", 409);
        const current = await tx.query.paymentIntakes.findMany({ where: and(eq(paymentIntakes.tenantId, ctx.tenantId), inArray(paymentIntakes.publicId, preview.participantPublicIds)) });
        const snapshotHash = digest(current.map((row) => ({ publicId: row.publicId, amount: row.amount, payerName: row.payerName, receivedAt: row.receivedAt.toISOString(), bankReferenceHash: row.bankReferenceHash, qrPayloadHash: row.qrPayloadHash, status: row.status })).sort((a, b) => a.publicId.localeCompare(b.publicId)));
        if (snapshotHash !== preview.participantSnapshotHash) throw new DomainError("PAYMENT_IDENTITY_PREVIEW_STALE", "Payment participants changed; preview again", 409);
        const audit = await createAuditLog(tx, { tenantId: ctx.tenantId, actorUserId: user.id, actorSource: ctx.actorSource, requestId: ctx.requestId, correlationId: ctx.correlationId, entityType: "payment_identity_decision", entityId: preview.publicId, action: "executed", payload: { decision: preview.decision, participantPaymentIntakePublicIds: preview.participantPublicIds, previewHash: preview.previewHash, requestHash } });
        const decision = await tx.insert(paymentIdentityDecisions).values({ tenantId: ctx.tenantId, decision: preview.decision, reason: input.reason.trim(), participantPublicIds: preview.participantPublicIds, participantSnapshotHash: preview.participantSnapshotHash, requestId: ctx.requestId, correlationId: ctx.correlationId, idempotencyKey: input.idempotencyKey.trim(), auditPublicId: audit.publicId, createdByUserId: user.id }).returning().then((rows) => rows[0]!);
        return { decisionPublicId: decision.publicId, auditPublicId: audit.publicId, correlationId: ctx.correlationId, decision: decision.decision };
    };
    return executor ? run(executor) : db.transaction(run);
}

/** Compatibility reader used by duplicate detection; historical duplicate-review rows remain authoritative too. */
export async function identityDecisionAuthorizesPair(ctx: CommandContext, firstPublicId: string, secondPublicId: string, executor: DbExecutor = db) {
    const rows = await executor.select({ decision: paymentIdentityDecisions.decision, participants: paymentIdentityDecisions.participantPublicIds }).from(paymentIdentityDecisions).where(eq(paymentIdentityDecisions.tenantId, ctx.tenantId));
    return rows.some((row) => row.participants.includes(firstPublicId) && row.participants.includes(secondPublicId));
}
