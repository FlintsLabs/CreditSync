import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db, type DbExecutor } from "../db";
import { financialEvidenceRequirements, paymentDuplicateReviewMemberships, paymentEvidenceRecoveryExecutions, paymentIdentityDecisionPreviews, paymentIdentityDecisions, paymentIntakes, paymentReplacementLineages, users } from "../db/schema";
import { createAuditLog } from "../lib/audit-log";
import type { CommandContext } from "./command-context";
import { DomainError } from "./domain-error";
import { lockPaymentWorkflowIdentity, withPaymentWorkflowTransaction } from "./payment-workflow-locks";
import { canAccessTenantWideData } from "../lib/access";
import { reviewAuthorizesPair } from "./payment-duplicate-review-service";
import { countAuthoritativeEvidenceAttempts } from "./financial-evidence-requirement-service";
import { effectivePaymentEvidence } from "./payment-effective-evidence-service";

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const operators = new Set(["owner", "manager", "collector"]);

// Lifecycle is deliberately excluded.  A reviewed identity remains useful
// when a draft becomes ready or posted; lifecycle/dependency authorization is
// checked live by the reader below.
type PaymentSnapshot = { publicId: string; amount: string; payerName: string | null; receivedAt: string; bankReferenceHash: string | null; qrPayloadHash: string | null };
function paymentSnapshot(row: typeof paymentIntakes.$inferSelect): PaymentSnapshot {
    return { publicId: row.publicId, amount: row.amount, payerName: row.payerName, receivedAt: row.receivedAt.toISOString(), bankReferenceHash: row.bankReferenceHash, qrPayloadHash: row.qrPayloadHash };
}
function snapshotsHash(rows: Array<typeof paymentIntakes.$inferSelect>) { return digest(rows.map(paymentSnapshot).sort((a, b) => a.publicId.localeCompare(b.publicId))); }
function hardIdentityConflicts(rows: Array<typeof paymentIntakes.$inferSelect>) {
    const bank = rows.map((row) => row.bankReferenceHash).filter((value): value is string => !!value);
    const qr = rows.map((row) => row.qrPayloadHash).filter((value): value is string => !!value);
    return new Set(bank).size !== bank.length || new Set(qr).size !== qr.length;
}
function exactPair(participants: string[], first: string, second: string) { return participants.length === 2 && participants[0] === first && participants[1] === second; }

async function participantEvidenceComplete(ctx: CommandContext, row: typeof paymentIntakes.$inferSelect, executor: DbExecutor) {
    const requirement = await executor.query.financialEvidenceRequirements.findFirst({ where: and(eq(financialEvidenceRequirements.tenantId, ctx.tenantId), eq(financialEvidenceRequirements.paymentIntakeId, row.id)) });
    const evidence = (await effectivePaymentEvidence(ctx.tenantId, [row.id], executor)).get(row.id) ?? [];
    const attempts = requirement ? await countAuthoritativeEvidenceAttempts(executor, ctx.tenantId, requirement.id, { kind: "payment", paymentIntakeId: row.id }) : 0;
    const expected = Math.max(requirement?.expectedCount ?? 0, evidence.length, attempts, row.evidenceRequired ? 1 : 0);
    const ready = evidence.filter((item) => item.status === "ready" && item.finalizedAt !== null && item.fileId !== null).length;
    return { complete: expected === 0 || (ready >= expected && evidence.length === ready), expected, ready, evidenceCount: evidence.length, attempts };
}

async function requireParticipantEvidenceCoverage(ctx: CommandContext, rows: Array<typeof paymentIntakes.$inferSelect>, executor: DbExecutor) {
    const states = await Promise.all(rows.map((row) => participantEvidenceComplete(ctx, row, executor)));
    const incomplete = rows.filter((_row, index) => !states[index]!.complete);
    if (!incomplete.length) return;
    // The only permitted exception is an already executed, audited canonical
    // coverage rule.  Every async authorization is resolved explicitly: a
    // Promise must never be treated as a truthy authorization.  A canonical
    // that is itself incomplete can never authorize another participant.
    const canonicalCoverage = (await Promise.all(rows.map(async (canonical, canonicalIndex) => {
        if (!states[canonicalIndex]!.complete) return false;
        const candidateChecks = await Promise.all(incomplete.map(async (candidate) => {
            if (candidate.id === canonical.id) return true;
            if (await reviewAuthorizesPair(ctx, canonical.id, candidate.id, executor)) return true;
            return recoveryCoverageAuthorizesPair(ctx, canonical.id, candidate.id, executor);
        }));
        return candidateChecks.every(Boolean);
    }))).some(Boolean);
    if (!canonicalCoverage) throw new DomainError("PAYMENT_IDENTITY_EVIDENCE_INCOMPLETE", "Every same-payment participant needs complete finalized evidence, or an existing audited canonical coverage rule", 409, {
        participantPublicIds: incomplete.map((row) => row.publicId),
        expectedSlots: incomplete.map((row, index) => ({ publicId: row.publicId, expected: states[rows.indexOf(row)]!.expected, ready: states[rows.indexOf(row)]!.ready })),
    });
}

