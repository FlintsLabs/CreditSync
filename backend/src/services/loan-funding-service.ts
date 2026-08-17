import { and, eq, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { db } from "../db";
import { auditLogs, bankLoans, bankProfiles, loanFundingAllocations, loans, users } from "../db/schema";
import { createAuditLog } from "../lib/audit-log";
import { canAccessTenantWideData, loanAccessFilters } from "../lib/access";
import { FinancialDecimal } from "../lib/financial-decimal";
import { serializeMoney } from "../lib/money";
import type { CommandContext } from "./command-context";
import { DomainError } from "./domain-error";
import { isMutableFundingLoan, presentFundingAllocation } from "../modules/loan-funding-presenters";

export type FundingAllocationInput = {
    loanPublicId: string; bankProfilePublicId?: string; bankLoanPublicId?: string;
    allocatedAmount: string; allocationDate: string; allocationType?: "initial" | "manual_adjustment" | "reallocation_in" | "reallocation_out"; note?: string;
};
export type FundingAllocationPreview = {
    source: { bankProfilePublicId: string | null; bankLoanPublicId: string | null; remainingCapacity: string };
    target: { loanPublicId: string; principalAmount: string; remainingUnfundedPrincipal: string };
    requestedAmount: string; resultingFunding: { netAllocatedPrincipal: string; remainingGap: string; state: string }; warnings: string[];
};
export type FundingAllocationResult = Awaited<ReturnType<typeof presentFundingAllocation>> & { auditPublicId?: string; correlationId?: string };

function fingerprint(input: unknown) { return createHash("sha256").update(JSON.stringify(input)).digest("hex"); }
function amount(value: string) { if (!/^\d+\.\d{2}$/.test(value)) throw new DomainError("INVALID_MONEY", "allocatedAmount must be a positive decimal with exactly two decimals", 400); try { const d = new FinancialDecimal(value); if (!d.isFinite() || d.lte(0)) throw new Error(); return d.toFixed(2); } catch { throw new DomainError("INVALID_MONEY", "allocatedAmount must be a positive decimal with exactly two decimals", 400); } }
function requireKey(ctx: CommandContext) { const key = ctx.idempotencyKey?.trim(); if (!key) throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key is required", 400); return key; }
async function authorize(ctx: CommandContext, executor: any = db) {
    if (ctx.actorUserId === null) throw new DomainError("TENANT_ADMIN_REQUIRED", "A tenant owner or manager is required", 403);
    const actor = (await executor.select().from(users).where(and(eq(users.id, ctx.actorUserId), eq(users.tenantId, ctx.tenantId))).limit(1))[0];
    if (!actor || !canAccessTenantWideData({ role: actor.role ?? "viewer" })) throw new DomainError("TENANT_ADMIN_REQUIRED", "A tenant owner or manager is required", 403);
}
async function resolve(tx: any, ctx: CommandContext, input: FundingAllocationInput, lock = true) {
    const loan = (await tx.select().from(loans).where(and(eq(loans.tenantId, ctx.tenantId), eq(loans.publicId, input.loanPublicId))).limit(1))[0];
    if (!loan) throw new DomainError("LOAN_NOT_FOUND", "Loan not found", 404);
    if (!isMutableFundingLoan(loan.status)) throw new DomainError("LOAN_FUNDING_LOCKED", "Funding cannot be changed after a loan is renewed or canceled", 409);
    const profile = input.bankProfilePublicId ? (await tx.select().from(bankProfiles).where(and(eq(bankProfiles.tenantId, ctx.tenantId), eq(bankProfiles.publicId, input.bankProfilePublicId))).limit(1))[0] : undefined;
    if (input.bankProfilePublicId && (!profile || profile.status !== "active")) throw new DomainError(profile ? "BANK_PROFILE_INACTIVE" : "BANK_PROFILE_NOT_FOUND", profile ? "Bank profile is inactive" : "Bank profile not found", 409);
    const drawdown = input.bankLoanPublicId ? (await tx.select().from(bankLoans).where(and(eq(bankLoans.tenantId, ctx.tenantId), eq(bankLoans.publicId, input.bankLoanPublicId))).limit(1))[0] : undefined;
    if (input.bankLoanPublicId && (!drawdown || drawdown.status !== "active")) throw new DomainError(drawdown ? "BANK_LOAN_INACTIVE" : "BANK_LOAN_NOT_FOUND", drawdown ? "Bank drawdown is inactive" : "Bank loan not found", 409);
    if (!profile && !drawdown) throw new DomainError("FUNDING_SOURCE_REQUIRED", "Either bankProfilePublicId or bankLoanPublicId is required", 400);
    if (lock) {
        await tx.execute(sql`SELECT id FROM loans WHERE tenant_id = ${ctx.tenantId} AND id = ${loan.id} FOR UPDATE`);
        if (drawdown) await tx.execute(sql`SELECT id FROM bank_loans WHERE tenant_id = ${ctx.tenantId} AND id = ${drawdown.id} FOR UPDATE`);
        if (profile) await tx.execute(sql`SELECT id FROM bank_profiles WHERE tenant_id = ${ctx.tenantId} AND id = ${profile.id} FOR UPDATE`);
    }
    const lockedLoan = lock ? (await tx.select().from(loans).where(and(eq(loans.tenantId, ctx.tenantId), eq(loans.id, loan.id))).limit(1))[0] : loan;
    if (!lockedLoan || !isMutableFundingLoan(lockedLoan.status)) throw new DomainError("LOAN_FUNDING_LOCKED", "Funding cannot be changed after a loan is terminal", 409);
    return { loan: lockedLoan, profile, drawdown };
}
async function capacities(tx: any, ctx: CommandContext, loan: any, drawdown: any) {
    const total = (await tx.select({ total: sql<string>`coalesce(sum(${loanFundingAllocations.allocatedAmount}),0)` }).from(loanFundingAllocations).where(and(eq(loanFundingAllocations.tenantId, ctx.tenantId), eq(loanFundingAllocations.loanId, loan.id))))[0]?.total ?? "0";
    const loanRemaining = FinancialDecimal.max(new FinancialDecimal(0), new FinancialDecimal(loan.principalAmount).minus(total));
    let sourceRemaining: InstanceType<typeof FinancialDecimal> | null = null;
    if (drawdown) { const used = (await tx.select({ total: sql<string>`coalesce(sum(${loanFundingAllocations.allocatedAmount}),0)` }).from(loanFundingAllocations).where(and(eq(loanFundingAllocations.tenantId, ctx.tenantId), eq(loanFundingAllocations.bankLoanId, drawdown.id))))[0]?.total ?? "0"; sourceRemaining = FinancialDecimal.max(new FinancialDecimal(0), new FinancialDecimal(drawdown.amount).minus(used)); }
    return { total: new FinancialDecimal(total), loanRemaining, sourceRemaining };
}
export async function previewFundingAllocation(ctx: CommandContext, input: FundingAllocationInput): Promise<FundingAllocationPreview> {
    await authorize(ctx); const requested = amount(input.allocatedAmount);
    return db.transaction(async tx => { const r = await resolve(tx, ctx, input, false); const c = await capacities(tx, ctx, r.loan, r.drawdown); const sourceProfilePublicId = r.profile?.publicId ?? (r.drawdown ? (await tx.select().from(bankProfiles).where(and(eq(bankProfiles.tenantId, ctx.tenantId), eq(bankProfiles.id, r.drawdown.bankProfileId))).limit(1))[0]?.publicId ?? null : null); const next = c.total.plus(requested); return { source: { bankProfilePublicId: sourceProfilePublicId, bankLoanPublicId: r.drawdown?.publicId ?? null, remainingCapacity: serializeMoney(c.sourceRemaining ?? new FinancialDecimal("999999999999999999999999999999.99")) }, target: { loanPublicId: r.loan.publicId, principalAmount: serializeMoney(r.loan.principalAmount), remainingUnfundedPrincipal: serializeMoney(c.loanRemaining) }, requestedAmount: requested, resultingFunding: { netAllocatedPrincipal: serializeMoney(next), remainingGap: serializeMoney(FinancialDecimal.max(new FinancialDecimal(0), new FinancialDecimal(r.loan.principalAmount).minus(next))), state: next.isZero() ? "unfunded" : next.gte(r.loan.principalAmount) ? "fully_funded" : "partially_funded" }, warnings: [] }; });
}
export async function createFundingAllocation(ctx: CommandContext, input: FundingAllocationInput): Promise<FundingAllocationResult> {
    const key = requireKey(ctx); const normalized = { ...input, allocatedAmount: amount(input.allocatedAmount) }; await authorize(ctx); const hash = fingerprint(normalized);
    return db.transaction(async tx => { await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`loan-funding:${ctx.tenantId}:${key}`},0))`); const existing = (await tx.select().from(loanFundingAllocations).where(and(eq(loanFundingAllocations.tenantId, ctx.tenantId), eq(loanFundingAllocations.idempotencyKey, key))).limit(1))[0]; if (existing) { if (existing.requestHash !== hash) throw new DomainError("IDEMPOTENCY_CONFLICT", "Idempotency key was used with a different request", 409); const audit = (await tx.select().from(auditLogs).where(and(eq(auditLogs.tenantId, ctx.tenantId), eq(auditLogs.entityId, existing.publicId), eq(auditLogs.action, "created"))).limit(1))[0]; return { ...await presentFundingAllocation(existing), auditPublicId: audit?.publicId, correlationId: ctx.correlationId }; } const r = await resolve(tx, ctx, normalized); const c = await capacities(tx, ctx, r.loan, r.drawdown); if (r.drawdown && new FinancialDecimal(normalized.allocatedAmount).gt(c.sourceRemaining!)) throw new DomainError("ALLOCATION_EXCEEDS_DRAWDOWN", "Allocation exceeds remaining drawdown balance", 400, { sourceRemaining: serializeMoney(c.sourceRemaining!) }); if (new FinancialDecimal(normalized.allocatedAmount).gt(c.loanRemaining)) throw new DomainError("ALLOCATION_EXCEEDS_PRINCIPAL", "Allocation exceeds remaining unfunded principal", 400, { remainingCapacity: serializeMoney(c.loanRemaining) }); const row = (await tx.insert(loanFundingAllocations).values({ tenantId: ctx.tenantId, bankProfileId: r.profile?.id ?? r.drawdown?.bankProfileId ?? null, bankLoanId: r.drawdown?.id ?? null, loanId: r.loan.id, allocatedAmount: normalized.allocatedAmount, allocationDate: normalized.allocationDate, allocationType: normalized.allocationType ?? "initial", allocationGroupId: crypto.randomUUID(), note: normalized.note, createdByUserId: ctx.actorUserId, idempotencyKey: key, requestHash: hash }).returning())[0]!; const audit = await createAuditLog(tx, { tenantId: ctx.tenantId, actorUserId: ctx.actorUserId, actorSource: ctx.actorSource, requestId: ctx.requestId, correlationId: ctx.correlationId, entityType: "loan_funding_allocation", entityId: row.publicId, action: "created", payload: { ...await presentFundingAllocation(row), requestHash: hash, idempotencyKey: key } }); return { ...await presentFundingAllocation(row), auditPublicId: audit.publicId, correlationId: ctx.correlationId }; });
}
export async function listLoanFundingAllocations(ctx: CommandContext, loanPublicId: string) { const loan = (await db.select().from(loans).where(and(eq(loans.tenantId, ctx.tenantId), eq(loans.publicId, loanPublicId))).limit(1))[0]; if (!loan) throw new DomainError("LOAN_NOT_FOUND", "Loan not found", 404); const rows = await db.select().from(loanFundingAllocations).where(and(eq(loanFundingAllocations.tenantId, ctx.tenantId), eq(loanFundingAllocations.loanId, loan.id))).orderBy(sql`${loanFundingAllocations.createdAt} DESC`); return Promise.all(rows.map(row => presentFundingAllocation(row)));
}
