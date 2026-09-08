import { createHash } from "node:crypto";
import { and, eq, gt, inArray, or, sql } from "drizzle-orm";
import { db, type DbExecutor } from "../db";
import { auditLogs, loanAdjustments, loanSchedules, loanRenewals, loans, paymentAllocationCorrectionEntries, paymentAllocationCorrectionGroups, paymentAllocationCorrectionPreviews, paymentIntermediaryAttributions, paymentIntakes, paymentReconciliationEntries, paymentReconciliationGroups, transactions } from "../db/schema";
import { FinancialDecimal } from "../lib/financial-decimal";
import { createAuditLog } from "../lib/audit-log";
import type { CommandContext } from "./command-context";
import { DomainError } from "./domain-error";
import { refreshReplacementLoanEconomicRollup, scheduleLifecycle } from "./payment-service";

type Money = InstanceType<typeof FinancialDecimal>;
type Components = { principal: string; interest: string; fee: string; penalty: string };
type TransactionRow = typeof transactions.$inferSelect;
type ScheduleRow = typeof loanSchedules.$inferSelect;
type PreviewRow = typeof paymentAllocationCorrectionPreviews.$inferSelect;
type GroupRow = typeof paymentAllocationCorrectionGroups.$inferSelect;
const publicUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const money = (value: string | Money) => new FinancialDecimal(value).toDecimalPlaces(2).toFixed(2);
const signedMoney = (value: Money) => value.toDecimalPlaces(2).toFixed(2);
const decimal = (value: string) => new FinancialDecimal(value);

