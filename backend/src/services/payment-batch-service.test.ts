import { describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { borrowers, loanSchedules, loans, paymentBatchAllocations, paymentBatchItems, paymentBatchPreviews, paymentBatches, paymentIntakes, transactions, users } from "../db/schema";
import type { CommandContext } from "./command-context";
import { capturePaymentBatch, createPaymentBatch, previewPaymentBatch } from "./payment-batch-service";
import type { PreviewPaymentBatchInput } from "./payment-batch-service";
import { executePaymentBatch } from "./payment-batch-service";

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
    const preview = await db.insert(paymentBatchPreviews).values({ tenantId, batchId: batch.id, version: 1, status: "ready", stateHash: "v1:fixture", previewHash: "v1:preview", confirmationHash: "v1:confirmation", warnings: [], candidates: [], evidenceReady: true, expiresAt: new Date(Date.now() + 60_000), createdByUserId: actor.id }).returning().then((rows) => rows[0]!);
    await db.insert(paymentBatchAllocations).values({ tenantId, previewId: preview.id, itemId: item.id, allocationOrder: 1, borrowerId: borrower.id, loanId: loan.id, scheduleId: schedule.id, amount: "30.00", targetDueDate: "2026-08-20", intent: "on_time", calculatedComponents: { principal: "30.00", interest: "0.00", fee: "0.00", penalty: "0.00" } });
    const ctx: CommandContext = { tenantId, actorUserId: actor.id, actorSource: "web", requestId: crypto.randomUUID(), correlationId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() };
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
});
