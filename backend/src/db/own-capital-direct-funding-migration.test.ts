import { describe, expect, test } from "bun:test";

const backendRoot = `${import.meta.dir}/../../`;

describe("own-capital direct funding migration", () => {
    test("registers an additive opportunity-cost policy without reclassifying profiles", async () => {
        const journal = await Bun.file(`${backendRoot}drizzle/meta/_journal.json`).json();
        expect(journal.entries.find((entry: { tag: string }) => entry.tag === "0013_own_capital_direct_funding"))
            .toMatchObject({ idx: 13, tag: "0013_own_capital_direct_funding" });

        const migration = Bun.file(`${backendRoot}drizzle/0013_own_capital_direct_funding.sql`);
        expect(await migration.exists()).toBe(true);
        const sql = await migration.text();
        expect(sql).toContain('ADD COLUMN "opportunity_cost_rate" numeric NOT NULL DEFAULT 2.00');
        expect(sql).toContain('CHECK ("opportunity_cost_rate" >= 0)');
        expect(sql).not.toContain('UPDATE "bank_profiles" SET "accounting_mode"');
        expect(sql).not.toMatch(/\bDROP\b/i);
    });
});
