import { and, eq, sql } from "drizzle-orm";
import Decimal from "decimal.js";
import { db } from "../src/db";
import { borrowers, loanInterestAccruals, loans, paymentIntakes, transactions, users } from "../src/db/schema";
import type { CommandContext } from "../src/services/command-context";
import { correctFloatingInterestAccruals } from "../src/services/floating-interest-service";
import { createPaymentIntake, postPayment, previewPaymentMatch, reversePayment } from "../src/services/payment-service";

const loanPublicId = process.env.TARGET_LOAN_PUBLIC_ID;
const intakePublicId = process.env.TARGET_PAYMENT_INTAKE_PUBLIC_ID;
const execute = process.env.EXECUTE_CORRECTION === "yes";
if (!loanPublicId || !intakePublicId) throw new Error("TARGET_LOAN_PUBLIC_ID and TARGET_PAYMENT_INTAKE_PUBLIC_ID are required");

const loan = await db.query.loans.findFirst({ where: eq(loans.publicId, loanPublicId) });
const intake = await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.publicId, intakePublicId) });
if (!loan || loan.repaymentType !== "floating" || !intake || intake.tenantId !== loan.tenantId || intake.status !== "posted") throw new Error("Target loan/payment state does not match the correction preconditions");
const original = await db.query.transactions.findFirst({ where: and(eq(transactions.paymentIntakeId, intake.id), eq(transactions.loanId, loan.id), eq(transactions.entryType, "repayment")) });
if (!original || !new Decimal(original.principalComponent).eq(intake.amount) || !new Decimal(original.interestComponent).eq(0)) throw new Error("Target payment is not a fully principal-applied floating repayment");
const actor = await db.query.users.findFirst({ where: and(eq(users.tenantId, loan.tenantId), eq(users.id, intake.createdByUserId ?? intake.ownerUserId)) });
const borrower = await db.query.borrowers.findFirst({ where: and(eq(borrowers.tenantId, loan.tenantId), eq(borrowers.id, loan.borrowerId)) });
if (!actor || !borrower) throw new Error("Correction actor or borrower is unavailable");
const accruals = await db.select().from(loanInterestAccruals).where(and(eq(loanInterestAccruals.tenantId, loan.tenantId), eq(loanInterestAccruals.loanId, loan.id), sql`${loanInterestAccruals.status} <> 'reversed'`));
const dates = accruals.map((row) => row.accrualDate).sort();
console.log(JSON.stringify({ execute, loanPublicId, intakePublicId, paymentAmount: new Decimal(intake.amount).toFixed(2), principalComponent: new Decimal(original.principalComponent).toFixed(2), correctionDates: dates }));
if (!execute) process.exit(0);

const base = `floating-allocation-correction:${loan.publicId}:${intake.publicId}`;
const context = (operation: string): CommandContext => ({
    tenantId: loan.tenantId, actorUserId: actor.id, actorSource: "system",
    requestId: `${base}:${operation}`, correlationId: base, idempotencyKey: `${base}:${operation}`,
});
await reversePayment(context("reverse"), intake.publicId, { reason: "Correct payment that bypassed legacy floating interest accruals" });
await correctFloatingInterestAccruals(context("accruals"), loan.publicId, dates, "Recalculate legacy floating accruals created with an incorrect zero principal basis");
const replacement = await createPaymentIntake(context("replacement-intake"), {
    amount: new Decimal(intake.amount).toFixed(2), receivedAt: intake.receivedAt.toISOString(), payerName: intake.payerName ?? borrower.name, originLoanPublicId: loan.publicId,
});
const proposal = await previewPaymentMatch(context("replacement-preview"), replacement.publicId, {
    allocations: [{ borrowerPublicId: borrower.publicId, loanPublicId: loan.publicId, amount: new Decimal(intake.amount).toFixed(2) }],
});
const posted = await postPayment(context("replacement-post"), replacement.publicId, { proposalPublicId: proposal.publicId });
console.log(JSON.stringify({ corrected: true, replacementIntakePublicId: replacement.publicId, adjustment: posted.transactions[0] }));
process.exit(0);
