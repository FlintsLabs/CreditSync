import { describe, expect, test } from "bun:test";

const backendRoot = `${import.meta.dir}/../../`;

describe("payment review warnings migration", () => {
    test("registers additive persisted intake warnings", async () => {
        const journal = await Bun.file(`${backendRoot}drizzle/meta/_journal.json`).json();
        expect(journal.entries.find((entry: { tag: string }) => entry.tag === "0012_payment_review_warnings"))
            .toMatchObject({ idx: 12, tag: "0012_payment_review_warnings" });
        const migration = await Bun.file(`${backendRoot}drizzle/0012_payment_review_warnings.sql`).text();
        expect(migration).toContain('ALTER TABLE "payment_intakes" ADD COLUMN "warnings" jsonb');
        expect(migration).not.toMatch(/\bDROP\b/i);
    });
});
