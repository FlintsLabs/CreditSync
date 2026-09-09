import { beforeEach, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { auditLogs, borrowers, loanInterestAccruals, loanInterestRatePeriods, loans, transactions, users } from "../db/schema";
import type { CommandContext } from "./command-context";
import { accrueFloatingInterestThrough, correctFloatingInterestAccruals, floatingInterestDue } from "./floating-interest-service";

const integrationEnabled = Boolean(process.env.TEST_DATABASE_URL);
const integrationTest = integrationEnabled ? test : test.skip;

async function resetTables() {
    await db.execute(sql`SET client_min_messages TO WARNING`);
    await db.execute(sql`TRUNCATE TABLE audit_logs, loan_adjustments, transactions, loan_interest_accruals, loan_interest_rate_periods, loans, borrowers, users RESTART IDENTITY CASCADE`);
}

async function seedWeeklyLoan(tenantId: string, overrides: Partial<typeof loans.$inferInsert> = {}) {
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
        ...overrides,
    }).returning().then((rows) => rows[0]!);
    return { actor, borrower, loan };
}

function bangkokNoon(date: string) {
    return new Date(`${date}T12:00:00+07:00`);
}

function context(actor: { id: number; tenantId: string }, idempotencyKey: string = crypto.randomUUID()): CommandContext {
    return {
        tenantId: actor.tenantId,
        actorUserId: actor.id,
        actorSource: "web",
        requestId: `req-${actor.tenantId}`,
        correlationId: `corr-${actor.tenantId}`,
        idempotencyKey,
    };
}

