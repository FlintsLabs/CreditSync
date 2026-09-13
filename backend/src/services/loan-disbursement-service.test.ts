import { afterEach, beforeEach, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { auditLogs, borrowers, files, financialEvidenceRequirements, loanDisbursementEvidence, loanDisbursementEvidenceIntents, loanDisbursementEvents, loanSchedules, loans, users } from "../db/schema";
import type { CommandContext } from "./command-context";
import {
    createDisbursementDraft,
    disbursementReversalRequestHash,
    evidenceIntentExpired,
    finalizeDisbursementEvidence,
    listLoanDisbursements,
    postDisbursement,
    prepareDisbursementEvidence,
    reverseDisbursement,
    updateDisbursementDraft,
} from "./loan-disbursement-service";
import { registerFinancialEvidenceRequirement } from "./financial-evidence-requirement-service";

const integrationTest = process.env.TEST_DATABASE_URL ? test : test.skip;

async function reset() {
    await db.execute(sql`TRUNCATE TABLE audit_logs, loan_disbursement_evidence, loan_disbursement_events,
        loan_schedules, loans, borrowers, users RESTART IDENTITY CASCADE`);
}

async function actor(tenantId = "tenant-a") {
    return db.insert(users).values({ tenantId, email: `${crypto.randomUUID()}@example.test`, role: "owner" })
        .returning().then((rows) => rows[0]!);
}

function context(user: { id: number; tenantId: string }, idempotencyKey: string = crypto.randomUUID()): CommandContext {
    return { tenantId: user.tenantId, actorUserId: user.id, actorSource: "web", requestId: `req-${crypto.randomUUID()}`, correlationId: `corr-${crypto.randomUUID()}`, idempotencyKey };
}

async function loanFor(
    user: { id: number; tenantId: string },
    principal = "5000.00",
    status: "active" | "draft" = "active",
) {
    const borrower = await db.insert(borrowers).values({ tenantId: user.tenantId, ownerUserId: user.id, name: "Disbursement borrower" })
        .returning().then((rows) => rows[0]!);
    return db.insert(loans).values({
        tenantId: user.tenantId, ownerUserId: user.id, borrowerId: borrower.id, principalAmount: principal,
        interestRate: "0.00", repaymentType: "monthly", outstandingPrincipal: principal,
        outstandingInterest: "0.00", outstandingFees: "0.00", status,
    }).returning().then((rows) => rows[0]!);
}

if (process.env.TEST_DATABASE_URL) {
    beforeEach(reset);
    afterEach(reset);
}

// Break caught: a reversal replay hash ignores the reason, or a persisted signer expiry is not enforced.
test("binds reversal replay hashes to target and reason and expires persisted upload intents", () => {
    expect(disbursementReversalRequestHash("00000000-0000-4000-8000-000000000001", "wrong payout"))
        .not.toBe(disbursementReversalRequestHash("00000000-0000-4000-8000-000000000001", "corrected reason"));
    expect(evidenceIntentExpired({ uploadExpiresAt: new Date(Date.now() - 1), createdAt: new Date() })).toBe(true);
    expect(evidenceIntentExpired({ uploadExpiresAt: new Date(Date.now() + 60_000), createdAt: new Date() })).toBe(false);
});

// Break caught: netting gross rather than attributed amounts, or including draft/reversed postings, reports a false loan payout.
integrationTest("lists only effective posted gross and attributed disbursement totals", async () => {
    const owner = await actor();
    const loan = await loanFor(owner);
    const ctx = context(owner);
    const first = await createDisbursementDraft(ctx, loan.publicId, {
        grossAmount: "5100.00", loanAttributedAmount: "5000.00", channel: "bank_transfer", note: "Grouped payout", disbursedAt: "2026-08-10T10:00:00.000Z",
    });
    await postDisbursement(context(owner, "post-one"), first.publicId);
    const second = await createDisbursementDraft(ctx, loan.publicId, {
        grossAmount: "200.00", loanAttributedAmount: "200.00", channel: "cash", disbursedAt: "2026-08-10T11:00:00.000Z",
    });
    await postDisbursement(context(owner, "post-two"), second.publicId);
    const reversed = await createDisbursementDraft(ctx, loan.publicId, {
        grossAmount: "900.00", loanAttributedAmount: "800.00", channel: "bank_transfer", note: "Wrong recipient", disbursedAt: "2026-08-10T12:00:00.000Z",
    });
    await postDisbursement(context(owner, "post-reversed"), reversed.publicId);
    await reverseDisbursement(context(owner, "reverse-reversed"), reversed.publicId, "Wrong recipient");
    await createDisbursementDraft(ctx, loan.publicId, {
        grossAmount: "700.00", loanAttributedAmount: "700.00", channel: "cash", disbursedAt: "2026-08-10T13:00:00.000Z",
    });

    const result = await listLoanDisbursements(ctx, loan.publicId);

    expect(result.summary).toMatchObject({ approvedPrincipal: "5000.00", postedGrossAmount: "5300.00", postedEventCount: 2, netDisbursed: "5200.00", variance: "200.00", status: "over_disbursed" });
    expect(result.events).toHaveLength(5);
});

// Break caught: a posted row remains editable, allowing payout history to be silently rewritten.
integrationTest("posts an editable draft once and locks it afterward", async () => {
    const owner = await actor();
    const loan = await loanFor(owner);
    const draft = await createDisbursementDraft(context(owner), loan.publicId, {
        grossAmount: "5000.00", loanAttributedAmount: "5000.00", channel: "cash", disbursedAt: "2026-08-10T10:00:00.000Z",
    });

    const posted = await postDisbursement(context(owner, "post-lock"), draft.publicId);

    expect(posted).toMatchObject({ publicId: draft.publicId, status: "posted" });
    await expect(updateDisbursementDraft(context(owner), posted.publicId, { note: "x" })).rejects.toMatchObject({ code: "DISBURSEMENT_LOCKED", status: 409 });
    expect(await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, draft.publicId), eq(auditLogs.action, "posted")))).toHaveLength(1);
});

