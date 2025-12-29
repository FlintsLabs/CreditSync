import dayjs from "dayjs";

export type RepaymentType = "daily" | "weekly" | "monthly" | "floating";

export interface LoanCalculationParams {
    principal: number;
    interestRate: number; // Percent per year
    termMonths: number;
    repaymentType: RepaymentType;
    startDate: Date;
}

export interface InstallmentSchedule {
    installmentNo: number;
    dueDate: string;
    amount: number;
    principalComponent: number;
    interestComponent: number;
    remainingPrincipal: number;
}

export function calculateLoanSchedule(params: LoanCalculationParams): InstallmentSchedule[] {
    const { principal, interestRate, termMonths, repaymentType, startDate } = params;
    const schedule: InstallmentSchedule[] = [];

    // Simple Interest Logic for MVP
    // Total Interest = Principal * Rate * (Years)
    // Total Amount = Principal + Total Interest

    const years = termMonths / 12;
    const totalInterest = principal * (interestRate / 100) * years;
    const totalAmount = principal + totalInterest;

    let installments = 0;
    let installmentAmount = 0;

    // Determine number of installments based on type
    if (repaymentType === "daily") {
        installments = termMonths * 30; // Approx
        installmentAmount = Math.ceil(totalAmount / installments);
    } else if (repaymentType === "weekly") {
        installments = termMonths * 4;
        installmentAmount = Math.ceil(totalAmount / installments);
    } else if (repaymentType === "monthly") {
        installments = termMonths;
        installmentAmount = Math.ceil(totalAmount / installments);
    } else {
        // Floating: No fixed schedule, interest accrues daily
        return [];
    }

    let remainingPrincipal = principal;
    let currentDate = dayjs(startDate);

    for (let i = 1; i <= installments; i++) {
        // Simple amortization breakdown (Pro-rated evenly for simplicity in this MVP)
        // In real accounting, this might be effective rate.
        const interestPerInstallment = totalInterest / installments;
        const principalPerInstallment = totalAmount / installments - interestPerInstallment;

        remainingPrincipal -= principalPerInstallment;
        if (remainingPrincipal < 0) remainingPrincipal = 0;

        // Validating dates
        if (repaymentType === "daily") currentDate = currentDate.add(1, 'day');
        if (repaymentType === "weekly") currentDate = currentDate.add(1, 'week');
        if (repaymentType === "monthly") currentDate = currentDate.add(1, 'month');

        schedule.push({
            installmentNo: i,
            dueDate: currentDate.format("YYYY-MM-DD"),
            amount: installmentAmount,
            principalComponent: Number(principalPerInstallment.toFixed(2)),
            interestComponent: Number(interestPerInstallment.toFixed(2)),
            remainingPrincipal: Number(remainingPrincipal.toFixed(2))
        });
    }

    return schedule;
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
