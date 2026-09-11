import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { db } from ".";
import { paymentIntakeCancellations, paymentIntakes, users } from "./schema";
import type { CommandContext } from "../services/command-context";
import { createPaymentIntake } from "../services/payment-service";
import { cancelPaymentIntake, getPaymentCancellationCapability } from "../services/payment-cancellation-service";
import { addPaymentBatchItem, cancelPaymentBatch, createPaymentBatch } from "../services/payment-batch-service";

const integrationTest = process.env.TEST_DATABASE_URL ? test : test.skip;
const migrationPath = join(import.meta.dir, "../../drizzle/0073_payment_intake_cancellation.sql");

async function reset() {
    await db.execute(sql`TRUNCATE TABLE audit_logs, payment_intake_cancellations, payment_intakes, users CASCADE`);
}

async function seedUser(role: "owner" | "manager" | "collector" | "viewer" | null = "owner") {
    return db.insert(users).values({ tenantId: "cancel-test", email: `${crypto.randomUUID()}@test.invalid`, role }).returning().then((rows) => rows[0]!);
}

function context(user: { id: number; tenantId: string }): CommandContext {
    return { tenantId: user.tenantId, actorUserId: user.id, actorSource: "web", requestId: crypto.randomUUID(), correlationId: crypto.randomUUID() };
}

