# Task 3 Report: Loan draft, preview, activation, and presentation

## Status

Implemented exact single-payment preview/draft/update/activation presentation and explicit floating accrual-cycle compatibility across the shared application service and REST loan contract.

## Changes

- Persist and present the normalized closed single-payment contract: due date, exact fixed agreed interest, mutually exclusive retroactive policy/rate, and the contracted late-penalty union.
- Keep the legacy `interestRate` field round-trippable for compatibility while schedule generation reads the fixed amount only from `singlePayment.fixedAgreedInterest`.
- Preserve single-payment terms across partial draft edits, clear incompatible columns when repayment type changes, and keep draft floating rate-period state synchronized with the edited policy.
- Activate single-payment drafts into exactly one schedule row, set `nextDueDate` to the contractual Bangkok due date, and roll up exact principal/interest without creating an actual payout record.
- Persist and present direct-capital funding independently from borrower disbursement events.
- Added a normalized `FloatingDailyInterest.accrualCycle`; legacy callers may omit the input and receive/persist `daily`, while explicit `weekly` survives preview, draft persistence, and presentation.
- Extended shared REST schemas with `single_payment`, closed single-payment terms, and floating accrual cycle. Public loan bodies retain exact string money validation and reject unknown fields (including nested fields) with stable `VALIDATION_ERROR` responses.
- Kept the currently frozen MCP contract stable by projecting the new presenter-only fields out of existing `loan.preview`, `loan.draft`, and `loan.activate` MCP responses until Task 6 synchronizes its input/output schemas, snapshot, plugin, and evals.
- Updated README loan-management behavior and the versioned root changelog.

## TDD Evidence

### Service RED

Command:

```text
cd backend && bun test src/services/loan-application-service.test.ts
```

Observed: `3 pass, 16 skip, 1 fail`. The new floating preview omitted the expected default `accrualCycle: "daily"`.

Disposable PostgreSQL command after correcting a test-only non-canonical money fixture:

```text
cd backend && ./scripts/test-disposable-postgres.sh src/services/loan-application-service.test.ts
```

Observed: `18 pass, 2 fail`. The floating preview still omitted the cycle, and PostgreSQL rejected the single-payment draft because the service left every new contractual column null (`loans_single_payment_terms_check`).

### REST RED

Command:

```text
cd backend && bun test src/modules/loans-route-composition.test.ts
```

Observed: `1 pass, 3 fail`. REST rejected `single_payment`, stripped the explicit weekly cycle back to the legacy daily default, and could not reach stable single-payment domain errors. After adding the new DTO schemas, a focused second RED was `3 pass, 1 fail`: unknown top-level/nested fields were still normalized away and accepted with HTTP 200 instead of rejected with 422.

### GREEN

Focused kernel/service/route regression and typecheck:

```text
cd backend && bun test src/lib/floating-daily-interest.test.ts src/lib/public-loan-terms.test.ts src/lib/public-loan-schedule.test.ts src/services/loan-application-service.test.ts src/modules/loans-route-composition.test.ts
cd backend && bun run typecheck
```

Observed: `20 pass, 16 skip, 0 fail`; `tsc --noEmit` passed. The skipped cases are database-backed and were run in the disposable suite below.

The first full backend regression run exposed one intended cross-adapter compatibility RED: `154 pass, 127 skip, 1 fail`, where the frozen MCP output schema rejected the new `floatingDailyInterest.accrualCycle`. After adding the frozen-shape MCP projection, the focused MCP/service/route suite reported `18 pass, 16 skip, 0 fail` and typecheck passed. A fresh full backend run then reported `155 pass, 127 skip, 0 fail` with `1043 expect()` calls.

Disposable PostgreSQL service and route verification:

```text
cd backend && ./scripts/test-disposable-postgres.sh src/services/loan-application-service.test.ts src/modules/loans-route-composition.test.ts
```

Observed: migrations applied successfully; `24 pass, 0 fail`, `131 expect()` calls.

Additional hygiene:

```text
git diff --check
```

Observed: pass.

## Financial and Compatibility Review

