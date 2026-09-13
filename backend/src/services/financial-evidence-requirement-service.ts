import { and, eq, or, sql } from "drizzle-orm";
import { db, type DbExecutor } from "../db";
import {
    files,
    financialEvidenceRequirements,
    financialEvidenceRequirementAttempts,
    loanDisbursementEvidenceIntents,
    loanDisbursementEvidence,
    loanDisbursementEvents,
    loans,
    paymentEvidence,
    paymentIntakes,
    users,
} from "../db/schema";
import { canAccessTenantWideData } from "../lib/access";
import { createAuditLog } from "../lib/audit-log";
import type { CommandContext } from "./command-context";
import { DomainError } from "./domain-error";
import { evaluateFinancialEvidence } from "./financial-evidence-policy";

export type FinancialEvidenceTarget =
    | { kind: "payment_intake"; publicId: string }
    | { kind: "loan_disbursement"; publicId: string };

const publicIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sha256IdentityPattern = /^[0-9a-f]{64}$/i;

function requirePublicId(value: string, field: string) {
    if (!publicIdPattern.test(value)) throw new DomainError("INVALID_PUBLIC_ID", `${field} must be a UUID`, 400, { field });
}

function validateExpectedCount(expectedCount: number) {
    if (!Number.isInteger(expectedCount) || expectedCount < 1 || expectedCount > 20) {
        throw new DomainError("INVALID_EVIDENCE_REQUIREMENT", "Evidence expectedCount must be an integer from 1 to 20", 400);
    }
}

function validateAttemptKey(attemptKey: string | undefined) {
    if (attemptKey !== undefined && (!attemptKey.trim() || attemptKey.trim().length > 512)) {
        throw new DomainError("INVALID_EVIDENCE_ATTEMPT", "Evidence attempt identity must be 1 to 512 characters", 400);
    }
    return attemptKey?.trim();
}

function legacyAttemptKey(evidenceHash: string | null | undefined, sourceFileFingerprint: string | null | undefined) {
    const hash = evidenceHash?.trim().toLowerCase();
    if (hash && sha256IdentityPattern.test(hash)) return `sha256:${hash}`;
    const fingerprint = sourceFileFingerprint?.trim().toLowerCase();
    if (fingerprint && sha256IdentityPattern.test(fingerprint)) return `fingerprint:${fingerprint}`;
    return null;
}

function auditContext(ctx: CommandContext) {
    return { tenantId: ctx.tenantId, actorUserId: ctx.actorUserId, actorSource: ctx.actorSource, requestId: ctx.requestId, correlationId: ctx.correlationId };
}

async function assertTargetAccess(tx: DbExecutor, ctx: CommandContext, ownerUserId: number | null, notFoundCode: "PAYMENT_INTAKE_NOT_FOUND" | "DISBURSEMENT_NOT_FOUND") {
    if (ctx.actorUserId === null) return;
    const actor = await tx.query.users.findFirst({ where: and(eq(users.tenantId, ctx.tenantId), eq(users.id, ctx.actorUserId)) });
    if (!actor) throw new DomainError("ACTOR_NOT_FOUND", "Actor is not available in this tenant", 403);
    if (!canAccessTenantWideData({ role: actor.role ?? "viewer" }) && ownerUserId !== actor.id) {
        throw new DomainError(notFoundCode, notFoundCode === "PAYMENT_INTAKE_NOT_FOUND" ? "Payment intake not found" : "Disbursement not found", 404);
    }
}

async function lockPaymentTarget(tx: DbExecutor, ctx: CommandContext, publicId: string) {
    requirePublicId(publicId, "paymentIntakePublicId");
    const snapshot = await tx.query.paymentIntakes.findFirst({ where: and(eq(paymentIntakes.tenantId, ctx.tenantId), eq(paymentIntakes.publicId, publicId)) });
    if (!snapshot) throw new DomainError("PAYMENT_INTAKE_NOT_FOUND", "Payment intake not found", 404);
    await assertTargetAccess(tx, ctx, snapshot.ownerUserId, "PAYMENT_INTAKE_NOT_FOUND");
    await tx.execute(sql`SELECT id FROM payment_intakes WHERE tenant_id = ${ctx.tenantId} AND id = ${snapshot.id} FOR UPDATE`);
    const current = await tx.query.paymentIntakes.findFirst({ where: and(eq(paymentIntakes.tenantId, ctx.tenantId), eq(paymentIntakes.id, snapshot.id)) });
    if (!current) throw new DomainError("PAYMENT_INTAKE_NOT_FOUND", "Payment intake not found", 404);
    if (["posted", "reversed", "duplicate", "cancelled"].includes(current.status)) {
        throw new DomainError("PAYMENT_INTAKE_IMMUTABLE", "Evidence requirements cannot be changed for this intake", 409);
    }
    return current;
}