function requireId(value: string, field: string): void { if (!publicUuid.test(value)) throw new DomainError("INVALID_PUBLIC_ID", `${field} must be a UUID`, 400, { field }); }
function normalizedReason(value: string): string { const result = value.trim().replace(/\s+/g, " "); if (!result) throw new DomainError("INVALID_REASON", "reason must not be blank", 400); return result; }
function digest(value: unknown): string { return `v1:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
function executionRequestHash(input: ExecutePaymentAllocationCorrectionInput, reason: string): string {
    return digest({
        contract: "payment-allocation-correction-execute-v1",
        correctionPreviewPublicId: input.correctionPreviewPublicId,
        previewHash: input.previewHash,
        expectedBalanceVersion: input.expectedBalanceVersion,
        confirmed: input.confirmed,
        reason,
        idempotencyKey: input.idempotencyKey.trim(),
    });
}
function componentsOf(row: TransactionRow): Components { return { principal: money(row.principalComponent), interest: money(row.interestComponent), fee: money(row.feeComponent), penalty: money(row.penaltyComponent) }; }
function componentSum(c: Components): Money { return decimal(c.principal).plus(c.interest).plus(c.fee).plus(c.penalty); }

export interface PreviewPaymentAllocationCorrectionInput { paymentIntakePublicId: string; transactionPublicId: string; targetSchedulePublicId: string; reason: string; }
export interface CorrectionScheduleProjection { schedulePublicId: string; dueDate: string; before: { paidTotal: string; paidPenalty: string; remainingDue: string; status: string }; after: { paidTotal: string; paidPenalty: string; remainingDue: string; status: string }; }
export interface PaymentAllocationCorrectionPreview { publicId: string; status: "ready" | "blocked"; paymentIntakePublicId: string; transactionPublicId: string; loanPublicId: string; source: CorrectionScheduleProjection; target: CorrectionScheduleProjection; amount: string; components: Components; netLoanVariance: { amount: string; principal: string; interest: string; fee: string; penalty: string }; warnings: Array<{ code: string; blockerPublicIds?: string[] }>; previewHash: string; expectedBalanceVersion: string; expiresAt: string; }
export interface ExecutePaymentAllocationCorrectionInput { correctionPreviewPublicId: string; previewHash: string; expectedBalanceVersion: string; confirmed: true; reason: string; idempotencyKey: string; }
export interface ExecutedPaymentAllocationCorrection { correctionPublicId: string; paymentIntakePublicId: string; sourceTransactionPublicId: string; compensatingTransactionPublicId: string; replacementTransactionPublicId: string; sourceSchedulePublicId: string; targetSchedulePublicId: string; amount: string; components: Components; auditPublicId: string; correlationId: string; }

type OpeningAncestor = {
    adjustmentPublicId: string;
    adjustmentType: "principal_transfer" | "cash_payout";
    amount: string;
    status: string;
    renewalPublicId: string;
    renewalStatus: string;
    newLoanPublicId: string;
};
type DependencyClassification = { blockerIds: string[]; openingAncestors: OpeningAncestor[] };
interface Loaded { intake: typeof paymentIntakes.$inferSelect; source: TransactionRow; loan: typeof loans.$inferSelect; sourceSchedule: ScheduleRow; targetSchedule: ScheduleRow; components: Components; amount: string; reason: string; dependencies: DependencyClassification; }

async function dependencies(ctx: CommandContext, source: TransactionRow, sourceLoanPublicId: string, targetScheduleId: number, executor: DbExecutor): Promise<DependencyClassification> {
    const [attributions, reconciliationEntries, reconciliationGroups, adjustments, renewals] = await Promise.all([
        executor.select({ publicId: paymentIntermediaryAttributions.publicId }).from(paymentIntermediaryAttributions).where(and(eq(paymentIntermediaryAttributions.tenantId, ctx.tenantId), eq(paymentIntermediaryAttributions.paymentId, source.id), sql`${paymentIntermediaryAttributions.reversedAttributionId} IS NULL`)),
        executor.select({ publicId: paymentReconciliationEntries.publicId }).from(paymentReconciliationEntries).where(and(eq(paymentReconciliationEntries.tenantId, ctx.tenantId), eq(paymentReconciliationEntries.sourceTransactionId, source.id))),
        executor.select({ publicId: paymentReconciliationGroups.publicId }).from(paymentReconciliationGroups).where(and(eq(paymentReconciliationGroups.tenantId, ctx.tenantId), eq(paymentReconciliationGroups.paymentIntakeId, source.paymentIntakeId ?? -1))),
        executor.select({
            adjustmentPublicId: loanAdjustments.publicId,
            loanId: loanAdjustments.loanId,
            adjustmentType: loanAdjustments.adjustmentType,
            amount: loanAdjustments.amount,
            status: loanAdjustments.status,
            renewalId: loanAdjustments.renewalId,
            renewalPublicId: loanRenewals.publicId,
            renewalStatus: loanRenewals.status,
            renewalNewLoanId: loanRenewals.newLoanId,
            newLoanPublicId: loans.publicId,
        }).from(loanAdjustments)
            .leftJoin(loanRenewals, and(eq(loanRenewals.tenantId, ctx.tenantId), eq(loanRenewals.id, loanAdjustments.renewalId)))
            .leftJoin(loans, and(eq(loans.tenantId, ctx.tenantId), eq(loans.id, loanRenewals.newLoanId)))
            .where(and(eq(loanAdjustments.tenantId, ctx.tenantId), eq(loanAdjustments.loanId, source.loanId), eq(loanAdjustments.status, "posted"))),
        executor.select({ publicId: loanRenewals.publicId }).from(loanRenewals).where(and(eq(loanRenewals.tenantId, ctx.tenantId), eq(loanRenewals.oldLoanId, source.loanId), inArray(loanRenewals.status, ["executed", "preview"]))),
    ]);
    const laterRepayments = await executor.select({ id: transactions.id, publicId: transactions.publicId })
        .from(transactions)
        .where(and(
            eq(transactions.tenantId, ctx.tenantId),
            gt(transactions.id, source.id),
            eq(transactions.entryType, "repayment"),
            or(eq(transactions.scheduleId, source.scheduleId!), eq(transactions.scheduleId, targetScheduleId)),
        ))
        .orderBy(transactions.id);
    const activeLaterRepayments: string[] = [];
    for (const later of laterRepayments) {
        const reversal = await executor.query.transactions.findFirst({
            where: and(eq(transactions.tenantId, ctx.tenantId), eq(transactions.reversedTransactionId, later.id)),
        });
        if (!reversal) activeLaterRepayments.push(later.publicId);
    }
    const openingAncestors: OpeningAncestor[] = [];
    const adjustmentBlockers: string[] = [];
    const allowedOpeningTypes = new Set(["principal_transfer", "cash_payout"]);
    for (const adjustment of adjustments) {
        const isOpeningAncestor = adjustment.renewalId !== null
            && adjustment.renewalStatus === "executed"
            && adjustment.renewalNewLoanId === source.loanId
            && adjustment.loanId === source.loanId
            && adjustment.newLoanPublicId !== null
            && adjustment.newLoanPublicId === sourceLoanPublicId
            && adjustment.renewalPublicId !== null
            && allowedOpeningTypes.has(adjustment.adjustmentType);
        if (isOpeningAncestor) {
            openingAncestors.push({
                adjustmentPublicId: adjustment.adjustmentPublicId,
                adjustmentType: adjustment.adjustmentType as "principal_transfer" | "cash_payout",
                amount: money(adjustment.amount),
                status: adjustment.status,
                renewalPublicId: adjustment.renewalPublicId,
                renewalStatus: adjustment.renewalStatus,
                newLoanPublicId: adjustment.newLoanPublicId,
            });
        } else {
            adjustmentBlockers.push(adjustment.adjustmentPublicId);
        }
    }
    const blockerIds = [...attributions, ...reconciliationEntries, ...reconciliationGroups, ...renewals]
        .map((row) => row.publicId)
        .concat(adjustmentBlockers, activeLaterRepayments)
        .sort();
    openingAncestors.sort((a, b) => a.adjustmentPublicId.localeCompare(b.adjustmentPublicId));
    return { blockerIds, openingAncestors };
}

async function load(ctx: CommandContext, input: PreviewPaymentAllocationCorrectionInput, executor: DbExecutor, checkDependencies = true): Promise<Loaded> {
    requireId(input.paymentIntakePublicId, "paymentIntakePublicId"); requireId(input.transactionPublicId, "transactionPublicId"); requireId(input.targetSchedulePublicId, "targetSchedulePublicId");
    const reason = normalizedReason(input.reason);
    const intake = await executor.query.paymentIntakes.findFirst({ where: and(eq(paymentIntakes.tenantId, ctx.tenantId), eq(paymentIntakes.publicId, input.paymentIntakePublicId)) });
    if (!intake) throw new DomainError("PAYMENT_INTAKE_NOT_FOUND", "Payment intake not found", 404);
    if (intake.status !== "posted") throw new DomainError("PAYMENT_NOT_POSTED", "Payment intake must be posted", 409);
    const source = await executor.query.transactions.findFirst({ where: and(eq(transactions.tenantId, ctx.tenantId), eq(transactions.publicId, input.transactionPublicId)) });
    if (!source || source.paymentIntakeId !== intake.id) throw new DomainError("TRANSACTION_NOT_FOUND", "Payment transaction not found", 404);
    if (source.entryType !== "repayment" || source.type !== "repayment" || source.scheduleId === null || !decimal(source.amount).gt(0)) throw new DomainError("INVALID_CORRECTION_SOURCE", "Source must be a positive scheduled repayment", 409);
    const reversal = await executor.query.transactions.findFirst({ where: and(eq(transactions.tenantId, ctx.tenantId), eq(transactions.reversedTransactionId, source.id)) });
    if (reversal) throw new DomainError("SOURCE_ALREADY_REVERSED", "Source transaction is already reversed", 409);
    const loan = await executor.query.loans.findFirst({ where: and(eq(loans.tenantId, ctx.tenantId), eq(loans.id, source.loanId)) });
    if (!loan || loan.status !== "active") throw new DomainError("LOAN_NOT_ACTIVE", "Source loan is not active", 409);
    if (loan.repaymentType === "floating") throw new DomainError("FLOATING_CORRECTION_UNSUPPORTED", "Floating-loan allocation correction is not supported", 409);
    const sourceSchedule = await executor.query.loanSchedules.findFirst({ where: and(eq(loanSchedules.tenantId, ctx.tenantId), eq(loanSchedules.id, source.scheduleId)) });
    const targetSchedule = await executor.query.loanSchedules.findFirst({ where: and(eq(loanSchedules.tenantId, ctx.tenantId), eq(loanSchedules.publicId, input.targetSchedulePublicId)) });
    if (!sourceSchedule || !targetSchedule || sourceSchedule.loanId !== loan.id || targetSchedule.loanId !== loan.id) throw new DomainError("SCHEDULE_NOT_FOUND", "Schedule is not in the source loan", 409);
    if (sourceSchedule.id === targetSchedule.id) throw new DomainError("SAME_SCHEDULE", "Source and target schedules must differ", 409);
    const components = componentsOf(source); const amount = money(source.amount);
    if (!componentSum(components).eq(amount)) throw new DomainError("PAYMENT_COMPONENT_MISMATCH", "Source components do not conserve the amount", 409);
    if (decimal(targetSchedule.remainingDue).lt(amount)) throw new DomainError("TARGET_OVERPAYMENT", "Target schedule cannot accept the complete replacement", 409);
    const existing = await executor.query.paymentAllocationCorrectionGroups.findFirst({ where: and(eq(paymentAllocationCorrectionGroups.tenantId, ctx.tenantId), eq(paymentAllocationCorrectionGroups.sourceTransactionId, source.id)) });
    if (existing) throw new DomainError("CORRECTION_ALREADY_EXECUTED", "Source transaction already has a correction", 409);
    return { intake, source, loan, sourceSchedule, targetSchedule, components, amount, reason, dependencies: checkDependencies ? await dependencies(ctx, source, loan.publicId, targetSchedule.id, executor) : { blockerIds: [], openingAncestors: [] } };
}

function projection(schedule: ScheduleRow, paid: Money, penalty: Money, remaining: Money, lifecycle: { status: string }): CorrectionScheduleProjection { return { schedulePublicId: schedule.publicId, dueDate: schedule.dueDate, before: { paidTotal: money(schedule.paidTotal), paidPenalty: money(schedule.paidPenalty), remainingDue: money(schedule.remainingDue), status: schedule.status }, after: { paidTotal: money(paid), paidPenalty: money(penalty), remainingDue: money(remaining), status: lifecycle.status } }; }
function projectedState(schedule: ScheduleRow, loan: typeof loans.$inferSelect, components: Components, direction: "remove" | "add", asOf: Date): CorrectionScheduleProjection {
    const sign = direction === "remove" ? decimal("-1") : decimal("1");
    const paid = decimal(schedule.paidTotal).plus(decimal(components.principal).plus(components.interest).plus(components.fee).times(sign));
    const penalty = decimal(schedule.paidPenalty).plus(decimal(components.penalty).times(sign));
    const remaining = decimal(schedule.scheduledTotal).minus(paid);
    if (paid.lt(0) || penalty.lt(0) || remaining.lt(0)) throw new DomainError("CORRECTION_STATE_INVALID", "Correction would create an invalid schedule balance", 409);
    return projection(schedule, paid, penalty, remaining, scheduleLifecycle(loan, schedule, { paidTotal: paid, paidPenalty: penalty, remainingDue: remaining }, asOf));
}
function version(loaded: Loaded): string { return digest({ intake: { publicId: loaded.intake.publicId, status: loaded.intake.status, amount: loaded.intake.amount, receivedAt: loaded.intake.receivedAt.toISOString() }, source: { publicId: loaded.source.publicId, amount: loaded.source.amount, components: loaded.components, entryType: loaded.source.entryType, scheduleId: loaded.source.scheduleId, transactionDate: loaded.source.transactionDate?.toISOString() }, sourceSchedule: loaded.sourceSchedule, targetSchedule: loaded.targetSchedule, loan: { publicId: loaded.loan.publicId, status: loaded.loan.status, outstandingPrincipal: loaded.loan.outstandingPrincipal, outstandingInterest: loaded.loan.outstandingInterest, outstandingFees: loaded.loan.outstandingFees }, dependencies: loaded.dependencies }); }
function previewResult(row: PreviewRow, loaded: Loaded, source: CorrectionScheduleProjection, target: CorrectionScheduleProjection, warnings: Array<{ code: string; blockerPublicIds?: string[] }>): PaymentAllocationCorrectionPreview { return { publicId: row.publicId, status: warnings.length ? "blocked" : "ready", paymentIntakePublicId: loaded.intake.publicId, transactionPublicId: loaded.source.publicId, loanPublicId: loaded.loan.publicId, source, target, amount: loaded.amount, components: loaded.components, netLoanVariance: { amount: "0.00", principal: "0.00", interest: "0.00", fee: "0.00", penalty: "0.00" }, warnings, previewHash: row.previewHash, expectedBalanceVersion: row.expectedBalanceVersion, expiresAt: row.expiresAt.toISOString() }; }

export async function previewPaymentAllocationCorrection(ctx: CommandContext, input: PreviewPaymentAllocationCorrectionInput): Promise<PaymentAllocationCorrectionPreview> {
    const loaded = await load(ctx, input, db); const now = new Date();
    const source = projectedState(loaded.sourceSchedule, loaded.loan, loaded.components, "remove", now); const target = projectedState(loaded.targetSchedule, loaded.loan, loaded.components, "add", now);
    const warnings = loaded.dependencies.blockerIds.length ? [{ code: "PAYMENT_ALLOCATION_CORRECTION_DEPENDENCY", blockerPublicIds: loaded.dependencies.blockerIds }] : [];
    const expectedBalanceVersion = version(loaded); const previewHash = digest({ expectedBalanceVersion, reason: loaded.reason, targetSchedulePublicId: loaded.targetSchedule.publicId, source, target }); const expiresAt = new Date(now.getTime() + 15 * 60 * 1000);
    const row = (await db.insert(paymentAllocationCorrectionPreviews).values({ tenantId: ctx.tenantId, paymentIntakeId: loaded.intake.id, sourceTransactionId: loaded.source.id, sourceScheduleId: loaded.sourceSchedule.id, targetScheduleId: loaded.targetSchedule.id, loanId: loaded.loan.id, status: warnings.length ? "blocked" : "ready", amount: loaded.amount, principalComponent: loaded.components.principal, interestComponent: loaded.components.interest, feeComponent: loaded.components.fee, penaltyComponent: loaded.components.penalty, sourceSnapshot: { publicId: loaded.source.publicId, schedulePublicId: loaded.sourceSchedule.publicId, amount: loaded.amount, components: loaded.components }, targetSnapshot: { publicId: loaded.targetSchedule.publicId, dueDate: loaded.targetSchedule.dueDate }, proposedProjection: { source, target }, warnings, previewHash, expectedBalanceVersion, reason: loaded.reason, expiresAt, createdByUserId: ctx.actorUserId }).returning())[0]!;
    return previewResult(row, loaded, source, target, warnings);
}

function executionResult(group: GroupRow, source: TransactionRow, reversal: TransactionRow, replacement: TransactionRow, intake: typeof paymentIntakes.$inferSelect, sourceSchedule: ScheduleRow, targetSchedule: ScheduleRow, auditPublicId: string, components: Components): ExecutedPaymentAllocationCorrection { return { correctionPublicId: group.publicId, paymentIntakePublicId: intake.publicId, sourceTransactionPublicId: source.publicId, compensatingTransactionPublicId: reversal.publicId, replacementTransactionPublicId: replacement.publicId, sourceSchedulePublicId: sourceSchedule.publicId, targetSchedulePublicId: targetSchedule.publicId, amount: money(source.amount), components, auditPublicId, correlationId: group.correlationId }; }
async function rebuild(tx: DbExecutor, loan: typeof loans.$inferSelect, schedule: ScheduleRow, asOf: Date): Promise<void> {
    const rows = await tx.select().from(transactions).where(and(eq(transactions.tenantId, loan.tenantId), eq(transactions.scheduleId, schedule.id))).orderBy(transactions.id); let paid = decimal("0"); let penalty = decimal("0");
    for (const row of rows) { paid = paid.plus(row.principalComponent).plus(row.interestComponent).plus(row.feeComponent); penalty = penalty.plus(row.penaltyComponent); }
    const remaining = decimal(schedule.scheduledTotal).minus(paid); if (paid.lt(0) || penalty.lt(0) || remaining.lt(0)) throw new DomainError("CORRECTION_STATE_INVALID", "Canonical schedule rebuild produced an invalid balance", 409);
    const lifecycle = scheduleLifecycle(loan, schedule, { paidTotal: paid, paidPenalty: penalty, remainingDue: remaining }, asOf);
    await tx.update(loanSchedules).set({ paidTotal: signedMoney(paid), paidPenalty: signedMoney(penalty), remainingDue: signedMoney(remaining), overdueDays: lifecycle.overdueDays, status: lifecycle.status, updatedAt: asOf }).where(and(eq(loanSchedules.tenantId, loan.tenantId), eq(loanSchedules.id, schedule.id)));
}

export async function executePaymentAllocationCorrection(ctx: CommandContext, input: ExecutePaymentAllocationCorrectionInput): Promise<ExecutedPaymentAllocationCorrection> {
    requireId(input.correctionPreviewPublicId, "correctionPreviewPublicId");
    if (!input.confirmed) throw new DomainError("CONFIRMATION_REQUIRED", "confirmed must be true", 400);
    const reason = normalizedReason(input.reason);
    const idempotencyKey = input.idempotencyKey.trim();
    if (!idempotencyKey) throw new DomainError("INVALID_IDEMPOTENCY_KEY", "idempotencyKey must not be blank", 400);
    const requestHash = executionRequestHash(input, reason);
    return db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`payment-allocation-correction:${ctx.tenantId}:${idempotencyKey}`}, 0))`);
        const existing = await tx.query.paymentAllocationCorrectionGroups.findFirst({ where: and(eq(paymentAllocationCorrectionGroups.tenantId, ctx.tenantId), eq(paymentAllocationCorrectionGroups.idempotencyKey, idempotencyKey)) });
        if (existing) {
            if (existing.requestHash !== requestHash) throw new DomainError("IDEMPOTENCY_CONFLICT", "Idempotency key was used with a different correction", 409);
            const entries = await tx.select().from(paymentAllocationCorrectionEntries).where(and(eq(paymentAllocationCorrectionEntries.tenantId, ctx.tenantId), eq(paymentAllocationCorrectionEntries.groupId, existing.id))).orderBy(paymentAllocationCorrectionEntries.id); const ids = entries.map((entry) => entry.transactionId); const rows = ids.length ? await tx.select().from(transactions).where(and(eq(transactions.tenantId, ctx.tenantId), inArray(transactions.id, ids))).orderBy(transactions.id) : [];
            const source = await tx.query.transactions.findFirst({ where: and(eq(transactions.tenantId, ctx.tenantId), eq(transactions.id, existing.sourceTransactionId)) }); const intake = await tx.query.paymentIntakes.findFirst({ where: and(eq(paymentIntakes.tenantId, ctx.tenantId), eq(paymentIntakes.id, existing.paymentIntakeId)) }); const sourceSchedule = await tx.query.loanSchedules.findFirst({ where: and(eq(loanSchedules.tenantId, ctx.tenantId), eq(loanSchedules.id, existing.sourceScheduleId)) }); const targetSchedule = await tx.query.loanSchedules.findFirst({ where: and(eq(loanSchedules.tenantId, ctx.tenantId), eq(loanSchedules.id, existing.targetScheduleId)) }); const reversal = rows.find((row) => row.entryType === "reversal"); const replacement = rows.find((row) => row.entryType === "repayment");
            if (!source || !intake || !sourceSchedule || !targetSchedule || !reversal || !replacement || entries.length !== 2) throw new DomainError("CORRECTION_CORRUPT", "Correction history is incomplete", 409);
            return executionResult(existing, source, reversal, replacement, intake, sourceSchedule, targetSchedule, existing.auditPublicId, componentsOf(source));
        }
        await tx.execute(sql`SELECT id FROM payment_allocation_correction_previews WHERE tenant_id = ${ctx.tenantId} AND public_id = ${input.correctionPreviewPublicId} FOR UPDATE`);
        const preview = await tx.query.paymentAllocationCorrectionPreviews.findFirst({ where: and(eq(paymentAllocationCorrectionPreviews.tenantId, ctx.tenantId), eq(paymentAllocationCorrectionPreviews.publicId, input.correctionPreviewPublicId)) }); if (!preview || preview.status !== "ready") throw new DomainError("PREVIEW_NOT_EXECUTABLE", "Correction preview is not executable", 409); if (preview.previewHash !== input.previewHash || preview.expectedBalanceVersion !== input.expectedBalanceVersion || preview.reason !== reason) throw new DomainError("STALE_CORRECTION_PREVIEW", "Correction preview guards no longer match", 409); if (preview.expiresAt.getTime() <= Date.now()) throw new DomainError("EXPIRED_CORRECTION_PREVIEW", "Correction preview has expired", 409);
        await tx.execute(sql`SELECT id FROM payment_allocation_correction_groups WHERE tenant_id = ${ctx.tenantId} AND (idempotency_key = ${idempotencyKey} OR source_transaction_id = ${preview.sourceTransactionId}) ORDER BY id FOR UPDATE`);
        await tx.execute(sql`SELECT id FROM payment_intakes WHERE tenant_id = ${ctx.tenantId} AND id = ${preview.paymentIntakeId} FOR UPDATE`);
        const intake = await tx.query.paymentIntakes.findFirst({ where: and(eq(paymentIntakes.tenantId, ctx.tenantId), eq(paymentIntakes.id, preview.paymentIntakeId)) });
        const source = await tx.query.transactions.findFirst({ where: and(eq(transactions.tenantId, ctx.tenantId), eq(transactions.id, preview.sourceTransactionId)) });
        if (!intake || !source) throw new DomainError("STALE_CORRECTION_PREVIEW", "Correction source no longer exists", 409);
        await tx.execute(sql`SELECT id FROM loans WHERE tenant_id = ${ctx.tenantId} AND id = ${preview.loanId} FOR UPDATE`);
        const firstSchedule = Math.min(preview.sourceScheduleId, preview.targetScheduleId);
        const lastSchedule = Math.max(preview.sourceScheduleId, preview.targetScheduleId);
        await tx.execute(sql`SELECT id FROM loan_schedules WHERE tenant_id = ${ctx.tenantId} AND id IN (${firstSchedule}, ${lastSchedule}) ORDER BY id FOR UPDATE`);
        await tx.execute(sql`SELECT id FROM transactions WHERE tenant_id = ${ctx.tenantId} AND schedule_id IN (${firstSchedule}, ${lastSchedule}) ORDER BY id FOR UPDATE`);
        const target = await tx.query.loanSchedules.findFirst({ where: and(eq(loanSchedules.tenantId, ctx.tenantId), eq(loanSchedules.id, preview.targetScheduleId)) }); if (!target) throw new DomainError("STALE_CORRECTION_PREVIEW", "Correction target no longer exists", 409); const loaded = await load(ctx, { paymentIntakePublicId: intake.publicId, transactionPublicId: source.publicId, targetSchedulePublicId: target.publicId, reason }, tx); if (version(loaded) !== preview.expectedBalanceVersion) throw new DomainError("STALE_CORRECTION_PREVIEW", "Correction balance changed since preview", 409); if (loaded.dependencies.blockerIds.length) throw new DomainError("PAYMENT_ALLOCATION_CORRECTION_DEPENDENCY", "Correction has downstream dependencies", 409, { blockerPublicIds: loaded.dependencies.blockerIds });
        const now = new Date(); const c = loaded.components; const reversal = (await tx.insert(transactions).values({ tenantId: ctx.tenantId, ownerUserId: loaded.source.ownerUserId, loanId: loaded.loan.id, scheduleId: loaded.sourceSchedule.id, amount: `-${loaded.amount}`, principalComponent: `-${c.principal}`, interestComponent: `-${c.interest}`, feeComponent: `-${c.fee}`, penaltyComponent: `-${c.penalty}`, type: "reversal", transactionDate: loaded.source.transactionDate, recordedByUserId: ctx.actorUserId, paymentIntakeId: loaded.intake.id, entryType: "reversal", reversedTransactionId: loaded.source.id, idempotencyKey: `payment-allocation-correction:${preview.publicId}:reversal`, postedAt: now }).returning())[0]!;
        const replacement = (await tx.insert(transactions).values({ tenantId: ctx.tenantId, ownerUserId: loaded.source.ownerUserId, loanId: loaded.loan.id, scheduleId: loaded.targetSchedule.id, amount: loaded.amount, principalComponent: c.principal, interestComponent: c.interest, feeComponent: c.fee, penaltyComponent: c.penalty, type: "repayment", transactionDate: loaded.source.transactionDate, recordedByUserId: ctx.actorUserId, paymentIntakeId: loaded.intake.id, entryType: "repayment", idempotencyKey: `payment-allocation-correction:${preview.publicId}:replacement`, postedAt: now }).returning())[0]!;
        const audit = await createAuditLog(tx, { tenantId: ctx.tenantId, actorUserId: ctx.actorUserId, actorSource: ctx.actorSource, requestId: ctx.requestId, correlationId: ctx.correlationId, entityType: "payment_allocation_correction", entityId: preview.publicId, action: "executed", payload: { correctionPreviewPublicId: preview.publicId, sourceTransactionPublicId: source.publicId, compensatingTransactionPublicId: reversal.publicId, replacementTransactionPublicId: replacement.publicId, reason, netLoanVariance: { amount: "0.00", principal: "0.00", interest: "0.00", fee: "0.00", penalty: "0.00" } } });
        const group = (await tx.insert(paymentAllocationCorrectionGroups).values({ tenantId: ctx.tenantId, previewId: preview.id, paymentIntakeId: loaded.intake.id, sourceTransactionId: loaded.source.id, sourceScheduleId: loaded.sourceSchedule.id, targetScheduleId: loaded.targetSchedule.id, loanId: loaded.loan.id, reason, idempotencyKey, requestHash, correlationId: ctx.correlationId, auditPublicId: audit.publicId, createdByUserId: ctx.actorUserId }).returning())[0]!;
        await tx.insert(paymentAllocationCorrectionEntries).values([{ tenantId: ctx.tenantId, groupId: group.id, entryType: "reversal", sourceTransactionId: loaded.source.id, transactionId: reversal.id, loanId: loaded.loan.id, scheduleId: loaded.sourceSchedule.id, amount: reversal.amount, principalComponent: reversal.principalComponent, interestComponent: reversal.interestComponent, feeComponent: reversal.feeComponent, penaltyComponent: reversal.penaltyComponent, reason, auditPublicId: audit.publicId, createdByUserId: ctx.actorUserId }, { tenantId: ctx.tenantId, groupId: group.id, entryType: "replacement", sourceTransactionId: loaded.source.id, transactionId: replacement.id, loanId: loaded.loan.id, scheduleId: loaded.targetSchedule.id, amount: replacement.amount, principalComponent: replacement.principalComponent, interestComponent: replacement.interestComponent, feeComponent: replacement.feeComponent, penaltyComponent: replacement.penaltyComponent, reason, auditPublicId: audit.publicId, createdByUserId: ctx.actorUserId }]);
        await rebuild(tx, loaded.loan, loaded.sourceSchedule, now); await rebuild(tx, loaded.loan, loaded.targetSchedule, now); await refreshReplacementLoanEconomicRollup(tx, ctx.tenantId, loaded.loan.id); await tx.update(paymentAllocationCorrectionPreviews).set({ status: "executed", executedByUserId: ctx.actorUserId, executedAt: now }).where(and(eq(paymentAllocationCorrectionPreviews.tenantId, ctx.tenantId), eq(paymentAllocationCorrectionPreviews.id, preview.id)));
        return executionResult(group, loaded.source, reversal, replacement, loaded.intake, loaded.sourceSchedule, loaded.targetSchedule, audit.publicId, loaded.components);
    });
}
