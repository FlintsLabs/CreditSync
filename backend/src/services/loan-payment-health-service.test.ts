import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { Elysia } from "elysia";
import { db } from "../db";
import {
    auditLogs,
    borrowers,
    floatingTransactionAllocations,
    loanInterestAccruals,
    loanInterestRatePeriods,
    loanSchedules,
    loans,
    transactions,
    users,
} from "../db/schema";
import { loansRoute } from "../modules/loans";
import { getLoanPaymentHealth } from "./loan-payment-health-service";

const integrationEnabled = Boolean(process.env.TEST_DATABASE_URL);
const integrationTest = integrationEnabled ? test : test.skip;

async function resetTables() {
    await db.execute(sql`SET client_min_messages TO WARNING`);
    await db.execute(sql`TRUNCATE TABLE loan_interest_accruals, loan_schedules, loans, borrowers, users RESTART IDENTITY CASCADE`);
}

async function seedActorAndBorrower(tenantId: string) {
    const actor = await db.insert(users).values({ tenantId, email: `${tenantId}@payment-health.test`, role: "owner" }).returning().then((rows) => rows[0]!);
    const borrower = await db.insert(borrowers).values({ tenantId, ownerUserId: actor.id, name: `${tenantId} Borrower` }).returning().then((rows) => rows[0]!);
    return { actor, borrower };
}

async function authToken(user: { id: number; email: string; role: string | null; tenantId: string }) {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const header = encode({ alg: "HS256", typ: "JWT" });
    const payload = encode({ id: user.id, email: user.email, role: user.role, tenantId: user.tenantId });
    const unsigned = `${header}.${payload}`;
    const key = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(process.env.JWT_SECRET ?? "dev_jwt_secret_change_me"),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
    );
    const signature = Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(unsigned))).toString("base64url");
    return `${unsigned}.${signature}`;
}

