import { createHash } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { db, type DbExecutor } from "../db";
import {
    auditLogs, bankLoans, bankProfiles, intermediatedDisbursementGroups, intermediaryCollections,
    intermediaryRemittanceAllocations, intermediaryRemittances, loanAdjustments, loanCommissionParticipants,
    loanDisbursementEvents, loanFundingAllocations, loanIntermediaryAssignments, loanRenewals,
    loanReplacementCorrections, loanReplacements, loanRestructures, loanRestructureWaivers, loanSchedules,
    loanSettlementPreviews, loans, paymentIntermediaryAttributions, transactions, users,
} from "../db/schema";
import { canAccessTenantWideData } from "../lib/access";
import { createAuditLog } from "../lib/audit-log";
import { FinancialDecimal } from "../lib/financial-decimal";
import { computeScheduledOutstandingPenalty } from "../lib/loan-payment-health";
import {
    isLoanReplacementProposal,
    type LoanReplacementProposal,
} from "../lib/loan-replacement-proposal";
import { generateLoanSchedule } from "../lib/loan-schedule";
import type { RepaymentType } from "../lib/calculator";
import { serializeMoney } from "../lib/money";
import type { CommandContext } from "./command-context";
import { DomainError } from "./domain-error";
import { activateLoanInTransaction } from "./loan-application-service";

type Executor = DbExecutor;
type Loan = typeof loans.$inferSelect;
type Replacement = typeof loanReplacements.$inferSelect;

interface ReplacementExecutionSnapshot {
    old: {
        loan: {
            status: string;
            outstandingPrincipal: string;
            outstandingInterest: string;
            outstandingFees: string;
            nextDueDate: string | null;
        };
        schedules: Array<{
            id: number;
            status: string;
            remainingDue: string;
            paidTotal: string;
            paidPenalty: string;
        }>;
    };
}

export type { LoanReplacementProposal } from "../lib/loan-replacement-proposal";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const versionPattern = /^v1:[0-9a-f]{64}$/i;
const previewTtlMs = 15 * 60 * 1000;

export interface LoanReplacementPreview extends LoanReplacementProposal {
    publicId: string; previewHash: string; oldBalanceVersion: string; replacementDraftVersion: string; expiresAt: Date;
    auditPublicId: string; correlationId: string;
}
export interface LoanReplacementExecution {
    replacementPublicId: string; oldLoanPublicId: string; replacementLoanPublicId: string; status: "executed";
    auditPublicId: string; correlationId: string;
}
export interface LoanReplacementReversal {
    replacementPublicId: string; oldLoanPublicId: string; replacementLoanPublicId: string; status: "reversed";
    auditPublicId: string; correlationId: string;
}

function auditContext(ctx: CommandContext) {
    return { tenantId: ctx.tenantId, actorUserId: ctx.actorUserId, actorSource: ctx.actorSource, requestId: ctx.requestId, correlationId: ctx.correlationId };
}
function canonicalValue(value: unknown): unknown {
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.map(canonicalValue);
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, nested]) => [key, canonicalValue(nested)]));
    }
    return value;
}
function sha(value: unknown) { return createHash("sha256").update(JSON.stringify(canonicalValue(value))).digest("hex"); }
function version(value: unknown) { return `v1:${sha(value)}`; }
function publicId(value: string, field: string) {
    if (!uuidPattern.test(value)) throw new DomainError("INVALID_PUBLIC_ID", `${field} must be a UUID`, 400, { field });
    return value;
}
function reason(value: string, code = "REPLACEMENT_REASON_REQUIRED") {
    const normalized = value.trim();
    if (!normalized) throw new DomainError(code, "A non-blank replacement reason is required", 400);
    return normalized;
}
function idempotencyKey(ctx: CommandContext) {
    const key = ctx.idempotencyKey?.trim();
    if (!key) throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", "Loan replacement requires a non-blank Idempotency-Key", 400);
    return key;
}
function signedMoney(value: InstanceType<typeof FinancialDecimal>) { return value.toFixed(2); }
function reviewRequired(code: string, message: string, blockerPublicIds: string[] = []): never {
    throw new DomainError(code, message, 409, { reviewRequired: true, blockerPublicIds });
}
async function admin(ctx: CommandContext, executor: Executor = db) {
    if (ctx.actorUserId === null) throw new DomainError("TENANT_ADMIN_REQUIRED", "A tenant owner or manager is required", 403);
    const actor = await executor.query.users.findFirst({ where: and(eq(users.tenantId, ctx.tenantId), eq(users.id, ctx.actorUserId)) });
    if (!actor || !canAccessTenantWideData({ role: actor.role ?? "viewer" })) throw new DomainError("TENANT_ADMIN_REQUIRED", "A tenant owner or manager is required", 403);
}
async function loanFor(ctx: CommandContext, executor: Executor, id: string) {
    const row = await executor.query.loans.findFirst({ where: and(eq(loans.tenantId, ctx.tenantId), eq(loans.publicId, id)) });
    if (!row) throw new DomainError("LOAN_NOT_FOUND", "Loan not found", 404);
    return row as Loan;
}
function activeRows<T extends { id: number; publicId?: string; entryType?: string | null; reversedTransactionId?: number | null; status?: string | null; reversedEventId?: number | null }>(rows: T[]) {
    const reversedTransactionIds = new Set(rows.filter(row => row.entryType === "reversal" && row.reversedTransactionId !== null).map(row => row.reversedTransactionId!));
    const reversedEventIds = new Set(rows.filter(row => row.reversedEventId !== null).map(row => row.reversedEventId!));
    return rows.filter(row => (row.entryType !== "repayment" || !reversedTransactionIds.has(row.id)) && (row.status !== "posted" || !reversedEventIds.has(row.id)));
}

