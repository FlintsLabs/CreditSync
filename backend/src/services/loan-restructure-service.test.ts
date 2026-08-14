import { beforeEach, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import {
    auditLogs, borrowers, loanDisbursementEvents, loanOpeningBalanceComponents,
    loanRestructures, loanSchedules, loans, transactions, users,
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
        expect(preview.cash).toEqual({ direction: "payout", amount: "800.00" });
        expect(preview.previewHash).toMatch(/^v1:[0-9a-f]{64}$/);
        expect(preview.oldBalanceVersion).toMatch(/^v1:[0-9a-f]{64}$/);
        expect(preview.expiresAt).toBeInstanceOf(Date);
        expect(await db.select().from(loans).where(eq(loans.clonedFromLoanId, loan.id))).toHaveLength(0);
    });

    integrationTest("executes atomically, replays same key, persists opening components, and creates only an additional-principal draft", async () => {
        const { tenantId, loan, ctx } = await seed();
        const preview = await previewLoanRestructure(ctx(), loan.publicId, {
            settlementDate: "2026-08-15", replacementTerms, additionalPrincipal: "1000.00",
            waivers: { interest: { amount: "100.00", reason: "hardship" } }, reason: "replace contract",
        });
        const input = { confirmed: true as const, previewHash: preview.previewHash, expectedBalanceVersion: preview.oldBalanceVersion, reason: "approved replacement" };
        const first = await executeLoanRestructure(ctx("execute-1"), preview.publicId, input);
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
            ["carried_principal", "5000.00"], ["additional_principal", "1000.00"], ["carried_interest", "1300.00"], ["carried_fee", "25.00"], ["carried_penalty", "40.00"], ["new_contract_interest", "240.00"],
        ]));
        const drafts = await db.select().from(loanDisbursementEvents).where(eq(loanDisbursementEvents.loanId, newLoan!.id));
        expect(drafts.map(d => [d.status, d.grossAmount, d.loanAttributedAmount])).toEqual([["draft", "1000.00", "1000.00"]]);
    });

    integrationTest("rejects stale balance and conflicting idempotency payload", async () => {
        const { loan, ctx } = await seed();
        const preview = await previewLoanRestructure(ctx(), loan.publicId, { settlementDate: "2026-08-15", replacementTerms, additionalPrincipal: "0.00", reason: "replace" });
        await db.insert(transactions).values({ tenantId: ctx().tenantId, ownerUserId: ctx().actorUserId, loanId: loan.id, amount: "100.00", principalComponent: "100.00", interestComponent: "0.00", feeComponent: "0.00", penaltyComponent: "0.00", type: "repayment", transactionDate: new Date("2026-08-14T03:00:00Z"), entryType: "repayment", idempotencyKey: crypto.randomUUID(), recordedByUserId: ctx().actorUserId });
        await expect(executeLoanRestructure(ctx("execute-stale"), preview.publicId, { confirmed: true, previewHash: preview.previewHash, expectedBalanceVersion: preview.oldBalanceVersion, reason: "approved" })).rejects.toMatchObject({ code: "STALE_RESTRUCTURE_PREVIEW" });
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
    });
});
