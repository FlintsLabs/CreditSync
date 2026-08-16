import { Elysia, t } from "elysia";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { bankLoans, bankProfiles, borrowers, loanFundingAllocations, loans, transactions } from "../db/schema";
import { authPlugin } from "../middleware/auth";
import { isTenantAdminUser } from "../lib/access";
import { calculateOpportunityCost, deriveProfitabilityMetrics, getBankProfileSettlementSummary } from "../lib/fund-settlement";
import Decimal from "decimal.js";
import { createAuditLog } from "../lib/audit-log";
import { invalidateTenantCache, withTenantCache } from "../lib/cache";
import { findBankProfileByPublicId } from "../lib/public-id";
import { serializeMoney } from "../lib/money";

function serializeSignedMoney(value: Decimal.Value): string {
    const amount = new Decimal(value);
    if (!amount.isFinite()) throw new Error("Funding usage amount must be finite");
    return amount.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

function bangkokBusinessDate(now = new Date()) {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(now);
    const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
    return `${value("year")}-${value("month")}-${value("day")}`;
}

export const bankProfilesRoute = new Elysia({ prefix: "/bank-profiles" })
    .use(authPlugin)
    .get("/", async ({ user, set }) => {
        if (!isTenantAdminUser(user)) {
            set.status = user ? 403 : 401;
            return { error: user ? "Forbidden" : "Unauthorized" };
        }
        return await withTenantCache({
            tenantId: user.tenantId,
            namespace: "bank-profiles",
            key: "list",
            ttlSeconds: 60,
            loader: async () => await db.select().from(bankProfiles).where(eq(bankProfiles.tenantId, user.tenantId)),
        });
    })
    .get("/:id", async ({ params: { id }, user, set }) => {
        if (!isTenantAdminUser(user)) {
            set.status = user ? 403 : 401;
            return { error: user ? "Forbidden" : "Unauthorized" };
        }
        const profile = await findBankProfileByPublicId(user.tenantId, id);
        if (!profile) {
            set.status = 404;
            return { error: "Bank profile not found" };
        }
        const result = await withTenantCache({
            tenantId: user.tenantId,
            namespace: "bank-profiles",
            key: `detail:${id}`,
            ttlSeconds: 60,
            loader: async () => [profile],
        });
        return result[0];
    })
    .get("/:id/funding-usage", async ({ params: { id }, query, user, set }) => {
        if (!isTenantAdminUser(user)) {
            set.status = user ? 403 : 401;
            return { error: user ? "Forbidden" : "Unauthorized" };
        }
        const profile = await findBankProfileByPublicId(user.tenantId, id);
        if (!profile) {
            set.status = 404;
            return { error: "Bank profile not found" };
        }

        const includeSettled = query.includeSettled === "true";
        return await withTenantCache({
            tenantId: user.tenantId,
            namespace: "bank-profiles",
            key: `funding-usage:${profile.id}:settled=${includeSettled}`,
            ttlSeconds: 20,
            loader: async () => {
                const [allocationRows, drawdowns] = await Promise.all([
                    db.select({
                        loanId: loanFundingAllocations.loanId,
                        loanPublicId: loans.publicId,
                        borrowerPublicId: borrowers.publicId,
                        borrowerName: borrowers.name,
                        loanStatus: loans.status,
                        principalAmount: loans.principalAmount,
                        outstandingPrincipal: loans.outstandingPrincipal,
                        allocatedAmount: loanFundingAllocations.allocatedAmount,
                        allocationDate: loanFundingAllocations.allocationDate,
                        bankLoanId: loanFundingAllocations.bankLoanId,
                        bankLoanPublicId: bankLoans.publicId,
                    }).from(loanFundingAllocations)
                        .leftJoin(loans, eq(loanFundingAllocations.loanId, loans.id))
                        .leftJoin(borrowers, eq(loans.borrowerId, borrowers.id))
                        .leftJoin(bankLoans, eq(loanFundingAllocations.bankLoanId, bankLoans.id))
                        .where(and(
                            eq(loanFundingAllocations.tenantId, user.tenantId),
                            eq(loanFundingAllocations.bankProfileId, profile.id),
                        )),
                    db.select({ amount: bankLoans.amount }).from(bankLoans).where(and(
                        eq(bankLoans.tenantId, user.tenantId),
                        eq(bankLoans.bankProfileId, profile.id),
                    )),
                ]);

                const byLoan = new Map<number, {
                    loanId: number;
                    loanPublicId: string;
                    borrowerPublicId: string | null;
                    borrowerName: string | null;
                    loanStatus: string;
                    principalAmount: string;
                    outstandingPrincipal: string;
                    netAllocatedAmount: Decimal;
                    latestAllocationDate: string;
                    routes: Map<string, { type: "direct" | "drawdown"; bankLoanPublicId: string | null; netAllocatedAmount: Decimal }>;
                }>();
                for (const row of allocationRows) {
                    if (!row.loanPublicId || !row.loanStatus || row.principalAmount === null || row.outstandingPrincipal === null) continue;
                    const current = byLoan.get(row.loanId) ?? {
                        loanId: row.loanId,
                        loanPublicId: row.loanPublicId,
                        borrowerPublicId: row.borrowerPublicId,
                        borrowerName: row.borrowerName,
                        loanStatus: row.loanStatus,
                        principalAmount: row.principalAmount,
                        outstandingPrincipal: row.outstandingPrincipal,
                        netAllocatedAmount: new Decimal(0),
                        latestAllocationDate: row.allocationDate,
                        routes: new Map(),
                    };
                    const type = row.bankLoanId === null ? "direct" as const : "drawdown" as const;
                    const routeKey = row.bankLoanId === null ? "direct" : `drawdown:${row.bankLoanId}`;
                    const route = current.routes.get(routeKey) ?? { type, bankLoanPublicId: row.bankLoanPublicId, netAllocatedAmount: new Decimal(0) };
                    const amount = new Decimal(row.allocatedAmount);
                    current.netAllocatedAmount = current.netAllocatedAmount.plus(amount);
                    route.netAllocatedAmount = route.netAllocatedAmount.plus(amount);
                    current.routes.set(routeKey, route);
                    if (row.allocationDate > current.latestAllocationDate) current.latestAllocationDate = row.allocationDate;
                    byLoan.set(row.loanId, current);
                }

                const allocatedLoans = [...byLoan.values()].filter((row) => row.netAllocatedAmount.gt(0));
                const allocatedLoanIds = allocatedLoans.map((row) => row.loanId);
                const [totalAllocationRows, transactionRows, interestRows] = allocatedLoanIds.length > 0
                    ? await Promise.all([
                        db.select({
                            loanId: loanFundingAllocations.loanId,
                            total: sql<string>`coalesce(sum(${loanFundingAllocations.allocatedAmount}) filter (where ${loanFundingAllocations.allocatedAmount} > 0), 0)`,
                        }).from(loanFundingAllocations).where(and(
                            eq(loanFundingAllocations.tenantId, user.tenantId),
                            inArray(loanFundingAllocations.loanId, allocatedLoanIds),
                        )).groupBy(loanFundingAllocations.loanId),
                        db.select({
                            loanId: transactions.loanId,
                            total: sql<string>`coalesce(sum(${transactions.amount}), 0)`,
                        }).from(transactions).where(and(
                            eq(transactions.tenantId, user.tenantId),
                            inArray(transactions.loanId, allocatedLoanIds),
                        )).groupBy(transactions.loanId),
                        db.select({
                            loanId: transactions.loanId,
                            total: sql<string>`coalesce(sum(${transactions.interestComponent}), 0)`,
                        }).from(transactions).where(and(
                            eq(transactions.tenantId, user.tenantId),
                            inArray(transactions.loanId, allocatedLoanIds),
                        )).groupBy(transactions.loanId),
                    ])
                    : [[], [], []];
                const totalAllocationByLoan = new Map(totalAllocationRows.map((row) => [row.loanId, new Decimal(row.total)]));
                const transactionTotalByLoan = new Map(transactionRows.map((row) => [row.loanId, new Decimal(row.total)]));
                const netInterestByLoan = new Map(interestRows.map((row) => [row.loanId, new Decimal(row.total)]));
                const netAllocatedPrincipal = allocatedLoans.reduce((total, row) => total.plus(row.netAllocatedAmount), new Decimal(0));
                const drawdownTotal = drawdowns.reduce((total, row) => total.plus(row.amount), new Decimal(0));
                const creditLimit = new Decimal(profile.creditLimit ?? 0);
                const capitalPool = profile.accountingMode === "capital_pool";
                const utilizedAmount = capitalPool ? netAllocatedPrincipal : drawdownTotal;
                const linkedBorrowerCashCollected = capitalPool
                    ? allocatedLoans.reduce((total, row) => {
                        const totalAllocation = totalAllocationByLoan.get(row.loanId) ?? new Decimal(0);
                        const fundingShare = totalAllocation.gt(0)
                            ? Decimal.max(row.netAllocatedAmount, 0).div(totalAllocation)
                            : new Decimal(0);
                        return total.plus((transactionTotalByLoan.get(row.loanId) ?? new Decimal(0)).times(fundingShare));
                    }, new Decimal(0))
                    : new Decimal(0);
                const availableAmount = capitalPool
                    ? creditLimit.minus(netAllocatedPrincipal).plus(linkedBorrowerCashCollected)
                    : creditLimit.minus(utilizedAmount);
                const utilizationPercent = creditLimit.gt(0)
                    ? utilizedAmount.times(100).div(creditLimit).toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
                    : new Decimal(0);
                const allocations = allocatedLoans
                    .filter((row) => includeSettled || new Decimal(row.outstandingPrincipal).gt(0))
                    .sort((left, right) => right.latestAllocationDate.localeCompare(left.latestAllocationDate))
                    .map((row) => {
                        const totalAllocation = totalAllocationByLoan.get(row.loanId) ?? new Decimal(0);
                        const netInterest = Decimal.max(netInterestByLoan.get(row.loanId) ?? 0, 0);
                        const fundingShare = totalAllocation.gt(0)
                            ? Decimal.max(row.netAllocatedAmount, 0).div(totalAllocation)
                            : new Decimal(0);
                        const linkedCash = capitalPool
                            ? (transactionTotalByLoan.get(row.loanId) ?? new Decimal(0)).times(fundingShare)
                            : new Decimal(0);
                        return {
                        loanPublicId: row.loanPublicId,
                        borrowerPublicId: row.borrowerPublicId,
                        borrowerName: row.borrowerName,
                        loanStatus: row.loanStatus,
                        principalAmount: serializeMoney(row.principalAmount),
                        outstandingPrincipal: serializeMoney(row.outstandingPrincipal),
                        netAllocatedAmount: serializeMoney(row.netAllocatedAmount),
                        linkedBorrowerCashCollected: serializeMoney(linkedCash),
                        collectedInterest: serializeMoney(netInterest.times(fundingShare)),
                        latestAllocationDate: row.latestAllocationDate,
                        fundingRoutes: [...row.routes.values()]
                            .filter((route) => route.netAllocatedAmount.gt(0))
                            .map((route) => ({
                                type: route.type,
                                bankLoanPublicId: route.bankLoanPublicId,
                                netAllocatedAmount: serializeMoney(route.netAllocatedAmount),
                            })),
                        };
                    });

                return {
                    accountingMode: profile.accountingMode,
                    creditLimit: serializeMoney(creditLimit),
                    netAllocatedPrincipal: serializeMoney(netAllocatedPrincipal),
                    availableAmount: serializeSignedMoney(availableAmount),
                    linkedBorrowerCashCollected: serializeMoney(linkedBorrowerCashCollected),
                    utilizationPercent: utilizationPercent.toFixed(2),
                    allocations,
                };
            },
        });
    }, {
        query: t.Object({ includeSettled: t.Optional(t.String()) }),
    })
    .get("/:id/settlement-summary", async ({ params: { id }, user, set }) => {
        if (!isTenantAdminUser(user)) {
            set.status = user ? 403 : 401;
            return { error: user ? "Forbidden" : "Unauthorized" };
        }
        const profile = await findBankProfileByPublicId(user.tenantId, id);

        if (!profile) {
            set.status = 404;
            return { error: "Bank profile not found" };
        }

        const bankProfileId = profile.id;

        const cached = await withTenantCache({
            tenantId: user.tenantId,
            namespace: "bank-profiles",
            key: `settlement:${bankProfileId}`,
            ttlSeconds: 30,
            loader: async () => {
                const drawdowns = await db.select().from(bankLoans).where(and(eq(bankLoans.bankProfileId, bankProfileId), eq(bankLoans.tenantId, user.tenantId)));
                const summary = await getBankProfileSettlementSummary(user.tenantId, bankProfileId);
                return {
                    ...summary,
                    bankProfileId,
                    drawdownCount: drawdowns.length,
                };
            },
        });

        return cached;
    })
    .get("/:id/profitability", async ({ params: { id }, user, set }) => {
        if (!isTenantAdminUser(user)) {
            set.status = user ? 403 : 401;
            return { error: user ? "Forbidden" : "Unauthorized" };
        }
        const profile = await findBankProfileByPublicId(user.tenantId, id);

        if (!profile) {
            set.status = 404;
            return { error: "Bank profile not found" };
        }

        const bankProfileId = profile.id;

        return await withTenantCache({
            tenantId: user.tenantId,
            namespace: "bank-profiles",
            key: `profitability:${bankProfileId}`,
            ttlSeconds: 30,
            loader: async () => {
                const summary = await getBankProfileSettlementSummary(user.tenantId, bankProfileId);
                const deployedPrincipal = await db.select({
            totalAllocated: sql<string>`coalesce(sum(${loanFundingAllocations.allocatedAmount}), 0)`,
        }).from(loanFundingAllocations).where(
            and(
                eq(loanFundingAllocations.tenantId, user.tenantId),
                eq(loanFundingAllocations.bankProfileId, bankProfileId),
            )
        ).then((rows) => rows[0]?.totalAllocated ?? "0");
                const allocations = profile.accountingMode === "capital_pool"
                    ? await db.select({ allocatedAmount: loanFundingAllocations.allocatedAmount, allocationDate: loanFundingAllocations.allocationDate })
                        .from(loanFundingAllocations).where(and(
                            eq(loanFundingAllocations.tenantId, user.tenantId),
                            eq(loanFundingAllocations.bankProfileId, bankProfileId),
                        ))
                    : [];
                const asOfDate = bangkokBusinessDate();
                const opportunityCostAccrued = allocations.reduce((total, allocation) => {
                    if (new Decimal(allocation.allocatedAmount).lte(0)) return total;
                    return total.plus(calculateOpportunityCost({
                        principal: allocation.allocatedAmount,
                        annualRate: profile.opportunityCostRate,
                        allocationDate: allocation.allocationDate,
                        asOfDate,
                    }));
                }, new Decimal(0)).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
                const metrics = deriveProfitabilityMetrics(summary, deployedPrincipal);

                return {
                    ...summary,
                    bankProfileId,
                    ...metrics,
                    opportunityCostAccrued: opportunityCostAccrued.toFixed(2),
                    economicSpread: new Decimal(metrics.realizedSpread).minus(opportunityCostAccrued).toFixed(2),
                };
            },
        });
    })
    .post("/", async ({ body, user, set }) => {
        if (!user || !["owner", "manager"].includes(user.role)) {
            set.status = 403;
            return { error: "Forbidden" };
        }
        return await db.transaction(async (tx) => {
            const result = await tx.insert(bankProfiles).values({
                tenantId: user.tenantId,
                name: body.name,
                type: body.type,
                creditLimit: body.creditLimit?.toString(),
                providerName: body.providerName,
                referenceNo: body.referenceNo,
                accountingMode: body.accountingMode ?? "external_liability",
                reinvestProfitMode: body.reinvestProfitMode ?? "manual_distribution",
                opportunityCostRate: body.opportunityCostRate?.toString() ?? "2.00",
                note: body.note,
            }).returning();

            await createAuditLog(tx, {
                tenantId: user.tenantId,
                actorUserId: user.id,
                entityType: "bank_profile",
                entityId: result[0].id,
                action: "created",
                payload: result[0],
            });

            await invalidateTenantCache(user.tenantId);

            return result[0];
        });
    }, {
        body: t.Object({
            name: t.String(),
            type: t.String(),
            creditLimit: t.Optional(t.Union([t.Number(), t.String()])),
            providerName: t.Optional(t.String()),
            referenceNo: t.Optional(t.String()),
            accountingMode: t.Optional(t.String()),
            reinvestProfitMode: t.Optional(t.String()),
            opportunityCostRate: t.Optional(t.Union([t.Number(), t.String()])),
            note: t.Optional(t.String()),
        })
    })
    .put("/:id", async ({ params: { id }, body, user, set }) => {
        if (!isTenantAdminUser(user)) {
            set.status = user ? 403 : 401;
            return { error: user ? "Forbidden" : "Unauthorized" };
        }
        return await db.transaction(async (tx) => {
            const target = await findBankProfileByPublicId(user.tenantId, id);
            if (!target) {
                set.status = 404;
                return { error: "Bank profile not found" };
            }
            const existing = await tx.select().from(bankProfiles).where(
                and(
                    eq(bankProfiles.id, target.id),
                    eq(bankProfiles.tenantId, user.tenantId)
                )
            ).then((rows) => rows[0]);

            const result = await tx.update(bankProfiles).set({
                name: body.name,
                type: body.type,
                creditLimit: body.creditLimit?.toString(),
                providerName: body.providerName,
                referenceNo: body.referenceNo,
                accountingMode: body.accountingMode,
                reinvestProfitMode: body.reinvestProfitMode,
                opportunityCostRate: body.opportunityCostRate?.toString(),
                note: body.note,
                status: body.status,
                updatedAt: new Date(),
            }).where(
                and(
                    eq(bankProfiles.id, target.id),
                    eq(bankProfiles.tenantId, user.tenantId)
                )
            ).returning();

            await createAuditLog(tx, {
                tenantId: user.tenantId,
                actorUserId: user.id,
                entityType: "bank_profile",
                entityId: result[0].id,
                action: "updated",
                payload: {
                    before: existing,
                    after: result[0],
                },
            });

            await invalidateTenantCache(user.tenantId);

            return result[0];
        });
    }, {
        body: t.Object({
            name: t.String(),
            type: t.String(),
            creditLimit: t.Optional(t.Union([t.Number(), t.String()])),
            providerName: t.Optional(t.String()),
            referenceNo: t.Optional(t.String()),
            accountingMode: t.Optional(t.String()),
            reinvestProfitMode: t.Optional(t.String()),
            opportunityCostRate: t.Optional(t.Union([t.Number(), t.String()])),
            note: t.Optional(t.String()),
            status: t.Optional(t.String()),
        })
    })
    .delete("/:id", async ({ params: { id }, user, set }) => {
        if (!user || !["owner", "manager"].includes(user.role)) {
            set.status = 403;
            return { error: "Forbidden" };
        }
        const target = await findBankProfileByPublicId(user.tenantId, id);
        if (!target) {
            return null;
        }
        const result = await db.delete(bankProfiles).where(
            and(
                eq(bankProfiles.id, target.id),
                eq(bankProfiles.tenantId, user.tenantId)
            )
        ).returning();
        await invalidateTenantCache(user.tenantId);
        return result[0];
    });