async function loadDownstream(executor: Executor, ctx: CommandContext, loanId: number) {
    const [
        paymentRows,
        disbursementRows,
        renewalRows,
        restructureRows,
        settlementRows,
        waiverRows,
        replacementRows,
        collectionRows,
        remittanceRows,
        assignmentRows,
        commissionRows,
        intermediatedDisbursementRows,
        adjustmentRows,
        attributionRows,
    ] = await Promise.all([
        executor.select().from(transactions)
            .where(and(eq(transactions.tenantId, ctx.tenantId), eq(transactions.loanId, loanId)))
            .orderBy(asc(transactions.id)),
        executor.select().from(loanDisbursementEvents)
            .where(and(eq(loanDisbursementEvents.tenantId, ctx.tenantId), eq(loanDisbursementEvents.loanId, loanId)))
            .orderBy(asc(loanDisbursementEvents.id)),
        executor.select().from(loanRenewals)
            .where(and(eq(loanRenewals.tenantId, ctx.tenantId), eq(loanRenewals.oldLoanId, loanId)))
            .orderBy(asc(loanRenewals.id)),
        executor.select().from(loanRestructures)
            .where(and(eq(loanRestructures.tenantId, ctx.tenantId), eq(loanRestructures.oldLoanId, loanId)))
            .orderBy(asc(loanRestructures.id)),
        executor.select().from(loanSettlementPreviews)
            .where(and(eq(loanSettlementPreviews.tenantId, ctx.tenantId), eq(loanSettlementPreviews.loanId, loanId)))
            .orderBy(asc(loanSettlementPreviews.id)),
        executor.select().from(loanRestructureWaivers)
            .where(and(eq(loanRestructureWaivers.tenantId, ctx.tenantId), eq(loanRestructureWaivers.loanId, loanId)))
            .orderBy(asc(loanRestructureWaivers.id)),
        executor.select().from(loanReplacements)
            .where(and(
                eq(loanReplacements.tenantId, ctx.tenantId),
                eq(loanReplacements.oldLoanId, loanId),
                eq(loanReplacements.status, "executed"),
            ))
            .orderBy(asc(loanReplacements.id)),
        executor.select().from(intermediaryCollections)
            .where(and(eq(intermediaryCollections.tenantId, ctx.tenantId), eq(intermediaryCollections.loanId, loanId)))
            .orderBy(asc(intermediaryCollections.id)),
        executor.select({
            allocationPublicId: intermediaryRemittanceAllocations.publicId,
            allocationReleasedAt: intermediaryRemittanceAllocations.releasedAt,
            collectionPublicId: intermediaryCollections.publicId,
            collectionStatus: intermediaryCollections.status,
            remittancePublicId: intermediaryRemittances.publicId,
            remittanceStatus: intermediaryRemittances.status,
        }).from(intermediaryRemittanceAllocations)
            .innerJoin(intermediaryCollections, and(
                eq(intermediaryCollections.tenantId, intermediaryRemittanceAllocations.tenantId),
                eq(intermediaryCollections.id, intermediaryRemittanceAllocations.collectionId),
            ))
            .innerJoin(intermediaryRemittances, and(
                eq(intermediaryRemittances.tenantId, intermediaryRemittanceAllocations.tenantId),
                eq(intermediaryRemittances.id, intermediaryRemittanceAllocations.remittanceId),
            ))
            .where(and(
                eq(intermediaryRemittanceAllocations.tenantId, ctx.tenantId),
                eq(intermediaryCollections.loanId, loanId),
            )).orderBy(asc(intermediaryRemittanceAllocations.id)),
        executor.select().from(loanIntermediaryAssignments)
            .where(and(eq(loanIntermediaryAssignments.tenantId, ctx.tenantId), eq(loanIntermediaryAssignments.loanId, loanId)))
            .orderBy(asc(loanIntermediaryAssignments.id)),
        executor.select().from(loanCommissionParticipants)
            .where(and(eq(loanCommissionParticipants.tenantId, ctx.tenantId), eq(loanCommissionParticipants.loanId, loanId)))
            .orderBy(asc(loanCommissionParticipants.id)),
        executor.select().from(intermediatedDisbursementGroups)
            .where(and(eq(intermediatedDisbursementGroups.tenantId, ctx.tenantId), eq(intermediatedDisbursementGroups.loanId, loanId)))
            .orderBy(asc(intermediatedDisbursementGroups.id)),
        executor.select().from(loanAdjustments)
            .where(and(eq(loanAdjustments.tenantId, ctx.tenantId), eq(loanAdjustments.loanId, loanId)))
            .orderBy(asc(loanAdjustments.id)),
        executor.select({
            id: paymentIntermediaryAttributions.id,
            publicId: paymentIntermediaryAttributions.publicId,
            attributedAmount: paymentIntermediaryAttributions.attributedAmount,
            reversedAttributionId: paymentIntermediaryAttributions.reversedAttributionId,
        }).from(paymentIntermediaryAttributions)
            .innerJoin(transactions, and(
                eq(transactions.tenantId, paymentIntermediaryAttributions.tenantId),
                eq(transactions.id, paymentIntermediaryAttributions.paymentId),
            ))
            .where(and(eq(paymentIntermediaryAttributions.tenantId, ctx.tenantId), eq(transactions.loanId, loanId)))
            .orderBy(asc(paymentIntermediaryAttributions.id)),
    ]);
    return {
        paymentRows,
        disbursementRows,
        renewalRows,
        restructureRows,
        settlementRows,
        waiverRows,
        replacementRows,
        collectionRows,
        remittanceRows,
        assignmentRows,
        commissionRows,
        intermediatedDisbursementRows,
        adjustmentRows,
        attributionRows,
    };
}

function effectiveDownstream(rows: Awaited<ReturnType<typeof loadDownstream>>) {
    const reversedWaiverIds = new Set(rows.waiverRows
        .filter((row) => row.status === "reversed" && row.reversedWaiverId !== null)
        .map((row) => row.reversedWaiverId));
    const compensatedGroupIds = new Set(rows.intermediatedDisbursementRows
        .filter((row) => row.status === "reversed" && row.reversedGroupId !== null)
        .map((row) => row.reversedGroupId));
    const reversedAttributionIds = new Set(rows.attributionRows
        .filter((row) => row.reversedAttributionId !== null)
        .map((row) => row.reversedAttributionId));
    const postedPaymentIds = activeRows(rows.paymentRows)
        .filter((row) => row.entryType === "repayment")
        .map((row) => row.publicId);
    const postedDisbursementIds = activeRows(rows.disbursementRows)
        .filter((row) => row.status === "posted")
        .map((row) => row.publicId);
    const dependentWorkflowIds = [
        ...rows.renewalRows.filter((row) => row.status === "executed").map((row) => row.publicId),
        ...rows.restructureRows.filter((row) => row.status === "executed").map((row) => row.publicId),
        ...rows.settlementRows.filter((row) => row.status === "executed").map((row) => row.publicId),
        ...rows.replacementRows.map((row) => row.publicId),
    ];
    const otherIds = [
        ...rows.waiverRows
            .filter((row) => row.status === "executed" && !reversedWaiverIds.has(row.id))
            .map((row) => row.publicId),
        ...rows.collectionRows
            .filter((row) => row.status !== "reversed")
            .map((row) => row.publicId),
        ...rows.remittanceRows
            .filter((row) => row.allocationReleasedAt === null && row.collectionStatus !== "reversed" && row.remittanceStatus !== "reversed")
            .flatMap((row) => [row.remittancePublicId, row.allocationPublicId]),
        ...rows.assignmentRows
            .filter((row) => row.status === "active")
            .map((row) => row.publicId),
        ...rows.commissionRows.map((row) => row.publicId),
        ...rows.intermediatedDisbursementRows
            .filter((row) => ["draft", "needs_review", "ready"].includes(row.status)
                || (row.status === "posted" && !compensatedGroupIds.has(row.id)))
            .map((row) => row.publicId),
        ...rows.adjustmentRows
            .filter((row) => row.status === "posted")
            .map((row) => row.publicId),
        ...rows.attributionRows
            .filter((row) => new FinancialDecimal(row.attributedAmount).gt(0) && !reversedAttributionIds.has(row.id))
            .map((row) => row.publicId),
    ];
    const unique = (ids: string[]) => [...new Set(ids)];
    return {
        postedPaymentIds: unique(postedPaymentIds),
        postedDisbursementIds: unique(postedDisbursementIds),
        dependentWorkflowIds: unique(dependentWorkflowIds),
        otherIds: unique(otherIds),
    };
}

