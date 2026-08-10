import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { auditLogs, bankProfiles, files, loanDisbursementEvidence, loanDisbursementEvents, loans, users } from "../db/schema";
import { canAccessTenantWideData } from "../lib/access";
import { parseMoney, serializeMoney } from "../lib/money";
import { BUCKET_NAME, createSignedPutUrl, headStoredObject, toStorageReference, type SignedPutRequest, type StoredObjectHead } from "../lib/storage";
import type { CommandContext } from "./command-context";
import { DomainError } from "./domain-error";

type Executor = any;
type EventRow = typeof loanDisbursementEvents.$inferSelect;

export interface DisbursementEvidenceStorageGateway {
    preparePut(request: SignedPutRequest): Promise<{ uploadUrl: string; expiresAt: Date }>;
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

function presentEvent(event: EventRow, evidenceFilePublicIds: string[] = []) {
    return {
        id: event.publicId, publicId: event.publicId, grossAmount: serializeMoney(event.grossAmount), loanAttributedAmount: serializeMoney(event.loanAttributedAmount),
        channel: event.channel, status: event.status, payeeHint: event.payeeHint, note: event.note, disbursedAt: event.disbursedAt,
        postedAt: event.postedAt, reversedAt: event.reversedAt, reversedEventId: event.reversedEventId, evidenceFilePublicIds,
    };
}

async function evidenceIds(ctx: CommandContext, eventId: number, executor: Executor = db) {
    const rows = await executor.select({ publicId: files.publicId }).from(loanDisbursementEvidence)
        .innerJoin(files, eq(loanDisbursementEvidence.fileId, files.id))
        .where(and(eq(loanDisbursementEvidence.tenantId, ctx.tenantId), eq(loanDisbursementEvidence.loanDisbursementEventId, eventId), eq(files.tenantId, ctx.tenantId)));
    return rows.map((row: { publicId: string }) => row.publicId);
}

async function lockEventAndLoan(tx: Executor, ctx: CommandContext, eventId: number) {
    await tx.execute(sql`SELECT id FROM loan_disbursement_events WHERE tenant_id = ${ctx.tenantId} AND id = ${eventId} FOR UPDATE`);
    const event = await tx.query.loanDisbursementEvents.findFirst({ where: and(eq(loanDisbursementEvents.id, eventId), eq(loanDisbursementEvents.tenantId, ctx.tenantId)) });
    if (!event) throw new DomainError("DISBURSEMENT_NOT_FOUND", "Disbursement not found", 404);
    await tx.execute(sql`SELECT id FROM loans WHERE tenant_id = ${ctx.tenantId} AND id = ${event.loanId} FOR UPDATE`);
    return event;
}

async function writeAudit(executor: Executor, ctx: CommandContext, event: EventRow, action: string, payload: unknown) {
    return executor.insert(auditLogs).values({ ...auditContext(ctx), entityType: "loan_disbursement", entityId: event.publicId, action, payload }).returning().then((rows: Array<typeof auditLogs.$inferSelect>) => rows[0]!);
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
        return presentEvent(created);
    });
}

