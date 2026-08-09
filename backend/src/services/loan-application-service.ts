import { and, eq, sql } from "drizzle-orm";
import Decimal from "decimal.js";
import { db } from "../db";
import { bankLoans, borrowers, loanFundingAllocations, loanSchedules, loans, users } from "../db/schema";
import { canAccessTenantWideData } from "../lib/access";
import { createAuditLog } from "../lib/audit-log";
import {
    calculatePublicLoanSchedule,
    normalizePublicLoanTerms,
    type PublicLoanCalculationParams,
    type RepaymentType,
} from "../lib/calculator";
import { generateLoanSchedule } from "../lib/loan-schedule";
import { computeLoanRollup } from "../lib/loan-rollup";
import { serializeMoney } from "../lib/money";
import type { CommandContext } from "./command-context";
import { DomainError } from "./domain-error";

type LoanRow = typeof loans.$inferSelect;

export interface LoanDraftInput extends PublicLoanCalculationParams {
    borrowerPublicId: string;
    bankLoanPublicId?: string | null;
}

export type LoanDraftUpdateInput = Partial<LoanDraftInput>;

function auditContext(ctx: CommandContext) {
    return {
        tenantId: ctx.tenantId,
        actorUserId: ctx.actorUserId,
        actorSource: ctx.actorSource,
        requestId: ctx.requestId,
        correlationId: ctx.correlationId,
    };
}

async function actorFor(ctx: CommandContext) {
    if (ctx.actorUserId === null) return null;
    const actor = await db.query.users.findFirst({
        where: and(eq(users.id, ctx.actorUserId), eq(users.tenantId, ctx.tenantId)),
    });
    if (!actor) throw new DomainError("ACTOR_NOT_FOUND", "Actor is not available in this tenant", 403);
    return actor;
}

async function loanAccessConditions(ctx: CommandContext) {
    const actor = await actorFor(ctx);
    const conditions = [eq(loans.tenantId, ctx.tenantId)];
    if (actor && !canAccessTenantWideData({ role: actor.role ?? "viewer" })) {
        conditions.push(eq(loans.ownerUserId, actor.id));
    }
    return conditions;
}

async function accessibleLoan(ctx: CommandContext, publicId: string) {
    const row = await db.query.loans.findFirst({
        where: and(eq(loans.publicId, publicId), ...(await loanAccessConditions(ctx))),
    });
    if (!row) throw new DomainError("LOAN_NOT_FOUND", "Loan not found", 404);
    return row;
}

async function accessibleBorrower(ctx: CommandContext, publicId: string) {
    const actor = await actorFor(ctx);
    const conditions = [eq(borrowers.tenantId, ctx.tenantId), eq(borrowers.publicId, publicId)];
    if (actor && !canAccessTenantWideData({ role: actor.role ?? "viewer" })) {
        conditions.push(eq(borrowers.ownerUserId, actor.id));
    }
    const row = await db.query.borrowers.findFirst({ where: and(...conditions) });
    if (!row) throw new DomainError("BORROWER_NOT_FOUND", "Borrower not found", 404);
    return row;
}

async function bankLoanFor(ctx: CommandContext, publicId?: string | null) {
    if (!publicId) return null;
    const actor = await actorFor(ctx);
    if (actor && !canAccessTenantWideData({ role: actor.role ?? "viewer" })) {
        throw new DomainError("FORBIDDEN", "Funding sources require tenant-wide access", 403);
    }
    const row = await db.query.bankLoans.findFirst({
        where: and(eq(bankLoans.publicId, publicId), eq(bankLoans.tenantId, ctx.tenantId)),
    });
    if (!row) throw new DomainError("BANK_LOAN_NOT_FOUND", "Funding source drawdown not found", 404);
    return row;
}

