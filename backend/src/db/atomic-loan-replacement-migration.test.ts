import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import { db } from ".";
import { auditLogs, loanReplacementCorrections, loanReplacements } from "./schema";
import { isLoanReplacementProposal } from "../lib/loan-replacement-proposal";
import { resetReplacementDatabase, seedReplacementFixture } from "../services/loan-replacement-test-fixture";

const integrationTest = process.env.TEST_DATABASE_URL ? test : test.skip;

const root = join(import.meta.dir, "../../drizzle");

async function expectDatabaseCode(promise: PromiseLike<unknown>, code: string): Promise<void> {
  await expect(Promise.resolve(promise)).rejects.toMatchObject({ cause: { code } });
}

describe("atomic loan replacement migration contract", () => {
  test("declares the replacement ledger and terminal status", () => {
    const sql = readFileSync(join(root, "0042_atomic_loan_replacement.sql"), "utf8");
    expect(sql).toContain('CREATE TABLE "loan_replacements"');
    expect(sql).toContain('CREATE TABLE "loan_replacement_corrections"');
    expect(sql).toContain("status IN ('preview', 'executed', 'reversed', 'expired')");
    expect(sql).toContain("'replaced'");
    expect(sql).toContain("loan_replacements_tenant_old_loan_fk");
    expect(sql).toContain("loan_replacements_tenant_replacement_loan_fk");
    expect(sql).toContain("'draft', 'active', 'paid', 'defaulted', 'closed', 'renewed', 'restructured', 'cancelled', 'canceled', 'settled', 'reversed', 'replaced'");
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

  test("contains the forward repair for the rate-period status column", () => {
    const migration = readFileSync(join(root, "0043_loan_interest_rate_period_status.sql"), "utf8");
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS "status" text DEFAULT \'posted\' NOT NULL');
    expect(migration).not.toContain("DROP TABLE");
  });

  // Break caught: replacement execution/reversal idempotency and lifecycle evidence exist only in an in-memory snapshot, making retries and database immutability unverifiable.
  test("adds a forward-only replacement lifecycle hardening migration", () => {
    const migration = readFileSync(join(root, "0044_atomic_loan_replacement_hardening.sql"), "utf8");
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS "execute_request_hash"');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS "reversal_request_hash"');
    expect(migration).toContain('loan_replacements_lifecycle_check');
    expect(migration).toContain('loan_replacements_immutable');
    expect(migration).toContain('loan_replacement_corrections_immutable');
  });

  // Break caught: the service returns a transient proposal that cannot be reproduced from the persisted command aggregate.
  test("journals the canonical proposal and audit-FK migration after lifecycle hardening", () => {
    const migration = readFileSync(join(root, "0045_atomic_loan_replacement_proposal.sql"), "utf8");
    const journal = readFileSync(join(root, "meta/_journal.json"), "utf8");
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS "preview_as_of_date" date');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS "preview_snapshot" jsonb');
    expect(migration).toContain('loan_replacements_preview_snapshot_check');
    expect(migration).toContain('loan_replacements_tenant_executed_audit_fk');
    expect(migration).toContain('loan_replacements_tenant_reversed_audit_fk');
    expect(migration).toContain("'schemaVersion', 0");
    expect(migration).toContain("WHEN \"status\" = 'preview' THEN 'expired'");
    const disableImmutableTrigger = migration.indexOf('DISABLE TRIGGER "loan_replacements_immutable"');
    const proposalBackfill = migration.indexOf('UPDATE "loan_replacements"');
    const enableImmutableTrigger = migration.indexOf('ENABLE TRIGGER "loan_replacements_immutable"');
    expect(disableImmutableTrigger).toBeGreaterThan(-1);
    expect(proposalBackfill).toBeGreaterThan(disableImmutableTrigger);
    expect(enableImmutableTrigger).toBeGreaterThan(proposalBackfill);
    expect(journal.indexOf('"tag": "0045_atomic_loan_replacement_proposal"')).toBeGreaterThan(
      journal.indexOf('"tag": "0044_atomic_loan_replacement_hardening"'),
    );
  });

  // Break caught: 0044 makes executed/reversed aggregates immutable before 0045 tries to
  // backfill their canonical proposal, so an upgrade with real replacement history aborts.
  integrationTest("upgrades an immutable executed replacement through the canonical proposal backfill", async () => {
    await resetReplacementDatabase();
    const fixture = await seedReplacementFixture();
    const preview = await fixture.preview();
    await fixture.execute(preview);
    const record = await db.query.loanReplacements.findFirst({
      where: eq(loanReplacements.publicId, preview.publicId),
    });
    expect(record).toMatchObject({ status: "executed" });

    const legacyPreviewFixture = await seedReplacementFixture({ tenantId: "legacy-preview-upgrade" });
    const legacyPreview = await legacyPreviewFixture.preview("Legacy preview must fail closed");
    const legacyPreviewRecord = await db.query.loanReplacements.findFirst({
      where: eq(loanReplacements.publicId, legacyPreview.publicId),
    });
    expect(legacyPreviewRecord).toMatchObject({ status: "preview" });

    const migration = readFileSync(join(root, "0045_atomic_loan_replacement_proposal.sql"), "utf8");
    const statements = migration.split("--> statement-breakpoint")
      .map((statement) => statement.trim())
      .filter(Boolean);
    await db.transaction(async (tx) => {
      await tx.execute(sql.raw('ALTER TABLE "loan_replacements" DROP CONSTRAINT IF EXISTS "loan_replacements_preview_snapshot_check"'));
      await tx.execute(sql.raw('ALTER TABLE "loan_replacements" ALTER COLUMN "preview_as_of_date" DROP NOT NULL, ALTER COLUMN "preview_snapshot" DROP NOT NULL'));
      await tx.execute(sql.raw('ALTER TABLE "loan_replacements" DISABLE TRIGGER "loan_replacements_immutable"'));
      await tx.execute(sql`UPDATE loan_replacements
        SET preview_as_of_date = NULL, preview_snapshot = NULL
        WHERE id = ${record!.id}`);
      await tx.execute(sql`UPDATE loan_replacements
        SET preview_as_of_date = NULL, preview_snapshot = NULL
        WHERE id = ${legacyPreviewRecord!.id}`);
      await tx.execute(sql.raw('ALTER TABLE "loan_replacements" ENABLE TRIGGER "loan_replacements_immutable"'));
      for (const statement of statements) await tx.execute(sql.raw(statement));
    });

    const upgraded = await db.query.loanReplacements.findFirst({
      where: eq(loanReplacements.id, record!.id),
    });
    expect(upgraded).toMatchObject({
      status: "executed",
      previewAsOfDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      previewSnapshot: {
        schemaVersion: 0,
        asOfDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        reason: record!.reason,
        legacy: true,
        proposalUnavailable: true,
      },
    });
    const upgradedLegacyPreview = await db.query.loanReplacements.findFirst({
      where: eq(loanReplacements.id, legacyPreviewRecord!.id),
    });
    expect(upgradedLegacyPreview).toMatchObject({
      status: "expired",
      previewSnapshot: {
        schemaVersion: 0,
        reason: legacyPreviewRecord!.reason,
        legacy: true,
        proposalUnavailable: true,
      },
    });
    await expectDatabaseCode(db.update(loanReplacements).set({ reason: "mutated" }).where(eq(
      loanReplacements.id,
      record!.id,
    )), "P0001");
  });

  // Break caught: transaction-scoped financial helpers silently accept `any`, so lock and
  // rollback guarantees can be bypassed without a compiler error.
  test("keeps replacement and adjacent writer transaction boundaries explicitly typed", () => {
    const sourceRoot = join(import.meta.dir, "..");
    const dbSource = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
    expect(dbSource).toContain("export type DbTransaction");
    expect(dbSource).toContain("export type DbExecutor");

    const transactionSources = [
      "services/loan-replacement-service.ts",
      "services/loan-application-service.ts",
      "services/loan-funding-service.ts",
      "services/loan-disbursement-service.ts",
      "services/loan-waiver-service.ts",
      "services/intermediary-service.ts",
      "services/intermediary-profile-service.ts",
      "services/loan-commission-service.ts",
    ].map((path) => [path, readFileSync(join(sourceRoot, path), "utf8")] as const);
    const unsafeExecutorPattern = /:\s*any\b|\bas\s+any\b|Array<any>|type\s+\w+\s*=\s*any\b/;
    for (const [path, source] of transactionSources) {
      expect(source, `${path} must not erase transaction types`).not.toMatch(unsafeExecutorPattern);
    }
  });

  // Break caught: a shallow object with only a few headline fields is accepted as the full
  // authoritative financial proposal and later consumed during execution.
  test("rejects structurally incomplete canonical replacement proposals in application code", () => {
    expect(isLoanReplacementProposal({
      schemaVersion: 1,
      asOfDate: "2026-08-17",
      reason: "Incomplete",
      oldLoan: { loanPublicId: crypto.randomUUID() },
      replacement: { loanPublicId: crypto.randomUUID() },
      correction: { principal: "0.00" },
      cash: { direction: "none", amount: "0.00" },
      warnings: [],
    })).toBe(false);
  });

  integrationTest("rejects invalid lifecycle and canonical proposal combinations at the database boundary", async () => {
    await resetReplacementDatabase();
    const fixture = await seedReplacementFixture();
    const preview = await fixture.preview();
    const record = await db.query.loanReplacements.findFirst({
      where: eq(loanReplacements.publicId, preview.publicId),
    });
    expect(record).toBeDefined();

    await expectDatabaseCode(db.update(loanReplacements).set({ status: "executed" }).where(and(
      eq(loanReplacements.tenantId, fixture.tenantId),
      eq(loanReplacements.id, record!.id),
    )), "23514");
    await expectDatabaseCode(db.execute(sql`UPDATE loan_replacements
      SET preview_as_of_date = '2026-08-18'
      WHERE tenant_id = ${fixture.tenantId} AND id = ${record!.id}`), "23514");
    await expectDatabaseCode(db.execute(sql`UPDATE loan_replacements
      SET preview_snapshot = NULL
      WHERE tenant_id = ${fixture.tenantId} AND id = ${record!.id}`), "23502");
    const incompleteProposal = JSON.stringify({
      schemaVersion: 1,
      asOfDate: preview.asOfDate,
      reason: record!.reason,
    });
    await expectDatabaseCode(db.execute(sql`UPDATE loan_replacements
      SET preview_snapshot = ${incompleteProposal}::jsonb
      WHERE tenant_id = ${fixture.tenantId} AND id = ${record!.id}`), "23514");

    if (!isLoanReplacementProposal(record!.previewSnapshot)) {
      throw new Error("Fixture did not persist a canonical proposal");
    }
    const canonical = record!.previewSnapshot;
    const malformedProposals: unknown[] = [
      { ...canonical, schemaVersion: "1" },
      { ...canonical, replacement: { ...canonical.replacement, termMonths: 0 } },
      { ...canonical, replacement: { ...canonical.replacement, totalInstallments: 1.5 } },
      {
        ...canonical,
        oldLoan: {
          ...canonical.oldLoan,
          collectibleBefore: { ...canonical.oldLoan.collectibleBefore, nextDueDate: "tomorrow" },
        },
      },
      { ...canonical, oldLoan: { ...canonical.oldLoan, principal: "36000x00" } },
      { ...canonical, warnings: ["valid", 42] },
    ];
    for (const malformed of malformedProposals) {
      const serialized = JSON.stringify(malformed);
      await expectDatabaseCode(db.execute(sql`UPDATE loan_replacements
        SET preview_snapshot = ${serialized}::jsonb
        WHERE tenant_id = ${fixture.tenantId} AND id = ${record!.id}`), "23514");
    }
    expect(await db.query.loanReplacements.findFirst({
      where: eq(loanReplacements.id, record!.id),
    })).toMatchObject({
      status: "preview",
      previewAsOfDate: preview.asOfDate,
      previewSnapshot: record!.previewSnapshot,
    });
  });

  integrationTest("makes executed replacements and every correction row append-only", async () => {
    await resetReplacementDatabase();
    const fixture = await seedReplacementFixture();
    const preview = await fixture.preview();
    await fixture.execute(preview);
    const record = await db.query.loanReplacements.findFirst({
      where: eq(loanReplacements.publicId, preview.publicId),
    });
    const correction = await db.query.loanReplacementCorrections.findFirst({
      where: eq(loanReplacementCorrections.replacementId, record!.id),
    });
    expect(record).toMatchObject({ status: "executed" });
    expect(correction).toBeDefined();

    await expectDatabaseCode(db.update(loanReplacements).set({ reason: "mutated" }).where(eq(
      loanReplacements.id,
      record!.id,
    )), "P0001");
    await expectDatabaseCode(db.delete(loanReplacements).where(eq(
      loanReplacements.id,
      record!.id,
    )), "P0001");
    await expectDatabaseCode(db.update(loanReplacementCorrections).set({ interest: "0.01" }).where(eq(
      loanReplacementCorrections.id,
      correction!.id,
    )), "P0001");
    await expectDatabaseCode(db.delete(loanReplacementCorrections).where(eq(
      loanReplacementCorrections.id,
      correction!.id,
    )), "P0001");
  });

  integrationTest("enforces tenant-scoped loan and correction foreign keys", async () => {
    await resetReplacementDatabase();
    const first = await seedReplacementFixture({ tenantId: "replacement-fk-a" });
    const second = await seedReplacementFixture({ tenantId: "replacement-fk-b" });
    const [firstPreview, secondPreview] = await Promise.all([first.preview(), second.preview()]);
    const [firstRecord, secondRecord] = await Promise.all([
      db.query.loanReplacements.findFirst({ where: eq(loanReplacements.publicId, firstPreview.publicId) }),
      db.query.loanReplacements.findFirst({ where: eq(loanReplacements.publicId, secondPreview.publicId) }),
    ]);

    await expectDatabaseCode(db.update(loanReplacements).set({ oldLoanId: first.oldLoan.id }).where(and(
      eq(loanReplacements.tenantId, second.tenantId),
      eq(loanReplacements.id, secondRecord!.id),
    )), "23503");
    await expectDatabaseCode(db.insert(loanReplacementCorrections).values({
      tenantId: second.tenantId,
      replacementId: firstRecord!.id,
      loanId: second.oldLoan.id,
      status: "posted",
      principal: "1.00",
      reason: "Cross-tenant correction must fail",
      createdByUserId: second.actor.id,
    }), "23503");
  });

  // Break caught: a cross-tenant audit UUID satisfies lifecycle evidence because the replacement aggregate has no audit FK.
  integrationTest("requires execution and reversal audits from the same tenant", async () => {
    await resetReplacementDatabase();
    const first = await seedReplacementFixture({ tenantId: "replacement-audit-a" });
    const foreign = await seedReplacementFixture({ tenantId: "replacement-audit-b" });
    const preview = await first.preview();
    const record = await db.query.loanReplacements.findFirst({
      where: eq(loanReplacements.publicId, preview.publicId),
    });
    const foreignExecutionAudit = await db.insert(auditLogs).values({
      tenantId: foreign.tenantId,
      entityType: "loan_replacement",
      entityId: record!.publicId,
      action: "executed",
      actorSource: "system",
    }).returning().then((rows) => rows[0]!);

    await expectDatabaseCode(db.update(loanReplacements).set({
      status: "executed",
      executeIdempotencyKey: "cross-tenant-execution-audit",
      executeRequestHash: "a".repeat(64),
      executeActorSource: "system",
      executedAuditPublicId: foreignExecutionAudit.publicId,
      executedAt: new Date("2026-08-17T00:00:00.000Z"),
      preExecutionSnapshot: { old: { loan: {}, schedules: [] } },
    }).where(and(
      eq(loanReplacements.tenantId, first.tenantId),
      eq(loanReplacements.id, record!.id),
    )), "23503");

    const executed = await first.execute(preview, "valid-execution-audit");
    const foreignReversalAudit = await db.insert(auditLogs).values({
      tenantId: foreign.tenantId,
      entityType: "loan_replacement",
      entityId: executed.replacementPublicId,
      action: "reversed",
      actorSource: "system",
    }).returning().then((rows) => rows[0]!);
    await expectDatabaseCode(db.update(loanReplacements).set({
      status: "reversed",
      reversalIdempotencyKey: "cross-tenant-reversal-audit",
      reversalRequestHash: "b".repeat(64),
      reversalActorSource: "system",
      reversedAuditPublicId: foreignReversalAudit.publicId,
      reversedAt: new Date("2026-08-17T00:01:00.000Z"),
    }).where(and(
      eq(loanReplacements.tenantId, first.tenantId),
      eq(loanReplacements.id, record!.id),
    )), "23503");
  });

  integrationTest("prevents two active executions from consuming the same old loan", async () => {
    await resetReplacementDatabase();
    const first = await seedReplacementFixture({ tenantId: "replacement-unique-execution" });
    const second = await seedReplacementFixture({ tenantId: "replacement-unique-execution" });
    const [firstPreview, secondPreview] = await Promise.all([first.preview(), second.preview()]);
    await first.execute(firstPreview, "first-unique-execution");
    const secondRecord = await db.query.loanReplacements.findFirst({
      where: eq(loanReplacements.publicId, secondPreview.publicId),
    });
    await db.update(loanReplacements).set({ oldLoanId: first.oldLoan.id }).where(eq(
      loanReplacements.id,
      secondRecord!.id,
    ));
    const audit = await db.insert(auditLogs).values({
      tenantId: first.tenantId,
      entityType: "loan_replacement",
      entityId: secondRecord!.publicId,
      action: "executed",
      actorSource: "system",
    }).returning().then((rows) => rows[0]!);

    await expectDatabaseCode(db.update(loanReplacements).set({
      status: "executed",
      executeIdempotencyKey: "duplicate-old-execution",
      executeRequestHash: "c".repeat(64),
      executeActorSource: "system",
      executedAuditPublicId: audit.publicId,
      executedAt: new Date("2026-08-17T00:00:00.000Z"),
      preExecutionSnapshot: { old: { loan: {}, schedules: [] } },
    }).where(eq(loanReplacements.id, secondRecord!.id)), "23505");
  });

  integrationTest("fresh migrations expose the schema-defined rate-period status", async () => {
    const postgres = (await import("postgres")).default(process.env.TEST_DATABASE_URL!, { max: 1 });
    try {
      const rows = await postgres.unsafe("SELECT column_default, is_nullable FROM information_schema.columns WHERE table_name = 'loan_interest_rate_periods' AND column_name = 'status'") as unknown as Array<{ column_default: string; is_nullable: string }>;
      expect(rows).toEqual([{ column_default: "'posted'::text", is_nullable: "NO" }]);
    } finally { await postgres.end(); }
  });

  integrationTest("accepts every loan status used by the application on a fresh database", async () => {
    const postgres = (await import("postgres")).default(process.env.TEST_DATABASE_URL!, { max: 1 });
    try {
      const tenant = `replacement-status-${Date.now()}`;
      const [{ id: userId }] = await postgres<{ id: number }[]>`INSERT INTO users (tenant_id, email, name) VALUES (${tenant}, ${`${tenant}@example.test`}, 'Status Test') RETURNING id`;
      const [{ id: borrowerId }] = await postgres<{ id: number }[]>`INSERT INTO borrowers (tenant_id, owner_user_id, name) VALUES (${tenant}, ${userId}, 'Status Borrower') RETURNING id`;
      const statuses = ["draft", "active", "paid", "completed", "defaulted", "closed", "renewed", "restructured", "cancelled", "canceled", "settled", "reversed", "replaced"];
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
