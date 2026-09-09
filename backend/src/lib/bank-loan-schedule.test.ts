import { describe, expect, test } from "bun:test";
import { generateBankLoanSchedule } from "./bank-loan-schedule";

const base = { amount: "36000.00", interestRate: "25.00", startDate: "2026-01-01", totalInstallments: 10, repaymentCycle: "monthly" as const };

describe("generateBankLoanSchedule", () => {
    test("generates a Decimal monthly amortization schedule", () => {
        const rows = generateBankLoanSchedule(base);
        expect(rows).toHaveLength(10);
        expect(rows[0]).toMatchObject({ dueDate: "2026-02-01", scheduledPrincipal: "3275.25", scheduledInterest: "750.00", scheduledTotal: "4025.25" });
        expect(rows.at(-1)).toMatchObject({ scheduledPrincipal: "3943.09", scheduledInterest: "82.15", remainingDue: "4025.24" });
        expect(rows.reduce((sum, row) => sum + BigInt(row.scheduledPrincipal.replace(".", "")), 0n)).toBe(3600000n);
    });

    test("honors explicit fixed installment and clears final principal exactly", () => {
        const rows = generateBankLoanSchedule({ ...base, installmentAmount: "4000.00" });
        expect(rows[0].scheduledPrincipal).toBe("3250.00");
        expect(rows.at(-1)?.scheduledPrincipal).toBe("4190.22");
        expect(rows.at(-1)?.scheduledTotal).toBe("4277.52");
    });

    test("divides zero-interest loans without floating point artifacts", () => {
        const rows = generateBankLoanSchedule({ ...base, interestRate: "0.00" });
        expect(rows[0]).toMatchObject({ scheduledPrincipal: "3600.00", scheduledInterest: "0.00", scheduledTotal: "3600.00" });
    });

    test("adds fee and VAT components to every installment", () => {
        const row = generateBankLoanSchedule({ ...base, processingFeeAmount: "10.00", utilizationFeeAmount: "5.00", vatRate: "7.00" })[0];
        expect(row).toMatchObject({ scheduledFee: "15.00", scheduledVat: "53.55", scheduledTotal: "4093.80" });
    });

    test("infers daily installments from term months", () => {
        const rows = generateBankLoanSchedule({ amount: "3000.00", interestRate: "0.00", startDate: "2026-01-01", termMonths: 2, repaymentCycle: "daily" });
        expect(rows).toHaveLength(60);
        expect(rows[0].dueDate).toBe("2026-01-02");
        expect(rows.at(-1)?.scheduledPrincipal).toBe("50.00");
    });
});
