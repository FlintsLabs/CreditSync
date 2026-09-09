import { describe, expect, test } from "bun:test";
import { db } from "../db";
import { mcpDiagnosticEvents, users } from "../db/schema";
import { eq, inArray } from "drizzle-orm";
import { persistMcpDiagnosticBestEffort, getMcpDiagnosticTrace, listMcpDiagnostics } from "./mcp-diagnostic-service";
import type { McpDiagnosticSnapshot } from "../mcp/diagnostic-context";

const ctx = { tenantId: "tenant-a", actorUserId: 1, actorSource: "mcp" as const, requestId: crypto.randomUUID(), correlationId: crypto.randomUUID() };
const snapshot: McpDiagnosticSnapshot = Object.freeze({
    ctx, toolName: "borrower.search", durationMs: 12,
    breadcrumbs: Object.freeze([{ stage: "handler" as const, outcome: "failed" as const, elapsedMs: 12, metadata: { itemCount: 1, token: "must-drop" } as any }]),
});

describe("MCP diagnostic persistence safety", () => {
    test("redacts injected breadcrumb metadata before persistence", async () => {
        let values: Record<string, unknown> | undefined;
        const executor = { insert: () => ({ values: (input: Record<string, unknown>) => { values = input; return Promise.resolve([]); } }) } as any;
        await persistMcpDiagnosticBestEffort({
            ctx, toolName: "borrower.search", publicError: { code: "INTERNAL_ERROR", message: "safe", suggestedAction: "inspect", retryable: true, reviewRequired: false, details: {}, correlationId: ctx.correlationId },
            classification: { category: "internal", failureClass: "unknown", terminalStage: "handler", upstreamStatus: 500, retryable: true, reviewRequired: false },
            snapshot, executor, logger: () => undefined, now: new Date("2026-09-09T00:00:00.000Z"), timeoutMs: 50,
        });
        expect(JSON.stringify(values)).not.toContain("must-drop");
        expect((values?.breadcrumbs as any[])[0]).toEqual({ stage: "handler", outcome: "failed", elapsedMs: 12, metadata: { itemCount: 1 } });
        expect((values?.expiresAt as Date).toISOString()).toBe("2026-10-09T00:00:00.000Z");
    });

    test("bounded persistence preserves the caller when an injected writer never settles", async () => {
        const executor = { insert: () => ({ values: () => new Promise(() => undefined) }) } as any;
        const logs: Record<string, unknown>[] = [];
        const started = performance.now();
        await persistMcpDiagnosticBestEffort({
            ctx, toolName: "borrower.search", publicError: { code: "INTERNAL_ERROR", message: "safe", suggestedAction: "inspect", retryable: true, reviewRequired: false, details: {}, correlationId: ctx.correlationId },
            classification: { category: "internal", failureClass: "unknown", terminalStage: "handler", upstreamStatus: 500, retryable: true, reviewRequired: false },
            snapshot, executor, logger: (entry) => logs.push(entry), timeoutMs: 20,
        });
        expect(performance.now() - started).toBeLessThan(200);
        expect(logs).toHaveLength(1);
        expect(logs[0]?.event).toBe("mcp_diagnostic_persist_failed");
    });

    test("500ms response deadline and throwing logger cannot leak a late rejection", async () => {
        const executor = { insert: () => ({ values: () => new Promise(() => undefined) }) } as any;
        const started = performance.now();
        await persistMcpDiagnosticBestEffort({
            ctx, toolName: "borrower.search", publicError: { code: "INTERNAL_ERROR", message: "safe", suggestedAction: "inspect", retryable: true, reviewRequired: false, details: {}, correlationId: ctx.correlationId },
            classification: { category: "internal", failureClass: "unknown", terminalStage: "handler", upstreamStatus: 500, retryable: true, reviewRequired: false },
            snapshot, executor, logger: () => { throw new Error("logger failure"); }, timeoutMs: 500,
        });
        expect(performance.now() - started).toBeLessThan(650);
    });

    test("enforces role, tenant, retention, bounds, and equal-time cursor ordering", async () => {
        if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for diagnostic database coverage");
        const tenantId = `diagnostic-${crypto.randomUUID()}`;
        const otherTenantId = `diagnostic-other-${crypto.randomUUID()}`;
        const owner = await db.insert(users).values({ tenantId, email: `${crypto.randomUUID()}@diag.test`, role: "owner" }).returning().then((rows) => rows[0]!);
        const viewer = await db.insert(users).values({ tenantId, email: `${crypto.randomUUID()}@diag.test`, role: "viewer" }).returning().then((rows) => rows[0]!);
        const otherOwner = await db.insert(users).values({ tenantId: otherTenantId, email: `${crypto.randomUUID()}@diag.test`, role: "owner" }).returning().then((rows) => rows[0]!);
        const occurredAt = new Date("2026-09-09T00:00:00.000Z");
        const expiresAt = new Date("2026-10-09T00:00:00.000Z");
        const expiredAt = new Date("2026-09-08T00:00:00.000Z");
        const rows = await db.insert(mcpDiagnosticEvents).values([
            { tenantId, toolName: "borrower.search", requestId: crypto.randomUUID(), correlationId: crypto.randomUUID(), category: "internal", failureClass: "unknown", errorCode: "INTERNAL_ERROR", terminalStage: "handler", retryable: true, reviewRequired: false, durationMs: 1, breadcrumbs: [], occurredAt, expiresAt },
            { tenantId, toolName: "borrower.search", requestId: crypto.randomUUID(), correlationId: crypto.randomUUID(), category: "internal", failureClass: "unknown", errorCode: "INTERNAL_ERROR", terminalStage: "handler", retryable: true, reviewRequired: false, durationMs: 2, breadcrumbs: [], occurredAt, expiresAt },
            { tenantId, toolName: "borrower.search", requestId: crypto.randomUUID(), correlationId: crypto.randomUUID(), category: "internal", failureClass: "unknown", errorCode: "INTERNAL_ERROR", terminalStage: "handler", retryable: true, reviewRequired: false, durationMs: 3, breadcrumbs: [], occurredAt: expiredAt, expiresAt: new Date("2026-09-08T12:00:00.000Z") },
            { tenantId: otherTenantId, toolName: "borrower.search", requestId: crypto.randomUUID(), correlationId: crypto.randomUUID(), category: "internal", failureClass: "unknown", errorCode: "INTERNAL_ERROR", terminalStage: "handler", retryable: true, reviewRequired: false, durationMs: 4, breadcrumbs: [], occurredAt, expiresAt },
        ]).returning({ id: mcpDiagnosticEvents.id, correlationId: mcpDiagnosticEvents.correlationId });
        try {
            const ownerCtx = { tenantId, actorUserId: owner.id, actorSource: "mcp" as const, requestId: crypto.randomUUID(), correlationId: crypto.randomUUID() };
            const viewerCtx = { ...ownerCtx, actorUserId: viewer.id };
            const otherCtx = { ...ownerCtx, actorUserId: otherOwner.id, tenantId: otherTenantId };
            await expect(getMcpDiagnosticTrace(viewerCtx, rows[0]!.correlationId)).rejects.toMatchObject({ code: "DIAGNOSTIC_FORBIDDEN", status: 403 });
            await expect(getMcpDiagnosticTrace(ownerCtx, rows[2]!.correlationId)).rejects.toMatchObject({ code: "DIAGNOSTIC_NOT_FOUND", status: 404 });
            const result = await listMcpDiagnostics(ownerCtx, { from: "2026-09-09T00:00:00.000Z", to: "2026-09-09T00:00:00.000Z", limit: 1 });
            expect(result.items).toHaveLength(1);
            expect(result.nextCursor).toBeString();
            const second = await listMcpDiagnostics(ownerCtx, { from: "2026-09-09T00:00:00.000Z", to: "2026-09-09T00:00:00.000Z", cursor: result.nextCursor!, limit: 1 });
            expect(second.items).toHaveLength(1);
            expect(second.items[0]!.diagnosticPublicId).not.toBe(result.items[0]!.diagnosticPublicId);
            await expect(listMcpDiagnostics(ownerCtx, { from: "2026-08-01T00:00:00.000Z", to: "2026-09-09T00:00:01.000Z" })).rejects.toMatchObject({ code: "DIAGNOSTIC_RANGE_INVALID", status: 422 });
            await expect(getMcpDiagnosticTrace(otherCtx, rows[0]!.correlationId)).rejects.toMatchObject({ code: "DIAGNOSTIC_NOT_FOUND", status: 404 });
        } finally {
            await db.delete(mcpDiagnosticEvents).where(eq(mcpDiagnosticEvents.tenantId, tenantId));
            await db.delete(mcpDiagnosticEvents).where(eq(mcpDiagnosticEvents.tenantId, otherTenantId));
            await db.delete(users).where(inArray(users.id, [owner.id, viewer.id, otherOwner.id]));
        }
    });
});
