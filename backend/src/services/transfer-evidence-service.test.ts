import { beforeEach, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import {
    auditLogs,
    borrowers,
    intermediaries,
    intermediatedDisbursementGroups,
    intermediatedTransferEvidence,
    intermediatedTransferEvidenceIntents,
    intermediatedTransferEvents,
    loanIntermediaryAssignments,
    loans,
    users,
} from "../db/schema";
import type { SignedPutRequest, StoredObjectHead, StoredObjectLocation } from "../lib/storage";
import type { CommandContext } from "./command-context";
import {
    createIntermediatedDisbursementGroup,
    createTransferEvent,
} from "./intermediated-disbursement-service";
import {
    finalizeTransferEvidence,
    getTransferEvidenceAccess,
    listTransferEvidence,
    prepareTransferEvidence,
    type TransferEvidenceStorageGateway,
} from "./transfer-evidence-service";

const integrationEnabled = Boolean(process.env.TEST_DATABASE_URL);
const integrationTest = integrationEnabled ? test : test.skip;

async function resetTables() {
    await db.execute(sql`SET client_min_messages TO WARNING`);
    await db.execute(sql`TRUNCATE TABLE
        audit_logs,
        intermediated_disbursement_group_previews,
        intermediated_transfer_evidence,
        intermediated_transfer_evidence_intents,
        intermediated_transfer_events,
        intermediated_disbursement_groups,
        loan_intermediary_assignments,
        intermediary_bank_accounts,
        intermediaries,
        loans,
        borrowers,
        users
        RESTART IDENTITY CASCADE`);
}

const activationResult = {
    publicId: "00000000-0000-7000-8000-000000000001",
    principal: "5000.00",
    principalAmount: "5000.00",
    repaymentType: "floating",
    floatingInterestPolicy: {
        periodUnit: "week",
        periodLength: 1,
        rateMode: "percent",
        rate: "12.0000",
        advanceInterestPeriods: 1,
        advanceInterestRefundPolicy: "non_refundable",
    },
    status: "active",
};

async function seed(tenantId: string, suffix: string) {
    const actor = await db.insert(users).values({
        tenantId,
        email: `${suffix}@transfer-evidence.test`,
        role: "owner",
    }).returning().then((rows) => rows[0]!);
    const borrower = await db.insert(borrowers).values({
        tenantId,
        ownerUserId: actor.id,
        name: `Borrower ${suffix}`,
    }).returning().then((rows) => rows[0]!);
    const loan = await db.insert(loans).values({
        tenantId,
        ownerUserId: actor.id,
        borrowerId: borrower.id,
        principalAmount: "5000.00",
        interestRate: "0.00",
        repaymentType: "floating",
        outstandingPrincipal: "5000.00",
        outstandingInterest: "0.00",
        outstandingFees: "0.00",
        activationIdempotencyKey: `activation-${suffix}`,
        activationResult,
        status: "active",
    }).returning().then((rows) => rows[0]!);
    const intermediary = await db.insert(intermediaries).values({
        tenantId,
        ownerUserId: actor.id,
        name: `Intermediary ${suffix}`,
        normalizedName: `intermediary ${suffix}`,
        createdByUserId: actor.id,
        updatedByUserId: actor.id,
    }).returning().then((rows) => rows[0]!);
    await db.insert(loanIntermediaryAssignments).values({
        tenantId,
        loanId: loan.id,
        intermediaryId: intermediary.id,
        role: "disbursement",
        effectiveFrom: new Date("2026-08-01T00:00:00.000Z"),
        idempotencyKey: `assignment-${suffix}`,
        createdByUserId: actor.id,
        updatedByUserId: actor.id,
    });
    return { actor, borrower, loan, intermediary };
}

function context(actor: typeof users.$inferSelect, idempotencyKey?: string): CommandContext {
    return {
        tenantId: actor.tenantId,
        actorUserId: actor.id,
        actorSource: "web",
        requestId: `req-${idempotencyKey ?? "read"}`,
        correlationId: `corr-${idempotencyKey ?? "read"}`,
        idempotencyKey,
    };
}

async function createGroup(owner: Awaited<ReturnType<typeof seed>>, suffix: string) {
    return createIntermediatedDisbursementGroup(context(owner.actor, `group-${suffix}`), {
        loanPublicId: owner.loan.publicId,
        intermediaryPublicId: owner.intermediary.publicId,
        retainedBalance: "0.00",
    });
}

async function createEvent(
    owner: Awaited<ReturnType<typeof seed>>,
    groupPublicId: string,
    suffix: string,
    role: "funding_to_intermediary" | "borrower_net_payout" = "borrower_net_payout",
    amount = "2000.00",
) {
    return createTransferEvent(context(owner.actor, `event-${suffix}`), groupPublicId, {
        role,
        channel: "bank_transfer",
        amount,
        transferredAt: "2026-08-13T09:00:00.000Z",
        bankReference: `REF-${suffix}`,
    });
}

class EvidenceGateway implements TransferEvidenceStorageGateway {
    putRequests: SignedPutRequest[] = [];
    heads = new Map<string, StoredObjectHead>();
    headCalls = 0;
    accessCalls: StoredObjectLocation[] = [];
    accessExpiresAt = new Date("2026-08-13T09:10:00.000Z");

    async preparePut(request: SignedPutRequest) {
        this.putRequests.push(request);
        return {
            uploadUrl: `https://upload.example/${encodeURIComponent(request.key)}?secret=never-audit`,
            expiresAt: new Date(Date.now() + 5 * 60_000),
            requiredHeaders: {
                "content-type": request.contentType,
                "x-private-upload-header": "never-audit",
            },
        };
    }

    async head(key: string) {
        this.headCalls += 1;
        return this.heads.get(key) ?? {
            exists: false,
            contentType: null,
            contentLength: null,
            checksumSha256: null,
            metadata: {},
        };
    }

    async createAccess(location: StoredObjectLocation) {
        this.accessCalls.push(location);
        return {
            url: `https://access.example/${encodeURIComponent(location.key)}?secret=short-lived`,
            expiresAt: this.accessExpiresAt,
        };
    }

    acceptLastPut() {
        const request = this.putRequests.at(-1)!;
        this.heads.set(request.key, {
            exists: true,
            contentType: request.contentType,
            contentLength: request.contentLength,
            checksumSha256: request.checksumSha256,
            metadata: request.metadata,
        });
    }
}

function evidenceInput(seedCharacter: string, originalName = `${seedCharacter}.png`) {
    return {
        mimeType: "image/png",
        size: 128,
        sha256: seedCharacter.repeat(64),
        originalName,
    };
}

describe("intermediated transfer evidence lifecycle", () => {
    if (integrationEnabled) beforeEach(resetTables);

    // Break caught: one event overwrites a prior slip, split payout events share evidence,
    // a ready retry issues another PUT, access leaks storage internals, or post detaches a link.
    integrationTest("keeps multiple finalized slips per event and separate slips per split event through posting", async () => {
        const owner = await seed("tenant-transfer-evidence", "multi");
        const group = await createGroup(owner, "multi");
        const firstSplit = await createEvent(owner, group.publicId, "split-a");
        const secondSplit = await createEvent(owner, group.publicId, "split-b", "borrower_net_payout", "2400.00");
        const gateway = new EvidenceGateway();
        const accessClock = () => new Date("2026-08-13T09:00:00.000Z");

        const prepared = [];
        for (const [eventPublicId, input] of [
            [firstSplit.publicId, evidenceInput("a", "front.png")],
            [firstSplit.publicId, evidenceInput("b", "back.pdf")],
            [secondSplit.publicId, evidenceInput("c", "split.png")],
        ] as const) {
            const pending = await prepareTransferEvidence(context(owner.actor), group.publicId, eventPublicId, input, gateway);
            expect(pending).toMatchObject({
                auditPublicId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
                correlationId: "corr-read",
            });
            expect(gateway.putRequests.at(-1)).toMatchObject({
                contentType: input.mimeType,
                contentLength: input.size,
                checksumSha256: input.sha256,
                metadata: {
                    tenant: owner.actor.tenantId,
                    group: group.publicId,
                    event: eventPublicId,
                },
            });
            gateway.acceptLastPut();
            const finalized = await finalizeTransferEvidence(context(owner.actor), group.publicId, eventPublicId, pending.publicId, gateway);
            expect(finalized).toMatchObject({
                auditPublicId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
                correlationId: "corr-read",
            });
            expect(finalized.auditPublicId).not.toBe(pending.auditPublicId);
            prepared.push(finalized);
        }

        expect(await listTransferEvidence(context(owner.actor), group.publicId, firstSplit.publicId)).toEqual([
            expect.objectContaining({ publicId: prepared[0]!.publicId, status: "ready", sha256: "a".repeat(64) }),
            expect.objectContaining({ publicId: prepared[1]!.publicId, status: "ready", sha256: "b".repeat(64) }),
        ]);
        expect(await listTransferEvidence(context(owner.actor), group.publicId, secondSplit.publicId)).toEqual([
            expect.objectContaining({ publicId: prepared[2]!.publicId, status: "ready", sha256: "c".repeat(64) }),
        ]);

        const putCount = gateway.putRequests.length;
        const prepareReplay = await prepareTransferEvidence(
            context(owner.actor, "prepare-ready-retry"),
            group.publicId,
            firstSplit.publicId,
            evidenceInput("a", "renamed-does-not-reupload.png"),
            gateway,
        );
        expect(prepareReplay).toMatchObject({
            publicId: prepared[0]!.publicId,
            status: "ready",
            auditPublicId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
            correlationId: "corr-read",
        });
        expect(prepareReplay.auditPublicId).not.toBe(prepared[0]!.auditPublicId);
        expect(gateway.putRequests).toHaveLength(putCount);

        const access = await getTransferEvidenceAccess(
            context(owner.actor),
            group.publicId,
            firstSplit.publicId,
            prepared[0]!.publicId,
            gateway,
            accessClock,
        );
        expect(access).toEqual({
            publicId: prepared[0]!.publicId,
            filePublicId: prepared[0]!.filePublicId,
            status: "ready",
            mimeType: "image/png",
            url: expect.stringContaining("https://access.example/"),
            expiresAt: gateway.accessExpiresAt.toISOString(),
        });
        expect(JSON.stringify(access)).not.toMatch(/bucket|objectKey|storage:\/\//i);

        const storedGroup = await db.query.intermediatedDisbursementGroups.findFirst({
            where: and(
                eq(intermediatedDisbursementGroups.tenantId, owner.actor.tenantId),
                eq(intermediatedDisbursementGroups.publicId, group.publicId),
            ),
        });
        const storedEvent = await db.query.intermediatedTransferEvents.findFirst({
            where: and(
                eq(intermediatedTransferEvents.tenantId, owner.actor.tenantId),
                eq(intermediatedTransferEvents.publicId, firstSplit.publicId),
            ),
        });
        await db.update(intermediatedTransferEvents).set({ status: "posted", postedAt: new Date() }).where(eq(intermediatedTransferEvents.id, storedEvent!.id));
        await db.update(intermediatedDisbursementGroups).set({ status: "posted", postIdempotencyKey: "post-multi", postedAt: new Date() }).where(eq(intermediatedDisbursementGroups.id, storedGroup!.id));

        expect(await listTransferEvidence(context(owner.actor), group.publicId, firstSplit.publicId)).toHaveLength(2);
        expect(await getTransferEvidenceAccess(
            context(owner.actor), group.publicId, firstSplit.publicId, prepared[0]!.publicId, gateway, accessClock,
        )).toMatchObject({ status: "ready" });
        await expect(prepareTransferEvidence(context(owner.actor), group.publicId, firstSplit.publicId, evidenceInput("d"), gateway)).rejects.toMatchObject({ code: "INTERMEDIATED_DISBURSEMENT_LOCKED" });

        const link = await db.query.intermediatedTransferEvidence.findFirst({
            where: and(
                eq(intermediatedTransferEvidence.tenantId, owner.actor.tenantId),
                eq(intermediatedTransferEvidence.eventId, storedEvent!.id),
            ),
        });
        await expect((async () => db.delete(intermediatedTransferEvidence)
            .where(eq(intermediatedTransferEvidence.id, link!.id))
            .returning())()).rejects.toMatchObject({ cause: { code: "P0001" } });

        const evidenceAudits = await db.select().from(auditLogs).where(and(
            eq(auditLogs.tenantId, owner.actor.tenantId),
            eq(auditLogs.entityType, "intermediated_transfer_evidence"),
        ));
        expect(evidenceAudits).toHaveLength(6);
        for (const audit of evidenceAudits) {
            expect(audit.payload).toMatchObject({
                groupPublicId: group.publicId,
                eventPublicId: expect.any(String),
                evidencePublicId: expect.any(String),
                filePublicId: expect.any(String),
                sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
                status: expect.stringMatching(/^(pending|ready)$/),
            });
            expect(Object.keys(audit.payload as object).sort()).toEqual([
                "eventPublicId",
                "evidencePublicId",
                "filePublicId",
                "groupPublicId",
                "sha256",
                "status",
            ]);
            expect(JSON.stringify(audit.payload)).not.toMatch(/url|header|content|objectKey|originalName|secret/i);
        }
    });

    // Break caught: finalization HEADs or accepts an upload after the signer-returned expiry.
    integrationTest("rejects an expired pending upload before inspecting storage", async () => {
        const owner = await seed("tenant-transfer-expiry", "expiry");
        const group = await createGroup(owner, "expiry");
        const event = await createEvent(owner, group.publicId, "expiry");
        const gateway = new EvidenceGateway();
        const pending = await prepareTransferEvidence(context(owner.actor), group.publicId, event.publicId, evidenceInput("d"), gateway);
        gateway.acceptLastPut();
        await db.update(intermediatedTransferEvidenceIntents).set({ uploadExpiresAt: new Date(Date.now() - 1_000) }).where(eq(intermediatedTransferEvidenceIntents.publicId, pending.publicId));

        await expect(finalizeTransferEvidence(context(owner.actor), group.publicId, event.publicId, pending.publicId, gateway)).rejects.toMatchObject({ code: "EVIDENCE_UPLOAD_EXPIRED" });
        expect(gateway.headCalls).toBe(0);
    });

    // Break caught: finalization trusts any one of MIME, size, checksum, tenant, group, or event metadata.
    integrationTest("requires exact MIME size SHA and tenant/group/event storage metadata", async () => {
        const owner = await seed("tenant-transfer-metadata", "metadata");
        const group = await createGroup(owner, "metadata");
        const event = await createEvent(owner, group.publicId, "metadata");
        const gateway = new EvidenceGateway();
        const pending = await prepareTransferEvidence(context(owner.actor), group.publicId, event.publicId, evidenceInput("e"), gateway);
        gateway.acceptLastPut();
        const key = gateway.putRequests[0]!.key;
        const valid = gateway.heads.get(key)!;

        for (const mismatch of [
            { ...valid, exists: false },
            { ...valid, contentType: "image/jpeg" },
            { ...valid, contentLength: 129 },
            { ...valid, checksumSha256: "f".repeat(64) },
            { ...valid, metadata: { ...valid.metadata, tenant: "other-tenant" } },
            { ...valid, metadata: { ...valid.metadata, group: crypto.randomUUID() } },
            { ...valid, metadata: { ...valid.metadata, event: crypto.randomUUID() } },
        ]) {
            gateway.heads.set(key, mismatch);
            await expect(finalizeTransferEvidence(context(owner.actor), group.publicId, event.publicId, pending.publicId, gateway)).rejects.toMatchObject({ code: "EVIDENCE_METADATA_MISMATCH" });
        }

        gateway.heads.set(key, valid);
        await expect(finalizeTransferEvidence(context(owner.actor), group.publicId, event.publicId, pending.publicId, gateway)).resolves.toMatchObject({ status: "ready", sha256: "e".repeat(64) });
    });

    // Break caught: a ready finalize retry consults mutable storage again instead of
    // returning the exact immutable evidence result already committed to PostgreSQL.
    integrationTest("replays a ready finalize result without a second storage HEAD", async () => {
        const owner = await seed("tenant-transfer-finalize-retry", "finalize-retry");
        const group = await createGroup(owner, "finalize-retry");
        const event = await createEvent(owner, group.publicId, "finalize-retry");
        const gateway = new EvidenceGateway();
        const pending = await prepareTransferEvidence(context(owner.actor), group.publicId, event.publicId, evidenceInput("6"), gateway);
        gateway.acceptLastPut();

        const finalized = await finalizeTransferEvidence(context(owner.actor), group.publicId, event.publicId, pending.publicId, gateway);
        expect(gateway.headCalls).toBe(1);
        const replay = await finalizeTransferEvidence(
            context(owner.actor, "finalize-ready-retry"),
            group.publicId,
            event.publicId,
            pending.publicId,
            gateway,
        );
        expect(replay).toEqual(finalized);
        expect(replay).toMatchObject({
            auditPublicId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
            correlationId: "corr-read",
        });
        expect(await db.select().from(auditLogs).where(and(
            eq(auditLogs.entityType, "intermediated_transfer_evidence"),
            eq(auditLogs.entityId, pending.publicId),
        ))).toHaveLength(2);
        expect(gateway.headCalls).toBe(1);
    });

    // Break caught: the service forwards an already-expired or excessively long-lived
    // storage descriptor, allowing callers to bypass the evidence-access lifetime policy.
    integrationTest("accepts the exact access-expiry boundary and rejects expired or longer descriptors", async () => {
        const owner = await seed("tenant-transfer-access-expiry", "access-expiry");
        const group = await createGroup(owner, "access-expiry");
        const event = await createEvent(owner, group.publicId, "access-expiry");
        const gateway = new EvidenceGateway();
        const pending = await prepareTransferEvidence(context(owner.actor), group.publicId, event.publicId, evidenceInput("7"), gateway);
        gateway.acceptLastPut();
        const finalized = await finalizeTransferEvidence(context(owner.actor), group.publicId, event.publicId, pending.publicId, gateway);
        const now = new Date("2026-08-13T09:00:00.000Z");
        const clock = () => new Date(now);

        gateway.accessExpiresAt = new Date(now.getTime() + 15 * 60_000);
        await expect(getTransferEvidenceAccess(
            context(owner.actor), group.publicId, event.publicId, finalized.publicId, gateway, clock,
        )).resolves.toMatchObject({ expiresAt: "2026-08-13T09:15:00.000Z" });

        for (const invalidExpiry of [
            new Date(now.getTime() + 15 * 60_000 + 1),
            new Date(now),
            new Date(now.getTime() - 1),
        ]) {
            gateway.accessExpiresAt = invalidExpiry;
            await expect(getTransferEvidenceAccess(
                context(owner.actor), group.publicId, event.publicId, finalized.publicId, gateway, clock,
            )).rejects.toMatchObject({ code: "EVIDENCE_ACCESS_DESCRIPTOR_INVALID", status: 502 });
        }
    });

    // Break caught: one tenant can reuse a finalized checksum on another economic transfer,
    // or silently change MIME/size while retrying a checksum reservation.
    integrationTest("rejects duplicate provenance across events and conflicting retry metadata", async () => {
        const owner = await seed("tenant-transfer-provenance", "provenance");
        const group = await createGroup(owner, "provenance");
        const first = await createEvent(owner, group.publicId, "provenance-a");
        const second = await createEvent(owner, group.publicId, "provenance-b", "borrower_net_payout", "2400.00");
        const gateway = new EvidenceGateway();
        const input = evidenceInput("f");
        await prepareTransferEvidence(context(owner.actor), group.publicId, first.publicId, input, gateway);

        await expect(prepareTransferEvidence(context(owner.actor), group.publicId, second.publicId, input, gateway)).rejects.toMatchObject({ code: "EVIDENCE_HASH_CONFLICT" });
        await expect(prepareTransferEvidence(context(owner.actor), group.publicId, first.publicId, { ...input, mimeType: "image/jpeg" }, gateway)).rejects.toMatchObject({ code: "EVIDENCE_HASH_CONFLICT" });
        await expect(prepareTransferEvidence(context(owner.actor), group.publicId, first.publicId, { ...input, size: 129 }, gateway)).rejects.toMatchObject({ code: "EVIDENCE_HASH_CONFLICT" });
    });

    // Break caught: an authenticated actor can enumerate, finalize, or sign evidence by UUID
    // across tenants even though the parent group/event is inaccessible.
    integrationTest("hides every lifecycle and retrieval operation across tenants", async () => {
        const owner = await seed("tenant-transfer-owner", "owner");
        const outsider = await seed("tenant-transfer-outsider", "outsider");
        const group = await createGroup(owner, "cross-tenant");
        const event = await createEvent(owner, group.publicId, "cross-tenant");
        const gateway = new EvidenceGateway();
        const pending = await prepareTransferEvidence(context(owner.actor), group.publicId, event.publicId, evidenceInput("1"), gateway);
        gateway.acceptLastPut();
        await finalizeTransferEvidence(context(owner.actor), group.publicId, event.publicId, pending.publicId, gateway);

        for (const operation of [
            () => listTransferEvidence(context(outsider.actor), group.publicId, event.publicId),
            () => prepareTransferEvidence(context(outsider.actor), group.publicId, event.publicId, evidenceInput("2"), gateway),
            () => finalizeTransferEvidence(context(outsider.actor), group.publicId, event.publicId, pending.publicId, gateway),
            () => getTransferEvidenceAccess(context(outsider.actor), group.publicId, event.publicId, pending.publicId, gateway),
        ]) {
            await expect(operation()).rejects.toMatchObject({ code: "INTERMEDIATED_DISBURSEMENT_NOT_FOUND", status: 404 });
        }
    });
});
