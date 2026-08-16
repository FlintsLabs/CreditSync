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
              AND pi.status = 'posted'
              AND pi.posted_at IS NOT NULL
        ))`,
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
