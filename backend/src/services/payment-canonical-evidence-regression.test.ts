import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db, type DbExecutor } from "../db";
import { auditLogs, borrowers, files, financialEvidenceRequirements, financialEvidenceRequirementAttempts, loanSchedules, loans, paymentDuplicateReviewCandidates, paymentEvidence, paymentEvidenceSupplements, paymentIntakes, transactions, users } from "../db/schema";
import type { CommandContext } from "./command-context";
import { createPaymentIntake, postPayment, previewPaymentMatch } from "./payment-service";
import { cancelPaymentIntake, getPaymentCancellationCapability } from "./payment-cancellation-service";
import { executePaymentDuplicateReview, previewPaymentDuplicateReview, reviewAuthorizesPair } from "./payment-duplicate-review-service";
import { createPaymentReplacement, inspectPaymentReplacement } from "./payment-replacement-service";

const integration = process.env.TEST_DATABASE_URL ? test : test.skip;
const tenantId = "canonical-evidence-regression";
type Actor = { id: number };
const ctx = (owner: Actor): CommandContext => ({ tenantId, actorUserId: owner.id, actorSource: "web", requestId: crypto.randomUUID(), correlationId: crypto.randomUUID() });
const hash = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex");
async function reset() { await db.execute(sql`TRUNCATE users CASCADE`); return (await db.insert(users).values({ tenantId, email: `${crypto.randomUUID()}@test.invalid`, role: "owner" }).returning())[0]!; }
async function file(owner: Actor) { return (await db.insert(files).values({ tenantId, ownerUserId: owner.id, bucket: "synthetic", key: crypto.randomUUID(), originalName: "synthetic.png", mimeType: "image/png", size: 20, url: "storage:synthetic" }).returning())[0]!; }
async function receipt(owner: Actor, expected?: number, evidence: "none" | "ready" | "pending" | "rejected" = "none") {
    const intake = await createPaymentIntake(ctx(owner), { amount: "200.00", receivedAt: "2026-09-21T12:05:00.000Z", payerName: "Synthetic Exact Payer", ...(expected === undefined ? {} : { attachmentRequirement: { expectedCount: expected } }) });
    const row = (await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.publicId, intake.publicId) }))!;
    if (evidence !== "none") await db.insert(paymentEvidence).values({ tenantId, paymentIntakeId: row.id, fileId: (await file(owner)).id, status: evidence, evidenceType: "slip", evidenceHash: hash(row.publicId), mimeType: "image/png", declaredSize: 20, finalizedAt: evidence === "ready" ? new Date() : null, createdByUserId: owner.id, updatedByUserId: owner.id });
    if (expected === 2 && evidence === "ready") await db.insert(paymentEvidence).values({ tenantId, paymentIntakeId: row.id, fileId: (await file(owner)).id, status: "ready", evidenceType: "slip", evidenceHash: hash(`${row.publicId}-second`), mimeType: "image/png", declaredSize: 20, finalizedAt: new Date(), createdByUserId: owner.id, updatedByUserId: owner.id });
    const capability = await getPaymentCancellationCapability(ctx(owner), intake.publicId);
    await cancelPaymentIntake(ctx(owner), intake.publicId, { reason: "synthetic duplicate correction", idempotencyKey: crypto.randomUUID(), expectedStateHash: capability.stateHash });
    return (await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.id, row.id) }))!;
}
async function fixture(expected = 1, evidence: "none" | "ready" | "pending" | "rejected" = "none") { const owner = await reset(); return { owner, source: await receipt(owner, 1, "ready"), candidate: await receipt(owner, expected, evidence) }; }
type Fixture = Awaited<ReturnType<typeof fixture>>;
function command(f: Fixture) { return { canonicalPaymentIntakePublicId: f.source.publicId, candidatePaymentIntakePublicIds: [f.candidate.publicId], canonicalEvidenceCandidatePublicIds: [f.candidate.publicId], reason: "explicit synthetic same receipt confirmation", idempotencyKey: crypto.randomUUID() }; }
function execution(p: Awaited<ReturnType<typeof previewPaymentDuplicateReview>>) { return { duplicateReviewPublicId: p.duplicateReviewPublicId, previewHash: p.previewHash, confirmed: true as const, reason: "explicit synthetic confirmation", idempotencyKey: crypto.randomUUID() }; }
// Simulate historical/storage drift exclusively inside the disposable test database.
async function drift(write: (tx: DbExecutor) => Promise<unknown>) {
    if (!process.env.TEST_DATABASE_URL) throw new Error("Disposable database required");
    return db.transaction(async tx => { await tx.execute(sql`SET LOCAL session_replication_role = replica`); await write(tx); });
}
async function attempt(f: Fixture) {
    const requirement = (await db.query.financialEvidenceRequirements.findFirst({ where: eq(financialEvidenceRequirements.paymentIntakeId, f.candidate.id) }))!;
    await drift(async tx => await tx.insert(financialEvidenceRequirementAttempts).values({ tenantId, financialEvidenceRequirementId: requirement.id, attemptKey: crypto.randomUUID(), source: "synthetic", requestId: crypto.randomUUID(), correlationId: crypto.randomUUID(), createdByUserId: f.owner.id }));
}
async function execute(f: Fixture) { const p = await previewPaymentDuplicateReview(ctx(f.owner), command(f)); await executePaymentDuplicateReview(ctx(f.owner), execution(p)); return p; }

