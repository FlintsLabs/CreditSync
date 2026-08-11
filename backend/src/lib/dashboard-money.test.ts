import { describe, expect, it } from "bun:test";
import { aggregateDashboardMoney, positiveDashboardDifference, serializeDashboardProfitability, subtractDashboardMoney, sumDashboardMoney } from "./dashboard-money";

describe("dashboard money", () => {
    it("sums and subtracts values beyond the JavaScript safe integer range", () => {
        expect(sumDashboardMoney(["9007199254740993.01", "0.99"])).toBe("9007199254740994.00");
        expect(subtractDashboardMoney("9007199254740994.00", "1.01")).toBe("9007199254740992.99");
    });

    it("aggregates allocations and produces a non-negative exact gap", () => {
        const totals = aggregateDashboardMoney([
            { key: 7, amount: "9007199254740993.01" },
            { key: 7, amount: "6.99" },
        ]);
        expect(totals.get(7)).toBe("9007199254741000.00");
        expect(positiveDashboardDifference("9007199254741001.25", totals.get(7) ?? "0.00")).toBe("1.25");
        expect(positiveDashboardDifference("1.00", "2.00")).toBe("0.00");
    });

    it("serializes every dashboard profitability value as a two-decimal public string", () => {
        expect(serializeDashboardProfitability({
            borrowerRevenueCollected: 10,
            fundCostPaid: 2,
            realizedSpread: 8,
            unrealizedSpread: 3,
            deployedPrincipal: 100,
            netCashPosition: 75,
            realizedRoiPercent: 8,
            carryForwardAvailable: 0,
        })).toEqual({
            borrowerRevenueCollected: "10.00",
            fundCostPaid: "2.00",
            realizedSpread: "8.00",
            unrealizedSpread: "3.00",
            deployedPrincipal: "100.00",
            netCashPosition: "75.00",
            realizedRoiPercent: "8.00",
            carryForwardAvailable: "0.00",
        });
    });
});
