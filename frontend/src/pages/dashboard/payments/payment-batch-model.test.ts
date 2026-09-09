import { describe, expect, it } from "vitest";
import { batchTotal, isBatchReady, normalizeMoney, semanticSummary, toExplicitBatchAllocations } from "./payment-batch-model";

describe("payment batch model", () => {
    it("uses exact decimal strings for totals", () => {
        expect(normalizeMoney("9007199254740993.1")).toBe("9007199254740993.10");
        expect(batchTotal([{ id: "a", paymentIntakePublicId: "i", amount: "0.10", targetDueDate: "2026-08-23", intent: "on_time", loanPublicId: "l", schedulePublicId: "s" }, { id: "b", paymentIntakePublicId: "j", amount: "0.20", targetDueDate: "2026-08-23", intent: "on_time", loanPublicId: "l", schedulePublicId: "s" }])).toBe("0.30");
    });
    it("requires a latest warning-free preview and confirmation", () => {
        const item = { id: "a", paymentIntakePublicId: "i", amount: "50", targetDueDate: "2026-08-23", intent: "on_time" as const, loanPublicId: "loan", schedulePublicId: "schedule" };
        const preview = { publicId: "preview", status: "ready", version: 1, previewHash: "p", confirmationHash: "c", evidenceReady: true, allocations: [{ itemPublicId: "item", loanPublicId: "loan", schedulePublicId: "schedule", amount: "50.00", targetDueDate: "2026-08-23", intent: "on_time" as const }], candidates: [], warnings: [] };
        expect(isBatchReady([item], "borrower", false, preview)).toBe(false);
        expect(isBatchReady([item], "borrower", true, preview)).toBe(true);
    });
    it("normalizes the semantic preview without changing intent", () => {
        expect(semanticSummary([{ id: "a", paymentIntakePublicId: "i", amount: "50.5", targetDueDate: "2026-08-23", intent: "advance", loanPublicId: "loan", schedulePublicId: "schedule" }])[0]).toMatchObject({ amount: "50.50", intent: "advance" });
    });
    it("maps every editor row to exact closed allocations in stable order", () => {
        const rows = [
            { id: "a", paymentIntakePublicId: "i", amount: "30.1", targetDueDate: "2026-08-23", intent: "on_time" as const, loanPublicId: "loan-a", schedulePublicId: "schedule-a" },
            { id: "b", paymentIntakePublicId: "j", amount: "20", targetDueDate: "2026-08-24", intent: "backdated" as const, loanPublicId: "loan-b", schedulePublicId: "schedule-b" },
        ];
        expect(toExplicitBatchAllocations(rows, ["item-a", "item-b"])).toEqual([
            { itemPublicId: "item-a", loanPublicId: "loan-a", schedulePublicId: "schedule-a", amount: "30.10", targetDueDate: "2026-08-23", intent: "on_time" },
            { itemPublicId: "item-b", loanPublicId: "loan-b", schedulePublicId: "schedule-b", amount: "20.00", targetDueDate: "2026-08-24", intent: "backdated" },
        ]);
    });
});
