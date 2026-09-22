import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, type DbExecutor } from "../db";
import { financialEvidenceRequirements, paymentBatches, paymentBatchItems, paymentIntakes, paymentReplacementEvidenceReferences, paymentReplacementLineages, transactions, users } from "../db/schema";
import { canAccessTenantWideData } from "../lib/access";
import { createAuditLog } from "../lib/audit-log";
import type { CommandContext } from "./command-context";
import { DomainError } from "./domain-error";
import { countAuthoritativeEvidenceAttempts, registerFinancialEvidenceRequirement } from "./financial-evidence-requirement-service";
import { effectivePaymentEvidence } from "./payment-effective-evidence-service";
import { assertPaymentReplacementDuplicateSafe, duplicateIdentityLock } from "./payment-duplicate-guard";

type Executor = DbExecutor;
type Intake = typeof paymentIntakes.$inferSelect;
const mutationRoles = new Set(["owner", "manager", "collector"]);

function requestHash(input: { paymentIntakePublicId: string; reason: string; idempotencyKey: string; expectedStateHash: string }) {
    return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}
function stateHash(source: Intake, evidence: Array<{ id: number; status: string; finalizedAt: Date | null; fileId: number | null }>, child: string | null, batch: { publicId: string; status: string; version: number; stateHash: string } | null, expectedCount: number) {
    return createHash("sha256").update(JSON.stringify({ status: source.status, updatedAt: source.updatedAt.toISOString(), cancelledAt: source.cancelledAt?.toISOString() ?? null, evidence: evidence.map((row) => ({ id: row.id, status: row.status, finalizedAt: row.finalizedAt?.toISOString() ?? null, fileId: row.fileId })).sort((a, b) => a.id - b.id), expectedCount, child, batch })).digest("hex");
}
async function actor(ctx: CommandContext, executor: Executor) {
    const user = ctx.actorUserId === null ? null : await executor.query.users.findFirst({ where: and(eq(users.tenantId, ctx.tenantId), eq(users.id, ctx.actorUserId)) });
    if (!user) throw new DomainError("UNAUTHORIZED", "Unauthorized", 401);
    return user;
}
async function accessible(ctx: CommandContext, publicId: string, executor: Executor) {
    const user = await actor(ctx, executor);
    const row = await executor.query.paymentIntakes.findFirst({ where: and(eq(paymentIntakes.tenantId, ctx.tenantId), eq(paymentIntakes.publicId, publicId)) });
    if (!row || (!canAccessTenantWideData({ role: user.role ?? "viewer" }) && row.ownerUserId !== user.id)) throw new DomainError("PAYMENT_INTAKE_NOT_FOUND", "Payment intake not found", 404);
    if (!mutationRoles.has(user.role ?? "viewer") || (!canAccessTenantWideData({ role: user.role ?? "viewer" }) && row.ownerUserId !== user.id)) throw new DomainError("PAYMENT_REPLACEMENT_FORBIDDEN", "You are not authorized to replace this payment", 403);
    return { user, row };
}
async function snapshot(ctx: CommandContext, source: Intake, executor: Executor) {
    const allEvidence = (await effectivePaymentEvidence(ctx.tenantId, [source.id], executor)).get(source.id) ?? [];
    const ready = allEvidence.filter((row) => row.status === "ready" && row.finalizedAt !== null && row.fileId !== null);
    const requirement = await executor.query.financialEvidenceRequirements.findFirst({ where: and(eq(financialEvidenceRequirements.tenantId, ctx.tenantId), eq(financialEvidenceRequirements.paymentIntakeId, source.id)) });
    const attemptCount = requirement ? await countAuthoritativeEvidenceAttempts(executor, ctx.tenantId, requirement.id, { kind: "payment", paymentIntakeId: source.id }) : 0;
    const expectedCount = Math.max(requirement?.expectedCount ?? 0, allEvidence.length, attemptCount, source.evidenceRequired ? 1 : 0);
    const child = await executor.query.paymentReplacementLineages.findFirst({ where: and(eq(paymentReplacementLineages.tenantId, ctx.tenantId), eq(paymentReplacementLineages.sourcePaymentIntakeId, source.id)) });
    const membership = await executor.select({ publicId: paymentBatches.publicId, status: paymentBatches.status, version: paymentBatches.version, stateHash: paymentBatches.stateHash }).from(paymentBatchItems).innerJoin(paymentBatches, and(eq(paymentBatches.tenantId, paymentBatchItems.tenantId), eq(paymentBatches.id, paymentBatchItems.batchId))).where(and(eq(paymentBatchItems.tenantId, ctx.tenantId), eq(paymentBatchItems.paymentIntakeId, source.id))).limit(1);
    return { allEvidence, ready, expectedCount, child, batch: membership[0] ?? null, hash: stateHash(source, allEvidence.map((row) => ({ id: row.sourceEvidenceId, status: row.status, finalizedAt: row.finalizedAt, fileId: row.fileId })), child?.replacementPaymentIntakeId ? String(child.replacementPaymentIntakeId) : null, membership[0] ?? null, expectedCount) };
}

