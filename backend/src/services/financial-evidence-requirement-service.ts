import { and, eq, inArray, or, sql } from "drizzle-orm";
import { db, type DbExecutor } from "../db";
import {
    financialEvidenceRequirements,
    loanDisbursementEvidenceIntents,
    loanDisbursementEvents,
    paymentEvidence,
    paymentIntakes,
    users,
} from "../db/schema";
import { createAuditLog } from "../lib/audit-log";
import type { CommandContext } from "./command-context";
import { DomainError } from "./domain-error";
import { evaluateFinancialEvidence } from "./financial-evidence-policy";

export type FinancialEvidenceTarget =
    | { kind: "payment_intake"; publicId: string }
    | { kind: "loan_disbursement"; publicId: string };

const publicIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requirePublicId(value: string, field: string) {
    if (!publicIdPattern.test(value)) throw new DomainError("INVALID_PUBLIC_ID", `${field} must be a UUID`, 400, { field });
}

function validateExpectedCount(expectedCount: number) {
    if (!Number.isInteger(expectedCount) || expectedCount < 1 || expectedCount > 20) {
        throw new DomainError("INVALID_EVIDENCE_REQUIREMENT", "Evidence expectedCount must be an integer from 1 to 20", 400);
    }
}

function auditContext(ctx: CommandContext) {
    return { tenantId: ctx.tenantId, actorUserId: ctx.actorUserId, actorSource: ctx.actorSource, requestId: ctx.requestId, correlationId: ctx.correlationId };
}

async function lockPaymentTarget(tx: DbExecutor, ctx: CommandContext, publicId: string) {
    requirePublicId(publicId, "paymentIntakePublicId");
    const snapshot = await tx.query.paymentIntakes.findFirst({ where: and(eq(paymentIntakes.tenantId, ctx.tenantId), eq(paymentIntakes.publicId, publicId)) });
    if (!snapshot) throw new DomainError("PAYMENT_INTAKE_NOT_FOUND", "Payment intake not found", 404);
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
    // This is the same loan -> event order used by payout posting/finalization.
    await tx.execute(sql`SELECT id FROM loans WHERE tenant_id = ${ctx.tenantId} AND id = ${snapshot.loanId} FOR UPDATE`);
    await tx.execute(sql`SELECT id FROM loan_disbursement_events WHERE tenant_id = ${ctx.tenantId} AND id = ${snapshot.id} FOR UPDATE`);
    const current = await tx.query.loanDisbursementEvents.findFirst({ where: and(eq(loanDisbursementEvents.tenantId, ctx.tenantId), eq(loanDisbursementEvents.id, snapshot.id)) });
    if (!current) throw new DomainError("DISBURSEMENT_NOT_FOUND", "Disbursement not found", 404);
    if (current.status !== "draft") throw new DomainError("DISBURSEMENT_LOCKED", "Evidence requirements cannot be changed for a posted or reversed disbursement", 409);
    return current;
}

/** Register or raise a sticky requirement under the target's lifecycle lock. */
export async function registerFinancialEvidenceRequirement(
    tx: DbExecutor,
    ctx: CommandContext,
    target: FinancialEvidenceTarget,
    expectedCount: number,
) {
    validateExpectedCount(expectedCount);
    const source = ctx.actorSource;
    if (target.kind === "payment_intake") {
        const intake = await lockPaymentTarget(tx, ctx, target.publicId);
        const existing = await tx.query.financialEvidenceRequirements.findFirst({ where: and(eq(financialEvidenceRequirements.tenantId, ctx.tenantId), eq(financialEvidenceRequirements.paymentIntakeId, intake.id)) });
        const nextCount = Math.max(expectedCount, existing?.expectedCount ?? 0);
        const row = existing
            ? await tx.update(financialEvidenceRequirements).set({ expectedCount: nextCount, updatedAt: new Date() }).where(eq(financialEvidenceRequirements.id, existing.id)).returning().then((rows) => rows[0]!)
            : await tx.insert(financialEvidenceRequirements).values({ tenantId: ctx.tenantId, paymentIntakeId: intake.id, expectedCount: nextCount, createdByUserId: ctx.actorUserId, source, requestId: ctx.requestId, correlationId: ctx.correlationId }).returning().then((rows) => rows[0]!);
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
    const nextCount = Math.max(expectedCount, existing?.expectedCount ?? 0);
    const row = existing
        ? await tx.update(financialEvidenceRequirements).set({ expectedCount: nextCount, updatedAt: new Date() }).where(eq(financialEvidenceRequirements.id, existing.id)).returning().then((rows) => rows[0]!)
        : await tx.insert(financialEvidenceRequirements).values({ tenantId: ctx.tenantId, loanDisbursementEventId: event.id, expectedCount: nextCount, createdByUserId: ctx.actorUserId, source, requestId: ctx.requestId, correlationId: ctx.correlationId }).returning().then((rows) => rows[0]!);
    if (!existing || nextCount > existing.expectedCount) {
        await createAuditLog(tx, { ...auditContext(ctx), entityType: "financial_evidence_requirement", entityId: row.publicId, action: existing ? "increased" : "registered", payload: { targetKind: target.kind, targetPublicId: target.publicId, expectedCount: nextCount } });
    }
    return row;
}

async function paymentDecision(tx: DbExecutor, ctx: CommandContext, intake: typeof paymentIntakes.$inferSelect) {
    const requirement = await tx.query.financialEvidenceRequirements.findFirst({ where: and(eq(financialEvidenceRequirements.tenantId, ctx.tenantId), eq(financialEvidenceRequirements.paymentIntakeId, intake.id)) });
    const evidence = await tx.select({ status: paymentEvidence.status, finalizedAt: paymentEvidence.finalizedAt }).from(paymentEvidence).where(and(eq(paymentEvidence.tenantId, ctx.tenantId), eq(paymentEvidence.paymentIntakeId, intake.id)));
    const state = evaluateFinancialEvidence({
        required: intake.evidenceRequired || Boolean(requirement) || evidence.length > 0,
        expectedCount: Math.max(requirement?.expectedCount ?? 0, evidence.length),
        readyCount: evidence.filter((row) => row.status === "ready" && row.finalizedAt !== null).length,
        pendingCount: evidence.filter((row) => row.status === "pending").length,
        rejectedCount: evidence.filter((row) => row.status === "rejected").length,
    });
    return { state, requirement, evidence };
}

async function disbursementDecision(tx: DbExecutor, ctx: CommandContext, event: typeof loanDisbursementEvents.$inferSelect) {
    const requirement = await tx.query.financialEvidenceRequirements.findFirst({ where: and(eq(financialEvidenceRequirements.tenantId, ctx.tenantId), eq(financialEvidenceRequirements.loanDisbursementEventId, event.id)) });
    const intents = await tx.select({ status: loanDisbursementEvidenceIntents.status }).from(loanDisbursementEvidenceIntents).where(and(eq(loanDisbursementEvidenceIntents.tenantId, ctx.tenantId), eq(loanDisbursementEvidenceIntents.loanDisbursementEventId, event.id)));
    const state = evaluateFinancialEvidence({
        required: Boolean(requirement) || intents.length > 0,
        expectedCount: Math.max(requirement?.expectedCount ?? 0, intents.length),
        readyCount: intents.filter((row) => row.status === "ready").length,
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
