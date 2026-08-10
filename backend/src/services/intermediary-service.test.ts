import { beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { db } from "../db";
import { borrowers, intermediaries, intermediaryCollections, loans, transactions, users } from "../db/schema";
import type { CommandContext } from "./command-context";
import { createIntermediary, createIntermediaryCollection, createIntermediaryRemittance, normalizeIntermediaryText, postIntermediaryRemittance, previewIntermediaryRemittance, saveRemittanceAllocations } from "./intermediary-service";

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
    });
});
