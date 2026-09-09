import { DomainError } from "../services/domain-error";
import type { McpDiagnosticCategory, McpDiagnosticFailureClass, McpDiagnosticStage } from "../lib/mcp-diagnostic-types";

export type OperationRecoveryPolicy = "read_only" | "mutating" | "financial";
export type PublicMcpDetailValue = string | number | boolean | null | string[] | Record<string, number>;
export type PublicMcpError = {
    code: string; message: string; suggestedAction: string; retryable: boolean; reviewRequired: boolean;
    repreviewRequired?: boolean; humanReviewRequired?: boolean; details: Record<string, PublicMcpDetailValue>; correlationId: string;
};
export type SafeDiagnosticClassification = {
    category: McpDiagnosticCategory; failureClass: McpDiagnosticFailureClass; terminalStage: McpDiagnosticStage;
    upstreamStatus: number | null; retryable: boolean; reviewRequired: boolean;
};

const catalog: Record<string, { message: string; action: string; retryable: boolean; review: boolean }> = {
    CHATGPT_FILE_UNAVAILABLE: { message: "The attached file is unavailable", action: "Inspect the evidence state and retry the same import intent with its idempotency key", retryable: true, review: false },
    EVIDENCE_UPLOAD_EXPIRED: { message: "The evidence upload has expired", action: "Prepare a new upload URL and upload the evidence again", retryable: false, review: true },
    DIAGNOSTIC_FORBIDDEN: { message: "Diagnostic access is not permitted", action: "Ask a tenant owner or manager to inspect this correlation ID", retryable: false, review: false },
    DIAGNOSTIC_NOT_FOUND: { message: "No diagnostic trace is available for this correlation ID", action: "Do not retry a write; inspect authoritative state or ask an owner to investigate", retryable: false, review: true },
    RATE_LIMITED: { message: "MCP request rate limit exceeded", action: "Wait for the retry window and retry only a read-only operation", retryable: true, review: false },
    REVERSAL_NOT_LATEST: { message: "Reverse later payments first", action: "Inspect later payments and reverse them in dependency order", retryable: false, review: true },
    AUDIT_METADATA_UNAVAILABLE: { message: "The operation completed but its audit metadata is unavailable", action: "Do not retry blindly; inspect the operation using the correlation ID", retryable: true, review: true },
    INVALID_TOOL_OUTPUT: { message: "The MCP tool returned an invalid result", action: "Inspect the correlation ID and authoritative state before retrying", retryable: false, review: true },
    ALLOCATION_EXCEEDS_DRAWDOWN: { message: "Allocation exceeds remaining drawdown balance", action: "Inspect the remaining drawdown balance and revise the allocation", retryable: false, review: false },
    INVALID_TOOL_ARGUMENTS: { message: "The MCP tool arguments are invalid", action: "Use the advertised schema and do not retry with guessed fields", retryable: false, review: true },
    DIAGNOSTIC_RANGE_INVALID: { message: "The diagnostic time range is outside the retained window", action: "Use a range within the last 30 days ending no later than now", retryable: false, review: false },
    DIAGNOSTIC_FILTER_REQUIRED: { message: "A diagnostic narrowing filter is required", action: "Provide a correlation, request, tool, code, category, or a window no larger than 24 hours", retryable: false, review: false },
};

function categoryFor(error: unknown): McpDiagnosticCategory {
    if (error instanceof DomainError) {
        if (/DATABASE|POSTGRES|CONSTRAINT/u.test(error.code)) return "database";
        if (/CACHE|RATE_LIMIT/u.test(error.code)) return "cache";
        if (/STORAGE|EVIDENCE_UPLOAD/u.test(error.code)) return "storage";
        if (/NETWORK|EXTERNAL|CHATGPT_FILE/u.test(error.code)) return "external_service";
        if (error.status === 401 || error.status === 403) return "authorization";
        if (error.status === 422 || error.status === 409) return "domain";
        if (error.status === 429) return "network";
        if (error.status >= 500) return "internal";
        return "validation";
    }
    const code = error instanceof Error ? (error as Error & { code?: string }).code : undefined;
    if (code?.includes("ECONN") || code === "ENOTFOUND") return "network";
    return "internal";
}

function failureClassFor(error: unknown): McpDiagnosticFailureClass {
    const code = error instanceof Error ? (error as Error & { code?: string }).code : undefined;
    if (code === "ENOTFOUND") return "dns_resolution";
    if (code === "ETIMEDOUT") return "connect_timeout";
    if (code === "ECONNRESET") return "connection_reset";
    return "unknown";
}

const publicDetailKeys = new Set([
    "paymentIntakePublicId", "transactionPublicId", "sourceRemaining", "availableFunding", "requestedPrincipal",
    "downstreamEntryCount", "accrualPublicId", "accrualDate", "periodStartDate", "periodEndDate", "availableAmount",
    "currentVersion", "oldBalanceVersion", "status", "eventPublicId", "transferredAt", "interestRatePreviewPublicId",
    "earliestEditableDate", "field", "blockers", "blockerPublicIds", "reviewRequired", "correctedAmount", "collected",
    "carriedForward", "treatedAsBorrowerPayment", "loanPublicId", "throughDate", "requestedAmount", "allocationType",
]);
const publicUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const publicMoney = /^\d{1,30}(?:\.\d{2})$/u;
const publicDate = /^\d{4}-\d{2}-\d{2}$/u;
const publicField = /^(?:actualFunding|variance|oldLoanId|paymentIntakePublicId|proposalPublicId|loanPublicId|schedulePublicId)$/u;
const publicStatus = /^(?:active|draft|posted|reversed|ready|needs_review|pending|completed|cancelled|unfunded|partially_funded|fully_funded)$/u;

