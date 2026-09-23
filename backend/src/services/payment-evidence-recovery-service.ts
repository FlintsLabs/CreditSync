import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, type DbExecutor } from "../db";
import { financialEvidenceRequirements, paymentEvidenceRecoveryExecutions, paymentEvidenceRecoveryPreviews, paymentIntakes, paymentReplacementEvidenceReferences, paymentReplacementLineages, users } from "../db/schema";
import { canAccessTenantWideData } from "../lib/access";
import { createAuditLog } from "../lib/audit-log";
import type { CommandContext } from "./command-context";
import { DomainError } from "./domain-error";
import { countAuthoritativeEvidenceAttempts, registerFinancialEvidenceRequirement } from "./financial-evidence-requirement-service";
import { effectivePaymentEvidence } from "./payment-effective-evidence-service";
import { lockPaymentWorkflowIdentity, withPaymentWorkflowTransaction } from "./payment-workflow-locks";

const operators = new Set(["owner", "manager", "collector"]);
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function requireActor(ctx: CommandContext, tx: DbExecutor) {
    const actor = ctx.actorUserId === null ? null : await tx.query.users.findFirst({ where: and(eq(users.tenantId, ctx.tenantId), eq(users.id, ctx.actorUserId)) });
    if (!actor || !operators.has(actor.role ?? "viewer")) throw new DomainError("PAYMENT_EVIDENCE_RECOVERY_FORBIDDEN", "Only a financial operator may recover payment evidence", 403);
    return actor;
}

async function sourceFor(ctx: CommandContext, sourcePublicId: string, tx: DbExecutor) {
    const actor = await requireActor(ctx, tx);
    const source = await tx.query.paymentIntakes.findFirst({ where: and(eq(paymentIntakes.tenantId, ctx.tenantId), eq(paymentIntakes.publicId, sourcePublicId)) });
    if (!source || (!canAccessTenantWideData({ role: actor.role ?? "viewer" }) && source.ownerUserId !== actor.id)) throw new DomainError("PAYMENT_INTAKE_NOT_FOUND", "Payment intake not found", 404);
    if (source.status !== "cancelled" || source.postedAt !== null || source.repostOfIntakeId !== null) throw new DomainError("PAYMENT_EVIDENCE_RECOVERY_SOURCE_INVALID", "Only an accessible cancelled, never-posted intake can start evidence recovery", 409);
    return { actor, source };
}

async function sourceState(ctx: CommandContext, source: typeof paymentIntakes.$inferSelect, tx: DbExecutor) {
    const evidence = (await effectivePaymentEvidence(ctx.tenantId, [source.id], tx)).get(source.id) ?? [];
    const requirement = await tx.query.financialEvidenceRequirements.findFirst({ where: and(eq(financialEvidenceRequirements.tenantId, ctx.tenantId), eq(financialEvidenceRequirements.paymentIntakeId, source.id)) });
    const attempts = requirement ? await countAuthoritativeEvidenceAttempts(tx, ctx.tenantId, requirement.id, { kind: "payment", paymentIntakeId: source.id }) : 0;
    const readyIds = evidence.filter((item) => item.status === "ready" && item.finalizedAt !== null && item.fileId !== null).map((item) => item.sourceEvidenceId).filter((id) => id > 0).sort((a, b) => a - b);
    const floor = Math.max(requirement?.expectedCount ?? 0, evidence.length, attempts, source.evidenceRequired ? 1 : 0);
    const stateHash = digest({ status: source.status, updatedAt: source.updatedAt.toISOString(), cancelledAt: source.cancelledAt?.toISOString() ?? null, requirement: requirement?.publicId ?? null, expectedCount: requirement?.expectedCount ?? 0, attempts, evidence: evidence.map((item) => ({ id: item.sourceEvidenceId, status: item.status, finalizedAt: item.finalizedAt?.toISOString() ?? null, fileId: item.fileId })).sort((a, b) => a.id - b.id) });
    return { evidence, readyIds, floor, stateHash };
}

export type PaymentEvidenceRecoveryPreviewInput = { sourcePaymentIntakePublicId: string; reason: string; expectedCount: number; reuseEvidence: boolean; idempotencyKey: string };

