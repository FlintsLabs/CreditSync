import { and, eq } from "drizzle-orm";
import { FinancialDecimal } from "../lib/financial-decimal";
import { type DbExecutor } from "../db";
import { transactions } from "../db/schema";
import { DomainError } from "./domain-error";

function bangkokDate(date: Date) {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
    const get = (key: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === key)?.value;
    return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Blocks historical receipts only when a later live principal or paid-penalty record depends on chronology. */
export async function assertSelectedFloatingHistorySafe(tx: DbExecutor, tenantId: string, loanId: number, receivedAt: Date, loanPublicId?: string) {
    const rows = await tx.select().from(transactions).where(and(eq(transactions.tenantId, tenantId), eq(transactions.loanId, loanId)));
    const children = new Map<number, number[]>();
    for (const row of rows) if (row.reversedTransactionId !== null) children.set(row.reversedTransactionId, [...(children.get(row.reversedTransactionId) ?? []), row.id]);
    const isLive = (id: number) => {
        let frontier = [id];
        let depth = 0;
        while (frontier.some((current) => (children.get(current)?.length ?? 0) > 0)) {
            frontier = frontier.flatMap((current) => children.get(current) ?? []);
            depth++;
        }
        return depth % 2 === 0;
    };
    const receivedDate = bangkokDate(receivedAt);
    const blocker = rows.find((row) => row.postedAt !== null && row.transactionDate !== null
        && bangkokDate(row.transactionDate) > receivedDate && isLive(row.id)
        && (new FinancialDecimal(row.principalComponent).gt(0) || new FinancialDecimal(row.penaltyComponent).gt(0)));
    if (blocker) throw new DomainError("FLOATING_BACKDATED_ALLOCATION_REQUIRES_RECONCILIATION", "Historical receipt conflicts with later live principal or paid-penalty provenance", 409, { loanPublicId, effectiveDate: receivedDate });
}
