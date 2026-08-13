import { and, asc, eq, inArray, sql } from "drizzle-orm";
import Decimal from "decimal.js";
import { db } from "../db";
import { loanAdjustments, loanInterestAccruals, loanInterestRatePeriods, loans, transactions } from "../db/schema";
import { createAuditLog } from "../lib/audit-log";
import { calculateDailyInterest, interestDatesThrough, type FloatingAccrualCycle, type FloatingDailyInterest, type FloatingDailyInterestInput } from "../lib/floating-daily-interest";
import { calculateWeeklyAccruedInterest, weeklySnapshotPeriod } from "../lib/floating-interest-period";
import { resolveRatePeriod, type RatePeriodValue, type RateType } from "../lib/interest-rate-periods";
import { DomainError } from "./domain-error";
import type { CommandContext } from "./command-context";

type Executor = any;

function bangkokDate(value: Date) {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(value);
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value;
    return `${part("year")}-${part("month")}-${part("day")}`;
}

function calendarDays(from: string, to: string) {
    return Math.max(0, Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000));
}

type WeeklyExpectedAccrual = {
    accrualDate: string;
    interestRatePeriodId: number;
    openingPrincipal: string;
    rateMode: RateType;
    rate: string;
    periodStartDate: string;
    periodEndDate: string;
    periodDayIndex: number;
    periodDays: number;
    cumulativeInterestAmount: string;
    interestAmount: string;
    status: "accruing" | "due" | "paid";
    paidAmount: string;
};

async function weeklyExpectedAccruals(
    tx: Executor,
    loan: typeof loans.$inferSelect,
    throughDate: string,
): Promise<WeeklyExpectedAccrual[]> {
    if (!loan.interestStartDate || !loan.firstDayTreatment) return [];
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
    const allTransactions = await tx.select().from(transactions).where(and(
        eq(transactions.tenantId, loan.tenantId),
        eq(transactions.loanId, loan.id),
    ));
    const reversedTransactionIds = new Set<number>(allTransactions.flatMap((row: typeof transactions.$inferSelect) =>
        row.reversedTransactionId === null ? [] : [row.reversedTransactionId]));
    const dates = interestDatesThrough(
        loan.interestStartDate,
        throughDate,
        loan.firstDayTreatment as FloatingDailyInterest["firstDayTreatment"],
        "weekly",
    );

    let segmentKey = "";
    let segmentElapsed = 0;
    let periodKey = "";
    let periodCumulative = new Decimal(0);
    return dates.map((accrualDate) => {
        const snapshot = weeklySnapshotPeriod(loan.interestStartDate!, accrualDate);
        const advanceCovered = loan.firstDayTreatment === "deduct" && snapshot.periodStartDate === loan.interestStartDate;
        const periodValue = resolveRatePeriod(periods, advanceCovered ? loan.interestStartDate! : accrualDate);
        const storedPeriod = periodValue ? rowByPublicId.get(periodValue.publicId) : undefined;
        if (!periodValue || !storedPeriod) {
            throw new DomainError("RATE_PERIOD_MISSING_COVERAGE", "Floating loan has no interest rate for an accrual date", 409, {
                accrualDate,
                loanPublicId: loan.publicId,
            });
        }
        const principalAppliedBefore = allTransactions
            .filter((row: typeof transactions.$inferSelect) => row.postedAt
                && row.transactionDate
                && row.reversedTransactionId === null
                && !reversedTransactionIds.has(row.id)
                && bangkokDate(row.transactionDate) < accrualDate)
            .reduce((sum: Decimal, row: typeof transactions.$inferSelect) => sum.plus(row.principalComponent), new Decimal(0));
        const openingPrincipal = advanceCovered
            ? new Decimal(loan.principalAmount).toFixed(2)
            : Decimal.max(0, new Decimal(loan.principalAmount).minus(principalAppliedBefore)).toFixed(2);
        const nextPeriodKey = `${snapshot.periodStartDate}:${snapshot.periodEndDate}`;
        if (nextPeriodKey !== periodKey) {
            periodKey = nextPeriodKey;
            periodCumulative = new Decimal(0);
            segmentKey = "";
        }
        const nextSegmentKey = `${nextPeriodKey}:${storedPeriod.id}:${openingPrincipal}:${periodValue.rateType}:${periodValue.rate}`;
        segmentElapsed = advanceCovered ? snapshot.dayIndex : nextSegmentKey === segmentKey ? segmentElapsed + 1 : 1;
        segmentKey = nextSegmentKey;
        const calculated = calculateWeeklyAccruedInterest(openingPrincipal, periodValue.rateType, periodValue.rate, segmentElapsed);
        periodCumulative = periodCumulative.plus(calculated.incrementAmount);
        const advancePaid = advanceCovered;
        const periodComplete = throughDate >= snapshot.periodEndDate;
        return {
            accrualDate,
            interestRatePeriodId: storedPeriod.id,
            openingPrincipal,
            rateMode: periodValue.rateType,
            rate: periodValue.rate,
            periodStartDate: snapshot.periodStartDate,
            periodEndDate: snapshot.periodEndDate,
            periodDayIndex: snapshot.dayIndex,
            periodDays: snapshot.periodDays,
            cumulativeInterestAmount: periodCumulative.toFixed(2),
            interestAmount: calculated.incrementAmount,
            status: advancePaid ? "paid" : periodComplete ? "due" : "accruing",
            paidAmount: advancePaid ? calculated.incrementAmount : "0.00",
        };
    });
}

