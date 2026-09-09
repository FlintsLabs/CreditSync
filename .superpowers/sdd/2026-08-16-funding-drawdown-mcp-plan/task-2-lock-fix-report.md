# Task 2 Lock Fix Report

Implemented the final review fix for bank drawdown draft creation.

- Draft creation now acquires the tenant-scoped bank profile row lock before validating profile status.
- The locked profile row is used consistently for aggregate credit-limit enforcement.
- The stale pre-lock profile read was removed.
- Activation lock ordering remains unchanged and consistent.

Verification:

- `bun test src/services/bank-loan-service.test.ts` — passed (3 tests).
- `bun run typecheck` — passed.
- `git diff --check` — passed.

Implementation commit: `b22ab28594205584c99054b7f14ef2f84ce0fb7e`
