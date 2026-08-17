import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "../db";
import { transactions } from "../db/schema";
import { canAccessTenantWideData } from "../lib/access";
import type { CommandContext } from "./command-context";
import { DomainError } from "./domain-error";

export type PaymentActor = { id: number; role: string | null } | null;

export function canAccessOwnedRecord(actor: PaymentActor, ownerUserId: number | null) {
    return actor === null || canAccessTenantWideData({ role: actor.role ?? "viewer" }) || actor.id === ownerUserId;
}

export function canonicalPostedPaymentPredicate(tenantId: string) {
    return and(
        eq(transactions.tenantId, tenantId),
        isNotNull(transactions.postedAt),
        inArray(transactions.entryType, ["repayment", "reversal"]),
        inArray(transactions.type, ["repayment", "close_account", "reversal"]),
        sql`(${transactions.paymentIntakeId} IS NULL OR EXISTS (
            SELECT 1 FROM payment_intakes pi
            WHERE pi.tenant_id = ${tenantId}
              AND pi.id = ${transactions.paymentIntakeId}
              AND pi.status IN ('posted', 'reversed')
              AND pi.posted_at IS NOT NULL
        ))`,
    );
}

// New financial links may target only an uncompensated posted payment. Historical readers
// still use the canonical predicate above so original + reversal rows remain inspectable.
export function effectivePostedPaymentPredicate(tenantId: string) {
    return and(
        canonicalPostedPaymentPredicate(tenantId),
        sql`NOT EXISTS (
            SELECT 1 FROM transactions payment_reversal
            WHERE payment_reversal.tenant_id = ${tenantId}
              AND payment_reversal.reversed_transaction_id = ${transactions.id}
              AND payment_reversal.entry_type = 'reversal'
              AND payment_reversal.posted_at IS NOT NULL
        )`,
    );
}

export async function authorizedPostedPayment(
    executor: any,
    ctx: CommandContext,
    actor: PaymentActor,
    reference: { publicId: string } | { id: number },
    notFoundCode = "PAYMENT_NOT_FOUND",
) {
    const referenceFilter = "publicId" in reference
        ? eq(transactions.publicId, reference.publicId)
        : eq(transactions.id, reference.id);
    const payment = await executor.query.transactions.findFirst({
        where: and(effectivePostedPaymentPredicate(ctx.tenantId), referenceFilter),
    });
    if (!payment || !canAccessOwnedRecord(actor, payment.ownerUserId)) {
        throw new DomainError(notFoundCode, notFoundCode === "PAYMENT_NOT_FOUND" ? "Payment not found" : "Payment attribution not found", 404);
    }
    return payment;
}

export async function authorizedCanonicalPostedPayment(
    executor: any,
    ctx: CommandContext,
    actor: PaymentActor,
    reference: { publicId: string } | { id: number },
    notFoundCode = "PAYMENT_NOT_FOUND",
) {
    const referenceFilter = "publicId" in reference
        ? eq(transactions.publicId, reference.publicId)
        : eq(transactions.id, reference.id);
    const payment = await executor.query.transactions.findFirst({
        where: and(canonicalPostedPaymentPredicate(ctx.tenantId), referenceFilter),
    });
    if (!payment || !canAccessOwnedRecord(actor, payment.ownerUserId)) {
        throw new DomainError(notFoundCode, notFoundCode === "PAYMENT_NOT_FOUND" ? "Payment not found" : "Payment attribution not found", 404);
    }
    return payment;
}

export async function listCanonicalPostedPaymentsForLoan(tenantId: string, loanId: number) {
    return db.select().from(transactions).where(and(
        canonicalPostedPaymentPredicate(tenantId),
        eq(transactions.loanId, loanId),
    ));
}
