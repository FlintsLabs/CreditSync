import { and, asc, eq, inArray, sql } from "drizzle-orm";
import Decimal from "decimal.js";
import { db } from "../db";
import { loanAdjustments, loanInterestAccruals, loanInterestRatePeriods, loans, transactions } from "../db/schema";
import { createAuditLog } from "../lib/audit-log";
import { calculateDailyInterest, interestDatesThrough, type FloatingDailyInterest } from "../lib/floating-daily-interest";
import {
    calculateAccruedInterest,
    calculatePeriodInterest,
    interestPeriodFor,
    type FloatingInterestPolicy,
} from "../lib/floating-interest-policy";
import { resolveRatePeriod, type RatePeriodValue, type RateType } from "../lib/interest-rate-periods";
import { DomainError } from "./domain-error";
import type { CommandContext } from "./command-context";

type Executor = any;

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
    const principalAppliedBefore = rows
        .filter((row) => row.postedAt && row.transactionDate && bangkokDate(row.transactionDate) < accrualDate)
        .reduce((sum, row) => sum.plus(row.principalComponent), new Decimal(0));
    return Decimal.max(0, new Decimal(loan.principalAmount).minus(principalAppliedBefore)).toFixed(2);
}

async function accrueLegacyFloatingInterestThrough(
    tx: Executor,
    loan: typeof loans.$inferSelect,
    throughDate: string,
    actorUserId: number | null,
) {
    if (!loan.dailyInterestMode || !loan.dailyInterestRate || !loan.firstDayTreatment || !loan.interestStartDate) return [];
    const firstDayTreatment = loan.firstDayTreatment as FloatingDailyInterest["firstDayTreatment"];
    const existing = await tx.select().from(loanInterestAccruals).where(and(
        eq(loanInterestAccruals.tenantId, loan.tenantId),
        eq(loanInterestAccruals.loanId, loan.id),
    ));
    const dates = new Set(existing.filter((row: typeof loanInterestAccruals.$inferSelect) => row.status !== "reversed")
        .map((row: typeof loanInterestAccruals.$inferSelect) => row.accrualDate));
    const dueDates = interestDatesThrough(loan.interestStartDate, throughDate, firstDayTreatment).filter((date) => !dates.has(date));
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
    const resolved = dueDates.map((accrualDate) => ({ accrualDate, period: resolveRatePeriod(periods, accrualDate) }));
    const missing = resolved.find((item) => item.period === null);
    if (missing) {
        throw new DomainError("RATE_PERIOD_MISSING_COVERAGE", "Floating loan has no interest rate for an accrual date", 409, {
            accrualDate: missing.accrualDate,
            loanPublicId: loan.publicId,
        });
    }
    const openingPrincipal = new Decimal(loan.outstandingPrincipal ?? loan.principalAmount);
    await tx.insert(loanInterestAccruals).values(resolved.map(({ accrualDate, period }) => {
        const effectivePeriod = period!;
        const storedPeriod = rowByPublicId.get(effectivePeriod.publicId)!;
        const policy: FloatingDailyInterest = { mode: effectivePeriod.rateType, rate: effectivePeriod.rate, firstDayTreatment };
        return {
            tenantId: loan.tenantId,
            loanId: loan.id,
            interestRatePeriodId: storedPeriod.id,
            accrualDate,
            openingPrincipal: openingPrincipal.toFixed(2),
            rateMode: policy.mode,
            rate: policy.rate,
            interestAmount: calculateDailyInterest(openingPrincipal.toFixed(2), policy),
            status: "accrued",
            createdByUserId: actorUserId,
        };
    })).onConflictDoNothing();
    return tx.select().from(loanInterestAccruals).where(and(
        eq(loanInterestAccruals.tenantId, loan.tenantId),
        eq(loanInterestAccruals.loanId, loan.id),
    ));
}

