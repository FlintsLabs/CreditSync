import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";

import { db } from "../db";
import { auditLogs, borrowers, files, loanDisbursementEvidence, loanDisbursementEvidenceIntents, loanDisbursementEvents, loanDisbursements, loanSchedules, loans, paymentIntakes, users } from "../db/schema";
import type { SignedPutRequest, StoredObjectHead } from "../lib/storage";
import { DomainError } from "./domain-error";
import { createDisbursementDraft, prepareDisbursementEvidence } from "./loan-disbursement-service";
import { importChatGptDisbursementEvidence, importChatGptPaymentEvidence, importChatGptSupplementEvidence, downloadChatGptFile, type ChatGptEvidenceDependencies, type ChatGptFileParam } from "./chatgpt-file-evidence-service";

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const file: ChatGptFileParam = {
    downloadUrl: "https://files.openai.test/download/token",
    fileId: "platform-file-id",
    mimeType: "image/png",
    fileName: "slip.png",
};

function dependencies(response: Response) {
    return {
        allowedHosts: new Set(["files.openai.test"]),
        maxBytes: 32,
        resolveHost: async () => ["93.184.216.34"],
        fetch: async (_url: string, init: RequestInit) => {
            expect(init.redirect).toBe("error");
            return response;
        },
    };
}

describe("bounded ChatGPT file download", () => {
    test("accepts a trusted HTTPS file and returns verified bytes without source identifiers", async () => {
        const result = await downloadChatGptFile(file, dependencies(new Response(png, {
            status: 200,
            headers: { "content-type": "image/png", "content-length": String(png.byteLength) },
        })));
        expect(result).toMatchObject({ mimeType: "image/png", size: png.byteLength });
        expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(JSON.stringify(result)).not.toContain(file.downloadUrl);
        expect(JSON.stringify(result)).not.toContain(file.fileId);
    });

    test.each([
        ["HTTP", { ...file, downloadUrl: "http://files.openai.test/x" }, new Response(png, { headers: { "content-type": "image/png" } })],
        ["untrusted host", { ...file, downloadUrl: "https://evil.test/x" }, new Response(png, { headers: { "content-type": "image/png" } })],
        ["redirect", file, new Response(null, { status: 302, headers: { location: "https://files.openai.test/elsewhere" } })],
        ["unsupported MIME", file, new Response(png, { headers: { "content-type": "text/html" } })],
        ["MIME mismatch", file, new Response(png, { headers: { "content-type": "image/jpeg" } })],
        ["signature mismatch", file, new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } })],
        ["oversize", file, new Response(new Uint8Array(33).fill(1), { headers: { "content-type": "image/png" } })],
    ])("rejects %s", async (_name, candidate, response) => {
        await expect(downloadChatGptFile(candidate as ChatGptFileParam, dependencies(response))).rejects.toMatchObject({
            code: expect.stringMatching(/^CHATGPT_FILE_/),
        });
    });

    test("rejects a host resolving to a private address before fetch", async () => {
        let fetched = false;
        await expect(downloadChatGptFile(file, {
            ...dependencies(new Response(png)),
            resolveHost: async () => ["127.0.0.1"],
            fetch: async () => { fetched = true; return new Response(png); },
        })).rejects.toMatchObject({ code: "CHATGPT_FILE_UNTRUSTED_HOST" });
        expect(fetched).toBe(false);
    });

    test.each(["::1", "::ffff:127.0.0.1", "fc00::1", "fe80::1", "100.64.0.1"])("rejects unsafe resolved address %s", async (address) => {
        let fetched = false;
        await expect(downloadChatGptFile(file, {
            ...dependencies(new Response(png)),
            resolveHost: async () => [address],
            fetch: async () => { fetched = true; return new Response(png); },
        })).rejects.toMatchObject({ code: "CHATGPT_FILE_UNTRUSTED_HOST" });
        expect(fetched).toBe(false);
    });

    test("propagates the shared abort signal through DNS and response body timeouts", async () => {
        let dnsAborted = false;
        await expect(downloadChatGptFile(file, {
            ...dependencies(new Response(png)),
            timeoutMs: 250,
            resolveHost: async (_hostname, signal) => await new Promise<string[]>((_, reject) => {
                signal?.addEventListener("abort", () => { dnsAborted = true; reject(new DOMException("aborted", "AbortError")); }, { once: true });
            }),
        })).rejects.toMatchObject({ code: "CHATGPT_FILE_TIMEOUT" });
        expect(dnsAborted).toBe(true);

        let bodyCancelled = false;
        const body = new ReadableStream<Uint8Array>({
            start(controller) { controller.enqueue(png); },
            pull() { return new Promise<void>(() => undefined); },
            cancel() { bodyCancelled = true; },
        });
        await expect(downloadChatGptFile(file, {
            ...dependencies(new Response(body, { headers: { "content-type": "image/png" } })),
            timeoutMs: 250,
        })).rejects.toMatchObject({ code: "CHATGPT_FILE_TIMEOUT" });
        expect(bodyCancelled).toBe(true);
    }, 3_000);

    test("enforces a bounded download timeout even when an injected fetch ignores AbortSignal", async () => {
        await expect(downloadChatGptFile(file, {
            ...dependencies(new Response(png)),
            timeoutMs: 250,
            fetch: async () => await new Promise<Response>(() => undefined),
        })).rejects.toMatchObject({ code: "CHATGPT_FILE_TIMEOUT" });
    }, 2_000);

    test("bounds a stalled response body and does not wait after headers", async () => {
        const stalledBody = new ReadableStream<Uint8Array>({
            start(controller) { controller.enqueue(png.slice(0, 8)); },
            pull() { return new Promise<void>(() => undefined); },
        });
        await expect(downloadChatGptFile(file, {
            ...dependencies(new Response(stalledBody, { headers: { "content-type": "image/png" } })),
            timeoutMs: 250,
        })).rejects.toMatchObject({ code: "CHATGPT_FILE_TIMEOUT" });
    }, 2_000);

    test("authorizes the exact payout draft before any attachment fetch", async () => {
        let fetched = false;
        const ctx = { tenantId: "tenant-a", actorUserId: 7, actorSource: "mcp" as const, requestId: crypto.randomUUID(), correlationId: crypto.randomUUID(), idempotencyKey: "payout-import-1" };
        await expect(importChatGptDisbursementEvidence(ctx, "0198c481-3e2b-7000-8000-000000000051", file, {
            ...dependencies(new Response(png)),
            authorizeDisbursement: async () => { throw new DomainError("DISBURSEMENT_NOT_FOUND", "Disbursement not found", 404); },
            fetch: async () => { fetched = true; return new Response(png); },
        })).rejects.toMatchObject({ code: "DISBURSEMENT_NOT_FOUND" });
        expect(fetched).toBe(false);
    });
});

