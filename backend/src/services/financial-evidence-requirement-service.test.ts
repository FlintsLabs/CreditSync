import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { financialEvidenceRequirements, paymentEvidence, paymentIntakes, users } from "../db/schema";
import type { CommandContext } from "./command-context";
import { createPaymentIntake } from "./payment-service";
import { assertFinancialEvidenceReady, registerFinancialEvidenceRequirement } from "./financial-evidence-requirement-service";

const integrationTest = process.env.TEST_DATABASE_URL ? test : test.skip;

async function reset() {
    await db.execute(sql`TRUNCATE TABLE financial_evidence_requirements, payment_evidence, payment_intakes, users RESTART IDENTITY CASCADE`);
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
        await db.insert(paymentEvidence).values([
            { tenantId: user.tenantId, paymentIntakeId: intakeRow!.id, evidenceType: "slip", status: "ready", finalizedAt: new Date(), createdByUserId: user.id, updatedByUserId: user.id },
            { tenantId: user.tenantId, paymentIntakeId: intakeRow!.id, evidenceType: "slip", status: "pending", createdByUserId: user.id, updatedByUserId: user.id },
        ]);

        await expect(db.transaction((tx) => assertFinancialEvidenceReady(tx, ctx, { kind: "payment_intake", publicId: intake.publicId })))
            .rejects.toMatchObject({ code: "EVIDENCE_REQUIRED_NOT_READY" });
        await db.update(paymentEvidence).set({ status: "ready", finalizedAt: new Date() })
            .where(and(eq(paymentEvidence.paymentIntakeId, intakeRow!.id), eq(paymentEvidence.status, "pending")));
        await expect(db.transaction((tx) => assertFinancialEvidenceReady(tx, ctx, { kind: "payment_intake", publicId: intake.publicId })))
            .resolves.toMatchObject({ allowed: true, code: "READY" });
    });

    integrationTest("does not authorize a requirement through another tenant", async () => {
        const owner = await actor("tenant-a");
        const other = await actor("tenant-b");
        const intake = await createPaymentIntake(context(owner), { amount: "10.00", receivedAt: "2026-09-14T03:00:00.000Z" });

        await expect(db.transaction((tx) => assertFinancialEvidenceReady(tx, context(other), { kind: "payment_intake", publicId: intake.publicId })))
            .rejects.toMatchObject({ code: "PAYMENT_INTAKE_NOT_FOUND", status: 404 });
    });
});
