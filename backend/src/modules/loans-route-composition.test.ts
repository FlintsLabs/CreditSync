import { describe, expect, test } from "bun:test";
import { loansRoute } from "./loans";

describe("loans route composition", () => {
    test("mounts the existing public contract, funding, and disbursement endpoints", () => {
        const endpoints = loansRoute.routes
            .map((route) => `${route.method} ${route.path}`)
            .sort();

        expect(endpoints).toEqual([
            "GET /loans/",
            "GET /loans/:id",
            "GET /loans/:id/allocation-state",
            "GET /loans/:id/closing-summary",
            "GET /loans/:id/disbursements",
            "GET /loans/:id/funding-allocations",
            "GET /loans/:id/profitability",
            "GET /loans/:id/schedule",
            "POST /loans/",
            "POST /loans/:id/activate",
            "POST /loans/:id/close",
            "POST /loans/:id/disbursements",
            "POST /loans/:id/disbursements/:disbursementId/evidence/:evidenceId/finalize",
            "POST /loans/:id/disbursements/:disbursementId/evidence/upload-intents",
            "POST /loans/:id/disbursements/:disbursementId/post",
            "POST /loans/:id/disbursements/:disbursementId/reverse",
            "POST /loans/:id/funding-allocations",
            "POST /loans/:id/funding-reallocations",
            "POST /loans/calculate",
            "POST /loans/preview",
            "PUT /loans/:id",
            "PUT /loans/:id/disbursements/:disbursementId",
        ].sort());
    });
});
