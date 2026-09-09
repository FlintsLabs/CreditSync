# Bank Drawdown Migration Test Hang Remediation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the deterministic hang in the bank-drawdown migration integration test so the full disposable-PostgreSQL verification gate can complete before merging and deploying the reversed-payment repost workflow.

**Architecture:** Keep migration `0040_bank_drawdown_command_hardening.sql` and its database invariants unchanged unless diagnostics prove the SQL itself is responsible. First isolate the exact awaited phase that never settles, then apply the smallest test-harness lifecycle fix and verify both the focused test and the complete serialized backend suite on fresh disposable PostgreSQL containers.

**Tech Stack:** Bun 1.3, `bun:test`, Postgres.js, PostgreSQL 18, Drizzle migrations, Bash/Docker Compose.

**Spec:** `docs/superpowers/specs/2026-08-21-repost-reversed-payment-design.md`

## Global Constraints

- Do not weaken or remove the assertions covering migration idempotency, required columns, required indexes, or invalid-status rejection.
- Do not change production financial rows or create test financial records in the live tenant.
- Keep production migrations forward-only; never edit an already-applied migration merely to satisfy a test.
- Use the disposable PostgreSQL script for database-backed tests and run it serially.
- Preserve unrelated dirty files in the main worktree.
- Update `CHANGELOG.md` before committing any code or test change.
- Do not merge or deploy until every required verification gate is green at the exact commit being integrated.

---

### Task 1: Pinpoint the Awaited Operation That Hangs

**Files:**
- Modify temporarily, then restore or retain only useful failure diagnostics: `backend/src/db/bank-drawdown-migration.test.ts`
- Inspect: `backend/drizzle/0040_bank_drawdown_command_hardening.sql`
- Inspect: `backend/scripts/test-disposable-postgres.sh`

**Interfaces:**
- Consumes: `TEST_DATABASE_URL` supplied by `test-disposable-postgres.sh`.
- Produces: one evidence-backed root-cause statement identifying whether the hang occurs during migration replay, schema inspection, rejected INSERT consumption, or Postgres.js shutdown.

- [ ] **Step 1: Confirm the clean focused reproduction**

Run:

```bash
cd backend
./scripts/test-disposable-postgres.sh --timeout 30000 src/db/bank-drawdown-migration.test.ts
```

Expected before the fix: the integration case times out at approximately 30 seconds, proving the failure is deterministic outside the full suite.

- [ ] **Step 2: Add phase-local timeout diagnostics without changing assertions**

Add this helper above the integration test:

```ts
async function tracePhase<T>(name: string, operation: Promise<T>): Promise<T> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
            () => reject(new Error(`bank drawdown migration phase timed out: ${name}`)),
            2_000,
        );
    });
    try {
        return await Promise.race([operation, timeout]);
    } finally {
        if (timeoutId) clearTimeout(timeoutId);
    }
}
```

Wrap each awaited phase independently:

```ts
await tracePhase("migration replay", postgres.unsafe(statement));
await tracePhase(
    "column inspection",
    postgres<{ column_name: string }[]>`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name = 'bank_loans'
          AND column_name IN (
            'idempotency_key',
            'request_id',
            'correlation_id',
            'activation_idempotency_key',
            'activation_request_hash',
            'activation_result'
          )
    `,
);
await tracePhase(
    "index inspection",
    postgres<{ indexname: string }[]>`
        SELECT indexname
        FROM pg_indexes
        WHERE tablename = 'bank_loans'
          AND indexname IN (
            'bank_loans_tenant_idempotency_unique',
            'bank_loans_tenant_activation_idempotency_unique'
          )
    `,
);
await tracePhase("invalid-status rejection", invalidInsertPromise);
await tracePhase("connection shutdown", postgres.end({ timeout: 1 }));
```

Keep SQL and expected values identical to the current test. The diagnostic error must name the exact phase instead of merely reaching Bun's global timeout.

- [ ] **Step 3: Run the focused test and capture the named failing phase**

Run:

