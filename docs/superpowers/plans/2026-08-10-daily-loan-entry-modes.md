# Daily Loan Entry Modes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator create a fixed daily loan from either a proposed daily payment or a flat daily-interest expression, with one calculation and schedule used by Web, REST, and MCP.

**Architecture:** Add a pure Decimal calculation module that normalizes daily entry input into existing compatible daily loan terms plus an explanatory calculation summary. Persist the selected entry metadata on loans, but keep `totalInstallments`, `installmentAmount`, and generated schedules as the accounting source of truth. Application service calls the kernel; HTTP, MCP, and the wizard only transport inputs and display the returned result.

**Tech Stack:** Bun, TypeScript, Elysia, Drizzle/PostgreSQL, decimal.js, Zod, React, i18next, Vitest/Bun test.

## Global Constraints

- Apply only to `repaymentType: "daily"`; floating daily-interest loans are unchanged.
- One month equals exactly 30 daily instalments.
- Use `decimal.js` and decimal strings; do not use JavaScript floating point for money or rates.
- All money is rounded half-up to two decimals; reference rates use four decimal places.
- Existing daily-loan REST/MCP clients without the new optional input remain compatible.
- Active loan terms remain immutable; draft edits may change the new terms.
- Update `frontend/src/locales/en.json` and `frontend/src/locales/th.json` together for all user-facing copy.
- Every commit updates root `CHANGELOG.md`; user-facing commits update `README.md` when setup or workflow documentation changes.

---

## File Structure

- Create `backend/src/lib/daily-loan-entry.ts`: pure validation and Decimal calculations for the two entry modes.
- Create `backend/src/lib/daily-loan-entry.test.ts`: example, rounding, conversion, and invalid-input tests.
- Create `backend/drizzle/0018_daily_loan_entry_metadata.sql`: additive nullable metadata columns and checks.
- Modify `backend/src/db/schema.ts`: declare the new loan metadata columns.
- Modify `backend/src/lib/calculator.ts`: accept normalized daily entry input and calculate schedules from its derived compatible terms.
- Modify `backend/src/services/loan-application-service.ts`: normalize once for preview/draft/update, persist metadata, and present the calculation result.
- Modify `backend/src/modules/loans.ts` and `backend/src/mcp/server.ts`: add optional typed REST/MCP contracts and output summary.
- Modify `frontend/src/lib/workflow-model.ts` and tests: build daily-entry request data without client-side financial calculation.
- Modify `frontend/src/pages/dashboard/loans/LoanWizard.tsx`, `frontend/src/locales/en.json`, and `frontend/src/locales/th.json`: add the daily form controls and read-only calculation card.
- Modify MCP, service, frontend tests and `README.md`/`CHANGELOG.md`: prove compatibility and document the workflow.

### Task 1: Daily-entry calculation kernel

**Files:**
- Create: `backend/src/lib/daily-loan-entry.ts`
- Create: `backend/src/lib/daily-loan-entry.test.ts`
- Modify: `backend/src/lib/calculator.ts`
- Modify: `backend/src/lib/public-loan-terms.test.ts`

**Interfaces:**
- Consumes: `parseMoney` and `serializeMoney` from `backend/src/lib/money.ts`.
- Produces: `normalizeDailyLoanEntry(input): NormalizedDailyLoanEntry` and `DailyLoanEntryInput` for service and API layers.

- [ ] **Step 1: Write failing kernel tests for borrower-proposed daily payment**

```ts
import { describe, expect, test } from "bun:test";
import { normalizeDailyLoanEntry } from "./daily-loan-entry";

test("derives flat daily interest from a proposed payment", () => {
  expect(normalizeDailyLoanEntry({
    principal: "2500.00", durationUnit: "days", durationValue: 15,
    entryMode: "daily_payment", dailyPayment: "200.00",
  })).toMatchObject({
    totalInstallments: 15, installmentAmount: "200.00",
    totalInterest: "500.00", dailyInterest: "33.33",
    flatDailyRatePercent: "1.3333", flatMonthlyRatePercent: "40.0000",
    flatAnnualRatePercent: "486.6667",
  });
});
```

- [ ] **Step 2: Add failing tests for months, each interest expression, and invalid totals**

```ts
test("uses thirty instalments per selected month", () => {
  expect(normalizeDailyLoanEntry({ principal: "10000.00", durationUnit: "months", durationValue: 1, entryMode: "daily_payment", dailyPayment: "500.00" }).totalInstallments).toBe(30);
});

test("derives a payment from 1.5 percent daily interest", () => {
  expect(normalizeDailyLoanEntry({ principal: "2000.00", durationUnit: "days", durationValue: 10, entryMode: "daily_interest", interestInput: { mode: "percent", value: "1.5000" } })).toMatchObject({ dailyInterest: "30.00", installmentAmount: "230.00", totalInterest: "300.00" });
});

test("rejects a proposed repayment below principal", () => {
  expect(() => normalizeDailyLoanEntry({ principal: "2500.00", durationUnit: "days", durationValue: 15, entryMode: "daily_payment", dailyPayment: "100.00" })).toThrow("Installment total cannot be less than principal");
});
```

