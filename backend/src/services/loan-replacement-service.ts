import { createHash } from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "../db";
import {
    auditLogs, bankLoans, loanDisbursementEvents, loanFundingAllocations, loanRenewals,
    loanReplacementCorrections, loanReplacements, loanRestructures, loanSchedules, loans, transactions, users,
} from "../db/schema";
import { canAccessTenantWideData } from "../lib/access";
import { createAuditLog } from "../lib/audit-log";
import { FinancialDecimal } from "../lib/financial-decimal";
import { serializeMoney } from "../lib/money";
import type { CommandContext } from "./command-context";
import { DomainError } from "./domain-error";
import { activateLoanInTransaction } from "./loan-application-service";

type Executor = any;
type Loan = typeof loans.$inferSelect;
type Replacement = typeof loanReplacements.$inferSelect;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const versionPattern = /^v1:[0-9a-f]{64}$/i;
const previewTtlMs = 15 * 60 * 1000;

export interface LoanReplacementPreview {
    publicId: string; previewHash: string; oldBalanceVersion: string; replacementDraftVersion: string; expiresAt: Date;
    cash: { direction: "none"; amount: string };
    correction: { principal: string; interest: string; fee: string; penalty: string };
    replacement: { loanPublicId: string; startDate: string | null; firstDueDate: string | null; lastDueDate: string | null; totalRepayment: string; fundingSourcePublicId: string | null };
    warnings: string[]; auditPublicId: string; correlationId: string;
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
function sha(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
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
function signedMoney(value: any) { return new FinancialDecimal(value).toFixed(2); }
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
async function state(executor: Executor, ctx: CommandContext, oldLoan: Loan, draft: Loan) {
    const [oldSchedules, draftSchedules, oldTransactions, oldDisbursements, oldAllocations, draftAllocations, priorOld, priorDraft] = await Promise.all([
        executor.select().from(loanSchedules).where(and(eq(loanSchedules.tenantId, ctx.tenantId), eq(loanSchedules.loanId, oldLoan.id))).orderBy(asc(loanSchedules.installmentNo)),
        executor.select().from(loanSchedules).where(and(eq(loanSchedules.tenantId, ctx.tenantId), eq(loanSchedules.loanId, draft.id))).orderBy(asc(loanSchedules.installmentNo)),
        executor.select().from(transactions).where(and(eq(transactions.tenantId, ctx.tenantId), eq(transactions.loanId, oldLoan.id))).orderBy(asc(transactions.id)),
        executor.select().from(loanDisbursementEvents).where(and(eq(loanDisbursementEvents.tenantId, ctx.tenantId), eq(loanDisbursementEvents.loanId, oldLoan.id))).orderBy(asc(loanDisbursementEvents.id)),
        executor.select().from(loanFundingAllocations).where(and(eq(loanFundingAllocations.tenantId, ctx.tenantId), eq(loanFundingAllocations.loanId, oldLoan.id))).orderBy(asc(loanFundingAllocations.id)),
        executor.select().from(loanFundingAllocations).where(and(eq(loanFundingAllocations.tenantId, ctx.tenantId), eq(loanFundingAllocations.loanId, draft.id))).orderBy(asc(loanFundingAllocations.id)),
        executor.select().from(loanReplacements).where(and(eq(loanReplacements.tenantId, ctx.tenantId), eq(loanReplacements.oldLoanId, oldLoan.id), eq(loanReplacements.status, "executed"))).limit(1),
        executor.select().from(loanReplacements).where(and(eq(loanReplacements.tenantId, ctx.tenantId), eq(loanReplacements.replacementLoanId, draft.id), eq(loanReplacements.status, "executed"))).limit(1),
    ]);
    const oldBalanceVersion = version({ loan: [oldLoan.publicId, oldLoan.status, oldLoan.outstandingPrincipal, oldLoan.outstandingInterest, oldLoan.outstandingFees, oldLoan.nextDueDate, oldLoan.updatedAt?.toISOString()], schedules: oldSchedules.map((row: any) => [row.publicId, row.status, row.remainingDue, row.paidTotal, row.paidPenalty]), transactions: oldTransactions.map((row: any) => [row.publicId, row.entryType, row.reversedTransactionId, row.amount]), disbursements: oldDisbursements.map((row: any) => [row.publicId, row.status, row.reversedEventId, row.loanAttributedAmount]) });
    const replacementDraftVersion = version({ loan: [draft.publicId, draft.status, draft.principalAmount, draft.repaymentType, draft.startDate, draft.totalInstallments, draft.installmentAmount, draft.bankLoanId, draft.fundingBankProfileId, draft.updatedAt?.toISOString()], schedules: draftSchedules.map((row: any) => [row.publicId, row.status]), allocations: draftAllocations.map((row: any) => [row.publicId, row.allocatedAmount, row.bankLoanId, row.bankProfileId]) });
    return { oldSchedules, draftSchedules, oldTransactions, oldDisbursements, oldAllocations, draftAllocations, priorOld: priorOld[0], priorDraft: priorDraft[0], oldBalanceVersion, replacementDraftVersion };
}
async function validate(ctx: CommandContext, executor: Executor, oldLoan: Loan, draft: Loan, current?: Awaited<ReturnType<typeof state>>) {
    current ??= await state(executor, ctx, oldLoan, draft);
    if (oldLoan.status !== "active") reviewRequired("OLD_LOAN_NOT_REPLACEABLE", "Only an active loan can be replaced", [oldLoan.publicId]);
    if (draft.status !== "draft") reviewRequired("REPLACEMENT_DRAFT_NOT_AVAILABLE", "Replacement loan must still be a draft", [draft.publicId]);
    if (!["daily", "weekly", "monthly"].includes(oldLoan.repaymentType) || !["daily", "weekly", "monthly"].includes(draft.repaymentType)) reviewRequired("REPLACEMENT_TYPE_UNSUPPORTED", "Only scheduled loans can be replaced", [oldLoan.publicId, draft.publicId]);
    if (oldLoan.borrowerId !== draft.borrowerId || oldLoan.ownerUserId !== draft.ownerUserId) reviewRequired("REPLACEMENT_SCOPE_MISMATCH", "Replacement loans must have the same borrower and owner", [oldLoan.publicId, draft.publicId]);
    if (current.priorOld || current.priorDraft) reviewRequired("REPLACEMENT_ALREADY_EXECUTED", "A loan already has an executed replacement", [current.priorOld?.publicId ?? current.priorDraft!.publicId]);
    const postedPayments = activeRows(current.oldTransactions).filter(row => row.entryType === "repayment");
    const postedDisbursements = activeRows(current.oldDisbursements).filter(row => row.status === "posted");
    if (postedPayments.length || postedDisbursements.length) reviewRequired("REPLACEMENT_DOWNSTREAM_ACTIVITY", "Posted payment or effective disbursement requires human review", [...postedPayments, ...postedDisbursements].flatMap(row => row.publicId ? [row.publicId] : []));
    const [renewal, restructure] = await Promise.all([
        executor.select({ publicId: loanRenewals.publicId }).from(loanRenewals).where(and(eq(loanRenewals.tenantId, ctx.tenantId), eq(loanRenewals.oldLoanId, oldLoan.id), eq(loanRenewals.status, "executed"))).limit(1),
        executor.select({ publicId: loanRestructures.publicId }).from(loanRestructures).where(and(eq(loanRestructures.tenantId, ctx.tenantId), eq(loanRestructures.oldLoanId, oldLoan.id), eq(loanRestructures.status, "executed"))).limit(1),
    ]);
    if (renewal[0] || restructure[0]) reviewRequired("REPLACEMENT_DEPENDENT_WORKFLOW", "An executed dependent workflow requires human review", [renewal[0]?.publicId ?? restructure[0]!.publicId]);
    if (!draft.bankLoanId && !draft.fundingBankProfileId) reviewRequired("REPLACEMENT_FUNDING_MISSING", "Replacement draft has no funding source", [draft.publicId]);
    if (draft.bankLoanId) {
        const source = await executor.query.bankLoans.findFirst({ where: and(eq(bankLoans.tenantId, ctx.tenantId), eq(bankLoans.id, draft.bankLoanId)) });
        if (!source || source.status !== "active") reviewRequired("REPLACEMENT_FUNDING_INVALID", "Replacement funding drawdown is not active", [source?.publicId ?? draft.publicId]);
        const allocated = await executor.select({ total: sql<string>`coalesce(sum(${loanFundingAllocations.allocatedAmount}), 0)` }).from(loanFundingAllocations).where(and(eq(loanFundingAllocations.tenantId, ctx.tenantId), eq(loanFundingAllocations.bankLoanId, source.id))).then((rows: any[]) => new FinancialDecimal(rows[0]?.total ?? "0"));
        const already = current.draftAllocations.reduce((total: any, row: any) => total.plus(row.allocatedAmount), new FinancialDecimal(0));
        const needed = FinancialDecimal.max(new FinancialDecimal(0), new FinancialDecimal(draft.principalAmount).minus(already));
        if (needed.gt(new FinancialDecimal(source.amount).minus(allocated))) reviewRequired("REPLACEMENT_FUNDING_INSUFFICIENT", "Replacement funding capacity is insufficient", [source.publicId]);
    }
    return current;
}
function correction(oldLoan: Loan, schedules: Array<typeof loanSchedules.$inferSelect>) {
    const penalty = schedules.reduce((total, row) => total.plus(new FinancialDecimal(row.paidPenalty ?? "0").minus(row.paidTotal ?? "0").abs()), new FinancialDecimal(0));
    return { principal: new FinancialDecimal(oldLoan.outstandingPrincipal ?? "0"), interest: new FinancialDecimal(oldLoan.outstandingInterest ?? "0"), fee: new FinancialDecimal(oldLoan.outstandingFees ?? "0"), penalty };
}
function previewHash(oldLoan: Loan, draft: Loan, current: Awaited<ReturnType<typeof state>>, why: string) {
    return version({ contract: "atomic-loan-replacement", oldLoanPublicId: oldLoan.publicId, replacementDraftPublicId: draft.publicId, reason: why, oldBalanceVersion: current.oldBalanceVersion, replacementDraftVersion: current.replacementDraftVersion });
}
async function presentPreview(executor: Executor, ctx: CommandContext, row: Replacement, oldLoan: Loan, draft: Loan, current: Awaited<ReturnType<typeof state>>, auditPublicId: string): Promise<LoanReplacementPreview> {
    const calculated = correction(oldLoan, current.oldSchedules);
    const schedule = current.draftSchedules;
    const generated = schedule.length ? schedule : [];
    const totalRepayment = generated.reduce((total: any, item: any) => total.plus(item.scheduledTotal), new FinancialDecimal(0));
    const source = draft.bankLoanId ? await executor.query.bankLoans.findFirst({ where: and(eq(bankLoans.tenantId, ctx.tenantId), eq(bankLoans.id, draft.bankLoanId)) }) : null;
    return { publicId: row.publicId, previewHash: row.previewHash, oldBalanceVersion: row.oldBalanceVersion, replacementDraftVersion: row.replacementDraftVersion, expiresAt: row.expiresAt, cash: { direction: "none", amount: "0.00" }, correction: { principal: serializeMoney(calculated.principal), interest: serializeMoney(calculated.interest), fee: serializeMoney(calculated.fee), penalty: serializeMoney(calculated.penalty) }, replacement: { loanPublicId: draft.publicId, startDate: draft.startDate, firstDueDate: generated[0]?.dueDate ?? nextDueDateFromTerms(draft), lastDueDate: generated.at(-1)?.dueDate ?? null, totalRepayment: serializeMoney(totalRepayment), fundingSourcePublicId: source?.publicId ?? null }, warnings: calculated.interest.gt(0) ? ["Calculated interest is corrected and is not collected or carried forward."] : [], auditPublicId, correlationId: ctx.correlationId };
}
function nextDueDateFromTerms(loan: Loan) {
    if (!loan.startDate) return null;
    const date = new Date(`${loan.startDate}T00:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() + (loan.repaymentType === "weekly" ? 7 : loan.repaymentType === "monthly" ? 30 : 1));
    return date.toISOString().slice(0, 10);
}

export async function previewLoanReplacement(ctx: CommandContext, input: { oldLoanPublicId: string; replacementDraftPublicId: string; reason: string }): Promise<LoanReplacementPreview> {
    await admin(ctx);
    const oldLoanPublicId = publicId(input.oldLoanPublicId, "oldLoanPublicId");
    const replacementDraftPublicId = publicId(input.replacementDraftPublicId, "replacementDraftPublicId");
    const why = reason(input.reason);
    return db.transaction(async tx => {
        const [oldLoan, draft] = await Promise.all([loanFor(ctx, tx, oldLoanPublicId), loanFor(ctx, tx, replacementDraftPublicId)]);
        const current = await validate(ctx, tx, oldLoan, draft);
        const hash = previewHash(oldLoan, draft, current, why);
        const row = await tx.insert(loanReplacements).values({ tenantId: ctx.tenantId, oldLoanId: oldLoan.id, replacementLoanId: draft.id, status: "preview", reason: why, oldBalanceVersion: current.oldBalanceVersion, replacementDraftVersion: current.replacementDraftVersion, previewHash: hash, requestHash: sha({ oldLoanPublicId, replacementDraftPublicId, why }), expiresAt: new Date(Date.now() + previewTtlMs), createdByUserId: ctx.actorUserId }).returning().then((rows: Replacement[]) => rows[0]!);
        const audit = await createAuditLog(tx, { ...auditContext(ctx), entityType: "loan_replacement", entityId: row.publicId, action: "previewed", payload: { oldLoanPublicId, replacementDraftPublicId, oldBalanceVersion: row.oldBalanceVersion, replacementDraftVersion: row.replacementDraftVersion, previewHash: row.previewHash, cash: { direction: "none", amount: "0.00" } } });
        return presentPreview(tx, ctx, row, oldLoan, draft, current, audit.publicId);
    });
}

async function replacementFor(ctx: CommandContext, executor: Executor, value: string) {
    publicId(value, "replacementPublicId");
    const row = await executor.query.loanReplacements.findFirst({ where: and(eq(loanReplacements.tenantId, ctx.tenantId), eq(loanReplacements.publicId, value)) });
    if (!row) throw new DomainError("LOAN_REPLACEMENT_NOT_FOUND", "Loan replacement was not found", 404);
    return row as Replacement;
}
function executionHash(input: { replacementPublicId: string; previewHash: string; expectedOldBalanceVersion: string; expectedReplacementDraftVersion: string; reason: string; confirmed: true }) { return sha(input); }

export async function executeLoanReplacement(ctx: CommandContext, input: { replacementPublicId: string; previewHash: string; expectedOldBalanceVersion: string; expectedReplacementDraftVersion: string; reason: string; confirmed: true }): Promise<LoanReplacementExecution> {
    await admin(ctx);
    const key = idempotencyKey(ctx); const why = reason(input.reason); publicId(input.replacementPublicId, "replacementPublicId");
    if (!input.confirmed) throw new DomainError("REPLACEMENT_CONFIRMATION_REQUIRED", "Explicit replacement confirmation is required", 400);
    if (!versionPattern.test(input.previewHash) || !versionPattern.test(input.expectedOldBalanceVersion) || !versionPattern.test(input.expectedReplacementDraftVersion)) throw new DomainError("INVALID_REPLACEMENT_VERSION", "Replacement fingerprints are invalid", 400);
    const requestHash = executionHash({ ...input, reason: why });
    return db.transaction(async tx => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`loan-replacement:${ctx.tenantId}:${input.replacementPublicId}`}, 0))`);
        const record = await replacementFor(ctx, tx, input.replacementPublicId);
        await tx.execute(sql`SELECT id FROM loan_replacements WHERE tenant_id = ${ctx.tenantId} AND id = ${record.id} FOR UPDATE`);
        if (record.status === "executed") {
            const stored = (record.preExecutionSnapshot as Record<string, unknown> | null)?.execution as Record<string, unknown> | undefined;
            if (record.executeIdempotencyKey !== key || stored?.requestHash !== requestHash) throw new DomainError("IDEMPOTENCY_CONFLICT", "Idempotency key was used with a different request", 409);
            const audit = await tx.query.auditLogs.findFirst({ where: and(eq(auditLogs.tenantId, ctx.tenantId), eq(auditLogs.entityId, record.publicId), eq(auditLogs.action, "executed")) });
            const oldLoan = await tx.query.loans.findFirst({ where: and(eq(loans.tenantId, ctx.tenantId), eq(loans.id, record.oldLoanId)) });
            const draft = await tx.query.loans.findFirst({ where: and(eq(loans.tenantId, ctx.tenantId), eq(loans.id, record.replacementLoanId)) });
            return { replacementPublicId: record.publicId, oldLoanPublicId: oldLoan!.publicId, replacementLoanPublicId: draft!.publicId, status: "executed", auditPublicId: audit?.publicId ?? "", correlationId: ctx.correlationId };
        }
        if (record.status !== "preview" || record.expiresAt.getTime() <= Date.now()) reviewRequired("REPLACEMENT_PREVIEW_EXPIRED", "Replacement preview is expired or unavailable", [record.publicId]);
        if (record.previewHash !== input.previewHash || record.oldBalanceVersion !== input.expectedOldBalanceVersion || record.replacementDraftVersion !== input.expectedReplacementDraftVersion || record.reason !== why) reviewRequired("REPLACEMENT_PREVIEW_STALE", "Replacement preview does not match the confirmed request", [record.publicId]);
        const [oldLoan, draft] = await Promise.all([loanFor(ctx, tx, (await tx.query.loans.findFirst({ where: and(eq(loans.tenantId, ctx.tenantId), eq(loans.id, record.oldLoanId)) }))!.publicId), loanFor(ctx, tx, (await tx.query.loans.findFirst({ where: and(eq(loans.tenantId, ctx.tenantId), eq(loans.id, record.replacementLoanId)) }))!.publicId)]);
        for (const loanId of [oldLoan.id, draft.id].sort((a, b) => a - b)) await tx.execute(sql`SELECT id FROM loans WHERE tenant_id = ${ctx.tenantId} AND id = ${loanId} FOR UPDATE`);
        if (draft.bankLoanId) await tx.execute(sql`SELECT id FROM bank_loans WHERE tenant_id = ${ctx.tenantId} AND id = ${draft.bankLoanId} FOR UPDATE`);
        const current = await validate(ctx, tx, oldLoan, draft);
        if (current.oldBalanceVersion !== record.oldBalanceVersion || current.replacementDraftVersion !== record.replacementDraftVersion) reviewRequired("REPLACEMENT_PREVIEW_STALE", "Replacement balances or funding changed after preview", [oldLoan.publicId, draft.publicId]);
        const oldSnapshot = { loan: { status: oldLoan.status, outstandingPrincipal: oldLoan.outstandingPrincipal, outstandingInterest: oldLoan.outstandingInterest, outstandingFees: oldLoan.outstandingFees, nextDueDate: oldLoan.nextDueDate }, schedules: current.oldSchedules.map((row: any) => ({ id: row.id, status: row.status, remainingDue: row.remainingDue, paidTotal: row.paidTotal, paidPenalty: row.paidPenalty })) };
        const activated = await activateLoanInTransaction(tx, { ...ctx, idempotencyKey: `replacement:${record.publicId}` }, draft, { replacementId: record.id });
        const corrected = correction(oldLoan, current.oldSchedules);
        await tx.insert(loanReplacementCorrections).values({ tenantId: ctx.tenantId, replacementId: record.id, loanId: oldLoan.id, status: "posted", principal: serializeMoney(corrected.principal), interest: serializeMoney(corrected.interest), fee: serializeMoney(corrected.fee), penalty: serializeMoney(corrected.penalty), reason: why, createdByUserId: ctx.actorUserId });
        await tx.update(loanSchedules).set({ status: "cancelled", remainingDue: "0.00" }).where(and(eq(loanSchedules.tenantId, ctx.tenantId), eq(loanSchedules.loanId, oldLoan.id)));
        await tx.update(loans).set({ status: "replaced", outstandingPrincipal: "0.00", outstandingInterest: "0.00", outstandingFees: "0.00", nextDueDate: null, updatedAt: new Date() }).where(and(eq(loans.tenantId, ctx.tenantId), eq(loans.id, oldLoan.id), eq(loans.status, "active")));
        const audit = await createAuditLog(tx, { ...auditContext(ctx), entityType: "loan_replacement", entityId: record.publicId, action: "executed", payload: { before: { oldLoan: oldSnapshot, replacementDraftStatus: "draft" }, after: { oldLoan: { status: "replaced", outstandingPrincipal: "0.00", outstandingInterest: "0.00", outstandingFees: "0.00", nextDueDate: null }, replacementLoan: activated }, cash: { direction: "none", amount: "0.00" }, reason: why, requestHash, idempotencyKey: key } });
        await tx.update(loanReplacements).set({ status: "executed", executeIdempotencyKey: key, executedByUserId: ctx.actorUserId, preExecutionSnapshot: { old: oldSnapshot, execution: { requestHash, auditPublicId: audit.publicId } }, updatedAt: new Date() }).where(and(eq(loanReplacements.tenantId, ctx.tenantId), eq(loanReplacements.id, record.id), eq(loanReplacements.status, "preview")));
        return { replacementPublicId: record.publicId, oldLoanPublicId: oldLoan.publicId, replacementLoanPublicId: draft.publicId, status: "executed", auditPublicId: audit.publicId, correlationId: ctx.correlationId };
    });
}

