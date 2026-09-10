import { and, eq, inArray } from "drizzle-orm";
import Decimal from "decimal.js";
import { db } from "../src/db";
import { borrowers, floatingTransactionAllocations, loanInterestAccruals, loans, paymentIntakes, transactions, users } from "../src/db/schema";
import type { CommandContext } from "../src/services/command-context";
import { createPaymentIntake, postPayment, previewPaymentMatch, reversePayment } from "../src/services/payment-service";

const primaryIntakePublicId = process.env.TARGET_PAYMENT_INTAKE_PUBLIC_ID;
const precedingIntakePublicId = process.env.PRECEDING_PAYMENT_INTAKE_PUBLIC_ID;
const execute = process.env.EXECUTE_REPAIR === "yes";
if (!primaryIntakePublicId || !precedingIntakePublicId) throw new Error("TARGET_PAYMENT_INTAKE_PUBLIC_ID and PRECEDING_PAYMENT_INTAKE_PUBLIC_ID are required");

function businessDate(value: Date) {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" }).format(value);
}

async function loadBatch(publicId: string) {
    const intake = await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.publicId, publicId) });
    if (!intake || !["posted", "reversed"].includes(intake.status)) throw new Error(`Payment intake ${publicId} must be posted or reversed`);
    const originals = await db.select().from(transactions).where(and(eq(transactions.tenantId, intake.tenantId), eq(transactions.paymentIntakeId, intake.id), eq(transactions.entryType, "repayment")));
    if (!originals.length) throw new Error(`Payment intake ${publicId} has no repayment transactions`);
    const loanRows = await db.select().from(loans).where(and(eq(loans.tenantId, intake.tenantId), inArray(loans.id, originals.map((row) => row.loanId))));
    const borrowersById = new Map((await db.select().from(borrowers).where(and(eq(borrowers.tenantId, intake.tenantId), inArray(borrowers.id, loanRows.map((row) => row.borrowerId))))).map((row) => [row.id, row]));
    const allocations = await db.select().from(floatingTransactionAllocations).where(and(eq(floatingTransactionAllocations.tenantId, intake.tenantId), inArray(floatingTransactionAllocations.transactionId, originals.map((row) => row.id))));
    const accruals = await db.select().from(loanInterestAccruals).where(and(eq(loanInterestAccruals.tenantId, intake.tenantId), inArray(loanInterestAccruals.loanId, originals.map((row) => row.loanId))));
    const loanById = new Map(loanRows.map((row) => [row.id, row]));
    const targetDate = businessDate(intake.receivedAt);
    const plan = originals.map((transaction) => {
        const loan = loanById.get(transaction.loanId);
        if (!loan || loan.status !== "active" || loan.repaymentType !== "floating") throw new Error("Every target transaction must belong to an active floating loan");
        if (!new Decimal(transaction.principalComponent).isZero() || !new Decimal(transaction.feeComponent).isZero() || !new Decimal(transaction.penaltyComponent).isZero()) throw new Error("Repair only supports interest-only transactions");
        const txAllocations = allocations.filter((row) => row.transactionId === transaction.id && row.entryType === "payment");
        if (txAllocations.length !== 1 || txAllocations[0]!.component !== "interest") throw new Error("Every target transaction must have one interest allocation");
        const target = accruals.find((row) => row.loanId === loan.id && row.accrualDate === targetDate && row.status !== "reversed");
        if (!target || new Decimal(target.interestAmount).lt(transaction.amount)) throw new Error(`Missing or insufficient target accrual for loan ${loan.publicId}`);
        const borrower = borrowersById.get(loan.borrowerId);
        if (!borrower) throw new Error("Borrower is unavailable");
        return { loan, borrower, amount: new Decimal(transaction.amount).toFixed(2), originalAllocationPublicId: txAllocations[0]!.publicId, originalDueDate: txAllocations[0]!.dueDate, targetAccrualPublicId: target.publicId, targetDate };
    });
    return { intake, plan };
}

