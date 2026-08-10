import { describe, expect, test } from "bun:test";
import { normalizeDailyLoanEntry } from "./daily-loan-entry";

describe("daily loan entry", () => {
    test("derives flat daily interest from a borrower-proposed payment", () => {
        expect(normalizeDailyLoanEntry({
            principal: "2500.00",
            durationUnit: "days",
            durationValue: 15,
            entryMode: "daily_payment",
            dailyPayment: "200.00",
        })).toMatchObject({
            termMonths: 1,
            totalInstallments: 15,
            installmentAmount: "200.00",
            totalRepayment: "3000.00",
            totalInterest: "500.00",
            dailyInterest: "33.33",
            flatDailyRatePercent: "1.3333",
            flatMonthlyRatePercent: "40.0000",
            flatAnnualRatePercent: "486.6667",
        });
    });

    test("uses exactly thirty instalments for a selected month", () => {
        expect(normalizeDailyLoanEntry({
            principal: "10000.00",
            durationUnit: "months",
            durationValue: 1,
            entryMode: "daily_payment",
            dailyPayment: "500.00",
        })).toMatchObject({ totalInstallments: 30, totalInterest: "5000.00" });
    });

    test("derives payment from each flat daily interest expression", () => {
        expect(normalizeDailyLoanEntry({
            principal: "2000.00",
            durationUnit: "days",
            durationValue: 10,
            entryMode: "daily_interest",
            interestInput: { mode: "percent", value: "1.5000" },
        })).toMatchObject({ dailyInterest: "30.00", installmentAmount: "230.00", totalInterest: "300.00" });

        expect(normalizeDailyLoanEntry({
            principal: "5000.00",
            durationUnit: "days",
            durationValue: 15,
            entryMode: "daily_interest",
            interestInput: { mode: "fixed_amount", value: "75.00" },
        })).toMatchObject({ dailyInterest: "75.00", installmentAmount: "408.33", totalInterest: "1125.00" });

        expect(normalizeDailyLoanEntry({
            principal: "5000.00",
            durationUnit: "days",
            durationValue: 15,
            entryMode: "daily_interest",
            interestInput: { mode: "per_thousand", value: "15.0000" },
        })).toMatchObject({ dailyInterest: "75.00", installmentAmount: "408.33", totalInterest: "1125.00" });
    });

    test("rejects a proposed repayment below principal", () => {
        expect(() => normalizeDailyLoanEntry({
            principal: "2500.00",
            durationUnit: "days",
            durationValue: 15,
            entryMode: "daily_payment",
            dailyPayment: "100.00",
        })).toThrow("Installment total cannot be less than principal");
    });

    test("rejects incomplete and conflicting entry expressions", () => {
        expect(() => normalizeDailyLoanEntry({
            principal: "2500.00", durationUnit: "days", durationValue: 15, entryMode: "daily_payment",
        })).toThrow("Daily payment is required");
        expect(() => normalizeDailyLoanEntry({
            principal: "2500.00", durationUnit: "days", durationValue: 15, entryMode: "daily_interest",
        })).toThrow("Daily interest input is required");
    });
});
