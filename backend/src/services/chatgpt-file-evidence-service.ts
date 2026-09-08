import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { and, eq, sql } from "drizzle-orm";

import { db } from "../db";
import { files, paymentEvidence, paymentEvidenceSupplements, paymentIntakes, users } from "../db/schema";
import { canAccessTenantWideData } from "../lib/access";
import { createAuditLog } from "../lib/audit-log";
import {
    BUCKET_NAME,
    deleteStoredObject,
    headStoredObject,
    putStoredObject,
    toStorageReference,
    type SignedPutRequest,
    type StoredObjectHead,
} from "../lib/storage";
import type { CommandContext } from "./command-context";
import { DomainError } from "./domain-error";

export type ChatGptFileParam = {
    downloadUrl: string;
    fileId: string;
    mimeType?: string | null;
    fileName?: string | null;
};

type VerifiedDownload = { bytes: Uint8Array; mimeType: string; size: number; sha256: string; fileName: string | null };
type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type ChatGptDownloadDependencies = {
    allowedHosts?: Set<string>;
    maxBytes?: number;
    fetch?: FetchLike;
    resolveHost?: (hostname: string) => Promise<string[]>;
};

export interface ChatGptEvidenceStorageGateway {
    put(request: SignedPutRequest, body: Uint8Array): Promise<unknown>;
    head(key: string, bucket?: string): Promise<StoredObjectHead>;
    delete(key: string, bucket?: string): Promise<void>;
}

export type ChatGptEvidenceDependencies = ChatGptDownloadDependencies & { storage?: ChatGptEvidenceStorageGateway };

const allowedMimeTypes = new Set(["image/jpeg", "image/png", "application/pdf"]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function configuredHosts() {
    return new Set((process.env.CHATGPT_FILE_DOWNLOAD_HOSTS ?? "")
        .split(",").map((value) => value.trim().toLocaleLowerCase("und")).filter(Boolean));
}

function privateAddress(address: string) {
    if (isIP(address) === 4) {
        const [a, b] = address.split(".").map(Number);
        return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)
            || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168)
            || a! >= 224;
    }
    if (isIP(address) === 6) {
        const normalized = address.toLocaleLowerCase("und");
        return normalized === "::" || normalized === "::1" || normalized.startsWith("fc")
            || normalized.startsWith("fd") || /^fe[89ab]/.test(normalized) || normalized.startsWith("ff");
    }
    return true;
}

function detectedMimeType(bytes: Uint8Array) {
    if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value)) return "image/png";
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
    if (bytes.length >= 5 && new TextDecoder().decode(bytes.slice(0, 5)) === "%PDF-") return "application/pdf";
    return null;
}

function safeOriginalName(name?: string | null) {
    if (!name) return null;
    const base = name.split(/[\\/]/).at(-1)?.replace(/[^a-zA-Z0-9._ -]/g, "_").trim();
    return base ? base.slice(0, 200) : null;
}

export async function downloadChatGptFile(file: ChatGptFileParam, dependencies: ChatGptDownloadDependencies = {}): Promise<VerifiedDownload> {
    let url: URL;
    try { url = new URL(file.downloadUrl); } catch { throw new DomainError("CHATGPT_FILE_INVALID_URL", "ChatGPT file is unavailable", 400); }
    const host = url.hostname.toLocaleLowerCase("und");
    const hosts = dependencies.allowedHosts ?? configuredHosts();
    if (url.protocol !== "https:") throw new DomainError("CHATGPT_FILE_INVALID_URL", "ChatGPT file is unavailable", 400);
    if (!hosts.has(host) || url.username || url.password || url.port) throw new DomainError("CHATGPT_FILE_UNTRUSTED_HOST", "ChatGPT file host is not trusted", 400);
    const resolveHost = dependencies.resolveHost ?? (async (hostname: string) => (await lookup(hostname, { all: true, verbatim: true })).map((item) => item.address));
    let addresses: string[];
    try { addresses = await resolveHost(host); } catch { throw new DomainError("CHATGPT_FILE_UNAVAILABLE", "ChatGPT file is temporarily unavailable", 409); }
    if (!addresses.length || addresses.some(privateAddress)) throw new DomainError("CHATGPT_FILE_UNTRUSTED_HOST", "ChatGPT file host is not trusted", 400);

    let response: Response;
    try { response = await (dependencies.fetch ?? globalThis.fetch)(url.toString(), { redirect: "error" }); }
    catch { throw new DomainError("CHATGPT_FILE_UNAVAILABLE", "ChatGPT file is temporarily unavailable", 409); }
    if (response.status >= 300 && response.status < 400) throw new DomainError("CHATGPT_FILE_REDIRECT", "ChatGPT file redirects are not allowed", 400);
    if (!response.ok || !response.body) throw new DomainError("CHATGPT_FILE_UNAVAILABLE", "ChatGPT file is temporarily unavailable", 409);
    const responseMime = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLocaleLowerCase("und") ?? "";
    if (!allowedMimeTypes.has(responseMime)) throw new DomainError("CHATGPT_FILE_UNSUPPORTED_MIME", "ChatGPT file type is not supported", 400);
    if (file.mimeType && file.mimeType.toLocaleLowerCase("und") !== responseMime) throw new DomainError("CHATGPT_FILE_MIME_MISMATCH", "ChatGPT file type does not match", 400);
    const maxBytes = dependencies.maxBytes ?? Math.max(1, Number(process.env.EVIDENCE_MAX_BYTES ?? 20 * 1024 * 1024));
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new DomainError("CHATGPT_FILE_TOO_LARGE", "ChatGPT file exceeds the evidence size limit", 413);

    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = response.body.getReader();
    while (true) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.byteLength;
        if (size > maxBytes) {
            await reader.cancel();
            throw new DomainError("CHATGPT_FILE_TOO_LARGE", "ChatGPT file exceeds the evidence size limit", 413);
        }
        chunks.push(item.value);
    }
    if (size === 0) throw new DomainError("CHATGPT_FILE_EMPTY", "ChatGPT file is empty", 400);
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    if (detectedMimeType(bytes) !== responseMime) throw new DomainError("CHATGPT_FILE_SIGNATURE_MISMATCH", "ChatGPT file contents do not match its type", 400);
    return { bytes, mimeType: responseMime, size, sha256: createHash("sha256").update(bytes).digest("hex"), fileName: safeOriginalName(file.fileName) };
}

