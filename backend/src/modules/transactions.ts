import { Elysia } from "elysia";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import { borrowers, loans, paymentIntakes, transactions } from "../db/schema";
import { resolveStoredFileUrl } from "../lib/storage";
import { authPlugin } from "../middleware/auth";
import { canAccessTenantWideData, getAccessScopeCacheKey, transactionAccessFilters } from "../lib/access";
import { withTenantCache } from "../lib/cache";
import { DomainError, presentDomainError } from "../services/domain-error";
import { paymentEvidenceSummariesByIntake } from "../services/payment-evidence-read-service";

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
                    paymentIntakeId: transactions.paymentIntakeId,
                    paymentIntakePublicId: paymentIntakes.publicId,
                    accessiblePaymentIntakeId: paymentIntakes.id,
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
                    .leftJoin(paymentIntakes, and(
                        eq(paymentIntakes.id, transactions.paymentIntakeId),
                        eq(paymentIntakes.tenantId, transactions.tenantId),
                        ...(canAccessTenantWideData(user) ? [] : [eq(paymentIntakes.ownerUserId, user.id)]),
                    ))
                    .where(and(...transactionAccessFilters(user)))
                    .orderBy(desc(transactions.transactionDate));

                const evidenceByIntake = await paymentEvidenceSummariesByIntake(user.tenantId, [...new Set(rows.flatMap((row) => row.accessiblePaymentIntakeId ? [row.accessiblePaymentIntakeId] : []))]);
                return await Promise.all(rows.map(async ({ paymentIntakeId, accessiblePaymentIntakeId, ...row }) => ({
                    ...row,
                    evidence: accessiblePaymentIntakeId ? evidenceByIntake.get(accessiblePaymentIntakeId) ?? [] : [],
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
