import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { loansRoute } from "./loans";
import { floatingDailyInterest } from "./loan-route-schemas";

async function postPreview(body: unknown) {
    const app = new Elysia().use(loansRoute);
    const response = await app.handle(new Request("http://localhost/loans/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    }));
    const text = await response.text();
    return { response, body: text ? JSON.parse(text) : null, text };
}

describe("loans route composition", () => {
    test("advertises a closed daily-or-weekly accrual-cycle enum", () => {
        const schema = floatingDailyInterest as unknown as {
            properties: { accrualCycle: { anyOf?: Array<{ const?: string }> } };
        };
        expect(schema.properties.accrualCycle.anyOf?.map((entry) => entry.const)).toEqual(["daily", "weekly"]);
    });
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
            "GET /loans/:id/interest-rates",
            "GET /loans/:id/payment-intakes",
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
            "POST /loans/:id/interest-rates/execute",
            "POST /loans/:id/interest-rates/preview",
            "POST /loans/calculate",
            "POST /loans/preview",
            "PUT /loans/:id",
            "PUT /loans/:id/disbursements/:disbursementId",
        ].sort());
    });

    // Break caught: the REST schema drops single-payment terms or allows numeric
    // money to cross the public contract before the exact calculator runs.
    test("previews exact string single-payment terms through the public route", async () => {
        const result = await postPreview({
            principal: "5000.00",
            interestRate: "99.00",
            termMonths: 1,
            repaymentType: "single_payment",
            startDate: "2026-08-10",
            singlePayment: {
                dueDate: "2026-08-19",
                fixedAgreedInterest: "500.00",
                interestPolicy: "fixed_only",
                latePenalty: { mode: "none" },
            },
        });

        expect(result.response.status, result.text).toBe(200);
        expect(result.body).toMatchObject({
            terms: {
                principal: "5000.00",
                interestRate: "99.00",
                singlePayment: { fixedAgreedInterest: "500.00", dueDate: "2026-08-19" },
            },
            schedule: [{ amount: "5500.00", principalComponent: "5000.00", interestComponent: "500.00" }],
        });

        const numericMoney = await postPreview({
            principal: 5000,
            interestRate: "0.00",
            termMonths: 1,
            repaymentType: "single_payment",
            startDate: "2026-08-10",
            singlePayment: {
                dueDate: "2026-08-19",
                fixedAgreedInterest: "500.00",
                interestPolicy: "fixed_only",
                latePenalty: { mode: "none" },
            },
        });
        expect(numericMoney.response.status).toBe(422);
    });

    // Break caught: closed public terms silently accept typos or contradictory
    // fixed-only/retroactive policy objects.
    test("rejects unknown fields and invalid single-payment policy combinations", async () => {
        const validBase = {
            principal: "5000.00",
            interestRate: "0.00",
            termMonths: 1,
            repaymentType: "single_payment",
            startDate: "2026-08-10",
        };
        const unknown = await postPreview({
            ...validBase,
            accidentalPayout: "5000.00",
            singlePayment: {
                dueDate: "2026-08-19",
                fixedAgreedInterest: "500.00",
                interestPolicy: "fixed_only",
                latePenalty: { mode: "none", unexpectedGraceDays: 1 },
            },
        });
        expect(unknown.response.status).toBe(422);

        const contradictory = await postPreview({
            ...validBase,
            singlePayment: {
                dueDate: "2026-08-19",
                fixedAgreedInterest: "500.00",
                interestPolicy: "fixed_only",
                retroactiveInterest: { rateType: "percent_per_day", rate: "1.0000" },
                latePenalty: { mode: "none" },
            },
        });
        expect(contradictory.response.status, contradictory.text).toBe(400);
        expect(contradictory.body).toMatchObject({
            code: "INVALID_LOAN_TERMS",
            error: "Fixed-only terms cannot include retroactive interest",
        });

        const missingRetroactive = await postPreview({
            ...validBase,
            singlePayment: {
                dueDate: "2026-08-19",
                fixedAgreedInterest: "500.00",
                interestPolicy: "greater_of_fixed_or_retroactive",
                latePenalty: { mode: "none" },
            },
        });
        expect(missingRetroactive.response.status, missingRetroactive.text).toBe(400);
        expect(missingRetroactive.body).toMatchObject({
            code: "INVALID_LOAN_TERMS",
            error: "Retroactive interest is required",
        });
    });

    // Break caught: floating weekly terms are rejected as unknown or lose their
    // explicit cycle while legacy daily requests stop working.
    test("normalizes legacy and weekly floating accrual cycles through REST", async () => {
        const base = {
            principal: "5000.00",
            interestRate: "0.00",
            termMonths: 1,
            repaymentType: "floating",
            startDate: "2026-08-10",
        };
        const legacy = await postPreview({
            ...base,
            floatingDailyInterest: { mode: "percent", rate: "1", firstDayTreatment: "start_next_day" },
        });
        expect(legacy.response.status, legacy.text).toBe(200);
        expect(legacy.body.floatingDailyInterest).toEqual({
            mode: "percent", rate: "1.0000", firstDayTreatment: "start_next_day", accrualCycle: "daily",
        });

        const weekly = await postPreview({
            ...base,
            floatingDailyInterest: { mode: "percent", rate: "1", firstDayTreatment: "start_next_day", accrualCycle: "weekly" },
        });
        expect(weekly.response.status, weekly.text).toBe(200);
        expect(weekly.body.floatingDailyInterest).toEqual({
            mode: "percent", rate: "1.0000", firstDayTreatment: "start_next_day", accrualCycle: "weekly",
        });

        const advance = await postPreview({
            ...base,
            floatingDailyInterest: { mode: "percent", rate: "12", firstDayTreatment: "deduct", accrualCycle: "weekly" },
        });
        expect(advance.response.status, advance.text).toBe(200);
        expect(advance.body).toMatchObject({
            firstPeriodInterest: "600.00", advanceInterest: "600.00", netBorrowerPayout: "4400.00",
            coveredStartDate: "2026-08-10", coveredEndDate: "2026-08-16",
            firstPeriodDueDate: "2026-08-17", nextAccrualDate: "2026-08-17",
            periodDays: 7, advanceInterestRefundPolicy: "non_refundable",
        });
        expect(advance.body).not.toHaveProperty("fullPeriodInterest");
        expect(advance.body).not.toHaveProperty("nextInterestDate");
        expect(advance.body).not.toHaveProperty("nonRefundable");
        expect(advance.body).not.toHaveProperty("dailyInterestAtCurrentPrincipal");
    });

    // Break caught: malformed floating policies escape as HTTP 500/DecimalError,
    // or an invalid cycle is reported through a different validation contract.
    test("maps every malformed floating policy to stable INVALID_LOAN_TERMS", async () => {
        const base = {
            principal: "5000.00", interestRate: "0.00", termMonths: 1,
            repaymentType: "floating", startDate: "2026-08-10",
        };
        const policies = [
            { mode: "percent", rate: "0", firstDayTreatment: "start_next_day", accrualCycle: "daily" },
            { mode: "percent", rate: "not-a-rate", firstDayTreatment: "start_next_day", accrualCycle: "daily" },
            { mode: "percent", rate: "1.00000", firstDayTreatment: "start_next_day", accrualCycle: "daily" },
            { mode: "percent", rate: "1.0000", firstDayTreatment: "start_next_day", accrualCycle: "monthly" },
        ];
        for (const floatingDailyInterest of policies) {
            const result = await postPreview({ ...base, floatingDailyInterest });
            expect(result.response.status, result.text).toBe(400);
            expect(result.body).toEqual({ error: "Floating interest policy is invalid", code: "INVALID_LOAN_TERMS" });
            expect(result.text).not.toContain("DecimalError");
        }
    });
});
