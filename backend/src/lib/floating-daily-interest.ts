import type Decimal from "decimal.js";
import { FinancialDecimal } from "./financial-decimal";

export type FloatingAccrualCycle = "daily" | "weekly" | "monthly";

export type FloatingDailyInterestInput = {
    mode: "per_thousand" | "percent";
    rate: string;
    firstDayTreatment: "deduct" | "start_next_day";
    accrualCycle?: FloatingAccrualCycle;
};

export type FloatingDailyInterest = Omit<FloatingDailyInterestInput, "accrualCycle"> & {
    accrualCycle: FloatingAccrualCycle;
};

export function normalizeFloatingDailyInterest(input: FloatingDailyInterestInput): FloatingDailyInterest {
    if (input.mode !== "per_thousand" && input.mode !== "percent") throw new Error("Daily interest mode is invalid");
    if (input.firstDayTreatment !== "deduct" && input.firstDayTreatment !== "start_next_day") {
        throw new Error("First-day treatment is invalid");
    }
    if (input.accrualCycle !== undefined && !["daily", "weekly", "monthly"].includes(input.accrualCycle)) {
        throw new Error("Floating accrual cycle is invalid");
    }
    const decimalSyntax = /^[+-]?(?:\d+(?:\.(\d*))?|\.(\d+))(?:e[+-]?\d+)?$/iu.exec(input.rate);
    const suppliedFraction = decimalSyntax?.[1] ?? decimalSyntax?.[2] ?? "";
    if (!decimalSyntax || suppliedFraction.length > 4) {
        throw new Error("Daily interest rate must be a positive decimal with at most four places");
    }
    let rate: Decimal;
    try {
        rate = new FinancialDecimal(input.rate);
    } catch {
        throw new Error("Daily interest rate must be a positive decimal with at most four places");
    }
    if (!rate.isFinite() || rate.lte(0) || rate.decimalPlaces() > 4) {
        throw new Error("Daily interest rate must be a positive decimal with at most four places");
    }
    return { mode: input.mode, rate: rate.toFixed(4), firstDayTreatment: input.firstDayTreatment, accrualCycle: input.accrualCycle ?? "daily" };
}

export function calculateDailyInterest(openingPrincipal: string, policy: FloatingDailyInterestInput) {
    const normalized = normalizeFloatingDailyInterest(policy);
    const principal = new FinancialDecimal(openingPrincipal);
    if (!principal.isFinite() || principal.lt(0)) throw new Error("Opening principal is invalid");
    const amount = normalized.mode === "per_thousand"
        ? principal.div(1000).times(normalized.rate)
        : principal.times(normalized.rate).div(100);
    return amount.toDecimalPlaces(2, FinancialDecimal.ROUND_HALF_UP).toFixed(2);
}

function dateAtMidnight(date: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Business date must use YYYY-MM-DD");
    const value = new Date(`${date}T00:00:00Z`);
    if (Number.isNaN(value.valueOf()) || value.toISOString().slice(0, 10) !== date) throw new Error("Business date is invalid");
    return value;
}

function formatDate(value: Date) {
    return value.toISOString().slice(0, 10);
}

export function interestDatesThrough(
    startDate: string,
    throughDate: string,
    firstDayTreatment: FloatingDailyInterest["firstDayTreatment"],
    accrualCycle: FloatingAccrualCycle = "daily",
) {
    const start = dateAtMidnight(startDate);
    const through = dateAtMidnight(throughDate);
    if (through < start) return [];
    if (firstDayTreatment !== "deduct" && firstDayTreatment !== "start_next_day") throw new Error("First-day treatment is invalid");
    if (!["daily", "weekly", "monthly"].includes(accrualCycle)) throw new Error("Floating accrual cycle is invalid");
    if (accrualCycle === "weekly" || firstDayTreatment === "start_next_day") start.setUTCDate(start.getUTCDate() + 1);
    const dates: string[] = [];
    while (start <= through) {
        dates.push(formatDate(start));
        start.setUTCDate(start.getUTCDate() + 1);
    }
    return dates;
}

export function nextInterestDate(
    startDate: string,
    firstDayTreatment: FloatingDailyInterest["firstDayTreatment"],
    accrualCycle: FloatingAccrualCycle = "daily",
) {
    const start = dateAtMidnight(startDate);
    if (!["daily", "weekly", "monthly"].includes(accrualCycle)) throw new Error("Floating accrual cycle is invalid");
    if (firstDayTreatment === "deduct") return formatDate(start);
    if (firstDayTreatment !== "start_next_day") throw new Error("First-day treatment is invalid");
    if (accrualCycle === "monthly") {
        const day = start.getUTCDate();
        start.setUTCDate(1);
        start.setUTCMonth(start.getUTCMonth() + 1);
        const lastDay = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate();
        start.setUTCDate(Math.min(day, lastDay));
    }
    else start.setUTCDate(start.getUTCDate() + (accrualCycle === "weekly" ? 7 : 1));
    return formatDate(start);
}
