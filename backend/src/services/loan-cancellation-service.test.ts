import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { db } from "../db";
import { auditLogs, borrowers, loanCancellationPreviews, loanSchedules, loans, users } from "../db/schema";
import type { CommandContext } from "./command-context";
import { evaluateUnfundedCancellationEligibility, executeUnfundedLoanCancellation, previewUnfundedLoanCancellation } from "./loan-cancellation-service";

const integrationTest = process.env.TEST_DATABASE_URL ? test : test.skip;

async function resetCancellationTables() {
    await db.execute(sql`TRUNCATE TABLE audit_logs, loan_cancellation_previews, loan_schedules, loans, borrowers, users RESTART IDENTITY CASCADE`);
}

async function seedUnfundedLoan() {
    const tenantId = `tenant-cancel-${crypto.randomUUID()}`;
    const actor = await db.insert(users).values({ tenantId, email: `${crypto.randomUUID()}@example.test`, role: "owner" }).returning().then((rows) => rows[0]!);
    const borrower = await db.insert(borrowers).values({ tenantId, ownerUserId: actor.id, name: "Unfunded cancellation borrower" }).returning().then((rows) => rows[0]!);
    const loan = await db.insert(loans).values({
        tenantId,
        ownerUserId: actor.id,
        borrowerId: borrower.id,
        principalAmount: "20000.00",
        interestRate: "0.00",
        repaymentType: "monthly",
        startDate: "2026-08-22",
        paymentStartDate: "2026-08-22",
        outstandingPrincipal: "20000.00",
        outstandingInterest: "10000.00",
        outstandingFees: "0.00",
        status: "active",
    }).returning().then((rows) => rows[0]!);
    await db.insert(loanSchedules).values({
        tenantId,
        loanId: loan.id,
        installmentNo: 1,
        dueDate: "2026-08-22",
        scheduledPrincipal: "20000.00",
        scheduledInterest: "10000.00",
        scheduledTotal: "30000.00",
        paidTotal: "0.00",
        remainingDue: "30000.00",
        status: "pending",
    });
    const context = (idempotencyKey: string): CommandContext => ({
        tenantId,
        actorUserId: actor.id,
        actorSource: "web",
        requestId: `request-${idempotencyKey}`,
        correlationId: crypto.randomUUID(),
        idempotencyKey,
    });
    return { loan, context };
}

test("allows an active zero-disbursement loan with reversed-only payments", () => {
    expect(evaluateUnfundedCancellationEligibility({
        status: "active",
        postedPaymentCount: 0,
        postedDisbursementCount: 0,
        netDisbursed: "0.00",
        downstreamBlocked: false,
    })).toEqual({ eligible: true, code: null });
});

test("rejects an unfunded cancellation when actual money was disbursed", () => {
    expect(evaluateUnfundedCancellationEligibility({
        status: "active",
        postedPaymentCount: 0,
        postedDisbursementCount: 1,
        netDisbursed: "0.00",
        downstreamBlocked: false,
    })).toEqual({ eligible: false, code: "LOAN_CANCEL_FUNDED" });
});

test("rejects an unfunded cancellation when a posted payment remains", () => {
    expect(evaluateUnfundedCancellationEligibility({
        status: "active",
        postedPaymentCount: 1,
        postedDisbursementCount: 0,
        netDisbursed: "0.00",
        downstreamBlocked: false,
    })).toEqual({ eligible: false, code: "LOAN_CANCEL_POSTED_PAYMENT" });
});

integrationTest("cancels a contract with contractual balances but no actual funding", async () => {
    await resetCancellationTables();
    const seeded = await seedUnfundedLoan();
    const preview = await previewUnfundedLoanCancellation(seeded.context("preview"), seeded.loan.publicId, "Contract was never funded");
    expect(preview).toMatchObject({ eligibility: "unfunded", status: "ready", before: { outstandingPrincipal: "20000.00", outstandingInterest: "10000.00", netDisbursed: "0.00" } });

    const executed = await executeUnfundedLoanCancellation(seeded.context("execute"), {
        previewPublicId: preview.publicId,
        previewHash: preview.previewHash,
        expectedBalanceVersion: preview.balanceVersion,
        confirmed: true,
        reason: preview.reason,
    });
    expect(executed).toMatchObject({ status: "cancelled", outstandingPrincipal: "0.00", outstandingInterest: "0.00", outstandingFees: "0.00", auditPublicIds: [executed.auditPublicId] });
    expect(await db.query.loanSchedules.findFirst()).toMatchObject({ status: "cancelled", remainingDue: "0.00" });
    expect(await db.query.loanCancellationPreviews.findFirst()).toMatchObject({ status: "executed", executedAuditPublicId: executed.auditPublicId });
    expect(await db.query.auditLogs.findFirst({ where: sql`action = 'cancelled_unfunded'` })).toBeTruthy();

    const replay = await executeUnfundedLoanCancellation(seeded.context("execute"), {
        previewPublicId: preview.publicId,
        previewHash: preview.previewHash,
        expectedBalanceVersion: preview.balanceVersion,
        confirmed: true,
        reason: preview.reason,
    });
    expect(replay.auditPublicId).toBe(executed.auditPublicId);
});
