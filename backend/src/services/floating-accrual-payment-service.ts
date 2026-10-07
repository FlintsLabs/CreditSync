import Decimal from "decimal.js";
import { createHash } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db, type DbExecutor } from "../db";
import { auditLogs, borrowers, commandReceipts, floatingTransactionAllocations, loanInterestAccruals, loans, paymentIntakes, paymentMatchAllocations, paymentMatchFloatingTargets, paymentMatchProposals, users } from "../db/schema";
import { activeFloatingPaymentAllocations } from "../lib/floating-allocation-integrity";
import { FinancialDecimal, unsignedPublicMoneyPattern } from "../lib/financial-decimal";
import { createAuditLog } from "../lib/audit-log";
import { canAccessTenantWideData } from "../lib/access";
import type { CommandContext } from "./command-context";
import { DomainError } from "./domain-error";
import { assertPaymentIdentityAvailable, createPaymentIntake, getPaymentIntake, normalizeBankReference, previewPaymentMatch, postPayment } from "./payment-service";
import { floatingInterestBalances, floatingPaymentObligations } from "./floating-interest-service";
import { duplicateIdentityLock } from "./payment-duplicate-guard";
import { lockPaymentBorrowers } from "./payment-chronology-service";
import { withPaymentWorkflowTransaction } from "./payment-workflow-locks";
import { assertSelectedFloatingHistorySafe } from "./selected-floating-history-safety";

export type SelectedAccrualTarget = { accrualDate: string; amount: string };
export type SelectedAccrualPaymentInput = {
    amount: string;
    receivedAt: string;
    targets: SelectedAccrualTarget[];
    paymentIntakePublicId?: string;
    notes?: string | null;
    bankReference?: string | null;
};
type SelectedPreviewResult = Awaited<ReturnType<typeof previewPaymentMatch>> & {
    paymentIntakePublicId: string; receivedAt: string; targets: SelectedAccrualTarget[]; total: string;
    remainingDebt: { principal: string; fees: string; interest: string; penalty: string }; recovered?: boolean;
};

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const moneyPattern = unsignedPublicMoneyPattern;
function referenceHash(value: string | null | undefined) {
    const normalized = value ? normalizeBankReference(value) : "";
    return normalized ? createHash("sha256").update(normalized).digest("hex") : null;
}
function previewCommandHash(loanPublicId: string, input: SelectedAccrualPaymentInput, receivedAt: Date, amount: Decimal, targets: SelectedAccrualTarget[]) {
    return createHash("sha256").update(JSON.stringify({ loanPublicId, amount: amount.toFixed(2), receivedAt: receivedAt.toISOString(), targets, bankReferenceHash: referenceHash(input.bankReference), notes: input.notes ?? null })).digest("hex");
}
function canonicalTargets(targets: SelectedAccrualTarget[]) {
    return targets.map((target) => ({ accrualDate: target.accrualDate, amount: validateMoney(target.amount).toFixed(2) }))
        .sort((left, right) => left.accrualDate.localeCompare(right.accrualDate));
}
function businessDate(value: Date) {
    const p = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(value);
    const get = (key: Intl.DateTimeFormatPartTypes) => p.find((part) => part.type === key)?.value;
    return `${get("year")}-${get("month")}-${get("day")}`;
}
function validateMoney(value: string) {
    if (!moneyPattern.test(value) || !new FinancialDecimal(value).isFinite() || new FinancialDecimal(value).lte(0)) {
        throw new DomainError("INVALID_PAYMENT_AMOUNT", "Amounts must be positive decimal strings with exactly two decimals", 400);
    }
    return new FinancialDecimal(value);
}
function validateDate(value: string) {
    if (!datePattern.test(value)) throw new DomainError("INVALID_ACCRUAL_DATE", "accrualDate must be YYYY-MM-DD", 400);
    const parsed = new Date(`${value}T00:00:00Z`);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new DomainError("INVALID_ACCRUAL_DATE", "accrualDate must be a real calendar date", 400);
}

