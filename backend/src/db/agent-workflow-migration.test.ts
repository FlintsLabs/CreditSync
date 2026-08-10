import { describe, expect, test } from "bun:test";
import { readMigrationFiles } from "drizzle-orm/migrator";

const migrationTag = "0008_agent_workflow_foundation";
const backendRoot = new URL("../../", import.meta.url).pathname;
const migrationPath = `${backendRoot}drizzle/${migrationTag}.sql`;
const evidenceExpiryMigrationPath = `${backendRoot}drizzle/0010_payment_evidence_expiry.sql`;
const journalPath = `${backendRoot}drizzle/meta/_journal.json`;

async function migrationSql(): Promise<string> {
    const file = Bun.file(migrationPath);
    expect(await file.exists(), `${migrationTag}.sql must exist`).toBe(true);
    return file.text();
}

describe("agent workflow migration contract", () => {
    test("adds exact evidence upload expiry with an additive registered migration", async () => {
        const journal = await Bun.file(journalPath).json() as { entries: Array<{ idx: number; tag: string }> };
        expect(journal.entries.find((entry) => entry.tag === "0010_payment_evidence_expiry"))
            .toMatchObject({ idx: 10, tag: "0010_payment_evidence_expiry" });
        const migration = await Bun.file(evidenceExpiryMigrationPath).text();
        expect(migration).toContain('ALTER TABLE "payment_evidence" ADD COLUMN "upload_expires_at" timestamp');
        expect(migration).not.toMatch(/\bDROP\b/i);
    });
    test("registers one Drizzle migration after 0007", async () => {
        const journal = await Bun.file(journalPath).json() as {
            entries: Array<{ idx: number; tag: string }>;
        };
        const entries = journal.entries.filter((entry) => entry.tag === migrationTag);

        expect(entries).toHaveLength(1);
        const workflowIndex = journal.entries.findIndex((entry) => entry.tag === migrationTag);
        expect(entries[0]?.idx).toBe(8);
        expect(journal.entries[workflowIndex - 1]?.tag).toBe("0007_user_record_visibility");
    });

    test("is additive and preserves legacy transaction columns", async () => {
        const sql = await migrationSql();

        expect(sql).not.toMatch(/\bDROP\s+(?:TABLE|COLUMN)\b/i);
        expect(sql).not.toMatch(/\bTRUNCATE\b/i);
        expect(sql).not.toMatch(/\bALTER\s+TABLE\s+"(?:loans|loan_schedules)"\b/i);
        expect(sql).toContain('ALTER TABLE "transactions" ADD COLUMN "payment_intake_id"');
        expect(sql).not.toContain('DROP COLUMN "slip_url"');
        expect(sql).not.toContain('DROP COLUMN "type"');
    });

    test("backfills one posted legacy intake per transaction and legacy slip evidence", async () => {
        const sql = await migrationSql();

        expect(sql).toMatch(/INSERT INTO "payment_intakes"[\s\S]+FROM "transactions"/);
        expect(sql).toMatch(/'legacy'[\s\S]+'posted'/);
        expect(sql).toMatch(/UPDATE "transactions"[\s\S]+"payment_intake_id"/);
        expect(sql).toMatch(/INSERT INTO "payment_evidence"[\s\S]+"slip_url" IS NOT NULL/);
        expect(sql).toMatch(/ALTER COLUMN "posted_at" SET DEFAULT now\(\)[\s\S]+ALTER COLUMN "posted_at" SET NOT NULL/);
    });

    test("installs a trigger that rejects both audit-log updates and deletes", async () => {
        const sql = await migrationSql();

        expect(sql).toContain('BEFORE UPDATE OR DELETE ON "audit_logs"');
        expect(sql).toMatch(/RAISE EXCEPTION[^;]+append-only/i);
    });

    test("enforces workflow status and actor-source vocabularies in PostgreSQL", async () => {
        const sql = await migrationSql();

        for (const constraint of [
            "borrower_aliases_status_check",
            "payment_intakes_status_check",
            "payment_evidence_status_check",
            "payment_match_proposals_status_check",
            "payment_match_allocations_status_check",
            "loan_renewals_status_check",
            "loan_adjustments_status_check",
            "audit_logs_actor_source_check",
        ]) {
            expect(sql).toContain(`CONSTRAINT "${constraint}" CHECK`);
        }
    });
});

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