describe("explicit cancelled duplicate canonical evidence policy", () => {
    integration("retains strict default and never mutates cancellation, evidence declarations or money during review", async () => {
        const f = await fixture(); const input = command(f);
        const requirements = await db.select().from(financialEvidenceRequirements);
        const originalEvidence = await db.select().from(paymentEvidence);
        await expect(previewPaymentDuplicateReview(ctx(f.owner), { ...input, canonicalEvidenceCandidatePublicIds: undefined })).rejects.toMatchObject({ code: "PAYMENT_DUPLICATE_REVIEW_CANDIDATE_EVIDENCE_INCOMPLETE" });
        const p = await previewPaymentDuplicateReview(ctx(f.owner), input);
        expect(p.canonicalEvidenceCandidatePublicIds).toEqual([f.candidate.publicId]);
        expect(await previewPaymentDuplicateReview(ctx(f.owner), input)).toEqual(p);
        const e = execution(p); const executed = await executePaymentDuplicateReview(ctx(f.owner), e);
        expect(await executePaymentDuplicateReview(ctx(f.owner), e)).toEqual(executed);
        expect(await db.select().from(transactions)).toHaveLength(0);
        expect(await db.select().from(financialEvidenceRequirements)).toEqual(requirements);
        expect(await db.select().from(paymentEvidence)).toEqual(originalEvidence);
        expect(await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.id, f.source.id) })).toEqual(f.source);
        expect(await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.id, f.candidate.id) })).toEqual(f.candidate);
        await expect(previewPaymentDuplicateReview(ctx(f.owner), { ...input, canonicalEvidenceCandidatePublicIds: [] })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
        await expect((async () => await db.update(paymentDuplicateReviewCandidates).set({ usesCanonicalEvidence: false }))()).rejects.toThrow();
        await expect((async () => await db.delete(paymentDuplicateReviewCandidates))()).rejects.toThrow();
    });
    for (const kind of ["unknown", "canonical", "duplicate", "noncandidate", "foreign"] as const) integration(`rejects ${kind} selection`, async () => {
        const f = await fixture(); let ids: Array<typeof f.candidate.publicId> = [crypto.randomUUID() as typeof f.candidate.publicId];
        if (kind === "canonical") ids = [f.source.publicId];
        if (kind === "duplicate") ids = [f.candidate.publicId, f.candidate.publicId];
        if (kind === "noncandidate") ids = [(await receipt(f.owner, 1)).publicId];
        if (kind === "foreign") { const foreign = (await db.insert(users).values({ tenantId: "other-canonical-tenant", email: `${crypto.randomUUID()}@test.invalid`, role: "owner" }).returning())[0]!; ids = [(await createPaymentIntake({ ...ctx(foreign), tenantId: "other-canonical-tenant" }, { amount: "200.00", receivedAt: "2026-09-21T12:05:00.000Z", payerName: "Foreign" })).publicId]; }
        await expect(previewPaymentDuplicateReview(ctx(f.owner), { ...command(f), canonicalEvidenceCandidatePublicIds: ids })).rejects.toMatchObject({ code: "PAYMENT_DUPLICATE_REVIEW_CANONICAL_EVIDENCE_SELECTION_INVALID" });
    });
    for (const status of ["pending", "rejected", "ready"] as const) integration(`rejects selected candidate with ${status} direct evidence`, async () => {
        const f = await fixture(1, status);
        await expect(previewPaymentDuplicateReview(ctx(f.owner), command(f))).rejects.toThrow();
    });
    integration("rejects a candidate with two declared attachments", async () => { const f = await fixture(2); await expect(previewPaymentDuplicateReview(ctx(f.owner), command(f))).rejects.toMatchObject({ code: "PAYMENT_DUPLICATE_REVIEW_CANONICAL_EVIDENCE_CANDIDATE_INVALID" }); });
    integration("rejects candidate with an attempt but no evidence", async () => { const f = await fixture(); await attempt(f); await expect(previewPaymentDuplicateReview(ctx(f.owner), command(f))).rejects.toThrow(); });
    for (const status of ["draft", "ready", "recorded"] as const) integration(`rejects candidate with ${status} supplemental evidence`, async () => {
        const f = await fixture();
        const audit = status === "recorded" ? (await db.insert(auditLogs).values([{ tenantId, entityType: "payment_evidence_supplement", entityId: f.candidate.publicId, action: "record", actorUserId: f.owner.id, actorSource: "web", correlationId: crypto.randomUUID() }]).returning())[0] : null;
        await db.insert(paymentEvidenceSupplements).values({ tenantId, paymentIntakeId: f.candidate.id, fileId: (await file(f.owner)).id, status, evidenceHash: status === "draft" ? null : hash(crypto.randomUUID()), mimeType: status === "draft" ? null : "image/png", declaredSize: status === "draft" ? null : 20, ...(status === "recorded" ? { reason: "evidence_recovered", recordIdempotencyKey: crypto.randomUUID(), auditPublicId: audit!.publicId, recordedByUserId: f.owner.id } : {}), importIdempotencyKey: crypto.randomUUID(), sourceFileFingerprint: hash(crypto.randomUUID()), correlationId: crypto.randomUUID(), createdByUserId: f.owner.id, readyAt: status !== "draft" ? new Date() : null, recordedAt: status === "recorded" ? new Date() : null });
        await expect(previewPaymentDuplicateReview(ctx(f.owner), command(f))).rejects.toThrow();
    });
    integration("rejects incomplete canonical receipt", async () => { const owner = await reset(); const f = { owner, source: await receipt(owner, 1), candidate: await receipt(owner, 1) }; await expect(previewPaymentDuplicateReview(ctx(owner), command(f))).rejects.toMatchObject({ code: "PAYMENT_DUPLICATE_REVIEW_CANONICAL_EVIDENCE_INCOMPLETE" }); });
    integration("executes multiple selected candidates regardless of supplied selection order", async () => {
        const f = await fixture(); const b = await receipt(f.owner, 1); const ids = [f.candidate.publicId, b.publicId].sort().reverse();
        const p = await previewPaymentDuplicateReview(ctx(f.owner), { ...command(f), candidatePaymentIntakePublicIds: ids, canonicalEvidenceCandidatePublicIds: ids });
        expect((await executePaymentDuplicateReview(ctx(f.owner), execution(p))).status).toBe("executed");
    });
    integration("rejects newly attempted evidence between preview and execution", async () => { const f = await fixture(); const p = await previewPaymentDuplicateReview(ctx(f.owner), command(f)); await attempt(f); await expect(executePaymentDuplicateReview(ctx(f.owner), execution(p))).rejects.toThrow(); });
    integration("revokes replacement eligibility when candidate requirement increases after execution", async () => {
        const f = await fixture(); await execute(f);
        await drift(async tx => await tx.update(financialEvidenceRequirements).set({ expectedCount: 2 }).where(eq(financialEvidenceRequirements.paymentIntakeId, f.candidate.id)));
        expect(await reviewAuthorizesPair(ctx(f.owner), f.source.id, f.candidate.id, db)).toBe(false);
        expect((await inspectPaymentReplacement(ctx(f.owner), f.source.publicId)).allowed).toBe(false);
    });
    integration("rejects posting a ready replacement after new candidate attempt, with no repayment side effects", async () => {
        const f = await fixture(); await execute(f);
        const b = (await db.insert(borrowers).values({ tenantId, ownerUserId: f.owner.id, name: "Synthetic borrower" }).returning())[0]!;
        const loan = (await db.insert(loans).values({ tenantId, ownerUserId: f.owner.id, borrowerId: b.id, principalAmount: "200.00", interestRate: "0.00", repaymentType: "monthly", outstandingPrincipal: "200.00", outstandingInterest: "0.00", outstandingFees: "0.00", status: "active" }).returning())[0]!;
        const schedules = await db.insert(loanSchedules).values(["2026-09-20", "2026-09-21"].map((dueDate, i) => ({ tenantId, loanId: loan.id, installmentNo: i + 1, dueDate, scheduledPrincipal: "100.00", scheduledInterest: "0.00", scheduledFee: "0.00", scheduledTotal: "100.00", paidTotal: "0.00", paidPenalty: "0.00", remainingDue: "100.00", status: "pending" }))).returning();
        const capability = await inspectPaymentReplacement(ctx(f.owner), f.source.publicId);
        const replacement = await createPaymentReplacement(ctx(f.owner), { paymentIntakePublicId: f.source.publicId, reason: "synthetic correction", idempotencyKey: crypto.randomUUID(), expectedStateHash: capability.stateHash });
        const p = await previewPaymentMatch(ctx(f.owner), replacement.replacementPaymentIntakePublicId, { allocations: schedules.map(s => ({ borrowerPublicId: b.publicId, loanPublicId: loan.publicId, schedulePublicId: s.publicId, amount: "100.00" })) });
        expect(p.status).toBe("ready");
        await attempt(f);
        await expect(postPayment(ctx(f.owner), replacement.replacementPaymentIntakePublicId, { proposalPublicId: p.publicId })).rejects.toThrow();
        expect(await db.select().from(transactions)).toHaveLength(0);
        expect((await db.select().from(loanSchedules)).every(s => s.paidTotal === "0.00")).toBe(true);
    });
    integration("preserves original request and preview digests for pre-upgrade empty selections", async () => {
        const owner = await reset(); const source = await receipt(owner, 1, "ready"); const candidate = await receipt(owner); const input = { canonicalPaymentIntakePublicId: source.publicId, candidatePaymentIntakePublicIds: [candidate.publicId], reason: "legacy", idempotencyKey: crypto.randomUUID() };
        const p = await previewPaymentDuplicateReview(ctx(owner), input);
        const requestHash = hash({ canonical: source.publicId, candidates: [candidate.publicId], reason: input.reason, idempotencyKey: input.idempotencyKey });
        const candidateStateHash = [hash({ id: candidate.publicId, status: candidate.status, amount: candidate.amount, receivedAt: candidate.receivedAt.toISOString(), payerName: "synthetic exact payer", warning: candidate.warnings ?? null })];
        expect(p.previewHash).toBe(hash({ requestHash, canonicalStateHash: p.canonicalStateHash, candidateStateHash, evidenceHash: p.evidenceHash, dependencyHash: p.dependencyHash }));
        expect((await executePaymentDuplicateReview(ctx(owner), execution(p))).status).toBe("executed");
        expect(await previewPaymentDuplicateReview(ctx(owner), { ...input, canonicalEvidenceCandidatePublicIds: [] })).toEqual(p);
    });
    integration("preserves legacy multi-evidence reviews but rejects selecting that canonical", async () => {
        const owner = await reset(); const source = await receipt(owner, 2, "ready"); const candidate = await receipt(owner);
        const p = await previewPaymentDuplicateReview(ctx(owner), { canonicalPaymentIntakePublicId: source.publicId, candidatePaymentIntakePublicIds: [candidate.publicId], reason: "legacy multiple evidence", idempotencyKey: crypto.randomUUID() });
        expect((await executePaymentDuplicateReview(ctx(owner), execution(p))).status).toBe("executed");
        expect(await reviewAuthorizesPair(ctx(owner), source.id, candidate.id, db)).toBe(true);
        const f = await fixture(); const two = await receipt(f.owner, 2, "ready");
        await expect(previewPaymentDuplicateReview(ctx(f.owner), { ...command(f), canonicalPaymentIntakePublicId: two.publicId })).rejects.toMatchObject({ code: "PAYMENT_DUPLICATE_REVIEW_CANONICAL_EVIDENCE_INCOMPLETE" });
    });
    integration("requires exactly one explicit candidate declaration", async () => {
        const owner = await reset(); const f = { owner, source: await receipt(owner, 1, "ready"), candidate: await receipt(owner) };
        await expect(previewPaymentDuplicateReview(ctx(owner), command(f))).rejects.toMatchObject({ code: "PAYMENT_DUPLICATE_REVIEW_CANONICAL_EVIDENCE_CANDIDATE_INVALID" });
    });

});
