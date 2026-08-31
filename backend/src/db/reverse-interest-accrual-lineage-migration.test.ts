import { expect, test } from "bun:test";

test("registers reversal provenance columns for materialized interest accruals", async () => {
    const [journal, migration] = await Promise.all([
        Bun.file(new URL("../../drizzle/meta/_journal.json", import.meta.url)).text(),
        Bun.file(new URL("../../drizzle/0058_reverse_interest_accrual_lineage.sql", import.meta.url)).text(),
    ]);

    expect(JSON.parse(journal).entries.map((entry: { tag: string }) => entry.tag))
        .toContain("0058_reverse_interest_accrual_lineage");
    expect(migration).toContain('"materialization_source"');
    expect(migration).toContain('"source_payment_intake_id"');
    expect(migration).toContain('"source_reversal_transaction_id"');
    expect(migration).toContain('"materialization_reason"');
});