async function lockDisbursementTarget(tx: DbExecutor, ctx: CommandContext, publicId: string) {
    requirePublicId(publicId, "disbursementPublicId");
    const snapshot = await tx.query.loanDisbursementEvents.findFirst({ where: and(eq(loanDisbursementEvents.tenantId, ctx.tenantId), eq(loanDisbursementEvents.publicId, publicId)) });
    if (!snapshot) throw new DomainError("DISBURSEMENT_NOT_FOUND", "Disbursement not found", 404);
    const loan = await tx.query.loans.findFirst({ where: and(eq(loans.tenantId, ctx.tenantId), eq(loans.id, snapshot.loanId)) });
    await assertTargetAccess(tx, ctx, loan?.ownerUserId ?? null, "DISBURSEMENT_NOT_FOUND");
    // This is the same loan -> event order used by payout posting/finalization.
    await tx.execute(sql`SELECT id FROM loans WHERE tenant_id = ${ctx.tenantId} AND id = ${snapshot.loanId} FOR UPDATE`);
    await tx.execute(sql`SELECT id FROM loan_disbursement_events WHERE tenant_id = ${ctx.tenantId} AND id = ${snapshot.id} FOR UPDATE`);
    const current = await tx.query.loanDisbursementEvents.findFirst({ where: and(eq(loanDisbursementEvents.tenantId, ctx.tenantId), eq(loanDisbursementEvents.id, snapshot.id)) });
    if (!current) throw new DomainError("DISBURSEMENT_NOT_FOUND", "Disbursement not found", 404);
    if (current.status !== "draft") throw new DomainError("DISBURSEMENT_LOCKED", "Evidence requirements cannot be changed for a posted or reversed disbursement", 409);
    return current;
}

async function seedLegacyPaymentEvidenceAttempts(tx: DbExecutor, ctx: CommandContext, requirementId: number, intakeId: number) {
    const legacyEvidence = await tx.select({
        evidenceHash: paymentEvidence.evidenceHash,
        sourceFileFingerprint: paymentEvidence.sourceFileFingerprint,
    }).from(paymentEvidence).where(and(
        eq(paymentEvidence.tenantId, ctx.tenantId),
        eq(paymentEvidence.paymentIntakeId, intakeId),
    ));
    for (const evidence of legacyEvidence) {
        const attemptKey = legacyAttemptKey(evidence.evidenceHash, evidence.sourceFileFingerprint);
        if (!attemptKey) continue;
        await tx.insert(financialEvidenceRequirementAttempts).values({
            tenantId: ctx.tenantId, financialEvidenceRequirementId: requirementId, attemptKey,
            createdByUserId: ctx.actorUserId, source: ctx.actorSource, requestId: ctx.requestId, correlationId: ctx.correlationId,
        }).onConflictDoNothing({ target: [financialEvidenceRequirementAttempts.tenantId, financialEvidenceRequirementAttempts.financialEvidenceRequirementId, financialEvidenceRequirementAttempts.attemptKey] });
    }
}

async function seedLegacyDisbursementEvidenceAttempts(tx: DbExecutor, ctx: CommandContext, requirementId: number, eventId: number) {
    const legacyIntents = await tx.select({
        evidenceHash: loanDisbursementEvidenceIntents.evidenceHash,
        sourceFileFingerprint: loanDisbursementEvidenceIntents.sourceFileFingerprint,
    }).from(loanDisbursementEvidenceIntents).where(and(
        eq(loanDisbursementEvidenceIntents.tenantId, ctx.tenantId),
        eq(loanDisbursementEvidenceIntents.loanDisbursementEventId, eventId),
    ));
    for (const intent of legacyIntents) {
        const attemptKey = legacyAttemptKey(intent.evidenceHash, intent.sourceFileFingerprint);
        if (!attemptKey) continue;
        await tx.insert(financialEvidenceRequirementAttempts).values({
            tenantId: ctx.tenantId, financialEvidenceRequirementId: requirementId, attemptKey,
            createdByUserId: ctx.actorUserId, source: ctx.actorSource, requestId: ctx.requestId, correlationId: ctx.correlationId,
        }).onConflictDoNothing({ target: [financialEvidenceRequirementAttempts.tenantId, financialEvidenceRequirementAttempts.financialEvidenceRequirementId, financialEvidenceRequirementAttempts.attemptKey] });
    }
}

