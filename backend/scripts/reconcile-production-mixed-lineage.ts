import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";

const root = new URL("../", import.meta.url).pathname;
const newTables = ["loan_restructures", "loan_opening_balance_components", "loan_restructure_waivers", "floating_penalty_ledger_entries", "floating_transaction_allocations", "loan_waiver_previews", "intermediary_bank_accounts", "intermediated_disbursement_group_previews", "intermediated_disbursement_groups", "intermediated_transfer_events", "intermediated_transfer_evidence", "intermediated_transfer_evidence_intents", "loan_intermediary_assignments", "loan_settlement_previews"] as const;
const postEmptyTables = newTables.filter((table) => table !== "floating_penalty_ledger_entries" && table !== "floating_transaction_allocations");
const catalogTables40 = [...newTables, "loans", "loan_interest_accruals", "loan_interest_rate_periods", "loan_disbursement_events", "loan_schedules", "transactions", "audit_logs"] as const;
const catalogTables42 = [...catalogTables40, "borrower_id_card_upload_intents"] as const;
const catalogTables53 = [...catalogTables42, "loan_replacements", "loan_replacement_corrections", "payment_intakes", "payment_reconciliation_proposals", "payment_reconciliation_groups", "payment_reconciliation_entries", "floating_penalty_ledger_entries", "floating_transaction_allocations"] as const;
const authoritativeCatalogSha25640 = "c08f69e551d54c803064261ad6b253899ce26979a0266b688565631f54ddc3d7";
const authoritativeCatalogSha25642 = "0fb05cff74c00051375725b39612f0b100ee87cf891c9e30c1ca24104f017f1a";
const authoritativeCatalogSha25653 = "8e89adf49b98ceab0e1da40f05c979cf7a88fd1f8b158d5eaf2bdc1e4d87194c";
const legacyCatalogSha256Public = "b6e6ea2666b1e3ea92726b22131db420e74221947a43f493aaaa68fdd2f6dacb";
const legacyCatalogSha256Quarantine = "2fb8cfa9272876a6668d6dd6cdaa97d8e54332df2f82ae1f502227ee5d3399f9";
const inboundFk = "intermediary_compensation_settlements_tenant_destination_fk";
const apply = process.argv.includes("--apply");
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const expectedShape = { floatingLoans: 5, ratePeriods: 5, accruals: 50, dueGroups: 43, disbursements: 10, allocations: 8, previews: 2 } as const;

type ManifestEntry = { idx: number; tag: string; when: number; hash: string };
const authoritative: ManifestEntry[] = [
  [27, "0027_single_payment_restructure", 1786698000000, "8c27192d3c621f990886a984c7c559bf14d4fe461f40f0988d9e188f92ac8c40"],
  [28, "0028_floating_weekly_period_snapshots", 1786698060000, "37b066173ebfe4688f68dfff81d79c5fcfa9955428e86a219c93194b62bd59b5"],
  [29, "0029_floating_penalty_snapshots", 1786698120000, "888cebc1338add134666299dae8de32bb7743c24c6e5072850810abd548bb10b"],
  [30, "0030_floating_penalty_ledger", 1786698180000, "75075b3514b429aab3be538ad1ae7a11d43083f908e25ca354a020863da3a9d4"],
  [31, "0031_loan_waiver_previews", 1786666687343, "481f291802947742537c40a327427b7ed047b45f4d90eca769731f9877b3804f"],
  [32, "0032_restructure_external_credit_allocation", 1786667618275, "2fe7dc33d08138d4c7258a79af41c4c2b9e60c4f91c284aa5b6f4b970944af1d"],
  [33, "0033_early_settlement_waiver_scope", 1786667764416, "64888da4a6064537514b7cb18badb2d6bd5fe4784630400d846b58cab5ddba25"],
  [34, "0034_waiver_schedule_provenance", 1786698900000, "f760c242234bd58d035ef9f4d61b43dca7857f81475de8e75630edcf1de5c8ab"],
  [35, "0035_disbursement_restructure_relation", 1786701600000, "39c5688bd53fdf3bb2603481f63b29e72c8d4d427b6d2ceb0c4664bcae78ffde"],
  [36, "0036_floating_weekly_intermediary_integration", 1786701660000, "f2668bcdcf5a46dac78f44762adbfdda46771cee9b2e5b4457ba8eb91598a64c"],
].map(([idx, tag, when, hash]) => ({ idx, tag, when, hash }));

const pendingTail = [
  ["0a72edb73c76b820f026b7389873cb441cc5f7d8ac2a81e9585131d9da866d2c", 1786485015063],
  ["73f1803d9c83df434746a58a82e5d180899071971b0d22fe45e23fa7bb7dfc81", 1786486095512],
  ["89925581f81bcafd3b9788fabccaffc1251261eca2e13522a9de6d6dcdf28c4a", 1786540800000],
  ["cd43d16ea7fe5c42d04624fe8bf7570871c504c9dda3cb88722a8c1097070427", 1786593600000],
] as const;
const stock = [
  ["31369ff9c020da13975cd5c1dfa1d04572b77546a66066c6ae20af9c44395839", 1786713592281],
  ["c0e3eb5f0e52595cd37d744a50faa0ec37a2ca87f302674597225773ca1e854a", 1786713600000],
] as const;

function statements(sql: string) { return sql.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean); }
function sha256(value: string) { return createHash("sha256").update(value).digest("hex"); }