function safePublicString(key: string, value: string): boolean {
    if (value.length > 500 || /^\s*(?:https?:|data:|bearer\b)/iu.test(value)) return false;
    if (["paymentIntakePublicId", "transactionPublicId", "accrualPublicId", "interestRatePreviewPublicId", "eventPublicId", "loanPublicId"].includes(key)) return publicUuid.test(value);
    if (["sourceRemaining", "availableFunding", "requestedPrincipal", "availableAmount", "correctedAmount", "requestedAmount"].includes(key)) return publicMoney.test(value);
    if (["accrualDate", "periodStartDate", "periodEndDate", "earliestEditableDate", "throughDate"].includes(key)) return publicDate.test(value);
    if (key === "transferredAt") return !Number.isNaN(Date.parse(value));
    if (key === "field") return publicField.test(value);
    if (key === "status") return publicStatus.test(value);
    if (key === "allocationType") return /^(?:initial|manual_adjustment|reallocation_in|reallocation_out)$/u.test(value);
    return false;
}

function sanitizeDetails(details: Record<string, unknown> | undefined): Record<string, PublicMcpDetailValue> {
    if (!details) return {};
    const result: Record<string, PublicMcpDetailValue> = {};
    for (const [key, value] of Object.entries(details)) {
        if (!publicDetailKeys.has(key)) continue;
        if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) result[key] = value;
        else if (typeof value === "string" && safePublicString(key, value)) result[key] = value;
        else if (key === "blockerPublicIds" && Array.isArray(value) && value.length <= 100 && value.every((item) => typeof item === "string" && publicUuid.test(item))) result[key] = value;
        else if (key === "blockers" && value && typeof value === "object" && !Array.isArray(value)) {
            const blockers: Record<string, number> = {};
            for (const [blockerKey, blockerValue] of Object.entries(value)) {
                if (/^(?:rateChanges|laterRenewals|downstreamEntries)$/u.test(blockerKey) && typeof blockerValue === "number" && Number.isInteger(blockerValue) && blockerValue >= 0 && blockerValue <= 10000) blockers[blockerKey] = blockerValue;
            }
            if (Object.keys(blockers).length) result[key] = blockers;
        }
    }
    return result;
}

export function presentMcpError(error: unknown, correlationId: string, policy: OperationRecoveryPolicy = "mutating", stage: McpDiagnosticStage = "handler") {
    const domain = error instanceof DomainError;
    const code = domain && /^[A-Z][A-Z0-9_]{0,159}$/u.test(error.code) ? error.code : domain ? "DOMAIN_ERROR" : "INTERNAL_ERROR";
    const known = catalog[code] ?? (domain ? { message: "The MCP operation was rejected", action: "Inspect the current record and follow the operation-specific recovery workflow", retryable: false, review: true } : undefined);
    const status = domain ? error.status : 500;
    const reviewRequired = domain ? status === 409 || /(AMBIGUOUS|MISMATCH|REVIEW|STALE|NOT_LATEST|OUTPUT|CONFIRM)/u.test(code) : policy !== "read_only";
    const transient = domain ? (status === 429 || status >= 500) : true;
    const retryable = (known?.retryable ?? false) || transient;
    const publicError: PublicMcpError = {
        code,
        message: known?.message ?? "The MCP tool could not complete the request",
        suggestedAction: known?.action ?? (policy === "read_only" && retryable ? "Retry this read-only operation once; otherwise inspect the correlation ID" : "Inspect authoritative state and this correlation ID before retrying"),
        retryable,
        reviewRequired: (known?.review ?? false) || reviewRequired,
        details: sanitizeDetails(domain ? error.details : undefined),
        correlationId,
        ...(code.startsWith("BATCH_") ? { repreviewRequired: ["BATCH_STATE_CHANGED_SEMANTICS_SAME", "BATCH_EXECUTION_CONFLICT"].includes(code), humanReviewRequired: ["BATCH_NEEDS_REVIEW", "BATCH_DUPLICATE_EVIDENCE", "BATCH_ALLOCATION_MISMATCH", "BATCH_CONFIRMATION_STALE"].includes(code) } : {}),
    };
    const classification: SafeDiagnosticClassification = {
        category: categoryFor(error), failureClass: failureClassFor(error), terminalStage: stage,
        upstreamStatus: status >= 100 && status <= 599 ? status : null,
        retryable, reviewRequired: publicError.reviewRequired,
    };
    return { publicError, diagnostic: classification, persist: !domain || retryable || ["database", "cache", "network", "storage", "external_service", "timeout"].includes(classification.category) };
}

export function shouldPersistMcpDiagnostic(result: ReturnType<typeof presentMcpError>) { return result.persist; }
