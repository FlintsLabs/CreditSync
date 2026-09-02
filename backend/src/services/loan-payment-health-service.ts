import { and, eq, lte, sql } from "drizzle-orm";
import type Decimal from "decimal.js";
import { db } from "../db";
import { floatingTransactionAllocations, loanInterestAccruals, loanSchedules, loans } from "../db/schema";
import { FinancialDecimal } from "../lib/financial-decimal";
import { computeLoanPaymentHealth, type LoanPaymentHealth } from "../lib/loan-payment-health";
import type { CommandContext } from "./command-context";
import { floatingInterestBalances } from "./floating-interest-service";

export const loanListLegacyAccrualProjection = {
    tenantId: loanInterestAccruals.tenantId,
    loanId: loanInterestAccruals.loanId,
    accrualDate: loanInterestAccruals.accrualDate,
    interestAmount: loanInterestAccruals.interestAmount,
    paidAmount: loanInterestAccruals.paidAmount,
    status: loanInterestAccruals.status,
};

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

export async function getLoanListLegacyPaymentHealth(
    executor: typeof db,
    loan: typeof loans.$inferSelect,
    input: { asOf: Date },
): Promise<LoanPaymentHealth> {
    const rows = await executor.select(loanListLegacyAccrualProjection)
        .from(loanInterestAccruals)
        .where(and(
            eq(loanInterestAccruals.tenantId, loan.tenantId),
            eq(loanInterestAccruals.loanId, loan.id),
        ));

    return computeLoanPaymentHealth({
        lifecycleStatus: loan.status ?? "draft",
        repaymentType: loan.repaymentType,
        businessDate: bangkokBusinessDate(input.asOf),
        gracePeriodDays: loan.gracePeriodDays,
        lateFeeMode: loan.lateFeeMode,
        lateFeeAmount: loan.lateFeeAmount,
        schedules: [],
        accruals: rows.map((row) => ({
            accrualDate: row.accrualDate,
            dueDate: row.accrualDate,
            interestAmount: row.interestAmount,
            paidAmount: row.paidAmount,
            penaltyDue: "0.00",
            status: row.status,
        })),
    });
}

export async function getLoanPaymentHealth(
    executor: typeof db,
    loan: typeof loans.$inferSelect,
    input: { asOf: Date; context: CommandContext } | { asOf: Date; actorUserId: number },
): Promise<LoanPaymentHealth> {
    const businessDate = bangkokBusinessDate(input.asOf);

    if (loan.repaymentType === "floating") {
        const commandActor = "context" in input ? input.context : input.actorUserId;
        const balances = await floatingInterestBalances(executor, loan, input.asOf, commandActor);
        const penaltyByDueDate = new Map(balances.penaltyGroups.map((group) => [group.dueDate, group.penaltyDue.toFixed(2)]));
        const dailyPolicy = loan.interestPeriodUnit === "day" || loan.floatingAccrualCycle === "daily";
        const dueGroups = new Map<string, {
            accrualDate: string;
            dueDate: string;
            interestAmount: Decimal;
            paidAmount: Decimal;
            status: string;
        }>();
        for (const row of balances.rows.filter((candidate: { tenantId: string; loanId: number }) =>
            candidate.tenantId === loan.tenantId && candidate.loanId === loan.id)) {
            const dueDate = dailyPolicy || row.periodUnit === "day" || row.periodDays === 1
                ? row.accrualDate
                : row.periodEndDate ?? row.accrualDate;
            const existing = dueGroups.get(dueDate);
            if (!existing) {
                dueGroups.set(dueDate, {
                    accrualDate: row.periodStartDate ?? row.accrualDate,
                    dueDate,
                    interestAmount: new FinancialDecimal(row.interestAmount),
                    paidAmount: new FinancialDecimal(row.paidAmount),
                    status: row.status,
                });
                continue;
            }
            existing.interestAmount = existing.interestAmount.plus(row.interestAmount);
            existing.paidAmount = existing.paidAmount.plus(row.paidAmount);
            if (row.status !== "paid") {
                existing.status = row.status === "accruing" && existing.status === "accruing" ? "accruing" : "due";
            }
        }
        // A contract that deducted the first weekly period collects each later
        // anchored period in advance.  Surface that full contractual amount on
        // its start date, using the same allocation provenance as posting.
        if (loan.advanceInterestPeriods === 1) {
            const advanceRow = balances.rows.find((row) => row.periodStartDate !== null
                && row.periodEndDate !== null
                && row.periodStartDate !== loan.interestPeriodAnchorDate
                && row.periodStartDate <= businessDate
                && businessDate < row.periodEndDate);
            if (advanceRow?.periodStartDate && advanceRow.periodEndDate && advanceRow.contractualInterestAmount) {
                const allocated = await executor.select({ total: sql<string>`coalesce(sum(${floatingTransactionAllocations.amount}), 0)` })
                    .from(floatingTransactionAllocations).where(and(
                        eq(floatingTransactionAllocations.tenantId, loan.tenantId),
                        eq(floatingTransactionAllocations.loanId, loan.id),
                        eq(floatingTransactionAllocations.component, "interest"),
                        eq(floatingTransactionAllocations.dueDate, advanceRow.periodEndDate),
                        lte(floatingTransactionAllocations.effectiveDate, businessDate),
                    ));
                const paidAmount = new FinancialDecimal(allocated[0]?.total ?? "0.00");
                dueGroups.set(advanceRow.periodEndDate, {
                    accrualDate: advanceRow.periodStartDate,
                    // Advance collection is due when the anchored period opens;
                    // allocation provenance still retains periodEndDate.
                    dueDate: advanceRow.periodStartDate,
                    interestAmount: new FinancialDecimal(advanceRow.contractualInterestAmount),
                    paidAmount,
                    status: paidAmount.gte(advanceRow.contractualInterestAmount) ? "paid" : "due",
                });
            }
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