async function existingSuccessor(ctx: CommandContext, sourceId: number, tx: DbExecutor) {
    const lineage = await tx.query.paymentReplacementLineages.findFirst({ where: and(eq(paymentReplacementLineages.tenantId, ctx.tenantId), eq(paymentReplacementLineages.sourcePaymentIntakeId, sourceId)) });
    if (!lineage) return null;
    return (await tx.query.paymentIntakes.findFirst({ where: and(eq(paymentIntakes.tenantId, ctx.tenantId), eq(paymentIntakes.id, lineage.replacementPaymentIntakeId)) }))?.publicId ?? null;
}

export async function previewPaymentEvidenceRecovery(ctx: CommandContext, input: PaymentEvidenceRecoveryPreviewInput, executor?: DbExecutor) {
    const run = async (tx: DbExecutor) => {
        if (!input.reason?.trim() || !Number.isInteger(input.expectedCount) || input.expectedCount < 1 || input.expectedCount > 20 || !input.idempotencyKey?.trim()) throw new DomainError("PAYMENT_EVIDENCE_RECOVERY_INVALID", "A reason, expected slot count, and idempotency key are required", 400);
        const { source } = await sourceFor(ctx, input.sourcePaymentIntakePublicId, tx);
        await lockPaymentWorkflowIdentity(ctx, tx, [source.publicId]);
        const state = await sourceState(ctx, source, tx);
        if (input.expectedCount < state.floor) throw new DomainError("PAYMENT_EVIDENCE_RECOVERY_REQUIREMENT_FLOOR", "Recovery cannot reduce the source evidence requirement", 409, { requirementFloor: state.floor });
        const requestHash = digest({ sourcePaymentIntakePublicId: source.publicId, reason: input.reason.trim(), expectedCount: input.expectedCount, reuseEvidence: input.reuseEvidence === true, idempotencyKey: input.idempotencyKey.trim() });
        const previewHash = digest({ requestHash, sourceStateHash: state.stateHash, reusableEvidenceIds: input.reuseEvidence ? state.readyIds : [], requirementFloor: state.floor });
        const existing = await tx.query.paymentEvidenceRecoveryPreviews.findFirst({ where: and(eq(paymentEvidenceRecoveryPreviews.tenantId, ctx.tenantId), eq(paymentEvidenceRecoveryPreviews.idempotencyKey, input.idempotencyKey.trim())) });
        if (existing) {
            if (existing.requestHash !== requestHash || existing.sourceStateHash !== state.stateHash) throw new DomainError("IDEMPOTENCY_CONFLICT", "Idempotency key was used for a different recovery request or changed source", 409);
            return { recoveryPreviewPublicId: existing.publicId, previewHash: existing.previewHash, sourcePaymentIntakePublicId: source.publicId, requirementFloor: existing.requirementFloor, expectedCount: existing.expectedCount, reusableEvidenceCount: existing.reusableEvidenceIds.length, existingSuccessorPaymentIntakePublicId: await existingSuccessor(ctx, source.id, tx), expiresAt: existing.expiresAt.toISOString(), auditPublicId: existing.auditPublicId, correlationId: existing.correlationId };
        }
        const successor = await existingSuccessor(ctx, source.id, tx);
        const audit = await createAuditLog(tx, { tenantId: ctx.tenantId, actorUserId: ctx.actorUserId, actorSource: ctx.actorSource, requestId: ctx.requestId, correlationId: ctx.correlationId, entityType: "payment_evidence_recovery_preview", entityId: source.publicId, action: "previewed", payload: { sourcePaymentIntakePublicId: source.publicId, requirementFloor: state.floor, expectedCount: input.expectedCount, reuseEvidence: input.reuseEvidence === true, reusableEvidenceCount: state.readyIds.length, existingSuccessorPaymentIntakePublicId: successor } });
        const preview = await tx.insert(paymentEvidenceRecoveryPreviews).values({ tenantId: ctx.tenantId, sourcePaymentIntakeId: source.id, reason: input.reason.trim(), expectedCount: input.expectedCount, requirementFloor: state.floor, sourceStateHash: state.stateHash, reusableEvidenceIds: input.reuseEvidence ? state.readyIds : [], reuseEvidence: input.reuseEvidence === true, previewHash, requestHash, auditPublicId: audit.publicId, expiresAt: new Date(Date.now() + 15 * 60 * 1000), requestId: ctx.requestId, correlationId: ctx.correlationId, idempotencyKey: input.idempotencyKey.trim(), createdByUserId: ctx.actorUserId! }).returning().then((rows) => rows[0]!);
        return { recoveryPreviewPublicId: preview.publicId, previewHash, sourcePaymentIntakePublicId: source.publicId, requirementFloor: state.floor, expectedCount: input.expectedCount, reusableEvidenceCount: state.readyIds.length, existingSuccessorPaymentIntakePublicId: successor, expiresAt: preview.expiresAt.toISOString(), auditPublicId: audit.publicId, correlationId: ctx.correlationId };
    };
    return executor ? run(executor) : withPaymentWorkflowTransaction(run);
}