async function recoveryCoverageAuthorizesPair(ctx: CommandContext, canonicalId: number, incompleteId: number, executor: DbExecutor) {
    // A cancelled source may remain incomplete forever.  It is covered only
    // when this exact canonical is its immutable, complete recovery successor
    // and the append-only recovery execution receipt exists.  Lineage alone
    // is intentionally insufficient: this is the explicit audited recovery
    // rule, not an arbitrary ancestry exemption.
    const lineage = await executor.query.paymentReplacementLineages.findFirst({ where: and(
        eq(paymentReplacementLineages.tenantId, ctx.tenantId),
        eq(paymentReplacementLineages.sourcePaymentIntakeId, incompleteId),
        eq(paymentReplacementLineages.replacementPaymentIntakeId, canonicalId),
    ) });
    if (!lineage) return false;
    const receipt = await executor.query.paymentEvidenceRecoveryExecutions.findFirst({ where: and(
        eq(paymentEvidenceRecoveryExecutions.tenantId, ctx.tenantId),
        eq(paymentEvidenceRecoveryExecutions.lineageId, lineage.id),
    ) });
    if (!receipt) return false;
    const [source, canonical] = await Promise.all([
        executor.query.paymentIntakes.findFirst({ where: and(eq(paymentIntakes.tenantId, ctx.tenantId), eq(paymentIntakes.id, incompleteId)) }),
        executor.query.paymentIntakes.findFirst({ where: and(eq(paymentIntakes.tenantId, ctx.tenantId), eq(paymentIntakes.id, canonicalId)) }),
    ]);
    if (!source || !canonical || source.status !== "cancelled" || source.postedAt !== null || source.repostOfIntakeId !== null || source.replacementOfIntakeId !== null) return false;
    const canonicalState = await participantEvidenceComplete(ctx, canonical, executor);
    return canonicalState.complete;
}

async function effectiveDecisions(tenantId: string, executor: DbExecutor) {
    const decisions = await executor.select().from(paymentIdentityDecisions).where(eq(paymentIdentityDecisions.tenantId, tenantId));
    const superseded = new Set(decisions.map((decision) => decision.supersedesDecisionId).filter((id): id is number => id !== null));
    const effective = [] as typeof decisions;
    for (const decision of decisions) {
        if (superseded.has(decision.id)) continue;
        const rows = await executor.query.paymentIntakes.findMany({ where: and(eq(paymentIntakes.tenantId, tenantId), inArray(paymentIntakes.publicId, decision.participantPublicIds)) });
        if (rows.length !== decision.participantPublicIds.length || snapshotsHash(rows) !== decision.participantSnapshotHash) continue;
        effective.push(decision);
    }
    return effective;
}

