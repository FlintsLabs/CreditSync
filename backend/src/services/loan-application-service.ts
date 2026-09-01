import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { db, type DbTransaction } from "../db";
import { auditLogs, bankLoans, bankProfiles, borrowers, loanDisbursements, loanFundingAllocations, loanInterestAccruals, loanInterestRatePeriods, loanOpeningBalanceComponents, loanReplacements, loanRestructures, loanRestructureWaivers, loanSchedules, loans, users } from "../db/schema";
import { canAccessTenantWideData } from "../lib/access";
import { createAuditLog } from "../lib/audit-log";
import {
    calculatePublicLoanSchedule,
    normalizePublicLoanTerms,
    resolvePublicLoanCalculationTerms,
    type PublicLoanCalculationParams,
    type RepaymentType,
    type PublicWeeklyFloatingInterestPreviewFields,
} from "../lib/calculator";
import { generateLoanSchedule } from "../lib/loan-schedule";
import { computeLoanRollup } from "../lib/loan-rollup";
import { serializeMoney } from "../lib/money";
import { FinancialDecimal } from "../lib/financial-decimal";
import {
    calculateAccruedInterest,
    calculatePeriodInterest,
    interestPeriodFor,
    normalizeFloatingInterestPolicy,
    type FloatingInterestPolicy,
} from "../lib/floating-interest-policy";
import type { CommandContext } from "./command-context";
import { DomainError } from "./domain-error";
import {
    calculateDailyInterest,
    nextInterestDate,
    normalizeFloatingDailyInterest,
    type FloatingDailyInterest,
    type FloatingDailyInterestInput,
} from "../lib/floating-daily-interest";
import { normalizeDailyLoanEntry, type DailyLoanEntryInput, type NormalizedDailyLoanEntry } from "../lib/daily-loan-entry";
import type { SinglePaymentTerms } from "../lib/single-payment";

type LoanRow = typeof loans.$inferSelect;

export interface LoanReplacementLineage {
    replacementPublicId: string;
    status: "executed" | "reversed";
    replacedFromPublicId: string | null;
    replacedToPublicId: string | null;
    inbound: { replacementPublicId: string; loanPublicId: string | null; status: "executed" | "reversed" } | null;
    outbound: { replacementPublicId: string; loanPublicId: string | null; status: "executed" | "reversed" } | null;
}

/**
 * Builds public-only replacement lineage for projections. A reversed aggregate
 * remains history; a replacement never reclassifies a loan as paid.
 */
export async function getLoanReplacementLineages(
    tenantId: string,
    loanRows: ReadonlyArray<Pick<LoanRow, "id">>,
): Promise<Map<number, LoanReplacementLineage | null>> {
    const requestedIds = [...new Set(loanRows.map((loan) => loan.id))];
    const result = new Map<number, LoanReplacementLineage | null>(requestedIds.map((id) => [id, null]));
    if (requestedIds.length === 0) return result;

    const [legacyReplacements, restructures] = await Promise.all([
        db.select().from(loanReplacements).where(and(
            eq(loanReplacements.tenantId, tenantId),
            inArray(loanReplacements.status, ["executed", "reversed"]),
            or(
                inArray(loanReplacements.oldLoanId, requestedIds),
                inArray(loanReplacements.replacementLoanId, requestedIds),
            ),
        )),
        db.select().from(loanRestructures).where(and(
            eq(loanRestructures.tenantId, tenantId),
            inArray(loanRestructures.status, ["executed", "reversed"]),
            or(
                inArray(loanRestructures.oldLoanId, requestedIds),
                inArray(loanRestructures.newLoanId, requestedIds),
            ),
        )),
    ]);
    const replacements = [
        ...legacyReplacements.map((replacement) => ({
            publicId: replacement.publicId,
            status: replacement.status,
            oldLoanId: replacement.oldLoanId,
            replacementLoanId: replacement.replacementLoanId,
            createdAt: replacement.createdAt,
        })),
        ...restructures.filter((restructure) => restructure.newLoanId !== null).map((restructure) => ({
            publicId: restructure.publicId,
            status: restructure.status,
            oldLoanId: restructure.oldLoanId,
            replacementLoanId: restructure.newLoanId!,
            createdAt: restructure.createdAt,
        })),
    ].sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
    if (replacements.length === 0) return result;

    const publicIds = new Map((await db.select({ id: loans.id, publicId: loans.publicId }).from(loans).where(and(
        eq(loans.tenantId, tenantId),
        inArray(loans.id, [...new Set(replacements.flatMap((replacement) => [replacement.oldLoanId, replacement.replacementLoanId]))]),
    ))).map((loan) => [loan.id, loan.publicId]));
    const inbound = new Map<number, typeof replacements[number]>();
    const outbound = new Map<number, typeof replacements[number]>();
    for (const replacement of replacements) {
        if (!inbound.has(replacement.replacementLoanId)) inbound.set(replacement.replacementLoanId, replacement);
        if (!outbound.has(replacement.oldLoanId)) outbound.set(replacement.oldLoanId, replacement);
    }
    for (const loanId of requestedIds) {
        const inboundReplacement = inbound.get(loanId);
        const outboundReplacement = outbound.get(loanId);
        if (!inboundReplacement && !outboundReplacement) continue;
        const primary = outboundReplacement ?? inboundReplacement!;
        const status = primary.status as "executed" | "reversed";
        result.set(loanId, {
            replacementPublicId: primary.publicId,
            status,
            replacedFromPublicId: inboundReplacement ? publicIds.get(inboundReplacement.oldLoanId) ?? null : null,
            replacedToPublicId: outboundReplacement ? publicIds.get(outboundReplacement.replacementLoanId) ?? null : null,
            inbound: inboundReplacement ? {
                replacementPublicId: inboundReplacement.publicId,
                loanPublicId: publicIds.get(inboundReplacement.oldLoanId) ?? null,
                status: inboundReplacement.status as "executed" | "reversed",
            } : null,
            outbound: outboundReplacement ? {
                replacementPublicId: outboundReplacement.publicId,
                loanPublicId: publicIds.get(outboundReplacement.replacementLoanId) ?? null,
                status: outboundReplacement.status as "executed" | "reversed",
            } : null,
        });
    }
    return result;
}

type DailyLoanEntryMetadata = Pick<NormalizedDailyLoanEntry, "durationUnit" | "durationValue" | "entryMode" | "dailyPayment" | "interestInput" | "flatDailyRatePercent">;

function singlePaymentFor(row: LoanRow): SinglePaymentTerms | null {
    if (row.repaymentType !== "single_payment"
        || !row.singlePaymentDueDate
        || row.singlePaymentFixedAgreedInterest === null
        || !row.singlePaymentInterestPolicy
        || !row.singlePaymentLatePenaltyMode) return null;
    const latePenalty = row.singlePaymentLatePenaltyMode === "fixed_amount_per_day"
        && row.singlePaymentLatePenaltyAmountPerDay !== null
        && row.singlePaymentLatePenaltyGraceDays !== null
        ? { mode: "fixed_amount_per_day" as const, amountPerDay: serializeMoney(row.singlePaymentLatePenaltyAmountPerDay), graceDays: row.singlePaymentLatePenaltyGraceDays }
        : { mode: "none" as const };
    if (row.singlePaymentInterestPolicy === "greater_of_fixed_or_retroactive"
        && row.singlePaymentRetroactiveRateType
        && row.singlePaymentRetroactiveRate !== null) {
        return {
            dueDate: row.singlePaymentDueDate,
            fixedAgreedInterest: serializeMoney(row.singlePaymentFixedAgreedInterest),
            interestPolicy: "greater_of_fixed_or_retroactive",
            retroactiveInterest: {
                rateType: row.singlePaymentRetroactiveRateType as "percent_per_day" | "per_thousand_per_day",
                rate: new FinancialDecimal(row.singlePaymentRetroactiveRate).toFixed(4),
            },
            latePenalty,
        };
    }
    return {
        dueDate: row.singlePaymentDueDate,
        fixedAgreedInterest: serializeMoney(row.singlePaymentFixedAgreedInterest),
        interestPolicy: "fixed_only",
        latePenalty,
    };
}

