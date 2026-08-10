# Own Capital Direct Funding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let owners and managers fund borrower loans directly from capital-pool profiles with capacity enforcement and a configurable non-cash opportunity cost that defaults to 2.00% per year.

**Architecture:** Extend `bank_profiles` with a classified capital-pool opportunity-cost policy and reuse `loan_funding_allocations` for direct profile allocations (`bankLoanId = null`). Loan application services own funding validation and activation locks; REST/MCP merely adapt public UUID contracts. The profitability layer computes opportunity cost separately from cash bank costs, while the wizard displays grouped capital profiles and external drawdowns.

**Tech Stack:** Bun, TypeScript, Elysia, Drizzle/PostgreSQL, Decimal.js, React 19, React i18next, Vitest.

## Global Constraints

- Only profiles with `accountingMode: "capital_pool"` can fund loans directly; never silently reclassify an existing profile.
- New capital-pool profiles default `opportunityCostRate` to `"2.00"`; all money/rates are decimal strings and every calculation uses Decimal.js.
- A direct capital allocation must have `bankProfileId` and a null `bankLoanId`; a drawdown allocation must have both IDs.
- Own-capital opportunity cost is non-cash: it must not create transactions, bank repayments, or fund-ledger cash entries.
- Activation locks the loan and source allocation rows, recomputes capacity in the same transaction, and rejects over-allocation.
- Preserve current drawdown behavior, public UUID boundaries, tenant isolation, and append-only audit records.
- Update `frontend/src/locales/en.json` and `frontend/src/locales/th.json` together for every visible string.
- Update root `CHANGELOG.md` in every commit and `README.md` for the user-facing workflow changes.

---

### Task 1: Persist opportunity-cost policy and direct-capital classification

**Files:**
- Modify: `backend/src/db/schema.ts`
- Create: `backend/drizzle/0013_own_capital_direct_funding.sql`
- Create: `backend/src/db/own-capital-direct-funding-migration.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- `bankProfiles.opportunityCostRate` is a non-negative numeric annual percent, defaulting to `"2.00"`.
- Existing rows retain their accounting mode and receive `"2.00"` without being made capital pools.

- [ ] **Step 1: Write the failing migration assertions**

```ts
it("adds a 2% annual opportunity cost without changing existing funding classification", async () => {
  await applyMigrationsThrough("0012_payment_review_warnings.sql");
  const legacy = await seedBankProfile({ accountingMode: "external_liability" });

  await applyMigration("0013_own_capital_direct_funding.sql");

  const profile = await findProfile(legacy.id);
  expect(profile.accountingMode).toBe("external_liability");
  expect(profile.opportunityCostRate).toBe("2.00");
});
```

- [ ] **Step 2: Run the migration test to verify it fails**

Run: `cd backend && bun test src/db/own-capital-direct-funding-migration.test.ts`  
Expected: FAIL because the migration and schema column do not exist.

- [ ] **Step 3: Add the migration and schema field**

```sql
ALTER TABLE bank_profiles
  ADD COLUMN opportunity_cost_rate numeric NOT NULL DEFAULT 2.00;
ALTER TABLE bank_profiles
  ADD CONSTRAINT bank_profiles_opportunity_cost_rate_nonnegative
  CHECK (opportunity_cost_rate >= 0);
```

```ts
opportunityCostRate: numeric("opportunity_cost_rate").notNull().default("2.00"),
```

- [ ] **Step 4: Verify the migration is additive and green**

Run: `cd backend && bun test src/db/own-capital-direct-funding-migration.test.ts`  
Expected: PASS; the pre-existing profile remains `external_liability`.

- [ ] **Step 5: Commit the persistence foundation**

```bash
git add backend/src/db/schema.ts backend/drizzle/0013_own_capital_direct_funding.sql backend/src/db/own-capital-direct-funding-migration.test.ts CHANGELOG.md
git commit -m "feat: add own-capital opportunity cost policy"
```

### Task 2: Compute non-cash opportunity cost in funding profitability

**Files:**
- Modify: `backend/src/lib/fund-settlement.ts`
- Modify: `backend/src/lib/fund-settlement.test.ts`
- Modify: `backend/src/modules/bank-profiles.ts`
- Modify: `backend/src/services/funding-source-service.ts`
- Modify: `backend/src/mcp/server.ts`
- Modify: `backend/src/mcp/default.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produce `opportunityCostAccrued` and `economicSpread` alongside existing `fundCostPaid`, `realizedSpread`, and `unrealizedSpread`.
- `opportunityCostAccrued = allocatedPrincipal × rate / 100 × Bangkok elapsed days / 365`, rounded half-up to cents.

