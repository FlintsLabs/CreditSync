import { Elysia, t } from "elysia";
import { uploadFile, downloadFile } from "../lib/storage";
import { db } from "../db";
import { files } from "../db/schema";
import { eq, and } from "drizzle-orm";
import { extractTextFromImage } from "../lib/ocr";

import { authPlugin } from "../middleware/auth";

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
            const url = await uploadFile(key, Buffer.from(buffer), file.type);

            // Record in DB
            const result = await db.insert(files).values({
                tenantId: user.tenantId,
                url: url,
                key: key,
                originalName: file.name,
                mimeType: file.type,
                size: file.size,
                bucket: "creditsync-files"
            }).returning();

            return result[0];
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
                .where(and(
                    eq(files.id, fileId),
                    eq(files.tenantId, user.tenantId)
                ))
                .then(res => res[0]);

            if (!fileRecord) {
                set.status = 404;
                return { error: "File not found" };
            }

            // Download file
            const buffer = await downloadFile(fileRecord.key);

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
    });