```bash
./scripts/test-disposable-postgres.sh --timeout 30000 src/db/bank-drawdown-migration.test.ts
```

Expected: FAIL within 2 seconds with exactly one named phase. Do not proceed with a code fix until this output identifies the phase.

- [ ] **Step 4: Compare the failing lifecycle with working database tests**

Inspect:

```bash
rg -n "postgres\.end|rejects\.toBeDefined|try \{|catch \(" src/db -g '*.test.ts'
```

Record the exact lifecycle difference between this test and at least one passing integration test. The current leading hypothesis is that Bun's promise matcher does not fully settle the Postgres.js query before pool shutdown, but this must be confirmed by Step 3.

---

### Task 2: Fix the Query and Connection Lifecycle Without Weakening Coverage

**Files:**
- Modify: `backend/src/db/bank-drawdown-migration.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: the failing phase proven in Task 1.
- Produces: a focused integration test that terminates normally and still proves invalid statuses are rejected at the database boundary.

- [ ] **Step 1: Preserve a failing regression run**

Before editing the lifecycle, rerun:

```bash
./scripts/test-disposable-postgres.sh --timeout 30000 src/db/bank-drawdown-migration.test.ts
```

Expected: FAIL with the Task 1 named phase. Save the command and failure text in the implementation notes.

- [ ] **Step 2: Replace matcher-owned rejection handling with explicit query consumption**

Use explicit `try/catch` so Postgres.js owns and settles the query promise before shutdown:

```ts
let rejectedInvalidStatus = false;
try {
    await postgres.unsafe(
        `INSERT INTO bank_loans (tenant_id, amount, status, idempotency_key) VALUES ('migration-test', 1, 'invalid', 'migration-test')`,
    );
} catch {
    rejectedInvalidStatus = true;
}
expect(rejectedInvalidStatus).toBe(true);
```

Close the client with a bounded shutdown in `finally`:

```ts
} finally {
    await postgres.end({ timeout: 1 });
}
```

If Task 1 proves a different phase hangs, do not apply this candidate blindly. Make the same one-variable lifecycle correction at the proven phase, retain the named diagnostic until the focused test is green, and do not change migration semantics.

- [ ] **Step 3: Run the focused test with the normal timeout**

Run:

```bash
./scripts/test-disposable-postgres.sh src/db/bank-drawdown-migration.test.ts
```

Expected: 2 pass, 0 fail, process exits normally without requiring Ctrl-C.

- [ ] **Step 4: Prove the regression test still detects a broken invariant**

Temporarily change the invalid status in the test to `'draft'`, rerun the focused test, and confirm it fails because the INSERT succeeds. Restore `'invalid'` immediately and rerun to 2 pass, 0 fail.

- [ ] **Step 5: Update the changelog and commit the isolated remediation**

Add one concise `### Fixed` bullet under the newest explicit version/date describing the deterministic migration-test connection lifecycle fix.

Run:

```bash
git add CHANGELOG.md backend/src/db/bank-drawdown-migration.test.ts
git diff --cached --check
git commit -m "test: prevent bank drawdown migration hang"
```

---

### Task 3: Re-run Every Integration Gate at the Candidate Merge Commit

**Files:**
- Verify only; do not change production data.

**Interfaces:**
- Consumes: the feature branch containing the remediation commit and reversed-payment repost commits.
- Produces: fresh evidence that the exact commit is safe to merge.

- [ ] **Step 1: Ensure no orphan disposable-test process is sharing resources**

Run:

```bash
ps -eo pid,ppid,etime,stat,cmd | rg 'test-disposable-postgres|bun test --max-concurrency=1' | rg -v rg || true
```

Expected: no orphan process whose current working directory is a deleted worktree. Do not terminate an active user-owned task without inspecting its PID, parent, elapsed time, and working directory.

- [ ] **Step 2: Run the complete backend database suite**

Run:

```bash
cd backend
./scripts/test-disposable-postgres.sh
bun run typecheck
```

Expected: both commands exit 0; the test summary reports 0 failures and the runner exits without hanging.

