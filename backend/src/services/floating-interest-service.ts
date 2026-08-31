import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type Decimal from "decimal.js";
import { db } from "../db";
import {
    floatingPenaltyLedgerEntries,
    floatingTransactionAllocations,
    loanAdjustments,
    loanInterestAccruals,
    loanInterestRatePeriods,
    loans,
    transactions,
} from "../db/schema";
import { createAuditLog } from "../lib/audit-log";
import { FinancialDecimal } from "../lib/financial-decimal";
import {
    calculateDailyInterest,
    interestDatesThrough,
    type FloatingAccrualCycle,
    type FloatingDailyInterest,
} from "../lib/floating-daily-interest";
import {
    calculateAccruedInterest,
    calculatePeriodInterest,
    interestPeriodFor,
    type FloatingInterestPolicy,
} from "../lib/floating-interest-policy";
import { weeklySnapshotPeriod } from "../lib/floating-interest-period";
import { resolveRatePeriod, type RatePeriodValue, type RateType } from "../lib/interest-rate-periods";
import { DomainError } from "./domain-error";
import type { CommandContext } from "./command-context";

type Executor = any;

export type FloatingAccrualMaterializationProvenance = {
    sourcePaymentIntakeId: number;
    sourceReversalTransactionId: number;
    reason: string;
};

/** Returns only payment allocations that have not been compensated by a reversal. */
export async function findActiveFloatingTransactionAllocation(
    executor: Executor,
    tenantId: string,
    loanId: number,
    effectiveDate: string,
) {
    return executor.query.floatingTransactionAllocations.findFirst({ where: and(
        eq(floatingTransactionAllocations.tenantId, tenantId),
        eq(floatingTransactionAllocations.loanId, loanId),
        eq(floatingTransactionAllocations.entryType, "payment"),
        sql`NOT EXISTS (
            SELECT 1 FROM floating_transaction_allocations AS reversal_allocation
            WHERE reversal_allocation.tenant_id = ${tenantId}
              AND reversal_allocation.reversed_allocation_id = "floatingTransactionAllocations"."id"
        )`,
        sql`${floatingTransactionAllocations.effectiveDate} > ${effectiveDate}`,
    ) });
}

function floatingCommandContext(loan: typeof loans.$inferSelect, value: CommandContext | number | null): CommandContext {
    if (typeof value === "object" && value !== null) return value;
    return {
        tenantId: loan.tenantId,
        actorUserId: value,
        actorSource: "system",
        requestId: `legacy-floating-service:${loan.publicId}`,
        correlationId: `legacy-floating-service:${loan.publicId}`,
    };
}

function bangkokDate(value: Date) {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(value);
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value;
    return `${part("year")}-${part("month")}-${part("day")}`;
}

function hasPeriodPolicy(loan: typeof loans.$inferSelect) {
    return (loan.interestPeriodUnit === "day" || loan.interestPeriodUnit === "week")
        && loan.interestPeriodLength === 1
        && (loan.advanceInterestPeriods === 0 || loan.advanceInterestPeriods === 1)
        && loan.advanceInterestRefundPolicy === "non_refundable"
        && loan.interestPeriodAnchorDate !== null;
}

function accrualDateFirstDayTreatment(loan: typeof loans.$inferSelect): FloatingDailyInterest["firstDayTreatment"] {
    if (hasPeriodPolicy(loan) && loan.interestPeriodUnit === "week") return "deduct";
    return loan.firstDayTreatment as FloatingDailyInterest["firstDayTreatment"];
}

function periodPolicy(
    loan: typeof loans.$inferSelect,
    period: typeof loanInterestRatePeriods.$inferSelect,
): FloatingInterestPolicy {
    return {
        periodUnit: loan.interestPeriodUnit as FloatingInterestPolicy["periodUnit"],
        periodLength: loan.interestPeriodLength as 1,
        rateMode: period.rateType as FloatingInterestPolicy["rateMode"],
        rate: period.rate,
        advanceInterestPeriods: loan.advanceInterestPeriods as 0 | 1,
        advanceInterestRefundPolicy: loan.advanceInterestRefundPolicy as "non_refundable",
    };
}

function principalAtStartOfDate(
    loan: typeof loans.$inferSelect,
    rows: Array<typeof transactions.$inferSelect>,
    accrualDate: string,
) {
    const reversedTransactionIds = new Set(rows
        .map((row) => row.reversedTransactionId)
        .filter((id): id is number => id !== null));
    const principalAppliedBefore = rows
        .filter((row) => row.entryType !== "reversal" && !reversedTransactionIds.has(row.id))
        .filter((row) => row.postedAt && row.transactionDate && bangkokDate(row.transactionDate) < accrualDate)
        .reduce((sum, row) => sum.plus(row.principalComponent), new FinancialDecimal(0));
    return FinancialDecimal.max(0, new FinancialDecimal(loan.principalAmount).minus(principalAppliedBefore)).toFixed(2);
}

async function accrueLegacyFloatingInterestThrough(
    tx: Executor,
    loan: typeof loans.$inferSelect,
    throughDate: string,
    actorUserId: number | null,
    provenance?: FloatingAccrualMaterializationProvenance,
) {
    if (!loan.dailyInterestMode || !loan.dailyInterestRate || !loan.firstDayTreatment || !loan.interestStartDate) return [];
    const firstDayTreatment = loan.firstDayTreatment as FloatingDailyInterest["firstDayTreatment"];
    const existing = await tx.select().from(loanInterestAccruals).where(and(
        eq(loanInterestAccruals.tenantId, loan.tenantId),
        eq(loanInterestAccruals.loanId, loan.id),
    ));
    const dates = new Set(existing.filter((row: typeof loanInterestAccruals.$inferSelect) => row.status !== "reversed")
        .map((row: typeof loanInterestAccruals.$inferSelect) => row.accrualDate));
    const accrualCycle = (loan.floatingAccrualCycle ?? "daily") as FloatingAccrualCycle;
    if (accrualCycle === "weekly") {
        const expected = await expectedFloatingAccruals(tx, loan, throughDate);
        const missing = expected.filter((row) => row.id < 0 && !dates.has(row.accrualDate));
        if (missing.length) {
            await tx.insert(loanInterestAccruals).values(missing.map((row) => ({
                tenantId: loan.tenantId,
                loanId: loan.id,
                interestRatePeriodId: row.interestRatePeriodId,
                accrualDate: row.accrualDate,
                openingPrincipal: row.openingPrincipal,
                rateMode: row.rateMode,
                rate: row.rate,
                periodStartDate: row.periodStartDate,
                periodEndDate: row.periodEndDate,
                periodDayIndex: row.periodDayIndex,
                periodDays: row.periodDays,
                periodUnit: row.periodUnit,
                periodLength: row.periodLength,
                contractualInterestAmount: row.contractualInterestAmount,
                cumulativeInterestAmount: row.cumulativeInterestAmount,
                dailyIncrementAmount: row.dailyIncrementAmount,
                interestAmount: row.interestAmount,
                paidAmount: row.paidAmount,
                status: row.status,
                materializationSource: provenance ? "payment_reversal" : undefined,
                sourcePaymentIntakeId: provenance?.sourcePaymentIntakeId,
                sourceReversalTransactionId: provenance?.sourceReversalTransactionId,
                materializationReason: provenance?.reason,
                createdByUserId: actorUserId,
            }))).onConflictDoNothing();
        }
        const completedPeriodStarts = [...new Set(expected
            .filter((row) => row.status === "due" && row.periodStartDate)
            .map((row) => row.periodStartDate!))];
        if (completedPeriodStarts.length) {
            await tx.update(loanInterestAccruals).set({ status: "due" }).where(and(
                eq(loanInterestAccruals.tenantId, loan.tenantId),
                eq(loanInterestAccruals.loanId, loan.id),
                inArray(loanInterestAccruals.periodStartDate, completedPeriodStarts),
                eq(loanInterestAccruals.status, "accruing"),
            ));
        }
        return tx.select().from(loanInterestAccruals).where(and(
            eq(loanInterestAccruals.tenantId, loan.tenantId),
            eq(loanInterestAccruals.loanId, loan.id),
        ));
    }
    const dueDates = interestDatesThrough(loan.interestStartDate, throughDate, firstDayTreatment, accrualCycle).filter((date) => !dates.has(date));
    if (!dueDates.length) return existing;
    const periodRows = await tx.select().from(loanInterestRatePeriods).where(and(
        eq(loanInterestRatePeriods.tenantId, loan.tenantId),
        eq(loanInterestRatePeriods.loanId, loan.id),
    )).orderBy(asc(loanInterestRatePeriods.effectiveDate));
    const periods: RatePeriodValue[] = periodRows.map((row: typeof loanInterestRatePeriods.$inferSelect) => ({
        publicId: row.publicId,
        effectiveDate: row.effectiveDate,
        expiryDate: row.expiryDate,
        rateType: row.rateType as RateType,
        rate: row.rate,
    }));
    const rowByPublicId = new Map<string, typeof loanInterestRatePeriods.$inferSelect>(
        periodRows.map((row: typeof loanInterestRatePeriods.$inferSelect) => [row.publicId, row]),
    );
    const transactionRows = await tx.select().from(transactions).where(and(
        eq(transactions.tenantId, loan.tenantId),
        eq(transactions.loanId, loan.id),
    ));
    const resolved = dueDates.map((accrualDate) => ({ accrualDate, period: resolveRatePeriod(periods, accrualDate) }));
    const missing = resolved.find((item) => item.period === null);
    if (missing) {
        throw new DomainError("RATE_PERIOD_MISSING_COVERAGE", "Floating loan has no interest rate for an accrual date", 409, {
            accrualDate: missing.accrualDate,
            loanPublicId: loan.publicId,
        });
    }
    await tx.insert(loanInterestAccruals).values(resolved.map(({ accrualDate, period }) => {
        const effectivePeriod = period!;
        const storedPeriod = rowByPublicId.get(effectivePeriod.publicId)!;
        const openingPrincipal = principalAtStartOfDate(loan, transactionRows, accrualDate);
        const policy: FloatingDailyInterest = { mode: effectivePeriod.rateType, rate: effectivePeriod.rate, firstDayTreatment, accrualCycle };
        const interestAmount = calculateDailyInterest(openingPrincipal, policy);
        const advancePaid = firstDayTreatment === "deduct" && accrualDate === loan.interestStartDate;
        return {
            tenantId: loan.tenantId,
            loanId: loan.id,
            interestRatePeriodId: storedPeriod.id,
            accrualDate,
            openingPrincipal,
            rateMode: policy.mode,
            rate: policy.rate,
            interestAmount,
            paidAmount: advancePaid ? interestAmount : "0.00",
            status: advancePaid ? "paid" : "accrued",
            createdByUserId: actorUserId,
        };
    })).onConflictDoNothing();
    return tx.select().from(loanInterestAccruals).where(and(
        eq(loanInterestAccruals.tenantId, loan.tenantId),
        eq(loanInterestAccruals.loanId, loan.id),
    ));
}