- All persisted/public money remains exact decimal strings; no financial `Number` conversion was added.
- The activated maturity row is `5000.00` principal plus `500.00` fixed interest due exactly `2026-08-19`, even when compatibility `interestRate` is `99.00`.
- Fixed and greater-of-retroactive terms round-trip as closed policies; changing back to fixed clears retroactive and fixed-penalty columns before activation.
- Actual payout remains independent: single-payment activation creates no `loan_disbursements` row.
- Activated term edits still return `LOAN_TERMS_LOCKED` and PostgreSQL Task 2 triggers remain the final immutability boundary.

## Concerns / Follow-up Boundaries

- MCP schemas and the frozen CreditSync plugin contract remain unchanged; the adapter compatibility projection prevents Task 3 presenter fields from breaking existing tools until Task 6 owns synchronized MCP/plugin exposure of the new loan terms.
- Frontend loan creation remains unchanged; Task 7 owns localized single-payment and accrual-cycle controls.

## Review Fix Round 1

- Implemented real weekly floating semantics end to end: weekly rates apply once per seven-day period anchored to `interestStartDate`; `deduct` creates the paid first-period accrual on activation, while `start_next_day` starts at the first seven-day boundary. Omitted and explicit `daily` policies retain the original daily dates.
- Applied the cycle to preview next-interest dates, catch-up accrual creation, payment health, payment allocation, and append-only correction. Correction now rejects an identified but off-cycle row with `ACCRUAL_DATE_NOT_SCHEDULED` before changing history.
- Added a generic MCP preflight hook and a default `loan.activate` guard that reads the draft and rejects unsupported single-payment activation with `MCP_LOAN_TYPE_UNSUPPORTED` before the financial handler runs. Both a stateful handler regression and a real PostgreSQL adapter regression prove no schedule, audit, rollup, or status mutation occurs.
- Rejected explicit `totalInstallments` and `installmentAmount` on single-payment terms. Partial updates now reject explicit incompatible daily/floating/single-payment objects, preserve same-type metadata, and clear inherited installment or policy metadata only on an actual repayment-type transition.
- Normalized malformed, zero, over-precise, and invalid-cycle floating policies to the stable HTTP 400 `{ error: "Floating interest policy is invalid", code: "INVALID_LOAN_TERMS" }` response for preview, create, and update without leaking Decimal errors.
- Updated immutable-loan payment fixtures to seed contractual penalty fields before activation, preserving the PostgreSQL immutability boundary during the expanded disposable-suite verification.

### Review TDD Evidence

The first non-database RED run reported `24 pass, 4 fail`: weekly dates were daily, single-payment installment metadata was accepted, MCP returned `INVALID_TOOL_OUTPUT` after invoking activation, and malformed floating input escaped the stable REST response. The first disposable PostgreSQL RED run reported `52 pass, 8 fail`, including the weekly accrual/health/correction, update-transition, REST, and real MCP post-mutation failures.

After implementation, the focused non-database suite reported `28 pass, 0 fail`; backend typecheck passed. The focused disposable PostgreSQL suite reported `60 pass, 0 fail`, `471 expect()` calls.

Final verification:

- Backend non-database suite: `160 pass, 132 skip, 0 fail`, `1078 expect()` calls; `tsc --noEmit` passed. Database-only skips were exercised by the disposable suite.
- Full disposable PostgreSQL suite: `291 pass, 1 skip, 0 fail`, `1972 expect()` calls. The sole skip is the existing cache-invalidation case that depends on a configured cache service.
- Frontend project runner: Vitest `100 pass, 0 fail`; ESLint passed; TypeScript/Vite production build passed with only the existing chunk-size advisory.
- CreditSync plugin: `32 pass, 0 fail`, `697 expect()` calls; validator passed for Plugin `2.4.0`, eight skills, and the frozen 41-tool contract.
- `git diff --check` passed.

## Review Fix Round 2

