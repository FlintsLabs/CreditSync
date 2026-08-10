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

    test("registers a nullable direct-capital source for loan drafts", async () => {
        const journal = await Bun.file(`${backendRoot}drizzle/meta/_journal.json`).json();
        expect(journal.entries.find((entry: { tag: string }) => entry.tag === "0014_loan_direct_capital_source"))
            .toMatchObject({ idx: 14, tag: "0014_loan_direct_capital_source" });

        const migration = Bun.file(`${backendRoot}drizzle/0014_loan_direct_capital_source.sql`);
        expect(await migration.exists()).toBe(true);
        const sql = await migration.text();
        expect(sql).toContain('ADD COLUMN "funding_bank_profile_id" integer');
        expect(sql).toContain('loans_funding_bank_profile_fk');
        expect(sql).toContain('loans_one_funding_source_check');
        expect(sql).not.toMatch(/\bDROP\b/i);
    });
});
