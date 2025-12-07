import { Elysia, t } from "elysia";
import { db } from "../db";
import { bankProfiles } from "../db/schema";
import { eq } from "drizzle-orm";

export const bankProfilesRoute = new Elysia({ prefix: "/bank-profiles" })
    .get("/", async () => {
        return await db.select().from(bankProfiles);
    })
    .get("/:id", async ({ params: { id } }) => {
        const result = await db.select().from(bankProfiles).where(eq(bankProfiles.id, parseInt(id)));
        return result[0];
    })
    .post("/", async ({ body }) => {
        const result = await db.insert(bankProfiles).values({
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
        const result = await db.delete(bankProfiles).where(eq(bankProfiles.id, parseInt(id))).returning();
        return result[0];
    });