- [ ] **Step 3: Run kernel tests to verify they fail**

Run: `cd backend && bun test src/lib/daily-loan-entry.test.ts`

Expected: FAIL because `daily-loan-entry.ts` does not exist.

- [ ] **Step 4: Implement the normalized input/result types and Decimal formulas**

```ts
export type DailyLoanEntryInput = {
  durationUnit: "days" | "months";
  durationValue: number;
  entryMode: "daily_payment" | "daily_interest";
  dailyPayment?: string;
  interestInput?: { mode: "percent" | "fixed_amount" | "per_thousand"; value: string };
};

export function normalizeDailyLoanEntry(input: DailyLoanEntryInput & { principal: string }) {
  const totalInstallments = input.durationUnit === "months" ? input.durationValue * 30 : input.durationValue;
  // Validate exactly one relevant entry source, derive daily interest/payment,
  // then return all values as fixed decimal strings.
}
```

Implement `daily_payment` as payment × count minus principal; implement `percent`, `fixed_amount`, and `per_thousand` from original principal; calculate the reference rates from unrounded Decimal values then serialize to four decimal places. Return `termMonths` as `ceil(totalInstallments / 30)` solely for existing daily-loan compatibility, alongside the explicit exact count.

- [ ] **Step 5: Integrate normalized derived fields into schedule calculation**

Update `PublicLoanCalculationParams` with optional `dailyEntry`. When `repaymentType === "daily"` and `dailyEntry` is present, call `normalizeDailyLoanEntry`, override `termMonths`, `totalInstallments`, and `installmentAmount` with its derived values, and build the schedule through the existing exact-remainder allocation loop. Preserve the current behavior when `dailyEntry` is absent.

- [ ] **Step 6: Run focused kernel and schedule tests**

Run: `cd backend && bun test src/lib/daily-loan-entry.test.ts src/lib/public-loan-schedule.test.ts src/lib/money.test.ts`

Expected: PASS; the final schedule row makes principal, interest, and total repayment reconcile exactly.

- [ ] **Step 7: Commit the kernel**

```bash
git add backend/src/lib/daily-loan-entry.ts backend/src/lib/daily-loan-entry.test.ts backend/src/lib/calculator.ts backend/src/lib/public-loan-terms.test.ts CHANGELOG.md
git commit -m "feat: calculate daily loan entry modes"
```

### Task 2: Persist daily entry metadata and service behavior

**Files:**
- Create: `backend/drizzle/0018_daily_loan_entry_metadata.sql`
- Modify: `backend/drizzle/meta/_journal.json`
- Modify: `backend/src/db/schema.ts`
- Modify: `backend/src/services/loan-application-service.ts`
- Modify: `backend/src/services/loan-application-service.test.ts`

**Interfaces:**
- Consumes: `DailyLoanEntryInput` and `normalizeDailyLoanEntry` from Task 1.
- Produces: optional `dailyEntry` command input, persisted metadata, and `dailyLoanCalculation` in preview/presented loan output.

- [ ] **Step 1: Write failing service tests for preview, draft persistence, and compatibility**

```ts
expect((await previewLoan(ctx, {
  borrowerPublicId, principal: "2500.00", interestRate: "0.00", termMonths: 1,
  repaymentType: "daily", startDate: "2026-08-10",
  dailyEntry: { durationUnit: "days", durationValue: 15, entryMode: "daily_payment", dailyPayment: "200.00" },
})).dailyLoanCalculation).toMatchObject({ totalInterest: "500.00", totalInstallments: 15 });

expect(created.dailyEntry).toMatchObject({ durationUnit: "days", durationValue: 15, entryMode: "daily_payment" });
expect(legacyDailyLoan.dailyEntry).toBeNull();
```

- [ ] **Step 2: Run the service test to verify it fails**

Run: `cd backend && bun test src/services/loan-application-service.test.ts`

Expected: FAIL because `dailyEntry` and `dailyLoanCalculation` are not exposed.

- [ ] **Step 3: Create additive migration and schema definitions**

Add nullable columns to `loans`: `daily_term_unit`, `daily_term_value`, `daily_entry_mode`, `daily_interest_input_mode`, `daily_interest_input_value`, and `daily_flat_rate_percent`. Add check constraints so populated term value is positive, populated unit is `days|months`, populated entry mode is `daily_payment|daily_interest`, and interest input mode is only populated with a daily-interest entry. Do not backfill existing daily loans.

