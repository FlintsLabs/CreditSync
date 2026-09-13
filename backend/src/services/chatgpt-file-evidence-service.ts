import { createHash } from "node:crypto";
import { Resolver } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import { and, eq, sql } from "drizzle-orm";

import { db } from "../db";
import { auditLogs, files, loanDisbursementEvidenceIntents, paymentEvidence, paymentEvidenceSupplements, paymentIntakes, users } from "../db/schema";
import { registerFinancialEvidenceRequirement } from "./financial-evidence-requirement-service";
import { canAccessTenantWideData } from "../lib/access";
import { createAuditLog } from "../lib/audit-log";
import {
    BUCKET_NAME,
    deleteStoredObject,
    headStoredObject,
    createSignedPutUrl,
    type SignedPutRequest,
    putStoredObject,
    toStorageReference,
    type StoredObjectHead,
} from "../lib/storage";
import { assertDisbursementEvidenceImportTarget, disbursementEvidenceFinalizedAuditPublicId, finalizeDisbursementEvidence, prepareDisbursementEvidence, type DisbursementEvidenceStorageGateway } from "./loan-disbursement-service";
import { recordMcpBreadcrumb } from "../mcp/diagnostic-context";
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
    resolveHost?: (hostname: string, signal?: AbortSignal) => Promise<string[]>;
    timeoutMs?: number;
};

export interface ChatGptEvidenceStorageGateway {
    put(request: SignedPutRequest, body: Uint8Array): Promise<unknown>;
    head(key: string, bucket?: string): Promise<StoredObjectHead>;
    delete(key: string, bucket?: string): Promise<void>;
}

export type ChatGptEvidenceDependencies = ChatGptDownloadDependencies & {
    storage?: ChatGptEvidenceStorageGateway;
    disbursementStorage?: ChatGptEvidenceStorageGateway;
    disbursementEvidenceGateway?: DisbursementEvidenceStorageGateway;
    authorizeDisbursement?: (ctx: CommandContext, disbursementPublicId: string) => Promise<unknown>;
};