describe("loan payment-health service", () => {
    if (integrationEnabled) beforeEach(resetTables);
    afterEach(() => setSystemTime());

    // Break caught: schedule aggregation omits tenant scope or merges due-now with arrears.
    integrationTest("loads only the selected loan tenant schedule and separates due-now", async () => {
        const { actor, borrower } = await seedActorAndBorrower("tenant-a");
        const loan = await db.insert(loans).values({
            tenantId: "tenant-a", ownerUserId: actor.id, borrowerId: borrower.id,
            principalAmount: "1000.00", interestRate: "0.00", repaymentType: "daily",
            gracePeriodDays: 0, lateFeeMode: "none", lateFeeAmount: "0.00",
            outstandingPrincipal: "1000.00", status: "active",
        }).returning().then((rows) => rows[0]!);
        await db.insert(loanSchedules).values([
            { tenantId: "tenant-a", loanId: loan.id, installmentNo: 1, dueDate: "2026-08-10", scheduledTotal: "125.25", remainingDue: "125.25", status: "partial" },
            { tenantId: "tenant-a", loanId: loan.id, installmentNo: 2, dueDate: "2026-08-11", scheduledTotal: "50.10", remainingDue: "50.10", status: "pending" },
            { tenantId: "tenant-b", loanId: loan.id, installmentNo: 3, dueDate: "2026-08-09", scheduledTotal: "999.00", remainingDue: "999.00", status: "pending" },
        ]);

        expect(await getLoanPaymentHealth(db, loan, {
            asOf: new Date("2026-08-11T12:00:00+07:00"), actorUserId: actor.id,
        })).toEqual({
            status: "overdue", dueTodayAmount: "50.10", overdueAmount: "125.25",
            overdueItemCount: 1, maxOverdueDays: 1,
        });
    });

    // Break caught: today's floating interest is overdue immediately, partial history uses gross,
    // or a health read writes missing financial snapshots.
    integrationTest("projects floating accruals without mutation and uses exact unpaid remainders", async () => {
        const { actor, borrower } = await seedActorAndBorrower("tenant-a");
        const loan = await db.insert(loans).values({
            tenantId: "tenant-a", ownerUserId: actor.id, borrowerId: borrower.id,
            principalAmount: "1000.00", interestRate: "0.00", repaymentType: "floating",
            dailyInterestMode: "per_thousand", dailyInterestRate: "15.0000",
            floatingAccrualCycle: "daily",
            firstDayTreatment: "start_next_day", interestStartDate: "2026-08-09",
            outstandingPrincipal: "1000.00", status: "active",
        }).returning().then((rows) => rows[0]!);
        const period = await db.insert(loanInterestRatePeriods).values({
            tenantId: "tenant-a", loanId: loan.id, effectiveDate: "2026-08-09", expiryDate: null,
            rateType: "per_thousand", rate: "15.0000", createdByUserId: actor.id,
        }).returning().then((rows) => rows[0]!);
        await db.transaction(async (tx) => {
            const accrual = await tx.insert(loanInterestAccruals).values({
                tenantId: "tenant-a", loanId: loan.id, interestRatePeriodId: period.id, accrualDate: "2026-08-10",
                openingPrincipal: "1000.00", rateMode: "per_thousand", rate: "15.0000",
                interestAmount: "15.00", paidAmount: "7.50", status: "accrued", createdByUserId: actor.id,
            }).returning().then((rows) => rows[0]!);
            const payment = await tx.insert(transactions).values({
                tenantId: "tenant-a", ownerUserId: actor.id, loanId: loan.id,
                amount: "7.50", principalComponent: "0.00", interestComponent: "7.50",
                feeComponent: "0.00", penaltyComponent: "0.00", type: "repayment",
                transactionDate: new Date("2026-08-10T05:00:00.000Z"), entryType: "repayment",
                idempotencyKey: "health-partial-payment", postedAt: new Date("2026-08-10T05:00:00.000Z"),
            }).returning().then((rows) => rows[0]!);
            const audit = await tx.insert(auditLogs).values({
                tenantId: "tenant-a", entityType: "transaction", entityId: payment.publicId,
                action: "floating_payment_allocations_recorded", actorUserId: actor.id, actorSource: "web",
                requestId: "health-partial-payment", correlationId: "health-partial-payment",
            }).returning().then((rows) => rows[0]!);
            await tx.insert(floatingTransactionAllocations).values({
                tenantId: "tenant-a", loanId: loan.id, transactionId: payment.id,
                dueDate: "2026-08-10", component: "interest", interestAccrualId: accrual.id,
                effectiveDate: "2026-08-10", allocationOrder: 1, entryType: "payment", amount: "7.50",
                idempotencyKey: "health-partial-allocation", auditPublicId: audit.publicId,
                actorSource: "web", requestId: "health-partial-payment",
                correlationId: "health-partial-payment", createdByUserId: actor.id,
            });
        });

        const input = { asOf: new Date("2026-08-11T12:00:00+07:00"), actorUserId: actor.id };
        const first = await getLoanPaymentHealth(db, loan, input);
        const second = await getLoanPaymentHealth(db, loan, input);

        expect(first).toEqual({
            status: "overdue", dueTodayAmount: "15.00", overdueAmount: "7.50",
            overdueItemCount: 1, maxOverdueDays: 1,
        });
        expect(second).toEqual(first);
        expect(await db.select().from(loanInterestAccruals).where(and(
            eq(loanInterestAccruals.tenantId, "tenant-a"), eq(loanInterestAccruals.loanId, loan.id),
        ))).toHaveLength(1);
    });

    // Break caught: weekly interest is absent between boundaries or becomes
    // normally payable before the complete weekly period is due.
    integrationTest("projects prorated weekly interest daily and promotes the exact period at its boundary", async () => {
        const { actor, borrower } = await seedActorAndBorrower("tenant-weekly-health");
        const loan = await db.insert(loans).values({
            tenantId: actor.tenantId, ownerUserId: actor.id, borrowerId: borrower.id,
            principalAmount: "5000.00", interestRate: "0.00", repaymentType: "floating",
            dailyInterestMode: "percent", dailyInterestRate: "12.0000",
            floatingAccrualCycle: "weekly",
            firstDayTreatment: "start_next_day", interestStartDate: "2026-08-10",
            outstandingPrincipal: "5000.00", status: "active",
        }).returning().then((rows) => rows[0]!);
        await db.insert(loanInterestRatePeriods).values({
            tenantId: actor.tenantId, loanId: loan.id, effectiveDate: "2026-08-10", expiryDate: null,
            rateType: "percent", rate: "12.0000", createdByUserId: actor.id,
        });

        expect(await getLoanPaymentHealth(db, loan, {
            asOf: new Date("2026-08-13T12:00:00+07:00"), actorUserId: actor.id,
        })).toMatchObject({
            status: "current", dueTodayAmount: "0.00", overdueAmount: "0.00",
            accruingInterestAmount: "257.14", overdueItemCount: 0, maxOverdueDays: 0,
        });
        expect(await db.select().from(loanInterestAccruals).where(eq(loanInterestAccruals.loanId, loan.id))).toHaveLength(0);

        expect(await getLoanPaymentHealth(db, loan, {
            asOf: new Date("2026-08-17T12:00:00+07:00"), actorUserId: actor.id,
        })).toMatchObject({
            status: "due_today", dueTodayAmount: "600.00", overdueAmount: "0.00",
            accruingInterestAmount: "0.00", overdueItemCount: 0, maxOverdueDays: 0,
        });
        expect(await db.select().from(loanInterestAccruals).where(eq(loanInterestAccruals.loanId, loan.id))).toHaveLength(0);

        expect(await getLoanPaymentHealth(db, loan, {
            asOf: new Date("2026-08-18T12:00:00+07:00"), actorUserId: actor.id,
        })).toMatchObject({
            status: "overdue", dueTodayAmount: "0.00", overdueAmount: "600.00",
            accruingInterestAmount: "85.71", overdueItemCount: 1, maxOverdueDays: 1,
        });
        expect(await db.select().from(loanInterestAccruals).where(eq(loanInterestAccruals.loanId, loan.id))).toHaveLength(0);
    });

    // Break caught: a pre-proration weekly aggregate is overlaid on only its
    // anchor date while the other six projected increments remain payable.
    integrationTest("does not double count a legacy weekly aggregate with projected period increments", async () => {
        const { actor, borrower } = await seedActorAndBorrower("tenant-legacy-weekly-health");
        const loan = await db.insert(loans).values({
            tenantId: actor.tenantId, ownerUserId: actor.id, borrowerId: borrower.id,
            principalAmount: "5000.00", interestRate: "0.00", repaymentType: "floating",
            dailyInterestMode: "percent", dailyInterestRate: "12.0000", floatingAccrualCycle: "weekly",
            firstDayTreatment: "start_next_day", interestStartDate: "2026-08-10",
            outstandingPrincipal: "5000.00", outstandingInterest: "600.00", status: "active",
        }).returning().then((rows) => rows[0]!);
        const period = await db.insert(loanInterestRatePeriods).values({
            tenantId: actor.tenantId, loanId: loan.id, effectiveDate: "2026-08-10", expiryDate: null,
            rateType: "percent", rate: "12.0000", createdByUserId: actor.id,
        }).returning().then((rows) => rows[0]!);
        await db.insert(loanInterestAccruals).values({
            tenantId: actor.tenantId, loanId: loan.id, interestRatePeriodId: period.id,
            accrualDate: "2026-08-17", openingPrincipal: "5000.00", rateMode: "percent", rate: "12.0000",
            interestAmount: "600.00", paidAmount: "0.00", status: "due", createdByUserId: actor.id,
        });

        expect(await getLoanPaymentHealth(db, loan, {
            asOf: new Date("2026-08-18T12:00:00+07:00"), actorUserId: actor.id,
        })).toMatchObject({
            status: "overdue", overdueAmount: "600.00", accruingInterestAmount: "85.71",
            overdueItemCount: 1, maxOverdueDays: 1,
        });
    });

    // Break caught: a mid-period contractual rate change reuses the old rate or
    // restarts the whole period cumulative amount instead of starting a new segment.
    integrationTest("preserves rate segments inside a prorated weekly period", async () => {
        const { actor, borrower } = await seedActorAndBorrower("tenant-weekly-rate-segments");
        const loan = await db.insert(loans).values({
            tenantId: actor.tenantId, ownerUserId: actor.id, borrowerId: borrower.id,
            principalAmount: "5000.00", interestRate: "0.00", repaymentType: "floating",
            dailyInterestMode: "percent", dailyInterestRate: "12.0000", floatingAccrualCycle: "weekly",
            firstDayTreatment: "start_next_day", interestStartDate: "2026-08-10",
            outstandingPrincipal: "5000.00", status: "active",
        }).returning().then((rows) => rows[0]!);
        const periods = await db.insert(loanInterestRatePeriods).values([
            { tenantId: actor.tenantId, loanId: loan.id, effectiveDate: "2026-08-10", expiryDate: "2026-08-12", rateType: "percent", rate: "12.0000", createdByUserId: actor.id },
            { tenantId: actor.tenantId, loanId: loan.id, effectiveDate: "2026-08-13", expiryDate: null, rateType: "percent", rate: "6.0000", createdByUserId: actor.id },
        ]).returning();

        await getLoanPaymentHealth(db, loan, { asOf: new Date("2026-08-13T12:00:00+07:00"), actorUserId: actor.id });
        expect(await getLoanPaymentHealth(db, loan, {
            asOf: new Date("2026-08-13T12:00:00+07:00"), actorUserId: actor.id,
        })).toMatchObject({ status: "current", accruingInterestAmount: "214.29" });
        expect(await db.select().from(loanInterestAccruals).where(eq(loanInterestAccruals.loanId, loan.id))).toHaveLength(0);
    });

    // Break caught: a catch-up accrual applies today's rate to every missing historical date.
    integrationTest("resolves each missing floating accrual date against its own rate period", async () => {
        const { actor, borrower } = await seedActorAndBorrower("tenant-a");
        const loan = await db.insert(loans).values({
            tenantId: "tenant-a", ownerUserId: actor.id, borrowerId: borrower.id,
            principalAmount: "1000.00", interestRate: "0.00", repaymentType: "floating",
            dailyInterestMode: "per_thousand", dailyInterestRate: "15.0000",
            floatingAccrualCycle: "daily",
            firstDayTreatment: "start_next_day", interestStartDate: "2026-08-30",
            outstandingPrincipal: "1000.00", status: "active",
        }).returning().then((rows) => rows[0]!);
        const periods = await db.insert(loanInterestRatePeriods).values([
            { tenantId: "tenant-a", loanId: loan.id, effectiveDate: "2026-08-30", expiryDate: "2026-08-31", rateType: "per_thousand", rate: "15.0000", createdByUserId: actor.id },
            { tenantId: "tenant-a", loanId: loan.id, effectiveDate: "2026-09-01", expiryDate: null, rateType: "per_thousand", rate: "18.0000", createdByUserId: actor.id },
        ]).returning();

        expect(await getLoanPaymentHealth(db, loan, {
            asOf: new Date("2026-09-02T12:00:00+07:00"), actorUserId: actor.id,
        })).toMatchObject({
            status: "overdue", dueTodayAmount: "18.00", overdueAmount: "33.00",
            overdueItemCount: 2, maxOverdueDays: 2,
        });
        expect(await db.select().from(loanInterestAccruals).where(eq(loanInterestAccruals.loanId, loan.id))).toHaveLength(0);
    });

    // Break caught: legacy floating principal creates synthetic payable interest without a policy.
    integrationTest("keeps a legacy floating loan without policy current", async () => {
        const { actor, borrower } = await seedActorAndBorrower("tenant-a");
        const loan = await db.insert(loans).values({
            tenantId: "tenant-a", ownerUserId: actor.id, borrowerId: borrower.id,
            principalAmount: "500.00", interestRate: "0.00", repaymentType: "floating",
            floatingAccrualCycle: "daily",
            outstandingPrincipal: "500.00", status: "active",
        }).returning().then((rows) => rows[0]!);

        expect(await getLoanPaymentHealth(db, loan, {
            asOf: new Date("2026-08-11T12:00:00+07:00"), actorUserId: actor.id,
        })).toEqual({
            status: "current", dueTodayAmount: "0.00", overdueAmount: "0.00",
            overdueItemCount: 0, maxOverdueDays: 0,
        });
    });

    // Break caught: the list contract omits payment health or leaks a tenant-internal numeric loan ID.
    integrationTest("adds payment health to the existing public loan-list contract", async () => {
        setSystemTime(new Date("2026-08-11T12:00:00+07:00"));
        const { actor, borrower } = await seedActorAndBorrower("tenant-route");
        const loan = await db.insert(loans).values({
            tenantId: "tenant-route", ownerUserId: actor.id, borrowerId: borrower.id,
            principalAmount: "125.25", interestRate: "0.00", repaymentType: "daily",
            gracePeriodDays: 0, lateFeeMode: "none", lateFeeAmount: "0.00",
            outstandingPrincipal: "125.25", status: "active",
        }).returning().then((rows) => rows[0]!);
        await db.insert(loanSchedules).values({
            tenantId: "tenant-route", loanId: loan.id, installmentNo: 1, dueDate: "2026-08-10",
            scheduledTotal: "125.25", remainingDue: "125.25", status: "pending",
        });

        const token = await authToken(actor);
        const response = await new Elysia().use(loansRoute).handle(new Request("http://localhost/loans", {
            headers: { authorization: `Bearer ${token}` },
        }));
        const body = await response.json() as Array<Record<string, unknown>>;

        expect(response.status).toBe(200);
        expect(body).toHaveLength(1);
        expect(body[0]).toMatchObject({
            id: loan.publicId,
            publicId: loan.publicId,
            principal: "125.25",
            paymentHealth: {
                status: "overdue",
                dueTodayAmount: "0.00",
                overdueAmount: "125.25",
                overdueItemCount: 1,
                maxOverdueDays: 1,
            },
        });
        expect(body[0]).not.toHaveProperty("loanId");
    });
});
