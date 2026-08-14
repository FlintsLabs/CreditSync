import { and, eq } from "drizzle-orm";
import Decimal from "decimal.js";
import { db } from "../db";
import { loanInterestAccruals, loanSchedules, loans } from "../db/schema";
import { computeLoanPaymentHealth, type LoanPaymentHealth } from "../lib/loan-payment-health";
import type { CommandContext } from "./command-context";
import { accrueFloatingInterestThrough } from "./floating-interest-service";

export function bangkokBusinessDate(value: Date) {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Bangkok",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(value);
    const read = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
    return `${read("year")}-${read("month")}-${read("day")}`;
}

export async function getLoanPaymentHealth(
    executor: typeof db,
    loan: typeof loans.$inferSelect,
    input: { asOf: Date; context: CommandContext },
): Promise<LoanPaymentHealth> {
    const businessDate = bangkokBusinessDate(input.asOf);

    if (loan.repaymentType === "floating") {
        const rows = loan.status === "active"
            ? await accrueFloatingInterestThrough(executor, loan, input.asOf, input.context)
            : await executor.select().from(loanInterestAccruals).where(and(
                eq(loanInterestAccruals.tenantId, loan.tenantId),
                eq(loanInterestAccruals.loanId, loan.id),
            ));
        return computeLoanPaymentHealth({
            lifecycleStatus: loan.status ?? "draft",
            repaymentType: loan.repaymentType,
            businessDate,
            gracePeriodDays: loan.gracePeriodDays,
            lateFeeMode: loan.lateFeeMode,
            lateFeeAmount: loan.lateFeeAmount,
            schedules: [],
            accruals: rows
                .filter((row: { tenantId: string; loanId: number }) => row.tenantId === loan.tenantId && row.loanId === loan.id)
                .map((row: { accrualDate: string; periodEndDate: string | null; interestAmount: string; paidAmount: string; status: string }) => ({
                    accrualDate: row.accrualDate,
                    periodEndDate: row.periodEndDate,
                    interestAmount: row.interestAmount,
                    paidAmount: row.paidAmount,
                    status: row.status,
                })),
        });
    }

    const rows = await executor.select().from(loanSchedules).where(and(
        eq(loanSchedules.tenantId, loan.tenantId),
        eq(loanSchedules.loanId, loan.id),
    ));
    return computeLoanPaymentHealth({
        lifecycleStatus: loan.status ?? "draft",
        repaymentType: loan.repaymentType,
        businessDate,
        gracePeriodDays: loan.gracePeriodDays,
        lateFeeMode: loan.lateFeeMode,
        lateFeeAmount: loan.lateFeeAmount,
        schedules: rows.map((row) => ({
            dueDate: row.dueDate,
            remainingDue: row.remainingDue,
            paidPenalty: row.paidPenalty,
            baseStatus: row.status,
        })),
        accruals: [],
    });
}
