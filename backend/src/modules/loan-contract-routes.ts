import { Elysia, t } from "elysia";
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import Decimal from "decimal.js";
import { db } from "../db";
import { borrowerAliases, borrowers, intermediaries, loanCommissionParticipants, loanScheduleDeferrals, loanSchedules, loans, paymentIntakes, transactions } from "../db/schema";
import { authPlugin } from "../middleware/auth";
import { calculateLoanClosingSummary } from "../lib/calculator";
import { createAuditLog } from "../lib/audit-log";
import { getAccessScopeCacheKey, loanAccessFilters } from "../lib/access";
import { computeOverdueSnapshot } from "../lib/overdue";
import { FinancialDecimal } from "../lib/financial-decimal";
import { serializeMoney } from "../lib/money";
import { invalidateTenantCache, withTenantCache } from "../lib/cache";
import { findAccessibleBorrowerByPublicId, findAccessibleLoanByPublicId } from "../lib/public-id";
import { activateLoan, createLoanDraft, deleteLoanDraft, getLoanApplication, getLoanReplacementLineages, presentLoan, previewLoan, updateLoanDraft, updateLoanPaymentStartDate } from "../services/loan-application-service";
import { bangkokBusinessDate, getLoanListLegacyPaymentHealth, getLoanPaymentHealth } from "../services/loan-payment-health-service";
import { getLoanReceiptSummaries } from "../services/loan-receipt-summary-service";
import { floatingInterestBalances } from "../services/floating-interest-service";
import { DomainError } from "../services/domain-error";
import {
    addLoanCommissionParticipant,
    endLoanCommissionParticipant,
    listLoanCommissionParticipants,
    previewLoanCommission,
    updateLoanCommissionParticipant,
} from "../services/loan-commission-service";
import { listCanonicalPostedPaymentsForLoan } from "../services/posted-payment-access";
import { loanCommandContext, loanDomainFailure, loanUnauthorized } from "./loan-http-support";
import { loanCancellationExecuteBody, loanCancellationPreviewBody, loanDraftBody, loanDraftUpdateBody, loanTermsBody } from "./loan-route-schemas";
import { countLoanScheduleDeferrals, deferLoanSchedule, getDeferralReasonForSchedule } from "../services/loan-schedule-deferral-service";
import { executeUnfundedLoanCancellation, previewUnfundedLoanCancellation } from "../services/loan-cancellation-service";

export const loanListLoanProjection = {
    id: loans.id,
    publicId: loans.publicId,
    tenantId: loans.tenantId,
    principalAmount: loans.principalAmount,
    interestRate: loans.interestRate,
    repaymentType: loans.repaymentType,
    installmentAmount: loans.installmentAmount,
    totalInstallments: loans.totalInstallments,
    gracePeriodDays: loans.gracePeriodDays,
    lateFeeMode: loans.lateFeeMode,
    lateFeeAmount: loans.lateFeeAmount,
    startDate: loans.startDate,
    outstandingPrincipal: loans.outstandingPrincipal,
    status: loans.status,
    createdAt: loans.createdAt,
    dailyInterestMode: loans.dailyInterestMode,
    dailyInterestRate: loans.dailyInterestRate,
    interestPeriodUnit: loans.interestPeriodUnit,
    floatingAccrualCycle: loans.floatingAccrualCycle,
    firstDayTreatment: loans.firstDayTreatment,
    interestStartDate: loans.interestStartDate,
};

const bangkokCurrentInstant = sql`((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Bangkok') AT TIME ZONE 'Asia/Bangkok')`;