export type ReplacementInspection = { sourcePaymentIntakePublicId: string; allowed: boolean; blockers: string[]; stateHash: string; replacementPaymentIntakePublicId: string | null; lineagePublicId?: string | null };

export async function inspectPaymentReplacement(ctx: CommandContext, sourcePublicId: string, executor: Executor = db): Promise<ReplacementInspection> {
    const { row } = await accessible(ctx, sourcePublicId, executor);
    const snap = await snapshot(ctx, row, executor);
    const blockers: string[] = [];
    if (row.repostOfIntakeId !== null) blockers.push("PAYMENT_REPLACEMENT_RESTORE_WORKFLOW_REQUIRED");
    if (row.status !== "cancelled") blockers.push(row.status === "posted" || row.status === "reversed" ? "PAYMENT_REPLACEMENT_SOURCE_FINANCIAL_STATE" : "PAYMENT_REPLACEMENT_SOURCE_NOT_CANCELLED");
    if (row.postedAt) blockers.push("PAYMENT_REPLACEMENT_SOURCE_POSTED");
    if (!row.cancellationAuditPublicId || !row.cancelledAt) blockers.push("PAYMENT_REPLACEMENT_CANCELLATION_PROVENANCE_REQUIRED");
    if (snap.ready.length < 1) blockers.push("PAYMENT_REPLACEMENT_EVIDENCE_NOT_READY");
    if (snap.expectedCount > 0 && (snap.ready.length !== snap.expectedCount || snap.allEvidence.length !== snap.expectedCount)) blockers.push("PAYMENT_REPLACEMENT_EVIDENCE_INCOMPLETE");
    if (snap.batch && snap.batch.status !== "cancelled") blockers.push("PAYMENT_REPLACEMENT_BATCH_NOT_CANCELLED");
    const dependency = await executor.execute(sql`SELECT 1 FROM transactions WHERE tenant_id = ${ctx.tenantId} AND payment_intake_id = ${row.id}
        UNION ALL SELECT 1 FROM payment_reconciliation_proposals WHERE tenant_id = ${ctx.tenantId} AND payment_intake_id = ${row.id}
        UNION ALL SELECT 1 FROM payment_reconciliation_groups WHERE tenant_id = ${ctx.tenantId} AND payment_intake_id = ${row.id}
        UNION ALL SELECT 1 FROM payment_reconciliation_groups WHERE tenant_id = ${ctx.tenantId} AND posted_intake_id = ${row.id}
        UNION ALL SELECT 1 FROM payment_allocation_correction_groups WHERE tenant_id = ${ctx.tenantId} AND payment_intake_id = ${row.id} LIMIT 1`);
    if (dependency.length) blockers.push("PAYMENT_REPLACEMENT_SOURCE_HAS_FINANCIAL_DEPENDENCY");
    return { sourcePaymentIntakePublicId: row.publicId, allowed: blockers.length === 0 && !snap.child, blockers, stateHash: snap.hash, replacementPaymentIntakePublicId: snap.child ? (await executor.query.paymentIntakes.findFirst({ where: and(eq(paymentIntakes.tenantId, ctx.tenantId), eq(paymentIntakes.id, snap.child.replacementPaymentIntakeId)) }))?.publicId ?? null : null, lineagePublicId: snap.child?.publicId ?? null };
}

