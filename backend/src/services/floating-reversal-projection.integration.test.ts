import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { borrowers, floatingPenaltyLedgerEntries, floatingTransactionAllocations, loanInterestAccruals, loanInterestRatePeriods, loans, paymentIntakes, transactions, users } from "../db/schema";
import { createAuditLog } from "../lib/audit-log";
import type { CommandContext } from "./command-context";
import { emptyFloatingBatchState } from "./payment-batch-accounting-planner";
import { addPaymentBatchItem, createPaymentBatch, executePaymentBatch, previewPaymentBatch } from "./payment-batch-service";
import { floatingPaymentObligations } from "./floating-interest-service";

const integration = process.env.TEST_DATABASE_URL ? test : test.skip;

// Synthetic repair history: a September 4 receipt was reversed on September 10
// and replaced using its original business date. September 5 is already paid.
async function fixture(replaced = true) {
    return db.transaction(async (tx) => {
        const tenantId = `reversal-projection-${crypto.randomUUID()}`;
        const [actor] = await tx.insert(users).values({ tenantId, email: `${tenantId}@example.test`, role: "owner" }).returning();
        const [borrower] = await tx.insert(borrowers).values({ tenantId, ownerUserId: actor!.id, name: "Synthetic reversal borrower" }).returning();
        const ctx: CommandContext = { tenantId, actorUserId: actor!.id, actorSource: "web", requestId: crypto.randomUUID(), correlationId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() };
        const audit = await createAuditLog(tx, { ...ctx, entityType: "borrower", entityId: borrower!.publicId, action: "synthetic_reversal_fixture", payload: {} });
        const targets: Array<{ loan: typeof loans.$inferSelect; interest: string; accrual: typeof loanInterestAccruals.$inferSelect }> = [];
        for (const [principal, interest] of [["2000.00", "30.00"], ["3000.00", "45.00"], ["1000.00", "15.00"], ["3000.00", "45.00"], ["2000.00", "30.00"]] as const) {
            const [loan] = await tx.insert(loans).values({ tenantId, ownerUserId: actor!.id, borrowerId: borrower!.id, principalAmount: principal, outstandingPrincipal: principal, outstandingInterest: "0.00", outstandingFees: "0.00", interestRate: "0.00", repaymentType: "floating", status: "active", dailyInterestMode: "per_thousand", dailyInterestRate: "15.0000", firstDayTreatment: "start_next_day", interestStartDate: "2026-09-03", interestPeriodAnchorDate: "2026-09-03", interestPeriodUnit: "day", interestPeriodLength: 1, advanceInterestPeriods: 0, advanceInterestRefundPolicy: "non_refundable", floatingAccrualCycle: "daily", lateFeeMode: "none", lateFeeAmount: "0.00" }).returning();
            const [period] = await tx.insert(loanInterestRatePeriods).values({ tenantId, loanId: loan!.id, effectiveDate: "2026-09-03", rateType: "per_thousand", rate: "15.0000", periodUnit: "day", periodLength: 1, createdByUserId: actor!.id }).returning();
            const accruals = await tx.insert(loanInterestAccruals).values([4, 5].map(day => ({ tenantId, loanId: loan!.id, interestRatePeriodId: period!.id, accrualDate: `2026-09-0${day}`, openingPrincipal: principal, rateMode: "per_thousand", rate: "15.0000", interestAmount: interest, paidAmount: day === 4 && !replaced ? "0.00" : interest, status: day === 4 && !replaced ? "accrued" : "paid", periodStartDate: `2026-09-0${day}`, periodEndDate: `2026-09-0${day + 1}`, periodDayIndex: 1, periodDays: 1, periodUnit: "day", periodLength: 1, cumulativeInterestAmount: interest, contractualInterestAmount: interest, dailyIncrementAmount: interest }))).returning();
            const accrual = accruals.find(a => a.accrualDate === "2026-09-04")!;
            const insertPayment = async (day: string, amount: string, targetAccrualId: number, reversed?: { transactionId: number; allocationId: number }) => {
                const [transaction] = await tx.insert(transactions).values({ tenantId, ownerUserId: actor!.id, loanId: loan!.id, amount, interestComponent: amount, principalComponent: "0.00", entryType: reversed ? "reversal" : "repayment", reversedTransactionId: reversed?.transactionId, transactionDate: new Date(`${day}T10:00:00+07:00`), postedAt: new Date("2026-09-10T12:00:00+07:00") }).returning();
                const [allocation] = await tx.insert(floatingTransactionAllocations).values({ tenantId, loanId: loan!.id, transactionId: transaction!.id, component: "interest", interestAccrualId: targetAccrualId, dueDate: accruals.find(a => a.id === targetAccrualId)!.accrualDate, effectiveDate: day, amount, allocationOrder: 1, entryType: reversed ? "reversal" : "payment", reversedAllocationId: reversed?.allocationId, reason: reversed ? "Replace erroneous receipt" : null, idempotencyKey: crypto.randomUUID(), auditPublicId: audit.publicId, actorSource: ctx.actorSource, requestId: ctx.requestId, correlationId: ctx.correlationId, createdByUserId: actor!.id }).returning();
                return { transactionId: transaction!.id, allocationId: allocation!.id };
            };
            const original = await insertPayment("2026-09-04", interest, accrual.id);
            await insertPayment("2026-09-10", `-${interest}`, accrual.id, original);
            if (replaced) await insertPayment("2026-09-04", interest, accrual.id);
            await insertPayment("2026-09-05", interest, accruals.find(a => a.accrualDate === "2026-09-05")!.id);
            targets.push({ loan: loan!, interest, accrual });
        }
        return { ctx, borrower: borrower!, targets, audit };
    });
}

