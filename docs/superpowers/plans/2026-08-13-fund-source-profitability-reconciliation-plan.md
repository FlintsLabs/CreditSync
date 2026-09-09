# Fund Source Profitability and Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make fund-source settlement and profitability recognize every historically posted borrower payment attributable to direct capital or drawdown allocations, and expose the exact difference from the append-only source ledger.

**Architecture:** Extract a Decimal-only attribution kernel that reduces signed allocation history into positive net source shares and applies those shares once to posted transaction components. Rebuild the bank-profile summary from allocations selected by `bankProfileId`, retain drawdown repayments as the source-cost projection, and add a read-only contract-to-ledger reconciliation projection. REST responses expose two-decimal strings and the fund detail page only presents backend results.

**Tech Stack:** Bun, TypeScript, Elysia, Drizzle ORM, PostgreSQL, `decimal.js`, React, Vitest, Testing Library, i18next, Docker Compose.

## Global Constraints

- Use `decimal.js` for every financial calculation, comparison, ratio, and rounding operation; never use JavaScript floating point or `Number` for money.
- Public money crosses REST interfaces as two-decimal decimal strings.
- Posted financial records and active loan terms are immutable; this read path must not append, edit, or delete financial entries.
- Tenant-scope every query and retain administrator-only access.
- Update Thai and English translations together.
- Update `CHANGELOG.md` under `v0.3.11 - 2026-08-13` before each commit.
- Preserve and do not stage the unrelated dirty Payment Inbox files.

---

### Task 1: Exact Net-Allocation Attribution Kernel

**Files:**
- Create: `backend/src/lib/fund-attribution.ts`
- Create: `backend/src/lib/fund-attribution.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: `{ loanId, bankProfileId, allocatedAmount }[]` and posted transaction components as decimal strings.
- Produces: `buildPositiveFundingShares(rows): Map<number, Map<number, Decimal>>` and `attributeTransactionComponents(input): AttributedComponents`.

- [ ] **Step 1: Write failing tests for signed allocation reduction**

```ts
const shares = buildPositiveFundingShares([
  { loanId: 1, bankProfileId: 10, allocatedAmount: "70.00" },
  { loanId: 1, bankProfileId: 10, allocatedAmount: "-10.00" },
  { loanId: 1, bankProfileId: 20, allocatedAmount: "40.00" },
]);
expect(shares.get(1)?.get(10)?.toFixed(2)).toBe("0.60");
expect(shares.get(1)?.get(20)?.toFixed(2)).toBe("0.40");
```

Add cases for a net-zero source, three-way recurring fractions, over-allocation normalized by total positive allocation, and negative reversal components.

- [ ] **Step 2: Confirm the focused test fails**

Run: `cd backend && bun test src/lib/fund-attribution.test.ts`

Expected: FAIL because the module and exports do not exist.

- [ ] **Step 3: Implement the Decimal-only reduction and attribution**

```ts
export function buildPositiveFundingShares(rows: AllocationRow[]) {
  const netByLoan = new Map<number, Map<number, Decimal>>();
  for (const row of rows) {
    const bySource = netByLoan.get(row.loanId) ?? new Map<number, Decimal>();
    bySource.set(
      row.bankProfileId,
      (bySource.get(row.bankProfileId) ?? new Decimal(0)).plus(row.allocatedAmount),
    );
    netByLoan.set(row.loanId, bySource);
  }
  const sharesByLoan = new Map<number, Map<number, Decimal>>();
  for (const [loanId, bySource] of netByLoan) {
    const positive = [...bySource].filter(([, amount]) => amount.gt(0));
    const total = positive.reduce((sum, [, amount]) => sum.plus(amount), new Decimal(0));
    if (total.lte(0)) continue;
    sharesByLoan.set(loanId, new Map(
      positive.map(([sourceId, amount]) => [sourceId, amount.div(total)]),
    ));
  }
  return sharesByLoan;
}
```

`attributeTransactionComponents` must sum `principal`, `interest`, `fees`, and `penalties` with `Decimal.plus` and `Decimal.times`. Do not round individual transaction rows; round only public totals.

- [ ] **Step 4: Verify kernel and type safety**

Run: `cd backend && bun test src/lib/fund-attribution.test.ts && bun run typecheck`

Expected: PASS and no `Number`, `parseFloat`, unary `+`, or native arithmetic on money in the new module.

- [ ] **Step 5: Commit the kernel**

Add a consolidated changelog bullet, then:

```bash
git add CHANGELOG.md backend/src/lib/fund-attribution.ts backend/src/lib/fund-attribution.test.ts
git diff --cached --check
git commit -m "feat: add exact fund attribution kernel"
```

---

### Task 2: Direct-Capital Settlement and Reconciliation Read Model

**Files:**
- Modify: `backend/src/lib/fund-settlement.ts`
- Modify: `backend/src/lib/fund-settlement.test.ts`
- Modify: `backend/src/modules/bank-profiles.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: Task 1 attribution helpers, profile allocations, posted borrower transactions, drawdown repayments, rollovers, and source ledger entries.
- Produces: Decimal-string settlement fields and `FundRevenueReconciliation`.

