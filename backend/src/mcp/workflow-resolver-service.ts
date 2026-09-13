import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { files, financialEvidenceRequirementAttempts, financialEvidenceRequirements, loanDisbursementEvidence, loanDisbursementEvidenceIntents, loanDisbursementEvents, loans, paymentEvidence, paymentIntakes, users } from "../db/schema";
import { canAccessTenantWideData } from "../lib/access";
import type { CommandContext } from "../services/command-context";
import { resolveWorkflowPolicy, type ResolverInput, type ResolverObservation, type ResolverProfile } from "./workflow-resolver";
import type { ToolProfile } from "./catalog-types";

type ResolverWireInput = Omit<ResolverInput, "profile"> & { profile?: never };

async function actorCanRead(ctx: CommandContext, ownerUserId: number | null) {
    if (ctx.actorUserId === null) return true;
    const actor = await db.query.users.findFirst({ where: and(eq(users.tenantId, ctx.tenantId), eq(users.id, ctx.actorUserId)) });
    return !!actor && (canAccessTenantWideData({ role: actor.role ?? "viewer" }) || ownerUserId === actor.id);
}

async function paymentObservation(ctx: CommandContext, publicId: string): Promise<ResolverObservation> {
    const intake = await db.query.paymentIntakes.findFirst({ where: and(eq(paymentIntakes.tenantId, ctx.tenantId), eq(paymentIntakes.publicId, publicId)) });
    if (!intake || !(await actorCanRead(ctx, intake.ownerUserId))) return { targetAvailable: false };
    const requirement = await db.query.financialEvidenceRequirements.findFirst({ where: and(eq(financialEvidenceRequirements.tenantId, ctx.tenantId), eq(financialEvidenceRequirements.paymentIntakeId, intake.id)) });
    const [evidence, attempts] = await Promise.all([
        db.select({ status: paymentEvidence.status, finalizedAt: paymentEvidence.finalizedAt, fileId: paymentEvidence.fileId, fileRecordId: files.id }).from(paymentEvidence)
            .leftJoin(files, and(eq(files.tenantId, ctx.tenantId), eq(files.id, paymentEvidence.fileId)))
            .where(and(eq(paymentEvidence.tenantId, ctx.tenantId), eq(paymentEvidence.paymentIntakeId, intake.id))).limit(20),
        requirement ? db.select({ id: financialEvidenceRequirementAttempts.id }).from(financialEvidenceRequirementAttempts)
            .where(and(eq(financialEvidenceRequirementAttempts.tenantId, ctx.tenantId), eq(financialEvidenceRequirementAttempts.financialEvidenceRequirementId, requirement.id))).limit(20) : Promise.resolve([]),
    ]);
    const expected = Math.max(requirement?.expectedCount ?? 0, evidence.length, attempts.length);
    const required = intake.evidenceRequired || !!requirement || evidence.length > 0;
    const ready = evidence.filter((row) => row.status === "ready" && row.finalizedAt !== null && row.fileId !== null && row.fileRecordId !== null).length;
    return { targetAvailable: true, identityResolved: true, state: ["posted", "reversed", "duplicate", "cancelled"].includes(intake.status) ? "posted" : "mutable", evidenceRequired: required, evidenceReady: !required || (expected > 0 && ready >= expected && evidence.length === ready), pendingEvidenceCount: evidence.filter((row) => row.status === "pending").length, rejectedEvidenceCount: evidence.filter((row) => row.status === "rejected").length };
}

