import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, type DbExecutor } from "../db";
import { financialEvidenceRequirements, paymentDuplicateReviewCandidates, paymentDuplicateReviewExecutions, paymentDuplicateReviewMemberships, paymentDuplicateReviews, paymentEvidenceSupplements, paymentIntakes, paymentReplacementLineages, users } from "../db/schema";
import { canAccessTenantWideData } from "../lib/access";
import { createAuditLog } from "../lib/audit-log";
import type { CommandContext } from "./command-context";
import { DomainError } from "./domain-error";
import { countAuthoritativeEvidenceAttempts } from "./financial-evidence-requirement-service";
import { effectivePaymentEvidence } from "./payment-effective-evidence-service";
import { normalizeBorrowerText } from "./borrower-service";
import { withPaymentWorkflowTransaction } from "./payment-workflow-locks";

type Executor = DbExecutor;
const operatorRoles = new Set(["owner", "manager", "collector"]);
const reviewTtlMs = 15 * 60 * 1000;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function actor(ctx: CommandContext, executor: Executor) {
    const user = ctx.actorUserId === null ? null : await executor.query.users.findFirst({ where: and(eq(users.tenantId, ctx.tenantId), eq(users.id, ctx.actorUserId)) });
    if (!user || !operatorRoles.has(user.role ?? "viewer")) throw new DomainError("PAYMENT_DUPLICATE_REVIEW_FORBIDDEN", "Only a financial operator may review cancelled duplicates", 403);
    return user;
}

async function intake(ctx: CommandContext, publicId: string, executor: Executor) {
    const user = await actor(ctx, executor);
    const row = await executor.query.paymentIntakes.findFirst({ where: and(eq(paymentIntakes.tenantId, ctx.tenantId), eq(paymentIntakes.publicId, publicId)) });
    if (!row || (!canAccessTenantWideData({ role: user.role ?? "viewer" }) && row.ownerUserId !== user.id)) throw new DomainError("PAYMENT_INTAKE_NOT_FOUND", "Payment intake not found", 404);
    return row;
}

async function dependencies(ctx: CommandContext, ids: number[], executor: Executor) {
    if (!ids.length) return [] as string[];
    const result = await executor.execute(sql`
        SELECT 'transaction' AS kind, payment_intake_id::text AS intake_id FROM transactions WHERE tenant_id = ${ctx.tenantId} AND payment_intake_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
        UNION ALL SELECT 'reconciliation_proposal', payment_intake_id::text FROM payment_reconciliation_proposals WHERE tenant_id = ${ctx.tenantId} AND payment_intake_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
        UNION ALL SELECT 'reconciliation_group', payment_intake_id::text FROM payment_reconciliation_groups WHERE tenant_id = ${ctx.tenantId} AND (payment_intake_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)}) OR posted_intake_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)}))
        UNION ALL SELECT 'allocation_correction', payment_intake_id::text FROM payment_allocation_correction_groups WHERE tenant_id = ${ctx.tenantId} AND payment_intake_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
        UNION ALL SELECT 'active_batch', bi.payment_intake_id::text FROM payment_batch_items bi JOIN payment_batches b ON b.tenant_id = bi.tenant_id AND b.id = bi.batch_id WHERE bi.tenant_id = ${ctx.tenantId} AND bi.payment_intake_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)}) AND b.status <> 'cancelled'
    `);
    return result.map((row) => `${String(row.kind)}:${String(row.intake_id)}`);
}

async function evidenceHash(ctx: CommandContext, id: number, executor: Executor) {
    const evidence = (await effectivePaymentEvidence(ctx.tenantId, [id], executor)).get(id) ?? [];
    const requirement = await executor.query.financialEvidenceRequirements.findFirst({ where: and(eq(financialEvidenceRequirements.tenantId, ctx.tenantId), eq(financialEvidenceRequirements.paymentIntakeId, id)) });
    const attempts = requirement ? await countAuthoritativeEvidenceAttempts(executor, ctx.tenantId, requirement.id, { kind: "payment", paymentIntakeId: id }) : 0;
    const expectedCount = requirement?.expectedCount ?? 0;
    const expected = Math.max(expectedCount, evidence.length, attempts);
    const ready = evidence.filter((row) => row.status === "ready" && row.finalizedAt !== null && row.fileId !== null);
    return { expected, expectedCount, effectiveEvidenceCount: evidence.length, attempts, ready, hash: digest({ expected, attempts, evidence: evidence.map((row) => ({ id: row.sourceEvidenceId, status: row.status, hash: row.evidenceHash ?? null, finalizedAt: row.finalizedAt?.toISOString() ?? null, fileId: row.fileId })).sort((a, b) => a.id - b.id) }) };
}