async function resolveTargets(ctx: CommandContext, loanPublicId: string, receivedAt: Date, targets: SelectedAccrualTarget[], executor: DbExecutor = db) {
    const loan = await accessibleDailyFloatingLoan(ctx, loanPublicId, executor);
    if (receivedAt.getTime() > Date.now()) throw new DomainError("FUTURE_RECEIPT_NOT_ALLOWED", "Receipt timestamp cannot be in the future", 400);
    const receivedDate = businessDate(receivedAt);
    await assertSelectedFloatingHistorySafe(executor, ctx.tenantId, loan.id, receivedAt, loan.publicId);
    const allLoanAllocations = await executor.select().from(floatingTransactionAllocations).where(and(eq(floatingTransactionAllocations.tenantId, ctx.tenantId), eq(floatingTransactionAllocations.loanId, loan.id)));
    const seen = new Set<string>();
    let total = new FinancialDecimal(0);
    for (const target of targets) {
        validateDate(target.accrualDate);
        if (target.accrualDate > receivedDate) throw new DomainError("ACCRUAL_AFTER_RECEIPT", "Selected interest date must have accrued by the receipt date", 409);
        if (seen.has(target.accrualDate)) throw new DomainError("DUPLICATE_ACCRUAL_TARGET", "Each accrual date may be selected once", 400);
        seen.add(target.accrualDate);
        total = total.plus(validateMoney(target.amount));
    }
    if (!targets.length || targets.length > 366) throw new DomainError("INVALID_ACCRUAL_TARGETS", "Select between one and 366 accrual dates", 400);
    const obligations = await floatingPaymentObligations(executor, loan, receivedAt, ctx);
    const rows = new Map(obligations.rows.map((row) => [row.accrualDate, row]));
    const all = allLoanAllocations.filter((item) => item.component === "interest");
    const activeByAccrual = new Map<number, Decimal>();
    for (const allocation of activeFloatingPaymentAllocations(all)) {
        if (allocation.interestAccrualId === null) continue;
        activeByAccrual.set(allocation.interestAccrualId, (activeByAccrual.get(allocation.interestAccrualId) ?? new FinancialDecimal(0)).plus(allocation.amount));
    }
    for (const target of targets) {
        const row = rows.get(target.accrualDate);
        if (!row || row.status === "reversed" || row.accrualDate > receivedDate) throw new DomainError("FLOATING_ACCRUAL_TARGET_UNAVAILABLE", "Selected accrual is unavailable at the receipt date", 409, { accrualDate: target.accrualDate });
        const activePaid = row.id > 0 ? activeByAccrual.get(row.id) ?? new FinancialDecimal(0) : new FinancialDecimal(0);
        const currentAccrual = row.id > 0 ? await executor.query.loanInterestAccruals.findFirst({ where: and(eq(loanInterestAccruals.tenantId, ctx.tenantId), eq(loanInterestAccruals.id, row.id)) }) : null;
        const currentPaid = currentAccrual ? new FinancialDecimal(currentAccrual.paidAmount) : new FinancialDecimal(0);
        const historicalBaseline = FinancialDecimal.max(currentPaid.minus(activePaid), 0);
        const capacity = FinancialDecimal.min(
            FinancialDecimal.max(new FinancialDecimal(row.interestAmount).minus(new FinancialDecimal(row.paidAmount)), 0),
            FinancialDecimal.max(new FinancialDecimal(row.interestAmount).minus(historicalBaseline).minus(activePaid), 0),
        );
        if (new FinancialDecimal(target.amount).gt(capacity)) throw new DomainError("FLOATING_ACCRUAL_CAPACITY_EXCEEDED", "Selected amount exceeds the unpaid capacity for this accrual date", 409, { accrualDate: target.accrualDate, availableAmount: capacity.toFixed(2) });
    }
    return { loan, total: total.toFixed(2) };
}

async function accessibleDailyFloatingLoan(ctx: CommandContext, loanPublicId: string, executor: DbExecutor) {
    const loan = await executor.query.loans.findFirst({ where: and(eq(loans.tenantId, ctx.tenantId), eq(loans.publicId, loanPublicId)) });
    if (!loan) throw new DomainError("LOAN_NOT_FOUND", "Loan not found", 404);
    await assertLoanPortfolioAccess(ctx, loan, executor);
    if (loan.status !== "active" || loan.repaymentType !== "floating" || loan.floatingAccrualCycle !== "daily" || loan.interestPeriodUnit !== "day") {
        throw new DomainError("FLOATING_DAILY_PAYMENT_UNSUPPORTED", "Selected accrual payments require an active floating daily loan", 409);
    }
    return loan;
}

