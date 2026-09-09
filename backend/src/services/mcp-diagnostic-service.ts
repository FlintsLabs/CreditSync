import { and, desc, eq, gt, lt, lte, or, sql } from "drizzle-orm";
import postgres from "postgres";
import { db, type DbExecutor } from "../db";
import { mcpDiagnosticEvents, users } from "../db/schema";
import type { CommandContext } from "./command-context";
import type { PublicMcpError, SafeDiagnosticClassification } from "../mcp/error-presentation";
import type { McpDiagnosticBreadcrumb, McpDiagnosticCategory } from "../lib/mcp-diagnostic-types";
import { projectMcpDiagnosticBreadcrumbs } from "../mcp/diagnostic-context";
import type { McpDiagnosticSnapshot } from "../mcp/diagnostic-context";
import { DomainError } from "./domain-error";
import { canAccessTenantWideData } from "../lib/access";

const retentionMs = 30 * 24 * 60 * 60 * 1000;
const maxWaitMs = 500;
const queryTimeoutMs = 450;
const diagnosticPool = postgres(process.env.DATABASE_URL || "postgres://user:password@localhost:5432/creditsync", {
    max: 2, connect_timeout: 0.2, idle_timeout: 5, max_lifetime: 30, prepare: false,
    connection: { statement_timeout: 450, lock_timeout: 100 },
});
let diagnosticInFlight = 0;

function safeLog(logger: (entry: Record<string, unknown>) => void, entry: Record<string, unknown>) {
    try { logger(entry); } catch { /* diagnostics must never affect the command */ }
}

export async function persistMcpDiagnosticBestEffort(input: {
    ctx: CommandContext;
    toolName: string;
    publicError: PublicMcpError;
    classification: SafeDiagnosticClassification;
    snapshot: McpDiagnosticSnapshot;
    logger: (entry: Record<string, unknown>) => void;
    executor?: DbExecutor;
    now?: Date;
    timeoutMs?: number;
}): Promise<void> {
    const occurredAt = input.now ?? new Date();
    const expiresAt = new Date(occurredAt.getTime() + retentionMs);
    const breadcrumbs = sanitizeBreadcrumbs(input.snapshot.breadcrumbs);
    if (diagnosticInFlight >= 2 && !input.executor) {
        safeLog(input.logger, { event: "mcp_diagnostic_persist_failed", tool: input.toolName, requestId: input.ctx.requestId, correlationId: input.ctx.correlationId, code: input.publicError.code });
        return;
    }
    diagnosticInFlight += input.executor ? 0 : 1;
    let queryTimer: ReturnType<typeof setTimeout> | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const write = input.executor
        ? Promise.resolve().then(() => input.executor!.insert(mcpDiagnosticEvents).values({ tenantId: input.ctx.tenantId, toolName: input.toolName, requestId: input.ctx.requestId, correlationId: input.ctx.correlationId, category: input.classification.category, failureClass: input.classification.failureClass, errorCode: input.publicError.code, terminalStage: input.classification.terminalStage, retryable: input.classification.retryable, reviewRequired: input.classification.reviewRequired, upstreamStatus: input.classification.upstreamStatus, durationMs: input.snapshot.durationMs, breadcrumbs, occurredAt, expiresAt })).then(() => undefined)
        : insertWithDiagnosticPool({ input, breadcrumbs, occurredAt, expiresAt, onQuery: (query) => { queryTimer = setTimeout(() => query.cancel(), Math.min(input.timeoutMs ?? maxWaitMs, queryTimeoutMs)); } });
    if (!input.executor) {
        write.then(() => { diagnosticInFlight -= 1; }, () => { diagnosticInFlight -= 1; });
    }
    const timeout = new Promise<never>((_, reject) => { deadlineTimer = setTimeout(() => reject(new Error("diagnostic persistence timeout")), Math.min(input.timeoutMs ?? maxWaitMs, maxWaitMs)); });
    write.catch(() => undefined);
    try {
        await Promise.race([write, timeout]);
        settled = true;
    } catch {
        safeLog(input.logger, { event: "mcp_diagnostic_persist_failed", tool: input.toolName, requestId: input.ctx.requestId, correlationId: input.ctx.correlationId, code: input.publicError.code });
    } finally {
        if (queryTimer) clearTimeout(queryTimer);
        if (deadlineTimer) clearTimeout(deadlineTimer);
        if (!settled) write.catch(() => undefined);
    }
}

