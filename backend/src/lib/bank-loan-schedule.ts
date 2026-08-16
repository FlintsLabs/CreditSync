import dayjs from "dayjs";
import { FinancialDecimal } from "./financial-decimal";
import { serializeMoney } from "./money";

export type RepaymentCycle = "daily" | "weekly" | "monthly" | "custom";

export interface BankLoanScheduleInput {
    amount: string;
    interestRate: string;
    startDate?: string;
    termMonths?: number;
    repaymentCycle?: RepaymentCycle;
    totalInstallments?: number;
    installmentAmount?: string;
    processingFeeAmount?: string;
    utilizationFeeAmount?: string;
    vatRate?: string;
}

export interface BankLoanScheduleRow {
    installmentNo: number;
    dueDate: string;
    scheduledPrincipal: string;
    scheduledInterest: string;
    scheduledFee: string;
    scheduledVat: string;
    scheduledTotal: string;
    remainingDue: string;
}

const periodsPerYear: Record<RepaymentCycle, number> = { daily: 365, weekly: 52, monthly: 12, custom: 12 };

function inferInstallmentCount(input: BankLoanScheduleInput) {
    if (input.totalInstallments && input.totalInstallments > 0) return input.totalInstallments;
    const termMonths = input.termMonths && input.termMonths > 0 ? input.termMonths : 1;
    return input.repaymentCycle === "daily" ? termMonths * 30 : input.repaymentCycle === "weekly" ? termMonths * 4 : termMonths;
}

function addInterval(baseDate: dayjs.Dayjs, cycle: RepaymentCycle, step: number) {
    return cycle === "daily" ? baseDate.add(step, "day") : cycle === "weekly" ? baseDate.add(step, "week") : baseDate.add(step, "month");
}

export function generateBankLoanSchedule(input: BankLoanScheduleInput): BankLoanScheduleRow[] {
    const cycle = input.repaymentCycle ?? "monthly";
    const totalInstallments = inferInstallmentCount(input);
    const principal = new FinancialDecimal(input.amount);
    const periodicRate = new FinancialDecimal(input.interestRate).div(100).div(periodsPerYear[cycle]);
    const fixedFee = new FinancialDecimal(input.processingFeeAmount ?? "0").plus(input.utilizationFeeAmount ?? "0");
    const vatRate = new FinancialDecimal(input.vatRate ?? "0").div(100);
    const baseDate = dayjs(input.startDate || new Date()).startOf("day");
    let installment = input.installmentAmount ? new FinancialDecimal(input.installmentAmount) : undefined;

    if (!installment || installment.isZero()) {
        installment = periodicRate.isZero()
            ? principal.div(totalInstallments)
            : principal.mul(periodicRate).div(new FinancialDecimal(1).minus(new FinancialDecimal(1).plus(periodicRate).pow(-totalInstallments)));
    }
    installment = installment.toDecimalPlaces(2, FinancialDecimal.ROUND_HALF_UP);

    const rows: BankLoanScheduleRow[] = [];
    let outstandingPrincipal = principal;
    for (let index = 0; index < totalInstallments; index += 1) {
        const interest = outstandingPrincipal.mul(periodicRate).toDecimalPlaces(2, FinancialDecimal.ROUND_HALF_UP);
        let principalComponent = index === totalInstallments - 1
            ? outstandingPrincipal
            : installment.minus(interest).toDecimalPlaces(2, FinancialDecimal.ROUND_HALF_UP);
        principalComponent = FinancialDecimal.max(new FinancialDecimal(0), FinancialDecimal.min(principalComponent, outstandingPrincipal));
        const fee = fixedFee.toDecimalPlaces(2, FinancialDecimal.ROUND_HALF_UP);
        const vat = interest.plus(fee).mul(vatRate).toDecimalPlaces(2, FinancialDecimal.ROUND_HALF_UP);
        const total = principalComponent.plus(interest).plus(fee).plus(vat);
        outstandingPrincipal = outstandingPrincipal.minus(principalComponent);
        rows.push({
            installmentNo: index + 1,
            dueDate: addInterval(baseDate, cycle, index + 1).format("YYYY-MM-DD"),
            scheduledPrincipal: serializeMoney(principalComponent),
            scheduledInterest: serializeMoney(interest),
            scheduledFee: serializeMoney(fee),
            scheduledVat: serializeMoney(vat),
            scheduledTotal: serializeMoney(total),
            remainingDue: serializeMoney(total),
        });
    }
    return rows;
}
