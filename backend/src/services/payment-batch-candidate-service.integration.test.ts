import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { borrowers, loanSchedules, loans, transactions, users } from "../db/schema";
import type { CommandContext } from "./command-context";
import { createBorrower } from "./borrower-service";
import { stagePaymentBatchItems, reviewPaymentBatchStagingItem, preparePaymentBatchStagingEvidence, finalizePaymentBatchStagingEvidence } from "./payment-batch-service";
import type { EvidenceStorageGateway } from "./payment-service";
import { discoverPaymentBatchCandidates } from "./payment-batch-candidate-service";

const integration = process.env.TEST_DATABASE_URL ? test : test.skip;

integration("discovers accessible named borrower and backend contract candidates without financial writes", async () => {
    const tenantId = `candidate-discovery-${crypto.randomUUID()}`;
    const [user] = await db.insert(users).values({ tenantId, email: `${crypto.randomUUID()}@example.test`, role: "owner" }).returning();
    const ctx: CommandContext = { tenantId, actorUserId: user!.id, actorSource: "web", requestId: crypto.randomUUID(), correlationId: crypto.randomUUID() };
    const borrower = await createBorrower(ctx, { name: "Candidate Borrower" });
    const [activated] = await db.insert(loans).values({ tenantId, ownerUserId: user!.id, borrowerId: (await db.query.borrowers.findFirst({ where: eq(borrowers.publicId, borrower.publicId) }))!.id, principalAmount: "75.00", interestRate: "0.00", repaymentType: "daily", startDate: "2026-09-01", totalInstallments: 1, installmentAmount: "75.00", outstandingPrincipal: "50.00", outstandingInterest: "0.00", outstandingFees: "0.00", lateFeeMode: "fixed", lateFeeAmount: "5.00", gracePeriodDays: 0, status: "active" }).returning();
    await db.insert(loanSchedules).values({ tenantId, loanId: activated!.id, installmentNo: 1, dueDate: "2026-09-08", scheduledPrincipal: "75.00", scheduledInterest: "0.00", scheduledFee: "0.00", scheduledTotal: "75.00", paidTotal: "25.00", paidPenalty: "0.00", remainingDue: "50.00", status: "partial" });
    const staged = await stagePaymentBatchItems(ctx, { idempotencyKey: "candidate-stage", borrowerPublicId: borrower.publicId, items: [{ clientItemKey: "slip-1", payerName: "Candidate Borrower" }] });
    const stagingItemPublicId = staged.items[0]!.publicId;
    const heads = new Map<string, Awaited<ReturnType<EvidenceStorageGateway["head"]>>>();
    const gateway: EvidenceStorageGateway = {
        preparePut: async (request) => { heads.set(request.key, { exists: true, contentType: request.contentType, contentLength: request.contentLength, checksumSha256: request.checksumSha256, metadata: request.metadata ?? {} }); return { uploadUrl: "https://upload.invalid/candidate", expiresAt: new Date(Date.now() + 60_000), requiredHeaders: {} }; },
        head: async (key) => heads.get(key) ?? { exists: false, contentType: null, contentLength: null, checksumSha256: null, metadata: {} },
    };
    const evidence = await preparePaymentBatchStagingEvidence(ctx, { stagingItemPublicId, mimeType: "image/png", size: 3, sha256: "a".repeat(64) }, gateway);
    await finalizePaymentBatchStagingEvidence(ctx, stagingItemPublicId, evidence.evidencePublicId, gateway);
    await reviewPaymentBatchStagingItem(ctx, { stagingItemPublicId, amount: "75.00", receivedAt: "2026-09-09T17:00:00.000Z", intakeIdempotencyKey: "candidate-intake" });
    const result = await discoverPaymentBatchCandidates(ctx, { stagingItemPublicId });
    expect(result.stagingRevision).toBe(2);
    expect(result.batchRevision).toBe(2);
    expect(result.inputFingerprint).toMatch(/^v1:/);
    expect(result.borrowerCandidates).toHaveLength(1);
    expect(result.borrowerCandidates[0]).toMatchObject({ publicId: borrower.publicId, name: "Candidate Borrower", matchType: "canonical" });
    expect(result.contractCandidates).toEqual(expect.arrayContaining([
        expect.objectContaining({ borrowerPublicId: borrower.publicId, loanPublicId: expect.any(String), repaymentType: "daily", eligible: true, dueComponents: { principal: "50.00", interest: "0.00", fee: "0.00", penalty: "5.00" }, proposalComponents: null }),
    ]));
    expect(await db.select().from(transactions).where(eq(transactions.tenantId, tenantId))).toHaveLength(0);
});

integration("keeps ambiguous names and portfolio access boundaries without resolving or writing", async () => {
    const tenantId = `candidate-access-${crypto.randomUUID()}`;
    const [owner] = await db.insert(users).values({ tenantId, email: `${crypto.randomUUID()}@example.test`, role: "owner" }).returning();
    const [viewer] = await db.insert(users).values({ tenantId, email: `${crypto.randomUUID()}@example.test`, role: "viewer" }).returning();
    const ownerCtx: CommandContext = { tenantId, actorUserId: owner!.id, actorSource: "web", requestId: crypto.randomUUID(), correlationId: crypto.randomUUID() };
    const [first, second] = await Promise.all([createBorrower(ownerCtx, { name: "Ambiguous Candidate" }), createBorrower(ownerCtx, { name: "Ambiguous Candidate" })]);
    const staged = await stagePaymentBatchItems(ownerCtx, { idempotencyKey: "candidate-access-stage", items: [{ clientItemKey: "access-1", payerName: "Ambiguous Candidate" }] });
    const stagingItemPublicId = staged.items[0]!.publicId;
    const candidate = await discoverPaymentBatchCandidates(ownerCtx, { stagingItemPublicId, amount: "120.00", receivedAt: "2026-09-10T00:00:00.000Z" });
    expect(candidate.borrowerResolution).toBe("ambiguous");
    expect(candidate.borrowerCandidates.map((row) => row.publicId).sort()).toEqual([first.publicId, second.publicId].sort());
    const viewerCtx: CommandContext = { ...ownerCtx, actorUserId: viewer!.id, requestId: crypto.randomUUID(), correlationId: crypto.randomUUID() };
    await expect(discoverPaymentBatchCandidates(viewerCtx, { stagingItemPublicId, amount: "120.00", receivedAt: "2026-09-10T00:00:00.000Z" })).rejects.toMatchObject({ code: "PAYMENT_BATCH_NOT_FOUND" });
    const otherTenant = `candidate-other-${crypto.randomUUID()}`;
    const [otherOwner] = await db.insert(users).values({ tenantId: otherTenant, email: `${crypto.randomUUID()}@example.test`, role: "owner" }).returning();
    const otherCtx: CommandContext = { tenantId: otherTenant, actorUserId: otherOwner!.id, actorSource: "web", requestId: crypto.randomUUID(), correlationId: crypto.randomUUID() };
    const otherStage = await stagePaymentBatchItems(otherCtx, { idempotencyKey: "candidate-other-stage", items: [{ clientItemKey: "other-1", payerName: "Ambiguous Candidate" }] });
    await expect(discoverPaymentBatchCandidates(ownerCtx, { stagingItemPublicId: otherStage.items[0]!.publicId, amount: "120.00", receivedAt: "2026-09-10T00:00:00.000Z" })).rejects.toMatchObject({ code: "PAYMENT_BATCH_STAGING_NOT_FOUND" });
    expect(await db.select().from(transactions).where(eq(transactions.tenantId, tenantId))).toHaveLength(0);
});
