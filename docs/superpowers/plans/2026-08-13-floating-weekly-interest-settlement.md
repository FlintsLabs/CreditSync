# Floating Weekly Interest and Settlement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generalize floating loans to exact day- or week-quoted interest, daily-prorated weekly accrual, non-refundable one-period advance interest, and previewed settlement.

**Architecture:** Replace daily-only public policy naming with a period policy while preserving additive compatibility columns and immutable accrual snapshots. A Decimal-only kernel owns period boundaries and cumulative rounding; application services materialize daily snapshots, promote completed periods to due, and execute settlement through an expiring preview. REST, MCP, plugin, and Web consume backend projections without recalculating money.

**Tech Stack:** Bun, TypeScript, Elysia, Drizzle ORM, PostgreSQL, `decimal.js`, React, TanStack Query, i18next, Vitest, CreditSync MCP/plugin.

## Global Constraints

- Keep `repaymentType: "floating"`; do not create fixed weekly schedules.
- Money crosses public interfaces as two-decimal strings and all calculations use `decimal.js`, never `Number`.
- Weekly periods are `[periodStart, nextPeriodStart)` in `Asia/Bangkok`; weekends and holidays are not skipped.
- Persist the contractual period rate; never persist `weeklyRate / 7` as a daily rate.
- `advanceInterestPeriods` is `0 | 1`; advance interest is always `non_refundable`.
- Posted accruals, advance charges, payments, and settlements are immutable and reversed only with compensating entries.
- All financial writes carry command context, request/correlation ID, actor/source, idempotency, and audit history.
- Update `frontend/src/locales/en.json` and `frontend/src/locales/th.json` together.
- Before every commit, update `CHANGELOG.md`; update `README.md` with the user-facing weekly floating workflow.

---

## File Map

- Create `backend/src/lib/floating-interest-policy.ts`: policy normalization, periods, cumulative/increment calculations.
- Create `backend/src/lib/floating-interest-policy.test.ts`: exact Decimal and date semantics.
- Create `backend/drizzle/0027_floating_interest_period_policy.sql`: additive policy/accrual/settlement-preview persistence and legacy backfill.
- Create `backend/src/db/floating-interest-period-policy-migration.test.ts`: migration constraints and backfill contract.
- Modify `backend/src/db/schema.ts`: typed policy, accrual snapshot, and settlement preview tables.
- Modify `backend/src/services/loan-application-service.ts`: preview/draft/activate generalized policy and advance charge.
- Modify `backend/src/services/floating-interest-service.ts`: period-aware accrual and due promotion.
- Create `backend/src/services/loan-settlement-service.ts`: preview/execute close-out.
- Create `backend/src/services/loan-settlement-service.test.ts`: financial invariants, stale preview, reversal boundaries.
- Modify `backend/src/services/payment-service.ts`: exclude accruing interest from normal allocation.
- Modify `backend/src/modules/loan-route-schemas.ts`, `backend/src/modules/loan-contract-routes.ts`: strict REST schemas.
- Create `backend/src/modules/loan-settlement-routes.ts`: settlement preview/execute endpoints.
- Modify `backend/src/mcp/server.ts`, `backend/src/mcp/default.ts`: public MCP policy and settlement tools.
- Modify `frontend/src/pages/dashboard/loans/LoanWizard.tsx`: weekly/advance controls and server preview.
- Create `frontend/src/pages/dashboard/loans/FloatingInterestSummary.tsx`: rate, period, accrual, due, advance display.
- Modify `frontend/src/pages/dashboard/loans/LoanDetail.tsx`: summary and settlement confirmation.
- Update CreditSync plugin manifest, contract, skills, evals, validator, README, and tests atomically.

### Task 1: Exact period-policy calculation kernel

