import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { auditLogs, bankProfiles, files, loanDisbursementEvidence, loanDisbursementEvidenceIntents, loanDisbursementEvents, loanRestructures, loans, users } from "../db/schema";
import { canAccessTenantWideData } from "../lib/access";
import { parseMoney, serializeMoney } from "../lib/money";
import { BUCKET_NAME, createSignedPutUrl, headStoredObject, toStorageReference, type SignedPutRequest, type StoredObjectHead } from "../lib/storage";
import type { CommandContext } from "./command-context";
import { DomainError } from "./domain-error";

type Executor = any;
type EventRow = typeof loanDisbursementEvents.$inferSelect;

export interface DisbursementEvidenceStorageGateway {
    preparePut(request: SignedPutRequest): Promise<{ uploadUrl: string; expiresAt: Date; requiredHeaders?: Record<string, string> }>;
    head(key: string, bucket?: string): Promise<StoredObjectHead>;
}

const defaultEvidenceGateway: DisbursementEvidenceStorageGateway = { preparePut: createSignedPutUrl, head: headStoredObject };
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sha256Pattern = /^[0-9a-f]{64}$/i;
const allowedEvidenceTypes = new Set(["image/jpeg", "image/png", "application/pdf"]);

export interface CreateDisbursementDraftInput {
    grossAmount: string;
    loanAttributedAmount: string;
    channel: "bank_transfer" | "cash" | "adjustment";
    sourceBankProfilePublicId?: string | null;
    payeeHint?: string | null;
    note?: string | null;
    disbursedAt: string;
}

export type UpdateDisbursementDraftInput = Partial<CreateDisbursementDraftInput>;
export interface PrepareDisbursementEvidenceInput { mimeType: string; size: number; sha256: string; originalName?: string | null }

export function rejectDisbursementDraftEvidenceIds(input: unknown) {
    if (input && typeof input === "object" && "evidenceFilePublicIds" in input) {
        throw new DomainError(
            "EVIDENCE_ATTACH_AFTER_DRAFT",
            "Create the draft first, then prepare and finalize evidence for that disbursement",
            400,
        );
    }
}

export function disbursementReversalRequestHash(disbursementPublicId: string, reason: string) {
    return createHash("sha256").update(JSON.stringify({
        contract: "loan-disbursement-reversal", version: "v1", disbursementPublicId, reason,
    })).digest("hex");
}

export function evidenceIntentExpired(intent: { uploadExpiresAt: Date | null; createdAt: Date | null }, now = new Date()) {
    if (intent.uploadExpiresAt) return intent.uploadExpiresAt.getTime() <= now.getTime();
    const graceMs = Math.max(60, Math.min(900, Number(process.env.EVIDENCE_UPLOAD_TTL_SECONDS ?? 300))) * 1000;
    return (intent.createdAt?.getTime() ?? now.getTime()) + graceMs <= now.getTime();
}

function auditContext(ctx: CommandContext) {
    return { tenantId: ctx.tenantId, actorUserId: ctx.actorUserId, actorSource: ctx.actorSource, requestId: ctx.requestId, correlationId: ctx.correlationId };
}

function requirePublicId(value: string, field: string) {
    if (!uuidPattern.test(value)) throw new DomainError("INVALID_PUBLIC_ID", `${field} must be a UUID`, 400, { field });
}

function money(value: string, field: string) {
    try { return parseMoney(value); }
    catch { throw new DomainError("INVALID_DISBURSEMENT_AMOUNT", `${field} must be a non-negative string with exactly two decimals`, 400, { field }); }
}

function dateTime(value: string) {
    const result = new Date(value);
    if (Number.isNaN(result.getTime())) throw new DomainError("INVALID_DISBURSED_AT", "disbursedAt must be an ISO date-time", 400);
    return result;
}

function normalizedText(value: string | null | undefined) { return value?.trim() || null; }

function rejectReservedIdempotencyKey(idempotencyKey: string) {
    if (idempotencyKey.startsWith("internal:")) {
        throw new DomainError(
            "RESERVED_IDEMPOTENCY_KEY",
            "Idempotency keys beginning with internal: are reserved",
            400,
        );
    }
}

function editableSnapshot(event: EventRow) {
    return {
        grossAmount: serializeMoney(event.grossAmount), loanAttributedAmount: serializeMoney(event.loanAttributedAmount),
        channel: event.channel, sourceBankProfileId: event.sourceBankProfileId, payeeHint: event.payeeHint,
        note: event.note, disbursedAt: event.disbursedAt?.toISOString() ?? null,
    };
}

async function actorFor(ctx: CommandContext, executor: Executor = db) {
    if (ctx.actorUserId === null) return null;
    const actor = await executor.query.users.findFirst({ where: and(eq(users.id, ctx.actorUserId), eq(users.tenantId, ctx.tenantId)) });
    if (!actor) throw new DomainError("ACTOR_NOT_FOUND", "Actor is not available in this tenant", 403);
    return actor;
}

async function accessibleLoan(ctx: CommandContext, publicId: string, executor: Executor = db) {
    requirePublicId(publicId, "loanPublicId");
    const actor = await actorFor(ctx, executor);
    const row = await executor.query.loans.findFirst({ where: and(eq(loans.publicId, publicId), eq(loans.tenantId, ctx.tenantId)) });
    if (!row || (actor && !canAccessTenantWideData({ role: actor.role ?? "viewer" }) && row.ownerUserId !== actor.id)) {
        throw new DomainError("LOAN_NOT_FOUND", "Loan not found", 404);
    }
    return row;
}