async function accrueFloatingInterestThroughInTransaction(tx: Executor, loan: typeof loans.$inferSelect, through: Date, ctx: CommandContext, provenance?: FloatingAccrualMaterializationProvenance) {
    if (loan.repaymentType !== "floating") return [];
    if (loan.tenantId !== ctx.tenantId) throw new DomainError("FLOATING_LOAN_NOT_FOUND", "Floating loan not found", 404);
    const throughDate = bangkokDate(through);
    if (!hasPeriodPolicy(loan)) return accrueLegacyFloatingInterestThrough(tx, loan, throughDate, ctx.actorUserId, provenance);
    const anchorDate = loan.interestPeriodAnchorDate!;
    const existing = await tx.select().from(loanInterestAccruals).where(and(
        eq(loanInterestAccruals.tenantId, loan.tenantId),
        eq(loanInterestAccruals.loanId, loan.id),
    )).orderBy(asc(loanInterestAccruals.accrualDate), asc(loanInterestAccruals.id));
    const activeByDate = new Map<string, typeof loanInterestAccruals.$inferSelect>(existing
        .filter((row: typeof loanInterestAccruals.$inferSelect) => row.status !== "reversed")
        .map((row: typeof loanInterestAccruals.$inferSelect) => [row.accrualDate, row]));
    const accrualDates = interestDatesThrough(
        anchorDate,
        throughDate,
        accrualDateFirstDayTreatment(loan),
        "daily",
    );
    const periodRows = await tx.select().from(loanInterestRatePeriods).where(and(
        eq(loanInterestRatePeriods.tenantId, loan.tenantId),
        eq(loanInterestRatePeriods.loanId, loan.id),
    )).orderBy(asc(loanInterestRatePeriods.effectiveDate));
    const periods: RatePeriodValue[] = periodRows.map((row: typeof loanInterestRatePeriods.$inferSelect) => ({
        publicId: row.publicId,
        effectiveDate: row.effectiveDate,
        expiryDate: row.expiryDate,
        rateType: row.rateType as RateType,
        rate: row.rate,
    }));
    const rowByPublicId = new Map<string, typeof loanInterestRatePeriods.$inferSelect>(
        periodRows.map((row: typeof loanInterestRatePeriods.$inferSelect) => [row.publicId, row]),
    );
    const missingDates = accrualDates.filter((date) => !activeByDate.has(date));
    const resolved = missingDates.map((accrualDate) => ({ accrualDate, period: resolveRatePeriod(periods, accrualDate) }));
    const missing = resolved.find((item) => item.period === null);
    if (missing) {
        throw new DomainError("RATE_PERIOD_MISSING_COVERAGE", "Floating loan has no interest rate for an accrual date", 409, {
            accrualDate: missing.accrualDate,
            loanPublicId: loan.publicId,
        });
    }
    const resolvedByDate = new Map(resolved.map((item) => [item.accrualDate, item.period!]));
    const transactionRows = missingDates.length
        ? await tx.select().from(transactions).where(and(eq(transactions.tenantId, loan.tenantId), eq(transactions.loanId, loan.id)))
        : [];
    const inserts: Array<typeof loanInterestAccruals.$inferInsert> = [];
    let previousPeriodKey: string | null = null;
    let previousSegmentKey: string | null = null;
    let segmentElapsedDays = 0;
    let periodCumulative = new FinancialDecimal(0);

    for (const accrualDate of accrualDates) {
        const existingRow = activeByDate.get(accrualDate);
        if (existingRow) {
            const periodKey = existingRow.periodStartDate && existingRow.periodEndDate
                ? `${existingRow.periodStartDate}:${existingRow.periodEndDate}`
                : `legacy:${existingRow.accrualDate}`;
            if (periodKey !== previousPeriodKey) {
                previousPeriodKey = periodKey;
                previousSegmentKey = null;
                segmentElapsedDays = 0;
                periodCumulative = new FinancialDecimal(0);
            }
            const segmentKey = `${periodKey}:${existingRow.interestRatePeriodId ?? "none"}:${existingRow.openingPrincipal}:${existingRow.rateMode}:${existingRow.rate}`;
            if (segmentKey !== previousSegmentKey) {
                previousSegmentKey = segmentKey;
                segmentElapsedDays = 0;
            }
            segmentElapsedDays += 1;
            periodCumulative = existingRow.cumulativeInterestAmount === null
                ? periodCumulative.plus(existingRow.interestAmount)
                : new FinancialDecimal(existingRow.cumulativeInterestAmount);
            continue;
        }

        const effectivePeriod = resolvedByDate.get(accrualDate)!;
        const storedPeriod = rowByPublicId.get(effectivePeriod.publicId)!;
        const policy = periodPolicy(loan, storedPeriod);
        const interestPeriod = interestPeriodFor(anchorDate, accrualDate, policy);
        const periodKey = `${interestPeriod.periodStart}:${interestPeriod.nextPeriodStart}`;
        if (periodKey !== previousPeriodKey) {
            previousPeriodKey = periodKey;
            previousSegmentKey = null;
            segmentElapsedDays = 0;
            periodCumulative = new FinancialDecimal(0);
        }
        const openingPrincipal = principalAtStartOfDate(loan, transactionRows, accrualDate);
        const segmentKey = `${periodKey}:${storedPeriod.id}:${openingPrincipal}:${storedPeriod.rateType}:${storedPeriod.rate}`;
        if (segmentKey !== previousSegmentKey) {
            previousSegmentKey = segmentKey;
            segmentElapsedDays = 0;
        }
        segmentElapsedDays += 1;
        const accrued = calculateAccruedInterest(openingPrincipal, policy, segmentElapsedDays);
        periodCumulative = periodCumulative.plus(accrued.incrementAmount);
        inserts.push({
            tenantId: loan.tenantId,
            loanId: loan.id,
            interestRatePeriodId: storedPeriod.id,
            accrualDate,
            openingPrincipal,
            rateMode: policy.rateMode,
            rate: policy.rate,
            interestAmount: accrued.incrementAmount,
            periodStartDate: interestPeriod.periodStart,
            periodEndDate: interestPeriod.nextPeriodStart,
            periodDayIndex: interestPeriod.dayIndex + 1,
            periodDays: interestPeriod.periodDays,
            periodUnit: policy.periodUnit,
            periodLength: policy.periodLength,
            contractualInterestAmount: calculatePeriodInterest(openingPrincipal, policy),
            cumulativeInterestAmount: periodCumulative.toFixed(2),
            dailyIncrementAmount: accrued.incrementAmount,
            status: policy.periodUnit === "day"
                ? "accrued"
                : interestPeriod.nextPeriodStart <= throughDate ? "due" : "accruing",
            materializationSource: provenance ? "payment_reversal" : undefined,
            sourcePaymentIntakeId: provenance?.sourcePaymentIntakeId,
            sourceReversalTransactionId: provenance?.sourceReversalTransactionId,
            materializationReason: provenance?.reason,
            createdByUserId: ctx.actorUserId,
        });
    }
    if (inserts.length) await tx.insert(loanInterestAccruals).values(inserts).onConflictDoNothing();

    const active = await tx.select().from(loanInterestAccruals).where(and(
        eq(loanInterestAccruals.tenantId, loan.tenantId),
        eq(loanInterestAccruals.loanId, loan.id),
        sql`${loanInterestAccruals.status} <> 'reversed'`,
    )).orderBy(asc(loanInterestAccruals.accrualDate), asc(loanInterestAccruals.id));
    for (const row of active) {
        if (accrualDueDate(row) > throughDate || row.status === "paid") continue;
        const paidAmount = new FinancialDecimal(row.paidAmount);
        const nextStatus = paidAmount.eq(row.interestAmount)
            ? "paid"
            : paidAmount.gt(0)
                ? "partially_paid"
                : row.periodUnit === "day" || row.periodDays === 1
                    ? "accrued"
                    : "due";
        if (row.status !== nextStatus) {
            await tx.update(loanInterestAccruals).set({ status: nextStatus }).where(and(
                eq(loanInterestAccruals.tenantId, loan.tenantId),
                eq(loanInterestAccruals.id, row.id),
            ));
        }
    }
    return tx.select().from(loanInterestAccruals).where(and(
        eq(loanInterestAccruals.tenantId, loan.tenantId),
        eq(loanInterestAccruals.loanId, loan.id),
    )).orderBy(asc(loanInterestAccruals.accrualDate), asc(loanInterestAccruals.id));
}

