import { describe, expect, it } from "bun:test";
import Decimal from "decimal.js";
import { computeLoanRollup } from "./loan-rollup";

describe("loan rollup exact money", () => {
    // Break caught: Number ratios turn exact scheduled components into drifting outstanding balances.
    it("returns Decimal balances that conserve non-even schedule components", () => {
        const rollup = computeLoanRollup([
            {
                dueDate: "2026-02-01",
                scheduledPrincipal: "8.33",
                scheduledInterest: "0.17",
                scheduledFee: "0.00",
                remainingDue: "8.50",
                status: "pending",
            },
            {
                dueDate: "2026-03-01",
                scheduledPrincipal: "8.37",
                scheduledInterest: "0.13",
                scheduledFee: "0.00",
                remainingDue: "8.50",
                status: "pending",
            },
        ]);

        expect(rollup.outstandingPrincipal).toBeInstanceOf(Decimal);
        expect(rollup.outstandingInterest).toBeInstanceOf(Decimal);
        expect(rollup.outstandingFees).toBeInstanceOf(Decimal);
        expect(rollup.outstandingPrincipal.toFixed(2)).toBe("16.70");
        expect(rollup.outstandingInterest.toFixed(2)).toBe("0.30");
        expect(rollup.outstandingFees.toFixed(2)).toBe("0.00");
        expect(rollup.nextDueDate).toBe("2026-02-01");
    });

    // Break caught: a fee/interest-first payment is incorrectly prorated across every component.
    it("rolls up mixed components using the same fee-interest-principal payment priority", () => {
        const rollup = computeLoanRollup([{
            dueDate: "2026-08-10",
            scheduledPrincipal: "70.00",
            scheduledInterest: "20.00",
            scheduledFee: "10.00",
            remainingDue: "70.00",
            status: "partial",
        }]);

        expect(rollup.outstandingFees.toFixed(2)).toBe("0.00");
        expect(rollup.outstandingInterest.toFixed(2)).toBe("0.00");
        expect(rollup.outstandingPrincipal.toFixed(2)).toBe("70.00");
    });
});