export async function accrueFloatingInterestThrough(tx: Executor, loan: typeof loans.$inferSelect, through: Date, actorUserId: number | null) {
    if (loan.repaymentType !== "floating") return [];
    const throughDate = bangkokDate(through);
    if (!hasPeriodPolicy(loan)) return accrueLegacyFloatingInterestThrough(tx, loan, throughDate, actorUserId);
    const anchorDate = loan.interestPeriodAnchorDate!;
    const existing = await tx.select().from(loanInterestAccruals).where(and(
        eq(loanInterestAccruals.tenantId, loan.tenantId),
        eq(loanInterestAccruals.loanId, loan.id),
    )).orderBy(asc(loanInterestAccruals.accrualDate), asc(loanInterestAccruals.id));
    const activeByDate = new Map<string, typeof loanInterestAccruals.$inferSelect>(existing
        .filter((row: typeof loanInterestAccruals.$inferSelect) => row.status !== "reversed")
        .map((row: typeof loanInterestAccruals.$inferSelect) => [row.accrualDate, row]));
    const accrualDates = interestDatesThrough(anchorDate, throughDate, "deduct");
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
    let periodCumulative = new Decimal(0);

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
                periodCumulative = new Decimal(0);
            }
            const segmentKey = `${periodKey}:${existingRow.interestRatePeriodId ?? "none"}:${existingRow.openingPrincipal}:${existingRow.rateMode}:${existingRow.rate}`;
            if (segmentKey !== previousSegmentKey) {
                previousSegmentKey = segmentKey;
                segmentElapsedDays = 0;
            }
            segmentElapsedDays += 1;
            periodCumulative = existingRow.cumulativeInterestAmount === null
                ? periodCumulative.plus(existingRow.interestAmount)
                : new Decimal(existingRow.cumulativeInterestAmount);
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
            periodCumulative = new Decimal(0);
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
            periodUnit: policy.periodUnit,
            periodLength: policy.periodLength,
            contractualInterestAmount: calculatePeriodInterest(openingPrincipal, policy),
            cumulativeInterestAmount: periodCumulative.toFixed(2),
            dailyIncrementAmount: accrued.incrementAmount,
            status: interestPeriod.nextPeriodStart <= throughDate ? "due" : "accruing",
            createdByUserId: actorUserId,
        });
    }
    if (inserts.length) await tx.insert(loanInterestAccruals).values(inserts).onConflictDoNothing();

    const active = await tx.select().from(loanInterestAccruals).where(and(
        eq(loanInterestAccruals.tenantId, loan.tenantId),
        eq(loanInterestAccruals.loanId, loan.id),
        sql`${loanInterestAccruals.status} <> 'reversed'`,
    )).orderBy(asc(loanInterestAccruals.accrualDate), asc(loanInterestAccruals.id));
    for (const row of active) {
        if (!row.periodEndDate || row.periodEndDate > throughDate || row.status === "paid") continue;
        const paidAmount = new Decimal(row.paidAmount);
        const nextStatus = paidAmount.eq(row.interestAmount)
            ? "paid"
            : paidAmount.gt(0)
                ? "partially_paid"
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

export async function floatingInterestDue(tx: Executor, loan: typeof loans.$inferSelect, through: Date, actorUserId: number | null) {
    const rows = await accrueFloatingInterestThrough(tx, loan, through, actorUserId);
    const throughDate = bangkokDate(through);
    const corrupt = rows.find((row: typeof loanInterestAccruals.$inferSelect) =>
        row.status !== "reversed"
        && row.accrualDate <= throughDate
        && new Decimal(row.openingPrincipal).eq(0)
        && new Decimal(row.interestAmount).eq(0)
        && new Decimal(row.rate).gt(0)
        && new Decimal(loan.outstandingPrincipal ?? loan.principalAmount).gt(0));
    if (corrupt) {
        throw new DomainError("FLOATING_INTEREST_ACCRUAL_CORRUPT", "Floating interest history must be corrected before allocating a payment", 409, {
            loanPublicId: loan.publicId,
            accrualDate: corrupt.accrualDate,
            accrualPublicId: corrupt.publicId,
        });
    }
    return rows.filter((row: typeof loanInterestAccruals.$inferSelect) => ["accrued", "due", "partially_paid"].includes(row.status))
        .reduce((total: Decimal, row: typeof loanInterestAccruals.$inferSelect) => total.plus(new Decimal(row.interestAmount).minus(row.paidAmount)), new Decimal(0));
}

export async function correctFloatingInterestAccruals(ctx: CommandContext, loanPublicId: string, dates: string[], reason: string) {
    if (!ctx.idempotencyKey) throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", "Accrual correction requires an idempotency key", 400);
    const cleanReason = reason.trim();
    if (!cleanReason) throw new DomainError("CORRECTION_REASON_REQUIRED", "Accrual correction requires a reason", 400);
    const uniqueDates = [...new Set(dates)].sort();
    if (!uniqueDates.length) throw new DomainError("CORRECTION_DATES_REQUIRED", "Select at least one accrual date", 400);
    return db.transaction(async (tx) => {
        const prior = await tx.query.loanAdjustments.findFirst({ where: and(eq(loanAdjustments.tenantId, ctx.tenantId), eq(loanAdjustments.idempotencyKey, ctx.idempotencyKey!)) });
        if (prior) return { adjustmentPublicId: prior.publicId, correctedDates: uniqueDates, amount: new Decimal(prior.amount).toFixed(2) };
        const loan = await tx.query.loans.findFirst({ where: and(eq(loans.tenantId, ctx.tenantId), eq(loans.publicId, loanPublicId)) });
        if (!loan || loan.repaymentType !== "floating") throw new DomainError("FLOATING_LOAN_NOT_FOUND", "Floating loan not found", 404);
        await tx.execute(sql`SELECT id FROM loans WHERE tenant_id = ${ctx.tenantId} AND id = ${loan.id} FOR UPDATE`);
        const oldRows = await tx.select().from(loanInterestAccruals).where(and(
            eq(loanInterestAccruals.tenantId, ctx.tenantId), eq(loanInterestAccruals.loanId, loan.id),
            inArray(loanInterestAccruals.accrualDate, uniqueDates), sql`${loanInterestAccruals.status} <> 'reversed'`,
        )).orderBy(asc(loanInterestAccruals.accrualDate));
        if (oldRows.length !== uniqueDates.length) throw new DomainError("ACCRUAL_CORRECTION_TARGET_MISMATCH", "Every correction date must identify one active accrual", 409);
        const periodRows = await tx.select().from(loanInterestRatePeriods).where(and(eq(loanInterestRatePeriods.tenantId, ctx.tenantId), eq(loanInterestRatePeriods.loanId, loan.id))).orderBy(asc(loanInterestRatePeriods.effectiveDate));
        const periodValues: RatePeriodValue[] = periodRows.map((row) => ({ publicId: row.publicId, effectiveDate: row.effectiveDate, expiryDate: row.expiryDate, rateType: row.rateType as RateType, rate: row.rate }));
        const allTransactions = await tx.select().from(transactions).where(and(eq(transactions.tenantId, ctx.tenantId), eq(transactions.loanId, loan.id)));
        const reversedTransactionIds = new Set(allTransactions.flatMap((row) => row.reversedTransactionId === null ? [] : [row.reversedTransactionId]));
        let delta = new Decimal(0);
        const replacements = [] as Array<typeof loanInterestAccruals.$inferSelect>;
        for (const old of oldRows) {
            const periodValue = resolveRatePeriod(periodValues, old.accrualDate);
            const period = periodRows.find((row) => row.publicId === periodValue?.publicId);
            if (!periodValue || !period) throw new DomainError("RATE_PERIOD_MISSING_COVERAGE", "Floating loan has no interest rate for a correction date", 409, { accrualDate: old.accrualDate });
            const principalAppliedBefore = allTransactions
                .filter((row) => row.postedAt && row.transactionDate && row.reversedTransactionId === null && !reversedTransactionIds.has(row.id) && bangkokDate(row.transactionDate) < old.accrualDate)
                .reduce((sum, row) => sum.plus(row.principalComponent), new Decimal(0));
            const openingPrincipal = Decimal.max(0, new Decimal(loan.principalAmount).minus(principalAppliedBefore));
            const policy: FloatingDailyInterest = { mode: periodValue.rateType, rate: periodValue.rate, firstDayTreatment: loan.firstDayTreatment as FloatingDailyInterest["firstDayTreatment"] };
            const interestAmount = calculateDailyInterest(openingPrincipal.toFixed(2), policy);
            const paidAmount = old.accrualDate === loan.interestStartDate && loan.firstDayTreatment === "deduct"
                ? interestAmount
                : Decimal.min(new Decimal(old.paidAmount), new Decimal(interestAmount)).toFixed(2);
            await tx.update(loanInterestAccruals).set({ status: "reversed" }).where(and(eq(loanInterestAccruals.tenantId, ctx.tenantId), eq(loanInterestAccruals.id, old.id)));
            const replacement = await tx.insert(loanInterestAccruals).values({
                tenantId: ctx.tenantId, loanId: loan.id, interestRatePeriodId: period.id, accrualDate: old.accrualDate,
                openingPrincipal: openingPrincipal.toFixed(2), rateMode: periodValue.rateType, rate: periodValue.rate,
                interestAmount, paidAmount, status: new Decimal(paidAmount).eq(interestAmount) ? "paid" : "accrued",
                reversedAccrualId: old.id, createdByUserId: ctx.actorUserId,
            }).returning().then((rows) => rows[0]!);
            replacements.push(replacement);
            delta = delta.plus(new Decimal(interestAmount).minus(old.interestAmount));
        }
        const active = await tx.select().from(loanInterestAccruals).where(and(eq(loanInterestAccruals.tenantId, ctx.tenantId), eq(loanInterestAccruals.loanId, loan.id), sql`${loanInterestAccruals.status} <> 'reversed'`));
        const outstandingInterest = active.reduce((sum, row) => sum.plus(new Decimal(row.interestAmount).minus(row.paidAmount)), new Decimal(0));
        await tx.update(loans).set({ outstandingInterest: outstandingInterest.toFixed(2), updatedAt: new Date() }).where(and(eq(loans.tenantId, ctx.tenantId), eq(loans.id, loan.id)));
        const adjustment = await tx.insert(loanAdjustments).values({
            tenantId: ctx.tenantId, loanId: loan.id, adjustmentType: "floating_interest_accrual_correction", amount: delta.toFixed(2),
            idempotencyKey: ctx.idempotencyKey, reason: cleanReason, createdByUserId: ctx.actorUserId, updatedByUserId: ctx.actorUserId,
        }).returning().then((rows) => rows[0]!);
        await createAuditLog(tx, {
            tenantId: ctx.tenantId, actorUserId: ctx.actorUserId, actorSource: ctx.actorSource, requestId: ctx.requestId, correlationId: ctx.correlationId,
            entityType: "loan", entityId: loan.publicId, action: "floating_interest_accruals_corrected",
            payload: { adjustmentPublicId: adjustment.publicId, reason: cleanReason, corrected: replacements.map((row) => ({ accrualDate: row.accrualDate, accrualPublicId: row.publicId, openingPrincipal: new Decimal(row.openingPrincipal).toFixed(2), interestAmount: new Decimal(row.interestAmount).toFixed(2), paidAmount: new Decimal(row.paidAmount).toFixed(2) })) },
        });
        return { adjustmentPublicId: adjustment.publicId, correctedDates: uniqueDates, amount: delta.toFixed(2) };
    });
}
