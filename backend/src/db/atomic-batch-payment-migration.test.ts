import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { paymentBatches, paymentBatchItems, paymentBatchStagingItems, paymentIntakes, users } from "./schema";

const root = new URL("../../", import.meta.url).pathname;
const integrationTest = process.env.TEST_DATABASE_URL ? test : test.skip;

describe("atomic payment batch migration", () => {
    test("registers durable capture staging and operation receipts", async () => {
        const migration = await readFile(resolve(root, "drizzle/0065_batch_chronology_safety.sql"), "utf8");
        expect(migration).toContain('CREATE TABLE "payment_batch_staging_items"');
        expect(migration).toContain('client_item_key');
        expect(migration).toContain('operation_request_hash');
        expect(migration).toContain('reviewed_range_from');
    });

    integrationTest("enforces staging tenant ownership and uniqueness in the real database", async () => {
        const tenantId = `migration-staging-${crypto.randomUUID()}`;
        const actor = await db.insert(users).values({ tenantId, email: `${crypto.randomUUID()}@example.test`, role: "owner" }).returning().then((rows) => rows[0]!);
        const batch = await db.insert(paymentBatches).values({ tenantId, status: "needs_review", version: 0, stateHash: "v1:empty", createIdempotencyKey: crypto.randomUUID(), createdByUserId: actor.id, updatedByUserId: actor.id }).returning().then((rows) => rows[0]!);
        const staged = await db.insert(paymentBatchStagingItems).values({ tenantId, batchId: batch.id, clientItemKey: "same-slip", payloadFingerprint: "fingerprint", status: "staged", createdByUserId: actor.id, updatedByUserId: actor.id }).returning().then((rows) => rows[0]!);
        expect(staged.amount).toBeNull();
        expect(staged.receivedAt).toBeNull();
        let duplicateRejected = false;
        try { await db.insert(paymentBatchStagingItems).values({ tenantId, batchId: batch.id, clientItemKey: "same-slip", payloadFingerprint: "different", status: "staged", createdByUserId: actor.id, updatedByUserId: actor.id }); } catch { duplicateRejected = true; }
        expect(duplicateRejected).toBe(true);
        let crossTenantRejected = false;
        try { await db.insert(paymentBatchStagingItems).values({ tenantId: `${tenantId}-other`, batchId: batch.id, clientItemKey: "cross-tenant", payloadFingerprint: "fingerprint", status: "staged" }); } catch { crossTenantRejected = true; }
        expect(crossTenantRejected).toBe(true);
        expect(await db.query.paymentBatchStagingItems.findFirst({ where: eq(paymentBatchStagingItems.id, staged.id) })).toMatchObject({ status: "staged", amount: null, receivedAt: null });
    });
    integrationTest("rejects inserting or moving batch members under a posted parent", async () => {
        const tenantId = `migration-posted-parent-${crypto.randomUUID()}`;
        const actor = await db.insert(users).values({ tenantId, email: `${crypto.randomUUID()}@example.test`, role: "owner" }).returning().then((rows) => rows[0]!);
        const pending = await db.insert(paymentBatches).values({ tenantId, status: "needs_review", version: 0, stateHash: "v1:pending", createIdempotencyKey: crypto.randomUUID(), createdByUserId: actor.id, updatedByUserId: actor.id }).returning().then((rows) => rows[0]!);
        const posted = await db.insert(paymentBatches).values({ tenantId, status: "posted", version: 1, stateHash: "v1:posted", confirmationHash: "v1:confirmed", createIdempotencyKey: crypto.randomUUID(), executeIdempotencyKey: crypto.randomUUID(), postedAt: new Date(), createdByUserId: actor.id, updatedByUserId: actor.id }).returning().then((rows) => rows[0]!);
        const intake = await db.insert(paymentIntakes).values({ tenantId, ownerUserId: actor.id, source: "web", status: "draft", amount: "1.00", receivedAt: new Date(), idempotencyKey: crypto.randomUUID(), createdByUserId: actor.id, updatedByUserId: actor.id }).returning().then((rows) => rows[0]!);
        let insertRejected = false;
        try { await db.insert(paymentBatchItems).values({ tenantId, batchId: posted.id, paymentIntakeId: intake.id, itemOrder: 1 }); } catch { insertRejected = true; }
        expect(insertRejected).toBe(true);
        const item = await db.insert(paymentBatchItems).values({ tenantId, batchId: pending.id, paymentIntakeId: intake.id, itemOrder: 1 }).returning().then((rows) => rows[0]!);
        let moveRejected = false;
        try { await db.update(paymentBatchItems).set({ batchId: posted.id }).where(eq(paymentBatchItems.id, item.id)); } catch { moveRejected = true; }
        expect(moveRejected).toBe(true);
    });
    test("registers the additive batch schema and immutable posted boundary", async () => {
        const [journal, migration] = await Promise.all([
            Bun.file(`${root}drizzle/meta/_journal.json`).json() as Promise<{ entries: Array<{ idx: number; tag: string }> }>,
            Bun.file(`${root}drizzle/0051_atomic_batch_payments.sql`).text(),
        ]);
        expect(journal.entries.find((entry) => entry.idx === 51)).toMatchObject({ idx: 51, tag: "0051_atomic_batch_payments" });
        for (const table of ["payment_batches", "payment_batch_items", "payment_batch_previews", "payment_batch_allocations"]) expect(migration).toContain(`CREATE TABLE "${table}"`);
        for (const name of [
            "payment_batches_tenant_idempotency_unique",
            "payment_batch_items_tenant_intake_unique",
            "payment_batch_previews_tenant_batch_version_unique",
            "payment_batch_allocations_tenant_preview_order_unique",
            "payment_batch_posted_immutable",
        ]) expect(migration).toContain(name);
        expect(migration).toContain("CREATE TRIGGER");
        expect(migration).not.toMatch(/DROP TABLE/i);
    });
});
