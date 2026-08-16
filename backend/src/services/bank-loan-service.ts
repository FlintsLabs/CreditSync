import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { bankLoanSchedules, bankLoans, bankProfiles } from "../db/schema";
import { createAuditLog } from "../lib/audit-log";
import { generateBankLoanSchedule, type BankLoanScheduleInput, type BankLoanScheduleRow } from "../lib/bank-loan-schedule";
import { serializeMoney } from "../lib/money";
import { FinancialDecimal } from "../lib/financial-decimal";
import type { CommandContext } from "./command-context";
import { DomainError } from "./domain-error";

export type BankDrawdownInput = BankLoanScheduleInput & { bankProfilePublicId: string; note?: string };
export type BankDrawdownPreview = { input: BankDrawdownInput; schedule: BankLoanScheduleRow[]; totalInterest: string; totalFees: string; totalVat: string; firstDueDate: string; lastDueDate: string };

function normalized(input: BankDrawdownInput): BankDrawdownInput {
    if (!input.bankProfilePublicId?.trim() || !input.amount || !input.interestRate) throw new DomainError("INVALID_BANK_DRAWDOWN", "Profile, amount, and interest rate are required", 400);
    if (!input.startDate || !/^\d{4}-\d{2}-\d{2}$/.test(input.startDate)) throw new DomainError("INVALID_START_DATE", "A valid ISO start date is required", 400);
    if (new FinancialDecimal(input.amount).lte(0) || new FinancialDecimal(input.interestRate).lt(0)) throw new DomainError("INVALID_BANK_DRAWDOWN", "Amount and rate are invalid", 400);
    return { ...input, amount: new FinancialDecimal(input.amount).toFixed(2), interestRate: new FinancialDecimal(input.interestRate).toFixed(4), processingFeeAmount: new FinancialDecimal(input.processingFeeAmount ?? "0").toFixed(2), utilizationFeeAmount: new FinancialDecimal(input.utilizationFeeAmount ?? "0").toFixed(2), vatRate: new FinancialDecimal(input.vatRate ?? "0").toFixed(4) };
}

async function profile(ctx: CommandContext, publicId: string, executor: any = db) {
    const rows = await executor.select().from(bankProfiles).where(and(eq(bankProfiles.tenantId, ctx.tenantId), eq(bankProfiles.publicId, publicId))).limit(1);
    const row = rows[0];
    if (!row) throw new DomainError("BANK_PROFILE_NOT_FOUND", "Bank profile not found", 404);
    if (row.status !== "active") throw new DomainError("BANK_PROFILE_INACTIVE", "Bank profile is inactive", 409);
    return row;
}

export async function previewBankDrawdown(ctx: CommandContext, raw: BankDrawdownInput): Promise<BankDrawdownPreview> {
    const input = normalized(raw); await profile(ctx, input.bankProfilePublicId);
    const schedule = generateBankLoanSchedule(input);
    const sum = (key: "scheduledInterest" | "scheduledFee" | "scheduledVat") => schedule.reduce((v, row) => v.plus(row[key]), new FinancialDecimal(0)).toFixed(2);
    return { input, schedule, totalInterest: sum("scheduledInterest"), totalFees: sum("scheduledFee"), totalVat: sum("scheduledVat"), firstDueDate: schedule[0]?.dueDate ?? "", lastDueDate: schedule.at(-1)?.dueDate ?? "" };
}