// Break caught: an actual payout can be posted against an application draft before its
// financial terms are activated and locked.
integrationTest("rejects posting a disbursement until the parent loan is active", async () => {
    const owner = await actor();
    const loan = await loanFor(owner, "5000.00", "draft");
    const draft = await createDisbursementDraft(context(owner), loan.publicId, {
        grossAmount: "5000.00",
        loanAttributedAmount: "5000.00",
        channel: "cash",
        disbursedAt: "2026-08-10T10:00:00.000Z",
    });

    await expect(postDisbursement(context(owner, "post-before-activation"), draft.publicId))
        .rejects.toMatchObject({ code: "LOAN_DISBURSEMENT_LOCKED", status: 409 });
    expect(await db.query.loanDisbursementEvents.findFirst({ where: eq(
        loanDisbursementEvents.publicId,
        draft.publicId,
    ) })).toMatchObject({ status: "draft", postedAt: null, postIdempotencyKey: null });
});

// Break caught: a compensating reversal can be edited or deleted directly, silently restoring the original payout.
integrationTest("creates one immutable idempotent compensating reversal without changing the loan", async () => {
    const owner = await actor();
    const loan = await loanFor(owner);
    const original = await createDisbursementDraft(context(owner), loan.publicId, {
        grossAmount: "5000.00", loanAttributedAmount: "5000.00", channel: "cash", disbursedAt: "2026-08-10T10:00:00.000Z",
    });
    const posted = await postDisbursement(context(owner, "post-reverse"), original.publicId);

    const results = await Promise.all([
        reverseDisbursement(context(owner, "reverse-key"), posted.publicId, "wrong payout"),
        reverseDisbursement(context(owner, "reverse-key"), posted.publicId, "wrong payout"),
    ]);
    const reversal = results.find((result) => !result.duplicate)!;
    const retried = results.find((result) => result.duplicate)!;

    expect(reversal).toMatchObject({ status: "reversed", reversedEventPublicId: posted.publicId });
    expect(retried).toMatchObject({ publicId: reversal.publicId, status: "reversed", duplicate: true, reversedEventPublicId: posted.publicId });
    expect(results.map((result) => result.duplicate).sort()).toEqual([false, true]);
    await expect(reverseDisbursement(context(owner, "other-reverse-key"), posted.publicId, "wrong payout"))
        .rejects.toMatchObject({ code: "REVERSAL_IDEMPOTENCY_CONFLICT", status: 409 });
    expect(await db.query.loans.findFirst({ where: eq(loans.id, loan.id) })).toMatchObject({ principalAmount: "5000.00", outstandingPrincipal: "5000.00" });
    const postedRow = await db.query.loanDisbursementEvents.findFirst({ where: eq(loanDisbursementEvents.publicId, posted.publicId) });
    const reversalRows = await db.select().from(loanDisbursementEvents).where(sql`${loanDisbursementEvents.reversedEventId} = ${postedRow!.id}`);
    expect(reversalRows).toHaveLength(1);
    expect(await db.select().from(auditLogs).where(and(
        eq(auditLogs.entityId, reversal.publicId),
        eq(auditLogs.action, "reversed"),
    ))).toHaveLength(1);
    const reversalRow = reversalRows[0]!;
    // postgres-js wraps the trigger message, so assert the actual mutation is rejected.
    await expect(db.update(loanDisbursementEvents).set({ note: "altered reversal" }).where(eq(loanDisbursementEvents.id, reversalRow.id)).execute())
        .rejects.toBeDefined();
    await expect(db.delete(loanDisbursementEvents).where(eq(loanDisbursementEvents.id, reversalRow.id)).execute())
        .rejects.toBeDefined();
});

