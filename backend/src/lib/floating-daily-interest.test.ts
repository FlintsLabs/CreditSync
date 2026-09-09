import { describe, expect, test } from "bun:test";
import { calculateDailyInterest, interestDatesThrough, nextInterestDate, normalizeFloatingDailyInterest } from "./floating-daily-interest";

describe("floating daily interest", () => {
    test("calculates fixed per-thousand and daily-percent rates in exact cents", () => {
        expect(calculateDailyInterest("5000.00", { mode: "per_thousand", rate: "15.00", firstDayTreatment: "deduct" })).toBe("75.00");
        expect(calculateDailyInterest("5000.00", { mode: "percent", rate: "1.50", firstDayTreatment: "start_next_day" })).toBe("75.00");
        expect(calculateDailyInterest("1000.00", { mode: "percent", rate: "1.235", firstDayTreatment: "deduct" })).toBe("12.35");
    });

    test("normalizes policy and chooses calendar dates based on first-day treatment", () => {
        expect(normalizeFloatingDailyInterest({ mode: "per_thousand", rate: "15", firstDayTreatment: "deduct" }))
            .toEqual({ mode: "per_thousand", rate: "15.0000", firstDayTreatment: "deduct", accrualCycle: "daily" });
        expect(interestDatesThrough("2026-08-06", "2026-08-08", "deduct")).toEqual(["2026-08-06", "2026-08-07", "2026-08-08"]);
        expect(interestDatesThrough("2026-08-06", "2026-08-08", "start_next_day")).toEqual(["2026-08-07", "2026-08-08"]);
    });

    // Break caught: a weekly policy omits the daily snapshots required for
    // interim projection and exact settlement.
    test("generates daily weekly-period snapshots from the contract anchor", () => {
        expect(interestDatesThrough("2026-08-10", "2026-08-13", "deduct", "weekly"))
            .toEqual(["2026-08-11", "2026-08-12", "2026-08-13"]);
        expect(interestDatesThrough("2026-08-10", "2026-08-13", "start_next_day", "weekly"))
            .toEqual(["2026-08-11", "2026-08-12", "2026-08-13"]);
        expect(nextInterestDate("2026-08-10", "deduct", "weekly")).toBe("2026-08-10");
        expect(nextInterestDate("2026-08-10", "start_next_day", "weekly")).toBe("2026-08-17");
        expect(calculateDailyInterest("5000.00", {
            mode: "percent", rate: "1.0000", firstDayTreatment: "start_next_day", accrualCycle: "weekly",
        })).toBe("50.00");
    });

    // Break caught: adding weekly support shifts omitted/explicit daily dates.
    test("keeps omitted and explicit daily cycles byte-for-byte compatible", () => {
        expect(interestDatesThrough("2026-08-10", "2026-08-12", "start_next_day"))
            .toEqual(["2026-08-11", "2026-08-12"]);
        expect(interestDatesThrough("2026-08-10", "2026-08-12", "start_next_day", "daily"))
            .toEqual(["2026-08-11", "2026-08-12"]);
        expect(nextInterestDate("2026-08-10", "start_next_day")).toBe("2026-08-11");
        expect(nextInterestDate("2026-08-10", "start_next_day", "daily")).toBe("2026-08-11");
    });

    // Break caught: hardening weekly input rejects a previously accepted
    // canonicalizable daily rate solely because it has a leading zero.
    test("preserves legacy daily Decimal rate canonicalization", () => {
        expect(normalizeFloatingDailyInterest({
            mode: "percent", rate: "01.0000", firstDayTreatment: "start_next_day", accrualCycle: "daily",
        })).toEqual({
            mode: "percent", rate: "1.0000", firstDayTreatment: "start_next_day", accrualCycle: "daily",
        });
    });
});
