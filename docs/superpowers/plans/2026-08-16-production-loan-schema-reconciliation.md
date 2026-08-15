# Production Loan Schema Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reconcile production loan-origination schema drift safely, restore the audited daily-loan lifecycle, and then create the approved 7,500.00 THB zero-interest agreement with its separate 4,000.00 THB actual-disbursement record.

**Architecture:** Define one object-level loan schema contract shared by a read-only checker and tests. Add a guarded forward-only `0038` repair migration after the in-progress `0037` lineage, rehearse it against the exact production drift shape, and retain all writes behind existing loan/disbursement services. Production deployment is gated by backup, pre/post schema reports, migration logs, authenticated lifecycle verification, and post-draft human confirmation before disbursement posting.

**Tech Stack:** Bun, TypeScript, Drizzle ORM/Kit, PostgreSQL, Elysia, Decimal.js, Docker Compose.

## Global Constraints

- Use Bun commands and `backend/scripts/test-disposable-postgres.sh` for database-backed tests.
- Preserve all unrelated dirty files, especially the in-progress `0037_borrower_id_card_upload_intents` migration and schema work.
- Never modify historical migration bytes or production `drizzle.__drizzle_migrations` rows.
- Use THB two-decimal strings and backend-owned Decimal.js calculations; never use JavaScript `Number` for money.
- Keep timestamps ISO 8601, due dates `YYYY-MM-DD`, and business dates in `Asia/Bangkok`.
- Financial writes require request/correlation IDs, actor/source, required idempotency keys, and append-only audit history.
- Do not log identity-card values, QR payloads, signed URLs, bearer tokens, evidence contents, or customer financial records.
- Do not automatically attach either supplied identity because the card and transfer recipient names conflict.
- Do not post the 4,000.00 THB disbursement until its draft has been re-listed, the -3,500.00 THB intended variance has been shown, and the user has explicitly confirmed posting.
- Update `CHANGELOG.md` before every commit; commit the changelog with the change it describes.

---

### Task 1: Define and test the loan-origination schema contract

**Files:**
- Create: `backend/src/db/loan-origination-schema-contract.ts`
- Create: `backend/src/db/loan-origination-schema-contract.test.ts`
- Create: `backend/scripts/check-loan-origination-schema.ts`
- Modify: `backend/package.json`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces: `LOAN_ORIGINATION_SCHEMA_CONTRACT`, `inspectLoanOriginationSchema(executor)`, and `assertCompatibleLoanOriginationSchema(report)`.
- Produces CLI: `bun run schema:check:loan-origination` using `DATABASE_URL`, with object metadata only.
- Consumes: a PostgreSQL executor supporting tagged SQL queries.

- [ ] **Step 1: Write failing contract-classification tests**

Cover exact classification of `compatible`, `missing`, and `incompatible` objects without querying table data:

```ts
test("classifies missing and incompatible loan columns without exposing row data", async () => {
    const report = await inspectLoanOriginationSchema(fakeCatalog({
        columns: [
            { table: "loans", name: "activation_idempotency_key", type: "text", nullable: true },
            { table: "loans", name: "activation_result", type: "text", nullable: true },
        ],
    }));

    expect(report.objects.find((item) => item.name === "loans.activation_idempotency_key")?.state).toBe("compatible");
    expect(report.objects.find((item) => item.name === "loans.activation_result")?.state).toBe("incompatible");
    expect(report.objects.find((item) => item.name === "loans.interest_period_unit")?.state).toBe("missing");
    expect(JSON.stringify(report)).not.toContain("borrower");
});
```

