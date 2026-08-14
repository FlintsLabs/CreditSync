import { and, desc, eq, inArray, sql } from "drizzle-orm";
import Decimal from "decimal.js";
import { db } from "../db";
import { bankLoans, bankProfiles, borrowers, loanDisbursements, loanFundingAllocations, loanInterestAccruals, loanInterestRatePeriods, loanOpeningBalanceComponents, loanRestructures, loanRestructureWaivers, loanSchedules, loans, users } from "../db/schema";
import { canAccessTenantWideData } from "../lib/access";
import { createAuditLog } from "../lib/audit-log";
import {
    calculatePublicLoanSchedule,
    normalizePublicLoanTerms,
    type PublicLoanCalculationParams,
    type RepaymentType,
    type PublicWeeklyFloatingInterestPreviewFields,
} from "../lib/calculator";
import { generateLoanSchedule } from "../lib/loan-schedule";
import { computeLoanRollup } from "../lib/loan-rollup";
import { serializeMoney } from "../lib/money";
import type { CommandContext } from "./command-context";
import { DomainError } from "./domain-error";
import { calculateDailyInterest, nextInterestDate, normalizeFloatingDailyInterest, type FloatingDailyInterest, type FloatingDailyInterestInput } from "../lib/floating-daily-interest";
import { addBangkokCalendarDays, calculateWeeklyAccruedInterest } from "../lib/floating-interest-period";
import { normalizeDailyLoanEntry, type DailyLoanEntryInput, type NormalizedDailyLoanEntry } from "../lib/daily-loan-entry";
import type { SinglePaymentTerms } from "../lib/single-payment";

type LoanRow = typeof loans.$inferSelect;

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
                rate: new Decimal(row.singlePaymentRetroactiveRate).toFixed(4),
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
    const dailyEntry: DailyLoanEntryMetadata | null = row.dailyEntryMode && row.dailyTermUnit && row.dailyTermValue && row.dailyFlatRatePercent
        ? {
            durationUnit: row.dailyTermUnit as DailyLoanEntryMetadata["durationUnit"],
            durationValue: row.dailyTermValue,
            entryMode: row.dailyEntryMode as DailyLoanEntryMetadata["entryMode"],
            dailyPayment: row.dailyEntryMode === "daily_payment" && row.installmentAmount !== null ? serializeMoney(row.installmentAmount) : null,
            interestInput: row.dailyEntryMode === "daily_interest" && row.dailyInterestInputMode && row.dailyInterestInputValue
                ? { mode: row.dailyInterestInputMode as NonNullable<DailyLoanEntryMetadata["interestInput"]>["mode"], value: row.dailyInterestInputMode === "fixed_amount" ? serializeMoney(row.dailyInterestInputValue) : new Decimal(row.dailyInterestInputValue).toFixed(4) }
                : null,
            flatDailyRatePercent: new Decimal(row.dailyFlatRatePercent).toFixed(4),
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
        floatingDailyInterest: row.dailyInterestMode && row.dailyInterestRate && row.firstDayTreatment
            ? {
                mode: row.dailyInterestMode as FloatingDailyInterest["mode"],
                rate: new Decimal(row.dailyInterestRate).toFixed(4),
                firstDayTreatment: row.firstDayTreatment as FloatingDailyInterest["firstDayTreatment"],
                accrualCycle: (row.floatingAccrualCycle ?? "daily") as "daily" | "weekly",
            }
            : null,
        singlePayment: singlePaymentFor(row),
        dailyEntry,
        dailyLoanCalculation,
        repaymentType: row.repaymentType,
        termMonths: row.termMonths,
        installmentAmount: row.installmentAmount === null ? null : serializeMoney(row.installmentAmount),
        totalInstallments: row.totalInstallments,
        startDate: row.startDate,
        nextDueDate: row.nextDueDate,
        outstandingPrincipal: serializeMoney(row.outstandingPrincipal ?? "0"),
        outstandingInterest: serializeMoney(row.outstandingInterest ?? "0"),
        outstandingFees: serializeMoney(row.outstandingFees ?? "0"),
        status: row.status,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}

