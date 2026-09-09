# Task 1 Review-Fix Report

Updated `backend/src/modules/bank-profiles.test.ts` only for the review findings:

- Corrected the `99.99` partial-attribution expectations to `59.99` and `40.00`.
- Added a negative-only allocation source and asserted zero linked recovered cash and no source-usage loan row, while retaining the positive-source assertions.
- Added HTTP 200 status assertions to the partial and external-liability tests.
- No production code was modified.

The focused disposable PostgreSQL suite remains intentionally RED because the funding-usage production behavior is not implemented yet.
