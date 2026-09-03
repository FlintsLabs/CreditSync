# Weekly Overdue Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make loan-list payment-health cards distinguish daily and weekly overdue obligations using backend-authoritative values before the UI renders them.

**Architecture:** Extend the existing `paymentHealth` DTO with the unit and count of overdue obligations. The backend derives these values from the authoritative contract policy and grouped payable records; the frontend only selects localized copy and formats already-computed money. Preserve `maxOverdueDays` as the actual calendar age of the oldest overdue due date.

**Tech Stack:** Bun, TypeScript, Elysia, Drizzle, `decimal.js`/`FinancialDecimal`, React, i18next, Vitest/Bun test.

**Spec:** [`docs/superpowers/specs/2026-08-11-loan-list-payment-health-design.md`](/home/flintstone/github/CreditSync/docs/superpowers/specs/2026-08-11-loan-list-payment-health-design.md)

## Global Constraints

- Money crosses public interfaces as two-decimal decimal strings and must be calculated with `decimal.js`; never use JavaScript floating point or `Number` for financial values.
- Use the `Asia/Bangkok` business timezone.
- Active loan terms and posted financial records are immutable; this change is read-only and requires no financial write.
- Frontend text must use the active i18n language; update English and Thai translations together.
- Keep public UUIDs and the existing payment-health states backward compatible.
- Do not change payment posting, interest accrual, penalty, allocation, MCP, or database schemas.

## File Map

- Modify `backend/src/lib/loan-payment-health.ts`: add the backend-owned overdue obligation unit/count to the shared calculation result.
- Modify `backend/src/services/loan-payment-health-service.ts`: map weekly contract policy and grouped floating obligations into the new DTO fields.
- Modify `backend/src/modules/loan-contract-routes.ts`: expose the additive DTO fields through the loan-list response without per-card API calls.
- Modify `backend/src/lib/loan-payment-health.test.ts`: unit-test daily and weekly obligation semantics.
- Modify `backend/src/services/loan-payment-health-service.test.ts`: integration-test weekly floating periods and exact totals.
- Modify `frontend/src/pages/dashboard/loans/LoanPaymentHealthBadge.tsx`: render backend-provided unit/count; never calculate money.
- Modify `frontend/tests/loan-list.vitest.tsx`: verify daily/weekly localized rendering and legacy fallback.
- Modify `frontend/src/locales/en.json` and `frontend/src/locales/th.json`: add matching daily/weekly/obligation copy.
- Modify `docs/superpowers/specs/2026-08-11-loan-list-payment-health-design.md`: document the additive DTO and distinction between obligation count and calendar age.
- Modify `CHANGELOG.md`: record the user-facing display correction before commit.

### Task 1: Update the payment-health contract and specification

**Files:**
- Modify: `docs/superpowers/specs/2026-08-11-loan-list-payment-health-design.md`
- Modify: `backend/src/lib/loan-payment-health.ts`
- Test: `backend/src/lib/loan-payment-health.test.ts`

**Interfaces:**
- Add `overdueObligationUnit: "day" | "week" | "installment"` and `overdueObligationCount: number` to `LoanPaymentHealth`.
- Keep `maxOverdueDays: number` unchanged and document it as calendar age, not weekly-period count.

- [ ] Write failing unit tests asserting a daily floating loan returns `day` plus its overdue-date count, while a weekly floating loan returns `week` plus its grouped overdue-period count.
- [ ] Run `bun test backend/src/lib/loan-payment-health.test.ts`; verify the new assertions fail because the fields do not exist.
- [ ] Implement the minimal DTO/type and calculation fields. For scheduled loans use `installment` unless the caller supplies a cadence-specific mapping; for floating loans count each payable due-date group once.
- [ ] Update the spec's payment-health contract and presentation rules with an example showing `overdueAmount: "1800.00"`, `overdueObligationUnit: "week"`, `overdueObligationCount: 3`, and `maxOverdueDays: 3` as separate meanings.
- [ ] Run the focused test again and confirm it passes.
- [ ] Commit the contract/spec/test change after updating `CHANGELOG.md`.

### Task 2: Derive daily versus weekly semantics in the backend service