function singlePaymentColumns(singlePayment: SinglePaymentTerms | undefined) {
    return {
        singlePaymentDueDate: singlePayment?.dueDate ?? null,
        singlePaymentFixedAgreedInterest: singlePayment?.fixedAgreedInterest ?? null,
        singlePaymentInterestPolicy: singlePayment?.interestPolicy ?? null,
        singlePaymentRetroactiveRateType: singlePayment?.interestPolicy === "greater_of_fixed_or_retroactive"
            ? singlePayment.retroactiveInterest.rateType : null,
        singlePaymentRetroactiveRate: singlePayment?.interestPolicy === "greater_of_fixed_or_retroactive"
            ? singlePayment.retroactiveInterest.rate : null,
        singlePaymentLatePenaltyMode: singlePayment?.latePenalty.mode ?? null,
        singlePaymentLatePenaltyAmountPerDay: singlePayment?.latePenalty.mode === "fixed_amount_per_day"
            ? singlePayment.latePenalty.amountPerDay : null,
        singlePaymentLatePenaltyGraceDays: singlePayment?.latePenalty.mode === "fixed_amount_per_day"
            ? singlePayment.latePenalty.graceDays : null,
    };
}

function floatingPolicyForRow(row: LoanRow): FloatingInterestPolicy | null {
    if (!row.interestPeriodUnit || row.interestPeriodLength === null || row.advanceInterestPeriods === null
        || !row.advanceInterestRefundPolicy || !row.interestPeriodAnchorDate || !row.dailyInterestMode || !row.dailyInterestRate) {
        return null;
    }
    return normalizeFloatingInterestPolicy({
        periodUnit: row.interestPeriodUnit as FloatingInterestPolicy["periodUnit"],
        periodLength: row.interestPeriodLength as FloatingInterestPolicy["periodLength"],
        rateMode: row.dailyInterestMode as FloatingInterestPolicy["rateMode"],
        rate: row.dailyInterestRate,
        advanceInterestPeriods: row.advanceInterestPeriods as FloatingInterestPolicy["advanceInterestPeriods"],
        advanceInterestRefundPolicy: row.advanceInterestRefundPolicy as FloatingInterestPolicy["advanceInterestRefundPolicy"],
    });
}

function floatingDailyInterestForPolicy(policy: FloatingInterestPolicy): FloatingDailyInterest {
    return {
        mode: policy.rateMode,
        rate: policy.rate,
        firstDayTreatment: policy.advanceInterestPeriods === 1 ? "deduct" : "start_next_day",
        accrualCycle: policy.periodUnit === "week" ? "weekly" : "daily",
    };
}

function floatingPolicyFromDaily(input: FloatingDailyInterestInput): FloatingInterestPolicy {
    const daily = normalizeFloatingDailyInterest(input);
    return normalizeFloatingInterestPolicy({
        periodUnit: daily.accrualCycle === "weekly" ? "week" : "day",
        periodLength: 1,
        rateMode: daily.mode,
        rate: daily.rate,
        advanceInterestPeriods: daily.firstDayTreatment === "deduct" ? 1 : 0,
        advanceInterestRefundPolicy: "non_refundable",
    });
}

function normalizeInputPolicy(input: PublicLoanCalculationParams) {
    if (input.repaymentType !== "floating") {
        if (input.floatingInterestPolicy !== undefined || input.floatingDailyInterest !== undefined) {
            throw new DomainError("INVALID_LOAN_TERMS", "Floating interest policy requires floating repayment", 400);
        }
        return null;
    }
    if (!input.floatingInterestPolicy && !input.floatingDailyInterest) {
        throw new DomainError("INVALID_LOAN_TERMS", "Floating loans require a floating interest policy", 400);
    }
    let generalized: FloatingInterestPolicy | null;
    let legacy: FloatingInterestPolicy | null;
    try {
        generalized = input.floatingInterestPolicy
            ? normalizeFloatingInterestPolicy(input.floatingInterestPolicy)
            : null;
        legacy = input.floatingDailyInterest
            ? floatingPolicyFromDaily(input.floatingDailyInterest)
            : null;
    } catch {
        throw new DomainError("INVALID_LOAN_TERMS", "Floating interest policy is invalid", 400);
    }
    if (generalized && legacy && JSON.stringify(generalized) !== JSON.stringify(legacy)) {
        throw new DomainError("INVALID_LOAN_TERMS", "Floating interest policy inputs conflict", 400);
    }
    return generalized ?? legacy!;
}

function addCalendarDays(date: string, days: number) {
    const value = new Date(`${date}T00:00:00.000Z`);
    value.setUTCDate(value.getUTCDate() + days);
    return value.toISOString().slice(0, 10);
}

export interface LoanDraftInput extends PublicLoanCalculationParams {
    borrowerPublicId: string;
    bankLoanPublicId?: string | null;
    bankProfilePublicId?: string | null;
}

export type LoanDraftUpdateInput = Partial<LoanDraftInput>;

function auditContext(ctx: CommandContext) {
    return {
        tenantId: ctx.tenantId,
        actorUserId: ctx.actorUserId,
        actorSource: ctx.actorSource,
        requestId: ctx.requestId,
        correlationId: ctx.correlationId,
    };
}

async function actorFor(ctx: CommandContext) {
    if (ctx.actorUserId === null) return null;
    const actor = await db.query.users.findFirst({
        where: and(eq(users.id, ctx.actorUserId), eq(users.tenantId, ctx.tenantId)),
    });
    if (!actor) throw new DomainError("ACTOR_NOT_FOUND", "Actor is not available in this tenant", 403);
    return actor;
}

async function loanAccessConditions(ctx: CommandContext) {
    const actor = await actorFor(ctx);
    const conditions = [eq(loans.tenantId, ctx.tenantId)];
    if (actor && !canAccessTenantWideData({ role: actor.role ?? "viewer" })) {
        conditions.push(eq(loans.ownerUserId, actor.id));
    }
    return conditions;
}

async function accessibleLoan(ctx: CommandContext, publicId: string) {
    const row = await db.query.loans.findFirst({
        where: and(eq(loans.publicId, publicId), ...(await loanAccessConditions(ctx))),
    });
    if (!row) throw new DomainError("LOAN_NOT_FOUND", "Loan not found", 404);
    return row;
}

async function accessibleBorrower(ctx: CommandContext, publicId: string) {
    const actor = await actorFor(ctx);
    const conditions = [eq(borrowers.tenantId, ctx.tenantId), eq(borrowers.publicId, publicId)];
    if (actor && !canAccessTenantWideData({ role: actor.role ?? "viewer" })) {
        conditions.push(eq(borrowers.ownerUserId, actor.id));
    }
    const row = await db.query.borrowers.findFirst({ where: and(...conditions) });
    if (!row) throw new DomainError("BORROWER_NOT_FOUND", "Borrower not found", 404);
    return row;
}

async function bankLoanFor(ctx: CommandContext, publicId?: string | null) {
    if (!publicId) return null;
    const actor = await actorFor(ctx);
    if (actor && !canAccessTenantWideData({ role: actor.role ?? "viewer" })) {
        throw new DomainError("FORBIDDEN", "Funding sources require tenant-wide access", 403);
    }
    const row = await db.query.bankLoans.findFirst({
        where: and(eq(bankLoans.publicId, publicId), eq(bankLoans.tenantId, ctx.tenantId)),
    });
    if (!row) throw new DomainError("BANK_LOAN_NOT_FOUND", "Funding source drawdown not found", 404);
    return row;
}

async function ownCapitalProfileFor(ctx: CommandContext, publicId?: string | null) {
    if (!publicId) return null;
    const actor = await actorFor(ctx);
    if (actor && !canAccessTenantWideData({ role: actor.role ?? "viewer" })) {
        throw new DomainError("FORBIDDEN", "Funding sources require tenant-wide access", 403);
    }
    const row = await db.query.bankProfiles.findFirst({
        where: and(eq(bankProfiles.publicId, publicId), eq(bankProfiles.tenantId, ctx.tenantId)),
    });
    if (!row) throw new DomainError("BANK_PROFILE_NOT_FOUND", "Funding profile not found", 404);
    if (row.status !== "active" || row.accountingMode !== "capital_pool") {
        throw new DomainError("INVALID_CAPITAL_SOURCE", "Funding profile must be an active own-capital pool", 400);
    }
    return row;
}

