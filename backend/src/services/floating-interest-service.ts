import { and, asc, eq } from "drizzle-orm";
import Decimal from "decimal.js";
import { loanInterestAccruals, loanInterestRatePeriods, loans } from "../db/schema";
import { calculateDailyInterest, interestDatesThrough, type FloatingDailyInterest } from "../lib/floating-daily-interest";
import { resolveRatePeriod, type RatePeriodValue, type RateType } from "../lib/interest-rate-periods";
import { DomainError } from "./domain-error";

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
    return rows.filter((row: typeof loanInterestAccruals.$inferSelect) => row.status === "accrued")
        .reduce((total: Decimal, row: typeof loanInterestAccruals.$inferSelect) => total.plus(new Decimal(row.interestAmount).minus(row.paidAmount)), new Decimal(0));
}