async function identityComponent(tenantId: string, seed: string, executor: DbExecutor) {
    const decisions = await effectiveDecisions(tenantId, executor);
    const lineages = await executor.select().from(paymentReplacementLineages).where(eq(paymentReplacementLineages.tenantId, tenantId));
    const legacyMemberships = await executor.select().from(paymentDuplicateReviewMemberships).where(eq(paymentDuplicateReviewMemberships.tenantId, tenantId));
    const members = new Set([seed]);
    let changed = true;
    while (changed) {
        changed = false;
        for (const decision of decisions) {
            if (decision.decision !== "same_payment" || !decision.participantPublicIds.some((id) => members.has(id))) continue;
            for (const id of decision.participantPublicIds) if (!members.has(id)) { members.add(id); changed = true; }
        }
        for (const lineage of lineages) {
            const source = (await executor.query.paymentIntakes.findFirst({ where: and(eq(paymentIntakes.tenantId, tenantId), eq(paymentIntakes.id, lineage.sourcePaymentIntakeId)) }))?.publicId;
            const replacement = (await executor.query.paymentIntakes.findFirst({ where: and(eq(paymentIntakes.tenantId, tenantId), eq(paymentIntakes.id, lineage.replacementPaymentIntakeId)) }))?.publicId;
            if (source && replacement && (members.has(source) || members.has(replacement))) {
                if (!members.has(source)) { members.add(source); changed = true; }
                if (!members.has(replacement)) { members.add(replacement); changed = true; }
            }
        }
        // Executed legacy duplicate reviews are durable identity evidence too.
        // Validate each membership through the same live reader used by the
        // duplicate guard before allowing it to connect the graph.
        for (const membership of legacyMemberships) {
            const canonical = await executor.query.paymentIntakes.findFirst({ where: and(eq(paymentIntakes.tenantId, tenantId), eq(paymentIntakes.id, membership.canonicalPaymentIntakeId)) });
            const candidate = await executor.query.paymentIntakes.findFirst({ where: and(eq(paymentIntakes.tenantId, tenantId), eq(paymentIntakes.id, membership.candidatePaymentIntakeId)) });
            if (!canonical || !candidate) continue;
            const valid = await legacyMembershipAuthorizesPair(tenantId, canonical.publicId, candidate.publicId, executor);
            if (!valid || (!members.has(canonical.publicId) && !members.has(candidate.publicId))) continue;
            if (!members.has(canonical.publicId)) { members.add(canonical.publicId); changed = true; }
            if (!members.has(candidate.publicId)) { members.add(candidate.publicId); changed = true; }
        }
    }
    return members;
}

async function legacyMembershipAuthorizesPair(tenantId: string, canonicalPublicId: string, candidatePublicId: string, executor: DbExecutor) {
    const rows = await executor.query.paymentIntakes.findMany({ where: and(eq(paymentIntakes.tenantId, tenantId), inArray(paymentIntakes.publicId, [canonicalPublicId, candidatePublicId])) });
    if (rows.length !== 2) return false;
    const canonical = rows.find((row) => row.publicId === canonicalPublicId)!;
    const candidate = rows.find((row) => row.publicId === candidatePublicId)!;
    // Identity connectivity must use the same live evidence/dependency
    // validation as replacement duplicate detection. A historical membership
    // is not a permanent exemption when its candidate later drifts.
    return reviewAuthorizesPair({ tenantId } as CommandContext, canonical.id, candidate.id, executor);
}

export async function inspectPaymentIdentity(ctx: CommandContext, participantPublicIds: readonly string[], executor: DbExecutor = db) {
    const components = new Set<string>();
    const firstComponent = await identityComponent(ctx.tenantId, participantPublicIds[0]!, executor);
    for (const participant of participantPublicIds) {
        for (const member of await identityComponent(ctx.tenantId, participant, executor)) components.add(member);
    }
    const rows = await executor.query.paymentIntakes.findMany({ where: and(eq(paymentIntakes.tenantId, ctx.tenantId), inArray(paymentIntakes.publicId, [...components])) });
    const snapshots = rows.map(paymentSnapshot).sort((a, b) => a.publicId.localeCompare(b.publicId));
    const firstReceivedAt = snapshots.reduce((min, row) => Math.min(min, Date.parse(row.receivedAt)), Number.POSITIVE_INFINITY);
    let evidenceCovered = false;
    try { await requireParticipantEvidenceCoverage(ctx, rows, executor); evidenceCovered = true; } catch { /* fail closed for duplicate authorization */ }
    return { participantPublicIds: [...components].sort(), connected: participantPublicIds.every((participant) => firstComponent.has(participant)), activeFinancialEffectCount: rows.filter((row) => row.status === "posted").length, evidenceCovered, participantSnapshots: snapshots.map((row) => ({ publicId: row.publicId, amount: row.amount, payerName: row.payerName, receivedAt: row.receivedAt, timeDifferenceSeconds: Math.max(0, Math.round((Date.parse(row.receivedAt) - firstReceivedAt) / 1000)) })) };
}

async function requireOperator(ctx: CommandContext, tx: DbExecutor) {
    const user = ctx.actorUserId === null ? null : await tx.query.users.findFirst({ where: and(eq(users.tenantId, ctx.tenantId), eq(users.id, ctx.actorUserId)) });
    if (!user || !operators.has(user.role ?? "viewer")) throw new DomainError("PAYMENT_IDENTITY_DECISION_FORBIDDEN", "Only a financial operator may decide payment identity", 403);
    return user;
}