async function accessibleEvent(ctx: CommandContext, publicId: string, executor: Executor = db) {
    requirePublicId(publicId, "disbursementPublicId");
    const actor = await actorFor(ctx, executor);
    const event = await executor.query.loanDisbursementEvents.findFirst({
        where: and(eq(loanDisbursementEvents.publicId, publicId), eq(loanDisbursementEvents.tenantId, ctx.tenantId)),
    });
    if (!event) throw new DomainError("DISBURSEMENT_NOT_FOUND", "Disbursement not found", 404);
    const loan = await executor.query.loans.findFirst({ where: and(eq(loans.id, event.loanId), eq(loans.tenantId, ctx.tenantId)) });
    if (!loan || (actor && !canAccessTenantWideData({ role: actor.role ?? "viewer" }) && loan.ownerUserId !== actor.id)) {
        throw new DomainError("DISBURSEMENT_NOT_FOUND", "Disbursement not found", 404);
    }
    return { event, loan };
}

export async function assertDisbursementParentLoan(ctx: CommandContext, loanPublicId: string, disbursementPublicId: string) {
    const [loan, resolved] = await Promise.all([
        accessibleLoan(ctx, loanPublicId),
        accessibleEvent(ctx, disbursementPublicId),
    ]);
    if (resolved.event.loanId !== loan.id) {
        throw new DomainError("DISBURSEMENT_NOT_FOUND", "Disbursement not found", 404);
    }
}

async function sourceProfileFor(ctx: CommandContext, publicId: string | null | undefined, executor: Executor = db) {
    if (!publicId) return null;
    requirePublicId(publicId, "sourceBankProfilePublicId");
    const profile = await executor.query.bankProfiles.findFirst({ where: and(eq(bankProfiles.publicId, publicId), eq(bankProfiles.tenantId, ctx.tenantId)) });
    if (!profile) throw new DomainError("BANK_PROFILE_NOT_FOUND", "Source bank profile not found", 404);
    return profile;
}

function validateDraft(input: CreateDisbursementDraftInput) {
    const grossAmount = money(input.grossAmount, "grossAmount");
    const loanAttributedAmount = money(input.loanAttributedAmount, "loanAttributedAmount");
    if (!input.channel || !["bank_transfer", "cash", "adjustment"].includes(input.channel)) {
        throw new DomainError("INVALID_DISBURSEMENT_CHANNEL", "channel must be bank_transfer, cash, or adjustment", 400);
    }
    const note = normalizedText(input.note);
    if (!grossAmount.equals(loanAttributedAmount) && !note) {
        throw new DomainError("DISBURSEMENT_NOTE_REQUIRED", "A note is required when gross and attributed amounts differ", 400);
    }
    return { grossAmount: serializeMoney(grossAmount), loanAttributedAmount: serializeMoney(loanAttributedAmount), channel: input.channel, note, disbursedAt: dateTime(input.disbursedAt) };
}

async function presentEvent(event: EventRow, evidenceFilePublicIds: string[] = [], executor: Executor = db) {
    const sourceProfile = event.sourceBankProfileId === null ? null : await executor.query.bankProfiles.findFirst({
        where: and(eq(bankProfiles.id, event.sourceBankProfileId), eq(bankProfiles.tenantId, event.tenantId)),
    });
    const restructure = event.restructureId === null ? null : await executor.query.loanRestructures.findFirst({
        where: and(eq(loanRestructures.id, event.restructureId), eq(loanRestructures.tenantId, event.tenantId)),
    });
    return {
        id: event.publicId, publicId: event.publicId, grossAmount: serializeMoney(event.grossAmount), loanAttributedAmount: serializeMoney(event.loanAttributedAmount),
        channel: event.channel, status: event.status, sourceBankProfilePublicId: sourceProfile?.publicId ?? null, payeeHint: event.payeeHint, note: event.note, disbursedAt: event.disbursedAt,
        restructurePublicId: restructure?.publicId ?? null, postedAt: event.postedAt, reversedAt: event.reversedAt, evidenceFilePublicIds,
    };
}

async function evidenceIds(ctx: CommandContext, eventId: number, executor: Executor = db) {
    const rows = await executor.select({ publicId: files.publicId }).from(loanDisbursementEvidence)
        .innerJoin(files, eq(loanDisbursementEvidence.fileId, files.id))
        .where(and(eq(loanDisbursementEvidence.tenantId, ctx.tenantId), eq(loanDisbursementEvidence.loanDisbursementEventId, eventId), eq(files.tenantId, ctx.tenantId)));
    return rows.map((row: { publicId: string }) => row.publicId);
}