async function disbursementEvidenceSummary(ctx: CommandContext, eventId: number) {
    const [requirement, intents] = await Promise.all([
        db.query.financialEvidenceRequirements.findFirst({ where: and(eq(financialEvidenceRequirements.tenantId, ctx.tenantId), eq(financialEvidenceRequirements.loanDisbursementEventId, eventId)) }),
        db.select({ status: loanDisbursementEvidenceIntents.status, finalizedAt: loanDisbursementEvidenceIntents.finalizedAt, fileId: loanDisbursementEvidenceIntents.fileId, fileRecordId: files.id, associationId: loanDisbursementEvidence.id })
            .from(loanDisbursementEvidenceIntents)
            .leftJoin(files, and(eq(files.tenantId, ctx.tenantId), eq(files.id, loanDisbursementEvidenceIntents.fileId)))
            .leftJoin(loanDisbursementEvidence, and(eq(loanDisbursementEvidence.tenantId, ctx.tenantId), eq(loanDisbursementEvidence.loanDisbursementEventId, eventId), eq(loanDisbursementEvidence.fileId, loanDisbursementEvidenceIntents.fileId)))
            .where(and(eq(loanDisbursementEvidenceIntents.tenantId, ctx.tenantId), eq(loanDisbursementEvidenceIntents.loanDisbursementEventId, eventId))).limit(20),
    ]);
    const attempts = requirement ? await db.select({ id: financialEvidenceRequirementAttempts.id }).from(financialEvidenceRequirementAttempts).where(and(
        eq(financialEvidenceRequirementAttempts.tenantId, ctx.tenantId), eq(financialEvidenceRequirementAttempts.financialEvidenceRequirementId, requirement.id),
    )).limit(20) : [];
    const expected = Math.max(requirement?.expectedCount ?? 0, intents.length, attempts.length);
    const required = !!requirement || intents.length > 0;
    const ready = intents.filter((intent) => intent.status === "ready" && intent.finalizedAt !== null && intent.fileId !== null && intent.fileRecordId !== null && intent.associationId !== null).length;
    return { required, ready: !required || (expected > 0 && ready >= expected && intents.length === ready), pending: intents.filter((intent) => intent.status === "pending").length, rejected: 0 };
}

async function loanObservation(ctx: CommandContext, publicId: string): Promise<ResolverObservation> {
    const loan = await db.query.loans.findFirst({ where: and(eq(loans.tenantId, ctx.tenantId), eq(loans.publicId, publicId)) });
    if (!loan || !(await actorCanRead(ctx, loan.ownerUserId))) return { targetAvailable: false };
    const events = await db.select({ eventId: loanDisbursementEvents.id }).from(loanDisbursementEvents).where(and(
        eq(loanDisbursementEvents.tenantId, ctx.tenantId), eq(loanDisbursementEvents.loanId, loan.id), eq(loanDisbursementEvents.status, "draft"),
    )).limit(20);
    const summaries = await Promise.all(events.map((event) => disbursementEvidenceSummary(ctx, event.eventId)));
    const required = summaries.some((summary) => summary.required);
    return { targetAvailable: true, identityResolved: true, state: loan.status === "draft" ? "mutable" : "posted", loanType: loan.repaymentType === "floating" ? "floating" : "scheduled", evidenceRequired: required, evidenceReady: summaries.every((summary) => summary.ready), pendingEvidenceCount: summaries.reduce((count, summary) => count + summary.pending, 0), rejectedEvidenceCount: summaries.reduce((count, summary) => count + summary.rejected, 0) };
}

async function disbursementObservation(ctx: CommandContext, publicId: string): Promise<ResolverObservation> {
    const event = await db.query.loanDisbursementEvents.findFirst({ where: and(eq(loanDisbursementEvents.tenantId, ctx.tenantId), eq(loanDisbursementEvents.publicId, publicId)) });
    if (!event) return { targetAvailable: false };
    const loan = await db.query.loans.findFirst({ where: and(eq(loans.tenantId, ctx.tenantId), eq(loans.id, event.loanId)) });
    if (!loan || !(await actorCanRead(ctx, loan.ownerUserId))) return { targetAvailable: false };
    const summary = await disbursementEvidenceSummary(ctx, event.id);
    return { targetAvailable: true, identityResolved: true, state: event.status === "draft" ? "mutable" : "posted", loanType: loan.repaymentType === "floating" ? "floating" : "scheduled", evidenceRequired: summary.required, evidenceReady: summary.ready, pendingEvidenceCount: summary.pending, rejectedEvidenceCount: summary.rejected };
}

export async function resolveWorkflowFromBackend(ctx: CommandContext, input: ResolverWireInput, profile: ToolProfile, catalogVersion: string, workflowVersion: string) {
    let observation: ResolverObservation = {};
    if (input.target) {
        if (input.target.kind === "payment_intake") observation = await paymentObservation(ctx, input.target.publicId);
        else if (input.target.kind === "loan") observation = await loanObservation(ctx, input.target.publicId);
        else if (input.target.kind === "loan_disbursement") observation = await disbursementObservation(ctx, input.target.publicId);
        else observation = { targetAvailable: false };
    }
    return resolveWorkflowPolicy({ ...input, profile }, observation, { profile, catalogVersion, workflowVersion } satisfies ResolverProfile);
}