const integrationTest = process.env.TEST_DATABASE_URL ? test : test.skip;

async function resetDisbursementEvidenceFixtures() {
    await db.execute(sql`TRUNCATE TABLE audit_logs, loan_disbursement_evidence, loan_disbursement_evidence_intents,
        loan_disbursement_events, loans, borrowers, users RESTART IDENTITY CASCADE`);
}

function dbContext(user: { id: number; tenantId: string }, idempotencyKey: string): import("./command-context").CommandContext {
    return { tenantId: user.tenantId, actorUserId: user.id, actorSource: "mcp", requestId: crypto.randomUUID(), correlationId: crypto.randomUUID(), idempotencyKey };
}

async function seededDraft() {
    const user = await db.insert(users).values({ tenantId: "tenant-a", email: `${crypto.randomUUID()}@example.test`, role: "owner" }).returning().then((rows) => rows[0]!);
    const borrower = await db.insert(borrowers).values({ tenantId: user.tenantId, ownerUserId: user.id, name: "Payout evidence borrower" }).returning().then((rows) => rows[0]!);
    const loan = await db.insert(loans).values({
        tenantId: user.tenantId, ownerUserId: user.id, borrowerId: borrower.id, principalAmount: "5000.00",
        interestRate: "0.00", repaymentType: "monthly", outstandingPrincipal: "5000.00",
        outstandingInterest: "0.00", outstandingFees: "0.00", status: "draft",
    }).returning().then((rows) => rows[0]!);
    const draft = await createDisbursementDraft(dbContext(user, "draft-key"), loan.publicId, {
        grossAmount: "5000.00", loanAttributedAmount: "5000.00", channel: "bank_transfer", disbursedAt: "2026-09-13T10:00:00.000Z",
    });
    return { user, loan, draft };
}

