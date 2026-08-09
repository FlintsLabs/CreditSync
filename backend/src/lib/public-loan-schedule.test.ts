import { describe, expect, it } from "bun:test";
import { calculatePublicLoanSchedule } from "./calculator";

describe("public loan schedule contract", () => {
    // Break caught: the public schedule calculation accepts an over-precise money amount.
    it("rejects over-precise money inputs", () => {
        expect(() => calculatePublicLoanSchedule({
            principal: "2500.000",
            interestRate: "0.00",
            installmentAmount: "190.00",
            totalInstallments: 15,
            termMonths: 1,
            repaymentType: "daily",
            startDate: "2026-01-01",
        })).toThrow("Money must be a non-negative string with exactly two decimals");
    });

    // Break caught: the public route leaks a number instead of an exact two-decimal money string.
    it("serializes all public schedule money fields as two-decimal strings", () => {
        const [first] = calculatePublicLoanSchedule({
            principal: "2500.00",
            interestRate: "0.00",
            installmentAmount: "190.00",
            totalInstallments: 15,
            termMonths: 1,
            repaymentType: "daily",
            startDate: "2026-01-01",
        });

        expect(first).toMatchObject({
            amount: "190.00",
            principalComponent: "166.67",
            interestComponent: "23.33",
            remainingPrincipal: "2333.33",
        });
    });
});
