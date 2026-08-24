import { and, eq, sql } from "drizzle-orm";
import Decimal from "decimal.js";
import { db } from "../src/db";
import { createAuditLog } from "../src/lib/audit-log";
import { loanRenewals, loans, transactions } from "../src/db/schema";

const renewalPublicId = process.env.TARGET_RENEWAL_PUBLIC_ID;
const execute = process.env.EXECUTE_BACKFILL === "yes";
if (!renewalPublicId) throw new Error("TARGET_RENEWAL_PUBLIC_ID is required");

const renewal = await db.query.loanRenewals.findFirst({ where: eq(loanRenewals.publicId, renewalPublicId) });
if (!renewal || renewal.status !== "executed" || renewal.newLoanId === null) throw new Error("Target renewal is not an executed renewal");
const oldLoan = await db.query.loans.findFirst({ where: and(eq(loans.id, renewal.oldLoanId), eq(loans.tenantId, renewal.tenantId)) });
if (!oldLoan || oldLoan.status !== "renewed") throw new Error("Target old loan is not in renewed status");

const composition = renewal.composition as {
    settlementPolicy: "full_contract_interest" | "accrued_to_date";
    settlementAmount: string;
    remainingContractInterest: string;
    accruedDueInterest: string;
    dueFees: string;
    duePenalties: string;
};
if (!composition) throw new Error("Renewal composition is unavailable");

const principal = new Decimal(renewal.outstandingPrincipal);
const settlementAmount = new Decimal(composition.settlementAmount);
const interest = new Decimal(composition.settlementPolicy === "full_contract_interest"
    ? composition.remainingContractInterest
    : composition.accruedDueInterest);
const fee = new Decimal(composition.dueFees);
const penalty = new Decimal(composition.duePenalties);
const amount = principal.plus(settlementAmount).toFixed(2);
const idempotencyKey = `renewal-backfill:${renewal.publicId}:settlement-v1`;
const actorUserId = renewal.executedByUserId ?? oldLoan.ownerUserId;
const transactionDate = new Date(`${renewal.renewalDate}T23:59:59.999+07:00`);

console.log(JSON.stringify({
    execute,
    renewalPublicId,
    oldLoanPublicId: oldLoan.publicId,
    amount,
    principalComponent: principal.toFixed(2),
    interestComponent: interest.toFixed(2),
    feeComponent: fee.toFixed(2),
    penaltyComponent: penalty.toFixed(2),
    idempotencyKey,
}));
if (!execute) process.exit(0);

const result = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM loan_renewals WHERE tenant_id = ${renewal.tenantId} AND id = ${renewal.id} FOR UPDATE`);
    const existing = await tx.query.transactions.findFirst({ where: and(
        eq(transactions.tenantId, renewal.tenantId),
        eq(transactions.loanId, oldLoan.id),
        eq(transactions.idempotencyKey, idempotencyKey),
        eq(transactions.entryType, "repayment"),
    ) });
    if (existing) return { status: "already_backfilled", transactionPublicId: existing.publicId };

    const transaction = await tx.insert(transactions).values({
        tenantId: renewal.tenantId,
        ownerUserId: actorUserId,
        loanId: oldLoan.id,
        amount,
        principalComponent: principal.toFixed(2),
        interestComponent: interest.toFixed(2),
        feeComponent: fee.toFixed(2),
        penaltyComponent: penalty.toFixed(2),
        type: "close_account",
        transactionDate,
        notes: "Renewal settlement — final installment paid from renewal proceeds",
        recordedByUserId: actorUserId,
        entryType: "repayment",
        idempotencyKey,
        postedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
    }).returning().then((rows) => rows[0]!);
    const audit = await createAuditLog(tx, {
        tenantId: renewal.tenantId,
        actorUserId,
        actorSource: "system",
        requestId: idempotencyKey,
        correlationId: idempotencyKey,
        entityType: "loan_renewal",
        entityId: renewal.publicId,
        action: "settlement_backfilled",
        payload: {
            renewalPublicId: renewal.publicId,
            oldLoanPublicId: oldLoan.publicId,
            transactionPublicId: transaction.publicId,
            amount,
            reason: "Record final installment paid from renewal proceeds",
        },
    });
    return { status: "backfilled", transactionPublicId: transaction.publicId, auditPublicId: audit.publicId };
});

console.log(JSON.stringify(result));