// Break caught: the date cutoff includes a voided source but excludes its later
// reversal, double-counting paid interest before a grouped batch can be posted.
integration("reversed and replaced receipts allow grouped September 6 and 7 preview, materialization and idempotent posting", async () => {
    const f = await fixture();
    const batch = await createPaymentBatch(f.ctx, { borrowerPublicId: f.borrower.publicId, idempotencyKey: "new-days" });
    const allocations: NonNullable<Parameters<typeof previewPaymentBatch>[2]["allocations"]> = [];
    for (const day of [7, 6]) {
        const date = `2026-09-0${day}`;
        const [intake] = await db.insert(paymentIntakes).values({ tenantId: f.ctx.tenantId, ownerUserId: f.ctx.actorUserId, amount: "165.00", receivedAt: new Date(`${date}T17:00:00+07:00`), status: "draft", idempotencyKey: `day-${day}` }).returning();
        const added = await addPaymentBatchItem(f.ctx, batch.publicId, { paymentIntakePublicId: intake!.publicId, itemOrder: day === 7 ? 1 : 2 });
        const item = added.items.find(i => i.paymentIntakePublicId === intake!.publicId)!;
        for (const target of f.targets) allocations.push({ itemPublicId: item.publicId, loanPublicId: target.loan.publicId, amount: target.interest, targetDueDate: date, intent: "backdated" });
    }
    const oldAllocations = await db.select().from(floatingTransactionAllocations).where(eq(floatingTransactionAllocations.tenantId, f.ctx.tenantId));
    const before = await db.select().from(loanInterestAccruals).where(eq(loanInterestAccruals.tenantId, f.ctx.tenantId));
    const preview = await previewPaymentBatch(f.ctx, batch.publicId, { borrowerPublicId: f.borrower.publicId, allocations });
    expect(preview.status).toBe("ready");
    expect(preview.warnings).toEqual([]);
    expect(await db.select().from(loanInterestAccruals).where(eq(loanInterestAccruals.tenantId, f.ctx.tenantId))).toEqual(before);
    const input = { previewPublicId: preview.publicId, previewHash: preview.previewHash, confirmationHash: preview.confirmationHash, confirmed: true as const, idempotencyKey: "post-new-days" };
    const posted = await executePaymentBatch(f.ctx, batch.publicId, input);
    expect(posted.posted).toHaveLength(2);
    const txBeforeRetry = await db.select().from(transactions).where(eq(transactions.tenantId, f.ctx.tenantId));
    await executePaymentBatch(f.ctx, batch.publicId, input);
    expect(await db.select().from(transactions).where(eq(transactions.tenantId, f.ctx.tenantId))).toEqual(txBeforeRetry);
    const allAllocations = await db.select().from(floatingTransactionAllocations).where(eq(floatingTransactionAllocations.tenantId, f.ctx.tenantId));
    expect(allAllocations.filter(a => oldAllocations.some(old => old.id === a.id))).toEqual(oldAllocations);
    const accruals = await db.select().from(loanInterestAccruals).where(eq(loanInterestAccruals.tenantId, f.ctx.tenantId));
    for (const target of f.targets) {
        const newRows = accruals.filter(a => a.loanId === target.loan.id && a.accrualDate >= "2026-09-06");
        expect(newRows.map(a => ({ date: a.accrualDate, interest: a.interestAmount, paid: a.paidAmount, status: a.status }))).toEqual([
            { date: "2026-09-06", interest: target.interest, paid: target.interest, status: "paid" },
            { date: "2026-09-07", interest: target.interest, paid: target.interest, status: "paid" },
        ]);
        expect((await db.query.loans.findFirst({ where: eq(loans.id, target.loan.id) }))!.outstandingPrincipal).toBe(target.loan.outstandingPrincipal);
    }
});

