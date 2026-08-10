import { and, eq } from "drizzle-orm";
import Decimal from "decimal.js";
import { loanInterestAccruals, loans } from "../db/schema";
import { calculateDailyInterest, interestDatesThrough, type FloatingDailyInterest } from "../lib/floating-daily-interest";

type Executor = any;

function bangkokDate(value: Date) {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(value);
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value;
    return `${part("year")}-${part("month")}-${part("day")}`;
}

export async function accrueFloatingInterestThrough(tx: Executor, loan: typeof loans.$inferSelect, through: Date, actorUserId: number | null) {
    if (loan.repaymentType !== "floating" || !loan.dailyInterestMode || !loan.dailyInterestRate || !loan.firstDayTreatment || !loan.interestStartDate) return [];
    const policy: FloatingDailyInterest = { mode: loan.dailyInterestMode as FloatingDailyInterest["mode"], rate: loan.dailyInterestRate, firstDayTreatment: loan.firstDayTreatment as FloatingDailyInterest["firstDayTreatment"] };
    const existing = await tx.select().from(loanInterestAccruals).where(and(eq(loanInterestAccruals.tenantId, loan.tenantId), eq(loanInterestAccruals.loanId, loan.id)));
    const dates = new Set(existing.map((row: typeof loanInterestAccruals.$inferSelect) => row.accrualDate));
    const dueDates = interestDatesThrough(loan.interestStartDate, bangkokDate(through), policy.firstDayTreatment).filter((date) => !dates.has(date));
    if (!dueDates.length) return existing;
    const openingPrincipal = new Decimal(loan.outstandingPrincipal ?? loan.principalAmount);
    const interestAmount = calculateDailyInterest(openingPrincipal.toFixed(2), policy);
    await tx.insert(loanInterestAccruals).values(dueDates.map((accrualDate) => ({
        tenantId: loan.tenantId, loanId: loan.id, accrualDate, openingPrincipal: openingPrincipal.toFixed(2),
        rateMode: policy.mode, rate: policy.rate, interestAmount, status: "accrued", createdByUserId: actorUserId,
    }))).onConflictDoNothing();
    return await tx.select().from(loanInterestAccruals).where(and(eq(loanInterestAccruals.tenantId, loan.tenantId), eq(loanInterestAccruals.loanId, loan.id)));
}

export async function floatingInterestDue(tx: Executor, loan: typeof loans.$inferSelect, through: Date, actorUserId: number | null) {
    const rows = await accrueFloatingInterestThrough(tx, loan, through, actorUserId);
    return rows.filter((row: typeof loanInterestAccruals.$inferSelect) => row.status === "accrued")
        .reduce((total: Decimal, row: typeof loanInterestAccruals.$inferSelect) => total.plus(new Decimal(row.interestAmount).minus(row.paidAmount)), new Decimal(0));
}
