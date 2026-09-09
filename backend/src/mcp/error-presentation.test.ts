import { describe, expect, test } from "bun:test";
import { DomainError } from "../services/domain-error";
import { presentMcpError } from "./error-presentation";

const correlationId = "0198c481-3e2b-7000-8000-000000000001";

describe("MCP error presentation", () => {
    test("does not expose unknown exception or unknown DomainError text", () => {
        const unknown = presentMcpError(new Error("password=secret database body"), correlationId);
        const domain = presentMcpError(new DomainError("UNLISTED_CODE", "raw private exception", 409), correlationId);
        expect(unknown.publicError.message).not.toContain("password");
        expect(domain.publicError.message).not.toContain("raw private exception");
        expect(unknown.publicError.correlationId).toBe(correlationId);
        expect(unknown.publicError.suggestedAction).toBeTruthy();
    });

    test("keeps known recovery semantics and makes read-only retry guidance distinct", () => {
        const known = presentMcpError(new DomainError("REVERSAL_NOT_LATEST", "backend text", 409), correlationId, "financial");
        const read = presentMcpError(new Error("transient"), correlationId, "read_only");
        const write = presentMcpError(new Error("transient"), correlationId, "financial");
        expect(known.publicError.code).toBe("REVERSAL_NOT_LATEST");
        expect(known.publicError.reviewRequired).toBe(true);
        expect(read.publicError.suggestedAction).toContain("read-only");
        expect(write.publicError.suggestedAction).toContain("authoritative state");
    });

    test("persists unexpected and retryable failures but excludes ordinary confirmation errors", () => {
        expect(presentMcpError(new Error("x"), correlationId).persist).toBe(true);
        expect(presentMcpError(new DomainError("CONFIRMATION_REQUIRED", "confirm", 409), correlationId).persist).toBe(false);
        expect(presentMcpError(new DomainError("DATABASE_ERROR", "db", 503), correlationId).persist).toBe(true);
    });

    test("uses typed public details and preserves blocker IDs", () => {
        const blocker = "0198c481-3e2b-7000-8000-000000000002";
        const result = presentMcpError(new DomainError("BLOCKED", "private", 409, {
            debug: "https://secret.invalid/x", blockerPublicIds: [blocker], amount: "100.00", blockers: { laterRenewals: 2, url: 1 },
        }), correlationId);
        expect(result.publicError.details).toEqual({ blockerPublicIds: [blocker], blockers: { laterRenewals: 2 } });
        expect(JSON.stringify(result.publicError)).not.toContain("secret.invalid");
        expect(result.publicError.reviewRequired).toBe(true);
    });

    test("keeps transient retryability for unknown server DomainErrors", () => {
        const result = presentMcpError(new DomainError("UNLISTED_CODE", "private", 503), correlationId);
        expect(result.publicError.retryable).toBe(true);
        expect(result.diagnostic.category).toBe("internal");
        expect(result.persist).toBe(true);
    });
});
