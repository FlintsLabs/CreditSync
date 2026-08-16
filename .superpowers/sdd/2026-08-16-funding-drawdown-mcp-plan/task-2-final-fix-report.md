# Task 2 final fix report

Fix commit: `ba46944c4d3bd13b31a9986299235498375d1b02`

Implemented all four review fixes:

1. Activation idempotency now consistently compares `activationRequestHash`.
2. The Drizzle `bank_loans.status` default is `draft`, matching migration `0040`.
3. Draft creation and activation lock the bank profile before drawdown-row work; activation rechecks current draft-plus-active exposure against the current credit limit with Decimal arithmetic.
4. `BankDrawdownInput` carries explicit `repaymentMode`; validation, persistence, and activation schedule generation support `fixed_installment` and reject unsupported modes.

Verification:

- Focused tests: 9 passed across the migration, service, and schedule test files. Bun required the explicit `././src/...` form in this environment; the prompt’s exact command was interpreted as name filters and ran no files.
- `cd backend && bunx tsc --noEmit`: passed.
- `git diff --check eb5de73 HEAD`: passed.
