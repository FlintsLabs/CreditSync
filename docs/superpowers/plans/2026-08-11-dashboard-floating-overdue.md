# Dashboard Floating Overdue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Include floating daily-interest arrears in Dashboard summary and borrower queue as one actionable row per loan with exact totals, overdue-item count, and maximum overdue age.

**Architecture:** Add a tenant-scoped Dashboard borrower-health loader that delegates all scheduled/floating classification and accrual materialization to `getLoanPaymentHealth`. Dashboard summary consumes loan-level health for exact borrower totals and overdue-loan count; the queue retains scheduled schedule rows and appends one aggregate floating row per payable loan. The frontend renders the aggregate metadata and omits `scheduleId` when navigating from floating rows.

**Tech Stack:** Bun, TypeScript, Elysia, Drizzle ORM, PostgreSQL, Decimal.js, React, React Router, i18next, Vitest/Testing Library.

## Global Constraints

- Money crossing Dashboard REST boundaries is a two-decimal string and is calculated with Decimal.js, never JavaScript floating point.
- Asia/Bangkok is the business timezone; timestamps remain ISO 8601 and due dates remain `YYYY-MM-DD`.
- Floating principal has no fixed schedule and must not be marked overdue merely because the loan is open.
- Existing floating accrual materialization stays idempotent and append-only.
- Frontend copy must be updated in `frontend/src/locales/en.json` and `frontend/src/locales/th.json` together.
- Every commit updates `CHANGELOG.md` with explicit version `v0.3.9`.

---

### Task 1: Tenant Dashboard borrower-health projection

**Files:**
- Create: `backend/src/services/dashboard-borrower-health-service.ts`
- Create: `backend/src/services/dashboard-borrower-health-service.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: `getLoanPaymentHealth(executor, loan, { asOf, actorUserId })` from `backend/src/services/loan-payment-health-service.ts`.
- Produces: `getDashboardBorrowerHealth(executor, { tenantId, actorUserId, asOf }): Promise<DashboardBorrowerHealthRow[]>`.
- `DashboardBorrowerHealthRow` contains `loanId`, `loanPublicId`, `borrowerName`, `repaymentType`, and the existing `LoanPaymentHealth` fields.

- [ ] **Step 1: Write the failing service test**

Create a database-backed test that inserts one active floating loan with four unpaid daily accruals and one active scheduled overdue loan. Call `getDashboardBorrowerHealth` and assert:

```ts
expect(floating).toMatchObject({
  repaymentType: "floating",
  status: "overdue",
  overdueAmount: "300.00",
  overdueItemCount: 4,
  maxOverdueDays: 4,
});
expect(rows.filter((row) => row.status === "overdue")).toHaveLength(2);
```

Use the disposable PostgreSQL setup already used by `loan-payment-health-service.test.ts`; do not mock payment-health calculations.

- [ ] **Step 2: Run the test to verify RED**

Run: `backend/scripts/test-disposable-postgres.sh src/services/dashboard-borrower-health-service.test.ts`

Expected: FAIL because `getDashboardBorrowerHealth` does not exist.

- [ ] **Step 3: Implement the minimal projection**

Load tenant loans and borrower names with tenant-scoped queries. Keep loans with active lifecycle status, call `getLoanPaymentHealth` with the provided Bangkok-aware `asOf`, and return public loan IDs plus unchanged health values. Process loans deterministically; do not reproduce schedule/accrual accounting in this service.

- [ ] **Step 4: Run focused database test and typecheck**

Run:

```bash
backend/scripts/test-disposable-postgres.sh src/services/dashboard-borrower-health-service.test.ts
cd backend && bun run typecheck
```

Expected: projection test passes and typecheck exits 0.

- [ ] **Step 5: Update changelog and commit**

Add a `v0.3.9` “Added” bullet describing the shared Dashboard borrower-health projection.

```bash
git add CHANGELOG.md backend/src/services/dashboard-borrower-health-service.ts backend/src/services/dashboard-borrower-health-service.test.ts
git commit -m "feat: project borrower health for dashboard"
```

---

### Task 2: Dashboard summary and queue contracts

**Files:**
- Modify: `backend/src/modules/dashboard.ts`
- Modify: `backend/src/lib/dashboard-money.ts`
- Modify: `backend/src/lib/dashboard-money.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: `getDashboardBorrowerHealth` from Task 1.
- Produces summary fields `dueFromBorrowersToday: string` and `overdueBorrowerCount: number` from loan health.
- Produces a floating borrower queue row with `scheduleId: null`, no `schedulePublicId`, `loanPublicId`, `remainingDue`, `totalDueNow`, `overdueItemCount`, `overdueDays`, `status`, and `repaymentType: "floating"`.

