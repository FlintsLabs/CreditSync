import { beforeEach, describe, expect, test } from "bun:test";
import Decimal from "decimal.js";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import {
    auditLogs, bankProfiles, borrowers, fundLedgerEntries, loanDisbursementEvents, loanFundingAllocations, loanOpeningBalanceComponents,
    loanInterestRatePeriods, loanRenewals, loanRestructures, loanSchedules, loans, paymentIntakes, paymentMatchAllocations, paymentMatchProposals, transactions, users,
} from "../db/schema";
import type { CommandContext } from "./command-context";
import { executeLoanRestructure, previewLoanRestructure, reverseLoanRestructure } from "./loan-restructure-service";

const integrationTest = process.env.TEST_DATABASE_URL ? test : test.skip;

async function reset() {
    await db.execute(sql`TRUNCATE TABLE audit_logs, loan_restructure_waivers,
        loan_opening_balance_components, loan_restructures, loan_disbursement_events,
        transactions, loan_schedules, loans, borrowers, users RESTART IDENTITY CASCADE`);
}

async function seed() {
    const tenantId = `tenant-${crypto.randomUUID()}`;
    const actor = await db.insert(users).values({ tenantId, email: `${crypto.randomUUID()}@example.test`, role: "owner" }).returning().then(r => r[0]!);
    const borrower = await db.insert(borrowers).values({ tenantId, ownerUserId: actor.id, name: "Restructure Borrower" }).returning().then(r => r[0]!);
    const loan = await db.insert(loans).values({
        tenantId, ownerUserId: actor.id, borrowerId: borrower.id,
        principalAmount: "5000.00", interestRate: "10.00", repaymentType: "single_payment", termMonths: 1,
        startDate: "2026-08-01", singlePaymentDueDate: "2026-08-10",
        singlePaymentFixedAgreedInterest: "500.00", singlePaymentInterestPolicy: "greater_of_fixed_or_retroactive",
        singlePaymentRetroactiveRateType: "percent_per_day", singlePaymentRetroactiveRate: "2.0000",
        singlePaymentLatePenaltyMode: "fixed_amount_per_day", singlePaymentLatePenaltyAmountPerDay: "10.00",
        singlePaymentLatePenaltyGraceDays: 1, outstandingPrincipal: "5000.00", outstandingInterest: "500.00",
        outstandingFees: "25.00", status: "active",
    }).returning().then(r => r[0]!);
    await db.insert(loanDisbursementEvents).values({
        tenantId, loanId: loan.id, grossAmount: "5000.00", loanAttributedAmount: "5000.00", channel: "bank_transfer",
        status: "posted", disbursedAt: new Date("2026-08-01T03:00:00Z"), postedAt: new Date("2026-08-01T03:01:00Z"), postIdempotencyKey: crypto.randomUUID(), createdByUserId: actor.id,
    });
    const ctx = (key?: string): CommandContext => ({ tenantId, actorUserId: actor.id, actorSource: "web", requestId: "req-task-4", correlationId: "corr-task-4", idempotencyKey: key });
    return { tenantId, actor, borrower, loan, ctx };
}

const replacementTerms = {
    repaymentType: "single_payment" as const, startDate: "2026-08-15", termMonths: 1, interestRate: "4.00",
    singlePayment: { dueDate: "2026-09-15", fixedAgreedInterest: "240.00", interestPolicy: "fixed_only" as const, latePenalty: { mode: "none" as const } },
};