/** Register or raise a sticky requirement under the target's lifecycle lock. */
export async function registerFinancialEvidenceRequirement(
    tx: DbExecutor,
    ctx: CommandContext,
    target: FinancialEvidenceTarget,
    expectedCount: number,
    options: { attemptKey?: string } = {},
) {
    validateExpectedCount(expectedCount);
    const attemptKey = validateAttemptKey(options.attemptKey);
    const source = ctx.actorSource;
    if (target.kind === "payment_intake") {
        const intake = await lockPaymentTarget(tx, ctx, target.publicId);
        const existing = await tx.query.financialEvidenceRequirements.findFirst({ where: and(eq(financialEvidenceRequirements.tenantId, ctx.tenantId), eq(financialEvidenceRequirements.paymentIntakeId, intake.id)) });
        let row = existing
            ? existing
            : await tx.insert(financialEvidenceRequirements).values({ tenantId: ctx.tenantId, paymentIntakeId: intake.id, expectedCount, createdByUserId: ctx.actorUserId, source, requestId: ctx.requestId, correlationId: ctx.correlationId }).returning().then((rows) => rows[0]!);
        if (attemptKey) {
            await tx.insert(financialEvidenceRequirementAttempts).values({
                tenantId: ctx.tenantId, financialEvidenceRequirementId: row.id, attemptKey,
                createdByUserId: ctx.actorUserId, source, requestId: ctx.requestId, correlationId: ctx.correlationId,
            }).onConflictDoNothing({ target: [financialEvidenceRequirementAttempts.tenantId, financialEvidenceRequirementAttempts.financialEvidenceRequirementId, financialEvidenceRequirementAttempts.attemptKey] });
        }
        await seedLegacyPaymentEvidenceAttempts(tx, ctx, row.id, intake.id);
        const attempts = await tx.select({ id: financialEvidenceRequirementAttempts.id }).from(financialEvidenceRequirementAttempts).where(and(
            eq(financialEvidenceRequirementAttempts.tenantId, ctx.tenantId),
            eq(financialEvidenceRequirementAttempts.financialEvidenceRequirementId, row.id),
        ));
        const nextCount = Math.max(expectedCount, row.expectedCount, attempts.length);
        if (nextCount > row.expectedCount) {
            row = await tx.update(financialEvidenceRequirements).set({ expectedCount: nextCount, updatedAt: new Date() }).where(eq(financialEvidenceRequirements.id, row.id)).returning().then((rows) => rows[0]!);
        }
        if (!intake.evidenceRequired) {
            await tx.update(paymentIntakes).set({ evidenceRequired: true, updatedByUserId: ctx.actorUserId, updatedAt: new Date() }).where(and(eq(paymentIntakes.tenantId, ctx.tenantId), eq(paymentIntakes.id, intake.id)));
        }
        if (!existing || nextCount > existing.expectedCount) {
            await createAuditLog(tx, { ...auditContext(ctx), entityType: "financial_evidence_requirement", entityId: row.publicId, action: existing ? "increased" : "registered", payload: { targetKind: target.kind, targetPublicId: target.publicId, expectedCount: nextCount } });
        }
        return row;
    }

    const event = await lockDisbursementTarget(tx, ctx, target.publicId);
    const existing = await tx.query.financialEvidenceRequirements.findFirst({ where: and(eq(financialEvidenceRequirements.tenantId, ctx.tenantId), eq(financialEvidenceRequirements.loanDisbursementEventId, event.id)) });
    let row = existing
        ? existing
        : await tx.insert(financialEvidenceRequirements).values({ tenantId: ctx.tenantId, loanDisbursementEventId: event.id, expectedCount, createdByUserId: ctx.actorUserId, source, requestId: ctx.requestId, correlationId: ctx.correlationId }).returning().then((rows) => rows[0]!);
    if (attemptKey) {
        await tx.insert(financialEvidenceRequirementAttempts).values({
            tenantId: ctx.tenantId, financialEvidenceRequirementId: row.id, attemptKey,
            createdByUserId: ctx.actorUserId, source, requestId: ctx.requestId, correlationId: ctx.correlationId,
        }).onConflictDoNothing({ target: [financialEvidenceRequirementAttempts.tenantId, financialEvidenceRequirementAttempts.financialEvidenceRequirementId, financialEvidenceRequirementAttempts.attemptKey] });
    }
    await seedLegacyDisbursementEvidenceAttempts(tx, ctx, row.id, event.id);
    const attempts = await tx.select({ id: financialEvidenceRequirementAttempts.id }).from(financialEvidenceRequirementAttempts).where(and(
        eq(financialEvidenceRequirementAttempts.tenantId, ctx.tenantId),
        eq(financialEvidenceRequirementAttempts.financialEvidenceRequirementId, row.id),
    ));
    const nextCount = Math.max(expectedCount, row.expectedCount, attempts.length);
    if (nextCount > row.expectedCount) {
        row = await tx.update(financialEvidenceRequirements).set({ expectedCount: nextCount, updatedAt: new Date() }).where(eq(financialEvidenceRequirements.id, row.id)).returning().then((rows) => rows[0]!);
    }
    if (!existing || nextCount > existing.expectedCount) {
        await createAuditLog(tx, { ...auditContext(ctx), entityType: "financial_evidence_requirement", entityId: row.publicId, action: existing ? "increased" : "registered", payload: { targetKind: target.kind, targetPublicId: target.publicId, expectedCount: nextCount } });
    }
    return row;
}

