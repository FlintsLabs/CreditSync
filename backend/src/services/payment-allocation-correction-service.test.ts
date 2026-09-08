import { and, eq } from "drizzle-orm";
import { describe, expect, test } from "bun:test";
import { db } from "../db";
import { borrowers, loanSchedules, loans, paymentAllocationCorrectionEntries, paymentAllocationCorrectionGroups, paymentAllocationCorrectionPreviews, paymentIntakes, transactions, users } from "../db/schema";
import type { CommandContext } from "./command-context";
import { executePaymentAllocationCorrection, previewPaymentAllocationCorrection } from "./payment-allocation-correction-service";

const integrationTest = process.env.TEST_DATABASE_URL ? test : test.skip;

async function fixture(targetScheduledTotal = "200.00") {
    const tenantId = `allocation-correction-${crypto.randomUUID()}`;
    const actor = (await db.insert(users).values({ tenantId, email: `${crypto.randomUUID()}@example.test`, role: "owner" }).returning())[0]!;
    const borrower = (await db.insert(borrowers).values({ tenantId, ownerUserId: actor.id, name: "Allocation Correction Borrower" }).returning())[0]!;
    const loan = (await db.insert(loans).values({ tenantId, ownerUserId: actor.id, borrowerId: borrower.id, principalAmount: "4000.00", interestRate: "0.00", repaymentType: "daily", termMonths: 1, startDate: "2026-09-06", outstandingPrincipal: "173.92", outstandingInterest: "26.08", outstandingFees: "0.00", status: "active" }).returning())[0]!;
    const schedules = await db.insert(loanSchedules).values([
        { tenantId, loanId: loan.id, installmentNo: 1, dueDate: "2026-09-06", scheduledPrincipal: "173.92", scheduledInterest: "26.08", scheduledFee: "0.00", scheduledTotal: "200.00", paidTotal: "0.00", paidPenalty: "0.00", remainingDue: "200.00", status: "pending" },
        { tenantId, loanId: loan.id, installmentNo: 2, dueDate: "2099-09-07", scheduledPrincipal: "173.92", scheduledInterest: "26.08", scheduledFee: "0.00", scheduledTotal: targetScheduledTotal, paidTotal: "200.00", paidPenalty: "0.00", remainingDue: targetScheduledTotal === "200.00" ? "0.00" : "100.00", status: targetScheduledTotal === "200.00" ? "paid" : "pending" },
    ]).returning();
    const intake = (await db.insert(paymentIntakes).values({ tenantId, ownerUserId: actor.id, source: "mcp", status: "posted", amount: "200.00", receivedAt: new Date("2026-09-06T04:00:00.000Z"), bankReference: "fixture-reference", postedAt: new Date("2026-09-06T04:01:00.000Z"), createdByUserId: actor.id, postedByUserId: actor.id }).returning())[0]!;
    const source = (await db.insert(transactions).values({ tenantId, ownerUserId: actor.id, loanId: loan.id, scheduleId: schedules[1]!.id, amount: "200.00", principalComponent: "173.92", interestComponent: "26.08", feeComponent: "0.00", penaltyComponent: "0.00", type: "repayment", transactionDate: new Date("2026-09-06T04:00:00.000Z"), recordedByUserId: actor.id, paymentIntakeId: intake.id, entryType: "repayment", postedAt: new Date("2026-09-06T04:01:00.000Z") }).returning())[0]!;
    const ctx: CommandContext = { tenantId, actorUserId: actor.id, actorSource: "mcp", requestId: crypto.randomUUID(), correlationId: crypto.randomUUID() };
    return { tenantId, loan, schedules, intake, source, ctx };
}

