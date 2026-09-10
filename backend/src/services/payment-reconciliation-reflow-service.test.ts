import { describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { auditLogs, borrowers, floatingTransactionAllocations, loans, paymentIntakes, paymentReconciliationEntries, paymentReconciliationGroups, paymentReconciliationProposals, paymentReconciliationReflowEntries, paymentReconciliationReflowGroups, transactions, users } from "../db/schema";
import { createAuditLog } from "../lib/audit-log";
import { createBorrower } from "./borrower-service";
import type { CommandContext } from "./command-context";
import { createLoanDraft, activateLoan } from "./loan-application-service";
import { createPaymentIntake, postPayment, previewPaymentMatch } from "./payment-service";
import { executePaymentReconciliationReflow, previewPaymentReconciliationReflow } from "./payment-reconciliation-reflow-service";

const integrationTest = process.env.TEST_DATABASE_URL ? test : test.skip;

async function legacyFixture() {
    const tenantId = `legacy-reflow-${crypto.randomUUID()}`;
    const actor = await db.insert(users).values({ tenantId, email: `${crypto.randomUUID()}@example.test`, role: "owner" }).returning().then((rows) => rows[0]!);
    const ctx: CommandContext = { tenantId, actorUserId: actor.id, actorSource: "web", requestId: crypto.randomUUID(), correlationId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() };
    const borrower = await createBorrower(ctx, { name: "Legacy Repair Borrower" });
    const draft = await createLoanDraft({ ...ctx, idempotencyKey: crypto.randomUUID() }, { borrowerPublicId: borrower.publicId, principal: "1000.00", interestRate: "0.00", repaymentType: "floating", termMonths: 1, startDate: "2026-08-01", floatingDailyInterest: { mode: "percent", rate: "1.0000", firstDayTreatment: "start_next_day" } });
    await activateLoan({ ...ctx, idempotencyKey: crypto.randomUUID() }, draft.publicId);
    const later = await createPaymentIntake({ ...ctx, idempotencyKey: crypto.randomUUID() }, { amount: "10.00", receivedAt: "2026-08-20T05:00:00.000Z", payerName: borrower.name });
    const laterProposal = await previewPaymentMatch(ctx, later.publicId, { allocations: [{ borrowerPublicId: borrower.publicId, loanPublicId: draft.publicId, amount: "10.00" }] });
    await postPayment(ctx, later.publicId, { proposalPublicId: laterProposal.publicId });
    const source = await createPaymentIntake({ ...ctx, idempotencyKey: crypto.randomUUID() }, { amount: "10.00", receivedAt: "2026-08-18T18:30:00.000Z", payerName: borrower.name });
    const sourceRow = await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.publicId, source.publicId) });
    const laterRow = await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.publicId, later.publicId) });
    const laterTransaction = await db.query.transactions.findFirst({ where: and(eq(transactions.tenantId, tenantId), eq(transactions.paymentIntakeId, laterRow!.id)) });
    const audit = await createAuditLog(db, { tenantId, actorUserId: actor.id, actorSource: "web", requestId: ctx.requestId, correlationId: ctx.correlationId, entityType: "payment_reconciliation", entityId: source.publicId, action: "executed", payload: { syntheticLegacy: true } });
    const proposal = await db.insert(paymentReconciliationProposals).values({ tenantId, paymentIntakeId: sourceRow!.id, status: "executed", previewHash: "v1:legacy", expectedBalanceVersion: "v1:legacy", sourceSnapshot: { mode: "historical_needs_review" }, proposedAllocations: [], warnings: [], reason: "Legacy historical reconciliation", expiresAt: new Date(), createdByUserId: actor.id, executedByUserId: actor.id, executedAt: new Date() }).returning().then((rows) => rows[0]!);
    const reconciliation = await db.insert(paymentReconciliationGroups).values({ tenantId, proposalId: proposal.id, paymentIntakeId: sourceRow!.id, postedIntakeId: sourceRow!.id, reason: proposal.reason, idempotencyKey: `legacy-${crypto.randomUUID()}`, correlationId: ctx.correlationId, auditPublicId: audit.publicId, createdByUserId: actor.id }).returning().then((rows) => rows[0]!);
    await db.insert(paymentReconciliationEntries).values({ tenantId, groupId: reconciliation.id, entryType: "replacement", component: "interest", amount: "10.00", interestComponent: "10.00", principalComponent: "0.00", feeComponent: "0.00", penaltyComponent: "0.00", sourceTransactionId: laterTransaction!.id, transactionId: laterTransaction!.id, loanId: laterTransaction!.loanId, scheduleId: null, reason: proposal.reason, auditPublicId: audit.publicId, createdByUserId: actor.id });
    return { tenantId, ctx, reconciliation, laterTransaction: laterTransaction!, source };
}

