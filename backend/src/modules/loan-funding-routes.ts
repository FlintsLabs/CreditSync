import { Elysia, t } from "elysia";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { bankProfiles, bankLoans, loanFundingAllocations, loans } from "../db/schema";
import { createAuditLog } from "../lib/audit-log";
import { canAccessTenantWideData, getAccessScopeCacheKey, loanAccessFilters } from "../lib/access";
import { invalidateTenantCache, withTenantCache } from "../lib/cache";
import { serializeMoney } from "../lib/money";
import { getLoanProfitabilitySummary } from "../lib/fund-settlement";
import { findAccessibleLoanByPublicId, findBankLoanByPublicId, findBankProfileByPublicId } from "../lib/public-id";
import { authPlugin } from "../middleware/auth";
import { DomainError } from "../services/domain-error";
import { loanDomainFailure, loanForbidden, loanMoneyInput, loanUnauthorized } from "./loan-http-support";
import { isMutableFundingLoan, presentFundingAllocation, presentLoanProfitability } from "./loan-funding-presenters";
import { FinancialDecimal } from "../lib/financial-decimal";

function assertMutableFundingLoan(loan: typeof loans.$inferSelect) {
    if (!isMutableFundingLoan(loan.status)) {
        throw new DomainError("LOAN_FUNDING_LOCKED", "Funding cannot be changed after a loan is renewed or canceled", 409);
    }
}

