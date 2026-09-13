import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { borrowers, files, financialEvidenceRequirementAttempts, financialEvidenceRequirements, loanDisbursementEvidence, loanDisbursementEvidenceIntents, loanDisbursementEvents, loans, paymentEvidence, paymentIntakes, users } from "../db/schema";
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

function countValue(value: number | string | null | undefined) {
    const count = Number(value ?? 0);
    return Number.isSafeInteger(count) && count >= 0 ? count : Number.MAX_SAFE_INTEGER;
}

async function paymentObservation(ctx: CommandContext, publicId: string): Promise<ResolverObservation> {
    const intake = await db.query.paymentIntakes.findFirst({ where: and(eq(paymentIntakes.tenantId, ctx.tenantId), eq(paymentIntakes.publicId, publicId)) });
    if (!intake || !(await actorCanRead(ctx, intake.ownerUserId))) return { targetAvailable: false };
    const requirement = await db.query.financialEvidenceRequirements.findFirst({ where: and(eq(financialEvidenceRequirements.tenantId, ctx.tenantId), eq(financialEvidenceRequirements.paymentIntakeId, intake.id)) });
    const [evidenceCounts, attemptCounts] = await Promise.all([
        db.select({
            total: sql<number>`count(${paymentEvidence.id})`,
            ready: sql<number>`count(${paymentEvidence.id}) FILTER (WHERE ${paymentEvidence.status} = 'ready' AND ${paymentEvidence.finalizedAt} IS NOT NULL AND ${paymentEvidence.fileId} IS NOT NULL AND ${files.id} IS NOT NULL)`,
            pending: sql<number>`count(${paymentEvidence.id}) FILTER (WHERE ${paymentEvidence.status} = 'pending')`,
            rejected: sql<number>`count(${paymentEvidence.id}) FILTER (WHERE ${paymentEvidence.status} = 'rejected')`,
        }).from(paymentEvidence)
            .leftJoin(files, and(eq(files.tenantId, ctx.tenantId), eq(files.id, paymentEvidence.fileId)))
            .where(and(eq(paymentEvidence.tenantId, ctx.tenantId), eq(paymentEvidence.paymentIntakeId, intake.id))),
        requirement ? db.select({ total: sql<number>`count(${financialEvidenceRequirementAttempts.id})` }).from(financialEvidenceRequirementAttempts)
            .where(and(eq(financialEvidenceRequirementAttempts.tenantId, ctx.tenantId), eq(financialEvidenceRequirementAttempts.financialEvidenceRequirementId, requirement.id))) : Promise.resolve([{ total: 0 }]),
    ]);
    const evidence = evidenceCounts[0]!;
    const attempts = attemptCounts[0]!;
    const evidenceTotal = countValue(evidence.total);
    const attemptTotal = countValue(attempts.total);
    const expected = Math.max(requirement?.expectedCount ?? 0, evidenceTotal, attemptTotal);
    const required = intake.evidenceRequired || !!requirement || evidenceTotal > 0;
    const ready = countValue(evidence.ready);
    return {
        targetAvailable: true, identityResolved: true, state: ["posted", "reversed", "duplicate", "cancelled"].includes(intake.status) ? "posted" : "mutable",
        evidenceRequired: required, evidenceReady: evidenceTotal <= 20 && attemptTotal <= 20 && (!required || (expected > 0 && ready >= expected && evidenceTotal === ready)),
        pendingEvidenceCount: countValue(evidence.pending), rejectedEvidenceCount: countValue(evidence.rejected),
        evidenceOverflow: evidenceTotal > 20 || attemptTotal > 20,
    };
}

async function disbursementEvidenceSummary(ctx: CommandContext, eventId: number) {
    const requirement = await db.query.financialEvidenceRequirements.findFirst({ where: and(eq(financialEvidenceRequirements.tenantId, ctx.tenantId), eq(financialEvidenceRequirements.loanDisbursementEventId, eventId)) });
    const [intentCounts, attemptCounts] = await Promise.all([
        db.select({
            total: sql<number>`count(${loanDisbursementEvidenceIntents.id})`,
            ready: sql<number>`count(${loanDisbursementEvidenceIntents.id}) FILTER (WHERE ${loanDisbursementEvidenceIntents.status} = 'ready' AND ${loanDisbursementEvidenceIntents.finalizedAt} IS NOT NULL AND ${loanDisbursementEvidenceIntents.fileId} IS NOT NULL AND ${files.id} IS NOT NULL AND ${loanDisbursementEvidence.id} IS NOT NULL)`,
            pending: sql<number>`count(${loanDisbursementEvidenceIntents.id}) FILTER (WHERE ${loanDisbursementEvidenceIntents.status} = 'pending')`,
        })
            .from(loanDisbursementEvidenceIntents)
            .leftJoin(files, and(eq(files.tenantId, ctx.tenantId), eq(files.id, loanDisbursementEvidenceIntents.fileId)))
            .leftJoin(loanDisbursementEvidence, and(eq(loanDisbursementEvidence.tenantId, ctx.tenantId), eq(loanDisbursementEvidence.loanDisbursementEventId, eventId), eq(loanDisbursementEvidence.fileId, loanDisbursementEvidenceIntents.fileId)))
            .where(and(eq(loanDisbursementEvidenceIntents.tenantId, ctx.tenantId), eq(loanDisbursementEvidenceIntents.loanDisbursementEventId, eventId))),
        requirement ? db.select({ total: sql<number>`count(${financialEvidenceRequirementAttempts.id})` }).from(financialEvidenceRequirementAttempts).where(and(
            eq(financialEvidenceRequirementAttempts.tenantId, ctx.tenantId), eq(financialEvidenceRequirementAttempts.financialEvidenceRequirementId, requirement.id),
        )) : Promise.resolve([{ total: 0 }]),
    ]);
    const intents = intentCounts[0]!;
    const attempts = attemptCounts[0]!;
    const intentTotal = countValue(intents.total);
    const attemptTotal = countValue(attempts.total);
    const expected = Math.max(requirement?.expectedCount ?? 0, intentTotal, attemptTotal);
    const required = !!requirement || intentTotal > 0;
    const ready = countValue(intents.ready);
    return { required, ready: !required || (expected > 0 && ready >= expected && intentTotal === ready), pending: countValue(intents.pending), rejected: 0, overflow: intentTotal > 20 || attemptTotal > 20 };
}