// Break caught: reads silently cap the phantom payment instead of reporting the
// restored unpaid obligation when no replacement exists.
integration("an unreplaced reversal restores historical interest and penalty before the reversal processing date", async () => {
    const f = await fixture(false);
    const target = f.targets[0]!;
    await db.insert(floatingPenaltyLedgerEntries).values({ tenantId: f.ctx.tenantId, loanId: target.loan.id, dueDate: "2026-09-04", penaltyDate: "2026-09-05", entryType: "fixed_assessment", amount: "5.00", openingInterestBasis: "30.00", lateFeeMode: "fixed", lateFeeValue: "5.00", gracePeriodDays: 0, idempotencyKey: "penalty-fixture", auditPublicId: f.audit.publicId, actorSource: "web", requestId: f.ctx.requestId, correlationId: f.ctx.correlationId });
    const [source] = await db.insert(transactions).values({ tenantId: f.ctx.tenantId, loanId: target.loan.id, amount: "5.00", penaltyComponent: "5.00", transactionDate: new Date("2026-09-05T10:00:00+07:00") }).returning();
    const [reversal] = await db.insert(transactions).values({ tenantId: f.ctx.tenantId, loanId: target.loan.id, amount: "-5.00", penaltyComponent: "-5.00", entryType: "reversal", reversedTransactionId: source!.id, transactionDate: new Date("2026-09-10T10:00:00+07:00") }).returning();
    const shared = { tenantId: f.ctx.tenantId, loanId: target.loan.id, component: "penalty", dueDate: "2026-09-04", allocationOrder: 1, auditPublicId: f.audit.publicId, actorSource: "web", requestId: f.ctx.requestId, correlationId: f.ctx.correlationId };
    const [allocation] = await db.insert(floatingTransactionAllocations).values({ ...shared, transactionId: source!.id, entryType: "payment", effectiveDate: "2026-09-05", amount: "5.00", idempotencyKey: "penalty-payment" }).returning();
    await db.insert(floatingTransactionAllocations).values({ ...shared, transactionId: reversal!.id, entryType: "reversal", reversedAllocationId: allocation!.id, effectiveDate: "2026-09-10", amount: "-5.00", idempotencyKey: "penalty-reversal", reason: "Void original penalty payment" });
    for (const projection of [undefined, emptyFloatingBatchState()]) {
        const due = await floatingPaymentObligations(db, target.loan, new Date("2026-09-06T17:00:00+07:00"), f.ctx, projection);
        expect(due.dueInterest.toFixed(2)).toBe("60.00");
        expect(due.duePenalty.toFixed(2)).toBe("5.00");
    }
});

integration("a genuine additional allocation to paid interest still rejects the projection", async () => {
    const f = await fixture();
    const target = f.targets[0]!;
    const state = emptyFloatingBatchState();
    state.allocations.push({ effectiveDate: "2026-09-06", dueDate: "2026-09-04", accrualDate: "2026-09-04", component: "interest", amount: "30.00" });
    await expect(floatingPaymentObligations(db, target.loan, new Date("2026-09-06T17:00:00+07:00"), f.ctx, state))
        .rejects.toMatchObject({ code: "FLOATING_ACCRUAL_PAID_CONFLICT" });
});
