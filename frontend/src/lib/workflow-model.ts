import { normalizeMoney, type PaymentAllocationInput } from "./workflow-api";

export interface LoanTermsForm {
    principal: string;
    interestRate: string;
    termMonths: string;
    repaymentType: string;
    startDate: string;
    totalInstallments?: string;
    installmentAmount?: string;
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
    } = {
        principal: normalizeMoney(form.principal),
        interestRate: normalizeMoney(form.interestRate),
        termMonths: positiveInteger(form.termMonths, "termMonths"),
        repaymentType: form.repaymentType,
        startDate: form.startDate,
    };
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