async function state(executor: Executor, ctx: CommandContext, oldLoan: Loan, draft: Loan) {
    const [oldSchedules, draftSchedules, oldDownstream, draftDownstream, oldAllocations, draftAllocations, priorOld, priorDraft] = await Promise.all([
        executor.select().from(loanSchedules).where(and(eq(loanSchedules.tenantId, ctx.tenantId), eq(loanSchedules.loanId, oldLoan.id))).orderBy(asc(loanSchedules.installmentNo)),
        executor.select().from(loanSchedules).where(and(eq(loanSchedules.tenantId, ctx.tenantId), eq(loanSchedules.loanId, draft.id))).orderBy(asc(loanSchedules.installmentNo)),
        loadDownstream(executor, ctx, oldLoan.id),
        loadDownstream(executor, ctx, draft.id),
        executor.select().from(loanFundingAllocations).where(and(eq(loanFundingAllocations.tenantId, ctx.tenantId), eq(loanFundingAllocations.loanId, oldLoan.id))).orderBy(asc(loanFundingAllocations.id)),
        executor.select().from(loanFundingAllocations).where(and(eq(loanFundingAllocations.tenantId, ctx.tenantId), eq(loanFundingAllocations.loanId, draft.id))).orderBy(asc(loanFundingAllocations.id)),
        executor.select().from(loanReplacements).where(and(eq(loanReplacements.tenantId, ctx.tenantId), eq(loanReplacements.oldLoanId, oldLoan.id), eq(loanReplacements.status, "executed"))).limit(1),
        executor.select().from(loanReplacements).where(and(eq(loanReplacements.tenantId, ctx.tenantId), eq(loanReplacements.replacementLoanId, draft.id), eq(loanReplacements.status, "executed"))).limit(1),
    ]);
    const oldBalanceVersion = version({
        loan: {
            publicId: oldLoan.publicId,
            status: oldLoan.status,
            outstandingPrincipal: oldLoan.outstandingPrincipal,
            outstandingInterest: oldLoan.outstandingInterest,
            outstandingFees: oldLoan.outstandingFees,
            nextDueDate: oldLoan.nextDueDate,
            gracePeriodDays: oldLoan.gracePeriodDays,
            lateFeeMode: oldLoan.lateFeeMode,
            lateFeeAmount: oldLoan.lateFeeAmount,
            updatedAt: oldLoan.updatedAt?.toISOString(),
        },
        schedules: oldSchedules,
        allocations: oldAllocations,
        downstream: oldDownstream,
    });
    const replacementDraftVersion = version({
        loan: {
            publicId: draft.publicId,
            ownerUserId: draft.ownerUserId,
            borrowerId: draft.borrowerId,
            status: draft.status,
            principalAmount: draft.principalAmount,
            interestRate: draft.interestRate,
            repaymentType: draft.repaymentType,
            termMonths: draft.termMonths,
            installmentAmount: draft.installmentAmount,
            totalInstallments: draft.totalInstallments,
            startDate: draft.startDate,
            gracePeriodDays: draft.gracePeriodDays,
            lateFeeMode: draft.lateFeeMode,
            lateFeeAmount: draft.lateFeeAmount,
            dailyTermUnit: draft.dailyTermUnit,
            dailyTermValue: draft.dailyTermValue,
            dailyEntryMode: draft.dailyEntryMode,
            dailyInterestInputMode: draft.dailyInterestInputMode,
            dailyInterestInputValue: draft.dailyInterestInputValue,
            dailyFlatRatePercent: draft.dailyFlatRatePercent,
            bankLoanId: draft.bankLoanId,
            fundingBankProfileId: draft.fundingBankProfileId,
            updatedAt: draft.updatedAt?.toISOString(),
        },
        schedules: draftSchedules,
        allocations: draftAllocations,
        downstream: draftDownstream,
    });
    return {
        oldSchedules,
        draftSchedules,
        oldTransactions: oldDownstream.paymentRows,
        oldDisbursements: oldDownstream.disbursementRows,
        oldDownstream,
        draftDownstream,
        oldAllocations,
        draftAllocations,
        priorOld: priorOld[0],
        priorDraft: priorDraft[0],
        oldBalanceVersion,
        replacementDraftVersion,
    };
}
async function validate(ctx: CommandContext, executor: Executor, oldLoan: Loan, draft: Loan, current?: Awaited<ReturnType<typeof state>>) {
    current ??= await state(executor, ctx, oldLoan, draft);
    if (oldLoan.status !== "active") reviewRequired("OLD_LOAN_NOT_REPLACEABLE", "Only an active loan can be replaced", [oldLoan.publicId]);
    if (draft.status !== "draft") reviewRequired("REPLACEMENT_DRAFT_NOT_AVAILABLE", "Replacement loan must still be a draft", [draft.publicId]);
    if (!["daily", "weekly", "monthly"].includes(oldLoan.repaymentType) || !["daily", "weekly", "monthly"].includes(draft.repaymentType)) reviewRequired("REPLACEMENT_TYPE_UNSUPPORTED", "Only scheduled loans can be replaced", [oldLoan.publicId, draft.publicId]);
    authoritativeReplacementSchedule(draft);
    if (oldLoan.borrowerId !== draft.borrowerId || oldLoan.ownerUserId !== draft.ownerUserId) reviewRequired("REPLACEMENT_SCOPE_MISMATCH", "Replacement loans must have the same borrower and owner", [oldLoan.publicId, draft.publicId]);
    if (current.priorOld || current.priorDraft) reviewRequired("REPLACEMENT_ALREADY_EXECUTED", "A loan already has an executed replacement", [current.priorOld?.publicId ?? current.priorDraft!.publicId]);
    const draftDownstream = effectiveDownstream(current.draftDownstream);
    const draftBlockerIds = [...new Set([
        ...draftDownstream.postedPaymentIds,
        ...draftDownstream.postedDisbursementIds,
        ...draftDownstream.dependentWorkflowIds,
        ...draftDownstream.otherIds,
        ...current.draftDownstream.disbursementRows
            .filter((row) => row.status === "draft")
            .map((row) => row.publicId),
        ...current.draftAllocations
            .filter((row) => row.allocationType !== "initial")
            .map((row) => row.publicId),
    ])];
    if (draftBlockerIds.length) reviewRequired(
        "REPLACEMENT_DRAFT_DOWNSTREAM_ACTIVITY",
        "Replacement draft has downstream activity and requires human review",
        draftBlockerIds,
    );
    const downstream = effectiveDownstream(current.oldDownstream);
    const financialBlockerIds = [...downstream.postedPaymentIds, ...downstream.postedDisbursementIds];
    if (financialBlockerIds.length) reviewRequired(
        "REPLACEMENT_DOWNSTREAM_ACTIVITY",
        "Posted payment or effective disbursement requires human review",
        financialBlockerIds,
    );
    if (downstream.dependentWorkflowIds.length) reviewRequired(
        "REPLACEMENT_DEPENDENT_WORKFLOW",
        "An executed dependent workflow requires human review",
        downstream.dependentWorkflowIds,
    );
    if (downstream.otherIds.length) reviewRequired(
        "REPLACEMENT_DOWNSTREAM_ACTIVITY",
        "Unsupported downstream activity requires human review",
        downstream.otherIds,
    );
    if (!draft.bankLoanId && !draft.fundingBankProfileId) reviewRequired("REPLACEMENT_FUNDING_MISSING", "Replacement draft has no funding source", [draft.publicId]);
    if (draft.bankLoanId) {
        const source = await executor.query.bankLoans.findFirst({ where: and(eq(bankLoans.tenantId, ctx.tenantId), eq(bankLoans.id, draft.bankLoanId)) });
        if (!source || source.status !== "active") reviewRequired("REPLACEMENT_FUNDING_INVALID", "Replacement funding drawdown is not active", [source?.publicId ?? draft.publicId]);
        const allocated = await executor.select({ total: sql<string>`coalesce(sum(${loanFundingAllocations.allocatedAmount}), 0)` }).from(loanFundingAllocations).where(and(eq(loanFundingAllocations.tenantId, ctx.tenantId), eq(loanFundingAllocations.bankLoanId, source.id))).then((rows: Array<{ total: string | null }>) => new FinancialDecimal(rows[0]?.total ?? "0"));
        const already = current.draftAllocations.reduce((total, row) => total.plus(row.allocatedAmount), new FinancialDecimal(0));
        const needed = FinancialDecimal.max(new FinancialDecimal(0), new FinancialDecimal(draft.principalAmount).minus(already));
        if (needed.gt(new FinancialDecimal(source.amount).minus(allocated))) reviewRequired("REPLACEMENT_FUNDING_INSUFFICIENT", "Replacement funding capacity is insufficient", [source.publicId]);
        const wrong = current.draftAllocations.find((row) => row.bankLoanId !== source.id || row.bankProfileId !== source.bankProfileId);
        if (wrong) reviewRequired("REPLACEMENT_FUNDING_MISMATCH", "Replacement allocation does not match its configured funding source", [wrong.publicId, source.publicId]);
    } else if (draft.fundingBankProfileId) {
        const source = await executor.query.bankProfiles.findFirst({ where: and(eq(bankProfiles.tenantId, ctx.tenantId), eq(bankProfiles.id, draft.fundingBankProfileId)) });
        if (!source || source.status !== "active" || source.accountingMode !== "capital_pool") reviewRequired("REPLACEMENT_FUNDING_INVALID", "Replacement capital source is not active", [source?.publicId ?? draft.publicId]);
        const allocated = await executor.select({ total: sql<string>`coalesce(sum(${loanFundingAllocations.allocatedAmount}), 0)` }).from(loanFundingAllocations).where(and(eq(loanFundingAllocations.tenantId, ctx.tenantId), eq(loanFundingAllocations.bankProfileId, source.id))).then((rows: Array<{ total: string | null }>) => new FinancialDecimal(rows[0]?.total ?? "0"));
        const already = current.draftAllocations.reduce((total, row) => total.plus(row.allocatedAmount), new FinancialDecimal(0));
        const needed = FinancialDecimal.max(new FinancialDecimal(0), new FinancialDecimal(draft.principalAmount).minus(already));
        if (needed.gt(new FinancialDecimal(source.creditLimit ?? "0").minus(allocated))) reviewRequired("REPLACEMENT_FUNDING_INSUFFICIENT", "Replacement capital capacity is insufficient", [source.publicId]);
        const wrong = current.draftAllocations.find((row) => row.bankProfileId !== source.id || row.bankLoanId !== null);
        if (wrong) reviewRequired("REPLACEMENT_FUNDING_MISMATCH", "Replacement allocation does not match its configured funding source", [wrong.publicId, source.publicId]);
    }
    return current;
}
function bangkokBusinessDate(value: Date): string {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Bangkok",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(value);
    const read = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
    return `${read("year")}-${read("month")}-${read("day")}`;
}