- [ ] **Step 1: Write failing profitability tests**

```ts
it("reports a 2% own-capital cost without treating it as cash fund cost", async () => {
  const summary = await getLoanProfitabilitySummary(tenantId, ownCapitalLoan.id, asOf("2026-08-11"));

  expect(summary.fundCostPaid).toBe(0);
  expect(summary.opportunityCostAccrued).toBe(1.37);
  expect(summary.economicSpread).toBe(summary.borrowerRevenueCollected - 1.37);
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `cd backend && bun test src/lib/fund-settlement.test.ts`  
Expected: FAIL because the summary has no opportunity-cost fields.

- [ ] **Step 3: Implement Decimal-based own-capital cost**

```ts
function opportunityCost(principal: Decimal, annualRate: Decimal, days: number) {
  return principal.times(annualRate).div(100).times(days).div(365)
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}
```

Only apply it to net allocations whose profile is `capital_pool`; preserve external drawdown cost logic exactly. Serialize values through `serializeMoney` and expose profile opportunity rate through `presentFundingSources` and the MCP funding read output.

- [ ] **Step 4: Verify focused backend and MCP contract tests**

Run: `cd backend && bun test src/lib/fund-settlement.test.ts src/mcp/default.test.ts`  
Expected: PASS; the funding tool shows the rate but exposes no funding write capability.

- [ ] **Step 5: Commit profitability support**

```bash
git add backend/src/lib/fund-settlement.ts backend/src/lib/fund-settlement.test.ts backend/src/modules/bank-profiles.ts backend/src/services/funding-source-service.ts backend/src/mcp/server.ts backend/src/mcp/default.test.ts CHANGELOG.md
git commit -m "feat: report own-capital opportunity cost"
```

### Task 3: Support direct capital profile allocation in loan draft and activation

**Files:**
- Modify: `backend/src/services/loan-application-service.ts`
- Modify: `backend/src/services/loan-application-service.test.ts`
- Modify: `backend/src/modules/loans.ts`
- Modify: `backend/src/mcp/server.ts`
- Modify: `backend/src/mcp/default.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**

```ts
type LoanDraftInput = PublicLoanCalculationParams & {
  borrowerPublicId: string;
  bankLoanPublicId?: string | null;
  bankProfilePublicId?: string | null;
};
```

`bankLoanPublicId` and `bankProfilePublicId` are mutually exclusive. `activateLoan` creates a direct allocation only when the profile is active, `capital_pool`, and has enough remaining capacity.

- [ ] **Step 1: Write failing application-service tests**

```ts
it("activates a direct own-capital allocation and records no bank drawdown", async () => {
  const draft = await createLoanDraft(ctx, { ...terms, borrowerPublicId, bankProfilePublicId: capital.publicId });
  await activateLoan(ctx, draft.publicId);

  expect(await allocationsForLoan(draft.publicId)).toMatchObject([
    { bankProfileId: capital.id, bankLoanId: null, allocatedAmount: "5000.00" },
  ]);
});

it("rejects direct capital activation that exceeds remaining profile capacity", async () => {
  await expect(activateLoan(ctx, overCapacityDraft.publicId)).rejects.toMatchObject({ code: "ALLOCATION_EXCEEDS_CAPITAL" });
});
```

- [ ] **Step 2: Run the service tests to verify they fail**

Run: `cd backend && bun test src/services/loan-application-service.test.ts`  
Expected: FAIL because direct profile IDs are not accepted or allocated during activation.

- [ ] **Step 3: Implement exclusive source resolution and locked capacity checks**

```ts
if (input.bankLoanPublicId && input.bankProfilePublicId) {
  throw new DomainError("INVALID_FUNDING_SOURCE", "Choose either a drawdown or own-capital profile", 400);
}
```

