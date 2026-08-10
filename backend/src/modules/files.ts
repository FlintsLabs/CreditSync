import { Elysia, t } from "elysia";
import { BUCKET_NAME, downloadFile, resolveStoredFileUrl, toStorageReference, uploadFile } from "../lib/storage";
import { db } from "../db";
import { files } from "../db/schema";
import { eq, and } from "drizzle-orm";
import { extractTextFromImage } from "../lib/ocr";

import { authPlugin } from "../middleware/auth";
import { fileAccessFilters } from "../lib/access";

export const filesRoute = new Elysia({ prefix: "/files" })
    .use(authPlugin)
    .post("/upload", async ({ body, set, user }) => {
        if (!user) {
            set.status = 401;
            return { error: "Unauthorized" };
        }
        const file = body.file;
        if (!file) {
            set.status = 400;
            return { error: "No file uploaded" };
        }

        const validTypes = ["image/jpeg", "image/png", "application/pdf"];
        if (!validTypes.includes(file.type)) {
            set.status = 400;
            return { error: "Invalid file type" };
        }

        const buffer = await file.arrayBuffer();
        const key = `uploads/${Date.now()}_${file.name}`;

        try {
            const uploaded = await uploadFile(key, Buffer.from(buffer), file.type);
            const fileRef = toStorageReference(uploaded);

            // Record in DB
            const result = await db.insert(files).values({
                tenantId: user.tenantId,
                ownerUserId: user.id,
                url: fileRef,
                key: uploaded.key,
                originalName: file.name,
                mimeType: file.type,
                size: file.size,
                bucket: uploaded.bucket
            }).returning();

            return {
                ...result[0],
                fileRef,
                url: await resolveStoredFileUrl(fileRef),
            };
        } catch (error) {
            console.error(error);
            set.status = 500;
            return { error: "Upload failed" };
        }
    }, {
        body: t.Object({
            file: t.File()
        })
    })
    .post("/ocr", async ({ body, set, user }) => {
        if (!user) {
            set.status = 401;
            return { error: "Unauthorized" };
        }

        const { fileId } = body;

        try {
            // Find file in DB
            const fileRecord = await db.select()
                .from(files)
                .where(and(eq(files.id, fileId), ...fileAccessFilters(user)))
                .then(res => res[0]);

            if (!fileRecord) {
                set.status = 404;
                return { error: "File not found" };
            }

            // Download file
            const buffer = await downloadFile(fileRecord.key, fileRecord.bucket);

            // Convert PDF to image if needed? core OCR handles images.
            // For now assume image.

            // Run OCR
            const text = await extractTextFromImage(buffer);

            return { success: true, text };

        } catch (error) {
            console.error("OCR Error", error);
            set.status = 500;
            return { error: "OCR extraction failed" };
        }
    }, {
        body: t.Object({
            fileId: t.Numeric()
        })
    })
    .get("/:id/access-url", async ({ params: { id }, set, user }) => {
        if (!user) {
            set.status = 401;
            return { error: "Unauthorized" };
        }

        const isPublicId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
        const fileRecord = await db.select()
            .from(files)
            .where(and(isPublicId ? eq(files.publicId, id) : eq(files.id, Number(id)), ...fileAccessFilters(user)))
            .then((rows) => rows[0]);

        if (!fileRecord) {
            set.status = 404;
            return { error: "File not found" };
        }

        const fileRef = fileRecord.url || toStorageReference({
            provider: process.env.STORAGE_PROVIDER === "azure-blob" ? "azure-blob" : "s3",
            bucket: fileRecord.bucket || BUCKET_NAME,
            key: fileRecord.key,
        });

        return {
            id: fileRecord.id,
            fileRef,
            url: await resolveStoredFileUrl(fileRef),
        };
    });
