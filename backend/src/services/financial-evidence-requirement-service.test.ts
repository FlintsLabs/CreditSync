import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { files, financialEvidenceRequirementAttempts, financialEvidenceRequirements, paymentEvidence, paymentIntakes, users } from "../db/schema";
import type { CommandContext } from "./command-context";
import { createPaymentIntake } from "./payment-service";
import { assertFinancialEvidenceReady, registerFinancialEvidenceRequirement } from "./financial-evidence-requirement-service";

const integrationTest = process.env.TEST_DATABASE_URL ? test : test.skip;

async function reset() {
    await db.execute(sql`TRUNCATE TABLE financial_evidence_requirement_attempts, financial_evidence_requirements, files, payment_evidence, payment_intakes, users RESTART IDENTITY CASCADE`);
}

async function actor(tenantId = "tenant-a") {
    return db.insert(users).values({ tenantId, email: `${crypto.randomUUID()}@example.test`, role: "owner" })
        .returning().then((rows) => rows[0]!);
}

function context(user: { id: number; tenantId: string }): CommandContext {
    return {
        tenantId: user.tenantId,
        actorUserId: user.id,
        actorSource: "web",
        requestId: `req-${crypto.randomUUID()}`,
        correlationId: `corr-${crypto.randomUUID()}`,
    };
}

if (process.env.TEST_DATABASE_URL) {
    beforeEach(reset);
    afterEach(reset);
}