- [ ] **Step 3: Re-run frontend and plugin gates**

Run:

```bash
cd ../frontend
bun test
bun run lint
bun run build
cd ../plugins/creditsync
bun test
bun run validate
```

Expected: all commands exit 0; plugin validation reports version 7.3.0, 11 skills, and 84 tools.

- [ ] **Step 4: Verify branch integrity**

Run from the repository worktree root:

```bash
git status --short
git diff --check
git log --oneline main..HEAD
```

Expected: clean status, no whitespace errors, and only the approved repost implementation plus the isolated migration-test remediation.

---

### Task 4: Merge, Deploy, and Verify Production Without Posting Financial Data

**Files:**
- Merge target: `main`
- Deploy configuration: `docker-compose.infra.yml`, `docker-compose.app.yml`, `.env.production`

**Interfaces:**
- Consumes: fully green feature branch from Task 3 and the user's existing merge/deploy authorization.
- Produces: deployed application with verified migration schema and healthy backend/frontend; no payment is posted by deployment.

- [ ] **Step 1: Preserve and account for existing main-worktree changes**

Run:

```bash
git -C /home/flintstone/github/CreditSync status --short
```

Expected: identify `.gitignore`, the two floating-loan documents, and `note.txt` as user-owned changes. The merge must not overwrite, stage, or commit them.

- [ ] **Step 2: Merge the feature branch locally**

Run:

```bash
git -C /home/flintstone/github/CreditSync merge --ff-only codex/repost-reversed-payment
git -C /home/flintstone/github/CreditSync merge-base --is-ancestor codex/repost-reversed-payment main
```

Expected: fast-forward succeeds and the ancestry check exits 0. If either fails, stop before deployment.

- [ ] **Step 3: Start production-style infrastructure and rebuild the application**

Run:

```bash
docker compose --env-file .env.production -f docker-compose.infra.yml up -d
docker compose --env-file .env.production -f docker-compose.app.yml up --build -d
```

Expected: PostgreSQL, MinIO, Dragonfly, backend, and frontend reach running/healthy state.

- [ ] **Step 4: Verify migration 0049 in production PostgreSQL**

Inspect backend migration logs and query the production PostgreSQL container for:

```sql
SELECT column_name
FROM information_schema.columns
WHERE table_name = 'payment_intakes'
  AND column_name = 'repost_of_intake_id';

SELECT column_name
FROM information_schema.columns
WHERE table_name = 'payment_reconciliation_groups'
  AND column_name = 'posted_intake_id';
```

Expected: each query returns exactly one row. Also verify the tenant/source unique index and tenant-safe foreign key introduced by migration 0049.

- [ ] **Step 5: Verify backend and frontend health**

Run:

```bash
docker compose --env-file .env.production -f docker-compose.app.yml exec backend \
  bun -e "const response = await fetch('http://127.0.0.1:3000/mcp/health'); console.log(response.status, await response.text()); if (!response.ok) process.exit(1)"
curl --fail --silent --show-error http://127.0.0.1:8088/ >/dev/null
docker compose --env-file .env.production -f docker-compose.app.yml ps
```

Expected: MCP health returns HTTP 200, frontend returns success, and app containers remain healthy.

- [ ] **Step 6: Keep the financial repost as a separate confirmed operation**

Do not post the ฿75 payment during deployment. After deployment, separately inspect the source intake, preview the split ฿30/฿45 interest-only allocation, show source/child IDs and unchanged principal, then obtain explicit confirmation before executing the financial write.

---

## Self-Review

- Spec coverage: the plan preserves append-only financial behavior and confines this remediation to the failing verification gate; production posting remains a separate confirmation boundary.
- Placeholder scan: no TBD/TODO or unspecified implementation step remains. Task 1 deliberately identifies the proven phase before Task 2 permits a one-variable correction.
- Type consistency: `TEST_DATABASE_URL`, Postgres.js client lifecycle, plugin version 7.3.0, and migration 0049 names match the current branch.
