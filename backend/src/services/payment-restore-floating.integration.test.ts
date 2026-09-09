import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { borrowers, loanInterestAccruals, loanInterestRatePeriods, loans, paymentEvidence, paymentIntakes, transactions, users } from "../db/schema";
import { createPaymentIntake, finalizePaymentRestoreEvidence, postPayment, preparePaymentRestoreEvidence, previewPaymentMatch, reversePayment, type EvidenceStorageGateway } from "./payment-service";
import { createPaymentRestoreDraft, executePaymentReconciliation, previewPaymentRestore } from "./payment-reconciliation-service";
import type { CommandContext } from "./command-context";

const integration = process.env.TEST_DATABASE_URL ? test : test.skip;
async function fixture(withPrincipal = false, withPenalty = false) {
    const tenantId = `restore-floating-${crypto.randomUUID()}`;
    const [actor] = await db.insert(users).values({ tenantId, email: `${crypto.randomUUID()}@example.test`, role: "owner" }).returning();
    const [borrower] = await db.insert(borrowers).values({ tenantId, ownerUserId: actor!.id, name: "Synthetic floating restore borrower" }).returning();
    const ctx: CommandContext = { tenantId, actorUserId: actor!.id, actorSource: "web", requestId: crypto.randomUUID(), correlationId: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() };
    const [loan] = await db.insert(loans).values({ tenantId, ownerUserId: actor!.id, borrowerId: borrower!.id, principalAmount: "10000.00", interestRate: "0.00", repaymentType: "floating", dailyInterestMode: "percent", dailyInterestRate: "1.0000", firstDayTreatment: "start_next_day", interestStartDate: "2026-09-06", interestPeriodUnit: "day", interestPeriodLength: 1, advanceInterestPeriods: 0, advanceInterestRefundPolicy: "non_refundable", interestPeriodAnchorDate: "2026-09-06", floatingAccrualCycle: "daily", outstandingPrincipal: "10000.00", outstandingInterest: "0.00", outstandingFees: "0.00", lateFeeMode: withPenalty ? "daily_percent" : "none", lateFeeAmount: withPenalty ? "1.00" : "0.00", gracePeriodDays: 0, status: "active" }).returning();
    await db.insert(loanInterestRatePeriods).values({ tenantId, loanId: loan!.id, effectiveDate: "2026-09-06", rateType: "percent", rate: "1.0000", periodUnit: "day", periodLength: 1, createdByUserId: actor!.id });
    const intake = await createPaymentIntake(ctx, { amount: withPrincipal ? "300.00" : "100.00", receivedAt: withPenalty ? "2026-09-08T03:00:00Z" : "2026-09-07T03:00:00Z" });
    const proposal = await previewPaymentMatch(ctx, intake.publicId, { allocations: (withPrincipal ? ["140.00", "160.00"] : ["40.00", "60.00"]).map((amount) => ({ borrowerPublicId: borrower!.publicId, loanPublicId: loan!.publicId, amount })) });
    const posted = await postPayment(ctx, intake.publicId, { proposalPublicId: proposal.publicId });
    expect(posted.transactions.map((row: { interestComponent: string }) => row.interestComponent)).toEqual(withPrincipal ? ["100.00", "0.00"] : [withPenalty ? "39.00" : "40.00", "60.00"]);
    await reversePayment(ctx, intake.publicId, { reason: "Synthetic mistaken reversal" });
    const draft = await createPaymentRestoreDraft(ctx, { paymentIntakePublicId: intake.publicId, reason: "Restore synthetic payment", idempotencyKey: "restore-draft" });
    const heads = new Map<string, Awaited<ReturnType<EvidenceStorageGateway["head"]>>>();
    const gateway: EvidenceStorageGateway = {
        preparePut: async (request) => {
            heads.set(request.key, { exists: true, contentType: request.contentType, contentLength: request.contentLength, checksumSha256: request.checksumSha256, metadata: request.metadata ?? {} });
            return { uploadUrl: "https://upload.invalid/restore", expiresAt: new Date(Date.now() + 60000), requiredHeaders: {} };
        },
        head: async (key) => heads.get(key) ?? { exists: false, contentType: null, contentLength: null, checksumSha256: null, metadata: {} },
    };
    const evidence = await preparePaymentRestoreEvidence(ctx, draft.restoreDraftPublicId, { mimeType: "image/png", size: 32, sha256: "d".repeat(64) }, gateway);
    await finalizePaymentRestoreEvidence(ctx, draft.restoreDraftPublicId, evidence.evidencePublicId, gateway);
    return { ctx, intake, draft, borrower: borrower!, loan: loan!, evidence, gateway };
}

