import { describe, expect, it } from "bun:test";
import { calculateLoanSchedule, calculateProRatedClosing, calculateLoanClosingSummary, calculatePublicLoanSchedule } from "./calculator";
import { FinancialDecimal } from "./financial-decimal";
import dayjs from "dayjs";

describe("Loan Calculator", () => {
    it("should calculate monthly schedule correctly", () => {
        const schedule = calculateLoanSchedule({
            principal: 20000,
            interestRate: 15,
            termMonths: 12,
            repaymentType: "monthly",
            startDate: new Date("2024-01-01")
        });

        expect(schedule.length).toBe(12);
        // Total interest = 20000 * 0.15 * 1 = 3000
        // Total amount = 23000
        // Exact components conserve 23000.00; the final row carries the cent residual.
        expect(schedule[0].amount).toBe("1916.67");
        expect(schedule[11].amount).toBe("1916.63");
        expect(schedule[0].dueDate).toBe("2024-02-01");
    });

    it("should calculate daily schedule correctly", () => {
        const schedule = calculateLoanSchedule({
            principal: 20000,
            interestRate: 20,
            termMonths: 12,
            repaymentType: "daily",
            startDate: new Date("2024-01-01")
        });

        // 12 months * 30 days = 360 installments
        expect(schedule.length).toBe(360);
        // Total interest = 4000
        // Total = 24000
        // Exact components conserve 24000.00; the final row carries the cent residual.
        expect(schedule[0].amount).toBe("66.67");
        expect(schedule[359].amount).toBe("65.47");
    });

    it("should start scheduled repayments on the explicit payment start date", () => {
        const schedule = calculateLoanSchedule({
            principal: 1000,
            interestRate: 0,
            termMonths: 1,
            repaymentType: "daily",
            startDate: new Date("2024-01-01"),
            paymentStartDate: new Date("2024-01-05"),
            totalInstallments: 2,
            installmentAmount: 500,
        });

        expect(schedule.map((row) => row.dueDate)).toEqual(["2024-01-05", "2024-01-06"]);
    });

    it("should use custom weekly count and fixed amount to derive scheduled interest", () => {
        const schedule = calculateLoanSchedule({
            principal: "30000.00",
            interestRate: "0.00",
            termMonths: 3,
            repaymentType: "weekly",
            startDate: new Date("2026-08-31T00:00:00Z"),
            totalInstallments: 10,
            installmentAmount: "5000.00",
        });

        expect(schedule).toHaveLength(10);
        expect(schedule[0]).toMatchObject({
            dueDate: "2026-09-07", amount: "5000.00", principalComponent: "3000.00", interestComponent: "2000.00",
        });
        expect(schedule.at(-1)).toMatchObject({ dueDate: "2026-11-09", remainingPrincipal: "0.00" });
        const totalInterest = schedule.reduce((sum, row) => sum.plus(row.interestComponent), new FinancialDecimal("0.00"));
        expect(totalInterest.toFixed(2)).toBe("20000.00");
    });

    it("should use custom monthly count and fixed amount", () => {
        const schedule = calculateLoanSchedule({
            principal: "1000.00", interestRate: "0.00", termMonths: 12,
            repaymentType: "monthly", startDate: new Date("2026-08-31T00:00:00Z"),
            totalInstallments: 3, installmentAmount: "500.00",
        });

        expect(schedule.map((row) => row.dueDate)).toEqual(["2026-09-30", "2026-10-30", "2026-11-30"]);
        expect(schedule.map((row) => row.amount)).toEqual(["500.00", "500.00", "500.00"]);
        expect(schedule.at(-1)?.remainingPrincipal).toBe("0.00");
    });

    it("keeps every custom installment non-negative when interest is only a few cents", () => {
        const schedule = calculateLoanSchedule({
            principal: "100.00", interestRate: "0.00", termMonths: 12,
            repaymentType: "monthly", startDate: new Date("2026-08-31T00:00:00Z"),
            totalInstallments: 12, installmentAmount: "8.34",
        });

        expect(schedule.map((row) => row.amount)).toEqual(Array(12).fill("8.34"));
        expect(schedule.every((row) => new FinancialDecimal(row.principalComponent).greaterThanOrEqualTo(0)
            && new FinancialDecimal(row.interestComponent).greaterThanOrEqualTo(0))).toBe(true);
        expect(schedule.reduce((sum, row) => sum.plus(row.interestComponent), new FinancialDecimal("0.00")).toFixed(2)).toBe("0.08");
        expect(schedule.at(-1)?.remainingPrincipal).toBe("0.00");
    });

    it("should reject one-sided custom scheduled terms and totals below principal", () => {
        expect(() => calculatePublicLoanSchedule({
            principal: "1000.00", interestRate: "0.00", termMonths: 3,
            repaymentType: "weekly", startDate: "2026-08-31", totalInstallments: 10,
        })).toThrow("Fixed installment count and amount must be entered together");
        expect(() => calculateLoanSchedule({
            principal: "1000.00", interestRate: "0.00", termMonths: 3,
            repaymentType: "weekly", startDate: new Date("2026-08-31T00:00:00Z"),
            totalInstallments: 2, installmentAmount: "400.00",
        })).toThrow("Installment total cannot be less than principal");
    });

    it("should calculate pro-rated closing amount", () => {
        const principal = 20000;
        const rate = 18; // 18% per year
        const start = new Date("2024-01-01");
        const close = new Date("2024-01-11"); // 10 days passed

        const closingAmount = calculateProRatedClosing(principal, rate, start, close);

        // Interest = 20000 * 0.18 * (10/365) = 98.63
        // Total = 20098.63
        expect(closingAmount).toBeCloseTo(20098.63, 1);
    });
});


