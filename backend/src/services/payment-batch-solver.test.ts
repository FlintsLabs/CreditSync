import { expect, test } from "bun:test";
import { solvePaymentBatch } from "./payment-batch-solver";
import type { BatchObligation, BatchSlip } from "./payment-batch-types";

const obligation = (schedulePublicId: string, remainingDue: string, dueDate: string, loanPublicId = `loan-${schedulePublicId}`): BatchObligation => ({
    borrowerPublicId: "borrower-1",
    loanPublicId,
    schedulePublicId,
    dueDate,
    remainingDue,
    principalDue: remainingDue,
    interestDue: "0.00",
    feeDue: "0.00",
    penaltyDue: "0.00",
});

const slip = (itemPublicId: string, amount: string, receivedAt = "2026-08-23T03:00:00.000Z"): BatchSlip => ({ itemPublicId, amount, receivedAt });

test("finds materially distinct exact combinations without selecting an ambiguous answer", () => {
    const result = solvePaymentBatch({
        obligations: [obligation("s-30", "30.00", "2026-08-20"), obligation("s-20", "20.00", "2026-08-21"), obligation("s-50", "50.00", "2026-08-22")],
        slips: [slip("item-1", "50.00")],
    });

    expect(result.status).toBe("needs_review");
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.map((candidate) => candidate.allocations.map((item) => item.schedulePublicId))).toEqual([
        ["s-30", "s-20"],
        ["s-50"],
    ]);
});

test("solves multiple slips jointly and never consumes one schedule twice", () => {
    const result = solvePaymentBatch({
        obligations: [obligation("s-30", "30.00", "2026-08-20"), obligation("s-20", "20.00", "2026-08-21"), obligation("s-10", "10.00", "2026-08-22")],
        slips: [slip("item-1", "30.00"), slip("item-2", "20.00")],
    });

    expect(result.status).toBe("ready");
    expect(result.allocations).toEqual([
        { itemPublicId: "item-1", schedulePublicId: "s-30", loanPublicId: "loan-s-30", amount: "30.00", targetDueDate: "2026-08-20", intent: "on_time", matchSource: "unique_exact" },
        { itemPublicId: "item-2", schedulePublicId: "s-20", loanPublicId: "loan-s-20", amount: "20.00", targetDueDate: "2026-08-21", intent: "on_time", matchSource: "unique_exact" },
    ]);
});

test("rejects non-canonical money and does not infer future or backdated allocations", () => {
    expect(() => solvePaymentBatch({ obligations: [obligation("s-1", "10.00", "2026-08-24")], slips: [slip("item-1", "10.000")] })).toThrow("two decimal");
    const result = solvePaymentBatch({ obligations: [obligation("s-1", "10.00", "2026-08-24")], slips: [slip("item-1", "10.00")] });
    expect(result.status).toBe("needs_review");
    expect(result.warnings.map((warning) => warning.code)).toContain("IMPLICIT_ADVANCE_NOT_ALLOWED");
});