function responseFor(bytes: Uint8Array = png) {
    return new Response(Buffer.from(bytes), { status: 200, headers: { "content-type": "image/png", "content-length": String(bytes.byteLength) } });
}

function importerDependencies(counters: { fetch: number; prepare: number; put: number; head: number }, options: { failPut?: boolean; failPrepare?: boolean } = {}): ChatGptEvidenceDependencies {
    const objects = new Map<string, { request: SignedPutRequest; body: Uint8Array }>();
    const storage = {
        put: async (request: SignedPutRequest, body: Uint8Array) => {
            counters.put++;
            if (options.failPut) throw new Error("storage unavailable");
            objects.set(request.key, { request, body: Uint8Array.from(body) });
        },
        head: async (key: string, _bucket?: string): Promise<StoredObjectHead> => {
            counters.head++;
            const object = objects.get(key);
            if (!object) return { exists: false, contentType: null, contentLength: null, checksumSha256: null, metadata: {} };
            return { exists: true, contentType: object.request.contentType, contentLength: object.body.byteLength, checksumSha256: object.request.checksumSha256, metadata: object.request.metadata ?? {} };
        },
        delete: async () => undefined,
    };
    return {
        ...dependencies(responseFor()),
        fetch: async (_url: string, _init: RequestInit) => { counters.fetch++; return responseFor(); },
        disbursementEvidenceGateway: {
            preparePut: async (request: SignedPutRequest) => {
                counters.prepare++;
                if (options.failPrepare) throw new Error("signer unavailable");
                return { uploadUrl: `https://storage.example.test/${counters.prepare}`, expiresAt: new Date(Date.now() + 60_000), requiredHeaders: { "content-type": request.contentType } };
            },
            head: storage.head,
        },
        disbursementStorage: storage,
    };
}

if (process.env.TEST_DATABASE_URL) {
    beforeEach(resetDisbursementEvidenceFixtures);
    afterEach(resetDisbursementEvidenceFixtures);
}

integrationTest("imports payout evidence into a draft without creating or posting a financial record", async () => {
    const { user, loan, draft } = await seededDraft();
    const counters = { fetch: 0, prepare: 0, put: 0, head: 0 };
    const result = await importChatGptDisbursementEvidence(dbContext(user, "import-one"), draft.publicId, file, importerDependencies(counters));
    const resultPublicId = result.publicId;
    const resultAuditPublicId = result.auditPublicId;
    const resultSha256 = result.sha256;
    expect(result.status).toBe("ready");
    expect(typeof resultSha256).toBe("string");
    expect(typeof resultAuditPublicId).toBe("string");
    expect(counters).toEqual({ fetch: 1, prepare: 1, put: 1, head: 1 });
    expect(await db.select().from(paymentIntakes)).toHaveLength(0);
    expect(await db.query.loanDisbursementEvents.findFirst({ where: eq(loanDisbursementEvents.publicId, draft.publicId) })).toMatchObject({ status: "draft" });
    expect(await db.query.loans.findFirst({ where: eq(loans.id, loan.id) })).toMatchObject({ status: "draft" });
    const intent = await db.query.loanDisbursementEvidenceIntents.findFirst({ where: eq(loanDisbursementEvidenceIntents.publicId, resultPublicId) });
    expect(intent?.status).toBe("ready");
    expect(intent?.importIdempotencyKey).toBe("import-one");
    expect(typeof intent?.sourceFileFingerprint).toBe("string");
    expect(intent?.finalizedAuditPublicId).toBe(resultAuditPublicId);
    expect(await db.select().from(loanDisbursementEvidence)).toHaveLength(1);
    expect(await db.select().from(auditLogs).where(eq(auditLogs.publicId, resultAuditPublicId))).toHaveLength(1);
    expect(await db.select().from(loanSchedules).where(eq(loanSchedules.loanId, loan.id))).toHaveLength(0);
    expect(await db.select().from(loanDisbursements).where(eq(loanDisbursements.loanId, loan.id))).toHaveLength(0);
});