async function paymentDecision(tx: DbExecutor, ctx: CommandContext, intake: typeof paymentIntakes.$inferSelect) {
    const requirement = await tx.query.financialEvidenceRequirements.findFirst({ where: and(eq(financialEvidenceRequirements.tenantId, ctx.tenantId), eq(financialEvidenceRequirements.paymentIntakeId, intake.id)) });
    const evidence = await tx.select({ status: paymentEvidence.status, finalizedAt: paymentEvidence.finalizedAt, fileId: paymentEvidence.fileId, fileRecordId: files.id }).from(paymentEvidence)
        .leftJoin(files, and(eq(files.tenantId, ctx.tenantId), eq(files.id, paymentEvidence.fileId)))
        .where(and(eq(paymentEvidence.tenantId, ctx.tenantId), eq(paymentEvidence.paymentIntakeId, intake.id)));
    const attempts = requirement ? await tx.select({ id: financialEvidenceRequirementAttempts.id }).from(financialEvidenceRequirementAttempts).where(and(
        eq(financialEvidenceRequirementAttempts.tenantId, ctx.tenantId), eq(financialEvidenceRequirementAttempts.financialEvidenceRequirementId, requirement.id),
    )) : [];
    const state = evaluateFinancialEvidence({
        required: intake.evidenceRequired || Boolean(requirement) || evidence.length > 0,
        expectedCount: Math.max(requirement?.expectedCount ?? 0, evidence.length, attempts.length),
        readyCount: evidence.filter((row) => row.status === "ready" && row.finalizedAt !== null && row.fileId !== null && row.fileRecordId !== null).length,
        pendingCount: evidence.filter((row) => row.status === "pending").length,
        rejectedCount: evidence.filter((row) => row.status === "rejected").length,
    });
    return { state, requirement, evidence };
}

async function disbursementDecision(tx: DbExecutor, ctx: CommandContext, event: typeof loanDisbursementEvents.$inferSelect) {
    const requirement = await tx.query.financialEvidenceRequirements.findFirst({ where: and(eq(financialEvidenceRequirements.tenantId, ctx.tenantId), eq(financialEvidenceRequirements.loanDisbursementEventId, event.id)) });
    const intents = await tx.select({ status: loanDisbursementEvidenceIntents.status, finalizedAt: loanDisbursementEvidenceIntents.finalizedAt, fileId: loanDisbursementEvidenceIntents.fileId, fileRecordId: files.id, associationId: loanDisbursementEvidence.id }).from(loanDisbursementEvidenceIntents)
        .leftJoin(files, and(eq(files.tenantId, ctx.tenantId), eq(files.id, loanDisbursementEvidenceIntents.fileId)))
        .leftJoin(loanDisbursementEvidence, and(
            eq(loanDisbursementEvidence.tenantId, ctx.tenantId),
            eq(loanDisbursementEvidence.loanDisbursementEventId, event.id),
            eq(loanDisbursementEvidence.fileId, loanDisbursementEvidenceIntents.fileId),
        ))
        .where(and(eq(loanDisbursementEvidenceIntents.tenantId, ctx.tenantId), eq(loanDisbursementEvidenceIntents.loanDisbursementEventId, event.id)));
    const attempts = requirement ? await tx.select({ id: financialEvidenceRequirementAttempts.id }).from(financialEvidenceRequirementAttempts).where(and(
        eq(financialEvidenceRequirementAttempts.tenantId, ctx.tenantId), eq(financialEvidenceRequirementAttempts.financialEvidenceRequirementId, requirement.id),
    )) : [];
    const state = evaluateFinancialEvidence({
        required: Boolean(requirement) || intents.length > 0,
        expectedCount: Math.max(requirement?.expectedCount ?? 0, intents.length, attempts.length),
        readyCount: intents.filter((row) => row.status === "ready" && row.finalizedAt !== null && row.fileId !== null && row.fileRecordId !== null && row.associationId !== null).length,
        pendingCount: intents.filter((row) => row.status === "pending").length,
        rejectedCount: 0,
    });
    return { state, requirement, intents };
}

