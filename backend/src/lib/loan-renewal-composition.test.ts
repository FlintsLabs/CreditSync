import { describe, expect, test } from "bun:test";
import { FinancialDecimal } from "./financial-decimal";
import {
    calculateRenewalComposition,
    type RenewalCompositionInput,
} from "./loan-renewal-composition";

function exampleInput(overrides: Partial<RenewalCompositionInput> = {}): RenewalCompositionInput {
    const schedules = Array.from({ length: 24 }, (_, index) => ({
        dueDate: `2026-08-${String(index + 1).padStart(2, "0")}`,
        principal: index === 23 ? "83.41" : "83.33",
        interest: index === 23 ? "16.59" : "16.67",
        fee: "0.00",
    }));
    const payments = Array.from({ length: 10 }, (_, index) => ({
        transactionPublicId: `00000000-0000-7000-8000-${String(index + 1).padStart(12, "0")}`,
        paidAt: `2026-08-${String(index + 1).padStart(2, "0")}T09:00:00.000+07:00`,
        amount: "100.00",
        principal: index === 9 ? "83.36" : "83.33",
        interest: index === 9 ? "16.64" : "16.67",
        fee: "0.00",
        penalty: "0.00",
    }));
    return {
        settlementPolicy: "full_contract_interest",
        renewalDate: "2026-08-10",
        requestedPrincipal: "2000.00",
        originalPrincipal: "2000.00",
        contractStartDate: "2026-08-01",
        contractDueDate: "2026-08-24",
        schedules,
        payments,
        accruedDueInterest: "0.00",
        dueFees: "0.00",
        duePenalties: "0.00",
        adjustments: [],
        ...overrides,
    };
}

describe("renewal composition", () => {
    test("charges full contractual interest and returns the exact 2000/100x24/10-day payout", () => {
        expect(calculateRenewalComposition(exampleInput())).toMatchObject({
            settlementPolicy: "full_contract_interest",
            requestedPrincipal: "2000.00",
            originalPrincipal: "2000.00",
            totalScheduledAmount: "2400.00",
            contractualInterest: "400.00",
            totalPaid: "1000.00",
            receivedPrincipal: "833.33",
            receivedInterest: "166.67",
            remainingContractInterest: "233.33",
            recoveredBeforeAdjustments: "600.00",
            manualCharges: "0.00",
            manualWaivers: "0.00",
            settlementAmount: "233.33",
            cashDirection: "payout",
            cashAmount: "600.00",
        });
    });

    test("uses accrued interest only when explicitly selected", () => {
        expect(calculateRenewalComposition(exampleInput({
            settlementPolicy: "accrued_to_date",
            accruedDueInterest: "50.00",
        }))).toMatchObject({
            settlementPolicy: "accrued_to_date",
            remainingContractInterest: "233.33",
            settlementAmount: "50.00",
            cashDirection: "payout",
            cashAmount: "783.33",
        });
    });

    test("floors recovered-before-adjustments at zero when payments are below contractual interest", () => {
        const result = calculateRenewalComposition(exampleInput({ payments: exampleInput().payments.slice(0, 2) }));
        expect(result.recoveredBeforeAdjustments).toBe("0.00");
        expect(result.cashDirection).toBe("collection");
        expect(result.cashAmount).toBe("200.00");
    });

    test("applies ordered charges and waivers without changing stored principal allocation", () => {
        const result = calculateRenewalComposition(exampleInput({
            adjustments: [
                { kind: "fee", amount: "10.00", reason: "Manual service fee" },
                { kind: "penalty", amount: "5.00", reason: "Agreed late charge" },
                { kind: "other_charge", amount: "10.00", reason: "Document expense" },
                { kind: "waiver", amount: "10.00", reason: "Operator concession" },
            ],
        }));
        expect(result).toMatchObject({
            receivedPrincipal: "833.33",
            manualCharges: "25.00",
            manualWaivers: "10.00",
            settlementAmount: "248.33",
            cashDirection: "payout",
            cashAmount: "585.00",
            adjustments: [
                { lineNo: 1, kind: "fee" },
                { lineNo: 2, kind: "penalty" },
                { lineNo: 3, kind: "other_charge" },
                { lineNo: 4, kind: "waiver" },
            ],
        });
    });

    test("rejects waivers above eligible charges", () => {
        expect(() => calculateRenewalComposition(exampleInput({
            adjustments: [{ kind: "waiver", amount: "233.34", reason: "Too much" }],
        }))).toThrow("RENEWAL_WAIVER_EXCEEDS_ELIGIBLE_CHARGES");
    });

    test("rejects invalid public money, blank reasons, and unknown kinds at runtime", () => {
        expect(() => calculateRenewalComposition(exampleInput({ requestedPrincipal: "2,000.00" }))).toThrow("INVALID_RENEWAL_MONEY");
        expect(() => calculateRenewalComposition(exampleInput({ adjustments: [{ kind: "fee", amount: "1.00", reason: "  " }] }))).toThrow("RENEWAL_ADJUSTMENT_REASON_REQUIRED");
        expect(() => calculateRenewalComposition(exampleInput({ adjustments: [{ kind: "credit" as "fee", amount: "1.00", reason: "Invalid" }] }))).toThrow("INVALID_RENEWAL_ADJUSTMENT_KIND");
    });

    test("keeps 29-digit public values exact", () => {
        const maximum = "99999999999999999999999999999.00";
        expect(calculateRenewalComposition(exampleInput({
            requestedPrincipal: maximum,
            originalPrincipal: maximum,
            schedules: [{ dueDate: "2026-08-24", principal: maximum, interest: "0.00", fee: "0.00" }],
            payments: [],
        }))).toMatchObject({
            requestedPrincipal: maximum,
            originalPrincipal: maximum,
            totalScheduledAmount: maximum,
            cashDirection: "none",
            cashAmount: "0.00",
        });
    });

    test("conserves replacement principal across old principal, settlement, and payout", () => {
        const result = calculateRenewalComposition(exampleInput({ dueFees: "7.00", duePenalties: "3.00" }));
        const requested = new FinancialDecimal(result.requestedPrincipal);
        const outstanding = new FinancialDecimal(result.originalPrincipal).minus(result.receivedPrincipal);
        const settlement = new FinancialDecimal(result.settlementAmount);
        const cash = new FinancialDecimal(result.cashAmount);
        expect(outstanding.plus(settlement).plus(cash).toFixed(2)).toBe(requested.toFixed(2));
    });
});
