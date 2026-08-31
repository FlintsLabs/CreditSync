import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { auditLogs, loanScheduleDeferrals, loanSchedules, loans, users } from "../db/schema";
import { canAccessTenantWideData } from "../lib/access";
import { createAuditLog } from "../lib/audit-log";
import { computeLoanRollup } from "../lib/loan-rollup";
import { FinancialDecimal } from "../lib/financial-decimal";
import { serializeMoney } from "../lib/money";
import { DomainError } from "./domain-error";
import type { CommandContext } from "./command-context";

export function getReplacementScheduleDate(scheduleTailDate: string) {
    const [year, month, day] = scheduleTailDate.split("-").map(Number);
    const next = new Date(Date.UTC(year!, month! - 1, day! + 1));
    return next.toISOString().slice(0, 10);
}

export function canDeferSchedule(row: Pick<typeof loanSchedules.$inferSelect, "paidTotal" | "remainingDue" | "status">) {
    return row.status !== "deferred"
        && new FinancialDecimal(row.paidTotal).isZero()
        && new FinancialDecimal(row.remainingDue).greaterThan(0);
}

function normalizeReason(reason: string) {
    const normalized = reason.trim();
    if (!normalized) throw new DomainError("VALIDATION_ERROR", "A deferral reason is required", 422);
    return normalized;
}

export function getDeferredLoanRollupUpdate(rollup: ReturnType<typeof computeLoanRollup>) {
    return {
        outstandingPrincipal: rollup.outstandingPrincipal.toFixed(2),
        outstandingInterest: rollup.outstandingInterest.toFixed(2),
        outstandingFees: rollup.outstandingFees.toFixed(2),
        nextDueDate: rollup.nextDueDate,
        status: rollup.status === "paid" ? "paid" : "active",
    };
}

export function countLoanScheduleDeferrals(deferralRows: readonly unknown[]) {
    return deferralRows.length;
}

export function getDeferralReasonForSchedule(
    scheduleId: number,
    deferralRows: readonly Pick<typeof loanScheduleDeferrals.$inferSelect, "sourceScheduleId" | "replacementScheduleId" | "reason">[],
) {
    return deferralRows.find((row) => row.sourceScheduleId === scheduleId || row.replacementScheduleId === scheduleId)?.reason ?? null;
}

async function accessibleLoan(ctx: CommandContext, publicId: string, executor: typeof db | any = db) {
    const actor = ctx.actorUserId === null ? null : await executor.query.users.findFirst({
        where: and(eq(users.id, ctx.actorUserId), eq(users.tenantId, ctx.tenantId)),
    });
    if (ctx.actorUserId !== null && !actor) throw new DomainError("ACTOR_NOT_FOUND", "Actor is not available in this tenant", 403);
    const conditions = [eq(loans.publicId, publicId), eq(loans.tenantId, ctx.tenantId)];
    if (actor && !canAccessTenantWideData({ role: actor.role ?? "viewer" })) conditions.push(eq(loans.ownerUserId, actor.id));
    const loan = await executor.query.loans.findFirst({ where: and(...conditions) });
    if (!loan) throw new DomainError("LOAN_NOT_FOUND", "Loan not found", 404);
    return loan;
}

function presentDeferral(loan: typeof loans.$inferSelect, source: typeof loanSchedules.$inferSelect, replacement: typeof loanSchedules.$inferSelect, auditPublicId: string | null, correlationId: string) {
    return {
        loanPublicId: loan.publicId,
        sourceSchedulePublicId: source.publicId,
        replacementSchedulePublicId: replacement.publicId,
        sourceStatus: source.status,
        replacementInstallmentNo: replacement.installmentNo,
        replacementDueDate: replacement.dueDate,
        scheduledPrincipal: serializeMoney(replacement.scheduledPrincipal),
        scheduledInterest: serializeMoney(replacement.scheduledInterest),
        scheduledFee: serializeMoney(replacement.scheduledFee),
        scheduledTotal: serializeMoney(replacement.scheduledTotal),
        auditPublicId,
        correlationId,
    };
}

