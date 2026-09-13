import { afterEach, beforeEach, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { db } from "../db";
import { borrowers, files, financialEvidenceRequirementAttempts, financialEvidenceRequirements, loanDisbursementEvidence, loanDisbursementEvidenceIntents, loanDisbursementEvents, loans, paymentEvidence, paymentIntakes, users } from "../db/schema";
import type { CommandContext } from "../services/command-context";
import { createDisbursementDraft } from "../services/loan-disbursement-service";
import { createPaymentIntake } from "../services/payment-service";
import { resolveWorkflowFromBackend } from "./workflow-resolver-service";

const integrationTest = process.env.TEST_DATABASE_URL ? test : test.skip;

function context(user: { id: number; tenantId: string }): CommandContext {
    return { tenantId: user.tenantId, actorUserId: user.id, actorSource: "mcp", requestId: crypto.randomUUID(), correlationId: crypto.randomUUID() };
}

if (process.env.TEST_DATABASE_URL) {
    beforeEach(() => db.execute(sql`TRUNCATE TABLE users RESTART IDENTITY CASCADE`));
    afterEach(() => db.execute(sql`TRUNCATE TABLE users RESTART IDENTITY CASCADE`));
}

integrationTest("uses exact finalized payment file association and tenant authorization", async () => {
    const owner = await db.insert(users).values({ tenantId: "resolver-a", email: `${crypto.randomUUID()}@example.test`, role: "owner" }).returning().then((rows) => rows[0]!);
    const otherTenant = await db.insert(users).values({ tenantId: "resolver-b", email: `${crypto.randomUUID()}@example.test`, role: "owner" }).returning().then((rows) => rows[0]!);
    const intake = await createPaymentIntake(context(owner), { amount: "10.00", receivedAt: "2026-09-14T07:00:00.000Z", attachmentRequirement: { expectedCount: 1 } });
    const intakeRow = await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.publicId, intake.publicId) });
    const file = await db.insert(files).values({ tenantId: owner.tenantId, ownerUserId: owner.id, bucket: "test", key: `resolver-${crypto.randomUUID()}`, originalName: "slip.png", mimeType: "image/png", size: 12, url: "storage:resolver" }).returning().then((rows) => rows[0]!);
    await db.insert(paymentEvidence).values({ tenantId: owner.tenantId, paymentIntakeId: intakeRow!.id, fileId: file.id, status: "ready", finalizedAt: new Date(), evidenceHash: "a".repeat(64), mimeType: "image/png", declaredSize: 12, createdByUserId: owner.id, updatedByUserId: owner.id });

    const input = { intent: "receive_payment" as const, target: { kind: "payment_intake" as const, publicId: intake.publicId }, attachments: "none" as const };
    const ready = await resolveWorkflowFromBackend(context(owner), input, "payments", "resolver-catalog", "resolver-workflow");
    expect(ready.observed).toMatchObject({ state: "mutable", evidenceReady: true });
    expect(ready.status).toBe("next_step");

    const foreign = await resolveWorkflowFromBackend(context(otherTenant), input, "payments", "resolver-catalog", "resolver-workflow");
    expect(foreign.observed.evidenceReady).toBe(false);
    expect(foreign.status).toBe("needs_input");
});

integrationTest.each([
    ["status-only", { fileId: null, finalizedAt: new Date() }],
    ["missing-finalization", { fileId: 1, finalizedAt: null }],
])("does not treat payment evidence as ready when %s", async (_name, values) => {
    const owner = await db.insert(users).values({ tenantId: "resolver-a", email: `${crypto.randomUUID()}@example.test`, role: "owner" }).returning().then((rows) => rows[0]!);
    const intake = await createPaymentIntake(context(owner), { amount: "10.00", receivedAt: "2026-09-14T07:10:00.000Z", attachmentRequirement: { expectedCount: 1 } });
    const intakeRow = await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.publicId, intake.publicId) });
    const file = values.fileId === 1 ? await db.insert(files).values({ tenantId: owner.tenantId, ownerUserId: owner.id, bucket: "test", key: `resolver-${crypto.randomUUID()}`, originalName: "slip.png", mimeType: "image/png", size: 12, url: "storage:resolver" }).returning().then((rows) => rows[0]!) : null;
    await db.insert(paymentEvidence).values({ tenantId: owner.tenantId, paymentIntakeId: intakeRow!.id, fileId: file?.id ?? null, status: "ready", finalizedAt: values.finalizedAt, evidenceHash: createHash("sha256").update(_name).digest("hex"), mimeType: "image/png", declaredSize: 12, createdByUserId: owner.id, updatedByUserId: owner.id });
    const resolved = await resolveWorkflowFromBackend(context(owner), { intent: "receive_payment", target: { kind: "payment_intake", publicId: intake.publicId }, attachments: "none" }, "payments", "resolver-catalog", "resolver-workflow");
    expect(resolved.observed.evidenceReady).toBe(false);
    expect(resolved.status).toBe("blocked");
});

