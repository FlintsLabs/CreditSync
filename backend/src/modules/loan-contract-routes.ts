import { Elysia, t } from "elysia";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db";
import { borrowers, loanSchedules, loans, transactions } from "../db/schema";
import { authPlugin } from "../middleware/auth";
import { calculateLoanClosingSummary } from "../lib/calculator";
import { createAuditLog } from "../lib/audit-log";
import { getAccessScopeCacheKey, loanAccessFilters } from "../lib/access";
import { computeOverdueSnapshot } from "../lib/overdue";
import { serializeMoney } from "../lib/money";
import { invalidateTenantCache, withTenantCache } from "../lib/cache";
import { findAccessibleBorrowerByPublicId, findAccessibleLoanByPublicId } from "../lib/public-id";
import { activateLoan, createLoanDraft, getLoanApplication, presentLoan, previewLoan, updateLoanDraft } from "../services/loan-application-service";
import { getLoanPaymentHealth } from "../services/loan-payment-health-service";
import { DomainError } from "../services/domain-error";
import { loanCommandContext, loanDomainFailure, loanUnauthorized } from "./loan-http-support";
import { dailyEntry, floatingInterestPolicy, repaymentType } from "./loan-route-schemas";

const loanTermsBody = t.Object({
    principal: t.String(), interestRate: t.String(), termMonths: t.Number(), repaymentType,
    startDate: t.String(), totalInstallments: t.Optional(t.Number()), installmentAmount: t.Optional(t.String()),
    floatingInterestPolicy: t.Optional(floatingInterestPolicy), dailyEntry: t.Optional(dailyEntry),
});

