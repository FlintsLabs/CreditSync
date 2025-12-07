import { Elysia, t } from "elysia";
import { db } from "../db";
import { borrowers } from "../db/schema";
import { eq } from "drizzle-orm";

export const borrowersRoute = new Elysia({ prefix: "/borrowers" })
    .get("/", async () => {
        return await db.select().from(borrowers);
    })
    .get("/:id", async ({ params: { id } }) => {
        const result = await db.select().from(borrowers).where(eq(borrowers.id, parseInt(id)));
        return result[0];
    })
    .post("/", async ({ body }) => {
        const result = await db.insert(borrowers).values({
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
        const result = await db.update(borrowers).set({
            name: body.name,
            idCardNumber: body.idCardNumber,
            phone: body.phone,
            address: body.address,
            creditScore: body.creditScore,
            notes: body.notes
        }).where(eq(borrowers.id, parseInt(id))).returning();
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
