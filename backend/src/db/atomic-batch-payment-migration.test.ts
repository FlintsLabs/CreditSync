import { describe, expect, test } from "bun:test";

const root = new URL("../../", import.meta.url).pathname;

describe("atomic payment batch migration", () => {
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