**Files:**
- Modify: `backend/src/services/loan-payment-health-service.ts`
- Modify: `backend/src/modules/loan-contract-routes.ts`
- Test: `backend/src/services/loan-payment-health-service.test.ts`

**Interfaces:**
- Consume `loan.interestPeriodUnit`, `loan.floatingAccrualCycle`, and the already grouped authoritative balances.
- Produce the extended `LoanPaymentHealth` object for every loan-list row.

- [ ] Add an integration test for the target shape: a weekly floating loan with three unpaid completed weekly groups returns `overdueAmount` as the sum of three weekly obligations, `overdueObligationUnit: "week"`, count `3`, and calendar age independently.
- [ ] Add a regression test proving a weekly period with seven daily accrual snapshots counts as one overdue obligation, not seven and not a daily multiplication of the weekly amount.
- [ ] Run `bun test backend/src/services/loan-payment-health-service.test.ts`; verify the new assertions fail.
- [ ] Implement unit selection from persisted policy: floating `periodUnit === "week"` or `floatingAccrualCycle === "weekly"` maps to `week`; floating daily maps to `day`; fixed schedules remain `installment` unless their existing presentation explicitly identifies daily obligations.
- [ ] Set the count from the same payable groups used to compute `overdueAmount`; do not recreate interest or penalty calculations and do not use `Number` for money.
- [ ] Run the focused service tests and the loan-contract route tests; confirm the response remains additive and tenant filtering is unchanged.
- [ ] Commit the backend change with the changelog entry.

### Task 3: Render the backend semantics in English and Thai

**Files:**
- Modify: `frontend/src/pages/dashboard/loans/LoanPaymentHealthBadge.tsx`
- Modify: `frontend/src/locales/en.json`
- Modify: `frontend/src/locales/th.json`
- Test: `frontend/tests/loan-list.vitest.tsx`

**Interfaces:**
- Consume `overdueObligationUnit` and `overdueObligationCount` from API data.
- Continue consuming `overdueAmount` and `maxOverdueDays` only as already formatted/displayed values.

- [ ] Add frontend fixtures and failing tests for daily floating copy and weekly floating copy in both supported languages.
- [ ] Add a regression assertion that `1800.00` is rendered exactly as the API value and is never multiplied in the component.
- [ ] Add a compatibility test for an older response missing the new fields; retain the current fallback wording rather than labeling an unknown unit as weekly.
- [ ] Run `bun test frontend/tests/loan-list.vitest.tsx`; verify the new assertions fail.
- [ ] Implement localized keys such as `overdueObligations.day`, `overdueObligations.week`, and `overdueObligations.installment`; use the backend unit/count for the badge and retain a separate “up to N days overdue” line for calendar age.
- [ ] Update `en.json` and `th.json` together, keeping the same key structure and avoiding mixed-language strings.
- [ ] Run the focused frontend tests and confirm card navigation, exact-money formatting, and lifecycle status behavior remain unchanged.
- [ ] Commit the frontend/i18n change with the changelog entry.

### Task 4: Full verification and handoff

**Files:**
- Modify: `CHANGELOG.md`

- [ ] Run backend disposable PostgreSQL tests using `backend/scripts/test-disposable-postgres.sh`.
- [ ] Run backend typecheck and the focused payment-health tests.
- [ ] Run frontend tests, lint, and production build.
- [ ] Inspect the final diff to confirm no financial writes, schema migrations, MCP contract changes, raw sensitive data, or unrelated `AGENTS.md` changes were introduced.
- [ ] Verify the target production contract through read-only CreditSync MCP after deployment or against the updated API response: weekly policy, weekly full-period interest, overdue obligation count, and calendar age must be separately visible.
- [ ] Confirm `CHANGELOG.md` is staged with the code/docs changes before the final commit.

## Acceptance Criteria

- A weekly contract never has its weekly overdue amount multiplied by the number of overdue days in the UI.
- The API returns the unit/count derived from the persisted contract and payable groups.
- The UI does no financial calculation and displays exact decimal strings from the API.
- Weekly cards show weekly obligations/periods, while calendar overdue age remains separately available when useful.
- Daily, scheduled, legacy, English, Thai, large-money, and existing payment-health tests pass.