function requireParticipantAccess(user: typeof users.$inferSelect, rows: Array<typeof paymentIntakes.$inferSelect>) {
    if (canAccessTenantWideData({ role: user.role ?? "viewer" })) return;
    if (rows.some((row) => row.ownerUserId !== user.id)) throw new DomainError("PAYMENT_IDENTITY_DECISION_FORBIDDEN", "Collector access is limited to owned payment participants", 403);
}

async function requireExpandedComponentAccess(ctx: CommandContext, user: typeof users.$inferSelect, participantPublicIds: readonly string[], executor: DbExecutor) {
    const inspected = await inspectPaymentIdentity(ctx, participantPublicIds, executor);
    const expanded = await executor.query.paymentIntakes.findMany({ where: and(eq(paymentIntakes.tenantId, ctx.tenantId), inArray(paymentIntakes.publicId, inspected.participantPublicIds)) });
    if (expanded.length !== inspected.participantPublicIds.length) throw new DomainError("PAYMENT_INTAKE_NOT_FOUND", "Every connected payment participant must belong to the tenant", 404);
    requireParticipantAccess(user, expanded);
    return inspected;
}

export async function previewPaymentIdentityDecision(ctx: CommandContext, input: { participantPaymentIntakePublicIds: string[]; decision: "same_payment" | "distinct_payment"; reason: string; idempotencyKey: string }, executor?: DbExecutor) {
    const run = async (tx: DbExecutor) => {
        const user = await requireOperator(ctx, tx);
        const participantPublicIds = [...new Set(input.participantPaymentIntakePublicIds)].sort();
        if (participantPublicIds.length < 2 || !input.reason?.trim() || !input.idempotencyKey?.trim()) throw new DomainError("PAYMENT_IDENTITY_DECISION_INVALID", "At least two participants, a reason, and an idempotency key are required", 400);
        await lockPaymentWorkflowIdentity(ctx, tx, participantPublicIds);
        const rows = await tx.query.paymentIntakes.findMany({ where: and(eq(paymentIntakes.tenantId, ctx.tenantId), inArray(paymentIntakes.publicId, participantPublicIds)) });
        if (rows.length !== participantPublicIds.length) throw new DomainError("PAYMENT_INTAKE_NOT_FOUND", "Every payment participant must belong to the tenant", 404);
        requireParticipantAccess(user, rows);
        const expanded = await requireExpandedComponentAccess(ctx, user, participantPublicIds, tx);
        const snapshots = rows.map(paymentSnapshot).sort((a, b) => a.publicId.localeCompare(b.publicId));
        if (input.decision === "distinct_payment" && hardIdentityConflicts(rows)) throw new DomainError("PAYMENT_IDENTITY_HARD_CONFLICT", "Matching bank or QR identity prevents a distinct decision", 409);
        const participantSnapshotHash = digest(snapshots);
        const requestHash = digest({ participantPublicIds, decision: input.decision, reason: input.reason.trim(), idempotencyKey: input.idempotencyKey.trim() });
        const previewHash = digest({ participantPublicIds, participantSnapshotHash, decision: input.decision, reason: input.reason.trim(), requestHash });
        const existing = await tx.query.paymentIdentityDecisionPreviews.findFirst({ where: and(eq(paymentIdentityDecisionPreviews.tenantId, ctx.tenantId), eq(paymentIdentityDecisionPreviews.idempotencyKey, input.idempotencyKey.trim())) });
        if (existing) { if (existing.requestHash !== requestHash) throw new DomainError("IDEMPOTENCY_CONFLICT", "Idempotency key was used for a different identity preview", 409); return { identityDecisionPreviewPublicId: existing.publicId, previewHash: existing.previewHash, participantSnapshotHash: existing.participantSnapshotHash, participantPaymentIntakePublicIds: participantPublicIds, participantSnapshots: expanded.participantSnapshots, decision: existing.decision as typeof input.decision, expiresAt: existing.expiresAt.toISOString(), auditPublicId: existing.auditPublicId, correlationId: existing.correlationId }; }
        const audit = await createAuditLog(tx, { tenantId: ctx.tenantId, actorUserId: ctx.actorUserId, actorSource: ctx.actorSource, requestId: ctx.requestId, correlationId: ctx.correlationId, entityType: "payment_identity_decision_preview", entityId: participantPublicIds.join(","), action: "previewed", payload: { participantPaymentIntakePublicIds: participantPublicIds, decision: input.decision, previewHash, requestHash } });
        const preview = await tx.insert(paymentIdentityDecisionPreviews).values({ tenantId: ctx.tenantId, participantPublicIds, participantSnapshotHash, decision: input.decision, reason: input.reason.trim(), previewHash, requestHash, auditPublicId: audit.publicId, expiresAt: new Date(Date.now() + 15 * 60 * 1000), requestId: ctx.requestId, correlationId: ctx.correlationId, idempotencyKey: input.idempotencyKey.trim(), createdByUserId: ctx.actorUserId! }).returning().then((rows) => rows[0]!);
        return { identityDecisionPreviewPublicId: preview.publicId, previewHash, participantSnapshotHash, participantPaymentIntakePublicIds: participantPublicIds, participantSnapshots: expanded.participantSnapshots, decision: input.decision, expiresAt: preview.expiresAt.toISOString(), auditPublicId: audit.publicId, correlationId: ctx.correlationId };
    };
    return executor ? run(executor) : withPaymentWorkflowTransaction(run);
}