describe("financial evidence requirements", () => {
    integrationTest("sticks before storage work and raises the floor without counting retries", async () => {
        const user = await actor();
        const ctx = context(user);
        const intake = await createPaymentIntake(ctx, { amount: "10.00", receivedAt: "2026-09-14T01:00:00.000Z" });

        await db.transaction(async (tx) => {
            await registerFinancialEvidenceRequirement(tx, ctx, { kind: "payment_intake", publicId: intake.publicId }, 2);
            await registerFinancialEvidenceRequirement(tx, ctx, { kind: "payment_intake", publicId: intake.publicId }, 1);
        });

        const row = await db.query.financialEvidenceRequirements.findFirst({ where: eq(financialEvidenceRequirements.paymentIntakeId, 1) });
        expect(row).toMatchObject({ expectedCount: 2, source: "web", requestId: ctx.requestId, correlationId: ctx.correlationId });
        expect(await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.publicId, intake.publicId) }))
            .toMatchObject({ evidenceRequired: true });
        await expect(db.transaction((tx) => assertFinancialEvidenceReady(tx, ctx, { kind: "payment_intake", publicId: intake.publicId })))
            .rejects.toMatchObject({ code: "EVIDENCE_REQUIRED_NOT_READY" });
    });

    integrationTest("requires every declared attachment and treats ready plus pending as blocked", async () => {
        const user = await actor();
        const ctx = context(user);
        const intake = await createPaymentIntake(ctx, {
            amount: "10.00", receivedAt: "2026-09-14T02:00:00.000Z", attachmentRequirement: { expectedCount: 2 },
        });
        const intakeRow = await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.publicId, intake.publicId) });
        expect(intakeRow).toBeDefined();
        const [readyFile, pendingFile] = await db.insert(files).values([
            { tenantId: user.tenantId, ownerUserId: user.id, bucket: "test", key: `ready-${crypto.randomUUID()}`, originalName: "ready.png", mimeType: "image/png", size: 12, url: "storage:test-ready" },
            { tenantId: user.tenantId, ownerUserId: user.id, bucket: "test", key: `pending-${crypto.randomUUID()}`, originalName: "pending.png", mimeType: "image/png", size: 12, url: "storage:test-pending" },
        ]).returning();
        await db.insert(paymentEvidence).values([
            { tenantId: user.tenantId, paymentIntakeId: intakeRow!.id, fileId: readyFile!.id, evidenceType: "slip", status: "ready", finalizedAt: new Date(), createdByUserId: user.id, updatedByUserId: user.id },
            { tenantId: user.tenantId, paymentIntakeId: intakeRow!.id, fileId: pendingFile!.id, evidenceType: "slip", status: "pending", createdByUserId: user.id, updatedByUserId: user.id },
        ]);

        await expect(db.transaction((tx) => assertFinancialEvidenceReady(tx, ctx, { kind: "payment_intake", publicId: intake.publicId })))
            .rejects.toMatchObject({ code: "EVIDENCE_REQUIRED_NOT_READY" });
        await db.update(paymentEvidence).set({ status: "ready", finalizedAt: new Date() })
            .where(and(eq(paymentEvidence.paymentIntakeId, intakeRow!.id), eq(paymentEvidence.status, "pending")));
        await expect(db.transaction((tx) => assertFinancialEvidenceReady(tx, ctx, { kind: "payment_intake", publicId: intake.publicId })))
            .resolves.toMatchObject({ allowed: true, code: "READY" });
    });

    integrationTest("commits distinct attempt identities before cleanup and does not inflate retries", async () => {
        const user = await actor();
        const ctx = context(user);
        const intake = await createPaymentIntake(ctx, { amount: "10.00", receivedAt: "2026-09-14T04:00:00.000Z" });

        await db.transaction(async (tx) => {
            await registerFinancialEvidenceRequirement(tx, ctx, { kind: "payment_intake", publicId: intake.publicId }, 1, { attemptKey: "sha256:first" });
            await registerFinancialEvidenceRequirement(tx, ctx, { kind: "payment_intake", publicId: intake.publicId }, 1, { attemptKey: "sha256:second" });
            await registerFinancialEvidenceRequirement(tx, ctx, { kind: "payment_intake", publicId: intake.publicId }, 1, { attemptKey: "sha256:second" });
        });

        const requirement = await db.query.financialEvidenceRequirements.findFirst({ where: eq(financialEvidenceRequirements.paymentIntakeId, 1) });
        expect(requirement).toMatchObject({ expectedCount: 2 });
        expect(await db.select().from(financialEvidenceRequirementAttempts).where(eq(financialEvidenceRequirementAttempts.financialEvidenceRequirementId, requirement!.id))).toHaveLength(2);
    });

    integrationTest("does not treat status-ready evidence without an exact file association as ready", async () => {
        const user = await actor();
        const ctx = context(user);
        const intake = await createPaymentIntake(ctx, { amount: "10.00", receivedAt: "2026-09-14T04:30:00.000Z", attachmentRequirement: { expectedCount: 1 } });
        const intakeRow = await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.publicId, intake.publicId) });
        await db.insert(paymentEvidence).values({ tenantId: user.tenantId, paymentIntakeId: intakeRow!.id, status: "ready", finalizedAt: new Date(), createdByUserId: user.id, updatedByUserId: user.id });
        await expect(db.transaction((tx) => assertFinancialEvidenceReady(tx, ctx, { kind: "payment_intake", publicId: intake.publicId })))
            .rejects.toMatchObject({ code: "EVIDENCE_REQUIRED_NOT_READY" });
    });

    integrationTest("does not count a finalized file attached to another target", async () => {
        const user = await actor();
        const ctx = context(user);
        const first = await createPaymentIntake(ctx, { amount: "10.00", receivedAt: "2026-09-14T04:45:00.000Z", attachmentRequirement: { expectedCount: 1 } });
        const second = await createPaymentIntake(ctx, { amount: "10.00", receivedAt: "2026-09-14T04:46:00.000Z" });
        const firstRow = await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.publicId, first.publicId) });
        const secondRow = await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.publicId, second.publicId) });
        const file = await db.insert(files).values({ tenantId: user.tenantId, ownerUserId: user.id, bucket: "test", key: `wrong-target-${crypto.randomUUID()}`, originalName: "slip.png", mimeType: "image/png", size: 12, url: "storage:wrong-target" }).returning().then((rows) => rows[0]!);
        await db.insert(paymentEvidence).values({ tenantId: user.tenantId, paymentIntakeId: secondRow!.id, fileId: file.id, status: "ready", finalizedAt: new Date(), createdByUserId: user.id, updatedByUserId: user.id });
        await expect(db.transaction((tx) => assertFinancialEvidenceReady(tx, ctx, { kind: "payment_intake", publicId: first.publicId })))
            .rejects.toMatchObject({ code: "EVIDENCE_REQUIRED_NOT_READY" });
        expect(firstRow).toBeDefined();
    });

    integrationTest("does not let a restricted actor register a requirement on another payment target", async () => {
        const owner = await actor();
        const restricted = await db.insert(users).values({ tenantId: owner.tenantId, email: `${crypto.randomUUID()}@example.test`, role: "viewer" }).returning().then((rows) => rows[0]!);
        const intake = await createPaymentIntake(context(owner), { amount: "10.00", receivedAt: "2026-09-14T05:00:00.000Z" });
        await expect(db.transaction((tx) => registerFinancialEvidenceRequirement(tx, context(restricted), { kind: "payment_intake", publicId: intake.publicId }, 1)))
            .rejects.toMatchObject({ code: "PAYMENT_INTAKE_NOT_FOUND", status: 404 });
        expect(await db.query.financialEvidenceRequirements.findFirst({ where: eq(financialEvidenceRequirements.paymentIntakeId, 1) })).toBeUndefined();
    });

    integrationTest("does not authorize a requirement through another tenant", async () => {
        const owner = await actor("tenant-a");
        const other = await actor("tenant-b");
        const intake = await createPaymentIntake(context(owner), { amount: "10.00", receivedAt: "2026-09-14T03:00:00.000Z" });

        await expect(db.transaction((tx) => assertFinancialEvidenceReady(tx, context(other), { kind: "payment_intake", publicId: intake.publicId })))
            .rejects.toMatchObject({ code: "PAYMENT_INTAKE_NOT_FOUND", status: 404 });
    });
});
