import { describe, expect, it } from "bun:test";
import { normalizePublicLoanTerms } from "./calculator";
import { calculatePublicLoanSchedule } from "./calculator";

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

    // Break caught: a single-payment contract creates periodic installments instead of one exact maturity obligation.
    it("creates a one-row maturity schedule for single-payment terms", () => {
        expect(calculatePublicLoanSchedule({
            principal: "5000.00", interestRate: "0.00", termMonths: 1,
            repaymentType: "single_payment", startDate: "2026-08-10",
            singlePayment: {
                dueDate: "2026-08-19",
                fixedAgreedInterest: "500.00",
                interestPolicy: "fixed_only",
                latePenalty: { mode: "none" },
            },
        })).toEqual([{
            installmentNo: 1,
            dueDate: "2026-08-19",
            amount: "5500.00",
            principalComponent: "5000.00",
            interestComponent: "500.00",
            remainingPrincipal: "0.00",
        }]);
    });
});