export async function executePaymentIdentityDecision(ctx: CommandContext, input: { identityDecisionPreviewPublicId: string; previewHash: string; confirmed: true; reason: string; idempotencyKey: string }, executor?: DbExecutor) {
    const run = async (tx: DbExecutor) => {
        const user = await requireOperator(ctx, tx);
        const preview = await tx.query.paymentIdentityDecisionPreviews.findFirst({ where: and(eq(paymentIdentityDecisionPreviews.tenantId, ctx.tenantId), eq(paymentIdentityDecisionPreviews.publicId, input.identityDecisionPreviewPublicId)) });
        if (!preview) throw new DomainError("PAYMENT_IDENTITY_PREVIEW_NOT_FOUND", "Identity decision preview not found", 404);
        // Replay is not an access bypass: load and authorize every participant
        // before returning a stored receipt.
        const replayParticipants = await tx.query.paymentIntakes.findMany({ where: and(eq(paymentIntakes.tenantId, ctx.tenantId), inArray(paymentIntakes.publicId, preview.participantPublicIds)) });
        if (replayParticipants.length !== preview.participantPublicIds.length) throw new DomainError("PAYMENT_INTAKE_NOT_FOUND", "Every payment participant must belong to the tenant", 404);
        requireParticipantAccess(user, replayParticipants);
        await lockPaymentWorkflowIdentity(ctx, tx, preview.participantPublicIds);
        // The component may have expanded since preview (including during an
        // idempotent replay). Re-read and authorize every connected member,
        // not just the original pair, before returning or writing a receipt.
        await requireExpandedComponentAccess(ctx, user, preview.participantPublicIds, tx);
        const requestHash = digest({ preview: input.identityDecisionPreviewPublicId, previewHash: input.previewHash, reason: input.reason.trim(), idempotencyKey: input.idempotencyKey.trim() });
        const existing = await tx.query.paymentIdentityDecisions.findFirst({ where: and(eq(paymentIdentityDecisions.tenantId, ctx.tenantId), eq(paymentIdentityDecisions.idempotencyKey, input.idempotencyKey.trim())) });
        if (existing) { if (existing.requestHash !== requestHash) throw new DomainError("IDEMPOTENCY_CONFLICT", "Idempotency key was used for a different identity decision", 409); return { decisionPublicId: existing.publicId, auditPublicId: existing.auditPublicId, correlationId: existing.correlationId, decision: existing.decision }; }
        if (input.confirmed !== true || preview.previewHash !== input.previewHash || preview.expiresAt.getTime() <= Date.now() || preview.reason !== input.reason.trim()) throw new DomainError("PAYMENT_IDENTITY_PREVIEW_STALE", "Fresh identity preview confirmation is required", 409);
        const current = await tx.query.paymentIntakes.findMany({ where: and(eq(paymentIntakes.tenantId, ctx.tenantId), inArray(paymentIntakes.publicId, preview.participantPublicIds)) });
        if (current.length !== preview.participantPublicIds.length) throw new DomainError("PAYMENT_INTAKE_NOT_FOUND", "Every payment participant must belong to the tenant", 404);
        requireParticipantAccess(user, current);
        const affected = await requireExpandedComponentAccess(ctx, user, preview.participantPublicIds, tx);
        const expandedRows = await tx.query.paymentIntakes.findMany({ where: and(eq(paymentIntakes.tenantId, ctx.tenantId), inArray(paymentIntakes.publicId, affected.participantPublicIds)) });
        if (preview.decision === "same_payment") {
            if (affected.activeFinancialEffectCount > 1) throw new DomainError("PAYMENT_IDENTITY_GROUP_FINANCIAL_CONFLICT", "A same-payment decision would merge multiple active postings", 409);
            await requireParticipantEvidenceCoverage(ctx, expandedRows, tx);
        }
        const snapshotHash = snapshotsHash(current);
        if (snapshotHash !== preview.participantSnapshotHash) throw new DomainError("PAYMENT_IDENTITY_PREVIEW_STALE", "Payment participants changed; preview again", 409);
        if (preview.decision === "distinct_payment" && hardIdentityConflicts(current)) throw new DomainError("PAYMENT_IDENTITY_HARD_CONFLICT", "Matching bank or QR identity prevents a distinct decision", 409);
        const previous = (await tx.select().from(paymentIdentityDecisions).where(eq(paymentIdentityDecisions.tenantId, ctx.tenantId)))
            .filter((row) => JSON.stringify([...row.participantPublicIds].sort()) === JSON.stringify([...preview.participantPublicIds].sort()))
            .sort((a, b) => b.id - a.id)[0];
        const audit = await createAuditLog(tx, { tenantId: ctx.tenantId, actorUserId: user.id, actorSource: ctx.actorSource, requestId: ctx.requestId, correlationId: ctx.correlationId, entityType: "payment_identity_decision", entityId: preview.publicId, action: "executed", payload: { decision: preview.decision, participantPaymentIntakePublicIds: preview.participantPublicIds, previewHash: preview.previewHash, requestHash } });
        const decision = await tx.insert(paymentIdentityDecisions).values({ tenantId: ctx.tenantId, decision: preview.decision, reason: input.reason.trim(), participantPublicIds: preview.participantPublicIds, participantSnapshotHash: preview.participantSnapshotHash, requestHash, requestId: ctx.requestId, correlationId: ctx.correlationId, idempotencyKey: input.idempotencyKey.trim(), auditPublicId: audit.publicId, createdByUserId: user.id, supersedesDecisionId: previous?.id ?? null }).returning().then((rows) => rows[0]!);
        return { decisionPublicId: decision.publicId, auditPublicId: audit.publicId, correlationId: ctx.correlationId, decision: decision.decision };
    };
    return executor ? run(executor) : withPaymentWorkflowTransaction(run);
}