const allowedMimeTypes = new Set(["image/jpeg", "image/png", "application/pdf"]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function configuredHosts() {
    return new Set((process.env.CHATGPT_FILE_DOWNLOAD_HOSTS ?? "")
        .split(",").map((value) => value.trim().toLocaleLowerCase("und")).filter(Boolean));
}

function ipv4Number(address: string) {
    const octets = address.split(".").map((part) => Number(part));
    if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
    return (((octets[0]! * 256 + octets[1]!) * 256 + octets[2]!) * 256 + octets[3]!);
}

function ipv6Words(address: string) {
    const withoutZone = address.split("%", 1)[0]!;
    const halves = withoutZone.split("::");
    if (halves.length > 2) return null;
    const parseHalf = (value: string) => {
        if (!value) return [] as number[];
        const words: number[] = [];
        for (const part of value.split(":")) {
            if (part.includes(".")) {
                const ipv4 = ipv4Number(part);
                if (ipv4 === null) return null;
                words.push(ipv4 >>> 16, ipv4 & 0xffff);
            } else {
                if (!/^[0-9a-f]{1,4}$/iu.test(part)) return null;
                words.push(Number.parseInt(part, 16));
            }
        }
        return words;
    };
    const left = parseHalf(halves[0]!);
    const right = parseHalf(halves[1] ?? "");
    if (!left || !right || halves.length === 1 && left.length !== 8 || halves.length === 2 && left.length + right.length >= 8) return null;
    return halves.length === 2 ? [...left, ...Array.from({ length: 8 - left.length - right.length }, () => 0), ...right] : left;
}

function privateAddress(address: string) {
    if (isIP(address) === 4) {
        const value = ipv4Number(address)!;
        const first = value >>> 24;
        const second = (value >>> 16) & 255;
        return first === 0 || first === 10 || first === 127 || first >= 224
            || (first === 100 && second >= 64 && second <= 127)
            || (first === 169 && second === 254)
            || (first === 172 && second >= 16 && second <= 31)
            || (first === 192 && second === 168)
            || (first === 192 && second === 0)
            || (first === 198 && second >= 18 && second <= 19);
    }
    if (isIP(address) === 6) {
        const words = ipv6Words(address);
        if (!words) return true;
        if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
            const mapped = (words[6]! << 16) | words[7]!;
            return privateAddress(`${mapped >>> 24}.${(mapped >>> 16) & 255}.${(mapped >>> 8) & 255}.${mapped & 255}`);
        }
        return words.every((word) => word === 0)
            || words.slice(0, 7).every((word) => word === 0) && words[7] === 1
            || (words[0]! & 0xfe00) === 0xfc00
            || (words[0]! & 0xffc0) === 0xfe80
            || (words[0]! & 0xff00) === 0xff00
            || words[0] === 0x2001 && words[1] === 0xdb8;
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

function pinnedHttpsFetch(url: URL, init: RequestInit, address: string): Promise<Response> {
    return new Promise((resolve, reject) => {
        const externalSignal = init.signal;
        if (externalSignal?.aborted) return reject(new DOMException("The operation was aborted", "AbortError"));
        const req = httpsRequest({
            protocol: "https:", hostname: address, port: 443, path: `${url.pathname}${url.search}`,
            method: "GET", servername: url.hostname, headers: { host: url.host },
            rejectUnauthorized: true,
            lookup: (_hostname, _options, callback) => callback(null, address, isIP(address) as 4 | 6),
            signal: externalSignal ?? undefined,
        }, (response) => {
            const headers = new Headers();
            for (const [key, value] of Object.entries(response.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
            resolve(new Response(Readable.toWeb(response) as unknown as ReadableStream, { status: response.statusCode ?? 502, headers }));
        });
        req.once("error", (error) => {
            reject(error);
        });
        req.end();
    });
}

async function resolveHostAddresses(hostname: string, signal?: AbortSignal) {
    const resolver = new Resolver();
    const abort = () => resolver.cancel();
    signal?.addEventListener("abort", abort, { once: true });
    try {
        const results = await Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]);
        if (signal?.aborted) throw new DOMException("The operation was aborted", "AbortError");
        const addresses = results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
        if (!addresses.length) throw results.find((result) => result.status === "rejected")?.reason ?? new Error("DNS resolution returned no addresses");
        return addresses;
    } finally {
        signal?.removeEventListener("abort", abort);
        resolver.cancel();
    }
}

async function readWithDeadline<T>(operation: Promise<T>, deadline: number, onTimeout?: () => void): Promise<T> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new DOMException("The operation timed out", "TimeoutError");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            operation,
            new Promise<T>((_, reject) => {
                timer = setTimeout(() => {
                    onTimeout?.();
                    reject(new DOMException("The operation timed out", "TimeoutError"));
                }, remaining);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

export async function downloadChatGptFile(file: ChatGptFileParam, dependencies: ChatGptDownloadDependencies = {}): Promise<VerifiedDownload> {
    let url: URL;
    try { url = new URL(file.downloadUrl); } catch { throw new DomainError("CHATGPT_FILE_INVALID_URL", "ChatGPT file is unavailable", 400); }
    const host = url.hostname.toLocaleLowerCase("und");
    const hosts = dependencies.allowedHosts ?? configuredHosts();
    if (url.protocol !== "https:") throw new DomainError("CHATGPT_FILE_INVALID_URL", "ChatGPT file is unavailable", 400);
    if (!hosts.has(host) || url.username || url.password || url.port) throw new DomainError("CHATGPT_FILE_UNTRUSTED_HOST", "ChatGPT file host is not trusted", 400);
    const timeoutMs = Math.max(250, Math.min(120_000, dependencies.timeoutMs ?? Number(process.env.EVIDENCE_DOWNLOAD_TIMEOUT_MS ?? 15_000)));
    const deadline = Date.now() + timeoutMs;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(0, deadline - Date.now()));
    const resolveHost = dependencies.resolveHost ?? resolveHostAddresses;
    let addresses: string[];
    recordMcpBreadcrumb({ stage: "chatgpt_file.dns", outcome: "started" });
    try {
        addresses = await readWithDeadline(resolveHost(host, controller.signal), deadline, () => controller.abort());
        recordMcpBreadcrumb({ stage: "chatgpt_file.dns", outcome: "succeeded" });
    } catch (error) {
        recordMcpBreadcrumb({ stage: "chatgpt_file.dns", outcome: "failed", metadata: { timeout: error instanceof DOMException && error.name === "TimeoutError" } });
        clearTimeout(timeout);
        throw new DomainError(controller.signal.aborted || error instanceof DOMException && error.name === "TimeoutError" ? "CHATGPT_FILE_TIMEOUT" : "CHATGPT_FILE_UNAVAILABLE", controller.signal.aborted || error instanceof DOMException && error.name === "TimeoutError" ? "ChatGPT file download timed out" : "ChatGPT file is temporarily unavailable", 409);
    }
    if (!addresses.length || addresses.some((address) => privateAddress(address))) {
        clearTimeout(timeout);
        throw new DomainError("CHATGPT_FILE_UNTRUSTED_HOST", "ChatGPT file host is not trusted", 400);
    }

    let response: Response;
    recordMcpBreadcrumb({ stage: "chatgpt_file.download", outcome: "started" });
    try {
        const fetcher = dependencies.fetch ?? ((value: string, init: RequestInit) => pinnedHttpsFetch(new URL(value), init, addresses[0]!));
        response = await readWithDeadline(fetcher(url.toString(), { redirect: "error", signal: controller.signal }), deadline, () => controller.abort());
        recordMcpBreadcrumb({ stage: "chatgpt_file.download", outcome: "succeeded" });
    } catch {
        recordMcpBreadcrumb({ stage: "chatgpt_file.download", outcome: "failed", metadata: { timeout: controller.signal.aborted } });
        clearTimeout(timeout);
        throw new DomainError(controller.signal.aborted ? "CHATGPT_FILE_TIMEOUT" : "CHATGPT_FILE_UNAVAILABLE", controller.signal.aborted ? "ChatGPT file download timed out" : "ChatGPT file is temporarily unavailable", 409);
    }
    try {
    if (response.status >= 300 && response.status < 400) throw new DomainError("CHATGPT_FILE_REDIRECT", "ChatGPT file redirects are not allowed", 400);
    if (!response.ok || !response.body) throw new DomainError("CHATGPT_FILE_UNAVAILABLE", "ChatGPT file is temporarily unavailable", 409);
    const responseMime = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLocaleLowerCase("und") ?? "";
    recordMcpBreadcrumb({ stage: "chatgpt_file.validate", outcome: "started" });
    if (!allowedMimeTypes.has(responseMime)) { recordMcpBreadcrumb({ stage: "chatgpt_file.validate", outcome: "failed" }); throw new DomainError("CHATGPT_FILE_UNSUPPORTED_MIME", "ChatGPT file type is not supported", 400); }
    if (file.mimeType && file.mimeType.toLocaleLowerCase("und") !== responseMime) throw new DomainError("CHATGPT_FILE_MIME_MISMATCH", "ChatGPT file type does not match", 400);
    const maxBytes = dependencies.maxBytes ?? Math.max(1, Number(process.env.EVIDENCE_MAX_BYTES ?? 20 * 1024 * 1024));
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new DomainError("CHATGPT_FILE_TOO_LARGE", "ChatGPT file exceeds the evidence size limit", 413);

    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = response.body.getReader();
    while (true) {
        try {
            const item = await readWithDeadline(reader.read(), deadline, () => controller.abort());
            if (item.done) break;
            size += item.value.byteLength;
            if (size > maxBytes) {
                controller.abort();
                void reader.cancel().catch(() => undefined);
                throw new DomainError("CHATGPT_FILE_TOO_LARGE", "ChatGPT file exceeds the evidence size limit", 413);
            }
            chunks.push(item.value);
        } catch (error) {
            if (error instanceof DomainError) throw error;
            controller.abort();
            void reader.cancel().catch(() => undefined);
            throw new DomainError(controller.signal.aborted ? "CHATGPT_FILE_TIMEOUT" : "CHATGPT_FILE_UNAVAILABLE", controller.signal.aborted ? "ChatGPT file download timed out" : "ChatGPT file is temporarily unavailable", 409);
        }
    }
    if (size === 0) throw new DomainError("CHATGPT_FILE_EMPTY", "ChatGPT file is empty", 400);
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    if (detectedMimeType(bytes) !== responseMime) throw new DomainError("CHATGPT_FILE_SIGNATURE_MISMATCH", "ChatGPT file contents do not match its type", 400);
    recordMcpBreadcrumb({ stage: "chatgpt_file.validate", outcome: "succeeded" });
    return { bytes, mimeType: responseMime, size, sha256: createHash("sha256").update(bytes).digest("hex"), fileName: safeOriginalName(file.fileName) };
    } finally {
        clearTimeout(timeout);
    }
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
        const storedAuditPublicId = "auditPublicId" in existing ? existing.auditPublicId : null;
        const importAudit = storedAuditPublicId ? null : await db.query.auditLogs.findFirst({
            columns: { publicId: true },
            where: and(
                eq(auditLogs.tenantId, ctx.tenantId),
                eq(auditLogs.entityType, supplement ? "payment_evidence_supplement" : "payment_evidence"),
                eq(auditLogs.entityId, existing.publicId),
                eq(auditLogs.action, "chatgpt_file_imported"),
            ),
        });
        const auditPublicId = storedAuditPublicId ?? importAudit?.publicId;
        if (!auditPublicId) throw new DomainError("EVIDENCE_AUDIT_NOT_FOUND", "Ready evidence audit metadata is unavailable", 503);
        return safeResult(existing, storedFile.publicId, auditPublicId, ctx.correlationId);
    }
    if (!supplement) await db.transaction(async (tx) => registerFinancialEvidenceRequirement(tx, ctx, { kind: "payment_intake", publicId: intake.publicId }, 1, {
        attemptKey: `chatgpt:${fingerprint}`,
        importIdempotencyKey: idempotencyKey,
        sourceFileFingerprint: fingerprint,
        bindingKind: "payment",
    }));
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

/**
 * Import a ChatGPT attachment into an existing payout draft. This deliberately
 * composes the payout evidence lifecycle: it never creates a payment intake,
 * activates a loan, or posts a disbursement.
 */
export async function importChatGptDisbursementEvidence(
    ctx: CommandContext,
    disbursementPublicId: string,
    source: ChatGptFileParam,
    dependencies: ChatGptEvidenceDependencies = {},
) {
    if (!source.fileId.trim()) throw new DomainError("CHATGPT_FILE_INVALID", "ChatGPT file is unavailable", 400);
    const idempotencyKey = ctx.idempotencyKey?.trim();
    if (!idempotencyKey) throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", "A stable idempotency key is required", 400);
    const event = await (dependencies.authorizeDisbursement
        ? dependencies.authorizeDisbursement(ctx, disbursementPublicId)
        : assertDisbursementEvidenceImportTarget(ctx, disbursementPublicId));
    const sourceFileFingerprint = createHash("sha256").update(source.fileId).digest("hex");
    const existing = await db.query.loanDisbursementEvidenceIntents.findFirst({ where: and(
        eq(loanDisbursementEvidenceIntents.tenantId, ctx.tenantId),
        eq(loanDisbursementEvidenceIntents.importIdempotencyKey, idempotencyKey),
    ) });
    if (existing) {
        if (existing.loanDisbursementEventId !== (event as { id: number }).id || existing.sourceFileFingerprint !== sourceFileFingerprint) throw new DomainError("EVIDENCE_IDEMPOTENCY_CONFLICT", "Evidence import idempotency payload does not match", 409);
        if (existing.status === "ready") {
            const file = await db.query.files.findFirst({ where: and(eq(files.tenantId, ctx.tenantId), eq(files.id, existing.fileId)) });
            if (!file) throw new DomainError("EVIDENCE_FILE_NOT_FOUND", "Evidence file not found", 404);
            const auditPublicId = await disbursementEvidenceFinalizedAuditPublicId(ctx, (event as { publicId: string }).publicId, existing.publicId, existing.finalizedAuditPublicId);
            if (!auditPublicId) throw new DomainError("EVIDENCE_AUDIT_NOT_FOUND", "Ready evidence audit metadata is unavailable", 503);
            return { publicId: existing.publicId, filePublicId: file.publicId, status: "ready" as const, sha256: existing.evidenceHash, auditPublicId, correlationId: ctx.correlationId };
        }
    }
    const existingSourceIdentity = await db.query.loanDisbursementEvidenceIntents.findFirst({ where: and(
        eq(loanDisbursementEvidenceIntents.tenantId, ctx.tenantId),
        eq(loanDisbursementEvidenceIntents.loanDisbursementEventId, (event as { id: number }).id),
        eq(loanDisbursementEvidenceIntents.sourceFileFingerprint, sourceFileFingerprint),
    ) });
    if (existingSourceIdentity?.importIdempotencyKey && existingSourceIdentity.importIdempotencyKey !== idempotencyKey) {
        throw new DomainError("EVIDENCE_IDEMPOTENCY_CONFLICT", "Evidence file identity is already bound to another import", 409);
    }
    await db.transaction(async (tx) => registerFinancialEvidenceRequirement(
        tx,
        ctx,
        { kind: "loan_disbursement", publicId: (event as { publicId: string }).publicId },
        1,
        {
            attemptKey: `chatgpt:${sourceFileFingerprint}`,
            importIdempotencyKey: idempotencyKey,
            sourceFileFingerprint,
            bindingKind: "disbursement",
        },
    ));
    const verified = await downloadChatGptFile(source, dependencies);
    const evidenceGateway = dependencies.disbursementEvidenceGateway ?? { preparePut: createSignedPutUrl, head: headStoredObject };
    const prepareInput = {
        mimeType: verified.mimeType,
        size: verified.size,
        sha256: verified.sha256,
        originalName: verified.fileName,
        importIdempotencyKey: idempotencyKey,
        sourceFileFingerprint,
        requirementAttemptKey: `chatgpt:${sourceFileFingerprint}`,
    } as const;
    let intent;
    try {
        intent = await prepareDisbursementEvidence(ctx, disbursementPublicId, prepareInput, evidenceGateway);
    } catch (error) {
        if (!(error instanceof DomainError) || error.code !== "EVIDENCE_HASH_CONFLICT") throw error;
        const raced = await db.query.loanDisbursementEvidenceIntents.findFirst({ where: and(eq(loanDisbursementEvidenceIntents.tenantId, ctx.tenantId), eq(loanDisbursementEvidenceIntents.importIdempotencyKey, idempotencyKey)) });
        if (!raced || raced.loanDisbursementEventId !== (event as { id: number }).id || raced.sourceFileFingerprint !== sourceFileFingerprint) throw new DomainError("EVIDENCE_IDEMPOTENCY_CONFLICT", "Evidence import idempotency payload does not match", 409);
        if (raced.evidenceHash !== verified.sha256 || raced.mimeType !== verified.mimeType || raced.declaredSize !== verified.size) throw new DomainError("EVIDENCE_IDEMPOTENCY_CONFLICT", "Evidence import content does not match the original request", 409);
        intent = await prepareDisbursementEvidence(ctx, disbursementPublicId, prepareInput, evidenceGateway);
    }
    if (intent.status === "ready") {
        const readyIntent = await db.query.loanDisbursementEvidenceIntents.findFirst({ where: and(
            eq(loanDisbursementEvidenceIntents.tenantId, ctx.tenantId),
            eq(loanDisbursementEvidenceIntents.publicId, intent.publicId),
        ) });
        const auditPublicId = readyIntent ? await disbursementEvidenceFinalizedAuditPublicId(ctx, (event as { publicId: string }).publicId, intent.publicId, readyIntent.finalizedAuditPublicId) : null;
        if (!readyIntent || !auditPublicId) throw new DomainError("EVIDENCE_AUDIT_NOT_FOUND", "Ready evidence audit metadata is unavailable", 503);
        return { publicId: intent.publicId, filePublicId: intent.filePublicId, status: "ready" as const, sha256: verified.sha256, auditPublicId, correlationId: ctx.correlationId };
    }
    if (!intent.objectKey) throw new DomainError("EVIDENCE_IMPORT_NOT_RESUMABLE", "Payout evidence storage progress cannot be resumed", 503);
    const storage = dependencies.disbursementStorage ?? defaultStorage;
    const request: SignedPutRequest = {
        bucket: BUCKET_NAME,
        key: intent.objectKey,
        contentType: verified.mimeType,
        contentLength: verified.size,
        checksumSha256: verified.sha256,
        metadata: { tenant: ctx.tenantId, disbursement: disbursementPublicId, sha256: verified.sha256 },
    };
    await storage.put(request, verified.bytes);
    const finalized = await finalizeDisbursementEvidence(ctx, disbursementPublicId, intent.publicId, {
        preparePut: evidenceGateway.preparePut,
        head: storage.head,
    });
    if (!finalized.auditPublicId) throw new DomainError("EVIDENCE_AUDIT_NOT_FOUND", "Ready evidence audit metadata is unavailable", 503);
    return { publicId: finalized.publicId, filePublicId: finalized.filePublicId, status: "ready" as const, sha256: finalized.sha256, auditPublicId: finalized.auditPublicId, correlationId: ctx.correlationId };
}

export type PaymentEvidenceSupplementReason = "upload_channel_unavailable" | "operator_omission" | "evidence_recovered" | "other";

export async function recordPaymentEvidenceSupplement(ctx: CommandContext, input: {
    paymentIntakePublicId: string; supplementPublicId: string; confirmed: true;
    reason: PaymentEvidenceSupplementReason; note?: string | null; idempotencyKey: string;
}) {
    if (input.confirmed !== true) throw new DomainError("EVIDENCE_SUPPLEMENT_CONFIRMATION_REQUIRED", "Explicit supplemental evidence confirmation is required", 409);
    const key = input.idempotencyKey.trim();
    const note = input.note?.trim() || null;
    if (!key) throw new DomainError("IDEMPOTENCY_KEY_REQUIRED", "A stable idempotency key is required", 400);
    if (input.reason === "other" && !note) throw new DomainError("EVIDENCE_SUPPLEMENT_NOTE_REQUIRED", "Reason other requires a note", 400);
    if (!uuidPattern.test(input.supplementPublicId)) throw new DomainError("INVALID_PUBLIC_ID", "supplementPublicId must be a UUID", 400);
    const intake = await accessibleIntake(ctx, input.paymentIntakePublicId);
    if (intake.status !== "posted") throw new DomainError("PAYMENT_INTAKE_NOT_POSTED", "Supplemental evidence requires an exact posted intake", 409);
    if (ctx.actorUserId === null) throw new DomainError("ACTOR_REQUIRED", "A tenant actor is required", 403);
    return db.transaction(async (tx) => {
        await tx.execute(sql`SELECT id FROM payment_intakes WHERE tenant_id = ${ctx.tenantId} AND id = ${intake.id} FOR UPDATE`);
        const replay = await tx.query.paymentEvidenceSupplements.findFirst({ where: and(eq(paymentEvidenceSupplements.tenantId, ctx.tenantId), eq(paymentEvidenceSupplements.recordIdempotencyKey, key)) });
        if (replay) {
            if (replay.publicId !== input.supplementPublicId || replay.reason !== input.reason || replay.note !== note) throw new DomainError("EVIDENCE_IDEMPOTENCY_CONFLICT", "Supplement record idempotency payload does not match", 409);
            const storedFile = await tx.query.files.findFirst({ where: and(eq(files.tenantId, ctx.tenantId), eq(files.id, replay.fileId)) });
            if (!storedFile) throw new DomainError("PAYMENT_EVIDENCE_NOT_FOUND", "Evidence file record not found", 404);
            return safeResult(replay, storedFile.publicId, replay.auditPublicId, replay.correlationId);
        }
        await tx.execute(sql`SELECT id FROM payment_evidence_supplements WHERE tenant_id = ${ctx.tenantId} AND public_id = ${input.supplementPublicId} FOR UPDATE`);
        const current = await tx.query.paymentEvidenceSupplements.findFirst({ where: and(eq(paymentEvidenceSupplements.tenantId, ctx.tenantId), eq(paymentEvidenceSupplements.publicId, input.supplementPublicId), eq(paymentEvidenceSupplements.paymentIntakeId, intake.id)) });
        if (!current || current.status !== "ready") throw new DomainError("EVIDENCE_SUPPLEMENT_NOT_READY", "Supplemental evidence is not ready", 409);
        const audit = await createAuditLog(tx, { tenantId: ctx.tenantId, actorUserId: ctx.actorUserId, actorSource: ctx.actorSource, requestId: ctx.requestId, correlationId: ctx.correlationId, entityType: "payment_evidence_supplement", entityId: current.publicId, action: "recorded", payload: { paymentIntakePublicId: intake.publicId, supplementPublicId: current.publicId, reason: input.reason, notePresent: note !== null, mimeType: current.mimeType, size: current.declaredSize, sha256: current.evidenceHash } });
        const recorded = await tx.update(paymentEvidenceSupplements).set({ status: "recorded", reason: input.reason, note, recordIdempotencyKey: key, auditPublicId: audit.publicId, correlationId: ctx.correlationId, recordedByUserId: ctx.actorUserId, recordedAt: new Date() }).where(and(eq(paymentEvidenceSupplements.id, current.id), eq(paymentEvidenceSupplements.status, "ready"))).returning().then((rows) => rows[0]);
        if (!recorded) throw new DomainError("EVIDENCE_SUPPLEMENT_NOT_READY", "Supplemental evidence is not ready", 409);
        const storedFile = await tx.query.files.findFirst({ where: and(eq(files.tenantId, ctx.tenantId), eq(files.id, recorded.fileId)) });
        if (!storedFile) throw new DomainError("PAYMENT_EVIDENCE_NOT_FOUND", "Evidence file record not found", 404);
        return safeResult(recorded, storedFile.publicId, audit.publicId, ctx.correlationId);
    });
}
