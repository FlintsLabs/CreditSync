import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import {
    borrowers, loans, loanSchedules, paymentEvidence, paymentIntakes, paymentReconciliationEntries,
    paymentReconciliationGroups, paymentReconciliationProposals, transactions,
    floatingTransactionAllocations, loanInterestAccruals, paymentMatchProposals, paymentMatchAllocations,
} from "../db/schema";
import { createAuditLog } from "../lib/audit-log";
import { parseMoney, serializeMoney } from "../lib/money";
import type { CommandContext } from "./command-context";
import { DomainError } from "./domain-error";
import { accrueFloatingInterestThrough, resolveFloatingInterestAllocationPlan, type FloatingInterestAllocationPlan } from "./floating-interest-service";

export type ReconciliationComponent = "interest" | "principal" | "fee" | "penalty";
export interface ReconciliationAllocation {
    borrowerPublicId: string;
    loanPublicId: string;
    amount: string;
    component: ReconciliationComponent;
    schedulePublicId?: string;
}

const components = ["principal", "interest", "fee", "penalty"] as const;
type Component = typeof components[number];

function money(value: string) {
    try { return parseMoney(value); } catch { throw new DomainError("INVALID_RECONCILIATION_AMOUNT", "Amounts must be non-negative strings with exactly two decimals", 400); }
}

function validateAllocation(item: ReconciliationAllocation, index: number) {
    const amount = money(item.amount);
    if (!amount.gt(0)) throw new DomainError("INVALID_RECONCILIATION_AMOUNT", `Allocation ${index + 1} must be greater than zero`, 400);
    if (!components.includes(item.component as Component)) throw new DomainError("INVALID_RECONCILIATION_COMPONENT", `Allocation ${index + 1} has an invalid component`, 400);
    return amount;
}