function canonicalSnapshot(row: typeof paymentIntakes.$inferSelect) {
    return digest({ id: row.publicId, status: row.status, amount: row.amount, receivedAt: row.receivedAt.toISOString(), payerName: normalizeBorrowerText(row.payerName ?? ""), cancellation: [row.cancelledAt?.toISOString(), row.cancellationAuditPublicId, row.cancellationRequestHash] });
}
function candidateSnapshot(row: typeof paymentIntakes.$inferSelect) {
    return digest({ id: row.publicId, status: row.status, amount: row.amount, receivedAt: row.receivedAt.toISOString(), payerName: normalizeBorrowerText(row.payerName ?? ""), warning: row.warnings ?? null });
}
async function participantEvidenceHash(ctx: CommandContext, canonical: typeof paymentIntakes.$inferSelect, candidates: Array<typeof paymentIntakes.$inferSelect>, canonicalEvidenceCandidatePublicIds: ReadonlySet<string>, executor: Executor) {
    const canonicalEvidence = await evidenceHash(ctx, canonical.id, executor);
    const candidateEvidence = await Promise.all(candidates.map((candidate) => evidenceHash(ctx, candidate.id, executor)));
    const canonicalReadyHashes = new Set(canonicalEvidence.ready.map((row) => row.evidenceHash ?? ""));
    if (candidateEvidence.some((item) => item.ready.length > 0 && (item.ready.length !== canonicalEvidence.ready.length || item.ready.some((row) => !canonicalReadyHashes.has(row.evidenceHash ?? ""))))) throw new DomainError("PAYMENT_DUPLICATE_REVIEW_HARD_IDENTITY_CONFLICT", "A duplicate candidate has conflicting finalized evidence", 409);
    const incomplete = candidateEvidence.find((item, index) => {
        const candidate = candidates[index]!;
        if (canonicalEvidenceCandidatePublicIds.has(candidate.publicId)) {
            if (item.expectedCount !== 1 || item.effectiveEvidenceCount !== 0 || item.attempts !== 0) throw new DomainError("PAYMENT_DUPLICATE_REVIEW_CANONICAL_EVIDENCE_CANDIDATE_INVALID", "A canonical-evidence candidate must declare exactly one requirement without evidence or attempts", 409);
            return false;
        }
        return item.expected > 0 && item.ready.length !== item.expected;
    });
    if (incomplete) throw new DomainError("PAYMENT_DUPLICATE_REVIEW_CANDIDATE_EVIDENCE_INCOMPLETE", "A duplicate candidate has incomplete finalized evidence", 409);
    const selected = [...canonicalEvidenceCandidatePublicIds].sort();
    return { canonicalEvidence, candidateEvidence, hash: digest({ canonical: canonicalEvidence.hash, candidates: candidateEvidence.map((item) => item.hash).sort(), ...(selected.length ? { canonicalEvidenceCandidatePublicIds: selected, snapshots: { canonical: { expectedCount: canonicalEvidence.expectedCount, effectiveEvidenceCount: canonicalEvidence.effectiveEvidenceCount, attempts: canonicalEvidence.attempts }, candidates: candidateEvidence.map((item, index) => ({ publicId: candidates[index]!.publicId, expectedCount: item.expectedCount, effectiveEvidenceCount: item.effectiveEvidenceCount, attempts: item.attempts })).sort((a, b) => a.publicId.localeCompare(b.publicId)) } } : {}) }) };
}
async function relevantDependencyHash(ctx: CommandContext, ids: number[], executor: Executor) {
    const deps = await dependencies(ctx, ids, executor);
    return { deps, hash: digest({ dependencies: deps }) };
}
async function supplementRows(ctx: CommandContext, intakeIds: number[], executor: Executor) {
    if (!intakeIds.length) return [];
    return executor.select({ intakeId: paymentEvidenceSupplements.paymentIntakeId, status: paymentEvidenceSupplements.status }).from(paymentEvidenceSupplements).where(and(eq(paymentEvidenceSupplements.tenantId, ctx.tenantId), inArray(paymentEvidenceSupplements.paymentIntakeId, intakeIds)));
}

function cancellationProvenance(row: typeof paymentIntakes.$inferSelect) {
    return row.status === "cancelled" && row.cancelledAt !== null && row.cancellationAuditPublicId !== null && !!row.cancellationReason?.trim() && !!row.cancellationRequestId?.trim() && !!row.cancellationCorrelationId?.trim() && !!row.cancellationIdempotencyKey?.trim() && !!row.cancellationRequestHash;
}
function hasExactCanonicalEvidence(snapshot: Awaited<ReturnType<typeof evidenceHash>>) {
    return snapshot.expected === 1 && snapshot.effectiveEvidenceCount === 1 && snapshot.ready.length === 1;
}

export type DuplicateReviewPreview = {
    duplicateReviewPublicId: string;
    status: "previewed";
    canonicalPaymentIntakePublicId: string;
    candidatePaymentIntakePublicIds: string[];
    canonicalEvidenceCandidatePublicIds: string[];
    previewHash: string;
    canonicalStateHash: string;
    evidenceHash: string;
    dependencyHash: string;
    expiresAt: string;
    auditPublicId: string;
    correlationId: string;
};

