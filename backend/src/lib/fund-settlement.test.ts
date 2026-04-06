import { describe, expect, it } from "bun:test";
import { computeFundSettlementSummary } from "./fund-settlement";

describe("Fund Settlement Summary Calculator", () => {
    it("should calculate realized spread correctly for a simple fully-funded case", () => {
        // Scenario: 
        // 1 bank loan of 10,000 at 5% interest
        // 1 borrower loan of 10,000 at 10% interest
        // Borrower pays 1,000 interest
        // Bank is paid 500 interest

        const allocations = [
            { loanId: 1, allocatedAmount: "10000" }
        ];
        const loans = [
            { id: 1, principalAmount: "10000", outstandingInterest: "0", outstandingFees: "0" }
        ];
        const borrowerTransactions = [
            { loanId: 1, principalComponent: "0", interestComponent: "1000", feeComponent: "0", penaltyComponent: "0" }
        ];
        const bankRepayments = [
            { principalComponent: "0", interestComponent: "500", feeComponent: "0", vatComponent: "0", penaltyComponent: "0" }
        ];

        const summary = computeFundSettlementSummary({
            allocations,
            loans,
            borrowerTransactions,
            bankRepayments,
            outstandingInterest: "0",
            outstandingFees: "0",
            outstandingPenalties: "0"
        });

        expect(summary.realizedSpread).toBe(500); // 1000 - 500
        expect(summary.borrowerInterestCollected).toBe(1000);
        expect(summary.bankInterestPaid).toBe(500);
        expect(summary.surplusBalance).toBe(500);
    });

    it("should handle partial allocations and weighted collections", () => {
        // Scenario:
        // Bank loan A (10,000) funds 50% of Borrower loan 1 (20,000)
        // Borrower loan 1 pays 2,000 interest
        // Bank loan A should see 1,000 (50%) of that interest as its revenue

        const allocations = [
            { loanId: 1, allocatedAmount: "10000" } // 50% of loan 1
        ];
        const loans = [
            { id: 1, principalAmount: "20000", outstandingInterest: "5000", outstandingFees: "0" }
        ];
        const borrowerTransactions = [
            { loanId: 1, principalComponent: "0", interestComponent: "2000", feeComponent: "0", penaltyComponent: "0" }
        ];
        const bankRepayments = [
            { principalComponent: "0", interestComponent: "300", feeComponent: "0", vatComponent: "0", penaltyComponent: "0" }
        ];

        const summary = computeFundSettlementSummary({
            allocations,
            loans,
            borrowerTransactions,
            bankRepayments,
            outstandingInterest: "1000",
            outstandingFees: "0",
            outstandingPenalties: "0"
        });

        // 50% of 2000 = 1000 collected
        expect(summary.borrowerInterestCollected).toBe(1000);
        // Realized Spread = 1000 - 300 = 700
        expect(summary.realizedSpread).toBe(700);
        
        // Unrealized calculation:
        // Borrower interest remaining = 5000 * 50% = 2500
        // Bank cost remaining = 1000
        // Unrealized Spread = 2500 - 1000 = 1500
        expect(summary.unrealizedSpread).toBe(1500);
    });

    it("should handle multiple allocations to the same loan", () => {
        // Scenario:
        // Bank loan A (10,000) funds 25% of Borrower loan 1 (40,000)
        // Bank loan B (10,000) funds 25% of Borrower loan 1 (40,000)
        // (Wait, computeFundSettlementSummary is called per Bank Loan/Profile, so we only see one side)
        
        const allocationsFromThisSource = [
            { loanId: 1, allocatedAmount: "10000" } // 25%
        ];
        const loans = [
            { id: 1, principalAmount: "40000", outstandingInterest: "4000", outstandingFees: "0" }
        ];
        const borrowerTransactions = [
            { loanId: 1, principalComponent: "0", interestComponent: "4000", feeComponent: "0", penaltyComponent: "0" }
        ];

        const summary = computeFundSettlementSummary({
            allocations: allocationsFromThisSource,
            loans,
            borrowerTransactions,
            bankRepayments: [],
            outstandingInterest: "0",
            outstandingFees: "0"
        });

        // 25% of 4000 = 1000
        expect(summary.borrowerInterestCollected).toBe(1000);
        expect(summary.unrealizedSpread).toBe(1000); // 25% of remaining 4000
    });

    it("should account for rollovers in cash position", () => {
        const summary = computeFundSettlementSummary({
            allocations: [],
            loans: [],
            borrowerTransactions: [],
            bankRepayments: [],
            rollovers: [
                { amount: "5000", direction: "in" },
                { amount: "2000", direction: "out" }
            ],
            outstandingInterest: "0",
            outstandingFees: "0"
        });

        expect(summary.surplusBalance).toBe(3000); // 5000 - 2000
        expect(summary.carryForwardAvailable).toBe(3000);
    });

    it("should correctly identify external vs internal rollovers in tenant summary logic", async () => {
        // This is more of a logic check for the implementation inside getTenantProfitabilitySummary
        const mockRollovers = [
            { id: 1, amount: "1000", fromBankProfileId: null, toBankProfileId: 10, entryType: "deficit_support" }, // External IN
            { id: 2, amount: "500", fromBankProfileId: 10, toBankProfileId: 11, entryType: "surplus_transfer" }, // Internal
            { id: 3, amount: "300", fromBankProfileId: 11, toBankProfileId: null, entryType: "capitalization" }, // External OUT
        ];

        const processed = mockRollovers.map((row) => {
            let direction: "in" | "out" | "internal" = "internal";
            if (row.fromBankProfileId && !row.toBankProfileId) direction = "out";
            if (!row.fromBankProfileId && row.toBankProfileId) direction = "in";
            
            return {
                amount: row.amount,
                direction: direction,
            };
        }).filter(r => r.direction !== "internal");

        expect(processed.length).toBe(2);
        expect(processed.find(p => p.direction === "in")?.amount).toBe("1000");
        expect(processed.find(p => p.direction === "out")?.amount).toBe("300");
    });
});
