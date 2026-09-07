import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { auditLogs, borrowers, loanSchedules, loans, paymentAllocationCorrectionEntries, paymentAllocationCorrectionGroups, paymentAllocationCorrectionPreviews, paymentIntakes, transactions, users } from "./schema";

const root = new URL("../../", import.meta.url).pathname;
const integrationTest = process.env.TEST_DATABASE_URL ? test : test.skip;

describe("scheduled payment allocation correction migration", () => {
    test("registers the additive migration and immutable ledger constraints", async () => {
        const journal = await Bun.file(`${root}drizzle/meta/_journal.json`).json() as { entries: Array<{ idx: number; tag: string; version: string; when: number; breakpoints: boolean }> };
        expect(journal.entries.find((entry) => entry.tag === "0061_scheduled_payment_allocation_corrections")).toEqual({ idx: 61, version: "7", when: 1788471121000, tag: "0061_scheduled_payment_allocation_corrections", breakpoints: true });
        const sql = await Bun.file(`${root}drizzle/0061_scheduled_payment_allocation_corrections.sql`).text();
        for (const table of ["payment_allocation_correction_previews", "payment_allocation_correction_groups", "payment_allocation_correction_entries"]) expect(sql).toContain(`CREATE TABLE IF NOT EXISTS \"${table}\"`);
        expect(sql).toContain("payment_allocation_correction_previews_amount_check");
        expect(sql).toContain("payment_allocation_correction_groups_tenant_idempotency_unique");
        expect(sql).toContain("payment_allocation_correction_groups_tenant_source_unique");
        expect(sql).toMatch(/BEFORE UPDATE OR DELETE ON \"payment_allocation_correction_(previews|groups|entries)\"/);
        expect(sql).toMatch(/records are immutable/i);
    });
});

describe("scheduled payment allocation correction database enforcement", () => {
    integrationTest("enforces immutable lifecycle and tenant-safe foreign keys in PostgreSQL", async () => {
        const tenantId = `migration-correction-${crypto.randomUUID()}`;
        const actor = (await db.insert(users).values({ tenantId, email: `${crypto.randomUUID()}@example.test`, role: "owner" }).returning())[0]!;
        const borrower = (await db.insert(borrowers).values({ tenantId, ownerUserId: actor.id, name: "Migration Correction Borrower" }).returning())[0]!;
        const loan = (await db.insert(loans).values({ tenantId, ownerUserId: actor.id, borrowerId: borrower.id, principalAmount: "100.00", interestRate: "0.00", repaymentType: "daily", termMonths: 1, startDate: "2026-09-01", outstandingPrincipal: "100.00", outstandingInterest: "0.00", outstandingFees: "0.00", status: "active" }).returning())[0]!;
        const schedules = await db.insert(loanSchedules).values([
            { tenantId, loanId: loan.id, installmentNo: 1, dueDate: "2026-09-01", scheduledPrincipal: "100.00", scheduledInterest: "0.00", scheduledFee: "0.00", scheduledTotal: "100.00", paidTotal: "0.00", paidPenalty: "0.00", remainingDue: "100.00", status: "pending" },
            { tenantId, loanId: loan.id, installmentNo: 2, dueDate: "2026-09-02", scheduledPrincipal: "100.00", scheduledInterest: "0.00", scheduledFee: "0.00", scheduledTotal: "100.00", paidTotal: "0.00", paidPenalty: "0.00", remainingDue: "100.00", status: "pending" },
        ]).returning();
        const intake = (await db.insert(paymentIntakes).values({ tenantId, ownerUserId: actor.id, status: "posted", amount: "100.00", receivedAt: new Date(), createdByUserId: actor.id }).returning())[0]!;
        const source = (await db.insert(transactions).values({ tenantId, ownerUserId: actor.id, loanId: loan.id, scheduleId: schedules[0]!.id, amount: "100.00", principalComponent: "100.00", interestComponent: "0.00", feeComponent: "0.00", penaltyComponent: "0.00", paymentIntakeId: intake.id, recordedByUserId: actor.id }).returning())[0]!;
        const audit = (await db.insert(auditLogs).values({ tenantId, actorUserId: actor.id, actorSource: "system", entityType: "test", entityId: source.publicId, action: "seed" }).returning())[0]!;
        const preview = (await db.insert(paymentAllocationCorrectionPreviews).values({ tenantId, paymentIntakeId: intake.id, sourceTransactionId: source.id, sourceScheduleId: schedules[0]!.id, targetScheduleId: schedules[1]!.id, loanId: loan.id, amount: "100.00", principalComponent: "100.00", interestComponent: "0.00", feeComponent: "0.00", penaltyComponent: "0.00", sourceSnapshot: {}, targetSnapshot: {}, proposedProjection: {}, warnings: [], previewHash: "v1:test", expectedBalanceVersion: "v1:test", reason: "migration test", expiresAt: new Date(Date.now() + 60_000), createdByUserId: actor.id }).returning())[0]!;
        await db.update(paymentAllocationCorrectionPreviews).set({ status: "executed" }).where(eq(paymentAllocationCorrectionPreviews.id, preview.id));
        await expect(Promise.resolve(db.update(paymentAllocationCorrectionPreviews).set({ reason: "changed" }).where(eq(paymentAllocationCorrectionPreviews.id, preview.id)))).rejects.toThrow();
        await expect(Promise.resolve(db.delete(paymentAllocationCorrectionPreviews).where(eq(paymentAllocationCorrectionPreviews.id, preview.id)))).rejects.toThrow();
        const group = (await db.insert(paymentAllocationCorrectionGroups).values({ tenantId, previewId: preview.id, paymentIntakeId: intake.id, sourceTransactionId: source.id, sourceScheduleId: schedules[0]!.id, targetScheduleId: schedules[1]!.id, loanId: loan.id, reason: "migration test", idempotencyKey: "migration-test-key", correlationId: "migration-test-correlation", auditPublicId: audit.publicId, createdByUserId: actor.id }).returning())[0]!;
        await expect(Promise.resolve(db.delete(paymentAllocationCorrectionGroups).where(and(eq(paymentAllocationCorrectionGroups.tenantId, tenantId), eq(paymentAllocationCorrectionGroups.id, group.id))))).rejects.toThrow();
        await expect(Promise.resolve(db.insert(paymentAllocationCorrectionPreviews).values({ tenantId, paymentIntakeId: intake.id, sourceTransactionId: source.id, sourceScheduleId: schedules[0]!.id, targetScheduleId: schedules[1]!.id, loanId: loan.id, amount: "100.00", principalComponent: "99.99", interestComponent: "0.00", feeComponent: "0.00", penaltyComponent: "0.00", sourceSnapshot: {}, targetSnapshot: {}, proposedProjection: {}, warnings: [], previewHash: "v1:bad", expectedBalanceVersion: "v1:bad", reason: "migration test", expiresAt: new Date(), createdByUserId: actor.id }))).rejects.toThrow();
        await db.insert(paymentAllocationCorrectionEntries).values({ tenantId, groupId: group.id, entryType: "reversal", sourceTransactionId: source.id, transactionId: source.id, loanId: loan.id, scheduleId: schedules[0]!.id, amount: "-100.00", principalComponent: "-100.00", interestComponent: "0.00", feeComponent: "0.00", penaltyComponent: "0.00", reason: "migration test", auditPublicId: audit.publicId, createdByUserId: actor.id });
    });
});
