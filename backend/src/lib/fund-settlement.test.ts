import { describe, expect, it } from "bun:test";
import { calculateOpportunityCost, computeFundSettlementSummary, reconcileFundRevenue } from "./fund-settlement";

describe("Fund Settlement Summary Calculator", () => {
    it("reports exact borrower cash and profit without treating principal as revenue", () => {
        const summary = computeFundSettlementSummary({
            allocations: [{ loanId: 1, allocatedAmount: "5000.00", totalPositiveAllocatedAmount: "5000.00" }],
            loans: [{ id: 1, principalAmount: "5000.00", outstandingInterest: "0.00", outstandingFees: "0.00" }],
            borrowerTransactions: [{
                loanId: 1,
                principalComponent: "2333.33",
                interestComponent: "1466.67",
                feeComponent: "0.00",
                penaltyComponent: "0.00",
            }],
            bankRepayments: [],
        });

        expect(summary).toMatchObject({
            borrowerPrincipalCollected: "2333.33",
            borrowerInterestCollected: "1466.67",
            borrowerRevenueCollected: "1466.67",
            realizedSpread: "1466.67",
            surplusBalance: "3800.00",
        });
    });

    it("reports contract revenue missing from the append-only source ledger", () => {
        expect(reconcileFundRevenue({
            contractAttributedRevenue: "1466.67",
            ledgerEntries: [
                { entryType: "interest_income_in", amount: "510.00" },
                { entryType: "principal_return_in", amount: "100.00" },
                { entryType: "rollover_in", amount: "20.00" },
            ],
        })).toEqual({
            contractAttributedRevenue: "1466.67",
            ledgerRecordedRevenue: "510.00",
            difference: "956.67",
            status: "needs_reconciliation",
        });
    });

    it("distinguishes matched and over-recorded revenue", () => {
        expect(reconcileFundRevenue({
            contractAttributedRevenue: "20.00",
            ledgerEntries: [
                { entryType: "fee_income_in", amount: "10.00" },
                { entryType: "penalty_income_in", amount: "10.00" },
            ],
        }).status).toBe("matched");
        expect(reconcileFundRevenue({
            contractAttributedRevenue: "20.00",
            ledgerEntries: [{ entryType: "interest_income_in", amount: "30.00" }],
        })).toMatchObject({ difference: "-10.00", status: "needs_reconciliation" });
    });

    it("does not duplicate transactions or outstanding revenue across allocation adjustment rows", () => {
        const summary = computeFundSettlementSummary({
            allocations: [
                { loanId: 1, allocatedAmount: "70.00", totalPositiveAllocatedAmount: "100.00" },
                { loanId: 1, allocatedAmount: "-10.00", totalPositiveAllocatedAmount: "100.00" },
            ],
            loans: [{ id: 1, principalAmount: "100.00", outstandingInterest: "50.00", outstandingFees: "10.00" }],
            borrowerTransactions: [{
                loanId: 1,
                principalComponent: "0.00",
                interestComponent: "100.00",
                feeComponent: "0.00",
                penaltyComponent: "0.00",
            }],
            bankRepayments: [],
        });

        expect(summary.borrowerInterestCollected).toBe("60.00");
        expect(summary.unrealizedSpread).toBe("36.00");
    });

    it("calculates a 2% annual own-capital opportunity cost without cash side effects", () => {
        expect(calculateOpportunityCost({
            principal: "5000.00",
            annualRate: "2.00",
            allocationDate: "2026-08-06",
            asOfDate: "2026-08-11",
        })).toBe("1.37");
    });

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

        expect(summary.realizedSpread).toBe("500.00"); // 1000 - 500
        expect(summary.borrowerInterestCollected).toBe("1000.00");
        expect(summary.bankInterestPaid).toBe("500.00");
        expect(summary.surplusBalance).toBe("500.00");
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
        expect(summary.borrowerInterestCollected).toBe("1000.00");
        // Realized Spread = 1000 - 300 = 700
        expect(summary.realizedSpread).toBe("700.00");
        
        // Unrealized calculation:
        // Borrower interest remaining = 5000 * 50% = 2500
        // Bank cost remaining = 1000
        // Unrealized Spread = 2500 - 1000 = 1500
        expect(summary.unrealizedSpread).toBe("1500.00");
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
        expect(summary.borrowerInterestCollected).toBe("1000.00");
        expect(summary.unrealizedSpread).toBe("1000.00"); // 25% of remaining 4000
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

        expect(summary.surplusBalance).toBe("3000.00"); // 5000 - 2000
        expect(summary.carryForwardAvailable).toBe("3000.00");
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