async function accessibleIntake(ctx: CommandContext, publicId: string) {
    if (!uuidPattern.test(publicId)) throw new DomainError("INVALID_PUBLIC_ID", "paymentIntakeId must be a UUID", 400);
    const row = await db.query.paymentIntakes.findFirst({ where: and(eq(paymentIntakes.tenantId, ctx.tenantId), eq(paymentIntakes.publicId, publicId)) });
    if (!row) throw new DomainError("PAYMENT_INTAKE_NOT_FOUND", "Payment intake not found", 404);
    if (ctx.actorUserId !== null) {
        const actor = await db.query.users.findFirst({ where: and(eq(users.tenantId, ctx.tenantId), eq(users.id, ctx.actorUserId)) });
        if (!actor || (!canAccessTenantWideData({ role: actor.role ?? "viewer" }) && row.ownerUserId !== actor.id)) throw new DomainError("PAYMENT_INTAKE_NOT_FOUND", "Payment intake not found", 404);
    }
    return row;
}

const defaultStorage: ChatGptEvidenceStorageGateway = { put: putStoredObject, head: headStoredObject, delete: deleteStoredObject };

function safeResult(evidence: { publicId: string; status: string; evidenceHash: string | null; mimeType: string | null; declaredSize: number | null }, filePublicId: string, auditPublicId: string | null, correlationId: string) {
    return { publicId: evidence.publicId, filePublicId, status: evidence.status, mimeType: evidence.mimeType, size: evidence.declaredSize, sha256: evidence.evidenceHash, auditPublicId, correlationId };
}

