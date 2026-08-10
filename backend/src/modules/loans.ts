import { Elysia, t } from "elysia";
import Decimal from "decimal.js";
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
import { parseMoney, serializeMoney } from "../lib/money";
import { invalidateTenantCache, withTenantCache } from "../lib/cache";
import {
    findAccessibleBorrowerByPublicId,
    findAccessibleLoanByPublicId,
    findBankLoanByPublicId,
    findBankProfileByPublicId,
} from "../lib/public-id";
import { activateLoan, createLoanDraft, getLoanApplication, presentLoan, previewLoan, updateLoanDraft } from "../services/loan-application-service";
import type { CommandContext } from "../services/command-context";
import { DomainError, presentDomainError } from "../services/domain-error";
import {
    createDisbursementDraft,
    assertDisbursementParentLoan,
    finalizeDisbursementEvidence,
    listLoanDisbursements,
    postDisbursement,
    prepareDisbursementEvidence,
    rejectDisbursementDraftEvidenceIds,
    reverseDisbursement,
    updateDisbursementDraft,
} from "../services/loan-disbursement-service";

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

function unauthorized(set: { status?: number | string }) {
    return domainFailure(new DomainError("UNAUTHORIZED", "Unauthorized", 401), set);
}

function forbidden(set: { status?: number | string }) {
    return domainFailure(new DomainError("FORBIDDEN", "Forbidden", 403), set);
}

function moneyInput(value: string, field: string) {
    try {
        return parseMoney(value);
    } catch {
        throw new DomainError("INVALID_MONEY", `${field} must be a non-negative string with exactly two decimals`, 400);
    }
}

function requireMutableFundingLoan(loan: typeof loans.$inferSelect) {
    if (["renewed", "canceled"].includes(loan.status ?? "")) {
        throw new DomainError("LOAN_FUNDING_LOCKED", "Funding cannot be changed after a loan is renewed or canceled", 409);
    }
}