integrationTest("retries ready evidence by stable key without fetching an expired ChatGPT URL", async () => {
    const { user, draft } = await seededDraft();
    const counters = { fetch: 0, prepare: 0, put: 0, head: 0 };
    const deps = importerDependencies(counters);
    const first = await importChatGptDisbursementEvidence(dbContext(user, "import-retry"), draft.publicId, file, deps);
    const retry = await importChatGptDisbursementEvidence(dbContext(user, "import-retry"), draft.publicId, { ...file, downloadUrl: "https://files.openai.test/expired" }, deps);
    expect(retry).toEqual({ ...first, correlationId: retry.correlationId });
    expect(counters).toEqual({ fetch: 1, prepare: 1, put: 1, head: 1 });
});

integrationTest("keeps pending import idempotency across storage failure and expired upload intent", async () => {
    const { user, draft } = await seededDraft();
    const failedCounters = { fetch: 0, prepare: 0, put: 0, head: 0 };
    await expect(importChatGptDisbursementEvidence(dbContext(user, "import-recover"), draft.publicId, file, importerDependencies(failedCounters, { failPut: true }))).rejects.toThrow("storage unavailable");
    const pending = await db.query.loanDisbursementEvidenceIntents.findFirst({ where: eq(loanDisbursementEvidenceIntents.importIdempotencyKey, "import-recover") });
    expect(pending).toMatchObject({ status: "pending" });
    await db.update(loanDisbursementEvidenceIntents).set({ uploadExpiresAt: new Date(Date.now() - 1) }).where(eq(loanDisbursementEvidenceIntents.id, pending!.id));
    const retryCounters = { fetch: 0, prepare: 0, put: 0, head: 0 };
    const result = await importChatGptDisbursementEvidence(dbContext(user, "import-recover"), draft.publicId, file, importerDependencies(retryCounters));
    expect(result).toMatchObject({ publicId: pending!.publicId, status: "ready" });
    expect(await db.select().from(loanDisbursementEvidenceIntents).where(eq(loanDisbursementEvidenceIntents.importIdempotencyKey, "import-recover"))).toHaveLength(1);
});

integrationTest("concurrent same-key imports converge to one ready association and audit", async () => {
    const { user, draft } = await seededDraft();
    const counters = { fetch: 0, prepare: 0, put: 0, head: 0 };
    const deps = importerDependencies(counters);
    const results = await Promise.all([
        importChatGptDisbursementEvidence(dbContext(user, "import-concurrent"), draft.publicId, file, deps),
        importChatGptDisbursementEvidence(dbContext(user, "import-concurrent"), draft.publicId, file, deps),
    ]);
    expect(results[0]!.publicId).toBe(results[1]!.publicId);
    expect(results[0]!.filePublicId).toBe(results[1]!.filePublicId);
    expect(await db.select().from(loanDisbursementEvidenceIntents)).toHaveLength(1);
    expect(await db.select().from(loanDisbursementEvidence)).toHaveLength(1);
    expect(await db.select().from(auditLogs).where(eq(auditLogs.action, "evidence_finalized"))).toHaveLength(1);
});

integrationTest("rejects target and source identity conflicts before a second download", async () => {
    const first = await seededDraft();
    const second = await createDisbursementDraft(dbContext(first.user, "draft-two"), first.loan.publicId, {
        grossAmount: "1.00", loanAttributedAmount: "1.00", channel: "cash", disbursedAt: "2026-09-13T11:00:00.000Z",
    });
    const counters = { fetch: 0, prepare: 0, put: 0, head: 0 };
    const deps = importerDependencies(counters);
    await importChatGptDisbursementEvidence(dbContext(first.user, "import-conflict"), first.draft.publicId, file, deps);
    await expect(importChatGptDisbursementEvidence(dbContext(first.user, "import-conflict"), second.publicId, file, deps)).rejects.toMatchObject({ code: "EVIDENCE_IDEMPOTENCY_CONFLICT" });
    await expect(importChatGptDisbursementEvidence(dbContext(first.user, "import-conflict"), first.draft.publicId, { ...file, fileId: "different-file" }, deps)).rejects.toMatchObject({ code: "EVIDENCE_IDEMPOTENCY_CONFLICT" });
    expect(counters.fetch).toBe(1);
});

