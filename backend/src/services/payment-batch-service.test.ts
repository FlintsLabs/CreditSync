import { describe, expect, test } from "bun:test";
import { createPaymentBatch, previewPaymentBatch } from "./payment-batch-service";

describe("payment batch service contract", () => {
    test("exports the lifecycle and preview entry points", () => {
        expect(typeof createPaymentBatch).toBe("function");
        expect(typeof previewPaymentBatch).toBe("function");
    });
});