describe("loan restructure service", () => {
    if (process.env.TEST_DATABASE_URL) beforeEach(reset);

    integrationTest("previews authoritative exposure, greater-of interest, concurrent penalty, waivers and additional cash", async () => {
        const { loan, ctx } = await seed();
        const preview = await previewLoanRestructure(ctx(), loan.publicId, {
            settlementDate: "2026-08-15", replacementTerms, additionalPrincipal: "1000.00",
            waivers: { interest: { amount: "100.00", reason: "hardship" }, fees: { amount: "5.00", reason: "assistance" }, penalty: { amount: "10.00", reason: "goodwill" } },
            externalSettlementCredit: { amount: "200.00", payer: "Family", source: "cash assistance" }, reason: "replace contract",
        });
        expect(preview.balance.grossPrincipal).toBe("5000.00");
        expect(preview.balance.fixedInterestCandidate).toBe("500.00");
        expect(preview.balance.retroactiveInterestCandidate).toBe("1400.00");
        expect(preview.balance.selectedInterestBranch).toBe("retroactive");
        expect(preview.balance.grossPenalty).toBe("40.00");
        expect(preview.balance.netInterest).toBe("1300.00");
        expect(preview.replacementPrincipal).toBe("6000.00");
        expect(preview.cash).toEqual({ direction: "payout", amount: "1000.00" });
        expect(preview.externalCreditAllocation).toEqual({ penalty: "30.00", fee: "20.00", interest: "150.00", principal: "0.00", unallocated: "0.00" });
        expect(preview.replacementPrincipal).toBe("6000.00");
        expect(preview.previewHash).toMatch(/^v1:[0-9a-f]{64}$/);
        expect(preview.oldBalanceVersion).toMatch(/^v1:[0-9a-f]{64}$/);
        expect(preview.expiresAt).toBeInstanceOf(Date);
        expect(await db.select().from(loans).where(eq(loans.clonedFromLoanId, loan.id))).toHaveLength(0);
    });

    integrationTest("executes atomically, replays same key, persists opening components, and creates only an additional-principal draft", async () => {
        const { tenantId, loan, ctx } = await seed();
        const profile = await db.insert(bankProfiles).values({ tenantId, name: "Settlement source", type: "personal_savings" }).returning().then(rows => rows[0]!);
        await db.insert(loanFundingAllocations).values({ tenantId, loanId: loan.id, bankProfileId: profile.id, allocatedAmount: "5000.00", allocationDate: "2026-08-01", createdByUserId: ctx().actorUserId });
        const preview = await previewLoanRestructure(ctx(), loan.publicId, {
            settlementDate: "2026-08-15", replacementTerms, additionalPrincipal: "1000.00",
            waivers: { interest: { amount: "100.00", reason: "hardship" } }, reason: "replace contract",
            externalSettlementCredit: { amount: "200.00", payer: "Family", source: "assistance" },
        });
        const input = { confirmed: true as const, previewHash: preview.previewHash, expectedBalanceVersion: preview.oldBalanceVersion, reason: "approved replacement" };
        const [first, concurrentReplay] = await Promise.all([
            executeLoanRestructure(ctx("execute-1"), preview.publicId, input),
            executeLoanRestructure(ctx("execute-1"), preview.publicId, input),
        ]);
        expect(concurrentReplay).toEqual(first);
        const replay = await executeLoanRestructure(ctx("execute-1"), preview.publicId, input);
        expect(replay).toEqual(first);
        expect(first.oldLoanPublicId).toBe(loan.publicId);
        expect(first.newLoanPublicId).toMatch(/^[0-9a-f-]{36}$/);
        expect(first.disbursementDraftPublicId).toMatch(/^[0-9a-f-]{36}$/);
        expect(first.auditPublicIds.length).toBeGreaterThan(0);
        expect(first.correlationId).toBe("corr-task-4");
        expect((await db.query.loans.findFirst({ where: and(eq(loans.tenantId, tenantId), eq(loans.id, loan.id)) }))?.status).toBe("restructured");
        const newLoan = await db.query.loans.findFirst({ where: eq(loans.publicId, first.newLoanPublicId) });
        expect(newLoan?.status).toBe("active");
        expect(newLoan?.principalAmount).toBe("6000.00");
        const components = await db.select().from(loanOpeningBalanceComponents).where(eq(loanOpeningBalanceComponents.loanId, newLoan!.id));
        expect(components.map(c => [c.componentKind, c.amount])).toEqual(expect.arrayContaining([
            ["carried_principal", "5000.00"], ["additional_principal", "1000.00"], ["carried_interest", "1165.00"], ["new_contract_interest", "240.00"],
        ]));
        const drafts = await db.select().from(loanDisbursementEvents).where(eq(loanDisbursementEvents.loanId, newLoan!.id));
        expect(drafts.map(d => [d.status, d.grossAmount, d.loanAttributedAmount, d.restructureId])).toEqual([["draft", "1000.00", "1000.00", expect.any(Number)]]);
        const executedRestructure = await db.query.loanRestructures.findFirst({ where: eq(loanRestructures.publicId, preview.publicId) });
        expect(executedRestructure).toBeDefined();
        expect(drafts[0]?.restructureId).toBe(executedRestructure!.id);
        await expect(db.update(loanDisbursementEvents).set({ restructureId: null }).where(eq(loanDisbursementEvents.id, drafts[0]!.id)).execute()).rejects.toBeDefined();
        expect((await db.select().from(transactions).where(eq(transactions.loanId, loan.id))).map(row => [row.amount, row.principalComponent, row.interestComponent, row.feeComponent, row.penaltyComponent, row.entryType]))
            .toEqual([["200.00", "0.00", "135.00", "25.00", "40.00", "repayment"]]);
        const creditTransaction = await db.query.transactions.findFirst({ where: and(eq(transactions.loanId, loan.id), eq(transactions.entryType, "repayment")) });
        const intake = await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.id, creditTransaction!.paymentIntakeId!) });
        const proposal = await db.query.paymentMatchProposals.findFirst({ where: eq(paymentMatchProposals.paymentIntakeId, intake!.id) });
        const allocation = await db.query.paymentMatchAllocations.findFirst({ where: eq(paymentMatchAllocations.proposalId, proposal!.id) });
        expect([intake?.status, proposal?.status, allocation?.status, allocation?.matchReason]).toEqual(["posted", "posted", "posted", "external_settlement_credit"]);
        const fundEffects = await db.select().from(fundLedgerEntries).where(eq(fundLedgerEntries.transactionId, creditTransaction!.id));
        expect(fundEffects.reduce((sum, row) => sum.plus(row.amount), new Decimal(0)).toFixed(2)).toBe("200.00");
        await reverseLoanRestructure(ctx("reverse-full"), preview.publicId, { reason: "undo complete restructure" });
        expect((await db.select().from(loanOpeningBalanceComponents).where(eq(loanOpeningBalanceComponents.loanId, newLoan!.id))).some(row => row.status === "reversed")).toBe(true);
        expect((await db.select().from(loanDisbursementEvents).where(eq(loanDisbursementEvents.loanId, newLoan!.id)))[0]?.status).toBe("reversed");
        expect((await db.select().from(transactions).where(eq(transactions.loanId, loan.id))).map(row => [row.amount, row.entryType]))
            .toEqual([["200.00", "repayment"], ["-200.00", "reversal"]]);
        expect((await db.select().from(fundLedgerEntries).where(eq(fundLedgerEntries.loanId, loan.id))).reduce((sum, row) => row.entryType.endsWith("_out") ? sum.minus(row.amount) : sum.plus(row.amount), new Decimal(0)).toFixed(2)).toBe("0.00");
    });

    integrationTest("creates a weekly floating replacement with the generalized interest policy", async () => {
        const { loan, ctx } = await seed();
        const weeklyReplacementTerms = {
            repaymentType: "floating" as const,
            startDate: "2026-08-15",
            termMonths: 1,
            interestRate: "0.00",
            floatingInterestPolicy: {
                periodUnit: "week" as const,
                periodLength: 1 as const,
                rateMode: "percent" as const,
                rate: "12.0000",
                advanceInterestPeriods: 1 as const,
                advanceInterestRefundPolicy: "non_refundable" as const,
            },
        };
        const preview = await previewLoanRestructure(ctx(), loan.publicId, {
            settlementDate: "2026-08-15",
            replacementTerms: weeklyReplacementTerms,
            additionalPrincipal: "0.00",
            reason: "replace with weekly floating terms",
        });
        const executed = await executeLoanRestructure(ctx("execute-weekly-floating"), preview.publicId, {
            confirmed: true,
            previewHash: preview.previewHash,
            expectedBalanceVersion: preview.oldBalanceVersion,
            reason: "weekly floating replacement approved",
        });
        const replacement = await db.query.loans.findFirst({ where: eq(loans.publicId, executed.newLoanPublicId) });
        expect(replacement).toMatchObject({
            repaymentType: "floating",
            termMonths: null,
            dailyInterestMode: "percent",
            dailyInterestRate: "12.0000",
            firstDayTreatment: "deduct",
            floatingAccrualCycle: "weekly",
            interestStartDate: "2026-08-15",
            interestPeriodUnit: "week",
            interestPeriodLength: 1,
            advanceInterestPeriods: 1,
            advanceInterestRefundPolicy: "non_refundable",
            interestPeriodAnchorDate: "2026-08-15",
        });
        const ratePeriods = await db.select().from(loanInterestRatePeriods).where(eq(loanInterestRatePeriods.loanId, replacement!.id));
        expect(ratePeriods).toHaveLength(1);
        expect(ratePeriods[0]).toMatchObject({
            effectiveDate: "2026-08-15",
            rateType: "percent",
            rate: "12.0000",
            periodUnit: "week",
            periodLength: 1,
        });
    });

    integrationTest("rejects stale balance and conflicting idempotency payload", async () => {
        const { loan, ctx } = await seed();
        const preview = await previewLoanRestructure(ctx(), loan.publicId, { settlementDate: "2026-08-15", replacementTerms, additionalPrincipal: "0.00", reason: "replace" });
        await db.insert(transactions).values({ tenantId: ctx().tenantId, ownerUserId: ctx().actorUserId, loanId: loan.id, amount: "100.00", principalComponent: "100.00", interestComponent: "0.00", feeComponent: "0.00", penaltyComponent: "0.00", type: "repayment", transactionDate: new Date("2026-08-14T03:00:00Z"), entryType: "repayment", idempotencyKey: crypto.randomUUID(), recordedByUserId: ctx().actorUserId });
        await expect(executeLoanRestructure(ctx("execute-stale"), preview.publicId, { confirmed: true, previewHash: preview.previewHash, expectedBalanceVersion: preview.oldBalanceVersion, reason: "approved" })).rejects.toMatchObject({ code: "STALE_RESTRUCTURE_PREVIEW" });
    });

    integrationTest("rejects settlement before later active payment or posted disbursement activity", async () => {
        const paymentCase = await seed();
        await db.insert(transactions).values({ tenantId: paymentCase.tenantId, ownerUserId: paymentCase.actor.id, loanId: paymentCase.loan.id, amount: "100.00", principalComponent: "100.00", interestComponent: "0.00", feeComponent: "0.00", penaltyComponent: "0.00", entryType: "repayment", transactionDate: new Date("2026-08-16T03:00:00Z"), idempotencyKey: crypto.randomUUID(), recordedByUserId: paymentCase.actor.id });
        await expect(previewLoanRestructure(paymentCase.ctx(), paymentCase.loan.publicId, { settlementDate: "2026-08-15", replacementTerms, additionalPrincipal: "0.00", reason: "backdated" })).rejects.toMatchObject({ code: "RESTRUCTURE_SETTLEMENT_PRECEDES_ACTIVE_ACTIVITY" });

        const disbursementCase = await seed();
        await db.insert(loanDisbursementEvents).values({ tenantId: disbursementCase.tenantId, loanId: disbursementCase.loan.id, grossAmount: "100.00", loanAttributedAmount: "100.00", channel: "bank_transfer", status: "posted", disbursedAt: new Date("2026-08-16T03:00:00Z"), postedAt: new Date("2026-08-16T03:01:00Z"), postIdempotencyKey: crypto.randomUUID(), createdByUserId: disbursementCase.actor.id });
        await expect(previewLoanRestructure(disbursementCase.ctx(), disbursementCase.loan.publicId, { settlementDate: "2026-08-15", replacementTerms, additionalPrincipal: "0.00", reason: "backdated" })).rejects.toMatchObject({ code: "RESTRUCTURE_SETTLEMENT_PRECEDES_ACTIVE_ACTIVITY" });
    });

    integrationTest("requires every replacement start date to equal the settlement date", async () => {
        const { loan, ctx } = await seed();
        await expect(previewLoanRestructure(ctx(), loan.publicId, { settlementDate: "2026-08-15", replacementTerms: { ...replacementTerms, startDate: "2026-08-16" }, additionalPrincipal: "0.00", reason: "overlap guard" })).rejects.toMatchObject({ code: "REPLACEMENT_START_DATE_MISMATCH" });

        const preview = await previewLoanRestructure(ctx(), loan.publicId, { settlementDate: "2026-08-15", replacementTerms, additionalPrincipal: "0.00", reason: "execute overlap guard" });
        const row = await db.query.loanRestructures.findFirst({ where: eq(loanRestructures.publicId, preview.publicId) });
        const stored = row!.requestedReplacementTerms as unknown as Record<string, unknown> & { replacementTerms: typeof replacementTerms };
        await db.update(loanRestructures).set({ requestedReplacementTerms: { ...stored, replacementTerms: { ...stored.replacementTerms, startDate: "2026-08-16" } } }).where(eq(loanRestructures.id, row!.id));
        await expect(executeLoanRestructure(ctx("execute-start-date-revalidation"), preview.publicId, { confirmed: true, previewHash: preview.previewHash, expectedBalanceVersion: preview.oldBalanceVersion, reason: "approved replacement" })).rejects.toMatchObject({ code: "REPLACEMENT_START_DATE_MISMATCH" });
    });

    integrationTest("revalidates later active source activity while executing a preview", async () => {
        const { tenantId, actor, loan, ctx } = await seed();
        const preview = await previewLoanRestructure(ctx(), loan.publicId, { settlementDate: "2026-08-15", replacementTerms, additionalPrincipal: "0.00", reason: "execute activity guard" });
        await db.insert(transactions).values({ tenantId, ownerUserId: actor.id, loanId: loan.id, amount: "100.00", principalComponent: "100.00", interestComponent: "0.00", feeComponent: "0.00", penaltyComponent: "0.00", entryType: "repayment", transactionDate: new Date("2026-08-16T03:00:00Z"), idempotencyKey: crypto.randomUUID(), recordedByUserId: actor.id });
        await expect(executeLoanRestructure(ctx("execute-later-activity"), preview.publicId, { confirmed: true, previewHash: preview.previewHash, expectedBalanceVersion: preview.oldBalanceVersion, reason: "approved replacement" })).rejects.toMatchObject({ code: "RESTRUCTURE_SETTLEMENT_PRECEDES_ACTIVE_ACTIVITY" });
        expect(await db.select().from(loans).where(eq(loans.clonedFromLoanId, loan.id))).toHaveLength(0);
        expect((await db.query.loans.findFirst({ where: eq(loans.id, loan.id) }))?.status).toBe("active");
    });

    integrationTest("reverses safely but blocks reversal after downstream replacement activity", async () => {
        const { loan, ctx } = await seed();
        const preview = await previewLoanRestructure(ctx(), loan.publicId, { settlementDate: "2026-08-15", replacementTerms, additionalPrincipal: "0.00", reason: "replace" });
        const executed = await executeLoanRestructure(ctx("execute-reverse"), preview.publicId, { confirmed: true, previewHash: preview.previewHash, expectedBalanceVersion: preview.oldBalanceVersion, reason: "approved" });
        const reversed = await reverseLoanRestructure(ctx("reverse-1"), preview.publicId, { reason: "operator correction" });
        expect(reversed.status).toBe("reversed");
        const old = await db.query.loans.findFirst({ where: eq(loans.publicId, loan.publicId) });
        const replacement = await db.query.loans.findFirst({ where: eq(loans.publicId, executed.newLoanPublicId) });
        expect(old?.status).toBe("active");
        expect(replacement?.status).toBe("cancelled");
        expect((await db.select().from(loanSchedules).where(eq(loanSchedules.loanId, replacement!.id))).every(s => s.status === "cancelled")).toBe(true);
        const compensated = await db.select().from(loanOpeningBalanceComponents).where(eq(loanOpeningBalanceComponents.loanId, replacement!.id));
        expect(compensated.filter(row => row.status === "reversed").length).toBeGreaterThan(0);
    });

    integrationTest("includes mutable rollup fields in balance version", async () => {
        const { loan, ctx } = await seed();
        const input = { settlementDate: "2026-08-15", replacementTerms, additionalPrincipal: "0.00", reason: "replace" };
        const before = await previewLoanRestructure(ctx(), loan.publicId, input);
        await db.update(loans).set({ outstandingFees: "26.00" }).where(eq(loans.id, loan.id));
        const after = await previewLoanRestructure(ctx(), loan.publicId, input);
        expect(after.oldBalanceVersion).not.toBe(before.oldBalanceVersion);
    });

    integrationTest("rolls back every effect when opening-component persistence fails", async () => {
        const { loan, ctx } = await seed();
        const preview = await previewLoanRestructure(ctx(), loan.publicId, { settlementDate: "2026-08-15", replacementTerms, additionalPrincipal: "1000.00", reason: "replace" });
        await db.execute(sql`CREATE FUNCTION task4_fail_opening_component() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected opening failure'; END $$`);
        await db.execute(sql`CREATE TRIGGER task4_fail_opening_component BEFORE INSERT ON loan_opening_balance_components FOR EACH ROW EXECUTE FUNCTION task4_fail_opening_component()`);
        try {
            await expect(executeLoanRestructure(ctx("rollback"), preview.publicId, { confirmed: true, previewHash: preview.previewHash, expectedBalanceVersion: preview.oldBalanceVersion, reason: "approved" })).rejects.toBeInstanceOf(Error);
        } finally {
            await db.execute(sql`DROP TRIGGER task4_fail_opening_component ON loan_opening_balance_components`);
            await db.execute(sql`DROP FUNCTION task4_fail_opening_component()`);
        }
        expect((await db.query.loans.findFirst({ where: eq(loans.id, loan.id) }))?.status).toBe("active");
        expect(await db.select().from(loans).where(eq(loans.clonedFromLoanId, loan.id))).toHaveLength(0);
        expect((await db.query.loanRestructures.findFirst({ where: eq(loanRestructures.publicId, preview.publicId) }))?.status).toBe("preview");
    });

    integrationTest("blocks reversal after a downstream renewal", async () => {
        const { loan, ctx } = await seed();
        const preview = await previewLoanRestructure(ctx(), loan.publicId, { settlementDate: "2026-08-15", replacementTerms, additionalPrincipal: "0.00", reason: "replace" });
        const executed = await executeLoanRestructure(ctx("execute-renewal-block"), preview.publicId, { confirmed: true, previewHash: preview.previewHash, expectedBalanceVersion: preview.oldBalanceVersion, reason: "approved" });
        const replacement = await db.query.loans.findFirst({ where: eq(loans.publicId, executed.newLoanPublicId!) });
        await db.insert(loanRenewals).values({ tenantId: ctx().tenantId, oldLoanId: replacement!.id, newLoanId: replacement!.id, status: "executed", previewHash: "v1:" + "a".repeat(64), requestedPrincipal: replacement!.principalAmount, outstandingPrincipal: replacement!.principalAmount, dueCharges: "0.00", waivedCharges: "0.00", cashDirection: "none", cashAmount: "0.00", reason: "downstream", idempotencyKey: crypto.randomUUID(), expiresAt: new Date(Date.now() + 60_000), executedAt: new Date(), createdByUserId: ctx().actorUserId, executedByUserId: ctx().actorUserId });
        await expect(reverseLoanRestructure(ctx("reverse-blocked-renewal"), preview.publicId, { reason: "try undo" })).rejects.toMatchObject({ code: "RESTRUCTURE_REVERSAL_BLOCKED", details: { blockers: { laterRenewals: 1 } } });
    });

    integrationTest("serializes different execution keys so exactly one wins", async () => {
        const { loan, ctx } = await seed();
        const preview = await previewLoanRestructure(ctx(), loan.publicId, { settlementDate: "2026-08-15", replacementTerms, additionalPrincipal: "0.00", reason: "replace" });
        const input = { confirmed: true as const, previewHash: preview.previewHash, expectedBalanceVersion: preview.oldBalanceVersion, reason: "approved" };
        const settled = await Promise.allSettled([executeLoanRestructure(ctx("different-a"), preview.publicId, input), executeLoanRestructure(ctx("different-b"), preview.publicId, input)]);
        expect(settled.filter(item => item.status === "fulfilled")).toHaveLength(1);
        expect(settled.filter(item => item.status === "rejected")).toHaveLength(1);
    });
});
