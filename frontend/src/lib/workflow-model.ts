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

function moneyParts(value: string) {
    const match = value.trim().match(/^(-?)(\d+)(?:\.(\d{1,2}))?$/);
    if (!match) throw new Error("Money must have at most two decimal places");
    const cents = BigInt(match[2]!) * 100n + BigInt((match[3] ?? "").padEnd(2, "0"));
    return match[1] ? -cents : cents;
}

function centsToMoney(value: bigint) {
    const negative = value < 0n;
    const absolute = negative ? -value : value;
    return `${negative ? "-" : ""}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, "0")}`;
}

export function sumMoney(values: string[]) {
    return centsToMoney(values.reduce((total, value) => total + moneyParts(value), 0n));
}

export function moneyDifference(next: string, previous: string) {
    return centsToMoney(moneyParts(next) - moneyParts(previous));
}

export function remainingMoney(balance: string, deductions: string[]) {
    const remaining = deductions.reduce((total, value) => total - moneyParts(value), moneyParts(balance));
    return centsToMoney(remaining < 0n ? 0n : remaining);
}

export function absoluteMoney(value: string) {
    const cents = moneyParts(value);
    return centsToMoney(cents < 0n ? -cents : cents);
}

export function isNegativeMoney(value: string) {
    return moneyParts(value) < 0n;
}

export function isPositiveMoney(value: string) {
    return moneyParts(value) > 0n;
}

export function formatDecimalExact(value: string, locale: string) {
    const cents = moneyParts(value);
    const negative = cents < 0n;
    const absolute = negative ? -cents : cents;
    const whole = absolute / 100n;
    const fraction = (absolute % 100n).toString().padStart(2, "0");
    const parts = new Intl.NumberFormat(locale, {
        minimumFractionDigits: 2, maximumFractionDigits: 2,
    }).formatToParts(negative ? -0 : 0);
    return parts.map((part) => {
        if (part.type === "integer") return whole.toLocaleString(locale);
        if (part.type === "fraction") return fraction;
        return part.value;
    }).join("");
}

export function formatMoneyExact(value: string, locale: string, currency = "THB") {
    const cents = moneyParts(value);
    const negative = cents < 0n;
    const absolute = negative ? -cents : cents;
    const whole = absolute / 100n;
    const fraction = (absolute % 100n).toString().padStart(2, "0");
    const parts = new Intl.NumberFormat(locale, {
        style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2,
    }).formatToParts(negative ? -0 : 0);
    return parts.map((part) => {
        if (part.type === "integer") return whole.toLocaleString(locale);
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