- [ ] **Step 1: Write failing settlement and reconciliation tests**

```ts
expect(summary).toMatchObject({
  borrowerPrincipalCollected: "2333.33",
  borrowerInterestCollected: "1466.67",
  borrowerRevenueCollected: "1466.67",
  realizedSpread: "1466.67",
  surplusBalance: "3800.00",
});
expect(reconcileFundRevenue({
  contractAttributedRevenue: "1466.67",
  ledgerEntries: [
    { entryType: "interest_income_in", amount: "510.00" },
    { entryType: "principal_return_in", amount: "100.00" },
  ],
})).toEqual({
  contractAttributedRevenue: "1466.67",
  ledgerRecordedRevenue: "510.00",
  difference: "956.67",
  status: "needs_reconciliation",
});
```

Add exact matched (`0.00`) and over-recorded (`-10.00`) tests. The revenue allowlist must include `interest_income_in`, `fee_income_in`, and `penalty_income_in`, while excluding principal, allocation, rollover, and bank-repayment entries.

- [ ] **Step 2: Write a failing database-backed direct-capital route test**

Seed a capital-pool profile without a drawdown, one `5000.00` allocation, historical payments with principal `2333.33` and interest `1466.67`, plus ledger interest `510.00`. Assert profitability returns:

```ts
{
  borrowerCashCollected: "3800.00",
  borrowerRevenueCollected: "1466.67",
  deployedPrincipal: "5000.00",
  realizedSpread: "1466.67",
  reconciliation: {
    contractAttributedRevenue: "1466.67",
    ledgerRecordedRevenue: "510.00",
    difference: "956.67",
    status: "needs_reconciliation"
  }
}
```

Also seed two sources plus signed adjustment rows and prove each transaction is attributed once. Add another-tenant rows and prove isolation.

- [ ] **Step 3: Confirm the root-cause failures**

Run:

```bash
cd backend
bun test src/lib/fund-settlement.test.ts
./scripts/test-disposable-postgres.sh src/modules/bank-profiles.test.ts
```

Expected: FAIL because profile discovery starts from drawdowns and reconciliation is absent.

- [ ] **Step 4: Select allocations by profile and costs by drawdown**

```ts
const profileAllocations = await db.select().from(loanFundingAllocations).where(and(
  eq(loanFundingAllocations.tenantId, tenantId),
  eq(loanFundingAllocations.bankProfileId, bankProfileId),
));
```

Load all allocations for the resulting loan IDs to build share denominators. Use drawdowns only for `bankLoanRepayments` and outstanding source costs. Aggregate signed allocation history before attributing posted transactions and outstanding borrower revenue.

- [ ] **Step 5: Convert the touched financial path to Decimal strings**

Replace financial accumulators, `Math.max`, comparisons, ratios, and `Number(...)` with Decimal operations. Return `toFixed(2)` strings for money and ROI; keep counts as numbers.

