import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db, type DbExecutor } from "../db";
import { borrowers, loanSchedules, loans, paymentBatchItems, paymentBatchStagingItems, paymentBatches, paymentIntakes, users } from "../db/schema";
import { canAccessTenantWideData } from "../lib/access";
import { serializeMoney } from "../lib/money";
import { bangkokBusinessDate } from "./payment-chronology-guard";
import { emptyFloatingBatchState, projectFloatingBatchPayment } from "./payment-batch-accounting-planner";
import { floatingInterestBalances } from "./floating-interest-service";
import { floatingCarriedBalances, planScheduledPayment, schedulePenaltyDue } from "./payment-service";
import { searchBorrowers } from "./borrower-service";
import type { CommandContext } from "./command-context";
import { DomainError } from "./domain-error";

const MAX_BORROWER_CANDIDATES = 25;
const MAX_CONTRACT_CANDIDATES = 100;
const MONEY_PATTERN = /^(0|[1-9]\d*)\.\d{2}$/;

export type PaymentBatchCandidateInput = {
    stagingItemPublicId: string;
    borrowerQuery?: string;
    amount?: string;
    receivedAt?: string;
};

function validTimestamp(value: string) {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) throw new DomainError("INVALID_CANDIDATE_INPUT", "receivedAt must be a valid ISO timestamp", 400);
    return parsed;
}

async function visibleStagingItem(ctx: CommandContext, publicId: string, tx: DbExecutor) {
    const row = await tx.query.paymentBatchStagingItems.findFirst({ where: and(eq(paymentBatchStagingItems.tenantId, ctx.tenantId), eq(paymentBatchStagingItems.publicId, publicId)) });
    if (!row) throw new DomainError("PAYMENT_BATCH_STAGING_NOT_FOUND", "Staging item not found", 404);
    const batch = await tx.query.paymentBatches.findFirst({ where: and(eq(paymentBatches.tenantId, ctx.tenantId), eq(paymentBatches.id, row.batchId)) });
    if (!batch) throw new DomainError("PAYMENT_BATCH_NOT_FOUND", "Payment batch not found", 404);
    const actor = ctx.actorUserId === null ? null : await tx.query.users.findFirst({ where: and(eq(users.id, ctx.actorUserId), eq(users.tenantId, ctx.tenantId)) });
    if (ctx.actorUserId !== null && !actor) throw new DomainError("ACTOR_NOT_FOUND", "Actor is not available in this tenant", 403);
    if (actor && !canAccessTenantWideData({ role: actor.role ?? "viewer" }) && batch.createdByUserId !== actor.id) throw new DomainError("PAYMENT_BATCH_NOT_FOUND", "Payment batch not found", 404);
    const batchItem = row.batchItemId === null ? null : await tx.query.paymentBatchItems.findFirst({ where: and(eq(paymentBatchItems.tenantId, ctx.tenantId), eq(paymentBatchItems.id, row.batchItemId)) });
    const intake = row.paymentIntakeId === null ? null : await tx.query.paymentIntakes.findFirst({ where: and(eq(paymentIntakes.tenantId, ctx.tenantId), eq(paymentIntakes.id, row.paymentIntakeId)) });
    return { row, batch, batchItem, intake };
}

async function visibleBorrowerRows(ctx: CommandContext, ids: string[], tx: DbExecutor) {
    if (!ids.length) return [];
    const actor = ctx.actorUserId === null ? null : await tx.query.users.findFirst({ where: and(eq(users.id, ctx.actorUserId), eq(users.tenantId, ctx.tenantId)) });
    if (ctx.actorUserId !== null && !actor) throw new DomainError("ACTOR_NOT_FOUND", "Actor is not available in this tenant", 403);
    const rows = await tx.select().from(borrowers).where(and(eq(borrowers.tenantId, ctx.tenantId), inArray(borrowers.publicId, ids)));
    if (actor && !canAccessTenantWideData({ role: actor.role ?? "viewer" })) return rows.filter((row) => row.ownerUserId === actor.id);
    return rows;
}