export async function deferLoanSchedule(ctx: CommandContext, loanPublicId: string, schedulePublicId: string, input: { reason: string }) {
    const reason = normalizeReason(input.reason);
    const idempotencyKey = ctx.idempotencyKey?.trim();
    if (!idempotencyKey) throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", "Schedule deferrals require a non-blank Idempotency-Key", 400);

    const accessible = await accessibleLoan(ctx, loanPublicId);
    if (accessible.status !== "active" || accessible.repaymentType === "floating") {
        throw new DomainError("INVALID_LOAN_TERMS", "Only active scheduled loans can defer installments", 409);
    }

    return db.transaction(async (tx) => {
        const existing = await tx.query.loanScheduleDeferrals.findFirst({
            where: and(eq(loanScheduleDeferrals.tenantId, ctx.tenantId), eq(loanScheduleDeferrals.idempotencyKey, idempotencyKey)),
        });
        if (existing) {
            const [currentLoan, source, replacement, audit] = await Promise.all([
                tx.query.loans.findFirst({ where: and(eq(loans.tenantId, ctx.tenantId), eq(loans.id, existing.loanId)) }),
                tx.query.loanSchedules.findFirst({ where: and(eq(loanSchedules.tenantId, ctx.tenantId), eq(loanSchedules.id, existing.sourceScheduleId)) }),
                tx.query.loanSchedules.findFirst({ where: and(eq(loanSchedules.tenantId, ctx.tenantId), eq(loanSchedules.id, existing.replacementScheduleId)) }),
                tx.query.auditLogs.findFirst({ where: and(eq(auditLogs.tenantId, ctx.tenantId), eq(auditLogs.entityId, existing.publicId), eq(auditLogs.action, "deferred")) }),
            ]);
            if (!currentLoan || !source || !replacement) throw new DomainError("IDEMPOTENCY_CONFLICT", "Deferral replay is missing its linked schedule rows", 409);
            if (currentLoan.publicId !== loanPublicId || source.publicId !== schedulePublicId || existing.reason !== reason) {
                throw new DomainError("IDEMPOTENCY_CONFLICT", "Idempotency-Key was already used for a different deferral", 409);
            }
            return presentDeferral(currentLoan, source, replacement, audit?.publicId ?? null, ctx.correlationId);
        }

        await tx.execute(sql`SELECT id FROM loans WHERE tenant_id = ${ctx.tenantId} AND id = ${accessible.id} FOR UPDATE`);
        await tx.execute(sql`SELECT id FROM loan_schedules WHERE tenant_id = ${ctx.tenantId} AND public_id = ${schedulePublicId} FOR UPDATE`);
        const loan = await tx.query.loans.findFirst({ where: and(eq(loans.tenantId, ctx.tenantId), eq(loans.id, accessible.id)) });
        const source = await tx.query.loanSchedules.findFirst({ where: and(eq(loanSchedules.tenantId, ctx.tenantId), eq(loanSchedules.loanId, accessible.id), eq(loanSchedules.publicId, schedulePublicId)) });
        if (!loan || !source) throw new DomainError("SCHEDULE_NOT_FOUND", "Schedule installment not found", 404);
        if (loan.status !== "active" || loan.repaymentType === "floating") throw new DomainError("INVALID_LOAN_TERMS", "Only active scheduled loans can defer installments", 409);
        if (!canDeferSchedule(source)) throw new DomainError("SCHEDULE_NOT_ELIGIBLE", "Only fully unpaid installments can be deferred", 409);

        const tail = await tx.query.loanSchedules.findFirst({
            where: and(eq(loanSchedules.tenantId, ctx.tenantId), eq(loanSchedules.loanId, loan.id)),
            orderBy: [desc(loanSchedules.dueDate), desc(loanSchedules.installmentNo)],
        });
        if (!tail) throw new DomainError("SCHEDULE_NOT_FOUND", "Loan has no repayment schedule", 404);
        const replacement = await tx.insert(loanSchedules).values({
            tenantId: ctx.tenantId,
            loanId: loan.id,
            installmentNo: Math.max(...(await tx.select({ installmentNo: loanSchedules.installmentNo }).from(loanSchedules).where(and(eq(loanSchedules.tenantId, ctx.tenantId), eq(loanSchedules.loanId, loan.id)))).map((row) => row.installmentNo)) + 1,
            dueDate: getReplacementScheduleDate(tail.dueDate),
            scheduledPrincipal: source.scheduledPrincipal,
            scheduledInterest: source.scheduledInterest,
            scheduledFee: source.scheduledFee,
            scheduledTotal: source.scheduledTotal,
            paidTotal: "0.00",
            paidPenalty: "0.00",
            overdueDays: 0,
            remainingDue: source.scheduledTotal,
            status: "pending",
        }).returning().then((rows) => rows[0]!);

        const deferredSource = await tx.update(loanSchedules).set({ status: "deferred", remainingDue: "0.00", overdueDays: 0, updatedAt: new Date() }).where(and(eq(loanSchedules.tenantId, ctx.tenantId), eq(loanSchedules.id, source.id))).returning().then((rows) => rows[0]!);
        const allSchedules = await tx.select().from(loanSchedules).where(and(eq(loanSchedules.tenantId, ctx.tenantId), eq(loanSchedules.loanId, loan.id))).orderBy(asc(loanSchedules.installmentNo));
        const rollup = computeLoanRollup(allSchedules);
        const updatedLoan = await tx.update(loans).set({
            ...getDeferredLoanRollupUpdate(rollup),
            updatedAt: new Date(),
        }).where(and(eq(loans.tenantId, ctx.tenantId), eq(loans.id, loan.id))).returning().then((rows) => rows[0]!);

        const deferral = await tx.insert(loanScheduleDeferrals).values({
            tenantId: ctx.tenantId,
            loanId: loan.id,
            sourceScheduleId: source.id,
            replacementScheduleId: replacement.id,
            reason,
            idempotencyKey,
            requestId: ctx.requestId,
            correlationId: ctx.correlationId,
            actorSource: ctx.actorSource,
            createdByUserId: ctx.actorUserId!,
        }).returning().then((rows) => rows[0]!);
        const audit = await createAuditLog(tx, {
            tenantId: ctx.tenantId,
            actorUserId: ctx.actorUserId,
            actorSource: ctx.actorSource,
            requestId: ctx.requestId,
            correlationId: ctx.correlationId,
            entityType: "loan_schedule_deferral",
            entityId: deferral.publicId,
            action: "deferred",
            payload: {
                loanPublicId: updatedLoan.publicId,
                sourceSchedulePublicId: source.publicId,
                replacementSchedulePublicId: replacement.publicId,
                before: { dueDate: source.dueDate, scheduledTotal: serializeMoney(source.scheduledTotal), paidTotal: serializeMoney(source.paidTotal) },
                after: { dueDate: replacement.dueDate, scheduledTotal: serializeMoney(replacement.scheduledTotal) },
                reason,
                idempotencyKey,
            },
        });
        return presentDeferral(updatedLoan, deferredSource, replacement, audit.publicId, ctx.correlationId);
    });
}
