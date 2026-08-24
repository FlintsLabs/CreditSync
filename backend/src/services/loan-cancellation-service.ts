import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db, type DbExecutor } from "../db";
import {
    loanCancellationPreviews,
    loanDisbursementEvents,
    loanCommissionParticipants,
    loanIntermediaryAssignments,
    loanRenewals,
    loanRestructures,
    loanSchedules,
    loanSettlementPreviews,
    loanWaiverPreviews,
    loans,
    transactions,
    users,
} from "../db/schema";
import { canAccessTenantWideData } from "../lib/access";
import { createAuditLog } from "../lib/audit-log";
import { invalidateTenantCache } from "../lib/cache";
import { FinancialDecimal } from "../lib/financial-decimal";
import { serializeMoney } from "../lib/money";
import { presentLoan } from "./loan-application-service";
import type { CommandContext } from "./command-context";
import { DomainError } from "./domain-error";
import { effectivePostedPaymentPredicate } from "./posted-payment-access";

type Executor = DbExecutor;
type LoanRow = typeof loans.$inferSelect;
type CancellationPreviewRow = typeof loanCancellationPreviews.$inferSelect;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const previewTtlMilliseconds = 15 * 60 * 1000;

export interface UnfundedCancellationEligibilityInput {
    status: string | null;
    postedPaymentCount: number;
    postedDisbursementCount: number;
    netDisbursed: string;
    downstreamBlocked: boolean;
}

export function evaluateUnfundedCancellationEligibility(input: UnfundedCancellationEligibilityInput) {
    if (input.status !== "active") return { eligible: false, code: "LOAN_CANCEL_NOT_ELIGIBLE" as const };
    if (input.postedDisbursementCount > 0 || input.netDisbursed !== "0.00") {
        return { eligible: false, code: "LOAN_CANCEL_FUNDED" as const };
    }
    if (input.postedPaymentCount > 0) return { eligible: false, code: "LOAN_CANCEL_POSTED_PAYMENT" as const };
    if (input.downstreamBlocked) return { eligible: false, code: "LOAN_CANCEL_DOWNSTREAM_ACTIVITY" as const };
    return { eligible: true, code: null };
}

function auditContext(ctx: CommandContext) {
    return {
        tenantId: ctx.tenantId,
        actorUserId: ctx.actorUserId,
        actorSource: ctx.actorSource,
        requestId: ctx.requestId,
        correlationId: ctx.correlationId,
    };
}

function requirePublicId(value: string, field: string) {
    if (!uuidPattern.test(value)) throw new DomainError("INVALID_PUBLIC_ID", `${field} must be a UUID`, 400, { field });
}

function requireReason(reason: string) {
    const normalized = reason.trim();
    if (!normalized) throw new DomainError("INVALID_REASON", "reason must not be blank", 400);
    return normalized;
}

