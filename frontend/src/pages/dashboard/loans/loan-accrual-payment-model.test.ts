import { describe, expect, test } from "vitest";
import { sumAccrualMoney } from "./loan-accrual-payment-model";

describe("loan accrual payment money model", () => {
    test("preserves all 29 public integer digits and cents when adding target amounts", () => {
        const amount = "246913578024691357802469135.79";
        expect(sumAccrualMoney([amount])).toBe(amount);
        expect(sumAccrualMoney([amount, amount])).toBe("493827156049382715604938271.58");
    });
});
