# Loan Card Received Totals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add exact backend-owned interest-received and paid-to-date values to Loan List cards, keep outstanding and original principal on one responsive row for non-paid loans, and replace a paid loan's zero balance with a checked `PAID` summary.

**Architecture:** A focused backend receipt-summary service performs two tenant-bound grouped reads for all visible loans, combines advance-interest deductions with signed posted transaction components using `FinancialDecimal`, and supplies exact two-decimal strings to the existing Loan List route. A focused React financial-summary component renders status-aware card layouts while `LoanList` retains fetching, filtering, health badges, and navigation.

**Tech Stack:** Bun, TypeScript, Elysia, Drizzle ORM, PostgreSQL, decimal.js/`FinancialDecimal`, React 19, react-i18next, Tailwind CSS, Lucide React, Vitest, Testing Library.

## Global Constraints

- Money crosses the API as two-decimal decimal strings and is calculated only with backend `FinancialDecimal`; never use JavaScript `Number` or floating point for receipt arithmetic or formatting.
- `interestReceived` equals activation-time `firstDayInterestDeducted` plus signed posted `interestComponent` values.
- `paidToDate` equals activation-time `firstDayInterestDeducted` plus signed posted principal, interest, fee, and penalty components.
- Posted reversal components reduce both totals; payment-intake drafts and unrelated ledger activity never count.
- Paid accrual snapshots are not receipt inputs because they can duplicate advance interest or transaction allocations.
- Reads are tenant-bound and restricted to loan IDs already authorized by the existing Loan List access filter.
- Missing grouped rows become exact `0.00`; a negative cumulative result raises a financial-invariant error and is never clamped.
- Use `Asia/Bangkok` for existing date behavior; this feature does not change dates.
- Update `frontend/src/locales/en.json` and `frontend/src/locales/th.json` together.
- Preserve explicit loan projections for production mixed-lineage compatibility.
- This feature is read-only and must not create accruals, post payments, or mutate balances/history.
- Before each commit, update `CHANGELOG.md` and stage it with the corresponding code.

---

## File Structure

- Create `backend/src/services/loan-receipt-summary-service.ts`: tenant-bound grouped receipt aggregation and invariant enforcement.
- Create `backend/src/services/loan-receipt-summary-service.test.ts`: database-backed exact-money, reversal, zero, isolation, and negative-invariant tests.
- Create `backend/src/modules/loan-list-received-totals.test.ts`: authenticated Loan List response contract using the real route and database.
- Modify `backend/src/modules/loan-contract-routes.ts`: request grouped receipt summaries for visible loan IDs and add the two exact strings to each row.
- Create `frontend/src/pages/dashboard/loans/LoanCardFinancialSummary.tsx`: status-aware financial presentation only.
- Modify `frontend/src/pages/dashboard/loans/LoanList.tsx`: extend the DTO and delegate the current amount/status block to the new component.
- Modify `frontend/tests/loan-list.vitest.tsx`: active, paid, exact-money, locale, and no-extra-request regressions.
- Modify `frontend/src/locales/en.json` and `frontend/src/locales/th.json`: receipt labels and explicit completed-state label.
- Modify `README.md`: document the status-aware Loan List financial summary and backend-owned receipt definitions.
- Modify `CHANGELOG.md`: implementation entries shipped with backend and frontend commits.

---

### Task 1: Backend Receipt Summary and Loan List Contract

**Files:**
- Create: `backend/src/services/loan-receipt-summary-service.ts`
- Create: `backend/src/services/loan-receipt-summary-service.test.ts`
- Create: `backend/src/modules/loan-list-received-totals.test.ts`
- Modify: `backend/src/modules/loan-contract-routes.ts:1-175`
- Modify: `CHANGELOG.md:3-45`

**Interfaces:**
- Consumes: `db`/transaction executors, `loanDisbursements`, `transactions`, `FinancialDecimal`, `serializeMoney`, authorized numeric loan IDs, and one tenant ID.
- Produces: `getLoanReceiptSummaries(executor, tenantId, loanIds): Promise<Map<number, LoanReceiptSummary>>`, where `LoanReceiptSummary = { interestReceived: string; paidToDate: string }`.
- Produces on `GET /loans`: `interestReceived: string` and `paidToDate: string` on every returned row.

