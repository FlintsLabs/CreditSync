import { Elysia } from "elysia";
import { and, eq } from "drizzle-orm";
import Decimal from "decimal.js";
import { db } from "../db";
import { bankLoanRepayments, bankLoanSchedules, bankLoans, bankTransactions, borrowers, botUploads, intermediaries, loanFundingAllocations, loanIntermediaryAssignments, loanSchedules, loans, reconciliationEntries, transactions } from "../db/schema";
import { authPlugin } from "../middleware/auth";
import { isTenantAdminUser } from "../lib/access";
import { getTenantProfitabilitySummary } from "../lib/fund-settlement";
import { computeOverdueSnapshot } from "../lib/overdue";
import { withTenantCache } from "../lib/cache";
import { aggregateDashboardMoney, compareDashboardMoneyDescending, isPositiveDashboardMoney, positiveDashboardDifference, serializeDashboardProfitability, subtractDashboardMoney, sumDashboardMoney, sumDashboardPayableHealth } from "../lib/dashboard-money";
import { getDashboardBorrowerHealth } from "../services/dashboard-borrower-health-service";
import { bangkokBusinessDate } from "../services/loan-payment-health-service";
import { buildDashboardCollectionSummary } from "../services/dashboard-collection-summary-service";
import { loanCommandContext } from "./loan-http-support";

function todayString() {
    return new Date().toISOString().slice(0, 10);
}