// Break caught: an uploaded-but-unfinalized or checksum-mismatched file can be attached and posted as evidence.
integrationTest("persists and verifies evidence readiness before a linked file can be posted", async () => {
    const owner = await actor();
    const loan = await loanFor(owner);
    const draft = await createDisbursementDraft(context(owner), loan.publicId, {
        grossAmount: "5.00", loanAttributedAmount: "5.00", channel: "cash", disbursedAt: "2026-08-10T10:00:00.000Z",
    });
    const checksum = "a".repeat(64);
    const gateway = {
        preparePut: async () => ({ uploadUrl: "https://storage.example.test/signed", expiresAt: new Date(Date.now() + 60_000) }),
        head: async () => ({ exists: true, contentType: "image/png", contentLength: 12, checksumSha256: checksum, metadata: { tenant: owner.tenantId, disbursement: draft.publicId } }),
    };
    const prepared = await prepareDisbursementEvidence(context(owner), draft.publicId, { mimeType: "image/png", size: 12, sha256: checksum }, gateway);
    const file = await db.query.files.findFirst({ where: eq(files.publicId, prepared.filePublicId) });
    const event = await db.query.loanDisbursementEvents.findFirst({ where: eq(loanDisbursementEvents.publicId, draft.publicId) });
    await db.insert(loanDisbursementEvidence).values({ tenantId: owner.tenantId, loanDisbursementEventId: event!.id, fileId: file!.id });

    await expect(postDisbursement(context(owner, "evidence-post"), draft.publicId)).rejects.toMatchObject({ code: "EVIDENCE_REQUIRED_NOT_READY", status: 409 });
    await expect(finalizeDisbursementEvidence(context(owner), draft.publicId, prepared.publicId, { ...gateway, head: async () => ({ exists: true, contentType: "image/png", contentLength: 12, checksumSha256: "b".repeat(64), metadata: { tenant: owner.tenantId, disbursement: draft.publicId } }) }))
        .rejects.toMatchObject({ code: "EVIDENCE_METADATA_MISMATCH", status: 409 });
    expect(await finalizeDisbursementEvidence(context(owner), draft.publicId, prepared.publicId, gateway)).toMatchObject({ status: "ready", sha256: checksum, filePublicId: prepared.filePublicId });
    await expect(postDisbursement(context(owner, "evidence-post"), draft.publicId)).resolves.toMatchObject({ status: "posted" });
});