**Files:**
- Create: `backend/src/lib/floating-interest-policy.ts`
- Create: `backend/src/lib/floating-interest-policy.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces: `FloatingInterestPolicy`, `normalizeFloatingInterestPolicy(input)`, `interestPeriodFor(anchorDate, businessDate, policy)`, `calculatePeriodInterest(principal, policy)`, and `calculateAccruedInterest(principal, policy, elapsedDays)`.
- `calculateAccruedInterest` returns `{ cumulativeAmount: string; incrementAmount: string; elapsedDays: number; periodDays: number }`.

- [ ] **Step 1: Write failing normalization and exact-rounding tests**

```ts
test("keeps a weekly contractual rate and reaches its exact period amount", () => {
  const policy = normalizeFloatingInterestPolicy({ periodUnit: "week", periodLength: 1, rateMode: "percent", rate: "12", advanceInterestPeriods: 0, advanceInterestRefundPolicy: "non_refundable" });
  expect(policy.rate).toBe("12.0000");
  expect(calculateAccruedInterest("5000.00", policy, 3)).toMatchObject({ cumulativeAmount: "257.14", incrementAmount: "85.71" });
  expect(calculateAccruedInterest("5000.00", policy, 7).cumulativeAmount).toBe("600.00");
});

test("uses half-open Bangkok weekly periods", () => {
  expect(interestPeriodFor("2026-08-13", "2026-08-20", weeklyPolicy)).toEqual({ periodStart: "2026-08-20", nextPeriodStart: "2026-08-27", dayIndex: 0, periodDays: 7 });
});
```

- [ ] **Step 2: Run the kernel test and verify it fails because the module is absent**

Run: `cd backend && bun test src/lib/floating-interest-policy.test.ts`

- [ ] **Step 3: Implement validation and cumulative-difference rounding with Decimal**

Reject unsupported unit/length, non-positive or >4dp rate, and unsupported advance/refund values. Calculate `cumulative(d)` and subtract `cumulative(d-1)`; do not divide then round a reusable daily amount.

- [ ] **Step 4: Run kernel tests and existing daily-interest tests**

Run: `cd backend && bun test src/lib/floating-interest-policy.test.ts src/lib/floating-daily-interest.test.ts`

- [ ] **Step 5: Update changelog and commit**

```bash
git add CHANGELOG.md backend/src/lib/floating-interest-policy.ts backend/src/lib/floating-interest-policy.test.ts
git commit -m "feat: calculate floating interest by period"
```

### Task 2: Additive policy and accrual persistence

**Files:**
- Create: `backend/drizzle/0027_floating_interest_period_policy.sql`
- Create: `backend/src/db/floating-interest-period-policy-migration.test.ts`
- Modify: `backend/src/db/schema.ts`
- Modify: `backend/drizzle/meta/_journal.json`
- Create: `backend/drizzle/meta/0027_snapshot.json`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: normalized values from Task 1.
- Produces: loan policy columns, period-unit snapshots on `loan_interest_rate_periods`, period-boundary/cumulative fields on `loan_interest_accruals`, and `loan_settlement_previews`.

- [ ] **Step 1: Write a failing migration contract test**

Assert checks for `day|week`, period length `= 1`, advance periods `0|1`, non-refundable policy, tenant-safe settlement preview FK, preview expiry/hash/status, and legacy backfill from `first_day_treatment`.

- [ ] **Step 2: Run the migration contract test and confirm failure**

Run: `cd backend && bun test src/db/floating-interest-period-policy-migration.test.ts`

- [ ] **Step 3: Add schema and SQL migration**

Backfill daily loans as `period_unit='day'`, `period_length=1`, and advance `1` only for legacy `deduct`. Preserve existing accrual amounts; populate new snapshot fields only where derivable without rewriting history.

- [ ] **Step 4: Generate the Drizzle snapshot and run disposable database tests**

Run: `cd backend && bun x drizzle-kit generate`

Run: `backend/scripts/test-disposable-postgres.sh src/db/floating-interest-period-policy-migration.test.ts src/db/floating-interest-rate-periods-migration.test.ts src/db/floating-daily-interest-migration.test.ts`

- [ ] **Step 5: Update changelog and commit**

```bash
git add CHANGELOG.md backend/drizzle/0027_floating_interest_period_policy.sql backend/drizzle/meta backend/src/db/schema.ts backend/src/db/floating-interest-period-policy-migration.test.ts
git commit -m "feat: persist floating period policies"
```

### Task 3: Preview, draft, and activate weekly policies

**Files:**
- Modify: `backend/src/services/loan-application-service.ts`
- Modify: `backend/src/services/loan-application-service.test.ts`
- Modify: `backend/src/modules/loan-route-schemas.ts`
- Modify: `backend/src/modules/loan-contract-routes.ts`
- Modify: `backend/src/lib/calculator.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: `FloatingInterestPolicy` and calculator functions from Task 1.
- Produces: `floatingInterestPolicy` request/response and preview fields `fullPeriodInterest`, `advanceInterest`, `netBorrowerPayout`, `firstPeriodStartDate`, `firstPeriodDueDate`, `periodDays`.