export async function accrueFloatingInterestThrough(executor: Executor, loan: typeof loans.$inferSelect, through: Date, context: CommandContext | number | null, provenance?: FloatingAccrualMaterializationProvenance) {
    const ctx = floatingCommandContext(loan, context);
    if (loan.repaymentType !== "floating") return [];
    if (loan.tenantId !== ctx.tenantId) {
        throw new DomainError("FLOATING_LOAN_NOT_FOUND", "Floating loan not found", 404);
    }
    const run = async (tx: Executor) => {
        await tx.execute(sql`SELECT id FROM loans
            WHERE tenant_id = ${ctx.tenantId} AND id = ${loan.id} FOR UPDATE`);
        const lockedLoan = await tx.query.loans.findFirst({ where: and(
            eq(loans.tenantId, ctx.tenantId),
            eq(loans.id, loan.id),
        ) });
        if (!lockedLoan || lockedLoan.repaymentType !== "floating") {
            throw new DomainError("FLOATING_LOAN_NOT_FOUND", "Floating loan not found", 404);
        }
        if (lockedLoan.status !== "active") {
            throw new DomainError(
                "FLOATING_LOAN_NOT_ACTIVE",
                "Floating interest can be materialized only for an active loan",
                409,
                { loanPublicId: lockedLoan.publicId, status: lockedLoan.status },
            );
        }
        const before = await tx.select().from(loanInterestAccruals).where(and(
            eq(loanInterestAccruals.tenantId, lockedLoan.tenantId),
            eq(loanInterestAccruals.loanId, lockedLoan.id),
        ));
        const beforeById = new Map<number, typeof loanInterestAccruals.$inferSelect>(before.map(
            (row: typeof loanInterestAccruals.$inferSelect) => [row.id, row],
        ));
        const rows = await accrueFloatingInterestThroughInTransaction(tx, lockedLoan, through, ctx, provenance);
        const inserted = rows.filter((row: typeof loanInterestAccruals.$inferSelect) => !beforeById.has(row.id));
        const promoted = rows.filter((row: typeof loanInterestAccruals.$inferSelect) => {
            const old = beforeById.get(row.id);
            return old !== undefined && old.status !== row.status;
        });
        if (inserted.length || promoted.length) {
            await createAuditLog(tx, {
                tenantId: ctx.tenantId,
                actorUserId: ctx.actorUserId,
                actorSource: ctx.actorSource,
                requestId: ctx.requestId,
                correlationId: ctx.correlationId,
                entityType: "loan",
                entityId: lockedLoan.publicId,
                action: "floating_interest_accruals_materialized",
                payload: {
                    throughDate: bangkokDate(through),
                    idempotencyKey: ctx.idempotencyKey ?? null,
                    insertedAccrualPublicIds: inserted.map((row: typeof loanInterestAccruals.$inferSelect) => row.publicId),
                    promotedAccrualPublicIds: promoted.map((row: typeof loanInterestAccruals.$inferSelect) => row.publicId),
                },
            });
        }
        return rows;
    };
    return executor === db ? db.transaction(run) : run(executor);
}

function accrualDueDate(row: typeof loanInterestAccruals.$inferSelect) {
    return row.status === "accrued" || row.periodUnit === "day" || row.periodDays === 1
        ? row.accrualDate
        : row.periodEndDate ?? row.accrualDate;
}

export function isFloatingAccrualPayableThrough(row: typeof loanInterestAccruals.$inferSelect, throughDate: string) {
    return ["accrued", "due", "partially_paid"].includes(row.status) && accrualDueDate(row) <= throughDate;
}

export async function floatingInterestDue(tx: Executor, loan: typeof loans.$inferSelect, through: Date, context: CommandContext | number | null) {
    const rows = await accrueFloatingInterestThrough(tx, loan, through, context);
    const throughDate = bangkokDate(through);
    const corrupt = rows.find((row: typeof loanInterestAccruals.$inferSelect) =>
        row.status !== "reversed"
        && row.accrualDate <= throughDate
        && new FinancialDecimal(row.openingPrincipal).eq(0)
        && new FinancialDecimal(row.interestAmount).eq(0)
        && new FinancialDecimal(row.rate).gt(0)
        && new FinancialDecimal(loan.outstandingPrincipal ?? loan.principalAmount).gt(0));
    if (corrupt) {
        throw new DomainError("FLOATING_INTEREST_ACCRUAL_CORRUPT", "Floating interest history must be corrected before allocating a payment", 409, {
            loanPublicId: loan.publicId,
            accrualDate: corrupt.accrualDate,
            accrualPublicId: corrupt.publicId,
        });
    }
    return rows.filter((row: typeof loanInterestAccruals.$inferSelect) => isFloatingAccrualPayableThrough(row, throughDate))
        .reduce((total: Decimal, row: typeof loanInterestAccruals.$inferSelect) => total.plus(new FinancialDecimal(row.interestAmount).minus(row.paidAmount)), new FinancialDecimal(0));
}

function assertFloatingAccrualHistory(
    rows: Array<typeof loanInterestAccruals.$inferSelect>,
    loan: typeof loans.$inferSelect,
    throughDate: string,
) {
    const corrupt = rows.find((row) => row.status !== "reversed"
        && row.accrualDate <= throughDate
        && new FinancialDecimal(row.openingPrincipal).eq(0)
        && new FinancialDecimal(row.interestAmount).eq(0)
        && new FinancialDecimal(row.rate).gt(0)
        && new FinancialDecimal(loan.outstandingPrincipal ?? loan.principalAmount).gt(0));
    if (corrupt) {
        throw new DomainError("FLOATING_INTEREST_ACCRUAL_CORRUPT", "Floating interest history must be corrected before allocating a payment", 409, {
            loanPublicId: loan.publicId,
            accrualDate: corrupt.accrualDate,
            accrualPublicId: corrupt.publicId,
        });
    }
}

export type FloatingPenaltyGroup = {
    dueDate: string;
    accruedPenalty: Decimal;
    paidPenalty: Decimal;
    penaltyDue: Decimal;
    interestDue: Decimal;
};

type ProjectedAccrual = typeof loanInterestAccruals.$inferSelect;

type ProjectedPenaltyAssessment = {
    dueDate: string;
    penaltyDate: string;
    entryType: "fixed_assessment" | "daily_percent_accrual";
    amount: Decimal;
    openingInterestBasis: Decimal;
};

function addCalendarDays(date: string, days: number) {
    const value = new Date(`${date}T00:00:00.000Z`);
    value.setUTCDate(value.getUTCDate() + days);
    return value.toISOString().slice(0, 10);
}

function legacyWeeklyPeriodStart(anchorDate: string, accrualDate: string) {
    const elapsedDays = Math.floor((Date.parse(`${accrualDate}T00:00:00Z`) - Date.parse(`${anchorDate}T00:00:00Z`)) / 86_400_000);
    return addCalendarDays(anchorDate, Math.floor(Math.max(0, elapsedDays - 1) / 7) * 7);
}

