export type PaymentWorkflowBlocker = {
    code: string;
    intakePublicIds: string[];
    nextAction: "identity_review" | "evidence_recovery" | "continue_successor" | "refresh_preview" | "reconciliation" | "human_investigation";
    retryable: boolean;
};

const classifications: Record<string, Pick<PaymentWorkflowBlocker, "nextAction" | "retryable">> = {
    PAYMENT_DUPLICATE_REQUIRES_REVIEW: { nextAction: "identity_review", retryable: false },
    PAYMENT_DUPLICATE_REVIEW_HARD_IDENTITY_CONFLICT: { nextAction: "human_investigation", retryable: false },
    PAYMENT_REPLACEMENT_ALREADY_EXISTS: { nextAction: "continue_successor", retryable: false },
    PAYMENT_REPLACEMENT_EVIDENCE_NOT_READY: { nextAction: "evidence_recovery", retryable: false },
    PAYMENT_REPLACEMENT_EVIDENCE_INCOMPLETE: { nextAction: "evidence_recovery", retryable: false },
    PAYMENT_REPLACEMENT_STALE: { nextAction: "refresh_preview", retryable: true },
    PAYMENT_REPLACEMENT_SOURCE_HAS_FINANCIAL_DEPENDENCY: { nextAction: "reconciliation", retryable: false },
    PAYMENT_DUPLICATE_REVIEW_STALE: { nextAction: "refresh_preview", retryable: true },
    PAYMENT_DUPLICATE_REVIEW_DEPENDENCY_BLOCKED: { nextAction: "reconciliation", retryable: false },
};

export function classifyPaymentWorkflowBlocker(code: string, intakePublicIds: readonly string[] = []): PaymentWorkflowBlocker {
    const classification = classifications[code] ?? { nextAction: "human_investigation" as const, retryable: false };
    return { code, intakePublicIds: [...new Set(intakePublicIds)], ...classification };
}

export function classifyPaymentWorkflowBlockers(codes: readonly { code: string; intakePublicIds?: readonly string[] }[]): PaymentWorkflowBlocker[] {
    return codes.map((item) => classifyPaymentWorkflowBlocker(item.code, item.intakePublicIds));
}