async function importEvidence(ctx: CommandContext, intakePublicId: string, source: ChatGptFileParam, idempotencyKey: string, supplement: boolean, dependencies: ChatGptEvidenceDependencies) {
    if (!idempotencyKey.trim()) throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", "A stable idempotency key is required", 400);
    if (!source.fileId.trim()) throw new DomainError("CHATGPT_FILE_INVALID", "ChatGPT file is unavailable", 400);
    const intake = await accessibleIntake(ctx, intakePublicId);
    if (supplement && ctx.actorUserId === null) throw new DomainError("ACTOR_REQUIRED", "A tenant actor is required", 403);
    if (supplement ? intake.status !== "posted" : ["posted", "reversed", "duplicate"].includes(intake.status)) {
        throw new DomainError(supplement ? "PAYMENT_INTAKE_NOT_POSTED" : "PAYMENT_INTAKE_IMMUTABLE", supplement ? "Supplemental evidence requires an exact posted intake" : "Evidence cannot be added to this intake", 409);
    }
    const fingerprint = createHash("sha256").update(source.fileId).digest("hex");
    const existing = supplement
        ? await db.query.paymentEvidenceSupplements.findFirst({ where: and(eq(paymentEvidenceSupplements.tenantId, ctx.tenantId), eq(paymentEvidenceSupplements.importIdempotencyKey, idempotencyKey)) })
        : await db.query.paymentEvidence.findFirst({ where: and(eq(paymentEvidence.tenantId, ctx.tenantId), eq(paymentEvidence.importIdempotencyKey, idempotencyKey)) });
    if (existing) {
        if (existing.paymentIntakeId !== intake.id || existing.sourceFileFingerprint !== fingerprint || existing.status === "draft") throw new DomainError("EVIDENCE_IDEMPOTENCY_CONFLICT", "Evidence import idempotency payload does not match", 409);
        const storedFile = existing.fileId ? await db.query.files.findFirst({ where: and(eq(files.tenantId, ctx.tenantId), eq(files.id, existing.fileId)) }) : null;
        if (!storedFile) throw new DomainError("PAYMENT_EVIDENCE_NOT_FOUND", "Evidence file record not found", 404);
        return safeResult(existing, storedFile.publicId, "auditPublicId" in existing ? existing.auditPublicId : null, ctx.correlationId);
    }
    if (!supplement) {
        await db.transaction(async (tx) => {
            await tx.execute(sql`SELECT id FROM payment_intakes WHERE tenant_id = ${ctx.tenantId} AND id = ${intake.id} FOR UPDATE`);
            await tx.update(paymentIntakes).set({ evidenceRequired: true, updatedByUserId: ctx.actorUserId, updatedAt: new Date() }).where(and(eq(paymentIntakes.tenantId, ctx.tenantId), eq(paymentIntakes.id, intake.id)));
        });
    }
    const verified = await downloadChatGptFile(source, dependencies);
    const key = `payment-evidence/${ctx.tenantId}/${intake.publicId}/${crypto.randomUUID()}`;
    const request: SignedPutRequest = { bucket: BUCKET_NAME, key, contentType: verified.mimeType, contentLength: verified.size, checksumSha256: verified.sha256, metadata: { tenant: ctx.tenantId, intake: intake.publicId, sha256: verified.sha256 } };
    const storage = dependencies.storage ?? defaultStorage;
    let uploaded = false;
    try {
        await storage.put(request, verified.bytes); uploaded = true;
        const head = await storage.head(key, BUCKET_NAME);
        if (!head.exists || head.contentType !== verified.mimeType || head.contentLength !== verified.size || head.checksumSha256?.toLocaleLowerCase("und") !== verified.sha256 || head.metadata.tenant !== ctx.tenantId || head.metadata.intake !== intake.publicId || head.metadata.sha256 !== verified.sha256) {
            throw new DomainError("EVIDENCE_METADATA_MISMATCH", "Stored evidence metadata does not match", 409);
        }
        return await db.transaction(async (tx) => {
            await tx.execute(sql`SELECT id FROM payment_intakes WHERE tenant_id = ${ctx.tenantId} AND id = ${intake.id} FOR UPDATE`);
            const current = await tx.query.paymentIntakes.findFirst({ where: and(eq(paymentIntakes.tenantId, ctx.tenantId), eq(paymentIntakes.id, intake.id)) });
            if (!current || (supplement ? current.status !== "posted" : ["posted", "reversed", "duplicate"].includes(current.status))) throw new DomainError("PAYMENT_INTAKE_IMMUTABLE", "Payment intake changed during evidence import", 409);
            const storedFile = await tx.insert(files).values({ tenantId: ctx.tenantId, ownerUserId: ctx.actorUserId, bucket: BUCKET_NAME, key, originalName: verified.fileName, mimeType: verified.mimeType, size: verified.size, url: toStorageReference({ provider: "s3", bucket: BUCKET_NAME, key }) }).returning().then((rows) => rows[0]!);
            const row = supplement
                ? await tx.insert(paymentEvidenceSupplements).values({ tenantId: ctx.tenantId, paymentIntakeId: intake.id, fileId: storedFile.id, status: "ready", evidenceHash: verified.sha256, mimeType: verified.mimeType, declaredSize: verified.size, importIdempotencyKey: idempotencyKey, sourceFileFingerprint: fingerprint, correlationId: ctx.correlationId, createdByUserId: ctx.actorUserId!, readyAt: new Date() }).returning().then((rows) => rows[0]!)
                : await tx.insert(paymentEvidence).values({ tenantId: ctx.tenantId, paymentIntakeId: intake.id, fileId: storedFile.id, evidenceType: "slip", status: "ready", evidenceHash: verified.sha256, mimeType: verified.mimeType, declaredSize: verified.size, importIdempotencyKey: idempotencyKey, sourceFileFingerprint: fingerprint, finalizedAt: new Date(), createdByUserId: ctx.actorUserId, updatedByUserId: ctx.actorUserId }).returning().then((rows) => rows[0]!);
            const audit = await createAuditLog(tx, { tenantId: ctx.tenantId, actorUserId: ctx.actorUserId, actorSource: ctx.actorSource, requestId: ctx.requestId, correlationId: ctx.correlationId, entityType: supplement ? "payment_evidence_supplement" : "payment_evidence", entityId: row.publicId, action: "chatgpt_file_imported", payload: { intakePublicId: intake.publicId, mimeType: verified.mimeType, size: verified.size, sha256: verified.sha256, status: "ready" } });
            return safeResult(row, storedFile.publicId, audit.publicId, ctx.correlationId);
        });
    } catch (error) {
        if (uploaded) await storage.delete(key, BUCKET_NAME).catch(() => undefined);
        throw error;
    }
}

export function importChatGptPaymentEvidence(ctx: CommandContext, intakePublicId: string, file: ChatGptFileParam, idempotencyKey: string, dependencies: ChatGptEvidenceDependencies = {}) {
    return importEvidence(ctx, intakePublicId, file, idempotencyKey, false, dependencies);
}

export function importChatGptSupplementEvidence(ctx: CommandContext, intakePublicId: string, file: ChatGptFileParam, idempotencyKey: string, dependencies: ChatGptEvidenceDependencies = {}) {
    return importEvidence(ctx, intakePublicId, file, idempotencyKey, true, dependencies);
}
