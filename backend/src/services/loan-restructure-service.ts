import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import {
    auditLogs, borrowers, loanDisbursementEvents, loanInterestAccruals, loanInterestRatePeriods,
    loanOpeningBalanceComponents, loanRenewals, loanRestructures, loanRestructureWaivers, loanSchedules, loans,
    transactions, users,
} from "../db/schema";
import { canAccessTenantWideData } from "../lib/access";
import { createAuditLog } from "../lib/audit-log";
import { normalizePublicLoanTerms, type PublicLoanCalculationParams, type RepaymentType } from "../lib/calculator";
import { normalizeDailyLoanEntry } from "../lib/daily-loan-entry";
import { normalizeFloatingDailyInterest } from "../lib/floating-daily-interest";
import { generateLoanSchedule } from "../lib/loan-schedule";
import { parseMoney, serializeMoney } from "../lib/money";
import { calculateSinglePaymentSettlement, type SinglePaymentExposure, type SinglePaymentTerms } from "../lib/single-payment";
import type { CommandContext } from "./command-context";
import { DomainError } from "./domain-error";
import { createDisbursementDraftInTransaction } from "./loan-disbursement-service";

type Executor = any;
type Loan = typeof loans.$inferSelect;
type Restructure = typeof loanRestructures.$inferSelect;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hashPattern = /^v1:[0-9a-f]{64}$/i;

export interface ReplacementLoanTerms extends Omit<PublicLoanCalculationParams, "principal"> {}
export interface PreviewLoanRestructureInput {
    settlementDate: string;
    replacementTerms: ReplacementLoanTerms;
    waivers?: {
        interest?: { amount: string; reason: string };
        fees?: { amount: string; reason: string };
        penalty?: { amount: string; reason: string };
    };
    externalSettlementCredit?: { amount: string; payer: string; source: string };
    additionalPrincipal: string;
    reason: string;
}

function auditContext(ctx: CommandContext) {
    return { tenantId: ctx.tenantId, actorUserId: ctx.actorUserId, actorSource: ctx.actorSource, requestId: ctx.requestId, correlationId: ctx.correlationId };
}
function sha(payload: unknown) { return createHash("sha256").update(JSON.stringify(payload)).digest("hex"); }
function versionHash(payload: unknown) { return `v1:${sha(payload)}`; }
function businessDate(value: string, field: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
        throw new DomainError("INVALID_BUSINESS_DATE", `${field} must be a valid YYYY-MM-DD business date`, 400, { field });
    }
    return value;
}
function money(value: string | undefined, field: string) {
    try { return parseMoney(value ?? "0.00"); }
    catch { throw new DomainError("INVALID_MONEY", `${field} must be a non-negative two-decimal string`, 400, { field }); }
}
function requiredText(value: string | undefined, code: string, message: string) {
    const normalized = value?.trim();
    if (!normalized) throw new DomainError(code, message, 400);
    return normalized;
}
function singlePaymentTerms(loan: Loan): SinglePaymentTerms {
    if (!loan.singlePaymentDueDate || loan.singlePaymentFixedAgreedInterest === null || !loan.singlePaymentInterestPolicy || !loan.singlePaymentLatePenaltyMode) {
        throw new DomainError("SINGLE_PAYMENT_TERMS_MISSING", "Activated single-payment terms are incomplete", 409);
    }
    const latePenalty = loan.singlePaymentLatePenaltyMode === "fixed_amount_per_day"
        ? { mode: "fixed_amount_per_day" as const, amountPerDay: serializeMoney(loan.singlePaymentLatePenaltyAmountPerDay!), graceDays: loan.singlePaymentLatePenaltyGraceDays! }
        : { mode: "none" as const };
    return loan.singlePaymentInterestPolicy === "greater_of_fixed_or_retroactive"
        ? { dueDate: loan.singlePaymentDueDate, fixedAgreedInterest: serializeMoney(loan.singlePaymentFixedAgreedInterest), interestPolicy: "greater_of_fixed_or_retroactive", retroactiveInterest: { rateType: loan.singlePaymentRetroactiveRateType as "percent_per_day" | "per_thousand_per_day", rate: new Decimal(loan.singlePaymentRetroactiveRate!).toFixed(4) }, latePenalty }
        : { dueDate: loan.singlePaymentDueDate, fixedAgreedInterest: serializeMoney(loan.singlePaymentFixedAgreedInterest), interestPolicy: "fixed_only", latePenalty };
}
async function actorFor(ctx: CommandContext, executor: Executor = db) {
    if (ctx.actorUserId === null) return null;
    const actor = await executor.query.users.findFirst({ where: and(eq(users.tenantId, ctx.tenantId), eq(users.id, ctx.actorUserId)) });
    if (!actor) throw new DomainError("ACTOR_NOT_FOUND", "Actor is not available in this tenant", 403);
    return actor;
}
async function accessibleLoan(ctx: CommandContext, publicId: string, executor: Executor = db) {
    if (!uuidPattern.test(publicId)) throw new DomainError("INVALID_PUBLIC_ID", "loanPublicId must be a UUID", 400);
    const actor = await actorFor(ctx, executor);
    const loan = await executor.query.loans.findFirst({ where: and(eq(loans.tenantId, ctx.tenantId), eq(loans.publicId, publicId)) });
    if (!loan || (actor && !canAccessTenantWideData({ role: actor.role ?? "viewer" }) && loan.ownerUserId !== actor.id)) {
        throw new DomainError("LOAN_NOT_FOUND", "Loan not found", 404);
    }
    return loan as Loan;
}
async function accessibleRestructure(ctx: CommandContext, publicId: string, executor: Executor = db) {
    if (!uuidPattern.test(publicId)) throw new DomainError("INVALID_PUBLIC_ID", "restructurePublicId must be a UUID", 400);
    const row = await executor.query.loanRestructures.findFirst({ where: and(eq(loanRestructures.tenantId, ctx.tenantId), eq(loanRestructures.publicId, publicId)) });
    if (!row) throw new DomainError("RESTRUCTURE_NOT_FOUND", "Loan restructure not found", 404);
    const oldLoan = await accessibleLoan(ctx, (await executor.query.loans.findFirst({ where: and(eq(loans.tenantId, ctx.tenantId), eq(loans.id, row.oldLoanId)) }))!.publicId, executor);
    return { row: row as Restructure, oldLoan };
}

