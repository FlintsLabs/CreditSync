import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import {
    loanAdjustments,
    loanFundingAllocations,
    loanRenewalAdjustmentLines,
    loanRenewals,
    loanSchedules,
    loans,
    transactions,
    users,
} from "../db/schema";
import { canAccessTenantWideData } from "../lib/access";
import { createAuditLog } from "../lib/audit-log";
import { invalidateTenantCache } from "../lib/cache";
import { generateLoanSchedule } from "../lib/loan-schedule";
import {
    calculateRenewalComposition,
    type RenewalComposition,
    type RenewalManualAdjustment,
    type RenewalSettlementPolicy,
} from "../lib/loan-renewal-composition";
import { parseMoney, serializeMoney } from "../lib/money";
import type { CommandContext } from "./command-context";
import { DomainError } from "./domain-error";

type Executor = any;
type LoanRow = typeof loans.$inferSelect;
type RenewalRow = typeof loanRenewals.$inferSelect;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const previewHashVersion = "v1";
const defaultPreviewTtlSeconds = 900;

export interface PreviewLoanRenewalInput {
    requestedPrincipal: string;
    renewalDate?: string;
    paymentStartDate?: string;
    settlementPolicy?: RenewalSettlementPolicy;
    adjustments?: RenewalManualAdjustment[];
    waivedCharges?: string;
    waiverReason?: string;
}

interface RenewalSnapshot {
    composition: RenewalComposition;
    principalPaid: Decimal;
    outstandingPrincipal: Decimal;
    dueInterest: Decimal;
    dueFees: Decimal;
    duePenalties: Decimal;
    dueCharges: Decimal;
    state: Record<string, unknown>;
}

interface RenewalSnapshotOptions {
    requestedPrincipal: Decimal;
    settlementPolicy: RenewalSettlementPolicy;
    adjustments: RenewalManualAdjustment[];
    renewalDate: string;
    validateActivityDate?: boolean;
}

function auditContext(ctx: CommandContext) {
    return {
        tenantId: ctx.tenantId,
        actorUserId: ctx.actorUserId,
        actorSource: ctx.actorSource,
        requestId: ctx.requestId,
        correlationId: ctx.correlationId,
    };
}

function requirePublicId(value: string, field: string) {
    if (!uuidPattern.test(value)) {
        throw new DomainError("INVALID_PUBLIC_ID", `${field} must be a UUID`, 400, { field });
    }
}

function renewalMoney(value: string | undefined, field: string, fallback = "0.00") {
    try {
        return parseMoney(value ?? fallback);
    } catch {
        throw new DomainError("INVALID_RENEWAL_AMOUNT", `${field} must be a non-negative string with exactly two decimals`, 400, { field });
    }
}

function previewTtlSeconds() {
    const configured = Number(process.env.RENEWAL_PREVIEW_TTL_SECONDS ?? defaultPreviewTtlSeconds);
    return Number.isFinite(configured) && Number.isInteger(configured) && configured >= 60
        ? configured
        : defaultPreviewTtlSeconds;
}

async function actorFor(ctx: CommandContext, executor: Executor = db) {
    if (ctx.actorUserId === null) return null;
    const actor = await executor.query.users.findFirst({
        where: and(eq(users.id, ctx.actorUserId), eq(users.tenantId, ctx.tenantId)),
    });
    if (!actor) throw new DomainError("ACTOR_NOT_FOUND", "Actor is not available in this tenant", 403);
    return actor;
}

async function accessibleLoan(ctx: CommandContext, publicId: string, executor: Executor = db) {
    requirePublicId(publicId, "oldLoanId");
    const actor = await actorFor(ctx, executor);
    const loan = await executor.query.loans.findFirst({
        where: and(eq(loans.publicId, publicId), eq(loans.tenantId, ctx.tenantId)),
    });
    if (!loan || (actor && !canAccessTenantWideData({ role: actor.role ?? "viewer" }) && loan.ownerUserId !== actor.id)) {
        throw new DomainError("LOAN_NOT_FOUND", "Loan not found", 404);
    }
    return loan as LoanRow;
}

function utcDay(value: Date | string) {
    const date = new Date(value);
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function bangkokDate(value: Date) {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Bangkok",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).format(value);
}

const businessDatePattern = /^\d{4}-\d{2}-\d{2}$/;

function parseBusinessDate(value: string | undefined, field: "renewalDate" | "paymentStartDate") {
    if (!value || !businessDatePattern.test(value)) {
        throw new DomainError("INVALID_RENEWAL_DATE", `${field} must use YYYY-MM-DD`, 400, { field });
    }
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
        throw new DomainError("INVALID_RENEWAL_DATE", `${field} must be a valid calendar date`, 400, { field });
    }
    return value;
}

function businessDateAsOf(value: string) {
    return new Date(`${value}T23:59:59.999+07:00`);
}

function resolveRenewalDates(input: PreviewLoanRenewalInput, loan: LoanRow, now: Date) {
    const hasExplicitRenewalDate = input.renewalDate !== undefined;
    const renewalDate = hasExplicitRenewalDate ? parseBusinessDate(input.renewalDate, "renewalDate") : bangkokDate(now);
    const loanStartDate = loan.startDate ?? renewalDate;
    if (hasExplicitRenewalDate && renewalDate < loanStartDate) {
        throw new DomainError("RENEWAL_DATE_BEFORE_LOAN_START", "renewalDate cannot be before the old loan start date", 400, { renewalDate, loanStartDate });
    }
    const today = bangkokDate(now);
    if (hasExplicitRenewalDate && renewalDate > today) {
        throw new DomainError("RENEWAL_DATE_IN_FUTURE", "renewalDate cannot be in the future", 400, { renewalDate, today });
    }
    const paymentStartDate = input.paymentStartDate === undefined
        ? undefined
        : parseBusinessDate(input.paymentStartDate, "paymentStartDate");
    if (paymentStartDate !== undefined && paymentStartDate < renewalDate) {
        throw new DomainError("PAYMENT_START_DATE_BEFORE_RENEWAL", "paymentStartDate cannot be before renewalDate", 400, { renewalDate, paymentStartDate });
    }
    return { renewalDate, paymentStartDate };
}

function activeRepayments(rows: Array<typeof transactions.$inferSelect>) {
    const reversedIds = new Set(rows
        .filter((row) => row.entryType === "reversal" && row.reversedTransactionId !== null)
        .map((row) => row.reversedTransactionId!));
    return rows.filter((row) => row.entryType === "repayment" && !reversedIds.has(row.id));
}

function penaltyDue(loan: LoanRow, remainingDue: Decimal, paidPenalty: Decimal, dueDate: string, asOf: Date) {
    if (remainingDue.lte(0)) return new Decimal(0);
    const overdueDays = Math.max(0,
        Math.floor((utcDay(asOf) - utcDay(dueDate)) / 86_400_000) - (loan.gracePeriodDays ?? 0));
    if (overdueDays === 0) return new Decimal(0);
    const rateOrAmount = new Decimal(loan.lateFeeAmount ?? 0);
    let accrued = new Decimal(0);
    if (loan.lateFeeMode === "fixed" || loan.lateFeeMode === "fixed_plus_percent") {
        accrued = accrued.plus(rateOrAmount);
    }
    if (loan.lateFeeMode === "daily_percent" || loan.lateFeeMode === "fixed_plus_percent") {
        accrued = accrued.plus(remainingDue.times(rateOrAmount).div(100).times(overdueDays));
    }
    return Decimal.max(0, accrued.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).minus(paidPenalty));
}

