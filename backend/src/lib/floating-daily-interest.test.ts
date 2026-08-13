import { describe, expect, test } from "bun:test";
import { calculateDailyInterest, interestDatesThrough, normalizeFloatingDailyInterest } from "./floating-daily-interest";

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
});
