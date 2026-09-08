import { describe, expect, test } from "vitest";
import { getFloatingAccrualCycle } from "./loan-list-model";

describe("getFloatingAccrualCycle", () => {
    test("uses the contractual period before conflicting accrual metadata", () => {
        expect(getFloatingAccrualCycle({
            repaymentType: "floating",
            interestPeriodUnit: "week",
            floatingAccrualCycle: "daily",
        })).toBe("weekly");
    });
});
