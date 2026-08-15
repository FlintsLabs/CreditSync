# Task 1 report — loan-origination schema contract

## RED

From the requested worktree backend:

`cd /home/flintstone/github/CreditSync/.worktrees/production-loan-schema-reconciliation/backend && bun test ./src/db/loan-origination-schema-contract.test.ts`

Result: failed as expected because `./loan-origination-schema-contract` was missing (`0 pass, 1 fail, 1 error`). No production implementation existed at this point.

## Implementation

Added the closed loan-origination schema manifest, catalog-only inspector, fail-closed assertion, and `schema:check:loan-origination` CLI. The checker reports object names/states and never queries table rows.

## Verification

- Focused GREEN: `bun test ./src/db/loan-origination-schema-contract.test.ts` — 3 pass, 0 fail.
- Typecheck: `bun run typecheck` — passed.
- `git diff --check` — passed.
- Scope check: changed files are limited to the Task 1 implementation/test/checker/package script/changelog and this report; no 0037/0038 files were touched.

## Fix round 1/5

### RED evidence

- Added regression tests for live PostgreSQL constraint/index canonicalization, materially different definitions, numeric precision/scale, and a migration-backed checker run.
- `pwd && bun test src/db/loan-origination-schema-contract.test.ts` from `backend/` failed as required: `4 pass, 2 fail, 1 skip`; canonical constraint classification was `incompatible` instead of `compatible`, and a constrained `numeric(10,2)` column was incorrectly `compatible`.
- The migration-backed test then exposed the production catalog defect and canonicalization gap: the original `pg_constraint` query selected nonexistent `table_name`/`constraint_name`, and live `pg_get_constraintdef` output used redundant grouping, casts, and `= ANY (ARRAY[...])`.

### GREEN evidence

- `pwd && bun test src/db/loan-origination-schema-contract.test.ts` — `6 pass, 0 fail, 1 skip` without a database.
- `pwd && bun run typecheck && git diff --check` — passed.
- `pwd && ./scripts/test-disposable-postgres.sh src/db/loan-origination-schema-contract.test.ts` — current migrations applied to disposable PostgreSQL; `7 pass, 0 fail`, including the live migration-backed contract test.
- Real checker gate against a separately migrated disposable PostgreSQL database: `DATABASE_URL="$check_url" bun run schema:check:loan-origination` — all 28 contract objects reported `compatible`, exit `0`, object metadata only.

### Fix files and scope

- Modified `backend/src/db/loan-origination-schema-contract.ts` to use `conname`, query numeric precision/scale, normalize PostgreSQL canonical casts/`ANY` rendering and index predicates, and retain fail-closed incompatible classification.
- Modified `backend/src/db/loan-origination-schema-contract.test.ts` with unit regressions and a database-backed migration test.
- Modified `CHANGELOG.md`.
- No 0037/0038, schema, lifecycle, disbursement, or unrelated files were touched. Existing commit `f19ed5b` was not amended.

### Self-review, status, and concerns

- Self-review: the checker remains catalog-only, returns only closed object metadata, preserves missing/incompatible states, checks nullable/type/numeric metadata, and the live migrated schema plus CLI both pass.
- Status: ready for review; fix commit is recorded below after commit creation.
- Concerns: constraint canonicalization intentionally treats PostgreSQL-added casts, redundant parentheses, and equivalent `IN`/`ANY` rendering as semantic equivalents; materially changed values/operators and the partial-index predicate remain incompatible in regression coverage.

### Fix commit

`dbe98fd fix(db): reconcile loan schema checker catalog handling`

## Fix round 2

### RED evidence

Added `rejects the same Boolean operands with different grouping`, using the exact same operand/operator token sequence as `loans_interest_period_policy_completeness_check` but a materially different `AND`/`OR` grouping. Before the implementation correction:

`cd /home/flintstone/github/CreditSync/.worktrees/production-loan-schema-reconciliation/backend && bun test src/db/loan-origination-schema-contract.test.ts`

Result: failed as required: `6 pass, 1 fail, 1 skip`; the new assertion expected `incompatible` but current production normalization returned `compatible`.

### GREEN evidence

- Focused unit test: `bun test src/db/loan-origination-schema-contract.test.ts` — `7 pass, 0 fail, 1 skip`.
- Disposable PostgreSQL gate: `./scripts/test-disposable-postgres.sh src/db/loan-origination-schema-contract.test.ts` — `8 pass, 0 fail`, including the migration-backed live catalog test.
- Backend typecheck: `bun run typecheck` — passed.
- Whitespace validation: `git diff --check` — passed.

### Round-2 correction and scope

Replaced lossy all-parenthesis removal for constraints with a small fail-closed Boolean parser that preserves `AND`/`OR` grouping, flattens only associative same-operator nesting and redundant grouping, and retains canonical handling for PostgreSQL casts, redundant scalar parentheses, and `IN`/`= ANY (ARRAY[...])`. Index normalization and the valid catalog queries remain unchanged. The checker remains catalog-only and emits no row or sensitive data.

Changed only `backend/src/db/loan-origination-schema-contract.ts`, `backend/src/db/loan-origination-schema-contract.test.ts`, `CHANGELOG.md`, and this report. No migration, schema, lifecycle, disbursement, production, or unrelated files were touched.