integrationTest.each([false, true])("direct prepare preserves expired import reservation (different draft: %s)", async (differentDraft) => {
    const { user, loan, draft } = await seededDraft();
    const counters = { fetch: 0, prepare: 0, put: 0, head: 0 };
    await expect(importChatGptDisbursementEvidence(
        dbContext(user, "durable-import"), draft.publicId, file,
        importerDependencies(counters, { failPut: true }),
    )).rejects.toThrow("storage unavailable");
    const original = await db.query.loanDisbursementEvidenceIntents.findFirst({
        where: eq(loanDisbursementEvidenceIntents.importIdempotencyKey, "durable-import"),
    });
    expect(original).toBeDefined();
    await db.update(loanDisbursementEvidenceIntents).set({ uploadExpiresAt: new Date(0) })
        .where(eq(loanDisbursementEvidenceIntents.id, original!.id));
    const target = differentDraft ? await createDisbursementDraft(dbContext(user, "other-draft"), loan.publicId, {
        grossAmount: "1.00", loanAttributedAmount: "1.00", channel: "cash", disbursedAt: "2026-09-13T11:00:00.000Z",
    }) : draft;
    const deps = importerDependencies(counters);
    const preparation = prepareDisbursementEvidence(dbContext(user, "direct-prepare"), target.publicId, {
        mimeType: "image/png", size: png.byteLength, sha256: original!.evidenceHash,
    }, deps.disbursementEvidenceGateway);
    if (differentDraft) {
        await expect(preparation).rejects.toMatchObject({ code: "EVIDENCE_HASH_CONFLICT" });
    } else {
        expect((await preparation).publicId).toBe(original!.publicId);
    }
    const retained = await db.query.loanDisbursementEvidenceIntents.findFirst({
        where: eq(loanDisbursementEvidenceIntents.importIdempotencyKey, "durable-import"),
    });
    expect(retained?.publicId).toBe(original!.publicId);
    expect(retained?.fileId).toBe(original!.fileId);
    expect(await db.select().from(files)).toHaveLength(1);
});

integrationTest("an in-flight direct prepare cannot clear a concurrently claimed import key", async () => {
    const { user, draft } = await seededDraft();
    const counters = { fetch: 0, prepare: 0, put: 0, head: 0 };
    const deps = importerDependencies(counters, { failPut: true });
    const verified = await downloadChatGptFile(file, deps);
    const input = { mimeType: "image/png", size: png.byteLength, sha256: verified.sha256 };
    const first = await prepareDisbursementEvidence(dbContext(user, "direct-first"), draft.publicId, input, deps.disbursementEvidenceGateway);
    let release!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const preparing = new Promise<void>((resolve) => { entered = resolve; });
    const direct = prepareDisbursementEvidence(dbContext(user, "direct-racing"), draft.publicId, input, {
        ...deps.disbursementEvidenceGateway!,
        preparePut: async (request) => {
            const signed = await deps.disbursementEvidenceGateway!.preparePut(request);
            entered();
            await paused;
            return signed;
        },
    });
    await preparing;
    try {
        await expect(importChatGptDisbursementEvidence(dbContext(user, "claimed-during-prepare"), draft.publicId, file, deps))
            .rejects.toThrow("storage unavailable");
    } finally {
        release();
    }
    await direct;
    const retained = await db.query.loanDisbursementEvidenceIntents.findFirst({
        where: eq(loanDisbursementEvidenceIntents.publicId, first.publicId),
    });
    expect(retained?.importIdempotencyKey).toBe("claimed-during-prepare");
    expect(typeof retained?.sourceFileFingerprint).toBe("string");
});

integrationTest.each([false, true])("payment import ready retry retains its audit receipt (supplement: %s)", async (supplement) => {
    const { user } = await seededDraft();
    const intake = await db.insert(paymentIntakes).values({
        tenantId: user.tenantId, ownerUserId: user.id, amount: "1.00", status: supplement ? "posted" : "draft", source: "mcp",
    }).returning().then((rows) => rows[0]!);
    const counters = { fetch: 0, prepare: 0, put: 0, head: 0 };
    const deps = importerDependencies(counters);
    const paymentDeps = { ...deps, storage: deps.disbursementStorage };
    const importer = supplement ? importChatGptSupplementEvidence : importChatGptPaymentEvidence;
    const first = await importer(dbContext(user, "receipt-import"), intake.publicId, file, "receipt-import", paymentDeps);
    const firstAuditId = first.auditPublicId;
    const firstEvidenceId = first.publicId;
    expect(typeof firstAuditId).toBe("string");
    const retry = await importer(dbContext(user, "receipt-import"), intake.publicId, {
        ...file, downloadUrl: "https://files.openai.test/expired",
    }, "receipt-import", { ...paymentDeps, fetch: async () => { throw new Error("ready retry must not download"); } });
    expect(retry.publicId).toBe(firstEvidenceId);
    expect(retry.auditPublicId).toBe(firstAuditId);
    expect(counters.put).toBe(1);
    expect(await db.select().from(auditLogs).where(eq(auditLogs.action, "chatgpt_file_imported"))).toHaveLength(1);
});

