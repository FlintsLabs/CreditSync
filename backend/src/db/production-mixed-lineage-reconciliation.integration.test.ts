import { afterAll, beforeAll, expect, test } from "bun:test";
import postgres from "postgres";
import { createHash } from "node:crypto";

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = databaseUrl ? test : test.skip;
const root = `${import.meta.dir}/../../`;
const legacyTail = [
  ["0a72edb73c76b820f026b7389873cb441cc5f7d8ac2a81e9585131d9da866d2c", 1786485015063],
  ["73f1803d9c83df434746a58a82e5d180899071971b0d22fe45e23fa7bb7dfc81", 1786486095512],
] as const;
const alternateFunding = ["cd43d16ea7fe5c42d04624fe8bf7570871c504c9dda3cb88722a8c1097070427", 1786593600000] as const;
let sql: ReturnType<typeof postgres>;

function hash(value: string) { return createHash("sha256").update(value).digest("hex"); }
async function applyFile(path: string) {
  const content = await Bun.file(path).text();
  for (const statement of content.split("--> statement-breakpoint")) if (statement.trim()) await sql.unsafe(statement);
}

async function resetMixedLineage() {
  await sql.unsafe("DROP SCHEMA public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA IF EXISTS creditsync_quarantine CASCADE; CREATE SCHEMA public");
  const journal = await Bun.file(`${root}drizzle/meta/_journal.json`).json() as { entries: Array<{ idx: number; tag: string; when: number }> };
  for (const entry of journal.entries.filter((e) => e.idx <= 25)) await applyFile(`${root}drizzle/${entry.tag}.sql`);
  await applyFile(`${root}drizzle/0026_intermediary_remittance_evidence.sql`);
  await sql.unsafe("CREATE SCHEMA drizzle; CREATE TABLE drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint NOT NULL)");
  for (const entry of journal.entries.filter((e) => e.idx <= 25)) {
    const content = await Bun.file(`${root}drizzle/${entry.tag}.sql`).text();
    await sql`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES (${hash(content)}, ${entry.when})`;
  }
  await sql.unsafe(`
    ALTER TABLE public.loan_funding_allocations ADD COLUMN request_id text;
    ALTER TABLE public.loan_funding_allocations ADD COLUMN correlation_id text;
    ALTER TABLE public.loan_funding_allocations ADD COLUMN idempotency_key text;
    CREATE TABLE public.loan_funding_previews (id serial PRIMARY KEY,public_id uuid DEFAULT uuidv7() NOT NULL UNIQUE,tenant_id text NOT NULL,loan_id integer NOT NULL,created_by_user_id integer,request jsonb NOT NULL,request_hash text NOT NULL,state_version text NOT NULL,proposed_entries jsonb NOT NULL,preview_hash text NOT NULL,expires_at timestamp NOT NULL,executed_at timestamp,execution_idempotency_key text,execution_request_hash text,result jsonb,created_at timestamp DEFAULT now(),CONSTRAINT loan_funding_previews_loan_fk FOREIGN KEY(loan_id) REFERENCES loans(id),CONSTRAINT loan_funding_previews_created_by_user_fk FOREIGN KEY(created_by_user_id) REFERENCES users(id));
    CREATE INDEX loan_funding_previews_tenant_loan_idx ON loan_funding_previews(tenant_id,loan_id);
    CREATE UNIQUE INDEX loan_funding_previews_tenant_execution_idempotency_unique ON loan_funding_previews(tenant_id,execution_idempotency_key) WHERE execution_idempotency_key IS NOT NULL;
    CREATE TABLE public.intermediary_bank_accounts (
      id serial PRIMARY KEY, public_id uuid DEFAULT uuidv7() NOT NULL, tenant_id text NOT NULL,
      intermediary_id integer NOT NULL, bank_code text NOT NULL, bank_name text NOT NULL,
      account_holder_name text NOT NULL, account_number_ciphertext text NOT NULL, account_fingerprint text NOT NULL,
      masked_account_number text NOT NULL, label text, verification_status text DEFAULT 'unverified' NOT NULL,
      status text DEFAULT 'active' NOT NULL, created_by_user_id integer, updated_by_user_id integer,
      created_at timestamp DEFAULT now() NOT NULL, updated_at timestamp DEFAULT now() NOT NULL,
      CONSTRAINT intermediary_bank_accounts_public_id_unique UNIQUE (public_id),
      CONSTRAINT intermediary_bank_accounts_status_check CHECK (status IN ('active','inactive')),
      CONSTRAINT intermediary_bank_accounts_verification_check CHECK (verification_status IN ('unverified','verified','conflict'))
    );
    CREATE UNIQUE INDEX intermediary_bank_accounts_active_fingerprint_unique ON public.intermediary_bank_accounts (tenant_id, account_fingerprint) WHERE status='active';
    CREATE UNIQUE INDEX intermediary_bank_accounts_tenant_id_id_unique ON public.intermediary_bank_accounts (tenant_id,id);
    ALTER TABLE public.intermediary_bank_accounts ADD CONSTRAINT intermediary_bank_accounts_tenant_intermediary_fk FOREIGN KEY (tenant_id,intermediary_id) REFERENCES intermediaries(tenant_id,id);
    ALTER TABLE public.intermediary_bank_accounts ADD CONSTRAINT intermediary_bank_accounts_tenant_created_by_fk FOREIGN KEY (tenant_id,created_by_user_id) REFERENCES users(tenant_id,id);
    ALTER TABLE public.intermediary_bank_accounts ADD CONSTRAINT intermediary_bank_accounts_tenant_updated_by_fk FOREIGN KEY (tenant_id,updated_by_user_id) REFERENCES users(tenant_id,id);
    CREATE TABLE public.intermediary_compensation_settlements (id serial PRIMARY KEY, tenant_id text NOT NULL, destination_account_id integer NOT NULL);
    ALTER TABLE public.intermediary_compensation_settlements ADD CONSTRAINT intermediary_compensation_settlements_tenant_destination_fk FOREIGN KEY (tenant_id,destination_account_id) REFERENCES public.intermediary_bank_accounts(tenant_id,id);
    INSERT INTO public.users (tenant_id,email,role) VALUES ('fixture','fixture@example.test','owner');
    INSERT INTO public.intermediaries (tenant_id,owner_user_id,name,normalized_name) SELECT 'fixture',id,'Fixture intermediary','fixture intermediary' FROM public.users WHERE email='fixture@example.test';
    INSERT INTO public.borrowers (tenant_id,owner_user_id,name) SELECT 'fixture',u.id,'Fixture borrower '||g FROM public.users u CROSS JOIN generate_series(1,5) g WHERE email='fixture@example.test';
    INSERT INTO public.loans (tenant_id,owner_user_id,borrower_id,daily_interest_mode,daily_interest_rate,first_day_treatment,interest_start_date,principal_amount,interest_rate,repayment_type,start_date,status)
      SELECT 'fixture',u.id,b.id,'percent',1,'start_next_day','2026-08-01',1000,1,'floating','2026-08-01','active' FROM public.users u CROSS JOIN public.borrowers b WHERE u.email='fixture@example.test';
    INSERT INTO public.loan_interest_rate_periods (tenant_id,loan_id,effective_date,rate_type,rate) SELECT 'fixture',id,'2026-08-01','percent',1 FROM loans;
    INSERT INTO public.loan_interest_accruals (tenant_id,loan_id,accrual_date,opening_principal,rate_mode,rate,interest_amount,paid_amount,status)
      SELECT 'fixture',l.id,DATE '2026-08-01'+g,1000,'percent',1,10,0,CASE WHEN row_number() OVER (ORDER BY l.id,g)<=7 THEN 'reversed' ELSE 'due' END FROM public.loans l CROSS JOIN generate_series(1,10) g;
    INSERT INTO public.loan_disbursement_events (tenant_id,loan_id,gross_amount,loan_attributed_amount,channel,status) SELECT 'fixture',l.id,100,100,'bank_transfer','draft' FROM loans l CROSS JOIN generate_series(1,2);
    INSERT INTO public.loan_funding_allocations (tenant_id,loan_id,allocated_amount,allocation_date) SELECT 'fixture',l.id,100,'2026-08-01' FROM loans l CROSS JOIN LATERAL generate_series(1,CASE WHEN l.id <= (SELECT min(id)+2 FROM loans) THEN 2 ELSE 1 END) g LIMIT 8;
    INSERT INTO public.loan_funding_previews (tenant_id,loan_id,request,request_hash,state_version,proposed_entries,preview_hash,expires_at) SELECT 'fixture',id,'{}','request-'||id,'v1','[]','preview-'||id,now()+interval '1 day' FROM loans ORDER BY id LIMIT 2;
  `);
  for (const [legacyHash, when] of legacyTail) await sql`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES (${legacyHash}, ${when})`;
  const m26 = journal.entries.find((e) => e.idx === 26)!;
  const m26Content = await Bun.file(`${root}drizzle/${m26.tag}.sql`).text();
  await sql`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES (${hash(m26Content)}, ${m26.when})`;
  await sql`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES (${alternateFunding[0]}, ${alternateFunding[1]})`;
}