export async function presentLoan(row: LoanRow) {
    const [borrower, bankLoan, fundingProfile] = await Promise.all([
        db.query.borrowers.findFirst({ where: and(eq(borrowers.id, row.borrowerId), eq(borrowers.tenantId, row.tenantId)) }),
        row.bankLoanId === null ? null : db.query.bankLoans.findFirst({
            where: and(eq(bankLoans.id, row.bankLoanId), eq(bankLoans.tenantId, row.tenantId)),
        }),
        row.fundingBankProfileId === null ? null : db.query.bankProfiles.findFirst({
            where: and(eq(bankProfiles.id, row.fundingBankProfileId), eq(bankProfiles.tenantId, row.tenantId)),
        }),
    ]);
    const principal = serializeMoney(row.principalAmount);
    const interestRate = serializeMoney(row.interestRate);
    const floatingInterestPolicy = floatingPolicyForRow(row);
    const floatingPayoutSummary = floatingInterestPolicy && row.startDate
        ? (() => {
            const fullPeriodInterest = calculatePeriodInterest(principal, floatingInterestPolicy);
            const advanceInterest = floatingInterestPolicy.advanceInterestPeriods === 1 ? fullPeriodInterest : "0.00";
            const firstPeriod = interestPeriodFor(row.startDate, row.startDate, floatingInterestPolicy);
            return {
                fullPeriodInterest,
                advanceInterest,
                netBorrowerPayout: serializeMoney(new FinancialDecimal(principal).minus(advanceInterest)),
                periodDays: firstPeriod.periodDays,
                firstPeriodStartDate: firstPeriod.periodStart,
                firstPeriodDueDate: firstPeriod.nextPeriodStart,
            };
        })()
        : null;
    const dailyEntry: DailyLoanEntryMetadata | null = row.dailyEntryMode && row.dailyTermUnit && row.dailyTermValue && row.dailyFlatRatePercent
        ? {
            durationUnit: row.dailyTermUnit as DailyLoanEntryMetadata["durationUnit"],
            durationValue: row.dailyTermValue,
            entryMode: row.dailyEntryMode as DailyLoanEntryMetadata["entryMode"],
            dailyPayment: row.dailyEntryMode === "daily_payment" && row.installmentAmount !== null ? serializeMoney(row.installmentAmount) : null,
            interestInput: row.dailyEntryMode === "daily_interest" && row.dailyInterestInputMode && row.dailyInterestInputValue
                ? { mode: row.dailyInterestInputMode as NonNullable<DailyLoanEntryMetadata["interestInput"]>["mode"], value: row.dailyInterestInputMode === "fixed_amount" ? serializeMoney(row.dailyInterestInputValue) : new FinancialDecimal(row.dailyInterestInputValue).toFixed(4) }
                : null,
            flatDailyRatePercent: new FinancialDecimal(row.dailyFlatRatePercent).toFixed(4),
        }
        : null;
    const dailyLoanCalculation = dailyEntry === null
        ? null
        : normalizeDailyLoanEntry({
            principal,
            durationUnit: dailyEntry.durationUnit,
            durationValue: dailyEntry.durationValue,
            entryMode: dailyEntry.entryMode,
            ...(dailyEntry.dailyPayment === null ? {} : { dailyPayment: dailyEntry.dailyPayment }),
            ...(dailyEntry.interestInput === null ? {} : { interestInput: dailyEntry.interestInput }),
        });
    return {
        id: row.publicId,
        publicId: row.publicId,
        borrowerPublicId: borrower?.publicId ?? null,
        bankLoanPublicId: bankLoan?.publicId ?? null,
        bankProfilePublicId: fundingProfile?.publicId ?? null,
        principal,
        principalAmount: principal,
        interestRate,
        floatingInterestPolicy,
        floatingPayoutSummary,
        floatingDailyInterest: floatingInterestPolicy ? floatingDailyInterestForPolicy(floatingInterestPolicy) : null,
        singlePayment: singlePaymentFor(row),
        dailyEntry,
        dailyLoanCalculation,
        repaymentType: row.repaymentType,
        termMonths: row.termMonths,
        installmentAmount: row.installmentAmount === null ? null : serializeMoney(row.installmentAmount),
        totalInstallments: row.totalInstallments,
        scheduledInstallmentMode: row.scheduledInstallmentMode,
        startDate: row.startDate,
        nextDueDate: row.nextDueDate,
        paymentStartDate: row.paymentStartDate,
        outstandingPrincipal: serializeMoney(row.outstandingPrincipal ?? "0"),
        outstandingInterest: serializeMoney(row.outstandingInterest ?? "0"),
        outstandingFees: serializeMoney(row.outstandingFees ?? "0"),
        status: row.status,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}

type PresentedLoan = Awaited<ReturnType<typeof presentLoan>>;

function storedActivationResult(value: unknown): PresentedLoan {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new DomainError("ACTIVATION_COMMAND_CORRUPT", "Stored loan activation result is unavailable", 409);
    }
    const stored = value as PresentedLoan & { createdAt: Date | string | null; updatedAt: Date | string | null };
    return {
        ...stored,
        createdAt: stored.createdAt === null ? null : new Date(stored.createdAt),
        updatedAt: stored.updatedAt === null ? null : new Date(stored.updatedAt),
    };
}

function activationIdempotencyConflict() {
    return new DomainError("IDEMPOTENCY_KEY_CONFLICT", "Idempotency key is already bound to another loan activation command", 409);
}

function existingDailyEntry(row: LoanRow): DailyLoanEntryInput | undefined {
    if (!row.dailyEntryMode || !row.dailyTermUnit || !row.dailyTermValue) return undefined;
    if (row.dailyEntryMode === "daily_payment" && row.installmentAmount !== null) {
        return { durationUnit: row.dailyTermUnit as DailyLoanEntryInput["durationUnit"], durationValue: row.dailyTermValue, entryMode: "daily_payment", dailyPayment: serializeMoney(row.installmentAmount) };
    }
    if (row.dailyEntryMode === "daily_interest" && row.dailyInterestInputMode && row.dailyInterestInputValue) {
        return {
            durationUnit: row.dailyTermUnit as DailyLoanEntryInput["durationUnit"], durationValue: row.dailyTermValue, entryMode: "daily_interest",
            interestInput: { mode: row.dailyInterestInputMode as NonNullable<DailyLoanEntryInput["interestInput"]>["mode"], value: row.dailyInterestInputMode === "fixed_amount" ? serializeMoney(row.dailyInterestInputValue) : new FinancialDecimal(row.dailyInterestInputValue).toFixed(4) },
        };
    }
    return undefined;
}

function normalizeTerms(input: PublicLoanCalculationParams): { terms: ReturnType<typeof normalizePublicLoanTerms>; dailyEntry: NormalizedDailyLoanEntry | null } {
    try {
        if (input.dailyEntry !== undefined && input.repaymentType !== "daily") throw new Error("Daily entry requires daily repayment");
        const dailyEntry = input.dailyEntry === undefined ? null : normalizeDailyLoanEntry({ principal: input.principal, ...input.dailyEntry });
        return {
            terms: resolvePublicLoanCalculationTerms({
                ...input,
                interestRate: dailyEntry ? "0.00" : input.interestRate,
                termMonths: dailyEntry?.termMonths ?? input.termMonths,
                totalInstallments: dailyEntry?.totalInstallments ?? input.totalInstallments,
                installmentAmount: dailyEntry?.installmentAmount ?? input.installmentAmount,
            }),
            dailyEntry,
        };
    } catch (error) {
        throw new DomainError("INVALID_LOAN_TERMS", error instanceof Error ? error.message : "Invalid loan terms", 400);
    }
}

export function previewLoan(input: PublicLoanCalculationParams) {
    const { terms, dailyEntry } = normalizeTerms(input);
    const policy = normalizeInputPolicy(input);
    try {
        const schedule = calculatePublicLoanSchedule({ ...input, ...terms });
        if (!policy) return { terms, schedule, dailyLoanCalculation: dailyEntry };
        const fullPeriodInterest = calculatePeriodInterest(terms.principal, policy);
        const advanceInterest = policy.advanceInterestPeriods === 1 ? fullPeriodInterest : "0.00";
        const firstPeriod = interestPeriodFor(input.startDate, input.startDate, policy);
        const floatingDailyInterest = floatingDailyInterestForPolicy(policy);
        const netBorrowerPayout = serializeMoney(new FinancialDecimal(terms.principal).minus(advanceInterest));
        const common = {
            terms,
            schedule,
            floatingInterestPolicy: policy,
            floatingDailyInterest,
            fullPeriodInterest,
            advanceInterest,
            netBorrowerPayout,
            firstPeriodStartDate: firstPeriod.periodStart,
            firstPeriodDueDate: firstPeriod.nextPeriodStart,
            periodDays: firstPeriod.periodDays,
        };
        if (policy.periodUnit === "week") {
            const weeklyFields: PublicWeeklyFloatingInterestPreviewFields = {
                fullPeriodInterest,
                firstPeriodStartDate: firstPeriod.periodStart,
                advanceInterestAmount: advanceInterest,
                netDisbursement: netBorrowerPayout,
                coveredStartDate: policy.advanceInterestPeriods === 1 ? firstPeriod.periodStart : null,
                coveredEndDate: policy.advanceInterestPeriods === 1 ? addCalendarDays(firstPeriod.periodStart, 6) : null,
                firstPeriodDueDate: firstPeriod.nextPeriodStart,
                nextAccrualDate: firstPeriod.nextPeriodStart,
                periodDays: 7,
                advanceInterestRefundPolicy: "non_refundable",
            };
            if (input.floatingDailyInterest !== undefined && input.floatingInterestPolicy === undefined) {
                return {
                    terms,
                    schedule,
                    floatingInterestPolicy: policy,
                    floatingDailyInterest,
                    ...weeklyFields,
                };
            }
            return { ...common, ...weeklyFields };
        }
        const dailyInterestAtCurrentPrincipal = calculateDailyInterest(terms.principal, floatingDailyInterest);
        return {
            ...common,
            firstDayInterest: advanceInterest,
            dailyInterestAtCurrentPrincipal,
            netDisbursement: netBorrowerPayout,
            nextInterestDate: nextInterestDate(input.startDate, floatingDailyInterest.firstDayTreatment, floatingDailyInterest.accrualCycle),
        };
    } catch (error) {
        throw new DomainError("INVALID_LOAN_TERMS", error instanceof Error ? error.message : "Invalid loan terms", 400);
    }
}