describe("scheduled payment allocation correction", () => {
    test("requires explicit confirmation before any database work", async () => {
        await expect(executePaymentAllocationCorrection({ tenantId: "tenant", actorUserId: null, actorSource: "mcp", requestId: "request", correlationId: "correlation" }, { correctionPreviewPublicId: "11111111-1111-4111-8111-111111111111", previewHash: `v1:${"a".repeat(64)}`, expectedBalanceVersion: `v1:${"b".repeat(64)}`, confirmed: false as never, reason: "test", idempotencyKey: "test" })).rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED" });
    });

    integrationTest("previews the defect with exact component conservation and correct schedule projections", async () => {
        const seeded = await fixture();
        const preview = await previewPaymentAllocationCorrection(seeded.ctx, { paymentIntakePublicId: seeded.intake.publicId, transactionPublicId: seeded.source.publicId, targetSchedulePublicId: seeded.schedules[0]!.publicId, reason: "Move payment to the received installment" });
        expect(preview).toMatchObject({ status: "ready", amount: "200.00", components: { principal: "173.92", interest: "26.08", fee: "0.00", penalty: "0.00" }, netLoanVariance: { amount: "0.00", principal: "0.00", interest: "0.00", fee: "0.00", penalty: "0.00" }, warnings: [] });
        expect(preview.source.after).toMatchObject({ paidTotal: "0.00", remainingDue: "200.00", status: "pending" });
        expect(preview.target.after).toMatchObject({ paidTotal: "200.00", remainingDue: "0.00", status: "paid" });
    });

    integrationTest("executes append-only compensation/replacement and supports idempotent replay", async () => {
        const seeded = await fixture();
        const beforeLoan = await db.query.loans.findFirst({ where: eq(loans.id, seeded.loan.id) });
        const preview = await previewPaymentAllocationCorrection(seeded.ctx, { paymentIntakePublicId: seeded.intake.publicId, transactionPublicId: seeded.source.publicId, targetSchedulePublicId: seeded.schedules[0]!.publicId, reason: "Move payment to the received installment" });
        const input = { correctionPreviewPublicId: preview.publicId, previewHash: preview.previewHash, expectedBalanceVersion: preview.expectedBalanceVersion, confirmed: true as const, reason: "Move payment to the received installment", idempotencyKey: "allocation-correction-execute-1" };
        const result = await executePaymentAllocationCorrection(seeded.ctx, input);
        expect(result).toMatchObject({ amount: "200.00", components: { principal: "173.92", interest: "26.08", fee: "0.00", penalty: "0.00" }, sourceSchedulePublicId: seeded.schedules[1]!.publicId, targetSchedulePublicId: seeded.schedules[0]!.publicId });
        const history = await db.select().from(transactions).where(and(eq(transactions.tenantId, seeded.tenantId), eq(transactions.paymentIntakeId, seeded.intake.id))).orderBy(transactions.id);
        expect(history).toHaveLength(3);
        expect(history[1]).toMatchObject({ type: "reversal", entryType: "reversal", amount: "-200.00", principalComponent: "-173.92", interestComponent: "-26.08", reversedTransactionId: seeded.source.id, scheduleId: seeded.schedules[1]!.id, transactionDate: seeded.source.transactionDate });
        expect(history[2]).toMatchObject({ entryType: "repayment", amount: "200.00", principalComponent: "173.92", interestComponent: "26.08", scheduleId: seeded.schedules[0]!.id, transactionDate: seeded.source.transactionDate });
        expect(await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.id, seeded.intake.id) })).toMatchObject({ status: "posted", amount: "200.00", receivedAt: seeded.intake.receivedAt });
        expect(await db.query.loanSchedules.findFirst({ where: eq(loanSchedules.id, seeded.schedules[0]!.id) })).toMatchObject({ paidTotal: "200.00", remainingDue: "0.00", status: "paid" });
        expect(await db.query.loanSchedules.findFirst({ where: eq(loanSchedules.id, seeded.schedules[1]!.id) })).toMatchObject({ paidTotal: "0.00", remainingDue: "200.00", status: "pending" });
        expect(await db.query.loans.findFirst({ where: eq(loans.id, seeded.loan.id) })).toMatchObject({ outstandingPrincipal: beforeLoan!.outstandingPrincipal, outstandingInterest: beforeLoan!.outstandingInterest, outstandingFees: beforeLoan!.outstandingFees });
        const replay = await executePaymentAllocationCorrection(seeded.ctx, input);
        expect(replay.correctionPublicId).toBe(result.correctionPublicId);
        expect(await db.select().from(paymentAllocationCorrectionGroups).where(eq(paymentAllocationCorrectionGroups.tenantId, seeded.tenantId))).toHaveLength(1);
        expect(await db.select().from(paymentAllocationCorrectionEntries).where(eq(paymentAllocationCorrectionEntries.tenantId, seeded.tenantId))).toHaveLength(2);
    });

    integrationTest("rejects stale guards without writing financial rows", async () => {
        const seeded = await fixture();
        const preview = await previewPaymentAllocationCorrection(seeded.ctx, { paymentIntakePublicId: seeded.intake.publicId, transactionPublicId: seeded.source.publicId, targetSchedulePublicId: seeded.schedules[0]!.publicId, reason: "Move payment to the received installment" });
        await db.update(loanSchedules).set({ paidTotal: "1.00" }).where(eq(loanSchedules.id, seeded.schedules[0]!.id));
        await expect(executePaymentAllocationCorrection(seeded.ctx, { correctionPreviewPublicId: preview.publicId, previewHash: preview.previewHash, expectedBalanceVersion: preview.expectedBalanceVersion, confirmed: true, reason: "Move payment to the received installment", idempotencyKey: "allocation-correction-stale" })).rejects.toMatchObject({ code: "STALE_CORRECTION_PREVIEW" });
        expect(await db.select().from(transactions).where(eq(transactions.tenantId, seeded.tenantId))).toHaveLength(1);
        expect(await db.select().from(paymentAllocationCorrectionGroups).where(eq(paymentAllocationCorrectionGroups.tenantId, seeded.tenantId))).toHaveLength(0);
    });

    integrationTest("blocks later posted repayment transactions on either touched schedule", async () => {
        const seeded = await fixture("300.00");
        const laterIntake = (await db.insert(paymentIntakes).values({ tenantId: seeded.tenantId, ownerUserId: seeded.ctx.actorUserId!, status: "posted", amount: "1.00", receivedAt: new Date(), postedAt: new Date(), createdByUserId: seeded.ctx.actorUserId!, postedByUserId: seeded.ctx.actorUserId! }).returning())[0]!;
        const later = (await db.insert(transactions).values({ tenantId: seeded.tenantId, ownerUserId: seeded.ctx.actorUserId, loanId: seeded.loan.id, scheduleId: seeded.schedules[1]!.id, amount: "1.00", principalComponent: "1.00", interestComponent: "0.00", feeComponent: "0.00", penaltyComponent: "0.00", paymentIntakeId: laterIntake.id, type: "repayment", entryType: "repayment", transactionDate: new Date(), postedAt: new Date(), recordedByUserId: seeded.ctx.actorUserId }).returning())[0]!;
        const preview = await previewPaymentAllocationCorrection(seeded.ctx, { paymentIntakePublicId: seeded.intake.publicId, transactionPublicId: seeded.source.publicId, targetSchedulePublicId: seeded.schedules[0]!.publicId, reason: "Move payment with downstream check" });
        expect(preview.status).toBe("blocked");
        expect(preview.warnings).toEqual([{ code: "PAYMENT_ALLOCATION_CORRECTION_DEPENDENCY", blockerPublicIds: [later.publicId] }]);
        expect(await db.select().from(paymentAllocationCorrectionPreviews).where(eq(paymentAllocationCorrectionPreviews.publicId, preview.publicId))).toHaveLength(1);
    });

    integrationTest("replays one result for concurrent identical idempotent requests", async () => {
        const seeded = await fixture();
        const preview = await previewPaymentAllocationCorrection(seeded.ctx, { paymentIntakePublicId: seeded.intake.publicId, transactionPublicId: seeded.source.publicId, targetSchedulePublicId: seeded.schedules[0]!.publicId, reason: "Concurrent correction" });
        const input = { correctionPreviewPublicId: preview.publicId, previewHash: preview.previewHash, expectedBalanceVersion: preview.expectedBalanceVersion, confirmed: true as const, reason: "Concurrent correction", idempotencyKey: "concurrent-correction" };
        const results = await Promise.all([executePaymentAllocationCorrection(seeded.ctx, input), executePaymentAllocationCorrection(seeded.ctx, input)]);
        expect(new Set(results.map((result) => result.correctionPublicId)).size).toBe(1);
        expect(await db.select().from(paymentAllocationCorrectionGroups).where(eq(paymentAllocationCorrectionGroups.tenantId, seeded.tenantId))).toHaveLength(1);
        expect(await db.select().from(paymentAllocationCorrectionEntries).where(eq(paymentAllocationCorrectionEntries.tenantId, seeded.tenantId))).toHaveLength(2);
    });

    integrationTest("rejects an idempotency key reused for a different preview request", async () => {
        const seeded = await fixture();
        const first = await previewPaymentAllocationCorrection(seeded.ctx, { paymentIntakePublicId: seeded.intake.publicId, transactionPublicId: seeded.source.publicId, targetSchedulePublicId: seeded.schedules[0]!.publicId, reason: "First correction" });
        const second = await previewPaymentAllocationCorrection(seeded.ctx, { paymentIntakePublicId: seeded.intake.publicId, transactionPublicId: seeded.source.publicId, targetSchedulePublicId: seeded.schedules[0]!.publicId, reason: "Second correction" });
        const firstInput = { correctionPreviewPublicId: first.publicId, previewHash: first.previewHash, expectedBalanceVersion: first.expectedBalanceVersion, confirmed: true as const, reason: "First correction", idempotencyKey: "conflicting-correction" };
        await executePaymentAllocationCorrection(seeded.ctx, firstInput);
        await expect(executePaymentAllocationCorrection(seeded.ctx, { ...firstInput, correctionPreviewPublicId: second.publicId, previewHash: second.previewHash, expectedBalanceVersion: second.expectedBalanceVersion, reason: "Second correction" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
        expect(await db.select().from(paymentAllocationCorrectionGroups).where(eq(paymentAllocationCorrectionGroups.tenantId, seeded.tenantId))).toHaveLength(1);
    });
});
