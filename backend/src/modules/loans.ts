import { Elysia, t } from "elysia";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db";
import {
    bankLoans,
    bankProfiles,
    borrowers,
    loanFundingAllocations,
    loanSchedules,
    loans,
    transactions,
} from "../db/schema";
import { authPlugin } from "../middleware/auth";
import { calculateLoanClosingSummary, calculateLoanSchedule, type RepaymentType } from "../lib/calculator";
import { generateLoanSchedule } from "../lib/loan-schedule";
import { createAuditLog } from "../lib/audit-log";
import { getLoanProfitabilitySummary } from "../lib/fund-settlement";
import { computeOverdueSnapshot } from "../lib/overdue";
import { invalidateTenantCache, withTenantCache } from "../lib/cache";

export const loansRoute = new Elysia({ prefix: "/loans" })
    .use(authPlugin)
    .get("/", async ({ user, query }) => {
        if (!user) return [];

        const conditions = [eq(loans.tenantId, user.tenantId)];
        if (query.borrowerId) {
            conditions.push(eq(loans.borrowerId, Number(query.borrowerId)));
        }

        return await withTenantCache({
            tenantId: user.tenantId,
            namespace: "loans",
            key: `list:borrower=${query.borrowerId ?? "all"}`,
            ttlSeconds: 30,
            loader: async () => await db.select({
                id: loans.id,
                borrowerId: loans.borrowerId,
                bankLoanId: loans.bankLoanId,
                borrowerName: borrowers.name,
                principal: loans.principalAmount,
                status: loans.status,
                createdAt: loans.createdAt,
                repaymentType: loans.repaymentType,
                interestRate: loans.interestRate,
                installmentAmount: loans.installmentAmount,
                totalInstallments: loans.totalInstallments,
            })
                .from(loans)
                .leftJoin(borrowers, eq(loans.borrowerId, borrowers.id))
                .where(and(...conditions))
                .orderBy(desc(loans.createdAt)),
        });
    }, {
        query: t.Object({
            borrowerId: t.Optional(t.String()),
        })
    })
    .get("/:id", async ({ params, user, set }) => {
        if (!user) {
            set.status = 401;
            return { error: "Unauthorized" };
        }

        const loan = await withTenantCache({
            tenantId: user.tenantId,
            namespace: "loans",
            key: `detail:${params.id}`,
            ttlSeconds: 30,
            loader: async () => await db.query.loans.findFirst({
                where: and(eq(loans.id, params.id), eq(loans.tenantId, user.tenantId)),
            }),
        });

        if (!loan) {
            set.status = 404;
            return { error: "Loan not found" };
        }

        return loan;
    }, {
        params: t.Object({
            id: t.Numeric(),
        })
    })
    .get("/:id/schedule", async ({ params, user, set }) => {
        if (!user) {
            set.status = 401;
            return { error: "Unauthorized" };
        }

        const loan = await db.query.loans.findFirst({
            where: and(eq(loans.id, params.id), eq(loans.tenantId, user.tenantId)),
        });

        if (!loan) {
            set.status = 404;
            return { error: "Loan not found" };
        }

        return await withTenantCache({
            tenantId: user.tenantId,
            namespace: "loans",
            key: `schedule:${loan.id}`,
            ttlSeconds: 20,
            loader: async () => {
                const scheduleRows = await db.select().from(loanSchedules).where(
                    and(
                        eq(loanSchedules.loanId, loan.id),
                        eq(loanSchedules.tenantId, user.tenantId)
                    )
                ).orderBy(loanSchedules.installmentNo);

                return scheduleRows.map((row) => {
                    const overdue = computeOverdueSnapshot({
                        dueDate: row.dueDate,
                        remainingDue: row.remainingDue,
                        paidPenalty: row.paidPenalty,
                        gracePeriodDays: loan.gracePeriodDays,
                        lateFeeMode: loan.lateFeeMode,
                        lateFeeAmount: loan.lateFeeAmount,
                        baseStatus: row.status,
                    });

                    return {
                        ...row,
                        overdueDays: overdue.overdueDays,
                        penaltyDue: overdue.penaltyDue.toFixed(2),
                        totalDueNow: overdue.totalDueNow.toFixed(2),
                        status: overdue.effectiveStatus,
                    };
                });
            },
        });
    }, {
        params: t.Object({
            id: t.Numeric(),
        })
    })
    .get("/:id/funding-allocations", async ({ params, user, set }) => {
        if (!user) {
            set.status = 401;
            return { error: "Unauthorized" };
        }

        const loan = await db.query.loans.findFirst({
            where: and(eq(loans.id, params.id), eq(loans.tenantId, user.tenantId)),
        });

        if (!loan) {
            set.status = 404;
            return { error: "Loan not found" };
        }

        return await withTenantCache({
            tenantId: user.tenantId,
            namespace: "loans",
            key: `funding-allocations:${loan.id}`,
            ttlSeconds: 20,
            loader: async () => await db.select({
                id: loanFundingAllocations.id,
                bankLoanId: loanFundingAllocations.bankLoanId,
                bankProfileId: loanFundingAllocations.bankProfileId,
                allocatedAmount: loanFundingAllocations.allocatedAmount,
                allocationDate: loanFundingAllocations.allocationDate,
                allocationType: loanFundingAllocations.allocationType,
                note: loanFundingAllocations.note,
                bankProfileName: bankProfiles.name,
            })
                .from(loanFundingAllocations)
                .leftJoin(bankProfiles, eq(loanFundingAllocations.bankProfileId, bankProfiles.id))
                .where(
                    and(
                        eq(loanFundingAllocations.loanId, loan.id),
                        eq(loanFundingAllocations.tenantId, user.tenantId)
                    )
                )
                .orderBy(desc(loanFundingAllocations.createdAt)),
        });
    }, {
        params: t.Object({
            id: t.Numeric(),
        })
    })
    .get("/:id/profitability", async ({ params, user, set }) => {
        if (!user) {
            set.status = 401;
            return { error: "Unauthorized" };
        }

        const summary = await withTenantCache({
            tenantId: user.tenantId,
            namespace: "loans",
            key: `profitability:${params.id}`,
            ttlSeconds: 20,
            loader: async () => await getLoanProfitabilitySummary(user.tenantId, params.id),
        });
        if (!summary) {
            set.status = 404;
            return { error: "Loan not found" };
        }

        return summary;
    }, {
        params: t.Object({
            id: t.Numeric(),
        })
    })
    .get("/:id/allocation-state", async ({ params, user, set }) => {
        if (!user) {
            set.status = 401;
            return { error: "Unauthorized" };
        }

        const loan = await db.query.loans.findFirst({
            where: and(eq(loans.id, params.id), eq(loans.tenantId, user.tenantId)),
        });

        if (!loan) {
            set.status = 404;
            return { error: "Loan not found" };
        }

        return await withTenantCache({
            tenantId: user.tenantId,
            namespace: "loans",
            key: `allocation-state:${loan.id}`,
            ttlSeconds: 20,
            loader: async () => {
                const netAllocated = await db.select({
                    totalAllocated: sql<string>`coalesce(sum(${loanFundingAllocations.allocatedAmount}), 0)`,
                }).from(loanFundingAllocations).where(
                    and(
                        eq(loanFundingAllocations.tenantId, user.tenantId),
                        eq(loanFundingAllocations.loanId, loan.id),
                    )
                ).then((rows) => Number(rows[0]?.totalAllocated ?? 0));

                const principalAmount = Number(loan.principalAmount ?? 0);
                const remainingGap = Math.max(0, principalAmount - netAllocated);
                const overfundedAmount = Math.max(0, netAllocated - principalAmount);
                const state =
                    netAllocated <= 0 ? "unfunded" :
                    overfundedAmount > 0 ? "overfunded" :
                    remainingGap <= 0.0001 ? "fully_funded" :
                    "partially_funded";

                return {
                    loanId: loan.id,
                    principalAmount: Number(principalAmount.toFixed(2)),
                    netAllocatedPrincipal: Number(netAllocated.toFixed(2)),
                    remainingGap: Number(remainingGap.toFixed(2)),
                    overfundedAmount: Number(overfundedAmount.toFixed(2)),
                    state,
                };
            },
        });
    }, {
        params: t.Object({
            id: t.Numeric(),
        })
    })
    .get("/:id/closing-summary", async ({ params, user, set }) => {
        if (!user) {
            set.status = 401;
            return { error: "Unauthorized" };
        }

        const loan = await db.query.loans.findFirst({
            where: and(eq(loans.id, params.id), eq(loans.tenantId, user.tenantId))
        });

        if (!loan) {
            set.status = 404;
            return { error: "Loan not found" };
        }

        const loanTransactions = await db.select()
            .from(transactions)
            .where(and(eq(transactions.loanId, params.id), eq(transactions.tenantId, user.tenantId)));

        return calculateLoanClosingSummary(loan, loanTransactions);
    }, {
        params: t.Object({
            id: t.Numeric()
        })
    })
    .post("/:id/close", async ({ params, body, user, set }) => {
        if (!user) {
            set.status = 401;
            return { error: "Unauthorized" };
        }

        return await db.transaction(async (tx) => {
            const loan = await tx.query.loans.findFirst({
                where: and(eq(loans.id, params.id), eq(loans.tenantId, user.tenantId)),
            });

            if (!loan) {
                set.status = 404;
                return { error: "Loan not found" };
            }

            if (loan.status === "closed") {
                set.status = 400;
                return { error: "Loan is already closed" };
            }

            const updated = await tx.update(loans)
                .set({
                    status: "closed",
                    closedAt: new Date(),
                    updatedAt: new Date(),
                })
                .where(eq(loans.id, params.id))
                .returning()
                .then((rows) => rows[0]);

            await createAuditLog(tx, {
                tenantId: user.tenantId,
                actorUserId: user.id,
                entityType: "loan",
                entityId: params.id,
                action: "closed",
                payload: {
                    before: loan,
                    after: updated,
                    note: body.note,
                },
            });

            await invalidateTenantCache(user.tenantId);
            return updated;
        });
    }, {
        params: t.Object({
            id: t.Numeric(),
        }),
        body: t.Object({
            note: t.Optional(t.String()),
        })
    })
    .post("/calculate", ({ body }) => {
        return calculateLoanSchedule({
            principal: body.principal,
            interestRate: body.interestRate,
            termMonths: body.termMonths,
            repaymentType: body.repaymentType as RepaymentType,
            startDate: new Date(body.startDate)
        });
    }, {
        body: t.Object({
            principal: t.Number(),
            interestRate: t.Number(),
            termMonths: t.Number(),
            repaymentType: t.String(),
            startDate: t.String()
        })
    })
    .post("/", async ({ body, user, set }) => {
        if (!user) throw new Error("Unauthorized");

        const generatedSchedule = body.repaymentType === "floating"
            ? []
            : generateLoanSchedule({
                principal: body.principal,
                interestRate: body.interestRate,
                termMonths: body.termMonths,
                repaymentType: body.repaymentType as RepaymentType,
                startDate: body.startDate,
            });

        const created = await db.transaction(async (tx) => {
            const created = await tx.insert(loans).values({
                tenantId: user.tenantId,
                borrowerId: body.borrowerId,
                bankLoanId: body.bankLoanId,
                principalAmount: body.principal.toFixed(2),
                interestRate: body.interestRate.toFixed(2),
                repaymentType: body.repaymentType,
                totalInstallments: body.totalInstallments,
                installmentAmount: body.installmentAmount?.toFixed(2),
                startDate: body.startDate,
                status: "active"
            }).returning().then((rows) => rows[0]);

            if (generatedSchedule.length > 0) {
                await tx.insert(loanSchedules).values(
                    generatedSchedule.map((row) => ({
                        tenantId: user.tenantId,
                        loanId: created.id,
                        installmentNo: row.installmentNo,
                        dueDate: row.dueDate,
                        scheduledPrincipal: row.scheduledPrincipal,
                        scheduledInterest: row.scheduledInterest,
                        scheduledFee: row.scheduledFee,
                        scheduledTotal: row.scheduledTotal,
                        paidTotal: row.paidTotal,
                        remainingDue: row.remainingDue,
                        status: "pending",
                    }))
                );
            }

            if (body.bankLoanId) {
                const sourceDrawdown = await tx.select().from(bankLoans).where(
                    and(
                        eq(bankLoans.id, body.bankLoanId),
                        eq(bankLoans.tenantId, user.tenantId)
                    )
                ).then((rows) => rows[0]);

                if (!sourceDrawdown) {
                    set.status = 404;
                    return { error: "Funding source drawdown not found" };
                }

                await tx.insert(loanFundingAllocations).values({
                    tenantId: user.tenantId,
                    bankProfileId: sourceDrawdown.bankProfileId,
                    bankLoanId: sourceDrawdown.id,
                    loanId: created.id,
                    allocatedAmount: body.principal.toFixed(2),
                    allocationDate: body.startDate,
                    allocationType: "initial",
                    note: "Auto-created from legacy bankLoanId field",
                    createdByUserId: user.id,
                });
            }

            await createAuditLog(tx, {
                tenantId: user.tenantId,
                actorUserId: user.id,
                entityType: "loan",
                entityId: created.id,
                action: "created",
                payload: {
                    loan: created,
                    scheduleCount: generatedSchedule.length,
                },
            });

            return created;
        });
        await invalidateTenantCache(user.tenantId);
        return created;
    }, {
        body: t.Object({
            borrowerId: t.Number(),
            bankLoanId: t.Optional(t.Number()),
            principal: t.Number(),
            interestRate: t.Number(),
            repaymentType: t.String(),
            termMonths: t.Number(),
            totalInstallments: t.Number(),
            installmentAmount: t.Optional(t.Number()),
            startDate: t.String()
        })
    })
    .post("/:id/funding-allocations", async ({ params, body, user, set }) => {
        if (!user) throw new Error("Unauthorized");

        const created = await db.transaction(async (tx) => {
            const loan = await tx.select().from(loans).where(
                and(
                    eq(loans.id, params.id),
                    eq(loans.tenantId, user.tenantId)
                )
            ).then((rows) => rows[0]);

            if (!loan) {
                set.status = 404;
                return { error: "Loan not found" };
            }

            let sourceBankProfileId = body.bankProfileId ?? null;
            if (body.bankLoanId) {
                // Use a row lock to prevent concurrent allocations from exceeding capacity
                const sourceDrawdown = await tx.execute(
                    sql`SELECT * FROM bank_loans WHERE id = ${body.bankLoanId} AND tenant_id = ${user.tenantId} FOR UPDATE`
                ).then((res) => res[0] as typeof bankLoans.$inferSelect | undefined);

                if (!sourceDrawdown) {
                    set.status = 404;
                    return { error: "Bank loan not found or access denied" };
                }

                const sourceAllocation = await tx.select({
                    totalAllocated: sql<string>`coalesce(sum(${loanFundingAllocations.allocatedAmount}), 0)`,
                }).from(loanFundingAllocations).where(
                    and(
                        eq(loanFundingAllocations.bankLoanId, body.bankLoanId),
                        eq(loanFundingAllocations.tenantId, user.tenantId)
                    )
                ).then((rows) => Number(rows[0]?.totalAllocated ?? 0));

                const sourceRemaining = Number(sourceDrawdown.amount) - sourceAllocation;
                if (body.allocatedAmount > sourceRemaining + 0.0001) {
                    set.status = 400;
                    return {
                        error: "Allocation exceeds remaining drawdown balance",
                        sourceRemaining: Number(sourceRemaining.toFixed(2)),
                    };
                }

                sourceBankProfileId = sourceDrawdown.bankProfileId;
            }

            if (!sourceBankProfileId && !body.bankLoanId) {
                set.status = 400;
                return { error: "Either bankProfileId or bankLoanId is required" };
            }

            const currentAllocation = await tx.select({
                totalAllocated: sql<string>`coalesce(sum(${loanFundingAllocations.allocatedAmount}), 0)`,
            }).from(loanFundingAllocations).where(
                and(
                    eq(loanFundingAllocations.loanId, loan.id),
                    eq(loanFundingAllocations.tenantId, user.tenantId)
                )
            ).then((rows) => Number(rows[0]?.totalAllocated ?? 0));

            const remainingLoanCapacity = Number(loan.principalAmount) - currentAllocation;
            if (body.allocatedAmount > remainingLoanCapacity + 0.0001) {
                set.status = 400;
                return {
                    error: "Allocation exceeds remaining unfunded principal",
                    remainingCapacity: Number(remainingLoanCapacity.toFixed(2)),
                };
            }

            const created = await tx.insert(loanFundingAllocations).values({
                tenantId: user.tenantId,
                bankProfileId: sourceBankProfileId,
                bankLoanId: body.bankLoanId,
                loanId: loan.id,
                allocatedAmount: body.allocatedAmount.toFixed(2),
                allocationDate: body.allocationDate,
                allocationType: body.allocationType ?? "initial",
                note: body.note,
                createdByUserId: user.id,
            }).returning().then((rows) => rows[0]);

            await createAuditLog(tx, {
                tenantId: user.tenantId,
                actorUserId: user.id,
                entityType: "loan_funding_allocation",
                entityId: created.id,
                action: "created",
                payload: created,
            });

            return created;
        });
        await invalidateTenantCache(user.tenantId);
        return created;
    }, {
        params: t.Object({
            id: t.Numeric(),
        }),
        body: t.Object({
            bankProfileId: t.Optional(t.Number()),
            bankLoanId: t.Optional(t.Number()),
            allocatedAmount: t.Number(),
            allocationDate: t.String(),
            allocationType: t.Optional(t.Union([
                t.Literal("initial"),
                t.Literal("manual_adjustment"),
                t.Literal("reallocation_in"),
                t.Literal("reallocation_out"),
            ])),
            note: t.Optional(t.String()),
        })
    })
    .post("/:id/funding-reallocations", async ({ params, body, user, set }) => {
        if (!user) throw new Error("Unauthorized");

        const createdRows = await db.transaction(async (tx) => {
            const loan = await tx.select().from(loans).where(
                and(
                    eq(loans.id, params.id),
                    eq(loans.tenantId, user.tenantId)
                )
            ).then((rows) => rows[0]);

            if (!loan) {
                set.status = 404;
                return { error: "Loan not found" };
            }

            const sourceDrawdown = await tx.select().from(bankLoans).where(
                and(
                    eq(bankLoans.id, body.fromBankLoanId),
                    eq(bankLoans.tenantId, user.tenantId)
                )
            ).then((rows) => rows[0]);
            const targetDrawdown = await tx.select().from(bankLoans).where(
                and(
                    eq(bankLoans.id, body.toBankLoanId),
                    eq(bankLoans.tenantId, user.tenantId)
                )
            ).then((rows) => rows[0]);

            if (!sourceDrawdown || !targetDrawdown) {
                set.status = 404;
                return { error: "Source or target drawdown not found" };
            }

            if (body.fromBankLoanId === body.toBankLoanId) {
                set.status = 400;
                return { error: "Source and target drawdowns must be different" };
            }

            const currentSourceAllocation = await tx.select({
                totalAllocated: sql<string>`coalesce(sum(${loanFundingAllocations.allocatedAmount}), 0)`,
            }).from(loanFundingAllocations).where(
                and(
                    eq(loanFundingAllocations.loanId, loan.id),
                    eq(loanFundingAllocations.bankLoanId, body.fromBankLoanId),
                    eq(loanFundingAllocations.tenantId, user.tenantId)
                )
            ).then((rows) => Number(rows[0]?.totalAllocated ?? 0));

            if (body.amount > currentSourceAllocation + 0.0001) {
                set.status = 400;
                return {
                    error: "Reallocation exceeds current allocation on the source drawdown",
                    sourceAllocated: Number(currentSourceAllocation.toFixed(2)),
                };
            }

            const targetAllocation = await tx.select({
                totalAllocated: sql<string>`coalesce(sum(${loanFundingAllocations.allocatedAmount}), 0)`,
            }).from(loanFundingAllocations).where(
                and(
                    eq(loanFundingAllocations.bankLoanId, body.toBankLoanId),
                    eq(loanFundingAllocations.tenantId, user.tenantId)
                )
            ).then((rows) => Number(rows[0]?.totalAllocated ?? 0));

            const targetRemaining = Number(targetDrawdown.amount) - targetAllocation;
            if (body.amount > targetRemaining + 0.0001) {
                set.status = 400;
                return {
                    error: "Reallocation exceeds remaining target drawdown balance",
                    targetRemaining: Number(targetRemaining.toFixed(2)),
                };
            }

            const createdRows = await tx.insert(loanFundingAllocations).values([
                {
                    tenantId: user.tenantId,
                    bankProfileId: sourceDrawdown.bankProfileId,
                    bankLoanId: sourceDrawdown.id,
                    loanId: loan.id,
                    allocatedAmount: (-body.amount).toFixed(2),
                    allocationDate: body.allocationDate,
                    allocationType: "reallocation_out",
                    note: body.note ?? `Reallocated out to drawdown #${targetDrawdown.id}`,
                    createdByUserId: user.id,
                },
                {
                    tenantId: user.tenantId,
                    bankProfileId: targetDrawdown.bankProfileId,
                    bankLoanId: targetDrawdown.id,
                    loanId: loan.id,
                    allocatedAmount: body.amount.toFixed(2),
                    allocationDate: body.allocationDate,
                    allocationType: "reallocation_in",
                    note: body.note ?? `Reallocated in from drawdown #${sourceDrawdown.id}`,
                    createdByUserId: user.id,
                },
            ]).returning();

            await createAuditLog(tx, {
                tenantId: user.tenantId,
                actorUserId: user.id,
                entityType: "loan_funding_reallocation",
                entityId: `${createdRows[0].id}:${createdRows[1].id}`,
                action: "created",
                payload: {
                    loanId: loan.id,
                    fromBankLoanId: sourceDrawdown.id,
                    toBankLoanId: targetDrawdown.id,
                    amount: body.amount.toFixed(2),
                    allocationDate: body.allocationDate,
                    note: body.note,
                },
            });

            return createdRows;
        });
        await invalidateTenantCache(user.tenantId);
        return createdRows;
    }, {
        params: t.Object({
            id: t.Numeric(),
        }),
        body: t.Object({
            fromBankLoanId: t.Number(),
            toBankLoanId: t.Number(),
            amount: t.Number(),
            allocationDate: t.String(),
            note: t.Optional(t.String()),
        })
    });
