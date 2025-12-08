import { Elysia, t } from "elysia";
import { db } from "../db";
import { bankProfiles } from "../db/schema";
import { eq, and } from "drizzle-orm";

export const bankProfilesRoute = new Elysia({ prefix: "/bank-profiles" })
    .get("/", async () => {
        // TODO: Get tenantId from context
        return await db.select().from(bankProfiles).where(eq(bankProfiles.tenantId, "default_tenant"));
    })
    .get("/:id", async ({ params: { id } }) => {
        // TODO: Get tenantId from context
        const result = await db.select().from(bankProfiles).where(
            and(
                eq(bankProfiles.id, parseInt(id)),
                eq(bankProfiles.tenantId, "default_tenant")
            )
        );
        return result[0];
    })
    .post("/", async ({ body }) => {
        // TODO: Get tenantId from context
        const result = await db.insert(bankProfiles).values({
            tenantId: "default_tenant", // Temporary default
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
    .delete("/:id", async ({ params: { id } }) => {
        // TODO: Get tenantId from context
        const result = await db.delete(bankProfiles).where(
            and(
                eq(bankProfiles.id, parseInt(id)),
                eq(bankProfiles.tenantId, "default_tenant")
            )
        ).returning();
        return result[0];
    });