integrationTest("requires the finalized payout intent and exact disbursement association", async () => {
    const owner = await db.insert(users).values({ tenantId: "resolver-a", email: `${crypto.randomUUID()}@example.test`, role: "owner" }).returning().then((rows) => rows[0]!);
    const borrower = await db.insert(borrowers).values({ tenantId: owner.tenantId, ownerUserId: owner.id, name: "Resolver borrower" }).returning().then((rows) => rows[0]!);
    const loan = await db.insert(loans).values({ tenantId: owner.tenantId, ownerUserId: owner.id, borrowerId: borrower.id, principalAmount: "100.00", interestRate: "0.00", repaymentType: "monthly", outstandingPrincipal: "100.00", outstandingInterest: "0.00", outstandingFees: "0.00", status: "draft" }).returning().then((rows) => rows[0]!);
    const draft = await createDisbursementDraft(context(owner), loan.publicId, { grossAmount: "100.00", loanAttributedAmount: "100.00", channel: "bank_transfer", disbursedAt: "2026-09-14T07:20:00.000Z" });
    const event = await db.query.loanDisbursementEvents.findFirst({ where: eq(loanDisbursementEvents.publicId, draft.publicId) });
    await db.insert(financialEvidenceRequirements).values({ tenantId: owner.tenantId, loanDisbursementEventId: event!.id, expectedCount: 1, createdByUserId: owner.id, source: "resolver-test", requestId: "resolver-request", correlationId: "resolver-correlation" });
    const file = await db.insert(files).values({ tenantId: owner.tenantId, ownerUserId: owner.id, bucket: "test", key: `resolver-${crypto.randomUUID()}`, originalName: "payout.png", mimeType: "image/png", size: 12, url: "storage:resolver" }).returning().then((rows) => rows[0]!);
    const intent = await db.insert(loanDisbursementEvidenceIntents).values({ tenantId: owner.tenantId, loanDisbursementEventId: event!.id, fileId: file.id, status: "ready", evidenceHash: "c".repeat(64), mimeType: "image/png", declaredSize: 12, finalizedAt: new Date(), createdByUserId: owner.id, updatedByUserId: owner.id }).returning().then((rows) => rows[0]!);
    await db.insert(loanDisbursementEvidence).values({ tenantId: owner.tenantId, loanDisbursementEventId: event!.id, fileId: file.id });
    expect(intent.status).toBe("ready");
    const resolved = await resolveWorkflowFromBackend(context(owner), { intent: "disburse_loan", target: { kind: "loan_disbursement", publicId: draft.publicId }, attachments: "none" }, "disbursements", "resolver-catalog", "resolver-workflow");
    expect(resolved.observed).toMatchObject({ state: "mutable", evidenceReady: true, loanType: "scheduled" });
});