describe("payment intake cancellation migration", () => {
    test("is journaled and contains deferred receipt plus complete lifecycle guards", () => {
        const migration = readFileSync(migrationPath, "utf8");
        const journal = readFileSync(join(import.meta.dir, "../../drizzle/meta/_journal.json"), "utf8");
        expect(journal).toContain('"tag": "0073_payment_intake_cancellation"');
        expect(migration).toContain("DEFERRABLE INITIALLY DEFERRED");
        expect(migration).toContain("payment_intakes_cancellation_receipt_guard");
        expect(migration).toContain("TG_OP = 'DELETE'");
        expect(migration).toContain("TG_OP = 'INSERT'");
        for (const field of ["cancellation_actor_source", "cancellation_request_id", "cancellation_correlation_id", "cancelled_by_user_id"]) expect(migration).toContain(field);
    });

    integrationTest("creates one immutable receipt, rejects viewer mutation, and preserves noncancelled DELETE", async () => {
        await reset();
        const owner = await seedUser("owner");
        const intake = await createPaymentIntake(context(owner), { amount: "12.34", receivedAt: "2026-09-11T10:00:00.000Z", payerName: "Synthetic payer" });
        const before = await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.publicId, intake.publicId) });
        const capability = await getPaymentCancellationCapability(context(owner), intake.publicId);
        expect(capability.allowed).toBe(true);
        const request = { reason: "  entered\nin error  ", idempotencyKey: crypto.randomUUID(), expectedStateHash: capability.stateHash };
        const first = await cancelPaymentIntake(context(owner), intake.publicId, request);
        expect(first.reason).toBe("entered in error");
        expect(await cancelPaymentIntake(context(owner), intake.publicId, request)).toEqual(first);
        expect(await db.select().from(paymentIntakeCancellations)).toHaveLength(1);
        expect(await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.publicId, intake.publicId) })).toMatchObject({ status: "cancelled", amount: before!.amount, payerName: before!.payerName });
        await expect(Promise.resolve(db.delete(paymentIntakeCancellations))).rejects.toMatchObject({ cause: { code: "P0001" } });
        await expect(Promise.resolve(db.delete(paymentIntakes).where(eq(paymentIntakes.publicId, intake.publicId)))).rejects.toMatchObject({ cause: { code: "P0001" } });

        const viewer = await seedUser("viewer");
        const viewerIntake = await createPaymentIntake(context(viewer), { amount: "1.00", receivedAt: "2026-09-11T11:00:00.000Z" });
        const viewerCapability = await getPaymentCancellationCapability(context(viewer), viewerIntake.publicId);
        expect(viewerCapability).toMatchObject({ allowed: false, blockedReason: "PAYMENT_CANCEL_FORBIDDEN" });
        await expect(cancelPaymentIntake(context(viewer), viewerIntake.publicId, { reason: "no", idempotencyKey: crypto.randomUUID(), expectedStateHash: viewerCapability.stateHash })).rejects.toMatchObject({ code: "PAYMENT_CANCEL_FORBIDDEN", status: 403 });

        const nullRole = await seedUser(null);
        const nullRoleIntake = await createPaymentIntake(context(nullRole), { amount: "1.01", receivedAt: "2026-09-11T11:15:00.000Z" });
        const nullRoleCapability = await getPaymentCancellationCapability(context(nullRole), nullRoleIntake.publicId);
        expect(nullRoleCapability).toMatchObject({ allowed: false, blockedReason: "PAYMENT_CANCEL_FORBIDDEN" });
        await expect(cancelPaymentIntake(context(nullRole), nullRoleIntake.publicId, {
            reason: "no", idempotencyKey: crypto.randomUUID(), expectedStateHash: nullRoleCapability.stateHash,
        })).rejects.toMatchObject({ code: "PAYMENT_CANCEL_FORBIDDEN", status: 403 });

        const concurrent = await createPaymentIntake(context(owner), { amount: "3.00", receivedAt: "2026-09-11T11:30:00.000Z" });
        const concurrentCapability = await getPaymentCancellationCapability(context(owner), concurrent.publicId);
        const concurrentRequest = { reason: "concurrent retry", idempotencyKey: crypto.randomUUID(), expectedStateHash: concurrentCapability.stateHash };
        const concurrentResults = await Promise.all([
            cancelPaymentIntake(context(owner), concurrent.publicId, concurrentRequest),
            cancelPaymentIntake(context(owner), concurrent.publicId, concurrentRequest),
        ]);
        expect(concurrentResults[0]).toEqual(concurrentResults[1]);
        expect(await db.select().from(paymentIntakeCancellations)).toHaveLength(2);
        await expect(cancelPaymentIntake(context(owner), concurrent.publicId, { ...concurrentRequest, reason: "changed" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", status: 409 });
        const otherTarget = await createPaymentIntake(context(owner), { amount: "4.00", receivedAt: "2026-09-11T11:45:00.000Z" });
        await expect(cancelPaymentIntake(context(owner), otherTarget.publicId, concurrentRequest)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", status: 409 });

        const batchIntakeOne = await createPaymentIntake(context(owner), { amount: "5.00", receivedAt: "2026-09-11T12:10:00.000Z" });
        const batchIntakeTwo = await createPaymentIntake(context(owner), { amount: "6.00", receivedAt: "2026-09-11T12:11:00.000Z" });
        const batch = await createPaymentBatch(context(owner), { idempotencyKey: crypto.randomUUID() });
        await addPaymentBatchItem(context(owner), batch.publicId, { paymentIntakePublicId: batchIntakeOne.publicId, itemOrder: 1 });
        const attached = await addPaymentBatchItem(context(owner), batch.publicId, { paymentIntakePublicId: batchIntakeTwo.publicId, itemOrder: 2 });
        const cancelledBatch = await cancelPaymentBatch(context(owner), batch.publicId, { reason: "batch entered in error", revision: attached.version, idempotencyKey: crypto.randomUUID() }) as { status: string };
        expect(cancelledBatch.status).toBe("cancelled");
        expect(await db.select().from(paymentIntakes).where(sql`public_id IN (${batchIntakeOne.publicId}, ${batchIntakeTwo.publicId})`)).toEqual(expect.arrayContaining([expect.objectContaining({ status: "cancelled" })]));
        expect(await db.select().from(paymentIntakeCancellations)).toHaveLength(4);

        const disposable = await createPaymentIntake(context(owner), { amount: "2.00", receivedAt: "2026-09-11T12:00:00.000Z" });
        await db.delete(paymentIntakes).where(eq(paymentIntakes.publicId, disposable.publicId));
        expect(await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.publicId, disposable.publicId) })).toBeUndefined();
    });
});
