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

    test("does not treat unresolved counts as ready", () => {
        expect(evaluateFinancialEvidence({ required: false, expectedCount: 1, readyCount: 1, pendingCount: 1, rejectedCount: 0 })).toEqual({ allowed: false, code: "EVIDENCE_REQUIRED_NOT_READY" });
        expect(evaluateFinancialEvidence({ required: false, expectedCount: 1, readyCount: 1, pendingCount: 0, rejectedCount: 1 })).toEqual({ allowed: false, code: "EVIDENCE_REQUIRED_NOT_READY" });
        expect(evaluateFinancialEvidence({ required: true, expectedCount: 0, readyCount: 0, pendingCount: 0, rejectedCount: 0 })).toEqual({ allowed: false, code: "EVIDENCE_REQUIRED_NOT_READY" });
    });

    test("fails closed for invalid or unknown runtime state", () => {
        const invalidStates = [
            { required: false, expectedCount: undefined, readyCount: 0, pendingCount: 0, rejectedCount: 0 },
            { required: false, expectedCount: Number.NaN, readyCount: 0, pendingCount: 0, rejectedCount: 0 },
            { required: false, expectedCount: -1, readyCount: 0, pendingCount: 0, rejectedCount: 0 },
            { required: false, expectedCount: 0.5, readyCount: 1, pendingCount: 0, rejectedCount: 0 },
            { required: false, expectedCount: Number.POSITIVE_INFINITY, readyCount: 1, pendingCount: 0, rejectedCount: 0 },
            { required: "false", expectedCount: 0, readyCount: 0, pendingCount: 0, rejectedCount: 0 },
            { required: false, expectedCount: 0, readyCount: Number.NaN, pendingCount: 0, rejectedCount: 0 },
            { required: false, expectedCount: 0, readyCount: 0, pendingCount: -1, rejectedCount: 0 },
        ] as unknown as Parameters<typeof evaluateFinancialEvidence>[0][];
        for (const state of invalidStates) {
            expect(evaluateFinancialEvidence(state)).toEqual({ allowed: false, code: "EVIDENCE_REQUIRED_NOT_READY" });
        }
    });
});
