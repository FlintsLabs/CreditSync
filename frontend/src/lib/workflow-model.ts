import type Decimal from "decimal.js";
import { FinancialDecimal, signedMoneyInputPattern, signedPublicMoneyPattern } from "./financial-decimal";
import { normalizeMoney, type PaymentAllocationInput } from "./workflow-api";

export interface LoanTermsForm {
    principal: string;
    interestRate: string;
    termMonths: string;
    repaymentType: string;
    startDate: string;
    totalInstallments?: string;
    installmentAmount?: string;
    dailyDurationUnit?: "days" | "months";
    dailyDurationValue?: string;
    dailyEntryMode?: "daily_payment" | "daily_interest";
    dailyPayment?: string;
    dailyInterestInputMode?: "percent" | "fixed_amount" | "per_thousand";
    dailyInterestInputValue?: string;
}

export interface AllocationDraft extends PaymentAllocationInput {
    id: string;
}

function positiveInteger(value: string, field: string) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${field} must be a positive integer`);
    return parsed;
}

export function buildLoanTermsInput(form: LoanTermsForm) {
    const terms: {
        principal: string;
        interestRate: string;
        termMonths: number;
        repaymentType: string;
        startDate: string;
        totalInstallments?: number;
        installmentAmount?: string;
        dailyEntry?: {
            durationUnit: "days" | "months";
            durationValue: number;
            entryMode: "daily_payment" | "daily_interest";
            dailyPayment?: string;
            interestInput?: { mode: "percent" | "fixed_amount" | "per_thousand"; value: string };
        };
    } = {
        principal: normalizeMoney(form.principal),
        interestRate: normalizeMoney(form.interestRate),
        termMonths: positiveInteger(form.termMonths, "termMonths"),
        repaymentType: form.repaymentType,
        startDate: form.startDate,
    };
    if (form.repaymentType === "daily" && form.dailyEntryMode) {
        const durationUnit = form.dailyDurationUnit;
        if (!durationUnit) throw new Error("dailyDurationUnit is required");
        const dailyEntry = { durationUnit, durationValue: positiveInteger(form.dailyDurationValue ?? "", "dailyDurationValue"), entryMode: form.dailyEntryMode } as NonNullable<typeof terms.dailyEntry>;
        if (form.dailyEntryMode === "daily_payment") {
            if (!form.dailyPayment?.trim()) throw new Error("dailyPayment is required");
            dailyEntry.dailyPayment = normalizeMoney(form.dailyPayment);
        } else {
            if (!form.dailyInterestInputMode || !form.dailyInterestInputValue?.trim()) throw new Error("daily interest input is required");
            dailyEntry.interestInput = { mode: form.dailyInterestInputMode, value: form.dailyInterestInputValue.trim() };
        }
        terms.dailyEntry = dailyEntry;
        return terms;
    }
    const hasFixedCount = Boolean(form.totalInstallments?.trim());
    const hasFixedAmount = Boolean(form.installmentAmount?.trim());
    if (hasFixedCount !== hasFixedAmount) throw new Error("Fixed installment count and amount must be entered together");
    if (hasFixedCount && hasFixedAmount) {
        terms.totalInstallments = positiveInteger(form.totalInstallments!, "totalInstallments");
        terms.installmentAmount = normalizeMoney(form.installmentAmount!);
    }
    return terms;
}

function moneyValue(value: string) {
    const normalized = value.trim();
    if (!signedMoneyInputPattern.test(normalized)) {
        throw new Error("Money must have at most two decimal places");
    }
    const money = new FinancialDecimal(normalized);
    if (!money.isFinite()) throw new Error("Money must be finite");
    return money;
}

function moneyToString(value: Decimal) {
    const serialized = value.isZero() ? "0.00" : value.toFixed(2);
    if (!signedPublicMoneyPattern.test(serialized)) {
        throw new Error("Money exceeds the public 29-digit integer bound");
    }
    return serialized;
}

function groupWholeNumber(value: string, locale: string) {
    const group = new Intl.NumberFormat(locale).formatToParts(1000)
        .find((part) => part.type === "group")?.value ?? ",";
    return value.replace(/\B(?=(\d{3})+(?!\d))/g, group);
}

export function sumMoney(values: string[]) {
    return moneyToString(values.reduce((total, value) => total.plus(moneyValue(value)), new FinancialDecimal("0")));
}

export function moneyDifference(next: string, previous: string) {
    return moneyToString(moneyValue(next).minus(moneyValue(previous)));
}

export function remainingMoney(balance: string, deductions: string[]) {
    const remaining = deductions.reduce((total, value) => total.minus(moneyValue(value)), moneyValue(balance));
    return moneyToString(FinancialDecimal.max(new FinancialDecimal("0"), remaining));
}

export function absoluteMoney(value: string) {
    return moneyToString(moneyValue(value).abs());
}

export function isNegativeMoney(value: string) {
    const money = moneyValue(value);
    return money.isNegative() && !money.isZero();
}

export function isPositiveMoney(value: string) {
    const money = moneyValue(value);
    return money.isPositive() && !money.isZero();
}

export function formatDecimalExact(value: string, locale: string) {
    const money = moneyValue(value);
    const negative = money.isNegative() && !money.isZero();
    const [whole, fraction] = money.abs().toFixed(2).split(".") as [string, string];
    const parts = new Intl.NumberFormat(locale, {
        minimumFractionDigits: 2, maximumFractionDigits: 2,
    }).formatToParts(negative ? -0 : 0);
    return parts.map((part) => {
        if (part.type === "integer") return groupWholeNumber(whole, locale);
        if (part.type === "fraction") return fraction;
        return part.value;
    }).join("");
}

export function formatMoneyExact(value: string, locale: string, currency = "THB") {
    const money = moneyValue(value);
    const negative = money.isNegative() && !money.isZero();
    const [whole, fraction] = money.abs().toFixed(2).split(".") as [string, string];
    const parts = new Intl.NumberFormat(locale, {
        style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2,
    }).formatToParts(negative ? -0 : 0);
    return parts.map((part) => {
        if (part.type === "integer") return groupWholeNumber(whole, locale);
        if (part.type === "fraction") return fraction;
        return part.value;
    }).join("");
}

export function toExplicitAllocations(rows: AllocationDraft[]): PaymentAllocationInput[] {
    return rows.map(({ borrowerPublicId, loanPublicId, schedulePublicId, amount }) => ({
        borrowerPublicId,
        loanPublicId,
        ...(schedulePublicId?.trim() ? { schedulePublicId: schedulePublicId.trim() } : {}),
        amount: normalizeMoney(amount),
    }));
}