export const loanFundingRoutes = new Elysia().use(authPlugin)
    .get("/:id/funding-allocations", async ({ params, user, set }) => {
        if (!user) return loanUnauthorized(set);
        const loan = await findAccessibleLoanByPublicId(user, params.id);
        if (!loan) return loanDomainFailure(new DomainError("LOAN_NOT_FOUND", "Loan not found", 404), set);

        const scopeKey = getAccessScopeCacheKey(user);
        return withTenantCache({
            tenantId: user.tenantId,
            namespace: "loans",
            key: `funding-allocations:${loan.id}:${scopeKey}`,
            ttlSeconds: 20,
            loader: async () => {
                const rows = await db.select().from(loanFundingAllocations).where(and(
                    eq(loanFundingAllocations.loanId, loan.id),
                    eq(loanFundingAllocations.tenantId, user.tenantId),
                )).orderBy(desc(loanFundingAllocations.createdAt));
                return Promise.all(rows.map(async (row) => ({
                    ...await presentFundingAllocation(row),
                    bankProfileName: row.bankProfileId === null ? null : await db.query.bankProfiles.findFirst({
                        where: and(eq(bankProfiles.id, row.bankProfileId), eq(bankProfiles.tenantId, user.tenantId)),
                    }).then((profile) => profile?.name ?? null),
                })));
            },
        });
    }, { params: t.Object({ id: t.String() }) })
    .get("/:id/profitability", async ({ params, user, set }) => {
        if (!user) return loanUnauthorized(set);
        if (!canAccessTenantWideData(user)) return loanForbidden(set);
        const summary = await withTenantCache({
            tenantId: user.tenantId,
            namespace: "loans",
            key: `profitability:${params.id}`,
            ttlSeconds: 20,
            loader: async () => {
                const loan = await findAccessibleLoanByPublicId(user, params.id);
                if (!loan) return null;
                const profitability = await getLoanProfitabilitySummary(user.tenantId, loan.id);
                return profitability ? presentLoanProfitability(user.tenantId, loan.publicId, profitability) : null;
            },
        });
        return summary ?? loanDomainFailure(new DomainError("LOAN_NOT_FOUND", "Loan not found", 404), set);
    }, { params: t.Object({ id: t.String() }) })
    .get("/:id/allocation-state", async ({ params, user, set }) => {
        if (!user) return loanUnauthorized(set);
        const loan = await findAccessibleLoanByPublicId(user, params.id);
        if (!loan) return loanDomainFailure(new DomainError("LOAN_NOT_FOUND", "Loan not found", 404), set);
        const scopeKey = getAccessScopeCacheKey(user);
        return withTenantCache({
            tenantId: user.tenantId,
            namespace: "loans",
            key: `allocation-state:${loan.id}:${scopeKey}`,
            ttlSeconds: 20,
            loader: async () => {
                const netAllocated = await db.select({
                    totalAllocated: sql<string>`coalesce(sum(${loanFundingAllocations.allocatedAmount}), 0)`,
                }).from(loanFundingAllocations).where(and(
                    eq(loanFundingAllocations.tenantId, user.tenantId),
                    eq(loanFundingAllocations.loanId, loan.id),
                )).then((rows) => new FinancialDecimal(rows[0]?.totalAllocated ?? "0"));
                const principalAmount = new FinancialDecimal(loan.principalAmount ?? "0");
                const zero = new FinancialDecimal("0");
                const remainingGap = FinancialDecimal.max(zero, principalAmount.minus(netAllocated));
                const overfundedAmount = FinancialDecimal.max(zero, netAllocated.minus(principalAmount));
                const state = netAllocated.lte(0) ? "unfunded" : overfundedAmount.gt(0) ? "overfunded" : remainingGap.isZero() ? "fully_funded" : "partially_funded";
                return {
                    loanId: loan.publicId,
                    loanPublicId: loan.publicId,
                    principalAmount: serializeMoney(principalAmount),
                    netAllocatedPrincipal: serializeMoney(netAllocated),
                    remainingGap: serializeMoney(remainingGap),
                    overfundedAmount: serializeMoney(overfundedAmount),
                    state,
                };
            },
        });
    }, { params: t.Object({ id: t.String() }) })
    .post("/:id/funding-allocations", async ({ params, body, user, set }) => {
        if (!user) return loanUnauthorized(set);
        if (!canAccessTenantWideData(user)) return loanForbidden(set);
        try {
            const amount = loanMoneyInput(body.allocatedAmount, "allocatedAmount");
            const created = await db.transaction(async (tx) => {
                const resolvedLoan = await findAccessibleLoanByPublicId(user, params.id);
                if (!resolvedLoan) throw new DomainError("LOAN_NOT_FOUND", "Loan not found", 404);
                await tx.execute(sql`SELECT id FROM loans WHERE tenant_id = ${user.tenantId} AND id = ${resolvedLoan.id} FOR UPDATE`);
                const loan = await tx.select().from(loans).where(and(eq(loans.id, resolvedLoan.id), ...loanAccessFilters(user))).then((rows) => rows[0]);
                if (!loan) throw new DomainError("LOAN_NOT_FOUND", "Loan not found", 404);
                assertMutableFundingLoan(loan);

                const requestedProfile = body.bankProfilePublicId ? await findBankProfileByPublicId(user.tenantId, body.bankProfilePublicId) : null;
                if (body.bankProfilePublicId && !requestedProfile) throw new DomainError("BANK_PROFILE_NOT_FOUND", "Bank profile not found", 404);
                const requestedDrawdown = body.bankLoanPublicId ? await findBankLoanByPublicId(user.tenantId, body.bankLoanPublicId) : null;
                if (body.bankLoanPublicId && !requestedDrawdown) throw new DomainError("BANK_LOAN_NOT_FOUND", "Bank loan not found", 404);
                let sourceBankProfileId = requestedProfile?.id ?? null;
                if (requestedDrawdown) {
                    const sourceDrawdown = await tx.execute(sql`SELECT * FROM bank_loans WHERE id = ${requestedDrawdown.id} AND tenant_id = ${user.tenantId} FOR UPDATE`).then((res) => res[0] as typeof bankLoans.$inferSelect | undefined);
                    if (!sourceDrawdown) throw new DomainError("BANK_LOAN_NOT_FOUND", "Bank loan not found", 404);
                    const sourceAllocation = await tx.select({ totalAllocated: sql<string>`coalesce(sum(${loanFundingAllocations.allocatedAmount}), 0)` })
                        .from(loanFundingAllocations).where(and(eq(loanFundingAllocations.bankLoanId, requestedDrawdown.id), eq(loanFundingAllocations.tenantId, user.tenantId)))
                        .then((rows) => new FinancialDecimal(rows[0]?.totalAllocated ?? "0"));
                    const sourceRemaining = new FinancialDecimal(sourceDrawdown.amount).minus(sourceAllocation);
                    if (amount.gt(sourceRemaining)) throw new DomainError("ALLOCATION_EXCEEDS_DRAWDOWN", "Allocation exceeds remaining drawdown balance", 400, { sourceRemaining: serializeMoney(FinancialDecimal.max(new FinancialDecimal("0"), sourceRemaining)) });
                    sourceBankProfileId = requestedDrawdown.bankProfileId;
                }
                if (!sourceBankProfileId && !requestedDrawdown) throw new DomainError("FUNDING_SOURCE_REQUIRED", "Either bankProfilePublicId or bankLoanPublicId is required", 400);
                const currentAllocation = await tx.select({ totalAllocated: sql<string>`coalesce(sum(${loanFundingAllocations.allocatedAmount}), 0)` })
                    .from(loanFundingAllocations).where(and(eq(loanFundingAllocations.loanId, loan.id), eq(loanFundingAllocations.tenantId, user.tenantId)))
                    .then((rows) => new FinancialDecimal(rows[0]?.totalAllocated ?? "0"));
                const remainingLoanCapacity = new FinancialDecimal(loan.principalAmount).minus(currentAllocation);
                if (amount.gt(remainingLoanCapacity)) throw new DomainError("ALLOCATION_EXCEEDS_PRINCIPAL", "Allocation exceeds remaining unfunded principal", 400, { remainingCapacity: serializeMoney(remainingLoanCapacity) });
                const created = await tx.insert(loanFundingAllocations).values({
                    tenantId: user.tenantId,
                    bankProfileId: sourceBankProfileId,
                    bankLoanId: requestedDrawdown?.id ?? null,
                    loanId: loan.id,
                    allocatedAmount: serializeMoney(amount),
                    allocationDate: body.allocationDate,
                    allocationType: body.allocationType ?? "initial",
                    allocationGroupId: crypto.randomUUID(),
                    note: body.note,
                    createdByUserId: user.id,
                }).returning().then((rows) => rows[0]);
                await createAuditLog(tx, { tenantId: user.tenantId, actorUserId: user.id, entityType: "loan_funding_allocation", entityId: created.publicId, action: "created", payload: await presentFundingAllocation(created) });
                return presentFundingAllocation(created);
            });
            await invalidateTenantCache(user.tenantId);
            return created;
        } catch (error) {
            return loanDomainFailure(error, set);
        }
    }, {
        params: t.Object({ id: t.String() }),
        body: t.Object({
            bankProfilePublicId: t.Optional(t.String()), bankLoanPublicId: t.Optional(t.String()), allocatedAmount: t.String(), allocationDate: t.String(),
            allocationType: t.Optional(t.Union([t.Literal("initial"), t.Literal("manual_adjustment"), t.Literal("reallocation_in"), t.Literal("reallocation_out")])),
            note: t.Optional(t.String()),
        }),
    })
    .post("/:id/funding-reallocations", async ({ params, body, user, set }) => {
        if (!user) return loanUnauthorized(set);
        if (!canAccessTenantWideData(user)) return loanForbidden(set);
        try {
            const amount = loanMoneyInput(body.amount, "amount");
            const resolvedLoan = await findAccessibleLoanByPublicId(user, params.id);
            if (!resolvedLoan) throw new DomainError("LOAN_NOT_FOUND", "Loan not found", 404);
            const createdRows = await db.transaction(async (tx) => {
                await tx.execute(sql`SELECT id FROM loans WHERE tenant_id = ${user.tenantId} AND id = ${resolvedLoan.id} FOR UPDATE`);
                const loan = await tx.select().from(loans).where(and(eq(loans.id, resolvedLoan.id), ...loanAccessFilters(user))).then((rows) => rows[0]);
                if (!loan) throw new DomainError("LOAN_NOT_FOUND", "Loan not found", 404);
                assertMutableFundingLoan(loan);
                const sourceDrawdown = await tx.select().from(bankLoans).where(and(eq(bankLoans.publicId, body.fromBankLoanPublicId), eq(bankLoans.tenantId, user.tenantId))).then((rows) => rows[0]);
                const targetDrawdown = await tx.select().from(bankLoans).where(and(eq(bankLoans.publicId, body.toBankLoanPublicId), eq(bankLoans.tenantId, user.tenantId))).then((rows) => rows[0]);
                if (!sourceDrawdown || !targetDrawdown) throw new DomainError("BANK_LOAN_NOT_FOUND", "Source or target drawdown not found", 404);
                if (body.fromBankLoanPublicId === body.toBankLoanPublicId) throw new DomainError("SAME_FUNDING_SOURCE", "Source and target drawdowns must be different", 400);
                const bankLoanIds = [sourceDrawdown.id, targetDrawdown.id].sort((a, b) => a - b);
                await tx.execute(sql`SELECT id FROM bank_loans WHERE tenant_id = ${user.tenantId} AND id IN (${sql.join(bankLoanIds.map((id) => sql`${id}`), sql`, `)}) ORDER BY id FOR UPDATE`);
                const currentSourceAllocation = await tx.select({ totalAllocated: sql<string>`coalesce(sum(${loanFundingAllocations.allocatedAmount}), 0)` })
                    .from(loanFundingAllocations).where(and(eq(loanFundingAllocations.loanId, loan.id), eq(loanFundingAllocations.bankLoanId, sourceDrawdown.id), eq(loanFundingAllocations.tenantId, user.tenantId)))
                    .then((rows) => new FinancialDecimal(rows[0]?.totalAllocated ?? "0"));
                if (amount.gt(currentSourceAllocation)) throw new DomainError("REALLOCATION_EXCEEDS_SOURCE", "Reallocation exceeds current allocation on the source drawdown", 400, { sourceAllocated: serializeMoney(currentSourceAllocation) });
                const targetAllocation = await tx.select({ totalAllocated: sql<string>`coalesce(sum(${loanFundingAllocations.allocatedAmount}), 0)` })
                    .from(loanFundingAllocations).where(and(eq(loanFundingAllocations.bankLoanId, targetDrawdown.id), eq(loanFundingAllocations.tenantId, user.tenantId)))
                    .then((rows) => new FinancialDecimal(rows[0]?.totalAllocated ?? "0"));
                const targetRemaining = new FinancialDecimal(targetDrawdown.amount).minus(targetAllocation);
                if (amount.gt(targetRemaining)) throw new DomainError("REALLOCATION_EXCEEDS_TARGET", "Reallocation exceeds remaining target drawdown balance", 400, { targetRemaining: serializeMoney(targetRemaining) });
                const allocationGroupId = crypto.randomUUID();
                const rows = await tx.insert(loanFundingAllocations).values([
                    { tenantId: user.tenantId, bankProfileId: sourceDrawdown.bankProfileId, bankLoanId: sourceDrawdown.id, loanId: loan.id, allocatedAmount: amount.negated().toFixed(2), allocationDate: body.allocationDate, allocationType: "reallocation_out", allocationGroupId, note: body.note ?? `Reallocated out to drawdown ${targetDrawdown.publicId}`, createdByUserId: user.id },
                    { tenantId: user.tenantId, bankProfileId: targetDrawdown.bankProfileId, bankLoanId: targetDrawdown.id, loanId: loan.id, allocatedAmount: amount.toFixed(2), allocationDate: body.allocationDate, allocationType: "reallocation_in", allocationGroupId, note: body.note ?? `Reallocated in from drawdown ${sourceDrawdown.publicId}`, createdByUserId: user.id },
                ]).returning();
                await createAuditLog(tx, { tenantId: user.tenantId, actorUserId: user.id, entityType: "loan_funding_reallocation", entityId: `${rows[0].publicId}:${rows[1].publicId}`, action: "created", payload: { loanPublicId: loan.publicId, fromBankLoanPublicId: sourceDrawdown.publicId, toBankLoanPublicId: targetDrawdown.publicId, amount: amount.toFixed(2), allocationDate: body.allocationDate, note: body.note } });
                return Promise.all(rows.map(presentFundingAllocation));
            });
            await invalidateTenantCache(user.tenantId);
            return createdRows;
        } catch (error) {
            return loanDomainFailure(error, set);
        }
    }, {
        params: t.Object({ id: t.String() }),
        body: t.Object({ fromBankLoanPublicId: t.String(), toBankLoanPublicId: t.String(), amount: t.String(), allocationDate: t.String(), note: t.Optional(t.String()) }),
    });