async function catalogFingerprint(tx: postgres.TransactionSql, tables: readonly string[], schema = "public") {
  const rows = await tx.unsafe<{ item: string }[]>(`
    WITH selected AS (SELECT c.oid,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$2 AND c.relname = ANY($1::text[])), items AS (
      SELECT 'column|'||s.relname||'|'||a.attnum||'|'||a.attname||'|'||format_type(a.atttypid,a.atttypmod)||'|'||a.attnotnull||'|'||COALESCE(pg_get_expr(d.adbin,d.adrelid),'') AS item FROM selected s JOIN pg_attribute a ON a.attrelid=s.oid LEFT JOIN pg_attrdef d ON d.adrelid=s.oid AND d.adnum=a.attnum WHERE a.attnum>0 AND NOT a.attisdropped
      UNION ALL SELECT 'constraint|'||s.relname||'|'||c.conname||'|'||c.contype::text||'|'||c.convalidated||'|'||array_to_string(c.conkey,',')||'|'||COALESCE(c.confrelid::regclass::text,'')||'|'||COALESCE(array_to_string(c.confkey,','),'')||'|'||pg_get_constraintdef(c.oid,true) FROM selected s JOIN pg_constraint c ON c.conrelid=s.oid
      UNION ALL SELECT 'index|'||s.relname||'|'||i.relname||'|'||am.amname||'|'||x.indisunique||'|'||x.indisvalid||'|'||x.indisready||'|'||x.indnkeyatts||'|'||x.indnatts||'|'||array_to_string(x.indkey,',')||'|'||COALESCE(pg_get_expr(x.indpred,x.indrelid),'')||'|'||pg_get_indexdef(i.oid) FROM selected s JOIN pg_index x ON x.indrelid=s.oid JOIN pg_class i ON i.oid=x.indexrelid JOIN pg_am am ON am.oid=i.relam
      UNION ALL SELECT 'trigger|'||s.relname||'|'||t.tgname||'|'||t.tgenabled::text||'|'||t.tgtype||'|'||p.oid::regprocedure::text||'|'||pg_get_triggerdef(t.oid,true) FROM selected s JOIN pg_trigger t ON t.tgrelid=s.oid JOIN pg_proc p ON p.oid=t.tgfoid WHERE NOT t.tgisinternal
      UNION ALL SELECT 'function|'||p.oid::regprocedure::text||'|'||pg_get_functiondef(p.oid) FROM pg_proc p WHERE p.oid IN (SELECT DISTINCT t.tgfoid FROM selected s JOIN pg_trigger t ON t.tgrelid=s.oid WHERE NOT t.tgisinternal)
      UNION ALL SELECT 'sequence|'||sn.nspname||'.'||seq.relname||'|'||s.relname||'|'||a.attname||'|'||format_type(a.atttypid,a.atttypmod)||'|'||COALESCE(pg_get_expr(ad.adbin,ad.adrelid),'')||'|'||ps.seqincrement||'|'||ps.seqmin||'|'||ps.seqmax||'|'||ps.seqstart||'|'||ps.seqcache||'|'||ps.seqcycle FROM selected s JOIN pg_attribute a ON a.attrelid=s.oid AND a.attnum>0 JOIN pg_depend dep ON dep.refobjid=s.oid AND dep.refobjsubid=a.attnum AND dep.deptype='a' JOIN pg_class seq ON seq.oid=dep.objid AND seq.relkind='S' JOIN pg_namespace sn ON sn.oid=seq.relnamespace JOIN pg_sequence ps ON ps.seqrelid=seq.oid LEFT JOIN pg_attrdef ad ON ad.adrelid=s.oid AND ad.adnum=a.attnum
    ) SELECT item FROM items ORDER BY item`, [tables, schema]);
  return sha256(rows.map((row) => row.item).join("\n"));
}

async function expectedPending() {
  const journal = await Bun.file(`${root}drizzle/meta/_journal.json`).json() as { entries: Array<{ tag: string; when: number }> };
  const base = await Promise.all(journal.entries.slice(0, 26).map(async (entry) => [sha256(await readFile(`${root}drizzle/${entry.tag}.sql`, "utf8")), entry.when] as const));
  return [...base, ...pendingTail];
}

async function expectedForwardTail() {
  const journal = await Bun.file(`${root}drizzle/meta/_journal.json`).json() as { entries: Array<{ idx: number; tag: string; when: number }> };
  return Promise.all(journal.entries.filter((entry) => entry.idx >= 39).map(async (entry) => [sha256(await readFile(`${root}drizzle/${entry.tag}.sql`, "utf8")), entry.when] as const));
}

