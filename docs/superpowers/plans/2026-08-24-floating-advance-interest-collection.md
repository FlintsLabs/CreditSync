# Floating Advance-Interest Collection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a floating loan configured for advance interest collect an exact payment for the next anchored period before that period ends, while arrears loans retain accrued-only collection and settlement never double-charges a prepaid period.

**Architecture:** Reuse the immutable `loan_interest_accruals` period snapshots and `floating_transaction_allocations` provenance rather than adding a second prepaid balance. Add a single backend selector for the earliest uncovered advance period, use it in normal payment and reconciliation posting, and make settlement subtract only the remaining unpaid amount on each accrual. Penalties remain a separate explicit ledger with no auto-assessment from late payment.

**Tech Stack:** Bun, TypeScript, Elysia, Drizzle ORM, PostgreSQL, `decimal.js`, React, Vitest, CreditSync MCP/plugin.

**Spec:** `docs/superpowers/specs/2026-08-24-floating-advance-interest-collection-design.md`

## Global Constraints

- All financial money values are two-decimal strings and use `decimal.js`; never use JavaScript `Number` for money.
- Periods are fixed `[periodStart, nextPeriodStart)` in `Asia/Bangkok`; receipt dates never move their anchor.
- `advanceInterestPeriods = 1` means advance collection and existing `non_refundable` policy remains immutable.
- An advance payment on 2026-08-23 for a weekly period beginning 2026-08-20 covers `[2026-08-20, 2026-08-27)`, even though it is received after the period starts.
- An arrears loan cannot apply payment to an accruing/unpayable period.
- Late penalty defaults to `0.00` and can only be added later through the existing explicit, audited penalty workflow.
- Posted payment, reversal, reconciliation, and settlement records are append-only; corrections are compensating only.
- All financial writes require command context, correlation/request IDs, idempotency, and audit history.
- Run database-backed suites through `backend/scripts/test-disposable-postgres.sh` serially.
- Update `CHANGELOG.md` before every commit; update README, MCP/plugin contract, skills, evals, and validator when public workflow changes.
- Preserve unrelated dirty renewal files in the current worktree.

---

## File Map

- Modify: `backend/src/services/floating-interest-service.ts` — materialize/select anchored advance-period accruals and expose exact coverage metadata.
- Modify: `backend/src/services/floating-interest-service.test.ts` or `backend/src/services/floating-allocation-regressions.test.ts` — regression coverage for weekly period coverage and settlement behavior.
- Modify: `backend/src/services/payment-service.ts` and `backend/src/services/payment-service.test.ts` — select advance interest before principal for the eligible period and preserve arrears behavior.
- Modify: `backend/src/services/payment-reconciliation-service.ts` and `backend/src/services/payment-reconciliation-service.test.ts` — reconcile a reversed evidence-backed payment as advance interest with provenance.
- Modify: `backend/src/services/loan-settlement-service.ts` and `backend/src/services/loan-settlement-service.test.ts` — exclude fully prepaid active period interest while retaining unpaid arrears and explicit penalties.
- Modify: `backend/src/services/loan-application-service.ts` and `backend/src/services/loan-application-service.test.ts` — present collection mode/covered period from immutable policy data.
- Modify: `backend/src/modules/loan-route-schemas.ts`, `backend/src/modules/loan-contract-routes.ts`, relevant route tests — closed public response schemas for coverage state.
- Modify: `backend/src/mcp/default.ts`, `backend/src/mcp/server.ts`, MCP tests — safe payment preview/reconciliation summaries and destructive hints remain correct.
- Modify: `frontend/src/pages/dashboard/loans/LoanDetail.tsx`, floating interest summary component/tests, `frontend/src/locales/en.json`, `frontend/src/locales/th.json` — show advance/arrears mode and covered period without browser-side finance calculations.
- Modify: `plugins/creditsync/references/mcp-tool-contract.json`, `README.md`, relevant plugin skills/evals/tests — synchronize operator guidance and schema contract.
- Modify: `CHANGELOG.md` — one concise entry per commit.

### Task 1: Define and test the anchored advance-period selector

