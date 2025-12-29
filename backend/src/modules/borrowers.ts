import { Elysia, t } from "elysia";
import { db } from "../db";
import { borrowers } from "../db/schema";
import { eq, and } from "drizzle-orm";

import { authPlugin } from "../middleware/auth";

import { extractTextFromImage } from "../lib/ocr";

export const borrowersRoute = new Elysia({ prefix: "/borrowers" })
    .use(authPlugin)
    .post("/extract-id-card", async ({ body, set }) => {
        const file = body.file;
        if (!file) {
            set.status = 400;
            return { error: "No file uploaded" };
        }

        try {
            const buffer = Buffer.from(await file.arrayBuffer());
            const text = await extractTextFromImage(buffer);

            // Simple heuristics for Thai ID Card
            // ID Number is usually 13 digits: \d{1} \d{4} \d{5} \d{2} \d{1} OR \d{13}
            const idMatch = text.match(/\d{1}\s?\d{4}\s?\d{5}\s?\d{2}\s?\d{1}/) || text.match(/\d{13}/);

            return {
                text,
                idCardNumber: idMatch ? idMatch[0].replace(/\s/g, '') : null
            };
        } catch (error) {
            set.status = 500;
            return { error: "OCR Failed" };
        }
    }, {
        body: t.Object({
            file: t.File()
        })
    })
    .get("/", async ({ user }) => {
        if (!user) return [];
        return await db.select().from(borrowers).where(eq(borrowers.tenantId, user.tenantId));
    })
    .get("/:id", async ({ params: { id }, user }) => {
        if (!user) return null;
        const result = await db.select().from(borrowers).where(
            and(
                eq(borrowers.id, parseInt(id)),
                eq(borrowers.tenantId, user.tenantId)
            )
        );
        return result[0];
    })
    .post("/", async ({ body, user }) => {
        if (!user) throw new Error("Unauthorized");
        const result = await db.insert(borrowers).values({
            tenantId: user.tenantId,
            name: body.name,
            idCardNumber: body.idCardNumber,
            phone: body.phone,
            address: body.address,
            creditScore: body.creditScore,
            notes: body.notes,
            idCardImageUrl: body.idCardImageUrl,
            tags: body.tags,
            googleMapsUrl: body.googleMapsUrl
        }).returning();
        return result[0];
    }, {
        body: t.Object({
            name: t.String(),
            idCardNumber: t.Optional(t.String()),
            phone: t.Optional(t.String()),
            address: t.Optional(t.String()),
            creditScore: t.Optional(t.Number()),
            notes: t.Optional(t.String()),
            idCardImageUrl: t.Optional(t.String()),
            tags: t.Optional(t.Array(t.String())),
            googleMapsUrl: t.Optional(t.String())
        })
    })
    .put("/:id", async ({ params: { id }, body, user }) => {
        if (!user) throw new Error("Unauthorized");
        const result = await db.update(borrowers).set({
            name: body.name,
            idCardNumber: body.idCardNumber,
            phone: body.phone,
            address: body.address,
            creditScore: body.creditScore,
            notes: body.notes,
            idCardImageUrl: body.idCardImageUrl,
            tags: body.tags,
            googleMapsUrl: body.googleMapsUrl
        }).where(
            and(
                eq(borrowers.id, parseInt(id)),
                eq(borrowers.tenantId, user.tenantId)
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
            notes: t.Optional(t.String()),
            idCardImageUrl: t.Optional(t.String()),
            tags: t.Optional(t.Array(t.String())),
            googleMapsUrl: t.Optional(t.String())
        })
    });