function existingDailyEntry(row: LoanRow): DailyLoanEntryInput | undefined {
    if (!row.dailyEntryMode || !row.dailyTermUnit || !row.dailyTermValue) return undefined;
    if (row.dailyEntryMode === "daily_payment" && row.installmentAmount !== null) {
        return { durationUnit: row.dailyTermUnit as DailyLoanEntryInput["durationUnit"], durationValue: row.dailyTermValue, entryMode: "daily_payment", dailyPayment: serializeMoney(row.installmentAmount) };
    }
    if (row.dailyEntryMode === "daily_interest" && row.dailyInterestInputMode && row.dailyInterestInputValue) {
        return {
            durationUnit: row.dailyTermUnit as DailyLoanEntryInput["durationUnit"], durationValue: row.dailyTermValue, entryMode: "daily_interest",
            interestInput: { mode: row.dailyInterestInputMode as NonNullable<DailyLoanEntryInput["interestInput"]>["mode"], value: row.dailyInterestInputMode === "fixed_amount" ? serializeMoney(row.dailyInterestInputValue) : new Decimal(row.dailyInterestInputValue).toFixed(4) },
        };
    }
    return undefined;
}

function existingFloatingPolicy(row: LoanRow): FloatingDailyInterest | undefined {
    if (row.repaymentType !== "floating" || !row.dailyInterestMode || row.dailyInterestRate === null || !row.firstDayTreatment) return undefined;
    return {
        mode: row.dailyInterestMode as FloatingDailyInterest["mode"],
        rate: new Decimal(row.dailyInterestRate).toFixed(4),
        firstDayTreatment: row.firstDayTreatment as FloatingDailyInterest["firstDayTreatment"],
        accrualCycle: (row.floatingAccrualCycle ?? "daily") as "daily" | "weekly",
    };
}

