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
import { calculateLoanClosingSummary } from "../lib/calculator";
import { createAuditLog } from "../lib/audit-log";
import { canAccessTenantWideData, getAccessScopeCacheKey, loanAccessFilters } from "../lib/access";
import { getLoanProfitabilitySummary } from "../lib/fund-settlement";
import { computeOverdueSnapshot } from "../lib/overdue";
import { invalidateTenantCache, withTenantCache } from "../lib/cache";
import { findAccessibleBorrowerByPublicId, findAccessibleLoanByPublicId } from "../lib/public-id";
import { activateLoan, createLoanDraft, getLoanApplication, previewLoan, updateLoanDraft } from "../services/loan-application-service";
import type { CommandContext } from "../services/command-context";
import { presentDomainError } from "../services/domain-error";

type RouteUser = { id: number; tenantId: string };

function commandContext(user: RouteUser, request: Request): CommandContext {
    const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
    return {
        tenantId: user.tenantId,
        actorUserId: user.id,
        actorSource: "web",
        requestId,
        correlationId: request.headers.get("x-correlation-id") ?? requestId,
        idempotencyKey: request.headers.get("idempotency-key") ?? undefined,
    };
}

function domainFailure(error: unknown, set: { status?: number | string }) {
    const presented = presentDomainError(error);
    set.status = presented.status;
    return presented.body;
}

const repaymentType = t.Union([
    t.Literal("daily"), t.Literal("weekly"), t.Literal("monthly"), t.Literal("floating"),
]);

