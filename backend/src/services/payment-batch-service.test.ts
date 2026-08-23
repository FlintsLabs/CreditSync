import { describe, expect, test } from "bun:test";
import { createPaymentBatch, previewPaymentBatch } from "./payment-batch-service";
import type { PreviewPaymentBatchInput } from "./payment-batch-service";

describe("payment batch service contract", () => {
    test("exports the lifecycle and preview entry points", () => {
        expect(typeof createPaymentBatch).toBe("function");
        expect(typeof previewPaymentBatch).toBe("function");
    });

    test("preview input is closed around one complete allocation revision", () => {
        const input: PreviewPaymentBatchInput = {
            borrowerPublicId: "00000000-0000-4000-8000-000000000001",
            allocations: [{ itemPublicId: "00000000-0000-4000-8000-000000000002", loanPublicId: "00000000-0000-4000-8000-000000000003", schedulePublicId: "00000000-0000-4000-8000-000000000004", amount: "10.00", targetDueDate: "2026-08-23", intent: "on_time" }],
        };
        expect(input.allocations).toHaveLength(1);
        expect(input.allocations![0]!.amount).toBe("10.00");
    });
});