function normalizeTerms(input: PublicLoanCalculationParams): { terms: ReturnType<typeof normalizePublicLoanTerms>; dailyEntry: NormalizedDailyLoanEntry | null } {
    try {
        if (input.dailyEntry !== undefined && input.repaymentType !== "daily") throw new Error("Daily entry requires daily repayment");
        const dailyEntry = input.dailyEntry === undefined ? null : normalizeDailyLoanEntry({ principal: input.principal, ...input.dailyEntry });
        return {
            terms: normalizePublicLoanTerms({
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

function normalizeFloatingPolicy(input: FloatingDailyInterestInput) {
    try {
        return normalizeFloatingDailyInterest(input);
    } catch {
        throw new DomainError("INVALID_LOAN_TERMS", "Floating interest policy is invalid", 400);
    }
}

export function previewLoan(input: PublicLoanCalculationParams) {
    const { terms, dailyEntry } = normalizeTerms(input);
    const policy = input.repaymentType === "floating" && input.floatingDailyInterest
        ? normalizeFloatingPolicy(input.floatingDailyInterest) : null;
    if (input.repaymentType === "floating" && !policy) throw new DomainError("INVALID_LOAN_TERMS", "Floating loans require a daily interest policy", 400);
    if (input.repaymentType !== "floating" && input.floatingDailyInterest) throw new DomainError("INVALID_LOAN_TERMS", "Daily interest policy requires floating repayment", 400);
    try {
        const schedule = calculatePublicLoanSchedule({ ...input, ...terms });
        if (!policy) return { terms, schedule, dailyLoanCalculation: dailyEntry };
        const dailyInterestAtCurrentPrincipal = calculateDailyInterest(terms.principal, policy);
        if (policy.accrualCycle === "weekly") {
            const hasAdvance = policy.firstDayTreatment === "deduct";
            const periodEndDate = addBangkokCalendarDays(input.startDate, 7);
            const weeklyFields: PublicWeeklyFloatingInterestPreviewFields = {
                fullPeriodInterest: dailyInterestAtCurrentPrincipal,
                firstPeriodStartDate: input.startDate,
                advanceInterestAmount: hasAdvance ? dailyInterestAtCurrentPrincipal : "0.00",
                netDisbursement: serializeMoney(new Decimal(terms.principal).minus(hasAdvance ? dailyInterestAtCurrentPrincipal : "0.00")),
                coveredStartDate: hasAdvance ? input.startDate : null,
                coveredEndDate: hasAdvance ? addBangkokCalendarDays(input.startDate, 6) : null,
                firstPeriodDueDate: periodEndDate,
                nextAccrualDate: periodEndDate,
                periodDays: 7,
                advanceInterestRefundPolicy: "non_refundable",
            };
            return { terms, schedule, floatingDailyInterest: policy, ...weeklyFields };
        }
        const firstDayInterest = policy.firstDayTreatment === "deduct" ? dailyInterestAtCurrentPrincipal : "0.00";
        return { terms, schedule, floatingDailyInterest: policy, firstDayInterest, dailyInterestAtCurrentPrincipal, netDisbursement: serializeMoney(new Decimal(terms.principal).minus(firstDayInterest)), nextInterestDate: nextInterestDate(input.startDate, policy.firstDayTreatment, policy.accrualCycle) };
    } catch (error) {
        throw new DomainError("INVALID_LOAN_TERMS", error instanceof Error ? error.message : "Invalid loan terms", 400);
    }
}

export async function getLoanApplication(ctx: CommandContext, publicId: string) {
    const loan = await accessibleLoan(ctx, publicId);
    const base = await presentLoan(loan);
    const [inbound, outbound] = await Promise.all([
        db.query.loanRestructures.findFirst({ where: and(eq(loanRestructures.tenantId, ctx.tenantId), inArray(loanRestructures.status, ["executed", "reversed"]), eq(loanRestructures.newLoanId, loan.id)), orderBy: [desc(loanRestructures.createdAt)] }),
        db.query.loanRestructures.findFirst({ where: and(eq(loanRestructures.tenantId, ctx.tenantId), inArray(loanRestructures.status, ["executed", "reversed"]), eq(loanRestructures.oldLoanId, loan.id)), orderBy: [desc(loanRestructures.createdAt)] }),
    ]);
    if (!inbound && !outbound) return { ...base, restructureLineage: null, openingBalanceComponents: [], restructureWaivers: [] };
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

export async function createLoanDraft(ctx: CommandContext, input: LoanDraftInput) {
    if (input.bankLoanPublicId && input.bankProfilePublicId) {
        throw new DomainError("FUNDING_SOURCE_CONFLICT", "Choose either a drawdown or an own-capital profile", 400);
    }
    const { terms, dailyEntry } = normalizeTerms(input);
    const policy = input.repaymentType === "floating" && input.floatingDailyInterest
        ? normalizeFloatingPolicy(input.floatingDailyInterest) : null;
    if (input.repaymentType === "floating" && !policy) throw new DomainError("INVALID_LOAN_TERMS", "Floating loans require a daily interest policy", 400);
    if (input.repaymentType !== "floating" && input.floatingDailyInterest) throw new DomainError("INVALID_LOAN_TERMS", "Daily interest policy requires floating repayment", 400);
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
            dailyInterestMode: policy?.mode ?? null,
            dailyInterestRate: policy?.rate ?? null,
            firstDayTreatment: policy?.firstDayTreatment ?? null,
            floatingAccrualCycle: policy?.accrualCycle ?? null,
            interestStartDate: policy ? input.startDate : null,
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
            startDate: input.startDate,
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
                rateType: policy.mode,
                rate: policy.rate,
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
    if (input.floatingDailyInterest !== undefined && repaymentType !== "floating") {
        throw new DomainError("INVALID_LOAN_TERMS", "Daily interest policy requires floating repayment", 400);
    }
    if (input.singlePayment !== undefined && repaymentType !== "single_payment") {
        throw new DomainError("INVALID_LOAN_TERMS", "Single-payment terms require single-payment repayment", 400);
    }
    const repaymentTypeChanged = repaymentType !== existing.repaymentType;
    const mergedInput: PublicLoanCalculationParams = {
        principal: input.principal ?? serializeMoney(existing.principalAmount),
        interestRate: input.interestRate ?? serializeMoney(existing.interestRate),
        repaymentType,
        termMonths: input.termMonths ?? existing.termMonths ?? 0,
        totalInstallments: input.totalInstallments ?? (repaymentTypeChanged ? undefined : existing.totalInstallments ?? undefined),
        installmentAmount: input.installmentAmount === undefined
            ? repaymentTypeChanged || existing.installmentAmount === null ? undefined : serializeMoney(existing.installmentAmount)
            : input.installmentAmount,
        startDate: input.startDate ?? existing.startDate ?? new Date().toISOString().slice(0, 10),
        dailyEntry: input.dailyEntry ?? (repaymentTypeChanged ? undefined : existingDailyEntry(existing)),
        floatingDailyInterest: input.floatingDailyInterest ?? (repaymentTypeChanged ? undefined : existingFloatingPolicy(existing)),
        singlePayment: input.singlePayment ?? (repaymentTypeChanged ? undefined : singlePaymentFor(existing) ?? undefined),
    };
    const { terms: merged, dailyEntry } = normalizeTerms(mergedInput);
    const policy = mergedInput.repaymentType === "floating" && mergedInput.floatingDailyInterest
        ? normalizeFloatingPolicy(mergedInput.floatingDailyInterest) : null;
    if (mergedInput.repaymentType === "floating" && !policy) throw new DomainError("INVALID_LOAN_TERMS", "Floating loans require a daily interest policy", 400);
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
            dailyTermUnit: dailyEntry?.durationUnit ?? null,
            dailyTermValue: dailyEntry?.durationValue ?? null,
            dailyEntryMode: dailyEntry?.entryMode ?? null,
            dailyInterestInputMode: dailyEntry?.interestInput?.mode ?? null,
            dailyInterestInputValue: dailyEntry?.interestInput?.value ?? null,
            dailyFlatRatePercent: dailyEntry?.flatDailyRatePercent ?? null,
            dailyInterestMode: policy?.mode ?? null,
            dailyInterestRate: policy?.rate ?? null,
            firstDayTreatment: policy?.firstDayTreatment ?? null,
            floatingAccrualCycle: policy?.accrualCycle ?? null,
            interestStartDate: policy ? mergedInput.startDate : null,
            ...singlePaymentColumns(merged.singlePayment),
            startDate: input.startDate ?? existing.startDate,
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
                rateType: policy.mode,
                rate: policy.rate,
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

export async function activateLoan(
    ctx: CommandContext,
    publicId: string,
    options: { allowedRepaymentTypes?: readonly RepaymentType[] } = {},
) {
    const accessible = await accessibleLoan(ctx, publicId);
    return db.transaction(async (tx) => {
        await tx.execute(sql`SELECT id FROM loans WHERE id = ${accessible.id} AND tenant_id = ${ctx.tenantId} FOR UPDATE`);
        const current = await tx.query.loans.findFirst({
            where: and(eq(loans.id, accessible.id), eq(loans.tenantId, ctx.tenantId)),
        });
        if (!current) throw new DomainError("LOAN_NOT_FOUND", "Loan not found", 404);
        if (options.allowedRepaymentTypes && !options.allowedRepaymentTypes.includes(current.repaymentType as RepaymentType)) {
            throw new DomainError("MCP_LOAN_TYPE_UNSUPPORTED", "This loan type cannot be activated through MCP", 409, {
                repaymentType: current.repaymentType,
            });
        }
        if (current.status === "active") return presentLoan(current);
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
            )).then((rows) => new Decimal(rows[0]?.totalAllocated ?? 0));
            const sourceRemaining = new Decimal(fundingSource.amount).minus(sourceAllocation);
            if (new Decimal(current.principalAmount).gt(sourceRemaining)) {
                throw new DomainError("ALLOCATION_EXCEEDS_DRAWDOWN", "Allocation exceeds remaining drawdown balance", 400, {
                    sourceRemaining: serializeMoney(Decimal.max(0, sourceRemaining)),
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
            )).then((rows) => new Decimal(rows[0]?.totalAllocated ?? 0));
            const sourceRemaining = new Decimal(ownCapitalProfile.creditLimit ?? 0).minus(sourceAllocation);
            if (new Decimal(current.principalAmount).gt(sourceRemaining)) {
                throw new DomainError("ALLOCATION_EXCEEDS_CAPITAL", "Allocation exceeds remaining own-capital balance", 400, {
                    sourceRemaining: serializeMoney(Decimal.max(0, sourceRemaining)),
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
                totalInstallments: current.totalInstallments ?? undefined,
                installmentAmount: current.installmentAmount ?? undefined,
                singlePayment: singlePaymentFor(current) ?? undefined,
            });
        } catch (error) {
            throw new DomainError("INVALID_LOAN_TERMS", error instanceof Error ? error.message : "Invalid loan terms", 400);
        }
        const rollup = generated.length ? computeLoanRollup(generated.map((row) => ({ ...row, status: "pending" }))) : {
            outstandingPrincipal: new Decimal(current.principalAmount),
            outstandingInterest: new Decimal(0),
            outstandingFees: new Decimal(0),
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
        if (current.repaymentType === "floating" && current.dailyInterestMode && current.dailyInterestRate && current.firstDayTreatment && current.interestStartDate) {
            const policy: FloatingDailyInterest = {
                mode: current.dailyInterestMode as FloatingDailyInterest["mode"],
                rate: current.dailyInterestRate,
                firstDayTreatment: current.firstDayTreatment as FloatingDailyInterest["firstDayTreatment"],
                accrualCycle: (current.floatingAccrualCycle ?? "daily") as FloatingDailyInterest["accrualCycle"],
            };
            const initialPeriod = await tx.query.loanInterestRatePeriods.findFirst({ where: and(
                eq(loanInterestRatePeriods.tenantId, ctx.tenantId),
                eq(loanInterestRatePeriods.loanId, current.id),
                eq(loanInterestRatePeriods.effectiveDate, current.interestStartDate),
            ) });
            if (!initialPeriod) throw new DomainError("RATE_PERIOD_MISSING_COVERAGE", "Floating loan has no interest rate for its start date", 409);
            const firstDayInterest = policy.firstDayTreatment === "deduct" ? calculateDailyInterest(current.principalAmount, policy) : "0.00";
            await tx.insert(loanDisbursements).values({ tenantId: ctx.tenantId, loanId: current.id, grossPrincipal: serializeMoney(current.principalAmount), firstDayInterestDeducted: firstDayInterest, netDisbursement: serializeMoney(new Decimal(current.principalAmount).minus(firstDayInterest)), createdByUserId: ctx.actorUserId });
            if (policy.firstDayTreatment === "deduct") {
                if (policy.accrualCycle === "weekly") {
                    await tx.insert(loanInterestAccruals).values(Array.from({ length: 7 }, (_, index) => {
                        const calculated = calculateWeeklyAccruedInterest(current.principalAmount, policy.mode, policy.rate, index + 1);
                        return {
                            tenantId: ctx.tenantId,
                            loanId: current.id,
                            interestRatePeriodId: initialPeriod.id,
                            accrualDate: addBangkokCalendarDays(current.interestStartDate!, index + 1),
                            openingPrincipal: serializeMoney(current.principalAmount),
                            rateMode: policy.mode,
                            rate: policy.rate,
                            periodStartDate: current.interestStartDate,
                            periodEndDate: addBangkokCalendarDays(current.interestStartDate!, 7),
                            periodDayIndex: index + 1,
                            periodDays: 7,
                            cumulativeInterestAmount: calculated.cumulativeAmount,
                            interestAmount: calculated.incrementAmount,
                            paidAmount: calculated.incrementAmount,
                            status: "paid",
                            createdByUserId: ctx.actorUserId,
                        };
                    })).onConflictDoNothing();
                } else {
                    await tx.insert(loanInterestAccruals).values({ tenantId: ctx.tenantId, loanId: current.id, interestRatePeriodId: initialPeriod.id, accrualDate: current.interestStartDate, openingPrincipal: serializeMoney(current.principalAmount), rateMode: policy.mode, rate: policy.rate, interestAmount: firstDayInterest, paidAmount: firstDayInterest, status: "paid", createdByUserId: ctx.actorUserId }).onConflictDoNothing();
                }
            }
        }
        if (fundingSource || ownCapitalProfile) {
            await tx.insert(loanFundingAllocations).values({
                tenantId: ctx.tenantId,
                bankProfileId: fundingSource?.bankProfileId ?? ownCapitalProfile!.id,
                bankLoanId: fundingSource?.id ?? null,
                loanId: current.id,
                allocatedAmount: serializeMoney(current.principalAmount),
                allocationDate: current.startDate ?? new Date().toISOString().slice(0, 10),
                allocationType: "initial",
                note: "Created when loan draft was activated",
                createdByUserId: ctx.actorUserId,
            });
        }
        const row = await tx.update(loans).set({
            status: "active",
            nextDueDate: rollup.nextDueDate ?? undefined,
            outstandingPrincipal: serializeMoney(rollup.outstandingPrincipal),
            outstandingInterest: serializeMoney(rollup.outstandingInterest),
            outstandingFees: serializeMoney(rollup.outstandingFees),
            updatedAt: new Date(),
        }).where(and(eq(loans.id, current.id), eq(loans.tenantId, ctx.tenantId)))
            .returning().then((rows) => rows[0]!);
        const before = await presentLoan(current);
        const after = await presentLoan(row);
        await createAuditLog(tx, {
            ...auditContext(ctx), entityType: "loan", entityId: row.publicId,
            action: "activated", payload: { before, after, scheduleCount: generated.length },
        });
        return after;
    });
}
