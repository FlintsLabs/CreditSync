import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import {
    auditLogs,
    bankProfiles,
    borrowers,
    fundLedgerEntries,
    loanDisbursements,
    loanFundingAllocations,
    loanInterestAccruals,
    loanInterestRatePeriods,
    loans,
    loanSettlementPreviews,
    transactions,
    users,
} from "../db/schema";
import type { CommandContext } from "./command-context";
import {
    createPaymentIntake,
    postPayment,
    previewPaymentMatch,
    reversePayment,
} from "./payment-service";
import {
    executeLoanSettlement,
    previewLoanSettlement,
} from "./loan-settlement-service";
import { accrueFloatingInterestThrough } from "./floating-interest-service";

const integrationEnabled = Boolean(process.env.TEST_DATABASE_URL);
const integrationTest = integrationEnabled ? test : test.skip;

async function resetApplicationTables() {
    await db.execute(sql`SET client_min_messages TO WARNING`);
    await db.execute(sql`TRUNCATE TABLE
        audit_logs, fund_ledger_entries, payment_match_allocations,
        payment_match_proposals, payment_evidence, transactions,
        payment_intakes, loan_settlement_previews, loan_disbursements,
        loan_interest_accruals, loan_interest_rate_periods,
        loan_funding_allocations, loan_schedules, loans,
        borrower_aliases, borrowers, bank_profiles, users
        RESTART IDENTITY CASCADE`);
}

async function seedUser(tenantId: string) {
    return db.insert(users).values({
        tenantId,
        email: `${crypto.randomUUID()}@example.test`,
        role: "owner",
    }).returning().then((rows) => rows[0]!);
}

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

const paidAdvanceIncrements = ["85.71", "85.72", "85.71", "85.72", "85.71", "85.72", "85.71"];
const paidAdvanceCumulative = ["85.71", "171.43", "257.14", "342.86", "428.57", "514.29", "600.00"];

async function seedWeeklyLoan(input: { tenantId: string; advancePeriods?: 0 | 1 }) {
    const actor = await seedUser(input.tenantId);
    const borrower = await db.insert(borrowers).values({
        tenantId: input.tenantId,
        ownerUserId: actor.id,
        name: "Settlement borrower",
    }).returning().then((rows) => rows[0]!);
    const advancePeriods = input.advancePeriods ?? 0;
    const loan = await db.insert(loans).values({
        tenantId: input.tenantId,
        ownerUserId: actor.id,
        borrowerId: borrower.id,
        principalAmount: "5000.00",
        interestRate: "0.00",
        repaymentType: "floating",
        dailyInterestMode: "percent",
        dailyInterestRate: "12.0000",
        firstDayTreatment: advancePeriods === 1 ? "deduct" : "start_next_day",
        interestStartDate: "2026-08-13",
        interestPeriodUnit: "week",
        interestPeriodLength: 1,
        advanceInterestPeriods: advancePeriods,
        advanceInterestRefundPolicy: "non_refundable",
        interestPeriodAnchorDate: "2026-08-13",
        outstandingPrincipal: "5000.00",
        outstandingInterest: "0.00",
        outstandingFees: "0.00",
        status: "active",
    }).returning().then((rows) => rows[0]!);
    const ratePeriod = await db.insert(loanInterestRatePeriods).values({
        tenantId: input.tenantId,
        loanId: loan.id,
        effectiveDate: "2026-08-13",
        rateType: "percent",
        rate: "12.0000",
        periodUnit: "week",
        periodLength: 1,
        createdByUserId: actor.id,
    }).returning().then((rows) => rows[0]!);
    if (advancePeriods === 1) {
        await db.insert(loanDisbursements).values({
            tenantId: input.tenantId,
            loanId: loan.id,
            grossPrincipal: "5000.00",
            firstDayInterestDeducted: "600.00",
            netDisbursement: "4400.00",
            disbursedAt: new Date("2026-08-13T12:00:00+07:00"),
            createdByUserId: actor.id,
        });
        await db.insert(loanInterestAccruals).values(paidAdvanceIncrements.map((interestAmount, index) => ({
            tenantId: input.tenantId,
            loanId: loan.id,
            interestRatePeriodId: ratePeriod.id,
            accrualDate: `2026-08-${String(13 + index).padStart(2, "0")}`,
            openingPrincipal: "5000.00",
            rateMode: "percent",
            rate: "12.0000",
            interestAmount,
            periodStartDate: "2026-08-13",
            periodEndDate: "2026-08-20",
            periodDayIndex: index + 1,
            periodUnit: "week",
            periodLength: 1,
            contractualInterestAmount: "600.00",
            cumulativeInterestAmount: paidAdvanceCumulative[index]!,
            dailyIncrementAmount: interestAmount,
            paidAmount: interestAmount,
            status: "paid",
            createdByUserId: actor.id,
        })));
    }
    return { actor, borrower, loan, ratePeriod };
}

