import { Elysia, t } from "elysia";
import { uploadFile } from "../lib/storage";
import { db } from "../db";
import { files } from "../db/schema";

export const filesRoute = new Elysia({ prefix: "/files" })
    .post("/upload", async ({ body, set }) => {
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
                tenantId: "default_tenant", // TODO: Context
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
    });
