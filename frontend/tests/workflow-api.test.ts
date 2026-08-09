import { describe, expect, test } from "bun:test";
import {
    createPaymentWorkflow,
    executeRenewal,
    normalizeMoney,
    type HttpClient,
} from "../src/lib/workflow-api";

const BORROWER_ID = "019c3a5a-94ce-7f2c-8b08-f56852dca7a1";
const LOAN_ID = "019c3a5a-94ce-7f2c-8b08-f56852dca7a2";
const SCHEDULE_ID = "019c3a5a-94ce-7f2c-8b08-f56852dca7a3";
const INTAKE_ID = "019c3a5a-94ce-7f2c-8b08-f56852dca7a4";
const PROPOSAL_ID = "019c3a5a-94ce-7f2c-8b08-f56852dca7a5";

describe("workflow API contracts", () => {
    test("normalizes user-entered money to the backend two-decimal contract", () => {
        expect(normalizeMoney("1200")).toBe("1200.00");
        expect(normalizeMoney("1200.5")).toBe("1200.50");
        expect(() => normalizeMoney("1,200")).toThrow();
        expect(() => normalizeMoney("12.345")).toThrow();
    });

    test("records a repayment through intake, explicit preview, and post without the legacy endpoint", async () => {
        const calls: Array<{ url: string; body: unknown }> = [];
        const client: HttpClient = {
            async get() { return { data: null }; },
            async post<T>(url: string, body?: unknown) {
                calls.push({ url, body });
                if (url === "/payment-intakes") return { data: { publicId: INTAKE_ID, duplicate: false } as T };
                if (url.endsWith("/match-preview")) return { data: { publicId: PROPOSAL_ID, status: "ready" } as T };
                return { data: { publicId: INTAKE_ID, status: "posted" } as T };
            },
        };

        const result = await createPaymentWorkflow(client, {
            amount: "450",
            receivedAt: "2026-08-10T09:30:00.000Z",
            payerName: "Somchai",
            allocation: {
                borrowerPublicId: BORROWER_ID,
                loanPublicId: LOAN_ID,
                schedulePublicId: SCHEDULE_ID,
                amount: "450",
            },
        });

        expect(result.status).toBe("posted");
        expect(calls).toEqual([
            {
                url: "/payment-intakes",
                body: {
                    amount: "450.00",
                    receivedAt: "2026-08-10T09:30:00.000Z",
                    payerName: "Somchai",
                    bankReference: null,
                    notes: null,
                },
            },
            {
                url: `/payment-intakes/${INTAKE_ID}/match-preview`,
                body: { allocations: [{
                    borrowerPublicId: BORROWER_ID,
                    loanPublicId: LOAN_ID,
                    schedulePublicId: SCHEDULE_ID,
                    amount: "450.00",
                }] },
            },
            {
                url: `/payment-intakes/${INTAKE_ID}/post`,
                body: { proposalPublicId: PROPOSAL_ID },
            },
        ]);
        expect(calls.some((call) => call.url === "/transactions")).toBe(false);
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
            allocation: {
                borrowerPublicId: BORROWER_ID,
                loanPublicId: LOAN_ID,
                amount: "450.00",
            },
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