async function lockLoanAndEvent(tx: Executor, ctx: CommandContext, eventId: number) {
    const snapshot = await tx.query.loanDisbursementEvents.findFirst({ where: and(
        eq(loanDisbursementEvents.id, eventId),
        eq(loanDisbursementEvents.tenantId, ctx.tenantId),
    ) });
    if (!snapshot) throw new DomainError("DISBURSEMENT_NOT_FOUND", "Disbursement not found", 404);
    await tx.execute(sql`SELECT id FROM loans WHERE tenant_id = ${ctx.tenantId} AND id = ${snapshot.loanId} FOR UPDATE`);
    await tx.execute(sql`SELECT id FROM loan_disbursement_events WHERE tenant_id = ${ctx.tenantId} AND id = ${eventId} FOR UPDATE`);
    const current = await tx.query.loanDisbursementEvents.findFirst({ where: and(
        eq(loanDisbursementEvents.id, eventId),
        eq(loanDisbursementEvents.tenantId, ctx.tenantId),
    ) });
    if (!current || current.loanId !== snapshot.loanId) {
        throw new DomainError("DISBURSEMENT_NOT_FOUND", "Disbursement not found", 404);
    }
    return current;
}

async function writeAudit(executor: Executor, ctx: CommandContext, event: EventRow, action: string, payload: unknown) {
    return executor.insert(auditLogs).values({ ...auditContext(ctx), entityType: "loan_disbursement", entityId: event.publicId, action, payload }).returning().then((rows: Array<typeof auditLogs.$inferSelect>) => rows[0]!);
}

export interface IntermediatedLoanPayoutProjectionInput {
    loanId: number;
    groupPublicId: string;
    amount: string;
    channel: "bank_transfer" | "cash" | "adjustment";
    payeeHint?: string | null;
    disbursedAt: Date;
}

/**
 * Internal transaction-aware projection used by the three-leg intermediary
 * workflow. The physical lender and advance-return legs remain on their own
 * transfer ledger; this row records only the exact cash paid to the borrower.
 */
export async function recordIntermediatedLoanPayout(
    executor: Executor,
    ctx: CommandContext,
    input: IntermediatedLoanPayoutProjectionInput,
) {
    requirePublicId(input.groupPublicId, "groupPublicId");
    const amount = serializeMoney(money(input.amount, "amount"));
    const postIdempotencyKey = `internal:intermediated-payout:${input.groupPublicId}`;
    const existing = await executor.query.loanDisbursementEvents.findFirst({ where: and(
        eq(loanDisbursementEvents.tenantId, ctx.tenantId),
        eq(loanDisbursementEvents.postIdempotencyKey, postIdempotencyKey),
    ) });
    if (existing) {
        // Exact group retries are resolved from the locked group audit before this
        // helper runs. Reusing any preexisting row here would let a regular,
        // caller-keyed disbursement impersonate this group's payout provenance.
        throw new DomainError(
            "INTERMEDIATED_LOAN_PAYOUT_CONFLICT",
            "The intermediary payout projection key is already occupied",
            409,
        );
    }
    const loan = await executor.query.loans.findFirst({ where: and(
        eq(loans.tenantId, ctx.tenantId),
        eq(loans.id, input.loanId),
    ) });
    if (!loan) throw new DomainError("LOAN_NOT_FOUND", "Loan not found", 404);
    const event = await executor.insert(loanDisbursementEvents).values({
        tenantId: ctx.tenantId,
        loanId: input.loanId,
        grossAmount: amount,
        loanAttributedAmount: amount,
        channel: input.channel,
        payeeHint: normalizedText(input.payeeHint),
        status: "posted",
        note: `Actual borrower payout projected from intermediary group ${input.groupPublicId}`,
        disbursedAt: input.disbursedAt,
        postedAt: new Date(),
        postIdempotencyKey,
        createdByUserId: ctx.actorUserId,
    }).returning().then((rows: Array<typeof loanDisbursementEvents.$inferSelect>) => rows[0]!);
    await writeAudit(executor, ctx, event, "intermediated_posted", {
        groupPublicId: input.groupPublicId,
        grossAmount: amount,
        loanAttributedAmount: amount,
    });
    return event;
}

export async function reverseIntermediatedLoanPayout(
    executor: Executor,
    ctx: CommandContext,
    input: { groupPublicId: string; disbursementPublicId: string; reason: string },
) {
    requirePublicId(input.groupPublicId, "groupPublicId");
    requirePublicId(input.disbursementPublicId, "disbursementPublicId");
    const reason = normalizedText(input.reason);
    if (!reason) throw new DomainError("REVERSAL_REASON_REQUIRED", "A reversal reason is required", 400);
    const original = await executor.query.loanDisbursementEvents.findFirst({ where: and(
        eq(loanDisbursementEvents.tenantId, ctx.tenantId),
        eq(loanDisbursementEvents.publicId, input.disbursementPublicId),
    ) });
    if (!original || original.status !== "posted") {
        throw new DomainError(
            "INTERMEDIATED_LOAN_PAYOUT_NOT_POSTED",
            "The linked intermediary loan payout is not posted",
            409,
        );
    }
    await executor.execute(sql`SELECT id FROM loan_disbursement_events WHERE tenant_id = ${ctx.tenantId} AND id = ${original.id} FOR UPDATE`);
    const reversalIdempotencyKey = `internal:intermediated-payout-reversal:${input.groupPublicId}`;
    const reversalRequestHash = disbursementReversalRequestHash(original.publicId, reason);
    const existing = await executor.query.loanDisbursementEvents.findFirst({ where: and(
        eq(loanDisbursementEvents.tenantId, ctx.tenantId),
        eq(loanDisbursementEvents.reversedEventId, original.id),
    ) });
    if (existing) {
        if (existing.reversalIdempotencyKey !== reversalIdempotencyKey
            || existing.reversalRequestHash !== reversalRequestHash) {
            throw new DomainError(
                "INTERMEDIATED_LOAN_PAYOUT_REVERSAL_CONFLICT",
                "The linked intermediary loan payout was already reversed differently",
                409,
            );
        }
        return existing;
    }
    const reversal = await executor.insert(loanDisbursementEvents).values({
        tenantId: ctx.tenantId,
        loanId: original.loanId,
        grossAmount: original.grossAmount,
        loanAttributedAmount: original.loanAttributedAmount,
        channel: original.channel,
        sourceBankProfileId: original.sourceBankProfileId,
        payeeHint: original.payeeHint,
        status: "reversed",
        reversedEventId: original.id,
        note: reason,
        disbursedAt: original.disbursedAt,
        postedAt: new Date(),
        reversedAt: new Date(),
        reversalIdempotencyKey,
        reversalRequestHash,
        createdByUserId: ctx.actorUserId,
    }).returning().then((rows: Array<typeof loanDisbursementEvents.$inferSelect>) => rows[0]!);
    await writeAudit(executor, ctx, reversal, "intermediated_reversed", {
        groupPublicId: input.groupPublicId,
        reversedEventPublicId: original.publicId,
        reason,
    });
    return reversal;
}