Include every currently required missing production loan column: `interest_period_unit`, `interest_period_length`, `advance_interest_periods`, `advance_interest_refund_policy`, `interest_period_anchor_date`, eight `single_payment_*` columns, `floating_accrual_cycle`, `activation_idempotency_key`, and `activation_result`. Include current loan constraints and `loans_tenant_activation_idempotency_unique`.

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
cd backend
bun test src/db/loan-origination-schema-contract.test.ts
```

Expected: FAIL because the contract module does not exist.

- [ ] **Step 3: Implement the minimal manifest and inspector**

Use closed types:

```ts
export type SchemaObjectState = "compatible" | "missing" | "incompatible";
export type SchemaObjectResult = {
    kind: "column" | "constraint" | "index";
    name: string;
    state: SchemaObjectState;
    expected: string;
    actual: string | null;
};

export type LoanOriginationSchemaReport = {
    compatible: boolean;
    objects: SchemaObjectResult[];
};
```

Query only `information_schema.columns`, `pg_constraint`, `pg_indexes`, and `drizzle.__drizzle_migrations`. Normalize SQL expressions before comparison, and fail closed when a present object has the wrong type, nullability, predicate, or definition. The checker must print only object names/states and exit `0` only when `report.compatible` is true.

- [ ] **Step 4: Run tests and the checker against disposable PostgreSQL**

Run:

```bash
cd backend
bun test src/db/loan-origination-schema-contract.test.ts
bun run typecheck
DATABASE_URL="$TEST_DATABASE_URL" bun run schema:check:loan-origination
```

Expected: tests and typecheck pass; a fully migrated disposable database reports all objects compatible.

- [ ] **Step 5: Update changelog and commit**

```bash
git add CHANGELOG.md backend/package.json backend/scripts/check-loan-origination-schema.ts backend/src/db/loan-origination-schema-contract.ts backend/src/db/loan-origination-schema-contract.test.ts
git commit -m "feat(db): add loan origination schema checker"
```

---

### Task 2: Add the guarded forward-only reconciliation migration

**Files:**
- Create: `backend/drizzle/0038_production_loan_schema_reconciliation.sql`
- Create: `backend/drizzle/meta/0038_snapshot.json`
- Modify: `backend/drizzle/meta/_journal.json`
- Create: `backend/src/db/production-loan-schema-reconciliation-migration.test.ts`
- Modify: `backend/src/db/floating-weekly-intermediary-integration-migration.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: `LOAN_ORIGINATION_SCHEMA_CONTRACT` from Task 1.
- Produces: migration tag `0038_production_loan_schema_reconciliation` with an `idx` and timestamp strictly after the user-owned `0037` entry.
- Produces: production-shaped fixture helper that applies authoritative migrations through `0030`, then removes only the objects known absent in production.

- [ ] **Step 1: Write the migration-lineage RED tests**

Assert that:

```ts
expect(entries.slice(-2).map((entry) => entry.tag)).toEqual([
    "0037_borrower_id_card_upload_intents",
    "0038_production_loan_schema_reconciliation",
]);
expect(entries.at(-1)!.when).toBeGreaterThan(entries.at(-2)!.when);
expect(await Bun.file(`${backendRoot}drizzle/0038_production_loan_schema_reconciliation.sql`).exists()).toBe(true);
```

Keep the immutable `0027`–`0036` hash assertions unchanged. Extend snapshot chaining so `0038_snapshot.json.prevId === 0037_snapshot.json.id`.

- [ ] **Step 2: Write the production-shaped PostgreSQL RED test**

Build a disposable schema with the production loan columns and journal boundary captured on 2026-08-16. Seed one active historical floating loan and its accrual, then assert the pre-migration checker reports the exact missing objects. Apply `0038`, assert the checker is compatible, apply `0038` a second time through its statement runner, and verify the seeded principal, accrual amount, status, and public IDs are byte-for-byte unchanged.

Also create one incompatible fixture (`activation_result text`) and assert migration preflight aborts without changing any object.

- [ ] **Step 3: Run the focused tests and verify RED**

Run:

```bash
backend/scripts/test-disposable-postgres.sh \
  src/db/production-loan-schema-reconciliation-migration.test.ts \
  src/db/floating-weekly-intermediary-integration-migration.test.ts
```