export async function previewPaymentDuplicateReview(ctx: CommandContext, input: { canonicalPaymentIntakePublicId: string; candidatePaymentIntakePublicIds: string[]; canonicalEvidenceCandidatePublicIds?: string[]; reason: string; idempotencyKey: string }, executor?: Executor): Promise<DuplicateReviewPreview> {
    if (!input.reason?.trim() || !input.idempotencyKey?.trim() || !input.candidatePaymentIntakePublicIds?.length || input.candidatePaymentIntakePublicIds.length > 50) throw new DomainError("PAYMENT_DUPLICATE_REVIEW_COMMAND_INVALID", "Canonical intake, bounded candidates, reason, and idempotency key are required", 400);
    const run = async (tx: Executor) => {
        const user = await actor(ctx, tx);
        let canonical = await intake(ctx, input.canonicalPaymentIntakePublicId, tx);
        const candidateIds = [...new Set(input.candidatePaymentIntakePublicIds)];
        const canonicalEvidenceCandidateIds = [...new Set(input.canonicalEvidenceCandidatePublicIds ?? [])].sort();
        if (candidateIds.length !== input.candidatePaymentIntakePublicIds.length || candidateIds.includes(canonical.publicId)) throw new DomainError("PAYMENT_DUPLICATE_REVIEW_AMBIGUOUS", "Candidate set must be explicit and contain no duplicate or canonical intake", 409);
        if (canonicalEvidenceCandidateIds.length !== (input.canonicalEvidenceCandidatePublicIds ?? []).length || canonicalEvidenceCandidateIds.length > candidateIds.length || canonicalEvidenceCandidateIds.some((id) => !candidateIds.includes(id))) throw new DomainError("PAYMENT_DUPLICATE_REVIEW_CANONICAL_EVIDENCE_SELECTION_INVALID", "Canonical evidence selection must be a unique subset of the explicit candidates", 409);
        let candidates = await Promise.all(candidateIds.map((id) => intake(ctx, id, tx)));
        for (const key of [input.idempotencyKey.trim(), canonical.publicId, ...candidateIds].sort()) await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`payment-duplicate-review:${ctx.tenantId}:${key}`}, 0))`);
        for (const id of [canonical.id, ...candidates.map((candidate) => candidate.id)].sort((a, b) => a - b)) await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`payment-replacement:${ctx.tenantId}:${id}`}, 0))`);
        canonical = await intake(ctx, input.canonicalPaymentIntakePublicId, tx);
        candidates = await Promise.all(candidateIds.map((id) => intake(ctx, id, tx)));
        const requestHash = digest({ canonical: canonical.publicId, candidates: candidateIds, ...(canonicalEvidenceCandidateIds.length ? { canonicalEvidenceCandidatePublicIds: canonicalEvidenceCandidateIds } : {}), reason: input.reason.trim(), idempotencyKey: input.idempotencyKey.trim() });
        const existing = await tx.query.paymentDuplicateReviews.findFirst({ where: and(eq(paymentDuplicateReviews.tenantId, ctx.tenantId), eq(paymentDuplicateReviews.idempotencyKey, input.idempotencyKey.trim())) });
        if (existing) {
            if (existing.requestHash !== requestHash) throw new DomainError("IDEMPOTENCY_CONFLICT", "Idempotency key was used for a different duplicate review", 409);
            const rows = await tx.query.paymentDuplicateReviewCandidates.findMany({ where: and(eq(paymentDuplicateReviewCandidates.tenantId, ctx.tenantId), eq(paymentDuplicateReviewCandidates.reviewId, existing.id)) });
            return { duplicateReviewPublicId: existing.publicId, status: "previewed" as const, canonicalPaymentIntakePublicId: canonical.publicId, candidatePaymentIntakePublicIds: rows.map((row) => candidates.find((candidate) => candidate.id === row.candidatePaymentIntakeId)?.publicId ?? "").filter(Boolean), canonicalEvidenceCandidatePublicIds: rows.filter((row) => row.usesCanonicalEvidence).map((row) => candidates.find((candidate) => candidate.id === row.candidatePaymentIntakeId)?.publicId ?? "").filter(Boolean), previewHash: existing.previewHash, canonicalStateHash: existing.canonicalStateHash, evidenceHash: existing.evidenceHash, dependencyHash: existing.dependencyHash, expiresAt: existing.expiresAt.toISOString(), auditPublicId: existing.auditPublicId, correlationId: existing.correlationId };
        }
        if (!cancellationProvenance(canonical)) throw new DomainError("PAYMENT_DUPLICATE_REVIEW_CANCELLATION_PROVENANCE_REQUIRED", "Canonical intake lacks cancellation provenance", 409);
        if (canonical.postedAt !== null || canonical.replacementOfIntakeId !== null || canonical.repostOfIntakeId !== null) throw new DomainError("PAYMENT_DUPLICATE_REVIEW_CANONICAL_INVALID", "Canonical intake is not an eligible cancelled source", 409);
        const participantEvidence = await participantEvidenceHash(ctx, canonical, candidates, new Set(canonicalEvidenceCandidateIds), tx);
        const canonicalEvidence = participantEvidence.canonicalEvidence;
        if (canonicalEvidenceCandidateIds.length > 0 && (canonicalEvidence.expected !== 1 || canonicalEvidence.effectiveEvidenceCount !== 1 || canonicalEvidence.ready.length !== 1)) throw new DomainError("PAYMENT_DUPLICATE_REVIEW_CANONICAL_EVIDENCE_INCOMPLETE", "Canonical intake must have exactly one complete finalized evidence", 409);
        if (canonicalEvidenceCandidateIds.length > 0 && (await supplementRows(ctx, canonicalEvidenceCandidateIds.map((id) => candidates.find((candidate) => candidate.publicId === id)!.id), tx)).length > 0) throw new DomainError("PAYMENT_DUPLICATE_REVIEW_CANONICAL_EVIDENCE_CANDIDATE_INVALID", "A canonical-evidence candidate cannot have any supplemental evidence row", 409);
        const dependencyState = await relevantDependencyHash(ctx, [canonical.id, ...candidates.map((candidate) => candidate.id)], tx);
        const allDependencies = dependencyState.deps;
        if (allDependencies.length) throw new DomainError("PAYMENT_DUPLICATE_REVIEW_DEPENDENCY_BLOCKED", "A review participant has a financial dependency", 409, { blockerPublicIds: candidates.filter((candidate) => allDependencies.some((item) => item.endsWith(`:${candidate.id}`))).map((candidate) => candidate.publicId) });
        if (candidates.some((candidate) => !cancellationProvenance(candidate) || candidate.postedAt !== null || candidate.replacementOfIntakeId !== null || candidate.repostOfIntakeId !== null)) throw new DomainError("PAYMENT_DUPLICATE_REVIEW_CANDIDATE_INVALID", "Every candidate must be an unposted cancelled draft with cancellation provenance", 409);
        if (candidates.some((candidate) => candidate.amount !== canonical.amount || candidate.receivedAt.getTime() !== canonical.receivedAt.getTime() || normalizeBorrowerText(candidate.payerName ?? "") !== normalizeBorrowerText(canonical.payerName ?? "") || !candidate.payerName || !canonical.payerName)) throw new DomainError("PAYMENT_DUPLICATE_REVIEW_IDENTITY_MISMATCH", "Candidate amount, received timestamp, and normalized payer must exactly match", 409, { blockerPublicIds: candidates.map((candidate) => candidate.publicId) });
        if (candidates.some((candidate) => candidate.bankReferenceHash !== null || candidate.qrPayloadHash !== null)) throw new DomainError("PAYMENT_DUPLICATE_REVIEW_HARD_IDENTITY_CONFLICT", "A duplicate candidate has a hard payment identity", 409, { blockerPublicIds: candidates.map((candidate) => candidate.publicId) });
        const lineages = await tx.select().from(paymentReplacementLineages).where(eq(paymentReplacementLineages.tenantId, ctx.tenantId));
        if (lineages.some((lineage) => [canonical.id, ...candidates.map((candidate) => candidate.id)].includes(lineage.sourcePaymentIntakeId) || [canonical.id, ...candidates.map((candidate) => candidate.id)].includes(lineage.replacementPaymentIntakeId))) throw new DomainError("PAYMENT_DUPLICATE_REVIEW_LINEAGE_CONFLICT", "Review participants already belong to a replacement lineage", 409);
        const memberships = await tx.select().from(paymentDuplicateReviewMemberships).where(eq(paymentDuplicateReviewMemberships.tenantId, ctx.tenantId));
        if (memberships.some((membership) => [canonical.id, ...candidates.map((candidate) => candidate.id)].includes(membership.canonicalPaymentIntakeId) || [canonical.id, ...candidates.map((candidate) => candidate.id)].includes(membership.candidatePaymentIntakeId))) throw new DomainError("PAYMENT_DUPLICATE_REVIEW_MEMBERSHIP_CONFLICT", "A review participant already belongs to an executed duplicate group", 409);
        const candidateStateHash = candidates.map(candidateSnapshot).sort();
        const dependencyHash = dependencyState.hash;
        const canonicalStateHash = canonicalSnapshot(canonical);
        const previewHash = digest({ requestHash, canonicalStateHash, candidateStateHash, ...(canonicalEvidenceCandidateIds.length ? { canonicalEvidenceCandidatePublicIds: canonicalEvidenceCandidateIds } : {}), evidenceHash: participantEvidence.hash, dependencyHash });
        const expiresAt = new Date(Date.now() + reviewTtlMs);
        const audit = await createAuditLog(tx, { tenantId: ctx.tenantId, actorUserId: ctx.actorUserId, actorSource: ctx.actorSource, requestId: ctx.requestId, correlationId: ctx.correlationId, entityType: "payment_duplicate_review", entityId: canonical.publicId, action: "previewed", payload: { canonicalPaymentIntakePublicId: canonical.publicId, candidatePaymentIntakePublicIds: candidateIds, canonicalEvidenceCandidatePublicIds: canonicalEvidenceCandidateIds, evidenceSnapshot: { canonical: { expectedCount: canonicalEvidence.expectedCount, effectiveEvidenceCount: canonicalEvidence.effectiveEvidenceCount, attempts: canonicalEvidence.attempts }, candidates: participantEvidence.candidateEvidence.map((item, index) => ({ publicId: candidates[index]!.publicId, expectedCount: item.expectedCount, effectiveEvidenceCount: item.effectiveEvidenceCount, attempts: item.attempts })) }, previewHash } });
        const review = await tx.insert(paymentDuplicateReviews).values({ tenantId: ctx.tenantId, canonicalPaymentIntakeId: canonical.id, reason: input.reason.trim(), requestId: ctx.requestId, correlationId: ctx.correlationId, idempotencyKey: input.idempotencyKey.trim(), requestHash, previewHash, canonicalStateHash, evidenceHash: participantEvidence.hash, dependencyHash, expiresAt, auditPublicId: audit.publicId, createdByUserId: user.id }).returning().then((rows) => rows[0]!);
        await tx.insert(paymentDuplicateReviewCandidates).values(candidates.map((candidate) => ({ tenantId: ctx.tenantId, reviewId: review.id, candidatePaymentIntakeId: candidate.id, candidateStateHash: candidateSnapshot(candidate), usesCanonicalEvidence: canonicalEvidenceCandidateIds.includes(candidate.publicId) })));
        return { duplicateReviewPublicId: review.publicId, status: "previewed" as const, canonicalPaymentIntakePublicId: canonical.publicId, candidatePaymentIntakePublicIds: candidateIds, canonicalEvidenceCandidatePublicIds: canonicalEvidenceCandidateIds, previewHash, canonicalStateHash, evidenceHash: participantEvidence.hash, dependencyHash, expiresAt: expiresAt.toISOString(), auditPublicId: audit.publicId, correlationId: ctx.correlationId };
    };
    return executor ? run(executor) : withPaymentWorkflowTransaction(run);
}