// Break caught: a payout evidence signing failure releases the intent and lets
// an old data-only post proceed without retaining the accepted requirement.
integrationTest("retains a payout requirement after signing failure and blocks post", async () => {
    const owner = await actor();
    const loan = await loanFor(owner);
    const draft = await createDisbursementDraft(context(owner), loan.publicId, {
        grossAmount: "5.00", loanAttributedAmount: "5.00", channel: "cash", disbursedAt: "2026-09-14T05:00:00.000Z",
    });
    await expect(prepareDisbursementEvidence(context(owner), draft.publicId, { mimeType: "image/png", size: 12, sha256: "d".repeat(64) }, {
        preparePut: async () => { throw new Error("signing unavailable"); },
        head: async () => ({ exists: false, contentType: null, contentLength: null, checksumSha256: null, metadata: {} }),
    })).rejects.toThrow("signing unavailable");
    const event = await db.query.loanDisbursementEvents.findFirst({ where: eq(loanDisbursementEvents.publicId, draft.publicId) });
    expect(await db.query.financialEvidenceRequirements.findFirst({ where: eq(financialEvidenceRequirements.loanDisbursementEventId, event!.id) }))
        .toMatchObject({ expectedCount: 1 });
    await expect(postDisbursement(context(owner, "payout-signing-failure-post"), draft.publicId))
        .rejects.toMatchObject({ code: "EVIDENCE_REQUIRED_NOT_READY", status: 409 });
});

integrationTest("retains a distinct payout attempt floor after a ready file and failed second signing", async () => {
    const owner = await actor();
    const loan = await loanFor(owner);
    const draft = await createDisbursementDraft(context(owner), loan.publicId, {
        grossAmount: "5.00", loanAttributedAmount: "5.00", channel: "cash", disbursedAt: "2026-08-10T05:30:00.000Z",
    });
    const first = await prepareDisbursementEvidence(context(owner), draft.publicId, { mimeType: "image/png", size: 12, sha256: "e".repeat(64) }, {
        preparePut: async () => ({ uploadUrl: "https://storage.example.test/first", expiresAt: new Date(Date.now() + 60_000) }),
        head: async () => ({ exists: false, contentType: null, contentLength: null, checksumSha256: null, metadata: {} }),
    });
    const firstIntent = await db.query.loanDisbursementEvidenceIntents.findFirst({ where: eq(loanDisbursementEvidenceIntents.publicId, first.publicId) });
    const event = await db.query.loanDisbursementEvents.findFirst({ where: eq(loanDisbursementEvents.publicId, draft.publicId) });
    await db.update(loanDisbursementEvidenceIntents).set({ status: "ready", finalizedAt: new Date() }).where(eq(loanDisbursementEvidenceIntents.id, firstIntent!.id));
    await db.insert(loanDisbursementEvidence).values({ tenantId: owner.tenantId, loanDisbursementEventId: event!.id, fileId: firstIntent!.fileId });

    await expect(prepareDisbursementEvidence(context(owner), draft.publicId, { mimeType: "image/png", size: 12, sha256: "f".repeat(64) }, {
        preparePut: async () => { throw new Error("second signing unavailable"); },
        head: async () => ({ exists: false, contentType: null, contentLength: null, checksumSha256: null, metadata: {} }),
    })).rejects.toThrow("second signing unavailable");
    const requirement = await db.query.financialEvidenceRequirements.findFirst({ where: eq(financialEvidenceRequirements.loanDisbursementEventId, event!.id) });
    expect(requirement).toMatchObject({ expectedCount: 2 });
    expect(await db.query.loanDisbursementEvidenceIntents.findFirst({ where: eq(loanDisbursementEvidenceIntents.evidenceHash, "f".repeat(64)) })).toBeUndefined();
    await expect(postDisbursement(context(owner, "payout-distinct-attempt-post"), draft.publicId)).rejects.toMatchObject({ code: "EVIDENCE_REQUIRED_NOT_READY" });
});

