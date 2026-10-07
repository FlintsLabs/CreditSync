import type { PaymentAllocationInput } from "../../../lib/workflow-api";
import { FinancialDecimal, unsignedMoneyInputPattern } from "../../../lib/financial-decimal";
import { normalizeMoney } from "../../../lib/workflow-api";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ReceiptAllocationDraft {
    id: string;
    borrowerPublicId: string;
    loanPublicId: string;
    schedulePublicId: string;
    amount: string;
}

function normalizeLocaleMoney(value: string, locale: string): string {
    const parts = new Intl.NumberFormat(locale).formatToParts(12345.6);
    const group = parts.find((part) => part.type === "group")?.value;
    const decimal = parts.find((part) => part.type === "decimal")?.value ?? ".";
    const stripped = value.trim().replace(/[\u00a0\u202f]/g, " ").replaceAll(group ?? "\u0000", "").trim();
    return normalizeMoney(decimal === "." ? stripped : stripped.replace(decimal, "."));
}

function allocationAmounts(rows: ReceiptAllocationDraft[], locale: string): string[] {
    const seen = new Set<string>();
    return rows.map((row) => {
        if (!uuidPattern.test(row.borrowerPublicId) || !uuidPattern.test(row.loanPublicId)) throw new Error("Allocation borrower and loan must be public UUIDs");
        const schedule = row.schedulePublicId.trim();
        if (schedule && !uuidPattern.test(schedule)) throw new Error("Schedule must be a public UUID");
        const target = `${row.loanPublicId}:${schedule}`;
        if (seen.has(target)) throw new Error("Duplicate contract and installment allocation");
        seen.add(target);
        const amount = normalizeLocaleMoney(row.amount, locale);
        if (!unsignedMoneyInputPattern.test(amount) || new FinancialDecimal(amount).lte(0)) throw new Error("Allocation amount must be positive public money");
        return amount;
    });
}

export function buildReceiptAllocations(rows: ReceiptAllocationDraft[], locale: string): PaymentAllocationInput[] {
    const amounts = allocationAmounts(rows, locale);
    return rows.map((row, index) => ({
        borrowerPublicId: row.borrowerPublicId,
        loanPublicId: row.loanPublicId,
        ...(row.schedulePublicId.trim() ? { schedulePublicId: row.schedulePublicId.trim() } : {}),
        amount: amounts[index]!,
    }));
}

export function receiptAllocationTotal(rows: ReceiptAllocationDraft[], locale: string): string {
    const amounts = allocationAmounts(rows, locale);
    const total = amounts.reduce((sum, amount) => sum.plus(amount), new FinancialDecimal(0));
    const canonical = total.toFixed(2);
    if (!unsignedMoneyInputPattern.test(canonical)) throw new Error("Allocation total exceeds public money bound");
    return canonical;
}

function validateParts(year: number, month: number, day: number, hour: number, minute: number) {
    const date = new Date(Date.UTC(year, month - 1, day, hour, minute));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || hour > 23 || minute > 59) {
        throw new Error("Invalid Bangkok receipt date/time");
    }
    return date;
}

export function bangkokReceiptInput(iso: string): string {
    const date = new Date(iso);
    if (!Number.isFinite(date.getTime())) throw new Error("Invalid receipt timestamp");
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(date);
    const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
    return `${value("year")}-${value("month")}-${value("day")}T${value("hour")}:${value("minute")}`;
}

export function bangkokReceiptTimestamp(localValue: string): string {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(localValue);
    if (!match) throw new Error("Invalid Bangkok receipt date/time");
    const [, year, month, day, hour, minute] = match;
    const local = validateParts(Number(year), Number(month), Number(day), Number(hour), Number(minute));
    return new Date(local.getTime() - 7 * 60 * 60 * 1000).toISOString();
}