async function expectedFloatingAccruals(
    tx: Executor,
    loan: typeof loans.$inferSelect,
    throughDate: string,
): Promise<ProjectedAccrual[]> {
    const anchorDate = loan.interestPeriodAnchorDate ?? loan.interestStartDate;
    if (!anchorDate || !loan.firstDayTreatment || !loan.dailyInterestMode || !loan.dailyInterestRate) return [];
    const periodRows = await tx.select().from(loanInterestRatePeriods).where(and(
        eq(loanInterestRatePeriods.tenantId, loan.tenantId),
        eq(loanInterestRatePeriods.loanId, loan.id),
    )).orderBy(asc(loanInterestRatePeriods.effectiveDate));
    const periods: RatePeriodValue[] = periodRows.map((row: typeof loanInterestRatePeriods.$inferSelect) => ({
        publicId: row.publicId,
        effectiveDate: row.effectiveDate,
        expiryDate: row.expiryDate,
        rateType: row.rateType as RateType,
        rate: row.rate,
    }));
    const rowByPublicId = new Map<string, typeof loanInterestRatePeriods.$inferSelect>(
        periodRows.map((row: typeof loanInterestRatePeriods.$inferSelect) => [row.publicId, row]),
    );
    const transactionRows = await tx.select().from(transactions).where(and(
        eq(transactions.tenantId, loan.tenantId),
        eq(transactions.loanId, loan.id),
    ));
    const accrualCycle = (loan.floatingAccrualCycle ?? (loan.interestPeriodUnit === "week" ? "weekly" : "daily")) as FloatingAccrualCycle;
    const generalizedPolicy = hasPeriodPolicy(loan);
    const dates = interestDatesThrough(
        anchorDate,
        throughDate,
        accrualDateFirstDayTreatment(loan),
        generalizedPolicy ? "daily" : accrualCycle,
    );
    let virtualId = -1;
    let previousPeriodKey: string | null = null;
    let previousSegmentKey: string | null = null;
    let segmentElapsedDays = 0;
    let periodCumulative = new FinancialDecimal(0);
    return dates.map((accrualDate) => {
        const resolved = resolveRatePeriod(periods, accrualDate);
        const storedPeriod = resolved ? rowByPublicId.get(resolved.publicId) : undefined;
        if (!resolved || !storedPeriod) {
            throw new DomainError("RATE_PERIOD_MISSING_COVERAGE", "Floating loan has no interest rate for an accrual date", 409, {
                accrualDate,
                loanPublicId: loan.publicId,
            });
        }
        const policy: FloatingInterestPolicy = generalizedPolicy
            ? periodPolicy(loan, storedPeriod)
            : {
                periodUnit: accrualCycle === "weekly" ? "week" : "day",
                periodLength: 1,
                rateMode: resolved.rateType,
                rate: resolved.rate,
                advanceInterestPeriods: loan.firstDayTreatment === "deduct" ? 1 : 0,
                advanceInterestRefundPolicy: "non_refundable",
            };
        const interestPeriod = !generalizedPolicy && accrualCycle === "weekly"
            ? (() => {
                const snapshot = weeklySnapshotPeriod(anchorDate, accrualDate);
                return {
                    periodStart: snapshot.periodStartDate,
                    nextPeriodStart: snapshot.periodEndDate,
                    dayIndex: snapshot.dayIndex - 1,
                    periodDays: snapshot.periodDays,
                };
            })()
            : interestPeriodFor(anchorDate, accrualDate, policy);
        const periodKey = `${interestPeriod.periodStart}:${interestPeriod.nextPeriodStart}`;
        if (periodKey !== previousPeriodKey) {
            previousPeriodKey = periodKey;
            previousSegmentKey = null;
            segmentElapsedDays = 0;
            periodCumulative = new FinancialDecimal(0);
        }
        const openingPrincipal = principalAtStartOfDate(loan, transactionRows, accrualDate);
        const segmentKey = `${periodKey}:${storedPeriod.id}:${openingPrincipal}:${storedPeriod.rateType}:${storedPeriod.rate}`;
        if (segmentKey !== previousSegmentKey) {
            previousSegmentKey = segmentKey;
            segmentElapsedDays = 0;
        }
        segmentElapsedDays += 1;
        const accrued = calculateAccruedInterest(openingPrincipal, policy, segmentElapsedDays);
        periodCumulative = periodCumulative.plus(accrued.incrementAmount);
        const advancePaid = policy.advanceInterestPeriods === 1 && interestPeriod.periodStart === anchorDate;
        return {
            id: virtualId--,
            publicId: `projected:${loan.publicId}:${accrualDate}`,
            tenantId: loan.tenantId,
            loanId: loan.id,
            interestRatePeriodId: storedPeriod.id,
            accrualDate,
            openingPrincipal,
            rateMode: policy.rateMode,
            rate: policy.rate,
            periodStartDate: interestPeriod.periodStart,
            periodEndDate: interestPeriod.nextPeriodStart,
            periodDayIndex: interestPeriod.dayIndex + 1,
            periodDays: interestPeriod.periodDays,
            periodUnit: policy.periodUnit,
            periodLength: policy.periodLength,
            contractualInterestAmount: calculatePeriodInterest(openingPrincipal, policy),
            cumulativeInterestAmount: periodCumulative.toFixed(2),
            dailyIncrementAmount: accrued.incrementAmount,
            interestAmount: accrued.incrementAmount,
            paidAmount: advancePaid ? accrued.incrementAmount : "0.00",
            accruedPenalty: "0.00",
            paidPenalty: "0.00",
            status: advancePaid
                ? "paid"
                : policy.periodUnit === "day"
                    ? "accrued"
                    : interestPeriod.nextPeriodStart <= throughDate ? "due" : "accruing",
            sourceTransactionId: null,
            reversedAccrualId: null,
            createdByUserId: null,
            createdAt: null,
        } as ProjectedAccrual;
    });
}

async function projectFloatingAccrualRows(
    tx: Executor,
    loan: typeof loans.$inferSelect,
    throughDate: string,
): Promise<ProjectedAccrual[]> {
    if (loan.repaymentType !== "floating" || !loan.dailyInterestMode || !loan.dailyInterestRate || !loan.firstDayTreatment || !loan.interestStartDate) return [];
    const existing = await tx.select().from(loanInterestAccruals).where(and(
        eq(loanInterestAccruals.tenantId, loan.tenantId),
        eq(loanInterestAccruals.loanId, loan.id),
    )) as ProjectedAccrual[];
    const activeByDate = new Map<string, ProjectedAccrual>(existing
        .filter((row) => row.status !== "reversed")
        .map((row) => [row.accrualDate, row]));
    const expected = await expectedFloatingAccruals(tx, loan, throughDate);
    const accrualCycle = (loan.floatingAccrualCycle ?? (loan.interestPeriodUnit === "week" ? "weekly" : "daily")) as FloatingAccrualCycle;
    const anchorDate = loan.interestPeriodAnchorDate ?? loan.interestStartDate;
    const legacyCoveredPeriods = new Set<string>();
    if (accrualCycle === "weekly" && anchorDate) {
        for (const row of activeByDate.values()) {
            if (row.periodStartDate !== null) continue;
            if (row.accrualDate === anchorDate && loan.firstDayTreatment === "deduct") {
                legacyCoveredPeriods.add(anchorDate);
            } else {
                legacyCoveredPeriods.add(legacyWeeklyPeriodStart(anchorDate, row.accrualDate));
            }
        }
    }
    const projected = expected
        .filter((row) => !row.periodStartDate || !legacyCoveredPeriods.has(row.periodStartDate))
        .map((row) => activeByDate.get(row.accrualDate) ?? row);
    const projectedDates = new Set(projected.map((row) => row.accrualDate));
    for (const row of activeByDate.values()) {
        if (row.accrualDate <= throughDate && !projectedDates.has(row.accrualDate)) projected.push(row);
    }
    const allocations = await tx.select().from(floatingTransactionAllocations).where(and(
        eq(floatingTransactionAllocations.tenantId, loan.tenantId),
        eq(floatingTransactionAllocations.loanId, loan.id),
        eq(floatingTransactionAllocations.component, "interest"),
    ));
    const cutovers = await tx.select().from(floatingPenaltyLedgerEntries).where(and(
        eq(floatingPenaltyLedgerEntries.tenantId, loan.tenantId),
        eq(floatingPenaltyLedgerEntries.loanId, loan.id),
        eq(floatingPenaltyLedgerEntries.entryType, "legacy_cutover"),
    ));
    const cutoverDate = (cutovers as Array<typeof floatingPenaltyLedgerEntries.$inferSelect>)
        .reduce((latest: string | null, entry) => !latest || entry.penaltyDate > latest ? entry.penaltyDate : latest, null);
    if (cutoverDate && throughDate < cutoverDate) {
        throw new DomainError("FLOATING_HISTORY_BEFORE_LEDGER_CUTOVER", "Floating history before the exact ledger cutover requires manual reconciliation", 409, {
            loanPublicId: loan.publicId,
            earliestSupportedDate: cutoverDate,
        });
    }
    const allByAccrual = new Map<number, Decimal>();
    const asOfByAccrual = new Map<number, Decimal>();
    for (const allocation of allocations as Array<typeof floatingTransactionAllocations.$inferSelect>) {
        if (!allocation.interestAccrualId) continue;
        allByAccrual.set(allocation.interestAccrualId, (allByAccrual.get(allocation.interestAccrualId) ?? new FinancialDecimal(0)).plus(allocation.amount));
        if (allocation.effectiveDate <= throughDate) {
            asOfByAccrual.set(allocation.interestAccrualId, (asOfByAccrual.get(allocation.interestAccrualId) ?? new FinancialDecimal(0)).plus(allocation.amount));
        }
    }
    return projected.sort((left, right) => left.accrualDate.localeCompare(right.accrualDate) || left.id - right.id).map((row) => {
        const allAllocated = row.id > 0 ? allByAccrual.get(row.id) ?? new FinancialDecimal(0) : new FinancialDecimal(0);
        const asOfAllocated = row.id > 0 ? asOfByAccrual.get(row.id) ?? new FinancialDecimal(0) : new FinancialDecimal(0);
        const baselinePaid = FinancialDecimal.max(new FinancialDecimal(row.paidAmount).minus(allAllocated), 0);
        const paidAmount = FinancialDecimal.min(new FinancialDecimal(row.interestAmount), FinancialDecimal.max(0, baselinePaid.plus(asOfAllocated)));
        const dueDate = accrualDueDate(row);
        const status: ProjectedAccrual["status"] = paidAmount.eq(row.interestAmount)
            ? "paid"
            : paidAmount.gt(0) && row.periodEndDate
                ? "partially_paid"
                : dueDate > throughDate
                    ? "accruing"
                    : row.periodUnit === "day" || row.periodDays === 1 || !row.periodEndDate
                        ? "accrued"
                        : row.periodEndDate
                        ? "due"
                        : "accrued";
        return { ...row, paidAmount: paidAmount.toFixed(2), status };
    });
}