export async function getLoanApplication(ctx: CommandContext, publicId: string) {
    const loan = await accessibleLoan(ctx, publicId);
    const base = await presentLoan(loan);
    const [inbound, outbound, replacementLineages] = await Promise.all([
        db.query.loanRestructures.findFirst({ where: and(eq(loanRestructures.tenantId, ctx.tenantId), inArray(loanRestructures.status, ["executed", "reversed"]), eq(loanRestructures.newLoanId, loan.id)), orderBy: [desc(loanRestructures.createdAt)] }),
        db.query.loanRestructures.findFirst({ where: and(eq(loanRestructures.tenantId, ctx.tenantId), inArray(loanRestructures.status, ["executed", "reversed"]), eq(loanRestructures.oldLoanId, loan.id)), orderBy: [desc(loanRestructures.createdAt)] }),
        getLoanReplacementLineages(ctx.tenantId, [loan]),
    ]);
    const replacementLineage = replacementLineages.get(loan.id) ?? null;
    if (!inbound && !outbound) return { ...base, replacementLineage, restructureLineage: null, openingBalanceComponents: [], restructureWaivers: [] };
    const [inboundOldLoan, outboundNewLoan, opening, waivers] = await Promise.all([
        inbound ? db.query.loans.findFirst({ where: and(eq(loans.tenantId, ctx.tenantId), eq(loans.id, inbound.oldLoanId)) }) : null,
        outbound?.newLoanId ? db.query.loans.findFirst({ where: and(eq(loans.tenantId, ctx.tenantId), eq(loans.id, outbound.newLoanId)) }) : null,
        inbound ? db.select().from(loanOpeningBalanceComponents).where(and(eq(loanOpeningBalanceComponents.tenantId, ctx.tenantId), eq(loanOpeningBalanceComponents.restructureId, inbound.id), eq(loanOpeningBalanceComponents.loanId, loan.id))).orderBy(loanOpeningBalanceComponents.id) : [],
        inbound ? db.select().from(loanRestructureWaivers).where(and(eq(loanRestructureWaivers.tenantId, ctx.tenantId), eq(loanRestructureWaivers.restructureId, inbound.id), eq(loanRestructureWaivers.loanId, loan.id))).orderBy(loanRestructureWaivers.id) : [],
    ]);
    // Preserve the legacy scalar contract: when a loan has been restructured
    // onward, the latest matching aggregate is its outbound transition. The
    // structured fields below retain both directions independently.
    const primary = outbound ?? inbound!;
    return {
        ...base,
        replacementLineage,
        restructureLineage: {
            restructurePublicId: primary.publicId,
            status: primary.status,
            restructuredFromPublicId: inboundOldLoan?.publicId ?? null,
            restructuredToPublicId: outboundNewLoan?.publicId ?? null,
            inbound: inbound ? { restructurePublicId: inbound.publicId, loanPublicId: inboundOldLoan?.publicId ?? null, status: inbound.status } : null,
            outbound: outbound ? { restructurePublicId: outbound.publicId, loanPublicId: outboundNewLoan?.publicId ?? null, status: outbound.status } : null,
        },
        openingBalanceComponents: opening.map(component => ({ publicId: component.publicId, kind: component.componentKind, amount: serializeMoney(component.amount), status: component.status, sourceType: component.sourceType, sourcePublicId: component.sourcePublicId })),
        restructureWaivers: waivers.map(waiver => ({ publicId: waiver.publicId, component: waiver.componentKind, amount: serializeMoney(waiver.amount), reason: waiver.reason, status: waiver.status, auditPublicId: waiver.auditPublicId, executedAt: waiver.executedAt, reversedAt: waiver.reversedAt })),
    };
}

export async function getLoanContract(ctx: CommandContext, publicId: string) {
    const loan = await accessibleLoan(ctx, publicId);
    const [application, scheduleRows] = await Promise.all([
        getLoanApplication(ctx, publicId),
        db.select().from(loanSchedules).where(and(
            eq(loanSchedules.tenantId, ctx.tenantId),
            eq(loanSchedules.loanId, loan.id),
        )).orderBy(loanSchedules.installmentNo),
    ]);
    const { replacementLineage: _replacementLineage, restructureLineage: _restructureLineage, openingBalanceComponents: _openingBalanceComponents, restructureWaivers: _restructureWaivers, ...contract } = application;
    return {
        ...contract,
        schedule: scheduleRows.map((row) => ({
            id: row.publicId,
            publicId: row.publicId,
            installmentNo: row.installmentNo,
            dueDate: row.dueDate,
            scheduledPrincipal: serializeMoney(row.scheduledPrincipal),
            scheduledInterest: serializeMoney(row.scheduledInterest),
            scheduledFee: serializeMoney(row.scheduledFee),
            scheduledTotal: serializeMoney(row.scheduledTotal),
            paidTotal: serializeMoney(row.paidTotal),
            paidPenalty: serializeMoney(row.paidPenalty),
            overdueDays: row.overdueDays,
            remainingDue: serializeMoney(row.remainingDue),
            status: row.status,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
        })),
    };
}

export interface UpdateLoanPaymentStartDateInput {
    paymentStartDate: string;
    reason: string;
}

export interface DeleteLoanDraftInput {
    reason: string;
}

/** Permanently removes an unactivated draft after retaining an audit event. */
export async function deleteLoanDraft(ctx: CommandContext, publicId: string, input: DeleteLoanDraftInput) {
    const idempotencyKey = ctx.idempotencyKey?.trim();
    if (!idempotencyKey) {
        throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", "Draft deletion requires a non-blank Idempotency-Key", 400);
    }
    const prior = await db.select({ publicId: auditLogs.publicId }).from(auditLogs).where(and(
        eq(auditLogs.tenantId, ctx.tenantId),
        eq(auditLogs.entityType, "loan"),
        eq(auditLogs.entityId, publicId),
        eq(auditLogs.action, "draft_deleted"),
        sql`${auditLogs.payload}->>'idempotencyKey' = ${idempotencyKey}`,
    )).orderBy(desc(auditLogs.createdAt)).limit(1);
    if (prior[0]) {
        return { loanPublicId: publicId, status: "deleted" as const, auditPublicId: prior[0].publicId, correlationId: ctx.correlationId };
    }
    const accessible = await accessibleLoan(ctx, publicId);
    if (accessible.status !== "draft") {
        throw new DomainError("LOAN_DRAFT_DELETE_FORBIDDEN", "Only draft loan contracts can be deleted", 409);
    }

    return db.transaction(async (tx) => {
        const current = await tx.query.loans.findFirst({ where: and(
            eq(loans.id, accessible.id),
            eq(loans.tenantId, ctx.tenantId),
        ) });
        if (!current) {
            const replay = await tx.select({ publicId: auditLogs.publicId }).from(auditLogs).where(and(
                eq(auditLogs.tenantId, ctx.tenantId),
                eq(auditLogs.entityType, "loan"),
                eq(auditLogs.entityId, publicId),
                eq(auditLogs.action, "draft_deleted"),
                sql`${auditLogs.payload}->>'idempotencyKey' = ${idempotencyKey}`,
            )).limit(1);
            if (replay[0]) return { loanPublicId: publicId, status: "deleted" as const, auditPublicId: replay[0].publicId, correlationId: ctx.correlationId };
            throw new DomainError("LOAN_NOT_FOUND", "Loan not found", 404);
        }
        if (current.status !== "draft") {
            throw new DomainError("LOAN_DRAFT_DELETE_FORBIDDEN", "Only draft loan contracts can be deleted", 409);
        }
        const schedules = await tx.select({ id: loanSchedules.id }).from(loanSchedules).where(and(eq(loanSchedules.tenantId, ctx.tenantId), eq(loanSchedules.loanId, current.id)));
        if (schedules.length > 0) {
            throw new DomainError("LOAN_DRAFT_HAS_DEPENDENCIES", "Draft has repayment schedule rows and cannot be deleted", 409);
        }
        await tx.delete(loanInterestRatePeriods).where(and(
            eq(loanInterestRatePeriods.tenantId, ctx.tenantId),
            eq(loanInterestRatePeriods.loanId, current.id),
        ));
        const audit = await createAuditLog(tx, {
            ...auditContext(ctx),
            entityType: "loan",
            entityId: current.publicId,
            action: "draft_deleted",
            payload: { before: await presentLoan(current), reason: input.reason, idempotencyKey },
        });
        try {
            await tx.delete(loans).where(and(eq(loans.tenantId, ctx.tenantId), eq(loans.id, current.id)));
        } catch {
            throw new DomainError("LOAN_DRAFT_HAS_DEPENDENCIES", "Draft has financial or workflow records and cannot be deleted", 409);
        }
        return { loanPublicId: publicId, status: "deleted" as const, auditPublicId: audit.publicId, correlationId: ctx.correlationId };
    });
}