export function summarizeLoanSchedule(loan: typeof loans.$inferSelect, scheduleRows: Array<typeof loanSchedules.$inferSelect>, deferralCount = scheduleRows.filter((row) => row.status === "deferred").length) {
    const today = bangkokBusinessDate(new Date());
    const summary = {
        businessDate: today,
        totalInstallments: scheduleRows.length,
        deferralCount,
        paidInstallments: 0,
        overdueInstallments: 0,
        dueTodayInstallments: 0,
        pendingInstallments: 0,
        dueTodayAmount: new FinancialDecimal("0.00"),
    };

    for (const row of scheduleRows) {
        if (row.status === "deferred") continue;
        const overdue = computeOverdueSnapshot({
            dueDate: row.dueDate,
            remainingDue: row.remainingDue,
            paidPenalty: row.paidPenalty,
            gracePeriodDays: loan.gracePeriodDays,
            lateFeeMode: loan.lateFeeMode,
            lateFeeAmount: loan.lateFeeAmount,
            baseStatus: row.status,
        });
        if (overdue.effectiveStatus === "paid") summary.paidInstallments += 1;
        else if (overdue.effectiveStatus === "overdue") summary.overdueInstallments += 1;
        else if (row.dueDate === today) {
            summary.dueTodayInstallments += 1;
            summary.dueTodayAmount = summary.dueTodayAmount.plus(overdue.totalDueNow.toFixed(2));
        } else if (overdue.effectiveStatus === "pending" || overdue.effectiveStatus === "partial") summary.pendingInstallments += 1;
    }

    return { ...summary, dueTodayAmount: summary.dueTodayAmount.toFixed(2) };
}