describe("existing-data temporal reflow repair", () => {
    integrationTest("previews without financial writes, executes once, replays exactly, and conflicts on changed key payload", async () => {
        const fixture = await legacyFixture();
        const before = await db.select().from(transactions).where(eq(transactions.tenantId, fixture.tenantId));
        const preview = await previewPaymentReconciliationReflow(fixture.ctx, { reconciliationPublicId: fixture.reconciliation.publicId, reason: "Repair legacy chronological interest" });
        expect(preview.status).toBe("ready");
        expect(preview.effectiveAfterDate).toBe("2026-08-19");
        expect(preview.plan.transactions.length).toBeGreaterThan(0);
        expect(await db.select().from(transactions).where(eq(transactions.tenantId, fixture.tenantId))).toEqual(before);
        const input = { reflowPreviewPublicId: preview.publicId, previewHash: preview.previewHash, expectedBalanceVersion: preview.expectedBalanceVersion, confirmed: true as const, reason: preview.reason, idempotencyKey: "legacy-repair-execute" };
        const result = await executePaymentReconciliationReflow(fixture.ctx, input);
        expect(result.reflowGroupPublicId).toBeTruthy();
        expect(result.compensatingTransactionPublicIds.length).toBeGreaterThan(0);
        expect(await executePaymentReconciliationReflow(fixture.ctx, input)).toEqual(result);
        await expect(executePaymentReconciliationReflow(fixture.ctx, { ...input, reason: "different repair" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
        expect(await db.select().from(paymentReconciliationReflowGroups).where(eq(paymentReconciliationReflowGroups.tenantId, fixture.tenantId))).toHaveLength(1);
        expect(await db.select().from(paymentReconciliationReflowEntries).where(eq(paymentReconciliationReflowEntries.tenantId, fixture.tenantId))).toHaveLength(result.compensatingTransactionPublicIds.length);
    });

    integrationTest("rejects a second repair group after automatic or prior repair provenance exists", async () => {
        const fixture = await legacyFixture();
        const first = await previewPaymentReconciliationReflow(fixture.ctx, { reconciliationPublicId: fixture.reconciliation.publicId, reason: "First legacy repair" });
        await executePaymentReconciliationReflow(fixture.ctx, { reflowPreviewPublicId: first.publicId, previewHash: first.previewHash, expectedBalanceVersion: first.expectedBalanceVersion, confirmed: true, reason: first.reason, idempotencyKey: "first-repair" });
        await expect(previewPaymentReconciliationReflow(fixture.ctx, { reconciliationPublicId: fixture.reconciliation.publicId, reason: "Second legacy repair" })).rejects.toMatchObject({ code: "RECONCILIATION_REFLOW_ALREADY_EXECUTED" });
    });

    integrationTest("rejects stale repair without a financial write and enforces tenant ownership", async () => {
        const fixture = await legacyFixture();
        const preview = await previewPaymentReconciliationReflow(fixture.ctx, { reconciliationPublicId: fixture.reconciliation.publicId, reason: "Expired legacy repair" });
        const beforeTransactions = await db.select().from(transactions).where(eq(transactions.tenantId, fixture.tenantId));
        await expect(executePaymentReconciliationReflow(fixture.ctx, { reflowPreviewPublicId: preview.publicId, previewHash: "v1:" + "0".repeat(64), expectedBalanceVersion: preview.expectedBalanceVersion, confirmed: true, reason: preview.reason, idempotencyKey: "stale-repair" })).rejects.toMatchObject({ code: "STALE_TEMPORAL_REFLOW_PREVIEW" });
        expect(await db.select().from(transactions).where(eq(transactions.tenantId, fixture.tenantId))).toEqual(beforeTransactions);
        const otherTenant = `foreign-reflow-${crypto.randomUUID()}`;
        const otherActor = await db.insert(users).values({ tenantId: otherTenant, email: `${crypto.randomUUID()}@example.test`, role: "owner" }).returning().then((rows) => rows[0]!);
        await expect(previewPaymentReconciliationReflow({ ...fixture.ctx, tenantId: otherTenant, actorUserId: otherActor.id }, { reconciliationPublicId: fixture.reconciliation.publicId, reason: "Cross tenant" })).rejects.toMatchObject({ code: "RECONCILIATION_GROUP_NOT_FOUND" });
    });

    integrationTest("rolls back the complete repair when a later provenance write fails", async () => {
        const fixture = await legacyFixture();
        const preview = await previewPaymentReconciliationReflow(fixture.ctx, { reconciliationPublicId: fixture.reconciliation.publicId, reason: "Rollback legacy repair" });
        const beforeTransactions = await db.select().from(transactions).where(eq(transactions.tenantId, fixture.tenantId));
        await db.execute(sql`CREATE OR REPLACE FUNCTION test_reflow_write_failure() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'synthetic reflow write failure'; END; $$ LANGUAGE plpgsql`);
        await db.execute(sql`CREATE TRIGGER test_reflow_write_failure_trigger AFTER INSERT ON payment_reconciliation_reflow_entries FOR EACH ROW EXECUTE FUNCTION test_reflow_write_failure()`);
        try {
            await expect(executePaymentReconciliationReflow(fixture.ctx, { reflowPreviewPublicId: preview.publicId, previewHash: preview.previewHash, expectedBalanceVersion: preview.expectedBalanceVersion, confirmed: true, reason: preview.reason, idempotencyKey: "rollback-repair" })).rejects.toThrow();
        } finally {
            await db.execute(sql`DROP TRIGGER IF EXISTS test_reflow_write_failure_trigger ON payment_reconciliation_reflow_entries`);
            await db.execute(sql`DROP FUNCTION IF EXISTS test_reflow_write_failure()`);
        }
        expect(await db.select().from(transactions).where(eq(transactions.tenantId, fixture.tenantId))).toEqual(beforeTransactions);
        expect(await db.select().from(paymentReconciliationReflowGroups).where(eq(paymentReconciliationReflowGroups.tenantId, fixture.tenantId))).toHaveLength(0);
        expect(await db.select().from(paymentReconciliationReflowEntries).where(eq(paymentReconciliationReflowEntries.tenantId, fixture.tenantId))).toHaveLength(0);
    });
});