/**
 * Amend the first repayment date without deleting a contract or rewriting
 * posted payment history. Paid schedule rows remain immutable; only unpaid
 * rows receive the new due dates derived from the requested start date.
 */
export async function updateLoanPaymentStartDate(
    ctx: CommandContext,
    publicId: string,
    input: UpdateLoanPaymentStartDateInput,
) {
    const accessible = await accessibleLoan(ctx, publicId);
    if (!['daily', 'weekly', 'monthly'].includes(accessible.repaymentType)) {
        throw new DomainError("INVALID_LOAN_TERMS", "Payment start date can only be changed for scheduled loans", 400);
    }
    if (!ctx.idempotencyKey?.trim()) {
        throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", "Payment start date changes require a non-blank Idempotency-Key", 400);
    }

    const normalized = normalizePublicLoanTerms({
        principal: serializeMoney(accessible.principalAmount),
        interestRate: serializeMoney(accessible.interestRate),
        termMonths: accessible.termMonths ?? 1,
        repaymentType: accessible.repaymentType as RepaymentType,
        startDate: accessible.startDate ?? input.paymentStartDate,
        paymentStartDate: input.paymentStartDate,
        totalInstallments: accessible.totalInstallments ?? undefined,
        installmentAmount: accessible.installmentAmount === null ? undefined : serializeMoney(accessible.installmentAmount),
    });
    const generated = generateLoanSchedule({
        principal: normalized.principal,
        interestRate: normalized.interestRate,
        termMonths: normalized.termMonths,
        repaymentType: normalized.repaymentType,
        startDate: normalized.startDate,
        paymentStartDate: normalized.paymentStartDate,
        totalInstallments: normalized.totalInstallments,
        installmentAmount: normalized.installmentAmount,
    });

    return db.transaction(async (tx) => {
        const current = await tx.query.loans.findFirst({
            where: and(eq(loans.id, accessible.id), eq(loans.tenantId, ctx.tenantId)),
        });
        if (!current) throw new DomainError("LOAN_NOT_FOUND", "Loan not found", 404);
        const repeated = await tx.select({ publicId: auditLogs.publicId }).from(auditLogs).where(and(
            eq(auditLogs.tenantId, ctx.tenantId),
            eq(auditLogs.entityType, "loan"),
            eq(auditLogs.entityId, current.publicId),
            eq(auditLogs.action, "payment_start_date_changed"),
            sql`${auditLogs.payload}->>'idempotencyKey' = ${ctx.idempotencyKey!.trim()}`,
        )).orderBy(desc(auditLogs.createdAt)).limit(1);
        if (repeated[0]) {
            return { ...await presentLoan(current), auditPublicId: repeated[0].publicId, correlationId: ctx.correlationId };
        }
        const existingSchedule = await tx.select().from(loanSchedules).where(and(
            eq(loanSchedules.tenantId, ctx.tenantId),
            eq(loanSchedules.loanId, current.id),
        )).orderBy(loanSchedules.installmentNo);
        const paidRows = existingSchedule.filter((row) => new FinancialDecimal(row.paidTotal).greaterThan(0));
        const lastPaid = paidRows.at(-1);
        const firstUnpaid = existingSchedule.find((row) => new FinancialDecimal(row.paidTotal).equals(0));
        if (lastPaid && firstUnpaid) {
            const generatedFirstUnpaid = generated.find((row) => row.installmentNo === firstUnpaid.installmentNo);
            if (generatedFirstUnpaid && generatedFirstUnpaid.dueDate <= lastPaid.dueDate) {
                throw new DomainError("SCHEDULE_CHANGE_CONFLICT", "New payment start date must keep unpaid installments after the last paid installment", 409);
            }
        }
        const changedSchedule: Array<{ installmentNo: number; before: string; after: string }> = [];
        for (const row of existingSchedule) {
            if (new FinancialDecimal(row.paidTotal).greaterThan(0)) continue;
            const replacement = generated.find((candidate) => candidate.installmentNo === row.installmentNo);
            if (!replacement || replacement.dueDate === row.dueDate) continue;
            await tx.update(loanSchedules).set({ dueDate: replacement.dueDate, updatedAt: new Date() }).where(and(
                eq(loanSchedules.tenantId, ctx.tenantId),
                eq(loanSchedules.id, row.id),
            ));
            changedSchedule.push({ installmentNo: row.installmentNo, before: row.dueDate, after: replacement.dueDate });
        }
        const updated = await tx.update(loans).set({ paymentStartDate: normalized.paymentStartDate, updatedAt: new Date() }).where(and(
            eq(loans.tenantId, ctx.tenantId),
            eq(loans.id, current.id),
        )).returning().then((rows) => rows[0]);
        if (!updated) throw new DomainError("LOAN_NOT_FOUND", "Loan not found", 404);
        const audit = await createAuditLog(tx, {
            ...auditContext(ctx),
            entityType: "loan",
            entityId: updated.publicId,
            action: "payment_start_date_changed",
            payload: {
                before: { paymentStartDate: current.paymentStartDate },
                after: { paymentStartDate: updated.paymentStartDate },
                changedSchedule,
                reason: input.reason,
                idempotencyKey: ctx.idempotencyKey!.trim(),
            },
        });
        return { ...await presentLoan(updated), auditPublicId: audit.publicId, correlationId: ctx.correlationId };
    });
}

