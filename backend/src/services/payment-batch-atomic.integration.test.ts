import { expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { db } from "../db";
import { borrowers, fundLedgerEntries, loanSchedules, loans, paymentBatchAllocations, paymentBatchPreviews, paymentBatches, paymentIntakes, transactions, users } from "../db/schema";
import type { CommandContext } from "./command-context";
import { addPaymentBatchItem, createPaymentBatch, decidePaymentBatch, executePaymentBatch, previewPaymentBatch } from "./payment-batch-service";
import { postPayment, previewPaymentMatch, reversePayment } from "./payment-service";

const integration = process.env.TEST_DATABASE_URL ? test : test.skip;
async function fixture(withCharges = false) {
    const tenantId = `batch-atomic-${crypto.randomUUID()}`;
    const [actor] = await db.insert(users).values({ tenantId, role: "owner", email: `${crypto.randomUUID()}@example.test` }).returning();
    const [borrower] = await db.insert(borrowers).values({ tenantId, ownerUserId: actor!.id, name: "Synthetic chronology borrower" }).returning();
    const [loan] = await db.insert(loans).values({ tenantId, ownerUserId: actor!.id, borrowerId: borrower!.id, principalAmount: "90.00", interestRate: "0.00", repaymentType: "monthly", outstandingPrincipal: "90.00", outstandingInterest: "0.00", outstandingFees: "0.00", status: "active" }).returning();
    const ctx: CommandContext = { tenantId, actorUserId: actor!.id, actorSource: "web", requestId: crypto.randomUUID(), correlationId: crypto.randomUUID() };
    const batch = await createPaymentBatch(ctx, { idempotencyKey: "batch", borrowerPublicId: borrower!.publicId });
    const intakes: Array<typeof paymentIntakes.$inferSelect> = [];
    const allocations: NonNullable<Parameters<typeof previewPaymentBatch>[2]["allocations"]> = [];
    for (const [index, day] of [23, 21, 22].entries()) {
        const date = `2026-08-${day}`;
        const [schedule] = await db.insert(loanSchedules).values({ tenantId, loanId: loan!.id, installmentNo: day - 20, dueDate: date, scheduledPrincipal: withCharges ? "20.00" : "30.00", scheduledInterest: withCharges ? "7.00" : "0.00", scheduledFee: withCharges ? "3.00" : "0.00", scheduledTotal: "30.00", paidTotal: "0.00", paidPenalty: "0.00", remainingDue: "30.00", status: "pending" }).returning();
        const [intake] = await db.insert(paymentIntakes).values({ tenantId, ownerUserId: actor!.id, amount: "30.00", receivedAt: new Date(`${date}T03:00:00Z`), status: "draft", idempotencyKey: `intake-${day}`, createdByUserId: actor!.id }).returning();
        intakes.push(intake!);
        const added = await addPaymentBatchItem(ctx, batch.publicId, { paymentIntakePublicId: intake!.publicId, itemOrder: index + 1 });
        const item = added.items.find((i) => i.paymentIntakePublicId === intake!.publicId)!;
        allocations.push({ itemPublicId: item.publicId, borrowerPublicId: borrower!.publicId, loanPublicId: loan!.publicId, schedulePublicId: schedule!.publicId, amount: "30.00", targetDueDate: date, intent: "on_time" });
    }
    const preview = await previewPaymentBatch(ctx, batch.publicId, { borrowerPublicId: borrower!.publicId, allocations });
    const command = { previewPublicId: preview.publicId, previewHash: preview.previewHash, confirmationHash: preview.confirmationHash, confirmed: true as const, idempotencyKey: "execute" };
    return { ctx, batch, borrower: borrower!, intakes, allocations, command };
}

integration("shuffled capture posts in actual timestamp order and returns exact receipt on retry", async () => {
    const f = await fixture();
    const first = await executePaymentBatch(f.ctx, f.batch.publicId, f.command);
    expect("posted" in first ? first.posted.map((p) => p.intakePublicId) : []).toEqual([f.intakes[1]!.publicId, f.intakes[2]!.publicId, f.intakes[0]!.publicId]);
    expect(await executePaymentBatch({ ...f.ctx, correlationId: crypto.randomUUID() }, f.batch.publicId, f.command)).toEqual(first);
    await expect(executePaymentBatch(f.ctx, f.batch.publicId, { ...f.command, previewHash: "different" })).rejects.toThrow();
});

integration("second of three items failing rolls back every item and never starts the third", async () => {
    const f = await fixture();
    let attempted = 0;
    await expect(executePaymentBatch(f.ctx, f.batch.publicId, f.command, { afterStage(stage) { if (stage === "item" && ++attempted === 2) throw new Error("second-item-failure"); } })).rejects.toThrow("second-item-failure");
    expect(attempted).toBe(2);
    expect(await db.select().from(transactions).where(eq(transactions.tenantId, f.ctx.tenantId))).toHaveLength(0);
    expect(await db.select().from(fundLedgerEntries).where(eq(fundLedgerEntries.tenantId, f.ctx.tenantId))).toHaveLength(0);
    expect((await db.select().from(paymentIntakes).where(eq(paymentIntakes.tenantId, f.ctx.tenantId))).map((i) => i.status)).toEqual(["draft", "draft", "draft"]);
    expect((await db.select().from(loanSchedules).where(eq(loanSchedules.tenantId, f.ctx.tenantId))).every((s) => s.paidTotal === "0.00" && s.remainingDue === "30.00")).toBe(true);
    expect(await db.query.paymentBatches.findFirst({ where: eq(paymentBatches.publicId, f.batch.publicId) })).toMatchObject({ status: "ready" });
});

integration("changing a reviewed transfer timestamp rejects stale confirmation before financial writes", async () => {
    const f = await fixture();
    await db.update(paymentIntakes).set({ receivedAt: new Date("2026-08-23T04:00:00Z") }).where(eq(paymentIntakes.id, f.intakes[0]!.id));
    await expect(executePaymentBatch(f.ctx, f.batch.publicId, f.command)).rejects.toThrow();
    expect(await db.select().from(transactions).where(eq(transactions.tenantId, f.ctx.tenantId))).toHaveLength(0);
});

integration("an explicit empty or incomplete allocation cannot produce a ready preview", async () => {
    const f = await fixture();
    for (const allocations of [[], f.allocations.slice(0, 2)]) {
        await expect(previewPaymentBatch(f.ctx, f.batch.publicId, { borrowerPublicId: f.borrower.publicId, allocations })).rejects.toThrow();
    }
});

integration("concurrent previews serialize revisions and supersede earlier confirmation", async () => {
    const f = await fixture();
    const previews = await Promise.all([1, 2].map(() => previewPaymentBatch(f.ctx, f.batch.publicId, { borrowerPublicId: f.borrower.publicId, allocations: f.allocations })));
    expect(new Set(previews.map((p) => p.version)).size).toBe(2);
    await expect(executePaymentBatch(f.ctx, f.batch.publicId, f.command)).rejects.toThrow();
    expect(await db.select().from(transactions).where(eq(transactions.tenantId, f.ctx.tenantId))).toHaveLength(0);
});

integration("single posting cannot bypass the gate of an unposted batch", async () => {
    const f = await fixture();
    const allocation = f.allocations[0]!;
    const proposal = await previewPaymentMatch(f.ctx, f.intakes[0]!.publicId, { allocations: [{ borrowerPublicId: f.borrower.publicId, loanPublicId: allocation.loanPublicId, schedulePublicId: allocation.schedulePublicId!, amount: "30.00" }] });
    await expect(postPayment(f.ctx, f.intakes[0]!.publicId, { proposalPublicId: proposal.publicId })).rejects.toThrow("batch");
    expect(await db.select().from(transactions).where(eq(transactions.tenantId, f.ctx.tenantId))).toHaveLength(0);
});

integration("an older standalone resolved proposal blocks a later batch even without originLoanId", async () => {
    const f = await fixture();
    const [older] = await db.insert(paymentIntakes).values({ tenantId: f.ctx.tenantId, ownerUserId: f.ctx.actorUserId!, amount: "30.00", receivedAt: new Date("2026-08-20T03:00:00Z"), status: "draft", createdByUserId: f.ctx.actorUserId }).returning();
    const allocation = f.allocations[1]!;
    await previewPaymentMatch(f.ctx, older!.publicId, { allocations: [{ borrowerPublicId: f.borrower.publicId, loanPublicId: allocation.loanPublicId, schedulePublicId: allocation.schedulePublicId!, amount: "30.00" }] });
    await expect(executePaymentBatch(f.ctx, f.batch.publicId, f.command)).rejects.toThrow("chronology");
    expect(await db.select().from(transactions).where(eq(transactions.tenantId, f.ctx.tenantId))).toHaveLength(0);
});

integration("preview exposes actual scheduled accounting components instead of labelling everything principal", async () => {
    const f = await fixture(true);
    const preview = await previewPaymentBatch(f.ctx, f.batch.publicId, { borrowerPublicId: f.borrower.publicId, allocations: f.allocations });
    const stored = await db.query.paymentBatchPreviews.findFirst({ where: eq(paymentBatchPreviews.publicId, preview.publicId) });
    const rows = await db.select().from(paymentBatchAllocations).where(eq(paymentBatchAllocations.previewId, stored!.id));
    expect(rows.map((r) => r.calculatedComponents)).toEqual([1, 2, 3].map(() => ({ principal: "20.00", interest: "7.00", fee: "3.00", penalty: "0.00" })));
});

integration("changing stored allocation components cannot bypass confirmed preview semantics", async () => {
    const f = await fixture();
    const stored = await db.query.paymentBatchPreviews.findFirst({ where: eq(paymentBatchPreviews.publicId, f.command.previewPublicId) });
    await db.update(paymentBatchAllocations).set({ calculatedComponents: { principal: "0.00", interest: "30.00", fee: "0.00", penalty: "0.00" } }).where(eq(paymentBatchAllocations.previewId, stored!.id));
    await expect(executePaymentBatch(f.ctx, f.batch.publicId, f.command)).rejects.toThrow();
    expect(await db.select().from(transactions).where(eq(transactions.tenantId, f.ctx.tenantId))).toHaveLength(0);
});

integration("missing-day confirmation creates a new preview and cannot survive a later revision", async () => {
    const f = await fixture();
    await db.update(paymentIntakes).set({ receivedAt: new Date("2026-08-23T04:00:00Z") }).where(eq(paymentIntakes.id, f.intakes[2]!.id));
    const preview = await previewPaymentBatch(f.ctx, f.batch.publicId, { borrowerPublicId: f.borrower.publicId, allocations: f.allocations });
    expect(preview.status).toBe("needs_review");
    const input = { previewPublicId: preview.publicId, previewHash: preview.previewHash, revision: preview.version, action: "confirm_no_older_pending" as const, reason: "Synthetic evidence review confirms no older slip remains", fromDate: "2026-08-21", toDate: "2026-08-23", idempotencyKey: "gap-decision" };
    const decision = await decidePaymentBatch(f.ctx, f.batch.publicId, input);
    expect(await decidePaymentBatch({ ...f.ctx, correlationId: crypto.randomUUID() }, f.batch.publicId, input)).toEqual(decision);
    const confirmed = await previewPaymentBatch(f.ctx, f.batch.publicId, { borrowerPublicId: f.borrower.publicId, allocations: f.allocations, decisionPublicId: (decision as { decisionPublicId: string }).decisionPublicId });
    expect(confirmed.status).toBe("ready");
    await expect(executePaymentBatch(f.ctx, f.batch.publicId, f.command)).rejects.toThrow();
    await expect(previewPaymentBatch(f.ctx, f.batch.publicId, { borrowerPublicId: f.borrower.publicId, allocations: f.allocations, decisionPublicId: (decision as { decisionPublicId: string }).decisionPublicId })).rejects.toThrow();
    expect(await db.select().from(transactions).where(eq(transactions.tenantId, f.ctx.tenantId))).toHaveLength(0);
});

integration("database rejects floating allocation metadata without an explicit provenance array", async () => {
    const f = await fixture();
    await expect(db.execute(sql`UPDATE payment_batch_allocations SET target_kind = 'floating', schedule_id = NULL, floating_plan = '{"throughDate":"2026-08-23"}'::jsonb WHERE tenant_id = ${f.ctx.tenantId}`).execute()).rejects.toThrow();
});

integration("a multi-borrower batch is planned together and rolls back every borrower on failure", async () => {
    const f = await fixture();
    const [borrower] = await db.insert(borrowers).values({ tenantId: f.ctx.tenantId, ownerUserId: f.ctx.actorUserId!, name: "Synthetic second borrower" }).returning();
    const [loan] = await db.insert(loans).values({ tenantId: f.ctx.tenantId, ownerUserId: f.ctx.actorUserId!, borrowerId: borrower!.id, principalAmount: "30.00", interestRate: "0.00", repaymentType: "monthly", outstandingPrincipal: "30.00", outstandingInterest: "0.00", outstandingFees: "0.00", status: "active" }).returning();
    const [schedule] = await db.insert(loanSchedules).values({ tenantId: f.ctx.tenantId, loanId: loan!.id, installmentNo: 1, dueDate: "2026-08-22", scheduledPrincipal: "30.00", scheduledInterest: "0.00", scheduledFee: "0.00", scheduledTotal: "30.00", paidTotal: "0.00", paidPenalty: "0.00", remainingDue: "30.00", status: "pending" }).returning();
    const [intake] = await db.insert(paymentIntakes).values({ tenantId: f.ctx.tenantId, ownerUserId: f.ctx.actorUserId!, amount: "30.00", receivedAt: new Date("2026-08-22T02:00:00Z"), status: "draft", createdByUserId: f.ctx.actorUserId }).returning();
    const added = await addPaymentBatchItem(f.ctx, f.batch.publicId, { paymentIntakePublicId: intake!.publicId, itemOrder: 4 });
    const item = added.items.find((row) => row.paymentIntakePublicId === intake!.publicId)!;
    const preview = await previewPaymentBatch(f.ctx, f.batch.publicId, { borrowerPublicId: f.borrower.publicId, allocations: [...f.allocations, { itemPublicId: item.publicId, borrowerPublicId: borrower!.publicId, loanPublicId: loan!.publicId, schedulePublicId: schedule!.publicId, amount: "30.00", targetDueDate: "2026-08-22", intent: "on_time" }] });
    const [later] = await db.insert(paymentIntakes).values({ tenantId: f.ctx.tenantId, ownerUserId: f.ctx.actorUserId!, amount: "30.00", receivedAt: new Date("2026-08-24T02:00:00Z"), status: "draft", createdByUserId: f.ctx.actorUserId }).returning();
    const laterProposal = await previewPaymentMatch(f.ctx, later!.publicId, { allocations: [{ borrowerPublicId: borrower!.publicId, loanPublicId: loan!.publicId, schedulePublicId: schedule!.publicId, amount: "30.00" }] });
    await expect(postPayment(f.ctx, later!.publicId, { proposalPublicId: laterProposal.publicId })).rejects.toMatchObject({ code: "PAYMENT_CHRONOLOGY_CONFLICT" });
    const beforeStatuses = await db.select({ id: paymentIntakes.id, status: paymentIntakes.status }).from(paymentIntakes).where(eq(paymentIntakes.tenantId, f.ctx.tenantId)).orderBy(paymentIntakes.id);
    let attempts = 0;
    await expect(executePaymentBatch(f.ctx, f.batch.publicId, { ...f.command, previewPublicId: preview.publicId, previewHash: preview.previewHash, confirmationHash: preview.confirmationHash }, { afterStage(stage) { if (stage === "item" && ++attempts === 2) throw new Error("second-borrower-failed"); } })).rejects.toThrow("second-borrower-failed");
    expect(attempts).toBe(2);
    expect(await db.select().from(transactions).where(eq(transactions.tenantId, f.ctx.tenantId))).toHaveLength(0);
    expect(await db.select({ id: paymentIntakes.id, status: paymentIntakes.status }).from(paymentIntakes).where(eq(paymentIntakes.tenantId, f.ctx.tenantId)).orderBy(paymentIntakes.id)).toEqual(beforeStatuses);
});

integration("reversal waits on the shared borrower lock before holding an intake lock", async () => {
    const f = await fixture();
    await executePaymentBatch(f.ctx, f.batch.publicId, f.command);
    let reversal: Promise<unknown> | undefined;
    try {
        await db.transaction(async (tx) => {
            await tx.execute(sql`SELECT id FROM borrowers WHERE id = ${f.borrower.id} FOR UPDATE`);
            reversal = reversePayment({ ...f.ctx, idempotencyKey: "reverse-last" }, f.intakes[0]!.publicId, { reason: "Synthetic lock-order regression" });
            const state = await Promise.race([reversal.then(() => "finished", () => "failed"), new Promise<string>((resolve) => setTimeout(() => resolve("waiting"), 100))]);
            expect(state).toBe("waiting");
            // A borrower-first writer must not hold this later lock while waiting.
            await tx.execute(sql`SELECT id FROM payment_intakes WHERE id = ${f.intakes[0]!.id} FOR UPDATE NOWAIT`);
        });
    } finally {
        await reversal;
    }
});
