import { describe, expect, it } from "bun:test";
import {
    allocatePaymentOldestFirst,
    parseMoney,
    quantizeMoney,
    serializeMoney,
    sumMoney,
} from "./money";
import { generateLoanSchedule } from "./loan-schedule";

describe("money public values", () => {
    // Break caught: accepting a malformed or negative API money value corrupts financial inputs.
    it("parses non-negative public strings with exactly two decimals", () => {
        expect(serializeMoney(parseMoney("0.00"))).toBe("0.00");
        expect(serializeMoney(parseMoney("1234.50"))).toBe("1234.50");
        expect(() => parseMoney("12.3")).toThrow("Money must be a non-negative string with exactly two decimals");
        expect(() => parseMoney("-1.00")).toThrow("Money must be a non-negative string with exactly two decimals");
    });

    // Break caught: a half-cent rounds down or serializes without two decimal places.
    it("rounds half up and always serializes to two decimals", () => {
        expect(serializeMoney(quantizeMoney("1.005"))).toBe("1.01");
        expect(serializeMoney(quantizeMoney("1.004"))).toBe("1.00");
        expect(serializeMoney(quantizeMoney("9"))).toBe("9.00");
    });

    // Break caught: binary floating-point drift changes a summed currency result.
    it("sums money without floating point drift", () => {
        expect(serializeMoney(sumMoney(["0.10", "0.20", "0.70"]))).toBe("1.00");
    });
});

describe("daily fixed-installment schedule", () => {
    // Break caught: per-row rounding loses or creates principal/interest on the final installment.
    it("conserves the exact daily loan totals in its final installment", () => {
        const schedule = generateLoanSchedule({
            principal: "2500.00",
            interestRate: "0.00",
            installmentAmount: "190.00",
            totalInstallments: 15,
            termMonths: 1,
            repaymentType: "daily",
            startDate: "2026-01-01",
        });

        expect(schedule).toHaveLength(15);
        expect(schedule.slice(0, 14).every((row) => row.scheduledPrincipal === "166.67")).toBe(true);
        expect(schedule[14]?.scheduledPrincipal).toBe("166.62");
        expect(schedule.slice(0, 14).every((row) => row.scheduledInterest === "23.33")).toBe(true);
        expect(schedule[14]?.scheduledInterest).toBe("23.38");
        expect(sumMoney(schedule.map((row) => row.scheduledPrincipal))).toEqual(parseMoney("2500.00"));
        expect(sumMoney(schedule.map((row) => row.scheduledInterest))).toEqual(parseMoney("350.00"));
        expect(sumMoney(schedule.map((row) => row.scheduledTotal))).toEqual(parseMoney("2850.00"));
    });

    // Break caught: a zero, negative, or fractional installment count silently changes the loan terms.
    it.each([0, -1, 15.5])("rejects invalid supplied installment count %p", (totalInstallments) => {
        expect(() => generateLoanSchedule({
            principal: "2500.00",
            interestRate: "0.00",
            installmentAmount: "190.00",
            totalInstallments,
            termMonths: 1,
            repaymentType: "daily",
            startDate: "2026-01-01",
        })).toThrow("Daily total installments must be a positive integer");
    });
});

describe("oldest-first payment allocation", () => {
    const schedules = [
        {
            scheduleId: "first",
            installmentNo: 1,
            penaltyDue: "5.00",
            feeDue: "10.00",
            interestDue: "20.00",
            principalDue: "100.00",
        },
        {
            scheduleId: "second",
            installmentNo: 2,
            penaltyDue: "0.00",
            feeDue: "0.00",
            interestDue: "10.00",
            principalDue: "100.00",
        },
    ];

    // Break caught: a partial payment allocates principal before a due penalty, fee, or interest.
    it("allocates a partial payment in penalty, fee, interest, principal order", () => {
        const result = allocatePaymentOldestFirst("25.00", schedules);

        expect(result.allocations[0]).toMatchObject({
            scheduleId: "first",
            penalty: "5.00",
            fee: "10.00",
            interest: "10.00",
            principal: "0.00",
            total: "25.00",
        });
        expect(result.unallocatedAmount).toBe("0.00");
    });

    // Break caught: money remaining after the oldest schedule is satisfied is not applied to the next schedule.
    it("advances to later schedules without allocating more than each due amount", () => {
        const result = allocatePaymentOldestFirst("150.00", schedules);

        expect(result.allocations[0]).toMatchObject({
            penalty: "5.00",
            fee: "10.00",
            interest: "20.00",
            principal: "100.00",
            total: "135.00",
        });
        expect(result.allocations[1]).toMatchObject({
            penalty: "0.00",
            fee: "0.00",
            interest: "10.00",
            principal: "5.00",
            total: "15.00",
        });
        expect(result.unallocatedAmount).toBe("0.00");
    });

    // Break caught: zero or malformed payments are accepted and produce a financial entry.
    it("rejects zero and invalid payment inputs", () => {
        expect(() => allocatePaymentOldestFirst("0.00", schedules)).toThrow("Payment amount must be greater than zero");
        expect(() => allocatePaymentOldestFirst("10.0", schedules)).toThrow("Money must be a non-negative string with exactly two decimals");
    });

    // Break caught: allocation totals no longer conserve the submitted payment amount.
    it("conserves a payment between allocations and its unallocated remainder", () => {
        const result = allocatePaymentOldestFirst("300.00", schedules);

        expect(serializeMoney(sumMoney([
            ...result.allocations.map((allocation) => allocation.total),
            result.unallocatedAmount,
        ]))).toBe("300.00");
        expect(result.unallocatedAmount).toBe("55.00");
    });

    // Break caught: an undated schedule receives payment before an explicitly dated older obligation.
    it("places schedules without a due date after dated schedules", () => {
        const result = allocatePaymentOldestFirst("10.00", [
            {
                scheduleId: "undated",
                installmentNo: 1,
                penaltyDue: "0.00",
                feeDue: "0.00",
                interestDue: "0.00",
                principalDue: "10.00",
            },
            {
                scheduleId: "dated",
                installmentNo: 2,
                dueDate: "2026-01-01",
                penaltyDue: "0.00",
                feeDue: "0.00",
                interestDue: "0.00",
                principalDue: "10.00",
            },
        ]);

        expect(result.allocations).toHaveLength(1);
        expect(result.allocations[0]?.scheduleId).toBe("dated");
    });
});