- [ ] **Step 1: Add failing service tests for weekly preview and advance activation**

```ts
expect(previewLoan(weeklyAdvanceInput)).toMatchObject({
  fullPeriodInterest: "600.00",
  advanceInterest: "600.00",
  netBorrowerPayout: "4400.00",
  firstPeriodStartDate: "2026-08-13",
  firstPeriodDueDate: "2026-08-20",
  periodDays: 7,
});
```

Also assert activation creates seven first-period snapshots totaling THB 600 in `paid` state exactly once and a retry creates no duplicates.

- [ ] **Step 2: Run focused service tests and confirm failure**

Run: `backend/scripts/test-disposable-postgres.sh src/services/loan-application-service.test.ts`

- [ ] **Step 3: Implement strict generalized policy input and activation posting**

Accept `floatingInterestPolicy`; retain legacy response compatibility only behind the existing presenter. At activation, post the advance charge and immutable covered snapshots in the same transaction and audit payload.

- [ ] **Step 4: Run application, route, and type checks**

Run: `backend/scripts/test-disposable-postgres.sh src/services/loan-application-service.test.ts`

Run: `cd backend && bun x tsc --noEmit`

- [ ] **Step 5: Update changelog and commit**

```bash
git add CHANGELOG.md backend/src/services/loan-application-service.ts backend/src/services/loan-application-service.test.ts backend/src/modules/loan-route-schemas.ts backend/src/modules/loan-contract-routes.ts backend/src/lib/calculator.ts
git commit -m "feat: originate weekly floating loans"
```

### Task 4: Period-aware accrual, due promotion, and normal payments

**Files:**
- Modify: `backend/src/services/floating-interest-service.ts`
- Create: `backend/src/services/floating-interest-service.test.ts`
- Modify: `backend/src/services/payment-service.ts`
- Modify: `backend/src/services/payment-service.test.ts`
- Modify: `backend/src/services/loan-payment-health-service.ts`
- Modify: `backend/src/lib/loan-payment-health.ts`
- Modify: corresponding tests
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces: `accrueFloatingInterestThrough(tx, loan, through, actorUserId)` with `accruing|due|paid|partially_paid|reversed` snapshots and `floatingInterestDue` that excludes `accruing`.

- [ ] **Step 1: Write failing database-backed tests for days 1–7, due/overdue, and principal changes**

Assert days 1–6 show projection but normal payment allocates zero interest; boundary day exposes THB 600 due; following Bangkok date is overdue; principal paid on day 3 changes day 4 onward only.

- [ ] **Step 2: Run the focused suites and verify failures**

Run: `backend/scripts/test-disposable-postgres.sh src/services/floating-interest-service.test.ts src/services/payment-service.test.ts src/services/loan-payment-health-service.test.ts`

- [ ] **Step 3: Implement per-date period resolution and state promotion**

Resolve the period effective on every missing accrual date. Snapshot cumulative and increment values. Promote all active rows of a completed period consistently without editing financial amounts.