```sql
ALTER TABLE loans ADD COLUMN daily_term_unit text;
ALTER TABLE loans ADD COLUMN daily_term_value integer;
ALTER TABLE loans ADD COLUMN daily_entry_mode text;
ALTER TABLE loans ADD COLUMN daily_interest_input_mode text;
ALTER TABLE loans ADD COLUMN daily_interest_input_value numeric;
ALTER TABLE loans ADD COLUMN daily_flat_rate_percent numeric;
```

Declare the exact columns in `schema.ts` and append migration `0018` to the Drizzle journal.

- [ ] **Step 4: Normalize once in the application service and persist atomically**

Extend `PublicLoanCalculationParams`/service command input with optional `dailyEntry`. In `previewLoan`, validate daily entry only for Daily and return the Task 1 summary. In create/update draft, derive the compatible fields server-side and write both those fields and metadata in the same insert/update. Reject daily entry for non-daily repayment and reject a daily loan’s partial metadata. `presentLoan` returns `dailyEntry: null` for legacy rows and a `dailyLoanCalculation` when metadata is present. Activation uses the already persisted derived schedule terms unchanged.

- [ ] **Step 5: Run migration and service tests**

Run: `cd backend && bun test src/services/loan-application-service.test.ts && bun run typecheck`

Expected: PASS. In a disposable database, run `bunx drizzle-kit migrate` and verify existing loans retain null metadata and unchanged schedule totals.

- [ ] **Step 6: Commit persistence and service changes**

```bash
git add backend/drizzle/0018_daily_loan_entry_metadata.sql backend/drizzle/meta/_journal.json backend/src/db/schema.ts backend/src/services/loan-application-service.ts backend/src/services/loan-application-service.test.ts CHANGELOG.md
git commit -m "feat: persist daily loan entry terms"
```

### Task 3: REST and MCP contracts

**Files:**
- Modify: `backend/src/modules/loans.ts`
- Modify: `backend/src/mcp/server.ts`
- Modify: `backend/src/mcp/server.test.ts`
- Create: `backend/src/modules/loans.test.ts`

**Interfaces:**
- Consumes: service `dailyEntry` command input and `dailyLoanCalculation` result from Task 2.
- Produces: identical optional `dailyEntry` input for REST preview/draft/update and MCP `loan.preview`/`loan.draft`; backwards-compatible output summary.

- [ ] **Step 1: Write failing REST and MCP contract tests**

```ts
const dailyEntry = { durationUnit: "days", durationValue: 24, entryMode: "daily_payment", dailyPayment: "500.00" };
expect(await invokeMcp("loan.preview", { ...baseTerms, repaymentType: "daily", dailyEntry })).toMatchObject({ structuredContent: { dailyLoanCalculation: { totalInstallments: 24, installmentAmount: "500.00" } } });
expect((await postLoanPreview({ ...baseTerms, repaymentType: "daily", dailyEntry })).body.dailyLoanCalculation.totalInterest).toBe("2000.00");
```

- [ ] **Step 2: Run contract tests to verify they fail**

Run: `cd backend && bun test src/mcp/server.test.ts src/modules/loans.test.ts`

Expected: FAIL because schemas reject `dailyEntry`.

- [ ] **Step 3: Add matching TypeBox and Zod schemas**

Use an optional object with the same closed union in both adapters:

```ts
dailyEntry: {
  durationUnit: "days" | "months";
  durationValue: positive integer;
  entryMode: "daily_payment" | "daily_interest";
  dailyPayment?: money string;
  interestInput?: { mode: "percent" | "fixed_amount" | "per_thousand"; value: decimal string };
}
```

Do not duplicate arithmetic in either adapter. Return `dailyLoanCalculation` with money strings, four-decimal rate strings, and total instalment count in preview, draft, update, and detail outputs. Keep schema version and existing tool names because all additions are optional/backwards compatible.

- [ ] **Step 4: Run contracts and all backend checks**

Run: `cd backend && bun test && bun run typecheck`

Expected: PASS, including legacy daily request fixtures without `dailyEntry`.

- [ ] **Step 5: Commit public-contract changes**

```bash
git add backend/src/modules/loans.ts backend/src/modules/loans.test.ts backend/src/mcp/server.ts backend/src/mcp/server.test.ts CHANGELOG.md
git commit -m "feat: expose daily loan entry contracts"
```

### Task 4: Daily wizard and documentation

**Files:**
- Modify: `frontend/src/lib/workflow-model.ts`
- Modify: `frontend/tests/workflow-model.test.ts`
- Modify: `frontend/src/pages/dashboard/loans/LoanWizard.tsx`
- Modify: `frontend/src/locales/en.json`
- Modify: `frontend/src/locales/th.json`
- Modify: `README.md`