Expected: FAIL because migration `0038` and its snapshot/journal entry do not exist.

- [ ] **Step 4: Implement guarded DDL**

Start the migration with a `DO` block that raises an exception when any existing target column has an incompatible PostgreSQL type. Then add nullable metadata columns without financial backfills:

```sql
ALTER TABLE "loans" ADD COLUMN IF NOT EXISTS "interest_period_unit" text;
ALTER TABLE "loans" ADD COLUMN IF NOT EXISTS "interest_period_length" integer;
ALTER TABLE "loans" ADD COLUMN IF NOT EXISTS "advance_interest_periods" integer;
ALTER TABLE "loans" ADD COLUMN IF NOT EXISTS "advance_interest_refund_policy" text;
ALTER TABLE "loans" ADD COLUMN IF NOT EXISTS "interest_period_anchor_date" date;
ALTER TABLE "loans" ADD COLUMN IF NOT EXISTS "single_payment_due_date" date;
ALTER TABLE "loans" ADD COLUMN IF NOT EXISTS "single_payment_fixed_agreed_interest" numeric;
ALTER TABLE "loans" ADD COLUMN IF NOT EXISTS "single_payment_interest_policy" text;
ALTER TABLE "loans" ADD COLUMN IF NOT EXISTS "single_payment_retroactive_rate_type" text;
ALTER TABLE "loans" ADD COLUMN IF NOT EXISTS "single_payment_retroactive_rate" numeric;
ALTER TABLE "loans" ADD COLUMN IF NOT EXISTS "single_payment_late_penalty_mode" text;
ALTER TABLE "loans" ADD COLUMN IF NOT EXISTS "single_payment_late_penalty_amount_per_day" numeric;
ALTER TABLE "loans" ADD COLUMN IF NOT EXISTS "single_payment_late_penalty_grace_days" integer;
ALTER TABLE "loans" ADD COLUMN IF NOT EXISTS "floating_accrual_cycle" text;
ALTER TABLE "loans" ADD COLUMN IF NOT EXISTS "activation_idempotency_key" text;
ALTER TABLE "loans" ADD COLUMN IF NOT EXISTS "activation_result" jsonb;
```

Add each current Drizzle check constraint only when absent, but compare and reject a same-named incompatible definition first. Create the partial unique index exactly as:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS "loans_tenant_activation_idempotency_unique"
ON "loans" ("tenant_id", "activation_idempotency_key")
WHERE "activation_idempotency_key" IS NOT NULL;
```

Do not populate `floating_accrual_cycle` for historical loans in this migration; unknown policy metadata remains null. If current constraints reject known legacy rows, add them `NOT VALID` and validate only after a separate read-only violation query returns zero.

- [ ] **Step 5: Create metadata without changing the user-owned 0037 work**

Generate or construct `0038_snapshot.json` from the unchanged current schema so it chains from `0037`. Verify that staging contains no modifications to `0037_borrower_id_card_upload_intents.sql`, `0037_snapshot.json`, or unrelated schema edits beyond the pre-existing user changes.

- [ ] **Step 6: Run migration tests twice and verify GREEN**

Run:

```bash
backend/scripts/test-disposable-postgres.sh \
  src/db/production-loan-schema-reconciliation-migration.test.ts \
  src/db/floating-weekly-intermediary-integration-migration.test.ts
cd backend && bun run typecheck
```

Expected: production-shaped upgrade and repeatability tests pass; incompatible fixture fails closed as asserted.

- [ ] **Step 7: Update changelog and commit**

```bash
git add CHANGELOG.md backend/drizzle/0038_production_loan_schema_reconciliation.sql backend/drizzle/meta/0038_snapshot.json backend/drizzle/meta/_journal.json backend/src/db/production-loan-schema-reconciliation-migration.test.ts backend/src/db/floating-weekly-intermediary-integration-migration.test.ts
git commit -m "fix(db): reconcile production loan schema"
```

Before committing, confirm `git diff --cached --name-only` contains only the listed files and the intended journal append. Because `0037` is user-owned and currently uncommitted, implementation must coordinate its integration rather than silently absorbing or rewriting it.

---

### Task 3: Prove the complete zero-interest daily-loan lifecycle

**Files:**
- Modify: `backend/src/services/loan-application-service.test.ts`
- Create: `backend/src/modules/loan-daily-origination.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes existing `previewLoan`, `createLoanDraft`, `activateLoan`, public REST routes, `loanSchedules`, and `auditLogs`.
- Produces no new financial service API.

