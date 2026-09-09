import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

test("floating daily interest migration adds optional policy and immutable daily accruals", async () => {
    const [journal, migration] = await Promise.all([
        readFile(new URL("../../drizzle/meta/_journal.json", import.meta.url), "utf8"),
        readFile(new URL("../../drizzle/0015_floating_daily_interest.sql", import.meta.url), "utf8"),
    ]);
    expect(journal).toContain('"tag": "0015_floating_daily_interest"');
    expect(migration).toContain('ADD COLUMN "daily_interest_mode" text');
    expect(migration).toContain('ADD COLUMN "daily_interest_rate" numeric');
    expect(migration).toContain('CREATE TABLE "loan_interest_accruals"');
    expect(migration).toContain('loan_interest_accruals_tenant_loan_date_unique');
});
