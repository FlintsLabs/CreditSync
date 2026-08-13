import type Decimal from "decimal.js";
import { FinancialDecimal } from "./financial-decimal";
import { parseMoney, serializeMoney } from "./money";

export type DailyTermUnit = "days" | "months";
export type DailyEntryMode = "daily_payment" | "daily_interest";
export type DailyInterestInputMode = "percent" | "fixed_amount" | "per_thousand";

export type DailyLoanEntryInput = {
    durationUnit: DailyTermUnit;
    durationValue: number;
    entryMode: DailyEntryMode;
    dailyPayment?: string;
    interestInput?: {
        mode: DailyInterestInputMode;
        value: string;
    };
};

export type NormalizedDailyLoanEntry = {
    durationUnit: DailyTermUnit;
    durationValue: number;
    entryMode: DailyEntryMode;
    dailyPayment: string | null;
    interestInput: { mode: DailyInterestInputMode; value: string } | null;
    termMonths: number;
    totalInstallments: number;
    installmentAmount: string;
    totalRepayment: string;
    totalInterest: string;
    dailyInterest: string;
    flatDailyRatePercent: string;
    flatMonthlyRatePercent: string;
    flatAnnualRatePercent: string;
};

const decimalPattern = /^\d+(?:\.\d{1,4})?$/;

function parseRate(value: string, field: string): Decimal {
    if (!decimalPattern.test(value)) throw new Error(`${field} must be a non-negative decimal with up to four places`);
    const decimal = new FinancialDecimal(value);
    if (!decimal.isFinite()) throw new Error(`${field} must be finite`);
    return decimal;
}

function positiveInteger(value: number, field: string) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${field} must be a positive whole number`);
    return value;
}

function money(value: Decimal.Value) {
    return serializeMoney(value);
}

function rate(value: Decimal.Value) {
    return new FinancialDecimal(value).toDecimalPlaces(4, FinancialDecimal.ROUND_HALF_UP).toFixed(4);
}

export function normalizeDailyLoanEntry(input: DailyLoanEntryInput & { principal: string }): NormalizedDailyLoanEntry {
    const principal = parseMoney(input.principal);
    const durationValue = positiveInteger(input.durationValue, "Daily duration");
    if (input.durationUnit !== "days" && input.durationUnit !== "months") throw new Error("Daily duration unit is not supported");
    const totalInstallments = input.durationUnit === "months" ? durationValue * 30 : durationValue;
    if (!Number.isSafeInteger(totalInstallments)) throw new Error("Daily duration is too large");
    if (input.entryMode !== "daily_payment" && input.entryMode !== "daily_interest") throw new Error("Daily entry mode is not supported");

    let installmentAmount: Decimal;
    let totalInterest: Decimal;
    let dailyInterest: Decimal;
    let dailyPayment: string | null = null;
    let interestInput: NormalizedDailyLoanEntry["interestInput"] = null;

    if (input.entryMode === "daily_payment") {
        if (input.dailyPayment === undefined) throw new Error("Daily payment is required");
        installmentAmount = parseMoney(input.dailyPayment);
        if (installmentAmount.isZero()) throw new Error("Daily payment must be greater than zero");
        const totalRepayment = installmentAmount.times(totalInstallments);
        if (totalRepayment.lessThan(principal)) throw new Error("Installment total cannot be less than principal");
        totalInterest = totalRepayment.minus(principal);
        dailyInterest = totalInterest.div(totalInstallments).toDecimalPlaces(2, FinancialDecimal.ROUND_HALF_UP);
        dailyPayment = money(installmentAmount);
    } else {
        if (!input.interestInput) throw new Error("Daily interest input is required");
        const value = parseRate(input.interestInput.value, "Daily interest value");
        const mode = input.interestInput.mode;
        if (mode === "percent") {
            dailyInterest = principal.times(value).div(100).toDecimalPlaces(2, FinancialDecimal.ROUND_HALF_UP);
        } else if (mode === "per_thousand") {
            dailyInterest = principal.div(1000).times(value).toDecimalPlaces(2, FinancialDecimal.ROUND_HALF_UP);
        } else if (mode === "fixed_amount") {
            dailyInterest = parseMoney(input.interestInput.value);
        } else {
            throw new Error("Daily interest input mode is not supported");
        }
        totalInterest = dailyInterest.times(totalInstallments);
        const totalRepayment = principal.plus(totalInterest);
        installmentAmount = totalRepayment.div(totalInstallments).toDecimalPlaces(2, FinancialDecimal.ROUND_HALF_UP);
        interestInput = { mode, value: mode === "fixed_amount" ? money(dailyInterest) : rate(value) };
    }

    const totalRepayment = principal.plus(totalInterest);
    const exactDailyInterest = totalInterest.div(totalInstallments);
    const flatDailyRatePercent = exactDailyInterest.div(principal).times(100);

    return {
        durationUnit: input.durationUnit,
        durationValue,
        entryMode: input.entryMode,
        dailyPayment,
        interestInput,
        termMonths: Math.ceil(totalInstallments / 30),
        totalInstallments,
        installmentAmount: money(installmentAmount),
        totalRepayment: money(totalRepayment),
        totalInterest: money(totalInterest),
        dailyInterest: money(dailyInterest),
        flatDailyRatePercent: rate(flatDailyRatePercent),
        flatMonthlyRatePercent: rate(flatDailyRatePercent.times(30)),
        flatAnnualRatePercent: rate(flatDailyRatePercent.times(365)),
    };
}
