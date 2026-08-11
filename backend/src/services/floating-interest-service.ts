import { and, asc, eq, inArray, sql } from "drizzle-orm";
import Decimal from "decimal.js";
import { db } from "../db";
import { loanAdjustments, loanInterestAccruals, loanInterestRatePeriods, loans, transactions } from "../db/schema";
import { createAuditLog } from "../lib/audit-log";
import { calculateDailyInterest, interestDatesThrough, type FloatingDailyInterest } from "../lib/floating-daily-interest";
import { resolveRatePeriod, type RatePeriodValue, type RateType } from "../lib/interest-rate-periods";
import { DomainError } from "./domain-error";
import type { CommandContext } from "./command-context";

type Executor = any;

function bangkokDate(value: Date) {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(value);
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value;
    return `${part("year")}-${part("month")}-${part("day")}`;
}

export async function accrueFloatingInterestThrough(tx: Executor, loan: typeof loans.$inferSelect, through: Date, actorUserId: number | null) {
    if (loan.repaymentType !== "floating" || !loan.dailyInterestMode || !loan.dailyInterestRate || !loan.firstDayTreatment || !loan.interestStartDate) return [];
    const firstDayTreatment = loan.firstDayTreatment as FloatingDailyInterest["firstDayTreatment"];
    const existing = await tx.select().from(loanInterestAccruals).where(and(eq(loanInterestAccruals.tenantId, loan.tenantId), eq(loanInterestAccruals.loanId, loan.id)));
    const dates = new Set(existing.map((row: typeof loanInterestAccruals.$inferSelect) => row.accrualDate));
    const dueDates = interestDatesThrough(loan.interestStartDate, bangkokDate(through), firstDayTreatment).filter((date) => !dates.has(date));
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
        const policy: FloatingDailyInterest = {
            mode: effectivePeriod.rateType,
            rate: effectivePeriod.rate,
            firstDayTreatment,
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
    return rows.filter((row: typeof loanInterestAccruals.$inferSelect) => row.status === "accrued")
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