- Replaced boundary-only weekly charging with the approved cumulative-difference model. A `5000.00` principal at `12%` weekly now records daily increments of `85.71`, `85.72`, and `85.71` through day three (`257.14` cumulative) and reaches exactly `600.00` on day seven.
- Added explicit weekly period metadata and `accruing`/`due` states. Interim snapshots contribute to closing and health projections but remain outside normal payment allocation; all seven rows become due together at the period boundary and overdue from the following Bangkok date.
- Preserved principal and effective-rate segments within a period, recomputed corrected rows append-only, and represented `deduct` as seven paid, non-refundable first-period snapshots.
- Added migration `0028_floating_weekly_period_snapshots` with database checks plus a trigger that permits settlement-state updates while rejecting deletion or mutation of active financial snapshot history.
- Moved the frozen MCP repayment-type guard into `activateLoan()` after `SELECT ... FOR UPDATE`; a deterministic lock-race regression proves a concurrent transition to `single_payment` returns `MCP_LOAN_TYPE_UNSUPPORTED` without schedules, audit, rollup, or activation mutation.
- Restored the closed REST `daily|weekly` enum while retaining the stable `INVALID_LOAN_TERMS` response, and preserved Decimal-compatible daily rate canonicalization including leading-zero input while rejecting malformed, zero, and over-precise strings.

### Review Round 2 TDD Evidence

The focused non-database RED run reported `9 pass, 4 fail, 1 error`: the period kernel and migration were absent, leading-zero Decimal input failed, and the route schema enum was open. The focused disposable PostgreSQL RED run reported `57 pass, 6 fail`, covering interim accrual, due promotion, principal-sensitive payment allocation, weekly advance snapshots, exact closing, and the MCP row-lock race.

After implementation, the focused non-database suite passed and backend typecheck passed. The initial focused disposable PostgreSQL suite reported `63 pass, 0 fail`, `488 expect()` calls; subsequent focused payment/health verification reported `34 pass, 0 fail`, including exact boundary allocation, rate segmentation, and database-enforced snapshot immutability.

Final verification: backend non-database `165 pass, 136 skip, 0 fail`; full disposable PostgreSQL `300 pass, 1 skip, 0 fail`, `2015 expect()` calls; frontend Vitest `100 pass, 0 fail`, ESLint and production build passed with only the existing chunk-size advisory; CreditSync plugin `32 pass, 0 fail`, `697 expect()` calls, and both validators passed; `git diff --check` passed.

## Review Fix Round 3

- Rebuilt the floating closing summary from the current obligation: `outstandingPrincipal + unpaid due interest + accruing interest + outstandingFees + applicable penalty`. Historical signed payments remain an informational `totalPaid` field and are not subtracted a second time. Closing responses now expose exact `fees` and `penalty` components.
- Added database-backed closing regressions after interest-only payment, mixed interest/principal payment, compensating reversal, and settlement during an advance-covered first period. Fixed and daily-percent late policies are calculated per overdue obligation group with Bangkok grace-day handling and net paid-penalty history.
- Made the advance-covered first weekly period reconstruct from immutable activation principal and initial rate-period basis. A later principal repayment no longer reduces a corrected paid snapshot; seven active paid rows remain exactly `600.00` for `5000.00 @ 12% weekly`.
- Replaced ambiguous weekly preview labels with typed public fields: `fullPeriodInterest`, `advanceInterest`, `netBorrowerPayout`, `coveredStartDate`, `coveredEndDate`, `periodDays`, `nextInterestDate`, and `nonRefundable`. Weekly deduct returns the true next boundary; daily preview remains byte-compatible. The frozen MCP projection maps these values into its legacy response shape until Task 6 owns the synchronized contract.

### Review Round 3 TDD Evidence

The non-database RED showed weekly preview still returning `dailyInterestAtCurrentPrincipal` and the anchor date. The PostgreSQL RED reported four intended failures: correction reduced the paid advance total from `600.00` to `582.86`; closing after interest-only payment reported `5485.71` instead of `5620.71`; mixed payment reported `4300.00` instead of `4900.00`; and the new preview contract was absent. Reversal and covered-advance closing cases already passed and remain regression coverage.

Final verification: backend non-database `165 pass, 141 skip, 0 fail`, `1107 expect()` calls and typecheck passed; full disposable PostgreSQL `305 pass, 1 skip, 0 fail`, `2040 expect()` calls; frontend Vitest `100 pass, 0 fail`, ESLint and production build passed with only the existing chunk-size advisory; CreditSync plugin `32 pass, 0 fail`, `697 expect()` calls, and its TypeScript validator passed for Plugin `2.4.0`, eight skills, and the frozen 41-tool contract; `git diff --check` passed.
