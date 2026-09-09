# Repayment History Mobile List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn mobile repayment history records into compact divider-separated, full-row navigation targets without changing the desktop table or financial behavior.

**Architecture:** Keep data fetching, quick capture, formatting, and desktop rendering in `LoanRepaymentHistory.tsx`. Add a small posted-component summary formatter at the presentation boundary and replace only the `md:hidden` record-card branch with one semantic list and native row buttons.

**Tech Stack:** React 19, TypeScript 6, Tailwind CSS 4, react-i18next, React Router, Vitest, Testing Library, Bun.

## Global Constraints

- Never calculate or compare financial values with JavaScript `Number`; use `Decimal` for zero filtering and retain `formatMoneyExact` for display.
- Preserve API contracts, record ordering, status behavior, quick capture, and desktop table.
- Update `frontend/src/locales/en.json` and `frontend/src/locales/th.json` together for user-facing copy.
- Do not include the unrelated Payment Inbox or locale edits from the main checkout.

---

### Task 1: Flat Mobile Repayment History Rows

**Files:**
- Modify: `frontend/tests/loan-repayment-history.vitest.tsx`
- Modify: `frontend/src/pages/dashboard/loans/LoanRepaymentHistory.tsx`
- Modify: `frontend/src/locales/en.json`
- Modify: `frontend/src/locales/th.json`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: `PaymentIntakeHistoryItem`, `openIntake(publicId)`, `formatMoneyExact(value, language)`, and existing repayment-history translation keys.
- Produces: mobile list rows identified by `data-testid="mobile-repayment-row"` and the new `loanDetail.repaymentHistory.viewDetails` translation.

- [ ] **Step 1: Write a failing mobile-list component test**

Extend the fixture with `fee: "0.00"` and `penalty: "0.00"`. Assert the mobile branch contains a native row button, `Principal ฿100.00`, `Interest ฿25.00`, no visible `Fee ฿0.00` or `Penalty ฿0.00`, and no nested `Open payment review` button. Activate the row and assert navigation includes its intake and loan IDs.

- [ ] **Step 2: Run the focused test and verify RED**

Run `cd frontend && bun run test -- tests/loan-repayment-history.vitest.tsx`.

Expected: FAIL because mobile records are bordered `div` cards, all zero components are printed, and navigation is owned by a nested full-width button.

- [ ] **Step 3: Implement the minimal flat list**

In `LoanRepaymentHistory.tsx`:

- Import `ChevronRight` and `Decimal`.
- Add a presentation helper that returns only posted component entries whose exact Decimal amount is non-zero.
- Keep `Allocation` for the desktop table.
- Replace `space-y-3 md:hidden` with a `divide-y divide-border/70 md:hidden` list.
- Render each record as `button type="button"`, `data-testid="mobile-repayment-row"`, `min-h-16`, `min-w-0`, full width, left aligned, and with hover/focus/pressed styling.
- Retain amount, received time, status, reference, latest allocation fallback, and non-zero posted component summary.
- Add a compact translated `View details` label plus `ChevronRight`; remove the nested full-width action button.

Add `viewDetails` as `View details` and `ดูรายละเอียด` to English and Thai locales.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run `cd frontend && bun run test -- tests/loan-repayment-history.vitest.tsx`.

Expected: all repayment-history tests pass.

- [ ] **Step 5: Record the implementation**

Under `CHANGELOG.md` version `v0.3.11 - 2026-08-13`, add a `### Changed` bullet describing the flat mobile repayment-history list, concise non-zero component summary, and full-row review navigation.

- [ ] **Step 6: Run verification gates**

Run:

```bash
cd frontend && bun run test
cd frontend && bun run lint
cd frontend && bun run build
```

Expected: all commands exit zero; the existing Vite chunk-size advisory may remain non-fatal.

- [ ] **Step 7: Inspect and commit the scoped diff**

Run `git diff --check`, inspect all changed files, stage only the component, test, paired locales, and changelog, then commit with `fix: flatten mobile repayment history`.
