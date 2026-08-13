import dayjs from "dayjs";
import Decimal from "decimal.js";
import { parseMoney, serializeMoney } from "./money";
import { normalizeDailyLoanEntry, type DailyLoanEntryInput } from "./daily-loan-entry";
import type { FloatingInterestPolicy } from "./floating-interest-policy";

export type RepaymentType = "daily" | "weekly" | "monthly" | "floating";

export interface LoanCalculationParams {
    principal: Decimal.Value;
    interestRate: Decimal.Value; // Percent per year
    termMonths: number;
    repaymentType: RepaymentType;
    startDate: Date;
    totalInstallments?: number;
    installmentAmount?: Decimal.Value;
}

export interface InstallmentSchedule {
    installmentNo: number;
    dueDate: string;
    amount: string;
    principalComponent: string;
    interestComponent: string;
    remainingPrincipal: string;
}

export interface PublicLoanCalculationParams {
    principal: string;
    interestRate: string;
    termMonths: number;
    repaymentType: RepaymentType;
    startDate: string;
    totalInstallments?: number;
    installmentAmount?: string;
    dailyEntry?: DailyLoanEntryInput;
    floatingInterestPolicy?: FloatingInterestPolicy;
}

export interface PublicInstallmentSchedule {
    installmentNo: number;
    dueDate: string;
    amount: string;
    principalComponent: string;
    interestComponent: string;
    remainingPrincipal: string;
}

export interface PublicLoanTerms {
    principal: string;
    interestRate: string;
    termMonths: number;
    repaymentType: RepaymentType;
    totalInstallments?: number;
    installmentAmount?: string;
}

export function normalizePublicLoanTerms(input: PublicLoanTerms): PublicLoanTerms {
    if (!Number.isFinite(input.termMonths) || !Number.isInteger(input.termMonths) || input.termMonths <= 0) {
        throw new Error("Term months must be a positive whole number");
    }
    if (!(["daily", "weekly", "monthly", "floating"] as const).includes(input.repaymentType)) {
        throw new Error("Repayment type is not supported");
    }
    if (input.totalInstallments !== undefined
        && (!Number.isFinite(input.totalInstallments)
            || !Number.isInteger(input.totalInstallments)
            || input.totalInstallments <= 0)) {
        throw new Error(input.repaymentType === "daily"
            ? "Daily total installments must be a positive integer"
            : "Total installments must be a positive integer");
    }

    return {
        ...input,
        principal: serializeMoney(parseMoney(input.principal)),
        interestRate: serializeMoney(parseMoney(input.interestRate)),
        installmentAmount: input.installmentAmount === undefined
            ? undefined
            : serializeMoney(parseMoney(input.installmentAmount)),
    };
}

export function calculateLoanSchedule(params: LoanCalculationParams): InstallmentSchedule[] {
    const { principal, interestRate, termMonths, repaymentType, startDate } = params;
    const schedule: InstallmentSchedule[] = [];

    // Simple Interest Logic for MVP
    // Total Interest = Principal * Rate * (Years)
    // Total Amount = Principal + Total Interest

    const principalMoney = new Decimal(principal);
    const interestRatePercent = new Decimal(interestRate);
    if (!principalMoney.isFinite() || !interestRatePercent.isFinite() || principalMoney.isNegative() || interestRatePercent.isNegative()) {
        throw new Error("Loan principal and interest rate must be non-negative finite values");
    }
    const totalInterest = principalMoney.times(interestRatePercent).div(100).times(termMonths).div(12)
        .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const totalAmount = principalMoney.plus(totalInterest);

    let installments = 0;
    let dailyInstallmentMoney: Decimal | undefined;

    // Determine number of installments based on type
    if (repaymentType === "daily") {
        if (params.totalInstallments !== undefined
            && (!Number.isFinite(params.totalInstallments)
                || !Number.isInteger(params.totalInstallments)
                || params.totalInstallments <= 0)) {
            throw new Error("Daily total installments must be a positive integer");
        }
        installments = params.totalInstallments ?? termMonths * 30; // Approx
        dailyInstallmentMoney = params.installmentAmount === undefined
            ? undefined
            : new Decimal(params.installmentAmount).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    } else if (repaymentType === "weekly") {
        installments = termMonths * 4;
    } else if (repaymentType === "monthly") {
        installments = termMonths;
    } else {
        // Floating: No fixed schedule, interest accrues daily
        return [];
    }

    const fixedDailyInstallment = repaymentType === "daily"
        && params.totalInstallments !== undefined
        && params.installmentAmount !== undefined;
    const fixedTotal = fixedDailyInstallment
        ? dailyInstallmentMoney!.times(installments)
        : totalAmount;
    if (fixedTotal.lessThan(principalMoney)) {
        throw new Error("Installment total cannot be less than principal");
    }
    const scheduledInterest = fixedDailyInstallment ? fixedTotal.minus(principalMoney) : totalInterest;
    const principalPerInstallment = principalMoney.div(installments).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    const interestPerInstallment = scheduledInterest.div(installments).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
    let allocatedPrincipal = new Decimal(0);
    let allocatedInterest = new Decimal(0);
    let remainingPrincipal = principalMoney;
    let currentDate = dayjs(startDate);

    for (let i = 1; i <= installments; i++) {
        const isFinalInstallment = i === installments;
        const principalComponent = isFinalInstallment
            ? principalMoney.minus(allocatedPrincipal)
            : principalPerInstallment;
        const interestComponent = isFinalInstallment
            ? scheduledInterest.minus(allocatedInterest)
            : interestPerInstallment;
        allocatedPrincipal = allocatedPrincipal.plus(principalComponent);
        allocatedInterest = allocatedInterest.plus(interestComponent);
        remainingPrincipal = Decimal.max(0, remainingPrincipal.minus(principalComponent));
        const rowTotal = principalComponent.plus(interestComponent)
            .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

        // Validating dates
        if (repaymentType === "daily") currentDate = currentDate.add(1, 'day');
        if (repaymentType === "weekly") currentDate = currentDate.add(1, 'week');
        if (repaymentType === "monthly") currentDate = currentDate.add(1, 'month');

        schedule.push({
            installmentNo: i,
            dueDate: currentDate.format("YYYY-MM-DD"),
            amount: rowTotal.toFixed(2),
            principalComponent: principalComponent.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
            interestComponent: interestComponent.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
            remainingPrincipal: remainingPrincipal.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2)
        });
    }

    return schedule;
}

