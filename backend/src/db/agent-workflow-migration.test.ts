import { describe, expect, test } from "bun:test";

const migrationTag = "0008_agent_workflow_foundation";
const backendRoot = new URL("../../", import.meta.url).pathname;
const migrationPath = `${backendRoot}drizzle/${migrationTag}.sql`;
const journalPath = `${backendRoot}drizzle/meta/_journal.json`;

async function migrationSql(): Promise<string> {
    const file = Bun.file(migrationPath);
    expect(await file.exists(), `${migrationTag}.sql must exist`).toBe(true);
    return file.text();
}

describe("agent workflow migration contract", () => {
    test("registers one Drizzle migration after 0007", async () => {
        const journal = await Bun.file(journalPath).json() as {
            entries: Array<{ idx: number; tag: string }>;
        };
        const entries = journal.entries.filter((entry) => entry.tag === migrationTag);

        expect(entries).toHaveLength(1);
        expect(entries[0]?.idx).toBe(8);
        expect(journal.entries.at(-2)?.tag).toBe("0007_user_record_visibility");
        expect(journal.entries.at(-1)?.tag).toBe(migrationTag);
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

        const applySqlFile = async (path: string) => {
            const content = await Bun.file(path).text();
            for (const statement of content.split("--> statement-breakpoint")) {
                if (statement.trim()) await sql.unsafe(statement);
            }
        };

        try {
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
            const applied = await sql<{ count: string }[]>`
                SELECT count(*)::text AS count
                FROM drizzle.__drizzle_migrations
            `;
            expect(applied[0]?.count).toBe("9");

            // Rebuild the already-confirmed-empty disposable database at the 0007
            // boundary so the additive migration can be exercised with legacy rows.
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
                VALUES ('tenant-a', 'task2-a@example.test', 'Task 2 A', 'owner');
                INSERT INTO borrowers (tenant_id, owner_user_id, name)
                SELECT 'tenant-a', id, 'Legacy Borrower' FROM users WHERE email = 'task2-a@example.test';
                INSERT INTO loans (
                    tenant_id, owner_user_id, borrower_id, principal_amount,
                    interest_rate, repayment_type, status
                )
                SELECT 'tenant-a', u.id, b.id, 1000, 10, 'daily', 'active'
                FROM users u JOIN borrowers b ON b.tenant_id = u.tenant_id
                WHERE u.email = 'task2-a@example.test';
                INSERT INTO loan_schedules (
                    tenant_id, loan_id, installment_no, due_date,
                    scheduled_total, remaining_due, status
                )
                SELECT 'tenant-a', id, 1, DATE '2026-08-10', 1100, 1100, 'pending' FROM loans;
                INSERT INTO transactions (
                    tenant_id, owner_user_id, loan_id, amount, type, slip_url,
                    transaction_date, recorded_by_user_id
                )
                SELECT 'tenant-a', u.id, l.id, 190, 'repayment', 'legacy/slip.jpg',
                       TIMESTAMP '2026-08-09 10:00:00', u.id
                FROM users u JOIN loans l ON l.tenant_id = u.tenant_id
                WHERE u.email = 'task2-a@example.test';
                CREATE TABLE task2_before AS
                SELECT l.id AS loan_id, l.status AS loan_status,
                       s.id AS schedule_id, s.status AS schedule_status,
                       s.remaining_due
                FROM loans l JOIN loan_schedules s ON s.loan_id = l.id;
            `);

            await applySqlFile(migrationPath);

            const backfill = await sql<{
                intakes: number;
                evidence: number;
                linked: number;
                unchanged: number;
            }[]>`
                SELECT
                    (SELECT count(*)::int FROM payment_intakes WHERE source = 'legacy' AND status = 'posted') AS intakes,
                    (SELECT count(*)::int FROM payment_evidence WHERE evidence_type = 'legacy_slip') AS evidence,
                    (SELECT count(*)::int FROM transactions WHERE payment_intake_id IS NOT NULL AND posted_at IS NOT NULL) AS linked,
                    (SELECT count(*)::int
                     FROM task2_before b
                     JOIN loans l ON l.id = b.loan_id
                     JOIN loan_schedules s ON s.id = b.schedule_id
                     WHERE l.status = b.loan_status
                       AND s.status = b.schedule_status
                       AND s.remaining_due = b.remaining_due) AS unchanged
            `;
            expect(backfill[0]).toEqual({ intakes: 1, evidence: 1, linked: 1, unchanged: 1 });

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
            await expect(sql.unsafe(`
                INSERT INTO borrower_aliases (
                    tenant_id, borrower_id, alias, normalized_alias, status
                )
                SELECT tenant_id, id, 'LEK', 'lek', 'confirmed'
                FROM borrowers ORDER BY id LIMIT 1
            `)).rejects.toThrow();

            const original = await sql<{ id: number; tenant_id: string; loan_id: number }[]>`
                SELECT id, tenant_id, loan_id FROM transactions LIMIT 1
            `;
            await sql`
                INSERT INTO transactions (
                    tenant_id, loan_id, amount, entry_type,
                    reversed_transaction_id, idempotency_key, posted_at
                ) VALUES (
                    ${original[0]!.tenant_id}, ${original[0]!.loan_id}, -190,
                    'reversal', ${original[0]!.id}, 'reverse-1', now()
                )
            `;
            await expect(sql`
                INSERT INTO transactions (
                    tenant_id, loan_id, amount, entry_type,
                    reversed_transaction_id, idempotency_key, posted_at
                ) VALUES (
                    ${original[0]!.tenant_id}, ${original[0]!.loan_id}, -190,
                    'reversal', ${original[0]!.id}, 'reverse-2', now()
                )
            `).rejects.toThrow();

            await sql`
                INSERT INTO audit_logs (tenant_id, entity_type, entity_id, action)
                VALUES ('tenant-a', 'transaction', '1', 'created')
            `;
            await expect(sql`UPDATE audit_logs SET action = 'changed'`).rejects.toThrow(/append-only/);
            await expect(sql`DELETE FROM audit_logs`).rejects.toThrow(/append-only/);
        } finally {
            await sql.end();
        }
    }, 60_000);
}
