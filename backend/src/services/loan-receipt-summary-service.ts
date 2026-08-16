import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { loanDisbursements, transactions } from "../db/schema";
import { FinancialDecimal } from "../lib/financial-decimal";
import { serializeMoney } from "../lib/money";
import { DomainError } from "./domain-error";

type Executor = any;

export type LoanReceiptSummary = {
    interestReceived: string;
    paidToDate: string;
};

export async function getLoanReceiptSummaries(
    executor: Executor,
    tenantId: string,
    loanIds: number[],
): Promise<Map<number, LoanReceiptSummary>> {
    if (loanIds.length === 0) return new Map();

    const summaries = new Map<number, {
        interestReceived: InstanceType<typeof FinancialDecimal>;
        paidToDate: InstanceType<typeof FinancialDecimal>;
    }>();
    for (const loanId of loanIds) {
        summaries.set(loanId, {
            interestReceived: new FinancialDecimal("0"),
            paidToDate: new FinancialDecimal("0"),
        });
    }

    const advanceRows = await executor.select({
        loanId: loanDisbursements.loanId,
        advanceInterest: sql<string>`coalesce(sum(${loanDisbursements.firstDayInterestDeducted}), 0)`,
    }).from(loanDisbursements).where(and(
        eq(loanDisbursements.tenantId, tenantId),
        inArray(loanDisbursements.loanId, loanIds),
    )).groupBy(loanDisbursements.loanId);

    for (const row of advanceRows) {
        const summary = summaries.get(row.loanId);
        if (!summary) continue;
        const advanceInterest = new FinancialDecimal(row.advanceInterest);
        summary.interestReceived = summary.interestReceived.plus(advanceInterest);
        summary.paidToDate = summary.paidToDate.plus(advanceInterest);
    }

    const paymentRows = await executor.select({
        loanId: transactions.loanId,
        interestReceived: sql<string>`coalesce(sum(${transactions.interestComponent}), 0)`,
        paidToDate: sql<string>`coalesce(sum(
            ${transactions.principalComponent}
            + ${transactions.interestComponent}
            + ${transactions.feeComponent}
            + ${transactions.penaltyComponent}
        ), 0)`,
    }).from(transactions).where(and(
        eq(transactions.tenantId, tenantId),
        inArray(transactions.loanId, loanIds),
        isNotNull(transactions.postedAt),
        inArray(transactions.entryType, ["repayment", "reversal"]),
    )).groupBy(transactions.loanId);

    for (const row of paymentRows) {
        const summary = summaries.get(row.loanId);
        if (!summary) continue;
        summary.interestReceived = summary.interestReceived.plus(row.interestReceived);
        summary.paidToDate = summary.paidToDate.plus(row.paidToDate);
    }

    const result = new Map<number, LoanReceiptSummary>();
    for (const [loanId, summary] of summaries) {
        if (summary.interestReceived.isNegative() || summary.paidToDate.isNegative()) {
            throw new DomainError(
                "LOAN_RECEIPT_SUMMARY_NEGATIVE",
                "Loan receipt history has a negative cumulative total",
                409,
                { loanId },
            );
        }
        result.set(loanId, {
            interestReceived: serializeMoney(summary.interestReceived),
            paidToDate: serializeMoney(summary.paidToDate),
        });
    }
    return result;
}