async function renewalSnapshot(
    executor: Executor,
    ctx: CommandContext,
    loan: LoanRow,
    asOf: Date,
    options: RenewalSnapshotOptions,
): Promise<RenewalSnapshot> {
    const [scheduleRows, transactionRows, fundingRows] = await Promise.all([
        executor.select().from(loanSchedules).where(and(
            eq(loanSchedules.tenantId, ctx.tenantId),
            eq(loanSchedules.loanId, loan.id),
        )).orderBy(loanSchedules.installmentNo),
        executor.select().from(transactions).where(and(
            eq(transactions.tenantId, ctx.tenantId),
            eq(transactions.loanId, loan.id),
        )).orderBy(transactions.id),
        executor.select().from(loanFundingAllocations).where(and(
            eq(loanFundingAllocations.tenantId, ctx.tenantId),
            eq(loanFundingAllocations.loanId, loan.id),
        )).orderBy(loanFundingAllocations.id),
    ]);
    const lateActivity = options.validateActivityDate
        ? transactionRows.find((row: typeof transactions.$inferSelect) => row.transactionDate !== null && bangkokDate(row.transactionDate) > options.renewalDate)
        : undefined;
    if (lateActivity) {
        throw new DomainError("RENEWAL_DATE_AFTER_POSTED_ACTIVITY", "renewalDate is before posted loan activity", 409, {
            renewalDate: options.renewalDate,
            transactionPublicId: lateActivity.publicId,
        });
    }
    const posted = activeRepayments(transactionRows);
    const actualPrincipalPaid = posted.reduce(
        (total: Decimal, row: typeof transactions.$inferSelect) => total.plus(row.principalComponent),
        new Decimal(0),
    );
    const principal = new Decimal(loan.principalAmount);
    const principalPaid = Decimal.min(principal, Decimal.max(0, actualPrincipalPaid)).toDecimalPlaces(2);
    const outstandingPrincipal = Decimal.max(0, principal.minus(principalPaid)).toDecimalPlaces(2);
    const paidBySchedule = new Map<number, { principal: Decimal; interest: Decimal; fee: Decimal; penalty: Decimal }>();
    for (const transaction of posted) {
        if (transaction.scheduleId === null) continue;
        const paid = paidBySchedule.get(transaction.scheduleId) ?? {
            principal: new Decimal(0), interest: new Decimal(0), fee: new Decimal(0), penalty: new Decimal(0),
        };
        paid.principal = paid.principal.plus(transaction.principalComponent);
        paid.interest = paid.interest.plus(transaction.interestComponent);
        paid.fee = paid.fee.plus(transaction.feeComponent);
        paid.penalty = paid.penalty.plus(transaction.penaltyComponent);
        paidBySchedule.set(transaction.scheduleId, paid);
    }
    let dueInterest = new Decimal(0);
    let dueFees = new Decimal(0);
    let duePenalties = new Decimal(0);
    for (const schedule of scheduleRows) {
        if (utcDay(schedule.dueDate) > utcDay(asOf)) continue;
        const paid = paidBySchedule.get(schedule.id) ?? {
            principal: new Decimal(0), interest: new Decimal(0), fee: new Decimal(0), penalty: new Decimal(0),
        };
        const interest = Decimal.max(0, new Decimal(schedule.scheduledInterest).minus(paid.interest));
        const fee = Decimal.max(0, new Decimal(schedule.scheduledFee).minus(paid.fee));
        const remainingDue = Decimal.max(0,
            new Decimal(schedule.scheduledPrincipal).minus(paid.principal)
                .plus(interest).plus(fee));
        dueInterest = dueInterest.plus(interest);
        dueFees = dueFees.plus(fee);
        duePenalties = duePenalties.plus(penaltyDue(loan, remainingDue, paid.penalty, schedule.dueDate, asOf));
    }
    dueInterest = dueInterest.toDecimalPlaces(2);
    dueFees = dueFees.toDecimalPlaces(2);
    duePenalties = duePenalties.toDecimalPlaces(2);
    let composition: RenewalComposition;
    try {
        composition = calculateRenewalComposition({
            settlementPolicy: options.settlementPolicy,
            renewalDate: options.renewalDate,
            requestedPrincipal: serializeMoney(options.requestedPrincipal),
            originalPrincipal: serializeMoney(loan.principalAmount),
            contractStartDate: loan.startDate ?? scheduleRows[0]?.dueDate ?? bangkokDate(asOf),
            contractDueDate: scheduleRows.at(-1)?.dueDate ?? loan.startDate ?? bangkokDate(asOf),
            schedules: scheduleRows.map((row: typeof loanSchedules.$inferSelect) => ({
                dueDate: row.dueDate,
                principal: serializeMoney(row.scheduledPrincipal),
                interest: serializeMoney(row.scheduledInterest),
                fee: serializeMoney(row.scheduledFee),
            })),
            payments: posted.map((row: typeof transactions.$inferSelect) => ({
                transactionPublicId: row.publicId,
                paidAt: (row.transactionDate ?? row.postedAt).toISOString(),
                amount: serializeMoney(row.amount),
                principal: new Decimal(row.principalComponent).toFixed(2),
                interest: new Decimal(row.interestComponent).toFixed(2),
                fee: new Decimal(row.feeComponent).toFixed(2),
                penalty: new Decimal(row.penaltyComponent).toFixed(2),
            })),
            accruedDueInterest: serializeMoney(dueInterest),
            dueFees: serializeMoney(dueFees),
            duePenalties: serializeMoney(duePenalties),
            adjustments: options.adjustments,
        });
    } catch (error) {
        const code = error instanceof Error ? error.message : "INVALID_RENEWAL_COMPOSITION";
        throw new DomainError(code, "Renewal composition is invalid", 400);
    }
    return {
        composition,
        principalPaid,
        outstandingPrincipal,
        dueInterest,
        dueFees,
        duePenalties,
        dueCharges: dueInterest.plus(dueFees).plus(duePenalties).toDecimalPlaces(2),
        state: {
            loan: {
                publicId: loan.publicId,
                status: loan.status,
                principalAmount: serializeMoney(loan.principalAmount),
                updatedAt: loan.updatedAt?.toISOString() ?? null,
            },
            schedules: scheduleRows.map((row: typeof loanSchedules.$inferSelect) => ({
                publicId: row.publicId,
                dueDate: row.dueDate,
                scheduledPrincipal: serializeMoney(row.scheduledPrincipal),
                scheduledInterest: serializeMoney(row.scheduledInterest),
                scheduledFee: serializeMoney(row.scheduledFee),
            })),
            repaymentLedger: transactionRows.map((row: typeof transactions.$inferSelect) => ({
                publicId: row.publicId,
                entryType: row.entryType,
                reversedTransactionId: row.reversedTransactionId,
                amount: row.amount,
                principal: new Decimal(row.principalComponent).toFixed(2),
                interest: new Decimal(row.interestComponent).toFixed(2),
                fee: new Decimal(row.feeComponent).toFixed(2),
                penalty: new Decimal(row.penaltyComponent).toFixed(2),
            })),
            fundingAllocations: fundingRows.map((row: typeof loanFundingAllocations.$inferSelect) => ({
                publicId: row.publicId,
                bankProfileId: row.bankProfileId,
                bankLoanId: row.bankLoanId,
                amount: new Decimal(row.allocatedAmount).toFixed(2),
                allocationType: row.allocationType,
                reversedAllocationId: row.reversedAllocationId,
            })),
        },
    };
}

