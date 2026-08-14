import { expect, test } from "bun:test";

test("adds a tenant-safe durable restructure relation to disbursement events", async () => {
    const sql = await Bun.file(new URL("../../drizzle/0035_disbursement_restructure_relation.sql", import.meta.url)).text();
    const journal = await Bun.file(new URL("../../drizzle/meta/_journal.json", import.meta.url)).json() as { entries: Array<{ tag: string }> };
    expect(sql).toContain('ADD COLUMN "restructure_id" integer');
    expect(sql).toContain('FOREIGN KEY ("tenant_id", "restructure_id") REFERENCES "loan_restructures"("tenant_id", "id")');
    expect(sql).toContain('loan_disbursement_events_tenant_restructure_idx');
    expect(sql).toContain('loan_disbursement_events_restructure_relation_immutable');
    expect(journal.entries.some(entry => entry.tag === "0035_disbursement_restructure_relation")).toBe(true);
});
