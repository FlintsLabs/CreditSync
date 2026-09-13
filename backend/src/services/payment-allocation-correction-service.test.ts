import { and, eq } from "drizzle-orm";
import { describe, expect, test } from "bun:test";
import { db } from "../db";
import { borrowers, financialEvidenceRequirements, loanAdjustments, loanRenewals, loanSchedules, loans, paymentAllocationCorrectionEntries, paymentAllocationCorrectionGroups, paymentAllocationCorrectionPreviews, paymentEvidence, paymentIntakes, transactions, users } from "../db/schema";
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

async function seedRenewalOpeningAdjustments(seeded: Awaited<ReturnType<typeof fixture>>) {
    const oldLoan = (await db.insert(loans).values({
        tenantId: seeded.tenantId,
        ownerUserId: seeded.ctx.actorUserId,
        borrowerId: seeded.loan.borrowerId,
        principalAmount: "4000.00",
        interestRate: "0.00",
        repaymentType: "daily",
        termMonths: 1,
        status: "renewed",
    }).returning())[0]!;
    const renewal = (await db.insert(loanRenewals).values({
        tenantId: seeded.tenantId,
        oldLoanId: oldLoan.id,
        newLoanId: seeded.loan.id,
        requestedPrincipal: "4000.00",
        outstandingPrincipal: "1913.08",
        dueCharges: "0.00",
        waivedCharges: "0.00",
        settlementPolicy: "full_contract_interest",
        cashDirection: "payout",
        cashAmount: "1800.00",
        renewalDate: "2026-09-05",
        previewHash: `v1:${"1".repeat(64)}`,
        expiresAt: new Date("2099-09-05T00:00:00.000Z"),
        status: "executed",
    }).returning())[0]!;
    const adjustments = await db.insert(loanAdjustments).values([
        { tenantId: seeded.tenantId, loanId: seeded.loan.id, renewalId: renewal.id, adjustmentType: "principal_transfer", amount: "1913.08", status: "posted", reason: "renewal" },
        { tenantId: seeded.tenantId, loanId: seeded.loan.id, renewalId: renewal.id, adjustmentType: "cash_payout", amount: "1800.00", status: "posted", reason: "renewal" },
    ]).returning();
    return { oldLoan, renewal, adjustments };
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

    integrationTest("allows executed-renewal opening adjustments on the renewal-created loan", async () => {
        const seeded = await fixture();
        const opening = await seedRenewalOpeningAdjustments(seeded);
        const preview = await previewPaymentAllocationCorrection(seeded.ctx, {
            paymentIntakePublicId: seeded.intake.publicId,
            transactionPublicId: seeded.source.publicId,
            targetSchedulePublicId: seeded.schedules[0]!.publicId,
            reason: "Move payment to the received installment",
        });
        expect(preview.status).toBe("ready");
        expect(preview.warnings).toEqual([]);
        expect(await db.select().from(loanAdjustments).where(eq(loanAdjustments.renewalId, opening.renewal.id)))
            .toEqual(expect.arrayContaining(opening.adjustments.map((row) => expect.objectContaining({ publicId: row.publicId, status: "posted" }))));
    });

    integrationTest("blocks an unrelated posted adjustment on the source loan", async () => {
        const seeded = await fixture();
        const blocker = (await db.insert(loanAdjustments).values({ tenantId: seeded.tenantId, loanId: seeded.loan.id, adjustmentType: "manual_fee", amount: "1.00", status: "posted", reason: "downstream" }).returning())[0]!;
        const preview = await previewPaymentAllocationCorrection(seeded.ctx, { paymentIntakePublicId: seeded.intake.publicId, transactionPublicId: seeded.source.publicId, targetSchedulePublicId: seeded.schedules[0]!.publicId, reason: "Move payment" });
        expect(preview).toMatchObject({ status: "blocked", warnings: [{ code: "PAYMENT_ALLOCATION_CORRECTION_DEPENDENCY", blockerPublicIds: [blocker.publicId] }] });
    });

    integrationTest("blocks an unknown adjustment type linked to the creating renewal", async () => {
        const seeded = await fixture();
        const opening = await seedRenewalOpeningAdjustments(seeded);
        const blocker = (await db.update(loanAdjustments).set({ adjustmentType: "future_unknown_type" }).where(eq(loanAdjustments.id, opening.adjustments[0]!.id)).returning())[0]!;
        await db.update(loanAdjustments).set({ status: "reversed" }).where(eq(loanAdjustments.id, opening.adjustments[1]!.id));
        const preview = await previewPaymentAllocationCorrection(seeded.ctx, { paymentIntakePublicId: seeded.intake.publicId, transactionPublicId: seeded.source.publicId, targetSchedulePublicId: seeded.schedules[0]!.publicId, reason: "Move payment" });
        expect(preview).toMatchObject({ status: "blocked", warnings: [{ code: "PAYMENT_ALLOCATION_CORRECTION_DEPENDENCY", blockerPublicIds: [blocker.publicId] }] });
    });

    integrationTest("blocks an allowed adjustment linked to a different renewal", async () => {
        const seeded = await fixture();
        const opening = await seedRenewalOpeningAdjustments(seeded);
        await db.update(loanAdjustments).set({ status: "reversed" }).where(eq(loanAdjustments.renewalId, opening.renewal.id));
        const otherLoan = (await db.insert(loans).values({ tenantId: seeded.tenantId, ownerUserId: seeded.ctx.actorUserId, borrowerId: seeded.loan.borrowerId, principalAmount: "4000.00", interestRate: "0.00", repaymentType: "daily", termMonths: 1, status: "active" }).returning())[0]!;
        const otherRenewal = (await db.insert(loanRenewals).values({ tenantId: seeded.tenantId, oldLoanId: opening.oldLoan.id, newLoanId: otherLoan.id, requestedPrincipal: "4000.00", outstandingPrincipal: "1913.08", dueCharges: "0.00", waivedCharges: "0.00", settlementPolicy: "full_contract_interest", cashDirection: "payout", cashAmount: "1800.00", renewalDate: "2026-09-05", previewHash: `v1:${"2".repeat(64)}`, expiresAt: new Date("2099-09-05T00:00:00.000Z"), status: "executed" }).returning())[0]!;
        const blocker = (await db.insert(loanAdjustments).values({ tenantId: seeded.tenantId, loanId: seeded.loan.id, renewalId: otherRenewal.id, adjustmentType: "principal_transfer", amount: "1.00", status: "posted", reason: "mislinked" }).returning())[0]!;
        const preview = await previewPaymentAllocationCorrection(seeded.ctx, { paymentIntakePublicId: seeded.intake.publicId, transactionPublicId: seeded.source.publicId, targetSchedulePublicId: seeded.schedules[0]!.publicId, reason: "Move payment" });
        expect(preview).toMatchObject({ status: "blocked", warnings: [{ code: "PAYMENT_ALLOCATION_CORRECTION_DEPENDENCY", blockerPublicIds: [blocker.publicId] }] });
    });

    integrationTest("blocks an allowed adjustment linked to a non-executed renewal", async () => {
        const seeded = await fixture();
        const opening = await seedRenewalOpeningAdjustments(seeded);
        await db.update(loanRenewals).set({ status: "preview" }).where(eq(loanRenewals.id, opening.renewal.id));
        const blocker = opening.adjustments[0]!;
        const preview = await previewPaymentAllocationCorrection(seeded.ctx, { paymentIntakePublicId: seeded.intake.publicId, transactionPublicId: seeded.source.publicId, targetSchedulePublicId: seeded.schedules[0]!.publicId, reason: "Move payment" });
        expect(preview).toMatchObject({ status: "blocked", warnings: [{ code: "PAYMENT_ALLOCATION_CORRECTION_DEPENDENCY", blockerPublicIds: [blocker.publicId, opening.adjustments[1]!.publicId] }] });
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

    integrationTest("rejects correction when a consumed intake has one ready and one pending required attachment", async () => {
        const seeded = await fixture();
        await db.insert(financialEvidenceRequirements).values({
            tenantId: seeded.tenantId,
            paymentIntakeId: seeded.intake.id,
            expectedCount: 2,
            source: "test",
            requestId: "correction-evidence-request",
            correlationId: "correction-evidence-correlation",
            createdByUserId: seeded.ctx.actorUserId,
        });
        await db.insert(paymentEvidence).values([
            { tenantId: seeded.tenantId, paymentIntakeId: seeded.intake.id, evidenceType: "slip", status: "ready", evidenceHash: "a".repeat(64), mimeType: "image/png", declaredSize: 128, finalizedAt: new Date(), createdByUserId: seeded.ctx.actorUserId, updatedByUserId: seeded.ctx.actorUserId },
            { tenantId: seeded.tenantId, paymentIntakeId: seeded.intake.id, evidenceType: "slip", status: "pending", evidenceHash: "b".repeat(64), mimeType: "image/png", declaredSize: 128, createdByUserId: seeded.ctx.actorUserId, updatedByUserId: seeded.ctx.actorUserId },
        ]);
        const preview = await previewPaymentAllocationCorrection(seeded.ctx, {
            paymentIntakePublicId: seeded.intake.publicId,
            transactionPublicId: seeded.source.publicId,
            targetSchedulePublicId: seeded.schedules[0]!.publicId,
            reason: "Move payment with complete evidence",
        });
        const beforeTransactions = await db.select().from(transactions).where(eq(transactions.tenantId, seeded.tenantId));
        await expect(executePaymentAllocationCorrection(seeded.ctx, {
            correctionPreviewPublicId: preview.publicId,
            previewHash: preview.previewHash,
            expectedBalanceVersion: preview.expectedBalanceVersion,
            confirmed: true,
            reason: "Move payment with complete evidence",
            idempotencyKey: "allocation-correction-pending-evidence",
        })).rejects.toMatchObject({ code: "EVIDENCE_REQUIRED_NOT_READY" });
        expect(await db.select().from(transactions).where(eq(transactions.tenantId, seeded.tenantId))).toEqual(beforeTransactions);
        expect(await db.select().from(paymentAllocationCorrectionGroups).where(eq(paymentAllocationCorrectionGroups.tenantId, seeded.tenantId))).toHaveLength(0);
    });

    integrationTest("preserves renewal opening adjustments during correction execution", async () => {
        const seeded = await fixture();
        const opening = await seedRenewalOpeningAdjustments(seeded);
        const beforeLoan = await db.query.loans.findFirst({ where: eq(loans.id, seeded.loan.id) });
        const preview = await previewPaymentAllocationCorrection(seeded.ctx, { paymentIntakePublicId: seeded.intake.publicId, transactionPublicId: seeded.source.publicId, targetSchedulePublicId: seeded.schedules[0]!.publicId, reason: "Move payment to the received installment" });
        const result = await executePaymentAllocationCorrection(seeded.ctx, { correctionPreviewPublicId: preview.publicId, previewHash: preview.previewHash, expectedBalanceVersion: preview.expectedBalanceVersion, confirmed: true, reason: "Move payment to the received installment", idempotencyKey: "renewal-opening-correction" });
        expect(result).toMatchObject({ amount: "200.00", components: { principal: "173.92", interest: "26.08", fee: "0.00", penalty: "0.00" }, sourceSchedulePublicId: seeded.schedules[1]!.publicId, targetSchedulePublicId: seeded.schedules[0]!.publicId });
        expect(await db.select().from(loanAdjustments).where(eq(loanAdjustments.renewalId, opening.renewal.id))).toEqual(opening.adjustments);
        const history = await db.select().from(transactions).where(eq(transactions.tenantId, seeded.tenantId)).orderBy(transactions.id);
        expect(history).toHaveLength(3);
        expect(history[1]).toMatchObject({ amount: "-200.00", principalComponent: "-173.92", interestComponent: "-26.08", feeComponent: "0.00", penaltyComponent: "0.00", transactionDate: seeded.source.transactionDate });
        expect(history[2]).toMatchObject({ amount: "200.00", principalComponent: "173.92", interestComponent: "26.08", feeComponent: "0.00", penaltyComponent: "0.00", transactionDate: seeded.source.transactionDate });
        expect(await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.id, seeded.intake.id) })).toMatchObject({ status: "posted" });
        expect(await db.query.loanSchedules.findFirst({ where: eq(loanSchedules.id, seeded.schedules[1]!.id) })).toMatchObject({ paidTotal: "0.00", remainingDue: "200.00" });
        expect(await db.query.loanSchedules.findFirst({ where: eq(loanSchedules.id, seeded.schedules[0]!.id) })).toMatchObject({ paidTotal: "200.00", remainingDue: "0.00" });
        expect(await db.query.loans.findFirst({ where: eq(loans.id, seeded.loan.id) })).toMatchObject({ outstandingPrincipal: beforeLoan!.outstandingPrincipal, outstandingInterest: beforeLoan!.outstandingInterest, outstandingFees: beforeLoan!.outstandingFees });
    });

    integrationTest("rejects execution when an opening adjustment status changes after preview", async () => {
        const seeded = await fixture();
        const opening = await seedRenewalOpeningAdjustments(seeded);
        const preview = await previewPaymentAllocationCorrection(seeded.ctx, { paymentIntakePublicId: seeded.intake.publicId, transactionPublicId: seeded.source.publicId, targetSchedulePublicId: seeded.schedules[0]!.publicId, reason: "Move payment" });
        await db.update(loanAdjustments).set({ status: "reversed" }).where(eq(loanAdjustments.id, opening.adjustments[0]!.id));
        await expect(executePaymentAllocationCorrection(seeded.ctx, { correctionPreviewPublicId: preview.publicId, previewHash: preview.previewHash, expectedBalanceVersion: preview.expectedBalanceVersion, confirmed: true, reason: "Move payment", idempotencyKey: "renewal-opening-status-stale" })).rejects.toMatchObject({ code: "STALE_CORRECTION_PREVIEW" });
        expect(await db.select().from(transactions).where(eq(transactions.tenantId, seeded.tenantId))).toHaveLength(1);
        expect(await db.select().from(paymentAllocationCorrectionGroups).where(eq(paymentAllocationCorrectionGroups.tenantId, seeded.tenantId))).toHaveLength(0);
    });

    integrationTest("rejects execution when opening renewal lineage changes after preview", async () => {
        const seeded = await fixture();
        const opening = await seedRenewalOpeningAdjustments(seeded);
        const preview = await previewPaymentAllocationCorrection(seeded.ctx, { paymentIntakePublicId: seeded.intake.publicId, transactionPublicId: seeded.source.publicId, targetSchedulePublicId: seeded.schedules[0]!.publicId, reason: "Move payment" });
        await db.update(loanRenewals).set({ status: "preview" }).where(eq(loanRenewals.id, opening.renewal.id));
        await expect(executePaymentAllocationCorrection(seeded.ctx, { correctionPreviewPublicId: preview.publicId, previewHash: preview.previewHash, expectedBalanceVersion: preview.expectedBalanceVersion, confirmed: true, reason: "Move payment", idempotencyKey: "renewal-lineage-stale" })).rejects.toMatchObject({ code: "STALE_CORRECTION_PREVIEW" });
        expect(await db.select().from(transactions).where(eq(transactions.tenantId, seeded.tenantId))).toHaveLength(1);
        expect(await db.select().from(paymentAllocationCorrectionGroups).where(eq(paymentAllocationCorrectionGroups.tenantId, seeded.tenantId))).toHaveLength(0);
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
