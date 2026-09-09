export const mcpDiagnosticCategories = [
    "domain", "validation", "authorization", "database", "cache", "network", "storage",
    "external_service", "timeout", "internal",
] as const;
export type McpDiagnosticCategory = (typeof mcpDiagnosticCategories)[number];

export const mcpDiagnosticStages = [
    "validation", "preflight", "handler", "cache.connect", "rate_limit.consume",
    "chatgpt_file.dns", "chatgpt_file.download", "chatgpt_file.validate", "storage.bucket",
    "storage.put", "storage.head", "storage.get", "storage.delete", "diagnostic.persist",
    "diagnostic.read",
] as const;
export type McpDiagnosticStage = (typeof mcpDiagnosticStages)[number] | "breadcrumbs_truncated";

export const mcpDiagnosticFailureClasses = [
    "dns_resolution", "connect_timeout", "connection_reset", "http_status", "redirect_rejected",
    "metadata_mismatch", "constraint_violation", "pool_exhausted", "cancelled", "unknown",
] as const;
export type McpDiagnosticFailureClass = (typeof mcpDiagnosticFailureClasses)[number];

export const safeDiagnosticMetadataKeys = ["runtimeCodeCategory", "httpStatus", "timeout", "attempt", "itemCount"] as const;
export type SafeDiagnosticMetadataKey = (typeof safeDiagnosticMetadataKeys)[number];

export type McpDiagnosticBreadcrumb = {
    stage: McpDiagnosticStage;
    outcome: "started" | "succeeded" | "failed" | "rejected";
    elapsedMs: number;
    metadata?: Partial<Readonly<Record<SafeDiagnosticMetadataKey, string | number | boolean | null>>>;
};
