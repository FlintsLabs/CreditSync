import { expect, test } from "bun:test";

const backendRoot = new URL("../../", import.meta.url).pathname;
const migrationPath = `${backendRoot}drizzle/0028_floating_weekly_period_snapshots.sql`;
const journalPath = `${backendRoot}drizzle/meta/_journal.json`;

test("registers immutable floating weekly period snapshots additively", async () => {
    expect(await Bun.file(migrationPath).exists()).toBe(true);
    const migration = await Bun.file(migrationPath).text();
    const journal = await Bun.file(journalPath).json() as { entries: Array<{ idx: number; tag: string }> };

    expect(journal.entries.at(-1)).toMatchObject({ idx: 28, tag: "0028_floating_weekly_period_snapshots" });
    for (const column of [
        "period_start_date", "period_end_date", "period_day_index", "period_days", "cumulative_interest_amount",
    ]) expect(migration).toContain(`"${column}"`);
    expect(migration).toContain("accruing");
    expect(migration).toContain("partially_paid");
    expect(migration).toMatch(/BEFORE UPDATE OR DELETE ON "loan_interest_accruals"/u);
    expect(migration).not.toMatch(/UPDATE\s+"loan_interest_accruals"\s+SET\s+"interest_amount"/iu);
});
