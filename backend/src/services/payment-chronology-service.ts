import { sql } from "drizzle-orm";
import type { DbExecutor } from "../db";
import { DomainError } from "./domain-error";

/** Shared borrower-first lock boundary. Always call before intake/loan locks. */
export async function lockPaymentBorrowers(tx: DbExecutor, tenantId: string, ids: number[]) {
    const sorted = [...new Set(ids)].sort((a, b) => a - b);
    if (sorted.length) await tx.execute(sql`SELECT id FROM borrowers WHERE tenant_id = ${tenantId} AND id IN (${sql.join(sorted.map((id) => sql`${id}`), sql`, `)}) ORDER BY id FOR UPDATE`);
}

export async function paymentIntakeBorrowerIds(tx: DbExecutor, tenantId: string, intakeId: number): Promise<number[]> {
    const rows = await tx.execute(sql`SELECT DISTINCT l.borrower_id FROM loans l WHERE l.tenant_id = ${tenantId} AND (
        l.id IN (SELECT t.loan_id FROM transactions t WHERE t.tenant_id = ${tenantId} AND t.payment_intake_id IN (SELECT i.id FROM payment_intakes i WHERE i.tenant_id = ${tenantId} AND (i.id = ${intakeId} OR i.id = (SELECT repost_of_intake_id FROM payment_intakes WHERE tenant_id = ${tenantId} AND id = ${intakeId}))))
        OR l.id = (SELECT origin_loan_id FROM payment_intakes WHERE tenant_id = ${tenantId} AND id = ${intakeId})
        OR l.id IN (SELECT a.loan_id FROM payment_match_allocations a WHERE a.tenant_id = ${tenantId} AND a.proposal_id = (SELECT p.id FROM payment_match_proposals p WHERE p.tenant_id = ${tenantId} AND p.payment_intake_id = ${intakeId} ORDER BY p.version DESC LIMIT 1))
        OR l.id IN (SELECT a.loan_id FROM payment_batch_items bi
            JOIN payment_batches b ON b.tenant_id = bi.tenant_id AND b.id = bi.batch_id
            JOIN payment_batch_allocations a ON a.tenant_id = bi.tenant_id AND a.item_id = bi.id
            WHERE bi.tenant_id = ${tenantId} AND bi.payment_intake_id = ${intakeId} AND b.status <> 'cancelled'
              AND a.preview_id = (SELECT p.id FROM payment_batch_previews p WHERE p.tenant_id = bi.tenant_id AND p.batch_id = bi.batch_id ORDER BY p.version DESC LIMIT 1))
    ) ORDER BY l.borrower_id`);
    return Array.from(rows, (row) => Number(row.borrower_id));
}

export async function assertNoLaterFloatingPayment(tx: DbExecutor, tenantId: string, loanId: number, receivedAt: Date) {
    const later = await tx.execute(sql`SELECT t.public_id FROM transactions t JOIN loans l ON l.tenant_id = t.tenant_id AND l.id = t.loan_id
        WHERE t.tenant_id = ${tenantId} AND t.loan_id = ${loanId} AND l.repayment_type = 'floating'
          AND t.entry_type = 'repayment' AND t.posted_at IS NOT NULL AND t.transaction_date > ${receivedAt.toISOString()}
          AND NOT EXISTS (SELECT 1 FROM transactions r WHERE r.tenant_id = t.tenant_id AND r.reversed_transaction_id = t.id)
        LIMIT 1`);
    if (later.length) throw new DomainError("FLOATING_BACKDATED_ALLOCATION_REQUIRES_RECONCILIATION", "A later floating payment requires reconciliation before posting this older slip", 409);
}

export async function assertNoOlderPendingPayment(tx: DbExecutor, tenantId: string, borrowerId: number, receivedAt: Date, excludedIntakeIds: number[]) {
    const excluded = excludedIntakeIds.length ? sql`AND i.id NOT IN (${sql.join(excludedIntakeIds.map((id) => sql`${id}`), sql`, `)})` : sql``;
    // Latest proposal is authoritative even if origin_loan_id was never set.
    // Cancelled batches do not remain artificial chronology dependencies.
    const pending = await tx.execute(sql`SELECT i.public_id FROM payment_intakes i
        WHERE i.tenant_id = ${tenantId} AND i.status NOT IN ('posted', 'reversed', 'cancelled', 'rejected')
          AND i.received_at < ${receivedAt.toISOString()} ${excluded}
          AND NOT EXISTS (SELECT 1 FROM payment_batch_items bi JOIN payment_batches b ON b.tenant_id = bi.tenant_id AND b.id = bi.batch_id WHERE bi.tenant_id = i.tenant_id AND bi.payment_intake_id = i.id AND b.status = 'cancelled')
          AND (
            EXISTS (SELECT 1 FROM loans l WHERE l.tenant_id = i.tenant_id AND l.id = i.origin_loan_id AND l.borrower_id = ${borrowerId})
            OR EXISTS (SELECT 1 FROM payment_match_allocations a WHERE a.tenant_id = i.tenant_id AND a.borrower_id = ${borrowerId} AND a.proposal_id = (SELECT p.id FROM payment_match_proposals p WHERE p.tenant_id = i.tenant_id AND p.payment_intake_id = i.id ORDER BY p.version DESC LIMIT 1))
            OR EXISTS (SELECT 1 FROM payment_batch_items bi
                JOIN payment_batches b ON b.tenant_id = bi.tenant_id AND b.id = bi.batch_id
                JOIN payment_batch_allocations a ON a.tenant_id = bi.tenant_id AND a.item_id = bi.id
                WHERE bi.tenant_id = i.tenant_id AND bi.payment_intake_id = i.id AND a.borrower_id = ${borrowerId}
                  AND b.status NOT IN ('posted', 'cancelled')
                  AND a.preview_id = (SELECT p.id FROM payment_batch_previews p WHERE p.tenant_id = bi.tenant_id AND p.batch_id = bi.batch_id ORDER BY p.version DESC LIMIT 1))
            OR EXISTS (SELECT 1 FROM payment_batch_items bi JOIN payment_batches b ON b.tenant_id = bi.tenant_id AND b.id = bi.batch_id WHERE bi.tenant_id = i.tenant_id AND bi.payment_intake_id = i.id AND b.borrower_id = ${borrowerId} AND b.status NOT IN ('posted', 'cancelled'))
          ) LIMIT 1`);
    if (pending.length) throw new DomainError("PAYMENT_CHRONOLOGY_CONFLICT", "An older pending payment blocks chronology; resolve that dependency first", 409);
}
