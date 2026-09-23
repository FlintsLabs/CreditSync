import { describe, expect, test } from "bun:test";
import { isTransientPaymentWorkflowError } from "./payment-workflow-locks";

describe("payment workflow transaction policy", () => {
    test("retries only PostgreSQL deadlock/serialization failures", () => {
        expect(isTransientPaymentWorkflowError({ code: "40P01" })).toBe(true);
        expect(isTransientPaymentWorkflowError({ code: "40001" })).toBe(true);
        expect(isTransientPaymentWorkflowError({ code: "23505" })).toBe(false);
        expect(isTransientPaymentWorkflowError(new Error("timeout"))).toBe(false);
    });
});