/** Compatibility reader used by duplicate detection; historical duplicate-review rows remain authoritative too. */
export async function identityDecisionAuthorizesPair(ctx: CommandContext, firstPublicId: string, secondPublicId: string, executor: DbExecutor = db) {
    if (firstPublicId === secondPublicId) return false;
    const rows = await effectiveDecisions(ctx.tenantId, executor);
    const pairRows = rows.filter((row) => row.participantPublicIds.includes(firstPublicId) && row.participantPublicIds.includes(secondPublicId)).sort((a, b) => b.id - a.id);
    const latest = pairRows[0];
    if (!latest) return false;
    const participantIds = [...new Set(latest.participantPublicIds)].sort();
    if (latest.decision === "distinct_payment") {
        if (!exactPair(participantIds, ...[firstPublicId, secondPublicId].sort() as [string, string])) return false;
        const current = await executor.query.paymentIntakes.findMany({ where: and(eq(paymentIntakes.tenantId, ctx.tenantId), inArray(paymentIntakes.publicId, participantIds)) });
        return current.length === participantIds.length && snapshotsHash(current) === latest.participantSnapshotHash && !hardIdentityConflicts(current);
    }
    const component = await identityComponent(ctx.tenantId, firstPublicId, executor);
    if (!component.has(secondPublicId)) return false;
    const current = await executor.query.paymentIntakes.findMany({ where: and(eq(paymentIntakes.tenantId, ctx.tenantId), inArray(paymentIntakes.publicId, [...component])) });
    // A same-payment review can connect a pending successor, but can never
    // authorize another active posting in a group that already has one.
    if (current.length !== component.size || current.filter((row) => row.status === "posted").length > 0) return false;
    try {
        await requireParticipantEvidenceCoverage(ctx, current, executor);
        return true;
    } catch {
        // Evidence drift revokes the posting exemption until the participant
        // requirement is complete or the existing audited coverage rule is
        // revalidated by the same live reader.
        return false;
    }
}
