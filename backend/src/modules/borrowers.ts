import { Elysia, t } from "elysia";
import { db } from "../db";
import { borrowers } from "../db/schema";
import { eq, and } from "drizzle-orm";

export const borrowersRoute = new Elysia({ prefix: "/borrowers" })
    .get("/", async () => {
        // TODO: Get tenantId from context
        return await db.select().from(borrowers).where(eq(borrowers.tenantId, "default_tenant"));
    })
    .get("/:id", async ({ params: { id } }) => {
        // TODO: Get tenantId from context
        const result = await db.select().from(borrowers).where(
            and(
                eq(borrowers.id, parseInt(id)),
                eq(borrowers.tenantId, "default_tenant")
            )
        );
        return result[0];
    })
    .post("/", async ({ body }) => {
        // TODO: Get tenantId from context
        const result = await db.insert(borrowers).values({
            tenantId: "default_tenant", // Temporary default
            name: body.name,
            idCardNumber: body.idCardNumber,
            phone: body.phone,
            address: body.address,
            creditScore: body.creditScore,
            notes: body.notes
        }).returning();
        return result[0];
    }, {
        body: t.Object({
            name: t.String(),
            idCardNumber: t.Optional(t.String()),
            phone: t.Optional(t.String()),
            address: t.Optional(t.String()),
            creditScore: t.Optional(t.Number()),
            notes: t.Optional(t.String())
        })
    })
    .put("/:id", async ({ params: { id }, body }) => {
        // TODO: Get tenantId from context
        const result = await db.update(borrowers).set({
            name: body.name,
            idCardNumber: body.idCardNumber,
            phone: body.phone,
            address: body.address,
            creditScore: body.creditScore,
            notes: body.notes
        }).where(
            and(
                eq(borrowers.id, parseInt(id)),
                eq(borrowers.tenantId, "default_tenant")
            )
        ).returning();
        return result[0];
    }, {
        body: t.Object({
            name: t.Optional(t.String()),
            idCardNumber: t.Optional(t.String()),
            phone: t.Optional(t.String()),
            address: t.Optional(t.String()),
            creditScore: t.Optional(t.Number()),
            notes: t.Optional(t.String())
        })
    });