async function verifyLegacyCatalog(tx: postgres.TransactionSql, relation: string) {
  const schema = relation.split(".")[0]!;
  const fingerprint = await catalogFingerprint(tx, ["intermediary_bank_accounts"], schema);
  const expected = schema === "public" ? legacyCatalogSha256Public : legacyCatalogSha256Quarantine;
  if (fingerprint !== expected) throw new Error(`legacy catalog fingerprint mismatch: ${schema}:${fingerprint}`);
  const inbound = await tx.unsafe<{ n: string }[]>(`SELECT count(*) AS n FROM pg_constraint c WHERE c.confrelid=$1::regclass AND c.conname=$2 AND c.contype='f' AND c.convalidated AND c.confupdtype='a' AND c.confdeltype='a' AND c.confmatchtype='s' AND (SELECT array_agg(a.attname ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(attnum,ord) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum)=ARRAY['tenant_id','destination_account_id']::name[] AND (SELECT array_agg(a.attname ORDER BY k.ord) FROM unnest(c.confkey) WITH ORDINALITY k(attnum,ord) JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.attnum)=ARRAY['tenant_id','id']::name[] AND c.conrelid='public.intermediary_compensation_settlements'::regclass`, [relation, inboundFk]);
  if (Number(inbound[0]!.n) !== 1) throw new Error("legacy dependent FK definition is not exact");
  const sequence = await tx.unsafe<{ n: string }[]>(`SELECT count(*) AS n FROM pg_depend d JOIN pg_class s ON s.oid=d.objid JOIN pg_namespace sn ON sn.oid=s.relnamespace JOIN pg_class t ON t.oid=d.refobjid JOIN pg_namespace tn ON tn.oid=t.relnamespace WHERE t.oid=$1::regclass AND s.relkind='S' AND d.deptype='a' AND sn.nspname=tn.nspname AND s.relname='intermediary_bank_accounts_id_seq'`, [relation]);
  if (Number(sequence[0]!.n) !== 1) throw new Error("legacy owned sequence identity/schema is not exact");
}

async function verifyQuarantineSchema(tx: postgres.TransactionSql) {
  const rows = await tx<{ owner_ok: boolean; non_owner_privileges: string; objects: string[] }[]>`SELECT n.nspowner=(SELECT usesysid FROM pg_user WHERE usename=current_user) AS owner_ok, (SELECT count(*) FROM aclexplode(COALESCE(n.nspacl,acldefault('n',n.nspowner))) WHERE grantee<>n.nspowner)::text AS non_owner_privileges, ARRAY(SELECT c.relname FROM pg_class c WHERE c.relnamespace=n.oid ORDER BY c.relname) AS objects FROM pg_namespace n WHERE n.nspname='creditsync_quarantine'`;
  const row = rows[0];
  const objects = ["intermediary_bank_accounts", "intermediary_bank_accounts_active_fingerprint_unique", "intermediary_bank_accounts_id_seq", "intermediary_bank_accounts_pkey", "intermediary_bank_accounts_public_id_unique", "intermediary_bank_accounts_tenant_id_id_unique"];
  if (!row?.owner_ok || Number(row.non_owner_privileges)!==0 || JSON.stringify(row.objects)!==JSON.stringify(objects)) throw new Error("quarantine schema owner/ACL/contents are not exact");
}