integrationTest("requires finalized payout intent, tenant file, and event association", async () => {
    const owner = await actor();
    const loan = await loanFor(owner);
    const draft = await createDisbursementDraft(context(owner), loan.publicId, {
        grossAmount: "5.00", loanAttributedAmount: "5.00", channel: "cash", disbursedAt: "2026-08-10T05:45:00.000Z",
    });
    const prepared = await prepareDisbursementEvidence(context(owner), draft.publicId, { mimeType: "image/png", size: 12, sha256: "1".repeat(64) }, {
        preparePut: async () => ({ uploadUrl: "https://storage.example.test/association", expiresAt: new Date(Date.now() + 60_000) }),
        head: async () => ({ exists: false, contentType: null, contentLength: null, checksumSha256: null, metadata: {} }),
    });
    const intent = await db.query.loanDisbursementEvidenceIntents.findFirst({ where: eq(loanDisbursementEvidenceIntents.publicId, prepared.publicId) });
    const event = await db.query.loanDisbursementEvents.findFirst({ where: eq(loanDisbursementEvents.publicId, draft.publicId) });
    await db.update(loanDisbursementEvidenceIntents).set({ status: "ready" }).where(eq(loanDisbursementEvidenceIntents.id, intent!.id));
    await expect(postDisbursement(context(owner, "missing-finalized-post"), draft.publicId)).rejects.toMatchObject({ code: "EVIDENCE_REQUIRED_NOT_READY" });
    await db.update(loanDisbursementEvidenceIntents).set({ finalizedAt: new Date() }).where(eq(loanDisbursementEvidenceIntents.id, intent!.id));
    await expect(postDisbursement(context(owner, "missing-association-post"), draft.publicId)).rejects.toMatchObject({ code: "EVIDENCE_REQUIRED_NOT_READY" });
    await db.insert(loanDisbursementEvidence).values({ tenantId: owner.tenantId, loanDisbursementEventId: event!.id, fileId: intent!.fileId });
    await expect(postDisbursement(context(owner, "association-complete-post"), draft.publicId)).resolves.toMatchObject({ status: "posted" });
});

// Break caught: retrying a pending upload creates a second intent/file instead of returning the same durable capability.
integrationTest("reuses a pending evidence intent when prepare is retried", async () => {
    const owner = await actor();
    const loan = await loanFor(owner);
    const draft = await createDisbursementDraft(context(owner), loan.publicId, {
        grossAmount: "5.00", loanAttributedAmount: "5.00", channel: "cash", disbursedAt: "2026-08-10T10:00:00.000Z",
    });
    let signed = 0;
    const gateway = {
        preparePut: async () => ({ uploadUrl: `https://storage.example.test/signed/${++signed}`, expiresAt: new Date(Date.now() + 60_000) }),
        head: async () => ({ exists: false, contentType: null, contentLength: null, checksumSha256: null, metadata: {} }),
    };
    const input = { mimeType: "image/png", size: 12, sha256: "c".repeat(64) };

    const first = await prepareDisbursementEvidence(context(owner), draft.publicId, input, gateway);
    const retry = await prepareDisbursementEvidence(context(owner), draft.publicId, input, gateway);

    expect(retry).toMatchObject({ publicId: first.publicId, filePublicId: first.filePublicId, objectKey: first.objectKey });
    expect(retry.uploadUrl).not.toBe(first.uploadUrl);
    expect(signed).toBe(2);
});