function previewHash(snapshot: RenewalSnapshot, asOfDate: string, expiresAt: Date, paymentStartDate?: string, includeDateFields = true) {
    const payload = JSON.stringify({
        contract: "loan-renewal-preview",
        version: previewHashVersion,
        asOfDate,
        expiresAt: expiresAt.toISOString(),
        ...(includeDateFields ? { renewalDate: asOfDate, paymentStartDate: paymentStartDate ?? null } : {}),
        composition: snapshot.composition,
        principalPaid: serializeMoney(snapshot.principalPaid),
        outstandingPrincipal: serializeMoney(snapshot.outstandingPrincipal),
        dueInterest: serializeMoney(snapshot.dueInterest),
        dueFees: serializeMoney(snapshot.dueFees),
        duePenalties: serializeMoney(snapshot.duePenalties),
        state: snapshot.state,
    });
    return `${previewHashVersion}:${createHash("sha256").update(payload).digest("hex")}`;
}

function presentPreview(row: RenewalRow, loan: LoanRow, snapshot: RenewalSnapshot) {
    return {
        id: row.publicId,
        publicId: row.publicId,
        oldLoanPublicId: loan.publicId,
        renewalDate: row.renewalDate ?? snapshot.composition.renewalDate,
        paymentStartDate: row.paymentStartDate,
        status: row.status,
        settlementPolicy: snapshot.composition.settlementPolicy,
        composition: snapshot.composition,
        previewHash: row.previewHash,
        hashVersion: previewHashVersion,
        principalPaid: serializeMoney(snapshot.principalPaid),
        outstandingPrincipal: serializeMoney(row.outstandingPrincipal),
        dueInterest: serializeMoney(snapshot.dueInterest),
        dueFees: serializeMoney(snapshot.dueFees),
        duePenalties: serializeMoney(snapshot.duePenalties),
        dueCharges: serializeMoney(row.dueCharges),
        settlementAmount: serializeMoney(new Decimal(row.dueCharges).minus(row.waivedCharges)),
        waivedCharges: serializeMoney(row.waivedCharges),
        requestedPrincipal: serializeMoney(row.requestedPrincipal),
        cashDirection: row.cashDirection ?? "none",
        cashAmount: serializeMoney(row.cashAmount),
        waiverReason: row.reason,
        expiresAt: row.expiresAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}

export async function previewLoanRenewal(
    ctx: CommandContext,
    oldLoanPublicId: string,
    input: PreviewLoanRenewalInput,
) {
    if (input.adjustments !== undefined && (input.waivedCharges !== undefined || input.waiverReason !== undefined)) {
        throw new DomainError(
            "RENEWAL_ADJUSTMENT_INPUT_CONFLICT",
            "Structured adjustments cannot be combined with legacy waiver fields",
            400,
        );
    }
    if ((input.adjustments?.length ?? 0) > 50) {
        throw new DomainError("TOO_MANY_RENEWAL_ADJUSTMENTS", "At most 50 renewal adjustments are allowed", 400);
    }
    const requestedPrincipal = renewalMoney(input.requestedPrincipal, "requestedPrincipal");
    if (requestedPrincipal.isZero()) {
        throw new DomainError("INVALID_RENEWAL_AMOUNT", "requestedPrincipal must be greater than zero", 400, { field: "requestedPrincipal" });
    }
    const waivedCharges = renewalMoney(input.waivedCharges, "waivedCharges");
    const waiverReason = input.waiverReason?.trim() || null;
    if (waivedCharges.gt(0) && !waiverReason) {
        throw new DomainError("WAIVER_REASON_REQUIRED", "A waiver reason is required when charges are waived", 400);
    }
    const settlementPolicy = input.settlementPolicy ?? "full_contract_interest";
    const adjustments = [...(input.adjustments ?? [])];
    if (waivedCharges.gt(0)) {
        adjustments.push({ kind: "waiver", amount: serializeMoney(waivedCharges), reason: waiverReason! });
    }
    const accessible = await accessibleLoan(ctx, oldLoanPublicId);
    return db.transaction(async (tx) => {
        await tx.execute(sql`SELECT id FROM loans WHERE tenant_id = ${ctx.tenantId} AND id = ${accessible.id} FOR UPDATE`);
        const loan = await accessibleLoan(ctx, oldLoanPublicId, tx);
        if (loan.repaymentType !== "daily" || !["active", "paid"].includes(loan.status ?? "")) {
            throw new DomainError("LOAN_NOT_RENEWABLE", "Only active or paid daily loans can be renewed", 409);
        }
        const asOf = new Date();
        const { renewalDate, paymentStartDate } = resolveRenewalDates(input, loan, asOf);
        const renewalAsOf = renewalDate === bangkokDate(asOf) ? asOf : businessDateAsOf(renewalDate);
        const snapshot = await renewalSnapshot(tx, ctx, loan, renewalAsOf, {
            requestedPrincipal,
            settlementPolicy,
            adjustments,
            renewalDate,
            validateActivityDate: input.renewalDate !== undefined,
        });
        const composition = snapshot.composition;
        const dueCharges = new Decimal(composition.settlementAmount).plus(composition.manualWaivers);
        const totalWaivers = new Decimal(composition.manualWaivers);
        const expiresAt = new Date(asOf.getTime() + previewTtlSeconds() * 1000);
        const hash = previewHash(snapshot, renewalDate, expiresAt, paymentStartDate);
        await tx.update(loanRenewals).set({
            status: "expired",
            updatedByUserId: ctx.actorUserId,
            updatedAt: asOf,
        }).where(and(
            eq(loanRenewals.tenantId, ctx.tenantId),
            eq(loanRenewals.oldLoanId, loan.id),
            eq(loanRenewals.status, "preview"),
        ));
        const row = await tx.insert(loanRenewals).values({
            tenantId: ctx.tenantId,
            oldLoanId: loan.id,
            status: "preview",
            settlementPolicy,
            composition,
            renewalDate,
            paymentStartDate: paymentStartDate ?? null,
            previewHash: hash,
            requestedPrincipal: serializeMoney(requestedPrincipal),
            outstandingPrincipal: serializeMoney(snapshot.outstandingPrincipal),
            dueCharges: serializeMoney(dueCharges),
            waivedCharges: serializeMoney(totalWaivers),
            cashDirection: composition.cashDirection,
            cashAmount: composition.cashAmount,
            reason: waiverReason,
            expiresAt,
            createdByUserId: ctx.actorUserId,
            updatedByUserId: ctx.actorUserId,
        }).returning().then((rows) => rows[0]!);
        await createAuditLog(tx, {
            ...auditContext(ctx),
            entityType: "loan_renewal",
            entityId: row.publicId,
            action: "previewed",
            payload: {
                oldLoanPublicId: loan.publicId,
                principalPaid: serializeMoney(snapshot.principalPaid),
                outstandingPrincipal: serializeMoney(snapshot.outstandingPrincipal),
                settlementPolicy,
                renewalDate,
                paymentStartDate,
                composition,
                dueCharges: serializeMoney(dueCharges),
                waivedCharges: serializeMoney(totalWaivers),
                settlementAmount: composition.settlementAmount,
                requestedPrincipal: serializeMoney(requestedPrincipal),
                cashDirection: composition.cashDirection,
                cashAmount: composition.cashAmount,
                previewHash: hash,
                expiresAt: row.expiresAt.toISOString(),
            },
        });
        return presentPreview(row, loan, snapshot);
    });
}

export interface ExecuteLoanRenewalInput {
    previewHash: string;
    confirmed: boolean;
    reason: string;
    confirmedCashDirection?: "collection";
}

function requireExecution(ctx: CommandContext, input: ExecuteLoanRenewalInput) {
    if (input.confirmed !== true) {
        throw new DomainError("RENEWAL_CONFIRMATION_REQUIRED", "Renewal execution requires explicit confirmation", 400);
    }
    const reason = input.reason?.trim();
    if (!reason) throw new DomainError("RENEWAL_REASON_REQUIRED", "Renewal execution requires a reason", 400);
    const idempotencyKey = ctx.idempotencyKey?.trim();
    if (!idempotencyKey) {
        throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", "Renewal execution requires a non-blank Idempotency-Key", 400);
    }
    if (!/^v\d+:[0-9a-f]{64}$/i.test(input.previewHash)) {
        throw new DomainError("INVALID_PREVIEW_HASH", "previewHash must be a versioned SHA-256 hash", 400);
    }
    return { reason, idempotencyKey };
}

async function accessibleRenewal(ctx: CommandContext, renewalPublicId: string, executor: Executor = db) {
    requirePublicId(renewalPublicId, "renewalId");
    const renewal = await executor.query.loanRenewals.findFirst({ where: and(
        eq(loanRenewals.publicId, renewalPublicId),
        eq(loanRenewals.tenantId, ctx.tenantId),
    ) });
    if (!renewal) throw new DomainError("RENEWAL_NOT_FOUND", "Loan renewal not found", 404);
    const oldLoan = await executor.query.loans.findFirst({ where: and(
        eq(loans.id, renewal.oldLoanId), eq(loans.tenantId, ctx.tenantId),
    ) });
    if (!oldLoan) throw new DomainError("RENEWAL_NOT_FOUND", "Loan renewal not found", 404);
    const actor = await actorFor(ctx, executor);
    if (actor && !canAccessTenantWideData({ role: actor.role ?? "viewer" }) && oldLoan.ownerUserId !== actor.id) {
        throw new DomainError("RENEWAL_NOT_FOUND", "Loan renewal not found", 404);
    }
    return { renewal: renewal as RenewalRow, oldLoan: oldLoan as LoanRow };
}

function executedPrincipalPaid(oldLoan: LoanRow, renewal: RenewalRow) {
    return Decimal.max(0, new Decimal(oldLoan.principalAmount).minus(renewal.outstandingPrincipal));
}

async function presentExecution(executor: Executor, renewal: RenewalRow, oldLoan: LoanRow) {
    const newLoan = renewal.newLoanId === null ? null : await executor.query.loans.findFirst({ where: and(
        eq(loans.id, renewal.newLoanId), eq(loans.tenantId, renewal.tenantId),
    ) });
    return {
        id: renewal.publicId,
        publicId: renewal.publicId,
        status: renewal.status,
        settlementPolicy: renewal.settlementPolicy,
        composition: renewal.composition,
        renewalDate: renewal.renewalDate ?? (renewal.composition as RenewalComposition | null)?.renewalDate ?? bangkokDate(renewal.createdAt),
        paymentStartDate: renewal.paymentStartDate,
        oldLoanPublicId: oldLoan.publicId,
        newLoanPublicId: newLoan?.publicId ?? null,
        previewHash: renewal.previewHash,
        principalPaid: serializeMoney(executedPrincipalPaid(oldLoan, renewal)),
        outstandingPrincipal: serializeMoney(renewal.outstandingPrincipal),
        dueCharges: serializeMoney(renewal.dueCharges),
        settlementAmount: serializeMoney(new Decimal(renewal.dueCharges).minus(renewal.waivedCharges)),
        waivedCharges: serializeMoney(renewal.waivedCharges),
        requestedPrincipal: serializeMoney(renewal.requestedPrincipal),
        cashDirection: renewal.cashDirection ?? "none",
        cashAmount: serializeMoney(renewal.cashAmount),
        reason: renewal.reason,
        executedAt: renewal.executedAt,
        reversedAt: renewal.reversedAt,
    };
}

function groupFunding(rows: Array<typeof loanFundingAllocations.$inferSelect>) {
    const grouped = new Map<string, {
        bankProfileId: number | null;
        bankLoanId: number | null;
        amount: Decimal;
    }>();
    for (const row of rows) {
        const key = `${row.bankProfileId ?? "none"}:${row.bankLoanId ?? "none"}`;
        const current = grouped.get(key);
        grouped.set(key, {
            bankProfileId: row.bankProfileId,
            bankLoanId: row.bankLoanId,
            amount: (current?.amount ?? new Decimal(0)).plus(row.allocatedAmount),
        });
    }
    return [...grouped.values()]
        .filter((row) => row.amount.gt(0))
        .sort((a, b) => (a.bankProfileId ?? 0) - (b.bankProfileId ?? 0) || (a.bankLoanId ?? 0) - (b.bankLoanId ?? 0));
}

export function allocateFundingByLargestRemainder(
    sources: ReturnType<typeof groupFunding>,
    requestedPrincipal: Decimal,
) {
    const availableCents = sources.reduce(
        (total, row) => total.plus(row.amount.times(100).toDecimalPlaces(0, Decimal.ROUND_DOWN)),
        new Decimal(0),
    );
    const requestedCents = requestedPrincipal.times(100).toDecimalPlaces(0, Decimal.ROUND_DOWN);
    if (sources.length === 0 || availableCents.lte(0) || requestedCents.lte(0)) {
        return sources.map((source) => ({ ...source, carryAmount: new Decimal(0) }));
    }
    const shares = sources.map((source, index) => {
        const sourceCents = source.amount.times(100).toDecimalPlaces(0, Decimal.ROUND_DOWN);
        const exact = requestedCents.times(sourceCents).div(availableCents);
        const floorCents = exact.toDecimalPlaces(0, Decimal.ROUND_DOWN);
        return { source, index, floorCents, remainder: exact.minus(floorCents) };
    });
    const floorTotal = shares.reduce((total, row) => total.plus(row.floorCents), new Decimal(0));
    const extraCentCount = requestedCents.minus(floorTotal).toNumber();
    const ranked = [...shares].sort((a, b) => {
        const remainderOrder = b.remainder.comparedTo(a.remainder);
        return remainderOrder === 0 ? a.index - b.index : remainderOrder;
    });
    const receivesExtraCent = new Set(ranked.slice(0, extraCentCount).map((row) => row.index));
    return shares.map(({ source, index, floorCents }) => ({
        ...source,
        carryAmount: floorCents.plus(receivesExtraCent.has(index) ? 1 : 0).div(100),
    }));
}

export async function executeLoanRenewal(
    ctx: CommandContext,
    renewalPublicId: string,
    input: ExecuteLoanRenewalInput,
) {
    const { reason, idempotencyKey } = requireExecution(ctx, input);
    const accessible = await accessibleRenewal(ctx, renewalPublicId);
    const result = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(
            ${`loan-renewal-execute:${ctx.tenantId}:${idempotencyKey}`}, 0
        ))`);
        const reusedKey = await tx.query.loanRenewals.findFirst({ where: and(
            eq(loanRenewals.tenantId, ctx.tenantId), eq(loanRenewals.idempotencyKey, idempotencyKey),
        ) });
        if (reusedKey && reusedKey.id !== accessible.renewal.id) {
            throw new DomainError("IDEMPOTENCY_KEY_CONFLICT", "Idempotency-Key was already used for another renewal", 409);
        }
        await tx.execute(sql`SELECT id FROM loans WHERE tenant_id = ${ctx.tenantId} AND id = ${accessible.oldLoan.id} FOR UPDATE`);
        await tx.execute(sql`SELECT id FROM loan_renewals WHERE tenant_id = ${ctx.tenantId} AND id = ${accessible.renewal.id} FOR UPDATE`);
        const locked = await accessibleRenewal(ctx, renewalPublicId, tx);
        const renewal = locked.renewal;
        const oldLoan = locked.oldLoan;
        if (renewal.status === "executed") {
            if (renewal.idempotencyKey === idempotencyKey) return { value: await presentExecution(tx, renewal, oldLoan) };
            throw new DomainError("RENEWAL_ALREADY_EXECUTED", "Loan renewal has already been executed", 409);
        }
        if (renewal.status !== "preview") {
            throw new DomainError("RENEWAL_NOT_EXECUTABLE", "Loan renewal is not executable", 409);
        }
        const effectiveAt = new Date();
        if (renewal.expiresAt.getTime() <= effectiveAt.getTime() || renewal.previewHash !== input.previewHash) {
            await tx.update(loanRenewals).set({ status: "expired", updatedByUserId: ctx.actorUserId, updatedAt: effectiveAt })
                .where(and(eq(loanRenewals.id, renewal.id), eq(loanRenewals.tenantId, ctx.tenantId)));
            return { stale: true as const };
        }
        const frozenComposition = renewal.composition as RenewalComposition | null;
        const renewalDate = renewal.renewalDate ?? frozenComposition?.renewalDate ?? bangkokDate(effectiveAt);
        const snapshotAsOf = renewalDate === bangkokDate(effectiveAt) ? effectiveAt : businessDateAsOf(renewalDate);
        const snapshot = await renewalSnapshot(tx, ctx, oldLoan, snapshotAsOf, {
            requestedPrincipal: new Decimal(renewal.requestedPrincipal),
            settlementPolicy: renewal.settlementPolicy,
            adjustments: frozenComposition?.adjustments.map(({ kind, amount, reason }) => ({ kind, amount, reason })) ?? [],
            renewalDate,
        });
        const currentHash = previewHash(snapshot, renewalDate, renewal.expiresAt, renewal.paymentStartDate ?? undefined, renewal.renewalDate !== null);
        const currentDueCharges = new Decimal(snapshot.composition.settlementAmount)
            .plus(snapshot.composition.manualWaivers);
        if (currentHash !== renewal.previewHash
            || !snapshot.outstandingPrincipal.eq(renewal.outstandingPrincipal)
            || !currentDueCharges.eq(renewal.dueCharges)) {
            await tx.update(loanRenewals).set({ status: "expired", updatedByUserId: ctx.actorUserId, updatedAt: effectiveAt })
                .where(and(eq(loanRenewals.id, renewal.id), eq(loanRenewals.tenantId, ctx.tenantId)));
            return { stale: true as const };
        }
        if (renewal.cashDirection === "collection" && input.confirmedCashDirection !== "collection") {
            throw new DomainError(
                "RENEWAL_COLLECTION_CONFIRMATION_REQUIRED",
                "Collection renewals require explicit cash-direction confirmation",
                400,
            );
        }
        if (renewal.cashDirection !== "collection" && input.confirmedCashDirection !== undefined) {
            throw new DomainError(
                "UNEXPECTED_RENEWAL_COLLECTION_CONFIRMATION",
                "Collection confirmation is only valid for a collection renewal",
                400,
            );
        }
        if (oldLoan.status !== "active" && oldLoan.status !== "paid") {
            throw new DomainError("LOAN_NOT_RENEWABLE", "Only active or paid daily loans can be renewed", 409);
        }
        if (oldLoan.termMonths === null) {
            throw new DomainError("INVALID_RENEWAL_TERMS", "The old loan has no reusable term length", 409);
        }
        const sourceRows = await tx.select().from(loanFundingAllocations).where(and(
            eq(loanFundingAllocations.tenantId, ctx.tenantId),
            eq(loanFundingAllocations.loanId, oldLoan.id),
        )).orderBy(loanFundingAllocations.id);
        const funding = groupFunding(sourceRows);
        const availableFunding = funding.reduce((total, row) => total.plus(row.amount), new Decimal(0));
        const requestedPrincipal = new Decimal(renewal.requestedPrincipal);
        if (availableFunding.lt(requestedPrincipal)) {
            throw new DomainError("INSUFFICIENT_FUNDING_ALLOCATION", "Existing funding cannot cover the requested renewal principal", 409, {
                availableFunding: serializeMoney(availableFunding),
                requestedPrincipal: serializeMoney(requestedPrincipal),
            });
        }
        let generated;
        const startDate = renewalDate;
        const paymentStartDate = renewal.paymentStartDate ?? undefined;
        try {
            generated = generateLoanSchedule({
                principal: renewal.requestedPrincipal,
                interestRate: oldLoan.interestRate,
                termMonths: oldLoan.termMonths,
                repaymentType: oldLoan.repaymentType as "daily",
                startDate,
                paymentStartDate,
                totalInstallments: oldLoan.totalInstallments ?? undefined,
                installmentAmount: oldLoan.installmentAmount ?? undefined,
            });
        } catch (error) {
            throw new DomainError("INVALID_RENEWAL_TERMS", error instanceof Error ? error.message : "Renewal terms are invalid", 400);
        }
        const outstandingInterest = generated.reduce(
            (total, row) => total.plus(row.scheduledInterest), new Decimal(0),
        );
        const outstandingFees = generated.reduce(
            (total, row) => total.plus(row.scheduledFee), new Decimal(0),
        );
        const newLoan = await tx.insert(loans).values({
            tenantId: ctx.tenantId,
            ownerUserId: oldLoan.ownerUserId,
            borrowerId: oldLoan.borrowerId,
            bankLoanId: oldLoan.bankLoanId,
            principalAmount: serializeMoney(requestedPrincipal),
            interestRate: serializeMoney(oldLoan.interestRate),
            repaymentType: oldLoan.repaymentType,
            termMonths: oldLoan.termMonths,
            installmentAmount: oldLoan.installmentAmount,
            totalInstallments: oldLoan.totalInstallments,
            gracePeriodDays: oldLoan.gracePeriodDays,
            lateFeeMode: oldLoan.lateFeeMode,
            lateFeeAmount: oldLoan.lateFeeAmount,
            startDate,
            paymentStartDate,
            nextDueDate: generated[0]?.dueDate ?? null,
            outstandingPrincipal: serializeMoney(requestedPrincipal),
            outstandingInterest: serializeMoney(outstandingInterest),
            outstandingFees: serializeMoney(outstandingFees),
            status: "active",
            clonedFromLoanId: oldLoan.id,
        }).returning().then((rows) => rows[0]!);
        if (generated.length) {
            await tx.insert(loanSchedules).values(generated.map((row) => ({
                tenantId: ctx.tenantId,
                loanId: newLoan.id,
                installmentNo: row.installmentNo,
                dueDate: row.dueDate,
                scheduledPrincipal: row.scheduledPrincipal,
                scheduledInterest: row.scheduledInterest,
                scheduledFee: row.scheduledFee,
                scheduledTotal: row.scheduledTotal,
                paidTotal: "0.00",
                paidPenalty: "0.00",
                remainingDue: row.remainingDue,
                status: "pending",
            })));
        }
        const carry = allocateFundingByLargestRemainder(funding, requestedPrincipal);
        const allocationGroupId = crypto.randomUUID();
        for (const source of carry) {
            await tx.insert(loanFundingAllocations).values([{
                tenantId: ctx.tenantId,
                bankProfileId: source.bankProfileId,
                bankLoanId: source.bankLoanId,
                loanId: oldLoan.id,
                allocatedAmount: source.carryAmount.negated().toFixed(2),
                allocationDate: startDate,
                allocationType: "reallocation_out",
                renewalId: renewal.id,
                allocationGroupId,
                note: `Transferred to renewal ${renewal.publicId}`,
                createdByUserId: ctx.actorUserId,
            }, {
                tenantId: ctx.tenantId,
                bankProfileId: source.bankProfileId,
                bankLoanId: source.bankLoanId,
                loanId: newLoan.id,
                allocatedAmount: source.carryAmount.toFixed(2),
                allocationDate: startDate,
                allocationType: "reallocation_in",
                renewalId: renewal.id,
                allocationGroupId,
                note: `Carried from loan ${oldLoan.publicId} via renewal ${renewal.publicId}`,
                createdByUserId: ctx.actorUserId,
            }]);
        }
        const composition = frozenComposition ?? snapshot.composition;
        const settlementAmount = new Decimal(composition.settlementAmount);
        if (composition.adjustments.length > 0) {
            const adjustmentAudit = await createAuditLog(tx, {
                ...auditContext(ctx),
                entityType: "loan_renewal_adjustment_lines",
                entityId: renewal.publicId,
                action: "posted",
                payload: { renewalPublicId: renewal.publicId, adjustments: composition.adjustments },
            });
            await tx.insert(loanRenewalAdjustmentLines).values(composition.adjustments.map((line) => ({
                tenantId: ctx.tenantId,
                renewalId: renewal.id,
                lineNo: line.lineNo,
                kind: line.kind,
                amount: line.amount,
                reason: line.reason,
                status: "posted" as const,
                actorSource: ctx.actorSource,
                requestId: ctx.requestId,
                correlationId: ctx.correlationId,
                idempotencyKey: `renewal:${idempotencyKey}:manual-line:${line.lineNo}`,
                auditPublicId: adjustmentAudit.publicId,
                createdByUserId: ctx.actorUserId,
            })));
        }
        const adjustments: Array<{
            loanId: number;
            adjustmentType: string;
            amount: string;
            suffix: string;
            reason?: string;
        }> = [{
            loanId: newLoan.id,
            adjustmentType: "principal_transfer",
            amount: serializeMoney(renewal.outstandingPrincipal),
            suffix: "principal-transfer",
        }];
        const policyInterest = new Decimal(composition.settlementPolicy === "full_contract_interest"
            ? composition.remainingContractInterest
            : composition.accruedDueInterest);
        if (policyInterest.gt(0)) adjustments.push({
            loanId: oldLoan.id,
            adjustmentType: composition.settlementPolicy === "full_contract_interest"
                ? "contract_interest_settlement"
                : "accrued_interest_settlement",
            amount: serializeMoney(policyInterest),
            suffix: "policy-interest-settlement",
        });
        if (new Decimal(composition.dueFees).gt(0)) adjustments.push({
            loanId: oldLoan.id,
            adjustmentType: "due_fee_settlement",
            amount: composition.dueFees,
            suffix: "due-fee-settlement",
        });
        if (new Decimal(composition.duePenalties).gt(0)) adjustments.push({
            loanId: oldLoan.id,
            adjustmentType: "due_penalty_settlement",
            amount: composition.duePenalties,
            suffix: "due-penalty-settlement",
        });
        for (const line of composition.adjustments) adjustments.push({
            loanId: oldLoan.id,
            adjustmentType: `manual_${line.kind}`,
            amount: line.amount,
            suffix: `manual-${line.lineNo}-${line.kind}`,
            reason: line.reason,
        });
        if (new Decimal(renewal.cashAmount).gt(0) && renewal.cashDirection !== "none") adjustments.push({
            loanId: renewal.cashDirection === "payout" ? newLoan.id : oldLoan.id,
            adjustmentType: renewal.cashDirection === "payout" ? "cash_payout" : "cash_collection",
            amount: serializeMoney(renewal.cashAmount),
            suffix: renewal.cashDirection === "payout" ? "cash-payout" : "cash-collection",
        });
        if (adjustments.length) {
            await tx.insert(loanAdjustments).values(adjustments.map((adjustment) => ({
                tenantId: ctx.tenantId,
                loanId: adjustment.loanId,
                renewalId: renewal.id,
                adjustmentType: adjustment.adjustmentType,
                amount: adjustment.amount,
                status: "posted",
                idempotencyKey: `renewal:${idempotencyKey}:${adjustment.suffix}`,
                reason: adjustment.reason ?? reason,
                effectiveAt,
                createdByUserId: ctx.actorUserId,
                updatedByUserId: ctx.actorUserId,
            })));
        }
        const settlementPrincipal = new Decimal(snapshot.outstandingPrincipal);
        const settlementInterest = new Decimal(composition.settlementPolicy === "full_contract_interest"
            ? composition.remainingContractInterest
            : composition.accruedDueInterest);
        const settlementFee = new Decimal(composition.dueFees);
        const settlementPenalty = new Decimal(composition.duePenalties);
        const renewalSettlementAmount = settlementPrincipal.plus(settlementAmount);
        if (renewalSettlementAmount.gt(0)) {
            await tx.insert(transactions).values({
                tenantId: ctx.tenantId,
                ownerUserId: oldLoan.ownerUserId ?? ctx.actorUserId,
                loanId: oldLoan.id,
                amount: renewalSettlementAmount.toFixed(2),
                principalComponent: settlementPrincipal.toFixed(2),
                interestComponent: settlementInterest.toFixed(2),
                feeComponent: settlementFee.toFixed(2),
                penaltyComponent: settlementPenalty.toFixed(2),
                type: "close_account",
                transactionDate: businessDateAsOf(renewalDate),
                notes: "Renewal settlement — final installment paid from renewal proceeds",
                recordedByUserId: ctx.actorUserId,
                entryType: "repayment",
                idempotencyKey: `renewal:${idempotencyKey}:settlement`,
                postedAt: effectiveAt,
                createdAt: effectiveAt,
                updatedAt: effectiveAt,
            });
        }
        await tx.update(loans).set({ status: "renewed", updatedAt: effectiveAt }).where(and(
            eq(loans.id, oldLoan.id), eq(loans.tenantId, ctx.tenantId),
        ));
        const executed = await tx.update(loanRenewals).set({
            newLoanId: newLoan.id,
            status: "executed",
            reason,
            idempotencyKey,
            preExecutionLoanState: {
                status: oldLoan.status ?? "active",
                outstandingPrincipal: serializeMoney(oldLoan.outstandingPrincipal ?? "0.00"),
                outstandingInterest: serializeMoney(oldLoan.outstandingInterest ?? "0.00"),
                outstandingFees: serializeMoney(oldLoan.outstandingFees ?? "0.00"),
                nextDueDate: oldLoan.nextDueDate ?? null,
            },
            executedAt: effectiveAt,
            executedByUserId: ctx.actorUserId,
            updatedByUserId: ctx.actorUserId,
            updatedAt: effectiveAt,
        }).where(and(eq(loanRenewals.id, renewal.id), eq(loanRenewals.tenantId, ctx.tenantId)))
            .returning().then((rows) => rows[0]!);
        await createAuditLog(tx, {
            ...auditContext(ctx),
            entityType: "loan_renewal",
            entityId: renewal.publicId,
            action: "executed",
            payload: {
                oldLoanPublicId: oldLoan.publicId,
                newLoanPublicId: newLoan.publicId,
                principalPaid: serializeMoney(snapshot.principalPaid),
                outstandingPrincipal: serializeMoney(snapshot.outstandingPrincipal),
                requestedPrincipal: serializeMoney(requestedPrincipal),
                dueCharges: serializeMoney(snapshot.dueCharges),
                settlementPolicy: composition.settlementPolicy,
                composition,
                settlementAmount: serializeMoney(settlementAmount),
                waivedCharges: serializeMoney(renewal.waivedCharges),
                cashDirection: renewal.cashDirection,
                cashAmount: serializeMoney(renewal.cashAmount),
                reason,
            },
        });
        return { value: await presentExecution(tx, executed, oldLoan) };
    });
    if ("stale" in result) {
        throw new DomainError("STALE_RENEWAL_PREVIEW", "Renewal preview has expired or no longer matches current balances", 409);
    }
    await invalidateTenantCache(ctx.tenantId);
    return result.value;
}

export interface ReverseLoanRenewalInput {
    reason: string;
}

export async function reverseLoanRenewal(
    ctx: CommandContext,
    renewalPublicId: string,
    input: ReverseLoanRenewalInput,
) {
    const reason = input.reason?.trim();
    if (!reason) throw new DomainError("REVERSAL_REASON_REQUIRED", "Renewal reversal requires a reason", 400);
    const idempotencyKey = ctx.idempotencyKey?.trim();
    if (!idempotencyKey) {
        throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", "Renewal reversal requires a non-blank Idempotency-Key", 400);
    }
    const accessible = await accessibleRenewal(ctx, renewalPublicId);
    const reversalRequestHash = createHash("sha256").update(JSON.stringify({
        contract: "loan-renewal-reversal",
        version: "v1",
        renewalPublicId,
        reason,
    })).digest("hex");
    const result = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(
            ${`loan-renewal-reverse:${ctx.tenantId}:${idempotencyKey}`}, 0
        ))`);
        const reusedReversalKey = await tx.query.loanRenewals.findFirst({ where: and(
            eq(loanRenewals.tenantId, ctx.tenantId),
            eq(loanRenewals.reversalIdempotencyKey, idempotencyKey),
        ) });
        if (reusedReversalKey && reusedReversalKey.id !== accessible.renewal.id) {
            throw new DomainError("REVERSAL_IDEMPOTENCY_CONFLICT", "Idempotency-Key was already used for another renewal reversal", 409);
        }
        await tx.execute(sql`SELECT id FROM loans WHERE tenant_id = ${ctx.tenantId}
            AND id = ${accessible.oldLoan.id} FOR UPDATE`);
        await tx.execute(sql`SELECT id FROM loan_renewals WHERE tenant_id = ${ctx.tenantId}
            AND id = ${accessible.renewal.id} FOR UPDATE`);
        const locked = await accessibleRenewal(ctx, renewalPublicId, tx);
        const renewal = locked.renewal;
        const oldLoan = locked.oldLoan;
        if (renewal.status === "reversed") {
            if (renewal.reversalIdempotencyKey === idempotencyKey
                && renewal.reversalRequestHash === reversalRequestHash) {
                return presentExecution(tx, renewal, oldLoan);
            }
            throw new DomainError(
                "REVERSAL_IDEMPOTENCY_CONFLICT",
                "Renewal reversal was already completed with a different idempotency key or payload",
                409,
            );
        }
        if (renewal.status !== "executed" || renewal.newLoanId === null) {
            throw new DomainError("RENEWAL_NOT_REVERSIBLE", "Only an executed renewal can be reversed", 409);
        }
        await tx.execute(sql`SELECT id FROM loans WHERE tenant_id = ${ctx.tenantId}
            AND id = ${renewal.newLoanId} FOR UPDATE`);
        const newLoan = await tx.query.loans.findFirst({ where: and(
            eq(loans.tenantId, ctx.tenantId), eq(loans.id, renewal.newLoanId),
        ) });
        if (!newLoan) throw new DomainError("RENEWAL_NOT_REVERSIBLE", "Replacement loan no longer exists", 409);
        const downstreamTransactions = await tx.select().from(transactions).where(and(
            eq(transactions.tenantId, ctx.tenantId), eq(transactions.loanId, newLoan.id),
        ));
        const activeDownstream = activeRepayments(downstreamTransactions);
        const downstreamAdjustments = (await tx.select().from(loanAdjustments).where(and(
            eq(loanAdjustments.tenantId, ctx.tenantId),
            eq(loanAdjustments.loanId, newLoan.id),
            eq(loanAdjustments.status, "posted"),
        ))).filter((row: typeof loanAdjustments.$inferSelect) => row.renewalId !== renewal.id);
        const replacementFunding = await tx.select().from(loanFundingAllocations).where(and(
            eq(loanFundingAllocations.tenantId, ctx.tenantId),
            eq(loanFundingAllocations.loanId, newLoan.id),
        )).orderBy(loanFundingAllocations.id);
        const carriedFunding = replacementFunding.filter((row: typeof loanFundingAllocations.$inferSelect) =>
            row.renewalId === renewal.id
            && row.allocationType === "reallocation_in"
            && row.reversedAllocationId === null);
        const downstreamFunding = replacementFunding.filter((row: typeof loanFundingAllocations.$inferSelect) =>
            row.renewalId !== renewal.id);
        const downstreamFundingBalance = new Map<string, Decimal>();
        for (const row of downstreamFunding) {
            const key = `${row.bankProfileId ?? "none"}:${row.bankLoanId ?? "none"}`;
            downstreamFundingBalance.set(
                key,
                (downstreamFundingBalance.get(key) ?? new Decimal(0)).plus(row.allocatedAmount),
            );
        }
        const nonZeroFundingSources = [...downstreamFundingBalance.values()].filter((amount) => !amount.isZero());
        if (activeDownstream.length > 0 || downstreamAdjustments.length > 0 || nonZeroFundingSources.length > 0) {
            throw new DomainError("RENEWAL_REVERSE_BLOCKED", "Reverse downstream replacement-loan entries first", 409, {
                downstreamEntryCount: activeDownstream.length + downstreamAdjustments.length + nonZeroFundingSources.length,
            });
        }
        const originalAdjustments = await tx.select().from(loanAdjustments).where(and(
            eq(loanAdjustments.tenantId, ctx.tenantId),
            eq(loanAdjustments.renewalId, renewal.id),
            eq(loanAdjustments.status, "posted"),
        )).orderBy(loanAdjustments.id);
        const oldCarryFunding = await tx.select().from(loanFundingAllocations).where(and(
            eq(loanFundingAllocations.tenantId, ctx.tenantId),
            eq(loanFundingAllocations.loanId, oldLoan.id),
            eq(loanFundingAllocations.renewalId, renewal.id),
        )).orderBy(loanFundingAllocations.id);
        const effectiveAt = new Date();
        for (const original of originalAdjustments) {
            if (original.adjustmentType === "reversal") continue;
            await tx.insert(loanAdjustments).values({
                tenantId: ctx.tenantId,
                loanId: original.loanId,
                renewalId: renewal.id,
                adjustmentType: "reversal",
                amount: new Decimal(original.amount).negated().toFixed(2),
                status: "posted",
                idempotencyKey: `renewal-reversal:${renewal.publicId}:${original.publicId}`,
                reversedAdjustmentId: original.id,
                reason,
                effectiveAt,
                createdByUserId: ctx.actorUserId,
                updatedByUserId: ctx.actorUserId,
            });
            await tx.update(loanAdjustments).set({
                status: "reversed", updatedByUserId: ctx.actorUserId, updatedAt: effectiveAt,
            }).where(and(eq(loanAdjustments.id, original.id), eq(loanAdjustments.tenantId, ctx.tenantId)));
        }
        const renewalSettlement = renewal.idempotencyKey
            ? await tx.query.transactions.findFirst({ where: and(
                eq(transactions.tenantId, ctx.tenantId),
                eq(transactions.loanId, oldLoan.id),
                eq(transactions.idempotencyKey, `renewal:${renewal.idempotencyKey}:settlement`),
                eq(transactions.entryType, "repayment"),
            ) })
            : null;
        if (renewalSettlement) {
            await tx.insert(transactions).values({
                tenantId: ctx.tenantId,
                ownerUserId: renewalSettlement.ownerUserId,
                loanId: oldLoan.id,
                amount: new Decimal(renewalSettlement.amount).negated().toFixed(2),
                principalComponent: new Decimal(renewalSettlement.principalComponent).negated().toFixed(2),
                interestComponent: new Decimal(renewalSettlement.interestComponent).negated().toFixed(2),
                feeComponent: new Decimal(renewalSettlement.feeComponent).negated().toFixed(2),
                penaltyComponent: new Decimal(renewalSettlement.penaltyComponent).negated().toFixed(2),
                type: "close_account",
                transactionDate: effectiveAt,
                notes: reason,
                recordedByUserId: ctx.actorUserId,
                entryType: "reversal",
                reversedTransactionId: renewalSettlement.id,
                idempotencyKey: `renewal-reversal:${idempotencyKey}:settlement`,
                postedAt: effectiveAt,
                createdAt: effectiveAt,
                updatedAt: effectiveAt,
            });
        }
        const originalManualLines = await tx.select().from(loanRenewalAdjustmentLines).where(and(
            eq(loanRenewalAdjustmentLines.tenantId, ctx.tenantId),
            eq(loanRenewalAdjustmentLines.renewalId, renewal.id),
            eq(loanRenewalAdjustmentLines.status, "posted"),
        )).orderBy(loanRenewalAdjustmentLines.lineNo);
        if (originalManualLines.length > 0) {
            const manualReversalAudit = await createAuditLog(tx, {
                ...auditContext(ctx),
                entityType: "loan_renewal_adjustment_lines",
                entityId: renewal.publicId,
                action: "reversed",
                payload: { renewalPublicId: renewal.publicId, reason, lineCount: originalManualLines.length },
            });
            const firstReversalLineNo = originalManualLines.at(-1)!.lineNo + 1;
            await tx.insert(loanRenewalAdjustmentLines).values(originalManualLines.map((line, index) => ({
                tenantId: ctx.tenantId,
                renewalId: renewal.id,
                lineNo: firstReversalLineNo + index,
                kind: line.kind,
                amount: line.amount,
                reason,
                status: "reversed" as const,
                reversesLineId: line.id,
                actorSource: ctx.actorSource,
                requestId: ctx.requestId,
                correlationId: ctx.correlationId,
                idempotencyKey: `renewal-reversal:${idempotencyKey}:manual-line:${line.lineNo}`,
                auditPublicId: manualReversalAudit.publicId,
                createdByUserId: ctx.actorUserId,
            })));
        }
        const reversalDate = effectiveAt.toISOString().slice(0, 10);
        for (const carried of carriedFunding) {
            const transferred = oldCarryFunding.find((row) =>
                row.allocationType === "reallocation_out"
                && row.allocationGroupId === carried.allocationGroupId
                && row.bankProfileId === carried.bankProfileId
                && row.bankLoanId === carried.bankLoanId
                && row.reversedAllocationId === null);
            if (!transferred) {
                throw new DomainError("RENEWAL_FUNDING_PROVENANCE_INVALID", "Renewal funding provenance is incomplete", 409);
            }
            await tx.insert(loanFundingAllocations).values([{
                tenantId: ctx.tenantId,
                bankProfileId: carried.bankProfileId,
                bankLoanId: carried.bankLoanId,
                loanId: newLoan.id,
                allocatedAmount: new Decimal(carried.allocatedAmount).negated().toFixed(2),
                allocationDate: reversalDate,
                allocationType: "reallocation_out",
                renewalId: renewal.id,
                allocationGroupId: carried.allocationGroupId,
                reversedAllocationId: carried.id,
                note: `Reversed renewal ${renewal.publicId}`,
                createdByUserId: ctx.actorUserId,
            }, {
                tenantId: ctx.tenantId,
                bankProfileId: carried.bankProfileId,
                bankLoanId: carried.bankLoanId,
                loanId: oldLoan.id,
                allocatedAmount: new Decimal(carried.allocatedAmount).toFixed(2),
                allocationDate: reversalDate,
                allocationType: "reallocation_in",
                renewalId: renewal.id,
                allocationGroupId: transferred.allocationGroupId,
                reversedAllocationId: transferred.id,
                note: `Restored from reversed renewal ${renewal.publicId}`,
                createdByUserId: ctx.actorUserId,
            }]);
        }
        const priorState = renewal.preExecutionLoanState;
        if (!priorState) {
            throw new DomainError("RENEWAL_STATE_UNAVAILABLE", "Pre-execution loan state is unavailable", 409);
        }
        await tx.update(loans).set({
            status: priorState.status,
            outstandingPrincipal: priorState.outstandingPrincipal,
            outstandingInterest: priorState.outstandingInterest,
            outstandingFees: priorState.outstandingFees,
            nextDueDate: priorState.nextDueDate,
            updatedAt: effectiveAt,
        }).where(and(
            eq(loans.id, oldLoan.id), eq(loans.tenantId, ctx.tenantId),
        ));
        await tx.update(loans).set({ status: "canceled", updatedAt: effectiveAt }).where(and(
            eq(loans.id, newLoan.id), eq(loans.tenantId, ctx.tenantId),
        ));
        const reversed = await tx.update(loanRenewals).set({
            status: "reversed",
            reason,
            reversalIdempotencyKey: idempotencyKey,
            reversalRequestHash,
            reversedAt: effectiveAt,
            reversedByUserId: ctx.actorUserId,
            updatedByUserId: ctx.actorUserId,
            updatedAt: effectiveAt,
        }).where(and(eq(loanRenewals.id, renewal.id), eq(loanRenewals.tenantId, ctx.tenantId)))
            .returning().then((rows) => rows[0]!);
        await createAuditLog(tx, {
            ...auditContext(ctx),
            entityType: "loan_renewal",
            entityId: renewal.publicId,
            action: "reversed",
            payload: {
                oldLoanPublicId: oldLoan.publicId,
                newLoanPublicId: newLoan.publicId,
                restoredOldStatus: priorState.status,
                canceledNewLoanStatus: "canceled",
                adjustmentReversalCount: originalAdjustments.length,
                fundingCompensationCount: carriedFunding.length * 2,
                reason,
                idempotencyKey,
            },
        });
        return presentExecution(tx, reversed, oldLoan);
    });
    await invalidateTenantCache(ctx.tenantId);
    return result;
}