async function verify0030Completed(tx: postgres.TransactionSql) {
  const rows = await tx<{ cutovers: string; snapshots: string; audits: string; distinct_dates: string; mismatch: string; invalid_audits: string }[]>`
    WITH cutoff AS (
      SELECT min(penalty_date) AS cutover_date, count(DISTINCT penalty_date) AS distinct_dates FROM floating_penalty_ledger_entries WHERE entry_type='legacy_cutover'
    ), expected_cutovers AS (
      SELECT l.tenant_id,l.id AS loan_id,c.cutover_date AS due_date,c.cutover_date AS penalty_date,0::numeric AS amount,0::numeric AS opening_interest_basis,'none'::text AS late_fee_mode,0::numeric AS late_fee_value,0 AS grace_period_days,
        'Marks the exact Bangkok cutover from legacy floating penalty state'::text AS reason,'floating-penalty-cutover-0030:'||l.public_id::text AS idempotency_key,'floating-penalty-ledger-migration-0030'::text AS request_id,'floating-penalty-ledger-migration-0030:'||l.public_id::text AS correlation_id,a.public_id AS audit_public_id,'system'::text AS actor_source,NULL::integer AS created_by_user_id,NULL::integer AS source_transaction_id
      FROM loans l CROSS JOIN cutoff c JOIN audit_logs a ON a.tenant_id=l.tenant_id AND a.correlation_id='floating-penalty-ledger-migration-0030:'||l.public_id::text WHERE l.repayment_type='floating'
    ), grouped AS (
      SELECT a.tenant_id,a.loan_id,a.accrual_date AS due_date,SUM(GREATEST(a.interest_amount-a.paid_amount,0)) AS unpaid_interest,SUM(a.accrued_penalty) AS stored_penalty FROM loan_interest_accruals a JOIN loans l ON l.tenant_id=a.tenant_id AND l.id=a.loan_id WHERE l.repayment_type='floating' AND a.status<>'reversed' GROUP BY 1,2,3
    ), expected_snapshots AS (
      SELECT g.tenant_id,g.loan_id,g.due_date,c.cutover_date AS penalty_date,GREATEST(g.stored_penalty,ROUND(CASE WHEN g.unpaid_interest<=0 OR c.cutover_date-g.due_date-GREATEST(COALESCE(l.grace_period_days,0),0)<=0 THEN 0 ELSE CASE WHEN COALESCE(l.late_fee_mode,'none') IN ('fixed','fixed_plus_percent') THEN COALESCE(l.late_fee_amount,0) ELSE 0 END + CASE WHEN COALESCE(l.late_fee_mode,'none') IN ('daily_percent','fixed_plus_percent') THEN g.unpaid_interest*COALESCE(l.late_fee_amount,0)/100*(c.cutover_date-g.due_date-GREATEST(COALESCE(l.grace_period_days,0),0)) ELSE 0 END END,2)) AS amount,g.unpaid_interest AS opening_interest_basis,COALESCE(l.late_fee_mode,'none') AS late_fee_mode,COALESCE(l.late_fee_amount,0) AS late_fee_value,GREATEST(COALESCE(l.grace_period_days,0),0) AS grace_period_days,
        'Migrated exact legacy floating penalty state at the Bangkok cutover'::text AS reason,'floating-penalty-snapshot-0030:'||l.public_id::text||':'||g.due_date::text AS idempotency_key,'floating-penalty-ledger-migration-0030'::text AS request_id,'floating-penalty-ledger-migration-0030:'||l.public_id::text AS correlation_id,audit.public_id AS audit_public_id,'system'::text AS actor_source,NULL::integer AS created_by_user_id,NULL::integer AS source_transaction_id
      FROM grouped g JOIN loans l ON l.tenant_id=g.tenant_id AND l.id=g.loan_id CROSS JOIN cutoff c JOIN audit_logs audit ON audit.tenant_id=l.tenant_id AND audit.correlation_id='floating-penalty-ledger-migration-0030:'||l.public_id::text
    ), actual AS (
      SELECT tenant_id,loan_id,due_date,penalty_date,amount,opening_interest_basis,late_fee_mode,late_fee_value,grace_period_days,reason,idempotency_key,request_id,correlation_id,audit_public_id,actor_source,created_by_user_id,source_transaction_id,entry_type FROM floating_penalty_ledger_entries WHERE entry_type IN ('legacy_cutover','legacy_snapshot')
    ), expected_all AS (
      SELECT *, 'legacy_cutover'::text AS entry_type FROM expected_cutovers UNION ALL SELECT *, 'legacy_snapshot'::text AS entry_type FROM expected_snapshots
    ), mismatch_rows AS (
      (SELECT * FROM expected_all EXCEPT SELECT * FROM actual) UNION ALL (SELECT * FROM actual EXCEPT SELECT * FROM expected_all)
    )
    SELECT (SELECT count(*) FROM actual WHERE entry_type='legacy_cutover') AS cutovers,(SELECT count(*) FROM actual WHERE entry_type='legacy_snapshot') AS snapshots,(SELECT count(*) FROM audit_logs WHERE action='floating_penalty_ledger_migrated' AND request_id='floating-penalty-ledger-migration-0030') AS audits,(SELECT distinct_dates FROM cutoff) AS distinct_dates,(SELECT count(*) FROM mismatch_rows) AS mismatch,
      (SELECT count(*) FROM audit_logs a LEFT JOIN loans l ON l.tenant_id=a.tenant_id AND a.entity_id=l.public_id::text WHERE a.action='floating_penalty_ledger_migrated' AND a.request_id='floating-penalty-ledger-migration-0030' AND (l.id IS NULL OR l.repayment_type<>'floating' OR a.entity_type<>'loan' OR a.actor_source<>'system' OR a.correlation_id IS DISTINCT FROM 'floating-penalty-ledger-migration-0030:'||l.public_id::text OR a.payload IS DISTINCT FROM '{"source":"legacy_floating_settlement_state"}'::jsonb)) AS invalid_audits`;
  const row = rows[0]!;
  if (Number(row.cutovers)!==5 || Number(row.snapshots)!==43 || Number(row.audits)!==5 || Number(row.distinct_dates)!==1 || Number(row.mismatch)!==0 || Number(row.invalid_audits)!==0) throw new Error(`0030 completed ledger/audit content is not exact: ${JSON.stringify(row)}`);
}

