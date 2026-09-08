import { expect, test } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";

const backendRoot = `${import.meta.dir}/../../`;
const migrationTag = "0061_chatgpt_payment_evidence";

test("registers additive evidence-required and supplemental-evidence persistence", async () => {
    const [journal, migration] = await Promise.all([
        Bun.file(`${backendRoot}drizzle/meta/_journal.json`).json(),
        Bun.file(`${backendRoot}drizzle/${migrationTag}.sql`).text(),
    ]);

    expect(journal.entries.at(-1)).toMatchObject({ idx: 61, tag: migrationTag });
    expect(migration).toContain('ALTER TABLE "payment_intakes" ADD COLUMN "evidence_required" boolean DEFAULT false NOT NULL');
    expect(migration).toContain('CREATE TABLE "payment_evidence_supplements"');
    expect(migration).toContain("payment_evidence_supplements_status_check");
    expect(migration).toContain("payment_evidence_supplements_reason_check");
    expect(migration).toContain("payment_evidence_supplements_other_note_check");
    expect(migration).toContain("payment_evidence_supplements_tenant_idempotency_unique");
    expect(migration).toContain('BEFORE UPDATE OR DELETE ON "payment_evidence_supplements"');
    expect(migration).not.toMatch(/\bDROP\s+(?:TABLE|COLUMN)\b/i);
});

test("schema maps the evidence gate and tenant-safe append-only supplement ledger", async () => {
    const { paymentEvidenceSupplements, paymentIntakes } = await import("./schema");
    const intake = getTableConfig(paymentIntakes);
    const supplement = getTableConfig(paymentEvidenceSupplements);

    expect(intake.columns.some((column) => column.name === "evidence_required")).toBe(true);
    expect(supplement.columns.map((column) => column.name)).toEqual(expect.arrayContaining([
        "public_id", "tenant_id", "payment_intake_id", "file_id", "status", "evidence_hash",
        "mime_type", "declared_size", "reason", "note", "import_idempotency_key",
        "record_idempotency_key", "audit_public_id", "correlation_id", "created_by_user_id",
        "recorded_by_user_id", "created_at", "recorded_at",
    ]));
    expect(supplement.checks.map((check) => check.name)).toEqual(expect.arrayContaining([
        "payment_evidence_supplements_status_check",
        "payment_evidence_supplements_reason_check",
        "payment_evidence_supplements_other_note_check",
    ]));
    expect(supplement.foreignKeys).toHaveLength(4);
});

const integrationTest = process.env.TEST_DATABASE_URL ? test : test.skip;

integrationTest("recorded supplement cannot update or delete", async () => {
    const postgres = (await import("postgres")).default(process.env.TEST_DATABASE_URL!, { max: 1 });
    const tenantId = `chatgpt-evidence-${crypto.randomUUID()}`;
    try {
        const [user] = await postgres<{ id: number }[]>`INSERT INTO users (tenant_id, email, role) VALUES (${tenantId}, ${`${tenantId}@test.invalid`}, 'owner') RETURNING id`;
        const [intake] = await postgres<{ id: number }[]>`INSERT INTO payment_intakes (tenant_id, owner_user_id, source, status, amount, created_by_user_id, updated_by_user_id) VALUES (${tenantId}, ${user!.id}, 'mcp', 'posted', 100, ${user!.id}, ${user!.id}) RETURNING id`;
        const [file] = await postgres<{ id: number }[]>`INSERT INTO files (tenant_id, owner_user_id, filename, mime_type, size, storage_key, created_by_user_id) VALUES (${tenantId}, ${user!.id}, 'safe-name.png', 'image/png', 4, ${`evidence/${crypto.randomUUID()}`}, ${user!.id}) RETURNING id`;
        const [row] = await postgres<{ id: number }[]>`
            INSERT INTO payment_evidence_supplements (
                tenant_id, payment_intake_id, file_id, status, evidence_hash, mime_type,
                declared_size, reason, import_idempotency_key, record_idempotency_key,
                audit_public_id, correlation_id, created_by_user_id, recorded_by_user_id, recorded_at
            ) VALUES (
                ${tenantId}, ${intake!.id}, ${file!.id}, 'recorded', ${"a".repeat(64)}, 'image/png',
                4, 'upload_channel_unavailable', 'import-key', 'record-key', ${crypto.randomUUID()},
                'safe-correlation', ${user!.id}, ${user!.id}, now()
            ) RETURNING id`;

        await expect(postgres`UPDATE payment_evidence_supplements SET note = 'changed' WHERE id = ${row!.id}`).rejects.toThrow(/immutable/i);
        await expect(postgres`DELETE FROM payment_evidence_supplements WHERE id = ${row!.id}`).rejects.toThrow(/immutable/i);
    } finally {
        await postgres.end({ timeout: 1 });
    }
});

integrationTest("reason other requires a non-blank note while standard reasons do not", async () => {
    const postgres = (await import("postgres")).default(process.env.TEST_DATABASE_URL!, { max: 1 });
    const tenantId = `chatgpt-note-${crypto.randomUUID()}`;
    try {
        const [user] = await postgres<{ id: number }[]>`INSERT INTO users (tenant_id, email, role) VALUES (${tenantId}, ${`${tenantId}@test.invalid`}, 'owner') RETURNING id`;
        const [intake] = await postgres<{ id: number }[]>`INSERT INTO payment_intakes (tenant_id, source, status, amount) VALUES (${tenantId}, 'mcp', 'posted', 100) RETURNING id`;
        const [file] = await postgres<{ id: number }[]>`INSERT INTO files (tenant_id, owner_user_id, filename, mime_type, size, storage_key, created_by_user_id) VALUES (${tenantId}, ${user!.id}, 'safe-name.png', 'image/png', 4, ${`evidence/${crypto.randomUUID()}`}, ${user!.id}) RETURNING id`;
        const insert = (reason: string, note: string | null, key: string) => postgres`
            INSERT INTO payment_evidence_supplements (
                tenant_id, payment_intake_id, file_id, status, evidence_hash, mime_type,
                declared_size, reason, note, import_idempotency_key, created_by_user_id
            ) VALUES (${tenantId}, ${intake!.id}, ${file!.id}, 'ready', ${"b".repeat(64)}, 'image/png', 4, ${reason}, ${note}, ${key}, ${user!.id})`;

        await expect(insert("other", "   ", "other-blank")).rejects.toThrow();
        await expect(insert("upload_channel_unavailable", null, "standard")).resolves.toBeDefined();
    } finally {
        await postgres.end({ timeout: 1 });
    }
});
