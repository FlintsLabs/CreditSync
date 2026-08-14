import { beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { db } from "../db";
import { auditLogs, borrowers, loanOpeningBalanceComponents, loanRestructures, loanRestructureWaivers, loanWaiverPreviews, loans, transactions, users } from "../db/schema";
import type { CommandContext } from "./command-context";
import { executeLoanWaiver, previewLoanWaiver, reverseLoanWaiver } from "./loan-waiver-service";
import { executeEarlyLoanSettlement, previewEarlyLoanSettlement } from "./payment-service";

const integrationTest = process.env.TEST_DATABASE_URL ? test : test.skip;
async function reset() { await db.execute(sql`TRUNCATE TABLE audit_logs, loan_restructure_waivers, loan_waiver_previews, loan_opening_balance_components, loan_restructures, loans, borrowers, users RESTART IDENTITY CASCADE`); }

async function seed() {
    const tenantId = `tenant-${crypto.randomUUID()}`;
    const user = await db.insert(users).values({ tenantId, email: `${crypto.randomUUID()}@example.test`, role: "owner" }).returning().then(r => r[0]!);
    const borrower = await db.insert(borrowers).values({ tenantId, ownerUserId: user.id, name: "Waiver Borrower" }).returning().then(r => r[0]!);
    const oldLoan = await db.insert(loans).values({ tenantId, ownerUserId: user.id, borrowerId: borrower.id, principalAmount: "5000.00", interestRate: "0.00", repaymentType: "daily", termMonths: 1, startDate: "2026-07-01", outstandingPrincipal: "5000.00", outstandingInterest: "0.00", outstandingFees: "0.00", status: "restructured" }).returning().then(r => r[0]!);
    const newLoan = await db.insert(loans).values({ tenantId, ownerUserId: user.id, borrowerId: borrower.id, principalAmount: "5000.00", interestRate: "5.00", repaymentType: "daily", termMonths: 1, startDate: "2026-08-01", outstandingPrincipal: "5000.00", outstandingInterest: "700.00", outstandingFees: "50.00", status: "active", clonedFromLoanId: oldLoan.id }).returning().then(r => r[0]!);
    const seedAudit = await db.insert(auditLogs).values({ tenantId, entityType: "loan_restructure", entityId: oldLoan.publicId, action: "seed", actorSource: "system", correlationId: "seed" }).returning().then(r => r[0]!);
    const restructure = await db.insert(loanRestructures).values({ tenantId, oldLoanId: oldLoan.id, newLoanId: newLoan.id, settlementDate: "2026-08-01", oldBalanceVersion: "v1:" + "a".repeat(64), status: "executed", previewHash: "v1:" + "b".repeat(64), requestHash: "c".repeat(64), requestedReplacementTerms: {}, grossPrincipal: "5000.00", grossInterest: "500.00", grossFees: "50.00", grossPenalty: "25.00", waivedInterest: "0.00", waivedFees: "0.00", waivedPenalty: "0.00", netPrincipal: "5000.00", netInterest: "500.00", netFees: "50.00", netPenalty: "25.00", externalSettlementCredits: "0.00", additionalPrincipal: "0.00", cashDirection: "none", cashAmount: "0.00", reason: "seed", createdActorSource: "system", executeActorSource: "system", correlationId: "seed", executeIdempotencyKey: crypto.randomUUID(), executeRequestHash: "d".repeat(64), executedAuditPublicId: seedAudit.publicId, preExecutionOldLoanState: { status: "active", outstandingPrincipal: "5000.00", outstandingInterest: "500.00", outstandingFees: "50.00", nextDueDate: null }, expiresAt: new Date("2026-09-01"), executedAt: new Date("2026-08-01") }).returning().then(r => r[0]!);
    await db.insert(loanOpeningBalanceComponents).values([
        { tenantId, restructureId: restructure.id, loanId: newLoan.id, componentKind: "carried_principal", amount: "5000.00", sourceType: "loan", sourcePublicId: oldLoan.publicId, createdByUserId: user.id },
        { tenantId, restructureId: restructure.id, loanId: newLoan.id, componentKind: "carried_interest", amount: "500.00", sourceType: "loan_restructure", sourcePublicId: restructure.publicId, createdByUserId: user.id },
        { tenantId, restructureId: restructure.id, loanId: newLoan.id, componentKind: "carried_fee", amount: "50.00", sourceType: "loan_restructure", sourcePublicId: restructure.publicId, createdByUserId: user.id },
        { tenantId, restructureId: restructure.id, loanId: newLoan.id, componentKind: "carried_penalty", amount: "25.00", sourceType: "loan_restructure", sourcePublicId: restructure.publicId, createdByUserId: user.id },
    ]);
    const ctx = (key?: string): CommandContext => ({ tenantId, actorUserId: user.id, actorSource: "web", requestId: "req-waiver", correlationId: "corr-waiver", idempotencyKey: key });
    return { newLoan, restructure, ctx };
}

describe("later restructure waiver service", () => {
    if (process.env.TEST_DATABASE_URL) beforeEach(reset);
    integrationTest("previews, executes and compensates component-only waiver idempotently", async () => {
        const { newLoan, ctx } = await seed();
        const preview = await previewLoanWaiver(ctx(), newLoan.publicId, { component: "interest", amount: "125.00", reason: "external assistance" });
        expect(preview.availableAmount).toBe("500.00");
        expect(preview.remainingAmount).toBe("375.00");
        const executed = await executeLoanWaiver(ctx("waive-1"), preview.publicId, { confirmed: true, previewHash: preview.previewHash, expectedBalanceVersion: preview.balanceVersion, reason: "external assistance" });
        expect((await executeLoanWaiver(ctx("waive-1"), preview.publicId, { confirmed: true, previewHash: preview.previewHash, expectedBalanceVersion: preview.balanceVersion, reason: "external assistance" })).publicId).toBe(executed.publicId);
        const reversed = await reverseLoanWaiver(ctx("waive-reverse-1"), executed.publicId, { reason: "entered in error" });
        expect(reversed.status).toBe("reversed");
        expect(await db.select().from(loanRestructureWaivers).where(eq(loanRestructureWaivers.loanId, newLoan.id))).toHaveLength(2);
    });

    integrationTest("rejects principal, over-waiver, and missing reason", async () => {
        const { newLoan, ctx } = await seed();
        await expect(previewLoanWaiver(ctx(), newLoan.publicId, { component: "principal" as never, amount: "1.00", reason: "no" })).rejects.toMatchObject({ code: "WAIVER_COMPONENT_NOT_ALLOWED" });
        await expect(previewLoanWaiver(ctx(), newLoan.publicId, { component: "fee", amount: "51.00", reason: "too much" })).rejects.toMatchObject({ code: "WAIVER_EXCEEDS_COMPONENT" });
        await expect(previewLoanWaiver(ctx(), newLoan.publicId, { component: "penalty", amount: "1.00", reason: "" })).rejects.toMatchObject({ code: "WAIVER_REASON_REQUIRED" });
    });

    integrationTest("subtracts posted payments and stales a preview when payment state changes", async () => {
        const { newLoan, ctx } = await seed();
        const preview = await previewLoanWaiver(ctx(), newLoan.publicId, { component: "interest", amount: "400.00", reason: "help" });
        await db.insert(transactions).values({ tenantId: ctx().tenantId, ownerUserId: ctx().actorUserId, loanId: newLoan.id, amount: "200.00", principalComponent: "0.00", interestComponent: "200.00", feeComponent: "0.00", penaltyComponent: "0.00", entryType: "repayment", idempotencyKey: crypto.randomUUID(), recordedByUserId: ctx().actorUserId });
        await expect(executeLoanWaiver(ctx("stale-after-payment"), preview.publicId, { confirmed: true, previewHash: preview.previewHash, expectedBalanceVersion: preview.balanceVersion, reason: "help" })).rejects.toMatchObject({ code: "STALE_WAIVER_PREVIEW" });
        await expect(previewLoanWaiver(ctx(), newLoan.publicId, { component: "interest", amount: "301.00", reason: "too much" })).rejects.toMatchObject({ code: "WAIVER_EXCEEDS_COMPONENT" });
    });

    integrationTest("persists and executes an early-settlement waiver against unearned new interest only", async () => {
        const { newLoan, restructure, ctx } = await seed();
        await db.insert(loanOpeningBalanceComponents).values({ tenantId: ctx().tenantId, restructureId: restructure.id, loanId: newLoan.id, componentKind: "new_contract_interest", amount: "200.00", sourceType: "loan_restructure", sourcePublicId: restructure.publicId, createdByUserId: ctx().actorUserId });
        const preview = await previewEarlyLoanSettlement(ctx(), newLoan.publicId, { settlementDate: "2026-08-10" });
        expect(preview).toMatchObject({ earnedNewInterest: "0.00", unearnedNewInterest: "200.00", proposedWaiver: "200.00", reason: "early_settlement_unearned_interest" });
        const executed = await executeEarlyLoanSettlement(ctx("early-close"), preview.publicId, { confirmed: true, previewHash: preview.previewHash, expectedBalanceVersion: preview.balanceVersion });
        expect(executed).toMatchObject({ status: "executed", component: "new_interest", amount: "200.00", reason: "early_settlement_unearned_interest" });
    });

    integrationTest("rejects expired persisted waiver previews", async () => {
        const { newLoan, ctx } = await seed();
        const preview = await previewLoanWaiver(ctx(), newLoan.publicId, { component: "fee", amount: "1.00", reason: "help" });
        await db.update(loanWaiverPreviews).set({ expiresAt: new Date(Date.now() - 1) }).where(eq(loanWaiverPreviews.publicId, preview.publicId));
        await expect(executeLoanWaiver(ctx("expired-waiver"), preview.publicId, { confirmed: true, previewHash: preview.previewHash, expectedBalanceVersion: preview.balanceVersion, reason: "help" })).rejects.toMatchObject({ code: "STALE_WAIVER_PREVIEW" });
    });

    integrationTest("honors tenant-wide manager access and hides another owner's loan from collectors", async () => {
        const { newLoan, ctx } = await seed();
        const manager = await db.insert(users).values({ tenantId: ctx().tenantId, email: `${crypto.randomUUID()}@example.test`, role: "manager" }).returning().then(rows => rows[0]!);
        const collector = await db.insert(users).values({ tenantId: ctx().tenantId, email: `${crypto.randomUUID()}@example.test`, role: "collector" }).returning().then(rows => rows[0]!);
        const asActor = (id: number): CommandContext => ({ ...ctx(), actorUserId: id });
        await expect(previewLoanWaiver(asActor(manager.id), newLoan.publicId, { component: "fee", amount: "1.00", reason: "manager approval" })).resolves.toMatchObject({ availableAmount: "50.00" });
        await expect(previewLoanWaiver(asActor(collector.id), newLoan.publicId, { component: "fee", amount: "1.00", reason: "not assigned" })).rejects.toMatchObject({ code: "LOAN_NOT_FOUND" });
    });
});