async function verifyCatalogAndData(tx: postgres.TransactionSql, journalCount: 40 | 42 | 53 | 54 | 57 | 58, compareCaptured = false) {
  await verifyLegacyCatalog(tx, "creditsync_quarantine.intermediary_bank_accounts");
  await verifyQuarantineSchema(tx);
  await verify0030Completed(tx);
  const catalog = await catalogFingerprint(tx, journalCount === 40 ? catalogTables40 : journalCount === 42 ? catalogTables42 : catalogTables53);
  const expectedCatalog = journalCount === 40 ? authoritativeCatalogSha25640 : journalCount === 42 ? authoritativeCatalogSha25642 : authoritativeCatalogSha25653;
  if (catalog !== expectedCatalog) throw new Error(`authoritative catalog fingerprint mismatch: ${catalog}`);
  for (const table of postEmptyTables) {
    const rows = await tx.unsafe<{ n: string }[]>(`SELECT count(*) AS n FROM public."${table}"`);
    if (Number(rows[0]!.n) !== 0) throw new Error(`new table is not empty: ${table}`);
  }
  const disbursements = await tx<{ n: string }[]>`SELECT count(*) AS n FROM loan_disbursement_events`;
  const allocations = await tx<{ n: string }[]>`SELECT count(*) AS n FROM loan_funding_allocations`;
  const previewRelation = await tx<{ relation: string | null }[]>`SELECT to_regclass('public.loan_funding_previews')::text AS relation`;
  const previews = previewRelation[0]?.relation ? await tx.unsafe<{ n: string }[]>(`SELECT count(*) AS n FROM public.loan_funding_previews`) : [{ n: "0" }];
  const settlementPreviews = await tx<{ n: string }[]>`SELECT count(*) AS n FROM loan_settlement_previews`;
  if (Number(settlementPreviews[0]!.n) !== 0) throw new Error("new loan_settlement_previews is not empty");
  if (Number(disbursements[0]!.n)!==expectedShape.disbursements || Number(allocations[0]!.n)!==expectedShape.allocations || Number(previews[0]!.n)!==expectedShape.previews) throw new Error("preserved production 10/8/2 cardinalities are not exact");
  if (compareCaptured) {
    const captured = await tx<{ disbursements: string; allocations: string; previews: string }[]>`SELECT disbursements, allocations, previews FROM reconcile_preserved_counts`;
    if (!captured[0] || Number(disbursements[0]!.n) !== Number(captured[0].disbursements) || Number(allocations[0]!.n) !== Number(captured[0].allocations) || Number(previews[0]!.n) !== Number(captured[0].previews)) throw new Error("preserved funding counts changed");
  }
  const disbursementColumns = await tx<{ exists: boolean }[]>`SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='loan_disbursement_events' AND column_name='restructure_id') AS exists`;
  if (disbursementColumns[0]?.exists) {
    const linked = await tx<{ n: string }[]>`SELECT count(*) AS n FROM loan_disbursement_events WHERE restructure_id IS NOT NULL`;
    if (Number(linked[0]!.n) !== 0) throw new Error("existing disbursement rows were linked to a restructure");
  }
  const backfill = await tx<{ n: string }[]>`SELECT count(*) AS n FROM loan_interest_accruals WHERE period_start_date IS NOT NULL AND (period_end_date IS NULL OR period_end_date <> accrual_date + 1)`;
  if (Number(backfill[0]!.n) !== 0) throw new Error("0036 period-end backfill is not exact");
  const projections = await tx<{ floating_loans: string; rate_periods: string; accruals: string; invalid_loans: string; invalid_periods: string; invalid_accruals: string }[]>`
    SELECT
      (SELECT count(*) FROM loans WHERE repayment_type='floating') AS floating_loans,
      (SELECT count(*) FROM loan_interest_rate_periods) AS rate_periods,
      (SELECT count(*) FROM loan_interest_accruals) AS accruals,
      (SELECT count(*) FROM loans WHERE repayment_type='floating' AND (daily_interest_mode NOT IN ('percent','per_thousand') OR daily_interest_mode IS NULL OR daily_interest_rate IS NULL OR COALESCE(interest_start_date,start_date) IS NULL OR
        interest_period_unit IS DISTINCT FROM CASE floating_accrual_cycle WHEN 'weekly' THEN 'week' ELSE 'day' END OR interest_period_length IS DISTINCT FROM 1 OR advance_interest_periods IS DISTINCT FROM CASE WHEN first_day_treatment='deduct' THEN 1 ELSE 0 END OR advance_interest_refund_policy IS DISTINCT FROM 'non_refundable' OR interest_period_anchor_date IS DISTINCT FROM COALESCE(interest_start_date,start_date))) AS invalid_loans,
      (SELECT count(*) FROM loan_interest_rate_periods r JOIN loans l ON l.tenant_id=r.tenant_id AND l.id=r.loan_id WHERE r.period_unit IS DISTINCT FROM CASE l.floating_accrual_cycle WHEN 'weekly' THEN 'week' ELSE 'day' END OR r.period_length IS DISTINCT FROM 1) AS invalid_periods,
      (SELECT count(*) FROM loan_interest_accruals a WHERE a.period_start_date IS DISTINCT FROM a.accrual_date OR a.period_end_date IS DISTINCT FROM a.accrual_date + 1 OR a.period_day_index IS DISTINCT FROM 1 OR a.period_days IS DISTINCT FROM 1 OR a.period_length IS DISTINCT FROM 1 OR a.period_unit IS DISTINCT FROM 'day' OR a.cumulative_interest_amount IS DISTINCT FROM a.interest_amount OR a.contractual_interest_amount IS DISTINCT FROM CASE a.rate_mode WHEN 'percent' THEN round(a.opening_principal*a.rate/100,2) WHEN 'per_thousand' THEN round(a.opening_principal*a.rate/1000,2) ELSE a.interest_amount END OR a.daily_increment_amount IS DISTINCT FROM a.interest_amount) AS invalid_accruals`;
  const p = projections[0]!;
  if (Number(p.floating_loans) !== expectedShape.floatingLoans || Number(p.rate_periods) !== expectedShape.ratePeriods || Number(p.accruals) !== expectedShape.accruals || Number(p.invalid_loans) || Number(p.invalid_periods) || Number(p.invalid_accruals)) throw new Error("0036 exact 5/5/50 projection is not exact");
  const trigger = await tx<{ n: string }[]>`SELECT count(*) AS n FROM pg_trigger WHERE tgrelid='public.loan_interest_accruals'::regclass AND tgname='loan_interest_accruals_history_immutable' AND NOT tgisinternal`;
  if (Number(trigger[0]!.n) !== 0) throw new Error("old accrual trigger remains");
}

const preflightDo = `DO $$
DECLARE old_oid oid; inbound integer;
BEGIN
  IF to_regclass('public.intermediary_bank_accounts') IS NULL AND to_regclass('creditsync_quarantine.intermediary_bank_accounts') IS NULL THEN
    RAISE EXCEPTION 'mixed-lineage preflight: quarantine table missing';
  END IF;
  old_oid := COALESCE(to_regclass('public.intermediary_bank_accounts'), to_regclass('creditsync_quarantine.intermediary_bank_accounts'));
  SELECT count(*) INTO inbound FROM pg_constraint WHERE confrelid = old_oid AND conname = 'intermediary_compensation_settlements_tenant_destination_fk';
  IF inbound <> 1 THEN RAISE EXCEPTION 'mixed-lineage preflight: dependent FK/OID mismatch'; END IF;
END $$;`;

