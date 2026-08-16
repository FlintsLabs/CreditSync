import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const integrationTest = process.env.TEST_DATABASE_URL ? test : test.skip;

const root = join(import.meta.dir, "../../drizzle");

describe("atomic loan replacement migration contract", () => {
  test("declares the replacement ledger and terminal status", () => {
    const sql = readFileSync(join(root, "0042_atomic_loan_replacement.sql"), "utf8");
    expect(sql).toContain('CREATE TABLE "loan_replacements"');
    expect(sql).toContain('CREATE TABLE "loan_replacement_corrections"');
    expect(sql).toContain("status IN ('preview', 'executed', 'reversed', 'expired')");
    expect(sql).toContain("'replaced'");
    expect(sql).toContain("loan_replacements_tenant_old_loan_fk");
    expect(sql).toContain("loan_replacements_tenant_replacement_loan_fk");
    expect(sql).toContain("'draft', 'active', 'paid', 'defaulted', 'closed', 'renewed', 'restructured', 'cancelled', 'settled', 'reversed', 'replaced'");
    expect(sql.indexOf('CREATE UNIQUE INDEX "loan_replacements_tenant_id_id_unique"'))
      .toBeLessThan(sql.indexOf('CREATE TABLE "loan_replacement_corrections"'));
  });

  test("is journaled after migration 0041", () => {
    const journal = readFileSync(join(root, "meta/_journal.json"), "utf8");
    expect(journal).toContain('"tag": "0041_funding_allocation_idempotency"');
    expect(journal).toContain('"tag": "0042_atomic_loan_replacement"');
    expect(journal.indexOf('"tag": "0042_atomic_loan_replacement"')).toBeGreaterThan(
      journal.indexOf('"tag": "0041_funding_allocation_idempotency"'),
    );
  });

  integrationTest("accepts every loan status used by the application on a fresh database", async () => {
    const postgres = (await import("postgres")).default(process.env.TEST_DATABASE_URL!, { max: 1 });
    try {
      const tenant = `replacement-status-${Date.now()}`;
      const [{ id: userId }] = await postgres<{ id: number }[]>`INSERT INTO users (tenant_id, email, name) VALUES (${tenant}, ${`${tenant}@example.test`}, 'Status Test') RETURNING id`;
      const [{ id: borrowerId }] = await postgres<{ id: number }[]>`INSERT INTO borrowers (tenant_id, owner_user_id, name) VALUES (${tenant}, ${userId}, 'Status Borrower') RETURNING id`;
      const statuses = ["draft", "active", "paid", "defaulted", "closed", "renewed", "restructured", "cancelled", "settled", "reversed", "replaced"];
      for (const status of statuses) {
        await postgres`INSERT INTO loans (tenant_id, owner_user_id, borrower_id, principal_amount, interest_rate, repayment_type, term_months, status) VALUES (${tenant}, ${userId}, ${borrowerId}, '100.00', '0.00', 'daily', 1, ${status})`;
      }
      const rows = await postgres<{ status: string }[]>`SELECT status FROM loans WHERE tenant_id = ${tenant} ORDER BY id`;
      expect(rows.map((row) => row.status)).toEqual(statuses);
    } finally {
      await postgres.end();
    }
  });
});
