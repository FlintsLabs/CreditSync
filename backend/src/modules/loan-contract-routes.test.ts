import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { loansRoute } from "./loans";

const weeklyPreview = {
    principal: "5000.00",
    interestRate: "0.00",
    repaymentType: "floating",
    termMonths: 1,
    startDate: "2026-08-13",
    floatingInterestPolicy: {
        periodUnit: "week",
        periodLength: 1,
        rateMode: "percent",
        rate: "12",
        advanceInterestPeriods: 1,
        advanceInterestRefundPolicy: "non_refundable",
    },
};

async function preview(body: unknown) {
    return new Elysia().use(loansRoute).handle(new Request("http://localhost/loans/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    }));
}

describe("loan contract route schemas", () => {
    // Break caught: the additive adapter strips a second equivalent policy or
    // lets a conflicting legacy projection silently override generalized terms.
    test("accepts equivalent dual floating projections and rejects conflicts", async () => {
        const equivalent = await preview({
            ...weeklyPreview,
            floatingDailyInterest: {
                mode: "percent", rate: "12", firstDayTreatment: "deduct", accrualCycle: "weekly",
            },
        });
        expect(equivalent.status).toBe(200);

        const conflict = await preview({
            ...weeklyPreview,
            floatingDailyInterest: {
                mode: "percent", rate: "12", firstDayTreatment: "deduct", accrualCycle: "daily",
            },
        });
        expect(conflict.status).toBe(400);
        expect(await conflict.json()).toEqual({
            code: "INVALID_LOAN_TERMS",
            error: "Floating interest policy inputs conflict",
        });
    });

    // Break caught: Elysia silently strips an unknown nested policy field and accepts a contract the closed schema does not define.
    test("rejects unknown fields nested inside a floating policy", async () => {
        const response = await preview({
            ...weeklyPreview,
            floatingInterestPolicy: { ...weeklyPreview.floatingInterestPolicy, firstDayTreatment: "deduct" },
        });

        expect(response.status).toBe(422);
    });
});
