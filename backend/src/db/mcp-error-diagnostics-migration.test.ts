import { expect, test } from "bun:test";
import { sql as drizzleSql } from "drizzle-orm";
import { db } from "./index";

const root = `${import.meta.dir}/../../`;

test("diagnostic migration defines bounded retention storage and tenant-safe indexes", async () => {
    const migrationSql = await Bun.file(`${root}drizzle/0064_mcp_error_diagnostics.sql`).text();
    expect(migrationSql).toContain('CREATE TABLE "mcp_diagnostic_events"');
    expect(migrationSql).toMatch(/mcp_diagnostic_events_expiry_check[\s\S]*CHECK \(expires_at > occurred_at\)/);
    expect(migrationSql).toContain('CONSTRAINT "mcp_diagnostic_events_breadcrumbs_check"');
    expect(migrationSql).toContain('mcp_diagnostic_events_tenant_correlation_idx');
    expect(migrationSql).toContain('mcp_diagnostic_events_tenant_request_idx');
    expect(migrationSql).toContain('mcp_diagnostic_events_tenant_occurred_idx');
    expect(migrationSql).toContain('mcp_diagnostic_events_expires_idx');
    const columns = await db.execute(drizzleSql`SELECT column_name FROM information_schema.columns WHERE table_name = 'mcp_diagnostic_events'`);
    expect(columns.map((row: Record<string, unknown>) => row.column_name)).toEqual(expect.arrayContaining(["tenant_id", "correlation_id", "expires_at", "breadcrumbs"]));
    const indexes = await db.execute(drizzleSql`SELECT indexname FROM pg_indexes WHERE tablename = 'mcp_diagnostic_events'`);
    expect(indexes.map((row: Record<string, unknown>) => row.indexname)).toEqual(expect.arrayContaining([
        "mcp_diagnostic_events_tenant_correlation_idx", "mcp_diagnostic_events_tenant_request_idx",
        "mcp_diagnostic_events_tenant_occurred_idx", "mcp_diagnostic_events_expires_idx",
    ]));
});