integrationTest("authorizes borrower targets for inspect and origination without exposing foreign or restricted borrowers", async () => {
    const owner = await db.insert(users).values({ tenantId: "resolver-a", email: `${crypto.randomUUID()}@example.test`, role: "owner" }).returning().then((rows) => rows[0]!);
    const restricted = await db.insert(users).values({ tenantId: owner.tenantId, email: `${crypto.randomUUID()}@example.test`, role: "viewer" }).returning().then((rows) => rows[0]!);
    const foreign = await db.insert(users).values({ tenantId: "resolver-b", email: `${crypto.randomUUID()}@example.test`, role: "owner" }).returning().then((rows) => rows[0]!);
    const borrower = await db.insert(borrowers).values({ tenantId: owner.tenantId, ownerUserId: owner.id, name: "Resolver borrower" }).returning().then((rows) => rows[0]!);
    const foreignBorrower = await db.insert(borrowers).values({ tenantId: foreign.tenantId, ownerUserId: foreign.id, name: "Foreign borrower" }).returning().then((rows) => rows[0]!);

    const inspect = await resolveWorkflowFromBackend(context(owner), { intent: "inspect", target: { kind: "borrower", publicId: borrower.publicId }, attachments: "none" }, "full", "resolver-catalog", "resolver-workflow");
    expect(inspect).toMatchObject({ status: "next_step", observed: { state: "mutable" }, nextSteps: [{ toolName: "borrower.resolve-and-portfolio", arguments: { borrowerPublicId: borrower.publicId } }] });
    const originate = await resolveWorkflowFromBackend(context(owner), { intent: "originate_loan", target: { kind: "borrower", publicId: borrower.publicId }, attachments: "none" }, "loans", "resolver-catalog", "resolver-workflow");
    expect(originate.status).toBe("next_step");
    expect(originate.nextSteps[1]?.arguments).toEqual({ borrowerPublicId: borrower.publicId });

    const restrictedResult = await resolveWorkflowFromBackend(context(restricted), { intent: "inspect", target: { kind: "borrower", publicId: borrower.publicId }, attachments: "none" }, "full", "resolver-catalog", "resolver-workflow");
    expect(restrictedResult.status).toBe("needs_input");
    expect(restrictedResult.nextSteps).toHaveLength(0);
    const foreignResult = await resolveWorkflowFromBackend(context(owner), { intent: "inspect", target: { kind: "borrower", publicId: foreignBorrower.publicId }, attachments: "none" }, "full", "resolver-catalog", "resolver-workflow");
    expect(foreignResult.status).toBe("needs_input");
    expect(foreignResult.observed.state).toBeNull();
});

integrationTest("fails closed when payment evidence exceeds the bounded resolver summary", async () => {
    const owner = await db.insert(users).values({ tenantId: "resolver-a", email: `${crypto.randomUUID()}@example.test`, role: "owner" }).returning().then((rows) => rows[0]!);
    const intake = await createPaymentIntake(context(owner), { amount: "10.00", receivedAt: "2026-09-14T07:30:00.000Z", attachmentRequirement: { expectedCount: 1 } });
    const intakeRow = await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.publicId, intake.publicId) });
    await db.insert(paymentEvidence).values(Array.from({ length: 21 }, (_, index) => ({
        tenantId: owner.tenantId, paymentIntakeId: intakeRow!.id, status: "pending", evidenceHash: `${String(index).padStart(2, "0")}${"a".repeat(62)}`,
        mimeType: "image/png", declaredSize: 12, createdByUserId: owner.id, updatedByUserId: owner.id,
    })));
    const requirement = await db.query.financialEvidenceRequirements.findFirst({ where: and(eq(financialEvidenceRequirements.tenantId, owner.tenantId), eq(financialEvidenceRequirements.paymentIntakeId, intakeRow!.id)) });
    await db.insert(financialEvidenceRequirementAttempts).values(Array.from({ length: 21 }, (_, index) => ({
        tenantId: owner.tenantId, financialEvidenceRequirementId: requirement!.id, attemptKey: `overflow-attempt-${index}`,
        source: "resolver-test", requestId: `resolver-request-${index}`, correlationId: `resolver-correlation-${index}`, createdByUserId: owner.id,
    })));
    const resolved = await resolveWorkflowFromBackend(context(owner), { intent: "receive_payment", target: { kind: "payment_intake", publicId: intake.publicId }, attachments: "none" }, "payments", "resolver-catalog", "resolver-workflow");
    expect(resolved.observed.evidenceReady).toBe(false);
    expect(resolved.status).toBe("blocked");
    expect(resolved.blockers).toContain("EVIDENCE_SUMMARY_OVERFLOW_REQUIRES_REVIEW");
});

