import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { borrowers, floatingPenaltyLedgerEntries, loanInterestRatePeriods, loans, paymentBatchAllocations, paymentBatchPreviews, paymentIntakes, transactions, users } from "../db/schema";
import { createAuditLog } from "../lib/audit-log";
import { addPaymentBatchItem, createPaymentBatch, executePaymentBatch, previewPaymentBatch } from "./payment-batch-service";
import type { CommandContext } from "./command-context";

const integration = process.env.TEST_DATABASE_URL ? test : test.skip;
async function setup(principalPayment = false, weeklyAdvance = false, materializedPenalty = false) {
    const tenantId = `batch-floating-projection-${crypto.randomUUID()}`;
    const [actor] = await db.insert(users).values({ tenantId, email: `${crypto.randomUUID()}@example.test`, role: "owner" }).returning();
    const [borrower] = await db.insert(borrowers).values({ tenantId, ownerUserId: actor!.id, name: "Synthetic grouped borrower" }).returning();
    const ctx: CommandContext = { tenantId, actorUserId: actor!.id, actorSource: "web", requestId: crypto.randomUUID(), correlationId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() };
    const targetLoans: Array<typeof loans.$inferSelect> = [];
    const weekly = weeklyAdvance || materializedPenalty;
    const anchor = materializedPenalty ? "2026-08-30" : weeklyAdvance ? "2026-08-31" : "2026-09-06";
    for (const principal of weekly ? ["1000.00"] : principalPayment ? ["5000.00"] : ["5000.00", "3000.00"]) {
        const [loan] = await db.insert(loans).values({ tenantId, ownerUserId: actor!.id, borrowerId: borrower!.id, principalAmount: principal, interestRate: "0.00", repaymentType: "floating", dailyInterestMode: weekly ? "percent" : "per_thousand", dailyInterestRate: weekly ? "7.0000" : "15.0000", firstDayTreatment: weeklyAdvance ? "deduct" : "start_next_day", interestStartDate: anchor, interestPeriodUnit: weekly ? "week" : "day", interestPeriodLength: 1, advanceInterestPeriods: weeklyAdvance ? 1 : 0, advanceInterestRefundPolicy: "non_refundable", interestPeriodAnchorDate: anchor, floatingAccrualCycle: "daily", outstandingPrincipal: principal, outstandingInterest: "0.00", outstandingFees: "0.00", lateFeeMode: materializedPenalty ? "daily_percent" : "none", lateFeeAmount: materializedPenalty ? "1.00" : "0.00", gracePeriodDays: 0, status: "active" }).returning();
        await db.insert(loanInterestRatePeriods).values({ tenantId, loanId: loan!.id, effectiveDate: anchor, rateType: weekly ? "percent" : "per_thousand", rate: weekly ? "7.0000" : "15.0000", periodUnit: weekly ? "week" : "day", periodLength: 1, createdByUserId: actor!.id });
        if (materializedPenalty) {
            const audit = await createAuditLog(db, { tenantId, actorUserId: actor!.id, actorSource: "web", requestId: ctx.requestId, correlationId: ctx.correlationId, entityType: "loan", entityId: loan!.publicId, action: "synthetic_penalty_fixture", payload: {} });
            for (const day of [7, 8]) await db.insert(floatingPenaltyLedgerEntries).values({ tenantId, loanId: loan!.id, dueDate: "2026-09-06", penaltyDate: `2026-09-0${day}`, entryType: "daily_percent_accrual", amount: "0.70", openingInterestBasis: "70.00", lateFeeMode: "daily_percent", lateFeeValue: "1.00", gracePeriodDays: 0, idempotencyKey: `penalty-${day}`, auditPublicId: audit.publicId, actorSource: "web", requestId: ctx.requestId, correlationId: ctx.correlationId, createdByUserId: actor!.id });
        }
        targetLoans.push(loan!);
    }
    const batch = await createPaymentBatch(ctx, { idempotencyKey: "batch", borrowerPublicId: borrower!.publicId });
    const allocations: NonNullable<Parameters<typeof previewPaymentBatch>[2]["allocations"]> = [];
    for (const day of [8, 7]) {
        const date = `2026-09-0${day}`;
        const amount = materializedPenalty ? day === 7 ? "70.70" : "1.00" : weeklyAdvance ? "170.00" : principalPayment ? day === 7 ? "1075.00" : "75.00" : "120.00";
        const [intake] = await db.insert(paymentIntakes).values({ tenantId, ownerUserId: actor!.id, amount, receivedAt: new Date(`${date}T04:00:00Z`), status: "draft", idempotencyKey: `day-${day}`, createdByUserId: actor!.id }).returning();
        const added = await addPaymentBatchItem(ctx, batch.publicId, { paymentIntakePublicId: intake!.publicId, itemOrder: day === 8 ? 1 : 2 });
        const item = added.items.find((i) => i.paymentIntakePublicId === intake!.publicId)!;
        targetLoans.forEach((loan, index) => allocations.push({ itemPublicId: item.publicId, loanPublicId: loan.publicId, amount: principalPayment || weekly ? amount : index === 0 ? "75.00" : "45.00", targetDueDate: date, intent: weeklyAdvance ? "advance" : "on_time" }));
    }
    const preview = await previewPaymentBatch(ctx, batch.publicId, { borrowerPublicId: borrower!.publicId, allocations });
    const stored = await db.query.paymentBatchPreviews.findFirst({ where: eq(paymentBatchPreviews.publicId, preview.publicId) });
    const rows = await db.select().from(paymentBatchAllocations).where(eq(paymentBatchAllocations.previewId, stored!.id)).orderBy(paymentBatchAllocations.allocationOrder);
    return { ctx, batch, preview, rows };
}