export async function presentLoan(row: LoanRow) {
    const [borrower, bankLoan] = await Promise.all([
        db.query.borrowers.findFirst({ where: and(eq(borrowers.id, row.borrowerId), eq(borrowers.tenantId, row.tenantId)) }),
        row.bankLoanId === null ? null : db.query.bankLoans.findFirst({
            where: and(eq(bankLoans.id, row.bankLoanId), eq(bankLoans.tenantId, row.tenantId)),
        }),
    ]);
    const principal = serializeMoney(row.principalAmount);
    const interestRate = serializeMoney(row.interestRate);
    return {
        id: row.publicId,
        publicId: row.publicId,
        borrowerPublicId: borrower?.publicId ?? null,
        bankLoanPublicId: bankLoan?.publicId ?? null,
        principal,
        principalAmount: principal,
        interestRate,
        repaymentType: row.repaymentType,
        termMonths: row.termMonths,
        installmentAmount: row.installmentAmount === null ? null : serializeMoney(row.installmentAmount),
        totalInstallments: row.totalInstallments,
        startDate: row.startDate,
        nextDueDate: row.nextDueDate,
        outstandingPrincipal: serializeMoney(row.outstandingPrincipal ?? "0"),
        outstandingInterest: serializeMoney(row.outstandingInterest ?? "0"),
        outstandingFees: serializeMoney(row.outstandingFees ?? "0"),
        status: row.status,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}

function normalizeTerms(input: PublicLoanCalculationParams) {
    try {
        return normalizePublicLoanTerms(input);
    } catch (error) {
        throw new DomainError("INVALID_LOAN_TERMS", error instanceof Error ? error.message : "Invalid loan terms", 400);
    }
}

export function previewLoan(input: PublicLoanCalculationParams) {
    const terms = normalizeTerms(input);
    try {
        return { terms, schedule: calculatePublicLoanSchedule({ ...input, ...terms }) };
    } catch (error) {
        throw new DomainError("INVALID_LOAN_TERMS", error instanceof Error ? error.message : "Invalid loan terms", 400);
    }
}

export async function getLoanApplication(ctx: CommandContext, publicId: string) {
    return presentLoan(await accessibleLoan(ctx, publicId));
}

export async function createLoanDraft(ctx: CommandContext, input: LoanDraftInput) {
    const terms = normalizeTerms(input);
    const [borrower, bankLoan] = await Promise.all([
        accessibleBorrower(ctx, input.borrowerPublicId),
        bankLoanFor(ctx, input.bankLoanPublicId),
    ]);
    return db.transaction(async (tx) => {
        const row = await tx.insert(loans).values({
            tenantId: ctx.tenantId,
            ownerUserId: ctx.actorUserId,
            borrowerId: borrower.id,
            bankLoanId: bankLoan?.id ?? null,
            principalAmount: terms.principal,
            interestRate: terms.interestRate,
            repaymentType: terms.repaymentType,
            termMonths: terms.termMonths,
            totalInstallments: terms.totalInstallments,
            installmentAmount: terms.installmentAmount,
            startDate: input.startDate,
            outstandingPrincipal: "0.00",
            outstandingInterest: "0.00",
            outstandingFees: "0.00",
            status: "draft",
        }).returning().then((rows) => rows[0]!);
        const after = await presentLoan(row);
        await createAuditLog(tx, {
            ...auditContext(ctx), entityType: "loan", entityId: row.publicId,
            action: "draft_created", payload: { before: null, after },
        });
        return after;
    });
}

export async function updateLoanDraft(ctx: CommandContext, publicId: string, input: LoanDraftUpdateInput) {
    const existing = await accessibleLoan(ctx, publicId);
    if (existing.status !== "draft") {
        throw new DomainError("LOAN_TERMS_LOCKED", "Active loan terms are immutable", 409);
    }
    const currentBorrower = await db.query.borrowers.findFirst({
        where: and(eq(borrowers.id, existing.borrowerId), eq(borrowers.tenantId, ctx.tenantId)),
    });
    const borrower = input.borrowerPublicId === undefined
        ? currentBorrower!
        : await accessibleBorrower(ctx, input.borrowerPublicId);
    const currentBankLoan = existing.bankLoanId === null ? null : await db.query.bankLoans.findFirst({
        where: and(eq(bankLoans.id, existing.bankLoanId), eq(bankLoans.tenantId, ctx.tenantId)),
    });
    const bankLoan = input.bankLoanPublicId === undefined
        ? currentBankLoan
        : await bankLoanFor(ctx, input.bankLoanPublicId);
    const merged = normalizeTerms({
        principal: input.principal ?? serializeMoney(existing.principalAmount),
        interestRate: input.interestRate ?? serializeMoney(existing.interestRate),
        repaymentType: (input.repaymentType ?? existing.repaymentType) as RepaymentType,
        termMonths: input.termMonths ?? existing.termMonths ?? 0,
        totalInstallments: input.totalInstallments ?? existing.totalInstallments ?? undefined,
        installmentAmount: input.installmentAmount === undefined
            ? existing.installmentAmount === null ? undefined : serializeMoney(existing.installmentAmount)
            : input.installmentAmount,
        startDate: input.startDate ?? existing.startDate ?? new Date().toISOString().slice(0, 10),
    });
    return db.transaction(async (tx) => {
        const row = await tx.update(loans).set({
            borrowerId: borrower.id,
            bankLoanId: bankLoan?.id ?? null,
            principalAmount: merged.principal,
            interestRate: merged.interestRate,
            repaymentType: merged.repaymentType,
            termMonths: merged.termMonths,
            totalInstallments: merged.totalInstallments,
            installmentAmount: merged.installmentAmount,
            startDate: input.startDate ?? existing.startDate,
            updatedAt: new Date(),
        }).where(and(
            eq(loans.id, existing.id),
            eq(loans.tenantId, ctx.tenantId),
            eq(loans.status, "draft"),
        )).returning().then((rows) => rows[0]);
        if (!row) throw new DomainError("LOAN_TERMS_LOCKED", "Active loan terms are immutable", 409);
        const before = await presentLoan(existing);
        const after = await presentLoan(row);
        await createAuditLog(tx, {
            ...auditContext(ctx), entityType: "loan", entityId: row.publicId,
            action: "draft_updated", payload: { before, after },
        });
        return after;
    });
}

export async function activateLoan(ctx: CommandContext, publicId: string) {
    const accessible = await accessibleLoan(ctx, publicId);
    return db.transaction(async (tx) => {
        await tx.execute(sql`SELECT id FROM loans WHERE id = ${accessible.id} AND tenant_id = ${ctx.tenantId} FOR UPDATE`);
        const current = await tx.query.loans.findFirst({
            where: and(eq(loans.id, accessible.id), eq(loans.tenantId, ctx.tenantId)),
        });
        if (!current) throw new DomainError("LOAN_NOT_FOUND", "Loan not found", 404);
        if (current.status === "active") return presentLoan(current);
        if (current.status !== "draft") {
            throw new DomainError("LOAN_NOT_ACTIVATABLE", "Only draft loans can be activated", 409);
        }
        if (current.termMonths === null) {
            throw new DomainError("INVALID_LOAN_TERMS", "Draft term months are required", 400);
        }

        let fundingSource: typeof bankLoans.$inferSelect | null = null;
        if (current.bankLoanId) {
            const lockedSource = await tx.execute(sql`SELECT id FROM bank_loans
                WHERE id = ${current.bankLoanId} AND tenant_id = ${ctx.tenantId} FOR UPDATE`);
            if (!lockedSource.length) {
                throw new DomainError("BANK_LOAN_NOT_FOUND", "Funding source drawdown not found", 404);
            }
            fundingSource = await tx.query.bankLoans.findFirst({
                where: and(eq(bankLoans.id, current.bankLoanId), eq(bankLoans.tenantId, ctx.tenantId)),
            }) ?? null;
            if (!fundingSource) {
                throw new DomainError("BANK_LOAN_NOT_FOUND", "Funding source drawdown not found", 404);
            }
            const sourceAllocation = await tx.select({
                totalAllocated: sql<string>`coalesce(sum(${loanFundingAllocations.allocatedAmount}), 0)`,
            }).from(loanFundingAllocations).where(and(
                eq(loanFundingAllocations.bankLoanId, fundingSource.id),
                eq(loanFundingAllocations.tenantId, ctx.tenantId),
            )).then((rows) => new Decimal(rows[0]?.totalAllocated ?? 0));
            const sourceRemaining = new Decimal(fundingSource.amount).minus(sourceAllocation);
            if (new Decimal(current.principalAmount).gt(sourceRemaining)) {
                throw new DomainError("ALLOCATION_EXCEEDS_DRAWDOWN", "Allocation exceeds remaining drawdown balance", 400, {
                    sourceRemaining: serializeMoney(sourceRemaining),
                });
            }
        }

        let generated;
        try {
            generated = current.repaymentType === "floating" ? [] : generateLoanSchedule({
                principal: current.principalAmount,
                interestRate: current.interestRate,
                termMonths: current.termMonths,
                repaymentType: current.repaymentType as RepaymentType,
                startDate: current.startDate ?? undefined,
                totalInstallments: current.totalInstallments ?? undefined,
                installmentAmount: current.installmentAmount ?? undefined,
            });
        } catch (error) {
            throw new DomainError("INVALID_LOAN_TERMS", error instanceof Error ? error.message : "Invalid loan terms", 400);
        }
        const rollup = generated.length ? computeLoanRollup(generated.map((row) => ({ ...row, status: "pending" }))) : {
            outstandingPrincipal: new Decimal(current.principalAmount),
            outstandingInterest: new Decimal(0),
            outstandingFees: new Decimal(0),
            nextDueDate: null,
        };
        if (generated.length) {
            await tx.insert(loanSchedules).values(generated.map((row) => ({
                tenantId: ctx.tenantId,
                loanId: current.id,
                installmentNo: row.installmentNo,
                dueDate: row.dueDate,
                scheduledPrincipal: row.scheduledPrincipal,
                scheduledInterest: row.scheduledInterest,
                scheduledFee: row.scheduledFee,
                scheduledTotal: row.scheduledTotal,
                paidTotal: "0.00",
                remainingDue: row.remainingDue,
                status: "pending",
            })));
        }
        if (fundingSource) {
            await tx.insert(loanFundingAllocations).values({
                tenantId: ctx.tenantId,
                bankProfileId: fundingSource.bankProfileId,
                bankLoanId: fundingSource.id,
                loanId: current.id,
                allocatedAmount: serializeMoney(current.principalAmount),
                allocationDate: current.startDate ?? new Date().toISOString().slice(0, 10),
                allocationType: "initial",
                note: "Created when loan draft was activated",
                createdByUserId: ctx.actorUserId,
            });
        }
        const row = await tx.update(loans).set({
            status: "active",
            nextDueDate: rollup.nextDueDate ?? undefined,
            outstandingPrincipal: serializeMoney(rollup.outstandingPrincipal),
            outstandingInterest: serializeMoney(rollup.outstandingInterest),
            outstandingFees: serializeMoney(rollup.outstandingFees),
            updatedAt: new Date(),
        }).where(and(eq(loans.id, current.id), eq(loans.tenantId, ctx.tenantId)))
            .returning().then((rows) => rows[0]!);
        const before = await presentLoan(current);
        const after = await presentLoan(row);
        await createAuditLog(tx, {
            ...auditContext(ctx), entityType: "loan", entityId: row.publicId,
            action: "activated", payload: { before, after, scheduleCount: generated.length },
        });
        return after;
    });
}
