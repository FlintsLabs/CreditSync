import { describe, expect, test } from "vitest";
import {
    createPaymentWorkflow,
    executeRenewal,
    normalizeMoney,
    type HttpClient,
} from "../src/lib/workflow-api";

const INTAKE_ID = "019c3a5a-94ce-7f2c-8b08-f56852dca7a4";
const PROPOSAL_ID = "019c3a5a-94ce-7f2c-8b08-f56852dca7a5";

describe("workflow API contracts", () => {
    test("normalizes user-entered money to the backend two-decimal contract", () => {
        expect(normalizeMoney("1200")).toBe("1200.00");
        expect(normalizeMoney("1200.5")).toBe("1200.50");
        expect(() => normalizeMoney("1,200")).toThrow();
        expect(() => normalizeMoney("12.345")).toThrow();
    });

    // Break caught: an unbounded public amount can exceed the configured financial arithmetic precision.
    test("accepts the 29-digit public money bound and rejects 30 integer digits", () => {
        expect(normalizeMoney("99999999999999999999999999999.99"))
            .toBe("99999999999999999999999999999.99");
        expect(normalizeMoney("0001.2")).toBe("1.20");
        expect(() => normalizeMoney("100000000000000000000000000000.00"))
            .toThrow("Money must be non-negative with at most two decimal places");
    });

    test("creates a review-first payment without previewing or posting", async () => {
        const calls: Array<{ url: string; body: unknown }> = [];
        const client: HttpClient = {
            async get() { return { data: null }; },
            async post<T>(url: string, body?: unknown) {
                calls.push({ url, body });
                return { data: { publicId: INTAKE_ID, status: "draft", duplicate: false, warnings: [] } as T };
            },
        };

        const result = await createPaymentWorkflow(client, {
            amount: "450",
            receivedAt: "2026-08-10T09:30:00.000Z",
            payerName: "Somchai",
        });

        expect(result.status).toBe("draft");
        expect(calls).toEqual([{ url: "/payment-intakes", body: {
            amount: "450.00", receivedAt: "2026-08-10T09:30:00.000Z",
            payerName: "Somchai", bankReference: null, notes: null, originLoanPublicId: null,
        } }]);
        expect(calls.some((call) => call.url === "/transactions")).toBe(false);
    });

    test("preserves semantic duplicate warnings and never previews or posts them", async () => {
        const calls: string[] = [];
        const client: HttpClient = {
            async get() { return { data: null }; },
            async post<T>(url: string) {
                calls.push(url);
                return { data: {
                    publicId: INTAKE_ID,
                    status: "needs_review",
                    duplicate: false,
                    warnings: [{ code: "POSSIBLE_SEMANTIC_DUPLICATE", intakePublicIds: [PROPOSAL_ID] }],
                } as T };
            },
        };

        const result = await createPaymentWorkflow(client, {
            amount: "450.00", receivedAt: "2026-08-10T09:30:00.000Z",
        });

        expect(result.warnings?.[0]).toMatchObject({ code: "POSSIBLE_SEMANTIC_DUPLICATE" });
        expect(calls).toEqual(["/payment-intakes"]);
    });

    test("stops before preview and post when intake creation reports a duplicate", async () => {
        const calls: string[] = [];
        const client: HttpClient = {
            async get() { return { data: null }; },
            async post<T>(url: string) {
                calls.push(url);
                return { data: { publicId: INTAKE_ID, status: "duplicate", duplicate: true, duplicateReason: "bank_reference" } as T };
            },
        };

        const result = await createPaymentWorkflow(client, {
            amount: "450.00",
            receivedAt: "2026-08-10T09:30:00.000Z",
        });

        expect(result.duplicate).toBe(true);
        expect(calls).toEqual(["/payment-intakes"]);
    });

    test("executes a renewal with explicit confirmation and an operation idempotency key", async () => {
        const calls: Array<{ url: string; body: unknown; headers?: Record<string, string> }> = [];
        const client: HttpClient = {
            async get() { return { data: null }; },
            async post<T>(url: string, body?: unknown, config?: { headers?: Record<string, string> }) {
                calls.push({ url, body, headers: config?.headers });
                return { data: { status: "executed" } as T };
            },
        };

        await executeRenewal(client, INTAKE_ID, "v1:hash", "Customer confirmed", "renewal-execute-key");

        expect(calls[0]).toEqual({
            url: `/loan-renewals/${INTAKE_ID}/execute`,
            body: { previewHash: "v1:hash", confirmed: true, reason: "Customer confirmed" },
            headers: { "Idempotency-Key": "renewal-execute-key" },
        });
    });
});