function sanitizeBreadcrumbs(value: readonly McpDiagnosticBreadcrumb[]): McpDiagnosticBreadcrumb[] {
    return projectMcpDiagnosticBreadcrumbs(value, "stored").slice(0, 20);
}

async function insertWithDiagnosticPool(input: { input: Parameters<typeof persistMcpDiagnosticBestEffort>[0]; breadcrumbs: McpDiagnosticBreadcrumb[]; occurredAt: Date; expiresAt: Date; onQuery: (query: { cancel: () => void }) => void }) {
    const { input: value, breadcrumbs, occurredAt, expiresAt } = input;
    const query = diagnosticPool`INSERT INTO mcp_diagnostic_events (tenant_id, tool_name, request_id, correlation_id, category, failure_class, error_code, terminal_stage, retryable, review_required, upstream_status, duration_ms, breadcrumbs, occurred_at, expires_at) VALUES (${value.ctx.tenantId}, ${value.toolName}, ${value.ctx.requestId}, ${value.ctx.correlationId}, ${value.classification.category}, ${value.classification.failureClass}, ${value.publicError.code}, ${value.classification.terminalStage}, ${value.classification.retryable}, ${value.classification.reviewRequired}, ${value.classification.upstreamStatus}, ${value.snapshot.durationMs}, ${diagnosticPool.json(breadcrumbs)}, ${occurredAt.toISOString()}, ${expiresAt.toISOString()})`;
    input.onQuery(query);
    await query;
}

function actorIsDiagnosticReader(ctx: CommandContext, executor: DbExecutor) {
    return executor.select({ id: users.id, role: users.role }).from(users).where(and(
        eq(users.id, ctx.actorUserId ?? -1), eq(users.tenantId, ctx.tenantId),
    )).limit(1);
}

function project(row: typeof mcpDiagnosticEvents.$inferSelect) {
    const breadcrumbs = sanitizeBreadcrumbs(Array.isArray(row.breadcrumbs) ? row.breadcrumbs : []);
    return {
        diagnosticPublicId: row.publicId, toolName: row.toolName, correlationId: row.correlationId, requestId: row.requestId,
        category: row.category, failureClass: row.failureClass, errorCode: row.errorCode, terminalStage: row.terminalStage,
        retryable: row.retryable, reviewRequired: row.reviewRequired, upstreamStatus: row.upstreamStatus,
        durationMs: row.durationMs, occurredAt: row.occurredAt.toISOString(), expiresAt: row.expiresAt.toISOString(),
        breadcrumbs,
        summary: `${row.errorCode} failed at ${row.terminalStage}`,
        recommendedNextCheck: row.reviewRequired ? "Inspect authoritative operation state before retrying" : "Follow the suggested action and inspect again if it repeats",
    };
}

export async function getMcpDiagnosticTrace(ctx: CommandContext, correlationId: string, executor: DbExecutor = db) {
    const actor = await actorIsDiagnosticReader(ctx, executor);
    if (!actor.length || !canAccessTenantWideData({ role: actor[0]!.role ?? "viewer" })) throw new DomainError("DIAGNOSTIC_FORBIDDEN", "Diagnostic access is not permitted", 403);
    const now = new Date();
    const rows = await executor.select().from(mcpDiagnosticEvents).where(and(
        eq(mcpDiagnosticEvents.tenantId, ctx.tenantId), eq(mcpDiagnosticEvents.correlationId, correlationId), gt(mcpDiagnosticEvents.expiresAt, now),
    )).orderBy(desc(mcpDiagnosticEvents.occurredAt)).limit(100);
    if (!rows.length) throw new DomainError("DIAGNOSTIC_NOT_FOUND", "No diagnostic trace is available for this correlation ID", 404);
    return { correlationId, items: rows.map(project) };
}

export type ListMcpDiagnosticsInput = {
    correlationId?: string; requestId?: string; toolName?: string; errorCode?: string; category?: McpDiagnosticCategory;
    from?: string; to?: string; cursor?: string; limit?: number;
};

