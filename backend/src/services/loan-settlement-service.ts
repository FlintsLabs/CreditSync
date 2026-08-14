import { createHash } from "node:crypto";
import type Decimal from "decimal.js";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import {
    auditLogs,
    loanDisbursements,
    loanInterestAccruals,
    loans,
    loanSettlementPreviews,
    transactions,
    users,
} from "../db/schema";
import { canAccessTenantWideData } from "../lib/access";
import { createAuditLog } from "../lib/audit-log";
import { invalidateTenantCache } from "../lib/cache";
import { FinancialDecimal } from "../lib/financial-decimal";
import { serializeMoney } from "../lib/money";
import type { CommandContext } from "./command-context";
import { DomainError } from "./domain-error";
import {
    accrueFloatingInterestThrough,
    isFloatingAccrualPayableThrough,
} from "./floating-interest-service";
import { writeFundEffects } from "./payment-service";

type Executor = any;
type LoanRow = typeof loans.$inferSelect;
type SettlementRow = typeof loanSettlementPreviews.$inferSelect;
type TransactionRow = typeof transactions.$inferSelect;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const businessDatePattern = /^\d{4}-\d{2}-\d{2}$/;
const previewHashPattern = /^v1:[0-9a-f]{64}$/i;
const hashVersion = "v1";
const previewTtlMilliseconds = 15 * 60 * 1000;

interface SettlementSnapshot {
    outstandingPrincipal: Decimal;
    dueInterest: Decimal;
    accruedNotDueInterest: Decimal;
    outstandingFees: Decimal;
    outstandingPenalties: Decimal;
    nonRefundableAdvanceInterest: Decimal;
    settlementTotal: Decimal;
    balanceVersion: string;
}