describe("Loan Closing Summary Calculator", () => {
    const loan = {
        principalAmount: "10000",
        interestRate: "10", // 10% per year
        startDate: "2024-01-01",
    };

    it("should calculate correctly with partial payments", () => {
        const transactions = [{ amount: "1000" }, { amount: "500" }];
        const closingDate = new Date("2024-07-01");
        
        const summary = calculateLoanClosingSummary(loan, transactions, closingDate);
        
        const expectedInterest = 10000 * 0.10 * (summary.daysSinceStart / 365);
        const expectedTotalDue = 10000 + expectedInterest;
        const totalPaid = 1500;
        const expectedBalance = expectedTotalDue - totalPaid;
        
        const expectedDays = dayjs(closingDate).diff(dayjs(loan.startDate), 'day');

        expect(summary.daysSinceStart).toBe(expectedDays);
        expect(summary.principal).toBe(10000);
        expect(summary.totalInterest).toBeCloseTo(expectedInterest);
        expect(summary.totalPaid).toBe(1500);
        expect(summary.totalDue).toBeCloseTo(expectedTotalDue);
        expect(summary.balance).toBeCloseTo(expectedBalance);
    });

    it("should calculate correctly with no payments", () => {
        const transactions: { amount: string }[] = [];
        const closingDate = new Date("2025-01-01"); // Exactly 366 days in a leap year
        const summary = calculateLoanClosingSummary(loan, transactions, closingDate);
        
        const expectedDays = dayjs(closingDate).diff(dayjs(loan.startDate), 'day');
        const expectedInterest = 10000 * 0.10 * (summary.daysSinceStart / 365);

        expect(summary.daysSinceStart).toBe(expectedDays); // 366 days for a leap year
        expect(summary.principal).toBe(10000);
        expect(summary.totalInterest).toBeCloseTo(expectedInterest);
        expect(summary.totalPaid).toBe(0);
        expect(summary.totalDue).toBeCloseTo(10000 + expectedInterest);
        expect(summary.balance).toBeCloseTo(10000 + expectedInterest);
    });

    it("should calculate correctly when overpaid", () => {
        const transactions = [{ amount: "6000" }, { amount: "6000" }];
        const closingDate = new Date("2025-01-01"); // Exactly 366 days
        const summary = calculateLoanClosingSummary(loan, transactions, closingDate);

        const expectedDays = dayjs(closingDate).diff(dayjs(loan.startDate), 'day');
        const expectedInterest = 10000 * 0.10 * (summary.daysSinceStart / 365);

        expect(summary.daysSinceStart).toBe(expectedDays);
        expect(summary.totalPaid).toBe(12000);
        expect(summary.totalDue).toBeCloseTo(10000 + expectedInterest);
        expect(summary.balance).toBeCloseTo((10000 + expectedInterest) - 12000);
    });

    it("should return principal if closing date is on or before start date", () => {
        const transactions: { amount: string }[] = [];
        const closingDate = new Date("2024-01-01");
        const summary = calculateLoanClosingSummary(loan, transactions, closingDate);

        expect(summary.daysSinceStart).toBe(0);
        expect(summary.totalInterest).toBe(0);
        expect(summary.totalDue).toBe(10000);
        expect(summary.balance).toBe(10000);
    });
});
