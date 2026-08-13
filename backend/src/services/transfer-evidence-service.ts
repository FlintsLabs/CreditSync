import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import {
    files,
    intermediaries,
    intermediatedDisbursementGroupPreviews,
    intermediatedDisbursementGroups,
    intermediatedTransferEvidence,
    intermediatedTransferEvidenceIntents,
    intermediatedTransferEvents,
    loans,
    users,
} from "../db/schema";
import { canAccessTenantWideData } from "../lib/access";
import { createAuditLog } from "../lib/audit-log";
import {
    BUCKET_NAME,
    createSignedObjectAccess,
    createSignedPutUrl,
    headStoredObject,
    toStorageReference,
    type SignedPutRequest,
    type StoredObjectHead,
    type StoredObjectLocation,
} from "../lib/storage";
import type { CommandContext } from "./command-context";
import { DomainError } from "./domain-error";

type Executor = any;
type Actor = typeof users.$inferSelect;
type EvidenceIntent = typeof intermediatedTransferEvidenceIntents.$inferSelect;
type EvidenceFile = typeof files.$inferSelect;

export interface PrepareTransferEvidenceInput {
    mimeType: string;
    size: number;
    sha256: string;
    originalName?: string | null;
}

export interface TransferEvidenceStorageGateway {
    preparePut(request: SignedPutRequest): Promise<{
        uploadUrl: string;
        expiresAt: Date;
        requiredHeaders?: Record<string, string>;
    }>;
    head(key: string, bucket?: string): Promise<StoredObjectHead>;
    createAccess(location: StoredObjectLocation): Promise<{ url: string; expiresAt: Date }>;
}