/** Re-read exact finalized associations. Resolver output is never accepted here. */
export async function assertFinancialEvidenceReady(tx: DbExecutor, ctx: CommandContext, target: FinancialEvidenceTarget) {
    if (target.kind === "payment_intake") {
        requirePublicId(target.publicId, "paymentIntakePublicId");
        const intake = await tx.query.paymentIntakes.findFirst({ where: and(eq(paymentIntakes.tenantId, ctx.tenantId), eq(paymentIntakes.publicId, target.publicId)) });
        if (!intake) throw new DomainError("PAYMENT_INTAKE_NOT_FOUND", "Payment intake not found", 404);
        const { state } = await paymentDecision(tx, ctx, intake);
        if (!state.allowed) throw new DomainError(state.code, "All required financial evidence must be finalized before this transition", 409, { blockerCode: state.code, recommendation: "workflow.resolve" });
        return state;
    }
    requirePublicId(target.publicId, "disbursementPublicId");
    const event = await tx.query.loanDisbursementEvents.findFirst({ where: and(eq(loanDisbursementEvents.tenantId, ctx.tenantId), eq(loanDisbursementEvents.publicId, target.publicId)) });
    if (!event) throw new DomainError("DISBURSEMENT_NOT_FOUND", "Disbursement not found", 404);
    const { state } = await disbursementDecision(tx, ctx, event);
    if (!state.allowed) throw new DomainError(state.code, "All required financial evidence must be finalized before this transition", 409, { blockerCode: state.code, recommendation: "workflow.resolve" });
    return state;
}

/** Activation guard for known payout requirements associated with a loan. */
export async function assertLoanFinancialEvidenceReady(tx: DbExecutor, ctx: CommandContext, loanId: number) {
    const targets = await tx.select({ publicId: loanDisbursementEvents.publicId }).from(loanDisbursementEvents).where(and(
        eq(loanDisbursementEvents.tenantId, ctx.tenantId), eq(loanDisbursementEvents.loanId, loanId), eq(loanDisbursementEvents.status, "draft"),
        or(
            sql`EXISTS (SELECT 1 FROM financial_evidence_requirements r WHERE r.tenant_id = ${ctx.tenantId} AND r.loan_disbursement_event_id = ${loanDisbursementEvents.id})`,
            sql`EXISTS (SELECT 1 FROM loan_disbursement_evidence_intents i WHERE i.tenant_id = ${ctx.tenantId} AND i.loan_disbursement_event_id = ${loanDisbursementEvents.id})`,
        ),
    ));
    for (const target of targets) await assertFinancialEvidenceReady(tx, ctx, { kind: "loan_disbursement", publicId: target.publicId });
}

export async function financialEvidenceRequirementForTarget(tx: DbExecutor, ctx: CommandContext, target: FinancialEvidenceTarget) {
    if (target.kind === "payment_intake") {
        const intake = await tx.query.paymentIntakes.findFirst({ where: and(eq(paymentIntakes.tenantId, ctx.tenantId), eq(paymentIntakes.publicId, target.publicId)) });
        if (!intake) return null;
        return tx.query.financialEvidenceRequirements.findFirst({ where: and(eq(financialEvidenceRequirements.tenantId, ctx.tenantId), eq(financialEvidenceRequirements.paymentIntakeId, intake.id)) });
    }
    const event = await tx.query.loanDisbursementEvents.findFirst({ where: and(eq(loanDisbursementEvents.tenantId, ctx.tenantId), eq(loanDisbursementEvents.publicId, target.publicId)) });
    if (!event) return null;
    return tx.query.financialEvidenceRequirements.findFirst({ where: and(eq(financialEvidenceRequirements.tenantId, ctx.tenantId), eq(financialEvidenceRequirements.loanDisbursementEventId, event.id)) });
}
