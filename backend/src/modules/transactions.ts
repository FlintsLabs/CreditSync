import { Elysia } from "elysia";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import { borrowers, loans, transactions } from "../db/schema";
import { resolveStoredFileUrl } from "../lib/storage";
import { authPlugin } from "../middleware/auth";
import { getAccessScopeCacheKey, transactionAccessFilters } from "../lib/access";
import { withTenantCache } from "../lib/cache";
import { DomainError, presentDomainError } from "../services/domain-error";

export const transactionsRoute = new Elysia({ prefix: "/transactions" })
    .use(authPlugin)
    .get("/", async ({ user, set }) => {
        if (!user) {
            set.status = 401;
            return { error: "Unauthorized" };
        }
        const scopeKey = getAccessScopeCacheKey(user);
        return await withTenantCache({
            tenantId: user.tenantId,
            namespace: "transactions",
            key: `list:${scopeKey}`,
            ttlSeconds: 20,
            loader: async () => {
                const rows = await db.select({
                    id: transactions.id,
                    publicId: transactions.publicId,
                    loanId: transactions.loanId,
                    loanPublicId: loans.publicId,
                    scheduleId: transactions.scheduleId,
                    borrowerName: borrowers.name,
                    amount: transactions.amount,
                    principalComponent: transactions.principalComponent,
                    interestComponent: transactions.interestComponent,
                    feeComponent: transactions.feeComponent,
                    penaltyComponent: transactions.penaltyComponent,
                    type: transactions.type,
                    date: transactions.transactionDate,
                    slipUrl: transactions.slipUrl,
                })
                    .from(transactions)
                    .leftJoin(loans, eq(transactions.loanId, loans.id))
                    .leftJoin(borrowers, eq(loans.borrowerId, borrowers.id))
                    .where(and(...transactionAccessFilters(user)))
                    .orderBy(desc(transactions.transactionDate));

                return await Promise.all(rows.map(async (row) => ({
                    ...row,
                    slipRef: row.slipUrl,
                    slipUrl: await resolveStoredFileUrl(row.slipUrl),
                })));
            },
        });
    })
    .post("/", ({ user, set }) => {
        const failure = !user
            ? new DomainError("UNAUTHORIZED", "Unauthorized", 401)
            : new DomainError(
                "LEGACY_REPAYMENT_WRITE_DISABLED",
                "Repayment writes must use the payment-intake workflow",
                405,
            );
        const presented = presentDomainError(failure);
        set.status = presented.status;
        return presented.body;
    });