integrationTest("fails closed when a payout has more than twenty exact-target evidence intents", async () => {
    const owner = await db.insert(users).values({ tenantId: "resolver-a", email: `${crypto.randomUUID()}@example.test`, role: "owner" }).returning().then((rows) => rows[0]!);
    const borrower = await db.insert(borrowers).values({ tenantId: owner.tenantId, ownerUserId: owner.id, name: "Resolver borrower" }).returning().then((rows) => rows[0]!);
    const loan = await db.insert(loans).values({ tenantId: owner.tenantId, ownerUserId: owner.id, borrowerId: borrower.id, principalAmount: "100.00", interestRate: "0.00", repaymentType: "monthly", outstandingPrincipal: "100.00", outstandingInterest: "0.00", outstandingFees: "0.00", status: "draft" }).returning().then((rows) => rows[0]!);
    const draft = await createDisbursementDraft(context(owner), loan.publicId, { grossAmount: "100.00", loanAttributedAmount: "100.00", channel: "bank_transfer", disbursedAt: "2026-09-14T07:40:00.000Z" });
    const event = await db.query.loanDisbursementEvents.findFirst({ where: eq(loanDisbursementEvents.publicId, draft.publicId) });
    for (let index = 0; index < 21; index += 1) {
        const file = await db.insert(files).values({ tenantId: owner.tenantId, ownerUserId: owner.id, bucket: "test", key: `resolver-overflow-${crypto.randomUUID()}`, originalName: "payout.png", mimeType: "image/png", size: 12, url: "storage:resolver" }).returning().then((rows) => rows[0]!);
        await db.insert(loanDisbursementEvidenceIntents).values({ tenantId: owner.tenantId, loanDisbursementEventId: event!.id, fileId: file.id, status: "pending", evidenceHash: `${String(index).padStart(2, "0")}${"b".repeat(62)}`, mimeType: "image/png", declaredSize: 12, createdByUserId: owner.id, updatedByUserId: owner.id });
    }
    const resolved = await resolveWorkflowFromBackend(context(owner), { intent: "disburse_loan", target: { kind: "loan_disbursement", publicId: draft.publicId }, attachments: "none" }, "disbursements", "resolver-catalog", "resolver-workflow");
    expect(resolved.observed.evidenceReady).toBe(false);
    expect(resolved.status).toBe("blocked");
    expect(resolved.blockers).toContain("EVIDENCE_SUMMARY_OVERFLOW_REQUIRES_REVIEW");
});

integrationTest("does not advertise a ready loan observation when more than twenty payout targets are present", async () => {
    const owner = await db.insert(users).values({ tenantId: "resolver-a", email: `${crypto.randomUUID()}@example.test`, role: "owner" }).returning().then((rows) => rows[0]!);
    const borrower = await db.insert(borrowers).values({ tenantId: owner.tenantId, ownerUserId: owner.id, name: "Resolver borrower" }).returning().then((rows) => rows[0]!);
    const loan = await db.insert(loans).values({ tenantId: owner.tenantId, ownerUserId: owner.id, borrowerId: borrower.id, principalAmount: "100.00", interestRate: "0.00", repaymentType: "monthly", outstandingPrincipal: "100.00", outstandingInterest: "0.00", outstandingFees: "0.00", status: "draft" }).returning().then((rows) => rows[0]!);
    await db.insert(loanDisbursementEvents).values(Array.from({ length: 21 }, () => ({
        tenantId: owner.tenantId, loanId: loan.id, grossAmount: "1.00", loanAttributedAmount: "1.00", channel: "cash", status: "draft", createdByUserId: owner.id,
    })));
    const resolved = await resolveWorkflowFromBackend(context(owner), { intent: "disburse_loan", target: { kind: "loan", publicId: loan.publicId }, attachments: "none" }, "disbursements", "resolver-catalog", "resolver-workflow");
    expect(resolved.observed.evidenceReady).toBe(false);
    expect(resolved.status).toBe("blocked");
    expect(resolved.blockers).toContain("EVIDENCE_SUMMARY_OVERFLOW_REQUIRES_REVIEW");
});