export function calculatePublicLoanSchedule(params: PublicLoanCalculationParams): PublicInstallmentSchedule[] {
    const dailyEntry = params.dailyEntry === undefined ? null : (() => {
        if (params.repaymentType !== "daily") throw new Error("Daily entry requires daily repayment");
        return normalizeDailyLoanEntry({ principal: params.principal, ...params.dailyEntry });
    })();
    const terms = normalizePublicLoanTerms({
        ...params,
        interestRate: dailyEntry ? "0.00" : params.interestRate,
        termMonths: dailyEntry?.termMonths ?? params.termMonths,
        totalInstallments: dailyEntry?.totalInstallments ?? params.totalInstallments,
        installmentAmount: dailyEntry?.installmentAmount ?? params.installmentAmount,
    });
    const schedule = calculateLoanSchedule({
        principal: parseMoney(terms.principal),
        interestRate: parseMoney(terms.interestRate),
        termMonths: terms.termMonths,
        repaymentType: terms.repaymentType,
        startDate: new Date(params.startDate),
        totalInstallments: terms.totalInstallments,
        installmentAmount: terms.installmentAmount === undefined ? undefined : parseMoney(terms.installmentAmount),
    });

    return schedule.map((row) => ({
        installmentNo: row.installmentNo,
        dueDate: row.dueDate,
        amount: row.amount,
        principalComponent: row.principalComponent,
        interestComponent: row.interestComponent,
        remainingPrincipal: row.remainingPrincipal,
    }));
}

export function calculateProRatedClosing(principal: number, interestRate: number, startDate: Date, closingDate: Date): number {
    // Principal + (Principal * Rate * DaysPassed / 365)
    const start = dayjs(startDate);
    const end = dayjs(closingDate);
    const days = end.diff(start, 'day');

    if (days <= 0) return principal;

    const interest = principal * (interestRate / 100) * (days / 365);
    return principal + interest;
}

export interface LoanClosingSummary {
    principal: number;
    totalInterest: number;
    totalPaid: number;
    totalDue: number;
    balance: number;
    daysSinceStart: number;
}

export function calculateLoanClosingSummary(
    loan: { principalAmount: string; interestRate: string; startDate: string | Date },
    transactions: { amount: string }[],
    closingDate: Date = new Date()
): LoanClosingSummary {
    const principal = parseFloat(loan.principalAmount);
    const interestRate = parseFloat(loan.interestRate);

    const start = dayjs(loan.startDate);
    const end = dayjs(closingDate);
    const daysSinceStart = Math.max(0, end.diff(start, 'day'));

    const totalInterest = principal * (interestRate / 100) * (daysSinceStart / 365);
    const totalDue = principal + totalInterest;

    const totalPaid = transactions.reduce((sum, tx) => sum + parseFloat(tx.amount), 0);

    const balance = totalDue - totalPaid;

    return {
        principal: Number(principal.toFixed(2)),
        totalInterest: Number(totalInterest.toFixed(2)),
        totalPaid: Number(totalPaid.toFixed(2)),
        totalDue: Number(totalDue.toFixed(2)),
        balance: Number(balance.toFixed(2)),
        daysSinceStart,
    };
}