describe("floating interest accrual service", () => {
    if (integrationEnabled) beforeEach(resetTables);

    // Break caught: the service's Decimal context rounds away cents while reconstructing a
    // 29-digit principal, summing weekly accruals, or recording a correction delta.
    integrationTest("preserves exact 29-digit principal history, accrual totals, and correction deltas", async () => {
        const principal = "98765432109876543210987654321.09";
        const principalPayment = "12345678901234567890.10";
        const reducedPrincipal = "98765432097530864309753086430.99";
        const { actor, loan } = await seedWeeklyLoan("tenant-weekly-precision-boundary", {
            principalAmount: principal,
            outstandingPrincipal: reducedPrincipal,
            dailyInterestRate: "0.0007",
            interestPeriodAnchorDate: "2026-08-14",
            interestStartDate: "2026-08-14",
        });
        const ratePeriod = await db.insert(loanInterestRatePeriods).values({
            tenantId: loan.tenantId,
            loanId: loan.id,
            effectiveDate: "2026-08-14",
            expiryDate: null,
            rateType: "percent",
            rate: "0.0007",
            periodUnit: "week",
            periodLength: 1,
            createdByUserId: actor.id,
        }).returning().then((rows) => rows[0]!);
        const payment = await db.insert(transactions).values({
            tenantId: loan.tenantId,
            ownerUserId: actor.id,
            loanId: loan.id,
            amount: principalPayment,
            principalComponent: principalPayment,
            interestComponent: "0.00",
            feeComponent: "0.00",
            penaltyComponent: "0.00",
            type: "repayment",
            transactionDate: new Date("2026-08-13T12:00:00+07:00"),
            recordedByUserId: actor.id,
            entryType: "repayment",
            idempotencyKey: "precision-boundary-payment",
            postedAt: new Date("2026-08-13T12:00:00+07:00"),
        }).returning().then((rows) => rows[0]!);
        const storedLoan = await db.query.loans.findFirst({ where: eq(loans.id, loan.id) });

        await accrueFloatingInterestThrough(db, storedLoan!, bangkokNoon("2026-08-20"), context(actor));

        const initial = await db.select({
            accrualDate: loanInterestAccruals.accrualDate,
            openingPrincipal: loanInterestAccruals.openingPrincipal,
            interestAmount: loanInterestAccruals.interestAmount,
            cumulativeInterestAmount: loanInterestAccruals.cumulativeInterestAmount,
        }).from(loanInterestAccruals)
            .where(eq(loanInterestAccruals.loanId, loan.id))
            .orderBy(loanInterestAccruals.accrualDate);
        expect(initial).toEqual([
            { accrualDate: "2026-08-14", openingPrincipal: reducedPrincipal, interestAmount: "98765432097530864309753.09", cumulativeInterestAmount: "98765432097530864309753.09" },
            { accrualDate: "2026-08-15", openingPrincipal: reducedPrincipal, interestAmount: "98765432097530864309753.08", cumulativeInterestAmount: "197530864195061728619506.17" },
            { accrualDate: "2026-08-16", openingPrincipal: reducedPrincipal, interestAmount: "98765432097530864309753.09", cumulativeInterestAmount: "296296296292592592929259.26" },
            { accrualDate: "2026-08-17", openingPrincipal: reducedPrincipal, interestAmount: "98765432097530864309753.09", cumulativeInterestAmount: "395061728390123457239012.35" },
            { accrualDate: "2026-08-18", openingPrincipal: reducedPrincipal, interestAmount: "98765432097530864309753.08", cumulativeInterestAmount: "493827160487654321548765.43" },
            { accrualDate: "2026-08-19", openingPrincipal: reducedPrincipal, interestAmount: "98765432097530864309753.09", cumulativeInterestAmount: "592592592585185185858518.52" },
            { accrualDate: "2026-08-20", openingPrincipal: reducedPrincipal, interestAmount: "98765432097530864309753.09", cumulativeInterestAmount: "691358024682716050168271.61" },
        ]);

        await db.insert(transactions).values({
            tenantId: loan.tenantId,
            ownerUserId: actor.id,
            loanId: loan.id,
            amount: `-${principalPayment}`,
            principalComponent: `-${principalPayment}`,
            interestComponent: "0.00",
            feeComponent: "0.00",
            penaltyComponent: "0.00",
            type: "reversal",
            transactionDate: new Date("2026-08-16T12:00:00+07:00"),
            recordedByUserId: actor.id,
            entryType: "reversal",
            reversedTransactionId: payment.id,
            idempotencyKey: "precision-boundary-payment-reversal",
            postedAt: new Date("2026-08-20T12:00:00+07:00"),
        });
        const correction = await correctFloatingInterestAccruals(
            context(actor, "precision-boundary-correction"),
            loan.publicId,
            ["2026-08-17"],
            "Restore exact principal after the compensating reversal",
        );

        expect(correction.amount).toBe("49382715604938.27");
        const activeFinal = await db.query.loanInterestAccruals.findFirst({
            where: and(
                eq(loanInterestAccruals.loanId, loan.id),
                eq(loanInterestAccruals.accrualDate, "2026-08-20"),
                sql`${loanInterestAccruals.status} <> 'reversed'`,
            ),
        });
        expect(activeFinal).toMatchObject({
            openingPrincipal: principal,
            interestRatePeriodId: ratePeriod.id,
            interestAmount: "98765432109876543210987.66",
            cumulativeInterestAmount: "691358024732098765773209.88",
        });
        expect((await floatingInterestDue(
            db,
            (await db.query.loans.findFirst({ where: eq(loans.id, loan.id) }))!,
            bangkokNoon("2026-08-21"),
            context(actor),
        )).toFixed(2)).toBe("691358024732098765773209.88");
    });

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
            expect((await floatingInterestDue(db, loan, bangkokNoon(date), context(actor))).toFixed(2)).toBe("0.00");
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

        expect((await floatingInterestDue(db, loan, new Date("2026-08-19T16:59:59.999Z"), context(actor))).toFixed(2)).toBe("0.00");
        expect((await floatingInterestDue(db, loan, new Date("2026-08-19T17:00:00.000Z"), context(actor))).toFixed(2)).toBe("600.00");

        const promotionAudit = (await db.select().from(auditLogs).where(eq(
            auditLogs.action,
            "floating_interest_accruals_materialized",
        ))).find((row) => (row.payload as { promotedAccrualPublicIds?: string[] }).promotedAccrualPublicIds?.length === 7);
        expect(promotionAudit).toMatchObject({
            actorUserId: actor.id,
            actorSource: "web",
            requestId: `req-${actor.tenantId}`,
            correlationId: `corr-${actor.tenantId}`,
            entityId: loan.publicId,
        });
        expect(promotionAudit?.payload).toMatchObject({
            throughDate: "2026-08-20",
            promotedAccrualPublicIds: expect.arrayContaining(beforePromotion.map((row) => row.publicId)),
        });

        // Persisted promotion is not permission to allocate the period before its boundary.
        expect((await floatingInterestDue(db, loan, bangkokNoon("2026-08-15"), context(actor))).toFixed(2)).toBe("0.00");

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

        await accrueFloatingInterestThrough(db, loan, bangkokNoon("2026-08-17"), context(actor));

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

    // Break caught: weekly correction applies the weekly quote as a daily rate, removes snapshot metadata, or retains a fully compensated payment in principal history.
    integrationTest("corrects weekly snapshots with signed transaction history effective on each Bangkok date", async () => {
        const { actor, loan } = await seedWeeklyLoan("tenant-weekly-correction");
        const ratePeriod = await db.insert(loanInterestRatePeriods).values({
            tenantId: loan.tenantId,
            loanId: loan.id,
            effectiveDate: "2026-08-13",
            expiryDate: null,
            rateType: "percent",
            rate: "12.0000",
            periodUnit: "week",
            periodLength: 1,
            createdByUserId: actor.id,
        }).returning().then((rows) => rows[0]!);
        await accrueFloatingInterestThrough(db, loan, bangkokNoon("2026-08-20"), context(actor));
        const original = await db.insert(transactions).values({
            tenantId: loan.tenantId,
            ownerUserId: actor.id,
            loanId: loan.id,
            amount: "1000.00",
            principalComponent: "1000.00",
            interestComponent: "0.00",
            feeComponent: "0.00",
            penaltyComponent: "0.00",
            type: "repayment",
            transactionDate: new Date("2026-08-15T12:00:00+07:00"),
            recordedByUserId: actor.id,
            entryType: "repayment",
            idempotencyKey: "weekly-correction-original",
            postedAt: new Date("2026-08-20T12:00:00+07:00"),
        }).returning().then((rows) => rows[0]!);
        await db.insert(transactions).values({
            tenantId: loan.tenantId,
            ownerUserId: actor.id,
            loanId: loan.id,
            amount: "-1000.00",
            principalComponent: "-1000.00",
            interestComponent: "0.00",
            feeComponent: "0.00",
            penaltyComponent: "0.00",
            type: "reversal",
            transactionDate: new Date("2026-08-18T12:00:00+07:00"),
            recordedByUserId: actor.id,
            entryType: "reversal",
            reversedTransactionId: original.id,
            idempotencyKey: "weekly-correction-reversal",
            postedAt: new Date("2026-08-20T12:00:00+07:00"),
        });

        await correctFloatingInterestAccruals(
            context(actor, "weekly-correction-1"),
            loan.publicId,
            ["2026-08-16", "2026-08-17", "2026-08-18", "2026-08-19"],
            "Apply signed historical principal timeline",
        );

        const active = await db.select({
            accrualDate: loanInterestAccruals.accrualDate,
            openingPrincipal: loanInterestAccruals.openingPrincipal,
            interestRatePeriodId: loanInterestAccruals.interestRatePeriodId,
            periodStartDate: loanInterestAccruals.periodStartDate,
            periodEndDate: loanInterestAccruals.periodEndDate,
            periodDayIndex: loanInterestAccruals.periodDayIndex,
            interestAmount: loanInterestAccruals.interestAmount,
            cumulativeInterestAmount: loanInterestAccruals.cumulativeInterestAmount,
            status: loanInterestAccruals.status,
            reversedAccrualId: loanInterestAccruals.reversedAccrualId,
        }).from(loanInterestAccruals).where(and(
            eq(loanInterestAccruals.loanId, loan.id),
            sql`${loanInterestAccruals.status} <> 'reversed'`,
        )).orderBy(loanInterestAccruals.accrualDate);
        expect(active.slice(3, 7)).toEqual([
            { accrualDate: "2026-08-16", openingPrincipal: "5000.00", interestRatePeriodId: ratePeriod.id, periodStartDate: "2026-08-13", periodEndDate: "2026-08-20", periodDayIndex: 4, interestAmount: "85.72", cumulativeInterestAmount: "342.86", status: "due", reversedAccrualId: expect.any(Number) },
            { accrualDate: "2026-08-17", openingPrincipal: "5000.00", interestRatePeriodId: ratePeriod.id, periodStartDate: "2026-08-13", periodEndDate: "2026-08-20", periodDayIndex: 5, interestAmount: "85.71", cumulativeInterestAmount: "428.57", status: "due", reversedAccrualId: expect.any(Number) },
            { accrualDate: "2026-08-18", openingPrincipal: "5000.00", interestRatePeriodId: ratePeriod.id, periodStartDate: "2026-08-13", periodEndDate: "2026-08-20", periodDayIndex: 6, interestAmount: "85.72", cumulativeInterestAmount: "514.29", status: "due", reversedAccrualId: expect.any(Number) },
            { accrualDate: "2026-08-19", openingPrincipal: "5000.00", interestRatePeriodId: ratePeriod.id, periodStartDate: "2026-08-13", periodEndDate: "2026-08-20", periodDayIndex: 7, interestAmount: "85.71", cumulativeInterestAmount: "600.00", status: "due", reversedAccrualId: expect.any(Number) },
        ]);
        expect((await floatingInterestDue(db, loan, bangkokNoon("2026-08-20"), context(actor))).toFixed(2)).toBe("600.00");
        expect(await db.query.loans.findFirst({ where: eq(loans.id, loan.id) })).toMatchObject({ outstandingInterest: "600.00" });
    });

    // Break caught: sparse correction targets let an untouched row overwrite the running weekly cumulative delta and leave the later suffix on stale principal.
    integrationTest("reprojects the complete materialized suffix for sparse weekly correction dates", async () => {
        const { actor, loan } = await seedWeeklyLoan("tenant-weekly-sparse-correction");
        const ratePeriod = await db.insert(loanInterestRatePeriods).values({
            tenantId: loan.tenantId,
            loanId: loan.id,
            effectiveDate: "2026-08-13",
            expiryDate: null,
            rateType: "percent",
            rate: "12.0000",
            periodUnit: "week",
            periodLength: 1,
            createdByUserId: actor.id,
        }).returning().then((rows) => rows[0]!);
        await accrueFloatingInterestThrough(db, loan, bangkokNoon("2026-08-20"), context(actor));
        await db.insert(transactions).values({
            tenantId: loan.tenantId,
            ownerUserId: actor.id,
            loanId: loan.id,
            amount: "1000.00",
            principalComponent: "1000.00",
            interestComponent: "0.00",
            feeComponent: "0.00",
            penaltyComponent: "0.00",
            type: "repayment",
            transactionDate: new Date("2026-08-15T12:00:00+07:00"),
            recordedByUserId: actor.id,
            entryType: "repayment",
            idempotencyKey: "weekly-sparse-correction-payment",
            postedAt: new Date("2026-08-20T12:00:00+07:00"),
        });

        const corrected = await correctFloatingInterestAccruals(
            context(actor, "weekly-sparse-correction-1"),
            loan.publicId,
            ["2026-08-18", "2026-08-16"],
            "Repair the full suffix from sparse evidence dates",
        );

        const activeSuffix = await db.select({
            accrualDate: loanInterestAccruals.accrualDate,
            openingPrincipal: loanInterestAccruals.openingPrincipal,
            interestRatePeriodId: loanInterestAccruals.interestRatePeriodId,
            contractualInterestAmount: loanInterestAccruals.contractualInterestAmount,
            interestAmount: loanInterestAccruals.interestAmount,
            cumulativeInterestAmount: loanInterestAccruals.cumulativeInterestAmount,
            status: loanInterestAccruals.status,
            reversedAccrualId: loanInterestAccruals.reversedAccrualId,
        }).from(loanInterestAccruals).where(and(
            eq(loanInterestAccruals.loanId, loan.id),
            sql`${loanInterestAccruals.status} <> 'reversed'`,
            sql`${loanInterestAccruals.accrualDate} >= '2026-08-16'`,
        )).orderBy(loanInterestAccruals.accrualDate);
        expect(activeSuffix).toEqual([
            { accrualDate: "2026-08-16", openingPrincipal: "4000.00", interestRatePeriodId: ratePeriod.id, contractualInterestAmount: "480.00", interestAmount: "68.57", cumulativeInterestAmount: "325.71", status: "due", reversedAccrualId: expect.any(Number) },
            { accrualDate: "2026-08-17", openingPrincipal: "4000.00", interestRatePeriodId: ratePeriod.id, contractualInterestAmount: "480.00", interestAmount: "68.57", cumulativeInterestAmount: "394.28", status: "due", reversedAccrualId: expect.any(Number) },
            { accrualDate: "2026-08-18", openingPrincipal: "4000.00", interestRatePeriodId: ratePeriod.id, contractualInterestAmount: "480.00", interestAmount: "68.57", cumulativeInterestAmount: "462.85", status: "due", reversedAccrualId: expect.any(Number) },
            { accrualDate: "2026-08-19", openingPrincipal: "4000.00", interestRatePeriodId: ratePeriod.id, contractualInterestAmount: "480.00", interestAmount: "68.58", cumulativeInterestAmount: "531.43", status: "due", reversedAccrualId: expect.any(Number) },
            { accrualDate: "2026-08-20", openingPrincipal: "4000.00", interestRatePeriodId: ratePeriod.id, contractualInterestAmount: "480.00", interestAmount: "68.57", cumulativeInterestAmount: "68.57", status: "accruing", reversedAccrualId: expect.any(Number) },
        ]);
        expect(corrected).toMatchObject({
            correctedDates: ["2026-08-16", "2026-08-18"],
            amount: "-85.71",
        });
        expect(await db.select().from(loanInterestAccruals).where(and(
            eq(loanInterestAccruals.loanId, loan.id),
            eq(loanInterestAccruals.status, "reversed"),
        ))).toHaveLength(5);
        expect((await floatingInterestDue(db, loan, bangkokNoon("2026-08-20"), context(actor))).toFixed(2)).toBe("531.43");
    });

    // Break caught: standalone promotion commits row states before its contextual audit write and loses request/correlation provenance.
    integrationTest("rolls back a standalone period promotion when its contextual audit cannot be written", async () => {
        const { actor, loan } = await seedWeeklyLoan("tenant-weekly-atomic-promotion");
        const ratePeriod = await db.insert(loanInterestRatePeriods).values({
            tenantId: loan.tenantId, loanId: loan.id, effectiveDate: "2026-08-13", expiryDate: null,
            rateType: "percent", rate: "12.0000", periodUnit: "week", periodLength: 1, createdByUserId: actor.id,
        }).returning().then((rows) => rows[0]!);
        const increments = ["85.71", "85.72", "85.71", "85.72", "85.71", "85.72", "85.71", "85.71"];
        const cumulative = ["85.71", "171.43", "257.14", "342.86", "428.57", "514.29", "600.00", "85.71"];
        await db.insert(loanInterestAccruals).values(increments.map((interestAmount, index) => ({
            tenantId: loan.tenantId,
            loanId: loan.id,
            interestRatePeriodId: ratePeriod.id,
            accrualDate: `2026-08-${String(13 + index).padStart(2, "0")}`,
            openingPrincipal: "5000.00",
            rateMode: "percent",
            rate: "12.0000",
            interestAmount,
            periodStartDate: index < 7 ? "2026-08-13" : "2026-08-20",
            periodEndDate: index < 7 ? "2026-08-20" : "2026-08-27",
            periodDayIndex: index < 7 ? index + 1 : 1,
            periodUnit: "week",
            periodLength: 1,
            contractualInterestAmount: "600.00",
            cumulativeInterestAmount: cumulative[index]!,
            dailyIncrementAmount: interestAmount,
            status: "accruing",
            createdByUserId: actor.id,
        })));
        const invalidContext = { ...context(actor), actorUserId: 2_147_483_647 };
        const contextualAccrue = accrueFloatingInterestThrough as unknown as (
            executor: typeof db,
            selectedLoan: typeof loan,
            through: Date,
            ctx: CommandContext,
        ) => Promise<unknown>;

        await expect(contextualAccrue(db, loan, bangkokNoon("2026-08-20"), invalidContext)).rejects.toBeDefined();
        expect((await db.select().from(loanInterestAccruals).where(eq(loanInterestAccruals.loanId, loan.id))).every((row) => row.status === "accruing")).toBe(true);
        expect(await db.select().from(auditLogs)).toHaveLength(0);
    });
});