export async function createDisbursementDraft(ctx: CommandContext, loanPublicId: string, input: CreateDisbursementDraftInput) {
    const loan = await accessibleLoan(ctx, loanPublicId);
    const draft = validateDraft(input);
    const sourceProfile = await sourceProfileFor(ctx, input.sourceBankProfilePublicId);
    return db.transaction(async (tx) => {
        const created = await tx.insert(loanDisbursementEvents).values({
            tenantId: ctx.tenantId, loanId: loan.id, ...draft, sourceBankProfileId: sourceProfile?.id ?? null,
            payeeHint: normalizedText(input.payeeHint), createdByUserId: ctx.actorUserId,
        }).returning().then((rows) => rows[0]!);
        await writeAudit(tx, ctx, created, "draft_created", { loanPublicId, grossAmount: draft.grossAmount, loanAttributedAmount: draft.loanAttributedAmount });
        return presentEvent(created, [], tx);
    });
}

/** Internal atomic-workflow adapter. The caller must already hold/validate the
 * parent-loan lock and own the surrounding transaction. */
export async function createDisbursementDraftInTransaction(
    tx: Executor,
    ctx: CommandContext,
    loan: typeof loans.$inferSelect,
    input: CreateDisbursementDraftInput,
    restructureId?: number,
) {
    const draft = validateDraft(input);
    const sourceProfile = await sourceProfileFor(ctx, input.sourceBankProfilePublicId, tx);
    const created = await tx.insert(loanDisbursementEvents).values({
        tenantId: ctx.tenantId,
        loanId: loan.id,
        restructureId: restructureId ?? null,
        ...draft,
        sourceBankProfileId: sourceProfile?.id ?? null,
        payeeHint: normalizedText(input.payeeHint),
        createdByUserId: ctx.actorUserId,
    }).returning().then((rows: EventRow[]) => rows[0]!);
    await writeAudit(tx, ctx, created, "draft_created", {
        loanPublicId: loan.publicId,
        grossAmount: draft.grossAmount,
        loanAttributedAmount: draft.loanAttributedAmount,
        workflow: "loan_restructure_additional_principal",
    });
    return created;
}

export async function updateDisbursementDraft(ctx: CommandContext, disbursementPublicId: string, input: UpdateDisbursementDraftInput) {
    const { event } = await accessibleEvent(ctx, disbursementPublicId);
    return db.transaction(async (tx) => {
        const current = await lockLoanAndEvent(tx, ctx, event.id);
        if (current.status !== "draft") throw new DomainError("DISBURSEMENT_LOCKED", "Posted or reversed disbursements cannot be edited", 409);
        const merged: CreateDisbursementDraftInput = {
            grossAmount: input.grossAmount ?? serializeMoney(current.grossAmount), loanAttributedAmount: input.loanAttributedAmount ?? serializeMoney(current.loanAttributedAmount),
            channel: input.channel ?? current.channel as CreateDisbursementDraftInput["channel"], note: input.note === undefined ? current.note : input.note,
            payeeHint: input.payeeHint === undefined ? current.payeeHint : input.payeeHint,
            sourceBankProfilePublicId: input.sourceBankProfilePublicId, disbursedAt: input.disbursedAt ?? current.disbursedAt?.toISOString() ?? new Date().toISOString(),
        };
        const values = validateDraft(merged);
        const sourceProfile = input.sourceBankProfilePublicId === undefined ? null : await sourceProfileFor(ctx, input.sourceBankProfilePublicId, tx);
        const updated = await tx.update(loanDisbursementEvents).set({ ...values, payeeHint: normalizedText(merged.payeeHint), ...(input.sourceBankProfilePublicId === undefined ? {} : { sourceBankProfileId: sourceProfile?.id ?? null }) })
            .where(and(eq(loanDisbursementEvents.id, current.id), eq(loanDisbursementEvents.status, "draft"))).returning().then((rows) => rows[0]);
        if (!updated) throw new DomainError("DISBURSEMENT_LOCKED", "Posted or reversed disbursements cannot be edited", 409);
        await writeAudit(tx, ctx, updated, "draft_updated", { before: editableSnapshot(current), after: editableSnapshot(updated) });
        return presentEvent(updated, await evidenceIds(ctx, updated.id, tx), tx);
    });
}