- [ ] **Step 6: Implement read-only reconciliation**

```ts
export type FundRevenueReconciliation = {
  contractAttributedRevenue: string;
  ledgerRecordedRevenue: string;
  difference: string;
  status: "matched" | "needs_reconciliation";
};
```

Use an explicit revenue-entry allowlist. Calculate `difference = contract.minus(ledger)` and attach it to the summary. Do not insert, update, or delete any record.

- [ ] **Step 7: Verify and commit**

Run:

```bash
cd backend
bun test src/lib/fund-attribution.test.ts src/lib/fund-settlement.test.ts
./scripts/test-disposable-postgres.sh src/modules/bank-profiles.test.ts
bun run typecheck
```

Expected: PASS and the PostgreSQL tests execute rather than skip. Update the changelog and commit only the listed files with message `fix: calculate direct fund profitability`.

---

### Task 3: Exact REST Contract and Cache Coverage

**Files:**
- Modify: `backend/src/modules/bank-profiles.ts`
- Modify: `backend/src/modules/bank-profiles.test.ts`
- Modify: `backend/src/lib/fund-settlement.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: Task 2 Decimal-string summary.
- Produces: stable settlement and profitability JSON with no financial `number` values.

- [ ] **Step 1: Add failing contract assertions**

Assert each money field, including reconciliation fields, is a string matching `/^-?\d+\.\d{2}$/`. Cover `borrowerCashCollected`, revenue components, costs, spreads, balances, deployed principal, ROI, opportunity cost, economic spread, and reconciliation totals.

- [ ] **Step 2: Add a cache invalidation regression**

Call profitability, post a new payment through the supported payment application service, then call again and assert the new response includes it. Do not seed the second payment through direct SQL because the test must cover real cache invalidation.

- [ ] **Step 3: Confirm current numeric serialization fails**

Run: `cd backend && ./scripts/test-disposable-postgres.sh src/modules/bank-profiles.test.ts`

- [ ] **Step 4: Remove native-money conversions from the route**

```ts
const deployedPrincipal = new Decimal(rows[0]?.totalAllocated ?? "0");
const metrics = deriveProfitabilityMetrics(summary, Decimal.max(0, deployedPrincipal));
const economicSpread = new Decimal(metrics.realizedSpread)
  .minus(opportunityCostAccrued)
  .toFixed(2);
