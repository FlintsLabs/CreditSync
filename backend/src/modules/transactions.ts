import { Elysia, t } from "elysia";
import { db } from "../db";
import { transactions, loans, borrowers, botUploads, files } from "../db/schema";
import { eq, desc, and } from "drizzle-orm";
import { uploadFile } from "../lib/storage";
import { authPlugin } from "../middleware/auth";

export const transactionsRoute = new Elysia({ prefix: "/transactions" })
    .use(authPlugin)
    .get("/", async ({ user }) => {
        if (!user) throw new Error("Unauthorized");
        return await db.select({
            id: transactions.id,
            loanId: transactions.loanId,
            borrowerName: borrowers.name,
            amount: transactions.amount,
            type: transactions.type,
            date: transactions.transactionDate,
            slipUrl: transactions.slipUrl
        })
            .from(transactions)
            .leftJoin(loans, eq(transactions.loanId, loans.id))
            .leftJoin(borrowers, eq(loans.borrowerId, borrowers.id))
            .where(eq(transactions.tenantId, user.tenantId))
            .orderBy(desc(transactions.transactionDate));
    })
    .post("/", async ({ body, user }) => {
        if (!user) throw new Error("Unauthorized");
        let slipUrl = null;

        // Handle File Upload if present
        if (body.slip) {
            const file = body.slip;
            const key = `slips/${Date.now()}_${file.name}`;
            try {
                const buffer = await file.arrayBuffer();
                slipUrl = await uploadFile(key, Buffer.from(buffer), file.type);
            } catch (e) {
                console.error("Slip upload failed", e);
            }
        }

        const result = await db.insert(transactions).values({
            tenantId: user.tenantId,
            loanId: Number(body.loanId),
            amount: body.amount.toString(),
            type: body.type || "repayment",
            slipUrl: slipUrl,
            transactionDate: new Date(body.date),
            notes: body.notes
        }).returning();

        return result[0];
    }, {
        body: t.Object({
            loanId: t.String(), // FormData often sends numbers as strings
            amount: t.String(),
            type: t.Optional(t.String()),
            date: t.String(),
            notes: t.Optional(t.String()),
            slip: t.Optional(t.File())
        })
    })
    .get("/bot-uploads", async ({ user }) => {
        if (!user) throw new Error("Unauthorized");
        return await db.select({
            id: botUploads.id,
            fileId: botUploads.fileId,
            source: botUploads.source,
            senderId: botUploads.senderId,
            status: botUploads.status,
            createdAt: botUploads.createdAt,
            url: files.url
        })
            .from(botUploads)
            .leftJoin(files, eq(botUploads.fileId, files.id))
            .where(and(eq(botUploads.tenantId, user.tenantId), eq(botUploads.status, "pending")))
            .orderBy(desc(botUploads.createdAt));
    })
    .post("/bot-uploads/:id/verify", async ({ params, body, user }) => {
        if (!user) throw new Error("Unauthorized");

        const uploadId = Number(params.id);

        // Fetch the bot upload and file URL
        const uploadInfo = await db.select({
            upload: botUploads,
            fileUrl: files.url
        })
            .from(botUploads)
            .leftJoin(files, eq(botUploads.fileId, files.id))
            .where(and(eq(botUploads.id, uploadId), eq(botUploads.tenantId, user.tenantId)))
            .limit(1);

        if (uploadInfo.length === 0) throw new Error("Upload not found");

        const { upload, fileUrl } = uploadInfo[0];

        // Create transaction
        const result = await db.insert(transactions).values({
            tenantId: user.tenantId,
            loanId: Number(body.loanId),
            amount: body.amount.toString(),
            type: "repayment",
            slipUrl: fileUrl,
            transactionDate: new Date(),
            notes: "Verified from bot upload"
        }).returning();

        // Update bot upload status
        await db.update(botUploads)
            .set({ status: "matched" })
            .where(eq(botUploads.id, uploadId));

        return result[0];
    }, {
        params: t.Object({
            id: t.String()
        }),
        body: t.Object({
            loanId: t.String(),
            amount: t.String()
        })
    });