**Files:**
- Modify: `backend/src/services/floating-interest-service.ts:226-370, 430-463`
- Test: `backend/src/services/floating-allocation-regressions.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces `selectFloatingInterestPaymentTargets(tx, loan, receivedAt, collectionMode)` returning ordered immutable accrual rows with `publicId`, `periodStartDate`, `periodEndDate`, `interestAmount`, `paidAmount`, and `isAdvanceEligible`.
- Consumes `accrueFloatingInterestThrough`, `interestPeriodFor`, and existing `loanInterestAccruals` rows.
- A future consumer may allocate only the remaining exact amount from this selector.

- [ ] **Step 1: Write failing weekly advance selector tests**

```ts
integrationTest("selects the anchored current weekly period for an advance payment", async () => {
  const seeded = await seedWeeklyFloatingLoan({
    startDate: "2026-08-13",
    principal: "5000.00",
    rate: "12.0000",
    advanceInterestPeriods: 1,
  });
  const targets = await selectFloatingInterestPaymentTargets(
    db, seeded.loan, new Date("2026-08-23T18:13:00+07:00"), seeded.ctx,
  );
  expect(targets).toMatchObject([{
    periodStartDate: "2026-08-20",
    periodEndDate: "2026-08-27",
    remainingAmount: "600.00",
    isAdvanceEligible: true,
  }]);
});