const defaultGateway: TransferEvidenceStorageGateway = {
    preparePut: createSignedPutUrl,
    head: headStoredObject,
    createAccess: createSignedObjectAccess,
};
const allowedMimeTypes = new Set(["image/jpeg", "image/png", "application/pdf"]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sha256Pattern = /^[0-9a-f]{64}$/i;
const maxAccessTtlMs = 15 * 60_000;

function requirePublicId(value: string, field: string) {
    if (!uuidPattern.test(value)) {
        throw new DomainError("INVALID_PUBLIC_ID", `${field} must be a UUID`, 400, { field });
    }
}

function auditContext(ctx: CommandContext) {
    return {
        tenantId: ctx.tenantId,
        actorUserId: ctx.actorUserId,
        actorSource: ctx.actorSource,
        requestId: ctx.requestId,
        correlationId: ctx.correlationId,
    };
}

function auditPayload(
    groupPublicId: string,
    eventPublicId: string,
    intent: Pick<EvidenceIntent, "publicId" | "evidenceHash" | "status">,
    file: Pick<EvidenceFile, "publicId">,
) {
    return {
        groupPublicId,
        eventPublicId,
        evidencePublicId: intent.publicId,
        filePublicId: file.publicId,
        sha256: intent.evidenceHash,
        status: intent.status,
    };
}

function presentEvidence(intent: EvidenceIntent, file: EvidenceFile) {
    return {
        publicId: intent.publicId,
        filePublicId: file.publicId,
        status: intent.status as "pending" | "ready",
        mimeType: intent.mimeType,
        size: intent.declaredSize,
        sha256: intent.evidenceHash,
        originalName: file.originalName,
        finalizedAt: intent.finalizedAt?.toISOString() ?? null,
        createdAt: intent.createdAt.toISOString(),
    };
}

function validateInput(input: PrepareTransferEvidenceInput) {
    const maxBytes = Math.max(1, Number(process.env.EVIDENCE_MAX_BYTES ?? 20 * 1024 * 1024));
    if (!allowedMimeTypes.has(input.mimeType)
        || !Number.isSafeInteger(input.size)
        || input.size <= 0
        || input.size > maxBytes
        || !sha256Pattern.test(input.sha256)) {
        throw new DomainError(
            "INVALID_EVIDENCE",
            "Evidence must have an allowed MIME type, positive size, and SHA-256 checksum",
            400,
        );
    }
}

async function actorFor(ctx: CommandContext, executor: Executor = db): Promise<Actor | null> {
    if (ctx.actorUserId === null) return null;
    const actor = await executor.query.users.findFirst({ where: and(
        eq(users.tenantId, ctx.tenantId),
        eq(users.id, ctx.actorUserId),
    ) });
    if (!actor) throw new DomainError("ACTOR_NOT_FOUND", "Actor is not available in this tenant", 403);
    return actor;
}

function canReadOwner(actor: Actor | null, ownerUserId: number | null) {
    return !actor || canAccessTenantWideData({ role: actor.role ?? "viewer" }) || ownerUserId === actor.id;
}

async function accessibleParent(
    ctx: CommandContext,
    groupPublicId: string,
    eventPublicId: string,
    executor: Executor = db,
) {
    requirePublicId(groupPublicId, "groupPublicId");
    requirePublicId(eventPublicId, "eventPublicId");
    const actor = await actorFor(ctx, executor);
    const group = await executor.query.intermediatedDisbursementGroups.findFirst({ where: and(
        eq(intermediatedDisbursementGroups.tenantId, ctx.tenantId),
        eq(intermediatedDisbursementGroups.publicId, groupPublicId),
    ) });
    if (!group) throw new DomainError("INTERMEDIATED_DISBURSEMENT_NOT_FOUND", "Intermediated disbursement group not found", 404);
    const [loan, intermediary, event] = await Promise.all([
        executor.query.loans.findFirst({ where: and(eq(loans.tenantId, ctx.tenantId), eq(loans.id, group.loanId)) }),
        executor.query.intermediaries.findFirst({ where: and(eq(intermediaries.tenantId, ctx.tenantId), eq(intermediaries.id, group.intermediaryId)) }),
        executor.query.intermediatedTransferEvents.findFirst({ where: and(
            eq(intermediatedTransferEvents.tenantId, ctx.tenantId),
            eq(intermediatedTransferEvents.publicId, eventPublicId),
            eq(intermediatedTransferEvents.groupId, group.id),
        ) }),
    ]);
    if (!loan || !intermediary || !event || !canReadOwner(actor, loan.ownerUserId) || !canReadOwner(actor, intermediary.ownerUserId)) {
        throw new DomainError("INTERMEDIATED_DISBURSEMENT_NOT_FOUND", "Intermediated disbursement group not found", 404);
    }
    return { group, event };
}

function assertMutableParent(groupStatus: string, eventStatus: string) {
    if (["posted", "reversed"].includes(groupStatus) || ["posted", "reversed"].includes(eventStatus)) {
        throw new DomainError(
            "INTERMEDIATED_DISBURSEMENT_LOCKED",
            "Evidence cannot be changed after its transfer group or event is posted",
            409,
        );
    }
}

async function lockMutableParent(ctx: CommandContext, groupId: number, eventId: number, executor: Executor) {
    await executor.execute(sql`SELECT id FROM intermediated_disbursement_groups WHERE tenant_id = ${ctx.tenantId} AND id = ${groupId} FOR UPDATE`);
    const group = await executor.query.intermediatedDisbursementGroups.findFirst({ where: and(
        eq(intermediatedDisbursementGroups.tenantId, ctx.tenantId),
        eq(intermediatedDisbursementGroups.id, groupId),
    ) });
    if (!group) throw new DomainError("INTERMEDIATED_DISBURSEMENT_NOT_FOUND", "Intermediated disbursement group not found", 404);
    await executor.execute(sql`SELECT id FROM intermediated_transfer_events WHERE tenant_id = ${ctx.tenantId} AND id = ${eventId} AND group_id = ${groupId} FOR UPDATE`);
    const event = await executor.query.intermediatedTransferEvents.findFirst({ where: and(
        eq(intermediatedTransferEvents.tenantId, ctx.tenantId),
        eq(intermediatedTransferEvents.id, eventId),
        eq(intermediatedTransferEvents.groupId, groupId),
    ) });
    if (!event) throw new DomainError("TRANSFER_EVENT_NOT_FOUND", "Transfer event not found", 404);
    assertMutableParent(group.status, event.status);
    return { group, event };
}

async function evidenceFile(executor: Executor, ctx: CommandContext, intent: EvidenceIntent) {
    const file = await executor.query.files.findFirst({ where: and(
        eq(files.tenantId, ctx.tenantId),
        eq(files.id, intent.fileId),
    ) });
    if (!file) throw new DomainError("EVIDENCE_FILE_NOT_FOUND", "Transfer evidence file not found", 404);
    return file;
}

function requireMatchingInput(intent: EvidenceIntent, input: PrepareTransferEvidenceInput) {
    if (intent.mimeType !== input.mimeType || intent.declaredSize !== input.size) {
        throw new DomainError("EVIDENCE_HASH_CONFLICT", "Existing evidence intent has different metadata", 409);
    }
}

async function staleEvidencePreviews(executor: Executor, ctx: CommandContext, groupId: number) {
    await executor.update(intermediatedDisbursementGroupPreviews).set({ status: "stale" }).where(and(
        eq(intermediatedDisbursementGroupPreviews.tenantId, ctx.tenantId),
        eq(intermediatedDisbursementGroupPreviews.groupId, groupId),
        inArray(intermediatedDisbursementGroupPreviews.status, ["ready", "needs_review"]),
    ));
    await executor.update(intermediatedDisbursementGroups).set({
        status: "draft",
        updatedByUserId: ctx.actorUserId,
        updatedAt: new Date(),
    }).where(and(
        eq(intermediatedDisbursementGroups.tenantId, ctx.tenantId),
        eq(intermediatedDisbursementGroups.id, groupId),
    ));
}

export async function prepareTransferEvidence(
    ctx: CommandContext,
    groupPublicId: string,
    eventPublicId: string,
    input: PrepareTransferEvidenceInput,
    gateway: TransferEvidenceStorageGateway = defaultGateway,
) {
    validateInput(input);
    const parent = await accessibleParent(ctx, groupPublicId, eventPublicId);
    const sha256 = input.sha256.toLowerCase();

    return db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`intermediated-transfer-evidence:${ctx.tenantId}:${sha256}`}, 0))`);
        const existing = await tx.query.intermediatedTransferEvidenceIntents.findFirst({ where: and(
            eq(intermediatedTransferEvidenceIntents.tenantId, ctx.tenantId),
            eq(intermediatedTransferEvidenceIntents.evidenceHash, sha256),
        ) });
        if (existing) {
            if (existing.eventId !== parent.event.id) {
                throw new DomainError("EVIDENCE_HASH_CONFLICT", "Evidence checksum belongs to another transfer event", 409);
            }
            requireMatchingInput(existing, input);
            const file = await evidenceFile(tx, ctx, existing);
            if (existing.status === "ready") return presentEvidence(existing, file);
            await lockMutableParent(ctx, parent.group.id, parent.event.id, tx);
            const signed = await gateway.preparePut({
                bucket: file.bucket,
                key: file.key,
                contentType: input.mimeType,
                contentLength: input.size,
                checksumSha256: sha256,
                metadata: { tenant: ctx.tenantId, group: groupPublicId, event: eventPublicId },
            });
            const refreshed = await tx.update(intermediatedTransferEvidenceIntents).set({
                uploadExpiresAt: signed.expiresAt,
                updatedByUserId: ctx.actorUserId,
                updatedAt: new Date(),
            }).where(and(
                eq(intermediatedTransferEvidenceIntents.tenantId, ctx.tenantId),
                eq(intermediatedTransferEvidenceIntents.id, existing.id),
                eq(intermediatedTransferEvidenceIntents.status, "pending"),
            )).returning().then((rows) => rows[0]);
            if (!refreshed) throw new DomainError("EVIDENCE_PREPARE_CONFLICT", "Evidence can no longer be prepared", 409);
            await createAuditLog(tx, {
                ...auditContext(ctx),
                entityType: "intermediated_transfer_evidence",
                entityId: refreshed.publicId,
                action: "prepared",
                payload: auditPayload(groupPublicId, eventPublicId, refreshed, file),
            });
            return {
                ...presentEvidence(refreshed, file),
                uploadUrl: signed.uploadUrl,
                expiresAt: signed.expiresAt.toISOString(),
                requiredHeaders: signed.requiredHeaders ?? {},
            };
        }

        await lockMutableParent(ctx, parent.group.id, parent.event.id, tx);
        const key = `intermediated-transfer-evidence/${ctx.tenantId}/${groupPublicId}/${eventPublicId}/${crypto.randomUUID()}`;
        const signed = await gateway.preparePut({
            bucket: BUCKET_NAME,
            key,
            contentType: input.mimeType,
            contentLength: input.size,
            checksumSha256: sha256,
            metadata: { tenant: ctx.tenantId, group: groupPublicId, event: eventPublicId },
        });
        const file = await tx.insert(files).values({
            tenantId: ctx.tenantId,
            ownerUserId: ctx.actorUserId,
            bucket: BUCKET_NAME,
            key,
            originalName: input.originalName?.trim() || null,
            mimeType: input.mimeType,
            size: input.size,
            url: toStorageReference({ provider: "s3", bucket: BUCKET_NAME, key }),
        }).returning().then((rows) => rows[0]!);
        const intent = await tx.insert(intermediatedTransferEvidenceIntents).values({
            tenantId: ctx.tenantId,
            eventId: parent.event.id,
            fileId: file.id,
            status: "pending",
            evidenceHash: sha256,
            mimeType: input.mimeType,
            declaredSize: input.size,
            uploadExpiresAt: signed.expiresAt,
            createdByUserId: ctx.actorUserId,
            updatedByUserId: ctx.actorUserId,
        }).returning().then((rows) => rows[0]!);
        await staleEvidencePreviews(tx, ctx, parent.group.id);
        await createAuditLog(tx, {
            ...auditContext(ctx),
            entityType: "intermediated_transfer_evidence",
            entityId: intent.publicId,
            action: "prepared",
            payload: auditPayload(groupPublicId, eventPublicId, intent, file),
        });
        return {
            ...presentEvidence(intent, file),
            uploadUrl: signed.uploadUrl,
            expiresAt: signed.expiresAt.toISOString(),
            requiredHeaders: signed.requiredHeaders ?? {},
        };
    });
}

export async function finalizeTransferEvidence(
    ctx: CommandContext,
    groupPublicId: string,
    eventPublicId: string,
    evidencePublicId: string,
    gateway: TransferEvidenceStorageGateway = defaultGateway,
) {
    requirePublicId(evidencePublicId, "evidencePublicId");
    const parent = await accessibleParent(ctx, groupPublicId, eventPublicId);
    const intent = await db.query.intermediatedTransferEvidenceIntents.findFirst({ where: and(
        eq(intermediatedTransferEvidenceIntents.tenantId, ctx.tenantId),
        eq(intermediatedTransferEvidenceIntents.publicId, evidencePublicId),
        eq(intermediatedTransferEvidenceIntents.eventId, parent.event.id),
    ) });
    if (!intent) throw new DomainError("EVIDENCE_NOT_FOUND", "Transfer evidence not found", 404);
    const file = await evidenceFile(db, ctx, intent);
    if (intent.status === "ready") return presentEvidence(intent, file);
    assertMutableParent(parent.group.status, parent.event.status);
    if (intent.uploadExpiresAt.getTime() <= Date.now()) {
        throw new DomainError("EVIDENCE_UPLOAD_EXPIRED", "Evidence upload intent has expired", 409);
    }
    const head = await gateway.head(file.key, file.bucket);
    if (!head.exists
        || head.contentType !== intent.mimeType
        || head.contentLength !== intent.declaredSize
        || head.checksumSha256?.toLowerCase() !== intent.evidenceHash
        || head.metadata.tenant !== ctx.tenantId
        || head.metadata.group !== groupPublicId
        || head.metadata.event !== eventPublicId) {
        throw new DomainError(
            "EVIDENCE_METADATA_MISMATCH",
            "Stored evidence metadata, size, type, checksum, or ownership does not match",
            409,
        );
    }

    return db.transaction(async (tx) => {
        await lockMutableParent(ctx, parent.group.id, parent.event.id, tx);
        await tx.execute(sql`SELECT id FROM intermediated_transfer_evidence_intents WHERE tenant_id = ${ctx.tenantId} AND id = ${intent.id} FOR UPDATE`);
        const locked = await tx.query.intermediatedTransferEvidenceIntents.findFirst({ where: and(
            eq(intermediatedTransferEvidenceIntents.tenantId, ctx.tenantId),
            eq(intermediatedTransferEvidenceIntents.id, intent.id),
            eq(intermediatedTransferEvidenceIntents.eventId, parent.event.id),
        ) });
        if (!locked) throw new DomainError("EVIDENCE_NOT_FOUND", "Transfer evidence not found", 404);
        if (locked.status === "ready") return presentEvidence(locked, file);
        if (locked.uploadExpiresAt.getTime() <= Date.now()) {
            throw new DomainError("EVIDENCE_UPLOAD_EXPIRED", "Evidence upload intent has expired", 409);
        }
        const updated = await tx.update(intermediatedTransferEvidenceIntents).set({
            status: "ready",
            finalizedAt: new Date(),
            updatedByUserId: ctx.actorUserId,
            updatedAt: new Date(),
        }).where(and(
            eq(intermediatedTransferEvidenceIntents.tenantId, ctx.tenantId),
            eq(intermediatedTransferEvidenceIntents.id, locked.id),
            eq(intermediatedTransferEvidenceIntents.status, "pending"),
        )).returning().then((rows) => rows[0]);
        if (!updated) throw new DomainError("EVIDENCE_FINALIZE_CONFLICT", "Evidence can no longer be finalized", 409);
        await tx.insert(intermediatedTransferEvidence).values({
            tenantId: ctx.tenantId,
            eventId: parent.event.id,
            fileId: file.id,
            createdByUserId: ctx.actorUserId,
        });
        await createAuditLog(tx, {
            ...auditContext(ctx),
            entityType: "intermediated_transfer_evidence",
            entityId: updated.publicId,
            action: "finalized",
            payload: auditPayload(groupPublicId, eventPublicId, updated, file),
        });
        return presentEvidence(updated, file);
    });
}

export async function listTransferEvidence(
    ctx: CommandContext,
    groupPublicId: string,
    eventPublicId: string,
) {
    const parent = await accessibleParent(ctx, groupPublicId, eventPublicId);
    const rows = await db.select({
        intent: intermediatedTransferEvidenceIntents,
        file: files,
    }).from(intermediatedTransferEvidenceIntents)
        .innerJoin(files, and(
            eq(files.tenantId, intermediatedTransferEvidenceIntents.tenantId),
            eq(files.id, intermediatedTransferEvidenceIntents.fileId),
        ))
        .where(and(
            eq(intermediatedTransferEvidenceIntents.tenantId, ctx.tenantId),
            eq(intermediatedTransferEvidenceIntents.eventId, parent.event.id),
        ))
        .orderBy(asc(intermediatedTransferEvidenceIntents.id));
    return rows.map(({ intent, file }) => presentEvidence(intent, file));
}

export async function getTransferEvidenceAccess(
    ctx: CommandContext,
    groupPublicId: string,
    eventPublicId: string,
    evidencePublicId: string,
    gateway: TransferEvidenceStorageGateway = defaultGateway,
    clock: () => Date = () => new Date(),
) {
    requirePublicId(evidencePublicId, "evidencePublicId");
    const parent = await accessibleParent(ctx, groupPublicId, eventPublicId);
    const row = await db.select({
        intent: intermediatedTransferEvidenceIntents,
        file: files,
    }).from(intermediatedTransferEvidenceIntents)
        .innerJoin(files, and(
            eq(files.tenantId, intermediatedTransferEvidenceIntents.tenantId),
            eq(files.id, intermediatedTransferEvidenceIntents.fileId),
        ))
        .innerJoin(intermediatedTransferEvidence, and(
            eq(intermediatedTransferEvidence.tenantId, intermediatedTransferEvidenceIntents.tenantId),
            eq(intermediatedTransferEvidence.eventId, intermediatedTransferEvidenceIntents.eventId),
            eq(intermediatedTransferEvidence.fileId, intermediatedTransferEvidenceIntents.fileId),
        ))
        .where(and(
            eq(intermediatedTransferEvidenceIntents.tenantId, ctx.tenantId),
            eq(intermediatedTransferEvidenceIntents.eventId, parent.event.id),
            eq(intermediatedTransferEvidenceIntents.publicId, evidencePublicId),
            eq(intermediatedTransferEvidenceIntents.status, "ready"),
        )).then((rows) => rows[0]);
    if (!row) throw new DomainError("EVIDENCE_NOT_FOUND", "Finalized transfer evidence not found", 404);
    const descriptor = await gateway.createAccess({ provider: "s3", bucket: row.file.bucket, key: row.file.key });
    const now = clock().getTime();
    const expiresAt = descriptor.expiresAt.getTime();
    if (!Number.isFinite(expiresAt) || expiresAt <= now || expiresAt > now + maxAccessTtlMs) {
        throw new DomainError(
            "EVIDENCE_ACCESS_DESCRIPTOR_INVALID",
            "Evidence storage returned an invalid access expiry",
            502,
        );
    }
    return {
        publicId: row.intent.publicId,
        filePublicId: row.file.publicId,
        status: "ready" as const,
        mimeType: row.intent.mimeType,
        url: descriptor.url,
        expiresAt: descriptor.expiresAt.toISOString(),
    };
}
