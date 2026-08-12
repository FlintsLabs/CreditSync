import { beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { db } from "../db";
import { borrowers, intermediaries, intermediaryCollections, intermediaryRemittanceEvidence, loans, paymentIntakes, transactions, users } from "../db/schema";
import type { CommandContext } from "./command-context";
import { createIntermediary, createIntermediaryCollection, createIntermediaryRemittance, finalizeIntermediaryRemittanceEvidence, manualApproveIntermediaryCollection, normalizeIntermediaryText, postIntermediaryRemittance, prepareIntermediaryRemittanceEvidence, previewIntermediaryRemittance, reverseIntermediaryRemittance, saveRemittanceAllocations } from "./intermediary-service";

const integrationTest = process.env.TEST_DATABASE_URL ? test : test.skip;

describe("intermediary collection service", () => {
    test("normalizes names without changing meaningful Thai text", () => {
        expect(normalizeIntermediaryText("  พี่ ก้อย!! ")).toBe("พี่ ก้อย");
    });

    integrationTest("captures an idempotent non-financial borrower collection", async () => {
        await db.execute(sql`TRUNCATE TABLE audit_logs, intermediary_remittance_proposals,
            intermediary_remittance_allocations, intermediary_remittances, intermediary_collections,
            intermediaries, transactions, payment_intakes, loans, borrowers, users RESTART IDENTITY CASCADE`);
        const actor = await db.insert(users).values({ tenantId: "tenant-a", email: "owner@example.test", role: "owner" }).returning().then((rows) => rows[0]!);
        const borrower = await db.insert(borrowers).values({ tenantId: actor.tenantId, ownerUserId: actor.id, name: "นาย เฉลิมพล" }).returning().then((rows) => rows[0]!);
        const loan = await db.insert(loans).values({ tenantId: actor.tenantId, ownerUserId: actor.id, borrowerId: borrower.id, principalAmount: "5000.00", interestRate: "0.00", repaymentType: "floating", outstandingPrincipal: "5000.00", outstandingInterest: "0.00", outstandingFees: "0.00", status: "active" }).returning().then((rows) => rows[0]!);
        const ctx: CommandContext = { tenantId: actor.tenantId, actorUserId: actor.id, actorSource: "web", requestId: "req-1", correlationId: "corr-1", idempotencyKey: "collection-1" };
        const intermediary = await createIntermediary({ ...ctx, idempotencyKey: undefined }, { name: "พี่ก้อย" });

        const first = await createIntermediaryCollection(ctx, { intermediaryPublicId: intermediary.publicId, borrowerPublicId: borrower.publicId, loanPublicId: loan.publicId, amount: "75.00", borrowerPaidAt: "2026-08-07T14:51:00+07:00", bankReference: "016219145104BTF08823" });
        const replay = await createIntermediaryCollection(ctx, { intermediaryPublicId: intermediary.publicId, borrowerPublicId: borrower.publicId, loanPublicId: loan.publicId, amount: "75.00", borrowerPaidAt: "2026-08-07T14:51:00+07:00", bankReference: "016219145104BTF08823" });

        expect(first).toMatchObject({ status: "pending_remittance", amount: "75.00", borrowerPaidAt: "2026-08-07T07:51:00.000Z" });
        expect(replay.publicId).toBe(first.publicId);
        expect(await db.select().from(intermediaryCollections)).toHaveLength(1);
        expect(await db.select().from(transactions).where(eq(transactions.loanId, loan.id))).toHaveLength(0);
        expect(await db.select().from(intermediaries)).toHaveLength(1);
    });

    integrationTest("prepares and verifies remittance-slip evidence before linking it", async () => {
        await db.execute(sql`TRUNCATE TABLE audit_logs, intermediary_remittance_evidence_intents, intermediary_remittance_evidence, intermediary_remittances, intermediaries, files, users RESTART IDENTITY CASCADE`);
        const actor = await db.insert(users).values({ tenantId: "tenant-a", email: "evidence@example.test", role: "owner" }).returning().then((rows) => rows[0]!);
        const ctx: CommandContext = { tenantId: actor.tenantId, actorUserId: actor.id, actorSource: "web", requestId: "req-evidence", correlationId: "corr-evidence" };
        const intermediary = await createIntermediary(ctx, { name: "Collector Evidence" });
        const remittance = await createIntermediaryRemittance({ ...ctx, idempotencyKey: "remit-evidence" }, { intermediaryPublicId: intermediary.publicId, grossAmount: "180.00", receivedAt: "2026-08-07T14:54:00+07:00" });
        const sha256 = "a".repeat(64);
        const gateway = { preparePut: async () => ({ uploadUrl: "https://upload.invalid/object", expiresAt: new Date(Date.now() + 60_000) }), head: async () => ({ exists: true, contentType: "image/png", contentLength: 12, checksumSha256: sha256, metadata: { tenant: actor.tenantId, remittance: remittance.publicId } }) };
        const prepared = await prepareIntermediaryRemittanceEvidence(ctx, remittance.publicId, { mimeType: "image/png", size: 12, sha256 }, gateway);
        expect(prepared).toMatchObject({ status: "pending", uploadUrl: "https://upload.invalid/object" });
        const finalized = await finalizeIntermediaryRemittanceEvidence(ctx, remittance.publicId, prepared.publicId, gateway);
        expect(finalized).toMatchObject({ status: "ready", sha256 });
        expect(await db.select().from(intermediaryRemittanceEvidence)).toHaveLength(1);
    });

    integrationTest("settles a historical collection linked to a posted intake without posting the loan twice", async () => {
        await db.execute(sql`TRUNCATE TABLE audit_logs, intermediary_remittance_proposals,
            intermediary_remittance_allocations, intermediary_remittances, intermediary_collections,
            intermediaries, transactions, payment_intakes, loans, borrowers, users RESTART IDENTITY CASCADE`);
        const actor = await db.insert(users).values({ tenantId: "tenant-a", email: "history@example.test", role: "owner" }).returning().then((rows) => rows[0]!);
        const borrower = await db.insert(borrowers).values({ tenantId: actor.tenantId, ownerUserId: actor.id, name: "Borrower" }).returning().then((rows) => rows[0]!);
        const loan = await db.insert(loans).values({ tenantId: actor.tenantId, ownerUserId: actor.id, borrowerId: borrower.id, principalAmount: "5000.00", interestRate: "0.00", repaymentType: "floating", outstandingPrincipal: "5000.00", outstandingInterest: "0.00", outstandingFees: "0.00", status: "active" }).returning().then((rows) => rows[0]!);
        const receivedAt = new Date("2026-08-07T07:54:00.000Z");
        const intake = await db.insert(paymentIntakes).values({ tenantId: actor.tenantId, ownerUserId: actor.id, status: "posted", amount: "180.00", receivedAt, bankReference: "borrower-ref", postedAt: new Date() }).returning().then((rows) => rows[0]!);
        await db.insert(transactions).values({ tenantId: actor.tenantId, ownerUserId: actor.id, loanId: loan.id, paymentIntakeId: intake.id, amount: "180.00", interestComponent: "180.00", entryType: "repayment", idempotencyKey: "historical-payment" });
        const base: CommandContext = { tenantId: actor.tenantId, actorUserId: actor.id, actorSource: "web", requestId: "req-history", correlationId: "corr-history" };
        const intermediary = await createIntermediary(base, { name: "Collector" });
        const collection = await createIntermediaryCollection({ ...base, idempotencyKey: "history-collection" }, {
            intermediaryPublicId: intermediary.publicId, borrowerPublicId: borrower.publicId, loanPublicId: loan.publicId,
            amount: "180.00", borrowerPaidAt: receivedAt.toISOString(), bankReference: "borrower-ref", paymentIntakePublicId: intake.publicId,
        });
        const remittance = await createIntermediaryRemittance({ ...base, idempotencyKey: "history-remittance" }, { intermediaryPublicId: intermediary.publicId, grossAmount: "180.00", receivedAt: "2026-08-07T14:54:00+07:00", bankReference: "remit-ref" });
        await saveRemittanceAllocations(base, remittance.publicId, { collectionPublicIds: [collection.publicId] });
        const preview = await previewIntermediaryRemittance(base, remittance.publicId);
        await postIntermediaryRemittance({ ...base, idempotencyKey: "history-post" }, remittance.publicId, { proposalPublicId: preview.publicId, confirmed: true });

        expect(await db.select().from(transactions).where(eq(transactions.loanId, loan.id))).toHaveLength(1);
        expect((await db.select().from(intermediaryCollections))[0]).toMatchObject({ status: "settled", postedPaymentIntakeId: intake.id });
        await reverseIntermediaryRemittance({ ...base, idempotencyKey: "history-reverse" }, remittance.publicId, { reason: "Collector transfer was recalled" });
        expect(await db.select().from(transactions).where(eq(transactions.loanId, loan.id))).toHaveLength(1);
        expect((await db.select().from(intermediaryCollections))[0]).toMatchObject({ status: "pending_remittance", postedPaymentIntakeId: intake.id, paymentIntakePreexisting: true });
    });

    integrationTest("persists explicit selections and previews exact remittance balance without auto-selection", async () => {
        await db.execute(sql`TRUNCATE TABLE audit_logs, intermediary_remittance_proposals,
            intermediary_remittance_allocations, intermediary_remittances, intermediary_collections,
            intermediaries, transactions, payment_intakes, loans, borrowers, users RESTART IDENTITY CASCADE`);
        const actor = await db.insert(users).values({ tenantId: "tenant-a", email: "owner-remit@example.test", role: "owner" }).returning().then((rows) => rows[0]!);
        const borrower = await db.insert(borrowers).values({ tenantId: actor.tenantId, ownerUserId: actor.id, name: "Borrower" }).returning().then((rows) => rows[0]!);
        const loan = await db.insert(loans).values({ tenantId: actor.tenantId, ownerUserId: actor.id, borrowerId: borrower.id, principalAmount: "5000.00", interestRate: "0.00", repaymentType: "floating", outstandingPrincipal: "5000.00", outstandingInterest: "0.00", outstandingFees: "0.00", status: "active" }).returning().then((rows) => rows[0]!);
        const base: CommandContext = { tenantId: actor.tenantId, actorUserId: actor.id, actorSource: "web", requestId: "req-remit", correlationId: "corr-remit" };
        const intermediary = await createIntermediary(base, { name: "Collector" });
        const collectionA = await createIntermediaryCollection({ ...base, idempotencyKey: "c-a" }, { intermediaryPublicId: intermediary.publicId, borrowerPublicId: borrower.publicId, loanPublicId: loan.publicId, amount: "75.00", borrowerPaidAt: "2026-08-07T14:51:00+07:00", bankReference: "ref-a" });
        const collectionB = await createIntermediaryCollection({ ...base, idempotencyKey: "c-b" }, { intermediaryPublicId: intermediary.publicId, borrowerPublicId: borrower.publicId, loanPublicId: loan.publicId, amount: "125.00", borrowerPaidAt: "2026-08-08T15:37:00+07:00", bankReference: "ref-b" });
        const remittance = await createIntermediaryRemittance({ ...base, idempotencyKey: "r-1" }, { intermediaryPublicId: intermediary.publicId, grossAmount: "200.00", receivedAt: "2026-08-11T09:00:00+07:00", bankReference: "remit-ref" });

        const partial = await saveRemittanceAllocations(base, remittance.publicId, { collectionPublicIds: [collectionA.publicId] });
        expect(partial).toMatchObject({ selectedTotal: "75.00", remainingBalance: "125.00", status: "needs_review" });
        const partialPreview = await previewIntermediaryRemittance(base, remittance.publicId);
        expect(partialPreview).toMatchObject({ version: 1, status: "needs_review", remainingBalance: "125.00" });

        const exact = await saveRemittanceAllocations(base, remittance.publicId, { collectionPublicIds: [collectionA.publicId, collectionB.publicId] });
        expect(exact).toMatchObject({ selectedTotal: "200.00", remainingBalance: "0.00", status: "ready" });
        const exactPreview = await previewIntermediaryRemittance(base, remittance.publicId);
        expect(exactPreview).toMatchObject({ version: 2, status: "ready", selectedTotal: "200.00", remainingBalance: "0.00", collectionPublicIds: [collectionA.publicId, collectionB.publicId] });

        const posted = await postIntermediaryRemittance({ ...base, idempotencyKey: "post-r-1" }, remittance.publicId, { proposalPublicId: exactPreview.publicId, confirmed: true });
        expect(posted).toMatchObject({ status: "posted", grossAmount: "200.00", selectedTotal: "200.00", remainingBalance: "0.00" });
        const postedTransactions = await db.select().from(transactions).orderBy(transactions.transactionDate);
        expect(postedTransactions.map((row) => [row.amount, row.transactionDate!.toISOString()])).toEqual([
            ["75.00", "2026-08-07T07:51:00.000Z"],
            ["125.00", "2026-08-08T08:37:00.000Z"],
        ]);

        const reversed = await reverseIntermediaryRemittance({ ...base, idempotencyKey: "reverse-r-1" }, remittance.publicId, { reason: "Intermediary transfer was recalled" });
        expect(reversed).toMatchObject({ status: "reversed", reversalReason: "Intermediary transfer was recalled" });
        expect((await db.select().from(transactions).orderBy(transactions.id)).map((row) => row.entryType)).toEqual(["repayment", "repayment", "reversal", "reversal"]);
        expect((await db.select().from(intermediaryCollections).orderBy(intermediaryCollections.id)).map((row) => row.status)).toEqual(["reversed", "reversed"]);
    });

    integrationTest("requires a tenant admin and reason to manually approve one collection", async () => {
        await db.execute(sql`TRUNCATE TABLE audit_logs, intermediary_remittance_proposals,
            intermediary_remittance_allocations, intermediary_remittances, intermediary_collections,
            intermediaries, transactions, payment_intakes, loans, borrowers, users RESTART IDENTITY CASCADE`);
        const owner = await db.insert(users).values({ tenantId: "tenant-a", email: "manual-owner@example.test", role: "owner" }).returning().then((rows) => rows[0]!);
        const collector = await db.insert(users).values({ tenantId: owner.tenantId, email: "manual-collector@example.test", role: "collector" }).returning().then((rows) => rows[0]!);
        const borrower = await db.insert(borrowers).values({ tenantId: owner.tenantId, ownerUserId: owner.id, name: "Manual Borrower" }).returning().then((rows) => rows[0]!);
        const loan = await db.insert(loans).values({ tenantId: owner.tenantId, ownerUserId: owner.id, borrowerId: borrower.id, principalAmount: "5000.00", interestRate: "0.00", repaymentType: "floating", outstandingPrincipal: "5000.00", outstandingInterest: "0.00", outstandingFees: "0.00", status: "active" }).returning().then((rows) => rows[0]!);
        const base: CommandContext = { tenantId: owner.tenantId, actorUserId: owner.id, actorSource: "web", requestId: "req-manual", correlationId: "corr-manual" };
        const intermediary = await createIntermediary(base, { name: "Manual Collector" });
        const collection = await createIntermediaryCollection({ ...base, idempotencyKey: "manual-c-1" }, { intermediaryPublicId: intermediary.publicId, borrowerPublicId: borrower.publicId, loanPublicId: loan.publicId, amount: "75.00", borrowerPaidAt: "2026-08-07T14:51:00+07:00" });

        await expect(manualApproveIntermediaryCollection({ ...base, actorUserId: collector.id, idempotencyKey: "manual-post-denied" }, collection.publicId, { reason: "Cash exception", confirmed: true })).rejects.toMatchObject({ code: "TENANT_ADMIN_REQUIRED" });
        await expect(manualApproveIntermediaryCollection({ ...base, idempotencyKey: "manual-post-empty" }, collection.publicId, { reason: " ", confirmed: true })).rejects.toMatchObject({ code: "MANUAL_APPROVAL_REASON_REQUIRED" });
        const approved = await manualApproveIntermediaryCollection({ ...base, idempotencyKey: "manual-post-1" }, collection.publicId, { reason: "Verified directly with lender", confirmed: true });
        expect(approved).toMatchObject({ status: "manual_approved", amount: "75.00", borrowerPaidAt: "2026-08-07T07:51:00.000Z" });
        expect((await db.select().from(transactions))[0]?.transactionDate?.toISOString()).toBe("2026-08-07T07:51:00.000Z");

        const remittance = await createIntermediaryRemittance({ ...base, idempotencyKey: "manual-r-1" }, { intermediaryPublicId: intermediary.publicId, grossAmount: "75.00", receivedAt: "2026-08-11T09:00:00+07:00" });
        await expect(saveRemittanceAllocations(base, remittance.publicId, { collectionPublicIds: [collection.publicId] })).rejects.toMatchObject({ code: "INVALID_COLLECTION_SELECTION" });
    });
});