- [ ] **Step 1: Write failing database-backed service tests**

Create `backend/src/services/loan-receipt-summary-service.test.ts` with disposable-PostgreSQL setup that truncates `loan_disbursements`, `transactions`, `loans`, `borrowers`, and `users` with dependencies. Seed one visible loan with:

```ts
await db.insert(loanDisbursements).values({
    tenantId,
    loanId: loan.id,
    grossPrincipal: "5000.00",
    firstDayInterestDeducted: "600.00",
    netDisbursement: "4400.00",
    createdByUserId: owner.id,
});
await db.insert(transactions).values([
    {
        tenantId, ownerUserId: owner.id, loanId: loan.id,
        amount: "1000.00", principalComponent: "700.00",
        interestComponent: "200.00", feeComponent: "50.00",
        penaltyComponent: "50.00", entryType: "repayment",
        postedAt: new Date("2026-08-16T12:00:00+07:00"),
    },
    {
        tenantId, ownerUserId: owner.id, loanId: loan.id,
        amount: "-400.00", principalComponent: "-300.00",
        interestComponent: "-50.00", feeComponent: "-25.00",
        penaltyComponent: "-25.00", entryType: "reversal",
        postedAt: new Date("2026-08-16T13:00:00+07:00"),
    },
]);
```

Assert literal results independent of production helpers:

```ts
expect((await getLoanReceiptSummaries(db, tenantId, [loan.id])).get(loan.id)).toEqual({
    interestReceived: "750.00", // 600 + 200 - 50
    paidToDate: "1200.00",      // 600 + 1000 - 400
});
```

Add cases proving an empty loan returns `{ interestReceived: "0.00", paidToDate: "0.00" }`, an omitted/foreign-tenant loan never appears in the returned map, 29-integer-digit components retain exact cents, and a reversal-only negative cumulative result rejects with `DomainError.code === "LOAN_RECEIPT_SUMMARY_NEGATIVE"`.

- [ ] **Step 2: Run the service test and verify RED**

Run:

```bash
backend/scripts/test-disposable-postgres.sh src/services/loan-receipt-summary-service.test.ts
```

Expected: FAIL because `loan-receipt-summary-service.ts` and `getLoanReceiptSummaries` do not exist.

- [ ] **Step 3: Implement the minimal grouped summary service**

Create `backend/src/services/loan-receipt-summary-service.ts` with this public contract:

```ts
export type LoanReceiptSummary = {
    interestReceived: string;
    paidToDate: string;
};

export async function getLoanReceiptSummaries(
    executor: Executor,
    tenantId: string,
    loanIds: number[],
): Promise<Map<number, LoanReceiptSummary>>;
```

Return an empty map immediately for no IDs. Run one grouped `loanDisbursements` query summing `firstDayInterestDeducted` and one grouped `transactions` query summing:

```ts
interestReceivedFromPayments = sum(transactions.interestComponent)
paidFromPayments = sum(
    transactions.principalComponent
    + transactions.interestComponent
    + transactions.feeComponent
    + transactions.penaltyComponent
)
```

Both reads must filter `tenantId`, `inArray(loanId, loanIds)`, `postedAt IS NOT NULL`, and transaction `entryType IN ('repayment', 'reversal')`. Initialize every requested ID to exact zero, combine SQL numeric strings with `FinancialDecimal`, reject either negative total with:

```ts
throw new DomainError(
    "LOAN_RECEIPT_SUMMARY_NEGATIVE",
    "Loan receipt history has a negative cumulative total",
    409,
    { loanId },
);
```

Serialize with `serializeMoney`; do not expose internal numeric IDs outside the service.

- [ ] **Step 4: Run the service test and verify GREEN**

Run:

```bash
backend/scripts/test-disposable-postgres.sh src/services/loan-receipt-summary-service.test.ts
```

Expected: all service cases PASS with zero skipped database assertions.

- [ ] **Step 5: Write the failing authenticated Loan List contract test**

Create `backend/src/modules/loan-list-received-totals.test.ts` using the JWT helper pattern from `loan-list-borrower-labels.test.ts`. Seed an owner-visible loan with a `100.00` advance deduction and signed posted components that produce literal values:

```ts
expect(row).toMatchObject({
    publicId: visibleLoan.publicId,
    interestReceived: "125.00",
    paidToDate: "600.00",
});
```

Also seed a second loan with no receipt rows and assert both fields are `"0.00"`, plus a foreign-tenant loan and assert it is absent from the response. Assert the request count remains one route call; the backend performs grouped reads internally.

- [ ] **Step 6: Run the route test and verify RED**

Run:

```bash
backend/scripts/test-disposable-postgres.sh src/modules/loan-list-received-totals.test.ts
```

Expected: FAIL because the Loan List response lacks `interestReceived` and `paidToDate`.

- [ ] **Step 7: Add receipt summaries to the Loan List mapper**

In `backend/src/modules/loan-contract-routes.ts`, after the visible loan rows are known and before `Promise.all(rows.map(...))`, call:

```ts
const receiptSummaries = await getLoanReceiptSummaries(
    db,
    user.tenantId,
    rows.map(({ loan }) => loan.id),
);
```

For each row use the service result or an exact fallback:

```ts
const receipts = receiptSummaries.get(loan.id) ?? {
    interestReceived: "0.00",
    paidToDate: "0.00",
};
```

Return both fields with the existing explicit loan DTO. Do not alter payment-health calculation, cache keys, borrower labels, sorting, or access filters.

- [ ] **Step 8: Run backend focused and regression tests**

Run:

```bash
backend/scripts/test-disposable-postgres.sh \
  src/services/loan-receipt-summary-service.test.ts \
  src/modules/loan-list-received-totals.test.ts \
  src/modules/loan-list-borrower-labels.test.ts
cd backend && bun run typecheck
```

Expected: all selected tests PASS, database cases are not skipped, and typecheck exits 0.

- [ ] **Step 9: Update changelog and commit the backend contract**

Add one concise `### Added` bullet under `v0.3.14 - 2026-08-16` describing backend-owned exact receipt summaries, advance deductions, signed reversals, tenant isolation, and grouped reads. Verify and commit:

```bash
git add CHANGELOG.md \
  backend/src/services/loan-receipt-summary-service.ts \
  backend/src/services/loan-receipt-summary-service.test.ts \
  backend/src/modules/loan-list-received-totals.test.ts \
  backend/src/modules/loan-contract-routes.ts
git diff --cached --check
git commit -m "feat(loans): expose received totals on loan list"
```

---

### Task 2: Status-Aware Loan Card Financial Presentation

**Files:**
- Create: `frontend/src/pages/dashboard/loans/LoanCardFinancialSummary.tsx`
- Modify: `frontend/src/pages/dashboard/loans/LoanList.tsx:20-40,205-225`
- Modify: `frontend/tests/loan-list.vitest.tsx`
- Modify: `frontend/src/locales/en.json:536-590`
- Modify: `frontend/src/locales/th.json:536-590`
- Modify: `README.md:73-90`
- Modify: `CHANGELOG.md:3-45`

**Interfaces:**
- Consumes from Task 1: `interestReceived: string` and `paidToDate: string` on every Loan List row.
- Produces: `LoanCardFinancialSummary({ status, outstandingPrincipal, originalPrincipal, interestReceived, paidToDate }): JSX.Element`.

- [ ] **Step 1: Write failing active and paid card regressions**

Extend `frontend/tests/loan-list.vitest.tsx` with one API fixture containing:

```ts
const active = {
    id: "active-summary", publicId: "active-summary", borrowerName: "Active Summary",
    principal: "5000.00", outstandingPrincipal: "3750.00",
    interestReceived: "200.25", paidToDate: "1450.25",
    status: "active", repaymentType: "daily", installmentAmount: "250.00",
    totalInstallments: 20, startDate: "2026-08-01",
    createdAt: "2026-08-10T07:30:00.000Z",
    paymentHealth: { status: "current", dueTodayAmount: "0.00", overdueAmount: "0.00", overdueItemCount: 0, maxOverdueDays: 0 },
};
const paid = {
    ...active,
    id: "paid-summary", publicId: "paid-summary", borrowerName: "Paid Summary",
    principal: "10000.00", outstandingPrincipal: "0.00",
    interestReceived: "2000.00", paidToDate: "12000.00", status: "paid",
};
```