function datesBetweenInclusive(from: string, through: string) {
    const dates: string[] = [];
    const cursor = new Date(`${from}T00:00:00Z`);
    const end = new Date(`${through}T00:00:00Z`);
    while (cursor <= end) {
        dates.push(cursor.toISOString().slice(0, 10));
        cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return dates;
}

async function projectFloatingPenaltyGroups(
    tx: Executor,
    loan: typeof loans.$inferSelect,
    rows: ProjectedAccrual[],
    throughDate: string,
) {
    const grouped = new Map<string, ProjectedAccrual[]>();
    for (const row of rows) {
        if (row.status === "reversed") continue;
        const dueDate = accrualDueDate(row);
        grouped.set(dueDate, [...(grouped.get(dueDate) ?? []), row]);
    }
    const allocations = await tx.select().from(floatingTransactionAllocations).where(and(
        eq(floatingTransactionAllocations.tenantId, loan.tenantId),
        eq(floatingTransactionAllocations.loanId, loan.id),
    ));
    const ledger = await tx.select().from(floatingPenaltyLedgerEntries).where(and(
        eq(floatingPenaltyLedgerEntries.tenantId, loan.tenantId),
        eq(floatingPenaltyLedgerEntries.loanId, loan.id),
    ));
    const feeValue = new FinancialDecimal(loan.lateFeeAmount ?? "0.00");
    const graceDays = Math.max(0, loan.gracePeriodDays ?? 0);
    const loanCutoverDate = ledger
        .filter((entry: typeof floatingPenaltyLedgerEntries.$inferSelect) => entry.entryType === "legacy_cutover")
        .reduce((latest: string | null, entry: typeof floatingPenaltyLedgerEntries.$inferSelect) =>
            !latest || entry.penaltyDate > latest ? entry.penaltyDate : latest, null);
    const groups: FloatingPenaltyGroup[] = [];
    const assessments: ProjectedPenaltyAssessment[] = [];
    const effectiveAssessments: ProjectedPenaltyAssessment[] = [];
    for (const [dueDate, groupRows] of [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right))) {
        const baseInterest = groupRows.reduce((sum, row) => sum.plus(row.interestAmount), new FinancialDecimal(0));
        const currentInterest = groupRows.reduce((sum, row) => sum.plus(FinancialDecimal.max(new FinancialDecimal(row.interestAmount).minus(row.paidAmount), 0)), new FinancialDecimal(0));
        const currentGroupAllocations = allocations.filter((row: typeof floatingTransactionAllocations.$inferSelect) =>
            row.dueDate === dueDate && row.effectiveDate <= throughDate);
        const interestAllocatedThrough = currentGroupAllocations
            .filter((row: typeof floatingTransactionAllocations.$inferSelect) => row.component === "interest")
            .reduce((sum: Decimal, row: typeof floatingTransactionAllocations.$inferSelect) => sum.plus(row.amount), new FinancialDecimal(0));
        const baselinePaid = FinancialDecimal.max(baseInterest.minus(currentInterest).minus(interestAllocatedThrough), 0);
        const firstPenaltyDate = new Date(`${dueDate}T00:00:00Z`);
        firstPenaltyDate.setUTCDate(firstPenaltyDate.getUTCDate() + graceDays + 1);
        const eligibleStart = firstPenaltyDate.toISOString().slice(0, 10);
        let fixedAssessmentProjected = false;
        if (eligibleStart <= throughDate) {
            for (const penaltyDate of datesBetweenInclusive(eligibleStart, throughDate)) {
                const paidBeforeDate = allocations
                    .filter((row: typeof floatingTransactionAllocations.$inferSelect) =>
                        row.dueDate === dueDate && row.component === "interest" && row.effectiveDate < penaltyDate)
                    .reduce((sum: Decimal, row: typeof floatingTransactionAllocations.$inferSelect) => sum.plus(row.amount), new FinancialDecimal(0));
                const openingInterestBasis = FinancialDecimal.max(baseInterest.minus(baselinePaid).minus(paidBeforeDate), 0);
                if (openingInterestBasis.lte(0)) continue;
                if (!fixedAssessmentProjected && (loan.lateFeeMode === "fixed" || loan.lateFeeMode === "fixed_plus_percent") && feeValue.gt(0)) {
                    assessments.push({ dueDate, penaltyDate, entryType: "fixed_assessment", amount: feeValue.toDecimalPlaces(2, FinancialDecimal.ROUND_HALF_UP), openingInterestBasis });
                    fixedAssessmentProjected = true;
                }
                if ((loan.lateFeeMode === "daily_percent" || loan.lateFeeMode === "fixed_plus_percent") && feeValue.gt(0)) {
                    assessments.push({
                        dueDate,
                        penaltyDate,
                        entryType: "daily_percent_accrual",
                        amount: openingInterestBasis.times(feeValue).div(100).toDecimalPlaces(2, FinancialDecimal.ROUND_HALF_UP),
                        openingInterestBasis,
                    });
                }
            }
        }
        const ledgerForGroupThrough = ledger.filter((entry: typeof floatingPenaltyLedgerEntries.$inferSelect) =>
            entry.dueDate === dueDate && entry.penaltyDate <= throughDate);
        const expectedForGroup = assessments.filter((entry) =>
            entry.dueDate === dueDate && (!loanCutoverDate || entry.penaltyDate > loanCutoverDate));
        effectiveAssessments.push(...expectedForGroup);
        const baseEntries = ledgerForGroupThrough.filter((entry: typeof floatingPenaltyLedgerEntries.$inferSelect) =>
            entry.entryType !== "adjustment" && entry.entryType !== "legacy_cutover");
        let accruedPenalty = new FinancialDecimal(0);
        for (const expected of expectedForGroup) {
            const base = baseEntries.find((entry: typeof floatingPenaltyLedgerEntries.$inferSelect) =>
                entry.penaltyDate === expected.penaltyDate && entry.entryType === expected.entryType);
            if (!base) {
                accruedPenalty = accruedPenalty.plus(expected.amount);
                continue;
            }
            accruedPenalty = accruedPenalty.plus(ledgerForGroupThrough
                .filter((entry: typeof floatingPenaltyLedgerEntries.$inferSelect) => entry.id === base.id || entry.adjustsEntryId === base.id)
                .reduce((sum: Decimal, entry: typeof floatingPenaltyLedgerEntries.$inferSelect) => sum.plus(entry.amount), new FinancialDecimal(0)));
        }
        for (const base of baseEntries) {
            const hasExpected = expectedForGroup.some((entry) =>
                entry.penaltyDate === base.penaltyDate && entry.entryType === base.entryType);
            if (hasExpected) continue;
            accruedPenalty = accruedPenalty.plus(ledgerForGroupThrough
                .filter((entry: typeof floatingPenaltyLedgerEntries.$inferSelect) => entry.id === base.id || entry.adjustsEntryId === base.id)
                .reduce((sum: Decimal, entry: typeof floatingPenaltyLedgerEntries.$inferSelect) => sum.plus(entry.amount), new FinancialDecimal(0)));
        }
        const paidPenalty = currentGroupAllocations
            .filter((row: typeof floatingTransactionAllocations.$inferSelect) => row.component === "penalty")
            .reduce((sum: Decimal, row: typeof floatingTransactionAllocations.$inferSelect) => sum.plus(row.amount), new FinancialDecimal(0));
        groups.push({ dueDate, accruedPenalty, paidPenalty, penaltyDue: FinancialDecimal.max(accruedPenalty.minus(paidPenalty), 0), interestDue: currentInterest });
    }
    return { groups, assessments: effectiveAssessments };
}

export async function floatingPaymentObligations(
    tx: Executor,
    loan: typeof loans.$inferSelect,
    through: Date,
    _context: CommandContext | number | null,
) {
    const throughDate = bangkokDate(through);
    const rows = await projectFloatingAccrualRows(tx, loan, throughDate);
    assertFloatingAccrualHistory(rows, loan, throughDate);
    const projectedPenalty = await projectFloatingPenaltyGroups(tx, loan, rows, throughDate);
    const dueInterest = rows
        .filter((row) => ["accrued", "due", "partially_paid"].includes(row.status) && accrualDueDate(row) <= throughDate)
        .reduce((total, row) => total.plus(FinancialDecimal.max(new FinancialDecimal(row.interestAmount).minus(row.paidAmount), 0)), new FinancialDecimal(0));
    const duePenalty = projectedPenalty.groups.reduce((total, group) => total.plus(group.penaltyDue), new FinancialDecimal(0));
    return { rows, dueInterest, duePenalty, penaltyGroups: projectedPenalty.groups, penaltyAssessments: projectedPenalty.assessments };
}

export async function floatingInterestBalances(
    tx: Executor,
    loan: typeof loans.$inferSelect,
    through: Date,
    context: CommandContext | number | null,
) {
    const obligations = await floatingPaymentObligations(tx, loan, through, context);
    const accruingInterest = obligations.rows
        .filter((row) => row.status === "accruing")
        .reduce((sum, row) => sum.plus(FinancialDecimal.max(new FinancialDecimal(row.interestAmount).minus(row.paidAmount), 0)), new FinancialDecimal(0));
    return {
        rows: obligations.rows,
        dueInterest: obligations.dueInterest,
        accruingInterest,
        applicablePenalty: obligations.duePenalty,
        penaltyGroups: obligations.penaltyGroups,
    };
}

export async function materializeFloatingPenaltyAssessments(
    tx: Executor,
    ctx: CommandContext,
    loan: typeof loans.$inferSelect,
    through: Date,
    auditPublicId: string,
    sourceTransactionId: number,
) {
    if (!ctx.idempotencyKey) throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", "Penalty materialization requires an idempotency key", 400);
    const obligations = await floatingPaymentObligations(tx, loan, through, ctx);
    const existing = await tx.select().from(floatingPenaltyLedgerEntries).where(and(
        eq(floatingPenaltyLedgerEntries.tenantId, ctx.tenantId),
        eq(floatingPenaltyLedgerEntries.loanId, loan.id),
    ));
    const keys = new Set(existing.filter((row: typeof floatingPenaltyLedgerEntries.$inferSelect) => row.entryType !== "adjustment")
        .map((row: typeof floatingPenaltyLedgerEntries.$inferSelect) => `${row.dueDate}:${row.penaltyDate}:${row.entryType}`));
    const missing = obligations.penaltyAssessments.filter((entry) => !keys.has(`${entry.dueDate}:${entry.penaltyDate}:${entry.entryType}`) && entry.amount.gt(0));
    if (missing.length) {
        await tx.insert(floatingPenaltyLedgerEntries).values(missing.map((entry) => ({
            tenantId: ctx.tenantId,
            loanId: loan.id,
            dueDate: entry.dueDate,
            penaltyDate: entry.penaltyDate,
            entryType: entry.entryType,
            amount: entry.amount.toFixed(2),
            openingInterestBasis: entry.openingInterestBasis.toFixed(2),
            lateFeeMode: loan.lateFeeMode ?? "none",
            lateFeeValue: new FinancialDecimal(loan.lateFeeAmount ?? 0).toFixed(2),
            gracePeriodDays: Math.max(0, loan.gracePeriodDays ?? 0),
            sourceTransactionId,
            idempotencyKey: `floating-penalty:${loan.publicId}:${entry.dueDate}:${entry.penaltyDate}:${entry.entryType}`,
            auditPublicId,
            actorSource: ctx.actorSource,
            requestId: ctx.requestId,
            correlationId: ctx.correlationId,
            createdByUserId: ctx.actorUserId,
        }))).onConflictDoNothing();
    }
    return floatingPaymentObligations(tx, loan, through, ctx);
}

