import { createHash } from "node:crypto";
import Decimal from "decimal.js";

export type RateType = "percent" | "per_thousand";

export type RatePeriodInput = {
    effectiveDate: string;
    expiryDate: string | null;
    rateType: RateType;
    rate: string;
};

export type RatePeriodValue = RatePeriodInput & {
    publicId: string;
};

export type RateRangeReplacementInput = RatePeriodInput & {
    newPublicId: string;
};

function dateValue(date: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Business date is invalid");
    const value = new Date(`${date}T00:00:00.000Z`);
    if (Number.isNaN(value.valueOf()) || value.toISOString().slice(0, 10) !== date) {
        throw new Error("Business date is invalid");
    }
    return value;
}

function shiftDate(date: string, days: number) {
    const value = dateValue(date);
    value.setUTCDate(value.getUTCDate() + days);
    return value.toISOString().slice(0, 10);
}

function previousDate(date: string) {
    return shiftDate(date, -1);
}

function nextDate(date: string) {
    return shiftDate(date, 1);
}

function normalizeRate(rate: string) {
    let value: Decimal;
    try {
        value = new Decimal(rate);
    } catch {
        throw new Error("Interest rate is invalid");
    }
    if (!value.isFinite() || value.lte(0)) throw new Error("Interest rate must be positive");
    if (value.decimalPlaces() > 4) throw new Error("Interest rate must have at most four decimal places");
    return value.toFixed(4);
}

export function normalizeRatePeriodInput(input: RatePeriodInput, publicId: string): RatePeriodValue {
    dateValue(input.effectiveDate);
    if (input.expiryDate !== null) {
        dateValue(input.expiryDate);
        if (input.expiryDate < input.effectiveDate) throw new Error("Interest rate expiry date must not precede its effective date");
    }
    if (input.rateType !== "percent" && input.rateType !== "per_thousand") {
        throw new Error("Interest rate type is invalid");
    }
    if (!publicId.trim()) throw new Error("Interest rate period public ID is invalid");
    return {
        publicId,
        effectiveDate: input.effectiveDate,
        expiryDate: input.expiryDate,
        rateType: input.rateType,
        rate: normalizeRate(input.rate),
    };
}

function sortedPeriods(periods: RatePeriodValue[]) {
    const normalized = periods
        .map((period) => normalizeRatePeriodInput(period, period.publicId))
        .sort((left, right) => left.effectiveDate.localeCompare(right.effectiveDate));
    for (let index = 1; index < normalized.length; index += 1) {
        const previous = normalized[index - 1]!;
        const current = normalized[index]!;
        if (previous.expiryDate === null || current.effectiveDate <= previous.expiryDate) {
            throw new Error("Interest rate periods overlap");
        }
    }
    return normalized;
}

export function resolveRatePeriod(periods: RatePeriodValue[], date: string): RatePeriodValue | null {
    dateValue(date);
    return sortedPeriods(periods).find((period) => (
        period.effectiveDate <= date && (period.expiryDate === null || date <= period.expiryDate)
    )) ?? null;
}

function intersects(period: RatePeriodValue, start: string, end: string | null) {
    return (period.expiryDate === null || period.expiryDate >= start)
        && (end === null || period.effectiveDate <= end);
}

function areAdjacent(left: RatePeriodValue, right: RatePeriodValue) {
    return left.expiryDate !== null && nextDate(left.expiryDate) === right.effectiveDate;
}

function mergeIdenticalAdjacent(periods: RatePeriodValue[]) {
    const merged: RatePeriodValue[] = [];
    for (const period of sortedPeriods(periods)) {
        const previous = merged.at(-1);
        if (previous && previous.rateType === period.rateType && previous.rate === period.rate && areAdjacent(previous, period)) {
            previous.expiryDate = period.expiryDate;
        } else {
            merged.push({ ...period });
        }
    }
    return merged;
}

export function replaceRateRange(periods: RatePeriodValue[], input: RateRangeReplacementInput) {
    const existing = sortedPeriods(periods);
    const replacement = normalizeRatePeriodInput(input, input.newPublicId);
    const timeline: RatePeriodValue[] = [];
    const supersededPublicIds: string[] = [];

    for (const period of existing) {
        if (!intersects(period, replacement.effectiveDate, replacement.expiryDate)) {
            timeline.push({ ...period });
            continue;
        }
        supersededPublicIds.push(period.publicId);
        if (period.effectiveDate < replacement.effectiveDate) {
            timeline.push({ ...period, expiryDate: previousDate(replacement.effectiveDate) });
        }
        if (replacement.expiryDate !== null && (period.expiryDate === null || period.expiryDate > replacement.expiryDate)) {
            timeline.push({
                ...period,
                publicId: `${period.publicId}:tail`,
                effectiveDate: nextDate(replacement.expiryDate),
            });
        }
    }
    timeline.push(replacement);

    return {
        timeline: mergeIdenticalAdjacent(timeline),
        supersededPublicIds,
    };
}

export function timelineVersion(periods: RatePeriodValue[]) {
    const canonical = sortedPeriods(periods).map(({ publicId, effectiveDate, expiryDate, rateType, rate }) => ({
        publicId, effectiveDate, expiryDate, rateType, rate,
    }));
    return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}
