import { describe, expect, test } from "bun:test";
import { evaluateConformanceResult } from "./conformance-result";

describe("conformance completion gate", () => {
    test("accepts a complete nonzero successful summary", () => {
        expect(evaluateConformanceResult("Passed: 28/28, 0 failed, 0 warnings", 0)).toEqual({
            checks: { passed: 28, denominator: 28, failed: 0, warnings: 0 }, passed: true,
        });
    });

    test.each([
        "", "runner started but no report", "Passed: 0/0, 0 failed, 0 warnings",
        "Passed: 2/3, 0 failed, 0 warnings", "Passed: 3/3, 1 failed, 0 warnings",
        "Passed: 4/3, 0 failed, 0 warnings", "Passed: many/all, 0 failed, 0 warnings",
    ])("rejects incomplete or inconsistent zero-exit evidence: %s", (output) => {
        expect(evaluateConformanceResult(output, 0).passed).toBe(false);
    });

    test("a valid summary cannot override a failed runner exit", () => {
        expect(evaluateConformanceResult("Passed: 28/28, 0 failed, 0 warnings", 1).passed).toBe(false);
    });
});