export async function reconcileFloatingPenaltyLedgerAfterInterestAllocation(
    tx: Executor,
    ctx: CommandContext,
    loan: typeof loans.$inferSelect,
    effectiveDate: string,
    sourceTransaction: Pick<typeof transactions.$inferSelect, "id" | "publicId">,
    input: { includeEffectiveDate?: boolean } = {},
) {
    if (!ctx.idempotencyKey) throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", "Penalty reconciliation requires an idempotency key", 400);
    const ledger = await tx.select().from(floatingPenaltyLedgerEntries).where(and(
        eq(floatingPenaltyLedgerEntries.tenantId, ctx.tenantId),
        eq(floatingPenaltyLedgerEntries.loanId, loan.id),
    ));
    const futureBases = ledger.filter((entry: typeof floatingPenaltyLedgerEntries.$inferSelect) =>
        entry.entryType !== "adjustment" && entry.entryType !== "legacy_snapshot" && entry.entryType !== "legacy_cutover"
        && (input.includeEffectiveDate ? entry.penaltyDate >= effectiveDate : entry.penaltyDate > effectiveDate));
    if (!futureBases.length) return [];
    const throughDate = futureBases.reduce((latest: string, entry: typeof floatingPenaltyLedgerEntries.$inferSelect) =>
        entry.penaltyDate > latest ? entry.penaltyDate : latest, effectiveDate);
    const projectedRows = await projectFloatingAccrualRows(tx, loan, throughDate);
    const projected = await projectFloatingPenaltyGroups(tx, loan, projectedRows, throughDate);
    const allTimePaidPenaltyByDueDate = new Map<string, Decimal>();
    const allPenaltyAllocations = await tx.select().from(floatingTransactionAllocations).where(and(
        eq(floatingTransactionAllocations.tenantId, ctx.tenantId),
        eq(floatingTransactionAllocations.loanId, loan.id),
        eq(floatingTransactionAllocations.component, "penalty"),
    ));
    for (const allocation of allPenaltyAllocations as Array<typeof floatingTransactionAllocations.$inferSelect>) {
        allTimePaidPenaltyByDueDate.set(
            allocation.dueDate,
            (allTimePaidPenaltyByDueDate.get(allocation.dueDate) ?? new FinancialDecimal(0)).plus(allocation.amount),
        );
    }
    const expectedByKey = new Map(projected.assessments.map((entry) => [
        `${entry.dueDate}:${entry.penaltyDate}:${entry.entryType}`,
        entry,
    ]));
    const adjustments: Array<{
        base: typeof floatingPenaltyLedgerEntries.$inferSelect;
        expected: ProjectedPenaltyAssessment | undefined;
        delta: Decimal;
    }> = futureBases.flatMap((base: typeof floatingPenaltyLedgerEntries.$inferSelect) => {
        const current = ledger
            .filter((entry: typeof floatingPenaltyLedgerEntries.$inferSelect) => entry.id === base.id || entry.adjustsEntryId === base.id)
            .reduce((sum: Decimal, entry: typeof floatingPenaltyLedgerEntries.$inferSelect) => sum.plus(entry.amount), new FinancialDecimal(0));
        const expected = expectedByKey.get(`${base.dueDate}:${base.penaltyDate}:${base.entryType}`);
        const expectedAmount = expected?.amount ?? new FinancialDecimal(0);
        const delta = expectedAmount.minus(current).toDecimalPlaces(2, FinancialDecimal.ROUND_HALF_UP);
        return delta.eq(0) ? [] : [{ base, expected, delta }];
    });
    const plannedDeltaByDueDate = new Map<string, Decimal>();
    for (const adjustment of adjustments) {
        plannedDeltaByDueDate.set(
            adjustment.base.dueDate,
            (plannedDeltaByDueDate.get(adjustment.base.dueDate) ?? new FinancialDecimal(0)).plus(adjustment.delta),
        );
    }
    for (const [dueDate, plannedDelta] of plannedDeltaByDueDate) {
        if (plannedDelta.gte(0)) continue;
        const group = projected.groups.find((candidate) => candidate.dueDate === dueDate);
        const paidFloor = allTimePaidPenaltyByDueDate.get(dueDate) ?? group?.paidPenalty ?? new FinancialDecimal(0);
        if (group && group.accruedPenalty.plus(plannedDelta).lt(paidFloor)) {
            throw new DomainError(
                "FLOATING_PENALTY_COMPENSATION_EXCEEDS_UNPAID",
                "Penalty compensation would reduce assessed penalty below the amount already paid",
                409,
                { loanPublicId: loan.publicId, dueDate },
            );
        }
    }
    if (!adjustments.length) return [];
    const audit = await createAuditLog(tx, {
        tenantId: ctx.tenantId,
        actorUserId: ctx.actorUserId,
        actorSource: ctx.actorSource,
        requestId: ctx.requestId,
        correlationId: ctx.correlationId,
        entityType: "transaction",
        entityId: sourceTransaction.publicId,
        action: "floating_penalty_ledger_compensated",
        payload: {
            loanPublicId: loan.publicId,
            sourceTransactionPublicId: sourceTransaction.publicId,
            effectiveDate,
            adjustments: adjustments.map(({ base, expected, delta }) => ({
                adjustedEntryPublicId: base.publicId,
                dueDate: base.dueDate,
                penaltyDate: base.penaltyDate,
                amount: delta.toFixed(2),
                openingInterestBasis: (expected?.openingInterestBasis ?? new FinancialDecimal(0)).toFixed(2),
            })),
        },
    });
    return tx.insert(floatingPenaltyLedgerEntries).values(adjustments.map(({ base, expected, delta }) => ({
        tenantId: ctx.tenantId,
        loanId: loan.id,
        dueDate: base.dueDate,
        penaltyDate: base.penaltyDate,
        entryType: "adjustment",
        amount: delta.toFixed(2),
        openingInterestBasis: (expected?.openingInterestBasis ?? new FinancialDecimal(0)).toFixed(2),
        lateFeeMode: base.lateFeeMode,
        lateFeeValue: base.lateFeeValue,
        gracePeriodDays: base.gracePeriodDays,
        adjustsEntryId: base.id,
        sourceTransactionId: sourceTransaction.id,
        reason: "Backdated interest allocation changed a later daily penalty basis",
        idempotencyKey: `floating-penalty-adjustment:${sourceTransaction.publicId}:${base.publicId}:${input.includeEffectiveDate ? "inclusive" : "future"}`,
        auditPublicId: audit.publicId,
        actorSource: ctx.actorSource,
        requestId: ctx.requestId,
        correlationId: ctx.correlationId,
        createdByUserId: ctx.actorUserId,
    }))).onConflictDoNothing().returning();
}

function payableOutstanding(rows: Array<typeof loanInterestAccruals.$inferSelect>) {
    return rows
        .filter((row) => ["accrued", "due", "partially_paid"].includes(row.status))
        .reduce((sum, row) => sum.plus(new FinancialDecimal(row.interestAmount).minus(row.paidAmount)), new FinancialDecimal(0));
}

function replacementStatus(
    old: typeof loanInterestAccruals.$inferSelect,
    paidAmount: Decimal,
    interestAmount: string,
    materializedThrough: string,
) {
    if (paidAmount.eq(interestAmount)) return "paid";
    const periodWasPayable = ["accrued", "due", "partially_paid"].includes(old.status)
        || (old.status === "paid" && accrualDueDate(old) <= materializedThrough);
    if (!periodWasPayable) return "accruing";
    if (paidAmount.gt(0)) return "partially_paid";
    return old.periodUnit === "day" || old.periodDays === 1 ? "accrued" : "due";
}

