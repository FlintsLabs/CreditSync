import { Elysia, t } from "elysia";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { bankLoans, bankProfiles, loanFundingAllocations } from "../db/schema";
import { authPlugin } from "../middleware/auth";
import { deriveProfitabilityMetrics, getBankProfileSettlementSummary } from "../lib/fund-settlement";
import { createAuditLog } from "../lib/audit-log";
import { invalidateTenantCache, withTenantCache } from "../lib/cache";

export const bankProfilesRoute = new Elysia({ prefix: "/bank-profiles" })
    .use(authPlugin)
    .get("/", async ({ user }) => {
        if (!user) return [];
        return await withTenantCache({
            tenantId: user.tenantId,
            namespace: "bank-profiles",
            key: "list",
            ttlSeconds: 60,
            loader: async () => await db.select().from(bankProfiles).where(eq(bankProfiles.tenantId, user.tenantId)),
        });
    })
    .get("/:id", async ({ params: { id }, user, set }) => {
        if (!user) return null;
        const result = await withTenantCache({
            tenantId: user.tenantId,
            namespace: "bank-profiles",
            key: `detail:${id}`,
            ttlSeconds: 60,
            loader: async () => await db.select().from(bankProfiles).where(
            and(
                eq(bankProfiles.id, parseInt(id)),
                eq(bankProfiles.tenantId, user.tenantId)
            )
        ),
        });
        if (!result[0]) {
            set.status = 404;
            return { error: "Bank profile not found" };
        }
        return result[0];
    })
    .get("/:id/settlement-summary", async ({ params: { id }, user, set }) => {
        if (!user) return null;

        const bankProfileId = parseInt(id);
        const profile = await db.query.bankProfiles.findFirst({
            where: and(eq(bankProfiles.id, bankProfileId), eq(bankProfiles.tenantId, user.tenantId)),
        });

        if (!profile) {
            set.status = 404;
            return { error: "Bank profile not found" };
        }

        const cached = await withTenantCache({
            tenantId: user.tenantId,
            namespace: "bank-profiles",
            key: `settlement:${bankProfileId}`,
            ttlSeconds: 30,
            loader: async () => {
                const drawdowns = await db.select().from(bankLoans).where(and(eq(bankLoans.bankProfileId, bankProfileId), eq(bankLoans.tenantId, user.tenantId)));
                const summary = await getBankProfileSettlementSummary(user.tenantId, bankProfileId);
                return {
                    bankProfileId,
                    drawdownCount: drawdowns.length,
                    ...summary,
                };
            },
        });

        return cached;
    })
    .get("/:id/profitability", async ({ params: { id }, user, set }) => {
        if (!user) return null;

        const bankProfileId = parseInt(id);
        const profile = await db.query.bankProfiles.findFirst({
            where: and(eq(bankProfiles.id, bankProfileId), eq(bankProfiles.tenantId, user.tenantId)),
        });

        if (!profile) {
            set.status = 404;
            return { error: "Bank profile not found" };
        }

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
        ).then((rows) => Number(rows[0]?.totalAllocated ?? 0));

                return {
            bankProfileId,
            ...summary,
            ...deriveProfitabilityMetrics(summary, Math.max(0, deployedPrincipal)),
                };
            },
        });
    })
    .post("/", async ({ body, user }) => {
        if (!user) throw new Error("Unauthorized");
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
            note: t.Optional(t.String()),
        })
    })
    .put("/:id", async ({ params: { id }, body, user, set }) => {
        if (!user) throw new Error("Unauthorized");
        return await db.transaction(async (tx) => {
            const existing = await tx.select().from(bankProfiles).where(
                and(
                    eq(bankProfiles.id, parseInt(id)),
                    eq(bankProfiles.tenantId, user.tenantId)
                )
            ).then((rows) => rows[0]);

            if (!existing) {
                set.status = 404;
                return { error: "Bank profile not found" };
            }

            const result = await tx.update(bankProfiles).set({
                name: body.name,
                type: body.type,
                creditLimit: body.creditLimit?.toString(),
                providerName: body.providerName,
                referenceNo: body.referenceNo,
                accountingMode: body.accountingMode,
                reinvestProfitMode: body.reinvestProfitMode,
                note: body.note,
                status: body.status,
                updatedAt: new Date(),
            }).where(
                and(
                    eq(bankProfiles.id, parseInt(id)),
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
            note: t.Optional(t.String()),
            status: t.Optional(t.String()),
        })
    })
    .delete("/:id", async ({ params: { id }, user }) => {
        if (!user) throw new Error("Unauthorized");
        const result = await db.delete(bankProfiles).where(
            and(
                eq(bankProfiles.id, parseInt(id)),
                eq(bankProfiles.tenantId, user.tenantId)
            )
        ).returning();
        await invalidateTenantCache(user.tenantId);
        return result[0];
    });
