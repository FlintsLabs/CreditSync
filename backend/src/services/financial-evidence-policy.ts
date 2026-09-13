export type FinancialEvidenceState = {
    required: boolean;
    expectedCount: number;
    readyCount: number;
    pendingCount: number;
    rejectedCount: number;
};

export type EvidenceDecision = {
    allowed: boolean;
    code: "READY" | "EVIDENCE_REQUIRED_NOT_READY";
};

/**
 * Decide whether an immutable financial transition may consume evidence.
 * Counts are supplied by an authoritative service query; this function never
 * interprets client flags or computes financial values.
 */
export function evaluateFinancialEvidence(state: FinancialEvidenceState): EvidenceDecision {
    const counts = [state.expectedCount, state.readyCount, state.pendingCount, state.rejectedCount];
    if (typeof state.required !== "boolean" || counts.some((value) => !Number.isSafeInteger(value) || value < 0)) {
        return { allowed: false, code: "EVIDENCE_REQUIRED_NOT_READY" };
    }
    const minimum = state.required || state.expectedCount > 0 ? Math.max(1, state.expectedCount) : 0;
    const unresolved = state.pendingCount > 0 || state.rejectedCount > 0;
    const complete = minimum === 0 || state.readyCount >= minimum;
    return unresolved || !complete
        ? { allowed: false, code: "EVIDENCE_REQUIRED_NOT_READY" }
        : { allowed: true, code: "READY" };
}