async function assertLoanPortfolioAccess(ctx: CommandContext, loan: typeof loans.$inferSelect, executor: DbExecutor) {
    const actor = ctx.actorUserId === null ? null : await executor.query.users.findFirst({ where: and(eq(users.tenantId, ctx.tenantId), eq(users.id, ctx.actorUserId)) });
    if (actor && !canAccessTenantWideData({ role: actor.role ?? "viewer" })) {
        const borrower = await executor.query.borrowers.findFirst({ where: and(eq(borrowers.tenantId, ctx.tenantId), eq(borrowers.id, loan.borrowerId)) });
        if (loan.ownerUserId !== actor.id || borrower?.ownerUserId !== actor.id) throw new DomainError("INVALID_PAYMENT_TARGET", "Payment target is outside the actor portfolio", 403);
    }
}

export async function previewFloatingAccrualPayment(ctx: CommandContext, loanPublicId: string, input: SelectedAccrualPaymentInput): Promise<SelectedPreviewResult> {
    if (!ctx.idempotencyKey?.trim()) throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key is required", 400);
    const idempotencyKey = ctx.idempotencyKey.trim();
    const receivedAt = new Date(input.receivedAt);
    if (!Number.isFinite(receivedAt.getTime()) || !input.receivedAt.includes("T")) throw new DomainError("INVALID_RECEIVED_AT", "receivedAt must be an ISO date-time", 400);
    const receivedTotal = validateMoney(input.amount);
    const targetTotal = input.targets.reduce((sum, item) => sum.plus(validateMoney(item.amount)), new FinancialDecimal(0));
    if (!receivedTotal.eq(targetTotal)) throw new DomainError("ALLOCATION_SUM_MISMATCH", "Target amounts must equal the receipt amount", 400);
    const normalizedTargets = canonicalTargets(input.targets);
    const fingerprint = previewCommandHash(loanPublicId, input, receivedAt, receivedTotal, normalizedTargets);
    return withPaymentWorkflowTransaction(async (tx) => {
        const priorCommand = await tx.query.commandReceipts.findFirst({ where: and(eq(commandReceipts.tenantId, ctx.tenantId), eq(commandReceipts.operationType, "selected_floating_preview"), eq(commandReceipts.operationKey, idempotencyKey)) });
        if (priorCommand) {
            const authorizedLoan = await tx.query.loans.findFirst({ where: and(eq(loans.tenantId, ctx.tenantId), eq(loans.publicId, loanPublicId)) });
            if (!authorizedLoan) throw new DomainError("LOAN_NOT_FOUND", "Loan not found", 404);
            await assertLoanPortfolioAccess(ctx, authorizedLoan, tx);
            if (priorCommand.requestHash !== fingerprint) throw new DomainError("IDEMPOTENCY_PAYLOAD_MISMATCH", "This idempotency key is already bound to a different canonical preview payload", 409);
            return { ...priorCommand.result, recovered: true } as unknown as SelectedPreviewResult;
        }
        const { loan } = await resolveTargets(ctx, loanPublicId, receivedAt, input.targets, tx);
        let intake = input.paymentIntakePublicId
            ? await tx.query.paymentIntakes.findFirst({ where: and(eq(paymentIntakes.tenantId, ctx.tenantId), eq(paymentIntakes.publicId, input.paymentIntakePublicId)) })
            : null;
        if (input.paymentIntakePublicId && (!intake || intake.originLoanId !== loan.id)) throw new DomainError("PAYMENT_INTAKE_NOT_FOUND", "Payment intake not found for this loan", 404);
        const borrower = await tx.query.borrowers.findFirst({ where: and(eq(borrowers.tenantId, ctx.tenantId), eq(borrowers.id, loan.borrowerId)) });
        if (!borrower) throw new DomainError("PAYMENT_TARGET_NOT_FOUND", "Borrower not found", 404);
        if (intake) {
            await duplicateIdentityLock(ctx, { amount: receivedTotal.toFixed(2), payerName: borrower.name, receivedAt, bankReferenceHash: referenceHash(input.bankReference), qrPayloadHash: null }, tx);
            await lockPaymentBorrowers(tx, ctx.tenantId, [loan.borrowerId]);
            await tx.execute(sql`SELECT id FROM payment_intakes WHERE tenant_id = ${ctx.tenantId} AND id = ${intake.id} FOR UPDATE`);
            const lockedIntake = await tx.query.paymentIntakes.findFirst({ where: and(eq(paymentIntakes.tenantId, ctx.tenantId), eq(paymentIntakes.id, intake.id)) });
            if (!lockedIntake || ["posted", "reversed", "duplicate", "cancelled"].includes(lockedIntake.status)) throw new DomainError("PAYMENT_INTAKE_IMMUTABLE", "This payment intake can no longer be edited", 409);
            intake = lockedIntake;
            await assertPaymentIdentityAvailable(ctx, { idempotencyKey: intake.idempotencyKey, bankReferenceHash: referenceHash(input.bankReference), qrPayloadHash: intake.qrPayloadHash, ignoreIntakeId: intake.id }, tx);
            const latest = await tx.select().from(paymentMatchProposals).where(and(eq(paymentMatchProposals.tenantId, ctx.tenantId), eq(paymentMatchProposals.paymentIntakeId, intake.id))).orderBy(asc(paymentMatchProposals.version));
            if (latest.some((proposal) => proposal.status === "posted")) throw new DomainError("PAYMENT_INTAKE_IMMUTABLE", "A posted proposal cannot be edited", 409);
            if (latest.length) await tx.update(paymentMatchProposals).set({ status: "stale", updatedByUserId: ctx.actorUserId, updatedAt: new Date() }).where(and(eq(paymentMatchProposals.tenantId, ctx.tenantId), eq(paymentMatchProposals.paymentIntakeId, intake.id), inArray(paymentMatchProposals.status, ["draft", "ready", "needs_review"])));
            await tx.update(paymentIntakes).set({ amount: receivedTotal.toFixed(2), receivedAt, notes: input.notes ?? intake.notes, bankReference: input.bankReference?.trim() || null, bankReferenceHash: referenceHash(input.bankReference), status: "draft", updatedByUserId: ctx.actorUserId, updatedAt: new Date() }).where(and(eq(paymentIntakes.tenantId, ctx.tenantId), eq(paymentIntakes.id, intake.id)));
            await createAuditLog(tx, { tenantId: ctx.tenantId, actorUserId: ctx.actorUserId, actorSource: ctx.actorSource, requestId: ctx.requestId, correlationId: ctx.correlationId, entityType: "payment_intake", entityId: intake.publicId, action: "selected_floating_draft_updated", payload: { amount: receivedTotal.toFixed(2), receivedAt: receivedAt.toISOString(), targetCount: input.targets.length } });
            intake = { ...intake, amount: receivedTotal.toFixed(2), receivedAt, notes: input.notes ?? intake.notes, bankReference: input.bankReference?.trim() || null, bankReferenceHash: referenceHash(input.bankReference), status: "draft" };
        } else {
            const created = await createPaymentIntake(ctx, { amount: receivedTotal.toFixed(2), receivedAt: receivedAt.toISOString(), originLoanPublicId: loanPublicId, notes: input.notes, bankReference: input.bankReference }, tx);
            if (created.duplicate) {
                if (created.duplicateReason !== "idempotency_key") throw new DomainError("POSSIBLE_DUPLICATE_REQUIRES_REVIEW", "An existing payment matches this receipt and needs review", 409);
                intake = await tx.query.paymentIntakes.findFirst({ where: and(eq(paymentIntakes.tenantId, ctx.tenantId), eq(paymentIntakes.publicId, created.publicId)) }) ?? null;
                if (!intake || intake.originLoanId !== loan.id || !new FinancialDecimal(intake.amount).eq(receivedTotal) || intake.receivedAt.getTime() !== receivedAt.getTime() || intake.bankReferenceHash !== referenceHash(input.bankReference)) throw new DomainError("IDEMPOTENCY_PAYLOAD_MISMATCH", "This idempotency key is already bound to a different receipt payload", 409);
                const proposalRows = await tx.select().from(paymentMatchProposals).where(and(eq(paymentMatchProposals.tenantId, ctx.tenantId), eq(paymentMatchProposals.paymentIntakeId, intake.id))).orderBy(asc(paymentMatchProposals.version));
                if (proposalRows.at(-1)?.status === "posted") throw new DomainError("PAYMENT_INTAKE_IMMUTABLE", "A posted payment cannot be previewed again", 409);
            }
            intake = await tx.query.paymentIntakes.findFirst({ where: and(eq(paymentIntakes.tenantId, ctx.tenantId), eq(paymentIntakes.publicId, created.publicId)) }) ?? null;
        }
        if (!intake) throw new DomainError("PAYMENT_INTAKE_NOT_FOUND", "Payment intake was not created", 500);
        if (["posted", "reversed", "duplicate", "cancelled"].includes(intake.status)) throw new DomainError("PAYMENT_INTAKE_IMMUTABLE", "This payment intake can no longer be previewed", 409);
        const storedTargets = canonicalTargets(input.targets);
        const preview = await previewPaymentMatch(ctx, intake.publicId, {
            allocations: [{ borrowerPublicId: borrower.publicId, loanPublicId, amount: receivedTotal.toFixed(2) }],
            selectedFloatingTargets: storedTargets,
        }, tx);
        const currentObligations = await floatingInterestBalances(tx, loan, new Date(), ctx);
        const result = { ...preview, paymentIntakePublicId: intake.publicId, receivedAt: receivedAt.toISOString(), targets: storedTargets, total: receivedTotal.toFixed(2), remainingDebt: { principal: loan.outstandingPrincipal ?? loan.principalAmount, fees: loan.outstandingFees ?? "0.00", interest: currentObligations.dueInterest.plus(currentObligations.accruingInterest).toFixed(2), penalty: currentObligations.applicablePenalty.toFixed(2) } };
        const audit = await createAuditLog(tx, { tenantId: ctx.tenantId, actorUserId: ctx.actorUserId, actorSource: ctx.actorSource, requestId: ctx.requestId, correlationId: ctx.correlationId, entityType: "payment_intake", entityId: intake.publicId, action: "selected_floating_preview_command_bound", payload: { idempotencyKey: ctx.idempotencyKey, requestHash: fingerprint, proposalPublicId: preview.publicId } });
        await tx.insert(commandReceipts).values([{ tenantId: ctx.tenantId, operationType: "selected_floating_preview", operationKey: idempotencyKey, requestHash: fingerprint, result, auditPublicId: audit.publicId, correlationId: ctx.correlationId, createdByUserId: ctx.actorUserId }]);
        return result;
    });
}