- [ ] **Step 1: Write a failing database-backed lifecycle test**

Use exact approved terms:

```ts
const terms = {
    principal: "7500.00",
    interestRate: "0.00",
    termMonths: 1,
    repaymentType: "daily" as const,
    startDate: "2026-08-16",
    dailyEntry: {
        durationUnit: "days" as const,
        durationValue: 75,
        entryMode: "daily_payment" as const,
        dailyPayment: "100.00",
    },
};
```

Assert preview returns 75 installments, 0.00 total interest, first due date `2026-08-17`, and last due date `2026-10-30`. Create a draft with a borrower public UUID; verify one `draft_created` audit. Activate with `Idempotency-Key: loan-p-nam-activate-20260816`; verify exactly 75 schedule rows, each `scheduledPrincipal = 100.00`, `scheduledInterest = 0.00`, `scheduledTotal = 100.00`, and total principal equals 7,500.00 using Decimal.js. Retry the same activation and assert no duplicate schedule/audit rows.

- [ ] **Step 2: Run against the production-shaped pre-repair fixture and verify RED**

Expected failure: draft insertion reports one of the absent loan columns. This proves the test catches the actual production incident rather than only a synthetic checker condition.

- [ ] **Step 3: Run after `0038` and verify GREEN**

Run:

```bash
backend/scripts/test-disposable-postgres.sh \
  src/services/loan-application-service.test.ts \
  src/modules/loan-daily-origination.test.ts
```

Expected: preview, draft, audit, activation, immutable schedule, and retry assertions pass.

- [ ] **Step 4: Run disbursement regression coverage**

Verify existing tests still prove a 4,000.00 posted disbursement against 7,500.00 approved principal yields `netDisbursed = 4000.00`, `variance = -3500.00`, and `under_disbursed`, without mutating principal or schedules. Add only the missing exact scenario to `backend/src/services/loan-disbursement-service.test.ts` if existing coverage does not assert all four facts.

- [ ] **Step 5: Update changelog and commit**

```bash
git add CHANGELOG.md backend/src/services/loan-application-service.test.ts backend/src/modules/loan-daily-origination.test.ts backend/src/services/loan-disbursement-service.test.ts
git commit -m "test(loans): cover zero-interest daily origination"
```

---

### Task 4: Add the production reconciliation runbook and full verification gate

**Files:**
- Create: `docs/operations/production-loan-schema-reconciliation.md`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes schema checker and migration from Tasks 1–2.
- Produces an operator sequence with explicit stop conditions and no embedded credentials.

- [ ] **Step 1: Write the runbook with exact preflight and stop conditions**

Include:

1. Record current Git HEAD, image digest, container state, and schema report.
2. Create and verify a recoverable PostgreSQL backup outside the container.
3. Restore that backup into an isolated disposable PostgreSQL instance.
4. Run the pre-migration checker and confirm it matches the approved drift set exactly.
5. Apply migrations to the restored copy; run checker, lifecycle tests, and row-preservation queries.
6. Stop if any additional missing/incompatible object appears.
7. Apply production migration before replacing the backend image.
8. Verify columns/constraints/index, migration logs, MCP health, and authenticated preview.
9. Roll back the application image on runtime failure; do not drop additive columns.

Use task-specific environment variable names such as `CREDITSYNC_BACKUP_PATH`; never reuse `HOME`.

- [ ] **Step 2: Document the post-deploy real-record sequence**