export const loansRoute = new Elysia({ prefix: "/loans" })
    .use(authPlugin)
    .get("/", async ({ user, query }) => {
        if (!user) return [];

        const conditions = loanAccessFilters(user);
        if (query.borrowerId) {
            const borrower = await findAccessibleBorrowerByPublicId(user, query.borrowerId);
            if (!borrower) {
                return [];
            }
            conditions.push(eq(loans.borrowerId, borrower.id));
        }
        const scopeKey = getAccessScopeCacheKey(user);

        return await withTenantCache({
            tenantId: user.tenantId,
            namespace: "loans",
            key: `list:${scopeKey}:borrower=${query.borrowerId ?? "all"}`,
            ttlSeconds: 30,
            loader: async () => await db.select({
                id: loans.publicId,
                publicId: loans.publicId,
                borrowerId: borrowers.publicId,
                borrowerPublicId: borrowers.publicId,
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
    .get("/:id", async ({ params, user, request, set }) => {
        if (!user) {
            set.status = 401;
            return { error: "Unauthorized" };
        }
        const scopeKey = getAccessScopeCacheKey(user);
        try {
            return await withTenantCache({
                tenantId: user.tenantId,
                namespace: "loans",
                key: `detail:${params.id}:${scopeKey}`,
                ttlSeconds: 30,
                loader: async () => getLoanApplication(commandContext(user, request), params.id),
            });
        } catch (error) {
            return domainFailure(error, set);
        }
    }, {
        params: t.Object({
            id: t.String(),
        })
    })
    .get("/:id/schedule", async ({ params, user, set }) => {
        if (!user) {
            set.status = 401;
            return { error: "Unauthorized" };
        }

        const loan = await findAccessibleLoanByPublicId(user, params.id);

        if (!loan) {
            set.status = 404;
            return { error: "Loan not found" };
        }

        const scopeKey = getAccessScopeCacheKey(user);
        return await withTenantCache({
            tenantId: user.tenantId,
            namespace: "loans",
            key: `schedule:${loan.id}:${scopeKey}`,
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
                        publicId: row.publicId,
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
            id: t.String(),
        })
    })
    .get("/:id/funding-allocations", async ({ params, user, set }) => {
        if (!user) {
            set.status = 401;
            return { error: "Unauthorized" };
        }

        const loan = await findAccessibleLoanByPublicId(user, params.id);

        if (!loan) {
            set.status = 404;
            return { error: "Loan not found" };
        }

        const scopeKey = getAccessScopeCacheKey(user);
        return await withTenantCache({
            tenantId: user.tenantId,
            namespace: "loans",
            key: `funding-allocations:${loan.id}:${scopeKey}`,
            ttlSeconds: 20,
            loader: async () => await db.select({
                id: loanFundingAllocations.id,
                bankLoanId: loanFundingAllocations.bankLoanId,
                bankProfileId: loanFundingAllocations.bankProfileId,
                loanPublicId: loans.publicId,
                bankProfilePublicId: bankProfiles.publicId,
                bankLoanPublicId: bankLoans.publicId,
                allocatedAmount: loanFundingAllocations.allocatedAmount,
                allocationDate: loanFundingAllocations.allocationDate,
                allocationType: loanFundingAllocations.allocationType,
                note: loanFundingAllocations.note,
                bankProfileName: bankProfiles.name,
            })
                .from(loanFundingAllocations)
                .leftJoin(bankProfiles, eq(loanFundingAllocations.bankProfileId, bankProfiles.id))
                .leftJoin(bankLoans, eq(loanFundingAllocations.bankLoanId, bankLoans.id))
                .leftJoin(loans, eq(loanFundingAllocations.loanId, loans.id))
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
            id: t.String(),
        })
    })
    .get("/:id/profitability", async ({ params, user, set }) => {
        if (!user) {
            set.status = 401;
            return { error: "Unauthorized" };
        }

        if (!canAccessTenantWideData(user)) {
            set.status = 403;
            return { error: "Forbidden" };
        }
        const summary = await withTenantCache({
            tenantId: user.tenantId,
            namespace: "loans",
            key: `profitability:${params.id}`,
            ttlSeconds: 20,
            loader: async () => {
                const loan = await findAccessibleLoanByPublicId(user, params.id);
                return loan ? await getLoanProfitabilitySummary(user.tenantId, loan.id) : null;
            },
        });
        if (!summary) {
            set.status = 404;
            return { error: "Loan not found" };
        }

        return summary;
    }, {
        params: t.Object({
            id: t.String(),
        })
    })
    .get("/:id/allocation-state", async ({ params, user, set }) => {
        if (!user) {
            set.status = 401;
            return { error: "Unauthorized" };
        }

        const loan = await findAccessibleLoanByPublicId(user, params.id);

        if (!loan) {
            set.status = 404;
            return { error: "Loan not found" };
        }

        const scopeKey = getAccessScopeCacheKey(user);
        return await withTenantCache({
            tenantId: user.tenantId,
            namespace: "loans",
            key: `allocation-state:${loan.id}:${scopeKey}`,
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
                    loanPublicId: loan.publicId,
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
            id: t.String(),
        })
    })
    .get("/:id/closing-summary", async ({ params, user, set }) => {
        if (!user) {
            set.status = 401;
            return { error: "Unauthorized" };
        }

        const loan = await findAccessibleLoanByPublicId(user, params.id);

        if (!loan) {
            set.status = 404;
            return { error: "Loan not found" };
        }

        const loanTransactions = await db.select()
            .from(transactions)
            .where(and(eq(transactions.loanId, loan.id), eq(transactions.tenantId, user.tenantId)));

        return calculateLoanClosingSummary({ ...loan, startDate: loan.startDate ?? new Date() }, loanTransactions);
    }, {
        params: t.Object({
            id: t.String()
        })
    })
    .post("/:id/close", async ({ params, body, user, set }) => {
        if (!user) {
            set.status = 401;
            return { error: "Unauthorized" };
        }

            return await db.transaction(async (tx) => {
            const resolved = await findAccessibleLoanByPublicId(user, params.id);
            const loan = resolved ? await tx.query.loans.findFirst({
                where: and(eq(loans.id, resolved.id), ...loanAccessFilters(user)),
            }) : null;

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
                    updatedAt: new Date(),
                })
                .where(eq(loans.id, loan.id))
                .returning()
                .then((rows) => rows[0]);

            await createAuditLog(tx, {
                tenantId: user.tenantId,
                actorUserId: user.id,
                entityType: "loan",
                entityId: loan.id,
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
            id: t.String(),
        }),
        body: t.Object({
            note: t.Optional(t.String()),
        })
    })
    .post("/calculate", ({ body, set }) => {
        try {
            return previewLoan(body).schedule;
        } catch (error) {
            return domainFailure(error, set);
        }
    }, {
        body: t.Object({
            principal: t.String(),
            interestRate: t.String(),
            termMonths: t.Number(),
            repaymentType,
            startDate: t.String(),
            totalInstallments: t.Optional(t.Number()),
            installmentAmount: t.Optional(t.String())
        })
    })
    .post("/preview", ({ body, set }) => {
        try {
            return previewLoan(body);
        } catch (error) {
            return domainFailure(error, set);
        }
    }, {
        body: t.Object({
            principal: t.String(), interestRate: t.String(), termMonths: t.Number(),
            repaymentType, startDate: t.String(), totalInstallments: t.Optional(t.Number()),
            installmentAmount: t.Optional(t.String()),
        }),
    })
    .post("/", async ({ body, user, request, set }) => {
        if (!user) throw new Error("Unauthorized");
        try {
            const created = await createLoanDraft(commandContext(user, request), body);
            await invalidateTenantCache(user.tenantId);
            return created;
        } catch (error) {
            return domainFailure(error, set);
        }
    }, {
        body: t.Object({
            borrowerPublicId: t.String(),
            bankLoanPublicId: t.Optional(t.Nullable(t.String())),
            principal: t.String(),
            interestRate: t.String(),
            repaymentType,
            termMonths: t.Number(),
            totalInstallments: t.Optional(t.Number()),
            installmentAmount: t.Optional(t.String()),
            startDate: t.String()
        })
    })
    .put("/:id", async ({ params, body, user, request, set }) => {
        if (!user) throw new Error("Unauthorized");
        try {
            const updated = await updateLoanDraft(commandContext(user, request), params.id, body);
            await invalidateTenantCache(user.tenantId);
            return updated;
        } catch (error) {
            return domainFailure(error, set);
        }
    }, {
        params: t.Object({ id: t.String() }),
        body: t.Object({
            borrowerPublicId: t.Optional(t.String()),
            bankLoanPublicId: t.Optional(t.Nullable(t.String())),
            principal: t.Optional(t.String()), interestRate: t.Optional(t.String()),
            repaymentType: t.Optional(repaymentType), termMonths: t.Optional(t.Number()),
            totalInstallments: t.Optional(t.Number()), installmentAmount: t.Optional(t.String()),
            startDate: t.Optional(t.String()),
        }),
    })
    .post("/:id/activate", async ({ params, user, request, set }) => {
        if (!user) throw new Error("Unauthorized");
        try {
            const activated = await activateLoan(commandContext(user, request), params.id);
            await invalidateTenantCache(user.tenantId);
            return activated;
        } catch (error) {
            return domainFailure(error, set);
        }
    }, { params: t.Object({ id: t.String() }) })
    .post("/:id/funding-allocations", async ({ params, body, user, set }) => {
        if (!user) throw new Error("Unauthorized");
        if (!canAccessTenantWideData(user)) {
            set.status = 403;
            return { error: "Forbidden" };
        }

        const created = await db.transaction(async (tx) => {
            const resolvedLoan = await findAccessibleLoanByPublicId(user, params.id);
            const loan = await tx.select().from(loans).where(
                and(
                    eq(loans.id, resolvedLoan?.id ?? -1),
                    ...loanAccessFilters(user)
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
            id: t.String(),
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
        if (!canAccessTenantWideData(user)) {
            set.status = 403;
            return { error: "Forbidden" };
        }
        const resolvedLoan = await findAccessibleLoanByPublicId(user, params.id);
        if (!resolvedLoan) {
            set.status = 404;
            return { error: "Loan not found" };
        }

        const createdRows = await db.transaction(async (tx) => {
            const loan = await tx.select().from(loans).where(
                and(
                    eq(loans.id, resolvedLoan.id),
                    ...loanAccessFilters(user)
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
            id: t.String(),
        }),
        body: t.Object({
            fromBankLoanId: t.Number(),
            toBankLoanId: t.Number(),
            amount: t.Number(),
            allocationDate: t.String(),
            note: t.Optional(t.String()),
        })
    });
