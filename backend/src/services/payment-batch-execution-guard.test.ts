import { describe, expect, test } from "bun:test";
import { assertPaymentBatchPreviewFresh } from "./payment-batch-execution-guard";

describe("payment batch execution guard", () => {
    test("rejects an expired or stale preview before any financial writer runs", () => {
        expect(() => assertPaymentBatchPreviewFresh({ status: "ready", previewHash: "preview-a", confirmationHash: "confirm-a", expiresAt: new Date("2026-09-09T03:59:59.000Z") }, { previewHash: "preview-a", confirmationHash: "confirm-a", now: new Date("2026-09-09T04:00:00.000Z") })).toThrow("expired");
        expect(() => assertPaymentBatchPreviewFresh({ status: "ready", previewHash: "preview-a", confirmationHash: "confirm-a", expiresAt: new Date("2026-09-09T04:01:00.000Z") }, { previewHash: "preview-b", confirmationHash: "confirm-a", now: new Date("2026-09-09T04:00:00.000Z") })).toThrow("matches");
    });

    test("requires the latest ready confirmation", () => {
        expect(() => assertPaymentBatchPreviewFresh({ status: "stale", previewHash: "preview-a", confirmationHash: "confirm-a", expiresAt: new Date("2026-09-09T04:01:00.000Z") }, { previewHash: "preview-a", confirmationHash: "confirm-a", now: new Date("2026-09-09T04:00:00.000Z") })).toThrow("ready");
    });
});