export function buildCurrentLoanAgentRowsQuery(tenantId: string, loanIds: number[]) {
    return db.select({
        loanId: loanCommissionParticipants.loanId,
        name: intermediaries.name,
        aliases: intermediaries.aliases,
    }).from(loanCommissionParticipants)
        .innerJoin(intermediaries, and(
            eq(intermediaries.tenantId, tenantId),
            eq(intermediaries.id, loanCommissionParticipants.intermediaryId),
        ))
        .where(and(
            eq(loanCommissionParticipants.tenantId, tenantId),
            inArray(loanCommissionParticipants.loanId, loanIds),
            sql`${loanCommissionParticipants.effectiveFrom} <= ${bangkokCurrentInstant}`,
            sql`(${loanCommissionParticipants.effectiveTo} IS NULL OR ${loanCommissionParticipants.effectiveTo} > ${bangkokCurrentInstant})`,
            sql`NOT EXISTS (
                SELECT 1 FROM loan_commission_participants successor
                WHERE successor.tenant_id = ${tenantId}
                  AND successor.previous_participant_id = ${loanCommissionParticipants.id}
                  AND successor.effective_from <= ${bangkokCurrentInstant}
            )`,
        ))
        .orderBy(loanCommissionParticipants.id);
}

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
        "principal", "interestRate", "termMonths", "repaymentType", "startDate", "paymentStartDate",
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
    if (loan.status === "replaced") {
        throw new DomainError(
            "LOAN_REPLACED",
            "Replaced loans cannot be closed directly",
            409,
        );
    }
    if (["cancelled", "canceled", "reversed"].includes(loan.status ?? "")) {
        throw new DomainError(
            "LOAN_NOT_CLOSEABLE",
            "Cancelled or reversed loans cannot be closed",
            409,
        );
    }
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
                    loan: loanListLoanProjection,
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
                )).orderBy(borrowerAliases.id);

                const aliasesByBorrower = new Map<number, string[]>();
                for (const aliasRow of aliasRows) {
                    aliasesByBorrower.set(aliasRow.borrowerId, [...(aliasesByBorrower.get(aliasRow.borrowerId) ?? []), aliasRow.alias]);
                }

                const [receiptSummaries, replacementLineages, currentAgentRows] = await Promise.all([
                    getLoanReceiptSummaries(
                        db,
                        user.tenantId,
                        rows.map(({ loan }) => loan.id),
                    ),
                    getLoanReplacementLineages(user.tenantId, rows.map(({ loan }) => loan)),
                    rows.length === 0
                        ? Promise.resolve([])
                        : buildCurrentLoanAgentRowsQuery(user.tenantId, rows.map(({ loan }) => loan.id)),
                ]);
                const currentAgentsByLoan = new Map<number, { name: string; aliases: string[] }[]>();
                for (const agentRow of currentAgentRows) {
                    currentAgentsByLoan.set(agentRow.loanId, [
                        ...(currentAgentsByLoan.get(agentRow.loanId) ?? []),
                        { name: agentRow.name, aliases: agentRow.aliases },
                    ]);
                }
                const asOf = new Date();
                return Promise.all(rows.map(async ({ loan, borrowerPublicId, borrowerName, borrowerId, borrowerTags }) => {
                    const receipts = receiptSummaries.get(loan.id) ?? {
                        interestReceived: "0.00",
                        paidToDate: "0.00",
                    };
                    const currentAgents = currentAgentsByLoan.get(loan.id) ?? [];
                    return {
                        id: loan.publicId,
                        publicId: loan.publicId,
                        borrowerId: borrowerPublicId,
                        borrowerPublicId,
                        borrowerName,
                        borrowerAliases: borrowerId == null ? [] : aliasesByBorrower.get(borrowerId) ?? [],
                        borrowerTags: borrowerTags ?? [],
                        replacementLineage: replacementLineages.get(loan.id) ?? null,
                        principal: serializeMoney(loan.principalAmount),
                        outstandingPrincipal: serializeMoney(loan.outstandingPrincipal ?? "0"),
                        interestReceived: receipts.interestReceived,
                        paidToDate: receipts.paidToDate,
                        status: loan.status,
                        createdAt: loan.createdAt,
                        repaymentType: loan.repaymentType,
                        interestRate: serializeMoney(loan.interestRate),
                        installmentAmount: loan.installmentAmount === null ? null : serializeMoney(loan.installmentAmount),
                        totalInstallments: loan.totalInstallments,
                        startDate: loan.startDate,
                        currentAgent: currentAgents.length === 0 ? null : {
                            name: currentAgents.map((agent) => agent.name).join(", "),
                            aliases: [...new Set(currentAgents.flatMap((agent) => agent.aliases))],
                        },
                        paymentHealth: loan.repaymentType === "floating"
                            ? (loan.firstDayTreatment && loan.interestStartDate && loan.dailyInterestMode && loan.dailyInterestRate
                                ? await getLoanPaymentHealth(db, loan as typeof loans.$inferSelect, { asOf, context: ctx })
                                : await getLoanListLegacyPaymentHealth(db, loan as typeof loans.$inferSelect, { asOf }))
                            : await getLoanPaymentHealth(db, loan as typeof loans.$inferSelect, { asOf, context: ctx }),
                    };
                }));
            },
        });
    }, { query: t.Object({ borrowerId: t.Optional(t.String()) }) })
    .get("/:id/commission-participants", async ({ params, user, request, set }) => {
        if (!user) return loanUnauthorized(set);
        try { return await listLoanCommissionParticipants(loanCommandContext(user, request), params.id); }
        catch (error) { return loanDomainFailure(error, set); }
    }, { params: t.Object({ id: t.String({ format: "uuid" }) }) })
    .post("/:id/commission-participants", async ({ params, body, user, request, set }) => {
        if (!user) return loanUnauthorized(set);
        try {
            const { confirmed: _confirmed, ...input } = body;
            const participant = await addLoanCommissionParticipant(loanCommandContext(user, request), { loanPublicId: params.id, ...input });
            await invalidateTenantCache(user.tenantId);
            return participant;
        } catch (error) { return loanDomainFailure(error, set); }
    }, {
        params: t.Object({ id: t.String({ format: "uuid" }) }),
        body: t.Object({
            intermediaryPublicId: t.String({ format: "uuid" }), commissionRate: t.String({ pattern: "^(?:0|[1-9]\\d{0,2})(?:\\.\\d{1,4})?$", maxLength: 8 }),
            role: t.String({ minLength: 1, maxLength: 500 }), effectiveFrom: t.String({ format: "date-time" }),
            note: t.Optional(t.Nullable(t.String({ maxLength: 2_000 }))), confirmed: t.Literal(true),
        }, { additionalProperties: t.Never() }),
    })
    .patch("/:id/commission-participants/:participantId", async ({ params, body, user, request, set }) => {
        if (!user) return loanUnauthorized(set);
        try {
            const ctx = loanCommandContext(user, request);
            const participants = await listLoanCommissionParticipants(ctx, params.id);
            if (!participants.some((participant) => participant.publicId === params.participantId)) throw new DomainError("COMMISSION_PARTICIPANT_NOT_FOUND", "Commission participant not found", 404);
            const { confirmed: _confirmed, ...input } = body;
            const participant = await updateLoanCommissionParticipant(ctx, { participantPublicId: params.participantId, ...input });
            await invalidateTenantCache(user.tenantId);
            return participant;
        } catch (error) { return loanDomainFailure(error, set); }
    }, {
        params: t.Object({ id: t.String({ format: "uuid" }), participantId: t.String({ format: "uuid" }) }),
        body: t.Object({
            commissionRate: t.String({ pattern: "^(?:0|[1-9]\\d{0,2})(?:\\.\\d{1,4})?$", maxLength: 8 }),
            role: t.String({ minLength: 1, maxLength: 500 }), effectiveFrom: t.String({ format: "date-time" }),
            note: t.Optional(t.Nullable(t.String({ maxLength: 2_000 }))), confirmed: t.Literal(true),
        }, { additionalProperties: t.Never() }),
    })
    .post("/:id/commission-participants/:participantId/end", async ({ params, body, user, request, set }) => {
        if (!user) return loanUnauthorized(set);
        try {
            const ctx = loanCommandContext(user, request);
            const participants = await listLoanCommissionParticipants(ctx, params.id);
            if (!participants.some((participant) => participant.publicId === params.participantId)) throw new DomainError("COMMISSION_PARTICIPANT_NOT_FOUND", "Commission participant not found", 404);
            const { confirmed: _confirmed, ...input } = body;
            const participant = await endLoanCommissionParticipant(ctx, { participantPublicId: params.participantId, ...input });
            await invalidateTenantCache(user.tenantId);
            return participant;
        } catch (error) { return loanDomainFailure(error, set); }
    }, {
        params: t.Object({ id: t.String({ format: "uuid" }), participantId: t.String({ format: "uuid" }) }),
        body: t.Object({ effectiveTo: t.String({ format: "date-time" }), reason: t.String({ minLength: 1, maxLength: 500 }), confirmed: t.Literal(true) }, { additionalProperties: t.Never() }),
    })
    .post("/:id/commission/preview", async ({ params, body, user, request, set }) => {
        if (!user) return loanUnauthorized(set);
        try { return await previewLoanCommission(loanCommandContext(user, request), { loanPublicId: params.id, paymentPublicIds: body.paymentPublicIds }); }
        catch (error) { return loanDomainFailure(error, set); }
    }, {
        params: t.Object({ id: t.String({ format: "uuid" }) }),
        body: t.Object({ paymentPublicIds: t.Array(t.String({ format: "uuid" }), { minItems: 1, maxItems: 1_000 }) }, { additionalProperties: t.Never() }),
    })
    .get("/:id/commissions", async ({ params, query, user, request, set }) => {
        if (!user) return loanUnauthorized(set);
        try {
            const paymentPublicIds = query.paymentPublicIds.split(",").map((value) => value.trim()).filter(Boolean);
            return await previewLoanCommission(loanCommandContext(user, request), { loanPublicId: params.id, paymentPublicIds });
        } catch (error) { return loanDomainFailure(error, set); }
    }, {
        params: t.Object({ id: t.String({ format: "uuid" }) }),
        query: t.Object({ paymentPublicIds: t.String({ minLength: 36, maxLength: 37_000 }) }, { additionalProperties: t.Never() }),
    })
    .get("/:id", async ({ params, user, request, set }) => {
        if (!user) return loanUnauthorized(set);
        const scopeKey = getAccessScopeCacheKey(user);
        try {
            return await withTenantCache({
                tenantId: user.tenantId,
                namespace: "loans",
                key: `detail:${params.id}:${scopeKey}`,
                ttlSeconds: 30,
                loader: async () => {
                    const ctx = loanCommandContext(user, request);
                    const accessibleLoan = await findAccessibleLoanByPublicId(user, params.id);
                    if (!accessibleLoan) throw new DomainError("LOAN_NOT_FOUND", "Loan not found", 404);
                    const [loan, commissionParticipants, paymentRows] = await Promise.all([
                        getLoanApplication(ctx, params.id),
                        listLoanCommissionParticipants(ctx, params.id),
                        db.select({ publicId: transactions.publicId }).from(transactions).where(and(
                            eq(transactions.tenantId, user.tenantId), eq(transactions.loanId, accessibleLoan.id),
                            isNotNull(transactions.postedAt), inArray(transactions.entryType, ["repayment", "reversal"]),
                            inArray(transactions.type, ["repayment", "close_account", "reversal"]),
                            sql`(${transactions.paymentIntakeId} IS NULL OR EXISTS (
                                SELECT 1 FROM ${paymentIntakes}
                                WHERE ${paymentIntakes.tenantId} = ${user.tenantId}
                                  AND ${paymentIntakes.id} = ${transactions.paymentIntakeId}
                                  AND ${paymentIntakes.status} = 'posted'
                                  AND ${paymentIntakes.postedAt} IS NOT NULL
                            ))`,
                        )),
                    ]);
                    const commissionSummary = paymentRows.length > 0
                        ? await previewLoanCommission(ctx, { loanPublicId: params.id, paymentPublicIds: paymentRows.map((row) => row.publicId) })
                        : { loanPublicId: params.id, paymentPublicIds: [], interestAmount: "0.00", totalCommission: "0.00", participants: [] };
                    return { ...loan, commissionParticipantCount: commissionParticipants.length, commissionParticipants, commissionSummary };
                },
            });
        } catch (error) {
            return loanDomainFailure(error, set);
        }
    }, { params: t.Object({ id: t.String() }) })
    .get("/:id/schedule-summary", async ({ params, user, set }) => {
        if (!user) return loanUnauthorized(set);
        const loan = await findAccessibleLoanByPublicId(user, params.id);
        if (!loan) return loanDomainFailure(new DomainError("LOAN_NOT_FOUND", "Loan not found", 404), set);

        const scopeKey = getAccessScopeCacheKey(user);
        return withTenantCache({
            tenantId: user.tenantId,
            namespace: "loans",
            key: `schedule-summary:${loan.id}:${scopeKey}`,
            ttlSeconds: 20,
            loader: async () => {
                const [scheduleRows, deferralRows] = await Promise.all([
                    db.select().from(loanSchedules).where(and(
                    eq(loanSchedules.loanId, loan.id),
                    eq(loanSchedules.tenantId, user.tenantId),
                    )),
                    db.select({ id: loanScheduleDeferrals.id }).from(loanScheduleDeferrals).where(and(
                        eq(loanScheduleDeferrals.loanId, loan.id),
                        eq(loanScheduleDeferrals.tenantId, user.tenantId),
                    )),
                ]);
                return summarizeLoanSchedule(loan, scheduleRows, countLoanScheduleDeferrals(deferralRows));
            },
        });
    }, { params: t.Object({ id: t.String() }) })
    .get("/:id/schedule", async ({ params, user, request, set }) => {
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
                const [scheduleRows, paymentRows, deferralRows] = await Promise.all([
                    db.select().from(loanSchedules).where(and(
                        eq(loanSchedules.loanId, loan.id),
                        eq(loanSchedules.tenantId, user.tenantId),
                    )).orderBy(loanSchedules.installmentNo),
                    listCanonicalPostedPaymentsForLoan(user.tenantId, loan.id),
                    db.select().from(loanScheduleDeferrals).where(and(
                        eq(loanScheduleDeferrals.tenantId, user.tenantId),
                        eq(loanScheduleDeferrals.loanId, loan.id),
                    )),
                ]);
                const deferralBySource = new Map(deferralRows.map((row) => [row.sourceScheduleId, row]));
                const deferralByReplacement = new Map(deferralRows.map((row) => [row.replacementScheduleId, row]));
                const paymentIdsBySchedule = new Map<number, string[]>();
                for (const payment of paymentRows) {
                    if (payment.scheduleId === null) continue;
                    const ids = paymentIdsBySchedule.get(payment.scheduleId) ?? [];
                    ids.push(payment.publicId);
                    paymentIdsBySchedule.set(payment.scheduleId, ids);
                }
                const ctx = loanCommandContext(user, request);
                return Promise.all(scheduleRows.map(async (row) => {
                    const paymentPublicIds = paymentIdsBySchedule.get(row.id) ?? [];
                    const commissionAmount = paymentPublicIds.length === 0
                        ? "0.00"
                        : (await previewLoanCommission(ctx, { loanPublicId: loan.publicId, paymentPublicIds })).totalCommission;
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
                        commissionAmount,
                        overdueDays: overdue.overdueDays,
                        penaltyDue: overdue.penaltyDue.toFixed(2),
                        totalDueNow: overdue.totalDueNow.toFixed(2),
                        status: row.status === "deferred" ? "deferred" : overdue.effectiveStatus,
                        deferredReplacementSchedulePublicId: deferralBySource.get(row.id) ? scheduleRows.find((candidate) => candidate.id === deferralBySource.get(row.id)!.replacementScheduleId)?.publicId ?? null : null,
                        deferredSourceSchedulePublicId: deferralByReplacement.get(row.id) ? scheduleRows.find((candidate) => candidate.id === deferralByReplacement.get(row.id)!.sourceScheduleId)?.publicId ?? null : null,
                        deferralReason: getDeferralReasonForSchedule(row.id, deferralRows),
                        createdAt: row.createdAt,
                        updatedAt: row.updatedAt,
                    };
                }));
            },
        });
    }, { params: t.Object({ id: t.String() }) })
    .post("/:id/schedule/:scheduleId/defer", async ({ params, body, user, request, set }) => {
        if (!user) return loanUnauthorized(set);
        try {
            const result = await deferLoanSchedule(loanCommandContext(user, request), params.id, params.scheduleId, body);
            await invalidateTenantCache(user.tenantId);
            return result;
        } catch (error) {
            return loanDomainFailure(error, set);
        }
    }, {
        params: t.Object({ id: t.String(), scheduleId: t.String() }),
        body: t.Object({ reason: t.String({ minLength: 1, maxLength: 2000 }) }),
    })
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
                // Legacy close is still a terminal writer. Lock and read the public target in
                // this transaction so replacement execution cannot commit `replaced` between
                // eligibility validation and the close update.
                const loan = (await tx.select().from(loans).where(and(
                    eq(loans.publicId, params.id),
                    ...loanAccessFilters(user),
                )).for("update").limit(1))[0] ?? null;
                if (!loan) throw new DomainError("LOAN_NOT_FOUND", "Loan not found", 404);
                requireLegacyCloseEligible(loan);
                if (loan.status === "closed") throw new DomainError("LOAN_ALREADY_CLOSED", "Loan is already closed", 409);
                const before = await getLoanApplication(loanCommandContext(user, request), loan.publicId);
                const updated = await tx.update(loans).set({ status: "closed", updatedAt: new Date() })
                    .where(and(
                        eq(loans.tenantId, user.tenantId),
                        eq(loans.id, loan.id),
                        sql`${loans.status} IS NOT DISTINCT FROM ${loan.status}`,
                    )).returning().then((rows) => rows[0]);
                if (!updated) {
                    throw new DomainError("LOAN_STATE_CHANGED", "Loan state changed before close", 409);
                }
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
    .post("/:id/cancel/preview", async ({ params, body, user, request, set }) => {
        if (!user) return loanUnauthorized(set);
        try {
            return await previewUnfundedLoanCancellation(loanCommandContext(user, request), params.id, body.reason);
        } catch (error) {
            return loanDomainFailure(error, set);
        }
    }, { params: t.Object({ id: t.String() }), body: loanCancellationPreviewBody })
    .post("/cancel/:previewId/execute", async ({ params, body, user, request, set }) => {
        if (!user) return loanUnauthorized(set);
        try {
            return await executeUnfundedLoanCancellation(loanCommandContext(user, request), {
                previewPublicId: params.previewId,
                previewHash: body.previewHash,
                expectedBalanceVersion: body.expectedBalanceVersion,
                confirmed: body.confirmed,
                reason: body.reason,
            });
        } catch (error) {
            return loanDomainFailure(error, set);
        }
    }, { params: t.Object({ previewId: t.String() }), body: loanCancellationExecuteBody })
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
    .post("/:id/payment-start-date", async ({ params, body, user, request, set }) => {
        if (!user) return loanUnauthorized(set);
        try {
            const updated = await updateLoanPaymentStartDate(loanCommandContext(user, request), params.id, body);
            await invalidateTenantCache(user.tenantId);
            return updated;
        } catch (error) {
            return loanDomainFailure(error, set);
        }
    }, { params: t.Object({ id: t.String() }), body: t.Object({ paymentStartDate: t.String(), reason: t.String() }) })
    .delete("/:id", async ({ params, body, user, request, set }) => {
        if (!user) return loanUnauthorized(set);
        try {
            const deleted = await deleteLoanDraft(loanCommandContext(user, request), params.id, body);
            await invalidateTenantCache(user.tenantId);
            return deleted;
        } catch (error) {
            return loanDomainFailure(error, set);
        }
    }, { params: t.Object({ id: t.String() }), body: t.Object({ reason: t.String() }) })
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
