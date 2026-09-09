import { describe, expect, it } from "bun:test";
import { attributeTransactionComponents, buildPositiveFundingShares } from "./fund-attribution";

describe("fund attribution", () => {
    it("reduces signed allocation history before calculating source shares", () => {
        const shares = buildPositiveFundingShares([
            { loanId: 1, bankProfileId: 10, allocatedAmount: "70.00" },
            { loanId: 1, bankProfileId: 10, allocatedAmount: "-10.00" },
            { loanId: 1, bankProfileId: 20, allocatedAmount: "40.00" },
        ]);

        expect(shares.get(1)?.get(10)?.toFixed(2)).toBe("0.60");
        expect(shares.get(1)?.get(20)?.toFixed(2)).toBe("0.40");
    });

    it("excludes net-zero sources without changing positive source shares", () => {
        const shares = buildPositiveFundingShares([
            { loanId: 1, bankProfileId: 10, allocatedAmount: "50.00" },
            { loanId: 1, bankProfileId: 20, allocatedAmount: "25.00" },
            { loanId: 1, bankProfileId: 20, allocatedAmount: "-25.00" },
        ]);

        expect(shares.get(1)?.get(10)?.toFixed(2)).toBe("1.00");
        expect(shares.get(1)?.has(20)).toBe(false);
    });

    it("normalizes positive allocations instead of capping over-allocation", () => {
        const shares = buildPositiveFundingShares([
            { loanId: 1, bankProfileId: 10, allocatedAmount: "90.00" },
            { loanId: 1, bankProfileId: 20, allocatedAmount: "60.00" },
        ]);

        expect(shares.get(1)?.get(10)?.toFixed(2)).toBe("0.60");
        expect(shares.get(1)?.get(20)?.toFixed(2)).toBe("0.40");
    });

    it("keeps recurring shares precise until public presentation", () => {
        const shares = buildPositiveFundingShares([
            { loanId: 1, bankProfileId: 10, allocatedAmount: "1.00" },
            { loanId: 1, bankProfileId: 20, allocatedAmount: "1.00" },
            { loanId: 1, bankProfileId: 30, allocatedAmount: "1.00" },
        ]);

        expect(shares.get(1)?.get(10)?.toFixed(10)).toBe("0.3333333333");
        expect(shares.get(1)?.get(10)?.times("100.00").toFixed(10)).toBe("33.3333333333");
    });

    it("attributes every signed payment component with no row-level rounding", () => {
        const attributed = attributeTransactionComponents({
            sourceShare: "0.60",
            transactions: [
                { principalComponent: "100.01", interestComponent: "33.33", feeComponent: "2.00", penaltyComponent: "1.00" },
                { principalComponent: "-10.00", interestComponent: "-3.33", feeComponent: "0.00", penaltyComponent: "0.00" },
            ],
        });

        expect(attributed.principal.toFixed(3)).toBe("54.006");
        expect(attributed.interest.toFixed(3)).toBe("18.000");
        expect(attributed.fees.toFixed(2)).toBe("1.20");
        expect(attributed.penalties.toFixed(2)).toBe("0.60");
    });
});
