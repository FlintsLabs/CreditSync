import { and, eq, sql } from "drizzle-orm";
import dayjs from "dayjs";
import { createHash } from "node:crypto";
import { db } from "../db";
import { bankLoanSchedules, bankLoans, bankProfiles, users } from "../db/schema";
import { createAuditLog } from "../lib/audit-log";
import { generateBankLoanSchedule, type BankLoanScheduleInput, type BankLoanScheduleRow, type RepaymentMode } from "../lib/bank-loan-schedule";
import { serializeMoney } from "../lib/money";
import { FinancialDecimal } from "../lib/financial-decimal";
import type { CommandContext } from "./command-context";
import { DomainError } from "./domain-error";
import { canAccessTenantWideData } from "../lib/access";

export type BankDrawdownInput = BankLoanScheduleInput & { bankProfilePublicId: string; repaymentMode: RepaymentMode; note?: string };
export type BankDrawdownPreview = { input: BankDrawdownInput; schedule: BankLoanScheduleRow[]; totalInterest: string; totalFees: string; totalVat: string; firstDueDate: string; lastDueDate: string };

function decimal(value: string | undefined, name: string, positive = false) {
    try { const d = new FinancialDecimal(value ?? "0"); if (!d.isFinite() || d.isNegative() || (positive && d.isZero())) throw new Error(); return d; } catch { throw new DomainError("INVALID_BANK_DRAWDOWN", `${name} must be a valid ${positive ? "positive" : "nonnegative"} decimal`, 400); }
}
function normalized(input: BankDrawdownInput): BankDrawdownInput {
    const cycles = ["daily", "weekly", "monthly", "custom"];
    if (!input.bankProfilePublicId?.trim()) throw new DomainError("INVALID_BANK_DRAWDOWN", "Profile is required", 400);
    if (!input.startDate || !/^\d{4}-\d{2}-\d{2}$/.test(input.startDate) || !dayjs(input.startDate).isValid() || dayjs(input.startDate).format("YYYY-MM-DD") !== input.startDate) throw new DomainError("INVALID_START_DATE", "A valid ISO start date is required", 400);
    if (!cycles.includes(input.repaymentCycle ?? "monthly")) throw new DomainError("INVALID_REPAYMENT_CYCLE", "Repayment cycle is invalid", 400);
    if (input.repaymentMode !== "fixed_installment") throw new DomainError("INVALID_REPAYMENT_MODE", "Only fixed_installment repayment mode is supported", 400);
    const amount = decimal(input.amount, "Amount", true), rate = decimal(input.interestRate, "Interest rate");
    if (input.termMonths !== undefined && (!Number.isInteger(input.termMonths) || input.termMonths < 1 || input.termMonths > 1200)) throw new DomainError("INVALID_TERM", "Term must be between 1 and 1200 months", 400);
    if (input.totalInstallments !== undefined && (!Number.isInteger(input.totalInstallments) || input.totalInstallments < 1 || input.totalInstallments > 10000)) throw new DomainError("INVALID_INSTALLMENTS", "Installments must be a positive bounded integer", 400);
    const installmentAmount = input.installmentAmount === undefined ? undefined : decimal(input.installmentAmount, "Installment", true).toFixed(2);
    return { ...input, amount: amount.toFixed(2), interestRate: rate.toFixed(4), installmentAmount, processingFeeAmount: decimal(input.processingFeeAmount, "Processing fee").toFixed(2), utilizationFeeAmount: decimal(input.utilizationFeeAmount, "Utilization fee").toFixed(2), vatRate: decimal(input.vatRate, "VAT rate").toFixed(4) };
}

function requiredIdempotencyKey(ctx: CommandContext) {
    const key = ctx.idempotencyKey?.trim();
    if (!key) throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", "Idempotency key is required", 400);
    return key;
}

function fingerprint(input: unknown) { return createHash("sha256").update(JSON.stringify(input)).digest("hex"); }
async function authorize(ctx: CommandContext, executor: any = db) {
    if (ctx.actorUserId === null) throw new DomainError("TENANT_ADMIN_REQUIRED", "A tenant owner or manager is required", 403);
    const actor = (await executor.select().from(users).where(and(eq(users.id, ctx.actorUserId), eq(users.tenantId, ctx.tenantId))).limit(1))[0];
    if (!actor || !canAccessTenantWideData({ role: actor.role ?? "viewer" })) throw new DomainError("TENANT_ADMIN_REQUIRED", "A tenant owner or manager is required", 403);
}

