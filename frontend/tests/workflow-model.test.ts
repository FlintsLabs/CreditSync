import { describe, expect, it, test } from "vitest";
import {
    absoluteMoney,
    buildLoanTermsInput,
    formatDecimalExact,
    formatMoneyExact,
    isNegativeMoney,
    isPositiveMoney,
    moneyDifference,
    remainingMoney,
    sumMoney,
    toExplicitAllocations,
} from "../src/lib/workflow-model";

describe("single-payment loan terms", () => {
    it("builds an exact closed single-payment request without calculating interest", () => {
        expect(buildLoanTermsInput({
            principal: "5000", interestRate: "0", termMonths: "1", repaymentType: "single_payment",
            startDate: "2026-08-10", singlePaymentDueDate: "2026-08-19",
            singlePaymentFixedAgreedInterest: "500", singlePaymentInterestPolicy: "greater_of_fixed_or_retroactive",
            singlePaymentRetroactiveRateType: "percent_per_day", singlePaymentRetroactiveRate: "1.0000",
            singlePaymentLatePenaltyMode: "fixed_amount_per_day", singlePaymentLatePenaltyAmountPerDay: "20",
            singlePaymentLatePenaltyGraceDays: "2",
        })).toEqual({
            principal: "5000.00", interestRate: "0.00", termMonths: 1, repaymentType: "single_payment", startDate: "2026-08-10",
            singlePayment: {
                dueDate: "2026-08-19", fixedAgreedInterest: "500.00", interestPolicy: "greater_of_fixed_or_retroactive",
                retroactiveInterest: { rateType: "percent_per_day", rate: "1.0000" },
                latePenalty: { mode: "fixed_amount_per_day", amountPerDay: "20.00", graceDays: 2 },
            },
        });
    });

    it("omits mutually exclusive retroactive and penalty fields for fixed-only terms", () => {
        expect(buildLoanTermsInput({
            principal: "5000", interestRate: "0", termMonths: "1", repaymentType: "single_payment",
            startDate: "2026-08-10", singlePaymentDueDate: "2026-08-19",
            singlePaymentFixedAgreedInterest: "500", singlePaymentInterestPolicy: "fixed_only",
            singlePaymentLatePenaltyMode: "none",
        }).singlePayment).toEqual({
            dueDate: "2026-08-19", fixedAgreedInterest: "500.00", interestPolicy: "fixed_only", latePenalty: { mode: "none" },
        });
    });
});

const BORROWER_A = "019c3a5a-94ce-7f2c-8b08-f56852dca7a1";
const BORROWER_B = "019c3a5a-94ce-7f2c-8b08-f56852dca7a2";
const LOAN_A = "019c3a5a-94ce-7f2c-8b08-f56852dca7a3";
const LOAN_B = "019c3a5a-94ce-7f2c-8b08-f56852dca7a4";

