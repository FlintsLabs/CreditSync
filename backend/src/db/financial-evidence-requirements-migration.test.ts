import { afterEach, beforeEach, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { db } from "../db";
import { financialEvidenceRequirementAttempts, financialEvidenceRequirements, paymentIntakes, users } from "./schema";
import { createPaymentIntake } from "../services/payment-service";
import type { CommandContext } from "../services/command-context";

const root = `${import.meta.dir}/../../`;
const integrationTest = process.env.TEST_DATABASE_URL ? test : test.skip;

function context(user: { id: number; tenantId: string }): CommandContext {
    return { tenantId: user.tenantId, actorUserId: user.id, actorSource: "web", requestId: `migration-req-${crypto.randomUUID()}`, correlationId: `migration-corr-${crypto.randomUUID()}` };
}

if (process.env.TEST_DATABASE_URL) {
    beforeEach(async () => db.execute(sql`TRUNCATE TABLE financial_evidence_requirement_attempts, financial_evidence_requirements, payment_intakes, users RESTART IDENTITY CASCADE`));
    afterEach(async () => db.execute(sql`TRUNCATE TABLE financial_evidence_requirement_attempts, financial_evidence_requirements, payment_intakes, users RESTART IDENTITY CASCADE`));
}

test("defines a tenant-safe typed sticky evidence requirement", async () => {
    const [migration, attemptMigration, journal, schema] = await Promise.all([
        Bun.file(`${root}drizzle/0075_financial_evidence_requirements.sql`).text(),
        Bun.file(`${root}drizzle/0076_financial_evidence_attempt_floor.sql`).text(),
        Bun.file(`${root}drizzle/meta/_journal.json`).json(),
        import("./schema"),
    ]);
    expect(journal.entries.at(-2)).toMatchObject({ idx: 75, tag: "0075_financial_evidence_requirements" });
    expect(journal.entries.at(-1)).toMatchObject({ idx: 76, tag: "0076_financial_evidence_attempt_floor" });
    expect(migration).toContain('CREATE TABLE "financial_evidence_requirements"');
    expect(migration).toContain("financial_evidence_requirements_target_xor_check");
    expect(migration).toContain("financial_evidence_requirements_expected_count_check");
    expect(migration).toContain("financial_evidence_requirements_tenant_payment_fk");
    expect(migration).toContain("financial_evidence_requirements_tenant_disbursement_fk");
    expect(migration).not.toMatch(/UPDATE\s+(?:payment_intakes|loan_disbursement_events)/i);
    expect(attemptMigration).toContain('CREATE TABLE "financial_evidence_requirement_attempts"');
    expect(attemptMigration).toContain("financial_evidence_requirement_attempts_tenant_requirement_fk");
    expect(attemptMigration).toContain("financial_evidence_requirements_append_only_guard");
    expect(attemptMigration).toContain("financial_evidence_requirement_attempts_append_only_guard");

    const table = getTableConfig(schema.financialEvidenceRequirements);
    expect(table.columns.map((column) => column.name)).toEqual(expect.arrayContaining([
        "public_id", "tenant_id", "payment_intake_id", "loan_disbursement_event_id", "expected_count", "source", "request_id", "correlation_id",
    ]));
    expect(table.checks.map((check) => check.name)).toEqual(expect.arrayContaining([
        "financial_evidence_requirements_target_xor_check",
        "financial_evidence_requirements_expected_count_check",
    ]));
    expect(table.foreignKeys).toHaveLength(3);
});

integrationTest("enforces the typed requirement constraints and protects historical parents in disposable PostgreSQL", async () => {
    const owner = await db.insert(users).values({ tenantId: "migration-a", email: `${crypto.randomUUID()}@example.test`, role: "owner" }).returning().then((rows) => rows[0]!);
    const other = await db.insert(users).values({ tenantId: "migration-b", email: `${crypto.randomUUID()}@example.test`, role: "owner" }).returning().then((rows) => rows[0]!);
    const intake = await createPaymentIntake(context(owner), { amount: "10.00", receivedAt: "2026-09-14T06:00:00.000Z" });
    const otherIntake = await createPaymentIntake(context(other), { amount: "10.00", receivedAt: "2026-09-14T06:01:00.000Z" });
    const intakeRow = await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.publicId, intake.publicId) });
    const otherIntakeRow = await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.publicId, otherIntake.publicId) });
    const base = { tenantId: owner.tenantId, paymentIntakeId: intakeRow!.id, createdByUserId: owner.id, source: "migration-test", requestId: "migration-request", correlationId: "migration-correlation" };

    await expect(db.insert(financialEvidenceRequirements).values({ ...base, expectedCount: 0 }).execute()).rejects.toBeDefined();
    await expect(db.insert(financialEvidenceRequirements).values({ ...base, expectedCount: 21 }).execute()).rejects.toBeDefined();
    await expect(db.insert(financialEvidenceRequirements).values({ ...base, paymentIntakeId: null, expectedCount: 1 }).execute()).rejects.toBeDefined();
    await expect(db.insert(financialEvidenceRequirements).values({ ...base, tenantId: owner.tenantId, paymentIntakeId: otherIntakeRow!.id, expectedCount: 1 }).execute()).rejects.toBeDefined();
    await expect(db.insert(financialEvidenceRequirements).values({ ...base, createdByUserId: other.id, expectedCount: 1 }).execute()).rejects.toBeDefined();

    const inserted = await db.insert(financialEvidenceRequirements).values({ ...base, expectedCount: 1 }).returning().then((rows) => rows[0]!);
    await expect(db.insert(financialEvidenceRequirements).values({ ...base, expectedCount: 1 }).execute()).rejects.toBeDefined();
    await db.update(paymentIntakes).set({ status: "posted" }).where(eq(paymentIntakes.id, intakeRow!.id));
    await expect(db.insert(financialEvidenceRequirements).values({ tenantId: owner.tenantId, paymentIntakeId: intakeRow!.id, expectedCount: 1, createdByUserId: owner.id, source: "posted-test", requestId: "posted-request", correlationId: "posted-correlation" }).execute()).rejects.toBeDefined();
    await expect(db.insert(financialEvidenceRequirementAttempts).values({ tenantId: owner.tenantId, financialEvidenceRequirementId: inserted.id, attemptKey: "sha256:late", createdByUserId: owner.id, source: "posted-attempt-test", requestId: "posted-attempt-request", correlationId: "posted-attempt-correlation" }).execute()).rejects.toBeDefined();
    expect(await db.query.financialEvidenceRequirements.findFirst({ where: eq(financialEvidenceRequirements.id, inserted.id) })).toMatchObject({ expectedCount: 1 });
    expect(await db.select().from(financialEvidenceRequirementAttempts).where(and(eq(financialEvidenceRequirementAttempts.tenantId, owner.tenantId), eq(financialEvidenceRequirementAttempts.financialEvidenceRequirementId, inserted.id)))).toHaveLength(0);
});
