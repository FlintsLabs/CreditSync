# Final Fix Report

## Fixed

- Replaced default `Decimal` arithmetic in bank-profile funding usage with `FinancialDecimal` (precision 100) for allocation aggregation, source-share attribution, recovered cash, available capital, and signed-money serialization.
- Extracted one source-share helper used by aggregate and per-loan recovered-cash output.
- Added a database-backed 29-digit regression covering a 1/3 source share and mixed principal, interest, fee, penalty, and reversal transaction amounts.
- Added post-transaction tenant-cache invalidation for intermediary remittance posting, manual collection approval, and remittance reversal.
- Added the v0.3.14 changelog entry.

## Verification

- RED: `./backend/scripts/test-disposable-postgres.sh src/modules/bank-profiles.test.ts` failed on the new large mixed-component regression before the precision fix.
- GREEN: `./backend/scripts/test-disposable-postgres.sh src/modules/bank-profiles.test.ts` — 11 passed, 0 failed.
- `./backend/scripts/test-disposable-postgres.sh src/services/intermediary-service.test.ts` — 6 passed, 0 failed.
- `bun run typecheck` from `backend/` — passed.
- `git diff --check` — passed.

## Concerns

- No reliable existing harness exposed cache-invalidation call counts without fragile mocking, so intermediary coverage relies on the existing integration lifecycle and the implementation keeps invalidation outside each committed transaction.