export async function listLoanDisbursements(ctx: CommandContext, loanPublicId: string) {
    const loan = await accessibleLoan(ctx, loanPublicId);
    const rows = await db.select().from(loanDisbursementEvents).where(and(eq(loanDisbursementEvents.tenantId, ctx.tenantId), eq(loanDisbursementEvents.loanId, loan.id))).orderBy(desc(loanDisbursementEvents.createdAt));
    const reversalIds = new Set(rows.filter((row) => row.reversedEventId !== null).map((row) => row.reversedEventId));
    const netDisbursed = rows.filter((row) => row.status === "posted" && !reversalIds.has(row.id))
        .reduce((total, row) => total.plus(row.loanAttributedAmount), new Decimal(0));
    const approvedPrincipal = new Decimal(loan.principalAmount);
    const variance = netDisbursed.minus(approvedPrincipal);
    const evidenceByEvent = new Map<number, string[]>();
    for (const row of rows) evidenceByEvent.set(row.id, await evidenceIds(ctx, row.id));
    return {
        loanPublicId: loan.publicId,
        summary: { approvedPrincipal: serializeMoney(approvedPrincipal), netDisbursed: serializeMoney(netDisbursed), variance: variance.toFixed(2), status: variance.isZero() ? "matched" : variance.isNegative() ? "under_disbursed" : "over_disbursed" },
        events: await Promise.all(rows.map((row) => presentEvent(row, evidenceByEvent.get(row.id) ?? []))),
    };
}

export async function postDisbursement(ctx: CommandContext, disbursementPublicId: string) {
    const idempotencyKey = ctx.idempotencyKey?.trim();
    if (!idempotencyKey) throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key is required to post a disbursement", 400);
    rejectReservedIdempotencyKey(idempotencyKey);
    const { event } = await accessibleEvent(ctx, disbursementPublicId);
    return db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`loan-disbursement-post:${ctx.tenantId}:${idempotencyKey}`}, 0))`);
        const reusedKey = await tx.query.loanDisbursementEvents.findFirst({ where: and(
            eq(loanDisbursementEvents.tenantId, ctx.tenantId), eq(loanDisbursementEvents.postIdempotencyKey, idempotencyKey),
        ) });
        if (reusedKey && reusedKey.id !== event.id) {
            throw new DomainError("IDEMPOTENCY_KEY_CONFLICT", "Idempotency-Key was already used for another disbursement post", 409);
        }
        const current = await lockLoanAndEvent(tx, ctx, event.id);
        if (current.status === "posted") {
            if (current.postIdempotencyKey === idempotencyKey) {
                return { ...await presentEvent(current, await evidenceIds(ctx, current.id, tx), tx), duplicate: true, auditPublicId: null, correlationId: ctx.correlationId };
            }
            throw new DomainError("DISBURSEMENT_ALREADY_POSTED", "Disbursement was already posted with another idempotency key", 409);
        }
        if (current.status !== "draft") throw new DomainError("DISBURSEMENT_LOCKED", "Reversed disbursements cannot be posted", 409);
        const attached = await tx.select().from(loanDisbursementEvidence).where(and(
            eq(loanDisbursementEvidence.tenantId, ctx.tenantId), eq(loanDisbursementEvidence.loanDisbursementEventId, current.id),
        ));
        for (const attachment of attached) {
            const intent = await tx.query.loanDisbursementEvidenceIntents.findFirst({ where: and(
                eq(loanDisbursementEvidenceIntents.tenantId, ctx.tenantId),
                eq(loanDisbursementEvidenceIntents.loanDisbursementEventId, current.id),
                eq(loanDisbursementEvidenceIntents.fileId, attachment.fileId),
                eq(loanDisbursementEvidenceIntents.status, "ready"),
            ) });
            if (!intent) throw new DomainError("EVIDENCE_NOT_FINALIZED", "Every attached evidence file must be finalized before posting", 409);
        }
        const updated = await tx.update(loanDisbursementEvents).set({ status: "posted", postedAt: new Date(), postIdempotencyKey: idempotencyKey })
            .where(and(eq(loanDisbursementEvents.id, current.id), eq(loanDisbursementEvents.status, "draft"))).returning().then((rows) => rows[0]);
        if (!updated) throw new DomainError("DISBURSEMENT_LOCKED", "Disbursement can no longer be posted", 409);
        const audit = await writeAudit(tx, ctx, updated, "posted", { idempotencyKey, grossAmount: serializeMoney(updated.grossAmount), loanAttributedAmount: serializeMoney(updated.loanAttributedAmount) });
        return { ...await presentEvent(updated, await evidenceIds(ctx, updated.id, tx), tx), duplicate: false, auditPublicId: audit.publicId, correlationId: ctx.correlationId };
    });
}

export async function reverseDisbursement(ctx: CommandContext, disbursementPublicId: string, reason: string) {
    const idempotencyKey = ctx.idempotencyKey?.trim();
    if (!idempotencyKey) throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key is required to reverse a disbursement", 400);
    rejectReservedIdempotencyKey(idempotencyKey);
    const note = reason.trim();
    if (!note) throw new DomainError("REVERSAL_REASON_REQUIRED", "A reversal reason is required", 400);
    const { event } = await accessibleEvent(ctx, disbursementPublicId);
    const reversalRequestHash = disbursementReversalRequestHash(disbursementPublicId, note);
    return db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`loan-disbursement-reverse:${ctx.tenantId}:${idempotencyKey}`}, 0))`);
        const reusedKey = await tx.query.loanDisbursementEvents.findFirst({ where: and(
            eq(loanDisbursementEvents.tenantId, ctx.tenantId), eq(loanDisbursementEvents.reversalIdempotencyKey, idempotencyKey),
        ) });
        if (reusedKey && (reusedKey.reversedEventId !== event.id || reusedKey.reversalRequestHash !== reversalRequestHash)) {
            throw new DomainError("REVERSAL_IDEMPOTENCY_CONFLICT", "Idempotency-Key was already used for another reversal or payload", 409);
        }
        const original = await lockLoanAndEvent(tx, ctx, event.id);
        if (original.status !== "posted") throw new DomainError("DISBURSEMENT_NOT_POSTED", "Only posted disbursements can be reversed", 409);
        const intermediaryProjectionAudit = await tx.query.auditLogs.findFirst({ where: and(
            eq(auditLogs.tenantId, ctx.tenantId),
            eq(auditLogs.entityType, "loan_disbursement"),
            eq(auditLogs.entityId, original.publicId),
            eq(auditLogs.action, "intermediated_posted"),
        ) });
        if (intermediaryProjectionAudit) {
            throw new DomainError(
                "INTERMEDIATED_DISBURSEMENT_REVERSAL_REQUIRED",
                "Reverse this payout through its intermediary disbursement group",
                409,
            );
        }
        const existing = await tx.query.loanDisbursementEvents.findFirst({ where: and(eq(loanDisbursementEvents.tenantId, ctx.tenantId), eq(loanDisbursementEvents.reversedEventId, original.id)) });
        if (existing) {
            if (existing.reversalIdempotencyKey === idempotencyKey && existing.reversalRequestHash === reversalRequestHash) {
                return { ...await presentEvent(existing, await evidenceIds(ctx, existing.id, tx), tx), reversedEventPublicId: original.publicId, duplicate: true, auditPublicId: null, correlationId: ctx.correlationId };
            }
            throw new DomainError("REVERSAL_IDEMPOTENCY_CONFLICT", "Disbursement was already reversed with another idempotency key or reason", 409);
        }
        const reversal = await tx.insert(loanDisbursementEvents).values({
            tenantId: ctx.tenantId, loanId: original.loanId, grossAmount: original.grossAmount, loanAttributedAmount: original.loanAttributedAmount,
            channel: original.channel, sourceBankProfileId: original.sourceBankProfileId, payeeHint: original.payeeHint, status: "reversed", reversedEventId: original.id, restructureId: original.restructureId,
            note, disbursedAt: original.disbursedAt, postedAt: new Date(), reversedAt: new Date(), createdByUserId: ctx.actorUserId,
            reversalIdempotencyKey: idempotencyKey, reversalRequestHash,
        }).returning().then((rows) => rows[0]!);
        const audit = await writeAudit(tx, ctx, reversal, "reversed", { reversedEventPublicId: original.publicId, reason: note, idempotencyKey });
        return { ...await presentEvent(reversal, [], tx), reversedEventPublicId: original.publicId, duplicate: false, auditPublicId: audit.publicId, correlationId: ctx.correlationId };
    });
}

