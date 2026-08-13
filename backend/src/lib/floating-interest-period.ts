import Decimal from "decimal.js";
import type { FloatingDailyInterestInput } from "./floating-daily-interest";

const DAY_MS = 86_400_000;

function dateValue(date: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) throw new Error("Business date must use YYYY-MM-DD");
    const value = new Date(`${date}T00:00:00Z`);
    if (Number.isNaN(value.valueOf()) || value.toISOString().slice(0, 10) !== date) throw new Error("Business date is invalid");
    return value;
}

function addDays(date: string, days: number) {
    const value = dateValue(date);
    value.setUTCDate(value.getUTCDate() + days);
    return value.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string) {
    return Math.round((dateValue(to).valueOf() - dateValue(from).valueOf()) / DAY_MS);
}

export function weeklySnapshotPeriod(anchorDate: string, accrualDate: string) {
    const elapsed = daysBetween(anchorDate, accrualDate);
    if (elapsed < 1) throw new Error("Weekly snapshot date must follow the period anchor");
    const periodIndex = Math.floor((elapsed - 1) / 7);
    const periodStartDate = addDays(anchorDate, periodIndex * 7);
    return {
        periodStartDate,
        periodEndDate: addDays(periodStartDate, 7),
        dayIndex: ((elapsed - 1) % 7) + 1,
        periodDays: 7,
    };
}

function contractualInterest(principal: string, mode: FloatingDailyInterestInput["mode"], rate: string) {
    const basis = new Decimal(principal);
    const quotedRate = new Decimal(rate);
    return mode === "per_thousand" ? basis.div(1000).times(quotedRate) : basis.times(quotedRate).div(100);
}

export function calculateWeeklyAccruedInterest(
    principal: string,
    mode: FloatingDailyInterestInput["mode"],
    rate: string,
    elapsedDays: number,
) {
    if (!Number.isInteger(elapsedDays) || elapsedDays < 1 || elapsedDays > 7) {
        throw new Error("Weekly elapsed days must be between one and seven");
    }
    const fullPeriod = contractualInterest(principal, mode, rate);
    const cumulative = fullPeriod.times(elapsedDays).div(7).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const previous = fullPeriod.times(elapsedDays - 1).div(7).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    return {
        cumulativeAmount: cumulative.toFixed(2),
        incrementAmount: cumulative.minus(previous).toFixed(2),
        elapsedDays,
        periodDays: 7,
    };
}

export function addBangkokCalendarDays(date: string, days: number) {
    return addDays(date, days);
}
