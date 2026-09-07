import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { auditLogs, loanSchedules, loans, paymentAllocationCorrectionEntries, paymentAllocationCorrectionGroups, paymentAllocationCorrectionPreviews, paymentIntakes, transactions } from "../db/schema";
import { FinancialDecimal } from "../lib/financial-decimal";
import { serializeMoney } from "../lib/money";
import { createAuditLog } from "../lib/audit-log";
import type { CommandContext } from "./command-context";
import { DomainError } from "./domain-error";
import { refreshReplacementLoanEconomicRollup } from "./payment-service";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type MoneyDecimal = InstanceType<typeof FinancialDecimal>;
const money = (value: string | MoneyDecimal) => new FinancialDecimal(value).toDecimalPlaces(2, FinancialDecimal.ROUND_HALF_UP).toFixed(2);
const signed = (value: MoneyDecimal) => value.toDecimalPlaces(2, FinancialDecimal.ROUND_HALF_UP).toFixed(2);
const zero = () => new FinancialDecimal("0");
const componentsOf = (row: typeof transactions.$inferSelect) => ({ principal: money(row.principalComponent), interest: money(row.interestComponent), fee: money(row.feeComponent), penalty: money(row.penaltyComponent) });
const componentTotal = (c: { principal: string; interest: string; fee: string; penalty: string }) => new FinancialDecimal(c.principal).plus(c.interest).plus(c.fee).plus(c.penalty);
function id(value: string, field: string) { if (!uuid.test(value)) throw new DomainError("INVALID_PUBLIC_ID", `${field} must be a UUID`, 400, { field }); }
function reason(value: string) { const normalized = value.trim().replace(/\s+/g, " "); if (!normalized) throw new DomainError("INVALID_REASON", "reason must not be blank", 400); return normalized; }
function hash(value: unknown) { return `v1:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }

export interface PreviewPaymentAllocationCorrectionInput { paymentIntakePublicId: string; transactionPublicId: string; targetSchedulePublicId: string; reason: string; }
export interface CorrectionScheduleProjection { schedulePublicId: string; dueDate: string; before: { paidTotal: string; paidPenalty: string; remainingDue: string; status: string }; after: { paidTotal: string; paidPenalty: string; remainingDue: string; status: string }; }
export interface PaymentAllocationCorrectionPreview { publicId: string; status: "ready" | "blocked"; paymentIntakePublicId: string; transactionPublicId: string; loanPublicId: string; source: CorrectionScheduleProjection; target: CorrectionScheduleProjection; amount: string; components: { principal: string; interest: string; fee: string; penalty: string }; netLoanVariance: { amount: string; principal: string; interest: string; fee: string; penalty: string }; warnings: Array<{ code: string; blockerPublicIds?: string[] }>; previewHash: string; expectedBalanceVersion: string; expiresAt: string; }
export interface ExecutePaymentAllocationCorrectionInput { correctionPreviewPublicId: string; previewHash: string; expectedBalanceVersion: string; confirmed: true; reason: string; idempotencyKey: string; }
export interface ExecutedPaymentAllocationCorrection { correctionPublicId: string; paymentIntakePublicId: string; sourceTransactionPublicId: string; compensatingTransactionPublicId: string; replacementTransactionPublicId: string; sourceSchedulePublicId: string; targetSchedulePublicId: string; amount: string; components: { principal: string; interest: string; fee: string; penalty: string }; auditPublicId: string; correlationId: string; }

type Executor = any;
type PreviewRow = typeof paymentAllocationCorrectionPreviews.$inferSelect;

function projection(schedule: typeof loanSchedules.$inferSelect, paid: MoneyDecimal, penalty: MoneyDecimal, remaining: MoneyDecimal, status?: string): CorrectionScheduleProjection {
    return { schedulePublicId: schedule.publicId, dueDate: schedule.dueDate, before: { paidTotal: money(schedule.paidTotal), paidPenalty: money(schedule.paidPenalty), remainingDue: money(schedule.remainingDue), status: schedule.status }, after: { paidTotal: money(paid), paidPenalty: money(penalty), remainingDue: money(remaining), status: status ?? schedule.status } };
}

async function load(ctx: CommandContext, input: PreviewPaymentAllocationCorrectionInput, executor: Executor = db) {
    id(input.paymentIntakePublicId, "paymentIntakePublicId"); id(input.transactionPublicId, "transactionPublicId"); id(input.targetSchedulePublicId, "targetSchedulePublicId");
    const intake = await executor.query.paymentIntakes.findFirst({ where: and(eq(paymentIntakes.tenantId, ctx.tenantId), eq(paymentIntakes.publicId, input.paymentIntakePublicId)) });
    if (!intake) throw new DomainError("PAYMENT_INTAKE_NOT_FOUND", "Payment intake not found", 404);
    if (intake.status !== "posted") throw new DomainError("PAYMENT_NOT_POSTED", "Payment intake must be posted", 409);
    const source = await executor.query.transactions.findFirst({ where: and(eq(transactions.tenantId, ctx.tenantId), eq(transactions.publicId, input.transactionPublicId)) });
    if (!source || source.paymentIntakeId !== intake.id) throw new DomainError("TRANSACTION_NOT_FOUND", "Payment transaction not found", 404);
    if (source.entryType !== "repayment" || !source.scheduleId || !new FinancialDecimal(source.amount).gt(0)) throw new DomainError("INVALID_CORRECTION_SOURCE", "Source must be a positive scheduled repayment", 409);
    const reversal = await executor.query.transactions.findFirst({ where: and(eq(transactions.tenantId, ctx.tenantId), eq(transactions.reversedTransactionId, source.id)) });
    if (reversal) throw new DomainError("SOURCE_ALREADY_REVERSED", "Source transaction is already reversed", 409);
    const loan = await executor.query.loans.findFirst({ where: and(eq(loans.tenantId, ctx.tenantId), eq(loans.id, source.loanId)) });
    if (!loan || loan.status !== "active") throw new DomainError("LOAN_NOT_ACTIVE", "Source loan is not active", 409);
    if (loan.repaymentType === "floating") throw new DomainError("FLOATING_CORRECTION_UNSUPPORTED", "Floating-loan allocation correction is not supported", 409);
    const sourceSchedule = await executor.query.loanSchedules.findFirst({ where: and(eq(loanSchedules.tenantId, ctx.tenantId), eq(loanSchedules.id, source.scheduleId)) });
    const targetSchedule = await executor.query.loanSchedules.findFirst({ where: and(eq(loanSchedules.tenantId, ctx.tenantId), eq(loanSchedules.publicId, input.targetSchedulePublicId)) });
    if (!sourceSchedule || !targetSchedule || targetSchedule.loanId !== loan.id) throw new DomainError("SCHEDULE_NOT_FOUND", "Schedule is not in the source loan", 409);
    if (sourceSchedule.id === targetSchedule.id) throw new DomainError("SAME_SCHEDULE", "Source and target schedules must differ", 409);
    const c = componentsOf(source); const amount = money(source.amount);
    if (!componentTotal(c).eq(amount)) throw new DomainError("PAYMENT_COMPONENT_MISMATCH", "Source components do not conserve the amount", 409);
    if (new FinancialDecimal(targetSchedule.remainingDue).lt(amount)) throw new DomainError("TARGET_OVERPAYMENT", "Target schedule cannot accept the complete replacement", 409);
    const existing = await executor.query.paymentAllocationCorrectionGroups.findFirst({ where: and(eq(paymentAllocationCorrectionGroups.tenantId, ctx.tenantId), eq(paymentAllocationCorrectionGroups.sourceTransactionId, source.id)) });
    if (existing) throw new DomainError("CORRECTION_ALREADY_EXECUTED", "Source transaction already has a correction", 409);
    const normalizedReason = reason(input.reason);
    return { intake, source, loan, sourceSchedule, targetSchedule, c, amount, normalizedReason };
}

function nextState(schedule: typeof loanSchedules.$inferSelect, delta: { paid: MoneyDecimal; penalty: MoneyDecimal; remaining: MoneyDecimal }) {
    const status = delta.remaining.lte(0) ? "paid" : delta.paid.gt(0) || delta.penalty.gt(0) ? "partial" : "pending";
    return projection(schedule, delta.paid, delta.penalty, delta.remaining, status);
}

export async function previewPaymentAllocationCorrection(ctx: CommandContext, input: PreviewPaymentAllocationCorrectionInput): Promise<PaymentAllocationCorrectionPreview> {
    const loaded = await load(ctx, input);
    const amount = new FinancialDecimal(loaded.amount);
    const nonPenalty = amount.minus(loaded.c.penalty);
    const sourcePaid = new FinancialDecimal(loaded.sourceSchedule.paidTotal).minus(nonPenalty);
    const sourcePenalty = new FinancialDecimal(loaded.sourceSchedule.paidPenalty).minus(loaded.c.penalty);
    const sourceRemaining = new FinancialDecimal(loaded.sourceSchedule.remainingDue).plus(nonPenalty);
    const targetPaid = new FinancialDecimal(loaded.targetSchedule.paidTotal).plus(nonPenalty);
    const targetPenalty = new FinancialDecimal(loaded.targetSchedule.paidPenalty).plus(loaded.c.penalty);
    const targetRemaining = new FinancialDecimal(loaded.targetSchedule.remainingDue).minus(nonPenalty);
    if (sourcePaid.lt(0) || sourcePenalty.lt(0) || targetRemaining.lt(0)) throw new DomainError("CORRECTION_STATE_INVALID", "Correction would create an invalid schedule balance", 409);
    const sourceProjection = nextState(loaded.sourceSchedule, { paid: sourcePaid, penalty: sourcePenalty, remaining: sourceRemaining });
    const targetProjection = nextState(loaded.targetSchedule, { paid: targetPaid, penalty: targetPenalty, remaining: targetRemaining });
    const expires = new Date(Date.now() + 15 * 60 * 1000);
    const safeSnapshot = { intakePublicId: loaded.intake.publicId, transactionPublicId: loaded.source.publicId, loanPublicId: loaded.loan.publicId, schedulePublicId: loaded.sourceSchedule.publicId, amount: loaded.amount, components: loaded.c };
    const balanceVersion = hash({ intake: loaded.intake.status, source: loaded.source, sourceSchedule: loaded.sourceSchedule, targetSchedule: loaded.targetSchedule, loan: { publicId: loaded.loan.publicId, status: loaded.loan.status, outstandingPrincipal: loaded.loan.outstandingPrincipal, outstandingInterest: loaded.loan.outstandingInterest, outstandingFees: loaded.loan.outstandingFees } });
    const previewHash = hash({ safeSnapshot, targetSchedulePublicId: loaded.targetSchedule.publicId, reason: loaded.normalizedReason, sourceProjection, targetProjection, balanceVersion });
    const inserted = await db.insert(paymentAllocationCorrectionPreviews).values({ tenantId: ctx.tenantId, paymentIntakeId: loaded.intake.id, sourceTransactionId: loaded.source.id, sourceScheduleId: loaded.sourceSchedule.id, targetScheduleId: loaded.targetSchedule.id, loanId: loaded.loan.id, status: "ready", amount: loaded.amount, principalComponent: loaded.c.principal, interestComponent: loaded.c.interest, feeComponent: loaded.c.fee, penaltyComponent: loaded.c.penalty, sourceSnapshot: safeSnapshot, targetSnapshot: { schedulePublicId: loaded.targetSchedule.publicId, dueDate: loaded.targetSchedule.dueDate }, proposedProjection: { source: sourceProjection, target: targetProjection }, warnings: [], previewHash, expectedBalanceVersion: balanceVersion, reason: loaded.normalizedReason, expiresAt: expires, createdByUserId: ctx.actorUserId }).returning(); const row = inserted[0]!;
    return { publicId: row.publicId, status: "ready", paymentIntakePublicId: loaded.intake.publicId, transactionPublicId: loaded.source.publicId, loanPublicId: loaded.loan.publicId, source: sourceProjection, target: targetProjection, amount: loaded.amount, components: loaded.c, netLoanVariance: { amount: "0.00", principal: "0.00", interest: "0.00", fee: "0.00", penalty: "0.00" }, warnings: [], previewHash, expectedBalanceVersion: balanceVersion, expiresAt: expires.toISOString() };
}

function output(group: typeof paymentAllocationCorrectionGroups.$inferSelect, source: typeof transactions.$inferSelect, reversal: typeof transactions.$inferSelect, replacement: typeof transactions.$inferSelect, components: { principal: string; interest: string; fee: string; penalty: string }, auditPublicId: string, intakePublicId: string, sourceSchedulePublicId: string, targetSchedulePublicId: string): ExecutedPaymentAllocationCorrection { return { correctionPublicId: group.publicId, paymentIntakePublicId: intakePublicId, sourceTransactionPublicId: source.publicId, compensatingTransactionPublicId: reversal.publicId, replacementTransactionPublicId: replacement.publicId, sourceSchedulePublicId, targetSchedulePublicId, amount: money(source.amount), components, auditPublicId, correlationId: group.correlationId }; }

export async function executePaymentAllocationCorrection(ctx: CommandContext, input: ExecutePaymentAllocationCorrectionInput): Promise<ExecutedPaymentAllocationCorrection> {
    id(input.correctionPreviewPublicId, "correctionPreviewPublicId"); if (!input.confirmed) throw new DomainError("CONFIRMATION_REQUIRED", "confirmed must be true", 400); const normalizedReason = reason(input.reason); const key = input.idempotencyKey.trim(); if (!key) throw new DomainError("INVALID_IDEMPOTENCY_KEY", "idempotencyKey must not be blank", 400);
    return db.transaction(async (tx: Executor) => {
        const existing = await tx.query.paymentAllocationCorrectionGroups.findFirst({ where: and(eq(paymentAllocationCorrectionGroups.tenantId, ctx.tenantId), eq(paymentAllocationCorrectionGroups.idempotencyKey, key)) });
        if (existing) { if (existing.reason !== normalizedReason) throw new DomainError("IDEMPOTENCY_CONFLICT", "Idempotency key was used with a different correction", 409); const entries = await tx.select().from(paymentAllocationCorrectionEntries).where(and(eq(paymentAllocationCorrectionEntries.tenantId, ctx.tenantId), eq(paymentAllocationCorrectionEntries.groupId, existing.id))).orderBy(paymentAllocationCorrectionEntries.id); const txs = await tx.select().from(transactions).where(inArray(transactions.id, entries.map((e: any) => e.transactionId))); const source = await tx.query.transactions.findFirst({ where: eq(transactions.id, existing.sourceTransactionId) }); const intake = await tx.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.id, existing.paymentIntakeId) }); const sourceSchedule = await tx.query.loanSchedules.findFirst({ where: eq(loanSchedules.id, existing.sourceScheduleId) }); const targetSchedule = await tx.query.loanSchedules.findFirst({ where: eq(loanSchedules.id, existing.targetScheduleId) }); if (!source || !intake || !sourceSchedule || !targetSchedule || txs.length !== 2) throw new DomainError("CORRECTION_CORRUPT", "Correction history is incomplete", 409); return output(existing, source, txs.find((r: any) => r.entryType === "reversal")!, txs.find((r: any) => r.entryType === "repayment")!, componentsOf(source), existing.auditPublicId, intake.publicId, sourceSchedule.publicId, targetSchedule.publicId); }
        const preview = await tx.query.paymentAllocationCorrectionPreviews.findFirst({ where: and(eq(paymentAllocationCorrectionPreviews.tenantId, ctx.tenantId), eq(paymentAllocationCorrectionPreviews.publicId, input.correctionPreviewPublicId)) });
        if (!preview || preview.status !== "ready") throw new DomainError("PREVIEW_NOT_EXECUTABLE", "Correction preview is not executable", 409);
        if (preview.previewHash !== input.previewHash || preview.expectedBalanceVersion !== input.expectedBalanceVersion || preview.reason !== normalizedReason) throw new DomainError("STALE_CORRECTION_PREVIEW", "Correction preview guards no longer match", 409);
        if (preview.expiresAt.getTime() <= Date.now()) throw new DomainError("EXPIRED_CORRECTION_PREVIEW", "Correction preview has expired", 409);
        const loaded = await load(ctx, { paymentIntakePublicId: (await tx.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.id, preview.paymentIntakeId) }))!.publicId, transactionPublicId: (await tx.query.transactions.findFirst({ where: eq(transactions.id, preview.sourceTransactionId) }))!.publicId, targetSchedulePublicId: (await tx.query.loanSchedules.findFirst({ where: eq(loanSchedules.id, preview.targetScheduleId) }))!.publicId, reason: normalizedReason }, tx);
        if (loaded.sourceSchedule.id !== preview.sourceScheduleId || loaded.targetSchedule.id !== preview.targetScheduleId) throw new DomainError("STALE_CORRECTION_PREVIEW", "Correction targets changed", 409);
        const now = new Date(); const c = loaded.c;
        const reversal = (await tx.insert(transactions).values({ tenantId: ctx.tenantId, ownerUserId: loaded.source.ownerUserId, loanId: loaded.loan.id, scheduleId: loaded.sourceSchedule.id, amount: `-${loaded.amount}`, principalComponent: `-${c.principal}`, interestComponent: `-${c.interest}`, feeComponent: `-${c.fee}`, penaltyComponent: `-${c.penalty}`, type: "repayment", transactionDate: loaded.source.transactionDate, recordedByUserId: ctx.actorUserId, paymentIntakeId: loaded.intake.id, entryType: "reversal", reversedTransactionId: loaded.source.id, idempotencyKey: `payment-allocation-correction:${preview.publicId}:reversal`, postedAt: now }).returning())[0]!;
        const replacement = (await tx.insert(transactions).values({ tenantId: ctx.tenantId, ownerUserId: loaded.source.ownerUserId, loanId: loaded.loan.id, scheduleId: loaded.targetSchedule.id, amount: loaded.amount, principalComponent: c.principal, interestComponent: c.interest, feeComponent: c.fee, penaltyComponent: c.penalty, type: "repayment", transactionDate: loaded.source.transactionDate, recordedByUserId: ctx.actorUserId, paymentIntakeId: loaded.intake.id, entryType: "repayment", idempotencyKey: `payment-allocation-correction:${preview.publicId}:replacement`, postedAt: now }).returning())[0]!;
        const audit = await createAuditLog(tx, { tenantId: ctx.tenantId, actorUserId: ctx.actorUserId, actorSource: ctx.actorSource, requestId: ctx.requestId, correlationId: ctx.correlationId, entityType: "payment_allocation_correction", entityId: preview.publicId, action: "executed", payload: { correctionPreviewPublicId: preview.publicId, sourceTransactionPublicId: loaded.source.publicId, compensatingTransactionPublicId: reversal.publicId, replacementTransactionPublicId: replacement.publicId, reason: normalizedReason, netLoanVariance: { amount: "0.00", principal: "0.00", interest: "0.00", fee: "0.00", penalty: "0.00" } } });
        const group = (await tx.insert(paymentAllocationCorrectionGroups).values({ tenantId: ctx.tenantId, previewId: preview.id, paymentIntakeId: loaded.intake.id, sourceTransactionId: loaded.source.id, sourceScheduleId: loaded.sourceSchedule.id, targetScheduleId: loaded.targetSchedule.id, loanId: loaded.loan.id, reason: normalizedReason, idempotencyKey: key, correlationId: ctx.correlationId, auditPublicId: audit.publicId, createdByUserId: ctx.actorUserId }).returning())[0]!;
        await tx.insert(paymentAllocationCorrectionEntries).values([{ tenantId: ctx.tenantId, groupId: group.id, entryType: "reversal", sourceTransactionId: loaded.source.id, transactionId: reversal.id, loanId: loaded.loan.id, scheduleId: loaded.sourceSchedule.id, amount: reversal.amount, principalComponent: reversal.principalComponent, interestComponent: reversal.interestComponent, feeComponent: reversal.feeComponent, penaltyComponent: reversal.penaltyComponent, reason: normalizedReason, auditPublicId: audit.publicId, createdByUserId: ctx.actorUserId }, { tenantId: ctx.tenantId, groupId: group.id, entryType: "replacement", sourceTransactionId: loaded.source.id, transactionId: replacement.id, loanId: loaded.loan.id, scheduleId: loaded.targetSchedule.id, amount: replacement.amount, principalComponent: replacement.principalComponent, interestComponent: replacement.interestComponent, feeComponent: replacement.feeComponent, penaltyComponent: replacement.penaltyComponent, reason: normalizedReason, auditPublicId: audit.publicId, createdByUserId: ctx.actorUserId }]);
        for (const schedule of [loaded.sourceSchedule, loaded.targetSchedule]) { const rows = await tx.select().from(transactions).where(and(eq(transactions.tenantId, ctx.tenantId), eq(transactions.scheduleId, schedule.id))); let paid = zero(); let penalty = zero(); for (const row of rows) { paid = paid.plus(row.principalComponent).plus(row.interestComponent).plus(row.feeComponent); penalty = penalty.plus(row.penaltyComponent); } const remaining = FinancialDecimal.max(zero(), new FinancialDecimal(schedule.scheduledTotal).minus(paid)); const status = remaining.isZero() ? "paid" : paid.gt(0) || penalty.gt(0) ? "partial" : "pending"; await tx.update(loanSchedules).set({ paidTotal: signed(paid), paidPenalty: signed(penalty), remainingDue: signed(remaining), status, overdueDays: 0, updatedAt: now }).where(eq(loanSchedules.id, schedule.id)); }
        await refreshReplacementLoanEconomicRollup(tx, ctx.tenantId, loaded.loan.id);
        await tx.update(paymentAllocationCorrectionPreviews).set({ status: "executed", executedByUserId: ctx.actorUserId, executedAt: now }).where(and(eq(paymentAllocationCorrectionPreviews.tenantId, ctx.tenantId), eq(paymentAllocationCorrectionPreviews.id, preview.id)));
        return output(group, loaded.source, reversal, replacement, c, audit.publicId, loaded.intake.publicId, loaded.sourceSchedule.publicId, loaded.targetSchedule.publicId);
    });
}