function correction(
    oldLoan: Loan,
    schedules: Array<typeof loanSchedules.$inferSelect>,
    asOfDate: string,
) {
    const penalty = new FinancialDecimal(computeScheduledOutstandingPenalty({
        businessDate: asOfDate,
        gracePeriodDays: oldLoan.gracePeriodDays,
        lateFeeMode: oldLoan.lateFeeMode,
        lateFeeAmount: oldLoan.lateFeeAmount,
        schedules: schedules.map((row) => ({
            dueDate: row.dueDate,
            remainingDue: row.remainingDue,
            paidPenalty: row.paidPenalty,
            baseStatus: row.status,
        })),
    }));
    return {
        principal: new FinancialDecimal(oldLoan.outstandingPrincipal ?? "0"),
        interest: new FinancialDecimal(oldLoan.outstandingInterest ?? "0"),
        fee: new FinancialDecimal(oldLoan.outstandingFees ?? "0"),
        penalty,
    };
}

function previewHash(current: Awaited<ReturnType<typeof state>>, proposal: LoanReplacementProposal) {
    return version({
        contract: "atomic-loan-replacement",
        proposal,
        oldBalanceVersion: current.oldBalanceVersion,
        replacementDraftVersion: current.replacementDraftVersion,
    });
}

async function buildProposal(
    executor: Executor,
    ctx: CommandContext,
    oldLoan: Loan,
    draft: Loan,
    current: Awaited<ReturnType<typeof state>>,
    why: string,
    asOfDate: string,
): Promise<LoanReplacementProposal> {
    const calculated = correction(oldLoan, current.oldSchedules, asOfDate);
    const generated = authoritativeReplacementSchedule(draft);
    const totalRepayment = generated.reduce(
        (total, item) => total.plus(item.scheduledTotal),
        new FinancialDecimal(0),
    );
    const source = draft.bankLoanId
        ? await executor.query.bankLoans.findFirst({
            where: and(eq(bankLoans.tenantId, ctx.tenantId), eq(bankLoans.id, draft.bankLoanId)),
        })
        : await executor.query.bankProfiles.findFirst({
            where: and(eq(bankProfiles.tenantId, ctx.tenantId), eq(bankProfiles.id, draft.fundingBankProfileId!)),
        });
    if (!source || !draft.startDate || !draft.termMonths || generated.length === 0) {
        reviewRequired(
            "REPLACEMENT_TERMS_INVALID",
            "Replacement proposal cannot be represented from the validated terms",
            [draft.publicId],
        );
    }
    const correctionValues = {
        principal: serializeMoney(calculated.principal),
        interest: serializeMoney(calculated.interest),
        fee: serializeMoney(calculated.fee),
        penalty: serializeMoney(calculated.penalty),
    };
    const warnings: string[] = [];
    if (calculated.interest.gt(0)) {
        warnings.push(`Outstanding calculated interest of ${correctionValues.interest} is corrected to zero and is neither collected nor carried forward.`);
    }
    if (calculated.penalty.gt(0)) {
        warnings.push(`Outstanding penalty of ${correctionValues.penalty} is corrected to zero and is not treated as borrower payment.`);
    }
    return {
        schemaVersion: 1,
        asOfDate,
        reason: why,
        oldLoan: {
            loanPublicId: oldLoan.publicId,
            statusBefore: "active",
            statusAfter: "replaced",
            principal: serializeMoney(oldLoan.principalAmount),
            collectibleBefore: {
                ...correctionValues,
                nextDueDate: oldLoan.nextDueDate,
            },
            collectibleAfter: {
                principal: "0.00",
                interest: "0.00",
                fee: "0.00",
                penalty: "0.00",
                nextDueDate: null,
            },
        },
        cash: { direction: "none", amount: "0.00" },
        correction: correctionValues,
        replacement: {
            loanPublicId: draft.publicId,
            statusBefore: "draft",
            statusAfter: "active",
            principal: serializeMoney(draft.principalAmount),
            interestRate: serializeMoney(draft.interestRate),
            repaymentType: draft.repaymentType as "daily" | "weekly" | "monthly",
            termMonths: draft.termMonths,
            totalInstallments: draft.totalInstallments ?? generated.length,
            installmentAmount: serializeMoney(draft.installmentAmount ?? generated[0]!.scheduledTotal),
            startDate: draft.startDate,
            firstDueDate: generated[0]!.dueDate,
            lastDueDate: generated.at(-1)!.dueDate,
            totalRepayment: serializeMoney(totalRepayment),
            fundingSourceKind: draft.bankLoanId ? "drawdown" : "own_capital",
            fundingSourcePublicId: source.publicId,
        },
        warnings,
    };
}

