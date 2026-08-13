import { expect, test } from "bun:test";

const backendRoot = new URL("../../", import.meta.url).pathname;
const migrationPath = `${backendRoot}drizzle/0028_floating_weekly_period_snapshots.sql`;
const penaltyMigrationPath = `${backendRoot}drizzle/0029_floating_penalty_snapshots.sql`;
const penaltyLedgerMigrationPath = `${backendRoot}drizzle/0030_floating_penalty_ledger.sql`;
const journalPath = `${backendRoot}drizzle/meta/_journal.json`;

test("registers immutable floating weekly period snapshots additively", async () => {
    expect(await Bun.file(migrationPath).exists()).toBe(true);
    const migration = await Bun.file(migrationPath).text();
    const journal = await Bun.file(journalPath).json() as { entries: Array<{ idx: number; tag: string }> };

    expect(journal.entries.find((entry) => entry.idx === 28)).toMatchObject({
        idx: 28,
        tag: "0028_floating_weekly_period_snapshots",
    });
    for (const column of [
        "period_start_date", "period_end_date", "period_day_index", "period_days", "cumulative_interest_amount",
    ]) expect(migration).toContain(`"${column}"`);
    expect(migration).toContain("accruing");
    expect(migration).toContain("partially_paid");
    expect(migration).toMatch(/BEFORE UPDATE OR DELETE ON "loan_interest_accruals"/u);
    expect(migration).not.toMatch(/UPDATE\s+"loan_interest_accruals"\s+SET\s+"interest_amount"/iu);
});

// Break caught: floating payments have no durable per-due-group penalty state,
// forcing settlement to subtract loan-wide transaction history.
test("registers exact paid-penalty state on floating accrual snapshots", async () => {
    expect(await Bun.file(penaltyMigrationPath).exists()).toBe(true);
    const migration = await Bun.file(penaltyMigrationPath).text();
    const journal = await Bun.file(journalPath).json() as { entries: Array<{ idx: number; tag: string }> };

    expect(journal.entries.find((entry) => entry.idx === 29)).toMatchObject({ idx: 29, tag: "0029_floating_penalty_snapshots" });
    expect(migration).toContain('ADD COLUMN "accrued_penalty" numeric DEFAULT \'0\' NOT NULL');
    expect(migration).toContain('ADD COLUMN "paid_penalty" numeric DEFAULT \'0\' NOT NULL');
    expect(migration).toContain("loan_interest_accruals_penalty_money_check");
});

// Break caught: floating penalties are stored as mutable undated aggregate
// columns instead of immutable dated assessments and exact group allocations.
test("registers append-only dated floating penalty and allocation ledgers", async () => {
    expect(await Bun.file(penaltyLedgerMigrationPath).exists()).toBe(true);
    const migration = await Bun.file(penaltyLedgerMigrationPath).text();
    const journal = await Bun.file(journalPath).json() as { entries: Array<{ idx: number; tag: string }> };

    expect(journal.entries.at(-1)).toMatchObject({ idx: 30, tag: "0030_floating_penalty_ledger" });
    for (const table of ["floating_penalty_ledger_entries", "floating_transaction_allocations"]) {
        expect(migration).toContain(`CREATE TABLE "${table}"`);
        expect(migration).toMatch(new RegExp(`BEFORE UPDATE OR DELETE ON "${table}"`, "u"));
    }
    for (const field of ["due_date", "penalty_date", "opening_interest_basis", "audit_public_id", "idempotency_key"]) {
        expect(migration).toContain(`"${field}"`);
    }
    expect(migration).toContain('"reversed_allocation_id"');
    expect(migration).toContain("legacy_snapshot");
    expect(migration).toContain("floating_penalty_ledger_migrated");
    expect(migration).toContain("floating settlement migration requires exact transaction allocation provenance");
    expect(migration).toContain("floating settlement migration found unmatched paid accrual state");
    expect(migration).toMatch(/ROW_NUMBER\(\) OVER[\s\S]+PARTITION BY "tenant_id", "transaction_id"/u);
    expect(migration).toMatch(/NEW\."accrued_penalty" IS DISTINCT FROM OLD\."accrued_penalty"/u);
    expect(migration).toMatch(/NEW\."paid_penalty" IS DISTINCT FROM OLD\."paid_penalty"/u);
});