function serializeSignedMoney(value: Decimal.Value) {
    const money = new Decimal(value);
    if (!money.isFinite()) throw new DomainError("INVALID_MONEY", "Money must be finite", 500);
    return money.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

type FundingAllocationRow = typeof loanFundingAllocations.$inferSelect;

async function presentFundingAllocation(row: FundingAllocationRow) {
    const [loan, bankProfile, bankLoan] = await Promise.all([
        db.query.loans.findFirst({ where: and(eq(loans.id, row.loanId), eq(loans.tenantId, row.tenantId)) }),
        row.bankProfileId === null ? null : db.query.bankProfiles.findFirst({
            where: and(eq(bankProfiles.id, row.bankProfileId), eq(bankProfiles.tenantId, row.tenantId)),
        }),
        row.bankLoanId === null ? null : db.query.bankLoans.findFirst({
            where: and(eq(bankLoans.id, row.bankLoanId), eq(bankLoans.tenantId, row.tenantId)),
        }),
    ]);
    return {
        id: row.publicId,
        publicId: row.publicId,
        loanPublicId: loan?.publicId ?? null,
        bankProfilePublicId: bankProfile?.publicId ?? null,
        bankLoanPublicId: bankLoan?.publicId ?? null,
        allocatedAmount: serializeSignedMoney(row.allocatedAmount),
        allocationDate: row.allocationDate,
        allocationType: row.allocationType,
        note: row.note,
        createdAt: row.createdAt,
    };
}

type LoanProfitabilitySummary = NonNullable<Awaited<ReturnType<typeof getLoanProfitabilitySummary>>>;

async function presentLoanProfitability(
    tenantId: string,
    loanPublicId: string,
    summary: LoanProfitabilitySummary,
) {
    const fundingComposition = await Promise.all(summary.fundingComposition.map(async (item) => {
        const [bankLoan, bankProfile] = await Promise.all([
            db.query.bankLoans.findFirst({
                where: and(eq(bankLoans.id, item.bankLoanId), eq(bankLoans.tenantId, tenantId)),
            }),
            item.bankProfileId === null ? null : db.query.bankProfiles.findFirst({
                where: and(eq(bankProfiles.id, item.bankProfileId), eq(bankProfiles.tenantId, tenantId)),
            }),
        ]);
        return {
            bankLoanPublicId: bankLoan?.publicId ?? null,
            bankProfilePublicId: bankProfile?.publicId ?? null,
            netAllocatedPrincipal: serializeSignedMoney(item.netAllocatedPrincipal),
            shareOfLoanPrincipal: item.shareOfLoanPrincipal,
            shareOfDrawdown: item.shareOfDrawdown,
            estimatedBankInterestPaid: serializeSignedMoney(item.estimatedBankInterestPaid),
            estimatedBankFeesPaid: serializeSignedMoney(item.estimatedBankFeesPaid),
            estimatedBankVatPaid: serializeSignedMoney(item.estimatedBankVatPaid),
            estimatedBankPenaltiesPaid: serializeSignedMoney(item.estimatedBankPenaltiesPaid),
            outstandingCostAllocated: serializeSignedMoney(item.outstandingCostAllocated),
        };
    }));
    const profileFundingComposition = await Promise.all(summary.profileFundingComposition.map(async (item) => {
        const profile = await db.query.bankProfiles.findFirst({
            where: and(eq(bankProfiles.id, item.bankProfileId), eq(bankProfiles.tenantId, tenantId)),
        });
        return {
            bankProfilePublicId: profile?.publicId ?? null,
            netAllocatedPrincipal: serializeSignedMoney(item.netAllocatedPrincipal),
        };
    }));
    return {
        loanId: loanPublicId,
        loanPublicId,
        principalAmount: serializeSignedMoney(summary.principalAmount),
        fundedPrincipal: serializeSignedMoney(summary.fundedPrincipal),
        unallocatedPrincipalGap: serializeSignedMoney(summary.unallocatedPrincipalGap),
        borrowerRevenueCollected: serializeSignedMoney(summary.borrowerRevenueCollected),
        fundCostPaid: serializeSignedMoney(summary.fundCostPaid),
        realizedSpread: serializeSignedMoney(summary.realizedSpread),
        unrealizedSpread: serializeSignedMoney(summary.unrealizedSpread),
        realizedRoiPercent: summary.realizedRoiPercent,
        estimatedOutstandingFundingCost: serializeSignedMoney(summary.estimatedOutstandingFundingCost),
        fundingShare: summary.fundingShare,
        fundingComposition,
        profileFundingComposition,
    };
}

const repaymentType = t.Union([
    t.Literal("daily"), t.Literal("weekly"), t.Literal("monthly"), t.Literal("floating"),
]);
const floatingDailyInterest = t.Object({
    mode: t.Union([t.Literal("per_thousand"), t.Literal("percent")]),
    rate: t.String(),
    firstDayTreatment: t.Union([t.Literal("deduct"), t.Literal("start_next_day")]),
});
const dailyEntry = t.Object({
    durationUnit: t.Union([t.Literal("days"), t.Literal("months")]),
    durationValue: t.Integer({ minimum: 1, maximum: 100_000 }),
    entryMode: t.Union([t.Literal("daily_payment"), t.Literal("daily_interest")]),
    dailyPayment: t.Optional(t.String()),
    interestInput: t.Optional(t.Object({
        mode: t.Union([t.Literal("percent"), t.Literal("fixed_amount"), t.Literal("per_thousand")]),
        value: t.String(),
    })),
});
const disbursementChannel = t.Union([t.Literal("bank_transfer"), t.Literal("cash"), t.Literal("adjustment")]);
const disbursementDraftBody = t.Object({
    grossAmount: t.String({ pattern: "^(0|[1-9]\\d*)\\.\\d{2}$", maxLength: 32 }),
    loanAttributedAmount: t.String({ pattern: "^(0|[1-9]\\d*)\\.\\d{2}$", maxLength: 32 }),
    channel: disbursementChannel,
    sourceBankProfilePublicId: t.Optional(t.Nullable(t.String({ format: "uuid" }))),
    payeeHint: t.Optional(t.Nullable(t.String({ maxLength: 500 }))),
    note: t.Optional(t.Nullable(t.String({ maxLength: 2000 }))),
    disbursedAt: t.String({ format: "date-time" }),
    evidenceFilePublicIds: t.Optional(t.Array(t.String({ format: "uuid" }), { maxItems: 100 })),
});
const disbursementDraftUpdateBody = t.Partial(disbursementDraftBody);

export const loansRoute = new Elysia({ prefix: "/loans" })
    .use(authPlugin)
    .get("/", async ({ user, query, set }) => {
        if (!user) return unauthorized(set);

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
            loader: async () => {
                const rows = await db.select({
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
                .orderBy(desc(loans.createdAt));
                return rows.map((row) => ({
                    ...row,
                    principal: serializeMoney(row.principal),
                    interestRate: serializeMoney(row.interestRate),
                    installmentAmount: row.installmentAmount === null ? null : serializeMoney(row.installmentAmount),
                }));
            },
        });
    }, {
        query: t.Object({
            borrowerId: t.Optional(t.String()),
        })
    })
    .get("/:id", async ({ params, user, request, set }) => {
        if (!user) {
            return unauthorized(set);
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
            return unauthorized(set);
        }

        const loan = await findAccessibleLoanByPublicId(user, params.id);

        if (!loan) return domainFailure(new DomainError("LOAN_NOT_FOUND", "Loan not found", 404), set);

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
                        id: row.publicId,
                        publicId: row.publicId,
                        loanPublicId: loan.publicId,
                        installmentNo: row.installmentNo,
                        dueDate: row.dueDate,
                        scheduledPrincipal: serializeMoney(row.scheduledPrincipal),
                        scheduledInterest: serializeMoney(row.scheduledInterest),
                        scheduledFee: serializeMoney(row.scheduledFee),
                        scheduledTotal: serializeMoney(row.scheduledTotal),
                        paidTotal: serializeMoney(row.paidTotal),
                        paidPenalty: serializeMoney(row.paidPenalty),
                        remainingDue: serializeMoney(row.remainingDue),
                        overdueDays: overdue.overdueDays,
                        penaltyDue: overdue.penaltyDue.toFixed(2),
                        totalDueNow: overdue.totalDueNow.toFixed(2),
                        status: overdue.effectiveStatus,
                        createdAt: row.createdAt,
                        updatedAt: row.updatedAt,
                    };
                });
            },
        });
    }, {
        params: t.Object({
            id: t.String(),
        })
    })
    .get("/:id/disbursements", async ({ params, user, request, set }) => {
        if (!user) return unauthorized(set);
        try {
            return await listLoanDisbursements(commandContext(user, request), params.id);
        } catch (error) {
            return domainFailure(error, set);
        }
    }, { params: t.Object({ id: t.String({ format: "uuid" }) }) })
    .post("/:id/disbursements", async ({ params, body, user, request, set }) => {
        if (!user) return unauthorized(set);
        try {
            rejectDisbursementDraftEvidenceIds(body);
            const created = await createDisbursementDraft(commandContext(user, request), params.id, body);
            await invalidateTenantCache(user.tenantId);
            return created;
        } catch (error) {
            return domainFailure(error, set);
        }
    }, { params: t.Object({ id: t.String({ format: "uuid" }) }), body: disbursementDraftBody })
    .put("/:id/disbursements/:disbursementId", async ({ params, body, user, request, set }) => {
        if (!user) return unauthorized(set);
        try {
            rejectDisbursementDraftEvidenceIds(body);
            const ctx = commandContext(user, request);
            await assertDisbursementParentLoan(ctx, params.id, params.disbursementId);
            const updated = await updateDisbursementDraft(ctx, params.disbursementId, body);
            await invalidateTenantCache(user.tenantId);
            return updated;
        } catch (error) {
            return domainFailure(error, set);
        }
    }, { params: t.Object({ id: t.String({ format: "uuid" }), disbursementId: t.String({ format: "uuid" }) }), body: disbursementDraftUpdateBody })
    .post("/:id/disbursements/:disbursementId/evidence/upload-intents", async ({ params, body, user, request, set }) => {
        if (!user) return unauthorized(set);
        try {
            const ctx = commandContext(user, request);
            await assertDisbursementParentLoan(ctx, params.id, params.disbursementId);
            return await prepareDisbursementEvidence(ctx, params.disbursementId, body);
        } catch (error) {
            return domainFailure(error, set);
        }
    }, { params: t.Object({ id: t.String({ format: "uuid" }), disbursementId: t.String({ format: "uuid" }) }), body: t.Object({ mimeType: t.Union([t.Literal("image/jpeg"), t.Literal("image/png"), t.Literal("application/pdf")]), size: t.Integer({ minimum: 1 }), sha256: t.String({ pattern: "^[0-9a-fA-F]{64}$" }), originalName: t.Optional(t.Nullable(t.String({ maxLength: 500 }))) }) })
    .post("/:id/disbursements/:disbursementId/evidence/:evidenceId/finalize", async ({ params, user, request, set }) => {
        if (!user) return unauthorized(set);
        try {
            const ctx = commandContext(user, request);
            await assertDisbursementParentLoan(ctx, params.id, params.disbursementId);
            return await finalizeDisbursementEvidence(ctx, params.disbursementId, params.evidenceId);
        } catch (error) {
            return domainFailure(error, set);
        }
    }, { params: t.Object({ id: t.String({ format: "uuid" }), disbursementId: t.String({ format: "uuid" }), evidenceId: t.String({ format: "uuid" }) }) })
    .post("/:id/disbursements/:disbursementId/post", async ({ params, user, request, set }) => {
        if (!user) return unauthorized(set);
        try {
            const ctx = commandContext(user, request);
            await assertDisbursementParentLoan(ctx, params.id, params.disbursementId);
            const posted = await postDisbursement(ctx, params.disbursementId);
            await invalidateTenantCache(user.tenantId);
            return posted;
        } catch (error) {
            return domainFailure(error, set);
        }
    }, { params: t.Object({ id: t.String({ format: "uuid" }), disbursementId: t.String({ format: "uuid" }) }), body: t.Object({}) })
    .post("/:id/disbursements/:disbursementId/reverse", async ({ params, body, user, request, set }) => {
        if (!user) return unauthorized(set);
        try {
            const ctx = commandContext(user, request);
            await assertDisbursementParentLoan(ctx, params.id, params.disbursementId);
            const reversed = await reverseDisbursement(ctx, params.disbursementId, body.reason);
            await invalidateTenantCache(user.tenantId);
            return reversed;
        } catch (error) {
            return domainFailure(error, set);
        }
    }, { params: t.Object({ id: t.String({ format: "uuid" }), disbursementId: t.String({ format: "uuid" }) }), body: t.Object({ reason: t.String({ minLength: 1, maxLength: 2_000 }) }) })
    .get("/:id/funding-allocations", async ({ params, user, set }) => {
        if (!user) {
            return unauthorized(set);
        }

        const loan = await findAccessibleLoanByPublicId(user, params.id);

        if (!loan) return domainFailure(new DomainError("LOAN_NOT_FOUND", "Loan not found", 404), set);

        const scopeKey = getAccessScopeCacheKey(user);
        return await withTenantCache({
            tenantId: user.tenantId,
            namespace: "loans",
            key: `funding-allocations:${loan.id}:${scopeKey}`,
            ttlSeconds: 20,
            loader: async () => {
                const rows = await db.select().from(loanFundingAllocations).where(
                    and(
                        eq(loanFundingAllocations.loanId, loan.id),
                        eq(loanFundingAllocations.tenantId, user.tenantId)
                    )
                )
                    .orderBy(desc(loanFundingAllocations.createdAt));
                return Promise.all(rows.map(async (row) => ({
                    ...await presentFundingAllocation(row),
                    bankProfileName: row.bankProfileId === null ? null : await db.query.bankProfiles.findFirst({
                        where: and(eq(bankProfiles.id, row.bankProfileId), eq(bankProfiles.tenantId, user.tenantId)),
                    }).then((profile) => profile?.name ?? null),
                })));
            },
        });
    }, {
        params: t.Object({
            id: t.String(),
        })
    })
    .get("/:id/profitability", async ({ params, user, set }) => {
        if (!user) {
            return unauthorized(set);
        }

        if (!canAccessTenantWideData(user)) {
            return forbidden(set);
        }
        const summary = await withTenantCache({
            tenantId: user.tenantId,
            namespace: "loans",
            key: `profitability:${params.id}`,
            ttlSeconds: 20,
            loader: async () => {
                const loan = await findAccessibleLoanByPublicId(user, params.id);
                if (!loan) return null;
                const profitability = await getLoanProfitabilitySummary(user.tenantId, loan.id);
                return profitability ? presentLoanProfitability(user.tenantId, loan.publicId, profitability) : null;
            },
        });
        if (!summary) return domainFailure(new DomainError("LOAN_NOT_FOUND", "Loan not found", 404), set);

        return summary;
    }, {
        params: t.Object({
            id: t.String(),
        })
    })
    .get("/:id/allocation-state", async ({ params, user, set }) => {
        if (!user) {
            return unauthorized(set);
        }

        const loan = await findAccessibleLoanByPublicId(user, params.id);

        if (!loan) return domainFailure(new DomainError("LOAN_NOT_FOUND", "Loan not found", 404), set);

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
                ).then((rows) => new Decimal(rows[0]?.totalAllocated ?? 0));

                const principalAmount = new Decimal(loan.principalAmount ?? 0);
                const remainingGap = Decimal.max(0, principalAmount.minus(netAllocated));
                const overfundedAmount = Decimal.max(0, netAllocated.minus(principalAmount));
                const state =
                    netAllocated.lte(0) ? "unfunded" :
                    overfundedAmount.gt(0) ? "overfunded" :
                    remainingGap.isZero() ? "fully_funded" :
                    "partially_funded";

                return {
                    loanId: loan.publicId,
                    loanPublicId: loan.publicId,
                    principalAmount: serializeMoney(principalAmount),
                    netAllocatedPrincipal: serializeMoney(netAllocated),
                    remainingGap: serializeMoney(remainingGap),
                    overfundedAmount: serializeMoney(overfundedAmount),
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
            return unauthorized(set);
        }

        const loan = await findAccessibleLoanByPublicId(user, params.id);

        if (!loan) return domainFailure(new DomainError("LOAN_NOT_FOUND", "Loan not found", 404), set);

        const loanTransactions = await db.select()
            .from(transactions)
            .where(and(eq(transactions.loanId, loan.id), eq(transactions.tenantId, user.tenantId)));

        const summary = calculateLoanClosingSummary({ ...loan, startDate: loan.startDate ?? new Date() }, loanTransactions);
        return {
            loanId: loan.publicId,
            loanPublicId: loan.publicId,
            principal: serializeMoney(summary.principal),
            totalInterest: serializeMoney(summary.totalInterest),
            totalPaid: serializeMoney(summary.totalPaid),
            totalDue: serializeMoney(summary.totalDue),
            balance: summary.balance < 0 ? `-${serializeMoney(Math.abs(summary.balance))}` : serializeMoney(summary.balance),
            daysSinceStart: summary.daysSinceStart,
        };
    }, {
        params: t.Object({
            id: t.String()
        })
    })
    .post("/:id/close", async ({ params, body, user, request, set }) => {
        if (!user) {
            return unauthorized(set);
        }

        try {
            const closed = await db.transaction(async (tx) => {
            const resolved = await findAccessibleLoanByPublicId(user, params.id);
            const loan = resolved ? await tx.query.loans.findFirst({
                where: and(eq(loans.id, resolved.id), ...loanAccessFilters(user)),
            }) : null;

            if (!loan) throw new DomainError("LOAN_NOT_FOUND", "Loan not found", 404);

            if (loan.status === "closed") throw new DomainError("LOAN_ALREADY_CLOSED", "Loan is already closed", 409);

            const before = await getLoanApplication(commandContext(user, request), loan.publicId);
            const updated = await tx.update(loans)
                .set({
                    status: "closed",
                    updatedAt: new Date(),
                })
                .where(eq(loans.id, loan.id))
                .returning()
                .then((rows) => rows[0]!);
            const after = await presentLoan(updated);

            await createAuditLog(tx, {
                tenantId: user.tenantId,
                actorUserId: user.id,
                entityType: "loan",
                entityId: loan.publicId,
                action: "closed",
                payload: {
                    before,
                    after,
                    note: body.note,
                },
            });

            await invalidateTenantCache(user.tenantId);
            return after;
        });
            return closed;
        } catch (error) {
            return domainFailure(error, set);
        }
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
            installmentAmount: t.Optional(t.String()),
            floatingDailyInterest: t.Optional(floatingDailyInterest),
            dailyEntry: t.Optional(dailyEntry),
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
            floatingDailyInterest: t.Optional(floatingDailyInterest),
            dailyEntry: t.Optional(dailyEntry),
        }),
    })
    .post("/", async ({ body, user, request, set }) => {
        if (!user) return unauthorized(set);
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
            bankProfilePublicId: t.Optional(t.Nullable(t.String())),
            principal: t.String(),
            interestRate: t.String(),
            repaymentType,
            termMonths: t.Number(),
            totalInstallments: t.Optional(t.Number()),
            installmentAmount: t.Optional(t.String()),
            floatingDailyInterest: t.Optional(floatingDailyInterest),
            dailyEntry: t.Optional(dailyEntry),
            startDate: t.String()
        })
    })
    .put("/:id", async ({ params, body, user, request, set }) => {
        if (!user) return unauthorized(set);
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
            bankProfilePublicId: t.Optional(t.Nullable(t.String())),
            principal: t.Optional(t.String()), interestRate: t.Optional(t.String()),
            repaymentType: t.Optional(repaymentType), termMonths: t.Optional(t.Number()),
            totalInstallments: t.Optional(t.Number()), installmentAmount: t.Optional(t.String()),
            floatingDailyInterest: t.Optional(floatingDailyInterest),
            dailyEntry: t.Optional(dailyEntry),
            startDate: t.Optional(t.String()),
        }),
    })
    .post("/:id/activate", async ({ params, user, request, set }) => {
        if (!user) return unauthorized(set);
        try {
            const activated = await activateLoan(commandContext(user, request), params.id);
            await invalidateTenantCache(user.tenantId);
            return activated;
        } catch (error) {
            return domainFailure(error, set);
        }
    }, { params: t.Object({ id: t.String() }) })
    .post("/:id/funding-allocations", async ({ params, body, user, set }) => {
        if (!user) return unauthorized(set);
        if (!canAccessTenantWideData(user)) {
            return forbidden(set);
        }
        try {
        const amount = moneyInput(body.allocatedAmount, "allocatedAmount");
        const created = await db.transaction(async (tx) => {
            const resolvedLoan = await findAccessibleLoanByPublicId(user, params.id);
            if (!resolvedLoan) throw new DomainError("LOAN_NOT_FOUND", "Loan not found", 404);
            await tx.execute(sql`SELECT id FROM loans WHERE tenant_id = ${user.tenantId}
                AND id = ${resolvedLoan.id} FOR UPDATE`);
            const loan = await tx.select().from(loans).where(
                and(
                    eq(loans.id, resolvedLoan.id),
                    ...loanAccessFilters(user)
                )
            ).then((rows) => rows[0]);

            if (!loan) throw new DomainError("LOAN_NOT_FOUND", "Loan not found", 404);
            requireMutableFundingLoan(loan);

            const requestedProfile = body.bankProfilePublicId
                ? await findBankProfileByPublicId(user.tenantId, body.bankProfilePublicId)
                : null;
            if (body.bankProfilePublicId && !requestedProfile) {
                throw new DomainError("BANK_PROFILE_NOT_FOUND", "Bank profile not found", 404);
            }
            const requestedDrawdown = body.bankLoanPublicId
                ? await findBankLoanByPublicId(user.tenantId, body.bankLoanPublicId)
                : null;
            if (body.bankLoanPublicId && !requestedDrawdown) {
                throw new DomainError("BANK_LOAN_NOT_FOUND", "Bank loan not found", 404);
            }
            let sourceBankProfileId = requestedProfile?.id ?? null;
            if (requestedDrawdown) {
                // Use a row lock to prevent concurrent allocations from exceeding capacity
                const sourceDrawdown = await tx.execute(
                    sql`SELECT * FROM bank_loans WHERE id = ${requestedDrawdown.id} AND tenant_id = ${user.tenantId} FOR UPDATE`
                ).then((res) => res[0] as typeof bankLoans.$inferSelect | undefined);

                if (!sourceDrawdown) throw new DomainError("BANK_LOAN_NOT_FOUND", "Bank loan not found", 404);

                const sourceAllocation = await tx.select({
                    totalAllocated: sql<string>`coalesce(sum(${loanFundingAllocations.allocatedAmount}), 0)`,
                }).from(loanFundingAllocations).where(
                    and(
                        eq(loanFundingAllocations.bankLoanId, requestedDrawdown.id),
                        eq(loanFundingAllocations.tenantId, user.tenantId)
                    )
                ).then((rows) => new Decimal(rows[0]?.totalAllocated ?? 0));

                const sourceRemaining = new Decimal(sourceDrawdown.amount).minus(sourceAllocation);
                if (amount.gt(sourceRemaining)) {
                    throw new DomainError("ALLOCATION_EXCEEDS_DRAWDOWN", "Allocation exceeds remaining drawdown balance", 400, {
                        sourceRemaining: serializeMoney(Decimal.max(0, sourceRemaining)),
                    });
                }

                sourceBankProfileId = requestedDrawdown.bankProfileId;
            }

            if (!sourceBankProfileId && !requestedDrawdown) {
                throw new DomainError("FUNDING_SOURCE_REQUIRED", "Either bankProfilePublicId or bankLoanPublicId is required", 400);
            }

            const currentAllocation = await tx.select({
                totalAllocated: sql<string>`coalesce(sum(${loanFundingAllocations.allocatedAmount}), 0)`,
            }).from(loanFundingAllocations).where(
                and(
                    eq(loanFundingAllocations.loanId, loan.id),
                    eq(loanFundingAllocations.tenantId, user.tenantId)
                )
            ).then((rows) => new Decimal(rows[0]?.totalAllocated ?? 0));

            const remainingLoanCapacity = new Decimal(loan.principalAmount).minus(currentAllocation);
            if (amount.gt(remainingLoanCapacity)) {
                throw new DomainError("ALLOCATION_EXCEEDS_PRINCIPAL", "Allocation exceeds remaining unfunded principal", 400, {
                    remainingCapacity: serializeMoney(remainingLoanCapacity),
                });
            }

            const created = await tx.insert(loanFundingAllocations).values({
                tenantId: user.tenantId,
                bankProfileId: sourceBankProfileId,
                bankLoanId: requestedDrawdown?.id ?? null,
                loanId: loan.id,
                allocatedAmount: serializeMoney(amount),
                allocationDate: body.allocationDate,
                allocationType: body.allocationType ?? "initial",
                allocationGroupId: crypto.randomUUID(),
                note: body.note,
                createdByUserId: user.id,
            }).returning().then((rows) => rows[0]);

            await createAuditLog(tx, {
                tenantId: user.tenantId,
                actorUserId: user.id,
                entityType: "loan_funding_allocation",
                entityId: created.publicId,
                action: "created",
                payload: await presentFundingAllocation(created),
            });

            return presentFundingAllocation(created);
        });
        await invalidateTenantCache(user.tenantId);
        return created;
        } catch (error) {
            return domainFailure(error, set);
        }
    }, {
        params: t.Object({
            id: t.String(),
        }),
        body: t.Object({
            bankProfilePublicId: t.Optional(t.String()),
            bankLoanPublicId: t.Optional(t.String()),
            allocatedAmount: t.String(),
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
        if (!user) return unauthorized(set);
        if (!canAccessTenantWideData(user)) {
            return forbidden(set);
        }
        try {
        const amount = moneyInput(body.amount, "amount");
        const resolvedLoan = await findAccessibleLoanByPublicId(user, params.id);
        if (!resolvedLoan) throw new DomainError("LOAN_NOT_FOUND", "Loan not found", 404);

        const createdRows = await db.transaction(async (tx) => {
            await tx.execute(sql`SELECT id FROM loans WHERE tenant_id = ${user.tenantId}
                AND id = ${resolvedLoan.id} FOR UPDATE`);
            const loan = await tx.select().from(loans).where(
                and(
                    eq(loans.id, resolvedLoan.id),
                    ...loanAccessFilters(user)
                )
            ).then((rows) => rows[0]);

            if (!loan) throw new DomainError("LOAN_NOT_FOUND", "Loan not found", 404);
            requireMutableFundingLoan(loan);

            const sourceDrawdown = await tx.select().from(bankLoans).where(
                and(
                    eq(bankLoans.publicId, body.fromBankLoanPublicId),
                    eq(bankLoans.tenantId, user.tenantId)
                )
            ).then((rows) => rows[0]);
            const targetDrawdown = await tx.select().from(bankLoans).where(
                and(
                    eq(bankLoans.publicId, body.toBankLoanPublicId),
                    eq(bankLoans.tenantId, user.tenantId)
                )
            ).then((rows) => rows[0]);

            if (!sourceDrawdown || !targetDrawdown) {
                throw new DomainError("BANK_LOAN_NOT_FOUND", "Source or target drawdown not found", 404);
            }

            if (body.fromBankLoanPublicId === body.toBankLoanPublicId) {
                throw new DomainError("SAME_FUNDING_SOURCE", "Source and target drawdowns must be different", 400);
            }
            const bankLoanIds = [sourceDrawdown.id, targetDrawdown.id].sort((a, b) => a - b);
            await tx.execute(sql`SELECT id FROM bank_loans WHERE tenant_id = ${user.tenantId}
                AND id IN (${sql.join(bankLoanIds.map((id) => sql`${id}`), sql`, `)}) ORDER BY id FOR UPDATE`);

            const currentSourceAllocation = await tx.select({
                totalAllocated: sql<string>`coalesce(sum(${loanFundingAllocations.allocatedAmount}), 0)`,
            }).from(loanFundingAllocations).where(
                and(
                    eq(loanFundingAllocations.loanId, loan.id),
                    eq(loanFundingAllocations.bankLoanId, sourceDrawdown.id),
                    eq(loanFundingAllocations.tenantId, user.tenantId)
                )
            ).then((rows) => new Decimal(rows[0]?.totalAllocated ?? 0));

            if (amount.gt(currentSourceAllocation)) {
                throw new DomainError("REALLOCATION_EXCEEDS_SOURCE", "Reallocation exceeds current allocation on the source drawdown", 400, {
                    sourceAllocated: serializeMoney(currentSourceAllocation),
                });
            }

            const targetAllocation = await tx.select({
                totalAllocated: sql<string>`coalesce(sum(${loanFundingAllocations.allocatedAmount}), 0)`,
            }).from(loanFundingAllocations).where(
                and(
                    eq(loanFundingAllocations.bankLoanId, targetDrawdown.id),
                    eq(loanFundingAllocations.tenantId, user.tenantId)
                )
            ).then((rows) => new Decimal(rows[0]?.totalAllocated ?? 0));

            const targetRemaining = new Decimal(targetDrawdown.amount).minus(targetAllocation);
            if (amount.gt(targetRemaining)) {
                throw new DomainError("REALLOCATION_EXCEEDS_TARGET", "Reallocation exceeds remaining target drawdown balance", 400, {
                    targetRemaining: serializeMoney(targetRemaining),
                });
            }

            const allocationGroupId = crypto.randomUUID();
            const createdRows = await tx.insert(loanFundingAllocations).values([
                {
                    tenantId: user.tenantId,
                    bankProfileId: sourceDrawdown.bankProfileId,
                    bankLoanId: sourceDrawdown.id,
                    loanId: loan.id,
                    allocatedAmount: amount.negated().toFixed(2),
                    allocationDate: body.allocationDate,
                    allocationType: "reallocation_out",
                    allocationGroupId,
                    note: body.note ?? `Reallocated out to drawdown ${targetDrawdown.publicId}`,
                    createdByUserId: user.id,
                },
                {
                    tenantId: user.tenantId,
                    bankProfileId: targetDrawdown.bankProfileId,
                    bankLoanId: targetDrawdown.id,
                    loanId: loan.id,
                    allocatedAmount: amount.toFixed(2),
                    allocationDate: body.allocationDate,
                    allocationType: "reallocation_in",
                    allocationGroupId,
                    note: body.note ?? `Reallocated in from drawdown ${sourceDrawdown.publicId}`,
                    createdByUserId: user.id,
                },
            ]).returning();

            await createAuditLog(tx, {
                tenantId: user.tenantId,
                actorUserId: user.id,
                entityType: "loan_funding_reallocation",
                entityId: `${createdRows[0].publicId}:${createdRows[1].publicId}`,
                action: "created",
                payload: {
                    loanPublicId: loan.publicId,
                    fromBankLoanPublicId: sourceDrawdown.publicId,
                    toBankLoanPublicId: targetDrawdown.publicId,
                    amount: amount.toFixed(2),
                    allocationDate: body.allocationDate,
                    note: body.note,
                },
            });

            return Promise.all(createdRows.map(presentFundingAllocation));
        });
        await invalidateTenantCache(user.tenantId);
        return createdRows;
        } catch (error) {
            return domainFailure(error, set);
        }
    }, {
        params: t.Object({
            id: t.String(),
        }),
        body: t.Object({
            fromBankLoanPublicId: t.String(),
            toBankLoanPublicId: t.String(),
            amount: t.String(),
            allocationDate: t.String(),
            note: t.Optional(t.String()),
        })
    });