export async function createLoanDraft(ctx: CommandContext, input: LoanDraftInput) {
    if (input.bankLoanPublicId && input.bankProfilePublicId) {
        throw new DomainError("FUNDING_SOURCE_CONFLICT", "Choose either a drawdown or an own-capital profile", 400);
    }
    const { terms, dailyEntry } = normalizeTerms(input);
    const policy = normalizeInputPolicy(input);
    const [borrower, bankLoan, fundingProfile] = await Promise.all([
        accessibleBorrower(ctx, input.borrowerPublicId),
        bankLoanFor(ctx, input.bankLoanPublicId),
        ownCapitalProfileFor(ctx, input.bankProfilePublicId),
    ]);
    return db.transaction(async (tx) => {
        const row = await tx.insert(loans).values({
            tenantId: ctx.tenantId,
            ownerUserId: ctx.actorUserId,
            borrowerId: borrower.id,
            bankLoanId: bankLoan?.id ?? null,
            fundingBankProfileId: fundingProfile?.id ?? null,
            dailyInterestMode: policy?.rateMode ?? null,
            dailyInterestRate: policy?.rate ?? null,
            firstDayTreatment: policy ? policy.advanceInterestPeriods === 1 ? "deduct" : "start_next_day" : null,
            interestStartDate: policy ? input.startDate : null,
            interestPeriodUnit: policy?.periodUnit ?? null,
            interestPeriodLength: policy?.periodLength ?? null,
            advanceInterestPeriods: policy?.advanceInterestPeriods ?? null,
            advanceInterestRefundPolicy: policy?.advanceInterestRefundPolicy ?? null,
            interestPeriodAnchorDate: policy ? input.startDate : null,
            floatingAccrualCycle: policy ? policy.periodUnit === "week" ? "weekly" : "daily" : null,
            dailyTermUnit: dailyEntry?.durationUnit ?? null,
            dailyTermValue: dailyEntry?.durationValue ?? null,
            dailyEntryMode: dailyEntry?.entryMode ?? null,
            dailyInterestInputMode: dailyEntry?.interestInput?.mode ?? null,
            dailyInterestInputValue: dailyEntry?.interestInput?.value ?? null,
            dailyFlatRatePercent: dailyEntry?.flatDailyRatePercent ?? null,
            ...singlePaymentColumns(terms.singlePayment),
            principalAmount: terms.principal,
            interestRate: terms.interestRate,
            repaymentType: terms.repaymentType,
            termMonths: terms.repaymentType === "floating" ? null : terms.termMonths,
            totalInstallments: terms.totalInstallments ?? null,
            installmentAmount: terms.installmentAmount ?? null,
            scheduledInstallmentMode: terms.scheduledInstallmentMode ?? null,
            startDate: input.startDate,
            paymentStartDate: input.paymentStartDate ?? null,
            outstandingPrincipal: "0.00",
            outstandingInterest: "0.00",
            outstandingFees: "0.00",
            status: "draft",
        }).returning().then((rows) => rows[0]!);
        if (policy) {
            await tx.insert(loanInterestRatePeriods).values({
                tenantId: ctx.tenantId,
                loanId: row.id,
                effectiveDate: input.startDate,
                expiryDate: null,
                rateType: policy.rateMode,
                rate: policy.rate,
                periodUnit: policy.periodUnit,
                periodLength: policy.periodLength,
                createdByUserId: ctx.actorUserId,
            });
        }
        const after = await presentLoan(row);
        await createAuditLog(tx, {
            ...auditContext(ctx), entityType: "loan", entityId: row.publicId,
            action: "draft_created", payload: { before: null, after },
        });
        return after;
    });
}

export async function updateLoanDraft(ctx: CommandContext, publicId: string, input: LoanDraftUpdateInput) {
    const existing = await accessibleLoan(ctx, publicId);
    if (existing.status !== "draft") {
        throw new DomainError("LOAN_TERMS_LOCKED", "Active loan terms are immutable", 409);
    }
    const currentBorrower = await db.query.borrowers.findFirst({
        where: and(eq(borrowers.id, existing.borrowerId), eq(borrowers.tenantId, ctx.tenantId)),
    });
    const borrower = input.borrowerPublicId === undefined
        ? currentBorrower!
        : await accessibleBorrower(ctx, input.borrowerPublicId);
    const currentBankLoan = existing.bankLoanId === null ? null : await db.query.bankLoans.findFirst({
        where: and(eq(bankLoans.id, existing.bankLoanId), eq(bankLoans.tenantId, ctx.tenantId)),
    });
    const bankLoan = input.bankLoanPublicId === undefined
        ? currentBankLoan
        : await bankLoanFor(ctx, input.bankLoanPublicId);
    const currentFundingProfile = existing.fundingBankProfileId === null ? null : await db.query.bankProfiles.findFirst({
        where: and(eq(bankProfiles.id, existing.fundingBankProfileId), eq(bankProfiles.tenantId, ctx.tenantId)),
    });
    const fundingProfile = input.bankProfilePublicId === undefined
        ? currentFundingProfile
        : await ownCapitalProfileFor(ctx, input.bankProfilePublicId);
    if (bankLoan && fundingProfile) {
        throw new DomainError("FUNDING_SOURCE_CONFLICT", "Choose either a drawdown or an own-capital profile", 400);
    }
    const repaymentType = (input.repaymentType ?? existing.repaymentType) as RepaymentType;
    if (input.dailyEntry !== undefined && repaymentType !== "daily") {
        throw new DomainError("INVALID_LOAN_TERMS", "Daily entry requires daily repayment", 400);
    }
    if ((input.floatingInterestPolicy !== undefined || input.floatingDailyInterest !== undefined) && repaymentType !== "floating") {
        throw new DomainError("INVALID_LOAN_TERMS", "Floating interest policy requires floating repayment", 400);
    }
    if (input.singlePayment !== undefined && repaymentType !== "single_payment") {
        throw new DomainError("INVALID_LOAN_TERMS", "Single-payment terms require single-payment repayment", 400);
    }
    const repaymentTypeChanged = repaymentType !== existing.repaymentType;
    const existingFloatingInterestPolicy = floatingPolicyForRow(existing);
    const suppliedFloatingPolicy = input.floatingInterestPolicy !== undefined || input.floatingDailyInterest !== undefined;
    const mergedInput: PublicLoanCalculationParams = {
        principal: input.principal ?? serializeMoney(existing.principalAmount),
        interestRate: input.interestRate ?? serializeMoney(existing.interestRate),
        repaymentType,
        termMonths: input.termMonths ?? existing.termMonths ?? 1,
        totalInstallments: input.totalInstallments ?? (repaymentTypeChanged ? undefined : existing.totalInstallments ?? undefined),
        installmentAmount: input.installmentAmount === undefined
            ? repaymentTypeChanged || existing.installmentAmount === null || existing.scheduledInstallmentMode === "rate_derived"
                ? undefined
                : serializeMoney(existing.installmentAmount)
            : input.installmentAmount,
        // An amount supplied by a draft-update command is a new fixed-total
        // instruction unless the caller explicitly selects another mode. Do
        // not inherit a stored rate-derived mode across that semantic change.
        scheduledInstallmentMode: input.scheduledInstallmentMode
            ?? (input.installmentAmount === undefined && !repaymentTypeChanged
                ? existing.scheduledInstallmentMode as "rate_derived" | "fixed_total" | null ?? undefined
                : undefined),
        startDate: input.startDate ?? existing.startDate ?? new Date().toISOString().slice(0, 10),
        paymentStartDate: input.paymentStartDate ?? (repaymentTypeChanged ? undefined : existing.paymentStartDate ?? undefined),
        dailyEntry: input.dailyEntry ?? (repaymentTypeChanged ? undefined : existingDailyEntry(existing)),
        floatingInterestPolicy: repaymentType === "floating"
            ? input.floatingInterestPolicy ?? (!suppliedFloatingPolicy && !repaymentTypeChanged ? existingFloatingInterestPolicy ?? undefined : undefined)
            : input.floatingInterestPolicy,
        floatingDailyInterest: input.floatingDailyInterest,
        singlePayment: input.singlePayment ?? (repaymentTypeChanged ? undefined : singlePaymentFor(existing) ?? undefined),
    };
    if (repaymentType !== "daily") delete mergedInput.dailyEntry;
    const { terms: merged, dailyEntry } = normalizeTerms(mergedInput);
    const policy = normalizeInputPolicy(mergedInput);
    return db.transaction(async (tx) => {
        const row = await tx.update(loans).set({
            borrowerId: borrower.id,
            bankLoanId: bankLoan?.id ?? null,
            fundingBankProfileId: fundingProfile?.id ?? null,
            principalAmount: merged.principal,
            interestRate: merged.interestRate,
            repaymentType: merged.repaymentType,
            termMonths: merged.repaymentType === "floating" ? null : merged.termMonths,
            totalInstallments: merged.totalInstallments ?? null,
            installmentAmount: merged.installmentAmount ?? null,
            scheduledInstallmentMode: merged.scheduledInstallmentMode ?? null,
            dailyInterestMode: policy?.rateMode ?? null,
            dailyInterestRate: policy?.rate ?? null,
            firstDayTreatment: policy ? policy.advanceInterestPeriods === 1 ? "deduct" : "start_next_day" : null,
            interestStartDate: policy ? mergedInput.startDate : null,
            interestPeriodUnit: policy?.periodUnit ?? null,
            interestPeriodLength: policy?.periodLength ?? null,
            advanceInterestPeriods: policy?.advanceInterestPeriods ?? null,
            advanceInterestRefundPolicy: policy?.advanceInterestRefundPolicy ?? null,
            interestPeriodAnchorDate: policy ? mergedInput.startDate : null,
            floatingAccrualCycle: policy ? policy.periodUnit === "week" ? "weekly" : "daily" : null,
            dailyTermUnit: dailyEntry?.durationUnit ?? null,
            dailyTermValue: dailyEntry?.durationValue ?? null,
            dailyEntryMode: dailyEntry?.entryMode ?? null,
            dailyInterestInputMode: dailyEntry?.interestInput?.mode ?? null,
            dailyInterestInputValue: dailyEntry?.interestInput?.value ?? null,
            dailyFlatRatePercent: dailyEntry?.flatDailyRatePercent ?? null,
            ...singlePaymentColumns(merged.singlePayment),
            startDate: input.startDate ?? existing.startDate,
            paymentStartDate: merged.repaymentType === "daily" || merged.repaymentType === "weekly" || merged.repaymentType === "monthly"
                ? input.paymentStartDate ?? existing.paymentStartDate
                : null,
            updatedAt: new Date(),
        }).where(and(
            eq(loans.id, existing.id),
            eq(loans.tenantId, ctx.tenantId),
            eq(loans.status, "draft"),
        )).returning().then((rows) => rows[0]);
        if (!row) throw new DomainError("LOAN_TERMS_LOCKED", "Active loan terms are immutable", 409);
        await tx.delete(loanInterestRatePeriods).where(and(
            eq(loanInterestRatePeriods.tenantId, ctx.tenantId),
            eq(loanInterestRatePeriods.loanId, row.id),
        ));
        if (policy) {
            await tx.insert(loanInterestRatePeriods).values({
                tenantId: ctx.tenantId,
                loanId: row.id,
                effectiveDate: mergedInput.startDate,
                expiryDate: null,
                rateType: policy.rateMode,
                rate: policy.rate,
                periodUnit: policy.periodUnit,
                periodLength: policy.periodLength,
                createdByUserId: ctx.actorUserId,
            });
        }
        const before = await presentLoan(existing);
        const after = await presentLoan(row);
        await createAuditLog(tx, {
            ...auditContext(ctx), entityType: "loan", entityId: row.publicId,
            action: "draft_updated", payload: { before, after },
        });
        return after;
    });
}

