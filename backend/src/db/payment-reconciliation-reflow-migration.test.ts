import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import postgres from "postgres";

const root = new URL("../../", import.meta.url).pathname;
const integrationTest = process.env.TEST_DATABASE_URL ? test : test.skip;

async function migrationFixture(prefix: string, maximumIndex?: number) {
    const fixture = await mkdtemp(`${prefix}-`);
    await mkdir(`${fixture}/meta`);
    const journal = await Bun.file(`${root}drizzle/meta/_journal.json`).json() as { entries: Array<{ idx: number; tag: string }> };
    const entries = journal.entries.filter((entry) => maximumIndex === undefined || entry.idx <= maximumIndex);
    for (const entry of entries) await cp(`${root}drizzle/${entry.tag}.sql`, `${fixture}/${entry.tag}.sql`);
    await writeFile(`${fixture}/meta/_journal.json`, JSON.stringify({ ...journal, entries }));
    return fixture;
}

describe("temporal reflow migration", () => {
    test("adds the immutable allocation-lineage companion schema", async () => {
        const migration = await readFile(resolve(root, "drizzle/0070_payment_reconciliation_temporal_reflow.sql"), "utf8");
        expect(migration).toContain('CREATE TABLE "payment_reconciliation_reflow_proposals"');
        expect(migration).toContain('CREATE TABLE "payment_reconciliation_reflow_groups"');
        expect(migration).toContain('CREATE TABLE "payment_reconciliation_reflow_entries"');
            expect(migration).toContain("reflow_entries_source_alloc_fk");
        expect(migration).toContain("payment_reconciliation_reflow_groups_immutable");
        expect(migration).toContain("payment_reconciliation_reflow_entries_immutable");
        expect(migration).not.toMatch(/DROP TABLE/i);
        expect(await readFile(resolve(root, "drizzle/0071_reflow_proposal_immutability.sql"), "utf8")).toContain("NEW.public_id = OLD.public_id");
        expect(await readFile(resolve(root, "drizzle/0072_reflow_source_split_lineage.sql"), "utf8")).toContain("reflow_entries_source_replacement_unique");
    });

    integrationTest("registers the additive tables, tenant constraints, and immutable triggers", async () => {
        const sql = postgres(process.env.TEST_DATABASE_URL!, { max: 1 });
        try {
            const tables = await sql<{ table_name: string }[]>`
                SELECT table_name FROM information_schema.tables
                WHERE table_schema = 'public'
                  AND table_name IN ('payment_reconciliation_reflow_proposals', 'payment_reconciliation_reflow_groups', 'payment_reconciliation_reflow_entries')
                ORDER BY table_name
            `;
            expect(tables.map((row) => row.table_name)).toEqual([
                "payment_reconciliation_reflow_entries",
                "payment_reconciliation_reflow_groups",
                "payment_reconciliation_reflow_proposals",
            ]);
            const constraints = await sql<{ conname: string }[]>`
                SELECT conname FROM pg_constraint
                WHERE conname LIKE 'payment_reconciliation_reflow_%' OR conname LIKE 'reflow_entries_%'
                ORDER BY conname
            `;
            expect(constraints.map((row) => row.conname)).toContain("reflow_entries_source_alloc_fk");
            expect(constraints.map((row) => row.conname)).toContain("payment_reconciliation_reflow_groups_repair_proposal_check");
            const triggers = await sql<{ tgname: string }[]>`
                SELECT tgname FROM pg_trigger
                WHERE NOT tgisinternal AND tgname LIKE 'payment_reconciliation_reflow_%_immutable'
                ORDER BY tgname
            `;
            expect(triggers.map((row) => row.tgname)).toEqual([
                "payment_reconciliation_reflow_entries_immutable",
                "payment_reconciliation_reflow_groups_immutable",
                "payment_reconciliation_reflow_proposals_immutable",
            ]);
        } finally {
            await sql.end();
        }
    });

    integrationTest("applies 0070 from a real 0069 prefix and is idempotent", async () => {
        const admin = postgres(process.env.TEST_DATABASE_URL!, { max: 1 });
        const databaseName = `creditsync_reflow_${crypto.randomUUID().replaceAll("-", "")}`;
        const journal = await Bun.file(`${root}drizzle/meta/_journal.json`).json() as { entries: Array<{ idx: number; tag: string; when: number }> };
        const entry = journal.entries.find((candidate) => candidate.tag === "0070_payment_reconciliation_temporal_reflow")!;
        const prefix = await migrationFixture("/tmp/creditsync-reflow-0069", entry.idx - 1);
        const full = await migrationFixture("/tmp/creditsync-reflow-full");
        try {
            await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
            const scratchUrl = new URL(process.env.TEST_DATABASE_URL!);
            scratchUrl.pathname = `/${databaseName}`;
            const scratch = postgres(scratchUrl.toString(), { max: 1 });
            try {
                const { drizzle } = await import("drizzle-orm/postgres-js");
                const { migrate } = await import("drizzle-orm/postgres-js/migrator");
                await migrate(drizzle(scratch), { migrationsFolder: prefix });
                expect(Array.from(await scratch`SELECT to_regclass('public.payment_reconciliation_reflow_groups')`)).toEqual([{ to_regclass: null }]);
                const oldJournal = Array.from(await scratch`SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`);
                await migrate(drizzle(scratch), { migrationsFolder: full });
                expect(Array.from(await scratch`SELECT to_regclass('public.payment_reconciliation_reflow_groups')`)).toEqual([{ to_regclass: "payment_reconciliation_reflow_groups" }]);
                const canonicalHash = createHash("sha256").update(await Bun.file(`${root}drizzle/${entry.tag}.sql`).text()).digest("hex");
                expect(Array.from(await scratch`SELECT hash FROM drizzle.__drizzle_migrations WHERE created_at = ${entry.when}`)).toEqual([{ hash: canonicalHash }]);
                const journalAfter = Array.from(await scratch`SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`);
                await migrate(drizzle(scratch), { migrationsFolder: full });
                expect(Array.from(await scratch`SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`)).toEqual(journalAfter);
                expect(journalAfter.slice(0, oldJournal.length)).toEqual(oldJournal);
            } finally {
                await scratch.end();
            }
        } finally {
            await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}"`);
            await admin.end();
            await rm(prefix, { recursive: true, force: true });
            await rm(full, { recursive: true, force: true });
        }
    });

    integrationTest("keeps reflow proposal identity immutable across its lifecycle", async () => {
        const sql = postgres(process.env.TEST_DATABASE_URL!, { max: 1 });
        const tenantId = `reflow-trigger-${crypto.randomUUID()}`;
        try {
            const [actor] = await sql<{ id: number }[]>`INSERT INTO users (tenant_id, email, role) VALUES (${tenantId}, ${crypto.randomUUID()} || '@example.test', 'owner') RETURNING id`;
            const [intake] = await sql<{ id: number }[]>`INSERT INTO payment_intakes (tenant_id, owner_user_id, source, status, amount, received_at, idempotency_key, created_by_user_id, updated_by_user_id) VALUES (${tenantId}, ${actor!.id}, 'system', 'posted', 1.00, now(), ${crypto.randomUUID()}, ${actor!.id}, ${actor!.id}) RETURNING id`;
            const [reconciliationAudit] = await sql<{ public_id: string }[]>`INSERT INTO audit_logs (tenant_id, entity_type, entity_id, action, actor_user_id, actor_source) VALUES (${tenantId}, 'payment', ${String(intake!.id)}, 'reconciliation', ${actor!.id}, 'system') RETURNING public_id`;
            const [proposal] = await sql<{ id: number }[]>`INSERT INTO payment_reconciliation_proposals (tenant_id, payment_intake_id, preview_hash, expected_balance_version, source_snapshot, proposed_allocations, reason, expires_at) VALUES (${tenantId}, ${intake!.id}, 'source-hash', 'balance-v1', '{}'::jsonb, '[]'::jsonb, 'synthetic reflow trigger', now() + interval '1 hour') RETURNING id`;
            const [group] = await sql<{ id: number }[]>`INSERT INTO payment_reconciliation_groups (tenant_id, proposal_id, payment_intake_id, status, reason, idempotency_key, correlation_id, audit_public_id) VALUES (${tenantId}, ${proposal!.id}, ${intake!.id}, 'executed', 'synthetic reconciliation', ${crypto.randomUUID()}, ${crypto.randomUUID()}, ${reconciliationAudit!.public_id}) RETURNING id`;
            const [reflow] = await sql<{ id: number; public_id: string }[]>`INSERT INTO payment_reconciliation_reflow_proposals (tenant_id, reconciliation_group_id, preview_hash, expected_balance_version, source_snapshot, proposed_reflow, reason, expires_at) VALUES (${tenantId}, ${group!.id}, 'reflow-hash', 'balance-v1', '{}'::jsonb, '{}'::jsonb, 'synthetic trigger proposal', now() + interval '1 hour') RETURNING id, public_id`;
            let identityRejected = false;
            try { await sql`UPDATE payment_reconciliation_reflow_proposals SET status = 'executed', public_id = uuidv7(), executed_by_user_id = ${actor!.id}, executed_at = now() WHERE id = ${reflow!.id}`; } catch { identityRejected = true; }
            expect(identityRejected).toBe(true);
            let creatorRejected = false;
            try { await sql`UPDATE payment_reconciliation_reflow_proposals SET status = 'executed', created_by_user_id = ${actor!.id}, executed_by_user_id = ${actor!.id}, executed_at = now() WHERE id = ${reflow!.id}`; } catch { creatorRejected = true; }
            expect(creatorRejected).toBe(true);
            let tenantRejected = false;
            try { await sql`UPDATE payment_reconciliation_reflow_proposals SET status = 'executed', tenant_id = ${`${tenantId}-other`}, executed_by_user_id = ${actor!.id}, executed_at = now() WHERE id = ${reflow!.id}`; } catch { tenantRejected = true; }
            expect(tenantRejected).toBe(true);
            let createdAtRejected = false;
            try { await sql`UPDATE payment_reconciliation_reflow_proposals SET status = 'executed', created_at = now() + interval '1 minute', executed_by_user_id = ${actor!.id}, executed_at = now() WHERE id = ${reflow!.id}`; } catch { createdAtRejected = true; }
            expect(createdAtRejected).toBe(true);
            let snapshotRejected = false;
            try { await sql`UPDATE payment_reconciliation_reflow_proposals SET status = 'executed', proposed_reflow = '{"changed":true}'::jsonb, executed_by_user_id = ${actor!.id}, executed_at = now() WHERE id = ${reflow!.id}`; } catch { snapshotRejected = true; }
            expect(snapshotRejected).toBe(true);
            await sql`UPDATE payment_reconciliation_reflow_proposals SET status = 'executed', executed_by_user_id = ${actor!.id}, executed_at = now() WHERE id = ${reflow!.id}`;
            expect(Array.from(await sql`SELECT status, executed_by_user_id FROM payment_reconciliation_reflow_proposals WHERE id = ${reflow!.id}`)).toEqual([{ status: "executed", executed_by_user_id: actor!.id }]);
            let deleteRejected = false;
            try { await sql`DELETE FROM payment_reconciliation_reflow_proposals WHERE id = ${reflow!.id}`; } catch { deleteRejected = true; }
            expect(deleteRejected).toBe(true);
        } finally {
            await sql.end();
        }
    });
});
