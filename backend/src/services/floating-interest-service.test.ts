import { beforeEach, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { borrowers, loanInterestAccruals, loanInterestRatePeriods, loans, users } from "../db/schema";
import { accrueFloatingInterestThrough, floatingInterestDue } from "./floating-interest-service";

const integrationEnabled = Boolean(process.env.TEST_DATABASE_URL);
const integrationTest = integrationEnabled ? test : test.skip;

async function resetTables() {
    await db.execute(sql`SET client_min_messages TO WARNING`);
    await db.execute(sql`TRUNCATE TABLE transactions, loan_interest_accruals, loan_interest_rate_periods, loans, borrowers, users RESTART IDENTITY CASCADE`);
}

async function seedWeeklyLoan(tenantId: string) {
    const actor = await db.insert(users).values({
        tenantId,
        email: `${tenantId}@floating-accrual.test`,
        role: "owner",
    }).returning().then((rows) => rows[0]!);
    const borrower = await db.insert(borrowers).values({
        tenantId,
        ownerUserId: actor.id,
        name: `${tenantId} Borrower`,
    }).returning().then((rows) => rows[0]!);
    const loan = await db.insert(loans).values({
        tenantId,
        ownerUserId: actor.id,
        borrowerId: borrower.id,
        principalAmount: "5000.00",
        interestRate: "0.00",
        repaymentType: "floating",
        dailyInterestMode: "percent",
        dailyInterestRate: "12.0000",
        firstDayTreatment: "start_next_day",
        interestStartDate: "2026-08-13",
        interestPeriodUnit: "week",
        interestPeriodLength: 1,
        advanceInterestPeriods: 0,
        advanceInterestRefundPolicy: "non_refundable",
        interestPeriodAnchorDate: "2026-08-13",
        outstandingPrincipal: "5000.00",
        outstandingInterest: "0.00",
        outstandingFees: "0.00",
        status: "active",
    }).returning().then((rows) => rows[0]!);
    return { actor, borrower, loan };
}

function bangkokNoon(date: string) {
    return new Date(`${date}T12:00:00+07:00`);
}

describe("floating interest accrual service", () => {
    if (integrationEnabled) beforeEach(resetTables);

    // Break caught: weekly projection is payable before its boundary, loses the exact THB 600 total, or promotion rewrites snapshot money.
    integrationTest("keeps days one through seven accruing and promotes the completed period at its boundary", async () => {
        const { actor, loan } = await seedWeeklyLoan("tenant-weekly-boundary");
        await db.insert(loanInterestRatePeriods).values({
            tenantId: loan.tenantId,
            loanId: loan.id,
            effectiveDate: "2026-08-13",
            expiryDate: null,
            rateType: "percent",
            rate: "12.0000",
            periodUnit: "week",
            periodLength: 1,
            createdByUserId: actor.id,
        });

        for (const date of ["2026-08-13", "2026-08-14", "2026-08-15", "2026-08-16", "2026-08-17", "2026-08-18", "2026-08-19"]) {
            expect((await floatingInterestDue(db, loan, bangkokNoon(date), actor.id)).toFixed(2)).toBe("0.00");
        }

        const beforePromotion = await db.select().from(loanInterestAccruals)
            .where(and(eq(loanInterestAccruals.tenantId, loan.tenantId), eq(loanInterestAccruals.loanId, loan.id)))
            .orderBy(loanInterestAccruals.accrualDate);
        expect(beforePromotion.map((row) => ({
            accrualDate: row.accrualDate,
            interestAmount: row.interestAmount,
            cumulativeInterestAmount: row.cumulativeInterestAmount,
            periodDayIndex: row.periodDayIndex,
            status: row.status,
        }))).toEqual([
            { accrualDate: "2026-08-13", interestAmount: "85.71", cumulativeInterestAmount: "85.71", periodDayIndex: 1, status: "accruing" },
            { accrualDate: "2026-08-14", interestAmount: "85.72", cumulativeInterestAmount: "171.43", periodDayIndex: 2, status: "accruing" },
            { accrualDate: "2026-08-15", interestAmount: "85.71", cumulativeInterestAmount: "257.14", periodDayIndex: 3, status: "accruing" },
            { accrualDate: "2026-08-16", interestAmount: "85.72", cumulativeInterestAmount: "342.86", periodDayIndex: 4, status: "accruing" },
            { accrualDate: "2026-08-17", interestAmount: "85.71", cumulativeInterestAmount: "428.57", periodDayIndex: 5, status: "accruing" },
            { accrualDate: "2026-08-18", interestAmount: "85.72", cumulativeInterestAmount: "514.29", periodDayIndex: 6, status: "accruing" },
            { accrualDate: "2026-08-19", interestAmount: "85.71", cumulativeInterestAmount: "600.00", periodDayIndex: 7, status: "accruing" },
        ]);
        const immutableAmounts = beforePromotion.map((row) => ({
            publicId: row.publicId,
            openingPrincipal: row.openingPrincipal,
            interestAmount: row.interestAmount,
            contractualInterestAmount: row.contractualInterestAmount,
            cumulativeInterestAmount: row.cumulativeInterestAmount,
            dailyIncrementAmount: row.dailyIncrementAmount,
            paidAmount: row.paidAmount,
        }));

        expect((await floatingInterestDue(db, loan, bangkokNoon("2026-08-20"), actor.id)).toFixed(2)).toBe("600.00");

        const afterPromotion = await db.select().from(loanInterestAccruals)
            .where(and(eq(loanInterestAccruals.tenantId, loan.tenantId), eq(loanInterestAccruals.loanId, loan.id)))
            .orderBy(loanInterestAccruals.accrualDate);
        expect(afterPromotion).toHaveLength(8);
        expect(afterPromotion.slice(0, 7).every((row) => row.status === "due")).toBe(true);
        expect(afterPromotion[7]).toMatchObject({
            accrualDate: "2026-08-20",
            periodStartDate: "2026-08-20",
            periodEndDate: "2026-08-27",
            periodDayIndex: 1,
            status: "accruing",
        });
        expect(afterPromotion.slice(0, 7).map((row) => ({
            publicId: row.publicId,
            openingPrincipal: row.openingPrincipal,
            interestAmount: row.interestAmount,
            contractualInterestAmount: row.contractualInterestAmount,
            cumulativeInterestAmount: row.cumulativeInterestAmount,
            dailyIncrementAmount: row.dailyIncrementAmount,
            paidAmount: row.paidAmount,
        }))).toEqual(immutableAmounts);
    });

    // Break caught: catch-up accrual reuses one rate for every missing date or restarts the whole weekly cumulative amount after a rate segment changes.
    integrationTest("resolves the effective rate for each missing date and preserves cumulative segment totals", async () => {
        const { actor, loan } = await seedWeeklyLoan("tenant-weekly-rate-segments");
        const periods = await db.insert(loanInterestRatePeriods).values([
            {
                tenantId: loan.tenantId,
                loanId: loan.id,
                effectiveDate: "2026-08-13",
                expiryDate: "2026-08-15",
                rateType: "percent",
                rate: "12.0000",
                periodUnit: "week",
                periodLength: 1,
                createdByUserId: actor.id,
            },
            {
                tenantId: loan.tenantId,
                loanId: loan.id,
                effectiveDate: "2026-08-16",
                expiryDate: null,
                rateType: "percent",
                rate: "10.0000",
                createdByUserId: actor.id,
            },
        ]).returning();

        await accrueFloatingInterestThrough(db, loan, bangkokNoon("2026-08-17"), actor.id);

        expect(await db.select({
            accrualDate: loanInterestAccruals.accrualDate,
            interestRatePeriodId: loanInterestAccruals.interestRatePeriodId,
            rate: loanInterestAccruals.rate,
            interestAmount: loanInterestAccruals.interestAmount,
            cumulativeInterestAmount: loanInterestAccruals.cumulativeInterestAmount,
            contractualInterestAmount: loanInterestAccruals.contractualInterestAmount,
        }).from(loanInterestAccruals).where(eq(loanInterestAccruals.loanId, loan.id)).orderBy(loanInterestAccruals.accrualDate)).toEqual([
            { accrualDate: "2026-08-13", interestRatePeriodId: periods[0]!.id, rate: "12.0000", interestAmount: "85.71", cumulativeInterestAmount: "85.71", contractualInterestAmount: "600.00" },
            { accrualDate: "2026-08-14", interestRatePeriodId: periods[0]!.id, rate: "12.0000", interestAmount: "85.72", cumulativeInterestAmount: "171.43", contractualInterestAmount: "600.00" },
            { accrualDate: "2026-08-15", interestRatePeriodId: periods[0]!.id, rate: "12.0000", interestAmount: "85.71", cumulativeInterestAmount: "257.14", contractualInterestAmount: "600.00" },
            { accrualDate: "2026-08-16", interestRatePeriodId: periods[1]!.id, rate: "10.0000", interestAmount: "71.43", cumulativeInterestAmount: "328.57", contractualInterestAmount: "500.00" },
            { accrualDate: "2026-08-17", interestRatePeriodId: periods[1]!.id, rate: "10.0000", interestAmount: "71.43", cumulativeInterestAmount: "400.00", contractualInterestAmount: "500.00" },
        ]);
    });
});
