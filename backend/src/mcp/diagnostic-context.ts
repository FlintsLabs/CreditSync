import { AsyncLocalStorage } from "node:async_hooks";
import type { CommandContext } from "../services/command-context";
import type { McpDiagnosticBreadcrumb, McpDiagnosticStage, SafeDiagnosticMetadataKey } from "../lib/mcp-diagnostic-types";

type Scope = {
    ctx: CommandContext;
    toolName: string;
    startedAt: number;
    breadcrumbs: McpDiagnosticBreadcrumb[];
    truncated: boolean;
};
export type McpDiagnosticSnapshot = Readonly<{
    ctx: CommandContext;
    toolName: string;
    durationMs: number;
    breadcrumbs: readonly McpDiagnosticBreadcrumb[];
}>;

const storage = new AsyncLocalStorage<Scope>();
const deniedKey = /(name|email|alias|phone|card|address|qr|reference|url|token|secret|hash|amount|payload|header|query|sql|file|key|credential|evidence|account)/iu;
const allowedKeys = new Set<SafeDiagnosticMetadataKey>(["runtimeCodeCategory", "httpStatus", "timeout", "attempt", "itemCount"]);

export function withMcpDiagnosticScope<T>(ctx: CommandContext, toolName: string, work: () => Promise<T>): Promise<T> {
    return storage.run({ ctx, toolName, startedAt: performance.now(), breadcrumbs: [], truncated: false }, work);
}

export function recordMcpBreadcrumb(input: {
    stage: McpDiagnosticStage;
    outcome: McpDiagnosticBreadcrumb["outcome"];
    elapsedMs?: number;
    metadata?: Readonly<Record<string, string | number | boolean | null>>;
}): void {
    const scope = storage.getStore();
    if (!scope) return;
    const metadata: Record<SafeDiagnosticMetadataKey, string | number | boolean | null> = {} as Record<SafeDiagnosticMetadataKey, string | number | boolean | null>;
    let rejected = false;
    for (const [key, value] of Object.entries(input.metadata ?? {})) {
        if (deniedKey.test(key) || !allowedKeys.has(key as SafeDiagnosticMetadataKey)) { rejected = true; continue; }
        if (typeof value === "string" && value.length > 80) { rejected = true; continue; }
        metadata[key as SafeDiagnosticMetadataKey] = value;
    }
    if (rejected) scope.truncated = true;
    const item: McpDiagnosticBreadcrumb = {
        stage: rejected ? "breadcrumbs_truncated" : input.stage,
        outcome: rejected ? "rejected" : input.outcome,
        elapsedMs: Math.max(0, Math.round(input.elapsedMs ?? (performance.now() - scope.startedAt))),
        ...(Object.keys(metadata).length ? { metadata: Object.freeze({ ...metadata }) } : {}),
    };
    if (scope.breadcrumbs.length < 20) {
        scope.breadcrumbs.push(Object.freeze(item));
        return;
    }
    scope.truncated = true;
    const marker = Object.freeze({ stage: "breadcrumbs_truncated" as const, outcome: "rejected" as const, elapsedMs: item.elapsedMs });
    scope.breadcrumbs = [scope.breadcrumbs[0]!, ...scope.breadcrumbs.slice(-18), marker];
}

export function currentMcpDiagnosticSnapshot(): McpDiagnosticSnapshot | null {
    const scope = storage.getStore();
    if (!scope) return null;
    return Object.freeze({
        ctx: { ...scope.ctx },
        toolName: scope.toolName,
        durationMs: Math.max(0, Math.round(performance.now() - scope.startedAt)),
        breadcrumbs: Object.freeze(scope.breadcrumbs.map((breadcrumb) => Object.freeze({
            ...breadcrumb,
            ...(breadcrumb.metadata ? { metadata: Object.freeze({ ...breadcrumb.metadata }) } : {}),
        }))),
    });
}