export async function createBankDrawdownDraft(ctx: CommandContext, raw: BankDrawdownInput) {
    if (!ctx.idempotencyKey) throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", "Idempotency key is required", 400);
    const input = normalized(raw); const key = ctx.idempotencyKey;
    return db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`bank-drawdown:${ctx.tenantId}:${key}`}, 0))`);
        const existing = (await tx.select().from(bankLoans).where(and(eq(bankLoans.tenantId, ctx.tenantId), eq(bankLoans.idempotencyKey, key))).limit(1))[0];
        const payload = JSON.stringify(input);
        if (existing) { if (existing.note !== payload) throw new DomainError("IDEMPOTENCY_CONFLICT", "Idempotency key payload differs", 409); return existing; }
        const p = await profile(ctx, input.bankProfilePublicId, tx);
        if (p.creditLimit && new FinancialDecimal(input.amount).gt(p.creditLimit)) throw new DomainError("CREDIT_LIMIT_EXCEEDED", "Drawdown exceeds credit limit", 409);
        const row = (await tx.insert(bankLoans).values({ tenantId: ctx.tenantId, bankProfileId: p.id, amount: input.amount, interestRate: input.interestRate, startDate: input.startDate, termMonths: input.termMonths, repaymentCycle: input.repaymentCycle ?? "monthly", repaymentMode: "fixed_installment", installmentAmount: input.installmentAmount, totalInstallments: input.totalInstallments, processingFeeAmount: input.processingFeeAmount, utilizationFeeAmount: input.utilizationFeeAmount, vatRate: input.vatRate, status: "draft", idempotencyKey: key, requestId: ctx.requestId, correlationId: ctx.correlationId, createdByUserId: ctx.actorUserId, updatedByUserId: ctx.actorUserId, note: payload }).returning())[0]!;
        await createAuditLog(tx, { tenantId: ctx.tenantId, actorUserId: ctx.actorUserId, actorSource: ctx.actorSource, requestId: ctx.requestId, correlationId: ctx.correlationId, entityType: "bank_loan", entityId: row.id, action: "draft_created", payload: { idempotencyKey: key } });
        return row;
    });
}

export async function activateBankDrawdown(ctx: CommandContext, input: { bankLoanPublicId: string }) {
    if (!ctx.idempotencyKey) throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", "Idempotency key is required", 400);
    return db.transaction(async (tx) => {
        const row = (await tx.select().from(bankLoans).where(and(eq(bankLoans.tenantId, ctx.tenantId), eq(bankLoans.publicId, input.bankLoanPublicId))).limit(1))[0];
        if (!row) throw new DomainError("BANK_LOAN_NOT_FOUND", "Bank loan not found", 404);
        if (row.status === "active") return row;
        if (row.status !== "draft" || !row.bankProfileId) throw new DomainError("BANK_LOAN_NOT_DRAFT", "Bank loan is not an activatable draft", 409);
        const p = (await tx.select().from(bankProfiles).where(and(eq(bankProfiles.id, row.bankProfileId), eq(bankProfiles.tenantId, ctx.tenantId))).limit(1))[0];
        if (!p || p.status !== "active") throw new DomainError("BANK_PROFILE_INACTIVE", "Bank profile is inactive", 409);
        const schedule = generateBankLoanSchedule({ amount: row.amount, interestRate: row.interestRate ?? "0", startDate: row.startDate ?? undefined, termMonths: row.termMonths ?? undefined, repaymentCycle: row.repaymentCycle as BankLoanScheduleInput["repaymentCycle"], totalInstallments: row.totalInstallments ?? undefined, installmentAmount: row.installmentAmount ?? undefined, processingFeeAmount: row.processingFeeAmount ?? undefined, utilizationFeeAmount: row.utilizationFeeAmount ?? undefined, vatRate: row.vatRate ?? undefined });
        for (const s of schedule) await tx.insert(bankLoanSchedules).values({ tenantId: ctx.tenantId, bankLoanId: row.id, ...s });
        const active = (await tx.update(bankLoans).set({ status: "active", nextDueDate: schedule[0]?.dueDate, outstandingPrincipal: row.amount, outstandingInterest: schedule.reduce((v, s) => v.plus(s.scheduledInterest), new FinancialDecimal(0)).toFixed(2), outstandingFees: schedule.reduce((v, s) => v.plus(s.scheduledFee).plus(s.scheduledVat), new FinancialDecimal(0)).toFixed(2), updatedByUserId: ctx.actorUserId, updatedAt: new Date() }).where(eq(bankLoans.id, row.id)).returning())[0]!;
        await createAuditLog(tx, { tenantId: ctx.tenantId, actorUserId: ctx.actorUserId, actorSource: ctx.actorSource, requestId: ctx.requestId, correlationId: ctx.correlationId, entityType: "bank_loan", entityId: row.id, action: "activated", payload: { idempotencyKey: ctx.idempotencyKey } });
        return active;
    });
}
