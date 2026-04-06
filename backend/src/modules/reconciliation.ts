import { Elysia, t } from "elysia";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import { bankLoanRepayments, bankLoans, botUploads, borrowers, files, loans, reconciliationEntries, transactions } from "../db/schema";
import { authPlugin } from "../middleware/auth";
import { createAuditLog } from "../lib/audit-log";
import { invalidateTenantCache, withTenantCache } from "../lib/cache";

export const reconciliationRoute = new Elysia({ prefix: "/reconciliation" })
    .use(authPlugin)
    .get("/overview", async ({ user, set }) => {
        if (!user) {
            set.status = 401;
            return { error: "Unauthorized" };
        }

        return await withTenantCache({
            tenantId: user.tenantId,
            namespace: "reconciliation",
            key: "overview",
            ttlSeconds: 20,
            loader: async () => {
                const [uploads, borrowerTransactions, bankRepayments, reconciliations] = await Promise.all([
                    db.select({
                        id: botUploads.id,
                        source: botUploads.source,
                        senderId: botUploads.senderId,
                        status: botUploads.status,
                        createdAt: botUploads.createdAt,
                        fileUrl: files.url,
                    })
                        .from(botUploads)
                        .leftJoin(files, eq(botUploads.fileId, files.id))
                        .where(eq(botUploads.tenantId, user.tenantId))
                        .orderBy(desc(botUploads.createdAt)),
                    db.select({
                        id: transactions.id,
                        loanId: transactions.loanId,
                        borrowerName: borrowers.name,
                        amount: transactions.amount,
                        transactionDate: transactions.transactionDate,
                        slipUrl: transactions.slipUrl,
                        scheduleId: transactions.scheduleId,
                    })
                        .from(transactions)
                        .leftJoin(loans, eq(transactions.loanId, loans.id))
                        .leftJoin(borrowers, eq(loans.borrowerId, borrowers.id))
                        .where(eq(transactions.tenantId, user.tenantId))
                        .orderBy(desc(transactions.transactionDate)),
                    db.select({
                        id: bankLoanRepayments.id,
                        bankLoanId: bankLoanRepayments.bankLoanId,
                        bankProfileId: bankLoans.bankProfileId,
                        amount: bankLoanRepayments.amount,
                        paymentDate: bankLoanRepayments.paymentDate,
                        scheduleId: bankLoanRepayments.scheduleId,
                        reference: bankLoanRepayments.reference,
                    })
                        .from(bankLoanRepayments)
                        .leftJoin(bankLoans, eq(bankLoanRepayments.bankLoanId, bankLoans.id))
                        .where(eq(bankLoanRepayments.tenantId, user.tenantId))
                        .orderBy(desc(bankLoanRepayments.paymentDate)),
                    db.select().from(reconciliationEntries).where(eq(reconciliationEntries.tenantId, user.tenantId)),
                ]);

                const matchedKeys = new Set(
                    reconciliations
                        .filter((row) => row.status !== "ignored")
                        .map((row) => `${row.entityType}:${row.entityId}`)
                );

                return {
                    pendingUploads: uploads.filter((row) => row.status === "pending"),
                    unreconciledBorrowerTransactions: borrowerTransactions.filter((row) => !matchedKeys.has(`borrower_transaction:${row.id}`)),
                    unreconciledBankRepayments: bankRepayments.filter((row) => !matchedKeys.has(`bank_loan_repayment:${row.id}`)),
                    history: reconciliations.sort((a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime()),
                };
            },
        });
    })
    .post("/borrower-transactions/:id/match", async ({ params: { id }, body, user, set }) => {
        if (!user) throw new Error("Unauthorized");

        const transactionId = parseInt(id);

        return await db.transaction(async (tx) => {
            const target = await tx.select().from(transactions).where(
                and(
                    eq(transactions.id, transactionId),
                    eq(transactions.tenantId, user.tenantId),
                )
            ).then((rows) => rows[0]);

            if (!target) {
                set.status = 404;
                return { error: "Borrower transaction not found" };
            }

            if (body.uploadId) {
                const upload = await tx.select().from(botUploads).where(
                    and(
                        eq(botUploads.id, body.uploadId),
                        eq(botUploads.tenantId, user.tenantId),
                    )
                ).then((rows) => rows[0]);

                if (!upload) {
                    set.status = 404;
                    return { error: "Upload not found" };
                }

                await tx.update(botUploads).set({ status: "matched" }).where(eq(botUploads.id, upload.id));
            }

            const entry = await tx.insert(reconciliationEntries).values({
                tenantId: user.tenantId,
                entityType: "borrower_transaction",
                entityId: transactionId,
                uploadId: body.uploadId,
                status: body.uploadId ? "matched" : "manual",
                note: body.note,
                matchedByUserId: user.id,
                updatedAt: new Date(),
            }).returning().then((rows) => rows[0]);

            await createAuditLog(tx, {
                tenantId: user.tenantId,
                actorUserId: user.id,
                entityType: "reconciliation_entry",
                entityId: entry.id,
                action: "borrower_transaction.matched",
                payload: entry,
            });

            await invalidateTenantCache(user.tenantId);
            return entry;
        });
    }, {
        body: t.Object({
            uploadId: t.Optional(t.Number()),
            note: t.Optional(t.String()),
        })
    })
    .post("/bank-repayments/:id/match", async ({ params: { id }, body, user, set }) => {
        if (!user) throw new Error("Unauthorized");

        const repaymentId = parseInt(id);

        return await db.transaction(async (tx) => {
            const target = await tx.select().from(bankLoanRepayments).where(
                and(
                    eq(bankLoanRepayments.id, repaymentId),
                    eq(bankLoanRepayments.tenantId, user.tenantId),
                )
            ).then((rows) => rows[0]);

            if (!target) {
                set.status = 404;
                return { error: "Bank repayment not found" };
            }

            if (body.uploadId) {
                const upload = await tx.select().from(botUploads).where(
                    and(
                        eq(botUploads.id, body.uploadId),
                        eq(botUploads.tenantId, user.tenantId),
                    )
                ).then((rows) => rows[0]);

                if (!upload) {
                    set.status = 404;
                    return { error: "Upload not found" };
                }

                await tx.update(botUploads).set({ status: "matched" }).where(eq(botUploads.id, upload.id));
            }

            const entry = await tx.insert(reconciliationEntries).values({
                tenantId: user.tenantId,
                entityType: "bank_loan_repayment",
                entityId: repaymentId,
                uploadId: body.uploadId,
                status: body.uploadId ? "matched" : "manual",
                note: body.note,
                matchedByUserId: user.id,
                updatedAt: new Date(),
            }).returning().then((rows) => rows[0]);

            await createAuditLog(tx, {
                tenantId: user.tenantId,
                actorUserId: user.id,
                entityType: "reconciliation_entry",
                entityId: entry.id,
                action: "bank_loan_repayment.matched",
                payload: entry,
            });

            await invalidateTenantCache(user.tenantId);
            return entry;
        });
    }, {
        body: t.Object({
            uploadId: t.Optional(t.Number()),
            note: t.Optional(t.String()),
        })
    })
    .post("/uploads/:id/ignore", async ({ params: { id }, body, user, set }) => {
        if (!user) throw new Error("Unauthorized");

        const uploadId = parseInt(id);

        return await db.transaction(async (tx) => {
            const upload = await tx.select().from(botUploads).where(
                and(
                    eq(botUploads.id, uploadId),
                    eq(botUploads.tenantId, user.tenantId),
                )
            ).then((rows) => rows[0]);

            if (!upload) {
                set.status = 404;
                return { error: "Upload not found" };
            }

            await tx.update(botUploads).set({ status: "discarded" }).where(eq(botUploads.id, uploadId));

            const entry = await tx.insert(reconciliationEntries).values({
                tenantId: user.tenantId,
                entityType: "bot_upload",
                entityId: uploadId,
                uploadId,
                status: "ignored",
                note: body.note,
                matchedByUserId: user.id,
                updatedAt: new Date(),
            }).returning().then((rows) => rows[0]);

            await createAuditLog(tx, {
                tenantId: user.tenantId,
                actorUserId: user.id,
                entityType: "reconciliation_entry",
                entityId: entry.id,
                action: "bot_upload.ignored",
                payload: entry,
            });

            await invalidateTenantCache(user.tenantId);
            return entry;
        });
    }, {
        body: t.Object({
            note: t.Optional(t.String()),
        })
    });