export async function executePaymentDuplicateReview(ctx: CommandContext, input: { duplicateReviewPublicId: string; previewHash: string; confirmed: true; reason: string; idempotencyKey: string }, executor?: Executor) {
    if (input.confirmed !== true || !input.reason?.trim() || !input.idempotencyKey?.trim()) throw new DomainError("PAYMENT_DUPLICATE_REVIEW_CONFIRMATION_REQUIRED", "Fresh preview confirmation, reason, and idempotency key are required", 400);
    const run = async (tx: Executor) => {
        const user = await actor(ctx, tx);
        const review = await tx.query.paymentDuplicateReviews.findFirst({ where: and(eq(paymentDuplicateReviews.tenantId, ctx.tenantId), eq(paymentDuplicateReviews.publicId, input.duplicateReviewPublicId)) });
        if (!review) throw new DomainError("PAYMENT_DUPLICATE_REVIEW_NOT_FOUND", "Duplicate review preview not found", 404);
        const candidateRows = await tx.query.paymentDuplicateReviewCandidates.findMany({ where: and(eq(paymentDuplicateReviewCandidates.tenantId, ctx.tenantId), eq(paymentDuplicateReviewCandidates.reviewId, review.id)) });
        const lockKeys = [input.idempotencyKey.trim(), review.publicId].sort();
        for (const key of lockKeys) await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`payment-duplicate-review:${ctx.tenantId}:${key}`}, 0))`);
        for (const id of [review.canonicalPaymentIntakeId, ...candidateRows.map((row) => row.candidatePaymentIntakeId)].sort((a, b) => a - b)) await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`payment-replacement:${ctx.tenantId}:${id}`}, 0))`);
        const requestHash = digest({ duplicateReviewPublicId: input.duplicateReviewPublicId, previewHash: input.previewHash, reason: input.reason.trim(), idempotencyKey: input.idempotencyKey.trim() });
        const canonicalForAccess = await tx.query.paymentIntakes.findFirst({ where: and(eq(paymentIntakes.tenantId, ctx.tenantId), eq(paymentIntakes.id, review.canonicalPaymentIntakeId)) });
        if (!canonicalForAccess) throw new DomainError("PAYMENT_DUPLICATE_REVIEW_INVALID", "Duplicate review dependencies are incomplete", 409);
        await intake(ctx, canonicalForAccess.publicId, tx);
        const candidatesForAccess = await tx.query.paymentIntakes.findMany({ where: and(eq(paymentIntakes.tenantId, ctx.tenantId), inArray(paymentIntakes.id, candidateRows.map((candidate) => candidate.candidatePaymentIntakeId))) });
        for (const candidate of candidatesForAccess) await intake(ctx, candidate.publicId, tx);
        const existing = await tx.query.paymentDuplicateReviewExecutions.findFirst({ where: and(eq(paymentDuplicateReviewExecutions.tenantId, ctx.tenantId), eq(paymentDuplicateReviewExecutions.idempotencyKey, input.idempotencyKey.trim())) });
        if (existing) {
            if (existing.requestHash !== requestHash) throw new DomainError("IDEMPOTENCY_CONFLICT", "Idempotency key was used for a different duplicate review execution", 409);
            return { duplicateReviewPublicId: review.publicId, status: "executed" as const, auditPublicId: existing.auditPublicId, correlationId: existing.correlationId, executionPublicId: existing.publicId };
        }
        if (review.previewHash !== input.previewHash) throw new DomainError("PAYMENT_DUPLICATE_REVIEW_STALE", "Duplicate review preview hash is stale", 409);
        if (review.expiresAt.getTime() <= Date.now()) throw new DomainError("PAYMENT_DUPLICATE_REVIEW_EXPIRED", "Duplicate review preview has expired", 409);
        const canonical = await tx.query.paymentIntakes.findFirst({ where: and(eq(paymentIntakes.tenantId, ctx.tenantId), eq(paymentIntakes.id, review.canonicalPaymentIntakeId)) });
        const candidates = candidateRows;
        if (!canonical || !candidates.length) throw new DomainError("PAYMENT_DUPLICATE_REVIEW_INVALID", "Duplicate review dependencies are incomplete", 409);
        await intake(ctx, canonical.publicId, tx);
        const currentCandidates = await tx.query.paymentIntakes.findMany({ where: and(eq(paymentIntakes.tenantId, ctx.tenantId), inArray(paymentIntakes.id, candidates.map((candidate) => candidate.candidatePaymentIntakeId))) });
        for (const candidate of currentCandidates) await intake(ctx, candidate.publicId, tx);
        if (currentCandidates.length !== candidates.length || !cancellationProvenance(canonical) || canonical.status !== "cancelled" || canonical.postedAt !== null) throw new DomainError("PAYMENT_DUPLICATE_REVIEW_STALE", "Reviewed payment or dependency state changed", 409);
        const memberships = await tx.select().from(paymentDuplicateReviewMemberships).where(eq(paymentDuplicateReviewMemberships.tenantId, ctx.tenantId));
        const participantIds = new Set([canonical.id, ...currentCandidates.map((candidate) => candidate.id)]);
        if (memberships.some((membership) => (membership.reviewId !== review.id && membership.canonicalPaymentIntakeId === canonical.id) || participantIds.has(membership.candidatePaymentIntakeId) || (membership.candidatePaymentIntakeId === canonical.id) || currentCandidates.some((candidate) => membership.canonicalPaymentIntakeId === candidate.id))) throw new DomainError("PAYMENT_DUPLICATE_REVIEW_MEMBERSHIP_CONFLICT", "A review participant already belongs to an executed duplicate group", 409);
        const selectedCandidateIds = new Set(candidateRows.filter((row) => row.usesCanonicalEvidence).map((row) => currentCandidates.find((candidate) => candidate.id === row.candidatePaymentIntakeId)?.publicId).filter((value): value is string => Boolean(value)));
        if (selectedCandidateIds.size > 0 && (await supplementRows(ctx, [...selectedCandidateIds].map((id) => currentCandidates.find((candidate) => candidate.publicId === id)!.id), tx)).length > 0) throw new DomainError("PAYMENT_DUPLICATE_REVIEW_STALE", "Selected candidate supplemental evidence changed", 409);
        const currentParticipantEvidence = await participantEvidenceHash(ctx, canonical, currentCandidates, selectedCandidateIds, tx);
        const currentEvidence = currentParticipantEvidence.canonicalEvidence;
        if (selectedCandidateIds.size > 0 && !hasExactCanonicalEvidence(currentEvidence)) throw new DomainError("PAYMENT_DUPLICATE_REVIEW_STALE", "Canonical evidence changed; reviewed selection is stale", 409);
        const currentDependencyState = await relevantDependencyHash(ctx, [canonical.id, ...currentCandidates.map((candidate) => candidate.id)], tx);
        const currentDependencies = currentDependencyState.deps;
        const currentLineages = await tx.select().from(paymentReplacementLineages).where(eq(paymentReplacementLineages.tenantId, ctx.tenantId));
        const candidateInvalid = currentCandidates.some((candidate) => {
            const identityChanged = candidate.amount !== canonical.amount
                || candidate.receivedAt.getTime() !== canonical.receivedAt.getTime()
                || normalizeBorrowerText(candidate.payerName ?? "") !== normalizeBorrowerText(canonical.payerName ?? "")
                || !candidate.payerName || !canonical.payerName;
            const hardIdentity = candidate.bankReferenceHash !== null || candidate.qrPayloadHash !== null;
            const hasLineage = currentLineages.some((lineage) => lineage.sourcePaymentIntakeId === candidate.id || lineage.replacementPaymentIntakeId === candidate.id);
            return identityChanged || hardIdentity || candidate.replacementOfIntakeId !== null || candidate.repostOfIntakeId !== null || candidate.status !== "cancelled" || hasLineage;
        });
        if (candidateInvalid) throw new DomainError("PAYMENT_DUPLICATE_REVIEW_STALE", "Reviewed payment or dependency state changed", 409);
        const currentCandidateHashes = currentCandidates.map(candidateSnapshot).sort();
        const storedCandidateHashes = candidates.map((candidate) => candidate.candidateStateHash).sort();
        const currentPreviewHash = digest({ requestHash: review.requestHash, canonicalStateHash: canonicalSnapshot(canonical), candidateStateHash: currentCandidateHashes, ...([...selectedCandidateIds].length ? { canonicalEvidenceCandidatePublicIds: [...selectedCandidateIds].sort() } : {}), evidenceHash: currentParticipantEvidence.hash, dependencyHash: currentDependencyState.hash });
        if (currentCandidateHashes.some((hash) => !storedCandidateHashes.includes(hash)) || currentParticipantEvidence.hash !== review.evidenceHash || currentDependencies.length !== 0 || currentPreviewHash !== review.previewHash) throw new DomainError("PAYMENT_DUPLICATE_REVIEW_STALE", "Reviewed payment or dependency state changed", 409);
        const audit = await createAuditLog(tx, { tenantId: ctx.tenantId, actorUserId: user.id, actorSource: ctx.actorSource, requestId: ctx.requestId, correlationId: ctx.correlationId, entityType: "payment_duplicate_review", entityId: review.publicId, action: "executed", payload: { duplicateReviewPublicId: review.publicId, previewHash: input.previewHash, candidateCount: candidates.length, canonicalEvidenceCandidatePublicIds: [...selectedCandidateIds].sort(), evidenceSnapshot: { canonical: { expectedCount: currentEvidence.expectedCount, effectiveEvidenceCount: currentEvidence.effectiveEvidenceCount, attempts: currentEvidence.attempts }, candidates: currentParticipantEvidence.candidateEvidence.map((item, index) => ({ publicId: currentCandidates[index]!.publicId, expectedCount: item.expectedCount, effectiveEvidenceCount: item.effectiveEvidenceCount, attempts: item.attempts })) } } });
        const execution = await tx.insert(paymentDuplicateReviewExecutions).values({ tenantId: ctx.tenantId, reviewId: review.id, idempotencyKey: input.idempotencyKey.trim(), requestHash, auditPublicId: audit.publicId, requestId: ctx.requestId, correlationId: ctx.correlationId, createdByUserId: user.id }).returning().then((rows) => rows[0]!);
        await tx.insert(paymentDuplicateReviewMemberships).values(currentCandidates.map((candidate) => ({ tenantId: ctx.tenantId, reviewId: review.id, executionId: execution.id, canonicalPaymentIntakeId: canonical.id, candidatePaymentIntakeId: candidate.id })));
        return { duplicateReviewPublicId: review.publicId, status: "executed" as const, auditPublicId: audit.publicId, correlationId: ctx.correlationId, executionPublicId: execution.publicId };
    };
    return executor ? run(executor) : withPaymentWorkflowTransaction(run);
}

