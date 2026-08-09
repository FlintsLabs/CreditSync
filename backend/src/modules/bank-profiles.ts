import { Elysia, t } from "elysia";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { bankLoans, bankProfiles, loanFundingAllocations } from "../db/schema";
import { authPlugin } from "../middleware/auth";
import { isTenantAdminUser } from "../lib/access";
import { deriveProfitabilityMetrics, getBankProfileSettlementSummary } from "../lib/fund-settlement";
import { createAuditLog } from "../lib/audit-log";
import { invalidateTenantCache, withTenantCache } from "../lib/cache";
import { findBankProfileByPublicId } from "../lib/public-id";

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
        ).then((rows) => Number(rows[0]?.totalAllocated ?? 0));

                return {
                    ...summary,
                    bankProfileId,
                    ...deriveProfitabilityMetrics(summary, Math.max(0, deployedPrincipal)),
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
