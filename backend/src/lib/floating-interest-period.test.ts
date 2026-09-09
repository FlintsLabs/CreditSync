import { describe, expect, test } from "bun:test";
import {
    calculateWeeklyAccruedInterest,
    weeklySnapshotPeriod,
} from "./floating-interest-period";

describe("floating weekly period interest", () => {
    // Break caught: a quoted weekly rate is divided and rounded once, losing
    // the contractual full-period amount and the day-three cumulative total.
    test("uses cumulative differences to reach exact interim and full-period amounts", () => {
        expect(calculateWeeklyAccruedInterest("5000.00", "percent", "12.0000", 1))
            .toEqual({ cumulativeAmount: "85.71", incrementAmount: "85.71", elapsedDays: 1, periodDays: 7 });
        expect(calculateWeeklyAccruedInterest("5000.00", "percent", "12.0000", 2))
            .toEqual({ cumulativeAmount: "171.43", incrementAmount: "85.72", elapsedDays: 2, periodDays: 7 });
        expect(calculateWeeklyAccruedInterest("5000.00", "percent", "12.0000", 3))
            .toEqual({ cumulativeAmount: "257.14", incrementAmount: "85.71", elapsedDays: 3, periodDays: 7 });
        expect(calculateWeeklyAccruedInterest("5000.00", "percent", "12.0000", 7))
            .toEqual({ cumulativeAmount: "600.00", incrementAmount: "85.71", elapsedDays: 7, periodDays: 7 });
    });

    test("anchors half-open weekly periods and treats boundary snapshots as day seven", () => {
        expect(weeklySnapshotPeriod("2026-08-10", "2026-08-13")).toEqual({
            periodStartDate: "2026-08-10", periodEndDate: "2026-08-17", dayIndex: 3, periodDays: 7,
        });
        expect(weeklySnapshotPeriod("2026-08-10", "2026-08-17")).toEqual({
            periodStartDate: "2026-08-10", periodEndDate: "2026-08-17", dayIndex: 7, periodDays: 7,
        });
        expect(weeklySnapshotPeriod("2026-08-10", "2026-08-18")).toEqual({
            periodStartDate: "2026-08-17", periodEndDate: "2026-08-24", dayIndex: 1, periodDays: 7,
        });
    });
});