export interface ExecuteLoanSettlementInput {
    settlementPublicId: string;
    previewHash: string;
    confirmed: boolean;
    reason: string;
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

function versionedHash(value: unknown) {
    return `${hashVersion}:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function requirePublicId(value: string, field: string) {
    if (!uuidPattern.test(value)) {
        throw new DomainError("INVALID_PUBLIC_ID", `${field} must be a UUID`, 400, { field });
    }
}

function parseAsOfDate(value: string) {
    if (!businessDatePattern.test(value)) {
        throw new DomainError("INVALID_SETTLEMENT_DATE", "asOfDate must be a Bangkok YYYY-MM-DD date", 400);
    }
    const date = new Date(`${value}T12:00:00+07:00`);
    const normalized = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Bangkok",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).format(date);
    if (Number.isNaN(date.getTime()) || normalized !== value) {
        throw new DomainError("INVALID_SETTLEMENT_DATE", "asOfDate must be a Bangkok YYYY-MM-DD date", 400);
    }
    return date;
}

async function actorFor(ctx: CommandContext, executor: Executor = db) {
    if (ctx.actorUserId === null) return null;
    const actor = await executor.query.users.findFirst({
        where: and(eq(users.tenantId, ctx.tenantId), eq(users.id, ctx.actorUserId)),
    });
    if (!actor) throw new DomainError("ACTOR_NOT_FOUND", "Actor is not available in this tenant", 403);
    return actor;
}

async function accessibleLoan(ctx: CommandContext, loanPublicId: string, executor: Executor = db) {
    requirePublicId(loanPublicId, "loanPublicId");
    const [actor, loan] = await Promise.all([
        actorFor(ctx, executor),
        executor.query.loans.findFirst({ where: and(
            eq(loans.tenantId, ctx.tenantId),
            eq(loans.publicId, loanPublicId),
        ) }),
    ]);
    if (!loan || (actor && !canAccessTenantWideData({ role: actor.role ?? "viewer" }) && loan.ownerUserId !== actor.id)) {
        throw new DomainError("LOAN_NOT_FOUND", "Loan not found", 404);
    }
    return loan as LoanRow;
}

async function accessibleSettlement(
    ctx: CommandContext,
    settlementPublicId: string,
    executor: Executor = db,
) {
    requirePublicId(settlementPublicId, "settlementPublicId");
    const settlement = await executor.query.loanSettlementPreviews.findFirst({ where: and(
        eq(loanSettlementPreviews.tenantId, ctx.tenantId),
        eq(loanSettlementPreviews.publicId, settlementPublicId),
    ) });
    if (!settlement) throw new DomainError("SETTLEMENT_NOT_FOUND", "Loan settlement not found", 404);
    const loan = await executor.query.loans.findFirst({ where: and(
        eq(loans.tenantId, ctx.tenantId),
        eq(loans.id, settlement.loanId),
    ) });
    const actor = await actorFor(ctx, executor);
    if (!loan || (actor && !canAccessTenantWideData({ role: actor.role ?? "viewer" }) && loan.ownerUserId !== actor.id)) {
        throw new DomainError("SETTLEMENT_NOT_FOUND", "Loan settlement not found", 404);
    }
    return { settlement: settlement as SettlementRow, loan: loan as LoanRow };
}

function money(value: Decimal.Value) {
    return new FinancialDecimal(value).toDecimalPlaces(2, FinancialDecimal.ROUND_HALF_UP);
}

async function settlementSnapshot(
    tx: Executor,
    ctx: CommandContext,
    loan: LoanRow,
    asOfDate: string,
): Promise<SettlementSnapshot> {
    const through = parseAsOfDate(asOfDate);
    await accrueFloatingInterestThrough(tx, loan, through, ctx);
    const [accrualRows, transactionRows, disbursementRows] = await Promise.all([
        tx.select().from(loanInterestAccruals).where(and(
            eq(loanInterestAccruals.tenantId, ctx.tenantId),
            eq(loanInterestAccruals.loanId, loan.id),
            sql`${loanInterestAccruals.status} <> 'reversed'`,
        )).orderBy(asc(loanInterestAccruals.accrualDate), asc(loanInterestAccruals.id)),
        tx.select().from(transactions).where(and(
            eq(transactions.tenantId, ctx.tenantId),
            eq(transactions.loanId, loan.id),
        )).orderBy(asc(transactions.id)),
        tx.select().from(loanDisbursements).where(and(
            eq(loanDisbursements.tenantId, ctx.tenantId),
            eq(loanDisbursements.loanId, loan.id),
        )).orderBy(asc(loanDisbursements.id)),
    ]);
    let dueInterest = new FinancialDecimal(0);
    let accruedNotDueInterest = new FinancialDecimal(0);
    for (const row of accrualRows) {
        if (row.accrualDate > asOfDate) continue;
        const unpaid = FinancialDecimal.max(0, new FinancialDecimal(row.interestAmount).minus(row.paidAmount));
        if (unpaid.isZero()) continue;
        if (isFloatingAccrualPayableThrough(row, asOfDate)) dueInterest = dueInterest.plus(unpaid);
        else accruedNotDueInterest = accruedNotDueInterest.plus(unpaid);
    }
    const outstandingPrincipal = money(loan.outstandingPrincipal ?? loan.principalAmount);
    const outstandingFees = money(loan.outstandingFees ?? "0.00");
    const outstandingPenalties = new FinancialDecimal(0);
    const nonRefundableAdvanceInterest = disbursementRows.reduce(
        (sum: Decimal, row: typeof loanDisbursements.$inferSelect) => sum.plus(row.firstDayInterestDeducted),
        new FinancialDecimal(0),
    ).toDecimalPlaces(2, FinancialDecimal.ROUND_HALF_UP);
    dueInterest = money(dueInterest);
    accruedNotDueInterest = money(accruedNotDueInterest);
    const settlementTotal = outstandingPrincipal.plus(dueInterest).plus(accruedNotDueInterest)
        .plus(outstandingFees).plus(outstandingPenalties).toDecimalPlaces(2, FinancialDecimal.ROUND_HALF_UP);
    const balanceVersion = versionedHash({
        contract: "loan-settlement-balance",
        version: hashVersion,
        asOfDate,
        loan: {
            publicId: loan.publicId,
            status: loan.status,
            outstandingPrincipal: outstandingPrincipal.toFixed(2),
            outstandingInterest: money(loan.outstandingInterest ?? "0.00").toFixed(2),
            outstandingFees: outstandingFees.toFixed(2),
            updatedAt: loan.updatedAt?.toISOString() ?? null,
        },
        accruals: accrualRows.map((row: typeof loanInterestAccruals.$inferSelect) => ({
            publicId: row.publicId,
            accrualDate: row.accrualDate,
            interestAmount: money(row.interestAmount).toFixed(2),
            paidAmount: money(row.paidAmount).toFixed(2),
            status: row.status,
            reversedAccrualId: row.reversedAccrualId,
        })),
        transactions: transactionRows.map((row: TransactionRow) => ({
            publicId: row.publicId,
            amount: money(row.amount).toFixed(2),
            principalComponent: money(row.principalComponent).toFixed(2),
            interestComponent: money(row.interestComponent).toFixed(2),
            feeComponent: money(row.feeComponent).toFixed(2),
            penaltyComponent: money(row.penaltyComponent).toFixed(2),
            entryType: row.entryType,
            reversedTransactionId: row.reversedTransactionId,
        })),
    });
    return {
        outstandingPrincipal,
        dueInterest,
        accruedNotDueInterest,
        outstandingFees,
        outstandingPenalties,
        nonRefundableAdvanceInterest,
        settlementTotal,
        balanceVersion,
    };
}

function settlementPreviewHash(asOfDate: string, snapshot: SettlementSnapshot) {
    return versionedHash({
        contract: "loan-settlement-preview",
        version: hashVersion,
        asOfDate,
        outstandingPrincipal: snapshot.outstandingPrincipal.toFixed(2),
        dueInterest: snapshot.dueInterest.toFixed(2),
        accruedNotDueInterest: snapshot.accruedNotDueInterest.toFixed(2),
        outstandingFees: snapshot.outstandingFees.toFixed(2),
        outstandingPenalties: snapshot.outstandingPenalties.toFixed(2),
        nonRefundableAdvanceInterest: snapshot.nonRefundableAdvanceInterest.toFixed(2),
        settlementTotal: snapshot.settlementTotal.toFixed(2),
        balanceVersion: snapshot.balanceVersion,
    });
}

function presentPreview(row: SettlementRow, loan: LoanRow) {
    return {
        id: row.publicId,
        publicId: row.publicId,
        loanPublicId: loan.publicId,
        status: row.status,
        asOfDate: row.asOfDate,
        outstandingPrincipal: serializeMoney(row.outstandingPrincipal),
        dueInterest: serializeMoney(row.dueInterest),
        accruedNotDueInterest: serializeMoney(row.accruedNotDueInterest),
        outstandingFees: serializeMoney(row.outstandingFees),
        outstandingPenalties: serializeMoney(row.outstandingPenalties),
        nonRefundableAdvanceInterest: serializeMoney(row.nonRefundableAdvanceInterest),
        settlementTotal: serializeMoney(row.settlementTotal),
        balanceVersion: row.balanceVersion,
        previewHash: row.previewHash,
        hashVersion,
        expiresAt: row.expiresAt,
        executedAt: row.executedAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
}

export async function previewLoanSettlement(
    ctx: CommandContext,
    loanPublicId: string,
    asOfDate: string,
) {
    parseAsOfDate(asOfDate);
    const accessible = await accessibleLoan(ctx, loanPublicId);
    return db.transaction(async (tx) => {
        await tx.execute(sql`SELECT id FROM loans
            WHERE tenant_id = ${ctx.tenantId} AND id = ${accessible.id} FOR UPDATE`);
        const loan = await accessibleLoan(ctx, loanPublicId, tx);
        if (loan.repaymentType !== "floating" || loan.status !== "active") {
            throw new DomainError("LOAN_NOT_SETTLEABLE", "Only an active floating loan can be settled", 409);
        }
        if (loan.interestPeriodAnchorDate && asOfDate < loan.interestPeriodAnchorDate) {
            throw new DomainError("INVALID_SETTLEMENT_DATE", "asOfDate cannot precede the floating interest anchor", 400);
        }
        const snapshot = await settlementSnapshot(tx, ctx, loan, asOfDate);
        const previewHash = settlementPreviewHash(asOfDate, snapshot);
        const createdAt = new Date();
        await tx.update(loanSettlementPreviews).set({
            status: "expired",
            updatedAt: createdAt,
        }).where(and(
            eq(loanSettlementPreviews.tenantId, ctx.tenantId),
            eq(loanSettlementPreviews.loanId, loan.id),
            eq(loanSettlementPreviews.status, "ready"),
        ));
        const row = await tx.insert(loanSettlementPreviews).values({
            tenantId: ctx.tenantId,
            loanId: loan.id,
            asOfDate,
            outstandingPrincipal: snapshot.outstandingPrincipal.toFixed(2),
            dueInterest: snapshot.dueInterest.toFixed(2),
            accruedNotDueInterest: snapshot.accruedNotDueInterest.toFixed(2),
            outstandingFees: snapshot.outstandingFees.toFixed(2),
            outstandingPenalties: snapshot.outstandingPenalties.toFixed(2),
            nonRefundableAdvanceInterest: snapshot.nonRefundableAdvanceInterest.toFixed(2),
            settlementTotal: snapshot.settlementTotal.toFixed(2),
            balanceVersion: snapshot.balanceVersion,
            previewHash,
            status: "ready",
            expiresAt: new Date(createdAt.getTime() + previewTtlMilliseconds),
            createdByUserId: ctx.actorUserId,
            createdAt,
            updatedAt: createdAt,
        }).returning().then((rows: SettlementRow[]) => rows[0]!);
        await createAuditLog(tx, {
            ...auditContext(ctx),
            entityType: "loan_settlement",
            entityId: row.publicId,
            action: "previewed",
            payload: {
                loanPublicId: loan.publicId,
                asOfDate,
                outstandingPrincipal: row.outstandingPrincipal,
                dueInterest: row.dueInterest,
                accruedNotDueInterest: row.accruedNotDueInterest,
                outstandingFees: row.outstandingFees,
                outstandingPenalties: row.outstandingPenalties,
                nonRefundableAdvanceInterest: row.nonRefundableAdvanceInterest,
                settlementTotal: row.settlementTotal,
                balanceVersion: row.balanceVersion,
                previewHash: row.previewHash,
                expiresAt: row.expiresAt.toISOString(),
            },
        });
        return presentPreview(row, loan);
    });
}

function requireExecution(ctx: CommandContext, input: ExecuteLoanSettlementInput) {
    if (input.confirmed !== true) {
        throw new DomainError("SETTLEMENT_CONFIRMATION_REQUIRED", "Settlement execution requires explicit confirmation", 400);
    }
    const reason = input.reason?.trim();
    if (!reason) throw new DomainError("SETTLEMENT_REASON_REQUIRED", "Settlement execution requires a reason", 400);
    const idempotencyKey = ctx.idempotencyKey?.trim();
    if (!idempotencyKey) {
        throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", "Settlement execution requires a non-blank Idempotency-Key", 400);
    }
    if (!previewHashPattern.test(input.previewHash)) {
        throw new DomainError("INVALID_PREVIEW_HASH", "previewHash must be a versioned SHA-256 hash", 400);
    }
    return { reason, idempotencyKey };
}

function presentTransaction(row: TransactionRow) {
    return {
        id: row.publicId,
        publicId: row.publicId,
        amount: serializeMoney(row.amount),
        principalComponent: serializeMoney(row.principalComponent),
        interestComponent: serializeMoney(row.interestComponent),
        feeComponent: serializeMoney(row.feeComponent),
        penaltyComponent: serializeMoney(row.penaltyComponent),
        type: row.type,
        entryType: row.entryType,
        transactionDate: row.transactionDate,
        postedAt: row.postedAt,
    };
}

async function presentExecution(
    tx: Executor,
    ctx: CommandContext,
    settlement: SettlementRow,
    loan: LoanRow,
) {
    const transaction = settlement.executeIdempotencyKey
        ? await tx.query.transactions.findFirst({ where: and(
            eq(transactions.tenantId, ctx.tenantId),
            eq(transactions.idempotencyKey, `loan-settlement:${settlement.executeIdempotencyKey}`),
        ) })
        : null;
    const audit = settlement.executedAuditPublicId
        ? await tx.query.auditLogs.findFirst({ where: and(
            eq(auditLogs.tenantId, ctx.tenantId),
            eq(auditLogs.publicId, settlement.executedAuditPublicId),
        ) })
        : null;
    if (!transaction || !audit) {
        throw new DomainError("SETTLEMENT_EXECUTION_INCOMPLETE", "Settlement execution record is incomplete", 409);
    }
    return {
        ...presentPreview(settlement, loan),
        status: settlement.status,
        transaction: presentTransaction(transaction),
        reason: transaction.notes,
        auditPublicId: settlement.executedAuditPublicId,
        correlationId: audit.correlationId,
    };
}

function sameStoredAmounts(row: SettlementRow, snapshot: SettlementSnapshot) {
    return new FinancialDecimal(row.outstandingPrincipal).eq(snapshot.outstandingPrincipal)
        && new FinancialDecimal(row.dueInterest).eq(snapshot.dueInterest)
        && new FinancialDecimal(row.accruedNotDueInterest).eq(snapshot.accruedNotDueInterest)
        && new FinancialDecimal(row.outstandingFees).eq(snapshot.outstandingFees)
        && new FinancialDecimal(row.outstandingPenalties).eq(snapshot.outstandingPenalties)
        && new FinancialDecimal(row.nonRefundableAdvanceInterest).eq(snapshot.nonRefundableAdvanceInterest)
        && new FinancialDecimal(row.settlementTotal).eq(snapshot.settlementTotal);
}

async function hasLaterActiveAccruals(tx: Executor, tenantId: string, loanId: number, asOfDate: string) {
    const rows = await tx.select({ id: loanInterestAccruals.id }).from(loanInterestAccruals).where(and(
        eq(loanInterestAccruals.tenantId, tenantId),
        eq(loanInterestAccruals.loanId, loanId),
        inArray(loanInterestAccruals.status, ["accrued", "accruing", "due", "partially_paid"]),
        sql`${loanInterestAccruals.accrualDate} > ${asOfDate}`,
    )).limit(1);
    return rows.length > 0;
}

export async function executeLoanSettlement(ctx: CommandContext, input: ExecuteLoanSettlementInput) {
    const { reason, idempotencyKey } = requireExecution(ctx, input);
    const accessible = await accessibleSettlement(ctx, input.settlementPublicId);
    const result = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(
            ${`loan-settlement-execute:${ctx.tenantId}:${idempotencyKey}`}, 0
        ))`);
        const reusedKey = await tx.query.loanSettlementPreviews.findFirst({ where: and(
            eq(loanSettlementPreviews.tenantId, ctx.tenantId),
            eq(loanSettlementPreviews.executeIdempotencyKey, idempotencyKey),
        ) });
        if (reusedKey && reusedKey.id !== accessible.settlement.id) {
            throw new DomainError("IDEMPOTENCY_KEY_CONFLICT", "Idempotency-Key was already used for another settlement", 409);
        }
        await tx.execute(sql`SELECT id FROM loans
            WHERE tenant_id = ${ctx.tenantId} AND id = ${accessible.loan.id} FOR UPDATE`);
        await tx.execute(sql`SELECT id FROM loan_settlement_previews
            WHERE tenant_id = ${ctx.tenantId} AND id = ${accessible.settlement.id} FOR UPDATE`);
        const locked = await accessibleSettlement(ctx, input.settlementPublicId, tx);
        const settlement = locked.settlement;
        const loan = locked.loan;
        if (settlement.status === "executed") {
            if (settlement.executeIdempotencyKey === idempotencyKey) {
                const replay = await presentExecution(tx, ctx, settlement, loan);
                if (replay.reason === reason && settlement.previewHash === input.previewHash) return { value: replay };
            }
            throw new DomainError("SETTLEMENT_ALREADY_EXECUTED", "Loan settlement has already been executed", 409);
        }
        const executedAt = new Date();
        if (settlement.status !== "ready"
            || settlement.expiresAt.getTime() <= executedAt.getTime()
            || settlement.previewHash !== input.previewHash) {
            if (settlement.status === "ready") {
                await tx.update(loanSettlementPreviews).set({ status: "expired", updatedAt: executedAt }).where(and(
                    eq(loanSettlementPreviews.tenantId, ctx.tenantId),
                    eq(loanSettlementPreviews.id, settlement.id),
                ));
            }
            return { stale: true as const };
        }
        if (loan.repaymentType !== "floating" || loan.status !== "active") {
            return { stale: true as const };
        }
        const snapshot = await settlementSnapshot(tx, ctx, loan, settlement.asOfDate);
        if (await hasLaterActiveAccruals(tx, ctx.tenantId, loan.id, settlement.asOfDate)) {
            return { stale: true as const };
        }
        const currentPreviewHash = settlementPreviewHash(settlement.asOfDate, snapshot);
        if (snapshot.balanceVersion !== settlement.balanceVersion
            || currentPreviewHash !== settlement.previewHash
            || !sameStoredAmounts(settlement, snapshot)) {
            await tx.update(loanSettlementPreviews).set({ status: "expired", updatedAt: executedAt }).where(and(
                eq(loanSettlementPreviews.tenantId, ctx.tenantId),
                eq(loanSettlementPreviews.id, settlement.id),
            ));
            return { stale: true as const };
        }

