# Floating Advance-Interest Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Display backend-calculated advance interest, first-period terms, and net borrower payout on floating-loan detail pages, with a non-mutating warning when posted payout differs.

**Architecture:** Extend `presentLoan` with an optional backend-owned `floatingPayoutSummary` derived through the existing floating calculation primitives and exact decimals. Pass that response through `LoanDetail` into the existing `FloatingInterestSummary`; derive posted gross payout only from the disbursement ledger and use it solely for an informational mismatch warning.

**Tech Stack:** Bun, TypeScript, Drizzle ORM, decimal.js, React 19, i18next, Vitest/Testing Library.

## Global Constraints

- Money remains two-decimal strings calculated with `decimal.js`; frontend code never calculates accounting values.
- Dates use `YYYY-MM-DD` contract dates and the `Asia/Bangkok` business interpretation.
- Posted financial records, principal, schedules, and policy data remain immutable.
- A disbursement mismatch is informational only and never changes accounting state.
- Thai and English locale keys change together.

---

### Task 1: Backend floating payout summary

**Files:**
- Modify: `backend/src/services/loan-application-service.test.ts`
- Modify: `backend/src/services/loan-application-service.ts`

**Interfaces:**
- Consumes: `FloatingInterestPolicy`, `calculateInterestAmount`, the existing first-period calendar helper, and `FinancialDecimal`.
- Produces: `floatingPayoutSummary: { fullPeriodInterest: string; advanceInterest: string; netBorrowerPayout: string; periodDays: number; firstPeriodStartDate: string; firstPeriodDueDate: string } | null` on `presentLoan`.

- [ ] **Step 1: Write the failing weekly advance-interest response test**

Add an assertion to the weekly floating-loan service test after draft retrieval:

```ts
expect(detail.floatingPayoutSummary).toEqual({
  fullPeriodInterest: "600.00",
  advanceInterest: "600.00",
  netBorrowerPayout: "4400.00",
  periodDays: 7,
  firstPeriodStartDate: "2026-08-13",
  firstPeriodDueDate: "2026-08-20",
});
```

- [ ] **Step 2: Run the focused backend test and verify RED**

Run: `cd backend && bun test src/services/loan-application-service.test.ts`

Expected: FAIL because `floatingPayoutSummary` is absent.

- [ ] **Step 3: Add the minimal backend calculation**

In `presentLoan`, when `floatingInterestPolicy` and `row.startDate` exist, use the existing floating-period calendar and interest calculation to return the six exact fields. Set `advanceInterest` to the full-period amount only for one advance period, and calculate `netBorrowerPayout` with `FinancialDecimal.minus`. Return `null` for incomplete policy data.

- [ ] **Step 4: Add and run the zero-advance compatibility test**

Assert `advanceInterest: "0.00"` and `netBorrowerPayout` equal to principal for a floating policy with `advanceInterestPeriods: 0`. Run the same focused test; expected PASS.

- [ ] **Step 5: Commit the backend contract**

```bash
git add backend/src/services/loan-application-service.ts backend/src/services/loan-application-service.test.ts CHANGELOG.md
git commit -m "feat(loans): expose floating payout summary"
```

### Task 2: Loan-detail presentation and mismatch warning

**Files:**
- Modify: `frontend/src/pages/dashboard/loans/LoanDetail.tsx`
- Modify: `frontend/src/pages/dashboard/loans/FloatingInterestSummary.tsx`
- Modify: `frontend/src/locales/en.json`
- Modify: `frontend/src/locales/th.json`
- Test: `frontend/tests/floating-advance-interest-summary.vitest.tsx`

**Interfaces:**
- Consumes: `loan.floatingPayoutSummary` from Task 1 and `LoanDisbursements` posted-event summary already loaded by Loan Detail.
- Produces: rendered exact contract values and optional `payoutMismatch` presentation props; no financial calculation.

- [ ] **Step 1: Write the failing render test**

Render a floating loan detail response containing the Task 1 summary and assert localized labels show `฿600.00` advance interest and `฿4,400.00` net payout. Mock API payloads only at the HTTP boundary; render the real components.

- [ ] **Step 2: Run the frontend test and verify RED**

Run: `cd frontend && bun test tests/floating-advance-interest-summary.vitest.tsx`

Expected: FAIL because Loan Detail does not pass summary props.

- [ ] **Step 3: Pass backend values to the existing summary card**

Extend the loan response type and pass:

```tsx
fullPeriodInterest={loan.floatingPayoutSummary?.fullPeriodInterest}
advanceInterest={loan.floatingPayoutSummary?.advanceInterest}
netBorrowerPayout={loan.floatingPayoutSummary?.netBorrowerPayout}
periodDays={loan.floatingPayoutSummary?.periodDays}
firstPeriodStartDate={loan.floatingPayoutSummary?.firstPeriodStartDate}
firstPeriodDueDate={loan.floatingPayoutSummary?.firstPeriodDueDate}
```

Run the focused test; expected PASS.

- [ ] **Step 4: Write the failing posted-payout mismatch test**

Provide posted gross payout `4300.00` with contract net payout `4400.00`; assert the localized informational warning contains both exact values. Provide only draft/reversed events in a second case and assert no warning.

- [ ] **Step 5: Implement non-mutating mismatch presentation**

Compute only the sum of posted `grossAmount` values using the existing exact-money view model helper or a backend-provided ledger summary; never subtract principal or derive interest in the UI. Pass the posted gross and contract net strings into `FloatingInterestSummary`, which compares exact normalized strings and renders the localized warning.

- [ ] **Step 6: Add locale keys and verify parity**

Add equivalent `loanDetail.floatingSummary.payoutMismatch` strings to `en.json` and `th.json`. Run:

```bash
cd frontend
bun test tests/floating-advance-interest-summary.vitest.tsx tests/locale-parity.vitest.ts
```

Expected: PASS.

- [ ] **Step 7: Commit the frontend presentation**

```bash
git add frontend/src/pages/dashboard/loans/LoanDetail.tsx frontend/src/pages/dashboard/loans/FloatingInterestSummary.tsx frontend/src/locales/en.json frontend/src/locales/th.json frontend/tests/floating-advance-interest-summary.vitest.tsx CHANGELOG.md
git commit -m "feat(loans): show advance interest on loan detail"
```

### Task 3: Full verification, documentation, merge readiness

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: backend contract and frontend rendering from Tasks 1–2.
- Produces: release documentation and independently verified merge candidate.

- [ ] **Step 1: Update user-facing documentation**

Document that floating loan detail shows contract advance interest/net payout and warns when actual posted payout differs, without mutating financial records.

- [ ] **Step 2: Run backend verification**

```bash
cd backend
bun test src/services/loan-application-service.test.ts
bun run typecheck
```

Expected: all tests pass and TypeScript exits zero.

- [ ] **Step 3: Run frontend verification**

```bash
cd frontend
bun test
bun run lint
bun run build
```

Expected: all tests, lint, typecheck, and production build pass.

- [ ] **Step 4: Review financial and compatibility diff**

Run `git diff --check` and inspect `git diff main...HEAD`. Confirm there are no writes to migrations, posted ledgers, principal, schedules, or evidence and no unrelated user-file changes.

- [ ] **Step 5: Commit documentation and changelog**

```bash
git add CHANGELOG.md README.md docs/superpowers/plans/2026-08-16-floating-advance-interest-summary.md
git commit -m "docs: document floating payout summary"
```

- [ ] **Step 6: Request independent review**

Ask a reviewer to verify backend ownership of all calculations, exact money strings, posted-only mismatch behavior, locale parity, regression coverage, and clean verification output before merge/deploy.