function storedProposal(record: Replacement): LoanReplacementProposal {
    if (!isLoanReplacementProposal(record.previewSnapshot)
        || record.previewSnapshot.asOfDate !== record.previewAsOfDate
        || record.previewSnapshot.reason !== record.reason) {
        reviewRequired(
            "REPLACEMENT_SNAPSHOT_MISSING",
            "The persisted replacement proposal is unavailable or invalid",
            [record.publicId],
        );
    }
    return record.previewSnapshot;
}

function isObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function storedExecutionSnapshot(record: Replacement): ReplacementExecutionSnapshot | null {
    const root = record.preExecutionSnapshot;
    if (!isObject(root) || !isObject(root.old)) return null;
    const loan = root.old.loan;
    const schedules = root.old.schedules;
    if (!isObject(loan)
        || typeof loan.status !== "string"
        || typeof loan.outstandingPrincipal !== "string"
        || typeof loan.outstandingInterest !== "string"
        || typeof loan.outstandingFees !== "string"
        || (loan.nextDueDate !== null && typeof loan.nextDueDate !== "string")
        || !Array.isArray(schedules)) return null;
    const normalizedSchedules: ReplacementExecutionSnapshot["old"]["schedules"] = [];
    for (const schedule of schedules) {
        if (!isObject(schedule)
            || typeof schedule.id !== "number"
            || typeof schedule.status !== "string"
            || typeof schedule.remainingDue !== "string"
            || typeof schedule.paidTotal !== "string"
            || typeof schedule.paidPenalty !== "string") return null;
        normalizedSchedules.push({
            id: schedule.id,
            status: schedule.status,
            remainingDue: schedule.remainingDue,
            paidTotal: schedule.paidTotal,
            paidPenalty: schedule.paidPenalty,
        });
    }
    return {
        old: {
            loan: {
                status: loan.status,
                outstandingPrincipal: loan.outstandingPrincipal,
                outstandingInterest: loan.outstandingInterest,
                outstandingFees: loan.outstandingFees,
                nextDueDate: loan.nextDueDate,
            },
            schedules: normalizedSchedules,
        },
    };
}
function authoritativeReplacementSchedule(loan: Loan) {
    if (!loan.termMonths || !loan.startDate || !["daily", "weekly", "monthly"].includes(loan.repaymentType)) {
        throw new DomainError("REPLACEMENT_TERMS_INVALID", "Replacement draft does not contain complete scheduled-loan terms", 409, { reviewRequired: true, blockerPublicIds: [loan.publicId] });
    }
    try {
        return generateLoanSchedule({
            principal: loan.principalAmount, interestRate: loan.interestRate, termMonths: loan.termMonths,
            repaymentType: loan.repaymentType as RepaymentType, startDate: loan.startDate,
            totalInstallments: loan.totalInstallments ?? undefined, installmentAmount: loan.installmentAmount ?? undefined,
        });
    } catch (error) {
        throw new DomainError("REPLACEMENT_TERMS_INVALID", error instanceof Error ? error.message : "Replacement terms cannot be activated", 409, { reviewRequired: true, blockerPublicIds: [loan.publicId] });
    }
}

export async function previewLoanReplacement(ctx: CommandContext, input: { oldLoanPublicId: string; replacementDraftPublicId: string; reason: string }): Promise<LoanReplacementPreview> {
    await admin(ctx);
    const oldLoanPublicId = publicId(input.oldLoanPublicId, "oldLoanPublicId");
    const replacementDraftPublicId = publicId(input.replacementDraftPublicId, "replacementDraftPublicId");
    const why = reason(input.reason);
    const asOfDate = bangkokBusinessDate(new Date());
    return db.transaction(async tx => {
        const [oldLoan, draft] = await Promise.all([loanFor(ctx, tx, oldLoanPublicId), loanFor(ctx, tx, replacementDraftPublicId)]);
        const current = await validate(ctx, tx, oldLoan, draft);
        const proposal = await buildProposal(tx, ctx, oldLoan, draft, current, why, asOfDate);
        const hash = previewHash(current, proposal);
        const row = await tx.insert(loanReplacements).values({
            tenantId: ctx.tenantId,
            oldLoanId: oldLoan.id,
            replacementLoanId: draft.id,
            status: "preview",
            reason: why,
            oldBalanceVersion: current.oldBalanceVersion,
            replacementDraftVersion: current.replacementDraftVersion,
            previewHash: hash,
            requestHash: sha({ oldLoanPublicId, replacementDraftPublicId, why }),
            previewAsOfDate: asOfDate,
            previewSnapshot: proposal,
            expiresAt: new Date(Date.now() + previewTtlMs),
            createdByUserId: ctx.actorUserId,
            createdActorSource: ctx.actorSource,
            requestId: ctx.requestId,
            correlationId: ctx.correlationId,
        }).returning().then((rows: Replacement[]) => rows[0]!);
        const audit = await createAuditLog(tx, {
            ...auditContext(ctx),
            entityType: "loan_replacement",
            entityId: row.publicId,
            action: "previewed",
            payload: {
                proposal,
                oldBalanceVersion: row.oldBalanceVersion,
                replacementDraftVersion: row.replacementDraftVersion,
                previewHash: row.previewHash,
            },
        });
        return {
            ...proposal,
            publicId: row.publicId,
            previewHash: row.previewHash,
            oldBalanceVersion: row.oldBalanceVersion,
            replacementDraftVersion: row.replacementDraftVersion,
            expiresAt: row.expiresAt,
            auditPublicId: audit.publicId,
            correlationId: ctx.correlationId,
        };
    });
}