        const interestComponent = snapshot.dueInterest.plus(snapshot.accruedNotDueInterest).toDecimalPlaces(2);
        const transactionDate = parseAsOfDate(settlement.asOfDate);
        const transaction = await tx.insert(transactions).values({
            tenantId: ctx.tenantId,
            ownerUserId: loan.ownerUserId ?? ctx.actorUserId,
            loanId: loan.id,
            amount: snapshot.settlementTotal.toFixed(2),
            principalComponent: snapshot.outstandingPrincipal.toFixed(2),
            interestComponent: interestComponent.toFixed(2),
            feeComponent: snapshot.outstandingFees.toFixed(2),
            penaltyComponent: snapshot.outstandingPenalties.toFixed(2),
            type: "close_account",
            transactionDate,
            notes: reason,
            recordedByUserId: ctx.actorUserId,
            entryType: "repayment",
            idempotencyKey: `loan-settlement:${idempotencyKey}`,
            postedAt: executedAt,
            createdAt: executedAt,
            updatedAt: executedAt,
        }).returning().then((rows: TransactionRow[]) => rows[0]!);
        await writeFundEffects(tx, ctx, loan.id, transaction.id, transactionDate, {
            principal: snapshot.outstandingPrincipal,
            interest: interestComponent,
            fee: snapshot.outstandingFees,
            penalty: snapshot.outstandingPenalties,
        });