export async function accrueFloatingInterestThrough(tx: Executor, loan: typeof loans.$inferSelect, through: Date, actorUserId: number | null) {
    if (loan.repaymentType !== "floating" || !loan.dailyInterestMode || !loan.dailyInterestRate || !loan.firstDayTreatment || !loan.interestStartDate) return [];
    const firstDayTreatment = loan.firstDayTreatment as FloatingDailyInterest["firstDayTreatment"];
    const accrualCycle = (loan.floatingAccrualCycle ?? "daily") as FloatingAccrualCycle;
    const existing = await tx.select().from(loanInterestAccruals).where(and(eq(loanInterestAccruals.tenantId, loan.tenantId), eq(loanInterestAccruals.loanId, loan.id)));
    if (accrualCycle === "weekly") {
        const throughDate = bangkokDate(through);
        const expected = await weeklyExpectedAccruals(tx, loan, throughDate);
        const dates = new Set(existing.filter((row: typeof loanInterestAccruals.$inferSelect) => row.status !== "reversed").map((row: typeof loanInterestAccruals.$inferSelect) => row.accrualDate));
        const legacyCoveredPeriods = new Set<string>();
        for (const row of existing as Array<typeof loanInterestAccruals.$inferSelect>) {
            if (row.status === "reversed" || row.periodStartDate !== null) continue;
            if (row.accrualDate === loan.interestStartDate && firstDayTreatment === "deduct") {
                legacyCoveredPeriods.add(loan.interestStartDate);
                continue;
            }
            try {
                legacyCoveredPeriods.add(weeklySnapshotPeriod(loan.interestStartDate, row.accrualDate).periodStartDate);
            } catch {
                // A legacy anchor-date advance row is handled above; malformed history remains visible for correction.
            }
        }
        const missing = expected.filter((row) => !dates.has(row.accrualDate) && !legacyCoveredPeriods.has(row.periodStartDate));
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
                cumulativeInterestAmount: row.cumulativeInterestAmount,
                interestAmount: row.interestAmount,
                paidAmount: row.paidAmount,
                status: row.status,
                createdByUserId: actorUserId,
            }))).onConflictDoNothing();
        }
        const completedPeriodStarts = [...new Set(expected.filter((row) => row.status === "due").map((row) => row.periodStartDate))];
        if (completedPeriodStarts.length) {
            await tx.update(loanInterestAccruals).set({ status: "due" }).where(and(
                eq(loanInterestAccruals.tenantId, loan.tenantId),
                eq(loanInterestAccruals.loanId, loan.id),
                inArray(loanInterestAccruals.periodStartDate, completedPeriodStarts),
                eq(loanInterestAccruals.status, "accruing"),
            ));
        }
        return await tx.select().from(loanInterestAccruals).where(and(eq(loanInterestAccruals.tenantId, loan.tenantId), eq(loanInterestAccruals.loanId, loan.id)));
    }
    const dates = new Set(existing.map((row: typeof loanInterestAccruals.$inferSelect) => row.accrualDate));
    const dueDates = interestDatesThrough(loan.interestStartDate, bangkokDate(through), firstDayTreatment, accrualCycle).filter((date) => !dates.has(date));
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
        const policy: FloatingDailyInterestInput = {
            mode: effectivePeriod.rateType,
            rate: effectivePeriod.rate,
            firstDayTreatment,
            accrualCycle,
        };
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
    return await tx.select().from(loanInterestAccruals).where(and(eq(loanInterestAccruals.tenantId, loan.tenantId), eq(loanInterestAccruals.loanId, loan.id)));
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
    return rows.filter((row: typeof loanInterestAccruals.$inferSelect) => row.status === "accrued" || row.status === "due" || row.status === "partially_paid")
        .reduce((total: Decimal, row: typeof loanInterestAccruals.$inferSelect) => total.plus(new Decimal(row.interestAmount).minus(row.paidAmount)), new Decimal(0));
}

