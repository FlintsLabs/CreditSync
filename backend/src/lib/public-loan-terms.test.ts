import { describe, expect, it } from "bun:test";
import { normalizePublicLoanTerms } from "./calculator";

describe("public loan create terms", () => {
    // Break caught: a preview's two-decimal money strings cannot be forwarded unchanged to loan creation.
    it("preserves canonical money strings for calculate-to-create handoff", () => {
        expect(normalizePublicLoanTerms({
            principal: "2500.00",
            interestRate: "15.00",
            installmentAmount: "190.00",
            totalInstallments: 15,
            termMonths: 1,
            repaymentType: "daily",
        })).toEqual({
            principal: "2500.00",
            interestRate: "15.00",
            installmentAmount: "190.00",
            totalInstallments: 15,
            termMonths: 1,
            repaymentType: "daily",
        });
    });

    // Break caught: create accepts a non-public-money value or invalid daily count after calculate rejected it.
    it("rejects over-precise money and fractional daily counts", () => {
        expect(() => normalizePublicLoanTerms({
            principal: "2500.000",
            interestRate: "15.00",
            installmentAmount: "190.00",
            totalInstallments: 15,
            termMonths: 1,
            repaymentType: "daily",
        })).toThrow("Money must be a non-negative string with exactly two decimals");
        expect(() => normalizePublicLoanTerms({
            principal: "2500.00",
            interestRate: "15.00",
            installmentAmount: "190.00",
            totalInstallments: 15.5,
            termMonths: 1,
            repaymentType: "daily",
        })).toThrow("Daily total installments must be a positive integer");
    });

    // Break caught: invalid count/rate-term semantics become a persisted loan despite valid money strings.
    it("rejects fractional terms, fractional counts, and unknown repayment types", () => {
        const validTerms = {
            principal: "2500.00",
            interestRate: "15.00",
            installmentAmount: "190.00",
            totalInstallments: 15,
            termMonths: 1,
            repaymentType: "monthly" as const,
        };

        expect(() => normalizePublicLoanTerms({ ...validTerms, termMonths: 1.5 }))
            .toThrow("Term months must be a positive whole number");
        expect(() => normalizePublicLoanTerms({ ...validTerms, totalInstallments: 15.5 }))
            .toThrow("Total installments must be a positive integer");
        expect(() => normalizePublicLoanTerms({ ...validTerms, repaymentType: "unsupported" as any }))
            .toThrow("Repayment type is not supported");
    });
});