        const accrualRows = await tx.select().from(loanInterestAccruals).where(and(
            eq(loanInterestAccruals.tenantId, ctx.tenantId),
            eq(loanInterestAccruals.loanId, loan.id),
            sql`${loanInterestAccruals.status} <> 'reversed'`,
            sql`${loanInterestAccruals.accrualDate} <= ${settlement.asOfDate}`,
        )).orderBy(asc(loanInterestAccruals.accrualDate), asc(loanInterestAccruals.id));
        for (const row of accrualRows) {
            if (new FinancialDecimal(row.paidAmount).eq(row.interestAmount)) continue;
            await tx.update(loanInterestAccruals).set({
                paidAmount: money(row.interestAmount).toFixed(2),
                status: "paid",
            }).where(and(
                eq(loanInterestAccruals.tenantId, ctx.tenantId),
                eq(loanInterestAccruals.id, row.id),
            ));
        }
        const remainingAccruals = await tx.select().from(loanInterestAccruals).where(and(
            eq(loanInterestAccruals.tenantId, ctx.tenantId),
            eq(loanInterestAccruals.loanId, loan.id),
            sql`${loanInterestAccruals.status} <> 'reversed'`,
            sql`${loanInterestAccruals.accrualDate} <= ${settlement.asOfDate}`,
        ));
        const remainingInterest = remainingAccruals.reduce(
            (sum: Decimal, row: typeof loanInterestAccruals.$inferSelect) => sum.plus(
                FinancialDecimal.max(0, new FinancialDecimal(row.interestAmount).minus(row.paidAmount)),
            ),
            new FinancialDecimal(0),
        );
        const remainingPrincipal = new FinancialDecimal(loan.outstandingPrincipal ?? loan.principalAmount)
            .minus(snapshot.outstandingPrincipal);
        const remainingFees = new FinancialDecimal(loan.outstandingFees ?? "0.00").minus(snapshot.outstandingFees);
        if (!remainingPrincipal.isZero() || !remainingInterest.isZero() || !remainingFees.isZero()
            || !snapshot.outstandingPenalties.isZero()) {
            throw new DomainError("SETTLEMENT_BALANCE_NOT_ZERO", "Settlement cannot close a loan with a remaining balance", 409);
        }
        const updatedLoan = await tx.update(loans).set({
            outstandingPrincipal: "0.00",
            outstandingInterest: "0.00",
            outstandingFees: "0.00",
            status: "paid",
            nextDueDate: null,
            updatedAt: executedAt,
        }).where(and(eq(loans.tenantId, ctx.tenantId), eq(loans.id, loan.id)))
            .returning().then((rows: LoanRow[]) => rows[0]!);
        const audit = await createAuditLog(tx, {
            ...auditContext(ctx),
            entityType: "loan_settlement",
            entityId: settlement.publicId,
            action: "executed",
            payload: {
                loanPublicId: loan.publicId,
                transactionPublicId: transaction.publicId,
                asOfDate: settlement.asOfDate,
                outstandingPrincipal: settlement.outstandingPrincipal,
                dueInterest: settlement.dueInterest,
                accruedNotDueInterest: settlement.accruedNotDueInterest,
                outstandingFees: settlement.outstandingFees,
                outstandingPenalties: settlement.outstandingPenalties,
                nonRefundableAdvanceInterest: settlement.nonRefundableAdvanceInterest,
                settlementTotal: settlement.settlementTotal,
                reason,
                idempotencyKey,
            },
        });
        const executed = await tx.update(loanSettlementPreviews).set({
            status: "executed",
            executeIdempotencyKey: idempotencyKey,
            executedAuditPublicId: audit.publicId,
            executedAt,
            executedByUserId: ctx.actorUserId,
            updatedAt: executedAt,
        }).where(and(
            eq(loanSettlementPreviews.tenantId, ctx.tenantId),
            eq(loanSettlementPreviews.id, settlement.id),
        )).returning().then((rows: SettlementRow[]) => rows[0]!);
        return { value: await presentExecution(tx, ctx, executed, updatedLoan) };
    });
    if ("stale" in result) {
        throw new DomainError("STALE_SETTLEMENT_PREVIEW", "Settlement preview has expired or no longer matches current balances", 409);
    }
    await invalidateTenantCache(ctx.tenantId);
    return result.value;
}
