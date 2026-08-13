# Fund Usage Flat List and Source Interest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace nested funding-usage cards with a responsive flat list and expose exact, source-attributed collected interest with localized semantic statuses.

**Architecture:** Extend the existing tenant-scoped funding-usage read model by aggregating net transaction interest per loan and allocating it to the current profile by its exact net funding share. Render the added decimal string in one responsive divider-row component inside the existing section card, using localized status badges and exact money formatting.

**Tech Stack:** Bun, TypeScript, Elysia, Drizzle ORM, PostgreSQL, decimal.js, React, React Router, Tailwind CSS, i18next, Vitest, Testing Library.

## Global Constraints

- Public money values are two-decimal decimal strings; backend arithmetic uses `decimal.js`, never JavaScript `Number`.
- Net collected interest includes negative append-only compensating reversals.
- Source attribution is `loan net interest × current profile net allocation ÷ total loan net allocation`, rounded once half-up to two decimals.
- The funding-usage read model must not mutate loans, transactions, or funding allocations.
- Preserve tenant scoping, the settled-loan toggle, exact formatting, loan navigation, and Thai/English localization.
- Do not overwrite or stage unrelated existing Payment Inbox changes.

---

### Task 1: Exact source-attributed collected-interest contract

**Files:**
- Modify: `backend/src/modules/bank-profiles.test.ts`
- Modify: `backend/src/modules/bank-profiles.ts`

**Interfaces:**
- Consumes: `transactions.interestComponent`, `loanFundingAllocations.allocatedAmount`, `serializeMoney(Decimal)`.
- Produces: `FundingUsageAllocation.collectedInterest: string` in `GET /bank-profiles/:id/funding-usage`.

- [ ] **Step 1: Write failing integration tests for full, proportional, reversal, and tenant-safe attribution**

Add one focused test that seeds two profiles, one loan, `60.00` and `40.00` allocations, and transaction interest components `100.00` and `-20.00`. Assert profile A returns `collectedInterest: "48.00"`, profile B returns `"32.00"`, and a different tenant cannot observe either loan. Extend the settled-allocation test to assert a loan with no interest returns `"0.00"`.

```ts
await db.insert(transactions).values([
    { tenantId: "tenant-a", loanId: loan.id, amount: "100.00", interestComponent: "100.00", entryType: "repayment", idempotencyKey: "interest-in" },
    { tenantId: "tenant-a", loanId: loan.id, amount: "-20.00", interestComponent: "-20.00", entryType: "reversal", idempotencyKey: "interest-out" },
]);
expect(first.body.allocations[0]).toMatchObject({ collectedInterest: "48.00" });
expect(second.body.allocations[0]).toMatchObject({ collectedInterest: "32.00" });
```

- [ ] **Step 2: Run the focused test and verify the contract is missing**

Run: `cd backend && bun test src/modules/bank-profiles.test.ts`

Expected: FAIL because allocation rows do not contain `collectedInterest`.

- [ ] **Step 3: Add exact per-loan interest and total-allocation projections**

Import `transactions` and query tenant-scoped grouped sums for the allocated loan IDs. Build maps keyed by loan ID:

```ts
const netInterestByLoan = new Map<number, Decimal>();
const totalNetAllocationByLoan = new Map<number, Decimal>();
const share = totalNetAllocation.gt(0)
    ? Decimal.max(row.netAllocatedAmount, 0).div(totalNetAllocation)
    : new Decimal(0);
const collectedInterest = Decimal.max(netInterest, 0)
    .times(share)
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
```

Use grouped SQL/Drizzle aggregation instead of one query per loan. Include negative transaction components naturally in the sum. Serialize the result as `collectedInterest: serializeMoney(collectedInterest)`.

- [ ] **Step 4: Run backend tests and typecheck**

Run: `cd backend && bun test src/modules/bank-profiles.test.ts`

Expected: PASS, including `48.00`, `32.00`, reversal, zero-interest, and authorization cases.

Run: `cd backend && bun x tsc --noEmit`

Expected: PASS.

- [ ] **Step 5: Commit the backend contract**

Update `CHANGELOG.md` under `v0.3.11` → `### Added` with one concise bullet describing exact source-attributed collected interest. Then run:

```bash
git add CHANGELOG.md backend/src/modules/bank-profiles.ts backend/src/modules/bank-profiles.test.ts
git commit -m "feat: attribute collected interest to funding sources"
```

### Task 2: Responsive flat funding-usage list and semantic statuses

**Files:**
- Modify: `frontend/tests/fund-detail.vitest.tsx`
- Modify: `frontend/src/pages/dashboard/funds/FundDetail.tsx`
- Modify: `frontend/src/locales/en.json`
- Modify: `frontend/src/locales/th.json`

**Interfaces:**
- Consumes: `FundingUsageAllocation.collectedInterest: string` from Task 1.
- Produces: one `data-testid="funding-usage-list"` divider list and localized status labels under `fundDetail.loanStatuses.*`.

- [ ] **Step 1: Replace card-oriented test fixtures with the new contract and failing UI expectations**

Add `collectedInterest: "23.33"` to the mocked allocation. Assert:

```ts
expect(screen.getByTestId("funding-usage-list")).toBeInTheDocument();
expect(screen.queryByTestId("funding-usage-cards")).not.toBeInTheDocument();
expect(screen.getByText("ดอกเบี้ยที่เก็บได้สำหรับแหล่งทุนนี้")).toBeInTheDocument();
expect(screen.getByText("฿23.33")).toBeInTheDocument();
expect(screen.getByText("ใช้งานอยู่")).toHaveClass("bg-emerald-100");
```

Keep assertions for settled-toggle refetch and loan navigation.

- [ ] **Step 2: Run the focused frontend test and verify it fails**

Run: `cd frontend && bun test tests/fund-detail.vitest.tsx`

Expected: FAIL because the old nested cards, raw status, and missing interest metric remain.

- [ ] **Step 3: Extend the TypeScript interface and add status presentation helpers**

Add `collectedInterest: string` to `FundingUsageAllocation`. Define a small local mapping that returns translated text and semantic classes without changing backend status values:

```ts
const loanStatusPresentation = (status: string) => {
    if (status === "active") return { label: t("fundDetail.loanStatuses.active"), className: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300" };
    if (["paid", "closed"].includes(status)) return { label: t(`fundDetail.loanStatuses.${status}`), className: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200" };
    if (["draft", "pending"].includes(status)) return { label: t(`fundDetail.loanStatuses.${status}`), className: "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300" };
    return { label: t("fundDetail.loanStatuses.problem"), className: "bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-300" };
};
```

Use the existing `Badge` component and preserve a visible focus ring on row links.

- [ ] **Step 4: Replace nested articles and duplicate desktop table with one responsive divider list**

Render a single list inside `CardContent`:

```tsx
<div data-testid="funding-usage-list" className="divide-y">
  {fundingUsage.allocations.map((allocation) => (
    <Link key={allocation.loanPublicId} to={`/loans/${allocation.loanPublicId}`} className="block px-1 py-5 transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-3">
      {/* borrower + badge; truncated ID + route; responsive metric grid; latest date */}
    </Link>
  ))}
</div>
```

Use borrower name as the primary heading, truncate the UUID visually while retaining it in the DOM/title, format all three metrics with `formatMoneyExact`, and ensure labels remain visible on mobile. Remove `rounded-lg border p-4` per-item styling and the separate `2xl` table.

- [ ] **Step 5: Add paired Thai and English locale keys**

Add matching keys:

```json
"collectedInterestForSource": "Interest collected for this funding source",
"loanStatuses": { "active": "Active", "paid": "Paid", "closed": "Closed", "draft": "Draft", "pending": "Pending", "problem": "Needs review" }
```

```json
"collectedInterestForSource": "ดอกเบี้ยที่เก็บได้สำหรับแหล่งทุนนี้",
"loanStatuses": { "active": "ใช้งานอยู่", "paid": "ชำระครบแล้ว", "closed": "ปิดสัญญาแล้ว", "draft": "ฉบับร่าง", "pending": "รอดำเนินการ", "problem": "ต้องตรวจสอบ" }
```

- [ ] **Step 6: Run focused tests, lint, and build**

Run: `cd frontend && bun test tests/fund-detail.vitest.tsx`

Run: `cd frontend && bun run lint`

Run: `cd frontend && bun run build`

Expected: all PASS; no horizontal overflow or missing translation-key warnings.

- [ ] **Step 7: Commit the responsive UI**

Update `CHANGELOG.md` under `v0.3.11` → `### Changed` with one bullet covering the flat list and localized semantic badges. Then run:

```bash
git add CHANGELOG.md frontend/src/pages/dashboard/funds/FundDetail.tsx frontend/src/locales/en.json frontend/src/locales/th.json frontend/tests/fund-detail.vitest.tsx
git commit -m "feat: flatten funding usage list"
```

### Task 3: Integrated verification and production-safe handoff

**Files:**
- Modify only if verification finds a scoped defect: files from Tasks 1–2 plus `CHANGELOG.md`.

**Interfaces:**
- Consumes: completed backend contract and frontend rendering.
- Produces: verified release-ready behavior; no new public interface.

- [ ] **Step 1: Run the full relevant verification matrix**

```bash
cd backend && bun test src/modules/bank-profiles.test.ts
cd backend && bun x tsc --noEmit
cd frontend && bun test tests/fund-detail.vitest.tsx
cd frontend && bun run lint
cd frontend && bun run build
```

Expected: every command exits 0.

- [ ] **Step 2: Review exactness and UI scope in the diff**

Run:

```bash
git diff --check HEAD~2..HEAD
git diff --stat HEAD~2..HEAD
git status --short
```

Confirm the backend never converts money through `Number`, the frontend uses `formatMoneyExact`, both locale files changed together, and unrelated Payment Inbox files remain unstaged/uncommitted.

- [ ] **Step 3: Verify against a production-style read model without writing financial data**

After deployment through the project's normal compose workflow, call the authenticated funding-usage endpoint or inspect the Fund Detail page. Confirm TTB shows six divider rows, localized green active badges, and source interest values matching net transaction interest for fully TTB-funded loans. Do not create test financial records in the live tenant.

- [ ] **Step 4: Commit only if verification required a fix**

If a scoped defect was corrected, update `CHANGELOG.md`, stage only the affected Task 1–2 files, and commit with a message describing the defect. If no fix was needed, do not create an empty verification commit.
