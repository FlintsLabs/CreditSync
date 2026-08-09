import { Elysia } from "elysia";
import { messagingApi, validateSignature, WebhookEvent } from "@line/bot-sdk";
import { db } from "../db";
import { files, botUploads } from "../db/schema";
import { toStorageReference, uploadFile } from "../lib/storage";

const { MessagingApiBlobClient } = messagingApi;

const isProd = process.env.NODE_ENV === "production";
const channelSecret = process.env.LINE_CHANNEL_SECRET || (isProd ? undefined : "dev_line_secret");
const channelAccessToken = process.env.LINE_CHANNEL_ACCESS_TOKEN || (isProd ? undefined : "dev_line_access_token");
const lineTenantId = process.env.LINE_TENANT_ID;
if (!channelSecret || !channelAccessToken) {
    throw new Error("LINE_CHANNEL_SECRET and LINE_CHANNEL_ACCESS_TOKEN are required in production");
}

const blobClient = new MessagingApiBlobClient({
    channelAccessToken: channelAccessToken,
});

export const webhookRoute = new Elysia({ prefix: "/webhook" })
    .post("/line", async ({ request, set }) => {
        const signature = request.headers.get("x-line-signature");
        const bodyText = await request.text();

        if (!signature || !validateSignature(bodyText, channelSecret, signature)) {
            set.status = 401;
            return { error: "Invalid signature" };
        }

        const body = JSON.parse(bodyText);
        const events: WebhookEvent[] = body.events;

        for (const event of events) {
            if (event.type === "message" && event.message.type === "image") {
                try {
                    const messageId = event.message.id;
                    const userId = event.source.userId;

                    // 1. Get Image Content
                    const stream = await blobClient.getMessageContent(messageId);

                    // Convert stream to buffer
                    const chunks: any[] = [];
                    // @ts-ignore
                    for await (const chunk of stream) {
                        chunks.push(chunk);
                    }
                    const buffer = Buffer.concat(chunks);

                    // 2. Upload to MinIO
                    const timestamp = Date.now();
                    const fileName = `line_${userId}_${timestamp}.jpg`; // Line images are usually JPEGs
                    const key = `uploads/bot/${fileName}`;
                    const mimeType = "image/jpeg";

                    const uploaded = await uploadFile(key, buffer, mimeType);
                    const fileRef = toStorageReference(uploaded);

                    // 3. Save to DB
                    // Create File Record
                    if (!lineTenantId) {
                        throw new Error("LINE_TENANT_ID is not configured");
                    }
                    const fileRecord = await db.insert(files).values({
                        tenantId: lineTenantId,
                        bucket: uploaded.bucket,
                        key: uploaded.key,
                        originalName: fileName,
                        mimeType: mimeType,
                        size: buffer.length,
                        url: fileRef
                    }).returning();

                    // Create Bot Upload Record
                    await db.insert(botUploads).values({
                        tenantId: lineTenantId,
                        fileId: fileRecord[0].id,
                        source: "line",
                        senderId: userId,
                        status: "pending"
                    });

                    console.log(`[Webhook] Saved image from ${userId} to ${key}`);

                } catch (error) {
                    console.error("[Webhook] Error handling image:", error);
                }
            }
        }

        return { success: true };
    });
