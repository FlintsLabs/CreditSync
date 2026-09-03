# Weekly overdue display worker report

## Result

Implemented the additive weekly-overdue payment-health display contract on branch `codex/weekly-overdue-display`.

- Added backend-owned `overdueObligationUnit` and `overdueObligationCount` fields.
- Selected `day`, `week`, or `installment` from persisted loan policy.
- Preserved exact backend money strings and independent calendar `maxOverdueDays`.
- Added the missing policy columns to the loan-list projection so weekly rows retain their cadence.
- Added English/Thai localized weekly obligation copy and legacy frontend fallback behavior.
- No schema, payment posting, interest accrual, allocation, MCP, or financial-write changes.

## Verification

- `bun test backend/src/lib/loan-payment-health.test.ts`: 13 passed.
- `bun test ./frontend/tests/loan-list.vitest.tsx`: 14 passed.
- `bash backend/scripts/test-disposable-postgres.sh src/lib/loan-payment-health.test.ts src/services/loan-payment-health-service.test.ts src/modules/loan-contract-routes.test.ts`: 27 passed, 0 failed.
- `bun run --cwd backend typecheck`: passed.
- `bun run --cwd frontend lint`: passed.
- `bun run --cwd frontend build`: passed; Vite emitted only the existing large-chunk warning.
- `git diff --check`: passed.

The unfiltered `bash backend/scripts/test-disposable-postgres.sh` run exercised many passing suites but was terminated by the environment with exit 137 before completion. The unfiltered frontend suite reported three pre-existing/unrelated failures: stale release metadata expectations, a `bun:test` bundling issue in `loan-schedule-deferral-model.test.ts`, and a schedule-tab fixture error from an undefined money value. The changed loan-list focused suite passed.

## Scope notes

The supplied untracked implementation plan was preserved and is not included in the commit. No merge, push, deploy, production MCP call, or financial write was performed.
