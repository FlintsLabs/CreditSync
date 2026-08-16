# Task 2 test-hardening report

Implemented executable test hardening for the bank drawdown service and migration.

Coverage added:

- Tenant owner authorization, viewer denial, null actor denial, and inactive-profile rejection.
- Decimal-normalized aggregate credit-limit enforcement.
- Draft note persistence and idempotent replay/conflict behavior.
- Activation replay/conflict behavior, schedule persistence, and activation state.
- Draft and activation audit request/correlation context.
- Rerunnable execution of migration `0040_bank_drawdown_command_hardening.sql`, catalog verification of lifecycle columns/indexes, and status-constraint behavior.

Verification:

- `cd backend && bun test ./src/db/bank-drawdown-migration.test.ts ./src/services/bank-loan-service.test.ts ./src/lib/bank-loan-schedule.test.ts`: 9 passed, 4 skipped, 0 failed. The four integration tests were skipped because `TEST_DATABASE_URL` was not set.
- `cd backend && bunx tsc --noEmit`: passed.
- `git diff --check eb5de73 HEAD`: run before commit.
