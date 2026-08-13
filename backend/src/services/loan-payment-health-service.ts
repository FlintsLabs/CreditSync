import { and, eq } from "drizzle-orm";
import Decimal from "decimal.js";
import { db } from "../db";
import { loanSchedules, loans } from "../db/schema";
import { computeLoanPaymentHealth, type LoanPaymentHealth } from "../lib/loan-payment-health";
import { floatingInterestBalances } from "./floating-interest-service";

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
    input: { asOf: Date; actorUserId: number },
): Promise<LoanPaymentHealth> {
    const businessDate = bangkokBusinessDate(input.asOf);

    if (loan.repaymentType === "floating") {
        const balances = await floatingInterestBalances(executor, loan, input.asOf, input.actorUserId);
        const penaltyByDueDate = new Map(balances.penaltyGroups.map((group) => [group.dueDate, group.penaltyDue.toFixed(2)]));
        const dueGroups = new Map<string, {
            accrualDate: string;
            dueDate: string;
            interestAmount: Decimal;
            paidAmount: Decimal;
            status: string;
        }>();
        for (const row of balances.rows.filter((candidate: { tenantId: string; loanId: number }) =>
            candidate.tenantId === loan.tenantId && candidate.loanId === loan.id)) {
            const dueDate = row.periodEndDate ?? row.accrualDate;
            const existing = dueGroups.get(dueDate);
            if (!existing) {
                dueGroups.set(dueDate, {
                    accrualDate: row.periodStartDate ?? row.accrualDate,
                    dueDate,
                    interestAmount: new Decimal(row.interestAmount),
                    paidAmount: new Decimal(row.paidAmount),
                    status: row.status,
                });
                continue;
            }
            existing.interestAmount = existing.interestAmount.plus(row.interestAmount);
            existing.paidAmount = existing.paidAmount.plus(row.paidAmount);
            if (row.status !== "paid") existing.status = row.status === "accruing" && existing.status === "accruing" ? "accruing" : "due";
        }
        return computeLoanPaymentHealth({
            lifecycleStatus: loan.status ?? "draft",
            repaymentType: loan.repaymentType,
            businessDate,
            gracePeriodDays: loan.gracePeriodDays,
            lateFeeMode: loan.lateFeeMode,
            lateFeeAmount: loan.lateFeeAmount,
            schedules: [],
            accruals: [...dueGroups.values()].map((group) => ({
                    accrualDate: group.accrualDate,
                    dueDate: group.dueDate,
                    interestAmount: group.interestAmount.toFixed(2),
                    paidAmount: group.paidAmount.toFixed(2),
                    penaltyDue: penaltyByDueDate.get(group.dueDate) ?? "0.00",
                    status: group.status,
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