// Break caught: concurrent post attempts write duplicate audits or both claim the initial transition.
integrationTest("serializes concurrent post attempts into one post and one replay", async () => {
    const owner = await actor();
    const loan = await loanFor(owner);
    const draft = await createDisbursementDraft(context(owner), loan.publicId, {
        grossAmount: "5.00", loanAttributedAmount: "5.00", channel: "cash", disbursedAt: "2026-08-10T10:00:00.000Z",
    });

    const results = await Promise.all([
        postDisbursement(context(owner, "concurrent-post"), draft.publicId),
        postDisbursement(context(owner, "concurrent-post"), draft.publicId),
    ]);

    expect(results.map((result) => result.duplicate).sort()).toEqual([false, true]);
    expect(await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, draft.publicId), eq(auditLogs.action, "posted")))).toHaveLength(1);
});

// Break caught: draft changes lack an auditable old/new value, and post keys can be reused for another event.
integrationTest("records complete draft before/after state and rejects a post-key conflict", async () => {
    const owner = await actor();
    const loan = await loanFor(owner, "10.00");
    const draft = await createDisbursementDraft(context(owner), loan.publicId, {
        grossAmount: "10.00", loanAttributedAmount: "10.00", channel: "cash", payeeHint: "old payee", note: "old note", disbursedAt: "2026-08-10T10:00:00.000Z",
    });
    expect((await listLoanDisbursements(context(owner), loan.publicId)).summary.status).toBe("under_disbursed");
    await updateDisbursementDraft(context(owner), draft.publicId, { channel: "adjustment", payeeHint: "new payee", note: "new note", disbursedAt: "2026-08-11T10:00:00.000Z" });
    const audit = await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, draft.publicId), eq(auditLogs.action, "draft_updated"))).then((rows) => rows[0]!);
    expect(audit.payload).toMatchObject({ before: { channel: "cash", payeeHint: "old payee", note: "old note" }, after: { channel: "adjustment", payeeHint: "new payee", note: "new note" } });
    await postDisbursement(context(owner, "shared-post-key"), draft.publicId);
    expect((await listLoanDisbursements(context(owner), loan.publicId)).summary.status).toBe("matched");
    const second = await createDisbursementDraft(context(owner), loan.publicId, { grossAmount: "1.00", loanAttributedAmount: "1.00", channel: "cash", disbursedAt: "2026-08-12T10:00:00.000Z" });
    await expect(postDisbursement(context(owner, "shared-post-key"), second.publicId)).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_CONFLICT", status: 409 });
});

// Break caught: a draft from another tenant can be read or modified by guessing its UUID.
integrationTest("does not expose another tenant's loan or draft", async () => {
    const owner = await actor();
    const outsider = await actor("tenant-b");
    const loan = await loanFor(owner);
    const draft = await createDisbursementDraft(context(owner), loan.publicId, {
        grossAmount: "1.00", loanAttributedAmount: "1.00", channel: "cash", disbursedAt: "2026-08-10T10:00:00.000Z",
    });

    await expect(listLoanDisbursements(context(outsider), loan.publicId)).rejects.toMatchObject({ code: "LOAN_NOT_FOUND", status: 404 });
    await expect(updateDisbursementDraft(context(outsider), draft.publicId, { note: "steal" })).rejects.toMatchObject({ code: "DISBURSEMENT_NOT_FOUND", status: 404 });
});

integrationTest("does not let a restricted actor register a requirement on another payout target", async () => {
    const owner = await actor();
    const restricted = await db.insert(users).values({ tenantId: owner.tenantId, email: `${crypto.randomUUID()}@example.test`, role: "viewer" }).returning().then((rows) => rows[0]!);
    const loan = await loanFor(owner);
    const draft = await createDisbursementDraft(context(owner), loan.publicId, {
        grossAmount: "5.00", loanAttributedAmount: "5.00", channel: "cash", disbursedAt: "2026-08-10T06:00:00.000Z",
    });
    await expect(db.transaction((tx) => registerFinancialEvidenceRequirement(tx, context(restricted), { kind: "loan_disbursement", publicId: draft.publicId }, 1)))
        .rejects.toMatchObject({ code: "DISBURSEMENT_NOT_FOUND", status: 404 });
    expect(await db.query.financialEvidenceRequirements.findFirst({ where: eq(financialEvidenceRequirements.loanDisbursementEventId, 1) })).toBeUndefined();
});
