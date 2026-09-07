import { describe, expect, test } from "bun:test";

const root = new URL("../../", import.meta.url).pathname;

describe("scheduled payment allocation correction migration", () => {
    test("registers the additive migration and immutable ledger constraints", async () => {
        const journal = await Bun.file(`${root}drizzle/meta/_journal.json`).json() as { entries: Array<{ idx: number; tag: string }> };
        expect(journal.entries.find((entry) => entry.tag === "0061_scheduled_payment_allocation_corrections")).toEqual({ idx: 61, version: "7", when: 1788471121000, tag: "0061_scheduled_payment_allocation_corrections", breakpoints: true });
        const sql = await Bun.file(`${root}drizzle/0061_scheduled_payment_allocation_corrections.sql`).text();
        for (const table of ["payment_allocation_correction_previews", "payment_allocation_correction_groups", "payment_allocation_correction_entries"]) expect(sql).toContain(`CREATE TABLE IF NOT EXISTS \"${table}\"`);
        expect(sql).toContain("payment_allocation_correction_previews_amount_check");
        expect(sql).toContain("payment_allocation_correction_groups_tenant_idempotency_unique");
        expect(sql).toContain("payment_allocation_correction_groups_tenant_source_unique");
        expect(sql).toMatch(/BEFORE UPDATE OR DELETE ON \"payment_allocation_correction_(previews|groups|entries)\"/);
        expect(sql).toMatch(/records are immutable/i);
    });
});
