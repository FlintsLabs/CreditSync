import type Decimal from "decimal.js";
import { FinancialDecimal, unsignedPublicMoneyPattern } from "./financial-decimal";

export type Money = Decimal;
export type MoneyInput = Decimal.Value;

const invalidMoneyMessage = "Money must be a non-negative string with exactly two decimals";

export function quantizeMoney(value: MoneyInput): Money {
    const money = new FinancialDecimal(value);
    if (!money.isFinite() || money.isNegative()) {
        throw new Error(invalidMoneyMessage);
    }
    const quantized = money.toDecimalPlaces(2, FinancialDecimal.ROUND_HALF_UP);
    if (!unsignedPublicMoneyPattern.test(quantized.toFixed(2))) {
        throw new Error(invalidMoneyMessage);
    }
    return quantized;
}

export function parseMoney(value: string): Money {
    if (!unsignedPublicMoneyPattern.test(value)) {
        throw new Error(invalidMoneyMessage);
    }
    return quantizeMoney(value);
}

export function sumMoney(values: readonly MoneyInput[]): Money {
    return quantizeMoney(values.reduce<Money>((total, value) => total.plus(value), new FinancialDecimal("0")));
}

export function serializeMoney(value: MoneyInput): string {
    return quantizeMoney(value).toFixed(2);
}

export interface PaymentScheduleBalance {
    scheduleId: string;
    installmentNo: number;
    dueDate?: string;
    penaltyDue: string;
    feeDue: string;
    interestDue: string;
    principalDue: string;
}

export interface PaymentAllocation {
    scheduleId: string;
    penalty: string;
    fee: string;
    interest: string;
    principal: string;
    total: string;
}

export interface PaymentAllocationResult {
    allocations: PaymentAllocation[];
    unallocatedAmount: string;
}

function takeAvailable(remaining: Money, due: Money): [Money, Money] {
    const allocated = FinancialDecimal.min(remaining, due);
    return [allocated, remaining.minus(allocated)];
}

export function allocatePaymentOldestFirst(
    paymentAmount: string,
    schedules: readonly PaymentScheduleBalance[],
): PaymentAllocationResult {
    let remaining = parseMoney(paymentAmount);
    if (remaining.isZero()) {
        throw new Error("Payment amount must be greater than zero");
    }

    const orderedSchedules = [...schedules].sort((left, right) => {
        if (left.dueDate && !right.dueDate) return -1;
        if (!left.dueDate && right.dueDate) return 1;
        const dueDateComparison = (left.dueDate ?? "").localeCompare(right.dueDate ?? "");
        return dueDateComparison || left.installmentNo - right.installmentNo;
    });
    const allocations: PaymentAllocation[] = [];

    for (const schedule of orderedSchedules) {
        if (remaining.isZero()) break;

        const penaltyDue = parseMoney(schedule.penaltyDue);
        const feeDue = parseMoney(schedule.feeDue);
        const interestDue = parseMoney(schedule.interestDue);
        const principalDue = parseMoney(schedule.principalDue);

        let penalty: Money;
        [penalty, remaining] = takeAvailable(remaining, penaltyDue);
        let fee: Money;
        [fee, remaining] = takeAvailable(remaining, feeDue);
        let interest: Money;
        [interest, remaining] = takeAvailable(remaining, interestDue);
        let principal: Money;
        [principal, remaining] = takeAvailable(remaining, principalDue);

        const total = sumMoney([penalty, fee, interest, principal]);
        if (!total.isZero()) {
            allocations.push({
                scheduleId: schedule.scheduleId,
                penalty: serializeMoney(penalty),
                fee: serializeMoney(fee),
                interest: serializeMoney(interest),
                principal: serializeMoney(principal),
                total: serializeMoney(total),
            });
        }
    }

    return {
        allocations,
        unallocatedAmount: serializeMoney(remaining),
    };
}
