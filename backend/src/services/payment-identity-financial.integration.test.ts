import { and, eq, sql } from "drizzle-orm";
import { describe, expect, test } from "bun:test";
import { db } from "../db";
import { auditLogs, borrowers, loanSchedules, loans, paymentIntakes, paymentMatchAllocations, paymentIdentityDecisions, transactions, users } from "../db/schema";
import type { CommandContext } from "./command-context";
import { createPaymentIntake, postPayment, previewPaymentMatch } from "./payment-service";
import { executePaymentIdentityDecision, identityDecisionAuthorizesPair, inspectPaymentIdentity, previewPaymentIdentityDecision } from "./payment-identity-decision-service";

const integration = process.env.TEST_DATABASE_URL ? test : test.skip;

type Fixture = { actor: { id: number; tenantId: string }; borrower: typeof borrowers.$inferSelect; schedules: Array<typeof loanSchedules.$inferSelect> };
function context(actor: Fixture["actor"], key = crypto.randomUUID()): CommandContext {
    return { tenantId: actor.tenantId, actorUserId: actor.id, actorSource: "web", requestId: crypto.randomUUID(), correlationId: crypto.randomUUID(), idempotencyKey: key };
}
async function reset() { await db.execute(sql`TRUNCATE TABLE users CASCADE`); }
async function fixture(count = 3): Promise<Fixture> {
    const tenantId = `identity-${crypto.randomUUID()}`;
    const actor = await db.insert(users).values({ tenantId, email: `${crypto.randomUUID()}@example.invalid`, role: "owner" }).returning().then(([row]) => ({ id: row!.id, tenantId }));
    const borrower = await db.insert(borrowers).values({ tenantId, ownerUserId: actor.id, name: "Identity payer" }).returning().then(([row]) => row!);
    const schedules: Array<typeof loanSchedules.$inferSelect> = [];
    for (let index = 0; index < count; index += 1) {
        const loan = await db.insert(loans).values({ tenantId, ownerUserId: actor.id, borrowerId: borrower.id, principalAmount: "100.00", interestRate: "0.00", repaymentType: "monthly", outstandingPrincipal: "100.00", outstandingInterest: "0.00", outstandingFees: "0.00", status: "active" }).returning().then(([row]) => row!);
        schedules.push(await db.insert(loanSchedules).values({ tenantId, loanId: loan.id, installmentNo: 1, dueDate: "2026-09-24", scheduledPrincipal: "10.00", scheduledInterest: "0.00", scheduledFee: "0.00", scheduledTotal: "10.00", paidTotal: "0.00", paidPenalty: "0.00", remainingDue: "10.00", status: "pending" }).returning().then(([row]) => row!));
    }
    return { actor, borrower, schedules };
}
async function createReady(f: Fixture, scheduleIndex: number, receivedAt: string) {
    const schedule = f.schedules[scheduleIndex]!;
    const loan = await db.query.loans.findFirst({ where: eq(loans.id, schedule.loanId) });
    const intake = await createPaymentIntake(context(f.actor), { amount: "10.00", receivedAt, payerName: "Identity payer", originLoanPublicId: loan!.publicId });
    return { intake, preview: await matchReady(f, scheduleIndex, intake.publicId) };
}
async function createRaw(f: Fixture, scheduleIndex: number, receivedAt: string) {
    const schedule = f.schedules[scheduleIndex]!;
    const loan = await db.query.loans.findFirst({ where: eq(loans.id, schedule.loanId) });
    return createPaymentIntake(context(f.actor), { amount: "10.00", receivedAt, payerName: "Identity payer", originLoanPublicId: loan!.publicId });
}
async function matchReady(f: Fixture, scheduleIndex: number, intakePublicId: string) {
    const schedule = f.schedules[scheduleIndex]!;
    const loan = await db.query.loans.findFirst({ where: eq(loans.id, schedule.loanId) });
    const preview = await previewPaymentMatch(context(f.actor), intakePublicId, { allocations: [{ borrowerPublicId: f.borrower.publicId, loanPublicId: loan!.publicId, schedulePublicId: schedule.publicId, amount: "10.00" }] });
    expect(preview.status).toBe("ready");
    return preview;
}
async function decide(f: Fixture, ids: string[], decision: "same_payment" | "distinct_payment", key = crypto.randomUUID()) {
    const preview = await previewPaymentIdentityDecision(context(f.actor), { participantPaymentIntakePublicIds: ids, decision, reason: `identity ${decision}`, idempotencyKey: key });
    return executePaymentIdentityDecision(context(f.actor), { identityDecisionPreviewPublicId: preview.identityDecisionPreviewPublicId, previewHash: preview.previewHash, confirmed: true, reason: `identity ${decision}`, idempotencyKey: `${key}-execute` });
}
async function errorCode(promise: Promise<unknown>) {
    try { await promise; throw new Error("expected rejection"); } catch (error) { return (error as { code?: string }).code; }
}

