# Task 2 Report

Status: DONE_WITH_CONCERNS

Implemented and committed as `c63ae6690834cef3d17a7066cb2197f20980d28f`.

- Funding usage now groups `transactions.amount` only for positively allocated loan IDs.
- Positive allocation denominators exclude negative allocation rows.
- Decimal.js source-share attribution exposes exact two-decimal `linkedBorrowerCashCollected` at response and allocation-row levels.
- Recovered cash increases available amount only for `capital_pool`; external-liability capacity, utilization, settlement summaries, and ROI calculations remain unchanged.
- Updated `CHANGELOG.md` before commit.

Verification:

- `cd backend && bun test src/modules/bank-profiles.test.ts`: command passed, but all 10 integration tests were skipped because `TEST_DATABASE_URL` is unset.
- Backend typecheck was attempted and is blocked by the existing unresolved `decimal.js` import in `frontend/src/lib/financial-decimal.ts`.
- `git diff --check`: passed.

Concern: the disposable PostgreSQL suite could not execute in this environment, so GREEN runtime verification remains pending in an environment with `TEST_DATABASE_URL` and the disposable database available.