export async function floatingInterestBalances(tx: Executor, loan: typeof loans.$inferSelect, through: Date, actorUserId: number | null) {
    const rows = await accrueFloatingInterestThrough(tx, loan, through, actorUserId);
    let dueInterest = new Decimal(0);
    let accruingInterest = new Decimal(0);
    for (const row of rows as Array<typeof loanInterestAccruals.$inferSelect>) {
        if (row.status === "reversed" || row.status === "paid") continue;
        const unpaid = Decimal.max(new Decimal(row.interestAmount).minus(row.paidAmount), 0);
        if (row.status === "accruing") accruingInterest = accruingInterest.plus(unpaid);
        else dueInterest = dueInterest.plus(unpaid);
    }
    const throughDate = bangkokDate(through);
    const payableGroups = new Map<string, Decimal>();
    for (const row of rows as Array<typeof loanInterestAccruals.$inferSelect>) {
        if (!["accrued", "due", "partially_paid"].includes(row.status)) continue;
        const dueDate = row.periodEndDate ?? row.accrualDate;
        const unpaid = Decimal.max(new Decimal(row.interestAmount).minus(row.paidAmount), 0);
        if (unpaid.gt(0)) payableGroups.set(dueDate, (payableGroups.get(dueDate) ?? new Decimal(0)).plus(unpaid));
    }
    const feeValue = new Decimal(loan.lateFeeAmount ?? "0.00");
    const graceDays = Math.max(0, loan.gracePeriodDays ?? 0);
    let calculatedPenalty = new Decimal(0);
    for (const [dueDate, unpaid] of payableGroups) {
        const overdueDays = Math.max(0, calendarDays(dueDate, throughDate) - graceDays);
        if (overdueDays === 0) continue;
        if (loan.lateFeeMode === "fixed" || loan.lateFeeMode === "fixed_plus_percent") {
            calculatedPenalty = calculatedPenalty.plus(feeValue);
        }
        if (loan.lateFeeMode === "daily_percent" || loan.lateFeeMode === "fixed_plus_percent") {
            calculatedPenalty = calculatedPenalty.plus(unpaid.times(feeValue).div(100).times(overdueDays));
        }
    }
    calculatedPenalty = calculatedPenalty.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const transactionRows = await tx.select().from(transactions).where(and(
        eq(transactions.tenantId, loan.tenantId),
        eq(transactions.loanId, loan.id),
    ));
    const paidPenalty = transactionRows.reduce(
        (sum: Decimal, transaction: typeof transactions.$inferSelect) => sum.plus(transaction.penaltyComponent),
        new Decimal(0),
    );
    const applicablePenalty = Decimal.max(calculatedPenalty.minus(paidPenalty), 0);
    return { rows, dueInterest, accruingInterest, applicablePenalty };
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
        if (!loan.interestStartDate || !loan.firstDayTreatment) {
            throw new DomainError("INVALID_LOAN_TERMS", "Floating interest policy is invalid", 409);
        }
        const firstDayTreatment = loan.firstDayTreatment as FloatingDailyInterest["firstDayTreatment"];
        const accrualCycle = (loan.floatingAccrualCycle ?? "daily") as FloatingAccrualCycle;
        for (const accrualDate of uniqueDates) {
            let scheduled = false;
            try {
                scheduled = interestDatesThrough(
                    loan.interestStartDate,
                    accrualDate,
                    firstDayTreatment,
                    accrualCycle,
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
        const periodRows = await tx.select().from(loanInterestRatePeriods).where(and(eq(loanInterestRatePeriods.tenantId, ctx.tenantId), eq(loanInterestRatePeriods.loanId, loan.id))).orderBy(asc(loanInterestRatePeriods.effectiveDate));
        const periodValues: RatePeriodValue[] = periodRows.map((row) => ({ publicId: row.publicId, effectiveDate: row.effectiveDate, expiryDate: row.expiryDate, rateType: row.rateType as RateType, rate: row.rate }));
        const allTransactions = await tx.select().from(transactions).where(and(eq(transactions.tenantId, ctx.tenantId), eq(transactions.loanId, loan.id)));
        const reversedTransactionIds = new Set(allTransactions.flatMap((row) => row.reversedTransactionId === null ? [] : [row.reversedTransactionId]));
        const weeklyExpected = accrualCycle === "weekly"
            ? new Map((await weeklyExpectedAccruals(tx, loan, uniqueDates.at(-1)!)).map((row) => [row.accrualDate, row]))
            : null;
        let delta = new Decimal(0);
        const replacements = [] as Array<typeof loanInterestAccruals.$inferSelect>;
        for (const old of oldRows) {
            const weekly = weeklyExpected?.get(old.accrualDate);
            if (accrualCycle === "weekly" && !weekly) {
                throw new DomainError("ACCRUAL_DATE_NOT_SCHEDULED", "Floating accrual date is outside the loan's accrual cycle", 409, { accrualDate: old.accrualDate });
            }
            const periodValue = resolveRatePeriod(periodValues, old.accrualDate);
            const period = periodRows.find((row) => row.publicId === periodValue?.publicId);
            if (!periodValue || !period) throw new DomainError("RATE_PERIOD_MISSING_COVERAGE", "Floating loan has no interest rate for a correction date", 409, { accrualDate: old.accrualDate });
            const principalAppliedBefore = allTransactions
                .filter((row) => row.postedAt && row.transactionDate && row.reversedTransactionId === null && !reversedTransactionIds.has(row.id) && bangkokDate(row.transactionDate) < old.accrualDate)
                .reduce((sum, row) => sum.plus(row.principalComponent), new Decimal(0));
            const openingPrincipal = weekly
                ? new Decimal(weekly.openingPrincipal)
                : Decimal.max(0, new Decimal(loan.principalAmount).minus(principalAppliedBefore));
            const policy: FloatingDailyInterestInput = {
                mode: periodValue.rateType,
                rate: periodValue.rate,
                firstDayTreatment,
                accrualCycle,
            };
            const interestAmount = weekly?.interestAmount ?? calculateDailyInterest(openingPrincipal.toFixed(2), policy);
            const paidAmount = weekly?.status === "paid" || (old.accrualDate === loan.interestStartDate && loan.firstDayTreatment === "deduct")
                ? interestAmount
                : Decimal.min(new Decimal(old.paidAmount), new Decimal(interestAmount)).toFixed(2);
            await tx.update(loanInterestAccruals).set({ status: "reversed" }).where(and(eq(loanInterestAccruals.tenantId, ctx.tenantId), eq(loanInterestAccruals.id, old.id)));
            const replacement = await tx.insert(loanInterestAccruals).values({
                tenantId: ctx.tenantId, loanId: loan.id, interestRatePeriodId: period.id, accrualDate: old.accrualDate,
                openingPrincipal: openingPrincipal.toFixed(2), rateMode: periodValue.rateType, rate: periodValue.rate,
                periodStartDate: weekly?.periodStartDate ?? null,
                periodEndDate: weekly?.periodEndDate ?? null,
                periodDayIndex: weekly?.periodDayIndex ?? null,
                periodDays: weekly?.periodDays ?? null,
                cumulativeInterestAmount: weekly?.cumulativeInterestAmount ?? null,
                interestAmount, paidAmount,
                status: new Decimal(paidAmount).eq(interestAmount) ? "paid" : weekly?.status ?? "accrued",
                reversedAccrualId: old.id, createdByUserId: ctx.actorUserId,
            }).returning().then((rows) => rows[0]!);
            replacements.push(replacement);
            delta = delta.plus(new Decimal(interestAmount).minus(old.interestAmount));
        }
        const active = await tx.select().from(loanInterestAccruals).where(and(eq(loanInterestAccruals.tenantId, ctx.tenantId), eq(loanInterestAccruals.loanId, loan.id), sql`${loanInterestAccruals.status} <> 'reversed'`));
        const outstandingInterest = active
            .filter((row) => row.status !== "accruing" && row.status !== "paid")
            .reduce((sum, row) => sum.plus(new Decimal(row.interestAmount).minus(row.paidAmount)), new Decimal(0));
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
