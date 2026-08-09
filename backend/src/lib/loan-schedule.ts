import { calculateLoanSchedule, type RepaymentType } from "./calculator";

interface GenerateLoanScheduleInput {
    principal: number | string;
    interestRate: number | string;
    termMonths: number;
    repaymentType: RepaymentType;
    startDate?: string;
    totalInstallments?: number;
    installmentAmount?: number | string;
}

export interface GeneratedLoanScheduleRow {
    installmentNo: number;
    dueDate: string;
    scheduledPrincipal: string;
    scheduledInterest: string;
    scheduledFee: string;
    scheduledTotal: string;
    remainingDue: string;
}

export function generateLoanSchedule(input: GenerateLoanScheduleInput): GeneratedLoanScheduleRow[] {
    const startDate = input.startDate ? new Date(input.startDate) : new Date();
    const schedule = calculateLoanSchedule({
        principal: input.principal,
        interestRate: input.interestRate,
        termMonths: input.termMonths,
        repaymentType: input.repaymentType,
        startDate,
        totalInstallments: input.totalInstallments,
        installmentAmount: input.installmentAmount,
    });

    return schedule.map((row) => ({
        installmentNo: row.installmentNo,
        dueDate: row.dueDate,
        scheduledPrincipal: row.principalComponent.toFixed(2),
        scheduledInterest: row.interestComponent.toFixed(2),
        scheduledFee: "0.00",
        scheduledTotal: row.amount.toFixed(2),
        remainingDue: row.amount.toFixed(2),
    }));
}