function hash(value: unknown) {
    return `v1:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

async function actorFor(ctx: CommandContext, executor: Executor = db) {
    if (ctx.actorUserId === null) return null;
    const actor = await executor.query.users.findFirst({
        where: and(eq(users.tenantId, ctx.tenantId), eq(users.id, ctx.actorUserId)),
    });
    if (!actor) throw new DomainError("ACTOR_NOT_FOUND", "Actor is not available in this tenant", 403);
    return actor;
}

async function accessibleLoan(ctx: CommandContext, loanPublicId: string, executor: Executor = db) {
    requirePublicId(loanPublicId, "loanPublicId");
    const actor = await actorFor(ctx, executor);
    const loan = await executor.query.loans.findFirst({
        where: and(eq(loans.tenantId, ctx.tenantId), eq(loans.publicId, loanPublicId)),
    });
    if (!loan || (actor && !canAccessTenantWideData({ role: actor.role ?? "viewer" }) && loan.ownerUserId !== actor.id)) {
        throw new DomainError("LOAN_NOT_FOUND", "Loan not found", 404);
    }
    return loan as LoanRow;
}

async function financialState(ctx: CommandContext, loan: LoanRow, executor: Executor = db) {
    const [postedPayments, postedDisbursements, downstreamRows] = await Promise.all([
        executor.select({ id: transactions.id }).from(transactions).where(and(
            effectivePostedPaymentPredicate(ctx.tenantId),
            eq(transactions.loanId, loan.id),
        )),
        executor.select({ loanAttributedAmount: loanDisbursementEvents.loanAttributedAmount }).from(loanDisbursementEvents).where(and(
            eq(loanDisbursementEvents.tenantId, ctx.tenantId),
            eq(loanDisbursementEvents.loanId, loan.id),
            eq(loanDisbursementEvents.status, "posted"),
        )),
        Promise.all([
            executor.select({ id: loanRenewals.id }).from(loanRenewals).where(and(eq(loanRenewals.tenantId, ctx.tenantId), eq(loanRenewals.status, "executed"), sql`(${loanRenewals.oldLoanId} = ${loan.id} OR ${loanRenewals.newLoanId} = ${loan.id})`)),
            executor.select({ id: loanRestructures.id }).from(loanRestructures).where(and(eq(loanRestructures.tenantId, ctx.tenantId), eq(loanRestructures.status, "executed"), sql`(${loanRestructures.oldLoanId} = ${loan.id} OR ${loanRestructures.newLoanId} = ${loan.id})`)),
            executor.select({ id: loanSettlementPreviews.id }).from(loanSettlementPreviews).where(and(eq(loanSettlementPreviews.tenantId, ctx.tenantId), eq(loanSettlementPreviews.loanId, loan.id), eq(loanSettlementPreviews.status, "executed"))),
            executor.select({ id: loanWaiverPreviews.id }).from(loanWaiverPreviews).where(and(eq(loanWaiverPreviews.tenantId, ctx.tenantId), eq(loanWaiverPreviews.loanId, loan.id), eq(loanWaiverPreviews.status, "consumed"))),
            executor.select({ id: loanIntermediaryAssignments.id }).from(loanIntermediaryAssignments).where(and(eq(loanIntermediaryAssignments.tenantId, ctx.tenantId), eq(loanIntermediaryAssignments.loanId, loan.id), eq(loanIntermediaryAssignments.status, "active"))),
            executor.select({ id: loanCommissionParticipants.id }).from(loanCommissionParticipants).where(and(eq(loanCommissionParticipants.tenantId, ctx.tenantId), eq(loanCommissionParticipants.loanId, loan.id), eq(loanCommissionParticipants.status, "active"))),
        ]),
    ]);
    const netDisbursedMoney = postedDisbursements
        .reduce((sum, row) => sum.plus(row.loanAttributedAmount), new FinancialDecimal("0"))
        .toFixed(2);
    const downstreamBlocked = loan.clonedFromLoanId !== null || downstreamRows.some((rows) => rows.length > 0);
    const eligibility = evaluateUnfundedCancellationEligibility({
        status: loan.status,
        postedPaymentCount: postedPayments.length,
        postedDisbursementCount: postedDisbursements.length,
        netDisbursed: netDisbursedMoney,
        downstreamBlocked,
    });
    const before = {
        status: loan.status,
        outstandingPrincipal: serializeMoney(loan.outstandingPrincipal ?? loan.principalAmount),
        outstandingInterest: serializeMoney(loan.outstandingInterest ?? "0.00"),
        outstandingFees: serializeMoney(loan.outstandingFees ?? "0.00"),
        nextDueDate: loan.nextDueDate,
        postedPaymentCount: postedPayments.length,
        postedDisbursementCount: postedDisbursements.length,
        netDisbursed: netDisbursedMoney,
    };
    const balanceVersion = hash({ contract: "loan-unfunded-cancellation", loanPublicId: loan.publicId, before });
    return { ...eligibility, before, balanceVersion };
}

function presentPreview(row: CancellationPreviewRow, loan: LoanRow) {
    return {
        id: row.publicId,
        publicId: row.publicId,
        loanPublicId: loan.publicId,
        reason: row.reason,
        eligibility: row.eligibility,
        before: row.beforeSnapshot,
        balanceVersion: row.balanceVersion,
        previewHash: row.previewHash,
        status: row.status,
        expiresAt: row.expiresAt,
    };
}

export async function previewUnfundedLoanCancellation(ctx: CommandContext, loanPublicId: string, reason: string) {
    const normalizedReason = requireReason(reason);
    const loan = await accessibleLoan(ctx, loanPublicId);
    const state = await financialState(ctx, loan);
    if (!state.eligible) throw new DomainError(state.code!, "Loan is not eligible for unfunded cancellation", 409, state.before);
    const previewHash = hash({ contract: "loan-unfunded-cancellation-preview", loanPublicId: loan.publicId, reason: normalizedReason, balanceVersion: state.balanceVersion });
    const created = await db.insert(loanCancellationPreviews).values({
        tenantId: ctx.tenantId,
        loanId: loan.id,
        reason: normalizedReason,
        eligibility: "unfunded",
        beforeSnapshot: state.before,
        balanceVersion: state.balanceVersion,
        previewHash,
        expiresAt: new Date(Date.now() + previewTtlMilliseconds),
        createdByUserId: ctx.actorUserId,
    }).returning().then((rows) => rows[0]!);
    return presentPreview(created, loan);
}

export interface ExecuteUnfundedCancellationInput {
    previewPublicId: string;
    previewHash: string;
    expectedBalanceVersion: string;
    confirmed: boolean;
    reason: string;
}

export async function executeUnfundedLoanCancellation(ctx: CommandContext, input: ExecuteUnfundedCancellationInput) {
    requirePublicId(input.previewPublicId, "previewPublicId");
    const normalizedReason = requireReason(input.reason);
    if (input.confirmed !== true) throw new DomainError("CONFIRMATION_REQUIRED", "confirmed must be true", 400);
    if (!ctx.idempotencyKey?.trim()) throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", "Cancellation requires a non-blank Idempotency-Key", 400);

    const result = await db.transaction(async (tx) => {
        const executionKey = ctx.idempotencyKey!.trim();
        const occupied = await tx.select({ publicId: loanCancellationPreviews.publicId }).from(loanCancellationPreviews).where(and(
            eq(loanCancellationPreviews.tenantId, ctx.tenantId),
            eq(loanCancellationPreviews.executeIdempotencyKey, executionKey),
        )).limit(1).then((rows) => rows[0]);
        if (occupied && occupied.publicId !== input.previewPublicId) {
            throw new DomainError("IDEMPOTENCY_KEY_CONFLICT", "Cancellation idempotency key was already used for another preview", 409);
        }
        const preview = await tx.select().from(loanCancellationPreviews).where(and(
            eq(loanCancellationPreviews.tenantId, ctx.tenantId),
            eq(loanCancellationPreviews.publicId, input.previewPublicId),
        )).for("update").limit(1).then((rows) => rows[0]);
        if (!preview) throw new DomainError("LOAN_CANCEL_PREVIEW_NOT_FOUND", "Loan cancellation preview not found", 404);
        const loan = await accessibleLoan(ctx, (await tx.select({ publicId: loans.publicId }).from(loans).where(and(eq(loans.tenantId, ctx.tenantId), eq(loans.id, preview.loanId))).limit(1).then((rows) => rows[0]))?.publicId ?? "", tx);
        if (preview.status === "executed" && preview.executeIdempotencyKey === executionKey) {
            return { loan, auditPublicId: preview.executedAuditPublicId!, correlationId: preview.correlationId ?? ctx.correlationId };
        }
        if (preview.status !== "ready" || preview.expiresAt.getTime() <= Date.now()) throw new DomainError("STALE_LOAN_CANCEL_PREVIEW", "Loan cancellation preview is stale or expired", 409);
        if (preview.reason !== normalizedReason || preview.previewHash !== input.previewHash || preview.balanceVersion !== input.expectedBalanceVersion) {
            throw new DomainError("STALE_LOAN_CANCEL_PREVIEW", "Loan cancellation preview does not match the current confirmation", 409);
        }
        const state = await financialState(ctx, loan, tx);
        if (!state.eligible) throw new DomainError(state.code!, "Loan is no longer eligible for unfunded cancellation", 409, state.before);
        if (state.balanceVersion !== preview.balanceVersion) throw new DomainError("STALE_LOAN_CANCEL_PREVIEW", "Loan state changed after preview", 409);
        const updated = await tx.update(loans).set({
            status: "cancelled",
            outstandingPrincipal: "0.00",
            outstandingInterest: "0.00",
            outstandingFees: "0.00",
            nextDueDate: null,
            updatedAt: new Date(),
        }).where(and(eq(loans.tenantId, ctx.tenantId), eq(loans.id, loan.id), eq(loans.status, "active"))).returning().then((rows) => rows[0]);
        if (!updated) throw new DomainError("LOAN_STATE_CHANGED", "Loan state changed before cancellation", 409);
        await tx.update(loanSchedules).set({ status: "cancelled", remainingDue: "0.00", updatedAt: new Date() }).where(and(
            eq(loanSchedules.tenantId, ctx.tenantId),
            eq(loanSchedules.loanId, loan.id),
            sql`${loanSchedules.paidTotal} = 0`,
        ));
        const audit = await createAuditLog(tx, {
            ...auditContext(ctx), entityType: "loan", entityId: loan.publicId, action: "cancelled_unfunded",
            payload: { before: state.before, after: { status: "cancelled", outstandingPrincipal: "0.00", outstandingInterest: "0.00", outstandingFees: "0.00", nextDueDate: null }, reason: normalizedReason, eligibility: "unfunded", idempotencyKey: executionKey },
        });
        const executed = await tx.update(loanCancellationPreviews).set({
            status: "executed", executeIdempotencyKey: executionKey, executedAuditPublicId: audit.publicId,
            correlationId: ctx.correlationId, executedAt: new Date(), executedByUserId: ctx.actorUserId, updatedAt: new Date(),
        }).where(eq(loanCancellationPreviews.id, preview.id)).returning().then((rows) => rows[0]!);
        return { loan: updated, auditPublicId: audit.publicId, correlationId: executed.correlationId ?? ctx.correlationId };
    });
    await invalidateTenantCache(ctx.tenantId);
    return { ...(await presentLoan(result.loan)), auditPublicId: result.auditPublicId, auditPublicIds: [result.auditPublicId], correlationId: result.correlationId };
}
