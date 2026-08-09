import dayjs from "dayjs";

export type RepaymentCycle = "daily" | "weekly" | "monthly" | "custom";

interface GenerateBankLoanScheduleInput {
    amount: number;
    interestRate: number;
    startDate?: string;
    termMonths?: number;
    repaymentCycle?: RepaymentCycle;
    totalInstallments?: number;
    installmentAmount?: number;
    processingFeeAmount?: number;
    utilizationFeeAmount?: number;
    vatRate?: number;
}

interface BankLoanScheduleRow {
    installmentNo: number;
    dueDate: string;
    scheduledPrincipal: string;
    scheduledInterest: string;
    scheduledFee: string;
    scheduledVat: string;
    scheduledTotal: string;
    remainingDue: string;
}

const periodsPerYear: Record<RepaymentCycle, number> = {
    daily: 365,
    weekly: 52,
    monthly: 12,
    custom: 12,
};

function roundMoney(value: number) {
    return Number(value.toFixed(2));
}

function inferInstallmentCount(input: GenerateBankLoanScheduleInput) {
    if (input.totalInstallments && input.totalInstallments > 0) {
        return input.totalInstallments;
    }

    const termMonths = input.termMonths && input.termMonths > 0 ? input.termMonths : 1;

    switch (input.repaymentCycle) {
        case "daily":
            return termMonths * 30;
        case "weekly":
            return termMonths * 4;
        case "monthly":
        case "custom":
        default:
            return termMonths;
    }
}

function addInterval(baseDate: dayjs.Dayjs, cycle: RepaymentCycle, step: number) {
    switch (cycle) {
        case "daily":
            return baseDate.add(step, "day");
        case "weekly":
            return baseDate.add(step, "week");
        case "monthly":
        case "custom":
        default:
            return baseDate.add(step, "month");
    }
}

export function generateBankLoanSchedule(input: GenerateBankLoanScheduleInput): BankLoanScheduleRow[] {
    const cycle = input.repaymentCycle ?? "monthly";
    const totalInstallments = inferInstallmentCount(input);
    const principal = roundMoney(input.amount);
    const annualRate = (input.interestRate ?? 0) / 100;
    const periodicRate = annualRate / periodsPerYear[cycle];
    const fixedFee = roundMoney((input.processingFeeAmount ?? 0) + (input.utilizationFeeAmount ?? 0));
    const vatRate = (input.vatRate ?? 0) / 100;
    const baseDate = dayjs(input.startDate || new Date()).startOf("day");

    const scheduledRows: BankLoanScheduleRow[] = [];
    let outstandingPrincipal = principal;

    let installmentAmount = input.installmentAmount;
    if (!installmentAmount || installmentAmount <= 0) {
        if (periodicRate === 0) {
            installmentAmount = principal / totalInstallments;
        } else {
            installmentAmount =
                (principal * periodicRate) /
                (1 - Math.pow(1 + periodicRate, -totalInstallments));
        }
    }

    installmentAmount = roundMoney(installmentAmount);

    for (let index = 0; index < totalInstallments; index += 1) {
        const interest = roundMoney(outstandingPrincipal * periodicRate);
        let principalComponent = roundMoney(installmentAmount - interest);
        if (index === totalInstallments - 1) {
            principalComponent = roundMoney(outstandingPrincipal);
        }
        principalComponent = Math.max(0, Math.min(principalComponent, outstandingPrincipal));

        const fee = fixedFee;
        const vat = roundMoney((interest + fee) * vatRate);
        const total = roundMoney(principalComponent + interest + fee + vat);

        outstandingPrincipal = roundMoney(outstandingPrincipal - principalComponent);

        scheduledRows.push({
            installmentNo: index + 1,
            dueDate: addInterval(baseDate, cycle, index + 1).format("YYYY-MM-DD"),
            scheduledPrincipal: principalComponent.toFixed(2),
            scheduledInterest: interest.toFixed(2),
            scheduledFee: fee.toFixed(2),
            scheduledVat: vat.toFixed(2),
            scheduledTotal: total.toFixed(2),
            remainingDue: total.toFixed(2),
        });
    }

    return scheduledRows;
}
