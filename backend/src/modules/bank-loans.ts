import { Elysia, t } from "elysia";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db";
import {
    bankLoanRepayments,
    bankLoans,
    bankLoanSchedules,
    bankProfiles,
    fundLedgerEntries,
    loanFundingAllocations,
    loans,
    borrowers,
} from "../db/schema";
import { authPlugin } from "../middleware/auth";
import { isTenantAdminUser } from "../lib/access";
import { generateBankLoanSchedule, type RepaymentCycle } from "../lib/bank-loan-schedule";
import { buildBankLoanRepaymentRollupUpdate, computeBankLoanRollup } from "../lib/bank-loan-rollup";
import { createAuditLog } from "../lib/audit-log";
import { deriveProfitabilityMetrics, getBankLoanSettlementSummary } from "../lib/fund-settlement";
import { computeOverdueSnapshot } from "../lib/overdue";
import { invalidateTenantCache, withTenantCache } from "../lib/cache";
import { findBankLoanByPublicId, findBankLoanScheduleByPublicId, findBankProfileByPublicId } from "../lib/public-id";
import { serializeMoney } from "../lib/money";
import { FinancialDecimal } from "../lib/financial-decimal";

export const bankLoansRoute = new Elysia({ prefix: "/bank-loans" })
    .use(authPlugin)
    .get("/", async ({ user, query, set }) => {
        if (!isTenantAdminUser(user)) {
            set.status = user ? 403 : 401;
            return { error: user ? "Forbidden" : "Unauthorized" };
        }
        const whereClause = [eq(bankLoans.tenantId, user.tenantId)];
        if (query.bankProfileId) {
            const bankProfile = await findBankProfileByPublicId(user.tenantId, query.bankProfileId);
            if (!bankProfile) {
                return [];
            }
            whereClause.push(eq(bankLoans.bankProfileId, bankProfile.id));
        }
        return await withTenantCache({
            tenantId: user.tenantId,
            namespace: "bank-loans",
            key: `list:profile=${query.bankProfileId ?? "all"}`,
            ttlSeconds: 30,
            loader: async () => await db.select().from(bankLoans)
                .where(and(...whereClause))
                .orderBy(desc(bankLoans.createdAt)),
        });
    }, {
        query: t.Object({
            bankProfileId: t.Optional(t.String())
        })
    })
    .get("/:id", async ({ params: { id }, user, set }) => {
        if (!isTenantAdminUser(user)) {
            set.status = user ? 403 : 401;
            return { error: user ? "Forbidden" : "Unauthorized" };
        }
        const bankLoan = await findBankLoanByPublicId(user.tenantId, id);
        if (!bankLoan) {
            set.status = 404;
            return { error: "Bank loan not found" };
        }

        const result = await withTenantCache({
            tenantId: user.tenantId,
            namespace: "bank-loans",
            key: `detail:${id}`,
            ttlSeconds: 30,
            loader: async () => await db.select().from(bankLoans).where(
                and(
                    eq(bankLoans.id, bankLoan.id),
                    eq(bankLoans.tenantId, user.tenantId)
                )
            ),
        });

        if (!result[0]) {
            set.status = 404;
            return { error: "Bank loan not found" };
        }

        return result[0];
    })
    .get("/:id/schedule", async ({ params: { id }, user, set }) => {
        if (!isTenantAdminUser(user)) {
            set.status = user ? 403 : 401;
            return { error: user ? "Forbidden" : "Unauthorized" };
        }
        const bankLoan = await findBankLoanByPublicId(user.tenantId, id);

        if (!bankLoan) {
            set.status = 404;
            return { error: "Bank loan not found" };
        }

        return await withTenantCache({
            tenantId: user.tenantId,
            namespace: "bank-loans",
            key: `schedule:${bankLoan.id}`,
            ttlSeconds: 20,
            loader: async () => {
                const scheduleRows = await db.select().from(bankLoanSchedules).where(
                    and(
                        eq(bankLoanSchedules.bankLoanId, bankLoan.id),
                        eq(bankLoanSchedules.tenantId, user.tenantId)
                    )
                ).orderBy(bankLoanSchedules.installmentNo);

                return scheduleRows.map((row) => {
                    const overdue = computeOverdueSnapshot({
                        dueDate: row.dueDate,
                        remainingDue: row.remainingDue,
                        paidPenalty: row.paidPenalty,
                        gracePeriodDays: bankLoan.gracePeriodDays,
                        lateFeeMode: bankLoan.lateFeeMode,
                        lateFeeAmount: bankLoan.lateFeeAmount,
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
    })
    .get("/:id/repayments", async ({ params: { id }, user, set }) => {
        if (!isTenantAdminUser(user)) {
            set.status = user ? 403 : 401;
            return { error: user ? "Forbidden" : "Unauthorized" };
        }
        const bankLoan = await findBankLoanByPublicId(user.tenantId, id);

        if (!bankLoan) {
            set.status = 404;
            return { error: "Bank loan not found" };
        }

        return await withTenantCache({
            tenantId: user.tenantId,
            namespace: "bank-loans",
            key: `repayments:${bankLoan.id}`,
            ttlSeconds: 20,
            loader: async () => await db.select().from(bankLoanRepayments).where(
                and(
                    eq(bankLoanRepayments.bankLoanId, bankLoan.id),
                    eq(bankLoanRepayments.tenantId, user.tenantId)
                )
            ).orderBy(desc(bankLoanRepayments.paymentDate)),
        });
    })
    .get("/:id/allocations", async ({ params: { id }, user, set }) => {
        if (!isTenantAdminUser(user)) {
            set.status = user ? 403 : 401;
            return { error: user ? "Forbidden" : "Unauthorized" };
        }
        const bankLoan = await findBankLoanByPublicId(user.tenantId, id);

        if (!bankLoan) {
            set.status = 404;
            return { error: "Bank loan not found" };
        }

        return await withTenantCache({
            tenantId: user.tenantId,
            namespace: "bank-loans",
            key: `allocations:${bankLoan.id}`,
            ttlSeconds: 20,
            loader: async () => await db.select({
                id: loanFundingAllocations.id,
                loanId: loanFundingAllocations.loanId,
                loanPublicId: loans.publicId,
                borrowerId: loans.borrowerId,
                borrowerPublicId: borrowers.publicId,
                borrowerName: borrowers.name,
                allocatedAmount: loanFundingAllocations.allocatedAmount,
                allocationDate: loanFundingAllocations.allocationDate,
                allocationType: loanFundingAllocations.allocationType,
                note: loanFundingAllocations.note,
            })
                .from(loanFundingAllocations)
                .leftJoin(loans, eq(loanFundingAllocations.loanId, loans.id))
                .leftJoin(borrowers, eq(loans.borrowerId, borrowers.id))
                .where(
                    and(
                        eq(loanFundingAllocations.bankLoanId, bankLoan.id),
                        eq(loanFundingAllocations.tenantId, user.tenantId)
                    )
                )
                .orderBy(desc(loanFundingAllocations.createdAt)),
        });
    })
    .get("/:id/profitability", async ({ params: { id }, user, set }) => {
        if (!isTenantAdminUser(user)) {
            set.status = user ? 403 : 401;
            return { error: user ? "Forbidden" : "Unauthorized" };
        }

        const bankLoan = await findBankLoanByPublicId(user.tenantId, id);

        if (!bankLoan) {
            set.status = 404;
            return { error: "Bank loan not found" };
        }
        const bankLoanId = bankLoan.id;

        return await withTenantCache({
            tenantId: user.tenantId,
            namespace: "bank-loans",
            key: `profitability:${bankLoanId}`,
            ttlSeconds: 20,
            loader: async () => {
                const summary = await getBankLoanSettlementSummary(user.tenantId, bankLoanId);
                const deployedPrincipal = await db.select({
                    totalAllocated: sql<string>`coalesce(sum(${loanFundingAllocations.allocatedAmount}), 0)`,
                }).from(loanFundingAllocations).where(
                    and(
                        eq(loanFundingAllocations.tenantId, user.tenantId),
                        eq(loanFundingAllocations.bankLoanId, bankLoanId),
                    )
                ).then((rows) => rows[0]?.totalAllocated ?? "0");

                return {
                    ...summary,
                    ...deriveProfitabilityMetrics(summary!, deployedPrincipal),
                    outstandingCost: new FinancialDecimal(bankLoan.outstandingInterest ?? 0)
                        .plus(bankLoan.outstandingFees ?? 0)
                        .plus(bankLoan.outstandingPenalties ?? 0)
                        .toFixed(2),
                };
            },
        });
    })
    .get("/:id/allocation-state", async ({ params: { id }, user, set }) => {
        if (!isTenantAdminUser(user)) {
            set.status = user ? 403 : 401;
            return { error: user ? "Forbidden" : "Unauthorized" };
        }

        const bankLoan = await findBankLoanByPublicId(user.tenantId, id);

        if (!bankLoan) {
            set.status = 404;
            return { error: "Bank loan not found" };
        }
        const bankLoanId = bankLoan.id;

        return await withTenantCache({
            tenantId: user.tenantId,
            namespace: "bank-loans",
            key: `allocation-state:${bankLoanId}`,
            ttlSeconds: 20,
            loader: async () => {
                const netAllocated = await db.select({
                    totalAllocated: sql<string>`coalesce(sum(${loanFundingAllocations.allocatedAmount}), 0)`,
                }).from(loanFundingAllocations).where(
                    and(
                        eq(loanFundingAllocations.tenantId, user.tenantId),
                        eq(loanFundingAllocations.bankLoanId, bankLoanId),
                    )
                ).then((rows) => new FinancialDecimal(rows[0]?.totalAllocated ?? "0"));

                const drawdownAmount = new FinancialDecimal(bankLoan.amount ?? "0");
                const zero = new FinancialDecimal("0");
                const remainingCapacity = FinancialDecimal.max(zero, drawdownAmount.minus(netAllocated));
                const overallocatedAmount = FinancialDecimal.max(zero, netAllocated.minus(drawdownAmount));
                const state =
                    netAllocated.lte(0) ? "unallocated" :
                    overallocatedAmount.gt(0) ? "overallocated" :
                    remainingCapacity.isZero() ? "fully_allocated" :
                    "partially_allocated";

                return {
                    bankLoanId,
                    drawdownAmount: serializeMoney(drawdownAmount),
                    netAllocatedPrincipal: serializeMoney(netAllocated),
                    remainingCapacity: serializeMoney(remainingCapacity),
                    overallocatedAmount: serializeMoney(overallocatedAmount),
                    state,
                };
            },
        });
    })
    .put("/:id", async ({ params: { id }, body, user, set }) => {
        if (!isTenantAdminUser(user)) {
            set.status = user ? 403 : 401;
            return { error: user ? "Forbidden" : "Unauthorized" };
        }

        const bankLoanId = parseInt(id);

        return await db.transaction(async (tx) => {
            const existingLoan = await tx.select().from(bankLoans).where(
                and(
                    eq(bankLoans.id, bankLoanId),
                    eq(bankLoans.tenantId, user.tenantId)
                )
            ).then((rows) => rows[0]);

            if (!existingLoan) {
                set.status = 404;
                return { error: "Bank loan not found" };
            }

            if (body.bankProfileId) {
                const bankProfile = await tx.select().from(bankProfiles).where(
                    and(
                        eq(bankProfiles.id, body.bankProfileId),
                        eq(bankProfiles.tenantId, user.tenantId)
                    )
                ).then((rows) => rows[0]);

                if (!bankProfile) {
                    set.status = 404;
                    return { error: "Bank profile not found" };
                }
            }

            const hasRepayments = await tx.select().from(bankLoanRepayments).where(
                and(
                    eq(bankLoanRepayments.bankLoanId, bankLoanId),
                    eq(bankLoanRepayments.tenantId, user.tenantId)
                )
            ).then((rows) => rows.length > 0);

            const scheduleAffectingChange =
                body.amount !== undefined ||
                body.interestRate !== undefined ||
                body.startDate !== undefined ||
                body.termMonths !== undefined ||
                body.repaymentCycle !== undefined ||
                body.repaymentMode !== undefined ||
                body.installmentAmount !== undefined ||
                body.totalInstallments !== undefined ||
                body.processingFeeAmount !== undefined ||
                body.utilizationFeeAmount !== undefined ||
                body.vatRate !== undefined ||
                body.lateFeeMode !== undefined ||
                body.lateFeeAmount !== undefined ||
                body.gracePeriodDays !== undefined;

            if (hasRepayments && scheduleAffectingChange) {
                set.status = 400;
                return {
                    error: "Cannot change schedule-affecting drawdown fields after repayments have been recorded",
                };
            }

            const nextAmount = body.amount ?? Number(existingLoan.amount ?? 0);
            const nextInterestRate = body.interestRate ?? Number(existingLoan.interestRate ?? 0);
            const nextStartDate = body.startDate ?? existingLoan.startDate ?? undefined;
            const nextTermMonths = body.termMonths ?? existingLoan.termMonths ?? undefined;
            const nextRepaymentCycle = (body.repaymentCycle ?? existingLoan.repaymentCycle ?? "monthly") as RepaymentCycle;
            const nextRepaymentMode = body.repaymentMode ?? existingLoan.repaymentMode ?? "fixed_installment";
            const existingInstallmentAmount = Number(existingLoan.installmentAmount ?? 0);
            const nextInstallmentAmount = body.installmentAmount ?? (existingInstallmentAmount > 0 ? existingInstallmentAmount : undefined);
            const nextTotalInstallments = body.totalInstallments ?? existingLoan.totalInstallments ?? undefined;
            const nextProcessingFeeAmount = body.processingFeeAmount ?? Number(existingLoan.processingFeeAmount ?? 0);
            const nextUtilizationFeeAmount = body.utilizationFeeAmount ?? Number(existingLoan.utilizationFeeAmount ?? 0);
            const nextVatRate = body.vatRate ?? Number(existingLoan.vatRate ?? 0);
            const nextLateFeeMode = body.lateFeeMode ?? existingLoan.lateFeeMode ?? "none";
            const nextLateFeeAmount = body.lateFeeAmount ?? Number(existingLoan.lateFeeAmount ?? 0);
            const nextGracePeriodDays = body.gracePeriodDays ?? existingLoan.gracePeriodDays ?? 0;

            let regeneratedSchedule = null as ReturnType<typeof generateBankLoanSchedule> | null;
            let nextDueDate = existingLoan.nextDueDate;
            let outstandingPrincipal = existingLoan.outstandingPrincipal ?? "0.00";
            let outstandingInterest = existingLoan.outstandingInterest ?? "0.00";
            let outstandingFees = existingLoan.outstandingFees ?? "0.00";
            let outstandingPenalties = existingLoan.outstandingPenalties ?? "0.00";

            if (scheduleAffectingChange && !hasRepayments) {
                regeneratedSchedule = generateBankLoanSchedule({
                    amount: nextAmount.toFixed(2),
                    interestRate: nextInterestRate.toFixed(2),
                    startDate: nextStartDate,
                    termMonths: nextTermMonths,
                    repaymentCycle: nextRepaymentCycle,
                    totalInstallments: nextTotalInstallments,
                    installmentAmount: nextInstallmentAmount?.toFixed(2),
                    processingFeeAmount: nextProcessingFeeAmount.toFixed(2),
                    utilizationFeeAmount: nextUtilizationFeeAmount.toFixed(2),
                    vatRate: nextVatRate.toFixed(2),
                });

                nextDueDate = regeneratedSchedule[0]?.dueDate ?? null;
                outstandingPrincipal = nextAmount.toFixed(2);
                outstandingInterest = regeneratedSchedule
                    .reduce((sum, row) => sum + Number(row.scheduledInterest), 0)
                    .toFixed(2);
                outstandingFees = regeneratedSchedule
                    .reduce((sum, row) => sum + Number(row.scheduledFee) + Number(row.scheduledVat), 0)
                    .toFixed(2);
                outstandingPenalties = "0.00";
            }

            const updatedLoan = await tx.update(bankLoans)
                .set({
                    bankProfileId: body.bankProfileId ?? existingLoan.bankProfileId,
                    amount: nextAmount.toFixed(2),
                    interestRate: nextInterestRate.toFixed(2),
                    startDate: nextStartDate,
                    termMonths: nextTermMonths,
                    repaymentCycle: nextRepaymentCycle,
                    repaymentMode: nextRepaymentMode,
                    installmentAmount: nextInstallmentAmount?.toFixed(2),
                    totalInstallments: nextTotalInstallments,
                    processingFeeAmount: nextProcessingFeeAmount.toFixed(2),
                    utilizationFeeAmount: nextUtilizationFeeAmount.toFixed(2),
                    vatRate: nextVatRate.toFixed(2),
                    lateFeeMode: nextLateFeeMode,
                    lateFeeAmount: nextLateFeeAmount.toFixed(2),
                    gracePeriodDays: nextGracePeriodDays,
                    nextDueDate,
                    outstandingPrincipal,
                    outstandingInterest,
                    outstandingFees,
                    outstandingPenalties,
                    note: body.note ?? existingLoan.note,
                    updatedAt: new Date(),
                })
                .where(eq(bankLoans.id, bankLoanId))
                .returning()
                .then((rows) => rows[0]);

            if (regeneratedSchedule) {
                await tx.delete(bankLoanSchedules).where(
                    and(
                        eq(bankLoanSchedules.bankLoanId, bankLoanId),
                        eq(bankLoanSchedules.tenantId, user.tenantId)
                    )
                );

                if (regeneratedSchedule.length > 0) {
                    await tx.insert(bankLoanSchedules).values(
                        regeneratedSchedule.map((row) => ({
                            tenantId: user.tenantId,
                            bankLoanId,
                            installmentNo: row.installmentNo,
                            dueDate: row.dueDate,
                            scheduledPrincipal: row.scheduledPrincipal,
                            scheduledInterest: row.scheduledInterest,
                            scheduledFee: row.scheduledFee,
                            scheduledVat: row.scheduledVat,
                            scheduledTotal: row.scheduledTotal,
                            remainingDue: row.remainingDue,
                            status: "pending",
                        }))
                    );
                }
            }

            await createAuditLog(tx, {
                tenantId: user.tenantId,
                actorUserId: user.id,
                entityType: "bank_loan",
                entityId: bankLoanId,
                action: "updated",
                payload: {
                    before: existingLoan,
                    after: updatedLoan,
                    regeneratedSchedule: Boolean(regeneratedSchedule),
                },
            });

            await invalidateTenantCache(user.tenantId);
            return updatedLoan;
        });
    }, {
        body: t.Object({
            bankProfileId: t.Optional(t.Number()),
            amount: t.Optional(t.Number()),
            interestRate: t.Optional(t.Number()),
            startDate: t.Optional(t.String()),
            termMonths: t.Optional(t.Number()),
            repaymentCycle: t.Optional(t.Union([
                t.Literal("daily"),
                t.Literal("weekly"),
                t.Literal("monthly"),
                t.Literal("custom"),
            ])),
            repaymentMode: t.Optional(t.Union([
                t.Literal("fixed_installment"),
                t.Literal("minimum_due"),
                t.Literal("interest_only"),
                t.Literal("custom"),
            ])),
            installmentAmount: t.Optional(t.Number()),
            totalInstallments: t.Optional(t.Number()),
            processingFeeAmount: t.Optional(t.Number()),
            utilizationFeeAmount: t.Optional(t.Number()),
            vatRate: t.Optional(t.Number()),
            lateFeeMode: t.Optional(t.Union([
                t.Literal("none"),
                t.Literal("fixed"),
                t.Literal("daily_percent"),
                t.Literal("fixed_plus_percent"),
            ])),
            lateFeeAmount: t.Optional(t.Number()),
            gracePeriodDays: t.Optional(t.Number()),
            note: t.Optional(t.String()),
        })
    })
    .post("/", async ({ body, user, set }) => {
        if (!isTenantAdminUser(user)) {
            set.status = user ? 403 : 401;
            return { error: user ? "Forbidden" : "Unauthorized" };
        }

        let bankProfile = null;
        if (body.bankProfileId) {
            bankProfile = await db.select().from(bankProfiles).where(
                and(
                    eq(bankProfiles.id, body.bankProfileId),
                    eq(bankProfiles.tenantId, user.tenantId)
                )
            ).then((rows) => rows[0]);

            if (!bankProfile) {
                set.status = 404;
                return { error: "Bank profile not found" };
            }
        }

        const schedule = generateBankLoanSchedule({
            amount: body.amount.toFixed(2),
            interestRate: body.interestRate.toFixed(2),
            startDate: body.startDate,
            termMonths: body.termMonths,
            repaymentCycle: body.repaymentCycle,
            totalInstallments: body.totalInstallments,
            installmentAmount: body.installmentAmount?.toFixed(2),
            processingFeeAmount: body.processingFeeAmount?.toFixed(2),
            utilizationFeeAmount: body.utilizationFeeAmount?.toFixed(2),
            vatRate: body.vatRate?.toFixed(2),
        });

        const outstandingPrincipal = body.amount;
        const outstandingInterest = schedule.reduce((sum, row) => sum + Number(row.scheduledInterest), 0);
        const outstandingFees = schedule.reduce((sum, row) => sum + Number(row.scheduledFee) + Number(row.scheduledVat), 0);
        const nextDueDate = schedule[0]?.dueDate;

        const createdLoan = await db.transaction(async (tx) => {
            const createdLoan = await tx.insert(bankLoans).values({
                tenantId: user.tenantId,
                bankProfileId: body.bankProfileId,
                amount: body.amount.toFixed(2),
                interestRate: body.interestRate.toFixed(2),
                startDate: body.startDate,
                termMonths: body.termMonths,
                repaymentCycle: body.repaymentCycle,
                repaymentMode: body.repaymentMode,
                installmentAmount: body.installmentAmount?.toFixed(2),
                totalInstallments: body.totalInstallments ?? schedule.length,
                processingFeeAmount: (body.processingFeeAmount ?? 0).toFixed(2),
                utilizationFeeAmount: (body.utilizationFeeAmount ?? 0).toFixed(2),
                vatRate: (body.vatRate ?? 0).toFixed(2),
                lateFeeMode: body.lateFeeMode,
                lateFeeAmount: (body.lateFeeAmount ?? 0).toFixed(2),
                gracePeriodDays: body.gracePeriodDays ?? 0,
                nextDueDate,
                outstandingPrincipal: outstandingPrincipal.toFixed(2),
                outstandingInterest: outstandingInterest.toFixed(2),
                outstandingFees: outstandingFees.toFixed(2),
                outstandingPenalties: "0.00",
                status: "active",
                note: body.note,
            }).returning().then((rows) => rows[0]);

            if (schedule.length > 0) {
                await tx.insert(bankLoanSchedules).values(
                    schedule.map((row) => ({
                        tenantId: user.tenantId,
                        bankLoanId: createdLoan.id,
                        installmentNo: row.installmentNo,
                        dueDate: row.dueDate,
                        scheduledPrincipal: row.scheduledPrincipal,
                        scheduledInterest: row.scheduledInterest,
                        scheduledFee: row.scheduledFee,
                        scheduledVat: row.scheduledVat,
                        scheduledTotal: row.scheduledTotal,
                        remainingDue: row.remainingDue,
                        status: "pending",
                    }))
                );
            }

            await createAuditLog(tx, {
                tenantId: user.tenantId,
                actorUserId: user.id,
                entityType: "bank_loan",
                entityId: createdLoan.id,
                action: "created",
                payload: {
                    bankLoan: createdLoan,
                    scheduleCount: schedule.length,
                },
            });

            return createdLoan;
        });
        await invalidateTenantCache(user.tenantId);
        return createdLoan;
    }, {
        body: t.Object({
            bankProfileId: t.Optional(t.Number()),
            amount: t.Number(),
            interestRate: t.Number(),
            startDate: t.Optional(t.String()),
            termMonths: t.Optional(t.Number()),
            repaymentCycle: t.Optional(t.Union([
                t.Literal("daily"),
                t.Literal("weekly"),
                t.Literal("monthly"),
                t.Literal("custom"),
            ])),
            repaymentMode: t.Optional(t.Union([
                t.Literal("fixed_installment"),
                t.Literal("minimum_due"),
                t.Literal("interest_only"),
                t.Literal("custom"),
            ])),
            installmentAmount: t.Optional(t.Number()),
            totalInstallments: t.Optional(t.Number()),
            processingFeeAmount: t.Optional(t.Number()),
            utilizationFeeAmount: t.Optional(t.Number()),
            vatRate: t.Optional(t.Number()),
            lateFeeMode: t.Optional(t.Union([
                t.Literal("none"),
                t.Literal("fixed"),
                t.Literal("daily_percent"),
                t.Literal("fixed_plus_percent"),
            ])),
            lateFeeAmount: t.Optional(t.Number()),
            gracePeriodDays: t.Optional(t.Number()),
            note: t.Optional(t.String()),
        })
    })
    .post("/:id/repayments", async ({ params: { id }, body, user, set }) => {
        if (!isTenantAdminUser(user)) {
            set.status = user ? 403 : 401;
            return { error: user ? "Forbidden" : "Unauthorized" };
        }

        const bankLoan = await findBankLoanByPublicId(user.tenantId, id);
        const bankLoanId = bankLoan?.id ?? -1;

        const createdRepayment = await db.transaction(async (tx) => {
            const currentBankLoan = await tx.select().from(bankLoans).where(
                and(
                    eq(bankLoans.id, bankLoanId),
                    eq(bankLoans.tenantId, user.tenantId)
                )
            ).then((rows) => rows[0]);

            if (!currentBankLoan) {
                set.status = 404;
                return { error: "Bank loan not found" };
            }

            const resolvedSchedule = body.schedulePublicId
                ? await findBankLoanScheduleByPublicId(user.tenantId, body.schedulePublicId)
                : null;

            const targetSchedule = await tx.select().from(bankLoanSchedules).where(
                and(
                    eq(bankLoanSchedules.id, body.scheduleId ?? resolvedSchedule?.id ?? -1),
                    eq(bankLoanSchedules.bankLoanId, bankLoanId),
                    eq(bankLoanSchedules.tenantId, user.tenantId)
                )
            ).then((rows) => rows[0]);

            if (!targetSchedule) {
                set.status = 404;
                return { error: "Schedule not found" };
            }

            const scheduledPrincipal = Number(targetSchedule.scheduledPrincipal);
            const scheduledInterest = Number(targetSchedule.scheduledInterest);
            const scheduledFee = Number(targetSchedule.scheduledFee);
            const scheduledVat = Number(targetSchedule.scheduledVat);
            const currentPaid = Number(targetSchedule.paidTotal);
            const remainingDue = Number(targetSchedule.remainingDue);
            const paymentAmount = Number(body.amount);
            if (paymentAmount <= 0) {
                set.status = 400;
                return { error: "Payment amount must be greater than zero" };
            }

            let remainingPayment = paymentAmount;
            let totalPrincipalPaid = 0;
            let totalInterestPaid = 0;
            let totalFeePaid = 0;
            let totalVatPaid = 0;
            let totalPenaltyPaid = 0;

            const schedulesToPay = body.scheduleId
                ? [targetSchedule]
                : await tx.select().from(bankLoanSchedules).where(
                    and(
                        eq(bankLoanSchedules.bankLoanId, bankLoanId),
                        eq(bankLoanSchedules.tenantId, user.tenantId)
                    )
                ).orderBy(bankLoanSchedules.installmentNo).then((rows) =>
                    rows.filter((row) => Number(row.remainingDue) > 0)
                );

            const repayment = await tx.insert(bankLoanRepayments).values({
                tenantId: user.tenantId,
                bankLoanId,
                scheduleId: targetSchedule?.id ?? null,
                paymentDate: body.paymentDate ? new Date(body.paymentDate) : new Date(),
                amount: paymentAmount.toFixed(2),
                principalComponent: "0.00",
                interestComponent: "0.00",
                feeComponent: "0.00",
                vatComponent: "0.00",
                penaltyComponent: "0.00",
                paymentMethod: body.paymentMethod,
                reference: body.reference,
                note: body.note,
                recordedByUserId: user.id,
            }).returning().then((rows) => rows[0]);

            for (const schedule of schedulesToPay) {
                if (remainingPayment <= 0) break;

                const scheduledPrincipal = Number(schedule.scheduledPrincipal);
                const scheduledInterest = Number(schedule.scheduledInterest);
                const scheduledFee = Number(schedule.scheduledFee);
                const scheduledVat = Number(schedule.scheduledVat);
                const currentPaid = Number(schedule.paidTotal);
                const currentPaidPenalty = Number(schedule.paidPenalty);
                const currentRemainingDue = Number(schedule.remainingDue);
                const overdue = computeOverdueSnapshot({
                    dueDate: schedule.dueDate,
                    remainingDue: currentRemainingDue,
                    paidPenalty: currentPaidPenalty,
                    gracePeriodDays: currentBankLoan.gracePeriodDays,
                    lateFeeMode: currentBankLoan.lateFeeMode,
                    lateFeeAmount: currentBankLoan.lateFeeAmount,
                    baseStatus: schedule.status,
                    asOf: body.paymentDate || new Date(),
                });

                const penaltyStep = Math.min(remainingPayment, overdue.penaltyDue);
                totalPenaltyPaid += penaltyStep;
                remainingPayment -= penaltyStep;

                const amountForThisSchedule = Math.min(remainingPayment, currentRemainingDue);
                
                const principalRemainingInRow = Math.max(0, scheduledPrincipal - currentPaid);
                const principalStep = Math.min(amountForThisSchedule, principalRemainingInRow);
                
                const interestStep = Math.min(amountForThisSchedule - principalStep, scheduledInterest);
                const feeStep = Math.min(amountForThisSchedule - principalStep - interestStep, scheduledFee);
                const vatStep = Math.min(amountForThisSchedule - principalStep - interestStep - feeStep, scheduledVat);

                totalPrincipalPaid += principalStep;
                totalInterestPaid += interestStep;
                totalFeePaid += feeStep;
                totalVatPaid += vatStep;
                remainingPayment -= amountForThisSchedule;

                const newPaidTotal = Number((currentPaid + amountForThisSchedule).toFixed(2));
                const newPaidPenalty = Number((currentPaidPenalty + penaltyStep).toFixed(2));
                const newRemainingDue = Number(Math.max(0, currentRemainingDue - amountForThisSchedule).toFixed(2));
                const nextOverdue = computeOverdueSnapshot({
                    dueDate: schedule.dueDate,
                    remainingDue: newRemainingDue,
                    paidPenalty: newPaidPenalty,
                    gracePeriodDays: currentBankLoan.gracePeriodDays,
                    lateFeeMode: currentBankLoan.lateFeeMode,
                    lateFeeAmount: currentBankLoan.lateFeeAmount,
                    baseStatus: schedule.status,
                    asOf: body.paymentDate || new Date(),
                });

                await tx.update(bankLoanSchedules)
                    .set({
                        paidTotal: newPaidTotal.toFixed(2),
                        paidPenalty: newPaidPenalty.toFixed(2),
                        overdueDays: nextOverdue.overdueDays,
                        remainingDue: newRemainingDue.toFixed(2),
                        status: nextOverdue.effectiveStatus,
                        updatedAt: new Date(),
                    })
                    .where(eq(bankLoanSchedules.id, schedule.id));
            }

            if (remainingPayment > 0) {
                totalPenaltyPaid += remainingPayment;
            }

            await tx.update(bankLoanRepayments)
                .set({
                    principalComponent: totalPrincipalPaid.toFixed(2),
                    interestComponent: totalInterestPaid.toFixed(2),
                    feeComponent: totalFeePaid.toFixed(2),
                    vatComponent: totalVatPaid.toFixed(2),
                    penaltyComponent: totalPenaltyPaid.toFixed(2),
                })
                .where(eq(bankLoanRepayments.id, repayment.id));

            const updatedSchedules = await tx.select().from(bankLoanSchedules).where(
                and(
                    eq(bankLoanSchedules.bankLoanId, bankLoanId),
                    eq(bankLoanSchedules.tenantId, user.tenantId)
                )
            ).orderBy(bankLoanSchedules.installmentNo);

            const rollup = computeBankLoanRollup(updatedSchedules);
            const outstandingPenalties = updatedSchedules.reduce((sum, row) => {
                const overdue = computeOverdueSnapshot({
                    dueDate: row.dueDate,
                    remainingDue: row.remainingDue,
                    paidPenalty: row.paidPenalty,
                    gracePeriodDays: currentBankLoan.gracePeriodDays,
                    lateFeeMode: currentBankLoan.lateFeeMode,
                    lateFeeAmount: currentBankLoan.lateFeeAmount,
                    baseStatus: row.status,
                    asOf: body.paymentDate || new Date(),
                });
                return sum + overdue.penaltyDue;
            }, 0);

            await tx.update(bankLoans)
                .set(buildBankLoanRepaymentRollupUpdate(rollup, outstandingPenalties))
                .where(eq(bankLoans.id, bankLoanId));

            if (currentBankLoan.bankProfileId) {
                await tx.insert(fundLedgerEntries).values({
                    tenantId: user.tenantId,
                    bankProfileId: currentBankLoan.bankProfileId,
                    bankLoanId,
                    bankRepaymentId: repayment.id,
                    entryDate: body.paymentDate ? new Date(body.paymentDate) : new Date(),
                    entryType: "bank_repayment_out",
                    amount: paymentAmount.toFixed(2),
                    note: `Upstream repayment for drawdown ${bankLoanId}`,
                    createdByUserId: user.id,
                });
            }

            await createAuditLog(tx, {
                tenantId: user.tenantId,
                actorUserId: user.id,
                entityType: "bank_loan_repayment",
                entityId: repayment.id,
                action: "posted",
                payload: repayment,
            });

            return repayment;
        });
        await invalidateTenantCache(user.tenantId);
        return createdRepayment;
    }, {
        body: t.Object({
            scheduleId: t.Optional(t.Number()),
            schedulePublicId: t.Optional(t.String()),
            amount: t.Number(),
            paymentDate: t.Optional(t.String()),
            paymentMethod: t.Optional(t.String()),
            reference: t.Optional(t.String()),
            note: t.Optional(t.String()),
        })
    })
    .post("/:id/close", async ({ params: { id }, body, user, set }) => {
        if (!isTenantAdminUser(user)) {
            set.status = user ? 403 : 401;
            return { error: user ? "Forbidden" : "Unauthorized" };
        }

        const bankLoan = await findBankLoanByPublicId(user.tenantId, id);
        const bankLoanId = bankLoan?.id ?? -1;

        const updated = await db.transaction(async (tx) => {
            const bankLoan = await tx.select().from(bankLoans).where(
                and(
                    eq(bankLoans.id, bankLoanId),
                    eq(bankLoans.tenantId, user.tenantId)
                )
            ).then((rows) => rows[0]);

            if (!bankLoan) {
                set.status = 404;
                return { error: "Bank loan not found" };
            }

            if (bankLoan.status === "closed") {
                set.status = 400;
                return { error: "Bank loan is already closed" };
            }

            const updated = await tx.update(bankLoans)
                .set({
                    status: "closed",
                    closedAt: new Date(),
                    note: body.note ? `${bankLoan.note || ""}\nManual Close Note: ${body.note}` : bankLoan.note,
                    updatedAt: new Date(),
                })
                .where(eq(bankLoans.id, bankLoanId))
                .returning()
                .then((rows) => rows[0]);

            await createAuditLog(tx, {
                tenantId: user.tenantId,
                actorUserId: user.id,
                entityType: "bank_loan",
                entityId: bankLoanId,
                action: "closed",
                payload: {
                    before: bankLoan,
                    after: updated,
                    note: body.note,
                },
            });

            return updated;
        });
        await invalidateTenantCache(user.tenantId);
        return updated;
    }, {
        body: t.Object({
            note: t.Optional(t.String()),
        })
    });
