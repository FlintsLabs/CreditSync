import dayjs from "dayjs";
import Decimal from "decimal.js";

export type RepaymentType = "daily" | "weekly" | "monthly" | "floating";

export interface LoanCalculationParams {
    principal: number | string;
    interestRate: number | string; // Percent per year
    termMonths: number;
    repaymentType: RepaymentType;
    startDate: Date;
    totalInstallments?: number;
    installmentAmount?: number | string;
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

    const principalMoney = new Decimal(principal);
    const interestRatePercent = new Decimal(interestRate);
    if (!principalMoney.isFinite() || !interestRatePercent.isFinite() || principalMoney.isNegative() || interestRatePercent.isNegative()) {
        throw new Error("Loan principal and interest rate must be non-negative finite values");
    }
    const totalInterest = principalMoney.times(interestRatePercent).div(100).times(termMonths).div(12);
    const totalAmount = principalMoney.plus(totalInterest);

    let installments = 0;
    let installmentAmount = 0;

    // Determine number of installments based on type
    if (repaymentType === "daily") {
        installments = params.totalInstallments && params.totalInstallments > 0 ? params.totalInstallments : termMonths * 30; // Approx
        installmentAmount = params.installmentAmount === undefined
            ? totalAmount.div(installments).ceil().toNumber()
            : new Decimal(params.installmentAmount).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber();
    } else if (repaymentType === "weekly") {
        installments = termMonths * 4;
        installmentAmount = totalAmount.div(installments).ceil().toNumber();
    } else if (repaymentType === "monthly") {
        installments = termMonths;
        installmentAmount = totalAmount.div(installments).ceil().toNumber();
    } else {
        // Floating: No fixed schedule, interest accrues daily
        return [];
    }

    const fixedDailyInstallment = repaymentType === "daily"
        && params.totalInstallments !== undefined
        && params.installmentAmount !== undefined;
    const fixedTotal = fixedDailyInstallment
        ? new Decimal(params.installmentAmount!).times(installments)
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

        // Validating dates
        if (repaymentType === "daily") currentDate = currentDate.add(1, 'day');
        if (repaymentType === "weekly") currentDate = currentDate.add(1, 'week');
        if (repaymentType === "monthly") currentDate = currentDate.add(1, 'month');

        schedule.push({
            installmentNo: i,
            dueDate: currentDate.format("YYYY-MM-DD"),
            amount: installmentAmount,
            principalComponent: principalComponent.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber(),
            interestComponent: interestComponent.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber(),
            remainingPrincipal: remainingPrincipal.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toNumber()
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