export async function updateDisbursementDraft(ctx: CommandContext, disbursementPublicId: string, input: UpdateDisbursementDraftInput) {
    const { event } = await accessibleEvent(ctx, disbursementPublicId);
    return db.transaction(async (tx) => {
        const current = await lockEventAndLoan(tx, ctx, event.id);
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
        await writeAudit(tx, ctx, updated, "draft_updated", { grossAmount: values.grossAmount, loanAttributedAmount: values.loanAttributedAmount });
        return presentEvent(updated, await evidenceIds(ctx, updated.id, tx));
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
        events: rows.map((row) => presentEvent(row, evidenceByEvent.get(row.id) ?? [])),
    };
}

export async function postDisbursement(ctx: CommandContext, disbursementPublicId: string) {
    const idempotencyKey = ctx.idempotencyKey?.trim();
    if (!idempotencyKey) throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key is required to post a disbursement", 400);
    const { event } = await accessibleEvent(ctx, disbursementPublicId);
    return db.transaction(async (tx) => {
        const current = await lockEventAndLoan(tx, ctx, event.id);
        if (current.status === "posted") return { ...presentEvent(current, await evidenceIds(ctx, current.id, tx)), duplicate: true, auditPublicId: null, correlationId: ctx.correlationId };
        if (current.status !== "draft") throw new DomainError("DISBURSEMENT_LOCKED", "Reversed disbursements cannot be posted", 409);
        const updated = await tx.update(loanDisbursementEvents).set({ status: "posted", postedAt: new Date() })
            .where(and(eq(loanDisbursementEvents.id, current.id), eq(loanDisbursementEvents.status, "draft"))).returning().then((rows) => rows[0]);
        if (!updated) throw new DomainError("DISBURSEMENT_LOCKED", "Disbursement can no longer be posted", 409);
        const audit = await writeAudit(tx, ctx, updated, "posted", { idempotencyKey, grossAmount: serializeMoney(updated.grossAmount), loanAttributedAmount: serializeMoney(updated.loanAttributedAmount) });
        return { ...presentEvent(updated, await evidenceIds(ctx, updated.id, tx)), duplicate: false, auditPublicId: audit.publicId, correlationId: ctx.correlationId };
    });
}

export async function reverseDisbursement(ctx: CommandContext, disbursementPublicId: string, reason: string) {
    const idempotencyKey = ctx.idempotencyKey?.trim();
    if (!idempotencyKey) throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key is required to reverse a disbursement", 400);
    const note = reason.trim();
    if (!note) throw new DomainError("REVERSAL_REASON_REQUIRED", "A reversal reason is required", 400);
    const { event } = await accessibleEvent(ctx, disbursementPublicId);
    return db.transaction(async (tx) => {
        const original = await lockEventAndLoan(tx, ctx, event.id);
        if (original.status !== "posted") throw new DomainError("DISBURSEMENT_NOT_POSTED", "Only posted disbursements can be reversed", 409);
        const existing = await tx.query.loanDisbursementEvents.findFirst({ where: and(eq(loanDisbursementEvents.tenantId, ctx.tenantId), eq(loanDisbursementEvents.reversedEventId, original.id)) });
        if (existing) return { ...presentEvent(existing, await evidenceIds(ctx, existing.id, tx)), reversedEventPublicId: original.publicId, duplicate: true, auditPublicId: null, correlationId: ctx.correlationId };
        const reversal = await tx.insert(loanDisbursementEvents).values({
            tenantId: ctx.tenantId, loanId: original.loanId, grossAmount: original.grossAmount, loanAttributedAmount: original.loanAttributedAmount,
            channel: original.channel, sourceBankProfileId: original.sourceBankProfileId, payeeHint: original.payeeHint, status: "reversed", reversedEventId: original.id,
            note, disbursedAt: original.disbursedAt, postedAt: new Date(), reversedAt: new Date(), createdByUserId: ctx.actorUserId,
        }).returning().then((rows) => rows[0]!);
        const audit = await writeAudit(tx, ctx, reversal, "reversed", { reversedEventPublicId: original.publicId, reason: note, idempotencyKey });
        return { ...presentEvent(reversal), reversedEventPublicId: original.publicId, duplicate: false, auditPublicId: audit.publicId, correlationId: ctx.correlationId };
    });
}

export async function prepareDisbursementEvidence(ctx: CommandContext, disbursementPublicId: string, input: PrepareDisbursementEvidenceInput, gateway: DisbursementEvidenceStorageGateway = defaultEvidenceGateway) {
    if (!allowedEvidenceTypes.has(input.mimeType) || !Number.isInteger(input.size) || input.size <= 0 || !sha256Pattern.test(input.sha256)) {
        throw new DomainError("INVALID_EVIDENCE", "Evidence must have an allowed MIME type, positive size, and SHA-256 checksum", 400);
    }
    const { event } = await accessibleEvent(ctx, disbursementPublicId);
    if (event.status !== "draft") throw new DomainError("DISBURSEMENT_LOCKED", "Evidence can only be prepared for a draft", 409);
    const key = `loan-disbursement-evidence/${ctx.tenantId}/${event.publicId}/${crypto.randomUUID()}`;
    const signed = await gateway.preparePut({ bucket: BUCKET_NAME, key, contentType: input.mimeType, contentLength: input.size, checksumSha256: input.sha256.toLowerCase(), metadata: { tenant: ctx.tenantId, disbursement: event.publicId } });
    return db.transaction(async (tx) => {
        const current = await lockEventAndLoan(tx, ctx, event.id);
        if (current.status !== "draft") throw new DomainError("DISBURSEMENT_LOCKED", "Evidence can only be prepared for a draft", 409);
        const file = await tx.insert(files).values({ tenantId: ctx.tenantId, ownerUserId: ctx.actorUserId, bucket: BUCKET_NAME, key, originalName: normalizedText(input.originalName), mimeType: input.mimeType, size: input.size, url: toStorageReference({ provider: "s3", bucket: BUCKET_NAME, key }) }).returning().then((rows) => rows[0]!);
        return { filePublicId: file.publicId, objectKey: key, uploadUrl: signed.uploadUrl, expiresAt: signed.expiresAt, requiredHeaders: { "content-type": input.mimeType, "x-amz-checksum-sha256": Buffer.from(input.sha256, "hex").toString("base64"), "x-amz-meta-tenant": ctx.tenantId, "x-amz-meta-disbursement": event.publicId } };
    });
}

export async function finalizeDisbursementEvidence(ctx: CommandContext, disbursementPublicId: string, filePublicId: string, gateway: DisbursementEvidenceStorageGateway = defaultEvidenceGateway) {
    requirePublicId(filePublicId, "filePublicId");
    const { event } = await accessibleEvent(ctx, disbursementPublicId);
    const file = await db.query.files.findFirst({ where: and(eq(files.publicId, filePublicId), eq(files.tenantId, ctx.tenantId)) });
    if (!file) throw new DomainError("EVIDENCE_FILE_NOT_FOUND", "Evidence file not found", 404);
    const head = await gateway.head(file.key, file.bucket);
    if (!head.exists || head.contentType !== file.mimeType || head.contentLength !== file.size || head.metadata.tenant !== ctx.tenantId || head.metadata.disbursement !== event.publicId) {
        throw new DomainError("EVIDENCE_METADATA_MISMATCH", "Stored evidence metadata, size, type, or ownership does not match", 409);
    }
    return db.transaction(async (tx) => {
        const current = await lockEventAndLoan(tx, ctx, event.id);
        if (current.status !== "draft") throw new DomainError("DISBURSEMENT_LOCKED", "Evidence can only be finalized for a draft", 409);
        await tx.insert(loanDisbursementEvidence).values({ tenantId: ctx.tenantId, loanDisbursementEventId: current.id, fileId: file.id }).onConflictDoNothing();
        await writeAudit(tx, ctx, current, "evidence_finalized", { filePublicId });
        return { filePublicId, status: "ready" as const };
    });
}
