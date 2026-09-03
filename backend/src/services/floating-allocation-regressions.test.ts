import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import Decimal from "decimal.js";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import {
    auditLogs,
    floatingPenaltyLedgerEntries,
    floatingTransactionAllocations,
    loanInterestAccruals,
    loans,
    transactions,
    users,
} from "../db/schema";
import type { CommandContext } from "./command-context";
import { createBorrower } from "./borrower-service";
import { accrueFloatingInterestThrough, floatingInterestBalances, materializeFloatingPenaltyAssessments } from "./floating-interest-service";
import { activateLoan, createLoanDraft } from "./loan-application-service";
import { getLoanPaymentHealth } from "./loan-payment-health-service";
import { createPaymentIntake, postPayment, previewPaymentMatch, reversePayment } from "./payment-service";

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

async function seedWeeklyLoan(input: { deduct?: boolean; fees?: string; fixedPenalty?: string; dailyPenalty?: string; principal?: string; rate?: string } = {}) {
    const tenantId = `tenant-closing-${crypto.randomUUID()}`;
    const actor = await db.insert(users).values({ tenantId, email: `${crypto.randomUUID()}@example.test`, role: "owner" })
        .returning().then((rows) => rows[0]!);
    const ctx = context(actor, "create");
    const borrower = await createBorrower(ctx, { name: "Closing Borrower" });
    const draft = await createLoanDraft(ctx, {
        borrowerPublicId: borrower.publicId,
        principal: input.principal ?? "5000.00", interestRate: "0.00", repaymentType: "floating", termMonths: 1,
        startDate: "2026-08-10",
        floatingDailyInterest: {
            mode: "percent", rate: input.rate ?? "12.0000",
            firstDayTreatment: input.deduct ? "deduct" : "start_next_day",
            accrualCycle: "weekly",
        },
    });
    if (input.fixedPenalty) {
        await db.update(loans).set({ lateFeeMode: "fixed", lateFeeAmount: input.fixedPenalty, gracePeriodDays: 0 })
            .where(eq(loans.publicId, draft.publicId));
    }
    if (input.dailyPenalty) {
        await db.update(loans).set({ lateFeeMode: "daily_percent", lateFeeAmount: input.dailyPenalty, gracePeriodDays: 0 })
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
    const loan = await db.query.loans.findFirst({ where: eq(loans.publicId, seeded.draft.publicId) });
    expect(loan).toBeDefined();
    const now = new Date();
    const balances = await floatingInterestBalances(db, loan!, now, context(seeded.actor));
    const loanTransactions = await db.select().from(transactions).where(and(
        eq(transactions.loanId, loan!.id),
        eq(transactions.tenantId, seeded.actor.tenantId),
    ));
    const principal = new Decimal(loan!.outstandingPrincipal ?? loan!.principalAmount);
    const totalInterest = balances.dueInterest.plus(balances.accruingInterest);
    const fees = new Decimal(loan!.outstandingFees ?? "0.00");
    const penalty = balances.applicablePenalty;
    const totalDue = principal.plus(totalInterest).plus(fees).plus(penalty);
    const totalPaid = loanTransactions.reduce((sum, transaction) => sum.plus(transaction.amount), new Decimal(0));
    return {
        principal: principal.toFixed(2),
        dueInterest: balances.dueInterest.toFixed(2),
        accruingInterest: balances.accruingInterest.toFixed(2),
        totalInterest: totalInterest.toFixed(2),
        fees: fees.toFixed(2),
        penalty: penalty.toFixed(2),
        totalPaid: totalPaid.toFixed(2),
        totalDue: totalDue.toFixed(2),
        balance: totalDue.toFixed(2),
    };
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
    const rows = await db.select().from(floatingTransactionAllocations).where(and(
        eq(floatingTransactionAllocations.loanId, loan!.id),
        eq(floatingTransactionAllocations.component, "penalty"),
    ));
    return rows.reduce((sum, row) => sum.plus(row.amount), new Decimal(0)).toFixed(2);
}

describe("weekly floating allocation, penalty, reversal, and projection invariants", () => {
    afterEach(() => setSystemTime());

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
            principal: "5000.00", dueInterest: "500.00", accruingInterest: "171.43",
            fees: "25.00", penalty: "10.00", totalInterest: "671.43",
            totalDue: "5706.43", balance: "5706.43", totalPaid: "100.00",
        });
    });

    integrationTest("uses remaining principal after a mixed interest and principal payment", async () => {
        setSystemTime(new Date("2026-08-17T12:00:00+07:00"));
        const seeded = await seedWeeklyLoan();
        await postFloatingPayment(seeded, "700.00");

        expect(await closingSummary(seeded)).toMatchObject({
            principal: "4900.00", dueInterest: "0.00", accruingInterest: "85.71",
            totalDue: "4985.71", balance: "4985.71", totalPaid: "700.00",
        });
    });

    integrationTest("restores the exact current obligation after a payment reversal", async () => {
        setSystemTime(new Date("2026-08-17T12:00:00+07:00"));
        const seeded = await seedWeeklyLoan();
        const posted = await postFloatingPayment(seeded, "700.00");
        await reversePayment(context(seeded.actor, "reverse"), posted.intake.publicId, { reason: "Bank returned transfer" });

        expect(await closingSummary(seeded)).toMatchObject({
            principal: "5000.00", dueInterest: "600.00", accruingInterest: "85.71",
            totalDue: "5685.71", balance: "5685.71", totalPaid: "0.00",
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

    // A first-period advance deduction covers only the initial weekly period.
    // On the next weekly due date the customer is again due for the next
    // period's interest; the payment-health read and posting allocation must
    // agree on that fact.
    integrationTest("allocates the next weekly amount to interest after an advance-covered first period", async () => {
        const asOf = new Date("2026-08-17T12:00:00+07:00");
        setSystemTime(asOf);
        const seeded = await seedWeeklyLoan({ deduct: true });

        expect(await paymentHealth(seeded, asOf)).toMatchObject({
            status: "due_today",
            dueTodayAmount: "600.00",
        });

        const payment = await postFloatingPayment(seeded, "600.00", "2026-08-17T05:00:00.000Z");
        expect(payment.posted.transactions).toEqual([expect.objectContaining({
            interestComponent: "600.00",
            principalComponent: "0.00",
        })]);
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
            penalty: "5.00", dueInterest: "600.00", totalDue: "5776.43",
        });
        expect(await paymentHealth(seeded, asOf)).toMatchObject({ status: "overdue", overdueAmount: "605.00" });

        const completed = await postFloatingPayment(seeded, "15.00", "2026-08-18T06:00:00.000Z");
        expect(completed.posted.transactions).toEqual([expect.objectContaining({
            penaltyComponent: "5.00", interestComponent: "10.00", principalComponent: "0.00",
        })]);
        expect(await persistedFloatingPenalty(seeded)).toBe("10.00");
        expect(await closingSummary(seeded)).toMatchObject({
            penalty: "0.00", dueInterest: "590.00", totalDue: "5761.43",
        });
        expect(await paymentHealth(seeded, asOf)).toMatchObject({ status: "overdue", overdueAmount: "590.00" });
    });

    integrationTest("conserves a payment that exactly covers penalty, due interest, and principal", async () => {
        setSystemTime(new Date("2026-08-18T12:00:00+07:00"));
        const seeded = await seedWeeklyLoan({ principal: "1000.00", rate: "10.0000", fixedPenalty: "50.00" });
        const intake = await createPaymentIntake(context(seeded.actor), {
            amount: "1150.00",
            receivedAt: "2026-08-18T05:00:00.000Z",
            payerName: seeded.borrower.name,
        });

        const preview = await previewPaymentMatch(context(seeded.actor), intake.publicId, {
            allocations: [{
                borrowerPublicId: seeded.borrower.publicId,
                loanPublicId: seeded.draft.publicId,
                amount: "1150.00",
            }],
        });
        expect(preview).toMatchObject({
            status: "ready",
            totalAllocated: "1150.00",
            allocations: [expect.objectContaining({ amount: "1150.00" })],
            warnings: [],
        });

        const posted = await postPayment(context(seeded.actor), intake.publicId, {
            proposalPublicId: preview.publicId,
        });
        expect(posted.transactions).toEqual([expect.objectContaining({
            amount: "1150.00",
            penaltyComponent: "50.00",
            interestComponent: "100.00",
            principalComponent: "1000.00",
        })]);
        const postedRow = posted.transactions[0]!;
        const components = new Decimal(postedRow.penaltyComponent)
            .plus(postedRow.interestComponent)
            .plus(postedRow.feeComponent)
            .plus(postedRow.principalComponent);
        expect(components.toFixed(2)).toBe("1150.00");
    });

    // Break caught: paying all related interest erases an already incurred
    // penalty from both settlement and payment-health projections.
    integrationTest("retains an unpaid period penalty after its exact interest allocations are fully paid", async () => {
        const asOf = new Date("2026-08-18T12:00:00+07:00");
        setSystemTime(asOf);
        const seeded = await seedWeeklyLoan({ fixedPenalty: "10.00" });
        expect(await closingSummary(seeded)).toMatchObject({ penalty: "10.00", dueInterest: "600.00" });
        const loan = await db.query.loans.findFirst({ where: eq(loans.publicId, seeded.draft.publicId) });
        expect(loan).toBeDefined();
        await accrueFloatingInterestThrough(db, loan!, asOf, seeded.actor.id);
        const periodRows = await db.select().from(loanInterestAccruals).where(and(
            eq(loanInterestAccruals.loanId, loan!.id),
            eq(loanInterestAccruals.periodEndDate, "2026-08-17"),
        ));
        const legacyTransaction = await db.insert(transactions).values({
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
        }).returning().then((rows) => rows[0]!);
        const allocationCtx = context(seeded.actor, "exact-interest-allocation");
        const audit = await db.insert(auditLogs).values({
            tenantId: seeded.actor.tenantId,
            entityType: "transaction",
            entityId: legacyTransaction.publicId,
            action: "floating_payment_allocations_recorded",
            actorUserId: seeded.actor.id,
            actorSource: allocationCtx.actorSource,
            requestId: allocationCtx.requestId,
            correlationId: allocationCtx.correlationId,
            payload: { testFixture: true },
        }).returning().then((rows) => rows[0]!);
        await materializeFloatingPenaltyAssessments(
            db,
            allocationCtx,
            loan!,
            asOf,
            audit.publicId,
            legacyTransaction.id,
        );
        await db.insert(floatingTransactionAllocations).values(periodRows.map((row, index) => ({
            tenantId: seeded.actor.tenantId,
            loanId: loan!.id,
            transactionId: legacyTransaction.id,
            dueDate: "2026-08-17",
            component: "interest",
            interestAccrualId: row.id,
            effectiveDate: "2026-08-18",
            allocationOrder: index + 1,
            entryType: "payment",
            amount: row.interestAmount,
            idempotencyKey: `exact-interest-allocation:${row.publicId}`,
            auditPublicId: audit.publicId,
            actorSource: allocationCtx.actorSource,
            requestId: allocationCtx.requestId,
            correlationId: allocationCtx.correlationId,
            createdByUserId: seeded.actor.id,
        })));
        await db.update(loanInterestAccruals).set({
            paidAmount: sql`${loanInterestAccruals.interestAmount}`,
            status: "paid",
        }).where(and(eq(loanInterestAccruals.loanId, loan!.id), eq(loanInterestAccruals.periodEndDate, "2026-08-17")));
        await db.update(loans).set({ outstandingInterest: "0.00" }).where(eq(loans.id, loan!.id));

        expect(await closingSummary(seeded)).toMatchObject({
            penalty: "10.00", dueInterest: "0.00", totalPaid: "600.00", totalDue: "5181.43",
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
            penalty: "10.00", dueInterest: "600.00", totalDue: "5781.43",
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

    // Break caught: an undated high-water cache recomputes all overdue days
    // from today's smaller balance and misses the next day's exact increment.
    integrationTest("accrues daily-percent penalty on each day's opening unpaid group basis", async () => {
        setSystemTime(new Date("2026-08-18T12:00:00+07:00"));
        const seeded = await seedWeeklyLoan({ dailyPenalty: "1.00" });
        const first = await postFloatingPayment(seeded, "306.00", "2026-08-18T05:00:00.000Z");
        expect(first.posted.transactions).toEqual([expect.objectContaining({
            penaltyComponent: "6.00", interestComponent: "300.00", principalComponent: "0.00",
        })]);

        setSystemTime(new Date("2026-08-19T12:00:00+07:00"));
        expect(await closingSummary(seeded)).toMatchObject({ penalty: "3.00", dueInterest: "300.00" });
        const second = await postFloatingPayment(seeded, "3.00", "2026-08-19T05:00:00.000Z");
        expect(second.posted.transactions).toEqual([expect.objectContaining({
            penaltyComponent: "3.00", interestComponent: "0.00", principalComponent: "0.00",
        })]);

        const loan = await db.query.loans.findFirst({ where: eq(loans.publicId, seeded.draft.publicId) });
        const entries = await db.select({
            penaltyDate: floatingPenaltyLedgerEntries.penaltyDate,
            amount: floatingPenaltyLedgerEntries.amount,
            openingInterestBasis: floatingPenaltyLedgerEntries.openingInterestBasis,
        }).from(floatingPenaltyLedgerEntries).where(and(
            eq(floatingPenaltyLedgerEntries.loanId, loan!.id),
            eq(floatingPenaltyLedgerEntries.dueDate, "2026-08-17"),
            eq(floatingPenaltyLedgerEntries.entryType, "daily_percent_accrual"),
        )).orderBy(floatingPenaltyLedgerEntries.penaltyDate);
        expect(entries).toEqual([
            { penaltyDate: "2026-08-18", amount: "6.00", openingInterestBasis: "600.00" },
            { penaltyDate: "2026-08-19", amount: "3.00", openingInterestBasis: "300.00" },
        ]);
    });

    // Break caught: closing/health reads materialize mutable future state that
    // leaks into a later-created payment carrying an earlier receivedAt date.
    integrationTest("keeps future and backdated projections pure and temporally isolated", async () => {
        setSystemTime(new Date("2026-08-20T12:00:00+07:00"));
        const seeded = await seedWeeklyLoan({ dailyPenalty: "1.00" });
        const loan = await db.query.loans.findFirst({ where: eq(loans.publicId, seeded.draft.publicId) });
        expect(loan).toBeDefined();
        const beforeAccruals = await db.select().from(loanInterestAccruals).where(eq(loanInterestAccruals.loanId, loan!.id));
        const beforeLedger = await db.select().from(floatingPenaltyLedgerEntries).where(eq(floatingPenaltyLedgerEntries.loanId, loan!.id));

        expect(await closingSummary(seeded)).toMatchObject({ penalty: "18.00", dueInterest: "600.00" });
        expect(await paymentHealth(seeded, new Date("2026-08-18T12:00:00+07:00"))).toMatchObject({
            overdueAmount: "606.00", overdueItemCount: 1,
        });
        expect(await db.select().from(loanInterestAccruals).where(eq(loanInterestAccruals.loanId, loan!.id))).toEqual(beforeAccruals);
        expect(await db.select().from(floatingPenaltyLedgerEntries).where(eq(floatingPenaltyLedgerEntries.loanId, loan!.id))).toEqual(beforeLedger);

        const backdated = await postFloatingPayment(seeded, "6.00", "2026-08-18T05:00:00.000Z");
        expect(backdated.posted.transactions).toEqual([expect.objectContaining({
            penaltyComponent: "6.00", interestComponent: "0.00", principalComponent: "0.00",
        })]);
        const materializedLedger = await db.select().from(floatingPenaltyLedgerEntries)
            .where(eq(floatingPenaltyLedgerEntries.loanId, loan!.id));
        expect(materializedLedger).toHaveLength(1);

        expect(await closingSummary(seeded)).toMatchObject({ penalty: "12.00", dueInterest: "600.00" });
        expect(await db.select().from(floatingPenaltyLedgerEntries).where(eq(floatingPenaltyLedgerEntries.loanId, loan!.id)))
            .toEqual(materializedLedger);
    });

    // Break caught: a later-created backdated payment rewrites obligations that
    // already have immutable future-dated allocation provenance.
    integrationTest("rejects backdated reconciliation across a later exact allocation", async () => {
        setSystemTime(new Date("2026-08-20T12:00:00+07:00"));
        const seeded = await seedWeeklyLoan({ dailyPenalty: "1.00" });
        await postFloatingPayment(seeded, "1.00", "2026-08-20T05:00:00.000Z");

        const loan = await db.query.loans.findFirst({ where: eq(loans.publicId, seeded.draft.publicId) });
        expect(loan).toBeDefined();
        expect(await db.select().from(floatingPenaltyLedgerEntries).where(and(
            eq(floatingPenaltyLedgerEntries.loanId, loan!.id),
            sql`${floatingPenaltyLedgerEntries.entryType} <> 'adjustment'`,
        ))).toHaveLength(3);

        const before = await db.select().from(floatingPenaltyLedgerEntries)
            .where(eq(floatingPenaltyLedgerEntries.loanId, loan!.id))
            .orderBy(floatingPenaltyLedgerEntries.id);
        await expect(postFloatingPayment(seeded, "306.00", "2026-08-18T05:00:00.000Z"))
            .rejects.toMatchObject({ code: "FLOATING_BACKDATED_ALLOCATION_REQUIRES_RECONCILIATION", status: 409 });
        expect(await db.select().from(floatingPenaltyLedgerEntries)
            .where(eq(floatingPenaltyLedgerEntries.loanId, loan!.id))
            .orderBy(floatingPenaltyLedgerEntries.id)).toEqual(before);
    });

    integrationTest("allows backdated reconciliation after later floating payment is reversed", async () => {
        setSystemTime(new Date("2026-08-20T12:00:00+07:00"));
        const seeded = await seedWeeklyLoan();
        const later = await postFloatingPayment(seeded, "600.00", "2026-08-20T05:00:00.000Z");
        await reversePayment(context(seeded.actor, "reverse-later-payment"), later.intake.publicId, {
            reason: "Reconcile a missing earlier payment",
        });

        await expect(postFloatingPayment(seeded, "600.00", "2026-08-18T05:00:00.000Z"))
            .resolves.toBeDefined();
    });

    // Break caught: a compensation can reduce the assessed ledger below the
    // penalty already paid, silently dropping the customer's excess credit.
    integrationTest("rejects backdated compensation below already-paid penalty", async () => {
        setSystemTime(new Date("2026-08-20T12:00:00+07:00"));
        const seeded = await seedWeeklyLoan({ dailyPenalty: "1.00" });
        await postFloatingPayment(seeded, "18.00", "2026-08-20T05:00:00.000Z");

        await expect(postFloatingPayment(seeded, "306.00", "2026-08-18T05:00:00.000Z"))
            .rejects.toMatchObject({ code: "FLOATING_PENALTY_COMPENSATION_EXCEEDS_UNPAID", status: 409 });
    });

    // Break caught: independent per-entry floor checks can each pass even when
    // their combined compensations reduce a due group below paid penalty.
    integrationTest("rejects aggregate multi-entry compensation below paid penalty", async () => {
        setSystemTime(new Date("2026-08-20T12:00:00+07:00"));
        const seeded = await seedWeeklyLoan({ dailyPenalty: "1.00" });
        await postFloatingPayment(seeded, "8.00", "2026-08-20T05:00:00.000Z");

        await expect(postFloatingPayment(seeded, "306.00", "2026-08-18T05:00:00.000Z"))
            .rejects.toMatchObject({ code: "FLOATING_PENALTY_COMPENSATION_EXCEEDS_UNPAID", status: 409 });
    });

    // Break caught: reconciliation evaluates the paid floor only through the
    // assessment date and misses a later immutable payment against that group.
    integrationTest("rejects backdated compensation below penalty paid after the assessment date", async () => {
        setSystemTime(new Date("2026-08-20T12:00:00+07:00"));
        const seeded = await seedWeeklyLoan({ fixedPenalty: "10.00" });
        await postFloatingPayment(seeded, "10.00", "2026-08-20T05:00:00.000Z");

        await expect(postFloatingPayment(seeded, "600.00", "2026-08-17T05:00:00.000Z"))
            .rejects.toMatchObject({ code: "FLOATING_PENALTY_COMPENSATION_EXCEEDS_UNPAID", status: 409 });
    });

    // Break caught: a later-created backdated payment targets the same accruals
    // as an immutable later-effective interest allocation and over-allocates them.
    integrationTest("rejects a backdated payment that overlaps a later exact interest allocation", async () => {
        setSystemTime(new Date("2026-08-20T12:00:00+07:00"));
        const seeded = await seedWeeklyLoan();
        await postFloatingPayment(seeded, "100.00", "2026-08-20T05:00:00.000Z");

        await expect(postFloatingPayment(seeded, "100.00", "2026-08-17T05:00:00.000Z"))
            .rejects.toMatchObject({ code: "FLOATING_BACKDATED_ALLOCATION_REQUIRES_RECONCILIATION", status: 409 });
    });

    // Break caught: a backdated penalty payment ignores an immutable
    // later-effective allocation and silently pays the same due group twice.
    integrationTest("rejects a backdated payment that overlaps a later exact penalty allocation", async () => {
        setSystemTime(new Date("2026-08-20T12:00:00+07:00"));
        const seeded = await seedWeeklyLoan({ fixedPenalty: "10.00" });
        await postFloatingPayment(seeded, "10.00", "2026-08-20T05:00:00.000Z");

        await expect(postFloatingPayment(seeded, "10.00", "2026-08-18T05:00:00.000Z"))
            .rejects.toMatchObject({ code: "FLOATING_BACKDATED_ALLOCATION_REQUIRES_RECONCILIATION", status: 409 });
    });

    // Break caught: fixed penalty is considered only on the original eligible
    // date, so a later reversal can reopen overdue interest without ever charging it.
    integrationTest("assesses the fixed fee when reversal first reopens an overdue interest basis", async () => {
        setSystemTime(new Date("2026-08-17T12:00:00+07:00"));
        const seeded = await seedWeeklyLoan({ fixedPenalty: "10.00" });
        const paid = await postFloatingPayment(seeded, "600.00", "2026-08-17T05:00:00.000Z");

        setSystemTime(new Date("2026-08-20T12:00:00+07:00"));
        await reversePayment(context(seeded.actor, "reverse-before-fixed-fee"), paid.intake.publicId, {
            reason: "Restore the overdue interest obligation",
        });
        setSystemTime(new Date("2026-08-21T12:00:00+07:00"));

        expect(await closingSummary(seeded)).toMatchObject({ penalty: "10.00", dueInterest: "600.00" });
    });

    // Break caught: reversal guesses from newest mutable rows rather than
    // compensating the exact due-group allocations made by its transaction.
    integrationTest("reverses exact multi-group allocations with immutable audited provenance", async () => {
        setSystemTime(new Date("2026-08-18T12:00:00+07:00"));
        const seeded = await seedWeeklyLoan({ fixedPenalty: "10.00" });
        await postFloatingPayment(seeded, "610.00", "2026-08-18T05:00:00.000Z");

        setSystemTime(new Date("2026-08-25T12:00:00+07:00"));
        const second = await postFloatingPayment(seeded, "610.00", "2026-08-25T05:00:00.000Z");
        const secondTransaction = await db.query.transactions.findFirst({
            where: eq(transactions.publicId, second.posted.transactions[0]!.publicId),
        });
        expect(secondTransaction).toBeDefined();
        const originalPenalty = await db.query.floatingTransactionAllocations.findFirst({
            where: and(
                eq(floatingTransactionAllocations.transactionId, secondTransaction!.id),
                eq(floatingTransactionAllocations.component, "penalty"),
            ),
        });
        expect(originalPenalty).toMatchObject({ dueDate: "2026-08-24", amount: "10.00", entryType: "payment" });

        const reversed = await reversePayment(context(seeded.actor, "reverse-second-group"), second.intake.publicId, {
            reason: "Return second grouped payment",
        });
        const reversalTransaction = await db.query.transactions.findFirst({
            where: and(eq(transactions.reversedTransactionId, secondTransaction!.id), eq(transactions.tenantId, seeded.actor.tenantId)),
        });
        expect(reversalTransaction).toBeDefined();
        const reversalPenalty = await db.query.floatingTransactionAllocations.findFirst({
            where: eq(floatingTransactionAllocations.reversedAllocationId, originalPenalty!.id),
        });
        expect(reversalPenalty).toMatchObject({
            transactionId: reversalTransaction!.id,
            dueDate: "2026-08-24",
            component: "penalty",
            amount: "-10.00",
            entryType: "reversal",
        });
        expect(reversed.transactions).toContainEqual(expect.objectContaining({ entryType: "reversal", penaltyComponent: "-10.00" }));
        expect(await closingSummary(seeded)).toMatchObject({ penalty: "10.00", dueInterest: "600.00" });

        const allocationAudit = await db.query.auditLogs.findFirst({
            where: and(eq(auditLogs.tenantId, seeded.actor.tenantId), eq(auditLogs.publicId, originalPenalty!.auditPublicId)),
        });
        expect(allocationAudit).toMatchObject({
            actorUserId: seeded.actor.id,
            actorSource: "web",
            action: "floating_payment_allocations_recorded",
        });
        expect(allocationAudit?.requestId).toBe(second.ctx.requestId);
        expect(allocationAudit?.correlationId).toBe(second.ctx.correlationId);

        const ledger = await db.query.floatingPenaltyLedgerEntries.findFirst({
            where: eq(floatingPenaltyLedgerEntries.loanId, secondTransaction!.loanId),
        });
        expect(ledger).toBeDefined();
        await expect(Promise.resolve(db.update(floatingPenaltyLedgerEntries).set({ amount: "99.00" })
            .where(eq(floatingPenaltyLedgerEntries.id, ledger!.id)))).rejects.toThrow();
        await expect(Promise.resolve(db.delete(floatingPenaltyLedgerEntries)
            .where(eq(floatingPenaltyLedgerEntries.id, ledger!.id)))).rejects.toThrow();
        await expect(Promise.resolve(db.update(floatingTransactionAllocations).set({ amount: "99.00" })
            .where(eq(floatingTransactionAllocations.id, originalPenalty!.id)))).rejects.toThrow();
        await expect(Promise.resolve(db.delete(floatingTransactionAllocations)
            .where(eq(floatingTransactionAllocations.id, originalPenalty!.id)))).rejects.toThrow();
    });
});