integrationTest("does not select an accruing weekly period for arrears collection", async () => {
  const seeded = await seedWeeklyFloatingLoan({ advanceInterestPeriods: 0 });
  const targets = await selectFloatingInterestPaymentTargets(
    db, seeded.loan, new Date("2026-08-23T18:13:00+07:00"), seeded.ctx,
  );
  expect(targets).toEqual([]);
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `backend/scripts/test-disposable-postgres.sh src/services/floating-allocation-regressions.test.ts`

Expected: FAIL because `selectFloatingInterestPaymentTargets` does not exist.

- [ ] **Step 3: Implement materialization and selection without moving periods**

Add the exported selector in `floating-interest-service.ts`. It must call
`accrueFloatingInterestThrough` through `receivedAt`, group snapshots by the
stored period boundary, skip the activation-paid first period, and return the
earliest remaining full/partial period only when:

```ts
const advanceEligible = loan.advanceInterestPeriods === 1
  && row.periodStartDate !== null
  && row.periodStartDate <= bangkokDate(receivedAt);
const arrearsEligible = isFloatingAccrualPayableThrough(row, bangkokDate(receivedAt));
```

Do not set a penalty, alter `periodStartDate`, or mutate paid amounts in this
selector.

- [ ] **Step 4: Run selector and existing floating regression suites**

Run: `backend/scripts/test-disposable-postgres.sh src/services/floating-allocation-regressions.test.ts src/services/payment-service.test.ts`

Expected: PASS, including all pre-existing daily and weekly allocation tests.

- [ ] **Step 5: Update changelog and commit**

```bash
git add CHANGELOG.md backend/src/services/floating-interest-service.ts backend/src/services/floating-allocation-regressions.test.ts
git commit -m "fix: select anchored advance floating interest periods"
```

### Task 2: Allocate normal advance payments to interest before principal

**Files:**
- Modify: `backend/src/services/payment-service.ts:1000-1050, 1578-1660`
- Test: `backend/src/services/payment-service.test.ts:534-720`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes `selectFloatingInterestPaymentTargets` from Task 1.
- Produces a payment preview allocation with `matchReason: "advance_interest_period"` and one or more interest-only `floatingTransactionAllocations`.
- Preserves the existing principal-first behavior when the selector returns no eligible target.

- [ ] **Step 1: Write failing posting tests**

```ts
integrationTest("posts a late-in-period weekly advance payment entirely as interest", async () => {
  const seeded = await seedWeeklyFloatingLoan({
    startDate: "2026-08-13", principal: "5000.00", rate: "12.0000",
    advanceInterestPeriods: 1,
  });
  const intake = await createPaymentIntake(seeded.ctx, {
    amount: "600.00", receivedAt: "2026-08-23T18:13:00+07:00",
  });
  const preview = await previewPaymentMatch(seeded.ctx, intake.publicId, {
    allocations: [{ borrowerPublicId: seeded.borrower.publicId, loanPublicId: seeded.loan.publicId, amount: "600.00" }],
  });
  const posted = await postPayment(seeded.ctx, intake.publicId, { proposalPublicId: preview.publicId });
  expect(posted.transactions).toMatchObject([{ principalComponent: "0.00", interestComponent: "600.00" }]);
  expect(await paidPeriod(seeded.loan.id, "2026-08-20", "2026-08-27")).toBe("600.00");
});

integrationTest("keeps an early arrears payment on principal", async () => {
  // Same dates and amount, but advanceInterestPeriods: 0.
  // Assert principalComponent is 600.00 and interestComponent is 0.00.
});
```

- [ ] **Step 2: Run the focused payment suite and verify it fails**

Run: `backend/scripts/test-disposable-postgres.sh src/services/payment-service.test.ts`

Expected: FAIL because the current weekly payment posts `principalComponent: "600.00"`.

- [ ] **Step 3: Route eligible amount through immutable interest allocations**

In preview and post execution, allocate from selector targets before the
principal fallback only for advance-mode floating loans. For each selected
target, insert `floatingTransactionAllocations` with the target accrual ID,
`component: "interest"`, `dueDate: periodEndDate`, actual Bangkok receipt
date as `effectiveDate`, stable allocation order, audit metadata, and an
idempotency key derived from payment/target/order. Update `paidAmount` and
status atomically; preserve exact partial amounts and reject over-allocation.

- [ ] **Step 4: Run focused payment and reversal suites**

Run: `backend/scripts/test-disposable-postgres.sh src/services/payment-service.test.ts src/services/floating-allocation-regressions.test.ts`

Expected: PASS. Confirm payment reversal restores the period's paid amount
and no penalty is inserted for the 23 August receipt.

- [ ] **Step 5: Update changelog and commit**

```bash
git add CHANGELOG.md backend/src/services/payment-service.ts backend/src/services/payment-service.test.ts
git commit -m "fix: post floating advance payments as interest"
```

### Task 3: Reconcile reversed evidence-backed advance payments

**Files:**
- Modify: `backend/src/services/payment-reconciliation-service.ts:260-312`
- Test: `backend/src/services/payment-reconciliation-service.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes the selector from Task 1 and the existing reconciliation proposal hash/balance version.
- Produces one append-only repost child with `principalComponent: "0.00"`, `interestComponent: "600.00"`, and linked advance-period provenance.

- [ ] **Step 1: Write a failing reversed-repost test for weekly advance interest**

```ts
integrationTest("reposts a reversed weekly advance payment as the anchored period interest", async () => {
  const { ctx, borrower, loan, reversedEvidenceBackedIntake } = await seedReversedWeeklyAdvancePayment({
    startDate: "2026-08-13", receivedAt: "2026-08-23T18:13:00+07:00", amount: "600.00",
  });
  const preview = await previewPaymentReconciliation(ctx, {
    paymentIntakePublicId: reversedEvidenceBackedIntake.publicId,
    allocations: [{ borrowerPublicId: borrower.publicId, loanPublicId: loan.publicId, amount: "600.00", component: "interest" }],
    reason: "Confirmed weekly advance interest",
  });
  const result = await executePaymentReconciliation(ctx, preview.publicId, confirmed(preview));
  expect(await replacementTransaction(result.postedPaymentPublicId)).toMatchObject({
    principalComponent: "0.00", interestComponent: "600.00",
  });
  expect(await paidPeriod(loan.id, "2026-08-20", "2026-08-27")).toBe("600.00");
});
```

- [ ] **Step 2: Run reconciliation tests and verify the current provenance failure**

Run: `backend/scripts/test-disposable-postgres.sh src/services/payment-reconciliation-service.test.ts`

Expected: FAIL with `RECONCILIATION_INTEREST_PROVENANCE_UNAVAILABLE`.

- [ ] **Step 3: Share the exact selector/allocation writer with reconciliation**

Replace the local due-only `loanInterestAccruals` loop with the Task 1 target
selection plus a common transaction-allocation writer. Keep locks before
state hashing, preserve `reversed_repost` lineage, and retain the existing
error when no advance or payable arrears provenance can cover the exact
interest amount.

- [ ] **Step 4: Run reconciliation, payment, and stale-state coverage**

Run: `backend/scripts/test-disposable-postgres.sh src/services/payment-reconciliation-service.test.ts src/services/payment-service.test.ts`

Expected: PASS for repost, evidence requirement, replay idempotency, stale
hash, and unsupported-component regressions.

- [ ] **Step 5: Update changelog and commit**

```bash
git add CHANGELOG.md backend/src/services/payment-reconciliation-service.ts backend/src/services/payment-reconciliation-service.test.ts
git commit -m "fix: reconcile floating advance interest"
```

### Task 4: Preserve prepaid coverage during settlement and penalty handling

**Files:**
- Modify: `backend/src/services/loan-settlement-service.ts:180-215, 520-665`
- Test: `backend/src/services/loan-settlement-service.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes paid accrual amounts and advance-period allocation provenance.
- Produces settlement preview/execution that includes only unpaid interest and explicit penalties.

- [ ] **Step 1: Write failing settlement and zero-penalty tests**

```ts
integrationTest("does not charge a prepaid weekly period again at close-out", async () => {
  const seeded = await seedWeeklyAdvanceLoanPaidForPeriod("2026-08-20", "2026-08-27");
  const preview = await previewLoanSettlement(seeded.ctx, seeded.loan.publicId, "2026-08-24");
  expect(preview.dueInterest).toBe("0.00");
  expect(preview.accruedNotDueInterest).toBe("0.00");
  expect(preview.outstandingPenalties).toBe("0.00");
});

integrationTest("does not create a penalty merely because advance interest arrived after period start", async () => {
  const seeded = await seedWeeklyAdvanceLoanPaidForPeriod("2026-08-20", "2026-08-27");
  expect(await floatingPenaltyRows(seeded.loan.id)).toEqual([]);
});
```

- [ ] **Step 2: Run settlement tests and verify the first test fails before the fix**

Run: `backend/scripts/test-disposable-postgres.sh src/services/loan-settlement-service.test.ts`

Expected: FAIL if settlement includes the THB 600 period despite `paidAmount`.

- [ ] **Step 3: Base settlement composition on remaining accrual amounts only**

Use `max(0, interestAmount - paidAmount)` for every active period snapshot
and preserve existing due/not-due classification only for remaining amounts.
Do not infer a penalty; leave `floatingPenaltyLedgerEntries` unchanged unless
the explicit penalty command has already created a row.

- [ ] **Step 4: Run settlement, payment reversal, and floating allocation suites**

Run: `backend/scripts/test-disposable-postgres.sh src/services/loan-settlement-service.test.ts src/services/payment-service.test.ts src/services/floating-allocation-regressions.test.ts`

Expected: PASS, including reversal of the advance payment restoring the exact
period's unpaid amount.

- [ ] **Step 5: Update changelog and commit**

```bash
git add CHANGELOG.md backend/src/services/loan-settlement-service.ts backend/src/services/loan-settlement-service.test.ts
git commit -m "fix: exclude prepaid floating interest from settlement"
```

### Task 5: Expose collection mode and synchronize operator workflow

**Files:**
- Modify: `backend/src/services/loan-application-service.ts:350-362, 1127-1154`
- Modify: `backend/src/modules/loan-route-schemas.ts`, `backend/src/modules/loan-contract-routes.ts`, relevant tests
- Modify: `backend/src/mcp/default.ts`, `backend/src/mcp/server.ts`, MCP tests
- Modify: `frontend/src/pages/dashboard/loans/LoanDetail.tsx`, floating interest summary component/tests
- Modify: `frontend/src/locales/en.json`, `frontend/src/locales/th.json`
- Modify: `plugins/creditsync/references/mcp-tool-contract.json`, `plugins/creditsync/README.md`, relevant skills/evals/tests
- Modify: `README.md`, `CHANGELOG.md`

**Interfaces:**
- Produces safe public contract fields: `collectionMode: "advance" | "arrears"`, `coveredPeriod` when one is fully paid, and payment preview match reason `advance_interest_period`.
- Frontend and MCP render backend values only; they do not calculate interest or penalty.

- [ ] **Step 1: Write failing presenter, MCP, and UI tests**

```ts
expect(contract.floatingInterestPolicy).toMatchObject({
  collectionMode: "advance",
  coveredPeriod: { startDate: "2026-08-20", endDate: "2026-08-27", amount: "600.00" },
});
expect(preview.allocations[0]).toMatchObject({ matchReason: "advance_interest_period" });
expect(screen.getByText(/paid in advance.*20.*27/i)).toBeVisible();
```

Add Thai assertions for the matching translated label. Add plugin contract and
eval assertions that an agent must inspect the policy, preview exact
allocation, and stop for confirmation before post/reconcile.

- [ ] **Step 2: Run focused API, MCP, frontend, and plugin tests to verify failure**

Run: `cd backend && bun test src/modules/loan-contract-routes.test.ts src/mcp`

Run: `cd frontend && bun test`

Run: `cd plugins/creditsync && bun test`

- [ ] **Step 3: Implement response presentation and localized labels**

Derive `collectionMode` only from immutable policy. Determine covered period
from persisted paid accrual/allocation provenance, return only safe public
fields, and preserve closed schemas. Add English and Thai keys together; no
hardcoded language strings or browser-side money calculations.

- [ ] **Step 4: Run full non-production verification gates**

Run: `backend/scripts/test-disposable-postgres.sh src/services/floating-allocation-regressions.test.ts src/services/payment-service.test.ts src/services/payment-reconciliation-service.test.ts src/services/loan-settlement-service.test.ts`

Run: `cd backend && bun x tsc --noEmit`

Run: `cd frontend && bun test && bun run lint && bun run build`

Run: `cd plugins/creditsync && bun test && bun run validate`

- [ ] **Step 5: Update docs/changelog and commit**

```bash
git add CHANGELOG.md README.md backend/src/services/loan-application-service.ts backend/src/modules backend/src/mcp frontend plugins/creditsync
git commit -m "feat: expose floating advance interest collection"
```

### Task 6: Correct the confirmed reversed THB 600 receipt through MCP

**Files:**
- No source-code changes; use MCP operational workflow after Tasks 1–5 pass.

**Interfaces:**
- Source intake: `01a03078-3fef-7f79-b6b5-dfdec84c0bc9` (must remain reversed).
- Loan: `019ffb21-f852-7375-8605-5adc6f0beb51`.
- Expected repost child: amount `600.00`, principal `0.00`, interest `600.00`, period `[2026-08-20, 2026-08-27)`.

- [ ] **Step 1: Re-inspect source, contract, and exact period before writing**

Call `intake_get`, `loan_contract_get`, and the payment/reconciliation preview.
Confirm evidence is `ready`, source status is `reversed`, advance collection
is enabled, no child repost exists, and preview covers exactly THB `600.00`.

- [ ] **Step 2: Execute only the explicit confirmation workflow**

Call `payment_reconcile_execute` with `confirmed: true`, the current preview
hash/balance version, a fresh idempotency key, and reason:

```text
Confirmed weekly advance interest for anchored period 2026-08-20 through 2026-08-27; no automatic penalty.
```

- [ ] **Step 3: Verify append-only result independently**

Call `intake_get`, `loan_payment_history_list`, and `loan_contract_get`.
Assert one repost child is posted, source is still reversed, original evidence
is retained on source, transaction components equal principal `0.00` and
interest `600.00`, linked allocation covers `[20,27)`, and audit/correlation
IDs are present.

- [ ] **Step 4: Report the verified financial state**

Report the receipt date, THB `600.00` interest component, zero principal,
covered dates, penalty `0.00`, repost child public ID, audit public ID, and
correlation ID. Do not expose raw QR payloads, signed URLs, or evidence text.

## Plan Self-Review

- **Spec coverage:** Tasks 1–4 implement anchored advance/arrears allocation,
  provenance, settlement, and zero-default penalty rules; Task 5 exposes the
  policy safely; Task 6 corrects the real reversed receipt only after tests.
- **Placeholder scan:** No `TBD`, `TODO`, vague error-handling directives, or
  undefined implementation steps remain.
- **Type consistency:** All tasks use existing `loanInterestAccruals`,
  `floatingTransactionAllocations`, `CommandContext`, MCP reconciliation
  preview/hash/balance-version inputs, and two-decimal string interfaces.
