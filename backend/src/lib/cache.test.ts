import { expect, test } from "bun:test";
import { withMcpDiagnosticScope, currentMcpDiagnosticSnapshot } from "../mcp/diagnostic-context";
import { withTenantCache } from "./cache";

test("cache fallback keeps the loader result and does not persist unsafe context", async () => {
    const result = await withMcpDiagnosticScope({
        tenantId: "cache-test-tenant", actorUserId: 1, actorSource: "mcp",
        requestId: crypto.randomUUID(), correlationId: crypto.randomUUID(),
    }, "borrower.search", async () => withTenantCache({
        tenantId: "cache-test-tenant", namespace: "diagnostic", key: "safe", loader: async () => ({ ok: true }),
    }));
    expect(result).toEqual({ ok: true });
    expect(JSON.stringify(currentMcpDiagnosticSnapshot())).not.toContain("cache-test-tenant");
});