export async function discoverPaymentBatchCandidates(ctx: CommandContext, input: PaymentBatchCandidateInput) {
    return db.transaction(async (tx) => {
        const { row, batch, batchItem, intake } = await visibleStagingItem(ctx, input.stagingItemPublicId, tx);
        const amount = input.amount ?? intake?.amount ?? row.amount;
        const receivedAtText = input.receivedAt ?? intake?.receivedAt?.toISOString() ?? row.receivedAt?.toISOString();
        if (!amount || !receivedAtText) throw new DomainError("CANDIDATE_DATA_INCOMPLETE", "Candidate discovery needs a reviewed amount and receivedAt", 409);
        if (!MONEY_PATTERN.test(amount)) throw new DomainError("INVALID_CANDIDATE_INPUT", "amount must use exactly two decimal places", 400);
        const receivedAt = validTimestamp(receivedAtText);
        const query = input.borrowerQuery ?? row.payerName ?? "";
        const searched = query.trim() ? await searchBorrowers(ctx, { query }) : { resolution: "none" as const, matchType: null, candidates: [] };
        const searchedIds = searched.candidates.slice(0, MAX_BORROWER_CANDIDATES).map((candidate) => candidate.publicId);
        const visible = await visibleBorrowerRows(ctx, searchedIds, tx);
        const visibleIds = new Set(visible.map((borrower) => borrower.publicId));
        const borrowerCandidates = searched.candidates.slice(0, MAX_BORROWER_CANDIDATES).filter((candidate) => visibleIds.has(candidate.publicId)).map((candidate) => ({
            publicId: candidate.publicId,
            name: candidate.name,
            matchType: searched.matchType,
        }));
        const contracts: Array<Record<string, unknown>> = [];
        const businessDate = bangkokBusinessDate(receivedAt);
        for (const borrowerCandidate of borrowerCandidates) {
            const borrower = visible.find((candidate) => candidate.publicId === borrowerCandidate.publicId)!;
            const actor = ctx.actorUserId === null ? null : await tx.query.users.findFirst({ where: and(eq(users.id, ctx.actorUserId), eq(users.tenantId, ctx.tenantId)) });
            const borrowerLoans = await tx.select().from(loans).where(and(eq(loans.tenantId, ctx.tenantId), eq(loans.borrowerId, borrower.id))).orderBy(asc(loans.id));
            const accessibleLoans = actor && !canAccessTenantWideData({ role: actor.role ?? "viewer" }) ? borrowerLoans.filter((loan) => loan.ownerUserId === actor.id) : borrowerLoans;
            for (const loan of accessibleLoans) {
                if (contracts.length >= MAX_CONTRACT_CANDIDATES) break;
                const schedules = await tx.select().from(loanSchedules).where(and(eq(loanSchedules.tenantId, ctx.tenantId), eq(loanSchedules.loanId, loan.id))).orderBy(asc(loanSchedules.dueDate), asc(loanSchedules.installmentNo));
                const openSchedules = schedules.filter((schedule) => schedule.status !== "paid" && schedule.remainingDue !== "0");
                const nextSchedule = openSchedules[0] ?? null;
                let eligible = loan.status === "active";
                let eligibilityCode: string | null = eligible ? null : "LOAN_NOT_ACTIVE";
                let dueComponents: Record<string, string> | null = null;
                let proposalComponents: Record<string, string> | null = null;
                let nextDueDate: string | null = nextSchedule?.dueDate ?? null;
                if (loan.repaymentType === "floating") {
                    try {
                        const balances = await floatingInterestBalances(tx, loan, receivedAt, ctx);
                        const carried = await floatingCarriedBalances(tx, ctx.tenantId, loan.id);
                        dueComponents = {
                            principal: serializeMoney(loan.outstandingPrincipal ?? loan.principalAmount),
                            interest: serializeMoney(balances.dueInterest.plus(carried?.carriedInterest ?? 0)),
                            fee: serializeMoney(carried?.carriedFee ?? 0),
                            penalty: serializeMoney(balances.applicablePenalty.plus(carried?.carriedPenalty ?? 0)),
                        };
                        const projected = await projectFloatingBatchPayment(tx, ctx, loan, receivedAt, amount, "on_time", emptyFloatingBatchState());
                        proposalComponents = projected.components;
                        nextDueDate = projected.throughDate;
                    } catch (error) {
                        eligible = false;
                        eligibilityCode = error instanceof DomainError ? error.code : "FLOATING_PROVENANCE_UNAVAILABLE";
                    }
                } else if (nextSchedule) {
                    const penalty = schedulePenaltyDue(loan, nextSchedule, receivedAt);
                    const dueAmount = new Decimal(nextSchedule.remainingDue).plus(penalty);
                    const duePlan = await planScheduledPayment(tx, ctx.tenantId, loan, nextSchedule, dueAmount.toFixed(2), receivedAt);
                    dueComponents = Object.fromEntries(Object.entries(duePlan.components).map(([key, value]) => [key, value.toFixed(2)]));
                    if (new Decimal(amount).lte(dueAmount)) {
                        const proposal = await planScheduledPayment(tx, ctx.tenantId, loan, nextSchedule, amount, receivedAt);
                        proposalComponents = Object.fromEntries(Object.entries(proposal.components).map(([key, value]) => [key, value.toFixed(2)]));
                    }
                    if (nextSchedule.dueDate > businessDate) {
                        eligible = false;
                        eligibilityCode = "FUTURE_SCHEDULE_REQUIRES_REVIEW";
                    }
                } else {
                    eligible = false;
                    eligibilityCode = "NO_OPEN_SCHEDULE";
                }
                contracts.push({
                    borrowerPublicId: borrower.publicId,
                    borrowerName: borrower.name,
                    loanPublicId: loan.publicId,
                    repaymentType: loan.repaymentType,
                    status: loan.status,
                    eligible,
                    eligibilityCode,
                    principalAmount: serializeMoney(loan.principalAmount),
                    outstandingPrincipal: serializeMoney(loan.outstandingPrincipal ?? loan.principalAmount),
                    interestRate: serializeMoney(loan.interestRate),
                    startDate: loan.startDate ?? null,
                    nextDueDate,
                    dueComponents,
                    proposalComponents,
                    schedules: openSchedules.slice(0, 50).map((schedule) => ({
                        publicId: schedule.publicId,
                        dueDate: schedule.dueDate,
                        status: schedule.status,
                        remainingDue: serializeMoney(schedule.remainingDue),
                        components: { principal: serializeMoney(schedule.scheduledPrincipal), interest: serializeMoney(schedule.scheduledInterest), fee: serializeMoney(schedule.scheduledFee), penalty: "0.00" },
                    })),
                });
            }
        }
        return {
            stagingItemPublicId: row.publicId,
            batchItemPublicId: batchItem?.publicId ?? null,
            stagingRevision: row.revision,
            batchRevision: batch.version,
            amount,
            receivedAt: receivedAt.toISOString(),
            businessDate,
            inputFingerprint: `v1:${createHash("sha256").update(JSON.stringify({ stagingItemPublicId: row.publicId, stagingRevision: row.revision, batchRevision: batch.version, borrowerQuery: query.trim(), amount, receivedAt: receivedAt.toISOString() })).digest("hex")}`,
            borrowerResolution: searched.resolution,
            matchType: searched.matchType,
            borrowerCandidates,
            contractCandidates: contracts,
            candidateLimitReached: contracts.length >= MAX_CONTRACT_CANDIDATES,
            reviewRequired: searched.resolution !== "unique" || contracts.filter((candidate) => candidate.eligible).length !== 1,
        };
    });
}
