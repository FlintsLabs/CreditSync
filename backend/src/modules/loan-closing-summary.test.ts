import { beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import Decimal from "decimal.js";
import { and, eq, sql } from "drizzle-orm";
import { Elysia } from "elysia";
import { db } from "../db";
import { loanInterestAccruals, loans, transactions, users } from "../db/schema";
import { loansRoute } from "./loans";
import type { CommandContext } from "../services/command-context";
import { createBorrower } from "../services/borrower-service";
import { activateLoan, createLoanDraft } from "../services/loan-application-service";
import { getLoanPaymentHealth } from "../services/loan-payment-health-service";
import { createPaymentIntake, postPayment, previewPaymentMatch, reversePayment } from "../services/payment-service";

const integrationTest = process.env.TEST_DATABASE_URL ? test : test.skip;

function context(actor: { id: number; tenantId: string }, idempotencyKey: string = crypto.randomUUID()): CommandContext {
    return {
        tenantId: actor.tenantId,
        actorUserId: actor.id,
        actorSource: "web",
        requestId: `req-${idempotencyKey}`,
        correlationId: `corr-${idempotencyKey}`,
        idempotencyKey,
    };
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

async function seedWeeklyLoan(input: { deduct?: boolean; fees?: string; fixedPenalty?: string } = {}) {
    const tenantId = `tenant-closing-${crypto.randomUUID()}`;
    const actor = await db.insert(users).values({ tenantId, email: `${crypto.randomUUID()}@example.test`, role: "owner" })
        .returning().then((rows) => rows[0]!);
    const ctx = context(actor, "create");
    const borrower = await createBorrower(ctx, { name: "Closing Borrower" });
    const draft = await createLoanDraft(ctx, {
        borrowerPublicId: borrower.publicId,
        principal: "5000.00", interestRate: "0.00", repaymentType: "floating", termMonths: 1,
        startDate: "2026-08-10",
        floatingDailyInterest: {
            mode: "percent", rate: "12.0000",
            firstDayTreatment: input.deduct ? "deduct" : "start_next_day",
            accrualCycle: "weekly",
        },
    });
    if (input.fixedPenalty) {
        await db.update(loans).set({ lateFeeMode: "fixed", lateFeeAmount: input.fixedPenalty, gracePeriodDays: 0 })
            .where(eq(loans.publicId, draft.publicId));
    }
    await activateLoan(ctx, draft.publicId);
    if (input.fees) {
        await db.update(loans).set({ outstandingFees: input.fees }).where(eq(loans.publicId, draft.publicId));
    }
    return { actor, borrower, draft };
}

async function postFloatingPayment(
    seeded: Awaited<ReturnType<typeof seedWeeklyLoan>>,
    amount: string,
    receivedAt = "2026-08-17T05:00:00.000Z",
) {
    const ctx = context(seeded.actor);
    const intake = await createPaymentIntake(ctx, {
        amount,
        receivedAt,
        payerName: seeded.borrower.name,
    });
    const preview = await previewPaymentMatch(ctx, intake.publicId, {
        allocations: [{
            borrowerPublicId: seeded.borrower.publicId,
            loanPublicId: seeded.draft.publicId,
            amount,
        }],
    });
    expect(preview.status).toBe("ready");
    const posted = await postPayment(ctx, intake.publicId, { proposalPublicId: preview.publicId });
    return { ctx, intake, posted };
}

async function closingSummary(seeded: Awaited<ReturnType<typeof seedWeeklyLoan>>) {
    const response = await new Elysia().use(loansRoute).handle(new Request(
        `http://localhost/loans/${seeded.draft.publicId}/closing-summary`,
        { headers: { authorization: `Bearer ${await authToken(seeded.actor)}` } },
    ));
    const body = await response.json() as Record<string, unknown>;
    expect(response.status, JSON.stringify(body)).toBe(200);
    return body;
}

async function paymentHealth(
    seeded: Awaited<ReturnType<typeof seedWeeklyLoan>>,
    asOf: Date,
) {
    const loan = await db.query.loans.findFirst({ where: eq(loans.publicId, seeded.draft.publicId) });
    expect(loan).toBeDefined();
    return getLoanPaymentHealth(db, loan!, { asOf, actorUserId: seeded.actor.id });
}

async function persistedFloatingPenalty(seeded: Awaited<ReturnType<typeof seedWeeklyLoan>>) {
    const loan = await db.query.loans.findFirst({ where: eq(loans.publicId, seeded.draft.publicId) });
    expect(loan).toBeDefined();
    const rows = await db.select().from(loanInterestAccruals).where(eq(loanInterestAccruals.loanId, loan!.id));
    return rows.reduce((sum, row) => sum.plus(row.paidPenalty), new Decimal(0)).toFixed(2);
}

describe("floating loan closing summary", () => {
    if (process.env.TEST_DATABASE_URL) beforeEach(async () => {
        setSystemTime();
        await db.execute(sql`SET client_min_messages TO WARNING`);
        await db.execute(sql`TRUNCATE TABLE loans, borrowers, users RESTART IDENTITY CASCADE`);
    });

    integrationTest("uses unpaid balances, fees, and one applicable period penalty after an interest-only payment", async () => {
        setSystemTime(new Date("2026-08-18T12:00:00+07:00"));
        const seeded = await seedWeeklyLoan({ fees: "25.00", fixedPenalty: "10.00" });
        await postFloatingPayment(seeded, "100.00");

        expect(await closingSummary(seeded)).toMatchObject({
            principal: "5000.00", dueInterest: "500.00", accruingInterest: "85.71",
            fees: "25.00", penalty: "10.00", totalInterest: "585.71",
            totalDue: "5620.71", balance: "5620.71", totalPaid: "100.00",
        });
    });

    integrationTest("uses remaining principal after a mixed interest and principal payment", async () => {
        setSystemTime(new Date("2026-08-17T12:00:00+07:00"));
        const seeded = await seedWeeklyLoan();
        await postFloatingPayment(seeded, "700.00");

        expect(await closingSummary(seeded)).toMatchObject({
            principal: "4900.00", dueInterest: "0.00", accruingInterest: "0.00",
            totalDue: "4900.00", balance: "4900.00", totalPaid: "700.00",
        });
    });

    integrationTest("restores the exact current obligation after a payment reversal", async () => {
        setSystemTime(new Date("2026-08-17T12:00:00+07:00"));
        const seeded = await seedWeeklyLoan();
        const posted = await postFloatingPayment(seeded, "700.00");
        await reversePayment(context(seeded.actor, "reverse"), posted.intake.publicId, { reason: "Bank returned transfer" });

        expect(await closingSummary(seeded)).toMatchObject({
            principal: "5000.00", dueInterest: "600.00", accruingInterest: "0.00",
            totalDue: "5600.00", balance: "5600.00", totalPaid: "0.00",
        });
    });

    integrationTest("does not refund or charge again inside an advance-covered period", async () => {
        setSystemTime(new Date("2026-08-13T12:00:00+07:00"));
        const seeded = await seedWeeklyLoan({ deduct: true });

        expect(await closingSummary(seeded)).toMatchObject({
            principal: "5000.00", dueInterest: "0.00", accruingInterest: "0.00",
            totalInterest: "0.00", totalDue: "5000.00", balance: "5000.00", totalPaid: "0.00",
        });
    });

    // Break caught: a floating payment bypasses an overdue period penalty,
    // pays interest first, and leaves no durable per-period paid-penalty state.
    integrationTest("allocates partial and full floating penalties before interest", async () => {
        const asOf = new Date("2026-08-18T12:00:00+07:00");
        setSystemTime(asOf);
        const seeded = await seedWeeklyLoan({ fixedPenalty: "10.00" });

        const partial = await postFloatingPayment(seeded, "5.00", "2026-08-18T05:00:00.000Z");
        expect(partial.posted.transactions).toEqual([expect.objectContaining({
            penaltyComponent: "5.00", interestComponent: "0.00", principalComponent: "0.00",
        })]);
        expect(await persistedFloatingPenalty(seeded)).toBe("5.00");
        expect(await closingSummary(seeded)).toMatchObject({
            penalty: "5.00", dueInterest: "600.00", totalDue: "5690.71",
        });
        expect(await paymentHealth(seeded, asOf)).toMatchObject({ status: "overdue", overdueAmount: "605.00" });

        const completed = await postFloatingPayment(seeded, "15.00", "2026-08-18T06:00:00.000Z");
        expect(completed.posted.transactions).toEqual([expect.objectContaining({
            penaltyComponent: "5.00", interestComponent: "10.00", principalComponent: "0.00",
        })]);
        expect(await persistedFloatingPenalty(seeded)).toBe("10.00");
        expect(await closingSummary(seeded)).toMatchObject({
            penalty: "0.00", dueInterest: "590.00", totalDue: "5675.71",
        });
        expect(await paymentHealth(seeded, asOf)).toMatchObject({ status: "overdue", overdueAmount: "590.00" });
    });

    // Break caught: paying all related interest erases an already incurred
    // penalty from both settlement and payment-health projections.
    integrationTest("retains an unpaid period penalty after its interest is fully paid", async () => {
        const asOf = new Date("2026-08-18T12:00:00+07:00");
        setSystemTime(asOf);
        const seeded = await seedWeeklyLoan({ fixedPenalty: "10.00" });
        expect(await closingSummary(seeded)).toMatchObject({ penalty: "10.00", dueInterest: "600.00" });
        const loan = await db.query.loans.findFirst({ where: eq(loans.publicId, seeded.draft.publicId) });
        expect(loan).toBeDefined();
        await db.update(loanInterestAccruals).set({
            paidAmount: sql`${loanInterestAccruals.interestAmount}`,
            status: "paid",
        }).where(and(eq(loanInterestAccruals.loanId, loan!.id), eq(loanInterestAccruals.periodEndDate, "2026-08-17")));
        await db.update(loans).set({ outstandingInterest: "0.00" }).where(eq(loans.id, loan!.id));
        await db.insert(transactions).values({
            tenantId: seeded.actor.tenantId,
            ownerUserId: seeded.actor.id,
            loanId: loan!.id,
            amount: "600.00",
            principalComponent: "0.00",
            interestComponent: "600.00",
            feeComponent: "0.00",
            penaltyComponent: "0.00",
            type: "repayment",
            transactionDate: asOf,
            recordedByUserId: seeded.actor.id,
            entryType: "repayment",
            idempotencyKey: `legacy-interest-${crypto.randomUUID()}`,
            postedAt: asOf,
        });

        expect(await closingSummary(seeded)).toMatchObject({
            penalty: "10.00", dueInterest: "0.00", totalPaid: "600.00", totalDue: "5095.71",
        });
        expect(await paymentHealth(seeded, asOf)).toMatchObject({ status: "overdue", overdueAmount: "10.00" });
    });

    // Break caught: penalty paid against an older weekly group globally offsets
    // the distinct penalty incurred by a later overdue weekly group.
    integrationTest("keeps paid penalty scoped to its weekly due group", async () => {
        setSystemTime(new Date("2026-08-18T12:00:00+07:00"));
        const seeded = await seedWeeklyLoan({ fixedPenalty: "10.00" });
        const firstPeriod = await postFloatingPayment(seeded, "610.00", "2026-08-18T05:00:00.000Z");
        expect(firstPeriod.posted.transactions).toEqual([expect.objectContaining({
            penaltyComponent: "10.00", interestComponent: "600.00", principalComponent: "0.00",
        })]);

        const later = new Date("2026-08-25T12:00:00+07:00");
        setSystemTime(later);
        expect(await closingSummary(seeded)).toMatchObject({
            penalty: "10.00", dueInterest: "600.00", totalDue: "5695.71",
        });
        expect(await paymentHealth(seeded, later)).toMatchObject({ status: "overdue", overdueAmount: "610.00" });
    });

    // Break caught: reversing a penalty-first floating payment restores only
    // interest/principal and leaves the due-group penalty marked as paid.
    integrationTest("restores the exact weekly penalty group on reversal", async () => {
        const asOf = new Date("2026-08-18T12:00:00+07:00");
        setSystemTime(asOf);
        const seeded = await seedWeeklyLoan({ fixedPenalty: "10.00" });
        const payment = await postFloatingPayment(seeded, "10.00", "2026-08-18T05:00:00.000Z");
        expect(payment.posted.transactions).toEqual([expect.objectContaining({
            penaltyComponent: "10.00", interestComponent: "0.00", principalComponent: "0.00",
        })]);
        expect(await persistedFloatingPenalty(seeded)).toBe("10.00");

        const reversed = await reversePayment(context(seeded.actor, "reverse-penalty"), payment.intake.publicId, {
            reason: "Correct penalty allocation",
        });
        expect(reversed.transactions).toContainEqual(expect.objectContaining({
            entryType: "reversal", penaltyComponent: "-10.00",
        }));
        expect(await persistedFloatingPenalty(seeded)).toBe("0.00");
        expect(await closingSummary(seeded)).toMatchObject({ penalty: "10.00", dueInterest: "600.00" });
        expect(await paymentHealth(seeded, asOf)).toMatchObject({ status: "overdue", overdueAmount: "610.00" });
    });
});
