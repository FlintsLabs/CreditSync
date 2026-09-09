# Floating Daily Interest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create auditable floating loans that charge either a fixed daily amount per ฿1,000 or a daily percentage, and expose the policy through Web, REST, and MCP.

**Architecture:** Store immutable daily-interest policy on a floating loan and persist one accrual row per Bangkok business date. The shared loan/payment services calculate accruals under the loan row lock; REST and MCP only adapt the shared DTOs. The wizard renders the same preview returned by the backend, rather than calculating financial values itself.

**Tech Stack:** Bun, TypeScript, Elysia, Drizzle/PostgreSQL, Decimal.js, Zod, React, i18next, Bun tests.

## Global Constraints

- Use Decimal.js for every money calculation; public money is a two-decimal string.
- Use `Asia/Bangkok` and `YYYY-MM-DD` for business dates.
- `per_thousand` is `openingPrincipal / 1000 × rate`; `percent` is `openingPrincipal × rate / 100`; round each day half-up to cents.
- A principal payment changes the rate from the following business date; interest never compounds.
- The first-day choice is `deduct` or `start_next_day`; active policy terms are immutable.
- Never delete financial history; use reversals/adjustments.
- Update English and Thai copy together, `CHANGELOG.md` for every commit, and `README.md` for user-facing changes.

---

### Task 1: Persist and validate floating-daily policy

**Files:**
- Create: `backend/drizzle/0015_floating_daily_interest.sql`
- Modify: `backend/drizzle/meta/_journal.json`, `backend/src/db/schema.ts`
- Test: `backend/src/db/floating-daily-interest-migration.test.ts`

**Interfaces:**
- Produces `loans.dailyInterestMode`, `dailyInterestRate`, `firstDayTreatment`, `interestStartDate` and append-only `loanInterestAccruals` rows.

- [ ] Write migration-contract tests asserting nullable policy fields, tenant-scoped `(tenant_id, loan_id, accrual_date)` uniqueness, and additive migration registration.
- [ ] Run `bun test src/db/floating-daily-interest-migration.test.ts` and verify it fails before migration exists.
- [ ] Add schema and SQL migration: `daily_interest_mode`, `daily_interest_rate`, `first_day_treatment`, `interest_start_date`; create `loan_interest_accruals` with UUID, opening principal, rate snapshot, interest amount, status, source transaction/reversal IDs, and audit metadata.
- [ ] Run the migration test and `bun run typecheck`.
- [ ] Commit with `feat: persist floating daily interest policy`.

### Task 2: Build exact daily policy and accrual kernel

**Files:**
- Create: `backend/src/lib/floating-daily-interest.ts`
- Test: `backend/src/lib/floating-daily-interest.test.ts`

**Interfaces:**
- Produces `normalizeFloatingDailyInterest`, `calculateDailyInterest`, and `interestDatesThrough`.

- [ ] Write failing tests for ฿5,000 at 15 per thousand = ฿75.00/day, 1.5 percent = ฿75.00/day, cent rounding, deducted first day, and start-next-day date selection.
- [ ] Run `bun test src/lib/floating-daily-interest.test.ts` and verify failure.
- [ ] Implement pure Decimal functions with strict mode/rate/date validation and Bangkok calendar-date iteration.
- [ ] Run the kernel tests and `bun run typecheck`.
- [ ] Commit with `feat: calculate floating daily interest exactly`.

### Task 3: Apply policy through loan draft and activation

**Files:**
- Modify: `backend/src/services/loan-application-service.ts`, `backend/src/modules/loans.ts`, `backend/src/mcp/server.ts`
- Test: `backend/src/services/loan-application-service.test.ts`, `backend/src/mcp/server.test.ts`

**Interfaces:**
- Consumes `floatingDailyInterest: { mode, rate, firstDayTreatment }` only when `repaymentType: "floating"`.
- Produces preview/draft/activation fields `firstDayInterest`, `netDisbursement`, `nextInterestDate`, and policy data.

- [ ] Add failing service tests: reject policy on non-floating loans, create a floating draft with policy, activate `deduct` with one paid first-day accrual, and activate `start_next_day` with no first-day accrual.
- [ ] Run the focused test and verify failure.
- [ ] Extend loan input validation, draft persistence, presentation, activation lock path, REST TypeBox schemas, and frozen MCP schemas. Keep annual `interestRate` as `0.00` for this policy.
- [ ] Run focused backend/MCP tests and `bun run typecheck`.
- [ ] Commit with `feat: activate floating daily interest loans`.

### Task 4: Accrue and collect floating daily interest

**Files:**
- Create: `backend/src/services/floating-interest-service.ts`
- Modify: `backend/src/services/payment-service.ts`, `backend/src/services/loan-application-service.ts`
- Test: `backend/src/services/floating-interest-service.test.ts`, `backend/src/services/payment-service.test.ts`

**Interfaces:**
- Produces `accrueFloatingInterestThrough(tx, loan, throughDate)` and a read-only floating-interest summary.

- [ ] Write failing integration tests for idempotent date accrual, payment priority interest before principal, next-day principal effect, and rejected out-of-order reversal.
- [ ] Run the focused tests with `TEST_DATABASE_URL`; if it is unavailable, run non-DB tests and record that integration suite is skipped.
- [ ] Implement locked, idempotent accrual inserts; have payment preview/post request current accruals before explicit floating allocations, persist interest components, and restore accrual state on reversal.
- [ ] Run all backend tests and `bun run typecheck`.
- [ ] Commit with `feat: collect accrued floating daily interest`.

### Task 5: Render the wizard and loan detail policy

**Files:**
- Modify: `frontend/src/pages/dashboard/loans/LoanWizard.tsx`, `frontend/src/lib/workflow-model.ts`, `frontend/src/locales/en.json`, `frontend/src/locales/th.json`, `README.md`, `CHANGELOG.md`
- Test: `frontend/tests/workflow-model.test.ts`

**Interfaces:**
- Consumes backend `floatingDailyInterest` preview and sends it unchanged when saving the draft.

- [ ] Write failing view-model tests for the two rate modes and first-day choices being passed unchanged.
- [ ] Run `bun test tests/workflow-model.test.ts` and verify failure.
- [ ] Show rate mode/rate/first-day controls only for floating repayment, show backend preview of first-day interest/net payout/next interest date/daily amount, and add localized labels/errors in both locale files.
- [ ] Run `bun run build` and `bun test` in `frontend/`.
- [ ] Commit with `feat: configure floating daily interest in wizard`.

### Task 6: Deploy and verify

**Files:**
- Modify: `README.md`, `CHANGELOG.md` only if verification changes user-facing operator guidance.

- [ ] Run `bun test` and `bun run typecheck` in `backend/`, then `bun run build && bun test` in `frontend/`.
- [ ] Rebuild with `docker compose --env-file .env.production -f docker-compose.app.yml up --build -d`.
- [ ] Verify backend migration log, running container image, and `curl -fsS http://127.0.0.1:8088/`.
- [ ] Commit any verification-documentation change.