Resolve a direct profile only if it is tenant-visible, active, and `capital_pool`. In activation, lock the profile and its allocation rows, sum net allocations, compare to `creditLimit`, then insert one `loanFundingAllocations` row with `bankLoanId: null`. Preserve existing drawdown locks and errors.

- [ ] **Step 4: Extend REST and MCP schemas, then run integration tests**

Add optional `bankProfilePublicId` to `POST /loans`, `PUT /loans/:id`, preview presenters, and the MCP `loan_draft` input. Return `bankProfilePublicId` and `fundingKind` in loan DTOs.  
Run: `cd backend && bun test src/services/loan-application-service.test.ts src/mcp/default.test.ts src/mcp/server.test.ts`  
Expected: PASS for direct capital, external drawdown, forbidden profile, conflicting sources, and concurrent capacity attempts.

- [ ] **Step 5: Commit direct funding activation**

```bash
git add backend/src/services/loan-application-service.ts backend/src/services/loan-application-service.test.ts backend/src/modules/loans.ts backend/src/mcp/server.ts backend/src/mcp/default.test.ts CHANGELOG.md
git commit -m "feat: fund loans directly from own capital"
```

### Task 4: Make funding profiles configurable as own capital

**Files:**
- Modify: `frontend/src/pages/dashboard/funds/FundList.tsx`
- Modify: `frontend/src/pages/dashboard/funds/FundDetail.tsx`
- Modify: `frontend/src/locales/en.json`
- Modify: `frontend/src/locales/th.json`
- Create: `frontend/tests/own-capital-funds.vitest.tsx`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- A profile form sends `accountingMode: "capital_pool"` and `opportunityCostRate: "2.00"` for own capital; external liability remains the existing default.
- Fund detail displays the non-cash annual rate and economic profitability values.

- [ ] **Step 1: Write failing UI tests for capital-pool setup**

```tsx
it("creates own capital with a 2% default opportunity cost", async () => {
  render(<FundList />);
  await user.click(screen.getByRole("button", { name: /add source/i }));
  await user.selectOptions(screen.getByLabelText(/funding kind/i), "capital_pool");
  expect(screen.getByLabelText(/opportunity cost/i)).toHaveValue(2);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && bun run test tests/own-capital-funds.vitest.tsx`  
Expected: FAIL because the current form has no capital classification or opportunity-cost field.

- [ ] **Step 3: Implement the localized source form and detail metrics**

Add a funding-kind select, localized help text explaining non-cash cost, a decimal rate input defaulted to 2.00 only for own capital, and profile-detail cards for cash cost, opportunity cost, and economic spread. Preserve existing bank source forms and delete behavior.

- [ ] **Step 4: Verify UI tests, locale completeness, and build**

Run: `cd frontend && bun run test tests/own-capital-funds.vitest.tsx && bun run lint && bun run build`  
Expected: PASS; both language catalogs resolve all new keys.

- [ ] **Step 5: Commit the funding-source UI**

```bash
git add frontend/src/pages/dashboard/funds/FundList.tsx frontend/src/pages/dashboard/funds/FundDetail.tsx frontend/src/locales/en.json frontend/src/locales/th.json frontend/tests/own-capital-funds.vitest.tsx README.md CHANGELOG.md
git commit -m "feat: configure own-capital funding profiles"
```

### Task 5: Group direct capital and drawdowns in the new-loan wizard

**Files:**
- Modify: `frontend/src/pages/dashboard/loans/LoanWizard.tsx`
- Modify: `frontend/src/lib/workflow-model.ts`
- Modify: `frontend/tests/loan-wizard.vitest.tsx`
- Modify: `frontend/src/locales/en.json`
- Modify: `frontend/src/locales/th.json`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Interfaces:**

```ts
type FundingSelection =
  | { kind: "none" }
  | { kind: "capital"; bankProfilePublicId: string }
  | { kind: "drawdown"; bankLoanPublicId: string };
```

`buildLoanDraftInput(form, fundingSelection)` emits only the relevant public source ID and never numeric IDs.

- [ ] **Step 1: Write failing wizard tests**

