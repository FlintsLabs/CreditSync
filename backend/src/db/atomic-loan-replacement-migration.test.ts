import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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
    expect(sql).toContain("'draft', 'active', 'paid', 'defaulted', 'replaced'");
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
});
