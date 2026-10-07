import { describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { borrowers, files, loanInterestRatePeriods, loanSchedules, loans, paymentBatchAllocations, paymentBatchItems, paymentBatchPreviews, paymentBatches, paymentBatchStagingItems, paymentEvidence, paymentIntakes, transactions, users } from "../db/schema";
import type { CommandContext } from "./command-context";
import { capturePaymentBatch, createPaymentBatch, finalizePaymentBatchStagingEvidence, preparePaymentBatchStagingEvidence, previewPaymentBatch, reviewPaymentBatchStagingItem, stagePaymentBatchItems } from "./payment-batch-service";
import type { PreviewPaymentBatchInput } from "./payment-batch-service";
import { executePaymentBatch } from "./payment-batch-service";
import { cancelPaymentBatch } from "./payment-batch-service";
import { cancelPaymentIntake, getPaymentCancellationCapability } from "./payment-cancellation-service";
import { createPaymentReplacement, inspectPaymentReplacement } from "./payment-replacement-service";

const integrationTest = process.env.TEST_DATABASE_URL ? test : test.skip;

async function fixture() {
    const tenantId = `batch-exec-${crypto.randomUUID()}`;
    const actor = await db.insert(users).values({ tenantId, email: `${crypto.randomUUID()}@example.test`, role: "owner" }).returning().then((rows) => rows[0]!);
    const borrower = await db.insert(borrowers).values({ tenantId, ownerUserId: actor.id, name: "Batch execution fixture" }).returning().then((rows) => rows[0]!);
    const loan = await db.insert(loans).values({ tenantId, ownerUserId: actor.id, borrowerId: borrower.id, principalAmount: "30.00", interestRate: "0.00", repaymentType: "monthly", outstandingPrincipal: "30.00", outstandingInterest: "0.00", outstandingFees: "0.00", status: "active" }).returning().then((rows) => rows[0]!);
    const schedule = await db.insert(loanSchedules).values({ tenantId, loanId: loan.id, installmentNo: 1, dueDate: "2026-08-20", scheduledPrincipal: "30.00", scheduledInterest: "0.00", scheduledFee: "0.00", scheduledTotal: "30.00", paidTotal: "0.00", paidPenalty: "0.00", remainingDue: "30.00", status: "pending" }).returning().then((rows) => rows[0]!);
    const intake = await db.insert(paymentIntakes).values({ tenantId, ownerUserId: actor.id, amount: "30.00", receivedAt: new Date("2026-08-23T03:00:00.000Z"), status: "draft", createdByUserId: actor.id }).returning().then((rows) => rows[0]!);
    const batch = await db.insert(paymentBatches).values({ tenantId, borrowerId: borrower.id, status: "ready", version: 1, stateHash: "v1:fixture", confirmationHash: "v1:confirmation", createIdempotencyKey: crypto.randomUUID(), createdByUserId: actor.id, updatedByUserId: actor.id }).returning().then((rows) => rows[0]!);
    const item = await db.insert(paymentBatchItems).values({ tenantId, batchId: batch.id, paymentIntakeId: intake.id, itemOrder: 1 }).returning().then((rows) => rows[0]!);
    const ctx: CommandContext = { tenantId, actorUserId: actor.id, actorSource: "web", requestId: crypto.randomUUID(), correlationId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() };
    const preview = await previewPaymentBatch(ctx, batch.publicId, { borrowerPublicId: borrower.publicId, allocations: [{ itemPublicId: item.publicId, loanPublicId: loan.publicId, schedulePublicId: schedule.publicId, amount: "30.00", targetDueDate: "2026-08-20", intent: "on_time" }] });
    return { actor, borrower, loan, schedule, intake, batch, preview, ctx };
}

describe("payment batch service contract", () => {
    test("exports compact multi-item capture", () => {
        expect(typeof capturePaymentBatch).toBe("function");
    });

    test("exports the lifecycle and preview entry points", () => {
        expect(typeof createPaymentBatch).toBe("function");
        expect(typeof previewPaymentBatch).toBe("function");
    });

    test("preview input is closed around one complete allocation revision", () => {
        const input: PreviewPaymentBatchInput = {
            borrowerPublicId: "00000000-0000-4000-8000-000000000001",
            allocations: [{ itemPublicId: "00000000-0000-4000-8000-000000000002", loanPublicId: "00000000-0000-4000-8000-000000000003", schedulePublicId: "00000000-0000-4000-8000-000000000004", amount: "10.00", targetDueDate: "2026-08-23", intent: "on_time" }],
        };
        expect(input.allocations).toHaveLength(1);
        expect(input.allocations![0]!.amount).toBe("10.00");
    });

    integrationTest("rolls back every financial effect when a later batch item fails", async () => {
        const seeded = await fixture();
        await expect(executePaymentBatch(seeded.ctx, seeded.batch.publicId, { previewPublicId: seeded.preview.publicId, previewHash: seeded.preview.previewHash, confirmationHash: seeded.preview.confirmationHash, confirmed: true, idempotencyKey: crypto.randomUUID() }, { afterStage: (stage) => { if (stage === "item") throw new Error("injected after item"); } })).rejects.toThrow("injected after item");
        expect(await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.id, seeded.intake.id) })).toMatchObject({ status: "draft" });
        expect(await db.select().from(transactions).where(and(eq(transactions.tenantId, seeded.ctx.tenantId), eq(transactions.paymentIntakeId, seeded.intake.id)))).toHaveLength(0);
        expect(await db.query.loanSchedules.findFirst({ where: eq(loanSchedules.id, seeded.schedule.id) })).toMatchObject({ remainingDue: "30.00", paidTotal: "0.00" });
    });

    integrationTest("returns one economic result for concurrent retries with the same execution key", async () => {
        const seeded = await fixture();
        const input = { previewPublicId: seeded.preview.publicId, previewHash: seeded.preview.previewHash, confirmationHash: seeded.preview.confirmationHash, confirmed: true as const, idempotencyKey: "same-batch-execution" };
        const [first, second] = await Promise.all([executePaymentBatch(seeded.ctx, seeded.batch.publicId, input), executePaymentBatch({ ...seeded.ctx, requestId: crypto.randomUUID(), correlationId: crypto.randomUUID() }, seeded.batch.publicId, input)]);
        expect(first.status).toBe("posted");
        expect(second.status).toBe("posted");
        expect(await db.select().from(transactions).where(and(eq(transactions.tenantId, seeded.ctx.tenantId), eq(transactions.paymentIntakeId, seeded.intake.id), eq(transactions.entryType, "repayment")))).toHaveLength(1);
    });

    integrationTest("stages evidence before amount/time and creates the intake only after review", async () => {
        const tenantId = `batch-staging-${crypto.randomUUID()}`;
        const actor = await db.insert(users).values({ tenantId, email: `${crypto.randomUUID()}@example.test`, role: "owner" }).returning().then((rows) => rows[0]!);
        const ctx: CommandContext = { tenantId, actorUserId: actor.id, actorSource: "web", requestId: crypto.randomUUID(), correlationId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() };
        const staged = await stagePaymentBatchItems(ctx, { idempotencyKey: "stage-upload-first", items: [{ clientItemKey: "slip-1", payerName: "Synthetic payer" }] });
        const staging = await db.query.paymentBatchStagingItems.findFirst({ where: eq(paymentBatchStagingItems.publicId, staged.items[0]!.publicId) });
        expect(staging).toMatchObject({ amount: null, receivedAt: null, status: "staged", paymentIntakeId: null, batchItemId: null });
        expect(await db.select().from(paymentIntakes).where(eq(paymentIntakes.tenantId, tenantId))).toHaveLength(0);
        const gateway = {
            preparePut: async () => ({ uploadUrl: "https://upload.invalid/staging", expiresAt: new Date(Date.now() + 60_000), requiredHeaders: {} }),
            head: async () => ({ exists: true, contentType: "image/png", contentLength: 32, checksumSha256: "a".repeat(64), metadata: { tenant: tenantId, staging: staging!.publicId } }),
        };
        const prepared = await preparePaymentBatchStagingEvidence(ctx, { stagingItemPublicId: staging!.publicId, mimeType: "image/png", size: 32, sha256: "a".repeat(64) }, gateway);
        await finalizePaymentBatchStagingEvidence(ctx, staging!.publicId, prepared.evidencePublicId, gateway);
        const reviewed = await reviewPaymentBatchStagingItem(ctx, { stagingItemPublicId: staging!.publicId, amount: "120.00", receivedAt: "2026-09-08T04:00:00.000Z", intakeIdempotencyKey: "reviewed-intake-1" });
        expect(reviewed.status).toBe("validated");
        expect(await db.select().from(paymentIntakes).where(eq(paymentIntakes.tenantId, tenantId))).toHaveLength(1);
        expect(await db.query.paymentBatchStagingItems.findFirst({ where: eq(paymentBatchStagingItems.publicId, staging!.publicId) })).toMatchObject({ amount: "120.00", status: "validated" });
    });

    integrationTest("uses the shared floating accrual planner for chronological multi-slip preview", async () => {
        const tenantId = `batch-floating-${crypto.randomUUID()}`;
        const actor = await db.insert(users).values({ tenantId, email: `${crypto.randomUUID()}@example.test`, role: "owner" }).returning().then((rows) => rows[0]!);
        const borrower = await db.insert(borrowers).values({ tenantId, ownerUserId: actor.id, name: "Floating batch fixture" }).returning().then((rows) => rows[0]!);
        const loan = await db.insert(loans).values({ tenantId, ownerUserId: actor.id, borrowerId: borrower.id, principalAmount: "5000.00", interestRate: "0.00", repaymentType: "floating", dailyInterestMode: "per_thousand", dailyInterestRate: "15.0000", firstDayTreatment: "start_next_day", interestStartDate: "2026-09-06", interestPeriodUnit: "day", interestPeriodLength: 1, advanceInterestPeriods: 0, advanceInterestRefundPolicy: "non_refundable", interestPeriodAnchorDate: "2026-09-06", floatingAccrualCycle: "daily", outstandingPrincipal: "5000.00", outstandingInterest: "0.00", outstandingFees: "0.00", status: "active" }).returning().then((rows) => rows[0]!);
        await db.insert(loanInterestRatePeriods).values({ tenantId, loanId: loan.id, effectiveDate: "2026-09-06", expiryDate: null, rateType: "per_thousand", rate: "15.0000", periodUnit: "day", periodLength: 1, createdByUserId: actor.id });
        const intake07 = await db.insert(paymentIntakes).values({ tenantId, ownerUserId: actor.id, amount: "75.00", receivedAt: new Date("2026-09-07T04:00:00.000Z"), status: "draft", idempotencyKey: "floating-intake-07", createdByUserId: actor.id }).returning().then((rows) => rows[0]!);
        const intake08 = await db.insert(paymentIntakes).values({ tenantId, ownerUserId: actor.id, amount: "75.00", receivedAt: new Date("2026-09-08T04:00:00.000Z"), status: "draft", idempotencyKey: "floating-intake-08", createdByUserId: actor.id }).returning().then((rows) => rows[0]!);
        const batch = await db.insert(paymentBatches).values({ tenantId, borrowerId: borrower.id, status: "draft", version: 2, stateHash: "v1:floating", createIdempotencyKey: "floating-batch", createdByUserId: actor.id, updatedByUserId: actor.id }).returning().then((rows) => rows[0]!);
        const item07 = await db.insert(paymentBatchItems).values({ tenantId, batchId: batch.id, paymentIntakeId: intake07.id, itemOrder: 1 }).returning().then((rows) => rows[0]!);
        const item08 = await db.insert(paymentBatchItems).values({ tenantId, batchId: batch.id, paymentIntakeId: intake08.id, itemOrder: 2 }).returning().then((rows) => rows[0]!);
        const ctx: CommandContext = { tenantId, actorUserId: actor.id, actorSource: "web", requestId: crypto.randomUUID(), correlationId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() };
        const preview = await previewPaymentBatch(ctx, batch.publicId, { borrowerPublicId: borrower.publicId, allocations: [
            { itemPublicId: item07.publicId, loanPublicId: loan.publicId, amount: "75.00", targetDueDate: "2026-09-07", intent: "on_time" },
            { itemPublicId: item08.publicId, loanPublicId: loan.publicId, amount: "75.00", targetDueDate: "2026-09-08", intent: "on_time" },
        ] });
        expect(preview.status).toBe("ready");
        expect(await db.select().from(paymentBatchAllocations).where(eq(paymentBatchAllocations.previewId, (await db.query.paymentBatchPreviews.findFirst({ where: eq(paymentBatchPreviews.publicId, preview.publicId) }))!.id))).toMatchObject([
            { calculatedComponents: { principal: "0.00", interest: "75.00", fee: "0.00", penalty: "0.00" } },
            { calculatedComponents: { principal: "0.00", interest: "75.00", fee: "0.00", penalty: "0.00" } },
        ]);
        expect(await db.select().from(transactions).where(eq(transactions.tenantId, tenantId))).toHaveLength(0);
    });

    integrationTest("replaces a cancelled batch receipt and allocates 200.00 across two 100.00 schedules exactly once", async () => {
        const tenantId = `cancelled-replacement-batch-${crypto.randomUUID()}`;
        const actor = await db.insert(users).values({ tenantId, email: `${crypto.randomUUID()}@example.test`, role: "owner" }).returning().then((rows) => rows[0]!);
        const borrower = await db.insert(borrowers).values({ tenantId, ownerUserId: actor.id, name: "Cancelled replacement borrower" }).returning().then((rows) => rows[0]!);
        const loan = await db.insert(loans).values({ tenantId, ownerUserId: actor.id, borrowerId: borrower.id, principalAmount: "200.00", interestRate: "0.00", repaymentType: "monthly", outstandingPrincipal: "200.00", outstandingInterest: "0.00", outstandingFees: "0.00", status: "active" }).returning().then((rows) => rows[0]!);
        const schedules = await db.insert(loanSchedules).values([
            { tenantId, loanId: loan.id, installmentNo: 1, dueDate: "2026-09-20", scheduledPrincipal: "100.00", scheduledInterest: "0.00", scheduledFee: "0.00", scheduledTotal: "100.00", paidTotal: "0.00", paidPenalty: "0.00", remainingDue: "100.00", status: "pending" },
            { tenantId, loanId: loan.id, installmentNo: 2, dueDate: "2026-09-21", scheduledPrincipal: "100.00", scheduledInterest: "0.00", scheduledFee: "0.00", scheduledTotal: "100.00", paidTotal: "0.00", paidPenalty: "0.00", remainingDue: "100.00", status: "pending" },
        ]).returning();
        const intake = await db.insert(paymentIntakes).values({ tenantId, ownerUserId: actor.id, amount: "200.00", receivedAt: new Date("2026-09-21T05:00:00.000Z"), status: "draft", createdByUserId: actor.id, updatedByUserId: actor.id }).returning().then((rows) => rows[0]!);
        const file = await db.insert(files).values({ tenantId, ownerUserId: actor.id, bucket: "test", key: `replacement-batch-${crypto.randomUUID()}`, originalName: "receipt.png", mimeType: "image/png", size: 20, url: "storage:test" }).returning().then((rows) => rows[0]!);
        await db.insert(paymentEvidence).values({ tenantId, paymentIntakeId: intake.id, fileId: file.id, status: "ready", evidenceType: "slip", evidenceHash: "d".repeat(64), mimeType: "image/png", declaredSize: 20, finalizedAt: new Date(), createdByUserId: actor.id, updatedByUserId: actor.id });
        const batch = await db.insert(paymentBatches).values({ tenantId, borrowerId: borrower.id, status: "draft", version: 1, stateHash: "v1:cancelled-source", createIdempotencyKey: "cancelled-source-batch", createdByUserId: actor.id, updatedByUserId: actor.id }).returning().then((rows) => rows[0]!);
        await db.insert(paymentBatchItems).values({ tenantId, batchId: batch.id, paymentIntakeId: intake.id, itemOrder: 1 });
        const ctx: CommandContext = { tenantId, actorUserId: actor.id, actorSource: "web", requestId: crypto.randomUUID(), correlationId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() };
        await cancelPaymentBatch(ctx, batch.publicId, { reason: "cancelled source batch", revision: batch.version, idempotencyKey: "cancel-source-batch" });
        const inspection = await inspectPaymentReplacement(ctx, intake.publicId);
        const replacement = await createPaymentReplacement(ctx, { paymentIntakePublicId: intake.publicId, reason: "correct schedule mapping", idempotencyKey: "replacement-batch-child", expectedStateHash: inspection.stateHash });
        const child = await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.publicId, replacement.replacementPaymentIntakePublicId) });
        const targetBatch = await db.insert(paymentBatches).values({ tenantId, borrowerId: borrower.id, status: "draft", version: 0, stateHash: "v1:new-batch", createIdempotencyKey: "replacement-target-batch", createdByUserId: actor.id, updatedByUserId: actor.id }).returning().then((rows) => rows[0]!);
        const item = await db.insert(paymentBatchItems).values({ tenantId, batchId: targetBatch.id, paymentIntakeId: child!.id, itemOrder: 1 }).returning().then((rows) => rows[0]!);
        const preview = await previewPaymentBatch(ctx, targetBatch.publicId, { borrowerPublicId: borrower.publicId, allocations: schedules.map((schedule) => ({ itemPublicId: item.publicId, loanPublicId: loan.publicId, schedulePublicId: schedule.publicId, amount: "100.00", targetDueDate: schedule.dueDate, intent: "on_time" })) });
        expect(preview.status).toBe("ready");
        const posted = await executePaymentBatch(ctx, targetBatch.publicId, { previewPublicId: preview.publicId, previewHash: preview.previewHash, confirmationHash: preview.confirmationHash, confirmed: true, idempotencyKey: "post-replacement-batch" });
        expect(posted.status).toBe("posted");
        const retry = await executePaymentBatch({ ...ctx, requestId: crypto.randomUUID(), correlationId: crypto.randomUUID() }, targetBatch.publicId, { previewPublicId: preview.publicId, previewHash: preview.previewHash, confirmationHash: preview.confirmationHash, confirmed: true, idempotencyKey: "post-replacement-batch" });
        expect(retry).toEqual(posted);
        expect(await db.select().from(transactions).where(and(eq(transactions.tenantId, tenantId), eq(transactions.paymentIntakeId, child!.id), eq(transactions.entryType, "repayment")))).toHaveLength(2);
        expect(await db.query.loanSchedules.findFirst({ where: eq(loanSchedules.id, schedules[0]!.id) })).toMatchObject({ paidTotal: "100.00", remainingDue: "0.00", status: "paid" });
        expect(await db.query.loanSchedules.findFirst({ where: eq(loanSchedules.id, schedules[1]!.id) })).toMatchObject({ paidTotal: "100.00", remainingDue: "0.00", status: "paid" });
    });
});