const postflightDo = `DO $$
DECLARE c integer; n integer;
BEGIN
  SELECT count(*) INTO c FROM pg_constraint WHERE conrelid = 'public.loan_interest_accruals'::regclass AND conname = 'loan_interest_accruals_period_date_order_check';
  IF c <> 1 THEN RAISE EXCEPTION 'mixed-lineage postflight: normalized accrual catalog mismatch'; END IF;
  SELECT count(*) INTO n FROM pg_trigger WHERE tgrelid = 'public.loan_interest_accruals'::regclass AND tgname = 'loan_interest_accruals_history_immutable' AND NOT tgisinternal;
  IF n <> 0 THEN RAISE EXCEPTION 'mixed-lineage postflight: old trigger remains'; END IF;
END $$;`;

async function run() {
  const sql = postgres(databaseUrl!, { max: 1 });
  try {
    const result = await sql.begin(async (tx) => {
      await tx.unsafe("SELECT pg_advisory_xact_lock(hashtextextended('creditsync:production-mixed-lineage', 0))");
      await tx.unsafe(`LOCK TABLE audit_logs, bank_profiles, borrowers, drizzle.__drizzle_migrations, files, intermediaries, intermediary_compensation_settlements, public.intermediary_bank_accounts, loan_disbursement_events, loan_funding_allocations, loan_funding_previews, loan_interest_accruals, loan_interest_rate_periods, loan_schedules, loans, transactions, users IN ACCESS EXCLUSIVE MODE`);
      const journal = await tx<{ hash: string; created_at: string }[]>`SELECT hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`;
      const count = journal.length;
       if (![30, 40, 42, 53, 54, 57, 58, 60].includes(count)) throw new Error(`mixed-lineage state is not exact: ${count} journal rows`);
      const pending = await expectedPending();
      const authoritativeRows = authoritative.map((entry) => [entry.hash, entry.when] as const);
      const forwardTail = count >= 53 ? (await expectedForwardTail()).slice(0, count - 42) : [];
      const expected = count === 30 ? pending : count === 40 ? [...pending, ...authoritativeRows] : [...pending, ...authoritativeRows, ...stock, ...forwardTail];
      if (expected.length !== count) throw new Error("internal journal manifest length mismatch");
      if (journal.some((row, i) => row.hash !== expected[i]![0] || Number(row.created_at) !== expected[i]![1])) throw new Error("mixed-lineage journal tuple array is not exact");
      if ([40, 42, 53, 54, 57, 58, 60].includes(count)) { await verifyCatalogAndData(tx, (count === 60 ? 58 : count) as 40 | 42 | 53 | 54 | 57 | 58); return "already-complete"; }
      await tx.unsafe(preflightDo);
      await verifyLegacyCatalog(tx, "public.intermediary_bank_accounts");
      const quarantine = await tx<{ relation: string | null }[]>`SELECT to_regclass('creditsync_quarantine.intermediary_bank_accounts')::text AS relation`;
      if (quarantine[0]?.relation) throw new Error("mixed-lineage preflight: quarantine target already exists");
      const quarantineSchema = await tx<{ exists: boolean }[]>`SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname='creditsync_quarantine') AS exists`;
      if (quarantineSchema[0]!.exists) throw new Error("mixed-lineage preflight: quarantine schema already exists");
      for (const table of newTables) {
        if (table === "intermediary_bank_accounts") continue;
        const relation = await tx<{ relation: string | null }[]>`SELECT to_regclass(${`public.${table}`})::text AS relation`;
        if (relation[0]?.relation) throw new Error(`mixed-lineage preflight: authoritative target already exists: ${table}`);
      }
      const legacyRows = await tx<{ n: string }[]>`SELECT count(*) AS n FROM public.intermediary_bank_accounts`;
      const compensationRows = await tx<{ n: string }[]>`SELECT count(*) AS n FROM public.intermediary_compensation_settlements`;
      if (Number(legacyRows[0]!.n) !== 0 || Number(compensationRows[0]!.n) !== 0) throw new Error("mixed-lineage preflight: legacy collision tables must be empty");
      const shape = await tx<{ floating_loans: string; rate_periods: string; accruals: string; disbursements: string; allocations: string; previews: string }[]>`
        SELECT (SELECT count(*) FROM loans WHERE repayment_type='floating') AS floating_loans,
          (SELECT count(*) FROM loan_interest_rate_periods) AS rate_periods,
          (SELECT count(*) FROM loan_interest_accruals) AS accruals,
          (SELECT count(*) FROM loan_disbursement_events) AS disbursements,
          (SELECT count(*) FROM loan_funding_allocations) AS allocations,
          (SELECT count(*) FROM loan_funding_previews) AS previews`;
      const s = shape[0]!;
      if (Number(s.floating_loans)!==expectedShape.floatingLoans || Number(s.rate_periods)!==expectedShape.ratePeriods || Number(s.accruals)!==expectedShape.accruals || Number(s.disbursements)!==expectedShape.disbursements || Number(s.allocations)!==expectedShape.allocations || Number(s.previews)!==expectedShape.previews) throw new Error("mixed-lineage preflight: production cardinality fingerprint is not exact");
      if (!apply) return "dry-run-approved";

      await tx.unsafe("CREATE TEMP TABLE reconcile_preserved_counts (disbursements bigint NOT NULL, allocations bigint NOT NULL, previews bigint NOT NULL) ON COMMIT DROP");
      await tx.unsafe("CREATE TEMP TABLE reconcile_legacy_identity AS SELECT c.oid AS table_oid, c.relfilenode, (SELECT count(*) FROM public.intermediary_bank_accounts) AS row_count FROM pg_class c WHERE c.oid='public.intermediary_bank_accounts'::regclass");
      const fundingPreviewRelation = await tx<{ relation: string | null }[]>`SELECT to_regclass('public.loan_funding_previews')::text AS relation`;
      const fundingPreviewCount = fundingPreviewRelation[0]?.relation ? Number((await tx.unsafe<{ n: string }[]>("SELECT count(*) AS n FROM public.loan_funding_previews"))[0]!.n) : 0;
      await tx`INSERT INTO reconcile_preserved_counts VALUES (${0}, ${0}, ${fundingPreviewCount})`;
      await tx.unsafe("UPDATE reconcile_preserved_counts SET disbursements=(SELECT count(*) FROM loan_disbursement_events), allocations=(SELECT count(*) FROM loan_funding_allocations)");

      await tx.unsafe("CREATE SCHEMA creditsync_quarantine AUTHORIZATION CURRENT_USER");
      await tx.unsafe("REVOKE ALL ON SCHEMA creditsync_quarantine FROM PUBLIC");
      await tx.unsafe("ALTER TABLE public.intermediary_bank_accounts SET SCHEMA creditsync_quarantine");
      const identity = await tx<{ exact: boolean }[]>`SELECT q.oid=i.table_oid AND q.relfilenode=i.relfilenode AND (SELECT count(*) FROM creditsync_quarantine.intermediary_bank_accounts)=i.row_count AS exact FROM reconcile_legacy_identity i CROSS JOIN pg_class q WHERE q.oid='creditsync_quarantine.intermediary_bank_accounts'::regclass`;
      if (identity.length !== 1 || !identity[0]!.exact) throw new Error("legacy quarantine identity changed");
      await verifyLegacyCatalog(tx, "creditsync_quarantine.intermediary_bank_accounts");
      await verifyQuarantineSchema(tx);

      let statementNumber = 0;
      for (const entry of authoritative) {
        const content = await readFile(`${root}drizzle/${entry.tag}.sql`, "utf8");
        if (sha256(content) !== entry.hash) throw new Error(`immutable migration hash mismatch: ${entry.tag}`);
        if (entry.idx === 30) {
          await tx.unsafe(`CREATE TEMP TABLE reconcile_0030_expected_loans AS SELECT tenant_id,id AS loan_id,public_id,(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Bangkok')::date AS due_date,('floating-penalty-cutover-0030:'||public_id::text) AS idempotency_key,('floating-penalty-ledger-migration-0030:'||public_id::text) AS correlation_id FROM loans WHERE repayment_type='floating'`);
          await tx.unsafe(`CREATE TEMP TABLE reconcile_0030_expected_groups ON COMMIT DROP AS
            WITH grouped AS (SELECT a.tenant_id,a.loan_id,COALESCE(a.period_end_date,a.accrual_date) AS due_date,SUM(GREATEST(a.interest_amount-a.paid_amount,0)) AS unpaid_interest,SUM(a.accrued_penalty) AS stored_penalty FROM loan_interest_accruals a JOIN loans l ON l.tenant_id=a.tenant_id AND l.id=a.loan_id WHERE l.repayment_type='floating' AND a.status<>'reversed' GROUP BY 1,2,3), exact_state AS
            (SELECT g.*,l.public_id AS loan_public_id,COALESCE(l.late_fee_mode,'none') AS late_fee_mode,COALESCE(l.late_fee_amount,0) AS late_fee_value,GREATEST(COALESCE(l.grace_period_days,0),0) AS grace_period_days,GREATEST(0,(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Bangkok')::date-g.due_date-GREATEST(COALESCE(l.grace_period_days,0),0)) AS overdue_days FROM grouped g JOIN loans l ON l.tenant_id=g.tenant_id AND l.id=g.loan_id)
            SELECT tenant_id,loan_id,due_date,(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Bangkok')::date AS penalty_date,GREATEST(stored_penalty,ROUND(CASE WHEN unpaid_interest<=0 OR overdue_days<=0 THEN 0 ELSE CASE WHEN late_fee_mode IN ('fixed','fixed_plus_percent') THEN late_fee_value ELSE 0 END + CASE WHEN late_fee_mode IN ('daily_percent','fixed_plus_percent') THEN unpaid_interest*late_fee_value/100*overdue_days ELSE 0 END END,2)) AS amount,unpaid_interest AS opening_interest_basis,late_fee_mode,late_fee_value,grace_period_days,'floating-penalty-snapshot-0030:'||loan_public_id::text||':'||due_date::text AS idempotency_key,'floating-penalty-ledger-migration-0030:'||loan_public_id::text AS correlation_id FROM exact_state`);
          const dueGroups = await tx<{ n: string }[]>`SELECT count(*) AS n FROM reconcile_0030_expected_groups`;
          if (Number(dueGroups[0]!.n) !== expectedShape.dueGroups) throw new Error("0030 frozen Bangkok due-group cardinality is not exact");
        }
        const migrationStatements = statements(content);
        for (const [localIndex, statement] of migrationStatements.entries()) {
          try {
            await tx.unsafe(statement);
          } catch (error) {
            throw new Error(`migration ${entry.tag} statement ${statementNumber + 1} failed: ${statement.slice(0, 100)}`, { cause: error });
          }
          statementNumber += 1;
          if (Number(process.env.RECONCILE_FAIL_AFTER_STATEMENT) === statementNumber) throw new Error(`fault injection after migration statement ${statementNumber}`);
          if (entry.idx === 36 && localIndex === 25) {
            if (!statement.includes('UPDATE "loan_interest_accruals" AS "accrual"') || !statement.includes('"daily_increment_amount" = "accrual"."interest_amount"')) throw new Error("0036 pinned accrual backfill marker changed");
            if (process.env.NODE_ENV === "test" && process.env.RECONCILE_TEST_CORRUPT_PAID_CACHE_BEFORE_DRAIN === "1") {
              await tx.unsafe("UPDATE loan_interest_accruals SET paid_amount=paid_amount+1");
            }
            // 0030 deliberately installs this as INITIALLY DEFERRED. 0036's
            // backfill queues it, so validate/drain it before later ALTER TABLE
            // statements while retaining the single atomic outer transaction.
            if (!(process.env.NODE_ENV === "test" && process.env.RECONCILE_TEST_SKIP_CONSTRAINT_DRAIN === "1")) {
              await tx.unsafe('SET CONSTRAINTS "public"."loan_interest_accruals_floating_paid_cache_consistent" IMMEDIATE');
            }
          }
        }
        if (entry.idx === 30) {
          const delta = await tx<{ loans: string; cutovers: string; groups: string; snapshots: string; audits: string; invalid: string; mismatch: string; cutover_mismatch: string }[]>`
            SELECT
              (SELECT count(*) FROM reconcile_0030_expected_loans) AS loans,
              (SELECT count(*) FROM floating_penalty_ledger_entries WHERE entry_type='legacy_cutover') AS cutovers,
              (SELECT count(*) FROM reconcile_0030_expected_groups) AS groups,
              (SELECT count(*) FROM floating_penalty_ledger_entries WHERE entry_type='legacy_snapshot') AS snapshots,
              (SELECT count(*) FROM audit_logs WHERE action='floating_penalty_ledger_migrated' AND request_id='floating-penalty-ledger-migration-0030') AS audits,
              (SELECT count(*) FROM floating_penalty_ledger_entries e LEFT JOIN audit_logs a ON a.tenant_id=e.tenant_id AND a.public_id=e.audit_public_id WHERE e.entry_type IN ('legacy_cutover','legacy_snapshot') AND (e.request_id <> 'floating-penalty-ledger-migration-0030' OR e.actor_source <> 'system' OR a.id IS NULL)) AS invalid,
              (SELECT count(*) FROM ((SELECT tenant_id,loan_id,due_date,penalty_date,amount,opening_interest_basis,late_fee_mode,late_fee_value,grace_period_days,idempotency_key,correlation_id FROM reconcile_0030_expected_groups EXCEPT SELECT tenant_id,loan_id,due_date,penalty_date,amount,opening_interest_basis,late_fee_mode,late_fee_value,grace_period_days,idempotency_key,correlation_id FROM floating_penalty_ledger_entries WHERE entry_type='legacy_snapshot') UNION ALL (SELECT tenant_id,loan_id,due_date,penalty_date,amount,opening_interest_basis,late_fee_mode,late_fee_value,grace_period_days,idempotency_key,correlation_id FROM floating_penalty_ledger_entries WHERE entry_type='legacy_snapshot' EXCEPT SELECT tenant_id,loan_id,due_date,penalty_date,amount,opening_interest_basis,late_fee_mode,late_fee_value,grace_period_days,idempotency_key,correlation_id FROM reconcile_0030_expected_groups)) mismatch_rows) AS mismatch,
              (SELECT count(*) FROM ((SELECT tenant_id,loan_id,due_date,due_date AS penalty_date,0::numeric AS amount,0::numeric AS opening_interest_basis,'none'::text AS late_fee_mode,0::numeric AS late_fee_value,0 AS grace_period_days,idempotency_key,correlation_id FROM reconcile_0030_expected_loans EXCEPT SELECT tenant_id,loan_id,due_date,penalty_date,amount,opening_interest_basis,late_fee_mode,late_fee_value,grace_period_days,idempotency_key,correlation_id FROM floating_penalty_ledger_entries WHERE entry_type='legacy_cutover') UNION ALL (SELECT tenant_id,loan_id,due_date,penalty_date,amount,opening_interest_basis,late_fee_mode,late_fee_value,grace_period_days,idempotency_key,correlation_id FROM floating_penalty_ledger_entries WHERE entry_type='legacy_cutover' EXCEPT SELECT tenant_id,loan_id,due_date,due_date,0::numeric,0::numeric,'none'::text,0::numeric,0,idempotency_key,correlation_id FROM reconcile_0030_expected_loans)) mismatch_rows) AS cutover_mismatch`;
          const d = delta[0]!;
          if (d.loans !== d.cutovers || d.loans !== d.audits || d.groups !== d.snapshots || Number(d.invalid) !== 0 || Number(d.mismatch)!==0 || Number(d.cutover_mismatch)!==0) throw new Error("0030 append-only cutover delta is not exact");
        }
        await tx`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES (${entry.hash}, ${entry.when})`;
      }
      await tx.unsafe(postflightDo);
      await verifyCatalogAndData(tx, 40, true);
      const final = await tx<{ count: string }[]>`SELECT count(*) FROM drizzle.__drizzle_migrations`;
      if (Number(final[0]!.count) !== 40) throw new Error("mixed-lineage postflight journal is not exactly 40 rows");
      return "applied";
    });
    console.log(result);
  } finally { await sql.end(); }
}

await run();