function activeTransactionRows(rows: Array<typeof transactions.$inferSelect>) {
    const reversed = new Set(rows.filter(row => row.entryType === "reversal" && row.reversedTransactionId !== null).map(row => row.reversedTransactionId!));
    return rows.filter(row => row.entryType === "repayment" && !reversed.has(row.id));
}
function activeDisbursementRows(rows: Array<typeof loanDisbursementEvents.$inferSelect>) {
    const reversed = new Set(rows.filter(row => row.reversedEventId !== null).map(row => row.reversedEventId!));
    return rows.filter(row => row.status === "posted" && !reversed.has(row.id));
}
function bangkokDate(value: Date) {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" }).format(value);
}
async function snapshot(executor: Executor, ctx: CommandContext, loan: Loan, settlementDate: string) {
    const [allTransactions, allDisbursements, schedules] = await Promise.all([
        executor.select().from(transactions).where(and(eq(transactions.tenantId, ctx.tenantId), eq(transactions.loanId, loan.id))).orderBy(transactions.transactionDate, transactions.id),
        executor.select().from(loanDisbursementEvents).where(and(eq(loanDisbursementEvents.tenantId, ctx.tenantId), eq(loanDisbursementEvents.loanId, loan.id))).orderBy(loanDisbursementEvents.disbursedAt, loanDisbursementEvents.id),
        executor.select().from(loanSchedules).where(and(eq(loanSchedules.tenantId, ctx.tenantId), eq(loanSchedules.loanId, loan.id))).orderBy(loanSchedules.installmentNo),
    ]);
    const activeTransactions = activeTransactionRows(allTransactions).filter(row => bangkokDate(row.transactionDate ?? row.postedAt) <= settlementDate);
    const activeDisbursements = activeDisbursementRows(allDisbursements).filter(row => bangkokDate(row.disbursedAt ?? row.postedAt ?? row.createdAt!) <= settlementDate);
    const totalDisbursed = activeDisbursements.reduce((sum, row) => sum.plus(row.loanAttributedAmount), new Decimal(0));
    const principalPaid = activeTransactions.reduce((sum, row) => sum.plus(row.principalComponent), new Decimal(0));
    const outstandingPrincipal = Decimal.max(0, totalDisbursed.minus(principalPaid));
    const outstandingFees = Decimal.max(0,
        (schedules as Array<typeof loanSchedules.$inferSelect>).reduce((sum: Decimal, row) => sum.plus(row.scheduledFee), new Decimal(0))
            .minus(activeTransactions.reduce((sum: Decimal, row) => sum.plus(row.feeComponent), new Decimal(0)))
            .plus(loan.outstandingFees ?? 0),
    );
    const events = [
        ...activeDisbursements.map(row => ({ date: bangkokDate(row.disbursedAt ?? row.postedAt ?? row.createdAt!), delta: new Decimal(row.loanAttributedAmount), tie: row.id })),
        ...activeTransactions.filter(row => new Decimal(row.principalComponent).gt(0)).map(row => ({ date: bangkokDate(row.transactionDate ?? row.postedAt), delta: new Decimal(row.principalComponent).negated(), tie: row.id + 1_000_000_000 })),
    ].sort((a, b) => a.date.localeCompare(b.date) || a.tie - b.tie);
    let balance = new Decimal(0);
    const exposures: SinglePaymentExposure[] = [];
    for (let index = 0; index < events.length; index++) {
        const event = events[index]!;
        balance = Decimal.max(0, balance.plus(event.delta));
        const toDate = events[index + 1]?.date ?? settlementDate;
        if (event.date < toDate) exposures.push({ amount: serializeMoney(balance), fromDate: event.date, toDate });
    }
    const versionPayload = {
        loanPublicId: loan.publicId, settlementDate,
        loan: [loan.status, loan.outstandingPrincipal, loan.outstandingInterest, loan.outstandingFees, loan.nextDueDate, loan.updatedAt?.toISOString(), loan.singlePaymentDueDate, loan.singlePaymentFixedAgreedInterest, loan.singlePaymentInterestPolicy, loan.singlePaymentRetroactiveRateType, loan.singlePaymentRetroactiveRate, loan.singlePaymentLatePenaltyMode, loan.singlePaymentLatePenaltyAmountPerDay, loan.singlePaymentLatePenaltyGraceDays],
        transactions: allTransactions.map((row: typeof transactions.$inferSelect) => [row.publicId, row.entryType, row.reversedTransactionId, row.principalComponent, row.interestComponent, row.feeComponent, row.penaltyComponent, row.transactionDate?.toISOString()]),
        disbursements: allDisbursements.map((row: typeof loanDisbursementEvents.$inferSelect) => [row.publicId, row.status, row.reversedEventId, row.loanAttributedAmount, row.disbursedAt?.toISOString(), row.postedAt?.toISOString()]),
        schedules: (schedules as Array<typeof loanSchedules.$inferSelect>).map(row => [row.publicId, row.paidTotal, row.paidPenalty, row.remainingDue, row.status]),
    };
    return { outstandingPrincipal, outstandingFees, exposures, version: versionHash(versionPayload), versionPayload };
}

