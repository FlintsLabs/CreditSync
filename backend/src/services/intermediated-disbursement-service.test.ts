import { beforeEach, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import postgres from "postgres";
import { db } from "../db";
import {
    auditLogs,
    borrowers,
    files,
    intermediaries,
    intermediatedDisbursementGroupPreviews,
    intermediatedDisbursementGroups,
    intermediatedTransferEvidenceIntents,
    intermediatedTransferEvents,
    loanDisbursementEvents,
    loanDisbursements,
    loanIntermediaryAssignments,
    loans,
    transactions,
    users,
} from "../db/schema";
import type { CommandContext } from "./command-context";
import { getIntermediaryHeldBalance } from "./intermediary-service";
import {
    createDisbursementDraft,
    postDisbursement,
    reverseDisbursement,
} from "./loan-disbursement-service";
import {
    createIntermediatedDisbursementGroup,
    createTransferEvent,
    getIntermediatedDisbursementGroup,
    listIntermediatedDisbursementGroups,
    postIntermediatedDisbursement,
    previewIntermediatedDisbursement,
    reverseIntermediatedDisbursement,
} from "./intermediated-disbursement-service";

const integrationEnabled = Boolean(process.env.TEST_DATABASE_URL);
const integrationTest = integrationEnabled ? test : test.skip;
const publicIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function resetTables() {
    await db.execute(sql`SET client_min_messages TO WARNING`);
    await db.execute(sql`TRUNCATE TABLE
        audit_logs,
        intermediated_disbursement_group_previews,
        intermediated_transfer_evidence,
        intermediated_transfer_evidence_intents,
        intermediated_transfer_events,
        intermediated_disbursement_groups,
        loan_disbursement_events,
        loan_disbursements,
        loan_intermediary_assignments,
        intermediary_bank_accounts,
        intermediaries,
        transactions,
        loans,
        borrowers,
        users
        RESTART IDENTITY CASCADE`);
}

const weeklyActivationResult = {
    id: "00000000-0000-7000-8000-000000000001",
    publicId: "00000000-0000-7000-8000-000000000001",
    principal: "5000.00",
    principalAmount: "5000.00",
    interestRate: "0.00",
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
        email: `${suffix}@intermediated-disbursement.test`,
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
        // Deliberately differs from the activation snapshot. A service that reads
        // mutable loan terms instead of the persisted activation result returns 9999.
        principalAmount: "9999.00",
        interestRate: "0.00",
        repaymentType: "floating",
        outstandingPrincipal: "9999.00",
        outstandingInterest: "0.00",
        outstandingFees: "0.00",
        activationIdempotencyKey: `activation-${suffix}`,
        activationResult: weeklyActivationResult,
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
    const assignment = await db.insert(loanIntermediaryAssignments).values({
        tenantId,
        loanId: loan.id,
        intermediaryId: intermediary.id,
        role: "disbursement",
        effectiveFrom: new Date("2026-08-01T00:00:00.000Z"),
        idempotencyKey: `assignment-${suffix}`,
        createdByUserId: actor.id,
        updatedByUserId: actor.id,
    }).returning().then((rows) => rows[0]!);
    const advanceProjection = await db.insert(loanDisbursements).values({
        tenantId,
        loanId: loan.id,
        grossPrincipal: "5000.00",
        firstDayInterestDeducted: "600.00",
        netDisbursement: "4400.00",
        disbursedAt: new Date("2026-08-13T09:00:00.000Z"),
        createdByUserId: actor.id,
    }).returning().then((rows) => rows[0]!);
    return { actor, borrower, loan, intermediary, assignment, advanceProjection };
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

async function createGroup(owner: Awaited<ReturnType<typeof seed>>, suffix: string, retainedBalance = "0.00") {
    return createIntermediatedDisbursementGroup(context(owner.actor, `group-${suffix}`), {
        loanPublicId: owner.loan.publicId,
        intermediaryPublicId: owner.intermediary.publicId,
        retainedBalance,
        note: `Group ${suffix}`,
    });
}

async function addEvent(
    owner: Awaited<ReturnType<typeof seed>>,
    groupPublicId: string,
    suffix: string,
    role: "funding_to_intermediary" | "borrower_net_payout" | "advance_interest_return",
    amount: string,
    transferredAt = "2026-08-13T09:00:00.000Z",
    bankReference: string | null = null,
) {
    return createTransferEvent(context(owner.actor, `event-${suffix}`), groupPublicId, {
        role,
        channel: "bank_transfer",
        amount,
        transferredAt,
        bankReference,
        senderHint: "Sender",
        payeeHint: "Payee",
        note: `Event ${suffix}`,
    });
}

async function addExactEvents(owner: Awaited<ReturnType<typeof seed>>, groupPublicId: string, suffix: string, borrowerAmounts = ["2000.00", "2400.00"]) {
    await addEvent(owner, groupPublicId, `${suffix}-funding`, "funding_to_intermediary", "5000.00");
    for (const [index, amount] of borrowerAmounts.entries()) {
        await addEvent(owner, groupPublicId, `${suffix}-borrower-${index}`, "borrower_net_payout", amount);
    }
    await addEvent(owner, groupPublicId, `${suffix}-advance`, "advance_interest_return", "600.00");
}

async function postGroup(
    ctx: CommandContext,
    groupPublicId: string,
    proposalPublicId: string,
    confirmed = true,
) {
    return postIntermediatedDisbursement(ctx, groupPublicId, proposalPublicId, confirmed);
}

async function reverseGroup(ctx: CommandContext, groupPublicId: string, reason: string) {
    return reverseIntermediatedDisbursement(ctx, groupPublicId, reason);
}

async function heldBalance(ctx: CommandContext, intermediaryPublicId: string) {
    return getIntermediaryHeldBalance(ctx, intermediaryPublicId);
}

describe("intermediated disbursement groups and exact preview", () => {
    if (integrationEnabled) beforeEach(resetTables);

    // Break caught: preview reads current loan columns/caller arithmetic, loses one split event,
    // or rounds the weekly activation projection to anything other than 5000/4400/600.
    integrationTest("derives exact contractual targets from the activation snapshot and sums split borrower events", async () => {
        const owner = await seed("tenant-exact", "exact");
        const group = await createGroup(owner, "exact");
        expect(group).toMatchObject({
            loanPublicId: owner.loan.publicId,
            intermediaryPublicId: owner.intermediary.publicId,
            expectedFunding: "5000.00",
            expectedBorrowerPayout: "4400.00",
            expectedAdvanceInterestReturn: "600.00",
            retainedBalance: "0.00",
            status: "draft",
            auditPublicId: expect.any(String),
            correlationId: "corr-group-exact",
        });

        await addExactEvents(owner, group.publicId, "exact");
        const preview = await previewIntermediatedDisbursement(context(owner.actor), group.publicId);

        expect(preview).toMatchObject({
            expectedFunding: "5000.00",
            actualFunding: "5000.00",
            expectedBorrowerPayout: "4400.00",
            actualBorrowerPayout: "4400.00",
            expectedAdvanceInterestReturn: "600.00",
            actualAdvanceInterestReturn: "600.00",
            retainedBalance: "0.00",
            variance: "0.00",
            warnings: [],
            evidenceReady: true,
            status: "ready",
            version: 1,
            previewHash: expect.stringMatching(/^[0-9a-f]{64}$/),
            publicId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
            expiresAt: expect.any(String),
            auditPublicId: expect.any(String),
            correlationId: "corr-read",
        });
        const detail = await getIntermediatedDisbursementGroup(context(owner.actor), group.publicId);
        expect(detail.events.map((event) => [event.role, event.amount])).toEqual([
            ["funding_to_intermediary", "5000.00"],
            ["borrower_net_payout", "2000.00"],
            ["borrower_net_payout", "2400.00"],
            ["advance_interest_return", "600.00"],
        ]);
        expect(detail.latestPreview).toMatchObject({ publicId: preview.publicId, status: "ready" });
        expect(JSON.stringify(detail)).not.toContain(`\"loanId\"`);
        expect(JSON.stringify(detail)).not.toContain(`\"intermediaryId\"`);
    });

    integrationTest("keeps an exact group in review while any transfer evidence intent is pending", async () => {
        const owner = await seed("tenant-pending-evidence", "pending-evidence");
        const group = await createGroup(owner, "pending-evidence");
        await addExactEvents(owner, group.publicId, "pending-evidence");
        const storedGroup = await db.query.intermediatedDisbursementGroups.findFirst({
            where: eq(intermediatedDisbursementGroups.publicId, group.publicId),
        });
        const event = await db.query.intermediatedTransferEvents.findFirst({
            where: and(
                eq(intermediatedTransferEvents.groupId, storedGroup!.id),
                eq(intermediatedTransferEvents.role, "funding_to_intermediary"),
            ),
        });
        const file = await db.insert(files).values({
            tenantId: owner.actor.tenantId,
            ownerUserId: owner.actor.id,
            bucket: "test-evidence",
            key: "pending-evidence/funding-slip.png",
            originalName: "funding-slip.png",
            mimeType: "image/png",
            size: 128,
        }).returning().then((rows) => rows[0]!);
        await db.insert(intermediatedTransferEvidenceIntents).values({
            tenantId: owner.actor.tenantId,
            eventId: event!.id,
            fileId: file.id,
            status: "pending",
            evidenceHash: "pending-evidence-hash",
            mimeType: "image/png",
            declaredSize: 128,
            uploadExpiresAt: new Date("2026-08-13T10:00:00.000Z"),
            createdByUserId: owner.actor.id,
            updatedByUserId: owner.actor.id,
        });

        expect(await previewIntermediatedDisbursement(context(owner.actor), group.publicId)).toMatchObject({
            variance: "0.00",
            evidenceReady: false,
            status: "needs_review",
            warnings: [{ code: "TRANSFER_EVIDENCE_NOT_READY" }],
        });
    });

    // Break caught: a balanced-looking total hides role-level under/over funding, or retained
    // cash is accepted as unexplained variance instead of an explicit group target.
    integrationTest("reports under and over funding while allowing only explicit retained balance", async () => {
        const owner = await seed("tenant-variance", "variance");
        for (const [suffix, funding, warningCode, variance] of [
            ["under", "4900.00", "FUNDING_UNDER_EXPECTED", "-100.00"],
            ["over", "5100.00", "FUNDING_OVER_EXPECTED", "100.00"],
        ] as const) {
            const group = await createGroup(owner, suffix);
            await addEvent(owner, group.publicId, `${suffix}-funding`, "funding_to_intermediary", funding);
            await addEvent(owner, group.publicId, `${suffix}-borrower`, "borrower_net_payout", "4400.00");
            await addEvent(owner, group.publicId, `${suffix}-advance`, "advance_interest_return", "600.00");
            const preview = await previewIntermediatedDisbursement(context(owner.actor), group.publicId);
            expect(preview).toMatchObject({ status: "needs_review", variance });
            expect(preview.warnings).toContainEqual(expect.objectContaining({ code: warningCode, amount: "100.00" }));
        }

        const retained = await createGroup(owner, "retained", "100.00");
        expect(retained).toMatchObject({
            expectedFunding: "5000.00",
            expectedBorrowerPayout: "4300.00",
            expectedAdvanceInterestReturn: "600.00",
            retainedBalance: "100.00",
        });
        await addEvent(owner, retained.publicId, "retained-funding", "funding_to_intermediary", "5000.00");
        await addEvent(owner, retained.publicId, "retained-borrower", "borrower_net_payout", "4300.00");
        await addEvent(owner, retained.publicId, "retained-advance", "advance_interest_return", "600.00");
        expect(await previewIntermediatedDisbursement(context(owner.actor), retained.publicId)).toMatchObject({
            retainedBalance: "100.00",
            variance: "0.00",
            warnings: [],
            status: "ready",
        });

        await expect(createIntermediatedDisbursementGroup(context(owner.actor, "retained-too-large"), {
            loanPublicId: owner.loan.publicId,
            intermediaryPublicId: owner.intermediary.publicId,
            retainedBalance: "4400.01",
        })).rejects.toMatchObject({ code: "INVALID_RETAINED_BALANCE", status: 400 });
    });

    // Break caught: individually valid transfer amounts can accumulate beyond the public-money
    // contract, leaving preview unable to serialize the group and the draft unrecoverable.
    integrationTest("rejects transfer events whose role total or signed variance exceeds the public-money bound", async () => {
        const owner = await seed("tenant-aggregate-bound", "aggregate-bound");
        const maximum = "99999999999999999999999999999.99";

        const roleTotalGroup = await createGroup(owner, "role-total-bound");
        await addEvent(owner, roleTotalGroup.publicId, "role-total-maximum", "funding_to_intermediary", maximum);
        const roleTotalBefore = await db.query.intermediatedDisbursementGroups.findFirst({
            where: eq(intermediatedDisbursementGroups.publicId, roleTotalGroup.publicId),
        });
        const roleTotalAuditsBefore = await db.select().from(auditLogs).where(and(
            eq(auditLogs.entityType, "intermediated_transfer_event"),
            eq(auditLogs.action, "created"),
        ));

        await expect(addEvent(
            owner,
            roleTotalGroup.publicId,
            "role-total-overflow",
            "funding_to_intermediary",
            "0.01",
        )).rejects.toMatchObject({
            code: "INTERMEDIATED_DISBURSEMENT_AGGREGATE_OUT_OF_RANGE",
            status: 409,
            details: { field: "actualFunding" },
        });
        expect(await db.query.intermediatedDisbursementGroups.findFirst({
            where: eq(intermediatedDisbursementGroups.publicId, roleTotalGroup.publicId),
        })).toEqual(roleTotalBefore);
        expect(await db.select().from(intermediatedTransferEvents).where(
            eq(intermediatedTransferEvents.groupId, roleTotalBefore!.id),
        )).toHaveLength(1);
        expect(await db.select().from(auditLogs).where(and(
            eq(auditLogs.entityType, "intermediated_transfer_event"),
            eq(auditLogs.action, "created"),
        ))).toEqual(roleTotalAuditsBefore);
        expect(await previewIntermediatedDisbursement(context(owner.actor), roleTotalGroup.publicId)).toMatchObject({
            actualFunding: maximum,
            status: "needs_review",
        });

        const varianceGroup = await createGroup(owner, "variance-bound");
        await addEvent(owner, varianceGroup.publicId, "variance-borrower-maximum", "borrower_net_payout", maximum);
        const varianceBefore = await db.query.intermediatedDisbursementGroups.findFirst({
            where: eq(intermediatedDisbursementGroups.publicId, varianceGroup.publicId),
        });
        await expect(addEvent(
            owner,
            varianceGroup.publicId,
            "variance-advance-overflow",
            "advance_interest_return",
            maximum,
        )).rejects.toMatchObject({
            code: "INTERMEDIATED_DISBURSEMENT_AGGREGATE_OUT_OF_RANGE",
            status: 409,
            details: { field: "variance" },
        });
        expect(await db.query.intermediatedDisbursementGroups.findFirst({
            where: eq(intermediatedDisbursementGroups.publicId, varianceGroup.publicId),
        })).toEqual(varianceBefore);
        expect(await db.select().from(intermediatedTransferEvents).where(
            eq(intermediatedTransferEvents.groupId, varianceBefore!.id),
        )).toHaveLength(1);
    });

    // Break caught: group/event creation accepts an inactive/wrong intermediary or checks the
    // assignment's current status instead of its half-open effective interval at transfer time.
    integrationTest("requires the matching disbursement assignment for each transfer timestamp", async () => {
        const owner = await seed("tenant-assignment-event", "assignment-event");
        const other = await db.insert(intermediaries).values({
            tenantId: owner.actor.tenantId,
            ownerUserId: owner.actor.id,
            name: "Wrong Intermediary",
            normalizedName: "wrong intermediary",
            createdByUserId: owner.actor.id,
            updatedByUserId: owner.actor.id,
        }).returning().then((rows) => rows[0]!);

        await expect(createIntermediatedDisbursementGroup(context(owner.actor, "wrong-intermediary"), {
            loanPublicId: owner.loan.publicId,
            intermediaryPublicId: other.publicId,
            retainedBalance: "0.00",
        })).rejects.toMatchObject({ code: "DISBURSEMENT_ASSIGNMENT_REQUIRED", status: 409 });

        const group = await createGroup(owner, "effective");
        await db.update(loanIntermediaryAssignments).set({
            effectiveTo: new Date("2026-08-13T10:00:00.000Z"),
            status: "ended",
        }).where(eq(loanIntermediaryAssignments.id, owner.assignment.id));

        expect(await addEvent(
            owner,
            group.publicId,
            "historically-effective",
            "funding_to_intermediary",
            "5000.00",
            "2026-08-13T09:59:59.000Z",
        )).toMatchObject({ amount: "5000.00", status: "ready" });
        await expect(addEvent(
            owner,
            group.publicId,
            "at-ended-boundary",
            "borrower_net_payout",
            "4400.00",
            "2026-08-13T10:00:00.000Z",
        )).rejects.toMatchObject({ code: "DISBURSEMENT_ASSIGNMENT_REQUIRED", status: 409 });

        const inactiveOwner = await seed("tenant-inactive-event", "inactive-event");
        await db.update(intermediaries).set({ status: "inactive" }).where(eq(intermediaries.id, inactiveOwner.intermediary.id));
        await expect(createGroup(inactiveOwner, "inactive")).rejects.toMatchObject({ code: "INTERMEDIARY_INACTIVE", status: 409 });
    });

    // Break caught: the same command key or normalized bank reference can create two cash events,
    // while a genuine exact retry is incorrectly rejected instead of replayed.
    integrationTest("replays exact command keys and rejects conflicting keys or duplicate bank references", async () => {
        const owner = await seed("tenant-event-identity", "event-identity");
        const group = await createGroup(owner, "event-identity");
        const input = {
            role: "funding_to_intermediary" as const,
            channel: "bank_transfer" as const,
            amount: "5000.00",
            transferredAt: "2026-08-13T09:00:00.000Z",
            bankReference: "BANK-REF-001",
            note: "Funding",
        };
        const ctx = context(owner.actor, "same-event-command");
        const first = await createTransferEvent(ctx, group.publicId, input);
        const replay = await createTransferEvent(ctx, group.publicId, input);
        expect(replay).toEqual(first);
        expect(await db.select().from(intermediatedTransferEvents)).toHaveLength(1);
        expect(await db.select().from(auditLogs).where(and(
            eq(auditLogs.entityType, "intermediated_transfer_event"),
            eq(auditLogs.action, "created"),
        ))).toHaveLength(1);

        await expect(createTransferEvent(ctx, group.publicId, { ...input, amount: "4999.00" }))
            .rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_CONFLICT", status: 409 });
        await expect(createTransferEvent(context(owner.actor, "different-event-command"), group.publicId, {
            ...input,
            bankReference: "  bank-ref-001  ",
        })).rejects.toMatchObject({ code: "DUPLICATE_BANK_REFERENCE", status: 409 });

        const groupReplay = await createGroup(owner, "group-replay");
        await previewIntermediatedDisbursement(context(owner.actor), groupReplay.publicId);
        expect(await createGroup(owner, "group-replay")).toEqual(groupReplay);
        expect(await db.select().from(intermediatedDisbursementGroups).where(
            eq(intermediatedDisbursementGroups.idempotencyKey, "group-group-replay"),
        )).toHaveLength(1);
        await expect(createIntermediatedDisbursementGroup(context(owner.actor, "group-group-replay"), {
            loanPublicId: owner.loan.publicId,
            intermediaryPublicId: owner.intermediary.publicId,
            retainedBalance: "1.00",
            note: "Conflicting group",
        })).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_CONFLICT", status: 409 });
    });

    // Break caught: a ready proposal remains actionable after another event changes the group,
    // or preview versions/hashes fail to advance under the locked group state.
    integrationTest("stales prior proposals when transfer state changes and advances preview version", async () => {
        const owner = await seed("tenant-stale-preview", "stale-preview");
        const group = await createGroup(owner, "stale");
        await addExactEvents(owner, group.publicId, "stale");
        const first = await previewIntermediatedDisbursement(context(owner.actor), group.publicId);
        expect(first).toMatchObject({ version: 1, status: "ready" });

        await addEvent(owner, group.publicId, "late-extra", "funding_to_intermediary", "1.00");
        expect(await db.query.intermediatedDisbursementGroupPreviews.findFirst({
            where: eq(intermediatedDisbursementGroupPreviews.publicId, first.publicId),
        })).toMatchObject({ status: "stale" });
        expect(await db.query.intermediatedDisbursementGroups.findFirst({
            where: eq(intermediatedDisbursementGroups.publicId, group.publicId),
        })).toMatchObject({ status: "draft" });

        const second = await previewIntermediatedDisbursement(context(owner.actor), group.publicId);
        expect(second).toMatchObject({ version: 2, status: "needs_review", actualFunding: "5001.00", variance: "1.00" });
        expect(second.previewHash).not.toBe(first.previewHash);
        expect((await db.select().from(intermediatedDisbursementGroupPreviews)
            .where(eq(intermediatedDisbursementGroupPreviews.groupId, (await db.query.intermediatedDisbursementGroups.findFirst({
                where: eq(intermediatedDisbursementGroups.publicId, group.publicId),
            }))!.id))
            .orderBy(intermediatedDisbursementGroupPreviews.version)).map((row) => row.status)).toEqual(["stale", "needs_review"]);
    });

    // Break caught: a balanced intermediary group is represented as a mismatched gross/attributed
    // loan event, duplicates the activation advance charge, or posts a borrower repayment.
    integrationTest("posts one exact balanced group without requiring operator-supplied evidence or double-counting loan money", async () => {
        const owner = await seed("tenant-atomic-post", "atomic-post");
        const group = await createGroup(owner, "atomic-post");
        await addExactEvents(owner, group.publicId, "atomic-post");
        const preview = await previewIntermediatedDisbursement(context(owner.actor), group.publicId);

        await expect(postGroup(
            context(owner.actor, "atomic-post-unconfirmed"),
            group.publicId,
            preview.publicId,
            false,
        )).rejects.toMatchObject({
            code: "INTERMEDIATED_DISBURSEMENT_CONFIRMATION_REQUIRED",
            status: 400,
        });
        const postContext = context(owner.actor, "atomic-post-key");
        const posted = await postGroup(postContext, group.publicId, preview.publicId);
        expect(posted).toMatchObject({
            publicId: group.publicId,
            status: "posted",
            proposalPublicId: preview.publicId,
            loanDisbursementPublicId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
            advanceInterestProjectionPublicId: owner.advanceProjection.publicId,
            fundingAmount: "5000.00",
            borrowerPayoutAmount: "4400.00",
            advanceInterestAmount: "600.00",
            retainedBalance: "0.00",
            intermediaryHeldBalance: "0.00",
            transferEventPublicIds: expect.arrayContaining([
                expect.stringMatching(/^[0-9a-f-]{36}$/i),
            ]),
            duplicate: false,
            auditPublicId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
            correlationId: "corr-atomic-post-key",
        });

        expect((await db.select().from(intermediatedTransferEvents).orderBy(intermediatedTransferEvents.id))
            .map((row) => [row.role, row.amount, row.status])).toEqual([
            ["funding_to_intermediary", "5000.00", "posted"],
            ["borrower_net_payout", "2000.00", "posted"],
            ["borrower_net_payout", "2400.00", "posted"],
            ["advance_interest_return", "600.00", "posted"],
        ]);
        expect(await db.select().from(loanDisbursementEvents)).toMatchObject([{
            publicId: posted.loanDisbursementPublicId,
            grossAmount: "4400.00",
            loanAttributedAmount: "4400.00",
            status: "posted",
        }]);
        expect(await db.select().from(loanDisbursements)).toMatchObject([{
            publicId: owner.advanceProjection.publicId,
            grossPrincipal: "5000.00",
            firstDayInterestDeducted: "600.00",
            netDisbursement: "4400.00",
        }]);
        expect(await db.select().from(transactions).where(eq(transactions.loanId, owner.loan.id))).toHaveLength(0);
        expect(await heldBalance(context(owner.actor), owner.intermediary.publicId)).toEqual({
            intermediaryPublicId: owner.intermediary.publicId,
            fundingReceived: "5000.00",
            borrowerPayout: "4400.00",
            advanceInterestReturned: "600.00",
            disbursementHeldBalance: "0.00",
            collectionHeldBalance: "0.00",
            totalHeldBalance: "0.00",
        });

        const postAudit = await db.query.auditLogs.findFirst({ where: and(
            eq(auditLogs.entityType, "intermediated_disbursement_group"),
            eq(auditLogs.entityId, group.publicId),
            eq(auditLogs.action, "posted"),
        ) });
        expect(postAudit?.payload).toMatchObject({
            proposalPublicId: preview.publicId,
            loanDisbursementPublicId: posted.loanDisbursementPublicId,
            advanceInterestProjectionPublicId: owner.advanceProjection.publicId,
            after: expect.objectContaining({
                publicId: group.publicId,
                loanDisbursementPublicId: posted.loanDisbursementPublicId,
                advanceInterestProjectionPublicId: owner.advanceProjection.publicId,
            }),
        });

        const replay = await postGroup(postContext, group.publicId, preview.publicId);
        expect(replay).toEqual({ ...posted, duplicate: true });
        expect(await db.select().from(loanDisbursementEvents)).toHaveLength(1);
        expect(await db.select().from(loanDisbursements)).toHaveLength(1);
        expect(await db.select().from(auditLogs).where(and(
            eq(auditLogs.entityType, "intermediated_disbursement_group"),
            eq(auditLogs.entityId, group.publicId),
            eq(auditLogs.action, "posted"),
        ))).toHaveLength(1);
        await expect(postGroup(
            postContext,
            group.publicId,
            "00000000-0000-7000-8000-000000000099",
        )).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_CONFLICT", status: 409 });
        await expect(postGroup(context(owner.actor, "different-post-key"), group.publicId, preview.publicId))
            .rejects.toMatchObject({ code: "INTERMEDIATED_DISBURSEMENT_ALREADY_POSTED", status: 409 });
    });

    // Break caught: concurrent retries race past the ready check and create duplicate loan payout
    // projections, transfer posting, or group audit records.
    integrationTest("serializes concurrent same-key posts into one financial result", async () => {
        const owner = await seed("tenant-concurrent-post", "concurrent-post");
        const group = await createGroup(owner, "concurrent-post");
        await addExactEvents(owner, group.publicId, "concurrent-post");
        const preview = await previewIntermediatedDisbursement(context(owner.actor), group.publicId);
        const postContext = context(owner.actor, "concurrent-post-key");

        const [first, second] = await Promise.all([
            postGroup(postContext, group.publicId, preview.publicId),
            postGroup(postContext, group.publicId, preview.publicId),
        ]);
        expect(new Set([first.loanDisbursementPublicId, second.loanDisbursementPublicId]).size).toBe(1);
        expect(new Set([first.auditPublicId, second.auditPublicId]).size).toBe(1);
        expect([first.duplicate, second.duplicate].sort()).toEqual([false, true]);
        expect(await db.select().from(loanDisbursementEvents)).toHaveLength(1);
        expect(await db.select().from(auditLogs).where(and(
            eq(auditLogs.entityType, "intermediated_disbursement_group"),
            eq(auditLogs.action, "posted"),
        ))).toHaveLength(1);
    });

    // Break caught: the loan row lock serializes two exact groups, but the second
    // transaction never checks the first group and pays the same activation twice.
    integrationTest("allows only one uncompensated posted group per loan across sequential and concurrent posts", async () => {
        const sequential = await seed("tenant-distinct-post-sequential", "distinct-post-sequential");
        const firstGroup = await createGroup(sequential, "distinct-first");
        const secondGroup = await createGroup(sequential, "distinct-second");
        await addExactEvents(sequential, firstGroup.publicId, "distinct-first");
        await addExactEvents(sequential, secondGroup.publicId, "distinct-second");
        const firstPreview = await previewIntermediatedDisbursement(context(sequential.actor), firstGroup.publicId);
        const secondPreview = await previewIntermediatedDisbursement(context(sequential.actor), secondGroup.publicId);
        const firstPost = await postGroup(context(sequential.actor, "distinct-first-post"), firstGroup.publicId, firstPreview.publicId);

        await expect(postGroup(
            context(sequential.actor, "distinct-second-post"),
            secondGroup.publicId,
            secondPreview.publicId,
        )).rejects.toMatchObject({ code: "INTERMEDIATED_DISBURSEMENT_ALREADY_POSTED_FOR_LOAN", status: 409 });
        expect(await db.select().from(loanDisbursementEvents)).toHaveLength(1);

        await reverseGroup(context(sequential.actor, "distinct-first-reverse"), firstGroup.publicId, "Transfer recalled");
        await expect(postGroup(
            context(sequential.actor, "distinct-second-replacement"),
            secondGroup.publicId,
            secondPreview.publicId,
        )).resolves.toMatchObject({ status: "posted", borrowerPayoutAmount: "4400.00" });

        const concurrent = await seed("tenant-distinct-post-concurrent", "distinct-post-concurrent");
        const concurrentA = await createGroup(concurrent, "concurrent-a");
        const concurrentB = await createGroup(concurrent, "concurrent-b");
        await addExactEvents(concurrent, concurrentA.publicId, "concurrent-a");
        await addExactEvents(concurrent, concurrentB.publicId, "concurrent-b");
        const [previewA, previewB] = await Promise.all([
            previewIntermediatedDisbursement(context(concurrent.actor), concurrentA.publicId),
            previewIntermediatedDisbursement(context(concurrent.actor), concurrentB.publicId),
        ]);
        const results = await Promise.allSettled([
            postGroup(context(concurrent.actor, "concurrent-a-post"), concurrentA.publicId, previewA.publicId),
            postGroup(context(concurrent.actor, "concurrent-b-post"), concurrentB.publicId, previewB.publicId),
        ]);
        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        expect(results.filter((result) => result.status === "rejected").map((result) => (
            result as PromiseRejectedResult
        ).reason)).toEqual([expect.objectContaining({
            code: "INTERMEDIATED_DISBURSEMENT_ALREADY_POSTED_FOR_LOAN",
            status: 409,
        })]);
        expect(await db.select().from(intermediatedDisbursementGroups).where(and(
            eq(intermediatedDisbursementGroups.tenantId, concurrent.actor.tenantId),
            eq(intermediatedDisbursementGroups.status, "posted"),
        ))).toHaveLength(1);
        expect(await db.select().from(loanDisbursementEvents).where(
            eq(loanDisbursementEvents.tenantId, concurrent.actor.tenantId),
        )).toHaveLength(1);
    });

    // Break caught: post takes a loan lock but uses the stale pre-lock loan snapshot,
    // allowing a payout after the loan has already become paid.
    integrationTest("rejects a proposal when its loan is no longer active at post time", async () => {
        const owner = await seed("tenant-post-paid-loan", "post-paid-loan");
        const group = await createGroup(owner, "post-paid-loan");
        await addExactEvents(owner, group.publicId, "post-paid-loan");
        const preview = await previewIntermediatedDisbursement(context(owner.actor), group.publicId);
        await db.update(loans).set({ status: "paid" }).where(eq(loans.id, owner.loan.id));

        await expect(postGroup(
            context(owner.actor, "post-paid-loan-key"),
            group.publicId,
            preview.publicId,
        )).rejects.toMatchObject({ code: "LOAN_NOT_ACTIVE", status: 409 });
        expect(await db.select().from(loanDisbursementEvents)).toHaveLength(0);
        expect((await db.query.intermediatedDisbursementGroups.findFirst({ where: eq(
            intermediatedDisbursementGroups.publicId,
            group.publicId,
        ) }))?.status).toBe("ready");
    });

    // Break caught: the intermediary payout uses a public command-key namespace,
    // allowing a regular post command to preoccupy a legitimate group projection.
    integrationTest("reserves the internal borrower-payout key namespace from public post commands", async () => {
        const owner = await seed("tenant-payout-key-isolation", "payout-key-isolation");
        const group = await createGroup(owner, "payout-key-isolation");
        await addExactEvents(owner, group.publicId, "payout-key-isolation");
        const preview = await previewIntermediatedDisbursement(context(owner.actor), group.publicId);
        const ordinaryDraft = await createDisbursementDraft(context(owner.actor), owner.loan.publicId, {
            grossAmount: "1.00",
            loanAttributedAmount: "1.00",
            channel: "cash",
            disbursedAt: "2026-08-13T10:00:00.000Z",
        });
        const internalPayoutKey = `internal:intermediated-payout:${group.publicId}`;

        await expect(postDisbursement(
            context(owner.actor, internalPayoutKey),
            ordinaryDraft.publicId,
        )).rejects.toMatchObject({ code: "RESERVED_IDEMPOTENCY_KEY", status: 400 });
        const posted = await postGroup(
            context(owner.actor, "post-payout-key-isolation"),
            group.publicId,
            preview.publicId,
        );

        expect(await db.query.loanDisbursementEvents.findFirst({ where: eq(
            loanDisbursementEvents.publicId,
            ordinaryDraft.publicId,
        ) })).toMatchObject({ status: "draft", postIdempotencyKey: null });
        expect(await db.query.loanDisbursementEvents.findFirst({ where: eq(
            loanDisbursementEvents.publicId,
            posted.loanDisbursementPublicId,
        ) })).toMatchObject({
            status: "posted",
            postIdempotencyKey: internalPayoutKey,
            grossAmount: "4400.00",
            loanAttributedAmount: "4400.00",
        });
    });

    // Break caught: post trusts a stale or needs-review preview and creates partial financial
    // projections before discovering the proposal or variance is invalid.
    integrationTest("rejects stale proposals and non-zero variance without financial side effects", async () => {
        const owner = await seed("tenant-post-validation", "post-validation");
        const staleGroup = await createGroup(owner, "post-stale");
        await addExactEvents(owner, staleGroup.publicId, "post-stale");
        const stale = await previewIntermediatedDisbursement(context(owner.actor), staleGroup.publicId);
        const current = await previewIntermediatedDisbursement(context(owner.actor), staleGroup.publicId);
        expect(current).toMatchObject({ version: 2, status: "ready" });
        await expect(postGroup(context(owner.actor, "post-stale-key"), staleGroup.publicId, stale.publicId))
            .rejects.toMatchObject({ code: "STALE_INTERMEDIATED_DISBURSEMENT_PROPOSAL", status: 409 });

        const varianceGroup = await createGroup(owner, "post-variance");
        await addEvent(owner, varianceGroup.publicId, "post-variance-funding", "funding_to_intermediary", "4999.99");
        await addEvent(owner, varianceGroup.publicId, "post-variance-borrower", "borrower_net_payout", "4400.00");
        await addEvent(owner, varianceGroup.publicId, "post-variance-advance", "advance_interest_return", "600.00");
        const variance = await previewIntermediatedDisbursement(context(owner.actor), varianceGroup.publicId);
        expect(variance).toMatchObject({ status: "needs_review", variance: "-0.01" });
        await expect(postGroup(context(owner.actor, "post-variance-key"), varianceGroup.publicId, variance.publicId))
            .rejects.toMatchObject({ code: "INTERMEDIATED_DISBURSEMENT_NOT_READY", status: 409 });

        expect(await db.select().from(loanDisbursementEvents)).toHaveLength(0);
        expect(await db.select().from(transactions)).toHaveLength(0);
        expect(await db.select().from(intermediatedDisbursementGroups).where(eq(intermediatedDisbursementGroups.status, "posted"))).toHaveLength(0);
        expect(await db.select().from(auditLogs).where(and(
            eq(auditLogs.entityType, "intermediated_disbursement_group"),
            eq(auditLogs.action, "posted"),
        ))).toHaveLength(0);
    });

    // Break caught: reversal edits immutable posted rows or deletes loan history instead of adding
    // public-ID-linked compensating group, transfer, and loan-disbursement records.
    integrationTest("reverses a posted group with append-only compensating provenance and exact replay", async () => {
        const owner = await seed("tenant-post-reversal", "post-reversal");
        const group = await createGroup(owner, "post-reversal");
        await addExactEvents(owner, group.publicId, "post-reversal");
        const preview = await previewIntermediatedDisbursement(context(owner.actor), group.publicId);
        const posted = await postGroup(context(owner.actor, "post-before-reversal"), group.publicId, preview.publicId);

        await expect(reverseDisbursement(
            context(owner.actor, "generic-reverse-intermediary-payout"),
            posted.loanDisbursementPublicId,
            "Wrong generic workflow",
        )).rejects.toMatchObject({
            code: "INTERMEDIATED_DISBURSEMENT_REVERSAL_REQUIRED",
            status: 409,
        });
        expect(await db.select().from(loanDisbursementEvents)).toHaveLength(1);

        const reversalContext = context(owner.actor, "reverse-group-key");
        const reversed = await reverseGroup(reversalContext, group.publicId, "Operator confirmed the lender transfer was recalled");
        expect(reversed.publicId).toMatch(publicIdPattern);
        expect(reversed.publicId).not.toBe(group.publicId);
        expect(reversed).toMatchObject({
            status: "reversed",
            reversedGroupPublicId: group.publicId,
            reversedLoanDisbursementPublicId: posted.loanDisbursementPublicId,
            loanDisbursementPublicId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
            advanceInterestProjectionPublicId: owner.advanceProjection.publicId,
            fundingAmount: "5000.00",
            borrowerPayoutAmount: "4400.00",
            advanceInterestAmount: "600.00",
            intermediaryHeldBalance: "0.00",
            reversalReason: "Operator confirmed the lender transfer was recalled",
            transferEvents: expect.arrayContaining([
                expect.objectContaining({
                    publicId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
                    reversedEventPublicId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
                }),
            ]),
            duplicate: false,
            auditPublicId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
            correlationId: "corr-reverse-group-key",
        });

        expect((await db.select().from(intermediatedDisbursementGroups).orderBy(intermediatedDisbursementGroups.id))
            .map((row) => [row.publicId, row.status, row.reversedGroupId])).toEqual([
            [group.publicId, "posted", null],
            [reversed.publicId, "reversed", expect.any(Number)],
        ]);
        expect((await db.select().from(intermediatedTransferEvents).orderBy(intermediatedTransferEvents.id))
            .map((row) => [row.role, row.amount, row.status, row.reversedEventId === null])).toEqual([
            ["funding_to_intermediary", "5000.00", "posted", true],
            ["borrower_net_payout", "2000.00", "posted", true],
            ["borrower_net_payout", "2400.00", "posted", true],
            ["advance_interest_return", "600.00", "posted", true],
            ["funding_to_intermediary", "5000.00", "reversed", false],
            ["borrower_net_payout", "2000.00", "reversed", false],
            ["borrower_net_payout", "2400.00", "reversed", false],
            ["advance_interest_return", "600.00", "reversed", false],
        ]);
        const reversalDetail = await getIntermediatedDisbursementGroup(context(owner.actor), reversed.publicId);
        expect(reversalDetail.events).toHaveLength(4);
        expect(reversalDetail.events.every((event) => (
            typeof event.reversedEventPublicId === "string" && publicIdPattern.test(event.reversedEventPublicId)
        ))).toBe(true);
        expect(JSON.stringify(reversalDetail)).not.toContain(`"reversedEventId"`);
        expect((await db.select().from(loanDisbursementEvents).orderBy(loanDisbursementEvents.id))
            .map((row) => [row.publicId, row.status, row.grossAmount, row.loanAttributedAmount, row.reversedEventId === null])).toEqual([
            [posted.loanDisbursementPublicId, "posted", "4400.00", "4400.00", true],
            [reversed.loanDisbursementPublicId, "reversed", "4400.00", "4400.00", false],
        ]);
        expect(await db.select().from(loanDisbursements)).toHaveLength(1);
        expect(await db.select().from(transactions)).toHaveLength(0);
        expect(await heldBalance(context(owner.actor), owner.intermediary.publicId)).toEqual({
            intermediaryPublicId: owner.intermediary.publicId,
            fundingReceived: "0.00",
            borrowerPayout: "0.00",
            advanceInterestReturned: "0.00",
            disbursementHeldBalance: "0.00",
            collectionHeldBalance: "0.00",
            totalHeldBalance: "0.00",
        });

        const replay = await reverseGroup(reversalContext, group.publicId, "Operator confirmed the lender transfer was recalled");
        expect(replay).toEqual({ ...reversed, duplicate: true });
        expect(await db.select().from(intermediatedDisbursementGroups)).toHaveLength(2);
        expect(await db.select().from(intermediatedTransferEvents)).toHaveLength(8);
        expect(await db.select().from(loanDisbursementEvents)).toHaveLength(2);
        await expect(reverseGroup(reversalContext, group.publicId, "Different reason"))
            .rejects.toMatchObject({ code: "INTERMEDIATED_DISBURSEMENT_REVERSAL_CONFLICT", status: 409 });
        await expect(reverseGroup(context(owner.actor, "reverse-other-key"), group.publicId, "Different reason"))
            .rejects.toMatchObject({ code: "INTERMEDIATED_DISBURSEMENT_REVERSAL_CONFLICT", status: 409 });
    });

    // Break caught: generic reversal locks payout-event then loan while group reversal
    // locks loan then payout-event, producing a real PostgreSQL deadlock under overlap.
    integrationTest("completes concurrent generic and group reversal without deadlock", async () => {
        const owner = await seed("tenant-reversal-lock-order", "reversal-lock-order");
        const group = await createGroup(owner, "reversal-lock-order");
        await addExactEvents(owner, group.publicId, "reversal-lock-order");
        const preview = await previewIntermediatedDisbursement(context(owner.actor), group.publicId);
        const posted = await postGroup(context(owner.actor, "reversal-lock-order-post"), group.publicId, preview.publicId);
        const payout = await db.query.loanDisbursementEvents.findFirst({ where: eq(
            loanDisbursementEvents.publicId,
            posted.loanDisbursementPublicId,
        ) });
        const databaseUrl = process.env.TEST_DATABASE_URL!;
        const blocker = postgres(databaseUrl, { max: 1 });
        const observer = postgres(databaseUrl, { max: 1 });
        let releaseBlocker!: () => void;
        let confirmLocked!: () => void;
        const release = new Promise<void>((resolve) => { releaseBlocker = resolve; });
        const locked = new Promise<void>((resolve) => { confirmLocked = resolve; });
        const blockerTransaction = blocker.begin(async (connection) => {
            await connection`SELECT id FROM loan_disbursement_events WHERE id = ${payout!.id} FOR UPDATE`;
            confirmLocked();
            await release;
        });
        const waitForLockWaiters = async (minimum: number) => {
            for (let attempt = 0; attempt < 200; attempt += 1) {
                const rows = await observer<{ count: number }[]>`
                    SELECT count(DISTINCT pid)::int AS count
                    FROM pg_stat_activity
                    WHERE datname = current_database()
                      AND pid <> pg_backend_pid()
                      AND wait_event_type = 'Lock'
                `;
                if ((rows[0]?.count ?? 0) >= minimum) return;
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            throw new Error(`Timed out waiting for ${minimum} PostgreSQL lock waiters`);
        };

        try {
            await locked;
            const generic = reverseDisbursement(
                context(owner.actor, "concurrent-generic-reversal"),
                posted.loanDisbursementPublicId,
                "Wrong generic workflow",
            );
            await waitForLockWaiters(1);
            const grouped = reverseGroup(
                context(owner.actor, "concurrent-group-reversal"),
                group.publicId,
                "Operator confirmed the transfer was recalled",
            );
            await waitForLockWaiters(2);
            releaseBlocker();

            const results = await Promise.race([
                Promise.allSettled([generic, grouped]),
                new Promise<never>((_, reject) => setTimeout(
                    () => reject(new Error("Concurrent reversals did not complete")),
                    5_000,
                )),
            ]);
            expect(results[0]).toMatchObject({
                status: "rejected",
                reason: { code: "INTERMEDIATED_DISBURSEMENT_REVERSAL_REQUIRED", status: 409 },
            });
            expect(results[1]).toMatchObject({
                status: "fulfilled",
                value: { status: "reversed", reversedGroupPublicId: group.publicId },
            });
            expect(results.map((result) => result.status)).toEqual(["rejected", "fulfilled"]);
            expect(await db.select().from(intermediatedDisbursementGroups).where(
                eq(intermediatedDisbursementGroups.reversedGroupId, (await db.query.intermediatedDisbursementGroups.findFirst({
                    where: eq(intermediatedDisbursementGroups.publicId, group.publicId),
                }))!.id),
            )).toHaveLength(1);
            expect(await db.select().from(loanDisbursementEvents).where(
                eq(loanDisbursementEvents.reversedEventId, payout!.id),
            )).toHaveLength(1);
        } finally {
            releaseBlocker();
            await blockerTransaction.catch(() => undefined);
            await Promise.all([blocker.end(), observer.end()]);
        }
    }, 10_000);

    // Break caught: predictable internal compensating keys share the public command
    // namespace, so ordinary drafts can permanently preoccupy a legitimate reversal.
    integrationTest("keeps internal reversal keys isolated from public group, event, and payout commands", async () => {
        const owner = await seed("tenant-reversal-key-isolation", "reversal-key-isolation");
        const group = await createGroup(owner, "reversal-key-isolation");
        await addExactEvents(owner, group.publicId, "reversal-key-isolation");
        const preview = await previewIntermediatedDisbursement(context(owner.actor), group.publicId);
        const posted = await postGroup(context(owner.actor, "reversal-key-isolation-post"), group.publicId, preview.publicId);
        const sourceEvent = await db.query.intermediatedTransferEvents.findFirst({ where: and(
            eq(intermediatedTransferEvents.tenantId, owner.actor.tenantId),
            eq(intermediatedTransferEvents.role, "funding_to_intermediary"),
        ) });

        const blocker = await createIntermediatedDisbursementGroup(
            context(owner.actor, `reversal:${group.publicId}`),
            {
                loanPublicId: owner.loan.publicId,
                intermediaryPublicId: owner.intermediary.publicId,
                retainedBalance: "0.00",
            },
        );
        await createTransferEvent(context(owner.actor, `reversal:${sourceEvent!.publicId}`), blocker.publicId, {
            role: "funding_to_intermediary",
            channel: "cash",
            amount: "1.00",
            transferredAt: "2026-08-13T10:00:00.000Z",
        });
        const regularDraft = await createDisbursementDraft(context(owner.actor), owner.loan.publicId, {
            grossAmount: "1.00",
            loanAttributedAmount: "1.00",
            channel: "cash",
            disbursedAt: "2026-08-13T10:00:00.000Z",
        });
        const regularPosted = await postDisbursement(context(owner.actor, "regular-collision-post"), regularDraft.publicId);
        await reverseDisbursement(
            context(owner.actor, `intermediated-payout-reversal:${group.publicId}`),
            regularPosted.publicId,
            "Regular correction",
        );
        const reservedDraft = await createDisbursementDraft(context(owner.actor), owner.loan.publicId, {
            grossAmount: "1.00",
            loanAttributedAmount: "1.00",
            channel: "cash",
            disbursedAt: "2026-08-13T10:01:00.000Z",
        });
        const reservedPosted = await postDisbursement(
            context(owner.actor, "reserved-reversal-post"),
            reservedDraft.publicId,
        );
        await expect(reverseDisbursement(
            context(owner.actor, "internal:reserved-payout-reversal"),
            reservedPosted.publicId,
            "Should reject reserved namespace",
        )).rejects.toMatchObject({ code: "RESERVED_IDEMPOTENCY_KEY", status: 400 });

        await expect(reverseGroup(
            context(owner.actor, "isolated-group-reversal"),
            group.publicId,
            "Intermediary transfer recalled",
        )).resolves.toMatchObject({
            status: "reversed",
            reversedLoanDisbursementPublicId: posted.loanDisbursementPublicId,
        });
        await expect(createIntermediatedDisbursementGroup(context(owner.actor, "internal:reserved-group"), {
            loanPublicId: owner.loan.publicId,
            intermediaryPublicId: owner.intermediary.publicId,
            retainedBalance: "0.00",
        })).rejects.toMatchObject({ code: "RESERVED_IDEMPOTENCY_KEY", status: 400 });
        await expect(createTransferEvent(context(owner.actor, "internal:reserved-event"), blocker.publicId, {
            role: "borrower_net_payout",
            channel: "cash",
            amount: "1.00",
            transferredAt: "2026-08-13T10:00:00.000Z",
        })).rejects.toMatchObject({ code: "RESERVED_IDEMPOTENCY_KEY", status: 400 });
    });

    // Break caught: list/get leaks another owner's groups or accepts an unrelated loan filter,
    // and public presenters expose numeric identifiers or stored reference hashes.
    integrationTest("keeps list and detail reads owner-scoped and exposes public identifiers only", async () => {
        const owner = await seed("tenant-read-scope", "read-owner");
        const otherTenant = await seed("tenant-read-scope-other", "read-other-tenant");
        const otherActor = await db.insert(users).values({
            tenantId: owner.actor.tenantId,
            email: "other@intermediated-disbursement.test",
            role: "collector",
        }).returning().then((rows) => rows[0]!);
        const group = await createGroup(owner, "read");
        const createdEvent = await addEvent(
            owner,
            group.publicId,
            "read-event",
            "funding_to_intermediary",
            "5000.00",
            "2026-08-13T09:00:00.000Z",
            "  ＰＲＩＶＡＴＥ   ＲＥＦ  ",
        );
        const storedEvent = await db.query.intermediatedTransferEvents.findFirst({
            where: eq(intermediatedTransferEvents.publicId, createdEvent.publicId),
        });
        const evidenceFile = await db.insert(files).values({
            tenantId: owner.actor.tenantId,
            ownerUserId: owner.actor.id,
            bucket: "private-evidence",
            key: "private/read-slip.png",
            url: "https://storage.invalid/private-signed-url",
            originalName: "read-slip.png",
            mimeType: "image/png",
            size: 128,
        }).returning().then((rows) => rows[0]!);
        const evidenceIntent = await db.insert(intermediatedTransferEvidenceIntents).values({
            tenantId: owner.actor.tenantId,
            eventId: storedEvent!.id,
            fileId: evidenceFile.id,
            status: "ready",
            evidenceHash: "read-scope-private-checksum",
            mimeType: "image/png",
            declaredSize: 128,
            uploadExpiresAt: new Date("2026-08-13T10:00:00.000Z"),
            finalizedAt: new Date("2026-08-13T09:05:00.000Z"),
            createdByUserId: owner.actor.id,
            updatedByUserId: owner.actor.id,
        }).returning().then((rows) => rows[0]!);

        const listed = await listIntermediatedDisbursementGroups(context(owner.actor), {
            loanPublicId: owner.loan.publicId,
            intermediaryPublicId: owner.intermediary.publicId,
            status: "draft",
        });
        expect(listed).toHaveLength(1);
        expect(listed[0]).toMatchObject({
            publicId: group.publicId,
            loanPublicId: owner.loan.publicId,
            events: [{
                publicId: createdEvent.publicId,
                role: "funding_to_intermediary",
                amount: "5000.00",
                payeeHint: "Payee",
                bankReference: "PRIVATE REF",
                evidence: {
                    status: "ready",
                    count: 1,
                    items: [{
                        publicId: evidenceIntent.publicId,
                        filePublicId: evidenceFile.publicId,
                        status: "ready",
                        mimeType: "image/png",
                    }],
                },
            }],
        });
        const detail = await getIntermediatedDisbursementGroup(context(owner.actor), group.publicId);
        expect(detail.events[0]?.evidence).toEqual({
            status: "ready",
            count: 1,
            items: [{
                publicId: evidenceIntent.publicId,
                filePublicId: evidenceFile.publicId,
                status: "ready",
                mimeType: "image/png",
            }],
        });
        expect(JSON.stringify(listed)).not.toContain("bankReferenceHash");
        expect(JSON.stringify(listed)).not.toContain("read-scope-private-checksum");
        expect(JSON.stringify(listed)).not.toContain("private-signed-url");
        expect(JSON.stringify(listed)).not.toContain("private/read-slip.png");
        expect(JSON.stringify(listed)).not.toContain(`\"id\":`);

        await expect(getIntermediatedDisbursementGroup(context(otherActor), group.publicId))
            .rejects.toMatchObject({ code: "INTERMEDIATED_DISBURSEMENT_NOT_FOUND", status: 404 });
        expect(await listIntermediatedDisbursementGroups(context(otherActor))).toEqual([]);
        await expect(getIntermediatedDisbursementGroup(context(otherTenant.actor), group.publicId))
            .rejects.toMatchObject({ code: "INTERMEDIATED_DISBURSEMENT_NOT_FOUND", status: 404 });
        await expect(addEvent(otherTenant, group.publicId, "cross-tenant", "funding_to_intermediary", "1.00"))
            .rejects.toMatchObject({ code: "INTERMEDIATED_DISBURSEMENT_NOT_FOUND", status: 404 });
        await expect(previewIntermediatedDisbursement(context(otherTenant.actor), group.publicId))
            .rejects.toMatchObject({ code: "INTERMEDIATED_DISBURSEMENT_NOT_FOUND", status: 404 });
        expect(await listIntermediatedDisbursementGroups(context(otherTenant.actor))).toEqual([]);
    });
});
