import { describe, expect, test } from "bun:test";

const root = new URL("../../", import.meta.url).pathname;
test("bank drawdown migration is additive and registers lifecycle metadata", async () => {
    const sql = await Bun.file(`${root}drizzle/0040_bank_drawdown_command_hardening.sql`).text();
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "idempotency_key"');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "request_id"');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "correlation_id"');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "activation_idempotency_key"');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "activation_request_hash"');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "activation_result"');
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "bank_loans_tenant_activation_idempotency_unique"');
    expect(sql).toContain("IF NOT EXISTS (SELECT 1 FROM pg_constraint");
    expect(sql.match(/CREATE UNIQUE INDEX IF NOT EXISTS/g)?.length).toBeGreaterThanOrEqual(2);
    expect(sql).toContain("bank_loans_status_check");
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b/i);
});

const integrationTest = process.env.TEST_DATABASE_URL ? test : test.skip;
integrationTest("executes the hardening migration idempotently and exposes its schema behavior", async () => {
    const postgres = (await import("postgres")).default(process.env.TEST_DATABASE_URL!, { max: 1 });
    try {
        for (const statement of (await Bun.file(`${root}drizzle/0040_bank_drawdown_command_hardening.sql`).text()).split("--> statement-breakpoint")) {
            if (statement.trim()) await postgres.unsafe(statement);
        }
        const columns = await postgres<{ column_name: string }[]>`SELECT column_name FROM information_schema.columns WHERE table_name = 'bank_loans' AND column_name IN ('idempotency_key','request_id','correlation_id','activation_idempotency_key','activation_request_hash','activation_result')`;
        expect(columns.map((row) => row.column_name).sort()).toEqual(['activation_idempotency_key','activation_request_hash','activation_result','correlation_id','idempotency_key','request_id']);
        const indexes = await postgres<{ indexname: string }[]>`SELECT indexname FROM pg_indexes WHERE tablename = 'bank_loans' AND indexname IN ('bank_loans_tenant_idempotency_unique','bank_loans_tenant_activation_idempotency_unique')`;
        expect(indexes.map((row) => row.indexname).sort()).toEqual(['bank_loans_tenant_activation_idempotency_unique','bank_loans_tenant_idempotency_unique']);
        await expect(postgres.unsafe(`INSERT INTO bank_loans (tenant_id, amount, status, idempotency_key) VALUES ('migration-test', 1, 'invalid', 'migration-test')`)).rejects.toBeDefined();
    } finally { await postgres.end(); }
});
