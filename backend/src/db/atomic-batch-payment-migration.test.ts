import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
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

            expect(await sql`SELECT loan_id, schedule_id, amount, principal_component, interest_component, fee_component, penalty_component, transaction_date, payment_intake_id, posted_at FROM transactions WHERE tenant_id = ${tenantId}`).toEqual(economicBefore);
            expect(await sql`SELECT batch_id, payment_intake_id, staging_item_id, item_order FROM payment_batch_items WHERE tenant_id = ${tenantId}`).toEqual(membershipBefore);
            expect(await sql`SELECT staging_item_id, file_id, evidence_hash, status, finalized_at FROM payment_batch_staging_evidence WHERE tenant_id = ${tenantId}`).toEqual(evidenceBefore);

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
            expect(await sql`SELECT public_id, resolution_state FROM payment_batch_staging_items WHERE tenant_id = ${tenantId} ORDER BY id`).toEqual(resolutionBeforeRerun);
            expect(await sql`SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`).toEqual(journalBeforeRerun);
            expect(journalBefore).toEqual(journalBeforeRerun);
        } finally {
            await sql.end();
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
