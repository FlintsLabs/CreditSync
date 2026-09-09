# Task 1 report

Added three backend integration regressions in `backend/src/modules/bank-profiles.test.ts` covering linked borrower cash recovery, exclusion of unlinked loans, partial source-share attribution, and external-liability behavior. No production code was modified.

Verification:

- `./scripts/test-disposable-postgres.sh src/modules/bank-profiles.test.ts`
- Result: 7 existing tests passed and the 3 new tests failed as intended because the funding-usage response does not yet expose recovered borrower cash and capital-pool availability remains allocation-only.

