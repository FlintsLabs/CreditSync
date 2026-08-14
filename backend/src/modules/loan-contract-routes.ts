import { Elysia, t } from "elysia";
import { and, desc, eq, inArray } from "drizzle-orm";
import Decimal from "decimal.js";
import { db } from "../db";
import { borrowerAliases, borrowers, loanSchedules, loans, transactions } from "../db/schema";
import { authPlugin } from "../middleware/auth";
import { calculateLoanClosingSummary } from "../lib/calculator";
import { createAuditLog } from "../lib/audit-log";
import { getAccessScopeCacheKey, loanAccessFilters } from "../lib/access";
import { computeOverdueSnapshot } from "../lib/overdue";
import { serializeMoney } from "../lib/money";
import { invalidateTenantCache, withTenantCache } from "../lib/cache";
import { findAccessibleBorrowerByPublicId, findAccessibleLoanByPublicId } from "../lib/public-id";
import { activateLoan, createLoanDraft, getLoanApplication, presentLoan, previewLoan, updateLoanDraft } from "../services/loan-application-service";
import { bangkokBusinessDate, getLoanPaymentHealth } from "../services/loan-payment-health-service";
import { floatingInterestBalances } from "../services/floating-interest-service";
import { DomainError } from "../services/domain-error";
import { loanCommandContext, loanDomainFailure, loanUnauthorized } from "./loan-http-support";
import { loanDraftBody, loanDraftUpdateBody, loanTermsBody } from "./loan-route-schemas";

function assertKnownKeys(value: Record<string, unknown>, allowedKeys: readonly string[], path = "body") {
    const unexpected = Object.keys(value).filter((key) => !allowedKeys.includes(key));
    if (unexpected.length) {
        throw new DomainError("VALIDATION_ERROR", `Unexpected ${path} field: ${unexpected[0]}`, 422, {
            unexpectedFields: unexpected.map((key) => `${path}.${key}`),
        });
    }
}

function assertClosedLoanTerms(body: Record<string, unknown>, draft: boolean) {
    assertKnownKeys(body, [
        "principal", "interestRate", "termMonths", "repaymentType", "startDate",
        "totalInstallments", "installmentAmount", "floatingInterestPolicy", "floatingDailyInterest",
        "dailyEntry", "singlePayment",
        ...(draft ? ["borrowerPublicId", "bankLoanPublicId", "bankProfilePublicId"] : []),
    ]);
    const policy = body.floatingInterestPolicy as Record<string, unknown> | undefined;
    if (policy) {
        assertKnownKeys(policy, [
            "periodUnit", "periodLength", "rateMode", "rate", "advanceInterestPeriods",
            "advanceInterestRefundPolicy",
        ], "body.floatingInterestPolicy");
    }
    const floating = body.floatingDailyInterest as Record<string, unknown> | undefined;
    if (floating) {
        assertKnownKeys(floating, ["mode", "rate", "firstDayTreatment", "accrualCycle"], "body.floatingDailyInterest");
    }
    const daily = body.dailyEntry as Record<string, unknown> | undefined;
    if (daily) {
        assertKnownKeys(daily, ["durationUnit", "durationValue", "entryMode", "dailyPayment", "interestInput"], "body.dailyEntry");
        const interestInput = daily.interestInput as Record<string, unknown> | undefined;
        if (interestInput) {
            assertKnownKeys(interestInput, ["mode", "value"], "body.dailyEntry.interestInput");
        }
    }
    const single = body.singlePayment as Record<string, unknown> | undefined;
    if (single) {
        assertKnownKeys(single, ["dueDate", "fixedAgreedInterest", "interestPolicy", "retroactiveInterest", "latePenalty"], "body.singlePayment");
        const retroactive = single.retroactiveInterest as Record<string, unknown> | undefined;
        if (retroactive) {
            assertKnownKeys(retroactive, ["rateType", "rate"], "body.singlePayment.retroactiveInterest");
        }
        const penalty = single.latePenalty as Record<string, unknown> | undefined;
        if (penalty) {
            assertKnownKeys(penalty, penalty.mode === "fixed_amount_per_day"
                ? ["mode", "amountPerDay", "graceDays"] : ["mode"], "body.singlePayment.latePenalty");
        }
    }
}

function requireLegacyCloseEligible(loan: typeof loans.$inferSelect) {
    if (loan.repaymentType === "floating") {
        throw new DomainError(
            "FLOATING_SETTLEMENT_REQUIRED",
            "Floating loans require the preview-and-execute settlement workflow",
            409,
        );
    }
}

