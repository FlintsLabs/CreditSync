# Task 2 Validation Fix Report

## Findings fixed

- Bank drawdown Decimal validation now rejects `NaN` and infinite values before schedule generation or persistence.
- Draft and activation writes reject missing and whitespace-only idempotency keys. Keys are trimmed once and the normalized value is used consistently for locking, lookup, persistence, and activation audit payloads.
- Validated `installmentAmount` is normalized to a two-decimal decimal string before draft persistence and schedule generation.

## Coverage

- Added service integration coverage for non-finite amount rejection, canonical installment persistence, and whitespace-only draft/activation keys.

## Verification

- Focused service tests: `bun test backend/src/services/bank-loan-service.test.ts`
- Backend typecheck: `cd backend && bun run typecheck`
- Diff check: `git diff --check`