async function replacementFor(ctx: CommandContext, executor: Executor, value: string) {
    publicId(value, "replacementPublicId");
    const row = await executor.query.loanReplacements.findFirst({ where: and(eq(loanReplacements.tenantId, ctx.tenantId), eq(loanReplacements.publicId, value)) });
    if (!row) throw new DomainError("LOAN_REPLACEMENT_NOT_FOUND", "Loan replacement was not found", 404);
    return row as Replacement;
}
async function lockLoanReplacementGraph(tx: Executor, ctx: CommandContext, loanIds: number[]) {
    const ids = [...new Set(loanIds)].sort((left, right) => left - right);
    for (const loanId of ids) {
        // The parent loan is the serialization boundary shared by every supported writer.
        // Child-command rows are deliberately not locked here: some established workflows
        // acquire their command row before the parent, and loan→child locking would create a
        // deadlock inversion. Authoritative child state is re-read after these parent locks.
        await tx.execute(sql`SELECT id FROM loans WHERE tenant_id = ${ctx.tenantId} AND id = ${loanId} FOR UPDATE`);
    }
}
function executionHash(input: { replacementPublicId: string; previewHash: string; expectedOldBalanceVersion: string; expectedReplacementDraftVersion: string; reason: string; confirmed: true }) { return sha(input); }
function reversalHash(input: { replacementPublicId: string; reason: string }) { return sha({ contract: "atomic-loan-replacement-reversal", ...input }); }

function assertExecutablePreviewFresh(record: Replacement, proposal?: LoanReplacementProposal) {
    if (record.status !== "preview" || record.expiresAt.getTime() <= Date.now()) {
        reviewRequired(
            "REPLACEMENT_PREVIEW_EXPIRED",
            "Replacement preview is expired or unavailable",
            [record.publicId],
        );
    }
    if (proposal && proposal.asOfDate !== bangkokBusinessDate(new Date())) {
        reviewRequired(
            "REPLACEMENT_PREVIEW_STALE",
            "The Bangkok business date changed after the replacement preview",
            [record.publicId],
        );
    }
}