async function loanObservation(ctx: CommandContext, publicId: string): Promise<ResolverObservation> {
    const loan = await db.query.loans.findFirst({ where: and(eq(loans.tenantId, ctx.tenantId), eq(loans.publicId, publicId)) });
    if (!loan || !(await actorCanRead(ctx, loan.ownerUserId))) return { targetAvailable: false };
    const [eventCount, events] = await Promise.all([
        db.select({ total: sql<number>`count(${loanDisbursementEvents.id})` }).from(loanDisbursementEvents).where(and(
            eq(loanDisbursementEvents.tenantId, ctx.tenantId), eq(loanDisbursementEvents.loanId, loan.id), eq(loanDisbursementEvents.status, "draft"),
        )),
        db.select({ eventId: loanDisbursementEvents.id }).from(loanDisbursementEvents).where(and(
        eq(loanDisbursementEvents.tenantId, ctx.tenantId), eq(loanDisbursementEvents.loanId, loan.id), eq(loanDisbursementEvents.status, "draft"),
        )).limit(20),
    ]);
    const summaries = await Promise.all(events.map((event) => disbursementEvidenceSummary(ctx, event.eventId)));
    const required = summaries.some((summary) => summary.required);
    const eventTotal = countValue(eventCount[0]?.total);
    const evidenceOverflow = eventTotal > 20 || summaries.some((summary) => summary.overflow);
    return { targetAvailable: true, identityResolved: true, state: loan.status === "draft" ? "mutable" : "posted", loanType: loan.repaymentType === "floating" ? "floating" : "scheduled", evidenceRequired: required, evidenceReady: !evidenceOverflow && summaries.every((summary) => summary.ready), pendingEvidenceCount: summaries.reduce((count, summary) => count + summary.pending, 0), rejectedEvidenceCount: summaries.reduce((count, summary) => count + summary.rejected, 0), evidenceOverflow };
}

async function disbursementObservation(ctx: CommandContext, publicId: string): Promise<ResolverObservation> {
    const event = await db.query.loanDisbursementEvents.findFirst({ where: and(eq(loanDisbursementEvents.tenantId, ctx.tenantId), eq(loanDisbursementEvents.publicId, publicId)) });
    if (!event) return { targetAvailable: false };
    const loan = await db.query.loans.findFirst({ where: and(eq(loans.tenantId, ctx.tenantId), eq(loans.id, event.loanId)) });
    if (!loan || !(await actorCanRead(ctx, loan.ownerUserId))) return { targetAvailable: false };
    const summary = await disbursementEvidenceSummary(ctx, event.id);
    return { targetAvailable: true, identityResolved: true, state: event.status === "draft" ? "mutable" : "posted", loanType: loan.repaymentType === "floating" ? "floating" : "scheduled", evidenceRequired: summary.required, evidenceReady: summary.ready && !summary.overflow, pendingEvidenceCount: summary.pending, rejectedEvidenceCount: summary.rejected, evidenceOverflow: summary.overflow };
}

export async function resolveWorkflowFromBackend(ctx: CommandContext, input: ResolverWireInput, profile: ToolProfile, catalogVersion: string, workflowVersion: string) {
    let observation: ResolverObservation = {};
    if (input.target) {
        if (input.target.kind === "payment_intake") observation = await paymentObservation(ctx, input.target.publicId);
        else if (input.target.kind === "loan") observation = await loanObservation(ctx, input.target.publicId);
        else if (input.target.kind === "loan_disbursement") observation = await disbursementObservation(ctx, input.target.publicId);
        else {
            const borrower = await db.query.borrowers.findFirst({ where: and(eq(borrowers.tenantId, ctx.tenantId), eq(borrowers.publicId, input.target.publicId)) });
            observation = borrower && await actorCanRead(ctx, borrower.ownerUserId)
                ? { targetAvailable: true, identityResolved: true, state: "mutable" }
                : { targetAvailable: false };
        }
    }
    return resolveWorkflowPolicy({ ...input, profile }, observation, { profile, catalogVersion, workflowVersion } satisfies ResolverProfile);
}