export async function createPaymentReplacement(ctx: CommandContext, input: { paymentIntakePublicId: string; reason: string; idempotencyKey: string; expectedStateHash: string }, executor?: Executor) {
    if (!input.reason?.trim() || !input.idempotencyKey?.trim() || !/^[0-9a-f]{64}$/iu.test(input.expectedStateHash)) throw new DomainError("PAYMENT_REPLACEMENT_COMMAND_INVALID", "Reason, idempotency key, and current state hash are required", 400);
    const run = async (tx: Executor) => {
        const { row: source } = await accessible(ctx, input.paymentIntakePublicId, tx);
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`payment-replacement-key:${ctx.tenantId}:${input.idempotencyKey.trim()}`}, 0))`);
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`payment-replacement:${ctx.tenantId}:${source.id}`}, 0))`);
        const hash = requestHash({ paymentIntakePublicId: input.paymentIntakePublicId, reason: input.reason.trim(), idempotencyKey: input.idempotencyKey.trim(), expectedStateHash: input.expectedStateHash });
        const existing = await tx.query.paymentReplacementLineages.findFirst({ where: and(eq(paymentReplacementLineages.tenantId, ctx.tenantId), eq(paymentReplacementLineages.idempotencyKey, input.idempotencyKey.trim())) });
        if (existing) {
            if (existing.requestHash !== hash || existing.sourcePaymentIntakeId !== source.id) throw new DomainError("IDEMPOTENCY_CONFLICT", "Idempotency key was used for a different replacement request", 409);
            const child = await tx.query.paymentIntakes.findFirst({ where: and(eq(paymentIntakes.tenantId, ctx.tenantId), eq(paymentIntakes.id, existing.replacementPaymentIntakeId)) });
            if (!child) throw new DomainError("PAYMENT_REPLACEMENT_RECEIPT_INVALID", "Replacement receipt is incomplete", 500);
            return { sourcePaymentIntakePublicId: source.publicId, replacementPaymentIntakePublicId: child.publicId, status: "draft" as const, auditPublicId: existing.auditPublicId, correlationId: existing.correlationId, lineagePublicId: existing.publicId };
        }
        const current = await tx.query.paymentIntakes.findFirst({ where: and(eq(paymentIntakes.tenantId, ctx.tenantId), eq(paymentIntakes.id, source.id)) });
        if (!current) throw new DomainError("PAYMENT_INTAKE_NOT_FOUND", "Payment intake not found", 404);
        const inspection = await inspectPaymentReplacement(ctx, current.publicId, tx);
        if (inspection.stateHash !== input.expectedStateHash) throw new DomainError("PAYMENT_REPLACEMENT_STALE", "Payment changed; inspect it again before replacing", 409);
        if (inspection.replacementPaymentIntakePublicId) throw new DomainError("PAYMENT_REPLACEMENT_ALREADY_EXISTS", "This cancelled payment already has a replacement; inspect that successor", 409, { replacementPaymentIntakePublicId: inspection.replacementPaymentIntakePublicId });
        if (!inspection.allowed) throw new DomainError(inspection.blockers[0] ?? "PAYMENT_REPLACEMENT_BLOCKED", "Payment replacement is not eligible", 409, { blockers: inspection.blockers });
        await duplicateIdentityLock(ctx, current, tx);
        await assertPaymentReplacementDuplicateSafe(ctx, current, tx, true);
        const evidence = (await effectivePaymentEvidence(ctx.tenantId, [current.id], tx)).get(current.id) ?? [];
        const sourceRequirement = await tx.query.financialEvidenceRequirements.findFirst({ where: and(eq(financialEvidenceRequirements.tenantId, ctx.tenantId), eq(financialEvidenceRequirements.paymentIntakeId, current.id)) });
        const sourceAttemptCount = sourceRequirement ? await countAuthoritativeEvidenceAttempts(tx, ctx.tenantId, sourceRequirement.id, { kind: "payment", paymentIntakeId: current.id }) : 0;
        const parentLineage = await tx.query.paymentReplacementLineages.findFirst({ where: and(eq(paymentReplacementLineages.tenantId, ctx.tenantId), eq(paymentReplacementLineages.replacementPaymentIntakeId, current.id)) });
        const audit = await createAuditLog(tx, { tenantId: ctx.tenantId, actorUserId: ctx.actorUserId, actorSource: ctx.actorSource, requestId: ctx.requestId, correlationId: ctx.correlationId, entityType: "payment_intake", entityId: current.publicId, action: "replacement_draft_created", payload: { sourcePaymentPublicId: current.publicId, reason: input.reason.trim() } });
        const child = await tx.insert(paymentIntakes).values({ tenantId: ctx.tenantId, ownerUserId: current.ownerUserId, source: current.source, status: "draft", amount: current.amount, receivedAt: current.receivedAt, payerName: current.payerName, warnings: current.warnings, originLoanId: current.originLoanId, replacementOfIntakeId: current.id, evidenceRequired: current.evidenceRequired, createdByUserId: ctx.actorUserId, updatedByUserId: ctx.actorUserId }).returning().then((rows) => rows[0]!);
        const lineage = await tx.insert(paymentReplacementLineages).values({ tenantId: ctx.tenantId, sourcePaymentIntakeId: current.id, replacementPaymentIntakeId: child.id, reason: input.reason.trim(), requestHash: hash, idempotencyKey: input.idempotencyKey.trim(), requestId: ctx.requestId, correlationId: ctx.correlationId, auditPublicId: audit.publicId, bankReferenceHash: current.bankReferenceHash ?? parentLineage?.bankReferenceHash ?? null, qrPayloadHash: current.qrPayloadHash ?? parentLineage?.qrPayloadHash ?? null, createdByUserId: ctx.actorUserId }).returning().then((rows) => rows[0]!);
        const expectedCount = Math.max(sourceRequirement?.expectedCount ?? 0, evidence.length, sourceAttemptCount, current.evidenceRequired ? 1 : 0);
        if (expectedCount > 0) await registerFinancialEvidenceRequirement(tx, ctx, { kind: "payment_intake", publicId: child.publicId }, expectedCount);
        if (evidence.length) await tx.insert(paymentReplacementEvidenceReferences).values(evidence.map((item) => item.sourceEvidenceId > 0
            ? { tenantId: ctx.tenantId, lineageId: lineage.id, replacementPaymentIntakeId: child.id, sourcePaymentIntakeId: item.sourceIntakeId, sourceEvidenceId: item.sourceEvidenceId, sourceSupplementId: null }
            : { tenantId: ctx.tenantId, lineageId: lineage.id, replacementPaymentIntakeId: child.id, sourcePaymentIntakeId: item.sourceIntakeId, sourceEvidenceId: null, sourceSupplementId: -item.sourceEvidenceId }));
        return { sourcePaymentIntakePublicId: current.publicId, replacementPaymentIntakePublicId: child.publicId, status: "draft" as const, auditPublicId: audit.publicId, correlationId: ctx.correlationId, lineagePublicId: lineage.publicId };
    };
    return executor ? run(executor) : db.transaction(run);
}
