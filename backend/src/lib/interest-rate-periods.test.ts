import { describe, expect, test } from "bun:test";
import {
    normalizeRatePeriodInput,
    replaceRateRange,
    resolveRatePeriod,
    timelineVersion,
    type RatePeriodValue,
} from "./interest-rate-periods";

const openEnded: RatePeriodValue = {
    publicId: "period-old",
    effectiveDate: "2026-08-01",
    expiryDate: null,
    rateType: "per_thousand",
    rate: "15.0000",
};

describe("interest rate periods", () => {
    test("normalizes an inclusive period and resolves both boundary dates", () => {
        const period = normalizeRatePeriodInput({
            effectiveDate: "2026-09-01",
            expiryDate: "2026-09-30",
            rateType: "per_thousand",
            rate: "18",
        }, "period-new");

        expect(period.rate).toBe("18.0000");
        expect(resolveRatePeriod([period], "2026-09-01")?.publicId).toBe("period-new");
        expect(resolveRatePeriod([period], "2026-09-30")?.publicId).toBe("period-new");
        expect(resolveRatePeriod([period], "2026-10-01")).toBeNull();
    });

    test("rejects invalid dates, reversed ranges, invalid types, and invalid rates", () => {
        expect(() => normalizeRatePeriodInput({ effectiveDate: "2026-02-30", expiryDate: null, rateType: "percent", rate: "1" }, "x")).toThrow("invalid");
        expect(() => normalizeRatePeriodInput({ effectiveDate: "2026-09-02", expiryDate: "2026-09-01", rateType: "percent", rate: "1" }, "x")).toThrow("expiry");
        expect(() => normalizeRatePeriodInput({ effectiveDate: "2026-09-01", expiryDate: null, rateType: "basis_points" as "percent", rate: "1" }, "x")).toThrow("type");
        expect(() => normalizeRatePeriodInput({ effectiveDate: "2026-09-01", expiryDate: null, rateType: "percent", rate: "0" }, "x")).toThrow("positive");
        expect(() => normalizeRatePeriodInput({ effectiveDate: "2026-09-01", expiryDate: null, rateType: "percent", rate: "1.00001" }, "x")).toThrow("four");
    });

    test("splits an open-ended period around a bounded replacement", () => {
        expect(replaceRateRange([openEnded], {
            newPublicId: "period-new",
            effectiveDate: "2026-09-01",
            expiryDate: "2026-09-30",
            rateType: "per_thousand",
            rate: "18",
        })).toEqual({
            timeline: [
                { ...openEnded, expiryDate: "2026-08-31" },
                { publicId: "period-new", effectiveDate: "2026-09-01", expiryDate: "2026-09-30", rateType: "per_thousand", rate: "18.0000" },
                { ...openEnded, publicId: "period-old:tail", effectiveDate: "2026-10-01" },
            ],
            supersededPublicIds: ["period-old"],
        });
    });

    test("an open-ended replacement removes every covered right-hand period", () => {
        const periods: RatePeriodValue[] = [
            { ...openEnded, expiryDate: "2026-08-31" },
            { publicId: "period-second", effectiveDate: "2026-09-01", expiryDate: null, rateType: "percent", rate: "1.0000" },
        ];

        expect(replaceRateRange(periods, {
            newPublicId: "period-new", effectiveDate: "2026-08-15", expiryDate: null,
            rateType: "percent", rate: "2",
        })).toEqual({
            timeline: [
                { ...openEnded, expiryDate: "2026-08-14" },
                { publicId: "period-new", effectiveDate: "2026-08-15", expiryDate: null, rateType: "percent", rate: "2.0000" },
            ],
            supersededPublicIds: ["period-old", "period-second"],
        });
    });

    test("merges an identical adjacent replacement into one minimal period", () => {
        const result = replaceRateRange([{ ...openEnded, expiryDate: "2026-08-31" }], {
            newPublicId: "period-new", effectiveDate: "2026-09-01", expiryDate: null,
            rateType: "per_thousand", rate: "15",
        });

        expect(result.timeline).toEqual([{ ...openEnded }]);
        expect(result.supersededPublicIds).toEqual([]);
    });

    test("timeline version ignores input ordering but changes with financial terms", () => {
        const first: RatePeriodValue = { ...openEnded, expiryDate: "2026-08-31" };
        const second: RatePeriodValue = { publicId: "period-second", effectiveDate: "2026-09-01", expiryDate: null, rateType: "percent", rate: "1.0000" };

        expect(timelineVersion([first, second])).toBe(timelineVersion([second, first]));
        expect(timelineVersion([first, second])).not.toBe(timelineVersion([first, { ...second, rate: "2.0000" }]));
    });
});