async function profile(ctx: CommandContext, publicId: string, executor: any = db) {
    const rows = await executor.select().from(bankProfiles).where(and(eq(bankProfiles.tenantId, ctx.tenantId), eq(bankProfiles.publicId, publicId))).limit(1);
    const row = rows[0];
    if (!row) throw new DomainError("BANK_PROFILE_NOT_FOUND", "Bank profile not found", 404);
    if (row.status !== "active") throw new DomainError("BANK_PROFILE_INACTIVE", "Bank profile is inactive", 409);
    return row;
}

export async function previewBankDrawdown(ctx: CommandContext, raw: BankDrawdownInput): Promise<BankDrawdownPreview> {
    await authorize(ctx); const input = normalized(raw); await profile(ctx, input.bankProfilePublicId);
    const schedule = generateBankLoanSchedule(input);
    const sum = (key: "scheduledInterest" | "scheduledFee" | "scheduledVat") => schedule.reduce((v, row) => v.plus(row[key]), new FinancialDecimal(0)).toFixed(2);
    return { input, schedule, totalInterest: sum("scheduledInterest"), totalFees: sum("scheduledFee"), totalVat: sum("scheduledVat"), firstDueDate: schedule[0]?.dueDate ?? "", lastDueDate: schedule.at(-1)?.dueDate ?? "" };
}