if (!testDatabaseUrl) {
    test.skip("PostgreSQL migration integration (TEST_DATABASE_URL is not set)", () => {});
} else {
    test("PostgreSQL migration integration against disposable database", async () => {
        const postgres = (await import("postgres")).default;
        const { migrate } = await import("drizzle-orm/postgres-js/migrator");
        const { drizzle } = await import("drizzle-orm/postgres-js");
        const sql = postgres(testDatabaseUrl, { max: 1 });

        const postgresError = async (query: PromiseLike<unknown>): Promise<unknown> => {
            try {
                await query;
                return undefined;
            } catch (error) {
                return error;
            }
        };

        const applySqlFile = async (path: string) => {
            const content = await Bun.file(path).text();
            for (const statement of content.split("--> statement-breakpoint")) {
                if (statement.trim()) await sql.unsafe(statement);
            }
        };

        try {
            // The suite migrates its disposable database before running tests. Recreate
            // the schema here so this migration contract owns its required 0000 state.
            await sql.unsafe("DROP SCHEMA public CASCADE");
            await sql.unsafe("DROP SCHEMA drizzle CASCADE");
            await sql.unsafe("CREATE SCHEMA public");
            const existingTables = await sql<{ count: string }[]>`
                SELECT count(*)::text AS count
                FROM information_schema.tables
                WHERE table_schema = 'public'
                  AND table_type = 'BASE TABLE'
            `;
            expect(existingTables[0]?.count).toBe("0");

            await migrate(drizzle(sql), { migrationsFolder: `${backendRoot}drizzle` });

            const workflowTables = await sql<{ table_name: string }[]>`
                SELECT table_name
                FROM information_schema.tables
                WHERE table_schema = 'public'
                  AND table_name IN (
                    'borrower_aliases', 'payment_intakes', 'payment_evidence',
                    'payment_match_proposals', 'payment_match_allocations',
                    'loan_renewals', 'loan_adjustments'
                  )
            `;
            expect(workflowTables).toHaveLength(7);

            await migrate(drizzle(sql), { migrationsFolder: `${backendRoot}drizzle` });
            const workflowMigration = readMigrationFiles({ migrationsFolder: `${backendRoot}drizzle` })[8];
            expect(workflowMigration).toBeDefined();
            const applied = await sql<{ count: string }[]>`
                SELECT count(*)::text AS count
                FROM drizzle.__drizzle_migrations
                WHERE hash = ${workflowMigration!.hash}
            `;
            expect(applied[0]?.count).toBe("1");

            // Rebuild the disposable database at the 0007 boundary so the additive
            // migration can be exercised with legacy rows.
            await sql.unsafe("DROP SCHEMA public CASCADE");
            await sql.unsafe("DROP SCHEMA drizzle CASCADE");
            await sql.unsafe("CREATE SCHEMA public");
            for (let migration = 0; migration <= 7; migration += 1) {
                const prefix = migration.toString().padStart(4, "0");
                const file = Array.from(
                    new Bun.Glob(`${prefix}_*.sql`).scanSync(`${backendRoot}drizzle`),
                );
                expect(file).toHaveLength(1);
                await applySqlFile(`${backendRoot}drizzle/${file[0]}`);
            }

            await sql.unsafe(`
                INSERT INTO users (tenant_id, email, name, role)
                VALUES
                    ('tenant-a', 'task2-a@example.test', 'Task 2 A', 'owner'),
                    ('tenant-b', 'task2-b@example.test', 'Task 2 B', 'owner');
                INSERT INTO borrowers (tenant_id, owner_user_id, name)
                SELECT 'tenant-a', id, 'Legacy Borrower' FROM users WHERE email = 'task2-a@example.test';
                INSERT INTO loans (
                    tenant_id, owner_user_id, borrower_id, principal_amount,
                    interest_rate, repayment_type, installment_amount,
                    total_installments, grace_period_days, late_fee_mode,
                    late_fee_amount, start_date, next_due_date,
                    outstanding_principal, outstanding_interest,
                    outstanding_fees, status, cloned_from_loan_id
                )
                SELECT 'tenant-a', u.id, b.id, 1000, 10, 'daily', 190,
                       6, 2, 'fixed', 15, DATE '2026-08-01', DATE '2026-08-10',
                       810, 90, 15, 'active', 77
                FROM users u JOIN borrowers b ON b.tenant_id = u.tenant_id
                WHERE u.email = 'task2-a@example.test';
                INSERT INTO loan_schedules (
                    tenant_id, loan_id, installment_no, due_date,
                    scheduled_principal, scheduled_interest, scheduled_fee,
                    scheduled_total, paid_total, paid_penalty, overdue_days,
                    remaining_due, status
                )
                SELECT 'tenant-a', id, 1, DATE '2026-08-10',
                       150, 30, 10, 190, 75, 5, 3, 115, 'partial'
                FROM loans;
                INSERT INTO transactions (
                    tenant_id, owner_user_id, loan_id, amount, type, slip_url,
                    transaction_date, recorded_by_user_id
                )
                SELECT 'tenant-a', u.id, l.id, 190, 'repayment', 'legacy/slip.jpg',
                       TIMESTAMP '2026-08-09 10:00:00', u.id
                FROM users u JOIN loans l ON l.tenant_id = u.tenant_id
                WHERE u.email = 'task2-a@example.test';
                INSERT INTO transactions (
                    tenant_id, owner_user_id, loan_id, amount, type,
                    transaction_date, recorded_by_user_id
                )
                SELECT 'tenant-a', owner.id, l.id, 110, 'repayment',
                       TIMESTAMP '2026-08-09 11:00:00', recorder.id
                FROM users owner
                JOIN loans l ON l.tenant_id = owner.tenant_id
                CROSS JOIN users recorder
                WHERE owner.email = 'task2-a@example.test'
                  AND recorder.email = 'task2-b@example.test';
                CREATE TABLE task2_before_loans AS SELECT * FROM loans;
                CREATE TABLE task2_before_schedules AS SELECT * FROM loan_schedules;
            `);

            await applySqlFile(migrationPath);

            const backfill = await sql<{
                intakes: number;
                evidence: number;
                linked: number;
                transactionTotal: string;
                intakeTotal: string;
                sanitizedActors: number;
                loanDifferences: number;
                scheduleDifferences: number;
            }[]>`
                SELECT
                    (SELECT count(*)::int FROM payment_intakes WHERE source = 'legacy' AND status = 'posted') AS intakes,
                    (SELECT count(*)::int FROM payment_evidence WHERE evidence_type = 'legacy_slip') AS evidence,
                    (SELECT count(*)::int FROM transactions WHERE payment_intake_id IS NOT NULL AND posted_at IS NOT NULL) AS linked,
                    (SELECT sum(amount)::text FROM transactions WHERE entry_type = 'repayment') AS "transactionTotal",
                    (SELECT sum(amount)::text FROM payment_intakes WHERE source = 'legacy') AS "intakeTotal",
                    (SELECT count(*)::int FROM payment_intakes
                     WHERE source = 'legacy' AND amount = 110
                       AND created_by_user_id IS NULL
                       AND updated_by_user_id IS NULL
                       AND posted_by_user_id IS NULL) AS "sanitizedActors",
                    (SELECT count(*)::int FROM (
                        (SELECT * FROM task2_before_loans EXCEPT ALL SELECT * FROM loans)
                        UNION ALL
                        (SELECT * FROM loans EXCEPT ALL SELECT * FROM task2_before_loans)
                    ) AS loan_diff) AS "loanDifferences",
                    (SELECT count(*)::int FROM (
                        (SELECT * FROM task2_before_schedules EXCEPT ALL SELECT * FROM loan_schedules)
                        UNION ALL
                        (SELECT * FROM loan_schedules EXCEPT ALL SELECT * FROM task2_before_schedules)
                    ) AS schedule_diff) AS "scheduleDifferences"
            `;
            expect(backfill[0]).toEqual({
                intakes: 2,
                evidence: 1,
                linked: 2,
                transactionTotal: "300",
                intakeTotal: "300",
                sanitizedActors: 1,
                loanDifferences: 0,
                scheduleDifferences: 0,
            });

            await sql.unsafe(`
                INSERT INTO borrowers (tenant_id, owner_user_id, name)
                SELECT 'tenant-a', id, 'Second Borrower' FROM users WHERE email = 'task2-a@example.test';
                INSERT INTO borrower_aliases (
                    tenant_id, borrower_id, alias, normalized_alias, status, created_by_user_id
                )
                SELECT b.tenant_id, b.id, 'Lek', 'lek', 'confirmed', u.id
                FROM borrowers b JOIN users u ON u.tenant_id = b.tenant_id;
            `);
            const ambiguousAlias = await sql<{ count: number }[]>`
                SELECT count(*)::int AS count FROM borrower_aliases WHERE normalized_alias = 'lek'
            `;
            expect(ambiguousAlias[0]?.count).toBe(2);
            expect(await postgresError(sql.unsafe(`
                INSERT INTO borrower_aliases (
                    tenant_id, borrower_id, alias, normalized_alias, status
                )
                SELECT tenant_id, id, 'LEK', 'lek', 'confirmed'
                FROM borrowers ORDER BY id LIMIT 1
            `))).toBeDefined();

            await sql.unsafe(`
                INSERT INTO borrowers (tenant_id, owner_user_id, name)
                SELECT 'tenant-b', id, 'Tenant B Borrower'
                FROM users WHERE email = 'task2-b@example.test';
                INSERT INTO loans (
                    tenant_id, owner_user_id, borrower_id, principal_amount,
                    interest_rate, repayment_type, status
                )
                SELECT 'tenant-b', u.id, b.id, 500, 10, 'daily', 'active'
                FROM users u JOIN borrowers b ON b.tenant_id = u.tenant_id
                WHERE u.email = 'task2-b@example.test';
                INSERT INTO loan_schedules (
                    tenant_id, loan_id, installment_no, due_date,
                    scheduled_total, remaining_due, status
                )
                SELECT 'tenant-b', id, 1, DATE '2026-08-10', 550, 550, 'pending'
                FROM loans WHERE tenant_id = 'tenant-b';

                INSERT INTO payment_intakes (tenant_id, source, status, amount, idempotency_key)
                VALUES
                    ('tenant-a', 'web', 'draft', 10, 'shared-intake-key'),
                    ('tenant-b', 'web', 'draft', 10, 'shared-intake-key');
                INSERT INTO payment_intakes (tenant_id, source, status, amount, bank_reference_hash)
                VALUES
                    ('tenant-a', 'web', 'draft', 11, 'shared-bank-hash'),
                    ('tenant-b', 'web', 'draft', 11, 'shared-bank-hash');
                INSERT INTO payment_intakes (tenant_id, source, status, amount, qr_payload_hash)
                VALUES
                    ('tenant-a', 'web', 'draft', 12, 'shared-qr-hash'),
                    ('tenant-b', 'web', 'draft', 12, 'shared-qr-hash');
            `);
            expect(await postgresError(sql`
                INSERT INTO payment_intakes (tenant_id, source, status, amount, idempotency_key)
                VALUES ('tenant-a', 'web', 'draft', 10, 'shared-intake-key')
            `)).toBeDefined();
            expect(await postgresError(sql`
                INSERT INTO payment_intakes (tenant_id, source, status, amount, bank_reference_hash)
                VALUES ('tenant-a', 'web', 'draft', 11, 'shared-bank-hash')
            `)).toBeDefined();
            expect(await postgresError(sql`
                INSERT INTO payment_intakes (tenant_id, source, status, amount, qr_payload_hash)
                VALUES ('tenant-a', 'web', 'draft', 12, 'shared-qr-hash')
            `)).toBeDefined();

            await sql.unsafe(`
                INSERT INTO payment_evidence (
                    tenant_id, payment_intake_id, evidence_type, status, evidence_hash
                )
                SELECT tenant_id, id, 'slip', 'ready', 'shared-evidence-hash'
                FROM payment_intakes
                WHERE idempotency_key = 'shared-intake-key';
            `);
            expect(await postgresError(sql.unsafe(`
                INSERT INTO payment_evidence (
                    tenant_id, payment_intake_id, evidence_type, status, evidence_hash
                )
                SELECT tenant_id, id, 'slip', 'ready', 'shared-evidence-hash'
                FROM payment_intakes
                WHERE tenant_id = 'tenant-a' AND idempotency_key = 'shared-intake-key'
            `))).toBeDefined();

            await sql.unsafe(`
                INSERT INTO transactions (tenant_id, loan_id, amount, idempotency_key)
                SELECT tenant_id, id, 1, 'shared-transaction-key'
                FROM loans WHERE tenant_id IN ('tenant-a', 'tenant-b');
            `);
            expect(await postgresError(sql.unsafe(`
                INSERT INTO transactions (tenant_id, loan_id, amount, idempotency_key)
                SELECT tenant_id, id, 1, 'shared-transaction-key'
                FROM loans WHERE tenant_id = 'tenant-a'
            `))).toBeDefined();

            await sql.unsafe(`
                INSERT INTO loan_renewals (
                    tenant_id, old_loan_id, status, preview_hash,
                    requested_principal, outstanding_principal,
                    idempotency_key, expires_at
                )
                SELECT tenant_id, id, 'preview', 'preview-' || tenant_id,
                       principal_amount, outstanding_principal,
                       'shared-renewal-key', now() + interval '1 hour'
                FROM loans WHERE tenant_id IN ('tenant-a', 'tenant-b');
            `);
            expect(await postgresError(sql.unsafe(`
                INSERT INTO loan_renewals (
                    tenant_id, old_loan_id, status, preview_hash,
                    requested_principal, outstanding_principal,
                    idempotency_key, expires_at
                )
                SELECT tenant_id, id, 'preview', 'duplicate-preview',
                       principal_amount, outstanding_principal,
                       'shared-renewal-key', now() + interval '1 hour'
                FROM loans WHERE tenant_id = 'tenant-a'
            `))).toBeDefined();

            await sql.unsafe(`
                INSERT INTO loan_adjustments (
                    tenant_id, loan_id, adjustment_type, amount, idempotency_key
                )
                SELECT tenant_id, id, 'cash_payout', 1, 'shared-adjustment-key'
                FROM loans WHERE tenant_id IN ('tenant-a', 'tenant-b');
            `);
            expect(await postgresError(sql.unsafe(`
                INSERT INTO loan_adjustments (
                    tenant_id, loan_id, adjustment_type, amount, idempotency_key
                )
                SELECT tenant_id, id, 'cash_payout', 1, 'shared-adjustment-key'
                FROM loans WHERE tenant_id = 'tenant-a'
            `))).toBeDefined();

            const original = await sql<{ id: number; tenant_id: string; loan_id: number }[]>`
                SELECT id, tenant_id, loan_id
                FROM transactions
                WHERE tenant_id = 'tenant-a' AND idempotency_key LIKE 'legacy-transaction:%'
                ORDER BY id LIMIT 1
            `;
            const tenantBLoan = await sql<{ id: number }[]>`
                SELECT id FROM loans WHERE tenant_id = 'tenant-b'
            `;
            expect(await postgresError(sql`
                INSERT INTO transactions (
                    tenant_id, loan_id, amount, entry_type,
                    reversed_transaction_id, idempotency_key, posted_at
                ) VALUES (
                    'tenant-b', ${tenantBLoan[0]!.id}, -190,
                    'reversal', ${original[0]!.id}, 'cross-tenant-reverse', now()
                )
            `)).toBeDefined();
            await sql`
                INSERT INTO transactions (
                    tenant_id, loan_id, amount, entry_type,
                    reversed_transaction_id, idempotency_key, posted_at
                ) VALUES (
                    ${original[0]!.tenant_id}, ${original[0]!.loan_id}, -190,
                    'reversal', ${original[0]!.id}, 'reverse-1', now()
                )
            `;
            expect(await postgresError(sql`
                INSERT INTO transactions (
                    tenant_id, loan_id, amount, entry_type,
                    reversed_transaction_id, idempotency_key, posted_at
                ) VALUES (
                    ${original[0]!.tenant_id}, ${original[0]!.loan_id}, -190,
                    'reversal', ${original[0]!.id}, 'reverse-2', now()
                )
            `)).toBeDefined();

            const originalAdjustment = await sql<{ id: number; loan_id: number }[]>`
                SELECT id, loan_id
                FROM loan_adjustments
                WHERE tenant_id = 'tenant-a' AND idempotency_key = 'shared-adjustment-key'
            `;
            expect(await postgresError(sql`
                INSERT INTO loan_adjustments (
                    tenant_id, loan_id, adjustment_type, amount,
                    reversed_adjustment_id, idempotency_key
                ) VALUES (
                    'tenant-b', ${tenantBLoan[0]!.id}, 'reversal', -1,
                    ${originalAdjustment[0]!.id}, 'cross-tenant-adjustment-reverse'
                )
            `)).toBeDefined();
            await sql`
                INSERT INTO loan_adjustments (
                    tenant_id, loan_id, adjustment_type, amount,
                    reversed_adjustment_id, idempotency_key
                ) VALUES (
                    'tenant-a', ${originalAdjustment[0]!.loan_id}, 'reversal', -1,
                    ${originalAdjustment[0]!.id}, 'adjustment-reverse-1'
                )
            `;
            expect(await postgresError(sql`
                INSERT INTO loan_adjustments (
                    tenant_id, loan_id, adjustment_type, amount,
                    reversed_adjustment_id, idempotency_key
                ) VALUES (
                    'tenant-a', ${originalAdjustment[0]!.loan_id}, 'reversal', -1,
                    ${originalAdjustment[0]!.id}, 'adjustment-reverse-2'
                )
            `)).toBeDefined();

            await sql`
                INSERT INTO audit_logs (tenant_id, entity_type, entity_id, action)
                VALUES ('tenant-a', 'transaction', '1', 'created')
            `;
            expect(String(await postgresError(sql`UPDATE audit_logs SET action = 'changed'`))).toMatch(/append-only/);
            expect(String(await postgresError(sql`DELETE FROM audit_logs`))).toMatch(/append-only/);

            // Leave the shared disposable target in the same fully migrated state
            // required by the rest of the integration suite.
            await sql.unsafe("DROP SCHEMA public CASCADE");
            await sql.unsafe("DROP SCHEMA IF EXISTS drizzle CASCADE");
            await sql.unsafe("CREATE SCHEMA public");
            await migrate(drizzle(sql), { migrationsFolder: `${backendRoot}drizzle` });
            const latestTables = await sql<{ count: string }[]>`
                SELECT count(*)::text AS count
                FROM information_schema.tables
                WHERE table_schema = 'public'
                  AND table_name = 'loan_disbursements'
            `;
            expect(latestTables[0]?.count).toBe("1");
        } finally {
            await sql.end();
        }
    }, 60_000);
}