integrationTest("signer failure retains a newly created import-key reservation and file for retry", async () => {
    const { user, draft } = await seededDraft();
    const failedCounters = { fetch: 0, prepare: 0, put: 0, head: 0 };
    await expect(importChatGptDisbursementEvidence(
        dbContext(user, "signer-recovery"), draft.publicId, file,
        importerDependencies(failedCounters, { failPrepare: true }),
    )).rejects.toThrow("signer unavailable");
    const pending = await db.query.loanDisbursementEvidenceIntents.findFirst({
        where: eq(loanDisbursementEvidenceIntents.importIdempotencyKey, "signer-recovery"),
    });
    expect(pending).toMatchObject({ status: "pending" });
    expect(await db.select().from(files)).toHaveLength(1);

    const retry = await importChatGptDisbursementEvidence(
        dbContext(user, "signer-recovery"), draft.publicId,
        { ...file, downloadUrl: "https://files.openai.test/refreshed" }, importerDependencies({ fetch: 0, prepare: 0, put: 0, head: 0 }),
    );
    expect(retry).toMatchObject({ publicId: pending!.publicId, status: "ready" });
    expect(await db.select().from(loanDisbursementEvidenceIntents).where(eq(loanDisbursementEvidenceIntents.importIdempotencyKey, "signer-recovery"))).toHaveLength(1);
});

integrationTest("new direct prepare preserves its file when an importer claims it before signer failure", async () => {
    const { user, draft } = await seededDraft();
    const baseDeps = importerDependencies({ fetch: 0, prepare: 0, put: 0, head: 0 });
    const verified = await downloadChatGptFile(file, baseDeps);
    let release!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const signerEntered = new Promise<void>((resolve) => { entered = resolve; });
    const direct = prepareDisbursementEvidence(dbContext(user, "direct-new"), draft.publicId, {
        mimeType: verified.mimeType, size: verified.size, sha256: verified.sha256,
    }, {
        ...baseDeps.disbursementEvidenceGateway!,
        preparePut: async () => {
            entered();
            await paused;
            throw new Error("signer unavailable");
        },
    });
    await signerEntered;
    try {
        await expect(importChatGptDisbursementEvidence(
            dbContext(user, "claimed-new-direct"), draft.publicId, file,
            importerDependencies({ fetch: 0, prepare: 0, put: 0, head: 0 }, { failPut: true }),
        )).rejects.toThrow("storage unavailable");
    } finally {
        release();
    }
    await expect(direct).rejects.toThrow("signer unavailable");
    const retained = await db.query.loanDisbursementEvidenceIntents.findFirst({
        where: eq(loanDisbursementEvidenceIntents.importIdempotencyKey, "claimed-new-direct"),
    });
    expect(retained).toMatchObject({ status: "pending", importIdempotencyKey: "claimed-new-direct" });
    expect(await db.select().from(files)).toHaveLength(1);

    const retry = await importChatGptDisbursementEvidence(
        dbContext(user, "claimed-new-direct"), draft.publicId,
        { ...file, downloadUrl: "https://files.openai.test/refreshed" }, importerDependencies({ fetch: 0, prepare: 0, put: 0, head: 0 }),
    );
    expect(retry).toMatchObject({ publicId: retained!.publicId, status: "ready" });
});