```tsx
it("groups own-capital profiles and drawdowns, then submits only the selected capital public ID", async () => {
  vi.mocked(api.get).mockResolvedValueOnce({ data: borrowers }).mockResolvedValueOnce({ data: profiles }).mockResolvedValueOnce({ data: drawdowns });
  render(<LoanWizard />);
  await user.selectOptions(screen.getByLabelText(/funding source/i), "capital:capital-public-id");
  await completeTermsAndSubmit(user);
  expect(api.post).toHaveBeenCalledWith("/loans", expect.objectContaining({ bankProfilePublicId: "capital-public-id" }));
  expect(api.post).not.toHaveBeenCalledWith("/loans", expect.objectContaining({ bankLoanPublicId: expect.anything() }));
});
```

- [ ] **Step 2: Run the wizard test to verify it fails**

Run: `cd frontend && bun run test tests/loan-wizard.vitest.tsx`  
Expected: FAIL because the wizard loads only `/bank-loans` and cannot submit a profile public ID.

- [ ] **Step 3: Implement grouped source selection and review disclosure**

Load active profiles and drawdowns, derive capital availability from the profile capacity DTO, and render grouped `optgroup` choices. Disable capital choices with zero capacity. Include selected source, remaining capacity, and annual opportunity cost in review. Keep “allocate later” as the default and retain the existing drawdown selection path.

- [ ] **Step 4: Verify the entire frontend suite**

Run: `cd frontend && bun run test && bun run lint && bun run build`  
Expected: PASS; the wizard remains compatible with no source and external drawdown workflows.

- [ ] **Step 5: Commit the wizard integration**

```bash
git add frontend/src/pages/dashboard/loans/LoanWizard.tsx frontend/src/lib/workflow-model.ts frontend/tests/loan-wizard.vitest.tsx frontend/src/locales/en.json frontend/src/locales/th.json README.md CHANGELOG.md
git commit -m "feat: select own capital in loan wizard"
```

### Task 6: Release verification and deploy

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- The documented workflow describes classification, direct allocation capacity, and the difference between cash and economic profitability.

- [ ] **Step 1: Add release-level regression coverage**

```ts
it("keeps a direct own-capital allocation tenant-scoped and leaves cash ledger entries unchanged", async () => {
  const before = await cashLedgerForProfile(capital.id);
  await activateLoan(ownerCtx, capitalDraft.publicId);
  expect(await cashLedgerForProfile(capital.id)).toEqual(before);
  await expect(getLoanApplication(otherTenantCtx, capitalDraft.publicId)).rejects.toMatchObject({ code: "LOAN_NOT_FOUND" });
});
```

- [ ] **Step 2: Run full verification**

Run: `cd backend && bun test && bun run typecheck && cd ../frontend && bun run test && bun run lint && bun run build`  
Expected: PASS; verify migration on a disposable database and review that no cash ledger entry was created for own-capital opportunity cost.

- [ ] **Step 3: Update operations documentation and changelog**

Document how to classify a source as own capital, set its rate, choose it in the loan wizard, and interpret cash versus economic spread. State that existing profiles remain external until explicitly changed.

- [ ] **Step 4: Rebuild the production application and smoke test**

Run: `docker compose --env-file .env.production -f docker-compose.app.yml up --build -d && curl --fail --silent http://127.0.0.1:8088/ > /dev/null`  
Expected: both application containers are running; create a non-posted draft in the web UI using an own-capital source, confirm its review values, then leave it as a draft or remove it through the normal workflow.

- [ ] **Step 5: Commit release documentation**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: document direct own-capital funding"
```

## Plan self-review

- **Spec coverage:** Task 1 covers persistent policy and safe compatibility; Task 2 covers analytical cost and read models; Task 3 covers direct allocation, capacity, REST/MCP, audit, and concurrency; Tasks 4–5 cover source management and wizard UX; Task 6 covers isolation, cash-ledger invariants, documentation, and deployment.
- **No placeholders:** The plan contains no incomplete actions; every code task has an explicit behavioral test, a failing command, a concrete implementation shape, and a verification command.
- **Type consistency:** `bankProfilePublicId` consistently identifies direct own capital; `bankLoanPublicId` consistently identifies external drawdowns; `opportunityCostRate`, `opportunityCostAccrued`, and `economicSpread` are used consistently across persistence, service, API, MCP, and UI tasks.
