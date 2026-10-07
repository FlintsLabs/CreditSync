import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "./index";
import { paymentIntakes, paymentReplacementLineages, users } from "./schema";
import { cancelPaymentIntake, getPaymentCancellationCapability } from "../services/payment-cancellation-service";
import type { CommandContext } from "../services/command-context";

const integrationTest = process.env.TEST_DATABASE_URL ? test : test.skip;

integrationTest("replacement lineage rejects an ordinary child with a NULL replacement parent at commit", async () => {
    const tenantId = `replacement-null-parent-${crypto.randomUUID()}`;
    const owner = (await db.insert(users).values({ tenantId, email: `${crypto.randomUUID()}@test.invalid`, role: "owner" }).returning())[0]!;
    const ctx: CommandContext = { tenantId, actorUserId: owner.id, actorSource: "web", requestId: crypto.randomUUID(), correlationId: crypto.randomUUID() };
    const payment = { tenantId, ownerUserId: owner.id, amount: "200.00", receivedAt: new Date("2026-09-21T12:05:00Z"), payerName: "Synthetic guard payer", status: "draft" as const, createdByUserId: owner.id, updatedByUserId: owner.id };
    const source = (await db.insert(paymentIntakes).values(payment).returning())[0]!;
    const capability = await getPaymentCancellationCapability(ctx, source.publicId);
    const cancellation = await cancelPaymentIntake(ctx, source.publicId, { reason: "Synthetic guard fixture", idempotencyKey: crypto.randomUUID(), expectedStateHash: capability.stateHash });
    const child = (await db.insert(paymentIntakes).values(payment).returning())[0]!;
    // Exact source/child data deliberately agree: rejection must be relational,
    // not a duplicate key, ownership or amount mismatch from the fixture.
    await expect(db.transaction(async (tx) => {
        await tx.insert(paymentReplacementLineages).values([{ tenantId, sourcePaymentIntakeId: source.id, replacementPaymentIntakeId: child.id, reason: "Synthetic invalid lineage", requestHash: "a".repeat(64), idempotencyKey: crypto.randomUUID(), requestId: ctx.requestId, correlationId: ctx.correlationId, auditPublicId: String(cancellation.auditPublicId), createdByUserId: owner.id }]);
    })).rejects.toThrow("replacement lineage lifecycle is invalid");
    expect(await db.select().from(paymentReplacementLineages).where(eq(paymentReplacementLineages.tenantId, tenantId))).toHaveLength(0);
});

integrationTest("replacement inspection keeps restore drafts in the restore workflow", async () => {
    const tenantId = `replacement-restore-boundary-${crypto.randomUUID()}`;
    const owner = (await db.insert(users).values({ tenantId, email: `${crypto.randomUUID()}@test.invalid`, role: "owner" }).returning())[0]!;
    const ctx: CommandContext = { tenantId, actorUserId: owner.id, actorSource: "web", requestId: crypto.randomUUID(), correlationId: crypto.randomUUID() };
    const source = (await db.insert(paymentIntakes).values({ tenantId, ownerUserId: owner.id, amount: "200.00", receivedAt: new Date("2026-09-21T12:05:00Z"), status: "draft", createdByUserId: owner.id }).returning())[0]!;
    const restoreDraft = (await db.insert(paymentIntakes).values({ tenantId, ownerUserId: owner.id, amount: "200.00", receivedAt: source.receivedAt, status: "draft", createdByUserId: owner.id, repostOfIntakeId: source.id }).returning())[0]!;
    const { inspectPaymentReplacement } = await import("../services/payment-replacement-service");
    const inspection = await inspectPaymentReplacement(ctx, restoreDraft.publicId);
    expect(inspection.allowed).toBe(false);
    expect(inspection.blockers).toContain("PAYMENT_REPLACEMENT_RESTORE_WORKFLOW_REQUIRED");
});
