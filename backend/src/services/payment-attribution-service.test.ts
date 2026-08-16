import { beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { db } from "../db";
import { borrowers, intermediaries, loans, paymentIntermediaryAttributions, transactions, users } from "../db/schema";
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
    const payment = await db.insert(transactions).values({ tenantId, ownerUserId: actor.id, loanId: loan.id, amount: "100.00", principalComponent: "80.00", interestComponent: "20.00", idempotencyKey: `${tenantId}-payment` }).returning().then((r) => r[0]!);
    const a = await db.insert(intermediaries).values({ tenantId, ownerUserId: actor.id, name: `${tenantId} A`, normalizedName: `${tenantId}-a`, createdByUserId: actor.id, updatedByUserId: actor.id }).returning().then((r) => r[0]!);
    const b = await db.insert(intermediaries).values({ tenantId, ownerUserId: actor.id, name: `${tenantId} B`, normalizedName: `${tenantId}-b`, createdByUserId: actor.id, updatedByUserId: actor.id }).returning().then((r) => r[0]!);
    return { actor, payment, a, b };
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
    });
});