export async function reviewedDuplicateCandidateIds(ctx: CommandContext, intakeId: number, executor: Executor) {
    const rows = await executor.select({ candidateId: paymentDuplicateReviewCandidates.candidatePaymentIntakeId, canonicalId: paymentDuplicateReviews.canonicalPaymentIntakeId }).from(paymentDuplicateReviewCandidates).innerJoin(paymentDuplicateReviews, and(eq(paymentDuplicateReviews.tenantId, paymentDuplicateReviewCandidates.tenantId), eq(paymentDuplicateReviews.id, paymentDuplicateReviewCandidates.reviewId))).innerJoin(paymentDuplicateReviewExecutions, and(eq(paymentDuplicateReviewExecutions.tenantId, paymentDuplicateReviews.tenantId), eq(paymentDuplicateReviewExecutions.reviewId, paymentDuplicateReviews.id))).where(and(eq(paymentDuplicateReviewCandidates.tenantId, ctx.tenantId), eq(paymentDuplicateReviewCandidates.candidatePaymentIntakeId, intakeId)));
    return rows;
}

/** Revalidates a durable executed membership. The confirmation TTL is deliberately not consulted here. */
export async function reviewAuthorizesPair(ctx: CommandContext, canonicalId: number, candidateId: number, executor: Executor) {
    const membership = await executor.query.paymentDuplicateReviewMemberships.findFirst({ where: and(eq(paymentDuplicateReviewMemberships.tenantId, ctx.tenantId), eq(paymentDuplicateReviewMemberships.canonicalPaymentIntakeId, canonicalId), eq(paymentDuplicateReviewMemberships.candidatePaymentIntakeId, candidateId)) });
    if (!membership) return false;
    const review = await executor.query.paymentDuplicateReviews.findFirst({ where: and(eq(paymentDuplicateReviews.tenantId, ctx.tenantId), eq(paymentDuplicateReviews.id, membership.reviewId)) });
    const canonical = await executor.query.paymentIntakes.findFirst({ where: and(eq(paymentIntakes.tenantId, ctx.tenantId), eq(paymentIntakes.id, canonicalId)) });
    const candidate = await executor.query.paymentIntakes.findFirst({ where: and(eq(paymentIntakes.tenantId, ctx.tenantId), eq(paymentIntakes.id, candidateId)) });
    if (!review || !canonical || !candidate || !cancellationProvenance(canonical) || !cancellationProvenance(candidate) || canonical.status !== "cancelled" || candidate.status !== "cancelled" || canonical.postedAt !== null || candidate.postedAt !== null || candidate.replacementOfIntakeId !== null || candidate.repostOfIntakeId !== null || candidate.bankReferenceHash !== null || candidate.qrPayloadHash !== null) return false;
    if (candidate.amount !== canonical.amount || candidate.receivedAt.getTime() !== canonical.receivedAt.getTime() || !candidate.payerName || !canonical.payerName || normalizeBorrowerText(candidate.payerName) !== normalizeBorrowerText(canonical.payerName)) return false;
    const candidateLineage = await executor.query.paymentReplacementLineages.findFirst({ where: and(eq(paymentReplacementLineages.tenantId, ctx.tenantId), sql`(${paymentReplacementLineages.sourcePaymentIntakeId} = ${candidate.id} OR ${paymentReplacementLineages.replacementPaymentIntakeId} = ${candidate.id})`) });
    if (candidateLineage) return false;
    const reviewCandidates = await executor.query.paymentDuplicateReviewCandidates.findMany({ where: and(eq(paymentDuplicateReviewCandidates.tenantId, ctx.tenantId), eq(paymentDuplicateReviewCandidates.reviewId, review.id)) });
    const participantIds = reviewCandidates.map((row) => row.candidatePaymentIntakeId);
    if (!reviewCandidates.some((row) => row.candidatePaymentIntakeId === candidateId)) return false;
    const currentCandidates = await executor.query.paymentIntakes.findMany({ where: and(eq(paymentIntakes.tenantId, ctx.tenantId), inArray(paymentIntakes.id, participantIds)) });
    if (currentCandidates.length !== participantIds.length) return false;
    if (currentCandidates.some((item) => !cancellationProvenance(item) || item.status !== "cancelled" || item.postedAt !== null || item.replacementOfIntakeId !== null || item.repostOfIntakeId !== null || item.bankReferenceHash !== null || item.qrPayloadHash !== null || item.amount !== canonical.amount || item.receivedAt.getTime() !== canonical.receivedAt.getTime() || !item.payerName || !canonical.payerName || normalizeBorrowerText(item.payerName) !== normalizeBorrowerText(canonical.payerName))) return false;
    const selectedCandidateIds = new Set(reviewCandidates.filter((row) => row.usesCanonicalEvidence).map((row) => currentCandidates.find((candidate) => candidate.id === row.candidatePaymentIntakeId)?.publicId).filter((value): value is string => Boolean(value)));
    if (selectedCandidateIds.size > 0 && (await supplementRows(ctx, [...selectedCandidateIds].map((id) => currentCandidates.find((candidate) => candidate.publicId === id)!.id), executor)).length > 0) return false;
    const evidence = await participantEvidenceHash(ctx, canonical, currentCandidates, selectedCandidateIds, executor).catch(() => null);
    if (!evidence || (selectedCandidateIds.size > 0 ? !hasExactCanonicalEvidence(evidence.canonicalEvidence) : evidence.canonicalEvidence.expected === 0 || evidence.canonicalEvidence.ready.length !== evidence.canonicalEvidence.expected) || canonicalSnapshot(canonical) !== review.canonicalStateHash || evidence.hash !== review.evidenceHash) return false;
    const currentHashes = currentCandidates.map(candidateSnapshot).sort();
    const storedHashes = reviewCandidates.map((row) => row.candidateStateHash).sort();
    if (currentHashes.length !== storedHashes.length || currentHashes.some((value, index) => value !== storedHashes[index])) return false;
    const dependencyState = await relevantDependencyHash(ctx, [canonical.id, ...participantIds], executor);
    return dependencyState.deps.length === 0 && dependencyState.hash === review.dependencyHash;
}
