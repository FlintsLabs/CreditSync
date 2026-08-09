import { Elysia, t } from "elysia";
import { db } from "../db";
import { borrowers } from "../db/schema";
import { eq, and } from "drizzle-orm";

import { authPlugin } from "../middleware/auth";
import { borrowerAccessFilters, getAccessScopeCacheKey } from "../lib/access";

import { extractTextFromImage } from "../lib/ocr";
import { createAuditLog } from "../lib/audit-log";
import { invalidateTenantCache, withTenantCache } from "../lib/cache";
import { findAccessibleBorrowerByPublicId } from "../lib/public-id";
import { resolveStoredFileUrl } from "../lib/storage";

async function hydrateBorrowerMedia<T extends { photoUrl?: string | null; idCardImageUrl?: string | null }>(borrower: T) {
    return {
        ...borrower,
        photoRef: borrower.photoUrl ?? null,
        photoUrl: await resolveStoredFileUrl(borrower.photoUrl),
        idCardImageRef: borrower.idCardImageUrl ?? null,
        idCardImageUrl: await resolveStoredFileUrl(borrower.idCardImageUrl),
    };
}

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
        const scopeKey = getAccessScopeCacheKey(user);
        return await withTenantCache({
            tenantId: user.tenantId,
            namespace: "borrowers",
            key: `list:${scopeKey}`,
            ttlSeconds: 60,
            loader: async () => {
                const rows = await db.select().from(borrowers).where(and(...borrowerAccessFilters(user)));
                return await Promise.all(rows.map((row) => hydrateBorrowerMedia(row)));
            },
        });
    })
    .get("/:id", async ({ params: { id }, user }) => {
        if (!user) return null;
        const borrower = await findAccessibleBorrowerByPublicId(user, id);
        if (!borrower) return null;
        const scopeKey = getAccessScopeCacheKey(user);
        const result = await withTenantCache({
            tenantId: user.tenantId,
            namespace: "borrowers",
            key: `detail:${id}:${scopeKey}`,
            ttlSeconds: 60,
            loader: async () => {
                const rows = await db.select().from(borrowers).where(and(eq(borrowers.id, borrower.id), ...borrowerAccessFilters(user)));
                return await Promise.all(rows.map((row) => hydrateBorrowerMedia(row)));
            },
        });
        return result[0];
    })
    .post("/", async ({ body, user }) => {
        if (!user) throw new Error("Unauthorized");
        return await db.transaction(async (tx) => {
            const result = await tx.insert(borrowers).values({
                tenantId: user.tenantId,
                ownerUserId: user.id,
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

            await createAuditLog(tx, {
                tenantId: user.tenantId,
                actorUserId: user.id,
                entityType: "borrower",
                entityId: result[0].id,
                action: "created",
                payload: result[0],
            });

            await invalidateTenantCache(user.tenantId);
            return await hydrateBorrowerMedia(result[0]);
        });
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
    .put("/:id", async ({ params: { id }, body, user, set }) => {
        if (!user) throw new Error("Unauthorized");
        return await db.transaction(async (tx) => {
            const borrower = await findAccessibleBorrowerByPublicId(user, id);
            if (!borrower) {
                set.status = 404;
                return { error: "Borrower not found" };
            }
            const existing = await tx.select().from(borrowers).where(
                and(eq(borrowers.id, borrower.id), ...borrowerAccessFilters(user))
            ).then((rows) => rows[0]);

            const result = await tx.update(borrowers).set({
                name: body.name,
                idCardNumber: body.idCardNumber,
                phone: body.phone,
                address: body.address,
                creditScore: body.creditScore,
                notes: body.notes,
                idCardImageUrl: body.idCardImageUrl,
                tags: body.tags,
                googleMapsUrl: body.googleMapsUrl,
                updatedAt: new Date(),
            }).where(
                and(eq(borrowers.id, borrower.id), ...borrowerAccessFilters(user))
            ).returning();

            await createAuditLog(tx, {
                tenantId: user.tenantId,
                actorUserId: user.id,
                entityType: "borrower",
                entityId: result[0].id,
                action: "updated",
                payload: {
                    before: existing,
                    after: result[0],
                },
            });

            await invalidateTenantCache(user.tenantId);
            return await hydrateBorrowerMedia(result[0]);
        });
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