integration("restore preserves two source interest allocations on one loan and uses newly uploaded child evidence", async () => {
    const f = await fixture();
    const preview = await previewPaymentRestore(f.ctx, { paymentIntakePublicId: f.intake.publicId, reason: "Restore synthetic payment" });
    const input = { previewHash: preview.previewHash, expectedBalanceVersion: preview.expectedBalanceVersion, confirmed: true as const, reason: preview.reason, idempotencyKey: "restore-execute" };
    const result = await executePaymentReconciliation(f.ctx, preview.publicId, input);
    expect(result.postedPaymentPublicId).toBe(f.draft.restoreDraftPublicId);
    expect(await executePaymentReconciliation({ ...f.ctx, correlationId: crypto.randomUUID() }, preview.publicId, input)).toEqual(result);
    const child = await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.publicId, f.draft.restoreDraftPublicId) });
    const posted = await db.select().from(transactions).where(eq(transactions.paymentIntakeId, child!.id)).orderBy(transactions.id);
    expect(posted.map((row) => row.interestComponent)).toEqual(["40.00", "60.00"]);
    expect(await db.select().from(paymentEvidence).where(eq(paymentEvidence.paymentIntakeId, child!.id))).toHaveLength(1);
    expect((await db.select().from(loanInterestAccruals).where(eq(loanInterestAccruals.loanId, f.loan.id))).filter((row) => row.status !== "reversed").map((row) => row.paidAmount)).toEqual(["100.00"]);
});

integration("restore rejects a changed child evidence set after preview", async () => {
    const f = await fixture();
    const preview = await previewPaymentRestore(f.ctx, { paymentIntakePublicId: f.intake.publicId, reason: "Restore synthetic payment" });
    const added = await preparePaymentRestoreEvidence(f.ctx, f.draft.restoreDraftPublicId, { mimeType: "image/png", size: 32, sha256: "e".repeat(64) }, f.gateway);
    await finalizePaymentRestoreEvidence(f.ctx, f.draft.restoreDraftPublicId, added.evidencePublicId, f.gateway);
    await expect(executePaymentReconciliation(f.ctx, preview.publicId, { previewHash: preview.previewHash, expectedBalanceVersion: preview.expectedBalanceVersion, confirmed: true, reason: preview.reason, idempotencyKey: "stale-restore" })).rejects.toThrow("preview");
});

integration("restore aggregates principal across source transactions before checking capacity", async () => {
    const f = await fixture(true);
    // Each source component (40 and 160) fits separately, but their total does not.
    await db.update(loans).set({ outstandingPrincipal: "180.00" }).where(eq(loans.id, f.loan.id));
    await expect(previewPaymentRestore(f.ctx, { paymentIntakePublicId: f.intake.publicId, reason: "Restore synthetic payment" })).rejects.toMatchObject({ code: "RECONCILIATION_RESTORE_CAPACITY_CONFLICT" });
});

integration("restore rechecks principal capacity at execute without posting the child", async () => {
    const f = await fixture(true);
    const preview = await previewPaymentRestore(f.ctx, { paymentIntakePublicId: f.intake.publicId, reason: "Restore synthetic payment" });
    await db.update(loans).set({ outstandingPrincipal: "180.00" }).where(eq(loans.id, f.loan.id));
    await expect(executePaymentReconciliation(f.ctx, preview.publicId, { previewHash: preview.previewHash, expectedBalanceVersion: preview.expectedBalanceVersion, confirmed: true, reason: preview.reason, idempotencyKey: "capacity-changed" })).rejects.toMatchObject({ code: "RECONCILIATION_RESTORE_CAPACITY_CONFLICT" });
    const child = await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.publicId, f.draft.restoreDraftPublicId) });
    expect(child?.status).toBe("draft");
    expect(await db.select().from(transactions).where(eq(transactions.paymentIntakeId, child!.id))).toHaveLength(0);
});

integration("restore preview rejects inactive targets consistently with execute", async () => {
    const f = await fixture();
    await db.update(loans).set({ status: "paid" }).where(eq(loans.id, f.loan.id));
    await expect(previewPaymentRestore(f.ctx, { paymentIntakePublicId: f.intake.publicId, reason: "Restore synthetic payment" })).rejects.toMatchObject({ code: "INVALID_RECONCILIATION_TARGET" });
});

integration("restore blocks floating penalties until exact penalty provenance replay is supported", async () => {
    const f = await fixture(false, true);
    await expect(previewPaymentRestore(f.ctx, { paymentIntakePublicId: f.intake.publicId, reason: "Restore synthetic payment" })).rejects.toMatchObject({ code: "RECONCILIATION_RESTORE_PROVENANCE_UNSUPPORTED" });
});