export async function executePaymentEvidenceRecovery(ctx: CommandContext, input: { recoveryPreviewPublicId: string; previewHash: string; confirmed: true; reason: string; idempotencyKey: string }, executor?: DbExecutor) {
    const run = async (tx: DbExecutor) => {
        const actor = await requireActor(ctx, tx);
        const preview = await tx.query.paymentEvidenceRecoveryPreviews.findFirst({ where: and(eq(paymentEvidenceRecoveryPreviews.tenantId, ctx.tenantId), eq(paymentEvidenceRecoveryPreviews.publicId, input.recoveryPreviewPublicId)) });
        if (!preview) throw new DomainError("PAYMENT_EVIDENCE_RECOVERY_PREVIEW_NOT_FOUND", "Recovery preview not found", 404);
        const requestHash = digest({ recoveryPreviewPublicId: input.recoveryPreviewPublicId, previewHash: input.previewHash, reason: input.reason.trim(), idempotencyKey: input.idempotencyKey.trim() });
        const existing = await tx.query.paymentEvidenceRecoveryExecutions.findFirst({ where: and(eq(paymentEvidenceRecoveryExecutions.tenantId, ctx.tenantId), eq(paymentEvidenceRecoveryExecutions.idempotencyKey, input.idempotencyKey.trim())) });
        if (existing) {
            if (existing.requestHash !== requestHash) throw new DomainError("IDEMPOTENCY_CONFLICT", "Idempotency key was used for a different recovery execution", 409);
            const lineage = await tx.query.paymentReplacementLineages.findFirst({ where: and(eq(paymentReplacementLineages.tenantId, ctx.tenantId), eq(paymentReplacementLineages.id, existing.lineageId)) });
            const child = lineage ? await tx.query.paymentIntakes.findFirst({ where: and(eq(paymentIntakes.tenantId, ctx.tenantId), eq(paymentIntakes.id, lineage.replacementPaymentIntakeId)) }) : null;
            const source = await tx.query.paymentIntakes.findFirst({ where: and(eq(paymentIntakes.tenantId, ctx.tenantId), eq(paymentIntakes.id, existing.sourcePaymentIntakeId)) });
            if (!child || !source) throw new DomainError("PAYMENT_EVIDENCE_RECOVERY_RECEIPT_INVALID", "Recovery receipt has no successor", 500);
            return { sourcePaymentIntakePublicId: source.publicId, recoveryIntakePublicId: child.publicId, status: child.status, resumed: true, auditPublicId: existing.auditPublicId, correlationId: existing.correlationId, executionPublicId: existing.publicId };
        }
        if (input.confirmed !== true || preview.previewHash !== input.previewHash || preview.reason !== input.reason.trim() || preview.expiresAt.getTime() <= Date.now()) throw new DomainError("PAYMENT_EVIDENCE_RECOVERY_PREVIEW_STALE", "Fresh confirmed recovery preview is required", 409);
        const source = await tx.query.paymentIntakes.findFirst({ where: and(eq(paymentIntakes.tenantId, ctx.tenantId), eq(paymentIntakes.id, preview.sourcePaymentIntakeId)) });
        if (!source) throw new DomainError("PAYMENT_INTAKE_NOT_FOUND", "Payment intake not found", 404);
        await lockPaymentWorkflowIdentity(ctx, tx, [source.publicId]);
        const state = await sourceState(ctx, source, tx);
        if (state.stateHash !== preview.sourceStateHash || preview.expectedCount < state.floor) throw new DomainError("PAYMENT_EVIDENCE_RECOVERY_PREVIEW_STALE", "Source evidence state changed; preview again", 409);
        const existingLineage = await tx.query.paymentReplacementLineages.findFirst({ where: and(eq(paymentReplacementLineages.tenantId, ctx.tenantId), eq(paymentReplacementLineages.sourcePaymentIntakeId, source.id)) });
        if (existingLineage) throw new DomainError("PAYMENT_EVIDENCE_RECOVERY_SUCCESSOR_EXISTS", "An existing recovery successor must be inspected and continued", 409, { recoveryIntakePublicId: (await tx.query.paymentIntakes.findFirst({ where: and(eq(paymentIntakes.tenantId, ctx.tenantId), eq(paymentIntakes.id, existingLineage.replacementPaymentIntakeId)) }))?.publicId ?? null });
        const audit = await createAuditLog(tx, { tenantId: ctx.tenantId, actorUserId: actor.id, actorSource: ctx.actorSource, requestId: ctx.requestId, correlationId: ctx.correlationId, entityType: "payment_intake", entityId: source.publicId, action: "evidence_recovery_draft_created", payload: { sourcePaymentIntakePublicId: source.publicId, expectedCount: preview.expectedCount, requirementFloor: preview.requirementFloor, reusedEvidenceCount: preview.reusableEvidenceIds.length, previewPublicId: preview.publicId, requestHash } });
        const child = await tx.insert(paymentIntakes).values({ tenantId: ctx.tenantId, ownerUserId: source.ownerUserId, source: source.source, status: "draft", amount: source.amount, receivedAt: source.receivedAt, payerName: source.payerName, warnings: source.warnings, originLoanId: source.originLoanId, replacementOfIntakeId: source.id, evidenceRequired: true, createdByUserId: actor.id, updatedByUserId: actor.id }).returning().then((rows) => rows[0]!);
        const lineage = await tx.insert(paymentReplacementLineages).values({ tenantId: ctx.tenantId, sourcePaymentIntakeId: source.id, replacementPaymentIntakeId: child.id, reason: preview.reason, requestHash, idempotencyKey: input.idempotencyKey.trim(), requestId: ctx.requestId, correlationId: ctx.correlationId, auditPublicId: audit.publicId, bankReferenceHash: source.bankReferenceHash, qrPayloadHash: source.qrPayloadHash, createdByUserId: actor.id }).returning().then((rows) => rows[0]!);
        await registerFinancialEvidenceRequirement(tx, ctx, { kind: "payment_intake", publicId: child.publicId }, preview.expectedCount);
        if (preview.reuseEvidence && preview.reusableEvidenceIds.length) await tx.insert(paymentReplacementEvidenceReferences).values(preview.reusableEvidenceIds.map((sourceEvidenceId) => ({ tenantId: ctx.tenantId, lineageId: lineage.id, replacementPaymentIntakeId: child.id, sourcePaymentIntakeId: source.id, sourceEvidenceId, sourceSupplementId: null })));
        const execution = await tx.insert(paymentEvidenceRecoveryExecutions).values({ tenantId: ctx.tenantId, previewId: preview.id, sourcePaymentIntakeId: source.id, lineageId: lineage.id, requestHash, idempotencyKey: input.idempotencyKey.trim(), auditPublicId: audit.publicId, correlationId: ctx.correlationId }).returning().then((rows) => rows[0]!);
        return { sourcePaymentIntakePublicId: source.publicId, recoveryIntakePublicId: child.publicId, status: child.status, resumed: false, auditPublicId: audit.publicId, correlationId: ctx.correlationId, executionPublicId: execution.publicId, lineagePublicId: lineage.publicId };
    };
    return executor ? run(executor) : withPaymentWorkflowTransaction(run);
}

/** Legacy callers fail closed instead of bypassing confirmation. */
export async function createPaymentEvidenceRecoveryDraft(ctx: CommandContext, input: { sourcePaymentIntakePublicId: string; reason: string; expectedCount: number; idempotencyKey: string }, executor?: DbExecutor) {
    const preview = await previewPaymentEvidenceRecovery(ctx, { ...input, reuseEvidence: false }, executor);
    throw new DomainError("PAYMENT_EVIDENCE_RECOVERY_CONFIRMATION_REQUIRED", "Recovery requires an explicit preview confirmation before creating a successor", 409, { recoveryPreviewPublicId: preview.recoveryPreviewPublicId, previewHash: preview.previewHash });
}
