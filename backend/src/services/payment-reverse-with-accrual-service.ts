import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db, type DbExecutor } from "../db";
import { auditLogs, loanInterestAccruals, loans, paymentIntakes, transactions } from "../db/schema";
import { createAuditLog } from "../lib/audit-log";
import { invalidateTenantCache } from "../lib/cache";
import { FinancialDecimal } from "../lib/financial-decimal";
import { getPaymentIntake, reversePayment } from "./payment-service";
import { accrueFloatingInterestThrough, floatingPaymentObligations, type FloatingAccrualMaterializationProvenance } from "./floating-interest-service";
import type { CommandContext } from "./command-context";
import { DomainError } from "./domain-error";

type Executor = DbExecutor;

export type ReverseWithAccrualInput = {
    reason: string;
    previewHash: string;
    confirmed: true;
    interestAccrualMode: "ensure_due_through_payment_date";
    idempotencyKey: string;
};

function businessDate(value: Date) {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(value);
    const read = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
    return `${read("year")}-${read("month")}-${read("day")}`;
}

function digest(value: unknown) {
    return `v1:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function requireReason(reason: string) {
    const normalized = reason.trim();
    if (!normalized) throw new DomainError("REVERSAL_REASON_REQUIRED", "Payment reversal requires a reason", 400);
    return normalized;
}

async function sourceSnapshot(ctx: CommandContext, paymentIntakePublicId: string, executor: Executor = db) {
    await getPaymentIntake(ctx, paymentIntakePublicId);
    const intake = await executor.query.paymentIntakes.findFirst({ where: and(
        eq(paymentIntakes.tenantId, ctx.tenantId),
        eq(paymentIntakes.publicId, paymentIntakePublicId),
    ) });
    if (!intake) throw new DomainError("PAYMENT_INTAKE_NOT_FOUND", "Payment intake not found", 404);
    if (intake.status !== "posted") throw new DomainError("PAYMENT_NOT_POSTED", "Only a posted payment can be reversed", 409);
    const originals = await executor.select().from(transactions).where(and(
        eq(transactions.tenantId, ctx.tenantId),
        eq(transactions.paymentIntakeId, intake.id),
        eq(transactions.entryType, "repayment"),
    )).orderBy(transactions.id);
    if (!originals.length) throw new DomainError("PAYMENT_REPAYMENT_MISSING", "Posted payment has no repayment transaction", 409);
    const loanIds = [...new Set(originals.map((row) => row.loanId))];
    const selectedLoans = await executor.select().from(loans).where(and(eq(loans.tenantId, ctx.tenantId), inArray(loans.id, loanIds)));
    if (selectedLoans.length !== loanIds.length) throw new DomainError("REVERSAL_TARGET_MISSING", "Payment target loan no longer exists", 409);
    if (selectedLoans.some((loan) => loan.repaymentType !== "floating")) {
        throw new DomainError("REVERSE_ACCRUAL_FLOATING_ONLY", "Automatic interest accrual is supported only for floating loans", 409);
    }
    const throughDate = businessDate(intake.receivedAt);
    const accrualPreview = [] as Array<Record<string, unknown>>;
    for (const loan of selectedLoans) {
        if (loan.status !== "active") throw new DomainError("FLOATING_LOAN_NOT_ACTIVE", "Floating interest can be materialized only for an active loan", 409);
        const obligations = await floatingPaymentObligations(executor, loan, intake.receivedAt, ctx);
        const missing = obligations.rows.filter((row) => row.id < 0);
        accrualPreview.push({
            loanPublicId: loan.publicId,
            throughDate,
            missingAccrualCount: missing.length,
            missingAccrualAmount: new FinancialDecimal(missing.reduce((sum, row) => sum.plus(row.interestAmount), new FinancialDecimal(0))).toFixed(2),
            existingDueInterest: obligations.dueInterest.toFixed(2),
        });
    }
    const snapshot = {
        paymentIntakePublicId: intake.publicId,
        receivedAt: intake.receivedAt.toISOString(),
        amount: intake.amount,
        originalTransactionPublicIds: originals.map((row) => row.publicId),
        loanPublicIds: selectedLoans.map((loan) => loan.publicId),
        throughDate,
        accrualPreview,
    };
    return { intake, originals, selectedLoans, snapshot, previewHash: digest(snapshot) };
}

export async function previewReverseWithInterestAccrual(ctx: CommandContext, paymentIntakePublicId: string) {
    const result = await sourceSnapshot(ctx, paymentIntakePublicId);
    return {
        ...result.snapshot,
        interestAccrualMode: "ensure_due_through_payment_date" as const,
        previewHash: result.previewHash,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    };
}

export async function executeReverseWithInterestAccrual(ctx: CommandContext, paymentIntakePublicId: string, input: ReverseWithAccrualInput) {
    if (!input.confirmed) throw new DomainError("CONFIRMATION_REQUIRED", "Explicit confirmation is required", 400);
    const reason = requireReason(input.reason);
    const run = async (tx: Executor) => {
        const priorAuditRows = await tx.select().from(auditLogs).where(and(
            eq(auditLogs.tenantId, ctx.tenantId),
            eq(auditLogs.entityType, "payment_intake"),
            eq(auditLogs.entityId, paymentIntakePublicId),
            eq(auditLogs.action, "reversed_with_interest_accruals_materialized"),
        ));
        const prior = priorAuditRows.find((row) => (row.payload as { idempotencyKey?: string } | null)?.idempotencyKey === input.idempotencyKey);
        if (prior) {
            const repeated = await reversePayment(ctx, paymentIntakePublicId, { reason }, tx);
            const linked = await tx.select().from(loanInterestAccruals).where(and(
                eq(loanInterestAccruals.tenantId, ctx.tenantId),
                eq(loanInterestAccruals.sourcePaymentIntakeId, (await tx.query.paymentIntakes.findFirst({ where: and(eq(paymentIntakes.tenantId, ctx.tenantId), eq(paymentIntakes.publicId, paymentIntakePublicId)) }))?.id ?? -1),
            ));
            return {
                ...repeated,
                createdAccrualPublicIds: linked.map((row) => row.publicId),
                promotedAccrualPublicIds: [],
                auditPublicIds: [prior.publicId],
                correlationId: ctx.correlationId,
            };
        }
        const before = await sourceSnapshot(ctx, paymentIntakePublicId, tx);
        if (before.previewHash !== input.previewHash) throw new DomainError("STALE_REVERSE_ACCRUAL_PREVIEW", "Payment state changed after preview", 409);
        const reversed = await reversePayment(ctx, paymentIntakePublicId, { reason }, tx);
        const createdAccrualPublicIds: string[] = [];
        const promotedAccrualPublicIds: string[] = [];
        for (const loan of before.selectedLoans) {
            const original = before.originals.find((row) => row.loanId === loan.id);
            if (!original) continue;
            const reversal = await tx.query.transactions.findFirst({ where: and(
                eq(transactions.tenantId, ctx.tenantId),
                eq(transactions.reversedTransactionId, original.id),
            ) });
            if (!reversal) throw new DomainError("REVERSAL_TARGET_MISSING", "Compensating reversal transaction was not created", 409);
            const beforeAccruals = await tx.select({ id: loanInterestAccruals.id }).from(loanInterestAccruals).where(and(
                eq(loanInterestAccruals.tenantId, ctx.tenantId), eq(loanInterestAccruals.loanId, loan.id),
            ));
            const provenance: FloatingAccrualMaterializationProvenance = {
                sourcePaymentIntakeId: before.intake.id,
                sourceReversalTransactionId: reversal.id,
                reason,
            };
            const rows = await accrueFloatingInterestThrough(tx, loan, before.intake.receivedAt, ctx, provenance);
            const beforeIds = new Set(beforeAccruals.map((row) => row.id));
            for (const row of rows) {
                if (!beforeIds.has(row.id)) createdAccrualPublicIds.push(row.publicId);
            }
        }
        const audit = await createAuditLog(tx, {
            tenantId: ctx.tenantId,
            actorUserId: ctx.actorUserId,
            actorSource: ctx.actorSource,
            requestId: ctx.requestId,
            correlationId: ctx.correlationId,
            entityType: "payment_intake",
            entityId: before.intake.publicId,
            action: "reversed_with_interest_accruals_materialized",
            payload: {
                reason,
                interestAccrualMode: input.interestAccrualMode,
                idempotencyKey: input.idempotencyKey,
                throughDate: before.snapshot.throughDate,
                createdAccrualPublicIds,
                promotedAccrualPublicIds,
            },
        });
        return {
            ...reversed,
            createdAccrualPublicIds,
            promotedAccrualPublicIds,
            auditPublicIds: [audit.publicId],
            correlationId: ctx.correlationId,
        };
    };
    const result = await db.transaction(run);
    await invalidateTenantCache(ctx.tenantId);
    return result;
}