export async function activateLoan(ctx: CommandContext, publicId: string) {
    const idempotencyKey = ctx.idempotencyKey?.trim();
    if (!idempotencyKey) {
        throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", "Loan activation requires a non-blank Idempotency-Key", 400);
    }
    const accessible = await accessibleLoan(ctx, publicId);
    return db.transaction(async (tx) => activateLoanInTransaction(tx, ctx, accessible));
}

/**
 * The transaction-aware activation primitive is intentionally the single owner
 * of contract schedule generation and initial funding allocation.  Composite
 * financial workflows must call it from their outer transaction rather than
 * opening a second transaction around activation.
 */
export async function activateLoanInTransaction(
    tx: DbTransaction,
    ctx: CommandContext,
    accessible: LoanRow,
    options: { replacementPublicId?: string; topUpPartialFunding?: boolean } = {},
) {
    const idempotencyKey = ctx.idempotencyKey?.trim();
    if (!idempotencyKey) {
        throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", "Loan activation requires a non-blank Idempotency-Key", 400);
    }
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`loan-activation:${ctx.tenantId}:${idempotencyKey}`}, 0))`);
        const existingCommand = await tx.query.loans.findFirst({ where: and(
            eq(loans.tenantId, ctx.tenantId),
            eq(loans.activationIdempotencyKey, idempotencyKey),
        ) });
        if (existingCommand) {
            if (existingCommand.id !== accessible.id) throw activationIdempotencyConflict();
            return storedActivationResult(existingCommand.activationResult);
        }
        await tx.execute(sql`SELECT id FROM loans WHERE id = ${accessible.id} AND tenant_id = ${ctx.tenantId} FOR UPDATE`);
        const current = await tx.query.loans.findFirst({
            where: and(eq(loans.id, accessible.id), eq(loans.tenantId, ctx.tenantId)),
        });
        if (!current) throw new DomainError("LOAN_NOT_FOUND", "Loan not found", 404);
        if (current.status === "active" || current.activationIdempotencyKey !== null) {
            throw activationIdempotencyConflict();
        }
        if (current.status !== "draft") {
            throw new DomainError("LOAN_NOT_ACTIVATABLE", "Only draft loans can be activated", 409);
        }
        if (current.termMonths === null && current.repaymentType !== "floating") {
            throw new DomainError("INVALID_LOAN_TERMS", "Draft term months are required", 400);
        }

        let fundingSource: typeof bankLoans.$inferSelect | null = null;
        let ownCapitalProfile: typeof bankProfiles.$inferSelect | null = null;
        if (current.bankLoanId) {
            const lockedSource = await tx.execute(sql`SELECT id FROM bank_loans
                WHERE id = ${current.bankLoanId} AND tenant_id = ${ctx.tenantId} FOR UPDATE`);
            if (!lockedSource.length) {
                throw new DomainError("BANK_LOAN_NOT_FOUND", "Funding source drawdown not found", 404);
            }
            fundingSource = await tx.query.bankLoans.findFirst({
                where: and(eq(bankLoans.id, current.bankLoanId), eq(bankLoans.tenantId, ctx.tenantId)),
            }) ?? null;
            if (!fundingSource) {
                throw new DomainError("BANK_LOAN_NOT_FOUND", "Funding source drawdown not found", 404);
            }
            const sourceAllocation = await tx.select({
                totalAllocated: sql<string>`coalesce(sum(${loanFundingAllocations.allocatedAmount}), 0)`,
            }).from(loanFundingAllocations).where(and(
                eq(loanFundingAllocations.bankLoanId, fundingSource.id),
                eq(loanFundingAllocations.tenantId, ctx.tenantId),
            )).then((rows: Array<{ totalAllocated: string | null }>) => new FinancialDecimal(rows[0]?.totalAllocated ?? "0"));
            const sourceRemaining = new FinancialDecimal(fundingSource.amount).minus(sourceAllocation);
            const existingLoanAllocation = await tx.select({ totalAllocated: sql<string>`coalesce(sum(${loanFundingAllocations.allocatedAmount}), 0)` })
                .from(loanFundingAllocations).where(and(
                    eq(loanFundingAllocations.loanId, current.id), eq(loanFundingAllocations.tenantId, ctx.tenantId),
                )).then((rows: Array<{ totalAllocated: string | null }>) => new FinancialDecimal(rows[0]?.totalAllocated ?? "0"));
            const requiredAllocation = FinancialDecimal.max(new FinancialDecimal(0), new FinancialDecimal(current.principalAmount).minus(existingLoanAllocation));
            if (requiredAllocation.gt(sourceRemaining)) {
                throw new DomainError("ALLOCATION_EXCEEDS_DRAWDOWN", "Allocation exceeds remaining drawdown balance", 400, {
                    sourceRemaining: serializeMoney(FinancialDecimal.max(new FinancialDecimal("0"), sourceRemaining)),
                });
            }
        }
        if (current.fundingBankProfileId) {
            const lockedSource = await tx.execute(sql`SELECT id FROM bank_profiles
                WHERE id = ${current.fundingBankProfileId} AND tenant_id = ${ctx.tenantId} FOR UPDATE`);
            if (!lockedSource.length) throw new DomainError("BANK_PROFILE_NOT_FOUND", "Funding profile not found", 404);
            ownCapitalProfile = await tx.query.bankProfiles.findFirst({
                where: and(eq(bankProfiles.id, current.fundingBankProfileId), eq(bankProfiles.tenantId, ctx.tenantId)),
            }) ?? null;
            if (!ownCapitalProfile) throw new DomainError("BANK_PROFILE_NOT_FOUND", "Funding profile not found", 404);
            if (ownCapitalProfile.status !== "active" || ownCapitalProfile.accountingMode !== "capital_pool") {
                throw new DomainError("INVALID_CAPITAL_SOURCE", "Funding profile must be an active own-capital pool", 400);
            }
            const sourceAllocation = await tx.select({
                totalAllocated: sql<string>`coalesce(sum(${loanFundingAllocations.allocatedAmount}), 0)`,
            }).from(loanFundingAllocations).where(and(
                eq(loanFundingAllocations.bankProfileId, ownCapitalProfile.id),
                eq(loanFundingAllocations.tenantId, ctx.tenantId),
            )).then((rows: Array<{ totalAllocated: string | null }>) => new FinancialDecimal(rows[0]?.totalAllocated ?? "0"));
            const sourceRemaining = new FinancialDecimal(ownCapitalProfile.creditLimit ?? "0").minus(sourceAllocation);
            const existingLoanAllocation = await tx.select({ totalAllocated: sql<string>`coalesce(sum(${loanFundingAllocations.allocatedAmount}), 0)` })
                .from(loanFundingAllocations).where(and(
                    eq(loanFundingAllocations.loanId, current.id), eq(loanFundingAllocations.tenantId, ctx.tenantId),
                )).then((rows: Array<{ totalAllocated: string | null }>) => new FinancialDecimal(rows[0]?.totalAllocated ?? "0"));
            const requiredAllocation = FinancialDecimal.max(new FinancialDecimal(0), new FinancialDecimal(current.principalAmount).minus(existingLoanAllocation));
            if (requiredAllocation.gt(sourceRemaining)) {
                throw new DomainError("ALLOCATION_EXCEEDS_CAPITAL", "Allocation exceeds remaining own-capital balance", 400, {
                    sourceRemaining: serializeMoney(FinancialDecimal.max(new FinancialDecimal("0"), sourceRemaining)),
                });
            }
        }

        let generated;
        try {
            generated = current.repaymentType === "floating" ? [] : generateLoanSchedule({
                principal: current.principalAmount,
                interestRate: current.interestRate,
                termMonths: current.termMonths!,
                repaymentType: current.repaymentType as RepaymentType,
                startDate: current.startDate ?? undefined,
                paymentStartDate: current.paymentStartDate ?? undefined,
                totalInstallments: current.totalInstallments ?? undefined,
                installmentAmount: current.installmentAmount ?? undefined,
                scheduledInstallmentMode: current.scheduledInstallmentMode === null
                    ? undefined
                    : current.scheduledInstallmentMode as "rate_derived" | "fixed_total",
                singlePayment: singlePaymentFor(current) ?? undefined,
            });
        } catch (error) {
            throw new DomainError("INVALID_LOAN_TERMS", error instanceof Error ? error.message : "Invalid loan terms", 400);
        }
        const rollup = generated.length ? computeLoanRollup(generated.map((row) => ({ ...row, status: "pending" }))) : {
            outstandingPrincipal: new FinancialDecimal(current.principalAmount),
            outstandingInterest: new FinancialDecimal("0"),
            outstandingFees: new FinancialDecimal("0"),
            nextDueDate: null,
        };
        if (generated.length) {
            await tx.insert(loanSchedules).values(generated.map((row) => ({
                tenantId: ctx.tenantId,
                loanId: current.id,
                installmentNo: row.installmentNo,
                dueDate: row.dueDate,
                scheduledPrincipal: row.scheduledPrincipal,
                scheduledInterest: row.scheduledInterest,
                scheduledFee: row.scheduledFee,
                scheduledTotal: row.scheduledTotal,
                paidTotal: "0.00",
                remainingDue: row.remainingDue,
                status: "pending",
            })));
        }
        let advanceInterest = "0.00";
        let netBorrowerPayout = serializeMoney(current.principalAmount);
        let advanceInterestSnapshotCount = 0;
        const policy = floatingPolicyForRow(current);
        if (current.repaymentType === "floating") {
            if (!policy || !current.interestPeriodAnchorDate) {
                throw new DomainError("INVALID_LOAN_TERMS", "Floating loan has no complete interest policy", 409);
            }
            const initialPeriod = await tx.query.loanInterestRatePeriods.findFirst({ where: and(
                eq(loanInterestRatePeriods.tenantId, ctx.tenantId),
                eq(loanInterestRatePeriods.loanId, current.id),
                eq(loanInterestRatePeriods.effectiveDate, current.interestPeriodAnchorDate),
            ) });
            if (!initialPeriod) throw new DomainError("RATE_PERIOD_MISSING_COVERAGE", "Floating loan has no interest rate for its start date", 409);
            const firstPeriod = interestPeriodFor(current.interestPeriodAnchorDate, current.interestPeriodAnchorDate, policy);
            const fullPeriodInterest = calculatePeriodInterest(current.principalAmount, policy);
            advanceInterest = policy.advanceInterestPeriods === 1 ? fullPeriodInterest : "0.00";
            netBorrowerPayout = serializeMoney(new FinancialDecimal(current.principalAmount).minus(advanceInterest));
            await tx.insert(loanDisbursements).values({ tenantId: ctx.tenantId, loanId: current.id, grossPrincipal: serializeMoney(current.principalAmount), firstDayInterestDeducted: advanceInterest, netDisbursement: netBorrowerPayout, createdByUserId: ctx.actorUserId });
            if (policy.advanceInterestPeriods === 1) {
                const snapshots = Array.from({ length: firstPeriod.periodDays }, (_, index) => {
                    const elapsedDays = index + 1;
                    const accrued = calculateAccruedInterest(current.principalAmount, policy, elapsedDays);
                    return {
                        tenantId: ctx.tenantId,
                        loanId: current.id,
                        interestRatePeriodId: initialPeriod.id,
                        accrualDate: addCalendarDays(firstPeriod.periodStart, index),
                        openingPrincipal: serializeMoney(current.principalAmount),
                        rateMode: policy.rateMode,
                        rate: policy.rate,
                        interestAmount: accrued.incrementAmount,
                        periodStartDate: firstPeriod.periodStart,
                        periodEndDate: firstPeriod.nextPeriodStart,
                        periodDayIndex: elapsedDays,
                        periodDays: firstPeriod.periodDays,
                        periodUnit: policy.periodUnit,
                        periodLength: policy.periodLength,
                        contractualInterestAmount: fullPeriodInterest,
                        cumulativeInterestAmount: accrued.cumulativeAmount,
                        dailyIncrementAmount: accrued.incrementAmount,
                        paidAmount: accrued.incrementAmount,
                        status: "paid",
                        createdByUserId: ctx.actorUserId,
                    };
                });
                await tx.insert(loanInterestAccruals).values(snapshots);
                advanceInterestSnapshotCount = snapshots.length;
            }
        }
        const existingFunding = (await tx.select({ total: sql<string>`coalesce(sum(${loanFundingAllocations.allocatedAmount}), 0)` })
            .from(loanFundingAllocations).where(and(
                eq(loanFundingAllocations.tenantId, ctx.tenantId),
                eq(loanFundingAllocations.loanId, current.id),
            )))[0]?.total ?? "0";
        const existingFundingAmount = new FinancialDecimal(existingFunding);
        const allocationAmount = existingFundingAmount.isZero()
            ? new FinancialDecimal(current.principalAmount)
            : options.topUpPartialFunding
                ? FinancialDecimal.max(
                    new FinancialDecimal(0),
                    new FinancialDecimal(current.principalAmount).minus(existingFundingAmount),
                )
                : new FinancialDecimal(0);
        if ((fundingSource || ownCapitalProfile) && allocationAmount.gt(0)) {
            await tx.insert(loanFundingAllocations).values({
                tenantId: ctx.tenantId,
                bankProfileId: fundingSource?.bankProfileId ?? ownCapitalProfile!.id,
                bankLoanId: fundingSource?.id ?? null,
                loanId: current.id,
                allocatedAmount: serializeMoney(allocationAmount),
                allocationDate: current.startDate ?? new Date().toISOString().slice(0, 10),
                allocationType: "initial",
                note: "Created when loan draft was activated",
                createdByUserId: ctx.actorUserId,
            });
        }
        const updatedAt = new Date();
        const activatedState = {
            ...current,
            status: "active",
            nextDueDate: rollup.nextDueDate ?? current.nextDueDate,
            outstandingPrincipal: serializeMoney(rollup.outstandingPrincipal),
            outstandingInterest: serializeMoney(rollup.outstandingInterest),
            outstandingFees: serializeMoney(rollup.outstandingFees),
            updatedAt,
        } as LoanRow;
        const before = await presentLoan(current);
        const after = await presentLoan(activatedState);
        const row = await tx.update(loans).set({
            status: activatedState.status,
            nextDueDate: activatedState.nextDueDate,
            outstandingPrincipal: activatedState.outstandingPrincipal,
            outstandingInterest: activatedState.outstandingInterest,
            outstandingFees: activatedState.outstandingFees,
            activationIdempotencyKey: idempotencyKey,
            activationResult: after,
            updatedAt,
        }).where(and(eq(loans.id, current.id), eq(loans.tenantId, ctx.tenantId), eq(loans.status, "draft")))
            .returning().then((rows: LoanRow[]) => rows[0]);
        if (!row) throw new DomainError("LOAN_NOT_ACTIVATABLE", "Only draft loans can be activated", 409);
        await createAuditLog(tx, {
            ...auditContext(ctx), entityType: "loan", entityId: current.publicId,
            action: "activated", payload: {
                before,
                after,
                scheduleCount: generated.length,
                floatingInterestPolicy: policy,
                advanceInterest,
                netBorrowerPayout,
                advanceInterestSnapshotCount,
                idempotencyKey,
                replacementPublicId: options.replacementPublicId ?? null,
            },
        });
        return after;
}