function normalizeReplacement(input: ReplacementLoanTerms, replacementPrincipal: Decimal) {
    let terms;
    try { terms = normalizePublicLoanTerms({ ...input, principal: serializeMoney(replacementPrincipal) }); }
    catch (error) { throw new DomainError("INVALID_REPLACEMENT_TERMS", error instanceof Error ? error.message : "Replacement terms are invalid", 400); }
    let dailyEntry = null;
    let floating = null;
    if (terms.repaymentType === "daily") {
        if (!input.dailyEntry) throw new DomainError("INVALID_REPLACEMENT_TERMS", "Daily replacement terms require daily entry terms", 400);
        try { dailyEntry = normalizeDailyLoanEntry({ ...input.dailyEntry, principal: serializeMoney(replacementPrincipal) }); }
        catch (error) { throw new DomainError("INVALID_REPLACEMENT_TERMS", error instanceof Error ? error.message : "Daily replacement terms are invalid", 400); }
    }
    if (terms.repaymentType === "floating") {
        if (!input.floatingDailyInterest) throw new DomainError("INVALID_REPLACEMENT_TERMS", "Floating replacement terms require interest policy", 400);
        try { floating = normalizeFloatingDailyInterest(input.floatingDailyInterest); }
        catch (error) { throw new DomainError("INVALID_REPLACEMENT_TERMS", error instanceof Error ? error.message : "Floating replacement terms are invalid", 400); }
    }
    const schedule = terms.repaymentType === "floating" ? [] : generateLoanSchedule({
        principal: terms.principal, interestRate: terms.interestRate, termMonths: terms.termMonths,
        repaymentType: terms.repaymentType, startDate: terms.startDate,
        totalInstallments: terms.totalInstallments, installmentAmount: terms.installmentAmount,
        singlePayment: terms.singlePayment,
    });
    return { terms, dailyEntry, floating, schedule };
}

function waiver(input: PreviewLoanRestructureInput, component: "interest" | "fees" | "penalty", gross: Decimal) {
    const item = input.waivers?.[component];
    const amount = money(item?.amount, `waivers.${component}.amount`);
    if (amount.gt(gross)) throw new DomainError("WAIVER_EXCEEDS_COMPONENT", `Waiver cannot exceed ${component}`, 400, { component, availableAmount: serializeMoney(gross) });
    if (amount.gt(0)) requiredText(item?.reason, "WAIVER_REASON_REQUIRED", `A ${component} waiver reason is required`);
    return amount;
}
function allocateExternalCredit(amount: Decimal, balances: { penalty: Decimal; fee: Decimal; interest: Decimal; principal: Decimal }) {
    let remaining = amount;
    const take = (available: Decimal) => {
        const allocated = Decimal.min(remaining, available);
        remaining = remaining.minus(allocated);
        return allocated;
    };
    const penalty = take(balances.penalty);
    const fee = take(balances.fee);
    const interest = take(balances.interest);
    const principal = take(balances.principal);
    return { penalty, fee, interest, principal, unallocated: remaining };
}
async function computePreview(executor: Executor, ctx: CommandContext, loan: Loan, input: PreviewLoanRestructureInput) {
    const settlementDate = businessDate(input.settlementDate, "settlementDate");
    if (loan.repaymentType !== "single_payment" || loan.status !== "active") throw new DomainError("LOAN_NOT_RESTRUCTURABLE", "Only active single-payment loans can use this settlement workflow", 409);
    const reason = requiredText(input.reason, "RESTRUCTURE_REASON_REQUIRED", "A restructure reason is required");
    const additionalPrincipal = money(input.additionalPrincipal, "additionalPrincipal");
    const creditAmount = money(input.externalSettlementCredit?.amount, "externalSettlementCredit.amount");
    if (creditAmount.gt(0)) {
        requiredText(input.externalSettlementCredit?.payer, "EXTERNAL_CREDIT_PAYER_REQUIRED", "External settlement credit payer is required");
        requiredText(input.externalSettlementCredit?.source, "EXTERNAL_CREDIT_SOURCE_REQUIRED", "External settlement credit source is required");
    }
    const current = await snapshot(executor, ctx, loan, settlementDate);
    const terms = singlePaymentTerms(loan);
    const gross = calculateSinglePaymentSettlement({ settlementDate, terms, exposures: current.exposures, waivers: { interest: "0.00", fees: "0.00", penalties: "0.00" }, outstandingPrincipal: serializeMoney(current.outstandingPrincipal), outstandingFees: serializeMoney(current.outstandingFees), externalSettlementCredits: "0.00" });
    const waivedInterest = waiver(input, "interest", new Decimal(gross.grossInterest));
    const waivedFees = waiver(input, "fees", new Decimal(gross.grossFees));
    const waivedPenalty = waiver(input, "penalty", new Decimal(gross.grossPenalty));
    const calculated = calculateSinglePaymentSettlement({ settlementDate, terms, exposures: current.exposures, waivers: { interest: serializeMoney(waivedInterest), fees: serializeMoney(waivedFees), penalties: serializeMoney(waivedPenalty) }, outstandingPrincipal: serializeMoney(current.outstandingPrincipal), outstandingFees: serializeMoney(current.outstandingFees), externalSettlementCredits: serializeMoney(creditAmount) });
    const creditAllocation = allocateExternalCredit(creditAmount, { penalty: new Decimal(calculated.netPenalty), fee: new Decimal(calculated.netFees), interest: new Decimal(calculated.netInterest), principal: current.outstandingPrincipal });
    if (creditAllocation.unallocated.gt(0)) {
        throw new DomainError("EXTERNAL_CREDIT_EXCEEDS_SETTLEMENT", "External settlement credit cannot exceed the net eligible settlement", 400);
    }
    const netPrincipal = current.outstandingPrincipal.minus(creditAllocation.principal);
    const netInterest = new Decimal(calculated.netInterest).minus(creditAllocation.interest);
    const netFees = new Decimal(calculated.netFees).minus(creditAllocation.fee);
    const netPenalty = new Decimal(calculated.netPenalty).minus(creditAllocation.penalty);
    const replacementPrincipal = netPrincipal.plus(additionalPrincipal);
    if (replacementPrincipal.lte(0)) throw new DomainError("INVALID_REPLACEMENT_PRINCIPAL", "Replacement principal must be greater than zero", 400);
    const replacement = normalizeReplacement(input.replacementTerms, replacementPrincipal);
    const cash = additionalPrincipal.gt(0) ? { direction: "payout" as const, amount: serializeMoney(additionalPrincipal) } : { direction: "none" as const, amount: "0.00" };
    const request = { ...input, reason, additionalPrincipal: serializeMoney(additionalPrincipal), currentVersion: current.version, replacementTerms: replacement.terms };
    const requestHash = sha(request);
    const previewHash = versionHash({ requestHash, currentVersion: current.version, calculated, replacementPrincipal: serializeMoney(replacementPrincipal), schedule: replacement.schedule });
    return { current, calculated, waivedInterest, waivedFees, waivedPenalty, creditAmount, creditAllocation, netPrincipal, netInterest, netFees, netPenalty, additionalPrincipal, replacementPrincipal, replacement, cash, reason, request, requestHash, previewHash };
}

