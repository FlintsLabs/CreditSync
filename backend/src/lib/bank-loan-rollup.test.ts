import { describe, expect, it } from "bun:test";
import { buildBankLoanRepaymentRollupUpdate } from "./bank-loan-rollup";

describe("bank-loan repayment rollup update", () => {
    // Break caught: a fully repaid bank loan becomes closed without persisting the close timestamp.
    it("persists the close timestamp when repayment closes the bank loan", () => {
        const closedAt = new Date("2026-08-09T12:00:00.000Z");
        const update = buildBankLoanRepaymentRollupUpdate({
            outstandingPrincipal: 0,
            outstandingInterest: 0,
            outstandingFees: 0,
            nextDueDate: null,
            status: "closed",
        }, 0, closedAt);

        expect(update.closedAt).toBe(closedAt);
        expect(update.status).toBe("closed");
    });
});
