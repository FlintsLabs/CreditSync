import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import { db } from "../db";
import { paymentBatches, paymentBatchItems, paymentBatchStagingItems, paymentIntakes, users } from "./schema";

const root = new URL("../../", import.meta.url).pathname;
const integrationTest = process.env.TEST_DATABASE_URL ? test : test.skip;

async function applySqlFile(sql: ReturnType<typeof postgres>, path: string) {
    const content = await Bun.file(path).text();
    for (const statement of content.split("--> statement-breakpoint")) {
        if (statement.trim()) await sql.unsafe(statement);
    }
}

async function makeMigrationFixture(prefix: string, maximumIndex?: number) {
    const fixture = await mkdtemp(`${prefix}-`);
    await mkdir(`${fixture}/meta`);
    const journal = await Bun.file(`${root}drizzle/meta/_journal.json`).json() as { entries: Array<{ idx: number; tag: string }> };
    const entries = journal.entries.filter((entry) => maximumIndex === undefined || entry.idx <= maximumIndex);
    for (const entry of entries) await cp(`${root}drizzle/${entry.tag}.sql`, `${fixture}/${entry.tag}.sql`);
    await writeFile(`${fixture}/meta/_journal.json`, JSON.stringify({ ...journal, entries }));
    return fixture;
}

