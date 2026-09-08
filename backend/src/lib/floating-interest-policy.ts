import type Decimal from "decimal.js";
import { FinancialDecimal } from "./financial-decimal";
import { parseMoney, serializeMoney } from "./money";

export type FloatingInterestPolicy = {
    periodUnit: "day" | "week" | "month";
    periodLength: 1;
    rateMode: "percent" | "per_thousand";
    rate: string;
    advanceInterestPeriods: 0 | 1;
    advanceInterestRefundPolicy: "non_refundable";
};

type InterestPeriod = {
    periodStart: string;
    nextPeriodStart: string;
    dayIndex: number;
    periodDays: number;
};

function normalizeRate(rate: string) {
    let value: Decimal;
    try {
        value = new FinancialDecimal(rate);
    } catch {
        throw new Error("Floating interest rate is invalid");
    }
    if (!value.isFinite() || value.lte(0)) {
        throw new Error("Floating interest rate must be positive");
    }
    if (value.decimalPlaces() > 4) {
        throw new Error("Floating interest rate must have at most four decimal places");
    }
    return value.toFixed(4);
}

function dateValue(date: string, label: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`${label} must use YYYY-MM-DD`);
    const value = new Date(`${date}T00:00:00.000Z`);
    if (Number.isNaN(value.valueOf()) || value.toISOString().slice(0, 10) !== date) {
        throw new Error(`${label} is invalid`);
    }
    return value;
}

function addBusinessDays(date: string, days: number) {
    const value = dateValue(date, "Business date");
    value.setUTCDate(value.getUTCDate() + days);
    return value.toISOString().slice(0, 10);
}

function periodDaysFor(policy: FloatingInterestPolicy, periodDaysOverride?: number) {
    return periodDaysOverride ?? (policy.periodUnit === "day" ? 1 : policy.periodUnit === "week" ? 7 : 30);
}

function addCalendarMonths(date: string, months: number) {
    const value = dateValue(date, "Business date");
    const day = value.getUTCDate();
    value.setUTCDate(1);
    value.setUTCMonth(value.getUTCMonth() + months);
    const lastDay = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 0)).getUTCDate();
    value.setUTCDate(Math.min(day, lastDay));
    return value.toISOString().slice(0, 10);
}

function decimalPrincipal(principal: string) {
    let value: Decimal;
    try {
        value = parseMoney(principal);
    } catch {
        throw new Error("Principal is invalid");
    }
    if (!value.isFinite() || value.lt(0)) throw new Error("Principal is invalid");
    return value;
}

function roundMoney(value: Decimal) {
    return serializeMoney(value);
}

function periodInterestAmount(principal: string, policy: FloatingInterestPolicy) {
    const value = decimalPrincipal(principal);
    return policy.rateMode === "percent"
        ? value.times(policy.rate).div(100)
        : value.times(policy.rate).div(1000);
}

export function normalizeFloatingInterestPolicy(input: FloatingInterestPolicy): FloatingInterestPolicy {
    if (input.periodUnit !== "day" && input.periodUnit !== "week" && input.periodUnit !== "month") {
        throw new Error("Floating interest period unit is invalid");
    }
    if (!Number.isInteger(input.periodLength) || input.periodLength !== 1) {
        throw new Error("Floating interest period length is invalid");
    }
    if (input.rateMode !== "percent" && input.rateMode !== "per_thousand") {
        throw new Error("Floating interest rate mode is invalid");
    }
    if (input.advanceInterestPeriods !== 0 && input.advanceInterestPeriods !== 1) {
        throw new Error("Floating interest advance periods are invalid");
    }
    if (input.advanceInterestRefundPolicy !== "non_refundable") {
        throw new Error("Floating interest advance refund policy is invalid");
    }
    return {
        periodUnit: input.periodUnit,
        periodLength: input.periodLength,
        rateMode: input.rateMode,
        rate: normalizeRate(input.rate),
        advanceInterestPeriods: input.advanceInterestPeriods,
        advanceInterestRefundPolicy: input.advanceInterestRefundPolicy,
    };
}

export function interestPeriodFor(anchorDate: string, businessDate: string, policy: FloatingInterestPolicy): InterestPeriod {
    const normalized = normalizeFloatingInterestPolicy(policy);
    const anchor = dateValue(anchorDate, "Anchor date");
    const business = dateValue(businessDate, "Business date");
    const elapsedCalendarDays = Math.round((business.valueOf() - anchor.valueOf()) / 86_400_000);
    if (elapsedCalendarDays < 0) throw new Error("Business date cannot precede anchor date");
    if (normalized.periodUnit === "month") {
        let periodIndex = Math.max(0, (business.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + business.getUTCMonth() - anchor.getUTCMonth());
        let periodStart = addCalendarMonths(anchorDate, periodIndex);
        if (periodStart > businessDate) {
            periodIndex -= 1;
            periodStart = addCalendarMonths(anchorDate, periodIndex);
        }
        const nextPeriodStart = addCalendarMonths(anchorDate, periodIndex + 1);
        const periodDays = Math.round((dateValue(nextPeriodStart, "Business date").valueOf() - dateValue(periodStart, "Business date").valueOf()) / 86_400_000);
        const dayIndex = Math.round((business.valueOf() - dateValue(periodStart, "Business date").valueOf()) / 86_400_000);
        return { periodStart, nextPeriodStart, dayIndex, periodDays };
    }
    const periodDays = periodDaysFor(normalized);
    const periodIndex = Math.floor(elapsedCalendarDays / periodDays);
    const dayIndex = elapsedCalendarDays - (periodIndex * periodDays);
    const periodStart = addBusinessDays(anchorDate, periodIndex * periodDays);

    return {
        periodStart,
        nextPeriodStart: addBusinessDays(periodStart, periodDays),
        dayIndex,
        periodDays,
    };
}

export function calculatePeriodInterest(principal: string, policy: FloatingInterestPolicy) {
    const normalized = normalizeFloatingInterestPolicy(policy);
    return roundMoney(periodInterestAmount(principal, normalized));
}

export function calculateAccruedInterest(principal: string, policy: FloatingInterestPolicy, elapsedDays: number, periodDaysOverride?: number) {
    const normalized = normalizeFloatingInterestPolicy(policy);
    const periodDays = periodDaysFor(normalized, periodDaysOverride);
    if (!Number.isInteger(elapsedDays) || elapsedDays < 0 || elapsedDays > periodDays) {
        throw new Error("Elapsed days must be within the interest period");
    }

    const periodInterest = periodInterestAmount(principal, normalized);
    const cumulative = periodInterest.times(elapsedDays).div(periodDays);
    const previousCumulative = elapsedDays === 0
        ? new FinancialDecimal("0")
        : periodInterest.times(elapsedDays - 1).div(periodDays);
    const cumulativeAmount = new FinancialDecimal(roundMoney(cumulative));
    const incrementAmount = cumulativeAmount.minus(roundMoney(previousCumulative));

    return {
        cumulativeAmount: cumulativeAmount.toFixed(2),
        incrementAmount: incrementAmount.toFixed(2),
        elapsedDays,
        periodDays,
    };
}