function presentPreview(row: Restructure, loan: Loan, computed: Awaited<ReturnType<typeof computePreview>>) {
    return {
        publicId: row.publicId, oldLoanPublicId: loan.publicId, status: row.status,
        settlementDate: row.settlementDate, oldBalanceVersion: row.oldBalanceVersion, previewHash: row.previewHash, expiresAt: row.expiresAt,
        balance: computed.calculated,
        replacementPrincipal: serializeMoney(new Decimal(row.netPrincipal).plus(row.additionalPrincipal)),
        externalCreditAllocation: { penalty: serializeMoney(row.externalCreditPenalty), fee: serializeMoney(row.externalCreditFees), interest: serializeMoney(row.externalCreditInterest), principal: serializeMoney(row.externalCreditPrincipal), unallocated: "0.00" },
        replacementTerms: row.requestedReplacementTerms,
        schedule: computed.replacement.schedule, cash: { direction: row.cashDirection, amount: serializeMoney(row.cashAmount) },
        reason: row.reason,
    };
}

export async function previewLoanRestructure(ctx: CommandContext, oldLoanPublicId: string, input: PreviewLoanRestructureInput) {
    const loan = await accessibleLoan(ctx, oldLoanPublicId);
    const computed = await computePreview(db, ctx, loan, input);
    const expiresAt = new Date(Date.now() + Math.max(60, Number(process.env.RESTRUCTURE_PREVIEW_TTL_SECONDS ?? 900)) * 1000);
    const row = await db.transaction(async tx => {
        await tx.update(loanRestructures).set({ status: "expired", updatedByUserId: ctx.actorUserId, updatedAt: new Date() }).where(and(eq(loanRestructures.tenantId, ctx.tenantId), eq(loanRestructures.oldLoanId, loan.id), eq(loanRestructures.status, "preview")));
        const created = await tx.insert(loanRestructures).values({
            tenantId: ctx.tenantId, oldLoanId: loan.id, settlementDate: input.settlementDate, oldBalanceVersion: computed.current.version,
            previewHash: computed.previewHash, requestHash: computed.requestHash, requestedReplacementTerms: computed.request as unknown as Record<string, unknown>,
            grossPrincipal: computed.calculated.grossPrincipal, grossInterest: computed.calculated.grossInterest, grossFees: computed.calculated.grossFees, grossPenalty: computed.calculated.grossPenalty,
            waivedInterest: computed.calculated.waivedInterest, waivedFees: computed.calculated.waivedFees, waivedPenalty: computed.calculated.waivedPenalty,
            netPrincipal: serializeMoney(computed.netPrincipal), netInterest: serializeMoney(computed.netInterest), netFees: serializeMoney(computed.netFees), netPenalty: serializeMoney(computed.netPenalty),
            externalSettlementCredits: serializeMoney(computed.creditAmount), externalCreditPrincipal: serializeMoney(computed.creditAllocation.principal), externalCreditInterest: serializeMoney(computed.creditAllocation.interest), externalCreditFees: serializeMoney(computed.creditAllocation.fee), externalCreditPenalty: serializeMoney(computed.creditAllocation.penalty), additionalPrincipal: serializeMoney(computed.additionalPrincipal), cashDirection: computed.cash.direction, cashAmount: computed.cash.amount,
            reason: computed.reason, createdActorSource: ctx.actorSource, requestId: ctx.requestId, correlationId: ctx.correlationId,
            expiresAt, createdByUserId: ctx.actorUserId, updatedByUserId: ctx.actorUserId,
        }).returning().then((rows: Restructure[]) => rows[0]!);
        await createAuditLog(tx, { ...auditContext(ctx), entityType: "loan_restructure", entityId: created.publicId, action: "previewed", payload: { oldLoanPublicId, previewHash: created.previewHash, oldBalanceVersion: created.oldBalanceVersion, settlementDate: created.settlementDate } });
        return created;
    });
    return presentPreview(row, loan, computed);
}

