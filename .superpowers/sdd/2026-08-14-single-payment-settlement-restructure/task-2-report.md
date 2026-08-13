# Task 2 Report: Additive database model and immutability

## Status

Implemented the additive single-payment/restructure persistence model and PostgreSQL enforcement. The committed migration sequence already contained `0023` through `0026`, so the planned `0023_single_payment_restructure.sql` was integrated as the next safe registered migration, `0027_single_payment_restructure.sql`, without renumbering or altering existing migrations.

## Changes

- Added nullable loan term columns for exact single-payment due date, fixed agreed interest, closed interest policy, optional retroactive rate type/rate, contracted late-penalty policy, and explicit floating accrual cycle.
- Backfilled `floating_accrual_cycle = 'daily'` only where existing `repayment_type = 'floating'`; no historical loan is inferred to be `single_payment`.
- Added database checks for mutually exclusive fixed/retroactive policies, due-date ordering, penalty-policy combinations, floating daily/weekly cycles, non-negative exact money scale, and four-place retroactive-rate scale.
- Added tenant-scoped Drizzle tables and SQL DDL for:
  - `loan_restructures`, including old/new public-loan lineage, immutable balance version, gross/waived/net component snapshots, external credits, additional principal, cash direction, replacement terms, preview/request hashes, actor/request/correlation context, audit public IDs, lifecycle timestamps, and durable execution/reversal keys plus request hashes.
  - `loan_opening_balance_components`, including exact amount, closed component kind, and polymorphic source type plus source public UUID.
  - `loan_restructure_waivers`, including closed waivable component kind, exact amount, reason, append-only reversal lineage, actor/request/correlation context, audit public ID, and durable execution/reversal keys plus hashes.
- Added composite `(tenant_id, id)` targets and composite tenant foreign keys for old/new loans, replacement loans, restructure aggregates, waiver reversals, and actor users.
- Added tenant-scoped unique execution/reversal request-key indexes and one-reversal-per-waiver lineage.
- Added triggers that reject arbitrary update/delete of executed or reversed restructure aggregates, reject all opening-component mutation, and reject all executed/reversed waiver mutation. The only aggregate mutation permitted after execution is the tightly constrained `executed -> reversed` lifecycle transition that changes reversal metadata only.

## TDD Evidence

### RED

Command:

```text
cd backend && bun test src/db/single-payment-restructure-migration.test.ts src/db/agent-workflow-schema.test.ts
```

Observed: `2 pass, 1 skip, 9 fail`. Failures were the expected missing `0027` migration, missing loan columns/checks, and missing `loanRestructures`, `loanOpeningBalanceComponents`, and `loanRestructureWaivers` Drizzle exports. A later focused lifecycle-contract RED produced `4 pass, 1 skip, 1 fail` until the status-dependent request-key/timestamp constraint was added.

### GREEN

Focused schema contract and typecheck:

```text
cd backend && bun run typecheck
cd backend && bun test src/db/single-payment-restructure-migration.test.ts src/db/agent-workflow-schema.test.ts
```

Observed: typecheck exited 0; focused suite reported `11 pass, 1 skip, 0 fail` (the PostgreSQL test is intentionally skipped without `TEST_DATABASE_URL`).

Disposable PostgreSQL:

```text
cd backend && ./scripts/test-disposable-postgres.sh src/db/single-payment-restructure-migration.test.ts
```

Observed: migrations applied successfully; `6 pass, 0 fail`. The integration test reconstructs migrations through `0026`, seeds an existing floating loan and a non-floating loan, applies `0027`, and verifies the selective backfill. It also verifies invalid term rejection, cross-tenant old/new loan rejection, over-waiver rejection, duplicate request-key rejection, immutable executed/reversed aggregates and waivers, and immutable opening components.

## Files

- `backend/drizzle/0027_single_payment_restructure.sql`
- `backend/drizzle/meta/_journal.json`
- `backend/src/db/schema.ts`
- `backend/src/db/single-payment-restructure-migration.test.ts`
- `backend/src/db/agent-workflow-schema.test.ts`
- `CHANGELOG.md`

## Concerns / Follow-up Boundaries

- The migration number differs from the original plan only because `0023`-`0026` already exist in this branch; `0027` is the next journal index.
- Task 3 must populate explicit `floatingAccrualCycle` for new floating loans and the normalized single-payment columns for new single-payment loans. The migration backfills only historical floating loans by design.
- Task 4 remains responsible for transactional preview/execute/reverse orchestration and downstream reversal blockers; this task supplies durable constraints and immutability boundaries but does not implement services.

## Review Fix Round 1

Addressed every Critical/Important finding from `task-2-review.md`:

- Added `loans` and `loan_schedules` triggers that freeze contractual fields after a loan leaves `draft`, while allowing operational loan balance/status/due-state changes and schedule paid/remaining/penalty/overdue/status changes. Activated and terminal loan deletion plus activated schedule deletion are rejected.
- Closed restructure lifecycles: executed/reversed rows require distinct old/new loans, complete execution audit, actor, timestamp, and pre-execution balance snapshot data; reversed rows additionally require complete reversal audit, actor, timestamp, key, and hash data. Preview/expired rows forbid execution/reversal-only metadata.
- Closed waiver lifecycles: every executed/reversed row requires a tenant-valid audit public ID, creator, and execution timestamp; executed rows forbid reversal metadata; compensating reversal rows require source waiver, reversal key/hash, reversal actor, and reversal timestamp.
- Added tenant-composite audit public-ID foreign keys, a replacement consistency composite foreign key requiring each opening component's loan to equal the restructure's new loan, and `old_loan_id <> new_loan_id` enforcement for executed/reversed rows.
- Added a polymorphic source validation trigger requiring `source_public_id` to exist in the row tenant and selected `source_type` table (`loans`, `loan_restructures`, or `loan_restructure_waivers`).
- Coupled cash direction and amount: `none` requires exactly zero; `payout` and `collection` require a positive exact amount.
- Replaced the original same-loan success fixture with distinct old/new loans and added positive operational-mutation/source/cash cases plus negative contract mutation, incomplete/contradictory lifecycle, cross-tenant/nonexistent source, wrong replacement, self-restructure, cross-tenant audit, and inconsistent cash cases.

### Review RED

Command:

```text
cd backend && ./scripts/test-disposable-postgres.sh src/db/single-payment-restructure-migration.test.ts
```

After correcting a test-only misuse of `expect(...).resolves` with the PostgreSQL PromiseLike, the feature RED completed normally with `5 pass, 1 fail`: an active single-payment due-date update returned no database error (`Received: "undefined"`) where the new test expected `contractual terms are immutable`. Subsequent focused REDs also exposed the missing lifecycle completeness constraint until the valid fixture supplied a real JSON object and complete audit/snapshot state.

### Review GREEN

Commands:

```text
cd backend && bun test src/db/single-payment-restructure-migration.test.ts src/db/agent-workflow-schema.test.ts
cd backend && bun run typecheck
cd backend && ./scripts/test-disposable-postgres.sh src/db/single-payment-restructure-migration.test.ts
```

Final results: focused static suite `11 pass, 1 skip, 0 fail`; TypeScript typecheck exited 0; disposable PostgreSQL migrations applied successfully and the database suite reported `6 pass, 0 fail` with `161 expect()` calls.
