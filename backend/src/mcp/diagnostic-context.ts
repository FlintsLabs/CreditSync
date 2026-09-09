import { AsyncLocalStorage } from "node:async_hooks";
import type { CommandContext } from "../services/command-context";
import {
    mcpDiagnosticOutcomes,
    mcpDiagnosticStages,
    safeDiagnosticMetadataKeys,
    safeDiagnosticRuntimeCategories,
    type McpDiagnosticBreadcrumb,
    type McpDiagnosticStage,
    type SafeDiagnosticMetadataKey,
} from "../lib/mcp-diagnostic-types";

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
const allowedKeys = new Set<SafeDiagnosticMetadataKey>(safeDiagnosticMetadataKeys);
const stageSet = new Set<string>(mcpDiagnosticStages);
const outcomeSet = new Set<string>(mcpDiagnosticOutcomes);
const runtimeCategorySet = new Set<string>(safeDiagnosticRuntimeCategories);
const maxCount = 10_000;
const maxElapsedMs = 86_400_000;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeMetadata(key: SafeDiagnosticMetadataKey, value: unknown): string | number | boolean | null | undefined {
    if (value === null) return null;
    if (key === "runtimeCodeCategory") return typeof value === "string" && runtimeCategorySet.has(value) ? value : undefined;
    if (key === "httpStatus") return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;
    if (key === "timeout") return typeof value === "boolean" ? value : undefined;
    if (key === "attempt" || key === "itemCount") {
        return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= maxCount ? value : undefined;
    }
    return undefined;
}

function projectBreadcrumb(value: unknown, mode: "capture" | "stored"): McpDiagnosticBreadcrumb | null {
    if (!isRecord(value)) return mode === "capture" ? { stage: "breadcrumbs_truncated", outcome: "rejected", elapsedMs: 0 } : null;
    const stage = value.stage;
    const outcome = value.outcome;
    const elapsedMs = value.elapsedMs;
    if (typeof stage !== "string" || (!stageSet.has(stage) && stage !== "breadcrumbs_truncated") ||
        typeof outcome !== "string" || !outcomeSet.has(outcome) ||
        typeof elapsedMs !== "number" || !Number.isFinite(elapsedMs) || elapsedMs < 0 || elapsedMs > maxElapsedMs) {
        return mode === "capture" ? { stage: "breadcrumbs_truncated", outcome: "rejected", elapsedMs: 0 } : null;
    }
    const metadata: Partial<Record<SafeDiagnosticMetadataKey, string | number | boolean | null>> = {};
    if (value.metadata !== undefined) {
        if (!isRecord(value.metadata)) return mode === "capture" ? { stage: "breadcrumbs_truncated", outcome: "rejected", elapsedMs: Math.round(elapsedMs) } : null;
        for (const [key, candidate] of Object.entries(value.metadata)) {
            if (!allowedKeys.has(key as SafeDiagnosticMetadataKey)) {
                if (mode === "capture") return { stage: "breadcrumbs_truncated", outcome: "rejected", elapsedMs: Math.round(elapsedMs) };
                continue;
            }
            const safe = safeMetadata(key as SafeDiagnosticMetadataKey, candidate);
            if (safe === undefined) {
                if (mode === "capture") return { stage: "breadcrumbs_truncated", outcome: "rejected", elapsedMs: Math.round(elapsedMs) };
                continue;
            }
            metadata[key as SafeDiagnosticMetadataKey] = safe;
        }
    }
    return {
        stage: stage as McpDiagnosticStage,
        outcome: outcome as McpDiagnosticBreadcrumb["outcome"],
        elapsedMs: Math.round(elapsedMs),
        ...(Object.keys(metadata).length ? { metadata } : {}),
    };
}

export function projectMcpDiagnosticBreadcrumbs(value: readonly unknown[], mode: "capture" | "stored" = "stored"): McpDiagnosticBreadcrumb[] {
    return value.flatMap((item) => {
        const projected = projectBreadcrumb(item, mode);
        return projected ? [projected] : [];
    });
}

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
    const metadata: Partial<Record<SafeDiagnosticMetadataKey, string | number | boolean | null>> = {};
    let rejected = false;
    for (const [key, value] of Object.entries(input.metadata ?? {})) {
        if (deniedKey.test(key) || !allowedKeys.has(key as SafeDiagnosticMetadataKey)) { rejected = true; continue; }
        const safe = safeMetadata(key as SafeDiagnosticMetadataKey, value);
        if (safe === undefined) { rejected = true; continue; }
        metadata[key as SafeDiagnosticMetadataKey] = safe;
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
    scope.breadcrumbs = [scope.breadcrumbs[0]!, ...scope.breadcrumbs.slice(-17), item, marker];
}

export function currentMcpDiagnosticSnapshot(): McpDiagnosticSnapshot | null {
    const scope = storage.getStore();
    if (!scope) return null;
    return Object.freeze({
        ctx: { ...scope.ctx },
        toolName: scope.toolName,
        durationMs: Math.max(0, Math.round(performance.now() - scope.startedAt)),
        breadcrumbs: Object.freeze(projectMcpDiagnosticBreadcrumbs(scope.breadcrumbs, "capture").map((breadcrumb) => Object.freeze({
            ...breadcrumb,
            ...(breadcrumb.metadata ? { metadata: Object.freeze({ ...breadcrumb.metadata }) } : {}),
        }))),
    });
}
