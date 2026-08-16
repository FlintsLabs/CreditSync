import { beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { db } from "../db";
import { auditLogs, borrowers, intermediaries, loans, paymentIntakes, paymentIntermediaryAttributions, transactions, users } from "../db/schema";
import type { CommandContext } from "./command-context";
import { createPaymentAttribution, listPaymentAttributions, reversePaymentAttribution } from "./payment-attribution-service";

const integrationEnabled = Boolean(process.env.TEST_DATABASE_URL);
const integrationTest = integrationEnabled ? test : test.skip;

async function resetTables() {
    await db.execute(sql`TRUNCATE TABLE audit_logs, payment_intermediary_attributions, loan_commission_participants, transactions, intermediaries, loans, borrowers, users RESTART IDENTITY CASCADE`);
}
async function seed(tenantId: string) {
    const actor = await db.insert(users).values({ tenantId, email: `${tenantId}@attribution.test`, role: "owner" }).returning().then((r) => r[0]!);
    const borrower = await db.insert(borrowers).values({ tenantId, ownerUserId: actor.id, name: tenantId }).returning().then((r) => r[0]!);
    const loan = await db.insert(loans).values({ tenantId, ownerUserId: actor.id, borrowerId: borrower.id, principalAmount: "100.00", interestRate: "0.00", repaymentType: "floating" }).returning().then((r) => r[0]!);
    const payment = await db.insert(transactions).values({ tenantId, ownerUserId: actor.id, loanId: loan.id, amount: "100.00", principalComponent: "80.00", interestComponent: "20.00", type: "repayment", entryType: "repayment", idempotencyKey: `${tenantId}-payment`, postedAt: new Date("2026-08-16T00:00:00.000Z") }).returning().then((r) => r[0]!);
    const a = await db.insert(intermediaries).values({ tenantId, ownerUserId: actor.id, name: `${tenantId} A`, normalizedName: `${tenantId}-a`, createdByUserId: actor.id, updatedByUserId: actor.id }).returning().then((r) => r[0]!);
    const b = await db.insert(intermediaries).values({ tenantId, ownerUserId: actor.id, name: `${tenantId} B`, normalizedName: `${tenantId}-b`, createdByUserId: actor.id, updatedByUserId: actor.id }).returning().then((r) => r[0]!);
    return { actor, loan, payment, a, b };
}
const ctx = (actor: typeof users.$inferSelect, key?: string): CommandContext => ({ tenantId: actor.tenantId, actorUserId: actor.id, actorSource: "web", requestId: `req-${key ?? "read"}`, correlationId: `corr-${key ?? "read"}`, idempotencyKey: key });

describe("payment intermediary attribution ledger", () => {
    if (integrationEnabled) beforeEach(resetTables);

    integrationTest("attributes an exact payment split with replay and tenant isolation", async () => {
        const seeded = await seed("attribution-a");
        const foreign = await seed("attribution-b");
        await createPaymentAttribution(ctx(seeded.actor, "direct"), { paymentPublicId: seeded.payment.publicId, sourceKind: "direct", amount: "20.00" });
        const first = await createPaymentAttribution(ctx(seeded.actor, "agent-a"), { paymentPublicId: seeded.payment.publicId, sourceKind: "intermediary", intermediaryPublicId: seeded.a.publicId, amount: "30.00" });
        const replay = await createPaymentAttribution(ctx(seeded.actor, "agent-a"), { paymentPublicId: seeded.payment.publicId, sourceKind: "intermediary", intermediaryPublicId: seeded.a.publicId, amount: "30.00" });
        await createPaymentAttribution(ctx(seeded.actor, "agent-b"), { paymentPublicId: seeded.payment.publicId, sourceKind: "intermediary", intermediaryPublicId: seeded.b.publicId, amount: "50.00" });
        expect(replay).toEqual(first);
        expect((await listPaymentAttributions(ctx(seeded.actor), seeded.payment.publicId)).map((row) => row.amount)).toEqual(["20.00", "30.00", "50.00"]);
        await expect(createPaymentAttribution(ctx(seeded.actor, "over"), { paymentPublicId: seeded.payment.publicId, sourceKind: "direct", amount: "0.01" })).rejects.toMatchObject({ code: "PAYMENT_ATTRIBUTION_EXCEEDS_PAYMENT", status: 409 });
        await expect(createPaymentAttribution(ctx(seeded.actor, "foreign-payment"), { paymentPublicId: foreign.payment.publicId, sourceKind: "direct", amount: "1.00" })).rejects.toMatchObject({ code: "PAYMENT_NOT_FOUND" });
        await expect(createPaymentAttribution(ctx(seeded.actor, "foreign-agent"), { paymentPublicId: seeded.payment.publicId, sourceKind: "intermediary", intermediaryPublicId: foreign.a.publicId, amount: "1.00" })).rejects.toMatchObject({ code: "INTERMEDIARY_NOT_FOUND" });
    });

    integrationTest("reverses by appending an exact compensating row with a required reason", async () => {
        const seeded = await seed("attribution-reversal");
        const original = await createPaymentAttribution(ctx(seeded.actor, "create"), { paymentPublicId: seeded.payment.publicId, sourceKind: "intermediary", intermediaryPublicId: seeded.a.publicId, amount: "40.00" });
        await expect(reversePaymentAttribution(ctx(seeded.actor, "reverse-empty"), { attributionPublicId: original.publicId, reason: " " })).rejects.toMatchObject({ code: "REVERSAL_REASON_REQUIRED" });
        const reversed = await reversePaymentAttribution(ctx(seeded.actor, "reverse"), { attributionPublicId: original.publicId, reason: "wrong source" });
        expect(reversed).toMatchObject({ amount: "-40.00", sourceKind: "intermediary", intermediaryPublicId: seeded.a.publicId, reversedAttributionPublicId: original.publicId, reason: "wrong source" });
        expect(await db.select().from(paymentIntermediaryAttributions)).toHaveLength(2);
        expect((await reversePaymentAttribution(ctx(seeded.actor, "reverse"), { attributionPublicId: original.publicId, reason: "wrong source" })).publicId).toBe(reversed.publicId);

        const audit = await db.query.auditLogs.findFirst({ where: eq(auditLogs.publicId, reversed.auditPublicId) });
        expect(audit).toMatchObject({ tenantId: seeded.actor.tenantId, actorUserId: seeded.actor.id, actorSource: "web", requestId: "req-reverse", correlationId: "corr-reverse", entityId: reversed.publicId, action: "reversed" });
        await expect(db.update(paymentIntermediaryAttributions).set({ reason: "mutated" }).where(eq(paymentIntermediaryAttributions.publicId, original.publicId)).execute()).rejects.toMatchObject({ cause: { code: "P0001", message: expect.stringMatching(/append-only/) } });
        await expect(db.delete(paymentIntermediaryAttributions).where(eq(paymentIntermediaryAttributions.publicId, original.publicId)).execute()).rejects.toMatchObject({ cause: { code: "P0001", message: expect.stringMatching(/append-only/) } });
    });

    integrationTest("authorizes replay before returning it and presents the persisted linked transaction", async () => {
        const seeded = await seed("attribution-replay");
        const peer = await db.insert(users).values({ tenantId: seeded.actor.tenantId, email: "peer@attribution.test", role: "collector" }).returning().then((rows) => rows[0]!);
        const linked = await db.insert(transactions).values({ tenantId: seeded.actor.tenantId, ownerUserId: seeded.actor.id, loanId: seeded.loan.id, amount: "5.00", interestComponent: "5.00", idempotencyKey: "linked-transaction" }).returning().then((rows) => rows[0]!);
        const input = { paymentPublicId: seeded.payment.publicId, transactionPublicId: linked.publicId, sourceKind: "intermediary" as const, intermediaryPublicId: seeded.a.publicId, amount: "30.00" };
        const created = await createPaymentAttribution(ctx(seeded.actor, "scoped-replay"), input);

        expect(created.transactionPublicId).toBe(linked.publicId);
        expect((await listPaymentAttributions(ctx(seeded.actor), seeded.payment.publicId))[0]?.transactionPublicId).toBe(linked.publicId);
        await expect(createPaymentAttribution(ctx(peer, "scoped-replay"), input)).rejects.toMatchObject({ code: "PAYMENT_ATTRIBUTION_NOT_FOUND", status: 404 });
        expect((await createPaymentAttribution(ctx(seeded.actor, "scoped-replay"), input)).publicId).toBe(created.publicId);
        const reverseInput = { attributionPublicId: created.publicId, reason: "wrong attribution" };
        await reversePaymentAttribution(ctx(seeded.actor, "scoped-reverse-replay"), reverseInput);
        await expect(reversePaymentAttribution(ctx(peer, "scoped-reverse-replay"), reverseInput)).rejects.toMatchObject({ code: "PAYMENT_ATTRIBUTION_NOT_FOUND", status: 404 });
    });

    integrationTest("accepts only canonical posted payments for both target and linked transactions", async () => {
        const seeded = await seed("attribution-canonical-payment");
        const draftIntake = await db.insert(paymentIntakes).values({ tenantId: seeded.actor.tenantId, ownerUserId: seeded.actor.id, amount: "10.00", status: "draft", originLoanId: seeded.loan.id }).returning().then((rows) => rows[0]!);
        await db.execute(sql`ALTER TABLE transactions ALTER COLUMN posted_at DROP NOT NULL`);
        const unposted = await db.insert(transactions).values({ tenantId: seeded.actor.tenantId, ownerUserId: seeded.actor.id, loanId: seeded.loan.id, amount: "10.00", type: "repayment", entryType: "repayment", idempotencyKey: "unposted-attribution-target", postedAt: new Date("2026-08-16T00:00:00.000Z") }).returning().then((rows) => rows[0]!);
        await db.execute(sql`UPDATE transactions SET posted_at = NULL WHERE id = ${unposted.id}`);
        const nonPayment = await db.insert(transactions).values({ tenantId: seeded.actor.tenantId, ownerUserId: seeded.actor.id, loanId: seeded.loan.id, amount: "10.00", type: "draft", entryType: "repayment", idempotencyKey: "non-payment-attribution-target", postedAt: new Date("2026-08-16T00:00:00.000Z") }).returning().then((rows) => rows[0]!);
        const invalidIntake = await db.insert(transactions).values({ tenantId: seeded.actor.tenantId, ownerUserId: seeded.actor.id, loanId: seeded.loan.id, paymentIntakeId: draftIntake.id, amount: "10.00", type: "repayment", entryType: "repayment", idempotencyKey: "invalid-intake-attribution-target", postedAt: new Date("2026-08-16T00:00:00.000Z") }).returning().then((rows) => rows[0]!);

        for (const [key, paymentPublicId] of [["unposted", unposted.publicId], ["non-payment", nonPayment.publicId], ["invalid-intake", invalidIntake.publicId]] as const) {
            await expect(createPaymentAttribution(ctx(seeded.actor, key), { paymentPublicId, sourceKind: "direct", amount: "1.00" })).rejects.toMatchObject({ code: "PAYMENT_NOT_FOUND", status: 404 });
            await expect(createPaymentAttribution(ctx(seeded.actor, `linked-${key}`), { paymentPublicId: seeded.payment.publicId, transactionPublicId: paymentPublicId, sourceKind: "direct", amount: "1.00" })).rejects.toMatchObject({ code: "PAYMENT_NOT_FOUND", status: 404 });
        }
    });

    integrationTest("hides and refuses to reverse attributions with a related row outside owner scope", async () => {
        const seeded = await seed("attribution-related-owner-scope");
        const caller = await db.insert(users).values({ tenantId: seeded.actor.tenantId, email: "caller@attribution-scope.test", role: "collector" }).returning().then((rows) => rows[0]!);
        const hiddenOwner = await db.insert(users).values({ tenantId: seeded.actor.tenantId, email: "hidden@attribution-scope.test", role: "collector" }).returning().then((rows) => rows[0]!);
        await db.execute(sql`UPDATE loans SET owner_user_id = ${caller.id} WHERE id = ${seeded.loan.id}`);
        await db.execute(sql`UPDATE transactions SET owner_user_id = ${caller.id} WHERE id = ${seeded.payment.id}`);
        const hiddenIntermediary = await db.insert(intermediaries).values({ tenantId: seeded.actor.tenantId, ownerUserId: hiddenOwner.id, name: "Hidden Agent", normalizedName: "hidden-agent", createdByUserId: hiddenOwner.id, updatedByUserId: hiddenOwner.id }).returning().then((rows) => rows[0]!);
        const hiddenLinked = await db.insert(transactions).values({ tenantId: seeded.actor.tenantId, ownerUserId: hiddenOwner.id, loanId: seeded.loan.id, amount: "10.00", type: "repayment", entryType: "repayment", idempotencyKey: "hidden-linked-owner-scope", postedAt: new Date("2026-08-16T00:00:00.000Z") }).returning().then((rows) => rows[0]!);
        const hiddenByIntermediary = await createPaymentAttribution(ctx(seeded.actor, "admin-create-hidden-intermediary"), { paymentPublicId: seeded.payment.publicId, sourceKind: "intermediary", intermediaryPublicId: hiddenIntermediary.publicId, amount: "10.00" });
        const hiddenByLinkedTransaction = await createPaymentAttribution(ctx(seeded.actor, "admin-create-hidden-linked"), { paymentPublicId: seeded.payment.publicId, transactionPublicId: hiddenLinked.publicId, sourceKind: "direct", amount: "10.00" });

        expect(await listPaymentAttributions(ctx(caller), seeded.payment.publicId)).toEqual([]);
        for (const [key, attributionPublicId] of [["intermediary", hiddenByIntermediary.publicId], ["linked", hiddenByLinkedTransaction.publicId]] as const) {
            await expect(reversePaymentAttribution(ctx(caller, `caller-reverse-hidden-${key}`), { attributionPublicId, reason: "must stay hidden" })).rejects.toMatchObject({ code: "PAYMENT_ATTRIBUTION_NOT_FOUND", status: 404 });
        }
    });
});
