import { describe, expect, test } from "bun:test";
import { classifyPaymentWorkflowBlocker } from "./payment-workflow-blockers";

describe("payment workflow blockers", () => {
    test("maps the three recovery dead ends to legal next actions", () => {
        expect(classifyPaymentWorkflowBlocker("PAYMENT_DUPLICATE_REQUIRES_REVIEW", ["a", "a"])).toEqual({ code: "PAYMENT_DUPLICATE_REQUIRES_REVIEW", intakePublicIds: ["a"], nextAction: "identity_review", retryable: false });
        expect(classifyPaymentWorkflowBlocker("PAYMENT_REPLACEMENT_EVIDENCE_INCOMPLETE").nextAction).toBe("evidence_recovery");
        expect(classifyPaymentWorkflowBlocker("PAYMENT_REPLACEMENT_ALREADY_EXISTS").nextAction).toBe("continue_successor");
    });

    test("does not turn unknown financial conflicts into retry loops", () => {
        expect(classifyPaymentWorkflowBlocker("UNKNOWN_FINANCIAL_CONFLICT").retryable).toBe(false);
        expect(classifyPaymentWorkflowBlocker("PAYMENT_REPLACEMENT_STALE").retryable).toBe(true);
    });
});