Document the exact workflow without secrets:

```text
reuse borrower พี่น้ำ
preview 7500.00 / daily / 75 days / 100.00 / zero interest
create draft with a stable idempotency key
inspect draft and schedule
activate with a stable idempotency key
create disbursement draft gross=4000.00 attributed=4000.00 channel=bank_transfer
list draft and show intended post-state variance=-3500.00
obtain explicit post-draft confirmation
post with a unique idempotency key
re-list and verify under_disbursed
```

- [ ] **Step 3: Run full verification**

Run serially where database reset is destructive:

```bash
backend/scripts/test-disposable-postgres.sh
cd backend && bun run typecheck
cd ../frontend && bun test && bun run lint && bun run build
```

Run plugin tests/validator only if the implementation changes MCP contracts; this design should not change them.

- [ ] **Step 4: Self-review the staged change and commit**

```bash
git diff --check
git diff --cached --stat
git add CHANGELOG.md README.md docs/operations/production-loan-schema-reconciliation.md
git commit -m "docs: add loan schema reconciliation runbook"
```

---

### Task 5: Supervised integration, migration, deployment, and approved record creation

**Files:**
- No source changes expected.
- Runtime evidence stays in task output; do not commit production dumps, tokens, or customer data.

**Interfaces:**
- Consumes the verified feature branch and runbook.
- Produces a merged/deployed backend, one active loan, and (only after confirmation) one posted disbursement.

- [ ] **Step 1: Independently verify the feature branch**

Inspect commits, `git diff <target>...HEAD`, migration bytes, journal order, test evidence, and unexplained tracked changes. Confirm the user-owned dirty files are preserved. Do not trust tmux worker completion without rerunning the required gates at feature HEAD.

- [ ] **Step 2: Merge only with explicit merge authorization**

After merging, run:

```bash
git merge-base --is-ancestor codex/production-loan-schema-reconciliation main
```

Expected: exit `0`. Distinguish local merge, push, and deployment in status reports.

- [ ] **Step 3: Rehearse from a fresh production backup**

Follow the runbook exactly. Stop on any drift beyond the approved manifest, failed constraint validation, changed seeded financial values, or migration log error.

- [ ] **Step 4: Apply production reconciliation and deploy**

Start production infra, apply the approved migration with the production env file, verify expected objects through PostgreSQL, then rebuild and replace only the required app containers. Confirm backend startup, successful migrations, MCP health at `http://127.0.0.1:3000/mcp/health` from inside the backend container, and public frontend health at `http://127.0.0.1:8088/`.

- [ ] **Step 5: Create and inspect the real loan**

Search canonical names and confirmed aliases again; reuse the existing `พี่น้ำ` borrower. Use authenticated application routes with non-secret request/correlation IDs and stable idempotency keys to preview, create the draft, inspect it, and activate it. Verify exactly 75 schedule rows totaling 7,500.00 THB and no interest. Do not print bearer tokens or identity data.

- [ ] **Step 6: Create the disbursement draft and pause for confirmation**

Create, but do not post, a bank-transfer draft with `grossAmount = 4000.00` and `loanAttributedAmount = 4000.00`. Re-list the event, show the user the exact intended post-state variance of `-3500.00`, and request explicit confirmation. This confirmation cannot be inherited from the earlier loan-creation approval because it must follow draft inspection.

- [ ] **Step 7: Post only after explicit confirmation and verify**

Post with a unique idempotency key, re-list, and verify the event is `posted`, the summary is `under_disbursed`, `netDisbursed = 4000.00`, and `variance = -3500.00`. Confirm the loan principal and 75 schedule rows are unchanged and audit/correlation public IDs were returned.

- [ ] **Step 8: Clean up and report**

Remove the isolated worktree and feature branch only after verified merge/deployment. Report commits, migration result, test counts, deployment health, loan public ID, disbursement public ID, variance, and any deliberately deferred evidence attachment—without sensitive customer data.