integrationTest("does not delete an expired intent after a concurrent importer claims its key", async () => {
    const { user, draft } = await seededDraft();
    const counters = { fetch: 0, prepare: 0, put: 0, head: 0 };
    const initial = await prepareDisbursementEvidence(dbContext(user, "direct-expired"), draft.publicId, {
        mimeType: "image/png", size: png.byteLength, sha256: createHash("sha256").update(png).digest("hex"),
    }, importerDependencies(counters).disbursementEvidenceGateway);
    await db.update(loanDisbursementEvidenceIntents).set({ uploadExpiresAt: new Date(0) })
        .where(eq(loanDisbursementEvidenceIntents.publicId, initial.publicId));
    const claimedKey = "claimed-before-delete";
    const gateway = importerDependencies(counters).disbursementEvidenceGateway!;
    const direct = await prepareDisbursementEvidence(dbContext(user, "direct-reclaim"), draft.publicId, {
        mimeType: "image/png", size: png.byteLength, sha256: createHash("sha256").update(png).digest("hex"),
    }, {
        ...gateway,
        beforeExpiredIntentCleanup: async ({ id }) => {
            await db.update(loanDisbursementEvidenceIntents).set({ importIdempotencyKey: claimedKey, sourceFileFingerprint: "claimed-file" })
                .where(and(eq(loanDisbursementEvidenceIntents.id, id), isNull(loanDisbursementEvidenceIntents.importIdempotencyKey)));
        },
    });
    expect(direct.publicId).toBe(initial.publicId);
    const retained = await db.query.loanDisbursementEvidenceIntents.findFirst({ where: eq(loanDisbursementEvidenceIntents.publicId, initial.publicId) });
    expect(retained).toMatchObject({ importIdempotencyKey: claimedKey, sourceFileFingerprint: "claimed-file" });
    expect(await db.select().from(files)).toHaveLength(1);
});

integrationTest("binds legacy ready evidence to its exact historical finalize audit and replays without download", async () => {
    const { user, draft } = await seededDraft();
    const event = await db.query.loanDisbursementEvents.findFirst({ where: eq(loanDisbursementEvents.publicId, draft.publicId) });
    expect(event).toBeDefined();
    const sha256 = createHash("sha256").update(png).digest("hex");
    const storedFile = await db.insert(files).values({
        tenantId: user.tenantId, ownerUserId: user.id, bucket: "evidence", key: `legacy/${crypto.randomUUID()}`,
        originalName: "legacy.png", mimeType: "image/png", size: png.byteLength, url: "s3://legacy",
    }).returning().then((rows) => rows[0]!);
    const legacyIntent = await db.insert(loanDisbursementEvidenceIntents).values({
        tenantId: user.tenantId, loanDisbursementEventId: event!.id, fileId: storedFile.id, status: "ready",
        evidenceHash: sha256, mimeType: "image/png", declaredSize: png.byteLength, finalizedAt: new Date(),
        createdByUserId: user.id, updatedByUserId: user.id,
    }).returning().then((rows) => rows[0]!);
    await db.insert(loanDisbursementEvidence).values({ tenantId: user.tenantId, loanDisbursementEventId: event!.id, fileId: storedFile.id });
    const historicalAudit = await db.insert(auditLogs).values({
        tenantId: user.tenantId, actorUserId: user.id, actorSource: "mcp", entityType: "loan_disbursement",
        entityId: draft.publicId, action: "evidence_finalized", payload: { evidencePublicId: legacyIntent.publicId, filePublicId: storedFile.publicId, sha256 },
    }).returning().then((rows) => rows[0]!);
    const counters = { fetch: 0, prepare: 0, put: 0, head: 0 };
    const first = await importChatGptDisbursementEvidence(dbContext(user, "legacy-import"), draft.publicId, file, importerDependencies(counters));
    expect(first).toMatchObject({ publicId: legacyIntent.publicId, status: "ready", auditPublicId: historicalAudit.publicId });
    expect(counters).toEqual({ fetch: 1, prepare: 0, put: 0, head: 0 });
    expect(await db.select().from(auditLogs).where(eq(auditLogs.action, "evidence_finalized"))).toHaveLength(1);
    const retry = await importChatGptDisbursementEvidence(dbContext(user, "legacy-import"), draft.publicId, { ...file, downloadUrl: "https://files.openai.test/expired" }, {
        ...importerDependencies(counters), fetch: async () => { throw new Error("legacy ready retry must not download"); },
    });
    expect(retry).toMatchObject({ publicId: legacyIntent.publicId, auditPublicId: historicalAudit.publicId });
    expect(await db.query.loanDisbursementEvidenceIntents.findFirst({ where: eq(loanDisbursementEvidenceIntents.id, legacyIntent.id) })).toMatchObject({ importIdempotencyKey: "legacy-import" });
});

