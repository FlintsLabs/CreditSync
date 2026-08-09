import { Elysia, t } from "elysia";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import { auditLogs } from "../db/schema";
import { authPlugin } from "../middleware/auth";
import { isTenantAdminUser } from "../lib/access";

export const auditLogsRoute = new Elysia({ prefix: "/audit-logs" })
    .use(authPlugin)
    .get("/", async ({ user, query, set }) => {
        if (!isTenantAdminUser(user)) {
            set.status = user ? 403 : 401;
            return { error: user ? "Forbidden" : "Unauthorized" };
        }

        const rows = await db.select().from(auditLogs).where(eq(auditLogs.tenantId, user.tenantId)).orderBy(desc(auditLogs.createdAt));

        return rows.filter((row) => {
            if (query.entityType && row.entityType !== query.entityType) return false;
            if (query.entityId && row.entityId !== query.entityId) return false;
            if (query.actorUserId && row.actorUserId !== Number(query.actorUserId)) return false;
            return true;
        });
    }, {
        query: t.Object({
            entityType: t.Optional(t.String()),
            entityId: t.Optional(t.String()),
            actorUserId: t.Optional(t.String()),
        })
    })
    .get("/:entityType/:entityId", async ({ params, user, set }) => {
        if (!isTenantAdminUser(user)) {
            set.status = user ? 403 : 401;
            return { error: user ? "Forbidden" : "Unauthorized" };
        }

        return await db.select().from(auditLogs).where(
            and(
                eq(auditLogs.tenantId, user.tenantId),
                eq(auditLogs.entityType, params.entityType),
                eq(auditLogs.entityId, params.entityId),
            )
        ).orderBy(desc(auditLogs.createdAt));
    }, {
        params: t.Object({
            entityType: t.String(),
            entityId: t.String(),
        })
    });