export async function postFloatingAccrualPayment(ctx: CommandContext, loanPublicId: string, input: { paymentIntakePublicId: string; proposalPublicId: string; confirmed: true }) {
    if (input.confirmed !== true) throw new DomainError("PAYMENT_CONFIRMATION_REQUIRED", "Explicit payment confirmation is required", 400);
    if (!ctx.idempotencyKey?.trim()) throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key is required", 400);
    const proposal = await db.query.paymentMatchProposals.findFirst({ where: and(eq(paymentMatchProposals.tenantId, ctx.tenantId), eq(paymentMatchProposals.publicId, input.proposalPublicId)) });
    const intake = await db.query.paymentIntakes.findFirst({ where: and(eq(paymentIntakes.tenantId, ctx.tenantId), eq(paymentIntakes.publicId, input.paymentIntakePublicId)) });
    const allocation = proposal ? await db.query.paymentMatchAllocations.findFirst({ where: and(eq(paymentMatchAllocations.tenantId, ctx.tenantId), eq(paymentMatchAllocations.proposalId, proposal.id)) }) : null;
    const loan = await db.query.loans.findFirst({ where: and(eq(loans.tenantId, ctx.tenantId), eq(loans.publicId, loanPublicId)) });
    if (!loan || !intake || !proposal || !allocation || allocation.loanId !== loan.id || intake.id !== proposal.paymentIntakeId || allocation.matchReason !== "selected_floating_interest") throw new DomainError("PAYMENT_PROPOSAL_NOT_FOUND", "Selected accrual payment proposal not found", 404);
    const targets = await db.select().from(paymentMatchFloatingTargets).where(and(eq(paymentMatchFloatingTargets.tenantId, ctx.tenantId), eq(paymentMatchFloatingTargets.allocationId, allocation.id))).orderBy(asc(paymentMatchFloatingTargets.accrualDate));
    const posted = intake.status === "posted" || intake.status === "reversed"
        ? await postPayment(ctx, input.paymentIntakePublicId, { proposalPublicId: proposal.publicId, selectedFloatingConfirmed: true })
        : await postPayment(ctx, input.paymentIntakePublicId, { proposalPublicId: input.proposalPublicId, selectedFloatingConfirmed: true });
    const transactionPublicId = posted.transactions[0]?.publicId;
    const audit = await db.query.auditLogs.findFirst({
        where: and(eq(auditLogs.tenantId, ctx.tenantId), eq(auditLogs.entityType, "payment_intake"), eq(auditLogs.entityId, posted.publicId), eq(auditLogs.action, "posted")),
        orderBy: (row, { desc }) => [desc(row.createdAt)],
    });
    if (!audit) throw new DomainError("PAYMENT_AUDIT_NOT_FOUND", "Posted selected receipt audit is unavailable", 500);
    return { ...posted, receiptPublicId: transactionPublicId, auditPublicId: audit.publicId, correlationId: audit.correlationId ?? ctx.correlationId };
}
