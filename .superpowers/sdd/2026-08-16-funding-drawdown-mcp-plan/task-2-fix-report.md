# Task 2 Fix Report

## Changed files

- `backend/src/db/schema.ts`: added request fingerprints and activation idempotency/result metadata with tenant-scoped uniqueness.
- `backend/drizzle/0040_bank_drawdown_command_hardening.sql`: added repeatable lifecycle columns, guarded constraints, and activation idempotency index.
- `backend/src/services/bank-loan-service.ts`: added tenant-admin authorization, strict command validation, Decimal aggregate credit-limit enforcement under profile locking, payload-safe replay/conflict handling, activation persistence, and note preservation.
- `backend/src/db/bank-drawdown-migration.test.ts`: expanded migration contract assertions.
- `CHANGELOG.md`: recorded the hardening changes.

## Verification

- `cd backend && bun test src/db/bank-drawdown-migration.test.ts src/services/bank-loan-service.test.ts src/lib/bank-loan-schedule.test.ts` — PASS (8 tests).
- `cd backend && bunx tsc --noEmit` — PASS.
- `git diff --check eb5de73 HEAD` — PASS.

The focused service suite remains non-database because the repository's disposable PostgreSQL gate was not available in this worktree; migration assertions are production-shape contract checks and no DB-backed test was skipped after starting one.

## Commit

Commit hash: `c4f60f4c415e8c7496523ade0229517083eb0164`.
