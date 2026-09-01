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
    scheduledInstallmentMode?: "rate_derived" | "fixed_total";
    dailyDurationUnit?: "days" | "months";
    dailyDurationValue?: string;
    dailyEntryMode?: "daily_payment" | "daily_interest";
    dailyPayment?: string;
    dailyInterestInputMode?: "percent" | "fixed_amount" | "per_thousand";
    dailyInterestInputValue?: string;
    singlePaymentDueDate?: string;
    singlePaymentFixedAgreedInterest?: string;
    singlePaymentInterestPolicy?: "fixed_only" | "greater_of_fixed_or_retroactive";
    singlePaymentRetroactiveRateType?: "percent_per_day" | "per_thousand_per_day";
    singlePaymentRetroactiveRate?: string;
    singlePaymentLatePenaltyMode?: "none" | "fixed_amount_per_day";
    singlePaymentLatePenaltyAmountPerDay?: string;
    singlePaymentLatePenaltyGraceDays?: string;
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
        scheduledInstallmentMode?: "rate_derived" | "fixed_total";
        dailyEntry?: {
            durationUnit: "days" | "months";
            durationValue: number;
            entryMode: "daily_payment" | "daily_interest";
            dailyPayment?: string;
            interestInput?: { mode: "percent" | "fixed_amount" | "per_thousand"; value: string };
        };
        singlePayment?: {
            dueDate: string;
            fixedAgreedInterest: string;
            interestPolicy: "fixed_only" | "greater_of_fixed_or_retroactive";
            retroactiveInterest?: { rateType: "percent_per_day" | "per_thousand_per_day"; rate: string };
            latePenalty: { mode: "none" } | { mode: "fixed_amount_per_day"; amountPerDay: string; graceDays: number };
        };
    } = {
        principal: normalizeMoney(form.principal),
        interestRate: normalizeMoney(form.interestRate),
        termMonths: positiveInteger(form.termMonths, "termMonths"),
        repaymentType: form.repaymentType,
        startDate: form.startDate,
    };
    if (form.repaymentType === "single_payment") {
        if (!form.singlePaymentDueDate) throw new Error("singlePaymentDueDate is required");
        if (!form.singlePaymentFixedAgreedInterest?.trim()) throw new Error("singlePaymentFixedAgreedInterest is required");
        const interestPolicy = form.singlePaymentInterestPolicy ?? "fixed_only";
        const latePenaltyMode = form.singlePaymentLatePenaltyMode ?? "none";
        const singlePayment: NonNullable<typeof terms.singlePayment> = {
            dueDate: form.singlePaymentDueDate,
            fixedAgreedInterest: normalizeMoney(form.singlePaymentFixedAgreedInterest),
            interestPolicy,
            latePenalty: latePenaltyMode === "fixed_amount_per_day"
                ? {
                    mode: "fixed_amount_per_day",
                    amountPerDay: normalizeMoney(form.singlePaymentLatePenaltyAmountPerDay ?? ""),
                    graceDays: Number(form.singlePaymentLatePenaltyGraceDays ?? "0"),
                }
                : { mode: "none" },
        };
        if (interestPolicy === "greater_of_fixed_or_retroactive") {
            if (!form.singlePaymentRetroactiveRateType || !form.singlePaymentRetroactiveRate?.trim()) throw new Error("singlePaymentRetroactiveInterest is required");
            singlePayment.retroactiveInterest = { rateType: form.singlePaymentRetroactiveRateType, rate: form.singlePaymentRetroactiveRate.trim() };
        }
        terms.singlePayment = singlePayment;
        return terms;
    }
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
    const scheduled = form.repaymentType === "weekly" || form.repaymentType === "monthly";
    if (scheduled && hasFixedAmount && !hasFixedCount) throw new Error("Installment amount requires total installments");
    if (hasFixedCount) {
        terms.totalInstallments = positiveInteger(form.totalInstallments!, "totalInstallments");
    }
    if (hasFixedAmount) {
        terms.installmentAmount = normalizeMoney(form.installmentAmount!);
        if (scheduled) terms.scheduledInstallmentMode = "fixed_total";
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
