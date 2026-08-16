# Own Capital Recovered Cash Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recycle all borrower cash collected from loans linked to a personal capital-pool source into its available-capital capacity while excluding unlinked loans and preserving ROI semantics.

**Architecture:** Extend the existing `funding-usage` read model in `backend/src/modules/bank-profiles.ts` to aggregate exact transaction cash by loan, attribute it using each source's positive allocation share, and add it only for `capital_pool` sources. Keep settlement/ROI calculations unchanged, expose the attributed amount in the response, and update the fund-detail explanatory copy in both locales.

**Tech Stack:** Bun, TypeScript, Elysia, Drizzle ORM, Decimal.js, React, react-i18next, Bun test.

## Global Constraints

- Use Bun for tests and development commands.
- Use Decimal.js for all financial arithmetic; do not use JavaScript floating-point arithmetic for money.
- Public money values remain two-decimal decimal strings.
- Only loans with a positive net allocation to the current funding source may contribute collected cash.
- Do not change realized spread, realized ROI, settlement summaries, or external-liability capacity behavior.
- Update `CHANGELOG.md` before each commit; update `README.md` only if setup or user-facing workflow expectations materially change.

### Task 1: Add failing funding-usage regression coverage

**Files:**
- Modify: `backend/src/modules/bank-profiles.test.ts`

**Interfaces:**
- Consumes: existing authenticated `GET /bank-profiles/:id/funding-usage` test harness and database fixtures.
- Produces: regression tests defining `linkedBorrowerCashCollected`, source-share attribution, unlinked-loan exclusion, and external-liability behavior.

- [ ] **Step 1: Add a capital-pool test with linked and unlinked payments.**

Seed a `60000.00` capital-pool source, a source-linked loan with a `7000.00` allocation, an unrelated loan with no allocation, and transactions on both loans. Assert that the response reports only the linked transaction amount and available amount equal to `60000 - 7000 + linked amount`.

- [ ] **Step 2: Add a partial-funding attribution assertion.**

Seed a loan with positive allocations from two sources, post one borrower transaction, and assert that the current source receives only `transaction.amount * sourcePositiveAllocation / totalPositiveAllocation` using exact two-decimal output.

- [ ] **Step 3: Add an external-liability regression assertion.**

Seed a non-`capital_pool` source with a drawdown and linked borrower payment. Assert its available amount remains capacity-based and its linked collected-cash field is `0.00` (or the response contract's documented non-applicable value).

- [ ] **Step 4: Run the focused tests and verify RED.**

Run:

```bash
cd backend && bun test src/modules/bank-profiles.test.ts
```

Expected: the new assertions fail because the response does not yet expose linked collected cash and available amount still uses only `creditLimit - netAllocatedPrincipal`.

### Task 2: Implement exact linked-cash aggregation in funding usage

**Files:**
- Modify: `backend/src/modules/bank-profiles.ts: funding-usage route`
- Modify: `backend/src/modules/bank-profiles.test.ts`

**Interfaces:**
- Consumes: positive source allocations already normalized by loan, existing `transactions` table, and Decimal.js.
- Produces: `linkedBorrowerCashCollected` as a two-decimal string and a capital-pool `availableAmount` that adds it.

- [ ] **Step 1: Query transaction totals only for positively allocated loans.**

After `allocatedLoans` is known, query `transactions.amount` grouped by `loanId` for those loan IDs. Do not query or aggregate all tenant transactions into the source result.

- [ ] **Step 2: Derive each loan's source share with Decimal.js.**

Reuse the existing positive-allocation denominator logic. For each allocated loan, compute `sourceNetAllocated / totalPositiveAllocation` and multiply the loan's grouped transaction amount by that share. Sum the results into `linkedBorrowerCashCollected`.

- [ ] **Step 3: Apply the capital-pool-only available formula.**

Keep external-liability behavior unchanged. For capital pools, calculate:

```ts
const linkedBorrowerCashCollected = ...;
const availableAmount = capitalPool
    ? creditLimit.minus(netAllocatedPrincipal).plus(linkedBorrowerCashCollected)
    : creditLimit.minus(utilizedAmount);
```

Serialize both values using the repository's exact money serializers.

- [ ] **Step 4: Run the focused tests and verify GREEN.**

Run:

```bash
cd backend && bun test src/modules/bank-profiles.test.ts
```

Expected: all funding-usage and profitability tests pass, including the new linked/unlinked/partial/external cases.

### Task 3: Explain the new metric in the localized fund UI

**Files:**
- Modify: `frontend/src/pages/dashboard/funds/FundDetail.tsx`
- Modify: `frontend/src/locales/th.json`
- Modify: `frontend/src/locales/en.json`

**Interfaces:**
- Consumes: `fundingUsage.availableAmount` and optional `linkedBorrowerCashCollected` response field.
- Produces: localized helper text stating that linked-loan collections are included and unlinked-loan collections are excluded.

- [ ] **Step 1: Add locale keys in Thai and English.**

Add matching keys for the available-own-capital explanation, with Thai copy making the inclusion/exclusion rule explicit and English copy preserving the same meaning.

- [ ] **Step 2: Render the explanation beneath the available amount.**

Show the helper only for `capital_pool` sources. Keep the existing limit/allocation labels and exact amount rendering unchanged.

- [ ] **Step 3: Run frontend checks.**

Run:

```bash
cd frontend && bun test && bun run lint && bun run build
```

Expected: all frontend checks pass.

### Task 4: Run full verification and record the change

**Files:**
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: completed backend/API/UI implementation.
- Produces: verified branch state with changelog entry and no unrelated tracked changes.

- [ ] **Step 1: Run backend typecheck and disposable database suites.**

Run the repository's prescribed backend disposable PostgreSQL test script and backend typecheck command from `backend/package.json`. Confirm no database-backed test is skipped for the changed invariant.

- [ ] **Step 2: Run plugin/validator checks if the response contract is consumed there.**

Search for `funding-usage`, `availableAmount`, and `linkedBorrowerCashCollected`. Run applicable plugin tests/validators only if this endpoint contract is mirrored outside the Web UI.

- [ ] **Step 3: Update the changelog before the implementation commit.**

Under `## v0.3.14 - 2026-08-16`, add a concise `Changed` entry describing that available own capital now recycles all cash collected from source-linked loans while excluding unlinked loans and keeping ROI separate.

- [ ] **Step 4: Inspect final diff and test state.**

Run `git diff --check`, `git status --short`, and review the complete diff. Confirm no unrelated user changes are overwritten and that all required gates ran at the final HEAD.

- [ ] **Step 5: Commit the implementation.**

```bash
git add backend/src/modules/bank-profiles.ts backend/src/modules/bank-profiles.test.ts frontend/src/pages/dashboard/funds/FundDetail.tsx frontend/src/locales/th.json frontend/src/locales/en.json CHANGELOG.md
git commit -m "feat: recycle linked loan cash into own capital"
```