**Interfaces:**
- Consumes: optional API `dailyEntry` and server-returned `dailyLoanCalculation` from Task 3.
- Produces: a user-selected request shape without any browser-side interest calculation.

- [ ] **Step 1: Write failing workflow-model tests for request construction**

```ts
expect(buildLoanTermsInput({
  ...dailyBase, repaymentType: "daily", dailyDurationUnit: "days", dailyDurationValue: "15",
  dailyEntryMode: "daily_payment", dailyPayment: "200.00",
}).dailyEntry).toEqual({ durationUnit: "days", durationValue: 15, entryMode: "daily_payment", dailyPayment: "200.00" });

expect(() => buildLoanTermsInput({ ...dailyBase, dailyEntryMode: "daily_interest" })).toThrow("interest input");
```

- [ ] **Step 2: Run frontend workflow tests to verify they fail**

Run: `cd frontend && bun test tests/workflow-model.test.ts`

Expected: FAIL because form fields are not represented in the request model.

- [ ] **Step 3: Build the daily-only controls and calculation card**

After Daily is selected, render:

1. `วัน | เดือน` chips and a positive duration input;
2. `กำหนดยอดส่งต่อวัน | กำหนดดอกเบี้ย` chips;
3. either daily-payment input, or interest-expression chips plus its value input;
4. a read-only server-preview calculation card showing count, daily payment, total repayment, total interest, daily interest, and flat daily/monthly/annual rates.

Disable the existing annual-interest input for daily entry and send `interestRate: "0.00"` while the server derives schedule fields. Keep the preview button disabled until all fields required by the selected mode are valid. Use the server preview response as the calculation card data; never derive financial values in React. Preserve the legacy optional total-installment/installment fields only when the new daily entry is not selected.

- [ ] **Step 4: Add localized labels and helpful validation copy**

Add matching English/Thai keys for duration units, entry modes, three interest expressions, `Flat reference rate`, the six calculation-card values, and below-principal validation. Use Thai wording that explicitly says `อัตราแบบคงที่` rather than effective or reducing-balance rate.

- [ ] **Step 5: Document the operator workflow and test the UI build**

Add a short README section explaining that Daily → proposed payment infers a flat rate, while Daily → interest infers the payment; both create a fixed daily schedule. Then run:

```bash
cd frontend && bun test && bun run build
cd ../backend && bun test && bun run typecheck
```

Expected: all pass; only the existing bundle-size warning may remain.

- [ ] **Step 6: Commit wizard and documentation**

```bash
git add frontend/src/lib/workflow-model.ts frontend/tests/workflow-model.test.ts frontend/src/pages/dashboard/loans/LoanWizard.tsx frontend/src/locales/en.json frontend/src/locales/th.json README.md CHANGELOG.md
git commit -m "feat: add daily loan entry wizard modes"
```

### Task 5: Migration, end-to-end verification, and deployment

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: all completed tasks.
- Produces: verified production deployment with additive migration and documented recovery checks.

- [ ] **Step 1: Run the production-equivalent migration check before deployment**

Run: `docker compose --env-file .env.production -f docker-compose.app.yml up --build -d backend`

Expected: backend logs show `migrations applied successfully`; inspect a pre-existing daily loan and confirm its schedule totals and null metadata are unchanged.

- [ ] **Step 2: Perform manual Web and MCP smoke tests**

Verify all three cases through preview and draft without activation: `2500 / 15 days / 200`, `10000 / 24 days / 500`, and `2000 / 10 days / 1.5% daily`. Verify a legacy request still previews. Through MCP call `loan.preview` for each entry mode and compare its amount/count/rate summary with REST.

- [ ] **Step 3: Build and deploy the frontend**

Run: `docker compose --env-file .env.production -f docker-compose.app.yml up --build -d frontend`

Expected: frontend and backend containers are running on their latest images; `curl -fsS http://127.0.0.1:8088/` returns HTTP 200.

- [ ] **Step 4: Record verification and commit final documentation**

Append the exact release verification date and supported entry modes to the current `v0.3.6` changelog section. Commit only if that verification text or README changed:

```bash
git add CHANGELOG.md README.md
git commit -m "docs: verify daily loan entry deployment"
```

## Self-Review

- Spec coverage: Tasks 1–2 implement both modes, days/months conversion, exact rounding, legacy compatibility, and persistence. Task 3 provides REST/MCP parity. Task 4 provides localized Web workflow. Task 5 covers migration, exact examples, and production verification.
- Placeholder scan: no TODO/TBD or unnamed test work remains; every task specifies files, interfaces, commands, and expected result.
- Type consistency: `DailyLoanEntryInput`, `dailyEntry`, `dailyLoanCalculation`, `durationUnit`, `durationValue`, `entryMode`, `dailyPayment`, and `interestInput` are defined in Task 1 and reused unchanged in Tasks 2–4.
