import { Elysia } from "elysia";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { bankLoanRepayments, bankLoanSchedules, bankLoans, bankTransactions, borrowers, botUploads, loanFundingAllocations, loanSchedules, loans, reconciliationEntries, transactions } from "../db/schema";
import { authPlugin } from "../middleware/auth";
import { isTenantAdminUser } from "../lib/access";
import { getTenantProfitabilitySummary } from "../lib/fund-settlement";
import { computeOverdueSnapshot } from "../lib/overdue";
import { withTenantCache } from "../lib/cache";
import { aggregateDashboardMoney, compareDashboardMoneyDescending, isPositiveDashboardMoney, positiveDashboardDifference, subtractDashboardMoney, sumDashboardMoney } from "../lib/dashboard-money";

function todayString() {
    return new Date().toISOString().slice(0, 10);
}

export const dashboardRoute = new Elysia({ prefix: "/dashboard" })
    .use(authPlugin)
    .get("/summary", async ({ user, set }) => {
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

                const [borrowerScheduleRows, fundScheduleRows, allLoans, allDrawdowns, allocations] = await Promise.all([
            db.select().from(loanSchedules).where(eq(loanSchedules.tenantId, user.tenantId)),
            db.select().from(bankLoanSchedules).where(eq(bankLoanSchedules.tenantId, user.tenantId)),
            db.select().from(loans).where(eq(loans.tenantId, user.tenantId)),
            db.select().from(bankLoans).where(eq(bankLoans.tenantId, user.tenantId)),
            db.select().from(loanFundingAllocations).where(eq(loanFundingAllocations.tenantId, user.tenantId)),
        ]);

        const loanMap = new Map(allLoans.map((loan) => [loan.id, loan]));
        const drawdownMap = new Map(allDrawdowns.map((drawdown) => [drawdown.id, drawdown]));

        const borrowerDueSnapshots = borrowerScheduleRows.map((row) => {
            const loan = loanMap.get(row.loanId);
            const overdue = computeOverdueSnapshot({
                dueDate: row.dueDate,
                remainingDue: row.remainingDue,
                paidPenalty: row.paidPenalty,
                gracePeriodDays: loan?.gracePeriodDays,
                lateFeeMode: loan?.lateFeeMode,
                lateFeeAmount: loan?.lateFeeAmount,
                baseStatus: row.status,
                asOf: today,
            });
            return { ...row, ...overdue };
        });
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

        const dueFromBorrowersToday = sumDashboardMoney(borrowerDueSnapshots
            .filter((row) => row.dueDate <= today && isPositiveDashboardMoney(row.totalDueNow))
            .map((row) => row.totalDueNow));
        const dueToFundsToday = sumDashboardMoney(fundDueSnapshots
            .filter((row) => row.dueDate <= today && isPositiveDashboardMoney(row.totalDueNow))
            .map((row) => row.totalDueNow));
        const overdueBorrowerCount = borrowerDueSnapshots.filter((row) => row.effectiveStatus === "overdue").length;
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
    .get("/borrower-due-queue", async ({ user, set }) => {
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
                const rows = await db.select({
            scheduleId: loanSchedules.id,
            dueDate: loanSchedules.dueDate,
            remainingDue: loanSchedules.remainingDue,
            paidPenalty: loanSchedules.paidPenalty,
            status: loanSchedules.status,
            installmentNo: loanSchedules.installmentNo,
            loanId: loans.id,
            borrowerName: borrowers.name,
            repaymentType: loans.repaymentType,
            gracePeriodDays: loans.gracePeriodDays,
            lateFeeMode: loans.lateFeeMode,
            lateFeeAmount: loans.lateFeeAmount,
        })
            .from(loanSchedules)
            .leftJoin(loans, eq(loanSchedules.loanId, loans.id))
            .leftJoin(borrowers, eq(loans.borrowerId, borrowers.id))
            .where(and(eq(loanSchedules.tenantId, user.tenantId), eq(loans.tenantId, user.tenantId)));

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
            loader: async () => await getTenantProfitabilitySummary(user.tenantId),
        });
    });
