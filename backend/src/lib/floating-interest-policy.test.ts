import { describe, expect, test } from "bun:test";
import {
    calculateAccruedInterest,
    calculatePeriodInterest,
    interestPeriodFor,
    normalizeFloatingInterestPolicy,
} from "./floating-interest-policy";

const weeklyPolicy = normalizeFloatingInterestPolicy({
    periodUnit: "week",
    periodLength: 1,
    rateMode: "percent",
    rate: "12",
    advanceInterestPeriods: 0,
    advanceInterestRefundPolicy: "non_refundable",
});

describe("floating interest period policy", () => {
    test("keeps a weekly contractual rate and reaches its exact period amount", () => {
        // Break caught: dividing a rounded daily amount loses a cent before the contractual weekly amount is reached.
        expect(weeklyPolicy.rate).toBe("12.0000");
        expect(calculateAccruedInterest("5000.00", weeklyPolicy, 3)).toMatchObject({
            cumulativeAmount: "257.14",
            incrementAmount: "85.71",
            elapsedDays: 3,
            periodDays: 7,
        });
        expect(calculateAccruedInterest("5000.00", weeklyPolicy, 7).cumulativeAmount).toBe("600.00");
        expect(calculatePeriodInterest("5000.00", weeklyPolicy)).toBe("600.00");
    });

    test("prorates from an unrounded fractional-cent weekly contractual amount", () => {
        // Break caught: rounding the full-period amount before proration overcharges affected daily cumulative amounts.
        const policy = normalizeFloatingInterestPolicy({ ...weeklyPolicy, rate: "1.0051" });

        expect(calculateAccruedInterest("100.00", policy, 4)).toMatchObject({
            cumulativeAmount: "0.57",
            incrementAmount: "0.14",
        });
        expect(calculateAccruedInterest("100.00", policy, 6)).toMatchObject({
            cumulativeAmount: "0.86",
            incrementAmount: "0.14",
        });
        expect(calculateAccruedInterest("100.00", policy, 7)).toMatchObject({
            cumulativeAmount: "1.01",
            incrementAmount: "0.15",
        });
    });

    test("uses half-open Bangkok weekly periods", () => {
        // Break caught: treating the excluded weekly boundary as the seventh day of the previous period.
        expect(interestPeriodFor("2026-08-13", "2026-08-20", weeklyPolicy)).toEqual({
            periodStart: "2026-08-20",
            nextPeriodStart: "2026-08-27",
            dayIndex: 0,
            periodDays: 7,
        });
    });

    test("validates the supported unit, one-period length, rate, and advance policy", () => {
        // Break caught: malformed policy values silently change a financial contract.
        expect(() => normalizeFloatingInterestPolicy({ ...weeklyPolicy, periodUnit: "month" as "week" })).toThrow("unit");
        expect(() => normalizeFloatingInterestPolicy({ ...weeklyPolicy, periodLength: 2 as unknown as 1 })).toThrow("length");
        expect(() => normalizeFloatingInterestPolicy({ ...weeklyPolicy, rate: "0" })).toThrow("positive");
        expect(() => normalizeFloatingInterestPolicy({ ...weeklyPolicy, rate: "1.00001" })).toThrow("four");
        expect(() => normalizeFloatingInterestPolicy({ ...weeklyPolicy, advanceInterestPeriods: 2 as unknown as 0 })).toThrow("advance");
        expect(() => normalizeFloatingInterestPolicy({ ...weeklyPolicy, advanceInterestRefundPolicy: "refundable" as "non_refundable" })).toThrow("refund");
    });

    test("calculates exact per-thousand daily policy interest", () => {
        // Break caught: applying a per-thousand policy as a percentage changes the contractual amount by 100 times.
        const policy = normalizeFloatingInterestPolicy({
            periodUnit: "day",
            periodLength: 1,
            rateMode: "per_thousand",
            rate: "15",
            advanceInterestPeriods: 1,
            advanceInterestRefundPolicy: "non_refundable",
        });

        expect(calculatePeriodInterest("5000.00", policy)).toBe("75.00");
        expect(calculateAccruedInterest("5000.00", policy, 1)).toEqual({
            cumulativeAmount: "75.00",
            incrementAmount: "75.00",
            elapsedDays: 1,
            periodDays: 1,
        });
    });
});