beforeAll(async () => { if (databaseUrl) { sql = postgres(databaseUrl, { max: 1 }); await resetMixedLineage(); } });
afterAll(async () => { if (sql) await sql.end(); });

integration("applies the exact mixed lineage, preserves legacy rows/FK, and reruns as a verified no-op", async () => {
  const before = await sql`SELECT oid, relfilenode FROM pg_class WHERE oid='public.intermediary_bank_accounts'::regclass`;
  const result = Bun.spawnSync(["bun", "run", "scripts/reconcile-production-mixed-lineage.ts", "--apply"], { cwd: root, env: { ...process.env, DATABASE_URL: databaseUrl! }, stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
  expect(new TextDecoder().decode(result.stdout)).toContain("applied");
  const after = await sql`SELECT oid, relfilenode FROM pg_class WHERE oid='creditsync_quarantine.intermediary_bank_accounts'::regclass`;
  expect(after[0]).toEqual(before[0]);
  expect((await sql`SELECT confrelid::regclass::text AS relation FROM pg_constraint WHERE conname='intermediary_compensation_settlements_tenant_destination_fk'`)[0]!.relation).toBe("creditsync_quarantine.intermediary_bank_accounts");
  const rerun = Bun.spawnSync(["bun", "run", "scripts/reconcile-production-mixed-lineage.ts", "--apply"], { cwd: root, env: { ...process.env, DATABASE_URL: databaseUrl! }, stdout: "pipe", stderr: "pipe" });
  expect(rerun.exitCode, new TextDecoder().decode(rerun.stderr)).toBe(0);
  expect(new TextDecoder().decode(rerun.stdout)).toContain("already-complete");
  const stock = Bun.spawnSync(["bun", "run", "migrate"], { cwd: root, env: { ...process.env, DATABASE_URL: databaseUrl! }, stdout: "pipe", stderr: "pipe" });
  expect(stock.exitCode, new TextDecoder().decode(stock.stderr)).toBe(0);
  const stockRerun = Bun.spawnSync(["bun", "run", "scripts/reconcile-production-mixed-lineage.ts"], { cwd: root, env: { ...process.env, DATABASE_URL: databaseUrl! }, stdout: "pipe", stderr: "pipe" });
  expect(stockRerun.exitCode, new TextDecoder().decode(stockRerun.stderr)).toBe(0);
  expect(new TextDecoder().decode(stockRerun.stdout)).toContain("already-complete");
  await sql`DROP TRIGGER borrower_id_card_upload_intents_lifecycle_guard ON borrower_id_card_upload_intents`;
  const mutated42 = Bun.spawnSync(["bun", "run", "scripts/reconcile-production-mixed-lineage.ts"], { cwd: root, env: { ...process.env, DATABASE_URL: databaseUrl! }, stdout: "pipe", stderr: "pipe" });
  expect(mutated42.exitCode).not.toBe(0);
  expect(new TextDecoder().decode(mutated42.stderr)).toContain("authoritative catalog fingerprint mismatch");
});

integration("rejects legacy and completed catalog mutations", async () => {
  await resetMixedLineage();
  await sql`ALTER TABLE intermediary_bank_accounts ALTER COLUMN status SET DEFAULT 'inactive'`;
  const legacy = Bun.spawnSync(["bun", "run", "scripts/reconcile-production-mixed-lineage.ts"], { cwd: root, env: { ...process.env, DATABASE_URL: databaseUrl! }, stdout: "pipe", stderr: "pipe" });
  expect(legacy.exitCode).not.toBe(0);
  expect(new TextDecoder().decode(legacy.stderr)).toContain("legacy catalog fingerprint mismatch");
  await resetMixedLineage();
  const applied = Bun.spawnSync(["bun", "run", "scripts/reconcile-production-mixed-lineage.ts", "--apply"], { cwd: root, env: { ...process.env, DATABASE_URL: databaseUrl! }, stdout: "pipe", stderr: "pipe" });
  expect(applied.exitCode, new TextDecoder().decode(applied.stderr)).toBe(0);
  await sql`DROP INDEX loan_waiver_previews_tenant_loan_status_idx`;
  const completed = Bun.spawnSync(["bun", "run", "scripts/reconcile-production-mixed-lineage.ts"], { cwd: root, env: { ...process.env, DATABASE_URL: databaseUrl! }, stdout: "pipe", stderr: "pipe" });
  expect(completed.exitCode).not.toBe(0);
  expect(new TextDecoder().decode(completed.stderr)).toContain("authoritative catalog fingerprint mismatch");
}, 15_000);

integration("rejects schedule, transaction, audit function, and sequence mutations", async () => {
  const cases = [
    `ALTER TABLE loan_schedules ALTER COLUMN scheduled_fee SET DEFAULT 1`,
    `ALTER TABLE transactions ALTER COLUMN principal_component SET DEFAULT 1`,
    `CREATE OR REPLACE FUNCTION reject_audit_log_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN OLD; END $$`,
    `ALTER SEQUENCE audit_logs_id_seq INCREMENT BY 2`,
  ];
  for (const mutation of cases) {
    await resetMixedLineage();
    const applied = Bun.spawnSync(["bun", "run", "scripts/reconcile-production-mixed-lineage.ts", "--apply"], { cwd: root, env: { ...process.env, DATABASE_URL: databaseUrl! }, stdout: "pipe", stderr: "pipe" });
    expect(applied.exitCode, new TextDecoder().decode(applied.stderr)).toBe(0);
    await sql.unsafe(mutation);
    const result = Bun.spawnSync(["bun", "run", "scripts/reconcile-production-mixed-lineage.ts"], { cwd: root, env: { ...process.env, DATABASE_URL: databaseUrl! }, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).not.toBe(0);
    expect(new TextDecoder().decode(result.stderr)).toContain("authoritative catalog fingerprint mismatch");
  }
}, 30_000);

integration("rejects quarantine privileges granted to a non-owner role", async () => {
  const intruder = "reconcile_acl_intruder";
  await resetMixedLineage();
  const applied = Bun.spawnSync(["bun", "run", "scripts/reconcile-production-mixed-lineage.ts", "--apply"], { cwd: root, env: { ...process.env, DATABASE_URL: databaseUrl! }, stdout: "pipe", stderr: "pipe" });
  expect(applied.exitCode, new TextDecoder().decode(applied.stderr)).toBe(0);
  try {
    await sql.unsafe(`DROP ROLE IF EXISTS ${intruder}; CREATE ROLE ${intruder}; GRANT USAGE ON SCHEMA creditsync_quarantine TO ${intruder}`);
    const result = Bun.spawnSync(["bun", "run", "scripts/reconcile-production-mixed-lineage.ts"], { cwd: root, env: { ...process.env, DATABASE_URL: databaseUrl! }, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).not.toBe(0);
    expect(new TextDecoder().decode(result.stderr)).toContain("quarantine schema owner/ACL/contents are not exact");
  } finally {
    await sql.unsafe(`REVOKE ALL ON SCHEMA creditsync_quarantine FROM ${intruder}; DROP ROLE IF EXISTS ${intruder}`);
  }
});

integration("rejects mutated completed 0030 ledger and audit content", async () => {
  const mutations = [
    `ALTER TABLE audit_logs DISABLE TRIGGER USER; UPDATE audit_logs SET payload='{"source":"tampered"}'::jsonb WHERE id=(SELECT min(id) FROM audit_logs WHERE action='floating_penalty_ledger_migrated'); ALTER TABLE audit_logs ENABLE TRIGGER USER`,
    `ALTER TABLE floating_penalty_ledger_entries DISABLE TRIGGER USER; UPDATE floating_penalty_ledger_entries SET actor_source='web' WHERE id=(SELECT min(id) FROM floating_penalty_ledger_entries WHERE entry_type IN ('legacy_cutover','legacy_snapshot')); ALTER TABLE floating_penalty_ledger_entries ENABLE TRIGGER USER`,
    `ALTER TABLE audit_logs DISABLE TRIGGER USER; UPDATE audit_logs SET entity_id='nonexistent-loan-public-id' WHERE id=(SELECT min(id) FROM audit_logs WHERE action='floating_penalty_ledger_migrated'); ALTER TABLE audit_logs ENABLE TRIGGER USER`,
  ];
  for (const mutation of mutations) {
    await resetMixedLineage();
    const applied = Bun.spawnSync(["bun", "run", "scripts/reconcile-production-mixed-lineage.ts", "--apply"], { cwd: root, env: { ...process.env, DATABASE_URL: databaseUrl! }, stdout: "pipe", stderr: "pipe" });
    expect(applied.exitCode, new TextDecoder().decode(applied.stderr)).toBe(0);
    await sql.unsafe(mutation);
    const result = Bun.spawnSync(["bun", "run", "scripts/reconcile-production-mixed-lineage.ts"], { cwd: root, env: { ...process.env, DATABASE_URL: databaseUrl! }, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).not.toBe(0);
    expect(new TextDecoder().decode(result.stderr)).toContain("0030 completed ledger/audit content is not exact");
  }
}, 30_000);

integration("fault injection rolls back journal, quarantine, and DDL", async () => {
  for (const boundary of [1, 120, 200]) {
    await resetMixedLineage();
    const result = Bun.spawnSync(["bun", "run", "scripts/reconcile-production-mixed-lineage.ts", "--apply"], { cwd: root, env: { ...process.env, DATABASE_URL: databaseUrl!, RECONCILE_FAIL_AFTER_STATEMENT: String(boundary) }, stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode).not.toBe(0);
    expect(Number((await sql`SELECT count(*) AS n FROM drizzle.__drizzle_migrations`)[0]!.n)).toBe(30);
    expect((await sql`SELECT to_regclass('public.intermediary_bank_accounts') IS NOT NULL AS exists`)[0]!.exists).toBe(true);
    expect((await sql`SELECT to_regclass('creditsync_quarantine.intermediary_bank_accounts') IS NOT NULL AS exists`)[0]!.exists).toBe(false);
  }
}, 15_000);

integration("an inconsistent paid cache fails at the targeted constraint drain and rolls back everything", async () => {
  await resetMixedLineage();
  const result = Bun.spawnSync(["bun", "run", "scripts/reconcile-production-mixed-lineage.ts", "--apply"], { cwd: root, env: { ...process.env, NODE_ENV: "test", RECONCILE_TEST_CORRUPT_PAID_CACHE_BEFORE_DRAIN: "1", DATABASE_URL: databaseUrl! }, stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode).not.toBe(0);
  expect(new TextDecoder().decode(result.stderr)).toContain("paid_amount cache does not match floating interest allocations");
  expect(Number((await sql`SELECT count(*) AS n FROM drizzle.__drizzle_migrations`)[0]!.n)).toBe(30);
  expect((await sql`SELECT to_regclass('public.intermediary_bank_accounts') IS NOT NULL AS exists`)[0]!.exists).toBe(true);
  expect((await sql`SELECT to_regclass('creditsync_quarantine.intermediary_bank_accounts') IS NOT NULL AS exists`)[0]!.exists).toBe(false);
});

integration("the pinned drain is required to avoid PostgreSQL pending trigger events", async () => {
  await resetMixedLineage();
  const result = Bun.spawnSync(["bun", "run", "scripts/reconcile-production-mixed-lineage.ts", "--apply"], { cwd: root, env: { ...process.env, NODE_ENV: "test", RECONCILE_TEST_SKIP_CONSTRAINT_DRAIN: "1", DATABASE_URL: databaseUrl! }, stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode).not.toBe(0);
  expect(new TextDecoder().decode(result.stderr)).toContain("pending trigger events");
  expect(Number((await sql`SELECT count(*) AS n FROM drizzle.__drizzle_migrations`)[0]!.n)).toBe(30);
  expect((await sql`SELECT to_regclass('public.intermediary_bank_accounts') IS NOT NULL AS exists`)[0]!.exists).toBe(true);
  expect((await sql`SELECT to_regclass('creditsync_quarantine.intermediary_bank_accounts') IS NOT NULL AS exists`)[0]!.exists).toBe(false);
});