export const loanContractRoutes = new Elysia({ normalize: false }).use(authPlugin)
    .get("/", async ({ user, query, request, set }) => {
        if (!user) return loanUnauthorized(set);
        const ctx = loanCommandContext(user, request);

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
                    borrowerId: borrowers.id,
                    borrowerTags: borrowers.tags,
                }).from(loans)
                    .leftJoin(borrowers, eq(loans.borrowerId, borrowers.id))
                    .where(and(...conditions))
                    .orderBy(desc(loans.createdAt));

                const visibleBorrowerIds = [...new Set(rows.flatMap((row) => row.borrowerId == null ? [] : [row.borrowerId]))];
                const aliasRows = visibleBorrowerIds.length === 0 ? [] : await db.select({
                    borrowerId: borrowerAliases.borrowerId,
                    alias: borrowerAliases.alias,
                }).from(borrowerAliases).where(and(
                    eq(borrowerAliases.tenantId, user.tenantId),
                    eq(borrowerAliases.status, "confirmed"),
                    inArray(borrowerAliases.borrowerId, visibleBorrowerIds),
                ));

                const aliasesByBorrower = new Map<number, string[]>();
                for (const aliasRow of aliasRows) {
                    aliasesByBorrower.set(aliasRow.borrowerId, [...(aliasesByBorrower.get(aliasRow.borrowerId) ?? []), aliasRow.alias]);
                }

                const asOf = new Date();
                return Promise.all(rows.map(async ({ loan, borrowerPublicId, borrowerName, borrowerId, borrowerTags }) => ({
                    id: loan.publicId,
                    publicId: loan.publicId,
                    borrowerId: borrowerPublicId,
                    borrowerPublicId,
                    borrowerName,
                    borrowerAliases: borrowerId == null ? [] : aliasesByBorrower.get(borrowerId) ?? [],
                    borrowerTags: borrowerTags ?? [],
                    principal: serializeMoney(loan.principalAmount),
                    outstandingPrincipal: serializeMoney(loan.outstandingPrincipal ?? "0"),
                    status: loan.status,
                    createdAt: loan.createdAt,
                    repaymentType: loan.repaymentType,
                    interestRate: serializeMoney(loan.interestRate),
                    installmentAmount: loan.installmentAmount === null ? null : serializeMoney(loan.installmentAmount),
                    totalInstallments: loan.totalInstallments,
                    startDate: loan.startDate,
                    paymentHealth: await getLoanPaymentHealth(db, loan, { asOf, context: ctx }),
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
        try {
            const loan = await findAccessibleLoanByPublicId(user, params.id);
            if (!loan) throw new DomainError("LOAN_NOT_FOUND", "Loan not found", 404);
            requireLegacyCloseEligible(loan);
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
        } catch (error) {
            return loanDomainFailure(error, set);
        }
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
                requireLegacyCloseEligible(loan);
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
        try {
            assertClosedLoanTerms(body, false);
            return previewLoan(body as unknown as Parameters<typeof previewLoan>[0]).schedule;
        }
        catch (error) { return loanDomainFailure(error, set); }
    }, { body: loanTermsBody })
    .post("/preview", ({ body, set }) => {
        try {
            assertClosedLoanTerms(body, false);
            return previewLoan(body as unknown as Parameters<typeof previewLoan>[0]);
        }
        catch (error) { return loanDomainFailure(error, set); }
    }, { body: loanTermsBody })
    .post("/", async ({ body, user, request, set }) => {
        if (!user) return loanUnauthorized(set);
        try {
            assertClosedLoanTerms(body, true);
            const created = await createLoanDraft(
                loanCommandContext(user, request),
                body as unknown as Parameters<typeof createLoanDraft>[1],
            );
            await invalidateTenantCache(user.tenantId);
            return created;
        } catch (error) {
            return loanDomainFailure(error, set);
        }
    }, { body: loanDraftBody })
    .put("/:id", async ({ params, body, user, request, set }) => {
        if (!user) return loanUnauthorized(set);
        try {
            assertClosedLoanTerms(body, true);
            const updated = await updateLoanDraft(
                loanCommandContext(user, request),
                params.id,
                body as unknown as Parameters<typeof updateLoanDraft>[2],
            );
            await invalidateTenantCache(user.tenantId);
            return updated;
        } catch (error) {
            return loanDomainFailure(error, set);
        }
    }, { params: t.Object({ id: t.String() }), body: loanDraftUpdateBody })
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