export async function reverseLoanReplacement(ctx: CommandContext, input: { replacementPublicId: string; reason: string }): Promise<LoanReplacementReversal> {
    await admin(ctx); const key = idempotencyKey(ctx); const why = reason(input.reason, "REPLACEMENT_REVERSAL_REASON_REQUIRED"); publicId(input.replacementPublicId, "replacementPublicId");
    return db.transaction(async tx => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`loan-replacement:${ctx.tenantId}:${input.replacementPublicId}`}, 0))`);
        const record = await replacementFor(ctx, tx, input.replacementPublicId);
        await tx.execute(sql`SELECT id FROM loan_replacements WHERE tenant_id = ${ctx.tenantId} AND id = ${record.id} FOR UPDATE`);
        const [oldLoan, draft] = await Promise.all([tx.query.loans.findFirst({ where: and(eq(loans.tenantId, ctx.tenantId), eq(loans.id, record.oldLoanId)) }), tx.query.loans.findFirst({ where: and(eq(loans.tenantId, ctx.tenantId), eq(loans.id, record.replacementLoanId)) })]);
        if (record.status === "reversed") {
            if (record.reversalIdempotencyKey !== key) throw new DomainError("IDEMPOTENCY_CONFLICT", "Idempotency key was used with a different request", 409);
            const audit = await tx.query.auditLogs.findFirst({ where: and(eq(auditLogs.tenantId, ctx.tenantId), eq(auditLogs.entityId, record.publicId), eq(auditLogs.action, "reversed")) });
            return { replacementPublicId: record.publicId, oldLoanPublicId: oldLoan!.publicId, replacementLoanPublicId: draft!.publicId, status: "reversed", auditPublicId: audit?.publicId ?? "", correlationId: ctx.correlationId };
        }
        if (record.status !== "executed" || !oldLoan || !draft) reviewRequired("REPLACEMENT_NOT_REVERSIBLE", "Only an executed replacement can be reversed", [record.publicId]);
        const [payments, disbursements, renewals, restructures] = await Promise.all([
            tx.select().from(transactions).where(and(eq(transactions.tenantId, ctx.tenantId), eq(transactions.loanId, draft.id))),
            tx.select().from(loanDisbursementEvents).where(and(eq(loanDisbursementEvents.tenantId, ctx.tenantId), eq(loanDisbursementEvents.loanId, draft.id))),
            tx.select({ publicId: loanRenewals.publicId }).from(loanRenewals).where(and(eq(loanRenewals.tenantId, ctx.tenantId), eq(loanRenewals.oldLoanId, draft.id), eq(loanRenewals.status, "executed"))).limit(1),
            tx.select({ publicId: loanRestructures.publicId }).from(loanRestructures).where(and(eq(loanRestructures.tenantId, ctx.tenantId), eq(loanRestructures.oldLoanId, draft.id), eq(loanRestructures.status, "executed"))).limit(1),
        ]);
        const blockers = [...activeRows(payments).filter(row => row.entryType === "repayment"), ...activeRows(disbursements).filter(row => row.status === "posted"), ...renewals, ...restructures].map(row => row.publicId);
        if (blockers.length) reviewRequired("REPLACEMENT_REVERSAL_DOWNSTREAM_ACTIVITY", "Replacement has downstream activity and requires human review", blockers);
        const snapshot = (record.preExecutionSnapshot as Record<string, any> | null)?.old;
        if (!snapshot) reviewRequired("REPLACEMENT_SNAPSHOT_MISSING", "Replacement snapshot is unavailable for safe reversal", [record.publicId]);
        const corrections = await tx.select().from(loanReplacementCorrections).where(and(eq(loanReplacementCorrections.tenantId, ctx.tenantId), eq(loanReplacementCorrections.replacementId, record.id), eq(loanReplacementCorrections.status, "posted")));
        for (const item of corrections) await tx.insert(loanReplacementCorrections).values({ tenantId: ctx.tenantId, replacementId: record.id, loanId: oldLoan.id, status: "reversed", principal: signedMoney(new FinancialDecimal(item.principal).negated()), interest: signedMoney(new FinancialDecimal(item.interest).negated()), fee: signedMoney(new FinancialDecimal(item.fee).negated()), penalty: signedMoney(new FinancialDecimal(item.penalty).negated()), reason: why, createdByUserId: ctx.actorUserId });
        const allocations = await tx.select().from(loanFundingAllocations).where(and(eq(loanFundingAllocations.tenantId, ctx.tenantId), eq(loanFundingAllocations.loanId, draft.id), eq(loanFundingAllocations.allocationType, "initial")));
        for (const allocation of allocations) await tx.insert(loanFundingAllocations).values({ tenantId: ctx.tenantId, bankProfileId: allocation.bankProfileId, bankLoanId: allocation.bankLoanId, loanId: draft.id, allocatedAmount: signedMoney(new FinancialDecimal(allocation.allocatedAmount).negated()), allocationDate: draft.startDate ?? new Date().toISOString().slice(0, 10), allocationType: "reallocation_out", allocationGroupId: crypto.randomUUID(), note: `Compensating replacement reversal ${record.publicId}`, createdByUserId: ctx.actorUserId, idempotencyKey: `replacement-reversal:${record.publicId}:${allocation.publicId}`, requestHash: sha({ replacementPublicId: record.publicId, allocationPublicId: allocation.publicId, why }) });
        await tx.update(loanSchedules).set({ status: "cancelled", remainingDue: "0.00" }).where(and(eq(loanSchedules.tenantId, ctx.tenantId), eq(loanSchedules.loanId, draft.id)));
        await tx.update(loans).set({ status: "cancelled", outstandingPrincipal: "0.00", outstandingInterest: "0.00", outstandingFees: "0.00", nextDueDate: null, updatedAt: new Date() }).where(and(eq(loans.tenantId, ctx.tenantId), eq(loans.id, draft.id)));
        await tx.update(loans).set({ status: snapshot.loan.status, outstandingPrincipal: snapshot.loan.outstandingPrincipal, outstandingInterest: snapshot.loan.outstandingInterest, outstandingFees: snapshot.loan.outstandingFees, nextDueDate: snapshot.loan.nextDueDate, updatedAt: new Date() }).where(and(eq(loans.tenantId, ctx.tenantId), eq(loans.id, oldLoan.id)));
        for (const schedule of snapshot.schedules as Array<any>) await tx.update(loanSchedules).set({ status: schedule.status, remainingDue: schedule.remainingDue, paidTotal: schedule.paidTotal, paidPenalty: schedule.paidPenalty }).where(and(eq(loanSchedules.tenantId, ctx.tenantId), eq(loanSchedules.id, schedule.id)));
        const audit = await createAuditLog(tx, { ...auditContext(ctx), entityType: "loan_replacement", entityId: record.publicId, action: "reversed", payload: { reason: why, before: { oldLoan: { status: "replaced" }, replacementLoan: { status: "active" } }, after: { oldLoan: snapshot.loan, replacementLoan: { status: "cancelled" } }, idempotencyKey: key } });
        await tx.update(loanReplacements).set({ status: "reversed", reversalIdempotencyKey: key, reversedByUserId: ctx.actorUserId, updatedAt: new Date() }).where(and(eq(loanReplacements.tenantId, ctx.tenantId), eq(loanReplacements.id, record.id), eq(loanReplacements.status, "executed")));
        return { replacementPublicId: record.publicId, oldLoanPublicId: oldLoan.publicId, replacementLoanPublicId: draft.publicId, status: "reversed", auditPublicId: audit.publicId, correlationId: ctx.correlationId };
    });
}