describe("payment identity decisions preserve financial invariants", () => {
    integration("same-payment receipts six minutes apart block the second real post without partial effects", async () => {
        await reset();
        const f = await fixture(2);
        const first = await createReady(f, 0, "2026-09-24T03:00:00.000Z");
        const second = await createReady(f, 1, "2026-09-24T03:06:00.000Z");
        await decide(f, [first.intake.publicId, second.intake.publicId], "same_payment");
        await postPayment(context(f.actor), first.intake.publicId, { proposalPublicId: first.preview.publicId });
        const before = await Promise.all([
            db.select().from(transactions).where(eq(transactions.tenantId, f.actor.tenantId)),
            db.select().from(paymentMatchAllocations).where(eq(paymentMatchAllocations.tenantId, f.actor.tenantId)),
            db.select().from(auditLogs).where(eq(auditLogs.tenantId, f.actor.tenantId)),
        ]);
        expect(await errorCode(postPayment(context(f.actor), second.intake.publicId, { proposalPublicId: second.preview.publicId }))).toBe("PAYMENT_DUPLICATE_REQUIRES_REVIEW");
        const after = await Promise.all([
            db.select().from(transactions).where(eq(transactions.tenantId, f.actor.tenantId)),
            db.select().from(paymentMatchAllocations).where(eq(paymentMatchAllocations.tenantId, f.actor.tenantId)),
            db.select().from(auditLogs).where(eq(auditLogs.tenantId, f.actor.tenantId)),
        ]);
        expect(after.map((rows) => rows.length)).toEqual(before.map((rows) => rows.length));
    });

    integration("a distinct identity decision lets two receipts within five minutes post to separate obligations", async () => {
        await reset();
        const f = await fixture(2);
        const firstIntake = await createRaw(f, 0, "2026-09-24T03:00:00.000Z");
        const secondIntake = await createRaw(f, 1, "2026-09-24T03:04:00.000Z");
        await decide(f, [firstIntake.publicId, secondIntake.publicId], "distinct_payment");
        const first = { intake: firstIntake, preview: await matchReady(f, 0, firstIntake.publicId) };
        const second = { intake: secondIntake, preview: await matchReady(f, 1, secondIntake.publicId) };
        expect(await identityDecisionAuthorizesPair(context(f.actor), first.intake.publicId, second.intake.publicId)).toBe(true);
        const firstRow = await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.publicId, first.intake.publicId) });
        await postPayment(context(f.actor), first.intake.publicId, { proposalPublicId: first.preview.publicId });
        expect(await identityDecisionAuthorizesPair(context(f.actor), first.intake.publicId, second.intake.publicId)).toBe(true);
        await postPayment(context(f.actor), second.intake.publicId, { proposalPublicId: second.preview.publicId });
        expect(await db.select().from(transactions).where(eq(transactions.tenantId, f.actor.tenantId))).toHaveLength(2);
        expect((await db.select().from(paymentIntakes).where(eq(paymentIntakes.tenantId, f.actor.tenantId))).filter((row) => row.status === "posted")).toHaveLength(2);
    });

    integration("same-payment identity is transitive and blocks a later post with zero extra ledger effect", async () => {
        await reset();
        const f = await fixture(3);
        const a = await createReady(f, 0, "2026-09-24T03:00:00.000Z");
        const b = await createReady(f, 1, "2026-09-24T03:30:00.000Z");
        const c = await createReady(f, 2, "2026-09-24T04:00:00.000Z");
        await decide(f, [a.intake.publicId, b.intake.publicId], "same_payment");
        await decide(f, [b.intake.publicId, c.intake.publicId], "same_payment");
        expect((await inspectPaymentIdentity(context(f.actor), [a.intake.publicId, c.intake.publicId])).connected).toBe(true);
        await postPayment(context(f.actor), a.intake.publicId, { proposalPublicId: a.preview.publicId });
        const transactionCount = (await db.select().from(transactions).where(eq(transactions.tenantId, f.actor.tenantId))).length;
        expect(await errorCode(postPayment(context(f.actor), c.intake.publicId, { proposalPublicId: c.preview.publicId }))).toBe("PAYMENT_DUPLICATE_REQUIRES_REVIEW");
        expect((await db.select().from(transactions).where(eq(transactions.tenantId, f.actor.tenantId))).length).toBe(transactionCount);
    });

    integration("a superseding distinct decision removes the old same-payment edge without mutating immutable decisions", async () => {
        await reset();
        const f = await fixture(2);
        const a = await createReady(f, 0, "2026-09-24T03:00:00.000Z");
        const b = await createReady(f, 1, "2026-09-24T03:30:00.000Z");
        await decide(f, [a.intake.publicId, b.intake.publicId], "same_payment");
        expect((await inspectPaymentIdentity(context(f.actor), [a.intake.publicId, b.intake.publicId])).connected).toBe(true);
        await decide(f, [a.intake.publicId, b.intake.publicId], "distinct_payment");
        expect((await inspectPaymentIdentity(context(f.actor), [a.intake.publicId, b.intake.publicId])).connected).toBe(false);
        const decisions = (await db.select().from(paymentIdentityDecisions).where(eq(paymentIdentityDecisions.tenantId, f.actor.tenantId))).sort((left, right) => left.id - right.id);
        expect(decisions).toHaveLength(2);
        expect(decisions[1]!.supersedesDecisionId).toBe(decisions[0]!.id);
    });

    integration("overlapping identity decisions on shared members both commit one effective transitive group", async () => {
        await reset();
        const f = await fixture(3);
        const a = await createRaw(f, 0, "2026-09-24T03:00:00.000Z");
        const b = await createRaw(f, 1, "2026-09-24T03:30:00.000Z");
        const c = await createRaw(f, 2, "2026-09-24T04:00:00.000Z");
        const firstPreview = await previewPaymentIdentityDecision(context(f.actor), { participantPaymentIntakePublicIds: [a.publicId, b.publicId], decision: "same_payment", reason: "shared AB", idempotencyKey: crypto.randomUUID() });
        const secondPreview = await previewPaymentIdentityDecision(context(f.actor), { participantPaymentIntakePublicIds: [b.publicId, c.publicId], decision: "same_payment", reason: "shared BC", idempotencyKey: crypto.randomUUID() });
        const results = await Promise.allSettled([
            executePaymentIdentityDecision(context(f.actor), { identityDecisionPreviewPublicId: firstPreview.identityDecisionPreviewPublicId, previewHash: firstPreview.previewHash, confirmed: true, reason: "shared AB", idempotencyKey: crypto.randomUUID() }),
            executePaymentIdentityDecision(context(f.actor), { identityDecisionPreviewPublicId: secondPreview.identityDecisionPreviewPublicId, previewHash: secondPreview.previewHash, confirmed: true, reason: "shared BC", idempotencyKey: crypto.randomUUID() }),
        ]);
        expect(results.every((result) => result.status === "fulfilled")).toBe(true);
        expect((await db.select().from(paymentIdentityDecisions).where(eq(paymentIdentityDecisions.tenantId, f.actor.tenantId)))).toHaveLength(2);
        expect((await inspectPaymentIdentity(context(f.actor), [a.publicId, c.publicId])).connected).toBe(true);
    });
});