- [ ] **Step 1: Write failing exact aggregation tests**

Extend `dashboard-money.test.ts` with a helper contract that sums payable health without Number conversion:

```ts
expect(sumDashboardPayableHealth([
  { dueTodayAmount: "9007199254740993.01", overdueAmount: "0.99" },
  { dueTodayAmount: "1.00", overdueAmount: "2.00" },
])).toBe("9007199254740997.00");
```

Add a route/service integration assertion that four floating accruals produce one queue row while `overdueBorrowerCount` counts the loan once.

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
cd backend && bun test src/lib/dashboard-money.test.ts
backend/scripts/test-disposable-postgres.sh src/services/dashboard-borrower-health-service.test.ts
```

Expected: FAIL because payable-health aggregation and Dashboard floating rows are not wired.

- [ ] **Step 3: Implement exact summary aggregation**

Add:

```ts
export function sumDashboardPayableHealth(rows: Array<{ dueTodayAmount: Decimal.Value; overdueAmount: Decimal.Value }>) {
  return sumDashboardMoney(rows.flatMap((row) => [row.dueTodayAmount, row.overdueAmount]));
}
```

In `/dashboard/summary`, replace borrower schedule-derived totals/count with the projection: sum due-today plus overdue amounts and count health rows whose status is `overdue`. Keep fund calculations unchanged.

- [ ] **Step 4: Implement one floating queue row per loan**

In `/dashboard/borrower-due-queue`, retain existing scheduled rows, then append payable floating projection rows. For floating rows:

```ts
{
  scheduleId: null,
  loanId: row.loanId,
  loanPublicId: row.loanPublicId,
  borrowerName: row.borrowerName,
  repaymentType: "floating",
  remainingDue: sumDashboardMoney([row.dueTodayAmount, row.overdueAmount]),
  totalDueNow: sumDashboardMoney([row.dueTodayAmount, row.overdueAmount]),
  overdueItemCount: row.overdueItemCount,
  overdueDays: row.maxOverdueDays,
  status: row.status === "due_today" ? "due" : row.status,
}
```

Sort overdue rows before due-today rows, then by maximum overdue age and stable loan/schedule identifier. Do not invent a schedule ID or fixed due schedule.

- [ ] **Step 5: Verify backend behavior**

Run focused tests, `bun test`, and `bun run typecheck`. Expected: all pass; no `Number(` appears in the changed Dashboard money/summary path.

- [ ] **Step 6: Update changelog and commit**

Add a `v0.3.9` “Fixed” bullet describing floating arrears in Dashboard summary/queue.

```bash
git add CHANGELOG.md backend/src/modules/dashboard.ts backend/src/lib/dashboard-money.ts backend/src/lib/dashboard-money.test.ts
git commit -m "fix: include floating arrears in dashboard"
```

---

### Task 3: Aggregate floating queue presentation and navigation

**Files:**
- Modify: `frontend/src/pages/dashboard/dashboard-model.ts`
- Modify: `frontend/src/pages/dashboard/Dashboard.tsx`
- Modify: `frontend/src/locales/en.json`
- Modify: `frontend/src/locales/th.json`
- Modify: `frontend/tests/dashboard-command-center.vitest.ts`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes borrower rows with nullable `scheduleId`, optional `schedulePublicId`, `overdueItemCount`, and `overdueDays`.
- Produces floating navigation `/transactions/new?loanId=<public-id>` and scheduled navigation with both `loanId` and `scheduleId`.

- [ ] **Step 1: Write failing frontend tests**

Add a pure navigation contract helper or component test asserting:

```ts
expect(buildBorrowerRepaymentHref(floatingRow)).toBe("/transactions/new?loanId=loan-public-id");
expect(buildBorrowerRepaymentHref(scheduledRow)).toBe("/transactions/new?loanId=loan-public-id&scheduleId=schedule-public-id");
```

Render a floating row and assert localized metadata contains “4 overdue items” / “ค้าง 4 รายการ” and “up to 4 days” / “สูงสุด 4 วัน”.

- [ ] **Step 2: Run the test to verify RED**

Run: `cd frontend && bun run test -- tests/dashboard-command-center.vitest.ts`

Expected: FAIL because nullable schedule navigation and aggregate copy are absent.

- [ ] **Step 3: Implement nullable schedule contract and navigation**

Update `BorrowerDueItem.scheduleId` to `number | null`, add `overdueItemCount?: number`, and export `buildBorrowerRepaymentHref`. Encode query values with `URLSearchParams`; append `scheduleId` only when a public or numeric schedule identifier exists.

- [ ] **Step 4: Render floating aggregate metadata**

For `repaymentType === "floating"`, replace installment/date metadata with localized `overdueItemCount` and `overdueDays`. Keep scheduled presentation unchanged. Add both language keys together under `dashboardPage`.

- [ ] **Step 5: Update docs and verify frontend**

Document one-row-per-floating-loan Dashboard behavior in `README.md`, update `CHANGELOG.md`, then run:

```bash
cd frontend
bun run test
bun run lint
VITE_GOOGLE_CLIENT_ID=dashboard-qa bun run build
```

Expected: tests, lint, and production build pass.

- [ ] **Step 6: Commit**

```bash
git add CHANGELOG.md README.md frontend/src/pages/dashboard/dashboard-model.ts frontend/src/pages/dashboard/Dashboard.tsx frontend/src/locales/en.json frontend/src/locales/th.json frontend/tests/dashboard-command-center.vitest.ts
git commit -m "fix: show floating arrears on dashboard"
```

---

### Task 4: End-to-end verification and deployment evidence

**Files:**
- Modify: `design-qa.md` only if the Dashboard screenshot/copy materially changes.
- Create: `docs/design-audits/dashboard-floating-overdue.png` when browser evidence is captured.
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes the production-style Docker deployment and synthetic floating payload matching the public API contract.
- Produces browser evidence with one floating row, exact `฿300.00`, four overdue items, maximum four days, and a repayment URL without `scheduleId`.

- [ ] **Step 1: Run complete verification before merge**

Run backend full tests/typecheck and frontend full tests/lint/build. Run `git diff --check`. Expected: zero failures/errors.

- [ ] **Step 2: Browser-verify production build**

Use a Playwright production-preview fixture with one floating loan containing four overdue accruals. Assert one borrower row, localized count/age, exact amount, no console/page errors, and navigation URL containing `loanId` without `scheduleId`.

- [ ] **Step 3: Merge locally and deploy changed services**

Merge the feature branch into local `main`. Re-run focused tests on the merge result. Rebuild/recreate backend and frontend with `docker-compose.app.yml` because both contracts changed.

- [ ] **Step 4: Verify deployed health and page**

Check backend MCP health from inside the container, frontend `/dashboard` HTTP 200, successful migration/startup logs, and the deployed browser flow. Preserve existing production data and infra containers.

- [ ] **Step 5: Record evidence and commit if documentation changed**

Add a concise `v0.3.9` changelog bullet for production verification and commit only project-bound QA evidence. Do not commit tokens, tenant data, or live financial records.
