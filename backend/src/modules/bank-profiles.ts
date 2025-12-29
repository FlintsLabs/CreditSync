import { Elysia, t } from "elysia";
import { db } from "../db";
import { bankProfiles } from "../db/schema";
import { eq, and } from "drizzle-orm";

import { authPlugin } from "../middleware/auth";

export const bankProfilesRoute = new Elysia({ prefix: "/bank-profiles" })
    .use(authPlugin)
    .get("/", async ({ user }) => {
        if (!user) return [];
        return await db.select().from(bankProfiles).where(eq(bankProfiles.tenantId, user.tenantId));
    })
    .get("/:id", async ({ params: { id }, user }) => {
        if (!user) return null;
        const result = await db.select().from(bankProfiles).where(
            and(
                eq(bankProfiles.id, parseInt(id)),
                eq(bankProfiles.tenantId, user.tenantId)
            )
        );
        return result[0];
    })
    .post("/", async ({ body, user }) => {
        if (!user) throw new Error("Unauthorized");
        const result = await db.insert(bankProfiles).values({
            tenantId: user.tenantId,
            name: body.name,
            type: body.type,
            creditLimit: body.creditLimit?.toString()
        }).returning();
        return result[0];
    }, {
        body: t.Object({
            name: t.String(),
            type: t.String(),
            creditLimit: t.Optional(t.Union([t.Number(), t.String()])),
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
        return result[0];
    });