- [ ] **Step 4: Run focused suites and verify all pass**

Run the command from Step 2 again.

- [ ] **Step 5: Update changelog and commit**

```bash
git add CHANGELOG.md backend/src/services/floating-interest-service* backend/src/services/payment-service* backend/src/services/loan-payment-health-service* backend/src/lib/loan-payment-health*
git commit -m "feat: accrue weekly floating interest"
```

### Task 5: Previewed settlement and compensating reversal boundary

**Files:**
- Create: `backend/src/services/loan-settlement-service.ts`
- Create: `backend/src/services/loan-settlement-service.test.ts`
- Create: `backend/src/modules/loan-settlement-routes.ts`
- Create: `backend/src/modules/loan-settlement-routes.test.ts`
- Modify: `backend/src/index.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces: `previewLoanSettlement(ctx, loanPublicId, asOfDate)` and `executeLoanSettlement(ctx, { settlementPublicId, previewHash, confirmed: true, reason })`.
- Preview returns exact principal, due interest, accrued-not-due interest, fees, penalties, non-refundable advance history, settlement total, hash, expiry, and balance version.

- [ ] **Step 1: Write failing service tests for the three approved examples**

Assert `5257.14` after three days without advance, `5000.00` additional during advance-covered period, and `5257.14` on day three of period two; add stale hash, expiry, concurrent payment, idempotent execute, and non-refundable assertions.

- [ ] **Step 2: Run the settlement suite and confirm failure**

Run: `backend/scripts/test-disposable-postgres.sh src/services/loan-settlement-service.test.ts src/modules/loan-settlement-routes.test.ts`

- [ ] **Step 3: Implement preview/execute with row locking and append-only entries**

Do not reuse normal payment preview for accruing interest. Execute materializes through `asOfDate`, posts exact components, closes only when principal and charges are zero, and writes audit/correlation IDs.

- [ ] **Step 4: Run settlement, payment, and reversal suites**

Run: `backend/scripts/test-disposable-postgres.sh src/services/loan-settlement-service.test.ts src/modules/loan-settlement-routes.test.ts src/services/payment-service.test.ts`

- [ ] **Step 5: Update changelog and commit**

```bash
git add CHANGELOG.md backend/src/index.ts backend/src/services/loan-settlement-service* backend/src/modules/loan-settlement-routes*
git commit -m "feat: settle floating loans exactly"
```

### Task 6: Synchronize MCP and CreditSync plugin contracts

**Files:**
- Modify: `backend/src/mcp/server.ts`, `backend/src/mcp/default.ts`, and MCP tests/snapshot
- Modify: `plugins/creditsync/.codex-plugin/plugin.json`, `plugins/creditsync/README.md`, `plugins/creditsync/CHANGELOG.md`
- Modify: `plugins/creditsync/skills/manage-loans/SKILL.md`, `plugins/creditsync/skills/manage-floating-interest-rates/SKILL.md`
- Create: `plugins/creditsync/skills/settle-floating-loans/SKILL.md`
- Modify: plugin contract, validator, evals, harness, and tests
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces closed-schema `loan.settlement.preview` and destructive/idempotent `loan.settlement.execute`; generalizes preview/draft policy schemas.

- [ ] **Step 1: Update tests first to require new tools, skill, policy contract, annotations, and stop gates**

Add a positive settlement case and negative stale/missing-confirmation/non-refundable-refund cases. Expected flow is inspect loan → preview → show exact composition → explicit confirmation → execute.

- [ ] **Step 2: Run MCP/plugin tests and verify contract failures**

Run: `cd backend && bun test src/mcp/server.test.ts src/mcp/default.test.ts`

Run: `cd plugins/creditsync && bun test`

- [ ] **Step 3: Implement handlers and synchronize every frozen artifact**

MCP calls application services directly, exposes public UUIDs/two-decimal strings only, and never computes settlement itself.

- [ ] **Step 4: Run MCP/plugin validation**

Run: `cd backend && bun test src/mcp/server.test.ts src/mcp/default.test.ts && bun x tsc --noEmit`

Run: `cd plugins/creditsync && bun test && bun run validate`

- [ ] **Step 5: Update changelogs/README and commit**

```bash
git add CHANGELOG.md README.md backend/src/mcp plugins/creditsync
git commit -m "feat: expose weekly floating settlement"
```

### Task 7: Localized Web origination, detail, and settlement UI

**Files:**
- Modify: `frontend/src/pages/dashboard/loans/LoanWizard.tsx`
- Create: `frontend/src/pages/dashboard/loans/FloatingInterestSummary.tsx`
- Modify: `frontend/src/pages/dashboard/loans/LoanDetail.tsx`
- Modify: `frontend/src/locales/en.json`, `frontend/src/locales/th.json`
- Create/modify: `frontend/tests/floating-weekly-interest.vitest.tsx`, `frontend/tests/loan-detail-settlement.vitest.tsx`
- Modify: `README.md`, `CHANGELOG.md`

**Interfaces:**
- Consumes backend preview and settlement fields from Tasks 3 and 5.

- [ ] **Step 1: Write failing UI tests**

Assert weekly/12%/advance controls, backend-produced THB 600/4,400 preview, non-refundable warning, accruing vs due labels, and confirmation that displays every settlement component.

- [ ] **Step 2: Run focused frontend tests and confirm failure**

Run: `cd frontend && bun test tests/floating-weekly-interest.vitest.tsx tests/loan-detail-settlement.vitest.tsx`

- [ ] **Step 3: Implement UI without financial calculations**

Use exact string formatters and active i18n language. Disable execute until the current preview is explicitly confirmed; refresh on stale conflicts.

- [ ] **Step 4: Run focused tests, lint, and build**

Run: `cd frontend && bun test tests/floating-weekly-interest.vitest.tsx tests/loan-detail-settlement.vitest.tsx && bun run lint && bun run build`

- [ ] **Step 5: Update README/changelog and commit**

```bash
git add CHANGELOG.md README.md frontend/src/pages/dashboard/loans frontend/src/locales frontend/tests/floating-weekly-interest.vitest.tsx frontend/tests/loan-detail-settlement.vitest.tsx
git commit -m "feat: manage weekly floating loans"
```

### Task 8: Full financial verification and production-style checks

**Files:**
- Modify tests/docs only if verification finds a defect; update `CHANGELOG.md` with any resulting fix.

- [ ] **Step 1: Run serialized backend financial suites and typecheck**

Run: `backend/scripts/test-disposable-postgres.sh src/services/loan-application-service.test.ts src/services/floating-interest-service.test.ts src/services/loan-settlement-service.test.ts src/services/payment-service.test.ts src/services/loan-payment-health-service.test.ts src/mcp/default.test.ts`

Run: `cd backend && bun x tsc --noEmit`

- [ ] **Step 2: Run frontend and plugin gates**

Run: `cd frontend && bun test && bun run lint && bun run build`

Run: `cd plugins/creditsync && bun test && bun run validate`

- [ ] **Step 3: Scan financial implementation for forbidden native-number conversions**

Run: `rg -n "Number\(|parseFloat\(|parseInt\(" backend/src/lib/floating-interest-policy.ts backend/src/services/floating-interest-service.ts backend/src/services/loan-settlement-service.ts frontend/src/pages/dashboard/loans`

Expected: no financial conversion matches; date/index parsing must be explicitly reviewed.

- [ ] **Step 4: Inspect migration and production-style health read-only**

Run infra then app using documented Compose commands; verify migration columns through PostgreSQL, backend migration logs, `http://127.0.0.1:3000/mcp/health` inside backend, and `http://127.0.0.1:8088/` publicly. Do not create live tenant records.

- [ ] **Step 5: Commit only if verification required changes**

Stage only the verified fix plus matching changelog entry; otherwise leave the verified commits unchanged.