```

Retain route authorization, public UUID lookup, cache namespace, and TTL. If payment posting does not invalidate both profile summary keys, extend its tenant-cache invalidation and its service test.

- [ ] **Step 5: Verify and commit**

Run the disposable `bank-profiles.test.ts` suite and `bun run typecheck`. Update the changelog and commit only Task 3 files with message `fix: expose exact fund profitability contract`.

---

### Task 4: Localized Fund Reconciliation UI

**Files:**
- Modify: `frontend/src/pages/dashboard/funds/FundDetail.tsx`
- Modify: `frontend/src/locales/en.json`
- Modify: `frontend/src/locales/th.json`
- Modify: `frontend/tests/fund-detail.vitest.tsx`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: Task 3 exact strings and `FundRevenueReconciliation`.
- Produces: exact summary rendering and a semantic, read-only reconciliation card.

- [ ] **Step 1: Add failing production-like UI fixtures**

Mock `borrowerCashCollected: "3800.00"`, `borrowerRevenueCollected: "1466.67"`, `deployedPrincipal: "21500.00"`, `ledgerRecordedRevenue: "510.00"`, and `difference: "956.67"`. Assert all values and the localized “Needs reconciliation” badge appear. Assert amber semantic classes; use a second matched fixture to assert emerald classes.

- [ ] **Step 2: Add an exactness regression**

Pass `"9007199254740993.01"` and assert it renders without losing cents. Confirm the fund summary no longer coerces API money with `Number(...)` or `toLocaleString`.

- [ ] **Step 3: Confirm the UI test fails**

Run: `cd frontend && bun test tests/fund-detail.vitest.tsx`

Expected: FAIL because reconciliation and exact rendering are absent.

- [ ] **Step 4: Update types and exact rendering**

Change settlement/profitability financial fields to `string`, add the reconciliation interface, render money through `formatMoneyExact`, and determine sign styles with `new Decimal(value).cmp(0)`. Render ROI using an exact localized decimal formatter without binary conversion.

- [ ] **Step 5: Add the reconciliation card and translations**

Place it after the summary grid and before funding usage. Show contract-attributed revenue, ledger-recorded revenue, signed difference, semantic badge, and a read-only note. Add these exact concepts under `fundDetail.reconciliation`; color must not be the only status signal:

```text
English: Data reconciliation; Contract-attributed revenue; Ledger-recorded revenue; Difference; Matched; Needs reconciliation; This status does not alter financial records.
Thai: การกระทบยอดข้อมูล; รายรับที่รับรู้ตามสัญญา; รายรับที่บันทึกในบัญชีแหล่งทุน; ส่วนต่าง; ตรงกัน; ต้องกระทบยอด; สถานะนี้ไม่มีการแก้ไขรายการทางการเงิน
```

- [ ] **Step 6: Verify frontend**

Run:

```bash
cd frontend
bun test tests/fund-detail.vitest.tsx
bun run lint
bun run build
```

- [ ] **Step 7: Stage carefully and commit**

Because locale files contain unrelated Payment Inbox edits, use `git add -p` for only the reconciliation keys. Stage the Fund Detail, test, and changelog files explicitly; verify `git diff --cached --name-only`; commit as `feat: show fund revenue reconciliation`.

---

### Task 5: Full Verification and Production Deployment

**Files:**
- Modify: `README.md` only if operator setup or deployment expectations change.
- Modify: `CHANGELOG.md` only if final review finds an omitted change.

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces: verified production services and read-only acceptance evidence.

- [ ] **Step 1: Audit the final financial diff**

Run `git status --short`, inspect the four-task diff, and search the changed path for `Number(`, `parseFloat`, `Math.max`, native money arithmetic, and accidental write queries in GET handlers. Confirm unrelated Payment Inbox changes remain unstaged.

- [ ] **Step 2: Run proportional verification**

```bash
cd backend
./scripts/test-disposable-postgres.sh src/lib/fund-attribution.test.ts src/lib/fund-settlement.test.ts src/modules/bank-profiles.test.ts src/services/payment-service.test.ts
bun run typecheck
cd ../frontend
bun test
bun run lint
bun run build
```

Expected: all PASS and database tests do not skip.

- [ ] **Step 3: Deploy production app**

```bash
docker compose --env-file .env.production -f docker-compose.infra.yml up -d
docker compose --env-file .env.production -f docker-compose.app.yml up --build -d backend frontend
```

Deploy a clean commit snapshot that excludes unrelated dirty files.

- [ ] **Step 4: Verify health and logs**

Check MCP health at `http://127.0.0.1:3000/mcp/health` from inside the backend container, public frontend HTTP 200 at `http://127.0.0.1:8088/`, and the last 100 backend/frontend log lines for query, migration, Decimal, or serialization errors.

- [ ] **Step 5: Perform read-only production acceptance**

Fetch the affected profile's settlement and profitability endpoints. Verify:

```json
{
  "borrowerInterestCollected": "1466.67",
  "borrowerRevenueCollected": "1466.67",
  "deployedPrincipal": "21500.00",
  "reconciliation": {
    "contractAttributedRevenue": "1466.67",
    "ledgerRecordedRevenue": "510.00",
    "difference": "956.67",
    "status": "needs_reconciliation"
  }
}
```

Do not create a payment, allocation, rollover, ledger entry, or reconciliation record.

- [ ] **Step 6: Complete browser QA and report**

Check desktop and narrow mobile layouts, Thai labels, no horizontal overflow, semantic status with text, exact values, and no console errors. Report deployed commit, test commands, health checks, acceptance amounts, and confirmation that production verification was read-only. Stop and report evidence if aggregates differ; never append corrections automatically.
