import { describe, expect, it } from "bun:test";
import {
    calculateSinglePaymentSettlement,
    normalizeSinglePaymentTerms,
} from "./single-payment";

describe("single-payment terms", () => {
    // Break caught: a fixed-only contract accepts retroactive terms and can later charge an uncontracted policy.
    it("normalizes a fixed-only contract without retroactive interest", () => {
        expect(normalizeSinglePaymentTerms({
            dueDate: "2026-08-19",
            fixedAgreedInterest: "500.00",
            interestPolicy: "fixed_only",
            latePenalty: { mode: "none" },
        }, "2026-08-10")).toEqual({
            dueDate: "2026-08-19",
            fixedAgreedInterest: "500.00",
            interestPolicy: "fixed_only",
            latePenalty: { mode: "none" },
        });
    });

    // Break caught: mutually exclusive interest policies produce an ambiguous activated contract.
    it("rejects incompatible retroactive policies and a non-maturity due date", () => {
        expect(() => normalizeSinglePaymentTerms({
            dueDate: "2026-08-19",
            fixedAgreedInterest: "500.00",
            interestPolicy: "fixed_only",
            retroactiveInterest: { rateType: "percent_per_day", rate: "1.0000" },
            latePenalty: { mode: "none" },
        }, "2026-08-10")).toThrow("Fixed-only terms cannot include retroactive interest");
        expect(() => normalizeSinglePaymentTerms({
            dueDate: "2026-08-19",
            fixedAgreedInterest: "500.00",
            interestPolicy: "greater_of_fixed_or_retroactive",
            latePenalty: { mode: "none" },
        }, "2026-08-10")).toThrow("Retroactive interest is required");
        expect(() => normalizeSinglePaymentTerms({
            dueDate: "2026-08-10",
            fixedAgreedInterest: "500.00",
            interestPolicy: "fixed_only",
            latePenalty: { mode: "none" },
        }, "2026-08-10")).toThrow("Due date must be later than start date");
    });
});

describe("single-payment settlement", () => {
    // Break caught: the greater-of policy adds fixed and retroactive interest instead of selecting the retroactive candidate.
    it("selects retroactive interest, traces exposure, and applies component waivers", () => {
        expect(calculateSinglePaymentSettlement({
            settlementDate: "2026-08-24",
            dueDate: "2026-08-19",
            fixedAgreedInterest: "500.00",
            retroactive: { rateType: "percent_per_day", rate: "1.0000" },
            exposures: [{ amount: "5000.00", fromDate: "2026-08-10", toDate: "2026-08-24" }],
            latePenalty: { mode: "fixed_amount_per_day", amountPerDay: "20.00", graceDays: 0 },
            waivers: { interest: "100.00", fees: "0.00", penalties: "40.00" },
        })).toMatchObject({
            fixedInterestCandidate: "500.00",
            retroactiveInterestCandidate: "700.00",
            selectedInterest: "700.00",
            selectedInterestBranch: "retroactive",
            grossPenalty: "100.00",
            netInterest: "600.00",
            netPenalty: "60.00",
            exposureTrace: [{ amount: "5000.00", fromDate: "2026-08-10", toDate: "2026-08-24", days: 14, roundedInterest: "700.00" }],
        });
    });

    // Break caught: equal candidates, changes in posted principal exposure, or fixed-policy settlements select the wrong amount.
    it("handles equality, multiple exposure segments, and fixed-only interest", () => {
        const equalCandidates = calculateSinglePaymentSettlement({
            settlementDate: "2026-08-12",
            dueDate: "2026-08-12",
            fixedAgreedInterest: "100.00",
            retroactive: { rateType: "per_thousand_per_day", rate: "10.0000" },
            exposures: [{ amount: "5000.00", fromDate: "2026-08-10", toDate: "2026-08-12" }],
            latePenalty: { mode: "none" },
            waivers: { interest: "0.00", fees: "0.00", penalties: "0.00" },
        });
        expect(equalCandidates).toMatchObject({
            retroactiveInterestCandidate: "100.00",
            selectedInterest: "100.00",
            selectedInterestBranch: "fixed",
        });

        const reducedExposure = calculateSinglePaymentSettlement({
            settlementDate: "2026-08-15",
            dueDate: "2026-08-20",
            fixedAgreedInterest: "300.00",
            retroactive: { rateType: "percent_per_day", rate: "1.0000" },
            exposures: [
                { amount: "5000.00", fromDate: "2026-08-10", toDate: "2026-08-12" },
                { amount: "3000.00", fromDate: "2026-08-12", toDate: "2026-08-15" },
            ],
            latePenalty: { mode: "none" },
            waivers: { interest: "0.00", fees: "0.00", penalties: "0.00" },
        });
        expect(reducedExposure).toMatchObject({
            retroactiveInterestCandidate: "190.00",
            selectedInterest: "300.00",
            selectedInterestBranch: "fixed",
            exposureTrace: [
                { amount: "5000.00", days: 2, roundedInterest: "100.00" },
                { amount: "3000.00", days: 3, roundedInterest: "90.00" },
            ],
        });
    });
});