export async function executeLoanReplacement(ctx: CommandContext, input: { replacementPublicId: string; previewHash: string; expectedOldBalanceVersion: string; expectedReplacementDraftVersion: string; reason: string; confirmed: true }): Promise<LoanReplacementExecution> {
    await admin(ctx);
    const key = idempotencyKey(ctx); const why = reason(input.reason); publicId(input.replacementPublicId, "replacementPublicId");
    if (!input.confirmed) throw new DomainError("REPLACEMENT_CONFIRMATION_REQUIRED", "Explicit replacement confirmation is required", 400);
    if (!versionPattern.test(input.previewHash) || !versionPattern.test(input.expectedOldBalanceVersion) || !versionPattern.test(input.expectedReplacementDraftVersion)) throw new DomainError("INVALID_REPLACEMENT_VERSION", "Replacement fingerprints are invalid", 400);
    const requestHash = executionHash({ ...input, reason: why });
    return db.transaction(async tx => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`loan-replacement:${ctx.tenantId}:execute-key:${key}`}, 0))`);
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`loan-replacement:${ctx.tenantId}:${input.replacementPublicId}`}, 0))`);
        const record = await replacementFor(ctx, tx, input.replacementPublicId);
        await tx.execute(sql`SELECT id FROM loan_replacements WHERE tenant_id = ${ctx.tenantId} AND id = ${record.id} FOR UPDATE`);
        const keyOwner = await tx.query.loanReplacements.findFirst({ where: and(eq(loanReplacements.tenantId, ctx.tenantId), eq(loanReplacements.executeIdempotencyKey, key)) });
        if (keyOwner && keyOwner.id !== record.id) throw new DomainError("IDEMPOTENCY_CONFLICT", "Idempotency key was used for another replacement execution", 409);
        if (record.status === "executed") {
            if (record.executeIdempotencyKey !== key || record.executeRequestHash !== requestHash) throw new DomainError("IDEMPOTENCY_CONFLICT", "Idempotency key was used with a different request", 409);
            const audit = await tx.query.auditLogs.findFirst({ where: and(eq(auditLogs.tenantId, ctx.tenantId), eq(auditLogs.entityId, record.publicId), eq(auditLogs.action, "executed")) });
            const oldLoan = await tx.query.loans.findFirst({ where: and(eq(loans.tenantId, ctx.tenantId), eq(loans.id, record.oldLoanId)) });
            const draft = await tx.query.loans.findFirst({ where: and(eq(loans.tenantId, ctx.tenantId), eq(loans.id, record.replacementLoanId)) });
            return { replacementPublicId: record.publicId, oldLoanPublicId: oldLoan!.publicId, replacementLoanPublicId: draft!.publicId, status: "executed", auditPublicId: audit?.publicId ?? "", correlationId: audit?.correlationId ?? record.correlationId ?? ctx.correlationId };
        }
        assertExecutablePreviewFresh(record);
        if (record.previewHash !== input.previewHash || record.oldBalanceVersion !== input.expectedOldBalanceVersion || record.replacementDraftVersion !== input.expectedReplacementDraftVersion || record.reason !== why) reviewRequired("REPLACEMENT_PREVIEW_STALE", "Replacement preview does not match the confirmed request", [record.publicId]);
        const proposal = storedProposal(record);
        assertExecutablePreviewFresh(record, proposal);
        let [oldLoan, draft] = await Promise.all([loanFor(ctx, tx, (await tx.query.loans.findFirst({ where: and(eq(loans.tenantId, ctx.tenantId), eq(loans.id, record.oldLoanId)) }))!.publicId), loanFor(ctx, tx, (await tx.query.loans.findFirst({ where: and(eq(loans.tenantId, ctx.tenantId), eq(loans.id, record.replacementLoanId)) }))!.publicId)]);
        await lockLoanReplacementGraph(tx, ctx, [oldLoan.id, draft.id]);
        if (draft.bankLoanId) await tx.execute(sql`SELECT id FROM bank_loans WHERE tenant_id = ${ctx.tenantId} AND id = ${draft.bankLoanId} FOR UPDATE`);
        assertExecutablePreviewFresh(record, proposal);
        [oldLoan, draft] = await Promise.all([loanFor(ctx, tx, oldLoan.publicId), loanFor(ctx, tx, draft.publicId)]);
        const current = await validate(ctx, tx, oldLoan, draft);
        if (current.oldBalanceVersion !== record.oldBalanceVersion || current.replacementDraftVersion !== record.replacementDraftVersion) reviewRequired("REPLACEMENT_PREVIEW_STALE", "Replacement balances or funding changed after preview", [oldLoan.publicId, draft.publicId]);
        if (previewHash(current, proposal) !== record.previewHash) {
            reviewRequired(
                "REPLACEMENT_PREVIEW_STALE",
                "The persisted replacement proposal no longer matches its fingerprint",
                [record.publicId],
            );
        }
        const oldSnapshot: ReplacementExecutionSnapshot["old"] = {
            loan: {
                status: oldLoan.status ?? "active",
                outstandingPrincipal: oldLoan.outstandingPrincipal ?? "0.00",
                outstandingInterest: oldLoan.outstandingInterest ?? "0.00",
                outstandingFees: oldLoan.outstandingFees ?? "0.00",
                nextDueDate: oldLoan.nextDueDate,
            },
            schedules: current.oldSchedules.map((row) => ({
                id: row.id,
                status: row.status,
                remainingDue: row.remainingDue,
                paidTotal: row.paidTotal,
                paidPenalty: row.paidPenalty,
            })),
        };
        await activateLoanInTransaction(
            tx,
            { ...ctx, idempotencyKey: `replacement:${record.publicId}` },
            draft,
            { replacementPublicId: record.publicId, topUpPartialFunding: true },
        );
        await tx.insert(loanReplacementCorrections).values({ tenantId: ctx.tenantId, replacementId: record.id, loanId: oldLoan.id, status: "posted", principal: proposal.correction.principal, interest: proposal.correction.interest, fee: proposal.correction.fee, penalty: proposal.correction.penalty, reason: why, createdByUserId: ctx.actorUserId });
        await tx.update(loanSchedules).set({ status: "cancelled", remainingDue: "0.00" }).where(and(eq(loanSchedules.tenantId, ctx.tenantId), eq(loanSchedules.loanId, oldLoan.id)));
        await tx.update(loans).set({ status: "replaced", outstandingPrincipal: "0.00", outstandingInterest: "0.00", outstandingFees: "0.00", nextDueDate: null, updatedAt: new Date() }).where(and(eq(loans.tenantId, ctx.tenantId), eq(loans.id, oldLoan.id), eq(loans.status, "active")));
        const audit = await createAuditLog(tx, {
            ...auditContext(ctx),
            entityType: "loan_replacement",
            entityId: record.publicId,
            action: "executed",
            payload: {
                proposal,
                before: {
                    oldLoan: {
                        loanPublicId: proposal.oldLoan.loanPublicId,
                        status: proposal.oldLoan.statusBefore,
                        ...proposal.oldLoan.collectibleBefore,
                    },
                    replacementLoan: {
                        loanPublicId: proposal.replacement.loanPublicId,
                        status: proposal.replacement.statusBefore,
                    },
                },
                after: {
                    oldLoan: {
                        loanPublicId: proposal.oldLoan.loanPublicId,
                        status: proposal.oldLoan.statusAfter,
                        ...proposal.oldLoan.collectibleAfter,
                    },
                    replacementLoan: {
                        loanPublicId: proposal.replacement.loanPublicId,
                        status: proposal.replacement.statusAfter,
                    },
                },
                requestHash,
                idempotencyKey: key,
            },
        });
        await tx.update(loanReplacements).set({ status: "executed", executeIdempotencyKey: key, executeRequestHash: requestHash, executeActorSource: ctx.actorSource, executedAuditPublicId: audit.publicId, executedAt: new Date(), executedByUserId: ctx.actorUserId, preExecutionSnapshot: { old: oldSnapshot }, updatedAt: new Date() }).where(and(eq(loanReplacements.tenantId, ctx.tenantId), eq(loanReplacements.id, record.id), eq(loanReplacements.status, "preview")));
        return { replacementPublicId: record.publicId, oldLoanPublicId: oldLoan.publicId, replacementLoanPublicId: draft.publicId, status: "executed", auditPublicId: audit.publicId, correlationId: ctx.correlationId };
    });
}