export async function listMcpDiagnostics(ctx: CommandContext, input: ListMcpDiagnosticsInput, executor: DbExecutor = db) {
    const actor = await actorIsDiagnosticReader(ctx, executor);
    if (!actor.length || !canAccessTenantWideData({ role: actor[0]!.role ?? "viewer" })) throw new DomainError("DIAGNOSTIC_FORBIDDEN", "Diagnostic access is not permitted", 403);
    const limit = Math.min(input.limit ?? 20, 100);
    const now = new Date();
    const oldest = new Date(now.getTime() - retentionMs);
    const from = input.from ? new Date(input.from) : oldest;
    const to = input.to ? new Date(input.to) : now;
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from < oldest || from > to || to > now) throw new DomainError("DIAGNOSTIC_RANGE_INVALID", "Diagnostic time range is outside the retained window", 422);
    const narrowed = input.correlationId || input.requestId || input.toolName || input.errorCode || input.category;
    if (!narrowed && to.getTime() - from.getTime() > 24 * 60 * 60 * 1000) throw new DomainError("DIAGNOSTIC_FILTER_REQUIRED", "A diagnostic narrowing filter is required", 422);
    const where = [eq(mcpDiagnosticEvents.tenantId, ctx.tenantId), gteSafe(mcpDiagnosticEvents.occurredAt, from), lte(mcpDiagnosticEvents.occurredAt, to), gt(mcpDiagnosticEvents.expiresAt, now)];
    if (input.correlationId) where.push(eq(mcpDiagnosticEvents.correlationId, input.correlationId));
    if (input.requestId) where.push(eq(mcpDiagnosticEvents.requestId, input.requestId));
    if (input.toolName) where.push(eq(mcpDiagnosticEvents.toolName, input.toolName));
    if (input.errorCode) where.push(eq(mcpDiagnosticEvents.errorCode, input.errorCode));
    if (input.category) where.push(eq(mcpDiagnosticEvents.category, input.category));
    if (input.cursor) {
        const cursor = decodeCursor(input.cursor);
        if (!cursor) throw new DomainError("DIAGNOSTIC_CURSOR_INVALID", "Diagnostic cursor is invalid", 422);
        where.push(or(lt(mcpDiagnosticEvents.occurredAt, cursor.occurredAt), and(eq(mcpDiagnosticEvents.occurredAt, cursor.occurredAt), lt(mcpDiagnosticEvents.id, cursor.id)))!);
    }
    const rows = await executor.select().from(mcpDiagnosticEvents).where(and(...where)).orderBy(desc(mcpDiagnosticEvents.occurredAt), desc(mcpDiagnosticEvents.id)).limit(limit + 1);
    const items = rows.slice(0, limit).map(project);
    return { items, nextCursor: rows.length > limit && rows[limit - 1] ? encodeCursor(rows[limit - 1]!.occurredAt, rows[limit - 1]!.id) : null };
}

function gteSafe(column: Parameters<typeof gt>[0], value: Date) { return or(gt(column, value), eq(column, value)); }

function encodeCursor(occurredAt: Date, id: number) { return Buffer.from(JSON.stringify({ occurredAt: occurredAt.toISOString(), id }), "utf8").toString("base64url"); }
function decodeCursor(value: string): { occurredAt: Date; id: number } | null {
    try { const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as { occurredAt?: string; id?: number }; const date = new Date(parsed.occurredAt ?? ""); return Number.isInteger(parsed.id) && parsed.id! > 0 && !Number.isNaN(date.getTime()) ? { occurredAt: date, id: parsed.id! } : null; } catch { return null; }
}

export async function cleanupExpiredMcpDiagnostics(input: { executor?: DbExecutor; now?: Date; limit?: number }) {
    const executor = input.executor ?? db;
    const limit = Math.min(Math.max(input.limit ?? 1000, 1), 10000);
    const now = input.now ?? new Date();
    const result = await executor.execute(sql`DELETE FROM mcp_diagnostic_events WHERE id IN (SELECT id FROM mcp_diagnostic_events WHERE expires_at < ${now} ORDER BY expires_at ASC LIMIT ${limit})`);
    return Number((result as { count?: number }).count ?? 0);
}