export async function createBankDrawdownDraft(ctx: CommandContext, raw: BankDrawdownInput) {
    const key = requiredIdempotencyKey(ctx);
    await authorize(ctx); const input = normalized(raw); const hash = fingerprint(input);
    return db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`bank-drawdown:${ctx.tenantId}:${key}`}, 0))`);
        const existing = (await tx.select().from(bankLoans).where(and(eq(bankLoans.tenantId, ctx.tenantId), eq(bankLoans.idempotencyKey, key))).limit(1))[0];
        const payload = JSON.stringify(input);
        if (existing) { if (existing.requestHash !== hash) throw new DomainError("IDEMPOTENCY_CONFLICT", "Idempotency key payload differs", 409); return existing; }
        const p = (await tx.select().from(bankProfiles).where(and(eq(bankProfiles.tenantId, ctx.tenantId), eq(bankProfiles.publicId, input.bankProfilePublicId))).for("update").limit(1))[0];
        if (!p) throw new DomainError("BANK_PROFILE_NOT_FOUND", "Bank profile not found", 404);
        if (p.status !== "active") throw new DomainError("BANK_PROFILE_INACTIVE", "Bank profile is inactive", 409);
        const totals = await tx.select({ total: sql<string>`coalesce(sum(${bankLoans.amount}), 0)` }).from(bankLoans).where(and(eq(bankLoans.tenantId, ctx.tenantId), eq(bankLoans.bankProfileId, p.id), sql`${bankLoans.status} IN ('draft','active')`));
        if (p.creditLimit && new FinancialDecimal(totals[0]?.total ?? "0").plus(input.amount).gt(p.creditLimit)) throw new DomainError("CREDIT_LIMIT_EXCEEDED", "Drawdown exceeds credit limit", 409);
        const row = (await tx.insert(bankLoans).values({ tenantId: ctx.tenantId, bankProfileId: p.id, amount: input.amount, interestRate: input.interestRate, startDate: input.startDate, termMonths: input.termMonths, repaymentCycle: input.repaymentCycle ?? "monthly", repaymentMode: input.repaymentMode, installmentAmount: input.installmentAmount, totalInstallments: input.totalInstallments, processingFeeAmount: input.processingFeeAmount, utilizationFeeAmount: input.utilizationFeeAmount, vatRate: input.vatRate, status: "draft", idempotencyKey: key, requestHash: hash, requestId: ctx.requestId, correlationId: ctx.correlationId, createdByUserId: ctx.actorUserId, updatedByUserId: ctx.actorUserId, note: input.note ?? null }).returning())[0]!;
        await createAuditLog(tx, { tenantId: ctx.tenantId, actorUserId: ctx.actorUserId, actorSource: ctx.actorSource, requestId: ctx.requestId, correlationId: ctx.correlationId, entityType: "bank_loan", entityId: row.id, action: "draft_created", payload: { idempotencyKey: key } });
        return row;
    });
}

export async function activateBankDrawdown(ctx: CommandContext, input: { bankLoanPublicId: string }) {
    const activationKey = requiredIdempotencyKey(ctx);
    await authorize(ctx);
    return db.transaction(async (tx) => {
        const activationHash = fingerprint(input);
        const keyOwner = (await tx.select({ id: bankLoans.id, activationRequestHash: bankLoans.activationRequestHash }).from(bankLoans).where(and(eq(bankLoans.tenantId, ctx.tenantId), eq(bankLoans.activationIdempotencyKey, activationKey))).limit(1))[0];
        if (keyOwner && keyOwner.activationRequestHash !== activationHash) throw new DomainError("IDEMPOTENCY_CONFLICT", "Activation key is bound to another command", 409);
        const target = (await tx.select({ bankProfileId: bankLoans.bankProfileId }).from(bankLoans).where(and(eq(bankLoans.tenantId, ctx.tenantId), eq(bankLoans.publicId, input.bankLoanPublicId))).limit(1))[0];
        if (!target) throw new DomainError("BANK_LOAN_NOT_FOUND", "Bank loan not found", 404);
        const p = (await tx.select().from(bankProfiles).where(and(eq(bankProfiles.id, target.bankProfileId!), eq(bankProfiles.tenantId, ctx.tenantId))).for("update").limit(1))[0];
        const row = (await tx.select().from(bankLoans).where(and(eq(bankLoans.tenantId, ctx.tenantId), eq(bankLoans.publicId, input.bankLoanPublicId))).for("update").limit(1))[0];
        if (!row) throw new DomainError("BANK_LOAN_NOT_FOUND", "Bank loan not found", 404);
        if (row.status === "active") { if (row.activationIdempotencyKey !== activationKey || row.activationRequestHash !== activationHash) throw new DomainError("IDEMPOTENCY_CONFLICT", "Activation command differs", 409); return row; }
        if (row.status !== "draft" || !row.bankProfileId) throw new DomainError("BANK_LOAN_NOT_DRAFT", "Bank loan is not an activatable draft", 409);
        if (!p || p.status !== "active") throw new DomainError("BANK_PROFILE_INACTIVE", "Bank profile is inactive", 409);
        const totals = await tx.select({ total: sql<string>`coalesce(sum(${bankLoans.amount}), 0)` }).from(bankLoans).where(and(eq(bankLoans.tenantId, ctx.tenantId), eq(bankLoans.bankProfileId, row.bankProfileId), sql`${bankLoans.status} IN ('draft','active')`));
        if (p.creditLimit && new FinancialDecimal(totals[0]?.total ?? "0").gt(p.creditLimit)) throw new DomainError("CREDIT_LIMIT_EXCEEDED", "Drawdown exceeds credit limit", 409);
        const schedule = generateBankLoanSchedule({ amount: row.amount, interestRate: row.interestRate ?? "0", startDate: row.startDate ?? undefined, termMonths: row.termMonths ?? undefined, repaymentCycle: row.repaymentCycle as BankLoanScheduleInput["repaymentCycle"], repaymentMode: row.repaymentMode as BankLoanScheduleInput["repaymentMode"], totalInstallments: row.totalInstallments ?? undefined, installmentAmount: row.installmentAmount ?? undefined, processingFeeAmount: row.processingFeeAmount ?? undefined, utilizationFeeAmount: row.utilizationFeeAmount ?? undefined, vatRate: row.vatRate ?? undefined });
        for (const s of schedule) await tx.insert(bankLoanSchedules).values({ tenantId: ctx.tenantId, bankLoanId: row.id, ...s });
        const active = (await tx.update(bankLoans).set({ status: "active", activationIdempotencyKey: activationKey, activationRequestHash: activationHash, activationResult: { publicId: row.publicId, status: "active" }, nextDueDate: schedule[0]?.dueDate, outstandingPrincipal: row.amount, outstandingInterest: schedule.reduce((v, s) => v.plus(s.scheduledInterest), new FinancialDecimal(0)).toFixed(2), outstandingFees: schedule.reduce((v, s) => v.plus(s.scheduledFee).plus(s.scheduledVat), new FinancialDecimal(0)).toFixed(2), updatedByUserId: ctx.actorUserId, updatedAt: new Date() }).where(eq(bankLoans.id, row.id)).returning())[0]!;
        await createAuditLog(tx, { tenantId: ctx.tenantId, actorUserId: ctx.actorUserId, actorSource: ctx.actorSource, requestId: ctx.requestId, correlationId: ctx.correlationId, entityType: "bank_loan", entityId: row.id, action: "activated", payload: { idempotencyKey: activationKey } });
        return active;
    });
}
