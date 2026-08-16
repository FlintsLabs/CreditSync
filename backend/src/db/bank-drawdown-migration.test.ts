import { describe, expect, test } from "bun:test";

const root = new URL("../../", import.meta.url).pathname;
test("bank drawdown migration is additive and registers lifecycle metadata", async () => {
    const sql = await Bun.file(`${root}drizzle/0040_bank_drawdown_command_hardening.sql`).text();
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "idempotency_key"');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "request_id"');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "correlation_id"');
    expect(sql).toContain("bank_loans_status_check");
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b/i);
});