describe("atomic payment batch migration", () => {
    test("registers durable capture staging and operation receipts", async () => {
        const migration = await readFile(resolve(root, "drizzle/0065_batch_chronology_safety.sql"), "utf8");
        expect(migration).toContain('CREATE TABLE "payment_batch_staging_items"');
        expect(migration).toContain('client_item_key');
        expect(migration).toContain('operation_request_hash');
        expect(migration).toContain('reviewed_range_from');
    });

    integrationTest("enforces staging tenant ownership and uniqueness in the real database", async () => {
        const tenantId = `migration-staging-${crypto.randomUUID()}`;
        const actor = await db.insert(users).values({ tenantId, email: `${crypto.randomUUID()}@example.test`, role: "owner" }).returning().then((rows) => rows[0]!);
        const batch = await db.insert(paymentBatches).values({ tenantId, status: "needs_review", version: 0, stateHash: "v1:empty", createIdempotencyKey: crypto.randomUUID(), createdByUserId: actor.id, updatedByUserId: actor.id }).returning().then((rows) => rows[0]!);
        const staged = await db.insert(paymentBatchStagingItems).values({ tenantId, batchId: batch.id, clientItemKey: "same-slip", payloadFingerprint: "fingerprint", status: "staged", createdByUserId: actor.id, updatedByUserId: actor.id }).returning().then((rows) => rows[0]!);
        expect(staged.amount).toBeNull();
        expect(staged.receivedAt).toBeNull();
        let duplicateRejected = false;
        try { await db.insert(paymentBatchStagingItems).values({ tenantId, batchId: batch.id, clientItemKey: "same-slip", payloadFingerprint: "different", status: "staged", createdByUserId: actor.id, updatedByUserId: actor.id }); } catch { duplicateRejected = true; }
        expect(duplicateRejected).toBe(true);
        let crossTenantRejected = false;
        try { await db.insert(paymentBatchStagingItems).values({ tenantId: `${tenantId}-other`, batchId: batch.id, clientItemKey: "cross-tenant", payloadFingerprint: "fingerprint", status: "staged" }); } catch { crossTenantRejected = true; }
        expect(crossTenantRejected).toBe(true);
        expect(await db.query.paymentBatchStagingItems.findFirst({ where: eq(paymentBatchStagingItems.id, staged.id) })).toMatchObject({ status: "staged", amount: null, receivedAt: null });
    });
    integrationTest("rejects inserting or moving batch members under a posted parent", async () => {
        const tenantId = `migration-posted-parent-${crypto.randomUUID()}`;
        const actor = await db.insert(users).values({ tenantId, email: `${crypto.randomUUID()}@example.test`, role: "owner" }).returning().then((rows) => rows[0]!);
        const pending = await db.insert(paymentBatches).values({ tenantId, status: "needs_review", version: 0, stateHash: "v1:pending", createIdempotencyKey: crypto.randomUUID(), createdByUserId: actor.id, updatedByUserId: actor.id }).returning().then((rows) => rows[0]!);
        const posted = await db.insert(paymentBatches).values({ tenantId, status: "posted", version: 1, stateHash: "v1:posted", confirmationHash: "v1:confirmed", createIdempotencyKey: crypto.randomUUID(), executeIdempotencyKey: crypto.randomUUID(), postedAt: new Date(), createdByUserId: actor.id, updatedByUserId: actor.id }).returning().then((rows) => rows[0]!);
        const intake = await db.insert(paymentIntakes).values({ tenantId, ownerUserId: actor.id, source: "web", status: "draft", amount: "1.00", receivedAt: new Date(), idempotencyKey: crypto.randomUUID(), createdByUserId: actor.id, updatedByUserId: actor.id }).returning().then((rows) => rows[0]!);
        let insertRejected = false;
        try { await db.insert(paymentBatchItems).values({ tenantId, batchId: posted.id, paymentIntakeId: intake.id, itemOrder: 1 }); } catch { insertRejected = true; }
        expect(insertRejected).toBe(true);
        const item = await db.insert(paymentBatchItems).values({ tenantId, batchId: pending.id, paymentIntakeId: intake.id, itemOrder: 1 }).returning().then((rows) => rows[0]!);
        let moveRejected = false;
        try { await db.update(paymentBatchItems).set({ batchId: posted.id }).where(eq(paymentBatchItems.id, item.id)); } catch { moveRejected = true; }
        expect(moveRejected).toBe(true);
    });

    integrationTest("upgrades a populated 0067 staging schema without changing posted history", async () => {
        const sql = postgres(process.env.TEST_DATABASE_URL!, { max: 1 });
        const tenantId = `migration-0067-populated-${crypto.randomUUID()}`;
        try {
            const [actor] = await sql<{ id: number }[]>`
                INSERT INTO users (tenant_id, email, role)
                VALUES (${tenantId}, ${crypto.randomUUID()} || '@example.test', 'owner')
                RETURNING id
            `;
            const [borrower] = await sql<{ id: number }[]>`
                INSERT INTO borrowers (tenant_id, owner_user_id, name)
                VALUES (${tenantId}, ${actor!.id}, 'Migration fixture borrower') RETURNING id
            `;
            const [loan] = await sql<{ id: number }[]>`
                INSERT INTO loans (tenant_id, owner_user_id, borrower_id, principal_amount, interest_rate,
                    repayment_type, status, start_date, outstanding_principal, outstanding_interest, outstanding_fees)
                VALUES (${tenantId}, ${actor!.id}, ${borrower!.id}, 1000.00, 0, 'daily', 'active', DATE '2026-08-01', 1000.00, 0.00, 0.00)
                RETURNING id
            `;
            const [schedule] = await sql<{ id: number }[]>`
                INSERT INTO loan_schedules (tenant_id, loan_id, installment_no, due_date, scheduled_total, remaining_due)
                VALUES (${tenantId}, ${loan!.id}, 1, DATE '2026-08-10', 100.00, 100.00) RETURNING id
            `;
            const [batch] = await sql<{ id: number }[]>`
                INSERT INTO payment_batches (tenant_id, borrower_id, status, version, state_hash, confirmation_hash,
                    create_idempotency_key, created_by_user_id, updated_by_user_id)
                VALUES (${tenantId}, ${borrower!.id}, 'needs_review', 2, 'state-posted', 'confirmation-posted',
                    ${crypto.randomUUID()}, ${actor!.id}, ${actor!.id})
                RETURNING id
            `;
            const [intake] = await sql<{ id: number }[]>`
                INSERT INTO payment_intakes (tenant_id, owner_user_id, source, status, amount, received_at,
                    idempotency_key, created_by_user_id, updated_by_user_id)
                VALUES (${tenantId}, ${actor!.id}, 'web', 'posted', 100.00, TIMESTAMPTZ '2026-08-11 03:00:00+00',
                    ${crypto.randomUUID()}, ${actor!.id}, ${actor!.id}) RETURNING id
            `;
            const [stagingMapped] = await sql<{ id: number; public_id: string }[]>`
                INSERT INTO payment_batch_staging_items (tenant_id, batch_id, client_item_key, payload_fingerprint,
                    amount, received_at, status, reviewed_mapping, created_by_user_id, updated_by_user_id)
                VALUES (${tenantId}, ${batch!.id}, 'mapped-posted', 'fp-mapped-posted', 100.00,
                    TIMESTAMPTZ '2026-08-11 03:00:00+00', 'validated',
                    ${sql.json({ borrowerPublicId: crypto.randomUUID(), loanPublicId: crypto.randomUUID() })}, ${actor!.id}, ${actor!.id})
                RETURNING id, public_id
            `;
            const [stagingUnknown] = await sql<{ id: number; public_id: string }[]>`
                INSERT INTO payment_batch_staging_items (tenant_id, batch_id, client_item_key, payload_fingerprint,
                    amount, received_at, status, created_by_user_id, updated_by_user_id)
                VALUES (${tenantId}, ${batch!.id}, 'legacy-unknown', 'fp-legacy-unknown', 25.00,
                    TIMESTAMPTZ '2026-08-11 04:00:00+00', 'staged', ${actor!.id}, ${actor!.id})
                RETURNING id, public_id
            `;
            const [batchItem] = await sql<{ id: number }[]>`
                INSERT INTO payment_batch_items (tenant_id, batch_id, payment_intake_id, staging_item_id, item_order)
                VALUES (${tenantId}, ${batch!.id}, ${intake!.id}, ${stagingMapped!.id}, 1) RETURNING id
            `;
            await sql`UPDATE payment_batch_staging_items SET batch_item_id = ${batchItem!.id}, payment_intake_id = ${intake!.id} WHERE id = ${stagingMapped!.id}`;
            const [preview] = await sql<{ id: number }[]>`
                INSERT INTO payment_batch_previews (tenant_id, batch_id, version, status, state_hash, preview_hash,
                    confirmation_hash, posting_sequence, evidence_ready, expires_at, created_by_user_id)
                VALUES (${tenantId}, ${batch!.id}, 2, 'posted', 'state-posted', 'preview-posted', 'confirm-posted',
                    ${sql.json([stagingMapped!.public_id])}, true, TIMESTAMPTZ '2026-09-01 00:00:00+00', ${actor!.id}) RETURNING id
            `;
            await sql`
                INSERT INTO payment_batch_allocations (tenant_id, preview_id, item_id, allocation_order, borrower_id, loan_id,
                    schedule_id, amount, target_due_date, intent, calculated_components, status)
                VALUES (${tenantId}, ${preview!.id}, ${batchItem!.id}, 1, ${borrower!.id}, ${loan!.id}, ${schedule!.id},
                    100.00, DATE '2026-08-10', 'on_time', ${sql.json({ principal: '100.00', interest: '0.00', fee: '0.00', penalty: '0.00' })}, 'posted')
            `;
            const [file] = await sql<{ id: number }[]>`
                INSERT INTO files (tenant_id, owner_user_id, bucket, key, original_name, mime_type, size)
                VALUES (${tenantId}, ${actor!.id}, 'test', ${crypto.randomUUID()}, 'fixture.png', 'image/png', 12) RETURNING id
            `;
            await sql`
                INSERT INTO payment_batch_staging_evidence (tenant_id, staging_item_id, file_id, evidence_hash,
                    mime_type, declared_size, status, finalized_at, created_by_user_id, updated_by_user_id)
                VALUES (${tenantId}, ${stagingMapped!.id}, ${file!.id}, ${crypto.randomUUID()}, 'image/png', 12,
                    'ready', TIMESTAMPTZ '2026-08-11 03:05:00+00', ${actor!.id}, ${actor!.id})
            `;
            await sql`
                INSERT INTO transactions (tenant_id, owner_user_id, loan_id, schedule_id, amount, principal_component,
                    interest_component, fee_component, penalty_component, transaction_date, payment_intake_id,
                    idempotency_key, posted_at)
                VALUES (${tenantId}, ${actor!.id}, ${loan!.id}, ${schedule!.id}, 100.00, 100.00, 0.00, 0.00, 0.00,
                    TIMESTAMPTZ '2026-08-11 03:00:00+00', ${intake!.id}, ${crypto.randomUUID()}, TIMESTAMPTZ '2026-08-11 03:01:00+00')
            `;
            await sql`UPDATE payment_batches SET status = 'posted', posted_at = TIMESTAMPTZ '2026-08-12 03:00:00+00', execute_idempotency_key = ${crypto.randomUUID()} WHERE id = ${batch!.id}`;

            const economicBefore = await sql`SELECT loan_id, schedule_id, amount, principal_component, interest_component, fee_component, penalty_component, transaction_date, payment_intake_id, posted_at FROM transactions WHERE tenant_id = ${tenantId}`;
            const membershipBefore = await sql`SELECT batch_id, payment_intake_id, staging_item_id, item_order FROM payment_batch_items WHERE tenant_id = ${tenantId}`;
            const evidenceBefore = await sql`SELECT staging_item_id, file_id, evidence_hash, status, finalized_at FROM payment_batch_staging_evidence WHERE tenant_id = ${tenantId}`;
            const journalBefore = await sql`SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`;

            await sql.unsafe('ALTER TABLE payment_batch_staging_items DROP CONSTRAINT payment_batch_staging_resolution_state_check');
            await sql.unsafe('ALTER TABLE payment_batch_staging_items DROP COLUMN resolution_state');
            const migrationPath = resolve(root, "drizzle/0068_staging_resolution_state.sql");
            await applySqlFile(sql, migrationPath);

            const resolution = await sql`SELECT public_id, reviewed_mapping, resolution_state FROM payment_batch_staging_items WHERE tenant_id = ${tenantId} ORDER BY id`;
            expect(resolution).toHaveLength(2);
            expect(resolution.find((row) => row.public_id === stagingMapped!.public_id)).toMatchObject({ resolution_state: "mapped" });
            expect(resolution.find((row) => row.public_id === stagingUnknown!.public_id)).toMatchObject({ reviewed_mapping: null, resolution_state: "unresolved" });
            expect(await sql`SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'payment_batch_staging_items' AND indexname = 'payment_batch_staging_tenant_batch_received_idx'`).toHaveLength(1);
            expect(await sql`SELECT conname FROM pg_constraint WHERE conrelid = 'payment_batch_staging_items'::regclass AND conname = 'payment_batch_staging_resolution_state_check'`).toHaveLength(1);
            let invalidStateRejected = false;
            try { await sql`UPDATE payment_batch_staging_items SET resolution_state = 'invalid' WHERE id = ${stagingUnknown!.id}`; } catch { invalidStateRejected = true; }
            expect(invalidStateRejected).toBe(true);

            expect(Array.from(await sql`SELECT loan_id, schedule_id, amount, principal_component, interest_component, fee_component, penalty_component, transaction_date, payment_intake_id, posted_at FROM transactions WHERE tenant_id = ${tenantId}`)).toEqual(Array.from(economicBefore));
            expect(Array.from(await sql`SELECT batch_id, payment_intake_id, staging_item_id, item_order FROM payment_batch_items WHERE tenant_id = ${tenantId}`)).toEqual(Array.from(membershipBefore));
            expect(Array.from(await sql`SELECT staging_item_id, file_id, evidence_hash, status, finalized_at FROM payment_batch_staging_evidence WHERE tenant_id = ${tenantId}`)).toEqual(Array.from(evidenceBefore));

            let postedBatchRejected = false;
            try { await sql`UPDATE payment_batches SET notes = 'tamper' WHERE id = ${batch!.id}`; } catch { postedBatchRejected = true; }
            expect(postedBatchRejected).toBe(true);
            let postedMemberRejected = false;
            try { await sql`DELETE FROM payment_batch_items WHERE id = ${batchItem!.id}`; } catch { postedMemberRejected = true; }
            expect(postedMemberRejected).toBe(true);
            let postedEvidenceRejected = false;
            try { await sql`DELETE FROM payment_batch_staging_evidence WHERE staging_item_id = ${stagingMapped!.id}`; } catch { postedEvidenceRejected = true; }
            expect(postedEvidenceRejected).toBe(true);

            const rowCountBeforeRerun = (await sql`SELECT count(*)::int AS count FROM payment_batch_staging_items WHERE tenant_id = ${tenantId}`)[0]!.count;
            const resolutionBeforeRerun = await sql`SELECT public_id, resolution_state FROM payment_batch_staging_items WHERE tenant_id = ${tenantId} ORDER BY id`;
            const journalBeforeRerun = await sql`SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`;
            const { migrate } = await import("drizzle-orm/postgres-js/migrator");
            const { drizzle } = await import("drizzle-orm/postgres-js");
            await migrate(drizzle(sql), { migrationsFolder: resolve(root, "drizzle") });
            expect((await sql`SELECT count(*)::int AS count FROM payment_batch_staging_items WHERE tenant_id = ${tenantId}`)[0]!.count).toBe(rowCountBeforeRerun);
            expect(Array.from(await sql`SELECT public_id, resolution_state FROM payment_batch_staging_items WHERE tenant_id = ${tenantId} ORDER BY id`)).toEqual(Array.from(resolutionBeforeRerun));
            expect(Array.from(await sql`SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`)).toEqual(Array.from(journalBeforeRerun));
            expect(Array.from(journalBefore)).toEqual(Array.from(journalBeforeRerun));
        } finally {
            await sql.end();
        }
    });

    integrationTest("runs the real 0067 to 0068 migrator against populated draft and posted data", async () => {
        const baseUrl = process.env.TEST_DATABASE_URL!;
        const admin = postgres(baseUrl, { max: 1 });
        const databaseName = `creditsync_upgrade_${crypto.randomUUID().replaceAll("-", "")}`;
        const migrationJournal = await Bun.file(`${root}drizzle/meta/_journal.json`).json() as { entries: Array<{ idx: number; when: number; tag: string }> };
        const resolutionEntry = migrationJournal.entries.find((entry) => entry.tag === "0068_staging_resolution_state");
        if (!resolutionEntry) throw new Error("0068 migration journal entry is missing");
        const prefixDir = await makeMigrationFixture("/tmp/creditsync-migrations-0067", resolutionEntry.idx - 1);
        const fullDir = await makeMigrationFixture("/tmp/creditsync-migrations-full");
        let scratch: ReturnType<typeof postgres> | undefined;
        try {
            await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
            const scratchUrl = new URL(baseUrl);
            scratchUrl.pathname = `/${databaseName}`;
            scratch = postgres(scratchUrl.toString(), { max: 1 });
            const { drizzle } = await import("drizzle-orm/postgres-js");
            const { migrate } = await import("drizzle-orm/postgres-js/migrator");
            await migrate(drizzle(scratch), { migrationsFolder: prefixDir });
            expect(Array.from(await scratch`SELECT to_regclass('public.payment_batch_staging_items')`)).toEqual([{ to_regclass: "payment_batch_staging_items" }]);
            expect(Array.from(await scratch`SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'payment_batch_staging_items' AND column_name = 'resolution_state')`)).toEqual([{ exists: false }]);
            expect(Array.from(await scratch`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations WHERE created_at = ${resolutionEntry.when}`)).toEqual([{ count: 0 }]);

            const tenantId = `migration-real-${crypto.randomUUID()}`;
            const [actor] = await scratch<{ id: number }[]>`INSERT INTO users (tenant_id, email, role) VALUES (${tenantId}, ${crypto.randomUUID()} || '@example.test', 'owner') RETURNING id`;
            const [borrower] = await scratch<{ id: number; public_id: string }[]>`INSERT INTO borrowers (tenant_id, owner_user_id, name) VALUES (${tenantId}, ${actor!.id}, 'Real upgrade borrower') RETURNING id, public_id`;
            const [loan] = await scratch<{ id: number; public_id: string }[]>`INSERT INTO loans (tenant_id, owner_user_id, borrower_id, principal_amount, interest_rate, repayment_type, status, start_date, outstanding_principal, outstanding_interest, outstanding_fees) VALUES (${tenantId}, ${actor!.id}, ${borrower!.id}, 2000, 0, 'daily', 'active', DATE '2026-08-01', 2000, 0, 0) RETURNING id, public_id`;
            const [schedule] = await scratch<{ id: number }[]>`INSERT INTO loan_schedules (tenant_id, loan_id, installment_no, due_date, scheduled_total, remaining_due) VALUES (${tenantId}, ${loan!.id}, 1, DATE '2026-08-10', 100, 100) RETURNING id`;
            const [draft] = await scratch<{ id: number }[]>`INSERT INTO payment_batches (tenant_id, borrower_id, status, version, state_hash, create_idempotency_key, created_by_user_id, updated_by_user_id) VALUES (${tenantId}, ${borrower!.id}, 'needs_review', 1, 'draft-state', ${crypto.randomUUID()}, ${actor!.id}, ${actor!.id}) RETURNING id`;
            const [posted] = await scratch<{ id: number }[]>`INSERT INTO payment_batches (tenant_id, borrower_id, status, version, state_hash, confirmation_hash, create_idempotency_key, created_by_user_id, updated_by_user_id) VALUES (${tenantId}, ${borrower!.id}, 'needs_review', 2, 'posted-state', 'posted-confirmation', ${crypto.randomUUID()}, ${actor!.id}, ${actor!.id}) RETURNING id`;
            const [intake] = await scratch<{ id: number }[]>`INSERT INTO payment_intakes (tenant_id, owner_user_id, source, status, amount, received_at, idempotency_key, created_by_user_id, updated_by_user_id) VALUES (${tenantId}, ${actor!.id}, 'web', 'posted', 100, TIMESTAMPTZ '2026-08-11 03:00:00+00', ${crypto.randomUUID()}, ${actor!.id}, ${actor!.id}) RETURNING id`;
            const [mapped] = await scratch<{ id: number; public_id: string }[]>`INSERT INTO payment_batch_staging_items (tenant_id, batch_id, client_item_key, payload_fingerprint, amount, received_at, status, reviewed_mapping, created_by_user_id, updated_by_user_id) VALUES (${tenantId}, ${posted!.id}, 'posted-mapped', 'posted-mapped-fp', 100, TIMESTAMPTZ '2026-08-11 03:00:00+00', 'validated', ${JSON.stringify({ borrowerPublicId: borrower!.public_id, loanPublicId: loan!.public_id })}, ${actor!.id}, ${actor!.id}) RETURNING id, public_id`;
            const [unknown] = await scratch<{ id: number; public_id: string }[]>`INSERT INTO payment_batch_staging_items (tenant_id, batch_id, client_item_key, payload_fingerprint, amount, received_at, status, created_by_user_id, updated_by_user_id) VALUES (${tenantId}, ${draft!.id}, 'draft-unknown', 'draft-unknown-fp', 25, TIMESTAMPTZ '2026-08-11 04:00:00+00', 'staged', ${actor!.id}, ${actor!.id}) RETURNING id, public_id`;
            const [member] = await scratch<{ id: number }[]>`INSERT INTO payment_batch_items (tenant_id, batch_id, payment_intake_id, staging_item_id, item_order) VALUES (${tenantId}, ${posted!.id}, ${intake!.id}, ${mapped!.id}, 1) RETURNING id`;
            await scratch`UPDATE payment_batch_staging_items SET payment_intake_id = ${intake!.id}, batch_item_id = ${member!.id} WHERE id = ${mapped!.id}`;
            const [preview] = await scratch<{ id: number }[]>`INSERT INTO payment_batch_previews (tenant_id, batch_id, version, status, state_hash, preview_hash, confirmation_hash, posting_sequence, evidence_ready, expires_at, created_by_user_id) VALUES (${tenantId}, ${posted!.id}, 2, 'posted', 'posted-state', 'posted-preview', 'posted-confirmation', ${JSON.stringify([mapped!.public_id])}, true, TIMESTAMPTZ '2026-09-01 00:00:00+00', ${actor!.id}) RETURNING id`;
            await scratch`INSERT INTO payment_batch_allocations (tenant_id, preview_id, item_id, allocation_order, borrower_id, loan_id, schedule_id, amount, target_due_date, intent, calculated_components, status) VALUES (${tenantId}, ${preview!.id}, ${member!.id}, 1, ${borrower!.id}, ${loan!.id}, ${schedule!.id}, 100, DATE '2026-08-10', 'on_time', ${JSON.stringify({ principal: '100.00', interest: '0.00', fee: '0.00', penalty: '0.00' })}, 'posted')`;
            const [file] = await scratch<{ id: number }[]>`INSERT INTO files (tenant_id, owner_user_id, bucket, key, original_name, mime_type, size) VALUES (${tenantId}, ${actor!.id}, 'test', ${crypto.randomUUID()}, 'upgrade.png', 'image/png', 12) RETURNING id`;
            await scratch`INSERT INTO payment_batch_staging_evidence (tenant_id, staging_item_id, file_id, evidence_hash, mime_type, declared_size, status, finalized_at, created_by_user_id, updated_by_user_id) VALUES (${tenantId}, ${mapped!.id}, ${file!.id}, ${crypto.randomUUID()}, 'image/png', 12, 'ready', TIMESTAMPTZ '2026-08-11 03:05:00+00', ${actor!.id}, ${actor!.id})`;
            await scratch`INSERT INTO transactions (tenant_id, owner_user_id, loan_id, schedule_id, amount, principal_component, interest_component, fee_component, penalty_component, transaction_date, payment_intake_id, idempotency_key, posted_at) VALUES (${tenantId}, ${actor!.id}, ${loan!.id}, ${schedule!.id}, 100, 100, 0, 0, 0, TIMESTAMPTZ '2026-08-11 03:00:00+00', ${intake!.id}, ${crypto.randomUUID()}, TIMESTAMPTZ '2026-08-11 03:01:00+00')`;
            await scratch`UPDATE payment_batches SET status = 'posted', posted_at = TIMESTAMPTZ '2026-08-12 03:00:00+00', execute_idempotency_key = ${crypto.randomUUID()} WHERE id = ${posted!.id}`;

            const postedSnapshot = async () => ({
                batch: Array.from(await scratch!`SELECT id, public_id, status, version, state_hash, confirmation_hash, posted_at FROM payment_batches WHERE id = ${posted!.id}`),
                member: Array.from(await scratch!`SELECT id, public_id, batch_id, payment_intake_id, staging_item_id, item_order FROM payment_batch_items WHERE id = ${member!.id}`),
                allocation: Array.from(await scratch!`SELECT id, public_id, preview_id, item_id, borrower_id, loan_id, schedule_id, amount, target_due_date, calculated_components, status FROM payment_batch_allocations WHERE preview_id = ${preview!.id}`),
                transaction: Array.from(await scratch!`SELECT id, public_id, loan_id, schedule_id, amount, principal_component, interest_component, fee_component, penalty_component, transaction_date, payment_intake_id, posted_at FROM transactions WHERE payment_intake_id = ${intake!.id}`),
                evidence: Array.from(await scratch!`SELECT staging_item_id, file_id, evidence_hash, status, finalized_at FROM payment_batch_staging_evidence WHERE staging_item_id = ${mapped!.id}`),
            });
            const before = await postedSnapshot();
            const oldJournal = Array.from(await scratch`SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`);
            await migrate(drizzle(scratch), { migrationsFolder: fullDir });
            const migrationSql = await Bun.file(`${root}drizzle/${resolutionEntry.tag}.sql`).text();
            const canonicalHash = createHash("sha256").update(migrationSql).digest("hex");
            expect(Array.from(await scratch`SELECT hash FROM drizzle.__drizzle_migrations WHERE created_at = ${resolutionEntry.when}`)).toEqual([{ hash: canonicalHash }]);
            expect(Array.from(await scratch`SELECT reviewed_mapping IS NOT NULL AS mapped, resolution_state FROM payment_batch_staging_items WHERE id = ${mapped!.id}`)).toEqual([{ mapped: true, resolution_state: "mapped" }]);
            expect(Array.from(await scratch`SELECT reviewed_mapping IS NULL AS unmapped, resolution_state FROM payment_batch_staging_items WHERE id = ${unknown!.id}`)).toEqual([{ unmapped: true, resolution_state: "unresolved" }]);
            const after = await postedSnapshot();
            expect(after).toEqual(before);
            let postedBatchRejected = false;
            try { await scratch`UPDATE payment_batches SET notes = 'tamper' WHERE id = ${posted!.id}`; } catch { postedBatchRejected = true; }
            expect(postedBatchRejected).toBe(true);
            let postedMemberRejected = false;
            try { await scratch`DELETE FROM payment_batch_items WHERE id = ${member!.id}`; } catch { postedMemberRejected = true; }
            expect(postedMemberRejected).toBe(true);
            let postedEvidenceRejected = false;
            try { await scratch`DELETE FROM payment_batch_staging_evidence WHERE staging_item_id = ${mapped!.id}`; } catch { postedEvidenceRejected = true; }
            expect(postedEvidenceRejected).toBe(true);
            const journalAfter = Array.from(await scratch`SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`);
            expect(journalAfter.slice(0, oldJournal.length)).toEqual(oldJournal);
            await migrate(drizzle(scratch), { migrationsFolder: fullDir });
            expect(Array.from(await scratch`SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`)).toEqual(journalAfter);
            expect(await postedSnapshot()).toEqual(before);
        } finally {
            if (scratch) await scratch.end();
            await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}"`);
            await admin.end();
            await rm(prefixDir, { recursive: true, force: true });
            await rm(fullDir, { recursive: true, force: true });
        }
    });
    test("registers the additive batch schema and immutable posted boundary", async () => {
        const [journal, migration] = await Promise.all([
            Bun.file(`${root}drizzle/meta/_journal.json`).json() as Promise<{ entries: Array<{ idx: number; tag: string }> }>,
            Bun.file(`${root}drizzle/0051_atomic_batch_payments.sql`).text(),
        ]);
        expect(journal.entries.find((entry) => entry.idx === 51)).toMatchObject({ idx: 51, tag: "0051_atomic_batch_payments" });
        for (const table of ["payment_batches", "payment_batch_items", "payment_batch_previews", "payment_batch_allocations"]) expect(migration).toContain(`CREATE TABLE "${table}"`);
        for (const name of [
            "payment_batches_tenant_idempotency_unique",
            "payment_batch_items_tenant_intake_unique",
            "payment_batch_previews_tenant_batch_version_unique",
            "payment_batch_allocations_tenant_preview_order_unique",
            "payment_batch_posted_immutable",
        ]) expect(migration).toContain(name);
        expect(migration).toContain("CREATE TRIGGER");
        expect(migration).not.toMatch(/DROP TABLE/i);
    });
});