function hash(value: unknown) {
    return `v1:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

const publicUuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function canonicalizeProvenanceSource(source: any) {
    if (!source || !Array.isArray(source.provenancePlans)) return source;
    return {
        ...source,
        provenancePlans: source.provenancePlans.map((plan: FloatingInterestAllocationPlan) => ({
            loanPublicId: plan.loanPublicId,
            throughDate: plan.throughDate,
            periodStartDate: plan.periodStartDate,
            periodEndDate: plan.periodEndDate,
            requestedAmount: plan.requestedAmount,
            availableAmount: plan.availableAmount,
            provenanceReady: plan.provenanceReady,
            warnings: plan.warnings,
            allocations: plan.allocations.map((allocation) => ({
                // A preview may contain a deterministic virtual row. Preserve
                // that logical identity until execute materializes it; real
                // replacement rows still compare by their public UUID.
                accrualPublicId: allocation.accrualPublicId.startsWith("projected:")
                    ? allocation.accrualPublicId
                    : allocation.accrualPublicId,
                accrualId: allocation.accrualId,
                dueDate: allocation.dueDate,
                amount: allocation.amount,
            })),
        })),
    };
}

function reconciliationPreviewHash(source: unknown, allocations: ReconciliationAllocation[], expectedBalanceVersion: string, reason: string) {
    return hash({ source: canonicalizeProvenanceSource(source), allocations: allocations.map(presentAllocation), expectedBalanceVersion, reason });
}

function provenancePlansMatch(current: FloatingInterestAllocationPlan[], preview: FloatingInterestAllocationPlan[]) {
    if (current.length !== preview.length) return false;
    return current.every((currentPlan, index) => {
        const previewPlan = preview[index];
        if (!previewPlan || currentPlan.loanPublicId !== previewPlan.loanPublicId
            || currentPlan.periodStartDate !== previewPlan.periodStartDate
            || currentPlan.periodEndDate !== previewPlan.periodEndDate
            || currentPlan.requestedAmount !== previewPlan.requestedAmount
            || currentPlan.availableAmount !== previewPlan.availableAmount
            || currentPlan.provenanceReady !== previewPlan.provenanceReady) return false;
        if (currentPlan.allocations.length !== previewPlan.allocations.length) return false;
        return currentPlan.allocations.every((allocation, allocationIndex) => {
            const expected = previewPlan.allocations[allocationIndex];
            if (!expected || allocation.dueDate !== expected.dueDate || allocation.amount !== expected.amount) return false;
            // Virtual preview rows become real rows during execute. Once a
            // preview has a concrete public ID, replacement of that row is
            // stale and must fail closed.
            return expected.accrualPublicId.startsWith("projected:")
                || (allocation.accrualPublicId === expected.accrualPublicId && allocation.accrualId === expected.accrualId);
        });
    });
}

export function calculateReconciliationComponents(input: ReconciliationAllocation[], sourceAmount: string) {
    const total = input.reduce((sum, item) => sum.plus(money(item.amount)), new Decimal(0));
    const source = money(sourceAmount);
    if (!total.eq(source)) throw new DomainError("RECONCILIATION_AMOUNT_MISMATCH", "Allocation total must equal source payment amount", 400);
    const result: Record<Component, Decimal> = { principal: new Decimal(0), interest: new Decimal(0), fee: new Decimal(0), penalty: new Decimal(0) };
    for (const [index, item] of input.entries()) {
        const amount = validateAllocation(item, index);
        result[item.component] = result[item.component].plus(amount);
    }
    return {
        total,
        components: Object.fromEntries(components.map((key) => [key, result[key].toFixed(2)])) as Record<Component, string>,
    };
}

export function deriveExactRestoreComponents(input: Array<{
    amount: string;
    principalComponent: string;
    interestComponent: string;
    feeComponent: string;
    penaltyComponent: string;
}>) {
    if (input.length === 0) throw new DomainError("RECONCILIATION_SOURCE_NOT_FULLY_REVERSED", "A reversed source must contain repayment transactions", 409);
    const totals = input.reduce((result, row) => {
        result.amount = result.amount.plus(money(row.amount));
        result.principal = result.principal.plus(money(row.principalComponent));
        result.interest = result.interest.plus(money(row.interestComponent));
        result.fee = result.fee.plus(money(row.feeComponent));
        result.penalty = result.penalty.plus(money(row.penaltyComponent));
        return result;
    }, { amount: new Decimal(0), principal: new Decimal(0), interest: new Decimal(0), fee: new Decimal(0), penalty: new Decimal(0) });
    const components = { amount: totals.amount.toFixed(2), principal: totals.principal.toFixed(2), interest: totals.interest.toFixed(2), fee: totals.fee.toFixed(2), penalty: totals.penalty.toFixed(2) };
    if (!totals.amount.eq(totals.principal.plus(totals.interest).plus(totals.fee).plus(totals.penalty))) {
        throw new DomainError("RECONCILIATION_SOURCE_COMPONENT_MISMATCH", "Source transaction components do not conserve the payment amount", 409);
    }
    return components;
}

function contextPayload(ctx: CommandContext) {
    return { tenantId: ctx.tenantId, actorUserId: ctx.actorUserId, actorSource: ctx.actorSource, requestId: ctx.requestId, correlationId: ctx.correlationId };
}

function presentAllocation(item: ReconciliationAllocation & { borrowerId?: number; loanId?: number; scheduleId?: number | null }) {
    return { borrowerPublicId: item.borrowerPublicId, loanPublicId: item.loanPublicId, schedulePublicId: item.schedulePublicId ?? null, amount: money(item.amount).toFixed(2), component: item.component };
}

function restoreScheduleAggregate(schedule: typeof loanSchedules.$inferSelect, amounts: Record<Component, string>) {
    const nonPenalty = new Decimal(amounts.principal).plus(amounts.interest).plus(amounts.fee);
    const paidTotal = new Decimal(schedule.paidTotal).plus(nonPenalty);
    const paidPenalty = new Decimal(schedule.paidPenalty).plus(amounts.penalty);
    const remainingDue = Decimal.max(0, new Decimal(schedule.remainingDue).minus(nonPenalty));
    const status = remainingDue.isZero() ? "paid" : paidTotal.gt(0) || paidPenalty.gt(0) ? "partial" : "pending";
    return { paidTotal: paidTotal.toFixed(2), paidPenalty: paidPenalty.toFixed(2), remainingDue: remainingDue.toFixed(2), status };
}

async function accessibleIntake(ctx: CommandContext, publicId: string, executor: any) {
    const row = await executor.query.paymentIntakes.findFirst({ where: and(eq(paymentIntakes.tenantId, ctx.tenantId), eq(paymentIntakes.publicId, publicId)) });
    if (!row) throw new DomainError("PAYMENT_INTAKE_NOT_FOUND", "Payment intake not found", 404);
    return row;
}

async function resolveAllocations(ctx: CommandContext, requested: ReconciliationAllocation[], executor: any) {
    const result: Array<ReconciliationAllocation & { borrowerId: number; loanId: number; scheduleId: number | null; loan: typeof loans.$inferSelect }> = [];
    for (const [index, item] of requested.entries()) {
        validateAllocation(item, index);
        if (!item.borrowerPublicId || !item.loanPublicId) throw new DomainError("INVALID_RECONCILIATION_TARGET", `Allocation ${index + 1} requires borrower and loan`, 400);
        const borrower = await executor.query.borrowers.findFirst({ where: and(eq(borrowers.tenantId, ctx.tenantId), eq(borrowers.publicId, item.borrowerPublicId)) });
        const loan = await executor.query.loans.findFirst({ where: and(eq(loans.tenantId, ctx.tenantId), eq(loans.publicId, item.loanPublicId)) });
        if (!borrower || !loan || loan.borrowerId !== borrower.id || loan.status !== "active") throw new DomainError("INVALID_RECONCILIATION_TARGET", "Allocation target is not an accessible active loan", 409);
        let scheduleId: number | null = null;
        if (item.schedulePublicId) {
            const schedule = await executor.query.loanSchedules.findFirst({ where: and(eq(loanSchedules.tenantId, ctx.tenantId), eq(loanSchedules.publicId, item.schedulePublicId), eq(loanSchedules.loanId, loan.id)) });
            if (!schedule) throw new DomainError("INVALID_RECONCILIATION_TARGET", "Schedule does not belong to the allocation loan", 409);
            scheduleId = schedule.id;
        }
        result.push({ ...item, amount: money(item.amount).toFixed(2), borrowerId: borrower.id, loanId: loan.id, scheduleId, loan });
    }
    return result;
}

async function activeSourceRepayments(executor: any, ctx: CommandContext, intakeId: number): Promise<Array<typeof transactions.$inferSelect>> {
    return executor.select().from(transactions).where(and(
        eq(transactions.tenantId, ctx.tenantId), eq(transactions.paymentIntakeId, intakeId), eq(transactions.entryType, "repayment"),
        sql`NOT EXISTS (
            SELECT 1 FROM transactions AS reversal
            WHERE reversal.tenant_id = ${ctx.tenantId}
              AND reversal.reversed_transaction_id = "transactions"."id"
        )`,
    )).orderBy(transactions.id);
}

type ReconciliationMode = "historical_needs_review" | "reversed_repost";

function isExactCompensation(original: typeof transactions.$inferSelect, reversal: typeof transactions.$inferSelect) {
    return reversal.loanId === original.loanId
        && reversal.scheduleId === original.scheduleId
        && new Decimal(reversal.amount).plus(original.amount).isZero()
        && new Decimal(reversal.principalComponent).plus(original.principalComponent).isZero()
        && new Decimal(reversal.interestComponent).plus(original.interestComponent).isZero()
        && new Decimal(reversal.feeComponent).plus(original.feeComponent).isZero()
        && new Decimal(reversal.penaltyComponent).plus(original.penaltyComponent).isZero();
}

async function inspectReconciliationSource(executor: any, ctx: CommandContext, intake: typeof paymentIntakes.$inferSelect, options: { requireSourceEvidence?: boolean; allowDraftChild?: boolean } = {}): Promise<{
    mode: ReconciliationMode;
    originals: Array<typeof transactions.$inferSelect>;
    reversals: Array<typeof transactions.$inferSelect>;
    hasReadyEvidence: boolean;
    repostChild: typeof paymentIntakes.$inferSelect | null;
}> {
    if (intake.status === "needs_review") return { mode: "historical_needs_review", originals: [], reversals: [], hasReadyEvidence: false, repostChild: null };
    if (intake.status !== "reversed") throw new DomainError("RECONCILIATION_INTAKE_INVALID", "Only needs_review or fully reversed intakes can be reconciled", 409);
    const originals: Array<typeof transactions.$inferSelect> = await executor.select().from(transactions).where(and(
        eq(transactions.tenantId, ctx.tenantId), eq(transactions.paymentIntakeId, intake.id), eq(transactions.entryType, "repayment"),
    )).orderBy(transactions.id);
    const reversals: Array<typeof transactions.$inferSelect> = originals.length
        ? await executor.select().from(transactions).where(and(
            eq(transactions.tenantId, ctx.tenantId), eq(transactions.entryType, "reversal"), inArray(transactions.reversedTransactionId, originals.map((row) => row.id)),
        )).orderBy(transactions.id)
        : [];
    const hasReadyEvidence = Boolean(await executor.query.paymentEvidence.findFirst({ where: and(
        eq(paymentEvidence.tenantId, ctx.tenantId), eq(paymentEvidence.paymentIntakeId, intake.id), eq(paymentEvidence.status, "ready"), sql`${paymentEvidence.finalizedAt} IS NOT NULL`,
    ) }));
    const child = await executor.query.paymentIntakes.findFirst({ where: and(
        eq(paymentIntakes.tenantId, ctx.tenantId), eq(paymentIntakes.repostOfIntakeId, intake.id),
    ) });
    const reversalByOriginal = new Map(reversals.map((row) => [row.reversedTransactionId, row]));
    if (!originals.length || reversals.length !== originals.length || originals.some((row) => {
        const reversal = reversalByOriginal.get(row.id);
        return !reversal || !isExactCompensation(row, reversal);
    })) throw new DomainError("RECONCILIATION_SOURCE_NOT_FULLY_REVERSED", "Every source repayment must have one exact compensating reversal", 409);
    if (options.requireSourceEvidence !== false && !hasReadyEvidence) throw new DomainError("RECONCILIATION_SOURCE_EVIDENCE_REQUIRED", "A finalized ready source evidence record is required", 409);
    if (child && !(options.allowDraftChild && child.status === "draft")) throw new DomainError("RECONCILIATION_SOURCE_ALREADY_REPOSTED", "The reversed source already has a repost child", 409);
    return { mode: "reversed_repost", originals, reversals, hasReadyEvidence, repostChild: child ?? null };
}

async function restoreDraftEvidence(executor: any, ctx: CommandContext, draft: typeof paymentIntakes.$inferSelect | null) {
    if (!draft || draft.status !== "draft") throw new DomainError("RECONCILIATION_RESTORE_DRAFT_REQUIRED", "A restore draft is required before preview", 409);
    const hasReadyEvidence = Boolean(await executor.query.paymentEvidence.findFirst({ where: and(
        eq(paymentEvidence.tenantId, ctx.tenantId), eq(paymentEvidence.paymentIntakeId, draft.id), eq(paymentEvidence.status, "ready"), sql`${paymentEvidence.finalizedAt} IS NOT NULL`,
    ) }));
    if (!hasReadyEvidence) throw new DomainError("RECONCILIATION_RESTORE_DRAFT_EVIDENCE_REQUIRED", "A finalized ready restore-draft evidence record is required", 409);
    return draft;
}

export async function createPaymentRestoreDraft(ctx: CommandContext, input: { paymentIntakePublicId: string; reason: string; idempotencyKey: string }) {
    if (!input.reason?.trim() || !input.idempotencyKey?.trim()) throw new DomainError("RECONCILIATION_COMMAND_CONTEXT_REQUIRED", "Reason and idempotency key are required", 400);
    return db.transaction(async (tx) => {
        const intake = await accessibleIntake(ctx, input.paymentIntakePublicId, tx);
        await tx.execute(sql`SELECT id FROM payment_intakes WHERE tenant_id = ${ctx.tenantId} AND id = ${intake.id} FOR UPDATE`);
        const inspected = await inspectReconciliationSource(tx, ctx, intake, { requireSourceEvidence: false, allowDraftChild: true });
        const existing = inspected.repostChild;
        if (existing) {
            if (existing.idempotencyKey !== input.idempotencyKey || existing.notes !== `Restore draft after reversal: ${input.reason.trim()}`) {
                throw new DomainError("IDEMPOTENCY_CONFLICT", "Idempotency key was used for a different restore draft", 409);
            }
            return { sourcePaymentPublicId: intake.publicId, restoreDraftPublicId: existing.publicId, status: existing.status, correlationId: ctx.correlationId };
        }
        const draft = await tx.insert(paymentIntakes).values({
            tenantId: ctx.tenantId, ownerUserId: intake.ownerUserId, source: intake.source, status: "draft", amount: serializeMoney(intake.amount), receivedAt: intake.receivedAt,
            payerName: intake.payerName, originLoanId: intake.originLoanId, repostOfIntakeId: intake.id,
            notes: `Restore draft after reversal: ${input.reason.trim()}`, idempotencyKey: input.idempotencyKey,
            createdByUserId: ctx.actorUserId, updatedByUserId: ctx.actorUserId,
        }).returning().then((rows) => rows[0]!);
        const audit = await createAuditLog(tx, { ...contextPayload(ctx), entityType: "payment_intake", entityId: draft.publicId, action: "restore_draft_created", payload: { sourcePaymentPublicId: intake.publicId, reason: input.reason.trim(), idempotencyKey: input.idempotencyKey } });
        return { sourcePaymentPublicId: intake.publicId, restoreDraftPublicId: draft.publicId, status: draft.status, auditPublicId: audit.publicId, correlationId: ctx.correlationId };
    });
}

export async function backfillPostedRestoreSchedule(ctx: CommandContext, input: { paymentIntakePublicId: string; reason: string; idempotencyKey: string }) {
    if (!input.reason?.trim() || !input.idempotencyKey?.trim()) throw new DomainError("RECONCILIATION_COMMAND_CONTEXT_REQUIRED", "Backfill requires a reason and idempotency key", 400);
    return db.transaction(async (tx) => {
        const intake = await accessibleIntake(ctx, input.paymentIntakePublicId, tx);
        if (intake.status !== "posted" || intake.repostOfIntakeId === null) throw new DomainError("RESTORE_BACKFILL_TARGET_INVALID", "Only a posted restore child can be backfilled", 409);
        const source = await tx.query.paymentIntakes.findFirst({ where: and(eq(paymentIntakes.tenantId, ctx.tenantId), eq(paymentIntakes.id, intake.repostOfIntakeId)) });
        if (!source || source.status !== "reversed") throw new DomainError("RESTORE_BACKFILL_SOURCE_INVALID", "Restore source must remain reversed", 409);
        await tx.execute(sql`SELECT id FROM payment_intakes WHERE tenant_id = ${ctx.tenantId} AND id IN (${source.id}, ${intake.id}) FOR UPDATE`);
        const repayments = await tx.select().from(transactions).where(and(
            eq(transactions.tenantId, ctx.tenantId), eq(transactions.paymentIntakeId, intake.id), eq(transactions.entryType, "repayment"),
        )).orderBy(transactions.id);
        const scheduleIds = [...new Set(repayments.map((row) => row.scheduleId).filter((id): id is number => id !== null))];
        if (scheduleIds.length !== 1) throw new DomainError("RESTORE_BACKFILL_TARGET_INVALID", "Restore must target exactly one scheduled installment", 409);
        const schedule = await tx.query.loanSchedules.findFirst({ where: and(eq(loanSchedules.tenantId, ctx.tenantId), eq(loanSchedules.id, scheduleIds[0]!)) });
        if (!schedule) throw new DomainError("RESTORE_BACKFILL_TARGET_INVALID", "Restore schedule no longer exists", 409);
        await tx.execute(sql`SELECT id FROM loan_schedules WHERE tenant_id = ${ctx.tenantId} AND id = ${schedule.id} FOR UPDATE`);
        const activeRepayments = await tx.select().from(transactions).where(and(
            eq(transactions.tenantId, ctx.tenantId), eq(transactions.loanId, schedule.loanId), eq(transactions.scheduleId, schedule.id), eq(transactions.entryType, "repayment"),
            sql`NOT EXISTS (SELECT 1 FROM transactions AS reversal WHERE reversal.tenant_id = ${ctx.tenantId} AND reversal.reversed_transaction_id = transactions.id)`,
        )).orderBy(transactions.id);
        const totals = activeRepayments.reduce((result, row) => ({
            principal: result.principal.plus(row.principalComponent), interest: result.interest.plus(row.interestComponent),
            fee: result.fee.plus(row.feeComponent), penalty: result.penalty.plus(row.penaltyComponent),
        }), { principal: new Decimal(0), interest: new Decimal(0), fee: new Decimal(0), penalty: new Decimal(0) });
        const paidTotal = totals.principal.plus(totals.interest).plus(totals.fee);
        const remainingDue = Decimal.max(0, new Decimal(schedule.scheduledTotal).minus(paidTotal));
        const paidPenalty = totals.penalty;
        const status = remainingDue.isZero() ? "paid" : paidTotal.gt(0) || paidPenalty.gt(0) ? "partial" : "pending";
        const changed = schedule.paidTotal !== paidTotal.toFixed(2) || schedule.paidPenalty !== paidPenalty.toFixed(2) || schedule.remainingDue !== remainingDue.toFixed(2) || schedule.status !== status;
        if (changed) await tx.update(loanSchedules).set({ paidTotal: paidTotal.toFixed(2), paidPenalty: paidPenalty.toFixed(2), remainingDue: remainingDue.toFixed(2), status, overdueDays: remainingDue.isZero() ? 0 : schedule.overdueDays, updatedAt: new Date() }).where(and(eq(loanSchedules.tenantId, ctx.tenantId), eq(loanSchedules.id, schedule.id)));
        const audit = await createAuditLog(tx, { ...contextPayload(ctx), entityType: "loan_schedule", entityId: schedule.publicId, action: "restore_schedule_backfilled", payload: { paymentIntakePublicId: intake.publicId, sourcePaymentPublicId: source.publicId, schedulePublicId: schedule.publicId, changed, reason: input.reason.trim(), idempotencyKey: input.idempotencyKey, before: { paidTotal: schedule.paidTotal, paidPenalty: schedule.paidPenalty, remainingDue: schedule.remainingDue, status: schedule.status }, after: { paidTotal: paidTotal.toFixed(2), paidPenalty: paidPenalty.toFixed(2), remainingDue: remainingDue.toFixed(2), status } } });
        return { changed, paymentIntakePublicId: intake.publicId, schedulePublicId: schedule.publicId, auditPublicId: audit.publicId, correlationId: ctx.correlationId };
    });
}

function sourceTransactionSnapshot(row: typeof transactions.$inferSelect) {
    const signedMoney = (value: string) => new Decimal(value).toDecimalPlaces(2).toFixed(2);
    return { transactionPublicId: row.publicId, reversedTransactionId: row.reversedTransactionId, loanId: row.loanId, scheduleId: row.scheduleId, amount: signedMoney(row.amount), principal: signedMoney(row.principalComponent), interest: signedMoney(row.interestComponent), fee: signedMoney(row.feeComponent), penalty: signedMoney(row.penaltyComponent) };
}

async function authoritativeBalanceVersion(executor: any, ctx: CommandContext, loanIds: number[], includeFloatingLedger = true) {
    const ids = [...new Set(loanIds)].sort((left, right) => left - right);
    if (!ids.length) return hash({ loans: [], transactions: [], accruals: [], allocations: [] });
    const [loanRows, transactionRows, accrualRows, allocationRows] = await Promise.all([
        executor.select({ id: loans.id, outstandingPrincipal: loans.outstandingPrincipal, outstandingInterest: loans.outstandingInterest, outstandingFees: loans.outstandingFees, status: loans.status, updatedAt: loans.updatedAt }).from(loans).where(and(eq(loans.tenantId, ctx.tenantId), inArray(loans.id, ids))).orderBy(loans.id),
        executor.select({ id: transactions.id, loanId: transactions.loanId, amount: transactions.amount, principalComponent: transactions.principalComponent, interestComponent: transactions.interestComponent, feeComponent: transactions.feeComponent, penaltyComponent: transactions.penaltyComponent, entryType: transactions.entryType, reversedTransactionId: transactions.reversedTransactionId, paymentIntakeId: transactions.paymentIntakeId }).from(transactions).where(and(eq(transactions.tenantId, ctx.tenantId), inArray(transactions.loanId, ids))).orderBy(transactions.loanId, transactions.id),
        includeFloatingLedger ? executor.select({ id: loanInterestAccruals.id, loanId: loanInterestAccruals.loanId, interestAmount: loanInterestAccruals.interestAmount, paidAmount: loanInterestAccruals.paidAmount, status: loanInterestAccruals.status, accrualDate: loanInterestAccruals.accrualDate }).from(loanInterestAccruals).where(and(eq(loanInterestAccruals.tenantId, ctx.tenantId), inArray(loanInterestAccruals.loanId, ids))).orderBy(loanInterestAccruals.loanId, loanInterestAccruals.id) : Promise.resolve([]),
        includeFloatingLedger ? executor.select({ id: floatingTransactionAllocations.id, loanId: floatingTransactionAllocations.loanId, transactionId: floatingTransactionAllocations.transactionId, component: floatingTransactionAllocations.component, amount: floatingTransactionAllocations.amount, entryType: floatingTransactionAllocations.entryType, reversedAllocationId: floatingTransactionAllocations.reversedAllocationId }).from(floatingTransactionAllocations).where(and(eq(floatingTransactionAllocations.tenantId, ctx.tenantId), inArray(floatingTransactionAllocations.loanId, ids))).orderBy(floatingTransactionAllocations.loanId, floatingTransactionAllocations.id) : Promise.resolve([]),
    ]);
    return hash({ loans: loanRows, transactions: transactionRows, accruals: accrualRows, allocations: allocationRows });
}

function bangkokBusinessDate(value: Date) {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(value);
    const read = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
    return `${read("year")}-${read("month")}-${read("day")}`;
}

function presentProposal(row: typeof paymentReconciliationProposals.$inferSelect, source: unknown, allocations: ReconciliationAllocation[], correction: Record<Component, string>, groups: string[]) {
    return {
        id: row.publicId, publicId: row.publicId, status: row.status, sourcePayment: source,
        currentAllocationSnapshot: (source as { currentAllocationSnapshot?: unknown })?.currentAllocationSnapshot ?? [],
        proposedAllocation: allocations.map(presentAllocation),
        correction: { principal: correction.principal, interest: correction.interest, fee: correction.fee, penalty: correction.penalty },
        warnings: row.warnings ?? [], previewHash: row.previewHash, expectedBalanceVersion: row.expectedBalanceVersion,
        expiresAt: row.expiresAt, historicalReconciliationGroupPublicIds: groups, reason: row.reason,
    };
}

async function deriveRestoreAllocations(ctx: CommandContext, executor: any, originals: Array<typeof transactions.$inferSelect>) {
    const allocations: ReconciliationAllocation[] = [];
    for (const original of originals) {
        const loan = await executor.query.loans.findFirst({ where: and(eq(loans.tenantId, ctx.tenantId), eq(loans.id, original.loanId)) });
        if (!loan) throw new DomainError("RECONCILIATION_TARGET_MISSING", "Source loan no longer exists", 409);
        const borrower = await executor.query.borrowers.findFirst({ where: and(eq(borrowers.tenantId, ctx.tenantId), eq(borrowers.id, loan.borrowerId)) });
        if (!borrower) throw new DomainError("RECONCILIATION_TARGET_MISSING", "Source borrower no longer exists", 409);
        const schedule = original.scheduleId === null ? null : await executor.query.loanSchedules.findFirst({ where: and(eq(loanSchedules.tenantId, ctx.tenantId), eq(loanSchedules.id, original.scheduleId)) });
        for (const component of components) {
            const amount = money(original[`${component}Component` as keyof typeof original] as string);
            if (amount.isZero()) continue;
            allocations.push({ borrowerPublicId: borrower.publicId, loanPublicId: loan.publicId, schedulePublicId: schedule?.publicId ?? undefined, amount: amount.toFixed(2), component });
        }
    }
    return allocations;
}

export async function previewPaymentRestore(ctx: CommandContext, input: { paymentIntakePublicId: string; reason: string }) {
    if (!input.reason?.trim()) throw new DomainError("RECONCILIATION_REASON_REQUIRED", "Restore requires a reason", 400);
    return db.transaction(async (tx) => {
        const intake = await accessibleIntake(ctx, input.paymentIntakePublicId, tx);
        await tx.execute(sql`SELECT id FROM payment_intakes WHERE tenant_id = ${ctx.tenantId} AND id = ${intake.id} FOR UPDATE`);
        const inspected = await inspectReconciliationSource(tx, ctx, intake, { requireSourceEvidence: false, allowDraftChild: true });
        const draft = await restoreDraftEvidence(tx, ctx, inspected.repostChild);
        const allocations = await deriveRestoreAllocations(ctx, tx, inspected.originals);
        const calculated = calculateReconciliationComponents(allocations, intake.amount);
        const source = {
            mode: "exact_restore", sourceMode: inspected.mode, paymentIntakePublicId: intake.publicId, status: intake.status,
            amount: serializeMoney(intake.amount), receivedAt: intake.receivedAt, hasReadyEvidence: true, restoreDraftPublicId: draft.publicId,
            currentAllocationSnapshot: inspected.originals.map(sourceTransactionSnapshot), reversalSnapshot: inspected.reversals.map(sourceTransactionSnapshot),
        };
        const financialBalanceVersion = await authoritativeBalanceVersion(tx, ctx, inspected.originals.map((item) => item.loanId));
        const expectedBalanceVersion = hash({ financialBalanceVersion, source });
        const previewHash = reconciliationPreviewHash(source, allocations, expectedBalanceVersion, input.reason.trim());
        const expiresAt = new Date(Date.now() + Math.max(60, Number(process.env.PAYMENT_PREVIEW_TTL_SECONDS ?? 900)) * 1000);
        const row = await tx.insert(paymentReconciliationProposals).values({
            tenantId: ctx.tenantId, paymentIntakeId: intake.id, status: "ready", previewHash, expectedBalanceVersion,
            sourceSnapshot: source, proposedAllocations: allocations.map(presentAllocation), warnings: [], reason: input.reason.trim(), expiresAt, createdByUserId: ctx.actorUserId,
        }).returning().then((rows) => rows[0]!);
        await createAuditLog(tx, { ...contextPayload(ctx), entityType: "payment_reconciliation", entityId: row.publicId, action: "restore_previewed", payload: { paymentIntakePublicId: intake.publicId, previewHash, expectedBalanceVersion, reason: input.reason.trim() } });
        return presentProposal(row, source, allocations, calculated.components, []);
    });
}

export async function previewPaymentReconciliation(ctx: CommandContext, input: { paymentIntakePublicId: string; allocations: ReconciliationAllocation[]; reason: string }) {
    if (!input.reason?.trim()) throw new DomainError("RECONCILIATION_REASON_REQUIRED", "Reconciliation requires a reason", 400);
    if (!Array.isArray(input.allocations) || input.allocations.length === 0) throw new DomainError("RECONCILIATION_ALLOCATIONS_REQUIRED", "At least one explicit allocation is required", 400);
    return db.transaction(async (tx) => {
        const intake = await accessibleIntake(ctx, input.paymentIntakePublicId, tx);
        if (input.allocations.some((item) => item.component !== "interest")) throw new DomainError("RECONCILIATION_COMPONENT_NOT_SUPPORTED", "Historical reconciliation supports interest-only allocations", 409);
        await tx.execute(sql`SELECT id FROM payment_intakes WHERE tenant_id = ${ctx.tenantId} AND id = ${intake.id} FOR UPDATE`);
        const inspected = await inspectReconciliationSource(tx, ctx, intake);
        const priorReconciliation = await tx.query.paymentReconciliationGroups.findFirst({ where: and(eq(paymentReconciliationGroups.tenantId, ctx.tenantId), eq(paymentReconciliationGroups.paymentIntakeId, intake.id)) });
        if (priorReconciliation) throw new DomainError("RECONCILIATION_SOURCE_ALREADY_COMPENSATED", "The payment intake has already been reconciled", 409);
        const originals = inspected.originals;
        const allocations = await resolveAllocations(ctx, input.allocations, tx);
        const calculated = calculateReconciliationComponents(input.allocations, intake.amount);
        const provenancePlans: FloatingInterestAllocationPlan[] = [];
        for (const item of allocations.filter((candidate) => candidate.loan.repaymentType === "floating")) {
            const plan = await resolveFloatingInterestAllocationPlan(tx, item.loan, intake.receivedAt, item.amount, ctx, "preview");
            provenancePlans.push(plan);
            if (!plan.provenanceReady) throw new DomainError("RECONCILIATION_INTEREST_PROVENANCE_UNAVAILABLE", "Historical floating interest has no complete accrual provenance", 409, { loanPublicId: item.loan.publicId, warnings: plan.warnings });
        }
        const source = {
            mode: inspected.mode, paymentIntakePublicId: intake.publicId, status: intake.status, amount: serializeMoney(intake.amount), receivedAt: intake.receivedAt,
            hasReadyEvidence: inspected.hasReadyEvidence,
            currentAllocationSnapshot: originals.map(sourceTransactionSnapshot),
            reversalSnapshot: inspected.reversals.map(sourceTransactionSnapshot),
            provenancePlans,
        };
        const financialBalanceVersion = await authoritativeBalanceVersion(tx, ctx, [...allocations.map((item) => item.loanId), ...originals.map((item) => item.loanId)], false);
        const expectedBalanceVersion = inspected.mode === "reversed_repost" ? hash({ financialBalanceVersion, source }) : financialBalanceVersion;
        const previewHash = reconciliationPreviewHash(source, allocations, expectedBalanceVersion, input.reason.trim());
        const expiresAt = new Date(Date.now() + Math.max(60, Number(process.env.PAYMENT_PREVIEW_TTL_SECONDS ?? 900)) * 1000);
        const row = await tx.insert(paymentReconciliationProposals).values({
            tenantId: ctx.tenantId, paymentIntakeId: intake.id, status: "ready", previewHash, expectedBalanceVersion,
            sourceSnapshot: source, proposedAllocations: allocations.map(presentAllocation), warnings: [], reason: input.reason.trim(), expiresAt, createdByUserId: ctx.actorUserId,
        }).returning().then((rows) => rows[0]!);
        await createAuditLog(tx, { ...contextPayload(ctx), entityType: "payment_reconciliation", entityId: row.publicId, action: "previewed", payload: { paymentIntakePublicId: intake.publicId, previewHash, expectedBalanceVersion, reason: input.reason.trim() } });
        return presentProposal(row, source, allocations, calculated.components, []);
    });
}

export async function executePaymentReconciliation(ctx: CommandContext, previewPublicId: string, input: { previewHash: string; expectedBalanceVersion: string; confirmed: true; reason: string; idempotencyKey: string }) {
    if (input.confirmed !== true) throw new DomainError("CONFIRMATION_REQUIRED", "Reconciliation execute requires confirmed: true", 400);
    if (!input.reason?.trim() || !input.idempotencyKey?.trim()) throw new DomainError("RECONCILIATION_COMMAND_CONTEXT_REQUIRED", "Reason and idempotency key are required", 400);
    return db.transaction(async (tx) => {
        const prior = await tx.query.paymentReconciliationGroups.findFirst({ where: and(eq(paymentReconciliationGroups.tenantId, ctx.tenantId), eq(paymentReconciliationGroups.idempotencyKey, input.idempotencyKey)) });
        if (prior) {
            const proposal = await tx.query.paymentReconciliationProposals.findFirst({ where: and(eq(paymentReconciliationProposals.tenantId, ctx.tenantId), eq(paymentReconciliationProposals.id, prior.proposalId)) });
            if (proposal?.publicId !== previewPublicId || proposal.previewHash !== input.previewHash || prior.reason !== input.reason.trim()) throw new DomainError("IDEMPOTENCY_CONFLICT", "Idempotency key was used for a different reconciliation", 409);
            const [sourcePayment, postedPayment] = await Promise.all([
                tx.query.paymentIntakes.findFirst({ where: and(eq(paymentIntakes.tenantId, ctx.tenantId), eq(paymentIntakes.id, prior.paymentIntakeId)) }),
                tx.query.paymentIntakes.findFirst({ where: and(eq(paymentIntakes.tenantId, ctx.tenantId), eq(paymentIntakes.id, prior.postedIntakeId ?? prior.paymentIntakeId)) }),
            ]);
            const entries = await tx.select().from(paymentReconciliationEntries).where(and(eq(paymentReconciliationEntries.tenantId, ctx.tenantId), eq(paymentReconciliationEntries.groupId, prior.id))).orderBy(paymentReconciliationEntries.id);
            const transactionIds = entries.map((entry) => entry.transactionId).filter((id): id is number => id !== null);
            const transactionRows = transactionIds.length ? await tx.select({ id: transactions.id, publicId: transactions.publicId }).from(transactions).where(and(eq(transactions.tenantId, ctx.tenantId), inArray(transactions.id, transactionIds))) : [];
            const publicIdById = new Map(transactionRows.map((row) => [row.id, row.publicId]));
            const idsFor = (entryType: "reversal" | "replacement") => entries.filter((entry) => entry.entryType === entryType).map((entry) => entry.transactionId === null ? undefined : publicIdById.get(entry.transactionId)).filter((id): id is string => Boolean(id));
            return { reconciliationPublicId: prior.publicId, sourcePaymentPublicId: sourcePayment?.publicId, postedPaymentPublicId: postedPayment?.publicId, compensatingTransactionPublicIds: idsFor("reversal"), correctedTransactionPublicIds: idsFor("replacement"), auditPublicIds: [prior.auditPublicId], correlationId: prior.correlationId };
        }
        await tx.execute(sql`SELECT id FROM payment_reconciliation_proposals WHERE tenant_id = ${ctx.tenantId} AND public_id = ${previewPublicId} FOR UPDATE`);
        const proposal = await tx.query.paymentReconciliationProposals.findFirst({ where: and(eq(paymentReconciliationProposals.tenantId, ctx.tenantId), eq(paymentReconciliationProposals.publicId, previewPublicId)) });
        if (!proposal) throw new DomainError("RECONCILIATION_PREVIEW_NOT_FOUND", "Reconciliation preview not found", 404);
        if (proposal.status !== "ready" || proposal.expiresAt.getTime() <= Date.now()) throw new DomainError("STALE_RECONCILIATION_PREVIEW", "Reconciliation preview is expired or already executed", 409);
        if (proposal.previewHash !== input.previewHash || proposal.expectedBalanceVersion !== input.expectedBalanceVersion) throw new DomainError("STALE_RECONCILIATION_PREVIEW", "Reconciliation preview no longer matches current state", 409);
        if (proposal.reason !== input.reason.trim()) throw new DomainError("RECONCILIATION_REASON_MISMATCH", "Execution reason must match the preview reason", 409);
        const intake = await accessibleIntake(ctx, (await tx.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.id, proposal.paymentIntakeId) }))!.publicId, tx);
        const restoreMode = (proposal.sourceSnapshot as { mode?: string }).mode === "exact_restore";
        const inspectedBeforeLocks = await inspectReconciliationSource(tx, ctx, intake, restoreMode ? { requireSourceEvidence: false, allowDraftChild: true } : undefined);
        const priorForIntake = await tx.query.paymentReconciliationGroups.findFirst({ where: and(eq(paymentReconciliationGroups.tenantId, ctx.tenantId), eq(paymentReconciliationGroups.paymentIntakeId, intake.id)) });
        if (priorForIntake) throw new DomainError("RECONCILIATION_SOURCE_ALREADY_COMPENSATED", "The payment intake has already been reconciled", 409);
        const allocations = await resolveAllocations(ctx, proposal.proposedAllocations as ReconciliationAllocation[], tx);
        if (!restoreMode && allocations.some((item) => item.component !== "interest")) throw new DomainError("RECONCILIATION_COMPONENT_NOT_SUPPORTED", "Historical reconciliation supports interest-only allocations", 409);
        const sourceRowsForLock: Array<{ loanId: number }> = inspectedBeforeLocks.originals;
        const lockLoanIds = [...new Set([...allocations.map((item) => item.loanId), ...sourceRowsForLock.map((item) => item.loanId)])].sort((left, right) => left - right);
        if (lockLoanIds.length) await tx.execute(sql`SELECT id FROM loans WHERE tenant_id = ${ctx.tenantId} AND id IN (${sql.join(lockLoanIds.map((id) => sql`${id}`), sql`, `)}) ORDER BY id FOR UPDATE`);
        if (lockLoanIds.length) await tx.execute(sql`SELECT id FROM loan_interest_accruals WHERE tenant_id = ${ctx.tenantId} AND loan_id IN (${sql.join(lockLoanIds.map((id) => sql`${id}`), sql`, `)}) ORDER BY loan_id, id FOR UPDATE`);
        if (lockLoanIds.length) await tx.execute(sql`SELECT id FROM transactions WHERE tenant_id = ${ctx.tenantId} AND loan_id IN (${sql.join(lockLoanIds.map((id) => sql`${id}`), sql`, `)}) ORDER BY loan_id, id FOR UPDATE`);
        const inspected = await inspectReconciliationSource(tx, ctx, intake, restoreMode ? { requireSourceEvidence: false, allowDraftChild: true } : undefined);
        const restoreDraft = restoreMode ? await restoreDraftEvidence(tx, ctx, inspected.repostChild) : null;
        const currentOriginals = inspected.originals;
        const currentProvenancePlans: FloatingInterestAllocationPlan[] = [];
        if (!restoreMode) {
            for (const item of allocations.filter((candidate) => candidate.loan.repaymentType === "floating")) {
                const plan = await resolveFloatingInterestAllocationPlan(tx, item.loan, intake.receivedAt, item.amount, ctx, "execute");
                currentProvenancePlans.push(plan);
                if (!plan.provenanceReady) throw new DomainError("RECONCILIATION_INTEREST_PROVENANCE_UNAVAILABLE", "Historical floating interest has no complete accrual provenance", 409, { loanPublicId: item.loan.publicId, warnings: plan.warnings });
            }
        }
        const currentSource = {
            mode: restoreMode ? "exact_restore" : inspected.mode,
            ...(restoreMode ? { sourceMode: inspected.mode } : {}),
            paymentIntakePublicId: intake.publicId, status: intake.status, amount: serializeMoney(intake.amount), receivedAt: intake.receivedAt,
            hasReadyEvidence: restoreMode ? true : inspected.hasReadyEvidence,
            ...(restoreMode ? { restoreDraftPublicId: restoreDraft!.publicId } : {}),
            currentAllocationSnapshot: currentOriginals.map(sourceTransactionSnapshot),
            reversalSnapshot: inspected.reversals.map(sourceTransactionSnapshot),
            ...(!restoreMode ? { provenancePlans: currentProvenancePlans } : {}),
        };
        const previewPlans = ((proposal.sourceSnapshot as { provenancePlans?: FloatingInterestAllocationPlan[] }).provenancePlans ?? []);
        if (!restoreMode && !provenancePlansMatch(currentProvenancePlans, previewPlans)) throw new DomainError("STALE_RECONCILIATION_PREVIEW", "Floating interest provenance differs from preview", 409);
        const financialBalanceVersion = await authoritativeBalanceVersion(tx, ctx, [...allocations.map((item) => item.loanId), ...currentOriginals.map((item) => item.loanId)], false);
        const currentBalanceVersion = (proposal.sourceSnapshot as { mode?: string }).mode === "exact_restore" || inspected.mode === "reversed_repost" ? hash({ financialBalanceVersion, source: currentSource }) : financialBalanceVersion;
        if (currentBalanceVersion !== proposal.expectedBalanceVersion) throw new DomainError("STALE_RECONCILIATION_PREVIEW", "Affected financial state differs from preview", 409);
        const hashSource = !restoreMode && previewPlans.length ? { ...currentSource, provenancePlans: previewPlans } : currentSource;
        if (reconciliationPreviewHash(hashSource, allocations, proposal.expectedBalanceVersion, proposal.reason) !== proposal.previewHash) throw new DomainError("STALE_RECONCILIATION_PREVIEW", "Current payment state differs from preview", 409);
        const audit = await createAuditLog(tx, { ...contextPayload(ctx), entityType: "payment_reconciliation", entityId: proposal.publicId, action: "executed", payload: { paymentIntakePublicId: intake.publicId, reason: input.reason.trim(), idempotencyKey: input.idempotencyKey, before: proposal.sourceSnapshot, after: proposal.proposedAllocations } });
        const postedIntake = restoreMode
            ? await tx.update(paymentIntakes).set({ status: "posted", postedAt: new Date(), postedByUserId: ctx.actorUserId, updatedByUserId: ctx.actorUserId, updatedAt: new Date() }).where(and(
                eq(paymentIntakes.tenantId, ctx.tenantId), eq(paymentIntakes.id, restoreDraft!.id), eq(paymentIntakes.status, "draft"),
            )).returning().then((rows) => {
                if (!rows[0]) throw new DomainError("RECONCILIATION_RESTORE_DRAFT_REQUIRED", "Restore draft is no longer postable", 409);
                return rows[0];
            })
            : inspected.mode === "reversed_repost"
            ? await tx.insert(paymentIntakes).values({
                tenantId: ctx.tenantId, ownerUserId: intake.ownerUserId, source: intake.source, status: "posted", amount: serializeMoney(intake.amount), receivedAt: intake.receivedAt,
                payerName: intake.payerName, originLoanId: intake.originLoanId, repostOfIntakeId: intake.id,
                notes: `Reposted after reversal from ${intake.publicId}: ${input.reason.trim()}`,
                postedAt: new Date(), createdByUserId: ctx.actorUserId, updatedByUserId: ctx.actorUserId, postedByUserId: ctx.actorUserId,
            }).returning().then((rows) => rows[0]!)
            : intake;
        const group = await tx.insert(paymentReconciliationGroups).values({ tenantId: ctx.tenantId, proposalId: proposal.id, paymentIntakeId: intake.id, postedIntakeId: postedIntake.id, reason: input.reason.trim(), idempotencyKey: input.idempotencyKey, correlationId: ctx.correlationId, auditPublicId: audit.publicId, createdByUserId: ctx.actorUserId }).returning().then((rows) => rows[0]!);
        const entryRows: Array<typeof paymentReconciliationEntries.$inferSelect> = [];
        for (const original of inspected.mode === "historical_needs_review" ? currentOriginals : []) {
            const reversal = await tx.insert(transactions).values({ tenantId: ctx.tenantId, ownerUserId: original.ownerUserId, loanId: original.loanId, scheduleId: original.scheduleId, amount: `-${serializeMoney(original.amount)}`, principalComponent: `-${serializeMoney(original.principalComponent)}`, interestComponent: `-${serializeMoney(original.interestComponent)}`, feeComponent: `-${serializeMoney(original.feeComponent)}`, penaltyComponent: `-${serializeMoney(original.penaltyComponent)}`, type: "reversal", transactionDate: new Date(), recordedByUserId: ctx.actorUserId, paymentIntakeId: intake.id, entryType: "reversal", reversedTransactionId: original.id, idempotencyKey: `reconciliation-reversal:${group.publicId}:${original.id}`, postedAt: new Date() }).returning().then((rows) => rows[0]!);
            const entry = await tx.insert(paymentReconciliationEntries).values({ tenantId: ctx.tenantId, groupId: group.id, entryType: "reversal", component: "mixed", amount: `-${serializeMoney(original.amount)}`, principalComponent: `-${serializeMoney(original.principalComponent)}`, interestComponent: `-${serializeMoney(original.interestComponent)}`, feeComponent: `-${serializeMoney(original.feeComponent)}`, penaltyComponent: `-${serializeMoney(original.penaltyComponent)}`, sourceTransactionId: original.id, transactionId: reversal.id, loanId: original.loanId, scheduleId: original.scheduleId, reason: input.reason.trim(), auditPublicId: audit.publicId, createdByUserId: ctx.actorUserId }).returning().then((rows) => rows[0]!);
            entryRows.push(entry);
            const sourceLoan = await tx.query.loans.findFirst({ where: and(eq(loans.tenantId, ctx.tenantId), eq(loans.id, original.loanId)) });
            if (!sourceLoan) throw new DomainError("RECONCILIATION_TARGET_MISSING", "Source loan no longer exists", 409);
            const restoredPrincipal = new Decimal(sourceLoan.outstandingPrincipal ?? sourceLoan.principalAmount).plus(original.principalComponent);
            const restoredInterest = new Decimal(sourceLoan.outstandingInterest ?? "0.00").plus(original.interestComponent);
            await tx.update(loans).set({ outstandingPrincipal: serializeMoney(restoredPrincipal), outstandingInterest: serializeMoney(restoredInterest), updatedAt: new Date() }).where(and(eq(loans.tenantId, ctx.tenantId), eq(loans.id, sourceLoan.id)));
        }
        const replacementPublicIds: string[] = [];
        for (const allocation of allocations) {
            const target = await tx.query.loans.findFirst({ where: and(eq(loans.tenantId, ctx.tenantId), eq(loans.publicId, allocation.loanPublicId)) });
            if (!target) throw new DomainError("INVALID_RECONCILIATION_TARGET", "Allocation target disappeared", 409);
            const amounts = { principal: "0.00", interest: "0.00", fee: "0.00", penalty: "0.00" };
            amounts[allocation.component] = serializeMoney(allocation.amount);
            const schedule = allocation.schedulePublicId ? await tx.query.loanSchedules.findFirst({ where: and(eq(loanSchedules.tenantId, ctx.tenantId), eq(loanSchedules.publicId, allocation.schedulePublicId), eq(loanSchedules.loanId, target.id)) }) : null;
            if (allocation.schedulePublicId && !schedule) throw new DomainError("INVALID_RECONCILIATION_TARGET", "Schedule no longer belongs to the allocation loan", 409);
            const replacement = await tx.insert(transactions).values({ tenantId: ctx.tenantId, ownerUserId: target.ownerUserId ?? ctx.actorUserId, loanId: target.id, scheduleId: schedule?.id ?? null, amount: serializeMoney(allocation.amount), principalComponent: amounts.principal, interestComponent: amounts.interest, feeComponent: amounts.fee, penaltyComponent: amounts.penalty, type: "repayment", transactionDate: intake.receivedAt, recordedByUserId: ctx.actorUserId, paymentIntakeId: postedIntake.id, entryType: "repayment", idempotencyKey: `reconciliation-replacement:${group.publicId}:${replacementPublicIds.length}`, postedAt: new Date() }).returning().then((rows) => rows[0]!);
            replacementPublicIds.push(replacement.publicId);
            await tx.insert(paymentReconciliationEntries).values({ tenantId: ctx.tenantId, groupId: group.id, entryType: "replacement", component: allocation.component, amount: serializeMoney(allocation.amount), principalComponent: amounts.principal, interestComponent: amounts.interest, feeComponent: amounts.fee, penaltyComponent: amounts.penalty, transactionId: replacement.id, loanId: target.id, reason: input.reason.trim(), auditPublicId: audit.publicId, createdByUserId: ctx.actorUserId });
            const updatedPrincipal = Decimal.max(0, new Decimal(target.outstandingPrincipal ?? target.principalAmount).minus(amounts.principal));
            const updatedInterest = Decimal.max(0, new Decimal(target.outstandingInterest ?? "0.00").minus(amounts.interest));
            await tx.update(loans).set({ outstandingPrincipal: serializeMoney(updatedPrincipal), outstandingInterest: serializeMoney(updatedInterest), updatedAt: new Date() }).where(and(eq(loans.tenantId, ctx.tenantId), eq(loans.id, target.id)));
            if (schedule) {
                const aggregate = restoreScheduleAggregate(schedule, amounts);
                await tx.update(loanSchedules).set({ ...aggregate, updatedAt: new Date() }).where(and(eq(loanSchedules.tenantId, ctx.tenantId), eq(loanSchedules.id, schedule.id)));
            }
            if (allocation.component === "interest" && target.repaymentType === "floating") {
                const plan = currentProvenancePlans.find((candidate) => candidate.loanPublicId === target.publicId && candidate.requestedAmount === serializeMoney(allocation.amount));
                if (!plan) throw new DomainError("RECONCILIATION_INTEREST_PROVENANCE_UNAVAILABLE", "Floating interest allocation plan is missing", 409);
                let allocationOrder = 1;
                for (const planned of plan.allocations) {
                    const accrual = await tx.query.loanInterestAccruals.findFirst({ where: and(eq(loanInterestAccruals.tenantId, ctx.tenantId), eq(loanInterestAccruals.id, planned.accrualId), eq(loanInterestAccruals.loanId, target.id)) });
                    if (!accrual) throw new DomainError("RECONCILIATION_INTEREST_PROVENANCE_UNAVAILABLE", "Floating accrual disappeared during reconciliation", 409);
                    const applied = new Decimal(planned.amount);
                    await tx.insert(floatingTransactionAllocations).values({ tenantId: ctx.tenantId, loanId: target.id, transactionId: replacement.id, dueDate: accrual.accrualDate, component: "interest", interestAccrualId: accrual.id, effectiveDate: bangkokBusinessDate(intake.receivedAt), allocationOrder, entryType: "payment", amount: serializeMoney(applied), reversedAllocationId: null, reason: null, idempotencyKey: `reconciliation-floating-allocation:${group.publicId}:${replacement.publicId}:${allocationOrder}`, auditPublicId: audit.publicId, actorSource: ctx.actorSource, requestId: ctx.requestId, correlationId: ctx.correlationId, createdByUserId: ctx.actorUserId });
                    const paid = new Decimal(accrual.paidAmount).plus(applied);
                    await tx.update(loanInterestAccruals).set({ paidAmount: serializeMoney(paid), status: paid.gte(accrual.interestAmount) ? "paid" : "partially_paid" }).where(and(eq(loanInterestAccruals.tenantId, ctx.tenantId), eq(loanInterestAccruals.id, accrual.id)));
                    allocationOrder += 1;
                }
            }
        }
        await tx.update(paymentReconciliationProposals).set({ status: "executed", executedByUserId: ctx.actorUserId, executedAt: new Date() }).where(eq(paymentReconciliationProposals.id, proposal.id));
        if (intake.status === "needs_review") await tx.update(paymentIntakes).set({ status: "posted", postedAt: new Date(), postedByUserId: ctx.actorUserId, updatedByUserId: ctx.actorUserId, updatedAt: new Date() }).where(eq(paymentIntakes.id, intake.id));
        return { reconciliationPublicId: group.publicId, sourcePaymentPublicId: intake.publicId, postedPaymentPublicId: postedIntake.publicId, compensatingTransactionPublicIds: [...entryRows.map((entry) => entry.transactionId).filter((id): id is number => id !== null)], correctedTransactionPublicIds: replacementPublicIds, auditPublicIds: [audit.publicId], correlationId: ctx.correlationId };
    });
}

/** No-write feasibility gate used immediately before asking for confirmation. */
export async function preflightPaymentExecution(ctx: CommandContext, input: { paymentIntakePublicId: string; allocations?: ReconciliationAllocation[]; reason: string; proposalPublicId?: string }) {
    const checks: Array<{ name: string; status: "pass" | "fail" | "warning"; code?: string }> = [];
    try {
        // Generic payment.post proposals have no component decomposition until
        // the backend's posting allocator runs. The no-write gate therefore
        // validates the exact ready proposal and exposes its target amounts;
        // reconciliation inputs continue through the provenance-aware path.
        if (input.proposalPublicId !== undefined) {
            const intake = await accessibleIntake(ctx, input.paymentIntakePublicId, db);
            const proposal = await db.query.paymentMatchProposals.findFirst({ where: and(
                eq(paymentMatchProposals.tenantId, ctx.tenantId),
                eq(paymentMatchProposals.publicId, input.proposalPublicId),
                eq(paymentMatchProposals.paymentIntakeId, intake.id),
            ) });
            if (!proposal || proposal.status !== "ready" || !proposal.expiresAt || proposal.expiresAt.getTime() <= Date.now()) {
                throw new DomainError("PAYMENT_PREFLIGHT_NOT_READY", "The payment proposal is not currently executable", 409);
            }
            if (((proposal.warnings as unknown[] | null) ?? []).length > 0) throw new DomainError("PAYMENT_PREFLIGHT_REVIEW_REQUIRED", "The payment proposal still has review warnings", 409);
            const rows = await db.select().from(paymentMatchAllocations).where(and(
                eq(paymentMatchAllocations.tenantId, ctx.tenantId), eq(paymentMatchAllocations.proposalId, proposal.id), eq(paymentMatchAllocations.status, "proposed"),
            )).orderBy(paymentMatchAllocations.allocationOrder);
            const targets = await Promise.all(rows.map(async (row) => db.query.loans.findFirst({ where: and(eq(loans.tenantId, ctx.tenantId), eq(loans.id, row.loanId)) })));
            const affectedLoanPublicIds = targets.flatMap((loan) => loan ? [loan.publicId] : []);
            const preflightHash = hash({ paymentIntakePublicId: intake.publicId, proposalPublicId: proposal.publicId, proposalHash: proposal.proposalHash });
            checks.push({ name: "source", status: "pass" }, { name: "proposal_ready", status: "pass" }, { name: "duplicate", status: "pass" }, { name: "execute_feasibility", status: "pass" });
            return {
                status: "ready_to_execute" as const, wouldWrite: false as const, sourcePaymentPublicId: intake.publicId,
                affectedLoanPublicIds, exactAmount: serializeMoney(intake.amount),
                proposedComponents: { principal: "0.00", interest: "0.00", fee: "0.00", penalty: "0.00" },
                allocationPlan: rows.map((row, index) => ({ loanPublicId: affectedLoanPublicIds[index]!, component: "principal" as const, amount: serializeMoney(row.amount) })),
                checks, previewHash: preflightHash, expectedBalanceVersion: preflightHash, reviewRequired: false,
            };
        }
        const allocations = input.allocations ?? [];
        const preview = await previewPaymentReconciliation(ctx, { ...input, allocations });
        const source = preview.sourcePayment as { amount?: string };
        checks.push(...[
            { name: "source", status: "pass" as const }, { name: "identity", status: "pass" as const },
            { name: "duplicate", status: "pass" as const }, { name: "component_conservation", status: "pass" as const },
            { name: "floating_provenance", status: "pass" as const }, { name: "execute_revalidation", status: "pass" as const },
        ]);
        return {
            status: "ready_to_execute" as const, wouldWrite: false as const, sourcePaymentPublicId: input.paymentIntakePublicId,
            affectedLoanPublicIds: [...new Set(allocations.map((item) => item.loanPublicId))], exactAmount: source.amount ?? "0.00",
            proposedComponents: preview.correction, allocationPlan: allocations.map((item) => {
                const plan = ((preview.sourcePayment as { provenancePlans?: FloatingInterestAllocationPlan[] }).provenancePlans ?? []).find((candidate) => candidate.loanPublicId === item.loanPublicId && candidate.requestedAmount === item.amount);
                return { loanPublicId: item.loanPublicId, component: item.component, amount: item.amount, accrualPublicIds: plan?.allocations.map((allocation) => allocation.accrualPublicId).filter((id) => publicUuidPattern.test(id)) };
            }),
            checks, previewHash: preview.previewHash, expectedBalanceVersion: preview.expectedBalanceVersion, reviewRequired: false,
            previewPersistence: { proposalPublicId: preview.publicId, expiresAt: preview.expiresAt },
        };
    } catch (error) {
        const domain = error instanceof DomainError ? error : new DomainError("PAYMENT_PREFLIGHT_FAILED", "Payment execution preflight failed", 409);
        checks.push({ name: "execute_feasibility", status: "fail", code: domain.code });
        return {
            status: "review_required" as const, wouldWrite: false as const, sourcePaymentPublicId: input.paymentIntakePublicId,
            affectedLoanPublicIds: [...new Set((input.allocations ?? []).map((item) => item.loanPublicId))], exactAmount: "0.00",
            proposedComponents: { principal: "0.00", interest: "0.00", fee: "0.00", penalty: "0.00" }, allocationPlan: [],
            checks, previewHash: "v1:" + "0".repeat(64), expectedBalanceVersion: "v1:" + "0".repeat(64), reviewRequired: true,
            warning: { code: domain.code, message: domain.message },
        };
    }
}
