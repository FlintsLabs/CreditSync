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
    // Break caught: Elysia strips a legacy top-level policy before the service can reject the ambiguous request.
    test("rejects a generalized preview that also includes the legacy policy", async () => {
        const response = await preview({
            ...weeklyPreview,
            floatingDailyInterest: { mode: "percent", rate: "12", firstDayTreatment: "deduct" },
        });

        expect(response.status).toBe(422);
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