export interface ExecuteLoanRestructureInput { confirmed: boolean; previewHash: string; expectedBalanceVersion: string; reason: string }
function requireExecute(ctx: CommandContext, input: ExecuteLoanRestructureInput) {
    if (input.confirmed !== true) throw new DomainError("RESTRUCTURE_CONFIRMATION_REQUIRED", "Restructure execution requires explicit confirmation", 400);
    if (!hashPattern.test(input.previewHash) || !hashPattern.test(input.expectedBalanceVersion)) throw new DomainError("INVALID_PREVIEW_HASH", "Preview and balance hashes must be versioned SHA-256 values", 400);
    const reason = requiredText(input.reason, "RESTRUCTURE_REASON_REQUIRED", "A restructure reason is required");
    const idempotencyKey = requiredText(ctx.idempotencyKey, "IDEMPOTENCY_KEY_REQUIRED", "Restructure execution requires an idempotency key");
    return { reason, idempotencyKey, requestHash: sha({ contract: "loan-restructure-execute", version: "v1", previewHash: input.previewHash, expectedBalanceVersion: input.expectedBalanceVersion, reason }) };
}
async function presentExecution(executor: Executor, row: Restructure, oldLoan: Loan) {
    const newLoan = row.newLoanId ? await executor.query.loans.findFirst({ where: and(eq(loans.tenantId, row.tenantId), eq(loans.id, row.newLoanId)) }) : null;
    const draft = row.newLoanId ? await executor.query.loanDisbursementEvents.findFirst({ where: and(eq(loanDisbursementEvents.tenantId, row.tenantId), eq(loanDisbursementEvents.loanId, row.newLoanId), eq(loanDisbursementEvents.status, "draft")) }) : null;
    return { publicId: row.publicId, status: row.status, oldLoanPublicId: oldLoan.publicId, newLoanPublicId: newLoan?.publicId ?? null, disbursementDraftPublicId: draft?.publicId ?? null, auditPublicIds: [row.executedAuditPublicId, row.reversedAuditPublicId].filter(Boolean), correlationId: row.correlationId };
}
function replacementColumns(replacement: ReturnType<typeof normalizeReplacement>) {
    const { terms, dailyEntry, floating } = replacement;
    const sp = terms.singlePayment;
    return {
        principalAmount: terms.principal, interestRate: terms.interestRate, repaymentType: terms.repaymentType,
        termMonths: terms.repaymentType === "floating" ? null : terms.termMonths, totalInstallments: terms.totalInstallments ?? null, installmentAmount: terms.installmentAmount ?? null,
        startDate: terms.startDate!, dailyTermUnit: dailyEntry?.durationUnit ?? null, dailyTermValue: dailyEntry?.durationValue ?? null,
        dailyEntryMode: dailyEntry?.entryMode ?? null, dailyInterestInputMode: dailyEntry?.interestInput?.mode ?? null, dailyInterestInputValue: dailyEntry?.interestInput?.value ?? null, dailyFlatRatePercent: dailyEntry?.flatDailyRatePercent ?? null,
        dailyInterestMode: floating?.mode ?? null, dailyInterestRate: floating?.rate ?? null, firstDayTreatment: floating?.firstDayTreatment ?? null, floatingAccrualCycle: floating?.accrualCycle ?? null, interestStartDate: floating ? terms.startDate! : null,
        singlePaymentDueDate: sp?.dueDate ?? null, singlePaymentFixedAgreedInterest: sp?.fixedAgreedInterest ?? null, singlePaymentInterestPolicy: sp?.interestPolicy ?? null,
        singlePaymentRetroactiveRateType: sp?.interestPolicy === "greater_of_fixed_or_retroactive" ? sp.retroactiveInterest.rateType : null,
        singlePaymentRetroactiveRate: sp?.interestPolicy === "greater_of_fixed_or_retroactive" ? sp.retroactiveInterest.rate : null,
        singlePaymentLatePenaltyMode: sp?.latePenalty.mode ?? null,
        singlePaymentLatePenaltyAmountPerDay: sp?.latePenalty.mode === "fixed_amount_per_day" ? sp.latePenalty.amountPerDay : null,
        singlePaymentLatePenaltyGraceDays: sp?.latePenalty.mode === "fixed_amount_per_day" ? sp.latePenalty.graceDays : null,
    };
}

