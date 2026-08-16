# Task 3 Report: Localized Fund Detail Recovered-Cash Explanation

## Status

DONE_WITH_CONCERNS

## Implemented

- Added matching `fundDetail.availableOwnCapitalExplanation` locale keys to `frontend/src/locales/en.json` and `frontend/src/locales/th.json`.
- Rendered the localized helper beneath the available amount in `frontend/src/pages/dashboard/funds/FundDetail.tsx` only for `capital_pool` sources.
- Kept the existing available amount, limit, allocation, utilization, and exact money formatting unchanged.
- Updated `CHANGELOG.md` under `v0.3.14 - 2026-08-16`.

## Verification

- `git diff --check`: passed.
- `cd frontend && bun test`: blocked during test setup because `@happy-dom/global-registrator` is unavailable; 12 suites failed before test execution.
- `cd frontend && bun run lint`: blocked because `eslint` is unavailable in the worktree.
- `cd frontend && bun run build`: blocked because `tsc` is unavailable in the worktree.

No backend code or financial calculation was changed.