integrationTest("rejects a cross-tenant payout importer before fetching the attachment", async () => {
    const { user, draft } = await seededDraft();
    const otherUser = await db.insert(users).values({ tenantId: "tenant-b", email: `${crypto.randomUUID()}@example.test`, role: "owner" }).returning().then((rows) => rows[0]!);
    let fetched = false;
    await expect(importChatGptDisbursementEvidence(dbContext(otherUser, "cross-tenant"), draft.publicId, file, {
        ...dependencies(responseFor()), fetch: async () => { fetched = true; return responseFor(); },
    })).rejects.toMatchObject({ code: "DISBURSEMENT_NOT_FOUND" });
    expect(fetched).toBe(false);
    expect(await db.select().from(loanDisbursementEvidenceIntents)).toHaveLength(0);
});

integrationTest("rejects a different key for ready evidence with the same source identity before fetching", async () => {
    const { user, draft } = await seededDraft();
    const counters = { fetch: 0, prepare: 0, put: 0, head: 0 };
    const deps = importerDependencies(counters);
    await importChatGptDisbursementEvidence(dbContext(user, "ready-original"), draft.publicId, file, deps);
    await expect(importChatGptDisbursementEvidence(dbContext(user, "ready-different"), draft.publicId, file, {
        ...deps, fetch: async () => { throw new Error("ready identity conflict must not download"); },
    })).rejects.toMatchObject({ code: "EVIDENCE_IDEMPOTENCY_CONFLICT" });
    expect(counters.fetch).toBe(1);
});

integrationTest.each(["cross-tenant", "wrong-event", "wrong-evidence"] as const)("fails closed for a %s stored ready audit pointer without fetching", async (pointerKind) => {
    const { user, loan, draft } = await seededDraft();
    const counters = { fetch: 0, prepare: 0, put: 0, head: 0 };
    const deps = importerDependencies(counters);
    await importChatGptDisbursementEvidence(dbContext(user, "audit-pointer"), draft.publicId, file, deps);
    const intent = await db.query.loanDisbursementEvidenceIntents.findFirst({ where: eq(loanDisbursementEvidenceIntents.importIdempotencyKey, "audit-pointer") });
    expect(intent).toBeDefined();
    let invalidAuditPublicId: string;
    if (pointerKind === "cross-tenant") {
        invalidAuditPublicId = await db.insert(auditLogs).values({
            tenantId: "tenant-b", entityType: "loan_disbursement", entityId: draft.publicId,
            action: "evidence_finalized", payload: { evidencePublicId: intent!.publicId },
        }).returning().then((rows) => rows[0]!.publicId);
    } else {
        const wrongEvent = pointerKind === "wrong-event" ? await createDisbursementDraft(dbContext(user, "audit-pointer-other"), loan.publicId, {
            grossAmount: "1.00", loanAttributedAmount: "1.00", channel: "cash", disbursedAt: "2026-09-13T11:00:00.000Z",
        }) : null;
        invalidAuditPublicId = await db.insert(auditLogs).values({
            tenantId: user.tenantId, entityType: "loan_disbursement", entityId: wrongEvent?.publicId ?? draft.publicId,
            action: "evidence_finalized", payload: { evidencePublicId: pointerKind === "wrong-evidence" ? crypto.randomUUID() : intent!.publicId },
        }).returning().then((rows) => rows[0]!.publicId);
    }
    await db.update(loanDisbursementEvidenceIntents).set({ finalizedAuditPublicId: invalidAuditPublicId })
        .where(eq(loanDisbursementEvidenceIntents.id, intent!.id));
    await expect(importChatGptDisbursementEvidence(dbContext(user, "audit-pointer"), draft.publicId, {
        ...file, downloadUrl: "https://files.openai.test/expired",
    }, { ...deps, fetch: async () => { throw new Error("invalid ready audit must not download"); } })).rejects.toMatchObject({
        code: "EVIDENCE_AUDIT_NOT_FOUND",
    });
    expect(counters.fetch).toBe(1);
});