Assert on real rendered behavior:

```ts
const activeCard = (await screen.findByText("Active Summary")).closest("a")!;
const activeOutstanding = within(activeCard).getByText(/THB\s*3,750\.00/);
expect(within(activeOutstanding.parentElement!).getByText(/Original principal.*THB\s*5,000\.00/)).toBeInTheDocument();
expect(within(activeCard).getByText(/Interest received.*THB\s*200\.25.*Paid to date.*THB\s*1,450\.25/)).toBeInTheDocument();

const paidCard = screen.getByText("Paid Summary").closest("a")!;
const paidStatus = within(paidCard).getByText("PAID");
expect(paidStatus.parentElement?.querySelector("svg.lucide-circle-check")).not.toBeNull();
expect(within(paidCard).queryByText(/THB\s*0\.00/)).not.toBeInTheDocument();
expect(within(paidCard).getByText(/Original principal.*THB\s*10,000\.00.*Interest received.*THB\s*2,000\.00/)).toBeInTheDocument();
expect(within(paidCard).queryByText(/Paid to date/)).not.toBeInTheDocument();
```

Keep the assertion that only `GET /loans` is requested.

- [ ] **Step 2: Run the Loan List test and verify RED**

Run:

```bash
cd frontend && bun test tests/loan-list.vitest.tsx
```

Expected: FAIL because receipt rows, the paid conditional layout, and the check icon do not exist.

- [ ] **Step 3: Add locale keys with parity**

Add the same key paths in both locale files:

```json
// en.json
"interestReceived": "Interest received",
"paidToDate": "Paid to date",
"paidComplete": "PAID"

// th.json
"interestReceived": "ดอกเบี้ยรับแล้ว",
"paidToDate": "จ่ายแล้ว",
"paidComplete": "PAID"
```

`paidComplete` intentionally remains the product's uppercase status token in both languages, while its surrounding labels follow the active locale.

- [ ] **Step 4: Implement the focused financial-summary component**

Create `LoanCardFinancialSummary.tsx` with exact string props:

```ts
export interface LoanCardFinancialSummaryProps {
    status: string;
    outstandingPrincipal: string;
    originalPrincipal: string;
    interestReceived: string;
    paidToDate: string;
}
```

Use `useTranslation`, `formatMoneyExact`, and Lucide `CircleCheck`. For `status === "paid"`, render a green success row containing `<CircleCheck aria-hidden="true" ... />` and `t("loans.paidComplete")`, followed by one muted `tabular-nums` row with original principal and interest received. Do not render outstanding principal or paid-to-date in this branch.

For all other statuses, render:

```tsx
<div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
    <div className="text-2xl font-bold tabular-nums">{formatMoneyExact(outstandingPrincipal, i18n.language)}</div>
    <p className="text-xs text-muted-foreground">/ {t("loans.originalPrincipal")} {formatMoneyExact(originalPrincipal, i18n.language)}</p>
</div>
<p className="text-xs text-muted-foreground tabular-nums">
    {t("loans.interestReceived")} {formatMoneyExact(interestReceived, i18n.language)}
    {" · "}
    {t("loans.paidToDate")} {formatMoneyExact(paidToDate, i18n.language)}
</p>
<p className={cn("text-xs font-semibold uppercase", status === "active" ? "text-green-600" : "text-gray-500")}>{status}</p>
```

Keep the component presentation-only: no API call, sum, coercion, or status mutation.

- [ ] **Step 5: Wire Loan List to the component**

Extend `LoanRow` in `LoanList.tsx` with required string fields:

```ts
interestReceived: string;
paidToDate: string;
```

Replace the existing outstanding/original/status block with:

```tsx
<LoanCardFinancialSummary
    status={loan.status}
    outstandingPrincipal={loan.outstandingPrincipal}
    originalPrincipal={loan.principal}
    interestReceived={loan.interestReceived}
    paidToDate={loan.paidToDate}
/>
```

Update existing Loan List fixtures to include exact zero receipt strings where the test does not exercise totals. Do not use optional props or frontend defaults to conceal a broken API contract.

