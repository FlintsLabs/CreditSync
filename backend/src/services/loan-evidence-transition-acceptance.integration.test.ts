import { beforeEach, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { auditLogs, borrowers, files, loanDisbursementEvidenceIntents, loanDisbursementEvents, loanSchedules, loans, paymentEvidence, paymentIntakes, paymentMatchProposals, transactions, users } from "../db/schema";
import type { CommandContext } from "./command-context";
import { createLoanDraft, activateLoan } from "./loan-application-service";
import { createDisbursementDraft, postDisbursement, prepareDisbursementEvidence, type DisbursementEvidenceStorageGateway } from "./loan-disbursement-service";
import { createPaymentIntake, postPayment, previewPaymentMatch } from "./payment-service";

const integrationTest = process.env.TEST_DATABASE_URL ? test : test.skip;

async function resetTables() {
    await db.execute(sql`TRUNCATE TABLE
        audit_logs, loan_disbursement_evidence, loan_disbursement_evidence_intents,
        loan_disbursement_events, loan_schedules, loans, borrowers, files, users
        RESTART IDENTITY CASCADE`);
}

function context(actor: { id: number; tenantId: string }, key: string): CommandContext {
    return {
        tenantId: actor.tenantId,
        actorUserId: actor.id,
        actorSource: "web",
        requestId: `req-${key}`,
        correlationId: `corr-${key}`,
        idempotencyKey: key,
    };
}

function evidenceBarrier() {
    let entered!: () => void;
    let release!: () => void;
    const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    const gateway: DisbursementEvidenceStorageGateway = {
        preparePut: async () => {
            entered();
            await released;
            return { uploadUrl: "https://storage.example.test/signed", expiresAt: new Date(Date.now() + 60_000) };
        },
        head: async () => ({ exists: false, contentType: null, contentLength: null, checksumSha256: null, metadata: {} }),
    };
    return { entered: enteredPromise, release, gateway };
}

async function seedDraft() {
    const tenantId = `transition-acceptance-${crypto.randomUUID()}`;
    const actor = await db.insert(users).values({ tenantId, email: `${crypto.randomUUID()}@example.test`, role: "owner" }).returning().then((rows) => rows[0]!);
    const borrower = await db.insert(borrowers).values({ tenantId, ownerUserId: actor.id, name: "Transition acceptance borrower" }).returning().then((rows) => rows[0]!);
    const draft = await createLoanDraft(context(actor, "draft-create"), {
        borrowerPublicId: borrower.publicId,
        principal: "1200.00",
        interestRate: "12.00",
        repaymentType: "monthly",
        termMonths: 3,
        totalInstallments: 3,
        startDate: "2026-09-14",
    });
    return { actor, borrower, draft };
}

async function payout(actor: { id: number; tenantId: string }, loanPublicId: string, key: string) {
    return createDisbursementDraft(context(actor, key), loanPublicId, {
        grossAmount: "1200.00",
        loanAttributedAmount: "1200.00",
        channel: "bank_transfer",
        disbursedAt: "2026-09-14T04:00:00.000Z",
    });
}

const evidenceInput = { mimeType: "image/png", size: 12, sha256: "a".repeat(64) };

describe("loan activation and payout evidence transition acceptance", () => {
    if (process.env.TEST_DATABASE_URL) beforeEach(resetTables);

    integrationTest("prepare wins against activation and activation leaves no effects on rejection", async () => {
        const seeded = await seedDraft();
        const draftPayout = await payout(seeded.actor, seeded.draft.publicId, "prepare-vs-activation-payout");
        const barrier = evidenceBarrier();
        let preparing: Promise<unknown> | undefined;
        try {
            preparing = prepareDisbursementEvidence(context(seeded.actor, "prepare-vs-activation"), draftPayout.publicId, evidenceInput, barrier.gateway);
            await barrier.entered;
            await expect(activateLoan(context(seeded.actor, "activation-after-prepare"), seeded.draft.publicId)).rejects.toMatchObject({ code: "EVIDENCE_REQUIRED_NOT_READY", status: 409 });
        } finally {
            barrier.release();
            if (preparing) await Promise.allSettled([preparing]);
        }
        expect(await db.query.loans.findFirst({ where: eq(loans.publicId, seeded.draft.publicId) })).toMatchObject({ status: "draft", activationIdempotencyKey: null });
        expect(await db.query.loanDisbursementEvents.findFirst({ where: eq(loanDisbursementEvents.publicId, draftPayout.publicId) })).toMatchObject({ status: "draft", postIdempotencyKey: null });
        expect(await db.select().from(loanSchedules).where(eq(loanSchedules.tenantId, seeded.actor.tenantId))).toHaveLength(0);
        expect(await db.select().from(auditLogs).where(and(eq(auditLogs.tenantId, seeded.actor.tenantId), eq(auditLogs.action, "activated")))).toHaveLength(0);
    });

    integrationTest("activation wins before a later payout evidence preparation", async () => {
        const seeded = await seedDraft();
        const draftPayout = await payout(seeded.actor, seeded.draft.publicId, "activation-vs-prepare-payout");
        const activated = await activateLoan(context(seeded.actor, "activation-before-prepare"), seeded.draft.publicId);
        const barrier = evidenceBarrier();
        let preparing: Promise<unknown> | undefined;
        try {
            preparing = prepareDisbursementEvidence(context(seeded.actor, "prepare-after-activation"), draftPayout.publicId, evidenceInput, barrier.gateway);
            await barrier.entered;
        } finally {
            barrier.release();
            if (preparing) await Promise.allSettled([preparing]);
        }
        await expect(preparing!).resolves.toMatchObject({ publicId: expect.any(String) });
        expect(activated.status).toBe("active");
        expect(await db.query.loans.findFirst({ where: eq(loans.publicId, seeded.draft.publicId) })).toMatchObject({ status: "active", activationIdempotencyKey: "activation-before-prepare" });
        expect(await db.query.loanDisbursementEvents.findFirst({ where: eq(loanDisbursementEvents.publicId, draftPayout.publicId) })).toMatchObject({ status: "draft" });
        expect(await db.select().from(loanDisbursementEvidenceIntents).where(eq(loanDisbursementEvidenceIntents.tenantId, seeded.actor.tenantId))).toMatchObject([{ status: "pending" }]);
    });

    integrationTest("prepare wins against payout posting and posting leaves the draft untouched", async () => {
        const seeded = await seedDraft();
        await activateLoan(context(seeded.actor, "activation-before-post-race"), seeded.draft.publicId);
        const draftPayout = await payout(seeded.actor, seeded.draft.publicId, "prepare-vs-post-payout");
        const barrier = evidenceBarrier();
        let preparing: Promise<unknown> | undefined;
        try {
            preparing = prepareDisbursementEvidence(context(seeded.actor, "prepare-before-post"), draftPayout.publicId, evidenceInput, barrier.gateway);
            await barrier.entered;
            await expect(postDisbursement(context(seeded.actor, "post-after-prepare"), draftPayout.publicId)).rejects.toMatchObject({ code: "EVIDENCE_REQUIRED_NOT_READY", status: 409 });
        } finally {
            barrier.release();
            if (preparing) await Promise.allSettled([preparing]);
        }
        expect(await db.query.loanDisbursementEvents.findFirst({ where: eq(loanDisbursementEvents.publicId, draftPayout.publicId) })).toMatchObject({ status: "draft", postedAt: null, postIdempotencyKey: null });
        expect(await db.select().from(auditLogs).where(and(eq(auditLogs.tenantId, seeded.actor.tenantId), eq(auditLogs.entityId, draftPayout.publicId), eq(auditLogs.action, "posted")))).toHaveLength(0);
    });

    integrationTest("payout posting wins before a later evidence preparation", async () => {
        const seeded = await seedDraft();
        await activateLoan(context(seeded.actor, "activation-before-post"), seeded.draft.publicId);
        const draftPayout = await payout(seeded.actor, seeded.draft.publicId, "post-vs-prepare-payout");
        await expect(postDisbursement(context(seeded.actor, "post-before-prepare"), draftPayout.publicId)).resolves.toMatchObject({ status: "posted" });
        const barrier = evidenceBarrier();
        let preparing: Promise<unknown> | undefined;
        try {
            preparing = prepareDisbursementEvidence(context(seeded.actor, "prepare-after-post"), draftPayout.publicId, evidenceInput, barrier.gateway);
            await expect(preparing).rejects.toMatchObject({ code: "DISBURSEMENT_LOCKED", status: 409 });
        } finally {
            barrier.release();
            if (preparing) await Promise.allSettled([preparing]);
        }
        expect(await db.query.loanDisbursementEvents.findFirst({ where: eq(loanDisbursementEvents.publicId, draftPayout.publicId) })).toMatchObject({ status: "posted", postIdempotencyKey: "post-before-prepare" });
    });

    integrationTest("isolates unrelated borrower and loan evidence from activation and payout posting", async () => {
        const seeded = await seedDraft();
        const unrelatedBorrower = await db.insert(borrowers).values({ tenantId: seeded.actor.tenantId, ownerUserId: seeded.actor.id, name: "Unrelated evidence borrower" }).returning().then((rows) => rows[0]!);
        const unrelatedDraft = await createLoanDraft(context(seeded.actor, "unrelated-draft"), {
            borrowerPublicId: unrelatedBorrower.publicId,
            principal: "800.00",
            interestRate: "12.00",
            repaymentType: "monthly",
            termMonths: 3,
            totalInstallments: 3,
            startDate: "2026-09-14",
        });
        await activateLoan(context(seeded.actor, "unrelated-activation"), unrelatedDraft.publicId);
        const unrelatedLoan = await db.query.loans.findFirst({ where: eq(loans.publicId, unrelatedDraft.publicId) });
        if (!unrelatedLoan) throw new Error("Unrelated loan fixture was not persisted");
        await createDisbursementDraft(context(seeded.actor, "unrelated-pending-requirement"), unrelatedDraft.publicId, {
            grossAmount: "1.00",
            loanAttributedAmount: "1.00",
            channel: "bank_transfer",
            disbursedAt: "2026-09-14T05:00:00.000Z",
            attachmentRequirement: { expectedCount: 1 },
        });

        await expect(activateLoan(context(seeded.actor, "isolated-target-activation"), seeded.draft.publicId)).resolves.toMatchObject({ status: "active" });
        const targetPayout = await payout(seeded.actor, seeded.draft.publicId, "isolated-target-payout");
        await expect(postDisbursement(context(seeded.actor, "isolated-target-post"), targetPayout.publicId)).resolves.toMatchObject({ status: "posted", duplicate: false });
        expect(await db.query.loanDisbursementEvents.findFirst({ where: eq(loanDisbursementEvents.publicId, targetPayout.publicId) })).toMatchObject({ status: "posted" });
        expect((await db.select().from(loanDisbursementEvents).where(eq(loanDisbursementEvents.loanId, unrelatedLoan.id))).every((row) => row.status === "draft")).toBe(true);
    });

    integrationTest("replays successful activation before a later related pending payout without effects", async () => {
        const seeded = await seedDraft();
        const first = await activateLoan(context(seeded.actor, "activation-replay"), seeded.draft.publicId);
        await createDisbursementDraft(context(seeded.actor, "historical-pending-payout"), seeded.draft.publicId, {
            grossAmount: "1.00",
            loanAttributedAmount: "1.00",
            channel: "bank_transfer",
            disbursedAt: "2026-09-14T05:00:00.000Z",
            attachmentRequirement: { expectedCount: 1 },
        });
        const before = {
            loans: await db.select().from(loans).where(eq(loans.tenantId, seeded.actor.tenantId)),
            schedules: await db.select().from(loanSchedules).where(eq(loanSchedules.tenantId, seeded.actor.tenantId)),
            audits: await db.select().from(auditLogs).where(eq(auditLogs.tenantId, seeded.actor.tenantId)),
        };
        const replay = await activateLoan(context(seeded.actor, "activation-replay"), seeded.draft.publicId);
        expect(replay).toEqual(first);
        expect(await db.select().from(loans).where(eq(loans.tenantId, seeded.actor.tenantId))).toEqual(before.loans);
        expect(await db.select().from(loanSchedules).where(eq(loanSchedules.tenantId, seeded.actor.tenantId))).toEqual(before.schedules);
        expect(await db.select().from(auditLogs).where(eq(auditLogs.tenantId, seeded.actor.tenantId))).toEqual(before.audits);
    });

    integrationTest("replays successful payout before a later related pending payout without effects", async () => {
        const seeded = await seedDraft();
        await activateLoan(context(seeded.actor, "activation-for-payout-replay"), seeded.draft.publicId);
        const posted = await payout(seeded.actor, seeded.draft.publicId, "posted-payout-replay");
        const first = await postDisbursement(context(seeded.actor, "payout-replay"), posted.publicId);
        const postedEvent = await db.query.loanDisbursementEvents.findFirst({ where: eq(loanDisbursementEvents.publicId, posted.publicId) });
        if (!postedEvent) throw new Error("Posted payout replay fixture was not persisted");
        const file = await db.insert(files).values({ tenantId: seeded.actor.tenantId, ownerUserId: seeded.actor.id, bucket: "historical-test", key: `payout-replay-${crypto.randomUUID()}`, originalName: "historical-pending.png", mimeType: "image/png", size: 12 }).returning().then((rows) => rows[0]!);
        await db.insert(loanDisbursementEvidenceIntents).values({ tenantId: seeded.actor.tenantId, loanDisbursementEventId: postedEvent.id, fileId: file.id, status: "pending", evidenceHash: "b".repeat(64), mimeType: "image/png", declaredSize: 12, createdByUserId: seeded.actor.id, updatedByUserId: seeded.actor.id });
        const before = {
            events: await db.select().from(loanDisbursementEvents).where(eq(loanDisbursementEvents.tenantId, seeded.actor.tenantId)),
            loans: await db.select().from(loans).where(eq(loans.tenantId, seeded.actor.tenantId)),
            audits: await db.select().from(auditLogs).where(eq(auditLogs.tenantId, seeded.actor.tenantId)),
        };
        const replay = await postDisbursement(context(seeded.actor, "payout-replay"), posted.publicId);
        expect(replay).toMatchObject({ publicId: first.publicId, status: "posted", duplicate: true });
        expect(await db.select().from(loanDisbursementEvents).where(eq(loanDisbursementEvents.tenantId, seeded.actor.tenantId))).toEqual(before.events);
        expect(await db.select().from(loans).where(eq(loans.tenantId, seeded.actor.tenantId))).toEqual(before.loans);
        expect(await db.select().from(auditLogs).where(eq(auditLogs.tenantId, seeded.actor.tenantId))).toEqual(before.audits);
    });

    integrationTest("replays a posted payment before its historical pending evidence guard without effects", async () => {
        const seeded = await seedDraft();
        await activateLoan(context(seeded.actor, "activation-for-payment-replay"), seeded.draft.publicId);
        const targetLoan = await db.query.loans.findFirst({ where: eq(loans.publicId, seeded.draft.publicId) });
        if (!targetLoan) throw new Error("Payment replay loan fixture was not persisted");
        const schedule = await db.query.loanSchedules.findFirst({ where: eq(loanSchedules.loanId, targetLoan.id) });
        if (!schedule) throw new Error("Payment replay fixture schedule was not persisted");
        const intake = await createPaymentIntake(context(seeded.actor, "payment-replay-intake"), {
            amount: "1.00",
            receivedAt: "2026-09-14T06:00:00.000Z",
            payerName: seeded.borrower.name,
        });
        const proposal = await previewPaymentMatch(context(seeded.actor, "payment-replay-preview"), intake.publicId, {
            allocations: [{ borrowerPublicId: seeded.borrower.publicId, loanPublicId: seeded.draft.publicId, schedulePublicId: schedule.publicId, amount: "1.00" }],
        });
        const first = await postPayment(context(seeded.actor, "payment-replay"), intake.publicId, { proposalPublicId: proposal.publicId });
        const file = await db.insert(files).values({ tenantId: seeded.actor.tenantId, ownerUserId: seeded.actor.id, bucket: "historical-test", key: `payment-replay-${crypto.randomUUID()}`, originalName: "historical-pending.png", mimeType: "image/png", size: 12 }).returning().then((rows) => rows[0]!);
        const intakeRow = await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.publicId, intake.publicId) });
        if (!intakeRow) throw new Error("Payment replay intake fixture was not persisted");
        await db.insert(paymentEvidence).values({ tenantId: seeded.actor.tenantId, paymentIntakeId: intakeRow.id, fileId: file.id, status: "pending", evidenceType: "slip", evidenceHash: "b".repeat(64), mimeType: "image/png", declaredSize: 12, createdByUserId: seeded.actor.id, updatedByUserId: seeded.actor.id });
        const before = {
            intakes: await db.select().from(paymentIntakes).where(eq(paymentIntakes.tenantId, seeded.actor.tenantId)),
            transactions: await db.select().from(transactions).where(eq(transactions.tenantId, seeded.actor.tenantId)),
            proposals: await db.select().from(paymentMatchProposals).where(eq(paymentMatchProposals.tenantId, seeded.actor.tenantId)),
            audits: await db.select().from(auditLogs).where(eq(auditLogs.tenantId, seeded.actor.tenantId)),
        };
        const replay = await postPayment(context(seeded.actor, "payment-replay"), intake.publicId, { proposalPublicId: proposal.publicId });
        expect(replay).toMatchObject({ publicId: first.publicId, status: "posted" });
        expect(await db.select().from(paymentIntakes).where(eq(paymentIntakes.tenantId, seeded.actor.tenantId))).toEqual(before.intakes);
        expect(await db.select().from(transactions).where(eq(transactions.tenantId, seeded.actor.tenantId))).toEqual(before.transactions);
        expect(await db.select().from(paymentMatchProposals).where(eq(paymentMatchProposals.tenantId, seeded.actor.tenantId))).toEqual(before.proposals);
        expect(await db.select().from(auditLogs).where(eq(auditLogs.tenantId, seeded.actor.tenantId))).toEqual(before.audits);
    });
});