export async function prepareDisbursementEvidence(ctx: CommandContext, disbursementPublicId: string, input: PrepareDisbursementEvidenceInput, gateway: DisbursementEvidenceStorageGateway = defaultEvidenceGateway) {
    const maxBytes = Math.max(1, Number(process.env.EVIDENCE_MAX_BYTES ?? 20 * 1024 * 1024));
    if (!allowedEvidenceTypes.has(input.mimeType) || !Number.isSafeInteger(input.size) || input.size <= 0 || input.size > maxBytes || !sha256Pattern.test(input.sha256)) {
        throw new DomainError("INVALID_EVIDENCE", "Evidence must have an allowed MIME type, positive size, and SHA-256 checksum", 400);
    }
    const { event } = await accessibleEvent(ctx, disbursementPublicId);
    if (event.status !== "draft") throw new DomainError("DISBURSEMENT_LOCKED", "Evidence can only be prepared for a draft", 409);
    const sha256 = input.sha256.toLowerCase();
    const existing = await db.query.loanDisbursementEvidenceIntents.findFirst({ where: and(
        eq(loanDisbursementEvidenceIntents.tenantId, ctx.tenantId), eq(loanDisbursementEvidenceIntents.evidenceHash, sha256),
    ) });
    if (existing) {
        if (existing.loanDisbursementEventId !== event.id) {
            if (existing.status === "pending" && evidenceIntentExpired(existing)) {
                await db.transaction(async (tx) => {
                    await tx.execute(sql`SELECT id FROM loan_disbursement_evidence_intents WHERE tenant_id = ${ctx.tenantId} AND id = ${existing.id} FOR UPDATE`);
                    const current = await tx.query.loanDisbursementEvidenceIntents.findFirst({ where: and(eq(loanDisbursementEvidenceIntents.id, existing.id), eq(loanDisbursementEvidenceIntents.tenantId, ctx.tenantId)) });
                    if (current?.status === "pending" && evidenceIntentExpired(current)) {
                        await tx.delete(loanDisbursementEvidenceIntents).where(eq(loanDisbursementEvidenceIntents.id, current.id));
                        await tx.delete(files).where(and(eq(files.id, current.fileId), eq(files.tenantId, ctx.tenantId)));
                    }
                });
                return prepareDisbursementEvidence(ctx, disbursementPublicId, input, gateway);
            }
            throw new DomainError("EVIDENCE_HASH_CONFLICT", "Evidence checksum belongs to another disbursement", 409);
        }
        const file = await db.query.files.findFirst({ where: and(eq(files.id, existing.fileId), eq(files.tenantId, ctx.tenantId)) });
        if (!file) throw new DomainError("EVIDENCE_FILE_NOT_FOUND", "Evidence file not found", 404);
        if (existing.status === "ready") return { id: existing.publicId, publicId: existing.publicId, filePublicId: file.publicId, status: "ready" as const };
        if (existing.mimeType !== input.mimeType || existing.declaredSize !== input.size) throw new DomainError("EVIDENCE_HASH_CONFLICT", "Existing evidence intent has different metadata", 409);
        if (evidenceIntentExpired(existing)) {
            await db.transaction(async (tx) => {
                const current = await tx.query.loanDisbursementEvidenceIntents.findFirst({ where: and(eq(loanDisbursementEvidenceIntents.id, existing.id), eq(loanDisbursementEvidenceIntents.tenantId, ctx.tenantId)) });
                if (current?.status === "pending" && evidenceIntentExpired(current)) {
                    await tx.delete(loanDisbursementEvidenceIntents).where(eq(loanDisbursementEvidenceIntents.id, current.id));
                    await tx.delete(files).where(and(eq(files.id, current.fileId), eq(files.tenantId, ctx.tenantId)));
                }
            });
            return prepareDisbursementEvidence(ctx, disbursementPublicId, input, gateway);
        }
        const signed = await gateway.preparePut({ bucket: file.bucket, key: file.key, contentType: input.mimeType, contentLength: input.size, checksumSha256: sha256, metadata: { tenant: ctx.tenantId, disbursement: event.publicId } });
        await db.transaction(async (tx) => {
            const current = await lockLoanAndEvent(tx, ctx, event.id);
            if (current.status !== "draft") throw new DomainError("DISBURSEMENT_LOCKED", "Evidence can only be prepared for a draft", 409);
            await tx.update(loanDisbursementEvidenceIntents).set({ uploadExpiresAt: signed.expiresAt, updatedByUserId: ctx.actorUserId, updatedAt: new Date() })
                .where(and(eq(loanDisbursementEvidenceIntents.id, existing.id), eq(loanDisbursementEvidenceIntents.status, "pending")));
        });
        return { id: existing.publicId, publicId: existing.publicId, filePublicId: file.publicId, objectKey: file.key, uploadUrl: signed.uploadUrl, expiresAt: signed.expiresAt, requiredHeaders: signed.requiredHeaders ?? { "content-type": input.mimeType, "x-amz-checksum-sha256": Buffer.from(sha256, "hex").toString("base64"), "x-amz-meta-tenant": ctx.tenantId, "x-amz-meta-disbursement": event.publicId } };
    }
    const key = `loan-disbursement-evidence/${ctx.tenantId}/${event.publicId}/${crypto.randomUUID()}`;
    let created: { file: typeof files.$inferSelect; intent: typeof loanDisbursementEvidenceIntents.$inferSelect };
    try {
        created = await db.transaction(async (tx) => {
            const current = await lockLoanAndEvent(tx, ctx, event.id);
            if (current.status !== "draft") throw new DomainError("DISBURSEMENT_LOCKED", "Evidence can only be prepared for a draft", 409);
            const file = await tx.insert(files).values({ tenantId: ctx.tenantId, ownerUserId: ctx.actorUserId, bucket: BUCKET_NAME, key, originalName: normalizedText(input.originalName), mimeType: input.mimeType, size: input.size, url: toStorageReference({ provider: "s3", bucket: BUCKET_NAME, key }) }).returning().then((rows) => rows[0]!);
            const intent = await tx.insert(loanDisbursementEvidenceIntents).values({ tenantId: ctx.tenantId, loanDisbursementEventId: event.id, fileId: file.id, status: "pending", evidenceHash: sha256, mimeType: input.mimeType, declaredSize: input.size, createdByUserId: ctx.actorUserId, updatedByUserId: ctx.actorUserId }).returning().then((rows) => rows[0]!);
            return { file, intent };
        });
    } catch (error) {
        const databaseError = error as { code?: string; cause?: { code?: string } };
        if (databaseError.code === "23505" || databaseError.cause?.code === "23505") {
            throw new DomainError("EVIDENCE_HASH_CONFLICT", "Evidence checksum was reserved concurrently; retry the request", 409);
        }
        throw error;
    }
    let signed: Awaited<ReturnType<DisbursementEvidenceStorageGateway["preparePut"]>>;
    try {
        signed = await gateway.preparePut({ bucket: BUCKET_NAME, key, contentType: input.mimeType, contentLength: input.size, checksumSha256: sha256, metadata: { tenant: ctx.tenantId, disbursement: event.publicId } });
        await db.transaction(async (tx) => {
            const current = await lockLoanAndEvent(tx, ctx, event.id);
            if (current.status !== "draft") throw new DomainError("DISBURSEMENT_LOCKED", "Evidence can only be prepared for a draft", 409);
            await tx.update(loanDisbursementEvidenceIntents).set({ uploadExpiresAt: signed.expiresAt, updatedByUserId: ctx.actorUserId, updatedAt: new Date() })
                .where(and(eq(loanDisbursementEvidenceIntents.id, created.intent.id), eq(loanDisbursementEvidenceIntents.status, "pending")));
        });
    } catch (error) {
        await db.transaction(async (tx) => {
            await tx.delete(loanDisbursementEvidenceIntents).where(and(eq(loanDisbursementEvidenceIntents.id, created.intent.id), eq(loanDisbursementEvidenceIntents.status, "pending")));
            await tx.delete(files).where(and(eq(files.id, created.file.id), eq(files.tenantId, ctx.tenantId)));
        });
        throw error;
    }
    return { id: created.intent.publicId, publicId: created.intent.publicId, filePublicId: created.file.publicId, objectKey: key, uploadUrl: signed.uploadUrl, expiresAt: signed.expiresAt, requiredHeaders: signed.requiredHeaders ?? { "content-type": input.mimeType, "x-amz-checksum-sha256": Buffer.from(sha256, "hex").toString("base64"), "x-amz-meta-tenant": ctx.tenantId, "x-amz-meta-disbursement": event.publicId } };
}

