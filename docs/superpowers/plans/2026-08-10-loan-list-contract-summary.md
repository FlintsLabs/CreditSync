# Loan List Contract Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show localized repayment agreement and clear Bangkok dates on every loan card, while moving internal funding metrics out of the list.

**Architecture:** Add persisted `startDate` to the tenant-scoped list projection. The UI consumes only that list response, formats existing exact money strings, and no longer fetches allocation/profitability metrics per card.

**Tech Stack:** Bun, Elysia, Drizzle, React, TypeScript, i18next, Vitest, Testing Library.

## Global Constraints

- Public money stays as two-decimal decimal strings; do not use `Number` for financial formatting.
- Update English and Thai UI copy together.
- Creation times use `Asia/Bangkok`; `startDate` remains date-only.
- Do not alter financial records or calculate repayment amounts in the client.
- Leave the unrelated landing-login plan unmodified and unstaged.

---

### Task 1: Extend the read-only loan list contract

**Files:**
- Modify: `backend/src/modules/loans.ts:225-250`
- Test: `backend/src/services/loan-application-service.test.ts:520-556`

**Interfaces:** Produces list rows with `startDate: string | null`.

- [ ] **Step 1: Write failing route-contract assertion**

Seed a loan with `startDate: "2099-01-15"`, then assert the authenticated list response contains `{ startDate: "2099-01-15" }`.

- [ ] **Step 2: Verify red**

Run backend's focused loan-application service test. It must fail because the route omits `startDate`.

- [ ] **Step 3: Add additive route projection**

Select `startDate: loans.startDate` in the list query and retain it in the mapped response. Do not change cache or money serialization.

- [ ] **Step 4: Verify green**

Re-run the focused backend test; it passes.

### Task 2: Render contract summaries instead of funding metrics

**Files:**
- Create: `frontend/tests/loan-list.vitest.tsx`
- Modify: `frontend/src/pages/dashboard/loans/LoanList.tsx:13-75,156-231`
- Modify: `frontend/src/locales/en.json:378-411`
- Modify: `frontend/src/locales/th.json:378-411`

**Interfaces:** Consumes `{ principal: string; repaymentType: string; installmentAmount: string | null; totalInstallments: number | null; startDate: string | null; createdAt: string }`; produces contract/date fields without funding requests.

- [ ] **Step 1: Write failing component tests**

Mock only the list response with complete fixed and floating rows. Assert a daily row renders its repayment type, exact installment, count, start-date label, and creation timestamp; assert floating renders no-fixed-schedule and unavailable-start-date text. Assert no request goes to allocation state or profitability endpoints.

- [ ] **Step 2: Verify red**

Run the focused frontend list test. It must fail because summary/date fields are absent and metric requests remain.

- [ ] **Step 3: Implement minimum UI change**

Extend `LoanRow`, fetch only `/loans`, and use the existing exact-money formatter. Remove the four funding/profitability cells. Add a localized fixed-vs-floating summary and labelled start/creation dates; creation includes time in Bangkok. Add matching `loans` keys in both locale files.

- [ ] **Step 4: Verify green**

Re-run the focused frontend test; it passes.

### Task 3: Verify and commit

**Files:** Modify `CHANGELOG.md` under `v0.3.6`.

- [ ] **Step 1: Record the shipped behavior**

Add a concise changelog entry for the contract-summary cards, labelled dates, and removal of internal list metrics.

- [ ] **Step 2: Run required quality gates**

Run backend typecheck, the disposable PostgreSQL service test, all frontend tests, lint, and production build. Every command exits zero and the disposable suite runs.

- [ ] **Step 3: Inspect and commit task files**

Run whitespace and status checks, stage only the files above plus `CHANGELOG.md`, and create a conventional feature commit. Confirm unrelated untracked files remain unstaged.