export const dashboardRoute = new Elysia({ prefix: "/dashboard" })
    .use(authPlugin)
    .get("/summary", async ({ user, request, set }) => {
        if (!isTenantAdminUser(user)) {
            set.status = user ? 403 : 401;
            return { error: user ? "Forbidden" : "Unauthorized" };
        }

        return await withTenantCache({
            tenantId: user.tenantId,
            namespace: "dashboard",
            key: "summary",
            ttlSeconds: 20,
            loader: async () => {
                const today = todayString();

                const [borrowerHealth, fundScheduleRows, allLoans, allDrawdowns, allocations] = await Promise.all([
            getDashboardBorrowerHealth(db, { context: loanCommandContext(user, request), asOf: new Date() }),
            db.select().from(bankLoanSchedules).where(eq(bankLoanSchedules.tenantId, user.tenantId)),
            db.select().from(loans).where(eq(loans.tenantId, user.tenantId)),
            db.select().from(bankLoans).where(eq(bankLoans.tenantId, user.tenantId)),
            db.select().from(loanFundingAllocations).where(eq(loanFundingAllocations.tenantId, user.tenantId)),
        ]);

        const drawdownMap = new Map(allDrawdowns.map((drawdown) => [drawdown.id, drawdown]));
        const fundDueSnapshots = fundScheduleRows.map((row) => {
            const drawdown = drawdownMap.get(row.bankLoanId);
            const overdue = computeOverdueSnapshot({
                dueDate: row.dueDate,
                remainingDue: row.remainingDue,
                paidPenalty: row.paidPenalty,
                gracePeriodDays: drawdown?.gracePeriodDays,
                lateFeeMode: drawdown?.lateFeeMode,
                lateFeeAmount: drawdown?.lateFeeAmount,
                baseStatus: row.status,
                asOf: today,
            });
            return { ...row, ...overdue };
        });

        const dueFromBorrowersToday = sumDashboardPayableHealth(borrowerHealth);
        const dueToFundsToday = sumDashboardMoney(fundDueSnapshots
            .filter((row) => row.dueDate <= today && isPositiveDashboardMoney(row.totalDueNow))
            .map((row) => row.totalDueNow));
        const overdueBorrowerCount = borrowerHealth.filter((row) => row.status === "overdue").length;
        const overdueFundCount = fundDueSnapshots.filter((row) => row.effectiveStatus === "overdue").length;

        const fundedByLoan = aggregateDashboardMoney(allocations.map((allocation) => ({ key: allocation.loanId, amount: allocation.allocatedAmount })));
        const allocatedByDrawdown = aggregateDashboardMoney(allocations.filter((allocation) => allocation.bankLoanId).map((allocation) => ({ key: allocation.bankLoanId!, amount: allocation.allocatedAmount })));

        const underfundedLoanCount = allLoans.filter((loan) => {
            return isPositiveDashboardMoney(positiveDashboardDifference(loan.principalAmount, fundedByLoan.get(loan.id) ?? "0.00"));
        }).length;

        const unallocatedDrawdownCount = allDrawdowns.filter((drawdown) => {
            return isPositiveDashboardMoney(positiveDashboardDifference(drawdown.amount, allocatedByDrawdown.get(drawdown.id) ?? "0.00"));
        }).length;

                return {
            dueFromBorrowersToday,
            dueToFundsToday,
            netPositionToday: subtractDashboardMoney(dueFromBorrowersToday, dueToFundsToday),
            overdueBorrowerCount,
            overdueFundCount,
            underfundedLoanCount,
            unallocatedDrawdownCount,
                };
            },
        });
    })
    .get("/collection-summary", async ({ user, request, set }) => {
        if (!isTenantAdminUser(user)) {
            set.status = user ? 403 : 401;
            return { error: user ? "Forbidden" : "Unauthorized" };
        }

        return await withTenantCache({
            tenantId: user.tenantId,
            namespace: "dashboard",
            key: "collection-summary",
            ttlSeconds: 20,
            loader: async () => {
                const asOf = new Date();
                const [borrowerHealth, tenantLoans, assignments] = await Promise.all([
                    getDashboardBorrowerHealth(db, { context: loanCommandContext(user, request), asOf }),
                    db.select().from(loans).where(and(eq(loans.tenantId, user.tenantId), eq(loans.status, "active"))),
                    db.select({
                        loanId: loanIntermediaryAssignments.loanId,
                        intermediaryPublicId: intermediaries.publicId,
                        intermediaryName: intermediaries.name,
                        role: loanIntermediaryAssignments.role,
                        status: loanIntermediaryAssignments.status,
                        effectiveFrom: loanIntermediaryAssignments.effectiveFrom,
                        effectiveTo: loanIntermediaryAssignments.effectiveTo,
                    })
                        .from(loanIntermediaryAssignments)
                        .innerJoin(intermediaries, eq(loanIntermediaryAssignments.intermediaryId, intermediaries.id))
                        .where(eq(loanIntermediaryAssignments.tenantId, user.tenantId)),
                ]);
                const loansById = new Map(tenantLoans.map((loan) => [loan.id, loan]));
                return buildDashboardCollectionSummary({
                    businessDate: bangkokBusinessDate(asOf),
                    loans: borrowerHealth.flatMap((health) => {
                        const loan = loansById.get(health.loanId);
                        return loan ? [{
                            ...health,
                            interestPeriodUnit: loan.interestPeriodUnit,
                            floatingAccrualCycle: loan.floatingAccrualCycle,
                        }] : [];
                    }),
                    assignments: assignments.map((assignment) => ({
                        ...assignment,
                        effectiveFrom: assignment.effectiveFrom.toISOString(),
                        effectiveTo: assignment.effectiveTo?.toISOString() ?? null,
                    })),
                });
            },
        });
    })
    .get("/borrower-due-queue", async ({ user, request, set }) => {
        if (!isTenantAdminUser(user)) {
            set.status = user ? 403 : 401;
            return { error: user ? "Forbidden" : "Unauthorized" };
        }

        return await withTenantCache({
            tenantId: user.tenantId,
            namespace: "dashboard",
            key: "borrower-due-queue",
            ttlSeconds: 20,
            loader: async () => {
                const [rows, borrowerHealth] = await Promise.all([db.select({
            scheduleId: loanSchedules.id,
            schedulePublicId: loanSchedules.publicId,
            dueDate: loanSchedules.dueDate,
            remainingDue: loanSchedules.remainingDue,
            paidPenalty: loanSchedules.paidPenalty,
            status: loanSchedules.status,
            installmentNo: loanSchedules.installmentNo,
            loanId: loans.id,
            loanPublicId: loans.publicId,
            borrowerName: borrowers.name,
            repaymentType: loans.repaymentType,
            gracePeriodDays: loans.gracePeriodDays,
            lateFeeMode: loans.lateFeeMode,
            lateFeeAmount: loans.lateFeeAmount,
        })
            .from(loanSchedules)
            .leftJoin(loans, eq(loanSchedules.loanId, loans.id))
            .leftJoin(borrowers, eq(loans.borrowerId, borrowers.id))
            .where(and(eq(loanSchedules.tenantId, user.tenantId), eq(loans.tenantId, user.tenantId))),
            getDashboardBorrowerHealth(db, { context: loanCommandContext(user, request), asOf: new Date() }),
        ]);

                const scheduledRows = rows
            .map((row) => {
                const overdue = computeOverdueSnapshot({
                    dueDate: row.dueDate,
                    remainingDue: row.remainingDue,
                    paidPenalty: row.paidPenalty,
                    gracePeriodDays: row.gracePeriodDays,
                    lateFeeMode: row.lateFeeMode,
                    lateFeeAmount: row.lateFeeAmount,
                    baseStatus: row.status,
                });
                return {
                    ...row,
                    penaltyDue: overdue.penaltyDue.toFixed(2),
                    totalDueNow: overdue.totalDueNow.toFixed(2),
                    overdueItemCount: overdue.effectiveStatus === "overdue" ? 1 : 0,
                    overdueDays: overdue.overdueDays,
                    status: overdue.effectiveStatus,
                };
            })
            .filter((row) => isPositiveDashboardMoney(row.totalDueNow));
                const floatingRows = borrowerHealth
                    .filter((row) => row.repaymentType === "floating")
                    .map((row) => ({
                        scheduleId: null,
                        dueDate: null,
                        remainingDue: sumDashboardMoney([row.dueTodayAmount, row.overdueAmount]),
                        paidPenalty: "0.00",
                        status: row.status === "due_today" ? "due" : row.status,
                        installmentNo: null,
                        loanId: row.loanId,
                        loanPublicId: row.loanPublicId,
                        borrowerName: row.borrowerName,
                        repaymentType: row.repaymentType,
                        penaltyDue: "0.00",
                        totalDueNow: sumDashboardMoney([row.dueTodayAmount, row.overdueAmount]),
                        overdueItemCount: row.overdueItemCount,
                        overdueDays: row.maxOverdueDays,
                    }))
                    .filter((row) => isPositiveDashboardMoney(row.totalDueNow));

                return [...scheduledRows, ...floatingRows].sort((a, b) => {
                    const overdueDifference = (b.overdueDays ?? 0) - (a.overdueDays ?? 0);
                    if (overdueDifference !== 0) return overdueDifference;
                    return (a.dueDate ?? "9999-12-31").localeCompare(b.dueDate ?? "9999-12-31");
                });
            },
        });
    })
    .get("/fund-due-queue", async ({ user, set }) => {
        if (!isTenantAdminUser(user)) {
            set.status = user ? 403 : 401;
            return { error: user ? "Forbidden" : "Unauthorized" };
        }

        return await withTenantCache({
            tenantId: user.tenantId,
            namespace: "dashboard",
            key: "fund-due-queue",
            ttlSeconds: 20,
            loader: async () => {
                const rows = await db.select({
            scheduleId: bankLoanSchedules.id,
            dueDate: bankLoanSchedules.dueDate,
            remainingDue: bankLoanSchedules.remainingDue,
            paidPenalty: bankLoanSchedules.paidPenalty,
            status: bankLoanSchedules.status,
            installmentNo: bankLoanSchedules.installmentNo,
            bankLoanId: bankLoans.id,
            bankProfileId: bankLoans.bankProfileId,
            note: bankLoans.note,
            gracePeriodDays: bankLoans.gracePeriodDays,
            lateFeeMode: bankLoans.lateFeeMode,
            lateFeeAmount: bankLoans.lateFeeAmount,
        })
            .from(bankLoanSchedules)
            .leftJoin(bankLoans, eq(bankLoanSchedules.bankLoanId, bankLoans.id))
            .where(and(eq(bankLoanSchedules.tenantId, user.tenantId), eq(bankLoans.tenantId, user.tenantId)));

                return rows
            .map((row) => {
                const overdue = computeOverdueSnapshot({
                    dueDate: row.dueDate,
                    remainingDue: row.remainingDue,
                    paidPenalty: row.paidPenalty,
                    gracePeriodDays: row.gracePeriodDays,
                    lateFeeMode: row.lateFeeMode,
                    lateFeeAmount: row.lateFeeAmount,
                    baseStatus: row.status,
                });
                return {
                    ...row,
                    penaltyDue: overdue.penaltyDue.toFixed(2),
                    totalDueNow: overdue.totalDueNow.toFixed(2),
                    overdueDays: overdue.overdueDays,
                    status: overdue.effectiveStatus,
                };
            })
            .filter((row) => isPositiveDashboardMoney(row.totalDueNow))
            .sort((a, b) => a.dueDate.localeCompare(b.dueDate));
            },
        });
    })
    .get("/funding-alerts", async ({ user, set }) => {
        if (!isTenantAdminUser(user)) {
            set.status = user ? 403 : 401;
            return { error: user ? "Forbidden" : "Unauthorized" };
        }

        return await withTenantCache({
            tenantId: user.tenantId,
            namespace: "dashboard",
            key: "funding-alerts",
            ttlSeconds: 30,
            loader: async () => {
                const [allLoans, allDrawdowns, allocations] = await Promise.all([
            db.select({
                id: loans.id,
                principalAmount: loans.principalAmount,
                borrowerName: borrowers.name,
            }).from(loans).leftJoin(borrowers, eq(loans.borrowerId, borrowers.id)).where(eq(loans.tenantId, user.tenantId)),
            db.select().from(bankLoans).where(eq(bankLoans.tenantId, user.tenantId)),
            db.select().from(loanFundingAllocations).where(eq(loanFundingAllocations.tenantId, user.tenantId)),
        ]);

        const fundedByLoan = aggregateDashboardMoney(allocations.map((allocation) => ({ key: allocation.loanId, amount: allocation.allocatedAmount })));
        const allocatedByDrawdown = aggregateDashboardMoney(allocations.filter((allocation) => allocation.bankLoanId).map((allocation) => ({ key: allocation.bankLoanId!, amount: allocation.allocatedAmount })));

        const underfundedLoans = allLoans
            .map((loan) => {
                const fundedAmount = fundedByLoan.get(loan.id) ?? "0.00";
                const gap = positiveDashboardDifference(loan.principalAmount, fundedAmount);
                return {
                    id: loan.id,
                    borrowerName: loan.borrowerName,
                    principalAmount: sumDashboardMoney([loan.principalAmount]),
                    fundedAmount,
                    gap,
                };
            })
            .filter((loan) => isPositiveDashboardMoney(loan.gap))
            .sort((a, b) => compareDashboardMoneyDescending(a.gap, b.gap));

        const unallocatedDrawdowns = allDrawdowns
            .map((drawdown) => {
                const allocated = allocatedByDrawdown.get(drawdown.id) ?? "0.00";
                const availableAmount = positiveDashboardDifference(drawdown.amount, allocated);
                return {
                    id: drawdown.id,
                    bankProfileId: drawdown.bankProfileId,
                    totalAmount: sumDashboardMoney([drawdown.amount]),
                    allocatedAmount: allocated,
                    availableAmount,
                    nextDueDate: drawdown.nextDueDate,
                };
            })
            .filter((drawdown) => isPositiveDashboardMoney(drawdown.availableAmount))
            .sort((a, b) => compareDashboardMoneyDescending(a.availableAmount, b.availableAmount));

                return {
            underfundedLoans,
            unallocatedDrawdowns,
                };
            },
        });
    })
    .get("/reconciliation-status", async ({ user, set }) => {
        if (!isTenantAdminUser(user)) {
            set.status = user ? 403 : 401;
            return { error: user ? "Forbidden" : "Unauthorized" };
        }

        return await withTenantCache({
            tenantId: user.tenantId,
            namespace: "dashboard",
            key: "reconciliation-status",
            ttlSeconds: 15,
            loader: async () => {
                const [borrowerTransactions, rawBankTransactions, bankLoanRepaymentsRows, pendingUploads, reconciliations] = await Promise.all([
            db.select({
                id: transactions.id,
                scheduleId: transactions.scheduleId,
                slipUrl: transactions.slipUrl,
            }).from(transactions).where(eq(transactions.tenantId, user.tenantId)),
            db.select({
                id: bankTransactions.id,
            }).from(bankTransactions).where(eq(bankTransactions.tenantId, user.tenantId)),
            db.select({
                id: bankLoanRepayments.id,
                scheduleId: bankLoanRepayments.scheduleId,
            }).from(bankLoanRepayments).where(eq(bankLoanRepayments.tenantId, user.tenantId)),
            db.select({
                id: botUploads.id,
            }).from(botUploads).where(
                and(
                    eq(botUploads.tenantId, user.tenantId),
                    eq(botUploads.status, "pending")
                )
            ),
            db.select({
                entityType: reconciliationEntries.entityType,
                entityId: reconciliationEntries.entityId,
                status: reconciliationEntries.status,
            }).from(reconciliationEntries).where(eq(reconciliationEntries.tenantId, user.tenantId)),
        ]);

        const matchedKeys = new Set(
            reconciliations
                .filter((row) => row.status !== "ignored")
                .map((row) => `${row.entityType}:${row.entityId}`)
        );

        const unreconciledBorrowerPayments = borrowerTransactions.filter((row) => !matchedKeys.has(`borrower_transaction:${row.id}`)).length;
        const borrowerPaymentsMissingSlip = borrowerTransactions.filter((row) => !row.slipUrl).length;
        const recordedFundRepayments = bankLoanRepaymentsRows.length;
        const fundRepaymentsMissingScheduleLink = bankLoanRepaymentsRows.filter((row) => !matchedKeys.has(`bank_loan_repayment:${row.id}`)).length;

                return {
            unreconciledBorrowerPayments,
            recordedFundRepayments,
            fundRepaymentsMissingScheduleLink,
            pendingBankImports: rawBankTransactions.length,
            pendingManualReviews: pendingUploads.length,
            borrowerPaymentsMissingSlip,
                };
            },
        });
    })
    .get("/profitability-summary", async ({ user, set }) => {
        if (!isTenantAdminUser(user)) {
            set.status = user ? 403 : 401;
            return { error: user ? "Forbidden" : "Unauthorized" };
        }

        return await withTenantCache({
            tenantId: user.tenantId,
            namespace: "dashboard",
            key: "profitability-summary",
            ttlSeconds: 30,
            loader: async () => serializeDashboardProfitability(await getTenantProfitabilitySummary(user.tenantId)),
        });
    })
    .get("/analytics", async ({ user, set }) => {
        if (!isTenantAdminUser(user)) {
            set.status = user ? 403 : 401;
            return { error: user ? "Forbidden" : "Unauthorized" };
        }

        return await withTenantCache({
            tenantId: user.tenantId,
            namespace: "dashboard",
            key: "analytics",
            ttlSeconds: 30,
            loader: async () => {
                const today = todayString();
                const start = new Date(`${today}T00:00:00.000Z`);
                start.setUTCDate(start.getUTCDate() - 29);
                const startDate = start.toISOString().slice(0, 10);
                const [schedules, repayments, allLoans, allocations] = await Promise.all([
                    db.select({ dueDate: loanSchedules.dueDate, scheduledTotal: loanSchedules.scheduledTotal, scheduledInterest: loanSchedules.scheduledInterest })
                        .from(loanSchedules)
                        .where(eq(loanSchedules.tenantId, user.tenantId)),
                    db.select({ transactionDate: transactions.transactionDate, postedAt: transactions.postedAt, amount: transactions.amount, interestComponent: transactions.interestComponent })
                        .from(transactions)
                        .where(eq(transactions.tenantId, user.tenantId)),
                    db.select({ status: loans.status, outstandingPrincipal: loans.outstandingPrincipal })
                        .from(loans)
                        .where(eq(loans.tenantId, user.tenantId)),
                    db.select({ allocatedAmount: loanFundingAllocations.allocatedAmount })
                        .from(loanFundingAllocations)
                        .where(eq(loanFundingAllocations.tenantId, user.tenantId)),
                ]);

                const zero = () => new Decimal(0);
                const add = (left: string | null | undefined, right: string | null | undefined) => new Decimal(left ?? 0).plus(right ?? 0).toFixed(2);
                const daily = new Map<string, { expected: string; actual: string; interest: string }>();
                const monthly = new Map<string, { expectedInterest: string; actualInterest: string }>();
                const ensureDaily = (date: string) => {
                    const current = daily.get(date) ?? { expected: "0.00", actual: "0.00", interest: "0.00" };
                    daily.set(date, current);
                    return current;
                };
                const ensureMonthly = (month: string) => {
                    const current = monthly.get(month) ?? { expectedInterest: "0.00", actualInterest: "0.00" };
                    monthly.set(month, current);
                    return current;
                };

                for (const row of schedules) {
                    if (row.dueDate < startDate || row.dueDate > today) continue;
                    const item = ensureDaily(row.dueDate);
                    item.expected = add(item.expected, row.scheduledTotal);
                    const month = row.dueDate.slice(0, 7);
                    const monthlyItem = ensureMonthly(month);
                    monthlyItem.expectedInterest = add(monthlyItem.expectedInterest, row.scheduledInterest);
                }
                for (const row of repayments) {
                    const date = (row.transactionDate ?? row.postedAt).toISOString().slice(0, 10);
                    if (date < startDate || date > today) continue;
                    const item = ensureDaily(date);
                    item.actual = add(item.actual, row.amount);
                    item.interest = add(item.interest, row.interestComponent);
                    const monthlyItem = ensureMonthly(date.slice(0, 7));
                    monthlyItem.actualInterest = add(monthlyItem.actualInterest, row.interestComponent);
                }
                const dailySeries = Array.from({ length: 30 }, (_, index) => {
                    const date = new Date(start);
                    date.setUTCDate(date.getUTCDate() + index);
                    const key = date.toISOString().slice(0, 10);
                    return { date: key, ...(daily.get(key) ?? { expected: "0.00", actual: "0.00", interest: "0.00" }) };
                });
                const deployedPrincipal = allocations.reduce((sum, row) => sum.plus(row.allocatedAmount), zero()).toFixed(2);
                const outstandingPrincipal = allLoans.filter((loan) => loan.status === "active").reduce((sum, loan) => sum.plus(loan.outstandingPrincipal ?? 0), zero()).toFixed(2);
                const todayItem = daily.get(today) ?? { expected: "0.00", actual: "0.00", interest: "0.00" };

                return {
                    collectionRate: { expected: todayItem.expected, actual: todayItem.actual },
                    daily: dailySeries,
                    monthly: Array.from(monthly.entries()).sort(([left], [right]) => left.localeCompare(right)).map(([month, values]) => ({ month, ...values })),
                    deployedPrincipal,
                    outstandingPrincipal,
                };
            },
        });
    });
