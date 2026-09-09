import { describe, expect, test } from "bun:test";
import { currentMcpDiagnosticSnapshot, recordMcpBreadcrumb, withMcpDiagnosticScope } from "./diagnostic-context";

const ctx = { tenantId: "tenant-test", actorUserId: 1, actorSource: "mcp" as const, requestId: crypto.randomUUID(), correlationId: crypto.randomUUID() };

describe("MCP diagnostic context", () => {
    test("is a no-op outside a request scope and rejects unsafe metadata", () => {
        recordMcpBreadcrumb({ stage: "handler", outcome: "failed", metadata: { token: "secret", amount: "99.00", itemCount: 2 } });
        expect(currentMcpDiagnosticSnapshot()).toBeNull();
    });

    test("bounds breadcrumbs and keeps safe fields only", async () => {
        const snapshot = await withMcpDiagnosticScope(ctx, "borrower.search", async () => {
            for (let index = 0; index < 25; index += 1) recordMcpBreadcrumb({ stage: "handler", outcome: "started", elapsedMs: index, metadata: { itemCount: index } });
            return currentMcpDiagnosticSnapshot();
        });
        expect(snapshot?.breadcrumbs).toHaveLength(20);
        expect(snapshot?.breadcrumbs.at(-1)?.stage).toBe("breadcrumbs_truncated");
        expect(JSON.stringify(snapshot)).not.toContain("token");
        expect(JSON.stringify(snapshot)).not.toContain("amount");
    });

    test("isolates concurrent async scopes", async () => {
        const result = await Promise.all(["a", "b"].map((toolName) => withMcpDiagnosticScope({ ...ctx, correlationId: crypto.randomUUID() }, toolName, async () => {
            recordMcpBreadcrumb({ stage: "handler", outcome: "succeeded" });
            await Promise.resolve();
            return currentMcpDiagnosticSnapshot();
        })));
        expect(result.map((item) => item?.toolName)).toEqual(["a", "b"]);
        expect(result[0]?.breadcrumbs).toHaveLength(1);
        expect(result[1]?.breadcrumbs).toHaveLength(1);
    });
});