export async function reverseLoanReplacement(ctx: CommandContext, input: { replacementPublicId: string; reason: string }): Promise<LoanReplacementReversal> {
    await admin(ctx); const key = idempotencyKey(ctx); const why = reason(input.reason, "REPLACEMENT_REVERSAL_REASON_REQUIRED"); publicId(input.replacementPublicId, "replacementPublicId"); const requestHash = reversalHash({ replacementPublicId: input.replacementPublicId, reason: why });
    return db.transaction(async tx => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`loan-replacement:${ctx.tenantId}:reverse-key:${key}`}, 0))`);
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`loan-replacement:${ctx.tenantId}:${input.replacementPublicId}`}, 0))`);
        const record = await replacementFor(ctx, tx, input.replacementPublicId);
        await tx.execute(sql`SELECT id FROM loan_replacements WHERE tenant_id = ${ctx.tenantId} AND id = ${record.id} FOR UPDATE`);
        const keyOwner = await tx.query.loanReplacements.findFirst({ where: and(eq(loanReplacements.tenantId, ctx.tenantId), eq(loanReplacements.reversalIdempotencyKey, key)) });
        if (keyOwner && keyOwner.id !== record.id) throw new DomainError("IDEMPOTENCY_CONFLICT", "Idempotency key was used for another replacement reversal", 409);
        let [oldLoan, draft] = await Promise.all([tx.query.loans.findFirst({ where: and(eq(loans.tenantId, ctx.tenantId), eq(loans.id, record.oldLoanId)) }), tx.query.loans.findFirst({ where: and(eq(loans.tenantId, ctx.tenantId), eq(loans.id, record.replacementLoanId)) })]);
        await lockLoanReplacementGraph(tx, ctx, [record.oldLoanId, record.replacementLoanId]);
        [oldLoan, draft] = await Promise.all([tx.query.loans.findFirst({ where: and(eq(loans.tenantId, ctx.tenantId), eq(loans.id, record.oldLoanId)) }), tx.query.loans.findFirst({ where: and(eq(loans.tenantId, ctx.tenantId), eq(loans.id, record.replacementLoanId)) })]);
        if (record.status === "reversed") {
            if (record.reversalIdempotencyKey !== key || record.reversalRequestHash !== requestHash) throw new DomainError("IDEMPOTENCY_CONFLICT", "Idempotency key was used with a different request", 409);
            const audit = await tx.query.auditLogs.findFirst({ where: and(eq(auditLogs.tenantId, ctx.tenantId), eq(auditLogs.entityId, record.publicId), eq(auditLogs.action, "reversed")) });
            return { replacementPublicId: record.publicId, oldLoanPublicId: oldLoan!.publicId, replacementLoanPublicId: draft!.publicId, status: "reversed", auditPublicId: audit?.publicId ?? "", correlationId: audit?.correlationId ?? record.correlationId ?? ctx.correlationId };
        }
        if (record.status !== "executed" || !oldLoan || !draft) reviewRequired("REPLACEMENT_NOT_REVERSIBLE", "Only an executed replacement can be reversed", [record.publicId]);
        const lifecycleBlockers = [
            ...(oldLoan.status === "replaced" ? [] : [oldLoan.publicId]),
            ...(draft.status === "active" ? [] : [draft.publicId]),
        ];
        if (lifecycleBlockers.length) {
            reviewRequired(
                "REPLACEMENT_REVERSAL_LIFECYCLE_CHANGED",
                "Replacement loan lifecycle changed and requires human review",
                lifecycleBlockers,
            );
        }
        const [rawDownstream, replacementFundingRows] = await Promise.all([
            loadDownstream(tx, ctx, draft.id),
            tx.select().from(loanFundingAllocations).where(and(
                eq(loanFundingAllocations.tenantId, ctx.tenantId),
                eq(loanFundingAllocations.loanId, draft.id),
            )).orderBy(asc(loanFundingAllocations.id)),
        ]);
        const downstream = effectiveDownstream(rawDownstream);
        const draftDisbursementIds = rawDownstream.disbursementRows
            .filter((row) => row.status === "draft")
            .map((row) => row.publicId);
        const changedFundingIds = replacementFundingRows
            .filter((row) => row.allocationType !== "initial")
            .map((row) => row.publicId);
        const blockers = [...new Set([
            ...downstream.postedPaymentIds,
            ...downstream.postedDisbursementIds,
            ...downstream.dependentWorkflowIds,
            ...downstream.otherIds,
            ...draftDisbursementIds,
            ...changedFundingIds,
        ])];
        if (blockers.length) reviewRequired("REPLACEMENT_REVERSAL_DOWNSTREAM_ACTIVITY", "Replacement has downstream activity and requires human review", blockers);
        const snapshot = storedExecutionSnapshot(record)?.old;
        if (!snapshot) reviewRequired("REPLACEMENT_SNAPSHOT_MISSING", "Replacement snapshot is unavailable for safe reversal", [record.publicId]);
        const corrections = await tx.select().from(loanReplacementCorrections).where(and(eq(loanReplacementCorrections.tenantId, ctx.tenantId), eq(loanReplacementCorrections.replacementId, record.id), eq(loanReplacementCorrections.status, "posted")));
        for (const item of corrections) await tx.insert(loanReplacementCorrections).values({ tenantId: ctx.tenantId, replacementId: record.id, loanId: oldLoan.id, status: "reversed", principal: signedMoney(new FinancialDecimal(item.principal).negated()), interest: signedMoney(new FinancialDecimal(item.interest).negated()), fee: signedMoney(new FinancialDecimal(item.fee).negated()), penalty: signedMoney(new FinancialDecimal(item.penalty).negated()), reason: why, reversedCorrectionId: item.id, createdByUserId: ctx.actorUserId });
        const allocations = await tx.select().from(loanFundingAllocations).where(and(eq(loanFundingAllocations.tenantId, ctx.tenantId), eq(loanFundingAllocations.loanId, draft.id), eq(loanFundingAllocations.allocationType, "initial")));
        for (const allocation of allocations) await tx.insert(loanFundingAllocations).values({ tenantId: ctx.tenantId, bankProfileId: allocation.bankProfileId, bankLoanId: allocation.bankLoanId, loanId: draft.id, allocatedAmount: signedMoney(new FinancialDecimal(allocation.allocatedAmount).negated()), allocationDate: draft.startDate ?? new Date().toISOString().slice(0, 10), allocationType: "reallocation_out", allocationGroupId: crypto.randomUUID(), reversedAllocationId: allocation.id, note: `Compensating replacement reversal ${record.publicId}`, createdByUserId: ctx.actorUserId, idempotencyKey: `replacement-reversal:${record.publicId}:${allocation.publicId}`, requestHash: sha({ replacementPublicId: record.publicId, allocationPublicId: allocation.publicId, why }) });
        await tx.update(loanSchedules).set({ status: "cancelled", remainingDue: "0.00" }).where(and(eq(loanSchedules.tenantId, ctx.tenantId), eq(loanSchedules.loanId, draft.id)));
        await tx.update(loans).set({ status: "cancelled", outstandingPrincipal: "0.00", outstandingInterest: "0.00", outstandingFees: "0.00", nextDueDate: null, updatedAt: new Date() }).where(and(eq(loans.tenantId, ctx.tenantId), eq(loans.id, draft.id)));
        await tx.update(loans).set({ status: snapshot.loan.status, outstandingPrincipal: snapshot.loan.outstandingPrincipal, outstandingInterest: snapshot.loan.outstandingInterest, outstandingFees: snapshot.loan.outstandingFees, nextDueDate: snapshot.loan.nextDueDate, updatedAt: new Date() }).where(and(eq(loans.tenantId, ctx.tenantId), eq(loans.id, oldLoan.id)));
        for (const schedule of snapshot.schedules) await tx.update(loanSchedules).set({ status: schedule.status, remainingDue: schedule.remainingDue, paidTotal: schedule.paidTotal, paidPenalty: schedule.paidPenalty }).where(and(eq(loanSchedules.tenantId, ctx.tenantId), eq(loanSchedules.id, schedule.id)));
        const audit = await createAuditLog(tx, { ...auditContext(ctx), entityType: "loan_replacement", entityId: record.publicId, action: "reversed", payload: { reason: why, before: { oldLoan: { status: "replaced" }, replacementLoan: { status: "active" } }, after: { oldLoan: snapshot.loan, replacementLoan: { status: "cancelled" } }, idempotencyKey: key } });
        await tx.update(loanReplacements).set({ status: "reversed", reversalIdempotencyKey: key, reversalRequestHash: requestHash, reversalActorSource: ctx.actorSource, reversedAuditPublicId: audit.publicId, reversedAt: new Date(), reversedByUserId: ctx.actorUserId, updatedAt: new Date() }).where(and(eq(loanReplacements.tenantId, ctx.tenantId), eq(loanReplacements.id, record.id), eq(loanReplacements.status, "executed")));
        return { replacementPublicId: record.publicId, oldLoanPublicId: oldLoan.publicId, replacementLoanPublicId: draft.publicId, status: "reversed", auditPublicId: audit.publicId, correlationId: ctx.correlationId };
    });
}
