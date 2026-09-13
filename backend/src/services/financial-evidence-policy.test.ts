import { describe, expect, test } from "bun:test";
import { evaluateFinancialEvidence } from "./financial-evidence-policy";

describe("evaluateFinancialEvidence", () => {
    test("blocks a known pending intent even when the legacy flag is false", () => {
        expect(evaluateFinancialEvidence({ required: false, expectedCount: 0, readyCount: 0, pendingCount: 1, rejectedCount: 0 }))
            .toEqual({ allowed: false, code: "EVIDENCE_REQUIRED_NOT_READY" });
    });

    test("requires every declared attachment to be ready", () => {
        expect(evaluateFinancialEvidence({ required: true, expectedCount: 2, readyCount: 1, pendingCount: 1, rejectedCount: 0 }).allowed).toBe(false);
        expect(evaluateFinancialEvidence({ required: true, expectedCount: 2, readyCount: 2, pendingCount: 0, rejectedCount: 0 })).toEqual({ allowed: true, code: "READY" });
    });

    test("preserves data-only legacy behavior when no evidence is known", () => {
        expect(evaluateFinancialEvidence({ required: false, expectedCount: 0, readyCount: 0, pendingCount: 0, rejectedCount: 0 })).toEqual({ allowed: true, code: "READY" });
    });
});