- [ ] **Step 6: Run frontend focused tests and verify GREEN**

Run:

```bash
cd frontend && bun test tests/loan-list.vitest.tsx tests/locale-parity.vitest.ts
```

Expected: all Loan List and locale-parity cases PASS.

- [ ] **Step 7: Add Thai rendering coverage**

In `loan-list.vitest.tsx`, change i18n to Thai for an active fixture and assert literal label fragments `ดอกเบี้ยรับแล้ว` and `จ่ายแล้ว` with exact formatted amounts. Add a paid Thai fixture and assert the visible product token remains `PAID`, while `เงินต้นตั้งต้น` and `ดอกเบี้ยรับแล้ว` are Thai. Run the same focused command and confirm PASS.

- [ ] **Step 8: Update user-facing documentation**

Add a concise README capability bullet near the existing Loan List search bullet:

```md
- scan exact Loan List financial summaries: non-paid cards keep outstanding and original principal together with backend-owned interest-received and paid-to-date totals, while paid cards show a checked completion state with original principal and interest received
```

Do not document internal query/table names or imply that the frontend calculates financial totals.

- [ ] **Step 9: Update changelog and commit the frontend presentation**

Add one `### Changed` bullet under `v0.3.14 - 2026-08-16` describing the responsive non-paid row and checked paid summary. Verify and commit:

```bash
git add CHANGELOG.md README.md \
  frontend/src/pages/dashboard/loans/LoanCardFinancialSummary.tsx \
  frontend/src/pages/dashboard/loans/LoanList.tsx \
  frontend/tests/loan-list.vitest.tsx \
  frontend/src/locales/en.json frontend/src/locales/th.json
git diff --cached --check
git commit -m "feat(loans): show received totals on loan cards"
```

---

### Task 3: Full Verification and Integration Readiness

**Files:**
- Verify only: all Task 1 and Task 2 files
- Modify only if a gate reveals a scoped defect: the failing task's listed files and `CHANGELOG.md`

**Interfaces:**
- Consumes: committed backend receipt contract and frontend status-aware presentation.
- Produces: verified feature branch ready for review and explicit integration authorization.

- [ ] **Step 1: Run complete backend database and type gates**

Run serially as required by the shared destructive disposable database:

```bash
backend/scripts/test-disposable-postgres.sh
cd backend && bun run typecheck
```

Expected: every backend test passes, no database-backed financial invariant test is skipped, and typecheck exits 0.

- [ ] **Step 2: Run complete frontend gates**

Run:

```bash
cd frontend
bun test
bun run lint
bun run build
```

Expected: Vitest reports zero failures, ESLint exits 0, and the production build exits 0.

- [ ] **Step 3: Inspect the final diff and commit lineage**

Run:

```bash
git status --short
git diff --check main...HEAD
git log --oneline --decorate main..HEAD
git diff --stat main...HEAD
git diff main...HEAD -- \
  backend/src/services/loan-receipt-summary-service.ts \
  backend/src/modules/loan-contract-routes.ts \
  frontend/src/pages/dashboard/loans/LoanCardFinancialSummary.tsx \
  frontend/src/pages/dashboard/loans/LoanList.tsx
```

Expected: clean worktree, no whitespace errors, only the approved spec/plan/backend/frontend/changelog scope, and no secrets or unrelated user files.

- [ ] **Step 4: Review financial and presentation acceptance criteria**

Confirm from test output and diff:

- advance deduction is counted once in each approved total;
- signed reversals reduce totals;
- transaction components, not browser arithmetic or principal inference, determine paid-to-date;
- tenant and visible-loan scope are enforced before aggregation;
- non-paid cards keep outstanding and original principal together;
- paid cards show checked `PAID`, no `0.00` outstanding headline, original principal, and interest received only;
- Thai/English keys have parity; and
- README describes the user-facing status-aware summaries; and
- no financial writes, schema migrations, new network requests, or extra sorting/filter behavior were introduced.

- [ ] **Step 5: Stop before merge, push, or deployment**

Report the verified branch, commits, test counts, and any warnings. Do not merge, push, deploy, or mutate production until the user explicitly authorizes those actions.
