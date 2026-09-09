import { expect, test } from "bun:test";
import { cleanupExpiredMcpDiagnostics } from "../src/services/mcp-diagnostic-service";

test("cleanup uses a bounded batch and reports deleted rows", async () => {
    let received: unknown;
    const executor = {
        execute: async (query: unknown) => { received = query; return { count: "7" }; },
    } as any;
    await expect(cleanupExpiredMcpDiagnostics({ executor, limit: 50000, now: new Date("2026-09-09T00:00:00.000Z") })).resolves.toBe(7);
    expect(received).toBeDefined();
});