export async function executeLoanRestructure(ctx: CommandContext, restructurePublicId: string, input: ExecuteLoanRestructureInput) {
    const required = requireExecute(ctx, input);
    const accessible = await accessibleRestructure(ctx, restructurePublicId);
    const result = await db.transaction(async tx => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`loan-restructure-execute:${ctx.tenantId}:${required.idempotencyKey}`}, 0))`);
        const reused = await tx.query.loanRestructures.findFirst({ where: and(eq(loanRestructures.tenantId, ctx.tenantId), eq(loanRestructures.executeIdempotencyKey, required.idempotencyKey)) });
        if (reused && reused.id !== accessible.row.id) throw new DomainError("IDEMPOTENCY_KEY_CONFLICT", "Idempotency key belongs to a different restructure", 409);
        await tx.execute(sql`SELECT id FROM loans WHERE tenant_id=${ctx.tenantId} AND id=${accessible.oldLoan.id} FOR UPDATE`);
        await tx.execute(sql`SELECT id FROM transactions WHERE tenant_id=${ctx.tenantId} AND loan_id=${accessible.oldLoan.id} ORDER BY id FOR UPDATE`);
        await tx.execute(sql`SELECT id FROM loan_disbursement_events WHERE tenant_id=${ctx.tenantId} AND loan_id=${accessible.oldLoan.id} ORDER BY id FOR UPDATE`);
        await tx.execute(sql`SELECT id FROM loan_schedules WHERE tenant_id=${ctx.tenantId} AND loan_id=${accessible.oldLoan.id} ORDER BY id FOR UPDATE`);
        await tx.execute(sql`SELECT id FROM loan_restructures WHERE tenant_id=${ctx.tenantId} AND id=${accessible.row.id} FOR UPDATE`);
        const { row, oldLoan } = await accessibleRestructure(ctx, restructurePublicId, tx);
        if (row.status === "executed") {
            if (row.executeIdempotencyKey === required.idempotencyKey && row.executeRequestHash === required.requestHash) return { value: await presentExecution(tx, row, oldLoan) };
            throw new DomainError("IDEMPOTENCY_KEY_CONFLICT", "Restructure was executed with a different key or payload", 409);
        }
        if (row.status !== "preview") throw new DomainError("RESTRUCTURE_NOT_EXECUTABLE", "Restructure preview is not executable", 409);
        if (row.expiresAt.getTime() <= Date.now() || row.previewHash !== input.previewHash || row.oldBalanceVersion !== input.expectedBalanceVersion) return { stale: true as const };
        const stored = row.requestedReplacementTerms as unknown as PreviewLoanRestructureInput & { currentVersion: string };
        const computed = await computePreview(tx, ctx, oldLoan, stored);
        // The persisted request/hash is immutable. Recomputing its JSON hash after a
        // PostgreSQL JSONB round-trip is not canonical (key ordering differs); the
        // authoritative staleness guard is the exact financial balance version.
        if (computed.current.version !== row.oldBalanceVersion || oldLoan.status !== "active") return { stale: true as const, details: { currentVersion: computed.current.version, oldBalanceVersion: row.oldBalanceVersion, status: oldLoan.status } };
        const replacement = computed.replacement;
        const scheduleInterest = replacement.schedule.reduce((sum, schedule) => sum.plus(schedule.scheduledInterest), new Decimal(0));
        const scheduleFees = replacement.schedule.reduce((sum, schedule) => sum.plus(schedule.scheduledFee), new Decimal(0));
        const now = new Date();
        const newLoan = await tx.insert(loans).values({
            tenantId: ctx.tenantId, ownerUserId: oldLoan.ownerUserId, borrowerId: oldLoan.borrowerId,
            bankLoanId: null, fundingBankProfileId: null, ...replacementColumns(replacement),
            nextDueDate: replacement.schedule[0]?.dueDate ?? null, outstandingPrincipal: serializeMoney(computed.replacementPrincipal),
            outstandingInterest: serializeMoney(scheduleInterest.plus(computed.calculated.netInterest)), outstandingFees: serializeMoney(scheduleFees.plus(computed.calculated.netFees)),
            status: "active", clonedFromLoanId: oldLoan.id,
        }).returning().then((rows: Loan[]) => rows[0]!);
        const executionAudit = await createAuditLog(tx, { ...auditContext(ctx), entityType: "loan_restructure", entityId: row.publicId, action: "executed", payload: { oldLoanPublicId: oldLoan.publicId, newLoanPublicId: newLoan.publicId, additionalPrincipal: serializeMoney(computed.additionalPrincipal), reason: required.reason } });
        const executed = await tx.update(loanRestructures).set({ newLoanId: newLoan.id, status: "executed", executeIdempotencyKey: required.idempotencyKey, executeRequestHash: required.requestHash, executeActorSource: ctx.actorSource, executedAuditPublicId: executionAudit.publicId, preExecutionOldLoanState: { status: oldLoan.status ?? "active", outstandingPrincipal: serializeMoney(oldLoan.outstandingPrincipal ?? 0), outstandingInterest: serializeMoney(oldLoan.outstandingInterest ?? 0), outstandingFees: serializeMoney(oldLoan.outstandingFees ?? 0), nextDueDate: oldLoan.nextDueDate ?? null }, executedAt: now, executedByUserId: ctx.actorUserId, updatedByUserId: ctx.actorUserId, updatedAt: now }).where(and(eq(loanRestructures.tenantId, ctx.tenantId), eq(loanRestructures.id, row.id))).returning().then((rows: Restructure[]) => rows[0]!);
        if (replacement.schedule.length) await tx.insert(loanSchedules).values(replacement.schedule.map(schedule => ({ tenantId: ctx.tenantId, loanId: newLoan.id, installmentNo: schedule.installmentNo, dueDate: schedule.dueDate, scheduledPrincipal: schedule.scheduledPrincipal, scheduledInterest: schedule.scheduledInterest, scheduledFee: schedule.scheduledFee, scheduledTotal: schedule.scheduledTotal, remainingDue: schedule.remainingDue, paidTotal: "0.00", paidPenalty: "0.00", status: "pending" })));
        if (replacement.floating) await tx.insert(loanInterestRatePeriods).values({ tenantId: ctx.tenantId, loanId: newLoan.id, effectiveDate: replacement.terms.startDate!, rateType: replacement.floating.mode, rate: replacement.floating.rate, createdByUserId: ctx.actorUserId });
        const componentRows = [
            ["carried_principal", serializeMoney(computed.netPrincipal), "loan", oldLoan.publicId],
            ["additional_principal", serializeMoney(computed.additionalPrincipal), "loan_restructure", row.publicId],
            ["carried_interest", serializeMoney(computed.netInterest), "loan_restructure", row.publicId],
            ["carried_fee", serializeMoney(computed.netFees), "loan_restructure", row.publicId],
            ["carried_penalty", serializeMoney(computed.netPenalty), "loan_restructure", row.publicId],
            ["new_contract_interest", serializeMoney(scheduleInterest), "loan_restructure", row.publicId],
        ] as const;
        await tx.insert(loanOpeningBalanceComponents).values(componentRows.filter(([, amount]) => new Decimal(amount).gt(0)).map(([componentKind, amount, sourceType, sourcePublicId]) => ({ tenantId: ctx.tenantId, restructureId: row.id, loanId: newLoan.id, componentKind, amount, sourceType, sourcePublicId, createdByUserId: ctx.actorUserId })));
        for (const [componentKind, amount, item] of [["interest", computed.waivedInterest, stored.waivers?.interest], ["fee", computed.waivedFees, stored.waivers?.fees], ["penalty", computed.waivedPenalty, stored.waivers?.penalty]] as const) {
            if (amount.gt(0)) {
                const waiverAudit = await createAuditLog(tx, { ...auditContext(ctx), entityType: "loan_restructure_waiver", entityId: row.publicId, action: "executed_with_restructure", payload: { componentKind, amount: serializeMoney(amount), reason: item?.reason } });
                await tx.insert(loanRestructureWaivers).values({ tenantId: ctx.tenantId, restructureId: row.id, loanId: newLoan.id, componentKind, amount: serializeMoney(amount), reason: item!.reason, status: "executed", actorSource: ctx.actorSource, requestId: ctx.requestId, correlationId: ctx.correlationId, executeIdempotencyKey: `restructure:${required.idempotencyKey}:waiver:${componentKind}`, executeRequestHash: sha({ row: row.publicId, componentKind, amount: serializeMoney(amount), reason: item!.reason }), auditPublicId: waiverAudit.publicId, createdByUserId: ctx.actorUserId, executedAt: now });
            }
        }
        if (computed.creditAmount.gt(0)) {
            await tx.insert(transactions).values({
                tenantId: ctx.tenantId, ownerUserId: oldLoan.ownerUserId, loanId: oldLoan.id,
                amount: serializeMoney(computed.creditAmount), principalComponent: serializeMoney(computed.creditAllocation.principal),
                interestComponent: serializeMoney(computed.creditAllocation.interest), feeComponent: serializeMoney(computed.creditAllocation.fee), penaltyComponent: serializeMoney(computed.creditAllocation.penalty),
                type: "close_account", entryType: "repayment", transactionDate: new Date(`${row.settlementDate}T00:00:00+07:00`),
                idempotencyKey: `restructure:${required.idempotencyKey}:external-credit`,
                notes: `External settlement credit — ${stored.externalSettlementCredit!.payer}: ${stored.externalSettlementCredit!.source}`,
                recordedByUserId: ctx.actorUserId,
            });
        }
        let draft = null;
        if (computed.additionalPrincipal.gt(0)) draft = await createDisbursementDraftInTransaction(tx, ctx, newLoan, { grossAmount: serializeMoney(computed.additionalPrincipal), loanAttributedAmount: serializeMoney(computed.additionalPrincipal), channel: "adjustment", note: `Additional principal approved by restructure ${row.publicId}; payout not yet posted`, payeeHint: null, disbursedAt: now.toISOString() });
        await tx.update(loans).set({ status: "restructured", updatedAt: now }).where(and(eq(loans.tenantId, ctx.tenantId), eq(loans.id, oldLoan.id), eq(loans.status, "active")));
        return { value: await presentExecution(tx, executed, oldLoan) };
    });
    if ("stale" in result) throw new DomainError("STALE_RESTRUCTURE_PREVIEW", "Restructure preview expired or balances changed", 409, result.details);
    return result.value;
}

export async function reverseLoanRestructure(ctx: CommandContext, restructurePublicId: string, input: { reason: string }) {
    const reason = requiredText(input.reason, "REVERSAL_REASON_REQUIRED", "Restructure reversal requires a reason");
    const idempotencyKey = requiredText(ctx.idempotencyKey, "IDEMPOTENCY_KEY_REQUIRED", "Restructure reversal requires an idempotency key");
    const requestHash = sha({ contract: "loan-restructure-reverse", version: "v1", restructurePublicId, reason });
    const accessible = await accessibleRestructure(ctx, restructurePublicId);
    return db.transaction(async tx => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`loan-restructure-reverse:${ctx.tenantId}:${idempotencyKey}`}, 0))`);
        await tx.execute(sql`SELECT id FROM loan_restructures WHERE tenant_id=${ctx.tenantId} AND id=${accessible.row.id} FOR UPDATE`);
        const { row, oldLoan } = await accessibleRestructure(ctx, restructurePublicId, tx);
        if (row.status === "reversed") {
            if (row.reversalIdempotencyKey === idempotencyKey && row.reversalRequestHash === requestHash) return presentExecution(tx, row, oldLoan);
            throw new DomainError("REVERSAL_IDEMPOTENCY_CONFLICT", "Restructure reversal payload conflicts", 409);
        }
        if (row.status !== "executed" || !row.newLoanId || !row.preExecutionOldLoanState) throw new DomainError("RESTRUCTURE_NOT_REVERSIBLE", "Only executed restructures can be reversed", 409);
        await tx.execute(sql`SELECT id FROM loans WHERE tenant_id=${ctx.tenantId} AND id IN (${oldLoan.id}, ${row.newLoanId}) ORDER BY id FOR UPDATE`);
        const [paymentCount, postedDisbursements, laterWaivers, laterRestructures, laterRenewals, rateChanges] = await Promise.all([
            tx.select({ count: sql<number>`count(*)::int` }).from(transactions).where(and(eq(transactions.tenantId, ctx.tenantId), eq(transactions.loanId, row.newLoanId))),
            tx.select({ count: sql<number>`count(*)::int` }).from(loanDisbursementEvents).where(and(eq(loanDisbursementEvents.tenantId, ctx.tenantId), eq(loanDisbursementEvents.loanId, row.newLoanId), inArray(loanDisbursementEvents.status, ["posted", "reversed"]))),
            tx.select({ count: sql<number>`count(*)::int` }).from(loanRestructureWaivers).where(and(
                eq(loanRestructureWaivers.tenantId, ctx.tenantId), eq(loanRestructureWaivers.loanId, row.newLoanId),
                sql`${loanRestructureWaivers.executeIdempotencyKey} NOT LIKE ${`restructure:${row.executeIdempotencyKey}:%`}`,
            )),
            tx.select({ count: sql<number>`count(*)::int` }).from(loanRestructures).where(and(eq(loanRestructures.tenantId, ctx.tenantId), eq(loanRestructures.oldLoanId, row.newLoanId), inArray(loanRestructures.status, ["executed", "reversed"]))),
            tx.select({ count: sql<number>`count(*)::int` }).from(loanRenewals).where(and(eq(loanRenewals.tenantId, ctx.tenantId), eq(loanRenewals.oldLoanId, row.newLoanId), inArray(loanRenewals.status, ["executed", "reversed"]))),
            tx.select({ count: sql<number>`count(*)::int` }).from(loanInterestRatePeriods).where(and(eq(loanInterestRatePeriods.tenantId, ctx.tenantId), eq(loanInterestRatePeriods.loanId, row.newLoanId))),
        ]);
        const replacement = await tx.query.loans.findFirst({ where: eq(loans.id, row.newLoanId) });
        const expectedInitialRatePeriod = replacement?.repaymentType === "floating" ? 1 : 0;
        const blockers = { payments: paymentCount[0]!.count, postedDisbursements: postedDisbursements[0]!.count, laterWaivers: laterWaivers[0]!.count, laterRestructures: laterRestructures[0]!.count, laterRenewals: laterRenewals[0]!.count, rateChanges: Math.max(0, rateChanges[0]!.count - expectedInitialRatePeriod) };
        if (Object.values(blockers).some(count => count > 0)) throw new DomainError("RESTRUCTURE_REVERSAL_BLOCKED", "Replacement loan has downstream financial activity", 409, { blockers });
        const now = new Date();
        const opening = await tx.select().from(loanOpeningBalanceComponents).where(and(eq(loanOpeningBalanceComponents.tenantId, ctx.tenantId), eq(loanOpeningBalanceComponents.restructureId, row.id), eq(loanOpeningBalanceComponents.status, "executed")));
        if (opening.length) await tx.insert(loanOpeningBalanceComponents).values(opening.map((component: typeof loanOpeningBalanceComponents.$inferSelect) => ({ tenantId: ctx.tenantId, restructureId: row.id, loanId: row.newLoanId!, componentKind: component.componentKind, amount: component.amount, sourceType: "loan_restructure", sourcePublicId: row.publicId, status: "reversed", createdByUserId: ctx.actorUserId })));
        const initialWaivers = await tx.select().from(loanRestructureWaivers).where(and(eq(loanRestructureWaivers.tenantId, ctx.tenantId), eq(loanRestructureWaivers.restructureId, row.id), eq(loanRestructureWaivers.status, "executed"), sql`${loanRestructureWaivers.executeIdempotencyKey} LIKE ${`restructure:${row.executeIdempotencyKey}:%`}`));
        for (const waiver of initialWaivers) {
            const waiverAudit = await createAuditLog(tx, { ...auditContext(ctx), entityType: "loan_restructure_waiver", entityId: waiver.publicId, action: "reversed_with_restructure", payload: { reason } });
            await tx.insert(loanRestructureWaivers).values({ tenantId: ctx.tenantId, restructureId: row.id, loanId: row.newLoanId, componentKind: waiver.componentKind, amount: waiver.amount, reason, status: "reversed", reversedWaiverId: waiver.id, actorSource: ctx.actorSource, requestId: ctx.requestId, correlationId: ctx.correlationId, executeIdempotencyKey: `restructure-reversal:${idempotencyKey}:waiver:${waiver.componentKind}`, executeRequestHash: sha({ waiver: waiver.publicId, reason }), reversalIdempotencyKey: `restructure-reversal:${idempotencyKey}:waiver:${waiver.componentKind}`, reversalRequestHash: requestHash, auditPublicId: waiverAudit.publicId, createdByUserId: ctx.actorUserId, reversedByUserId: ctx.actorUserId, executedAt: now, reversedAt: now });
        }
        const externalCredit = await tx.query.transactions.findFirst({ where: and(eq(transactions.tenantId, ctx.tenantId), eq(transactions.loanId, oldLoan.id), eq(transactions.idempotencyKey, `restructure:${row.executeIdempotencyKey}:external-credit`)) });
        if (externalCredit) await tx.insert(transactions).values({ tenantId: ctx.tenantId, ownerUserId: oldLoan.ownerUserId, loanId: oldLoan.id, amount: new Decimal(externalCredit.amount).negated().toFixed(2), principalComponent: new Decimal(externalCredit.principalComponent).negated().toFixed(2), interestComponent: new Decimal(externalCredit.interestComponent).negated().toFixed(2), feeComponent: new Decimal(externalCredit.feeComponent).negated().toFixed(2), penaltyComponent: new Decimal(externalCredit.penaltyComponent).negated().toFixed(2), type: "close_account", entryType: "reversal", reversedTransactionId: externalCredit.id, idempotencyKey: `restructure-reversal:${idempotencyKey}:external-credit`, notes: reason, transactionDate: now, recordedByUserId: ctx.actorUserId });
        await tx.update(loanDisbursementEvents).set({ status: "reversed", reversedAt: now, reversalIdempotencyKey: `restructure-reversal:${idempotencyKey}:draft` }).where(and(eq(loanDisbursementEvents.tenantId, ctx.tenantId), eq(loanDisbursementEvents.loanId, row.newLoanId), eq(loanDisbursementEvents.status, "draft")));
        await tx.update(loans).set({ ...row.preExecutionOldLoanState, updatedAt: now }).where(and(eq(loans.tenantId, ctx.tenantId), eq(loans.id, oldLoan.id)));
        await tx.update(loans).set({ status: "cancelled", outstandingPrincipal: "0.00", outstandingInterest: "0.00", outstandingFees: "0.00", updatedAt: now }).where(and(eq(loans.tenantId, ctx.tenantId), eq(loans.id, row.newLoanId)));
        await tx.update(loanSchedules).set({ status: "cancelled", remainingDue: "0.00", updatedAt: now }).where(and(eq(loanSchedules.tenantId, ctx.tenantId), eq(loanSchedules.loanId, row.newLoanId)));
        const audit = await createAuditLog(tx, { ...auditContext(ctx), entityType: "loan_restructure", entityId: row.publicId, action: "reversed", payload: { reason, blockers } });
        const reversed = await tx.update(loanRestructures).set({ status: "reversed", reversalIdempotencyKey: idempotencyKey, reversalRequestHash: requestHash, reversalActorSource: ctx.actorSource, reversedAuditPublicId: audit.publicId, reversedAt: now, reversedByUserId: ctx.actorUserId, updatedByUserId: ctx.actorUserId, updatedAt: now }).where(and(eq(loanRestructures.tenantId, ctx.tenantId), eq(loanRestructures.id, row.id))).returning().then((rows: Restructure[]) => rows[0]!);
        return presentExecution(tx, reversed, oldLoan);
    });
}
