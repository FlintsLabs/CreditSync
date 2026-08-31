# Custom Scheduled Installments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make weekly and monthly loans honor a custom installment count and fixed installment amount so a ฿30,000 principal can be represented as 10 weekly payments of ฿5,000, with the derived ฿20,000 scheduled interest.

**Architecture:** Extend the existing Decimal-backed `calculateLoanSchedule` path. When both custom fields are supplied for a scheduled repayment, the count and fixed total become authoritative and the residual above principal becomes scheduled interest; legacy schedules without the pair retain their current term-based behavior. Reuse the existing public REST/MCP terms and frontend form fields, adding validation and preview copy only where needed.

**Tech Stack:** Bun, TypeScript, Elysia, Drizzle/PostgreSQL, `decimal.js` via `FinancialDecimal`, React, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-31-custom-scheduled-installments-design.md`

## Global Constraints

- Money crossing public interfaces remains two-decimal decimal strings and uses `FinancialDecimal`.
- Active loan terms and posted financial records remain immutable; this change affects origination calculation only.
- Existing daily custom schedules and non-custom weekly/monthly schedules remain backward compatible.
- Use `Asia/Bangkok` business dates and ISO `YYYY-MM-DD` due dates.
- Update `CHANGELOG.md` before every commit; update `README.md` if user-facing setup/workflow documentation changes.

---

### Task 1: Add calculator regression coverage for custom scheduled terms

**Files:**
- Modify: `backend/src/modules/loans-route-composition.test.ts` or the closest existing calculator test file after locating the current schedule unit tests
- Test: `backend/src/lib/calculator.test.ts` if the repository has a direct calculator test file; otherwise add focused cases to the existing calculator test suite

**Interfaces:**
- Consumes: `calculateLoanSchedule` / `calculatePublicLoanSchedule` existing public term shape
- Produces: executable failing tests for weekly/monthly custom count + amount, residual interest, final-row rounding, mismatch rejection, and legacy fallback

- [ ] **Step 1: Write the failing weekly custom schedule test**

```ts
it("uses a custom weekly installment count and derives fixed-total interest", () => {
  const rows = calculateLoanSchedule({
    principal: "30000.00", interestRate: "0.00", termMonths: 3,
    repaymentType: "weekly", startDate: new Date("2026-08-31T00:00:00Z"),
    totalInstallments: 10, installmentAmount: "5000.00",
  });
  expect(rows).toHaveLength(10);
  expect(rows[0]).toMatchObject({ dueDate: "2026-09-07", amount: "5000.00", principalComponent: "3000.00", interestComponent: "2000.00" });
  expect(rows.at(-1)).toMatchObject({ dueDate: "2026-11-09", remainingPrincipal: "0.00" });
  expect(rows.reduce((sum, row) => sum + row.interestComponent, 0)).toBe(20000);
});
```

Use `FinancialDecimal` in the actual assertion aggregation rather than JavaScript numeric addition; the snippet is illustrative and the committed test must preserve decimal-string safety.

- [ ] **Step 2: Add monthly custom and validation tests**

Cover a 3-month custom schedule with 3 installments, assert due dates advance monthly; assert one-sided custom fields reject; assert total custom amount below principal rejects; assert weekly without custom fields still produces `termMonths * 4` rows.

- [ ] **Step 3: Run the focused test and verify the expected RED failure**

Run: `bun test backend/src/lib/calculator.test.ts` (or the located test file)

Expected: the new weekly case fails because weekly currently always uses `termMonths * 4` and does not derive fixed-total interest.

### Task 2: Implement authoritative custom scheduled calculation

**Files:**
- Modify: `backend/src/lib/calculator.ts`
- Test: the focused calculator tests from Task 1

**Interfaces:**
- Consumes: normalized `LoanCalculationParams` with optional `totalInstallments` and `installmentAmount`
- Produces: schedule rows whose count and total match the custom pair for weekly/monthly; unchanged legacy behavior otherwise

- [ ] **Step 1: Add paired-field validation in normalization**

In `normalizePublicLoanTerms`, reject exactly-one-of `totalInstallments` and `installmentAmount` for `weekly` and `monthly` with a domain-readable error. Keep daily validation behavior intact.

- [ ] **Step 2: Write the minimal custom-count/amount branch**

In `calculateLoanSchedule`, set `customFixedScheduled = (repaymentType === "weekly" || repaymentType === "monthly") && totalInstallments !== undefined && installmentAmount !== undefined`; use the supplied count, fixed total, and `fixedTotal.minus(principalMoney)` as scheduled interest. Retain the existing term-derived count and annual-rate interest when `customFixedScheduled` is false.

- [ ] **Step 3: Preserve exact Decimal allocation and date cadence**

Use the existing final-installment residual logic for principal and interest. Keep weekly date increments at 7 days and monthly increments at one calendar month. Reject fixed totals below principal before generating rows.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `bun test backend/src/lib/calculator.test.ts` (or the located test file)

Expected: all new custom and legacy calculator cases pass.

### Task 3: Prove REST/MCP preview and draft paths preserve the custom terms

**Files:**
- Modify: `backend/src/modules/loan-contract-routes.test.ts`
- Modify: `backend/src/modules/loan-daily-origination.test.ts` only if shared origination coverage is the established location
- Inspect/modify: `backend/src/mcp/default.ts` only if the existing MCP adapter drops the fields

**Interfaces:**
- Consumes: `previewLoan`, `createLoanDraft`, existing closed MCP loan tools
- Produces: route/MCP coverage proving `totalInstallments=10` and `installmentAmount="5000.00"` produce a ten-row preview and draft snapshot

- [ ] **Step 1: Add failing HTTP preview regression test**

Post `/loans/preview` with `{ principal: "30000.00", interestRate: "0.00", termMonths: 3, repaymentType: "weekly", startDate: "2026-08-31", totalInstallments: 10, installmentAmount: "5000.00" }`; assert status 200, ten rows, first amount `5000.00`, and total interest `20000.00` across rows.

- [ ] **Step 2: Run the route test and verify RED**

Run: `bun test backend/src/modules/loan-contract-routes.test.ts`

Expected: preview returns twelve rows or the old term-derived result.

- [ ] **Step 3: Add draft serialization coverage and implement only required adapter changes**

Create a draft through the existing test helper, assert the persisted draft exposes the custom pair and generated schedule metadata. Do not add new database columns or financial writes beyond the draft operation already covered by the test.

- [ ] **Step 4: Run route/MCP tests and verify GREEN**

Run: `bun test backend/src/modules/loan-contract-routes.test.ts backend/src/modules/loan-agent-routes.test.ts`

Expected: all targeted backend route and MCP tests pass.

### Task 4: Update frontend workflow validation and preview presentation

**Files:**
- Modify: `frontend/src/lib/workflow-model.ts`
- Modify: `frontend/src/pages/dashboard/loans/LoanWizard.tsx`
- Modify: `frontend/src/locales/en.json`
- Modify: `frontend/src/locales/th.json`
- Test: `frontend/tests/workflow-model.test.ts`
- Test: `frontend/tests/loan-wizard.vitest.tsx`

**Interfaces:**
- Consumes: existing loan wizard form fields and backend preview response
- Produces: custom weekly/monthly fields serialized as decimal strings, clear paired-field validation, and preview UI that shows ten installments and derived interest without hardcoded mixed-language text

- [ ] **Step 1: Add failing model/UI tests**

Assert `buildLoanTermsInput` includes `{ totalInstallments: 10, installmentAmount: "5000.00" }` for weekly forms, rejects only-one-of fields, and the wizard preview renders the returned ten-row schedule and total interest summary when supplied by the API.

- [ ] **Step 2: Run frontend focused tests and verify RED**

Run: `bun test frontend/tests/workflow-model.test.ts frontend/tests/loan-wizard.vitest.tsx`

Expected: the new preview assertion fails because the UI has no scheduled fixed-total summary or the validation message is not exposed.

- [ ] **Step 3: Implement minimal model and copy changes**

Keep the existing pair serialization, add only the scheduled-type guard/validation needed by the backend contract, and add localized labels for custom total repayment and derived interest. Render the summary using exact money formatters and the active locale.

- [ ] **Step 4: Run focused frontend tests and verify GREEN**

Run: `bun test frontend/tests/workflow-model.test.ts frontend/tests/loan-wizard.vitest.tsx`

Expected: all focused frontend tests pass in both language fixtures.

### Task 5: Update documentation, changelog, and run verification gates

**Files:**
- Modify: `README.md` if the loan workflow documentation mentions fixed installment limitations
- Modify: `CHANGELOG.md`
- Test: existing backend and frontend suites

**Interfaces:**
- Consumes: completed implementation and test evidence from Tasks 1–4
- Produces: documented release note and verified branch state

- [ ] **Step 1: Add user-facing documentation only where applicable**

Document that weekly/monthly loans may provide both a custom installment count and fixed installment amount; explain that the total above principal is scheduled interest. Keep examples in THB decimal-string form.

- [ ] **Step 2: Update changelog before the implementation commit**

Add a `v0.3.66 - 2026-08-31` entry under `### Added` describing custom fixed-total weekly/monthly schedules, consolidating the already committed design entry if needed so the version/date/type accurately describe the final staged set.

- [ ] **Step 3: Run verification gates**

Run backend disposable tests with `backend/scripts/test-disposable-postgres.sh`, backend typecheck, frontend test/lint/build, and relevant plugin validator/tests if the changed MCP contract requires them. Do not treat skipped database tests as sufficient.

- [ ] **Step 4: Inspect final diff and status**

Run `git diff --check`, `git status --short`, and `git diff --stat`; verify no unrelated files from the original worktree are present and no financial record was created.

- [ ] **Step 5: Commit implementation with changelog**

```bash
git add backend frontend README.md CHANGELOG.md docs/superpowers/plans/2026-08-31-custom-scheduled-installments.md
git commit -m "feat: support custom scheduled installments"
```

