# Loan Schedule Deferral Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an auditable defer-payment workflow that moves only fully unpaid scheduled installments to a new installment at the end of the contract.

**Architecture:** Keep original schedule contractual fields immutable. Add an append-only deferral relation and a new replacement schedule row; transition only mutable operational fields on the source row so it cannot be selected for payment or counted overdue. Expose one authenticated command endpoint and render the command in the existing repayment-schedule tab.

**Tech Stack:** Bun, TypeScript, Elysia, Drizzle/PostgreSQL, decimal.js, React, i18next, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-25-loan-schedule-deferral-design.md`

## Global Constraints

- Money crosses public interfaces as two-decimal decimal strings and must be calculated with `decimal.js`.
- Use the `Asia/Bangkok` business timezone and `YYYY-MM-DD` due dates.
- Active loan terms and posted financial records are immutable; corrections use append-only history.
- Every financial write needs command context, request/correlation ID, actor/source, idempotency where supported, and audit history.
- Frontend text must use the active i18n language and update `en.json` and `th.json` together.
- Do not modify the existing user change in `frontend/src/lib/release.ts`.

---

### Task 1: Add the deferral persistence model and migration

**Files:**
- Modify: `backend/src/db/schema.ts`
- Create: `backend/drizzle/0056_loan_schedule_deferrals.sql`
- Test: `backend/src/db/loan-schedule-deferral-migration.test.ts`

**Interfaces:**
- Produces `loanScheduleDeferrals` with tenant-safe foreign keys to loan/source/replacement schedules and a unique tenant/idempotency constraint.
- Produces `deferred` schedule status support without weakening the activated contractual-field trigger.

- [ ] **Step 1: Write migration contract tests** asserting the new table, required columns, unique idempotency constraint, tenant-safe foreign keys, append-only trigger, and no change to contractual immutability.
- [ ] **Step 2: Run the focused migration test and verify it fails because the migration/model is absent.**
- [ ] **Step 3: Add the Drizzle table definition and SQL migration with append-only protection, status/check constraints, and tenant-safe relationships.**
- [ ] **Step 4: Run the focused migration test and verify it passes.**
- [ ] **Step 5: Run schema/type checks for the backend.**

### Task 2: Implement the transactional deferral service and route

**Files:**
- Create: `backend/src/services/loan-schedule-deferral-service.ts`
- Modify: `backend/src/modules/loan-contract-routes.ts`
- Test: `backend/src/services/loan-schedule-deferral-service.test.ts`
- Test: `backend/src/modules/loan-contract-routes.test.ts`

**Interfaces:**
- Consumes `CommandContext`, accessible loan lookup, `loanSchedules`, `loans`, `loanScheduleDeferrals`, `createAuditLog`, `invalidateTenantCache`, `FinancialDecimal`, and Bangkok date helpers.
- Produces `deferLoanSchedule(ctx, loanPublicId, schedulePublicId, { reason })` returning source/replacement public IDs, updated due date, serialized amount fields, audit public ID, and correlation ID.

- [ ] **Step 1: Add failing service tests for a successful deferral: source row has zero paid amount, replacement row is appended at `max(due_date, installment_no) + 1 day`, amounts match exactly, source becomes `deferred`, loan totals extend, and audit payload links both rows.**
- [ ] **Step 2: Add failing tests for partial-payment rejection, paid/empty-row rejection, inactive/floating-loan rejection, missing reason/idempotency rejection, tenant isolation, and idempotent replay.**
- [ ] **Step 3: Run the focused service tests and verify they fail for the missing service.**
- [ ] **Step 4: Implement the transaction with loan/source row locks, eligibility re-checks, Decimal money handling, append-only deferral insert, replacement insert, mutable source transition, loan rollup update, and audit creation.**
- [ ] **Step 5: Add the authenticated `POST /:id/schedule/:scheduleId/defer` route using the standard request context/error envelope and invalidate the loan cache only after success.**
- [ ] **Step 6: Run focused service and route tests and verify they pass.**

### Task 3: Update schedule read models and summary semantics

**Files:**
- Modify: `backend/src/modules/loan-contract-routes.ts`
- Modify: `backend/src/lib/overdue.ts` only if a narrow deferred-state guard is required
- Test: `backend/src/modules/loan-contract-routes.test.ts`

- [ ] **Step 1: Add failing read-model tests asserting deferred rows serialize with `status: "deferred"`, source/replacement metadata, and no overdue penalty; partial rows serialize paid and remaining amounts unchanged.**
- [ ] **Step 2: Add failing summary tests asserting deferred rows are excluded from paid/overdue/due/pending counts while replacement rows are counted.**
- [ ] **Step 3: Implement the narrow read-model changes without changing existing partial-payment or penalty calculations.**
- [ ] **Step 4: Run focused read-model tests and the existing loan payment-health tests.**

### Task 4: Add the repayment-schedule UI workflow and translations

**Files:**
- Modify: `frontend/src/pages/dashboard/loans/LoanRepaymentScheduleTab.tsx`
- Modify: `frontend/src/locales/en.json`
- Modify: `frontend/src/locales/th.json`
- Test: `frontend/src/pages/dashboard/loans/LoanRepaymentScheduleTab.test.tsx`

- [ ] **Step 1: Add failing component tests for partial display (`paid`, `remaining`, `partial`), no defer action when paid amount is positive, defer action when paid amount is zero, reason dialog, confirmation text, API submission, and refreshed schedule.**
- [ ] **Step 2: Run the focused frontend test and verify it fails because the new UI is absent.**
- [ ] **Step 3: Implement exact decimal-string rendering, action/dialog state, idempotency header, error display, and schedule refresh using existing UI primitives and i18n keys in both languages.**
- [ ] **Step 4: Update status styling so deferred rows are neutral/blue and partial rows show paid plus remaining values.**
- [ ] **Step 5: Run the focused frontend test and verify it passes.**

### Task 5: Full verification and documentation

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `README.md` only if the user-facing workflow/setup documentation requires it

- [ ] **Step 1: Run `backend/scripts/test-disposable-postgres.sh` and inspect the complete result.**
- [ ] **Step 2: Run backend typecheck and frontend test/lint/build with Bun.**
- [ ] **Step 3: Run plugin validator/tests if the frozen plugin contract or skills are affected; otherwise document why they are unaffected.**
- [ ] **Step 4: Update `CHANGELOG.md` under an explicit version/date heading with the schedule-deferral behavior.**
- [ ] **Step 5: Review `git diff` and `git status --short` to confirm only scoped files changed and the pre-existing release file remains preserved.**