describe("workflow view models", () => {
    test("uses identical daily terms for preview and draft without deriving a fixed installment", () => {
        const form = {
            principal: "1000",
            interestRate: "15",
            termMonths: "12",
            repaymentType: "daily",
            startDate: "2026-08-10",
            totalInstallments: "",
            installmentAmount: "",
        };

        const previewTerms = buildLoanTermsInput(form);
        const draftTerms = buildLoanTermsInput(form);

        expect(previewTerms).toEqual(draftTerms);
        expect(previewTerms).toEqual({
            principal: "1000.00",
            interestRate: "15.00",
            termMonths: 12,
            repaymentType: "daily",
            startDate: "2026-08-10",
        });
    });

    test("preserves explicitly entered fixed-daily terms in preview and draft", () => {
        expect(buildLoanTermsInput({
            principal: "1000.00", interestRate: "15.00", termMonths: "12",
            repaymentType: "daily", startDate: "2026-08-10",
            totalInstallments: "360", installmentAmount: "3.20",
        })).toMatchObject({ totalInstallments: 360, installmentAmount: "3.20" });
    });

    test("sends a daily entry source without calculating financial terms in the browser", () => {
        expect(buildLoanTermsInput({
            principal: "2500", interestRate: "0", termMonths: "1", repaymentType: "daily", startDate: "2026-08-10",
            dailyDurationUnit: "days", dailyDurationValue: "15", dailyEntryMode: "daily_payment", dailyPayment: "200",
        })).toMatchObject({
            principal: "2500.00", interestRate: "0.00", termMonths: 1,
            dailyEntry: { durationUnit: "days", durationValue: 15, entryMode: "daily_payment", dailyPayment: "200.00" },
        });
        expect(buildLoanTermsInput({
            principal: "2000", interestRate: "0", termMonths: "1", repaymentType: "daily", startDate: "2026-08-10",
            dailyDurationUnit: "days", dailyDurationValue: "10", dailyEntryMode: "daily_interest", dailyInterestInputMode: "percent", dailyInterestInputValue: "1.5",
        }).dailyEntry).toEqual({ durationUnit: "days", durationValue: 10, entryMode: "daily_interest", interestInput: { mode: "percent", value: "1.5" } });
    });

    test("sums and subtracts money exactly beyond Number safe integer range", () => {
        expect(sumMoney(["9007199254740993.10", "0.20", "6.70"])).toBe("9007199254741000.00");
        expect(moneyDifference("9007199254741000.00", "9007199254740993.10")).toBe("6.90");
        expect(formatMoneyExact("9007199254741000.00", "en", "THB")).toContain("9,007,199,254,741,000.00");
    });

    // Break caught: decimal.js default precision silently removes cents once a valid amount has 20 significant digits.
    test("keeps cents exact at the 29-digit public money maximum", () => {
        expect(sumMoney(["99999999999999999999999999999.98", "0.01"])).toBe("99999999999999999999999999999.99");
        expect(moneyDifference("99999999999999999999999999999.99", "0.01")).toBe("99999999999999999999999999999.98");
        expect(remainingMoney("99999999999999999999999999999.99", ["1.01"])).toBe("99999999999999999999999999998.98");
        expect(() => sumMoney(["99999999999999999999999999999.99", "0.01"]))
            .toThrow("Money exceeds the public 29-digit integer bound");
    });

    test("derives funding balances and signs exactly beyond Number safe integer range", () => {
        expect(remainingMoney("9007199254741000.00", ["9007199254740993.10", "0.20"])).toBe("6.70");
        expect(remainingMoney("5.00", ["6.00"])).toBe("0.00");
        expect(absoluteMoney("-9007199254740993.10")).toBe("9007199254740993.10");
        expect(formatDecimalExact("9007199254740993.10", "en")).toBe("9,007,199,254,740,993.10");
        expect(isNegativeMoney("-0.01")).toBe(true);
        expect(isPositiveMoney("0.01")).toBe(true);
        expect(isPositiveMoney("0.00")).toBe(false);
    });

    test("rejects transient and non-decimal money grammar without coercion", () => {
        for (const invalid of ["", "1.234", "1e3", "NaN", "Infinity"]) {
            expect(() => sumMoney([invalid]), invalid).toThrow("Money must have at most two decimal places");
            expect(() => formatMoneyExact(invalid, "en"), invalid).toThrow("Money must have at most two decimal places");
        }
    });

    test("builds all explicit allocation rows and preserves their exact amounts", () => {
        const allocations = toExplicitAllocations([
            { id: "row-a", borrowerPublicId: BORROWER_A, loanPublicId: LOAN_A, schedulePublicId: "", amount: "10.10" },
            { id: "row-b", borrowerPublicId: BORROWER_B, loanPublicId: LOAN_B, schedulePublicId: undefined, amount: "20.20" },
        ]);

        expect(allocations).toEqual([
            { borrowerPublicId: BORROWER_A, loanPublicId: LOAN_A, amount: "10.10" },
            { borrowerPublicId: BORROWER_B, loanPublicId: LOAN_B, amount: "20.20" },
        ]);
        expect(sumMoney(allocations.map((row) => row.amount))).toBe("30.30");
    });
});