async function replaceGeneralizedAccruals(
    tx: Executor,
    ctx: CommandContext,
    loan: typeof loans.$inferSelect,
    targetRows: Array<typeof loanInterestAccruals.$inferSelect>,
    sourceTransactionId: number | null,
) {
    if (!targetRows.length) return { replacements: [] as Array<typeof loanInterestAccruals.$inferSelect>, delta: new FinancialDecimal(0) };
    if (!hasPeriodPolicy(loan)) throw new DomainError("FLOATING_PERIOD_POLICY_REQUIRED", "Floating loan period policy is required for generalized correction", 409);
    const active = await tx.select().from(loanInterestAccruals).where(and(
        eq(loanInterestAccruals.tenantId, ctx.tenantId),
        eq(loanInterestAccruals.loanId, loan.id),
        sql`${loanInterestAccruals.status} <> 'reversed'`,
    )).orderBy(asc(loanInterestAccruals.accrualDate), asc(loanInterestAccruals.id));
    const targetIds = new Set(targetRows.map((row) => row.id));
    const materializedThrough = active.at(-1)?.accrualDate ?? loan.interestPeriodAnchorDate!;
    const periodRows = await tx.select().from(loanInterestRatePeriods).where(and(
        eq(loanInterestRatePeriods.tenantId, ctx.tenantId),
        eq(loanInterestRatePeriods.loanId, loan.id),
    )).orderBy(asc(loanInterestRatePeriods.effectiveDate));
    const periodValues: RatePeriodValue[] = periodRows.map((row: typeof loanInterestRatePeriods.$inferSelect) => ({
        publicId: row.publicId,
        effectiveDate: row.effectiveDate,
        expiryDate: row.expiryDate,
        rateType: row.rateType as RateType,
        rate: row.rate,
    }));
    const periodByPublicId = new Map<string, typeof loanInterestRatePeriods.$inferSelect>(periodRows.map(
        (row: typeof loanInterestRatePeriods.$inferSelect) => [row.publicId, row],
    ));
    const transactionRows = await tx.select().from(transactions).where(and(
        eq(transactions.tenantId, ctx.tenantId),
        eq(transactions.loanId, loan.id),
    ));
    const replacements: Array<typeof loanInterestAccruals.$inferSelect> = [];
    let delta = new FinancialDecimal(0);
    let previousPeriodKey: string | null = null;
    let previousSegmentKey: string | null = null;
    let segmentElapsedDays = 0;
    let periodCumulative = new FinancialDecimal(0);

    for (const row of active) {
        const targeted = targetIds.has(row.id);
        const periodValue = resolveRatePeriod(periodValues, row.accrualDate);
        const storedPeriod = periodValue ? periodByPublicId.get(periodValue.publicId) : undefined;
        if (!periodValue || !storedPeriod) {
            throw new DomainError("RATE_PERIOD_MISSING_COVERAGE", "Floating loan has no interest rate for a correction date", 409, {
                accrualDate: row.accrualDate,
            });
        }
        const policy = periodPolicy(loan, storedPeriod);
        const interestPeriod = interestPeriodFor(loan.interestPeriodAnchorDate!, row.accrualDate, policy);
        const periodKey = `${interestPeriod.periodStart}:${interestPeriod.nextPeriodStart}`;
        if (periodKey !== previousPeriodKey) {
            previousPeriodKey = periodKey;
            previousSegmentKey = null;
            segmentElapsedDays = 0;
            periodCumulative = new FinancialDecimal(0);
        }
        const advancePaidPeriod = policy.advanceInterestPeriods === 1
            && interestPeriod.periodStart === loan.interestPeriodAnchorDate;
        const openingPrincipal = targeted && !advancePaidPeriod
            ? principalAtStartOfDate(loan, transactionRows, row.accrualDate)
            : row.openingPrincipal;
        const ratePeriodId = targeted ? storedPeriod.id : row.interestRatePeriodId ?? storedPeriod.id;
        const rateMode = targeted ? periodValue.rateType : row.rateMode;
        const rate = targeted ? periodValue.rate : row.rate;
        const segmentKey = `${periodKey}:${ratePeriodId}:${openingPrincipal}:${rateMode}:${rate}`;
        if (segmentKey !== previousSegmentKey) {
            previousSegmentKey = segmentKey;
            segmentElapsedDays = 0;
        }
        segmentElapsedDays += 1;
        if (!targeted) {
            periodCumulative = row.cumulativeInterestAmount === null
                ? periodCumulative.plus(row.interestAmount)
                : new FinancialDecimal(row.cumulativeInterestAmount);
            continue;
        }

        const accrued = calculateAccruedInterest(openingPrincipal, policy, segmentElapsedDays);
        periodCumulative = periodCumulative.plus(accrued.incrementAmount);
        const paidAmount = new FinancialDecimal(row.paidAmount);
        if (paidAmount.gt(accrued.incrementAmount)) {
            throw new DomainError(
                "FLOATING_ACCRUAL_PAID_CONFLICT",
                "Recalculated floating interest cannot be lower than its immutable paid allocation",
                409,
                {
                    loanPublicId: loan.publicId,
                    accrualPublicId: row.publicId,
                    accrualDate: row.accrualDate,
                    paidAmount: paidAmount.toFixed(2),
                    recalculatedInterestAmount: new FinancialDecimal(accrued.incrementAmount).toFixed(2),
                },
            );
        }
        const status = replacementStatus(row, paidAmount, accrued.incrementAmount, materializedThrough);
        await tx.update(loanInterestAccruals).set({ status: "reversed" }).where(and(
            eq(loanInterestAccruals.tenantId, ctx.tenantId),
            eq(loanInterestAccruals.id, row.id),
        ));
        const replacement = await tx.insert(loanInterestAccruals).values({
            tenantId: ctx.tenantId,
            loanId: loan.id,
            interestRatePeriodId: storedPeriod.id,
            accrualDate: row.accrualDate,
            openingPrincipal,
            rateMode: policy.rateMode,
            rate: policy.rate,
            interestAmount: accrued.incrementAmount,
            periodStartDate: interestPeriod.periodStart,
            periodEndDate: interestPeriod.nextPeriodStart,
            periodDayIndex: interestPeriod.dayIndex + 1,
            periodDays: interestPeriod.periodDays,
            periodUnit: policy.periodUnit,
            periodLength: policy.periodLength,
            contractualInterestAmount: calculatePeriodInterest(openingPrincipal, policy),
            cumulativeInterestAmount: periodCumulative.toFixed(2),
            dailyIncrementAmount: accrued.incrementAmount,
            paidAmount: paidAmount.toFixed(2),
            status,
            sourceTransactionId: sourceTransactionId ?? row.sourceTransactionId,
            reversedAccrualId: row.id,
            createdByUserId: ctx.actorUserId,
        }).returning().then((rows: Array<typeof loanInterestAccruals.$inferSelect>) => rows[0]!);
        replacements.push(replacement);
        delta = delta.plus(new FinancialDecimal(replacement.interestAmount).minus(row.interestAmount));
    }
    return { replacements, delta };
}

export async function reprojectFloatingInterestAfterTransaction(
    tx: Executor,
    ctx: CommandContext,
    loan: typeof loans.$inferSelect,
    sourceTransaction: typeof transactions.$inferSelect,
) {
    if (!hasPeriodPolicy(loan) || !sourceTransaction.transactionDate) return [];
    const effectiveDate = bangkokDate(sourceTransaction.transactionDate);
    const targets = await tx.select().from(loanInterestAccruals).where(and(
        eq(loanInterestAccruals.tenantId, ctx.tenantId),
        eq(loanInterestAccruals.loanId, loan.id),
        sql`${loanInterestAccruals.status} <> 'reversed'`,
        sql`${loanInterestAccruals.accrualDate} > ${effectiveDate}`,
    )).orderBy(asc(loanInterestAccruals.accrualDate), asc(loanInterestAccruals.id));
    if (!targets.length) return [];
    const { replacements } = await replaceGeneralizedAccruals(tx, ctx, loan, targets, sourceTransaction.id);
    const refreshed = await tx.select().from(loanInterestAccruals).where(and(
        eq(loanInterestAccruals.tenantId, ctx.tenantId),
        eq(loanInterestAccruals.loanId, loan.id),
        sql`${loanInterestAccruals.status} <> 'reversed'`,
    ));
    await tx.update(loans).set({
        outstandingInterest: payableOutstanding(refreshed).toFixed(2),
        updatedAt: new Date(),
    }).where(and(eq(loans.tenantId, ctx.tenantId), eq(loans.id, loan.id)));
    await createAuditLog(tx, {
        tenantId: ctx.tenantId,
        actorUserId: ctx.actorUserId,
        actorSource: ctx.actorSource,
        requestId: ctx.requestId,
        correlationId: ctx.correlationId,
        entityType: "loan",
        entityId: loan.publicId,
        action: "floating_interest_accruals_reprojected",
        payload: {
            sourceTransactionPublicId: sourceTransaction.publicId,
            effectiveDate,
            replacementAccrualPublicIds: replacements.map((row) => row.publicId),
        },
    });
    return replacements;
}