export async function finalizeDisbursementEvidence(ctx: CommandContext, disbursementPublicId: string, evidencePublicId: string, gateway: DisbursementEvidenceStorageGateway = defaultEvidenceGateway) {
    requirePublicId(evidencePublicId, "evidencePublicId");
    const { event } = await accessibleEvent(ctx, disbursementPublicId);
    const intent = await db.query.loanDisbursementEvidenceIntents.findFirst({ where: and(eq(loanDisbursementEvidenceIntents.publicId, evidencePublicId), eq(loanDisbursementEvidenceIntents.tenantId, ctx.tenantId), eq(loanDisbursementEvidenceIntents.loanDisbursementEventId, event.id)) });
    if (!intent) throw new DomainError("EVIDENCE_NOT_FOUND", "Disbursement evidence not found", 404);
    const file = await db.query.files.findFirst({ where: and(eq(files.id, intent.fileId), eq(files.tenantId, ctx.tenantId)) });
    if (!file) throw new DomainError("EVIDENCE_FILE_NOT_FOUND", "Evidence file not found", 404);
    if (intent.status === "ready") return { id: intent.publicId, publicId: intent.publicId, filePublicId: file.publicId, status: "ready" as const, sha256: intent.evidenceHash };
    const head = await gateway.head(file.key, file.bucket);
    if (!head.exists || head.contentType !== intent.mimeType || head.contentLength !== intent.declaredSize || head.checksumSha256?.toLowerCase() !== intent.evidenceHash || head.metadata.tenant !== ctx.tenantId || head.metadata.disbursement !== event.publicId) {
        throw new DomainError("EVIDENCE_METADATA_MISMATCH", "Stored evidence metadata, size, type, or ownership does not match", 409);
    }
    return db.transaction(async (tx) => {
        const current = await lockLoanAndEvent(tx, ctx, event.id);
        if (current.status !== "draft") throw new DomainError("DISBURSEMENT_LOCKED", "Evidence can only be finalized for a draft", 409);
        const locked = await tx.query.loanDisbursementEvidenceIntents.findFirst({ where: and(eq(loanDisbursementEvidenceIntents.id, intent.id), eq(loanDisbursementEvidenceIntents.tenantId, ctx.tenantId)) });
        if (!locked) throw new DomainError("EVIDENCE_NOT_FOUND", "Disbursement evidence not found", 404);
        if (locked.status === "ready") return { id: locked.publicId, publicId: locked.publicId, filePublicId: file.publicId, status: "ready" as const, sha256: locked.evidenceHash };
        if (evidenceIntentExpired(locked)) throw new DomainError("EVIDENCE_UPLOAD_EXPIRED", "Evidence upload intent has expired", 409);
        const updated = await tx.update(loanDisbursementEvidenceIntents).set({ status: "ready", finalizedAt: new Date(), updatedByUserId: ctx.actorUserId, updatedAt: new Date() })
            .where(and(eq(loanDisbursementEvidenceIntents.id, locked.id), eq(loanDisbursementEvidenceIntents.status, "pending"))).returning().then((rows) => rows[0]);
        if (!updated) throw new DomainError("EVIDENCE_FINALIZE_CONFLICT", "Evidence can no longer be finalized", 409);
        await tx.insert(loanDisbursementEvidence).values({ tenantId: ctx.tenantId, loanDisbursementEventId: current.id, fileId: file.id }).onConflictDoNothing();
        await writeAudit(tx, ctx, current, "evidence_finalized", { evidencePublicId: updated.publicId, filePublicId: file.publicId, sha256: updated.evidenceHash });
        return { id: updated.publicId, publicId: updated.publicId, filePublicId: file.publicId, status: "ready" as const, sha256: updated.evidenceHash };
    });
}