async function postFloatingPrincipalPayment(
    seeded: Awaited<ReturnType<typeof seedWeeklyLoan>>,
    amount: string,
    receivedAt: string,
    key: string,
) {
    const intake = await createPaymentIntake(context(seeded.actor, `${key}-intake`), { amount, receivedAt });
    const preview = await previewPaymentMatch(context(seeded.actor, `${key}-preview`), intake.publicId, {
        allocations: [{
            borrowerPublicId: seeded.borrower.publicId,
            loanPublicId: seeded.loan.publicId,
            amount,
        }],
    });
    const posted = await postPayment(context(seeded.actor, `${key}-post`), intake.publicId, {
        proposalPublicId: preview.publicId,
    });
    return { intake, posted };
}

describe("loan settlement service", () => {
    if (integrationEnabled) beforeEach(resetApplicationTables);
    afterEach(() => setSystemTime());

    // Break caught: settlement reuses normal-payment allocation and omits current-period accruing interest.
    integrationTest("previews THB 5,257.14 after three weekly accrual dates without advance interest", async () => {
        const seeded = await seedWeeklyLoan({ tenantId: "tenant-settlement-no-advance" });

        const preview = await previewLoanSettlement(context(seeded.actor), seeded.loan.publicId, "2026-08-15");

        expect(preview).toMatchObject({
            id: preview.publicId,
            loanPublicId: seeded.loan.publicId,
            status: "ready",
            asOfDate: "2026-08-15",
            outstandingPrincipal: "5000.00",
            dueInterest: "0.00",
            accruedNotDueInterest: "257.14",
            outstandingFees: "0.00",
            outstandingPenalties: "0.00",
            nonRefundableAdvanceInterest: "0.00",
            settlementTotal: "5257.14",
            hashVersion: "v1",
        });
        expect(preview.previewHash).toMatch(/^v1:[0-9a-f]{64}$/);
        expect(preview.balanceVersion).toMatch(/^v1:[0-9a-f]{64}$/);
        expect((await db.select().from(loanInterestAccruals).where(eq(loanInterestAccruals.loanId, seeded.loan.id)))
            .map((row) => ({ amount: row.interestAmount, status: row.status }))).toEqual([
            { amount: "85.71", status: "accruing" },
            { amount: "85.72", status: "accruing" },
            { amount: "85.71", status: "accruing" },
        ]);
    });

    // Break caught: a future read promotes the period and makes a backdated close-out omit not-yet-due interest.
    integrationTest("classifies a backdated preview by its as-of date after the period was promoted later", async () => {
        const seeded = await seedWeeklyLoan({ tenantId: "tenant-settlement-backdated-preview" });
        await accrueFloatingInterestThrough(
            db,
            seeded.loan,
            new Date("2026-08-20T12:00:00+07:00"),
            context(seeded.actor),
        );

        const preview = await previewLoanSettlement(context(seeded.actor), seeded.loan.publicId, "2026-08-15");

        expect(preview).toMatchObject({
            dueInterest: "0.00",
            accruedNotDueInterest: "257.14",
            settlementTotal: "5257.14",
        });
    });

    // Break caught: a backdated execute closes the loan while active later accruals remain unpaid.
    integrationTest("rejects a backdated execute when later active accruals already exist", async () => {
        const seeded = await seedWeeklyLoan({ tenantId: "tenant-settlement-backdated-execute" });
        await accrueFloatingInterestThrough(
            db,
            seeded.loan,
            new Date("2026-08-20T12:00:00+07:00"),
            context(seeded.actor),
        );
        const preview = await previewLoanSettlement(context(seeded.actor), seeded.loan.publicId, "2026-08-15");
        const accrualsBefore = await db.select().from(loanInterestAccruals)
            .where(eq(loanInterestAccruals.loanId, seeded.loan.id)).orderBy(loanInterestAccruals.id);

        await expect(executeLoanSettlement(context(seeded.actor, "settlement-backdated-execute"), {
            settlementPublicId: preview.publicId,
            previewHash: preview.previewHash,
            confirmed: true,
            reason: "Attempt a historical close after later accruals exist",
        })).rejects.toMatchObject({ code: "STALE_SETTLEMENT_PREVIEW", status: 409 });

        expect(await db.query.loanSettlementPreviews.findFirst({
            where: eq(loanSettlementPreviews.publicId, preview.publicId),
        })).toMatchObject({ status: "ready", executedAt: null });
        expect(await db.query.loans.findFirst({ where: eq(loans.id, seeded.loan.id) })).toMatchObject({
            status: "active",
            outstandingPrincipal: "5000.00",
        });
        expect(await db.select().from(transactions).where(eq(transactions.loanId, seeded.loan.id))).toHaveLength(0);
        expect(await db.select().from(fundLedgerEntries).where(eq(fundLedgerEntries.loanId, seeded.loan.id))).toHaveLength(0);
        expect(await db.select().from(loanInterestAccruals)
            .where(eq(loanInterestAccruals.loanId, seeded.loan.id)).orderBy(loanInterestAccruals.id)).toEqual(accrualsBefore);
    });

    // Break caught: close-out refunds an unused part of the already-paid advance period or charges it twice.
    integrationTest("previews only THB 5,000.00 during an advance-covered period and preserves THB 600.00 as non-refundable history", async () => {
        const seeded = await seedWeeklyLoan({ tenantId: "tenant-settlement-advance", advancePeriods: 1 });
        const before = await db.select().from(loanInterestAccruals)
            .where(eq(loanInterestAccruals.loanId, seeded.loan.id)).orderBy(loanInterestAccruals.id);

        const preview = await previewLoanSettlement(context(seeded.actor), seeded.loan.publicId, "2026-08-15");

        expect(preview).toMatchObject({
            outstandingPrincipal: "5000.00",
            dueInterest: "0.00",
            accruedNotDueInterest: "0.00",
            nonRefundableAdvanceInterest: "600.00",
            settlementTotal: "5000.00",
        });
        expect(await db.select().from(loanInterestAccruals)
            .where(eq(loanInterestAccruals.loanId, seeded.loan.id)).orderBy(loanInterestAccruals.id)).toEqual(before);
    });

    // Break caught: advance coverage leaks into period two or settlement charges a complete second week early.
    integrationTest("previews THB 5,257.14 on accrual date three of period two after one advance period", async () => {
        const seeded = await seedWeeklyLoan({ tenantId: "tenant-settlement-period-two", advancePeriods: 1 });

        const preview = await previewLoanSettlement(context(seeded.actor), seeded.loan.publicId, "2026-08-22");

        expect(preview).toMatchObject({
            outstandingPrincipal: "5000.00",
            dueInterest: "0.00",
            accruedNotDueInterest: "257.14",
            nonRefundableAdvanceInterest: "600.00",
            settlementTotal: "5257.14",
        });
    });

    // Break caught: execute duplicates close-out money, omits command audit context, or closes a non-zero loan.
    integrationTest("executes one exact close-account entry idempotently and closes only zero balances", async () => {
        const seeded = await seedWeeklyLoan({ tenantId: "tenant-settlement-execute" });
        const preview = await previewLoanSettlement(context(seeded.actor), seeded.loan.publicId, "2026-08-15");
        const ctx = context(seeded.actor, "settlement-execute-once");
        const input = {
            settlementPublicId: preview.publicId,
            previewHash: preview.previewHash,
            confirmed: true as const,
            reason: "Borrower confirmed exact close-out",
        };

        const [first, retry] = await Promise.all([
            executeLoanSettlement(ctx, input),
            executeLoanSettlement(ctx, input),
        ]);
        const laterRetry = await executeLoanSettlement({
            ...ctx,
            requestId: "req-settlement-execute-retry",
            correlationId: "corr-settlement-execute-retry",
        }, input);

        expect(retry).toEqual(first);
        expect(laterRetry).toEqual(first);
        expect(first).toMatchObject({
            status: "executed",
            loanPublicId: seeded.loan.publicId,
            settlementTotal: "5257.14",
            transaction: {
                amount: "5257.14",
                principalComponent: "5000.00",
                interestComponent: "257.14",
                feeComponent: "0.00",
                penaltyComponent: "0.00",
                type: "close_account",
                entryType: "repayment",
            },
            auditPublicId: expect.stringMatching(/^[0-9a-f-]{36}$/),
            correlationId: "corr-settlement-execute-once",
        });
        expect(await db.select().from(transactions).where(eq(transactions.loanId, seeded.loan.id))).toHaveLength(1);
        expect(await db.query.loans.findFirst({ where: eq(loans.id, seeded.loan.id) })).toMatchObject({
            status: "paid",
            outstandingPrincipal: "0.00",
            outstandingInterest: "0.00",
            outstandingFees: "0.00",
        });
        expect(await db.select().from(loanInterestAccruals).where(and(
            eq(loanInterestAccruals.loanId, seeded.loan.id),
            sql`${loanInterestAccruals.status} <> 'reversed'`,
        ))).toEqual(expect.arrayContaining([
            expect.objectContaining({ accrualDate: "2026-08-13", paidAmount: "85.71", status: "paid" }),
            expect.objectContaining({ accrualDate: "2026-08-14", paidAmount: "85.72", status: "paid" }),
            expect.objectContaining({ accrualDate: "2026-08-15", paidAmount: "85.71", status: "paid" }),
        ]));
        expect(await db.select().from(auditLogs).where(and(
            eq(auditLogs.entityId, preview.publicId),
            eq(auditLogs.action, "executed"),
        ))).toEqual([expect.objectContaining({
            actorUserId: seeded.actor.id,
            actorSource: "web",
            requestId: "req-settlement-execute-once",
            correlationId: "corr-settlement-execute-once",
        })]);
    });

    // Break caught: close-account posting bypasses the funded principal return and income ledger effects.
    integrationTest("posts exact principal, interest, and fee fund effects for a funded settlement", async () => {
        const seeded = await seedWeeklyLoan({ tenantId: "tenant-settlement-funded" });
        const profile = await db.insert(bankProfiles).values({
            tenantId: seeded.actor.tenantId,
            name: "Settlement fund",
            type: "personal_savings",
        }).returning().then((rows) => rows[0]!);
        await db.insert(loanFundingAllocations).values({
            tenantId: seeded.actor.tenantId,
            loanId: seeded.loan.id,
            bankProfileId: profile.id,
            allocatedAmount: "5000.00",
            allocationDate: "2026-08-13",
            createdByUserId: seeded.actor.id,
        });
        await db.update(loans).set({ outstandingFees: "12.34", updatedAt: new Date() })
            .where(eq(loans.id, seeded.loan.id));
        const preview = await previewLoanSettlement(context(seeded.actor), seeded.loan.publicId, "2026-08-15");

        const executed = await executeLoanSettlement(context(seeded.actor, "settlement-funded-execute"), {
            settlementPublicId: preview.publicId,
            previewHash: preview.previewHash,
            confirmed: true,
            reason: "Return funded principal and recognize exact income",
        });

        expect(executed).toMatchObject({
            settlementTotal: "5269.48",
            transaction: {
                principalComponent: "5000.00",
                interestComponent: "257.14",
                feeComponent: "12.34",
            },
        });
        const transaction = await db.query.transactions.findFirst({
            where: eq(transactions.publicId, executed.transaction.publicId),
        });
        const ledger = await db.select().from(fundLedgerEntries)
            .where(eq(fundLedgerEntries.loanId, seeded.loan.id)).orderBy(fundLedgerEntries.id);
        expect(ledger).toHaveLength(3);
        expect(ledger).toEqual(expect.arrayContaining([
            expect.objectContaining({
                bankProfileId: profile.id,
                transactionId: transaction!.id,
                entryType: "principal_return_in",
                amount: "5000.00",
            }),
            expect.objectContaining({
                bankProfileId: profile.id,
                transactionId: transaction!.id,
                entryType: "interest_income_in",
                amount: "257.14",
            }),
            expect.objectContaining({
                bankProfileId: profile.id,
                transactionId: transaction!.id,
                entryType: "fee_income_in",
                amount: "12.34",
            }),
        ]));
    });

    // Break caught: caller-supplied hash is trusted instead of the persisted versioned settlement proposal.
    integrationTest("rejects a stale preview hash without posting money", async () => {
        const seeded = await seedWeeklyLoan({ tenantId: "tenant-settlement-stale-hash" });
        const preview = await previewLoanSettlement(context(seeded.actor), seeded.loan.publicId, "2026-08-15");

        await expect(executeLoanSettlement(context(seeded.actor, "settlement-stale-hash"), {
            settlementPublicId: preview.publicId,
            previewHash: `v1:${"0".repeat(64)}`,
            confirmed: true,
            reason: "This hash is stale",
        })).rejects.toMatchObject({ code: "STALE_SETTLEMENT_PREVIEW", status: 409 });

        expect(await db.select().from(transactions).where(eq(transactions.loanId, seeded.loan.id))).toHaveLength(0);
        expect(await db.query.loanSettlementPreviews.findFirst({ where: eq(loanSettlementPreviews.publicId, preview.publicId) }))
            .toMatchObject({ status: "expired" });
    });

    // Break caught: an expired amount can still settle a loan after its review window.
    integrationTest("rejects an expired preview without posting money", async () => {
        const seeded = await seedWeeklyLoan({ tenantId: "tenant-settlement-expired" });
        const preview = await previewLoanSettlement(context(seeded.actor), seeded.loan.publicId, "2026-08-15");
        setSystemTime(new Date(preview.expiresAt.getTime() + 1));

        await expect(executeLoanSettlement(context(seeded.actor, "settlement-expired"), {
            settlementPublicId: preview.publicId,
            previewHash: preview.previewHash,
            confirmed: true,
            reason: "Expired amount must stop",
        })).rejects.toMatchObject({ code: "STALE_SETTLEMENT_PREVIEW", status: 409 });

        expect(await db.select().from(transactions).where(eq(transactions.loanId, seeded.loan.id))).toHaveLength(0);
    });

    // Break caught: a normal payment between preview and execute is ignored by a balance-version-only-in-name check.
    integrationTest("rejects execution after a concurrent normal payment changes the balance version", async () => {
        const seeded = await seedWeeklyLoan({ tenantId: "tenant-settlement-concurrent-payment" });
        const preview = await previewLoanSettlement(context(seeded.actor), seeded.loan.publicId, "2026-08-15");
        await postFloatingPrincipalPayment(seeded, "100.00", "2026-08-15T12:00:00+07:00", "concurrent-payment");
        const refreshed = await previewLoanSettlement(context(seeded.actor), seeded.loan.publicId, "2026-08-15");
        expect(refreshed.balanceVersion).not.toBe(preview.balanceVersion);

        await expect(executeLoanSettlement(context(seeded.actor, "settlement-after-payment"), {
            settlementPublicId: preview.publicId,
            previewHash: preview.previewHash,
            confirmed: true,
            reason: "Must use latest borrower balance",
        })).rejects.toMatchObject({ code: "STALE_SETTLEMENT_PREVIEW", status: 409 });

        expect((await db.select().from(transactions).where(eq(transactions.loanId, seeded.loan.id)))
            .filter((row) => row.type === "close_account")).toHaveLength(0);
    });

    // Break caught: execute reads stale balances before acquiring the loan row lock.
    integrationTest("waits for the loan row lock and rejects the preview after the locked balance changes", async () => {
        const seeded = await seedWeeklyLoan({ tenantId: "tenant-settlement-row-lock" });
        const preview = await previewLoanSettlement(context(seeded.actor), seeded.loan.publicId, "2026-08-15");
        let markLocked!: () => void;
        let releaseBlocker!: () => void;
        const locked = new Promise<void>((resolve) => { markLocked = resolve; });
        const release = new Promise<void>((resolve) => { releaseBlocker = resolve; });
        const blocker = db.transaction(async (tx) => {
            await tx.execute(sql`SELECT id FROM loans WHERE id = ${seeded.loan.id} FOR UPDATE`);
            markLocked();
            await release;
            await tx.update(loans).set({ outstandingPrincipal: "4999.00", updatedAt: new Date() })
                .where(eq(loans.id, seeded.loan.id));
        });
        await locked;
        let completed = false;
        const pending = executeLoanSettlement(context(seeded.actor, "settlement-row-lock"), {
            settlementPublicId: preview.publicId,
            previewHash: preview.previewHash,
            confirmed: true,
            reason: "Lock before balance verification",
        }).finally(() => { completed = true; });
        pending.catch(() => undefined);
        await Bun.sleep(75);
        expect(completed).toBe(false);
        expect((await db.select().from(transactions).where(eq(transactions.loanId, seeded.loan.id)))
            .filter((row) => row.type === "close_account")).toHaveLength(0);

        releaseBlocker();
        await blocker;
        await expect(pending).rejects.toMatchObject({ code: "STALE_SETTLEMENT_PREVIEW", status: 409 });
    });

    // Break caught: settling an advance-covered loan mutates or refunds its historical THB 600 charge.
    integrationTest("executes the additional THB 5,000.00 without changing paid advance history", async () => {
        const seeded = await seedWeeklyLoan({ tenantId: "tenant-settlement-advance-execute", advancePeriods: 1 });
        const before = await db.select().from(loanInterestAccruals)
            .where(eq(loanInterestAccruals.loanId, seeded.loan.id)).orderBy(loanInterestAccruals.id);
        const preview = await previewLoanSettlement(context(seeded.actor), seeded.loan.publicId, "2026-08-15");

        const executed = await executeLoanSettlement(context(seeded.actor, "settlement-advance-execute"), {
            settlementPublicId: preview.publicId,
            previewHash: preview.previewHash,
            confirmed: true,
            reason: "Close during paid advance period",
        });

        expect(executed).toMatchObject({
            settlementTotal: "5000.00",
            nonRefundableAdvanceInterest: "600.00",
            transaction: { amount: "5000.00", principalComponent: "5000.00", interestComponent: "0.00" },
        });
        expect(await db.select().from(loanInterestAccruals)
            .where(eq(loanInterestAccruals.loanId, seeded.loan.id)).orderBy(loanInterestAccruals.id)).toEqual(before);
        expect((await db.select().from(transactions).where(eq(transactions.loanId, seeded.loan.id)))
            .some((row) => row.amount.startsWith("-"))).toBe(false);
    });

    // Break caught: reversing an earlier payment after close-out restores principal underneath a posted settlement.
    integrationTest("blocks reversal of an earlier payment while its downstream settlement remains posted", async () => {
        const seeded = await seedWeeklyLoan({ tenantId: "tenant-settlement-reversal-boundary" });
        const earlier = await postFloatingPrincipalPayment(
            seeded,
            "100.00",
            "2026-08-14T12:00:00+07:00",
            "earlier-payment",
        );
        const preview = await previewLoanSettlement(context(seeded.actor), seeded.loan.publicId, "2026-08-15");
        await executeLoanSettlement(context(seeded.actor, "settlement-after-earlier-payment"), {
            settlementPublicId: preview.publicId,
            previewHash: preview.previewHash,
            confirmed: true,
            reason: "Close after an ordinary principal payment",
        });

        await expect(reversePayment(context(seeded.actor, "reverse-before-settlement"), earlier.intake.publicId, {
            reason: "Attempt unsafe historical reversal",
        })).rejects.toMatchObject({ code: "REVERSAL_NOT_LATEST", status: 409 });

        const rows = await db.select().from(transactions).where(eq(transactions.loanId, seeded.loan.id)).orderBy(transactions.id);
        expect(rows.map((row) => ({ type: row.type, entryType: row.entryType, amount: row.amount }))).toEqual([
            { type: "repayment", entryType: "repayment", amount: "100.00" },
            { type: "close_account", entryType: "repayment", amount: preview.settlementTotal },
        ]);
        expect(await db.query.loans.findFirst({ where: eq(loans.id, seeded.loan.id) })).toMatchObject({
            status: "paid",
            outstandingPrincipal: "0.00",
        });
    });
});
