import { Elysia, t } from "elysia";
import { db } from "../db";
import { transactions, loans, borrowers } from "../db/schema";
import { eq, desc } from "drizzle-orm";
import { uploadFile } from "../lib/storage";

export const transactionsRoute = new Elysia({ prefix: "/transactions" })
    .get("/", async () => {
        // TODO: Context Tenant
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
            .where(eq(transactions.tenantId, "default_tenant"))
            .orderBy(desc(transactions.transactionDate));
    })
    .post("/", async ({ body }) => {
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
            tenantId: "default_tenant",
            loanId: body.loanId,
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
    });