const primary = await loadBatch(primaryIntakePublicId);
const preceding = await loadBatch(precedingIntakePublicId);
if (primary.intake.tenantId !== preceding.intake.tenantId || primary.plan.length !== preceding.plan.length) throw new Error("The two batches must belong to the same tenant and cover the same loans");
const primaryByLoan = new Map(primary.plan.map((item) => [item.loan.publicId, item]));
for (const item of preceding.plan) {
    const later = primaryByLoan.get(item.loan.publicId);
    if (!later || item.amount !== later.amount) throw new Error("The preceding and target batches must have matching per-loan amounts");
}
const actorId = primary.intake.createdByUserId ?? primary.intake.ownerUserId;
const actor = actorId ? await db.query.users.findFirst({ where: and(eq(users.tenantId, primary.intake.tenantId), eq(users.id, actorId)) }) : null;
if (!actor) throw new Error("Repair actor is unavailable");
console.log(JSON.stringify({ execute, batches: [
    { intakePublicId: preceding.intake.publicId, receivedDate: businessDate(preceding.intake.receivedAt), totalAmount: new Decimal(preceding.intake.amount).toFixed(2), allocations: preceding.plan.map((item) => ({ loanPublicId: item.loan.publicId, amount: item.amount, originalDueDate: item.originalDueDate, targetAccrualPublicId: item.targetAccrualPublicId })) },
    { intakePublicId: primary.intake.publicId, receivedDate: businessDate(primary.intake.receivedAt), totalAmount: new Decimal(primary.intake.amount).toFixed(2), allocations: primary.plan.map((item) => ({ loanPublicId: item.loan.publicId, amount: item.amount, originalDueDate: item.originalDueDate, targetAccrualPublicId: item.targetAccrualPublicId })) },
] }, null, 2));
if (!execute) process.exit(0);

const base = `floating-payment-ordering-repair:${preceding.intake.publicId}:${primary.intake.publicId}`;
const context = (operation: string): CommandContext => ({ tenantId: primary.intake.tenantId, actorUserId: actor.id, actorSource: "system", requestId: `${base}:${operation}`, correlationId: base, idempotencyKey: `${base}:${operation}` });
if (preceding.intake.status !== "reversed") await reversePayment(context("reverse-preceding"), preceding.intake.publicId, { reason: "Correct transaction insertion ordering for floating interest allocation" });
if (primary.intake.status !== "reversed") await reversePayment(context("reverse-primary"), primary.intake.publicId, { reason: "Correct duplicate floating interest allocation to the prior accrual date" });
for (const [label, batch] of [["preceding", preceding], ["primary", primary]] as const) {
    const replacementKey = `${base}:replacement-intake-${label}`;
    const existingReplacement = await db.query.paymentIntakes.findFirst({ where: and(eq(paymentIntakes.tenantId, primary.intake.tenantId), eq(paymentIntakes.idempotencyKey, replacementKey)) });
    const replacement = existingReplacement
        ? { publicId: existingReplacement.publicId, status: existingReplacement.status }
        : await createPaymentIntake(context(`replacement-intake-${label}`), { amount: new Decimal(batch.intake.amount).toFixed(2), receivedAt: batch.intake.receivedAt.toISOString(), payerName: batch.intake.payerName });
    if (replacement.status === "posted") continue;
    const proposal = await previewPaymentMatch(context(`replacement-preview-${label}`), replacement.publicId, { allocations: batch.plan.map((item) => ({ borrowerPublicId: item.borrower.publicId, loanPublicId: item.loan.publicId, amount: item.amount })) });
    const posted = await postPayment(context(`replacement-post-${label}`), replacement.publicId, { proposalPublicId: proposal.publicId });
    console.log(JSON.stringify({ repairedBatch: label, replacementIntakePublicId: replacement.publicId, transactionPublicIds: posted.transactions.map((row) => row.publicId) }));
}