export async function correctFloatingInterestAccruals(ctx: CommandContext, loanPublicId: string, dates: string[], reason: string) {
    if (!ctx.idempotencyKey) throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", "Accrual correction requires an idempotency key", 400);
    const cleanReason = reason.trim();
    if (!cleanReason) throw new DomainError("CORRECTION_REASON_REQUIRED", "Accrual correction requires a reason", 400);
    const uniqueDates = [...new Set(dates)].sort();
    if (!uniqueDates.length) throw new DomainError("CORRECTION_DATES_REQUIRED", "Select at least one accrual date", 400);
    return db.transaction(async (tx) => {
        const prior = await tx.query.loanAdjustments.findFirst({ where: and(eq(loanAdjustments.tenantId, ctx.tenantId), eq(loanAdjustments.idempotencyKey, ctx.idempotencyKey!)) });
        if (prior) return { adjustmentPublicId: prior.publicId, correctedDates: uniqueDates, amount: new FinancialDecimal(prior.amount).toFixed(2) };
        const loan = await tx.query.loans.findFirst({ where: and(eq(loans.tenantId, ctx.tenantId), eq(loans.publicId, loanPublicId)) });
        if (!loan || loan.repaymentType !== "floating") throw new DomainError("FLOATING_LOAN_NOT_FOUND", "Floating loan not found", 404);
        await tx.execute(sql`SELECT id FROM loans WHERE tenant_id = ${ctx.tenantId} AND id = ${loan.id} FOR UPDATE`);
        if (!loan.interestStartDate || !loan.firstDayTreatment) {
            throw new DomainError("INVALID_LOAN_TERMS", "Floating interest policy is invalid", 409);
        }
        const accrualCycle = (loan.floatingAccrualCycle ?? "daily") as FloatingAccrualCycle;
        for (const accrualDate of uniqueDates) {
            let scheduled = false;
            try {
                scheduled = interestDatesThrough(
                    hasPeriodPolicy(loan) ? loan.interestPeriodAnchorDate! : loan.interestStartDate,
                    accrualDate,
                    accrualDateFirstDayTreatment(loan),
                    hasPeriodPolicy(loan) ? "daily" : accrualCycle,
                ).includes(accrualDate);
            } catch {
                scheduled = false;
            }
            if (!scheduled) {
                throw new DomainError(
                    "ACCRUAL_DATE_NOT_SCHEDULED",
                    "Floating accrual date is outside the loan's accrual cycle",
                    409,
                    { accrualDate },
                );
            }
        }
        const oldRows = await tx.select().from(loanInterestAccruals).where(and(
            eq(loanInterestAccruals.tenantId, ctx.tenantId), eq(loanInterestAccruals.loanId, loan.id),
            inArray(loanInterestAccruals.accrualDate, uniqueDates), sql`${loanInterestAccruals.status} <> 'reversed'`,
        )).orderBy(asc(loanInterestAccruals.accrualDate));
        if (oldRows.length !== uniqueDates.length) throw new DomainError("ACCRUAL_CORRECTION_TARGET_MISMATCH", "Every correction date must identify one active accrual", 409);
        const allocatedTargets = oldRows.length ? await tx.select({
            interestAccrualId: floatingTransactionAllocations.interestAccrualId,
        }).from(floatingTransactionAllocations)
            .innerJoin(transactions, eq(transactions.id, floatingTransactionAllocations.transactionId))
            .where(and(
            eq(floatingTransactionAllocations.tenantId, ctx.tenantId),
            eq(floatingTransactionAllocations.loanId, loan.id),
            eq(floatingTransactionAllocations.component, "interest"),
            inArray(floatingTransactionAllocations.interestAccrualId, oldRows.map((row) => row.id)),
            eq(transactions.entryType, "repayment"),
            sql`NOT EXISTS (SELECT 1 FROM transactions reversal
                WHERE reversal.tenant_id = ${ctx.tenantId}
                  AND reversal.reversed_transaction_id = ${transactions.id})`,
        )) : [];
        if (allocatedTargets.length) {
            throw new DomainError(
                "ACCRUAL_CORRECTION_HAS_ALLOCATIONS",
                "Reverse payments allocated to an accrual before correcting it",
                409,
                {
                    accrualPublicIds: oldRows
                        .filter((row) => allocatedTargets.some((allocation) => allocation.interestAccrualId === row.id))
                        .map((row) => row.publicId),
                },
            );
        }
        const correctedDueDates = new Set(oldRows.map((row) => accrualDueDate(row)));
        const dependentPenaltyHistory = await tx.select({
            dueDate: floatingPenaltyLedgerEntries.dueDate,
            entryType: floatingPenaltyLedgerEntries.entryType,
        }).from(floatingPenaltyLedgerEntries).where(and(
            eq(floatingPenaltyLedgerEntries.tenantId, ctx.tenantId),
            eq(floatingPenaltyLedgerEntries.loanId, loan.id),
            inArray(floatingPenaltyLedgerEntries.dueDate, [...correctedDueDates]),
        ));
        if (dependentPenaltyHistory.some((entry) => !["legacy_cutover", "legacy_snapshot"].includes(entry.entryType) && correctedDueDates.has(entry.dueDate))) {
            throw new DomainError(
                "ACCRUAL_CORRECTION_HAS_PENALTY_HISTORY",
                "Accruals with immutable penalty history require a compensating financial workflow",
                409,
                { dueDates: [...correctedDueDates] },
            );
        }
        let delta = new FinancialDecimal(0);
        let replacements: Array<typeof loanInterestAccruals.$inferSelect> = [];
        if (hasPeriodPolicy(loan)) {
            const suffixRows = await tx.select().from(loanInterestAccruals).where(and(
                eq(loanInterestAccruals.tenantId, ctx.tenantId),
                eq(loanInterestAccruals.loanId, loan.id),
                sql`${loanInterestAccruals.status} <> 'reversed'`,
                sql`${loanInterestAccruals.accrualDate} >= ${oldRows[0]!.accrualDate}`,
            )).orderBy(asc(loanInterestAccruals.accrualDate), asc(loanInterestAccruals.id));
            ({ replacements, delta } = await replaceGeneralizedAccruals(tx, ctx, loan, suffixRows, null));
        } else {
            const periodRows = await tx.select().from(loanInterestRatePeriods).where(and(
                eq(loanInterestRatePeriods.tenantId, ctx.tenantId),
                eq(loanInterestRatePeriods.loanId, loan.id),
            )).orderBy(asc(loanInterestRatePeriods.effectiveDate));
            const periodValues: RatePeriodValue[] = periodRows.map((row) => ({
                publicId: row.publicId,
                effectiveDate: row.effectiveDate,
                expiryDate: row.expiryDate,
                rateType: row.rateType as RateType,
                rate: row.rate,
            }));
            const allTransactions = await tx.select().from(transactions).where(and(
                eq(transactions.tenantId, ctx.tenantId),
                eq(transactions.loanId, loan.id),
            ));
            const weeklyExpected = accrualCycle === "weekly"
                ? new Map((await expectedFloatingAccruals(tx, loan, uniqueDates.at(-1)!)).map((row) => [row.accrualDate, row]))
                : null;
            for (const old of oldRows) {
                const weekly = weeklyExpected?.get(old.accrualDate);
                if (accrualCycle === "weekly" && !weekly) {
                    throw new DomainError("ACCRUAL_DATE_NOT_SCHEDULED", "Floating accrual date is outside the loan's accrual cycle", 409, {
                        accrualDate: old.accrualDate,
                    });
                }
                const periodValue = resolveRatePeriod(periodValues, old.accrualDate);
                const period = periodRows.find((row) => row.publicId === periodValue?.publicId);
                if (!periodValue || !period) throw new DomainError("RATE_PERIOD_MISSING_COVERAGE", "Floating loan has no interest rate for a correction date", 409, { accrualDate: old.accrualDate });
                const openingPrincipal = weekly?.openingPrincipal ?? principalAtStartOfDate(loan, allTransactions, old.accrualDate);
                const policy: FloatingDailyInterest = { mode: periodValue.rateType, rate: periodValue.rate, firstDayTreatment: loan.firstDayTreatment as FloatingDailyInterest["firstDayTreatment"], accrualCycle };
                const interestAmount = weekly?.interestAmount ?? calculateDailyInterest(openingPrincipal, policy);
                const paidAmount = weekly?.status === "paid" || (old.accrualDate === loan.interestStartDate && loan.firstDayTreatment === "deduct")
                    ? interestAmount
                    : FinancialDecimal.min(new FinancialDecimal(old.paidAmount), new FinancialDecimal(interestAmount)).toFixed(2);
                await tx.update(loanInterestAccruals).set({ status: "reversed" }).where(and(
                    eq(loanInterestAccruals.tenantId, ctx.tenantId),
                    eq(loanInterestAccruals.id, old.id),
                ));
                const replacement = await tx.insert(loanInterestAccruals).values({
                    tenantId: ctx.tenantId,
                    loanId: loan.id,
                    interestRatePeriodId: period.id,
                    accrualDate: old.accrualDate,
                    openingPrincipal,
                    rateMode: periodValue.rateType,
                    rate: periodValue.rate,
                    interestAmount,
                    periodStartDate: weekly?.periodStartDate ?? null,
                    periodEndDate: weekly?.periodEndDate ?? null,
                    periodDayIndex: weekly?.periodDayIndex ?? null,
                    periodDays: weekly?.periodDays ?? null,
                    periodUnit: weekly?.periodUnit ?? null,
                    periodLength: weekly?.periodLength ?? null,
                    contractualInterestAmount: weekly?.contractualInterestAmount ?? null,
                    cumulativeInterestAmount: weekly?.cumulativeInterestAmount ?? null,
                    dailyIncrementAmount: weekly?.dailyIncrementAmount ?? null,
                    paidAmount,
                    accruedPenalty: old.accruedPenalty,
                    paidPenalty: old.paidPenalty,
                    status: new FinancialDecimal(paidAmount).eq(interestAmount) ? "paid" : weekly?.status ?? "accrued",
                    sourceTransactionId: old.sourceTransactionId,
                    reversedAccrualId: old.id,
                    createdByUserId: ctx.actorUserId,
                }).returning().then((rows) => rows[0]!);
                replacements.push(replacement);
                delta = delta.plus(new FinancialDecimal(interestAmount).minus(old.interestAmount));
            }
        }
        const active = await tx.select().from(loanInterestAccruals).where(and(eq(loanInterestAccruals.tenantId, ctx.tenantId), eq(loanInterestAccruals.loanId, loan.id), sql`${loanInterestAccruals.status} <> 'reversed'`));
        const outstandingInterest = payableOutstanding(active);
        await tx.update(loans).set({ outstandingInterest: outstandingInterest.toFixed(2), updatedAt: new Date() }).where(and(eq(loans.tenantId, ctx.tenantId), eq(loans.id, loan.id)));
        const adjustment = await tx.insert(loanAdjustments).values({
            tenantId: ctx.tenantId, loanId: loan.id, adjustmentType: "floating_interest_accrual_correction", amount: delta.toFixed(2),
            idempotencyKey: ctx.idempotencyKey, reason: cleanReason, createdByUserId: ctx.actorUserId, updatedByUserId: ctx.actorUserId,
        }).returning().then((rows) => rows[0]!);
        await createAuditLog(tx, {
            tenantId: ctx.tenantId, actorUserId: ctx.actorUserId, actorSource: ctx.actorSource, requestId: ctx.requestId, correlationId: ctx.correlationId,
            entityType: "loan", entityId: loan.publicId, action: "floating_interest_accruals_corrected",
            payload: { adjustmentPublicId: adjustment.publicId, reason: cleanReason, corrected: replacements.map((row) => ({ accrualDate: row.accrualDate, accrualPublicId: row.publicId, openingPrincipal: new FinancialDecimal(row.openingPrincipal).toFixed(2), interestAmount: new FinancialDecimal(row.interestAmount).toFixed(2), paidAmount: new FinancialDecimal(row.paidAmount).toFixed(2) })) },
        });
        return { adjustmentPublicId: adjustment.publicId, correctedDates: uniqueDates, amount: delta.toFixed(2) };
    });
}