integration("two floating contracts preview and post 75 plus 45 on each date in chronological order", async () => {
    const f = await setup();
    expect(f.preview.status).toBe("ready");
    expect(f.rows.map((r) => r.calculatedComponents)).toEqual(["75.00", "45.00", "75.00", "45.00"].map((interest) => ({ principal: "0.00", interest, fee: "0.00", penalty: "0.00" })));
    expect(await db.select().from(transactions).where(eq(transactions.tenantId, f.ctx.tenantId))).toHaveLength(0);
    const result = await executePaymentBatch(f.ctx, f.batch.publicId, { previewPublicId: f.preview.publicId, previewHash: f.preview.previewHash, confirmationHash: f.preview.confirmationHash, confirmed: true, idempotencyKey: "execute" });
    expect(result.posted).toHaveLength(2);
    const posted = await db.select().from(transactions).where(eq(transactions.tenantId, f.ctx.tenantId)).orderBy(transactions.id);
    expect(posted.map((r) => r.interestComponent)).toEqual(["75.00", "45.00", "75.00", "45.00"]);
});

integration("the later floating preview uses principal after the earlier payment", async () => {
    const f = await setup(true);
    expect(f.rows.map((r) => r.calculatedComponents)).toEqual([
        { principal: "1000.00", interest: "75.00", fee: "0.00", penalty: "0.00" },
        { principal: "15.00", interest: "60.00", fee: "0.00", penalty: "0.00" },
    ]);
    const result = await executePaymentBatch(f.ctx, f.batch.publicId, { previewPublicId: f.preview.publicId, previewHash: f.preview.previewHash, confirmationHash: f.preview.confirmationHash, confirmed: true, idempotencyKey: "execute" });
    expect(result.posted).toHaveLength(2);
    const posted = await db.select().from(transactions).where(eq(transactions.tenantId, f.ctx.tenantId)).orderBy(transactions.id);
    expect(posted.map((r) => ({ principal: r.principalComponent, interest: r.interestComponent }))).toEqual([{ principal: "1000.00", interest: "75.00" }, { principal: "15.00", interest: "60.00" }]);
});

integration("advance interest plus principal is blocked during preview when it would orphan paid future accruals", async () => {
    await expect(setup(false, true)).rejects.toThrow("paid");
});

integration("preview projects later penalty compensation caused by an earlier interest payment", async () => {
    const f = await setup(false, false, true);
    expect(f.rows.map((row) => row.calculatedComponents)).toEqual([
        { principal: "0.00", interest: "70.00", fee: "0.00", penalty: "0.70" },
        { principal: "1.00", interest: "0.00", fee: "0.00", penalty: "0.00" },
    ]);
    const result = await executePaymentBatch(f.ctx, f.batch.publicId, { previewPublicId: f.preview.publicId, previewHash: f.preview.previewHash, confirmationHash: f.preview.confirmationHash, confirmed: true, idempotencyKey: "execute" });
    expect(result.posted).toHaveLength(2);
});

integration("an older floating slip arriving after a later posted allocation requires reconciliation at preview", async () => {
    const f = await setup();
    await executePaymentBatch(f.ctx, f.batch.publicId, { previewPublicId: f.preview.publicId, previewHash: f.preview.previewHash, confirmationHash: f.preview.confirmationHash, confirmed: true, idempotencyKey: "execute" });
    const loan = await db.query.loans.findFirst({ where: eq(loans.id, f.rows[0]!.loanId) });
    const borrower = await db.query.borrowers.findFirst({ where: eq(borrowers.id, loan!.borrowerId) });
    const batch = await createPaymentBatch(f.ctx, { borrowerPublicId: borrower!.publicId, idempotencyKey: "late-arrival" });
    const [intake] = await db.insert(paymentIntakes).values({ tenantId: f.ctx.tenantId, ownerUserId: f.ctx.actorUserId!, amount: "75.00", receivedAt: new Date("2026-09-07T02:00:00Z"), status: "draft", createdByUserId: f.ctx.actorUserId }).returning();
    const added = await addPaymentBatchItem(f.ctx, batch.publicId, { paymentIntakePublicId: intake!.publicId, itemOrder: 1 });
    await expect(previewPaymentBatch(f.ctx, batch.publicId, { borrowerPublicId: borrower!.publicId, allocations: [{ itemPublicId: added.items[0]!.publicId, loanPublicId: loan!.publicId, amount: "75.00", targetDueDate: "2026-09-07", intent: "backdated" }] })).rejects.toThrow("reconciliation");
});
