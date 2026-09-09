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

    it("builds the exact schedule from a daily-entry calculation", () => {
        const schedule = calculatePublicLoanSchedule({
            principal: "2500.00",
            interestRate: "0.00",
            termMonths: 1,
            repaymentType: "daily",
            startDate: "2026-01-01",
            dailyEntry: {
                durationUnit: "days",
                durationValue: 15,
                entryMode: "daily_payment",
                dailyPayment: "200.00",
            },
        });

        expect(schedule).toHaveLength(15);
        expect(schedule[0]).toMatchObject({ amount: "200.00", principalComponent: "166.67", interestComponent: "33.33" });
        expect(schedule[14]).toMatchObject({ amount: "200.00", principalComponent: "166.62", interestComponent: "33.38", remainingPrincipal: "0.00" });
    });

    // Break caught: default Decimal precision rounds a valid maximum principal up to an invalid 30-digit schedule amount.
    it("preserves a zero-rate schedule at the 29-digit maximum and rejects a real interest overflow", () => {
        const maximum = "99999999999999999999999999999.99";
        expect(calculatePublicLoanSchedule({
            principal: maximum,
            interestRate: "0.00",
            termMonths: 1,
            repaymentType: "monthly",
            startDate: "2026-01-01",
        })).toEqual([{
            installmentNo: 1,
            dueDate: "2026-02-01",
            amount: maximum,
            principalComponent: maximum,
            interestComponent: "0.00",
            remainingPrincipal: "0.00",
        }]);

        expect(() => calculatePublicLoanSchedule({
            principal: maximum,
            interestRate: "12.00",
            termMonths: 1,
            repaymentType: "monthly",
            startDate: "2026-01-01",
        })).toThrow("Money must be a non-negative string with exactly two decimals");
    });
});