export const loanContractRoutes = new Elysia().use(authPlugin)
    .get("/", async ({ user, query, set }) => {
        if (!user) return loanUnauthorized(set);

        const conditions = loanAccessFilters(user);
        if (query.borrowerId) {
            const borrower = await findAccessibleBorrowerByPublicId(user, query.borrowerId);
            if (!borrower) return [];
            conditions.push(eq(loans.borrowerId, borrower.id));
        }
        const scopeKey = getAccessScopeCacheKey(user);
        return withTenantCache({
            tenantId: user.tenantId,
            namespace: "loans",
            key: `list:${scopeKey}:borrower=${query.borrowerId ?? "all"}`,
            ttlSeconds: 30,
            loader: async () => {
                const rows = await db.select({
                    loan: loans,
                    borrowerPublicId: borrowers.publicId,
                    borrowerName: borrowers.name,
                }).from(loans)
                    .leftJoin(borrowers, eq(loans.borrowerId, borrowers.id))
                    .where(and(...conditions))
                    .orderBy(desc(loans.createdAt));
                const asOf = new Date();
                return Promise.all(rows.map(async ({ loan, borrowerPublicId, borrowerName }) => ({
                    id: loan.publicId,
                    publicId: loan.publicId,
                    borrowerId: borrowerPublicId,
                    borrowerPublicId,
                    borrowerName,
                    principal: serializeMoney(loan.principalAmount),
                    outstandingPrincipal: serializeMoney(loan.outstandingPrincipal ?? "0"),
                    status: loan.status,
                    createdAt: loan.createdAt,
                    repaymentType: loan.repaymentType,
                    interestRate: serializeMoney(loan.interestRate),
                    installmentAmount: loan.installmentAmount === null ? null : serializeMoney(loan.installmentAmount),
                    totalInstallments: loan.totalInstallments,
                    startDate: loan.startDate,
                    paymentHealth: await getLoanPaymentHealth(db, loan, { asOf, actorUserId: user.id }),
                })));
            },
        });
    }, { query: t.Object({ borrowerId: t.Optional(t.String()) }) })
    .get("/:id", async ({ params, user, request, set }) => {
        if (!user) return loanUnauthorized(set);
        const scopeKey = getAccessScopeCacheKey(user);
        try {
            return await withTenantCache({
                tenantId: user.tenantId,
                namespace: "loans",
                key: `detail:${params.id}:${scopeKey}`,
                ttlSeconds: 30,
                loader: async () => getLoanApplication(loanCommandContext(user, request), params.id),
            });
        } catch (error) {
            return loanDomainFailure(error, set);
        }
    }, { params: t.Object({ id: t.String() }) })
    .get("/:id/schedule", async ({ params, user, set }) => {
        if (!user) return loanUnauthorized(set);
        const loan = await findAccessibleLoanByPublicId(user, params.id);
        if (!loan) return loanDomainFailure(new DomainError("LOAN_NOT_FOUND", "Loan not found", 404), set);

        const scopeKey = getAccessScopeCacheKey(user);
        return withTenantCache({
            tenantId: user.tenantId,
            namespace: "loans",
            key: `schedule:${loan.id}:${scopeKey}`,
            ttlSeconds: 20,
            loader: async () => {
                const scheduleRows = await db.select().from(loanSchedules).where(and(
                    eq(loanSchedules.loanId, loan.id),
                    eq(loanSchedules.tenantId, user.tenantId),
                )).orderBy(loanSchedules.installmentNo);
                return scheduleRows.map((row) => {
                    const overdue = computeOverdueSnapshot({
                        dueDate: row.dueDate,
                        remainingDue: row.remainingDue,
                        paidPenalty: row.paidPenalty,
                        gracePeriodDays: loan.gracePeriodDays,
                        lateFeeMode: loan.lateFeeMode,
                        lateFeeAmount: loan.lateFeeAmount,
                        baseStatus: row.status,
                    });
                    return {
                        id: row.publicId,
                        publicId: row.publicId,
                        loanPublicId: loan.publicId,
                        installmentNo: row.installmentNo,
                        dueDate: row.dueDate,
                        scheduledPrincipal: serializeMoney(row.scheduledPrincipal),
                        scheduledInterest: serializeMoney(row.scheduledInterest),
                        scheduledFee: serializeMoney(row.scheduledFee),
                        scheduledTotal: serializeMoney(row.scheduledTotal),
                        paidTotal: serializeMoney(row.paidTotal),
                        paidPenalty: serializeMoney(row.paidPenalty),
                        remainingDue: serializeMoney(row.remainingDue),
                        overdueDays: overdue.overdueDays,
                        penaltyDue: overdue.penaltyDue.toFixed(2),
                        totalDueNow: overdue.totalDueNow.toFixed(2),
                        status: overdue.effectiveStatus,
                        createdAt: row.createdAt,
                        updatedAt: row.updatedAt,
                    };
                });
            },
        });
    }, { params: t.Object({ id: t.String() }) })
    .get("/:id/closing-summary", async ({ params, user, set }) => {
        if (!user) return loanUnauthorized(set);
        const loan = await findAccessibleLoanByPublicId(user, params.id);
        if (!loan) return loanDomainFailure(new DomainError("LOAN_NOT_FOUND", "Loan not found", 404), set);
        const loanTransactions = await db.select().from(transactions)
            .where(and(eq(transactions.loanId, loan.id), eq(transactions.tenantId, user.tenantId)));
        const summary = calculateLoanClosingSummary({ ...loan, startDate: loan.startDate ?? new Date() }, loanTransactions);
        return {
            loanId: loan.publicId,
            loanPublicId: loan.publicId,
            principal: serializeMoney(summary.principal),
            totalInterest: serializeMoney(summary.totalInterest),
            totalPaid: serializeMoney(summary.totalPaid),
            totalDue: serializeMoney(summary.totalDue),
            balance: summary.balance < 0 ? `-${serializeMoney(Math.abs(summary.balance))}` : serializeMoney(summary.balance),
            daysSinceStart: summary.daysSinceStart,
        };
    }, { params: t.Object({ id: t.String() }) })
    .post("/:id/close", async ({ params, body, user, request, set }) => {
        if (!user) return loanUnauthorized(set);
        try {
            return await db.transaction(async (tx) => {
                const resolved = await findAccessibleLoanByPublicId(user, params.id);
                const loan = resolved ? await tx.query.loans.findFirst({
                    where: and(eq(loans.id, resolved.id), ...loanAccessFilters(user)),
                }) : null;
                if (!loan) throw new DomainError("LOAN_NOT_FOUND", "Loan not found", 404);
                if (loan.status === "closed") throw new DomainError("LOAN_ALREADY_CLOSED", "Loan is already closed", 409);
                const before = await getLoanApplication(loanCommandContext(user, request), loan.publicId);
                const updated = await tx.update(loans).set({ status: "closed", updatedAt: new Date() })
                    .where(eq(loans.id, loan.id)).returning().then((rows) => rows[0]!);
                const after = await presentLoan(updated);
                await createAuditLog(tx, {
                    tenantId: user.tenantId,
                    actorUserId: user.id,
                    entityType: "loan",
                    entityId: loan.publicId,
                    action: "closed",
                    payload: { before, after, note: body.note },
                });
                await invalidateTenantCache(user.tenantId);
                return after;
            });
        } catch (error) {
            return loanDomainFailure(error, set);
        }
    }, { params: t.Object({ id: t.String() }), body: t.Object({ note: t.Optional(t.String()) }) })
    .post("/calculate", ({ body, set }) => {
        try { return previewLoan(body).schedule; }
        catch (error) { return loanDomainFailure(error, set); }
    }, { body: loanTermsBody })
    .post("/preview", ({ body, set }) => {
        try { return previewLoan(body); }
        catch (error) { return loanDomainFailure(error, set); }
    }, { body: loanTermsBody })
    .post("/", async ({ body, user, request, set }) => {
        if (!user) return loanUnauthorized(set);
        try {
            const created = await createLoanDraft(loanCommandContext(user, request), body);
            await invalidateTenantCache(user.tenantId);
            return created;
        } catch (error) {
            return loanDomainFailure(error, set);
        }
    }, {
        body: t.Object({
            borrowerPublicId: t.String(),
            bankLoanPublicId: t.Optional(t.Nullable(t.String())),
            bankProfilePublicId: t.Optional(t.Nullable(t.String())),
            principal: t.String(), interestRate: t.String(), repaymentType, termMonths: t.Number(),
            totalInstallments: t.Optional(t.Number()), installmentAmount: t.Optional(t.String()),
            floatingInterestPolicy: t.Optional(floatingInterestPolicy), dailyEntry: t.Optional(dailyEntry), startDate: t.String(),
        }),
    })
    .put("/:id", async ({ params, body, user, request, set }) => {
        if (!user) return loanUnauthorized(set);
        try {
            const updated = await updateLoanDraft(loanCommandContext(user, request), params.id, body);
            await invalidateTenantCache(user.tenantId);
            return updated;
        } catch (error) {
            return loanDomainFailure(error, set);
        }
    }, {
        params: t.Object({ id: t.String() }),
        body: t.Object({
            borrowerPublicId: t.Optional(t.String()),
            bankLoanPublicId: t.Optional(t.Nullable(t.String())),
            bankProfilePublicId: t.Optional(t.Nullable(t.String())),
            principal: t.Optional(t.String()), interestRate: t.Optional(t.String()),
            repaymentType: t.Optional(repaymentType), termMonths: t.Optional(t.Number()),
            totalInstallments: t.Optional(t.Number()), installmentAmount: t.Optional(t.String()),
            floatingInterestPolicy: t.Optional(floatingInterestPolicy), dailyEntry: t.Optional(dailyEntry), startDate: t.Optional(t.String()),
        }),
    })
    .post("/:id/activate", async ({ params, user, request, set }) => {
        if (!user) return loanUnauthorized(set);
        try {
            const activated = await activateLoan(loanCommandContext(user, request), params.id);
            await invalidateTenantCache(user.tenantId);
            return activated;
        } catch (error) {
            return loanDomainFailure(error, set);
        }
    }, { params: t.Object({ id: t.String() }) });
