# Floating Interest Rate Periods Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single floating-loan daily rate with an effective-dated, loan-scoped timeline that supports previewed future changes, exact per-date accruals, and localized management on Loan Detail.

**Architecture:** A pure Decimal/date kernel normalizes and replaces non-overlapping inclusive periods. PostgreSQL owns tenant isolation, non-overlap, persisted previews, idempotency, and immutable accrual snapshots; an application service provides list/preview/execute commands, while the existing accrual service resolves one period per business date. Loan Detail consumes server-calculated current-rate summaries and manages the timeline through explicit preview and confirmation.

**Tech Stack:** Bun, TypeScript, Elysia, Drizzle ORM, PostgreSQL 18 (`btree_gist`), Decimal.js, React 19, Vitest, Testing Library, i18next.

## Global Constraints

- All money crossing public interfaces is a two-decimal string and all financial calculations use `decimal.js`; never use JavaScript `Number` for financial values.
- Business dates use `YYYY-MM-DD` in the `Asia/Bangkok` timezone; effective and expiry dates are inclusive.
- Posted/materialized financial records are immutable; rate changes affect only dates without an existing accrual.
- Financial writes carry request/correlation ID, actor/source, idempotency key, and append-only audit history.
- Public APIs use tenant-safe UUIDs and closed schemas.
- Thai and English locale files change together; frontend formatting uses the active i18n language.
- The backend owns interest calculations; the frontend displays exact server results and does not recreate accounting logic.
- Use Bun commands and serialize disposable PostgreSQL suites with `backend/scripts/test-disposable-postgres.sh`.
- Before every commit, update `CHANGELOG.md`, stage it with the related change, and confirm the entry matches the staged set.
- Do not expose new MCP write tools in this release; existing MCP loan creation remains compatible through the initial period created by the application service.

---

## File Structure

**Create**

- `backend/src/lib/interest-rate-periods.ts` — pure date/rate validation, resolution, replacement, merging, and timeline version hashing.
- `backend/src/lib/interest-rate-periods.test.ts` — fast unit coverage for inclusive timeline behavior.
- `backend/src/services/loan-interest-rate-service.ts` — tenant-scoped list, preview, execute, presentation, audit, locking, and idempotency.
- `backend/src/services/loan-interest-rate-service.test.ts` — disposable-PostgreSQL service and concurrency coverage.
- `backend/src/modules/loan-interest-rate-routes.ts` — closed HTTP schemas and loan-scoped endpoints.
- `backend/src/modules/loan-interest-rate-routes.test.ts` — authenticated route contracts and tenant isolation.
- `backend/src/db/floating-interest-rate-periods-migration.test.ts` — additive migration contract checks.
- `backend/drizzle/0024_floating_interest_rate_periods.sql` — period/preview tables, legacy backfill, constraints, and accrual foreign key.
- `frontend/src/pages/dashboard/loans/FloatingInterestRateCard.tsx` — current summary, timeline, editor, preview, and confirmation UI.
- `frontend/tests/floating-interest-rate-card.vitest.tsx` — localized component behavior and exact display tests.

**Modify**

- `backend/src/db/schema.ts` — Drizzle tables, indexes, checks, and tenant-safe foreign keys.
- `backend/drizzle/meta/_journal.json` and generated snapshot — register migration 0024.
- `backend/src/services/loan-application-service.ts` — create the initial period, present current rate fields, and attach the first-day accrual to its period.
- `backend/src/services/loan-application-service.test.ts` — initial-period and detail projection integration tests.
- `backend/src/services/floating-interest-service.ts` — resolve and calculate each unmaterialized date independently.
- `backend/src/services/loan-payment-health-service.test.ts` — retain payment-health behavior with period-backed accruals.
- `backend/src/modules/loan-contract-routes.ts` — mount the rate router or delegate its endpoints without enlarging generic update semantics.
- `backend/src/index.ts` — register the new router if modules are registered centrally.
- `frontend/src/pages/dashboard/loans/LoanDetail.tsx` — declare the exact floating-interest projection and render the new card.
- `frontend/src/locales/en.json` and `frontend/src/locales/th.json` — matching timeline labels, explanations, warnings, and actions.
- `README.md` — document effective-dated floating interest and immutable accrued dates.
- `CHANGELOG.md` — maintain one consolidated v0.3.9 feature bullet as tasks land.

---

### Task 1: Pure Effective-Dated Timeline Kernel

**Files:**
- Create: `backend/src/lib/interest-rate-periods.ts`
- Create: `backend/src/lib/interest-rate-periods.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces: `RateType`, `RatePeriodValue`, `RatePeriodInput`, `normalizeRatePeriodInput(input)`, `resolveRatePeriod(periods, date)`, `replaceRateRange(periods, input)`, and `timelineVersion(periods)`.
- `RatePeriodValue` is `{ publicId: string; effectiveDate: string; expiryDate: string | null; rateType: "percent" | "per_thousand"; rate: string }`.
- `replaceRateRange` returns `{ timeline: RatePeriodValue[]; supersededPublicIds: string[] }` and accepts `newPublicId` in its input so it remains deterministic and testable.

- [ ] **Step 1: Write failing normalization and resolution tests**

```ts
import { describe, expect, test } from "bun:test";
import { normalizeRatePeriodInput, resolveRatePeriod } from "./interest-rate-periods";

describe("interest rate periods", () => {
    test("normalizes an inclusive period and resolves both boundary dates", () => {
        const period = normalizeRatePeriodInput({
            effectiveDate: "2026-09-01", expiryDate: "2026-09-30",
            rateType: "per_thousand", rate: "18",
        }, "period-new");
        expect(period.rate).toBe("18.0000");
        expect(resolveRatePeriod([period], "2026-09-01")?.publicId).toBe("period-new");
        expect(resolveRatePeriod([period], "2026-09-30")?.publicId).toBe("period-new");
        expect(resolveRatePeriod([period], "2026-10-01")).toBeNull();
    });

    test("rejects invalid dates, reversed ranges, unsupported types, and non-positive rates", () => {
        expect(() => normalizeRatePeriodInput({ effectiveDate: "2026-02-30", expiryDate: null, rateType: "percent", rate: "1" }, "x")).toThrow("invalid");
        expect(() => normalizeRatePeriodInput({ effectiveDate: "2026-09-02", expiryDate: "2026-09-01", rateType: "percent", rate: "1" }, "x")).toThrow("expiry");
        expect(() => normalizeRatePeriodInput({ effectiveDate: "2026-09-01", expiryDate: null, rateType: "percent", rate: "0" }, "x")).toThrow("positive");
    });
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `cd backend && bun test src/lib/interest-rate-periods.test.ts`

Expected: FAIL because `./interest-rate-periods` does not exist.

- [ ] **Step 3: Implement strict date/rate normalization and inclusive resolution**

Use UTC calendar helpers (`previousDate`, `nextDate`) only for `YYYY-MM-DD` arithmetic, normalize rates with `new Decimal(rate).toFixed(4)`, reject decimal precision over four places, sort by `effectiveDate`, and never parse rates through `Number`.

```ts
export type RateType = "percent" | "per_thousand";
export type RatePeriodInput = { effectiveDate: string; expiryDate: string | null; rateType: RateType; rate: string };
export type RatePeriodValue = RatePeriodInput & { publicId: string };

export function resolveRatePeriod(periods: RatePeriodValue[], date: string): RatePeriodValue | null {
    assertBusinessDate(date);
    return periods.find((period) => period.effectiveDate <= date && (period.expiryDate === null || date <= period.expiryDate)) ?? null;
}
```

- [ ] **Step 4: Run the focused test and confirm GREEN**

Run: `cd backend && bun test src/lib/interest-rate-periods.test.ts`

Expected: PASS.

- [ ] **Step 5: Write failing replacement tests**

Add separate tests proving: insertion into an open-ended period yields left/new/right periods; an open-ended replacement removes the right tail; replacement across multiple periods supersedes each covered ID; identical adjacent values merge; output never overlaps; and `timelineVersion` is stable across input ordering but changes with dates/type/rate.

```ts
test("splits an open-ended period around a bounded replacement", () => {
    const existing = [{ publicId: "old", effectiveDate: "2026-08-01", expiryDate: null, rateType: "per_thousand" as const, rate: "15.0000" }];
    expect(replaceRateRange(existing, {
        newPublicId: "new", effectiveDate: "2026-09-01", expiryDate: "2026-09-30",
        rateType: "per_thousand", rate: "18",
    }).timeline).toEqual([
        { ...existing[0], expiryDate: "2026-08-31" },
        { publicId: "new", effectiveDate: "2026-09-01", expiryDate: "2026-09-30", rateType: "per_thousand", rate: "18.0000" },
        { ...existing[0], publicId: "old:tail", effectiveDate: "2026-10-01" },
    ]);
});
```

- [ ] **Step 6: Run replacement tests and confirm RED**

Run: `cd backend && bun test src/lib/interest-rate-periods.test.ts`

Expected: FAIL because replacement/version functions are missing.

- [ ] **Step 7: Implement minimal replacement, merge, and SHA-256 version logic**

Split by inclusive boundaries, derive deterministic tail IDs as `${source.publicId}:tail` only in the pure projection, merge only adjacent periods whose type/rate match and whose boundary dates touch, and hash a canonical JSON representation with `Bun.CryptoHasher("sha256")`.

- [ ] **Step 8: Run kernel tests and typecheck**

Run: `cd backend && bun test src/lib/interest-rate-periods.test.ts && bun run typecheck`

Expected: PASS with no warnings.

- [ ] **Step 9: Update changelog and commit**

Update the v0.3.9 `### Added` feature bullet to mention the tested effective-dated timeline kernel, then run:

```bash
git add CHANGELOG.md backend/src/lib/interest-rate-periods.ts backend/src/lib/interest-rate-periods.test.ts
git diff --cached --check
git commit -m "feat: add floating rate timeline kernel"
```

---

### Task 2: PostgreSQL Period, Preview, and Accrual Schema

**Files:**
- Create: `backend/src/db/floating-interest-rate-periods-migration.test.ts`
- Create: `backend/drizzle/0024_floating_interest_rate_periods.sql`
- Modify: `backend/src/db/schema.ts`
- Modify: `backend/drizzle/meta/_journal.json`
- Modify: `backend/drizzle/meta/0024_snapshot.json`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces Drizzle exports `loanInterestRatePeriods` and `loanInterestRatePreviews`.
- Adds `loanInterestAccruals.interestRatePeriodId: number | null`.
- Preview rows store `publicId`, tenant/loan/actor IDs, canonical request JSON, request hash, before/after timeline JSON, timeline version, status, idempotency key, `expiresAt`, and timestamps.

- [ ] **Step 1: Write the failing migration contract test**

Read `0024_floating_interest_rate_periods.sql` and `_journal.json`; assert the migration creates `btree_gist`, both tables, positive-rate/type/date checks, tenant-safe foreign keys, an exclusion constraint using `daterange(effective_date, expiry_date, '[]')`, preview idempotency uniqueness, the nullable accrual FK, and a legacy backfill from floating loans.

Also add a disposable integration test that attempts two overlapping ranges for one loan and expects PostgreSQL error `23P01`, while identical dates on different loans/tenants succeed.

- [ ] **Step 2: Run the test and confirm RED**

Run: `cd backend && bun test src/db/floating-interest-rate-periods-migration.test.ts`

Expected: FAIL because migration 0024 and schema exports are absent.

- [ ] **Step 3: Add Drizzle schema definitions**

Define exact column names from the design. Use `numeric("rate")`, `date`, UUIDv7 public IDs, tenant-safe composite foreign keys, and these checks:

```ts
check("loan_interest_rate_periods_rate_positive_check", sql`${table.rate} > 0`),
check("loan_interest_rate_periods_rate_type_check", sql`${table.rateType} IN ('percent', 'per_thousand')`),
check("loan_interest_rate_periods_date_order_check", sql`${table.expiryDate} IS NULL OR ${table.expiryDate} >= ${table.effectiveDate}`),
```

Type preview JSON columns as `RatePeriodInput`/presented timeline arrays without using `Record<string, any>`.

- [ ] **Step 4: Generate migration artifacts, then edit the generated SQL additively**

Run: `cd backend && bun run generate`

Confirm it chooses migration number `0024`. Add `CREATE EXTENSION IF NOT EXISTS btree_gist`, the exclusion constraint, and this idempotent legacy backfill:

```sql
INSERT INTO loan_interest_rate_periods (tenant_id, loan_id, effective_date, expiry_date, rate_type, rate, created_at)
SELECT tenant_id, id, interest_start_date, NULL, daily_interest_mode, daily_interest_rate, NOW()
FROM loans
WHERE repayment_type = 'floating'
  AND interest_start_date IS NOT NULL
  AND daily_interest_mode IN ('percent', 'per_thousand')
  AND daily_interest_rate > 0
  AND NOT EXISTS (
      SELECT 1 FROM loan_interest_rate_periods p
      WHERE p.tenant_id = loans.tenant_id AND p.loan_id = loans.id
  );
```

- [ ] **Step 5: Run migration and schema tests against disposable PostgreSQL**

Run: `backend/scripts/test-disposable-postgres.sh src/db/floating-interest-rate-periods-migration.test.ts src/db/floating-daily-interest-migration.test.ts`

Expected: PASS; overlapping same-loan ranges fail at the database boundary.

- [ ] **Step 6: Run backend typecheck**

Run: `cd backend && bun run typecheck`

Expected: PASS.

- [ ] **Step 7: Update changelog and commit**

Update the consolidated v0.3.9 bullet to include the additive schema, legacy backfill, overlap protection, and accrual linkage. Then stage every generated migration artifact and commit:

```bash
git add CHANGELOG.md backend/src/db/schema.ts backend/src/db/floating-interest-rate-periods-migration.test.ts backend/drizzle/0024_floating_interest_rate_periods.sql backend/drizzle/meta/_journal.json backend/drizzle/meta/0024_snapshot.json
git diff --cached --check
git commit -m "feat: persist floating interest rate periods"
```

---

### Task 3: Timeline List, Preview, and Idempotent Execute Service

**Files:**
- Create: `backend/src/services/loan-interest-rate-service.ts`
- Create: `backend/src/services/loan-interest-rate-service.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: timeline kernel, `CommandContext`, period/preview/audit tables, `findAccessibleLoanByPublicId`, `calculateDailyInterest`.
- Produces:

```ts
export type RateChangeInput = { effectiveDate: string; expiryDate: string | null; rateType: RateType; rate: string };
export async function listLoanInterestRates(ctx: CommandContext, loanPublicId: string, asOf?: Date): Promise<LoanRateTimeline>;
export async function previewLoanInterestRateChange(ctx: CommandContext, loanPublicId: string, input: RateChangeInput): Promise<RateChangePreview>;
export async function executeLoanInterestRateChange(ctx: CommandContext, loanPublicId: string, previewPublicId: string): Promise<RateChangeExecution>;
```

`LoanRateTimeline` includes exact presented periods, `currentPeriod`, `dailyInterestAtCurrentPrincipal`, `nextChange`, `earliestEditableDate`, and `timelineVersion`. `RateChangeExecution` includes the resulting timeline, `auditPublicId`, and `correlationId`.

- [ ] **Step 1: Write failing list and preview service tests**

Seed two tenants and floating loans. Assert list is chronological and tenant-scoped; the Bangkok `asOf` date selects the current period; the daily amount is exact for a principal beyond `Number.MAX_SAFE_INTEGER`; and preview returns before/after split timelines plus a 15-minute `expiresAt` without writing periods.

Assert a requested range touching an existing accrual fails with `RATE_PERIOD_ACCRUED_DATE_CONFLICT` and exposes the earliest editable date as the calendar day after the latest accrual.

- [ ] **Step 2: Run service tests and confirm RED**

Run: `backend/scripts/test-disposable-postgres.sh src/services/loan-interest-rate-service.test.ts`

Expected: FAIL because the service does not exist.

- [ ] **Step 3: Implement list and preview minimally**

Use one tenant-filtered period query ordered by effective date. Calculate summary amounts only with `calculateDailyInterest(serializeMoney(outstandingPrincipal), policy)`. Preview stores the canonical request, request hash, before/after projection, current timeline version, actor, and `expiresAt = now + 15 minutes`; it does not mutate live periods.

Use `DomainError` codes `INVALID_RATE_PERIOD`, `RATE_PERIOD_ACCRUED_DATE_CONFLICT`, `RATE_PERIOD_MISSING_COVERAGE`, and `LOAN_NOT_FOUND` with safe public details.

- [ ] **Step 4: Run focused tests and confirm GREEN for list/preview**

Run: `backend/scripts/test-disposable-postgres.sh src/services/loan-interest-rate-service.test.ts`

Expected: list/preview tests PASS.

- [ ] **Step 5: Write failing execute, stale, audit, and concurrency tests**

Cover: missing idempotency key; expired preview; actor/tenant mismatch; changed timeline version; exact replacement result; idempotent replay with the same key; conflict when a key is reused for a different preview; one audit row containing before/after/request data and context; and two concurrent executes producing a single non-overlapping result.

- [ ] **Step 6: Run execute tests and confirm RED**

Run: `backend/scripts/test-disposable-postgres.sh src/services/loan-interest-rate-service.test.ts`

Expected: FAIL because execute is missing.

- [ ] **Step 7: Implement transactional execute**

Require a trimmed idempotency key. Inside one transaction acquire `pg_advisory_xact_lock(hashtextextended('loan-rate-change:' || tenant || ':' || loanPublicId, 0))`, lock the preview, re-read periods, compare the timeline version, recheck accrued dates, replace live period rows, and mark the preview executed. Preserve original rows in the audit payload before updating/deleting them; never change accrual rows.

Map projected tail IDs to newly generated database public IDs instead of persisting `:tail` identifiers. Catch PostgreSQL `23P01` and surface `RATE_PERIOD_OVERLAP_CONFLICT`.

- [ ] **Step 8: Run service suite and backend typecheck**

Run: `backend/scripts/test-disposable-postgres.sh src/services/loan-interest-rate-service.test.ts && cd backend && bun run typecheck`

Expected: PASS, including concurrency and exact-money assertions.

- [ ] **Step 9: Update changelog and commit**

Update the consolidated feature bullet with preview/execute, idempotency, audit, and accrued-date protection, then commit:

```bash
git add CHANGELOG.md backend/src/services/loan-interest-rate-service.ts backend/src/services/loan-interest-rate-service.test.ts
git diff --cached --check
git commit -m "feat: manage floating interest rate timelines"
```

---

### Task 4: Period-Backed Origination and Per-Date Accrual

**Files:**
- Modify: `backend/src/services/loan-application-service.ts`
- Modify: `backend/src/services/loan-application-service.test.ts`
- Modify: `backend/src/services/floating-interest-service.ts`
- Modify: `backend/src/services/loan-payment-health-service.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: `loanInterestRatePeriods`, `resolveRatePeriod`, and existing `calculateDailyInterest`.
- Produces: new floating drafts persist an initial open-ended period; detail presentation delegates rate summary to Task 3; each accrual stores `interestRatePeriodId` plus snapshot type/rate.

- [ ] **Step 1: Write failing origination tests**

Extend `loan-application-service.test.ts` to assert creating a floating draft writes exactly one open-ended period beginning on `interestStartDate`, activating a first-day-deduct loan links its paid first-day accrual to that period, and repeated activation creates neither duplicate period nor duplicate accrual.

- [ ] **Step 2: Run origination tests and confirm RED**

Run: `backend/scripts/test-disposable-postgres.sh src/services/loan-application-service.test.ts`

Expected: FAIL because drafts still write only the legacy loan columns.

- [ ] **Step 3: Persist and present the initial period**

Within the existing draft transaction insert the normalized period after the loan row, retaining legacy columns only for compatibility. During first-day activation resolve the period and set `interestRatePeriodId`. Extend `presentLoan` with the server-produced `floatingInterestRateTimeline` from the list service without making frontend calculations.

- [ ] **Step 4: Run origination tests and confirm GREEN**

Run: `backend/scripts/test-disposable-postgres.sh src/services/loan-application-service.test.ts`

Expected: PASS.

- [ ] **Step 5: Write failing boundary-accrual tests**

Add service tests with 15-per-thousand through August 31 and 18-per-thousand from September 1. Accrue through September 2 and assert each date snapshots its own period ID/rate and exact amount. Add a principal-changing payment between dates and prove each date uses its correct opening outstanding principal. Assert a coverage gap throws `RATE_PERIOD_MISSING_COVERAGE` and inserts no partial batch.

- [ ] **Step 6: Run accrual tests and confirm RED**

Run: `backend/scripts/test-disposable-postgres.sh src/services/loan-payment-health-service.test.ts`

Expected: FAIL because one legacy policy/amount is reused for all missing dates.

- [ ] **Step 7: Resolve one period and amount per accrual date**

Fetch all applicable periods once, enumerate unmaterialized dates, resolve each date, and build each insert row independently. Perform coverage validation before inserting any row. Snapshot `interestRatePeriodId`, `rateMode`, `rate`, opening principal, and exact two-decimal interest. Preserve existing `onConflictDoNothing` idempotency.

- [ ] **Step 8: Run financial integration suites and typecheck**

Run:

```bash
backend/scripts/test-disposable-postgres.sh \
  src/services/loan-application-service.test.ts \
  src/services/loan-payment-health-service.test.ts \
  src/services/dashboard-borrower-health-service.test.ts
cd backend && bun run typecheck
```

Expected: PASS; no skipped database tests.

- [ ] **Step 9: Update changelog and commit**

Update the feature bullet with period-backed origination and per-date accrual snapshots, then commit all files:

```bash
git add CHANGELOG.md backend/src/services/loan-application-service.ts backend/src/services/loan-application-service.test.ts backend/src/services/floating-interest-service.ts backend/src/services/loan-payment-health-service.test.ts
git diff --cached --check
git commit -m "feat: accrue floating interest by rate period"
```

---

### Task 5: Closed REST Contracts

**Files:**
- Create: `backend/src/modules/loan-interest-rate-routes.ts`
- Create: `backend/src/modules/loan-interest-rate-routes.test.ts`
- Modify: `backend/src/modules/loan-contract-routes.ts`
- Modify: `backend/src/index.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes Task 3 service functions and `loanCommandContext`.
- Produces:
  - `GET /loans/:id/interest-rates`
  - `POST /loans/:id/interest-rates/preview`
  - `POST /loans/:id/interest-rates/execute` with `{ previewPublicId: string }`
- Execute requires `Idempotency-Key`; all routes use public loan/preview UUIDs.

- [ ] **Step 1: Write failing authenticated route tests**

Exercise routes through the Elysia app. Assert exact strings and closed response shapes, draft/active/closed loans can preview, cross-tenant IDs return 404, malformed types/dates return 400, execute without `Idempotency-Key` returns `IDEMPOTENCY_KEY_REQUIRED`, stale preview returns 409, and successful execute includes audit/correlation IDs.

- [ ] **Step 2: Run route tests and confirm RED**

Run: `backend/scripts/test-disposable-postgres.sh src/modules/loan-interest-rate-routes.test.ts`

Expected: FAIL with route not found.

- [ ] **Step 3: Implement route schemas and registration**

Use Elysia `t.Object` with no additional fields and the existing `floatingDailyInterest` literals for the type union. Build command context from headers, delegate all business rules to the service, call `invalidateTenantCache` after execute, and translate `DomainError` through `loanDomainFailure`.

Do not add interest-period fields to generic `PUT /loans/:id`; preview/execute remains the only timeline mutation path.

- [ ] **Step 4: Run route/service suites and typecheck**

Run: `backend/scripts/test-disposable-postgres.sh src/modules/loan-interest-rate-routes.test.ts src/services/loan-interest-rate-service.test.ts && cd backend && bun run typecheck`

Expected: PASS.

- [ ] **Step 5: Run MCP compatibility tests unchanged**

Run: `cd backend && bun test src/mcp/server.test.ts src/mcp/default.test.ts`

Expected: PASS without adding rate-management MCP tools or changing its frozen outputs.

- [ ] **Step 6: Update changelog and commit**

Update the feature bullet with the authenticated closed REST contracts, then commit:

```bash
git add CHANGELOG.md backend/src/modules/loan-interest-rate-routes.ts backend/src/modules/loan-interest-rate-routes.test.ts backend/src/modules/loan-contract-routes.ts backend/src/index.ts
git diff --cached --check
git commit -m "feat: expose loan interest rate timeline APIs"
```

---

### Task 6: Localized Loan Detail Timeline Management

**Files:**
- Create: `frontend/src/pages/dashboard/loans/FloatingInterestRateCard.tsx`
- Create: `frontend/tests/floating-interest-rate-card.vitest.tsx`
- Modify: `frontend/src/pages/dashboard/loans/LoanDetail.tsx`
- Modify: `frontend/src/locales/en.json`
- Modify: `frontend/src/locales/th.json`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes `floatingInterestRateTimeline` from loan detail plus the three endpoints from Task 5.
- Produces `FloatingInterestRateCard({ loanPublicId, timeline, onTimelineChanged })`.
- Money stays an exact string through `formatMoneyExact`; rates use a string formatter that adds locale grouping without numeric coercion.

- [ ] **Step 1: Write failing current-rate display tests**

Mock the loan-detail responses and render `LoanDetail`. In Thai, assert the card shows `ดอกเบี้ยต่อวัน`, `15.0000 บาทต่อทุก ฿1,000`, the exact server amount for a value beyond JS safe integer, inclusive date range, and next scheduled change. In English, assert no Thai labels appear. Assert non-floating loans do not render the card.

- [ ] **Step 2: Run display tests and confirm RED**

Run: `cd frontend && bun test tests/floating-interest-rate-card.vitest.tsx`

Expected: FAIL because the card is absent.

- [ ] **Step 3: Implement the read-only card and exact types**

Extend `LoanDetailData` with the exact timeline response type, render the card only for floating loans, display `-` for a deliberate coverage gap, and show the next change only when present. Reuse shared Card/Button/Dialog primitives and active-language formatting.

- [ ] **Step 4: Run display tests and confirm GREEN**

Run: `cd frontend && bun test tests/floating-interest-rate-card.vitest.tsx`

Expected: PASS.

- [ ] **Step 5: Write failing management-flow tests**

Using `userEvent`, test: opening management from active and closed loans; entering effective date, optional expiry, type, and rate; preview rendering automatic left/new/right splits from the server; confirmation sending `previewPublicId` with a generated `Idempotency-Key`; accrued-date conflict showing earliest editable date while retaining fields; stale preview refreshing the timeline; and cancel never executing.

- [ ] **Step 6: Run management tests and confirm RED**

Run: `cd frontend && bun test tests/floating-interest-rate-card.vitest.tsx`

Expected: FAIL because management controls are absent.

- [ ] **Step 7: Implement preview and explicit confirmation UI**

Keep form values as strings. POST input only to preview; render server before/after periods and warnings; require a second confirm action before execute. Generate an idempotency UUID once per confirmation attempt, disable controls in flight, retain values for recoverable failures, and call `onTimelineChanged` with the exact execution response.

Add matching locale trees under `loanDetail.floatingInterest` in both JSON files, including rate types, open-ended date, current/next labels, accrued lock explanation, preview language, stale/conflict messages, and actions.

- [ ] **Step 8: Run frontend focused tests, lint, and build**

Run:

```bash
cd frontend
bun test tests/floating-interest-rate-card.vitest.tsx tests/loan-detail-activation.vitest.tsx tests/loan-disbursement-flow.vitest.tsx
bun run lint
bun run build
```

Expected: all PASS; TypeScript build emits no financial `Number(...)` conversion in the new component.

- [ ] **Step 9: Update changelog and commit**

Update the consolidated feature bullet with localized Loan Detail display and preview/confirmation management, then commit:

```bash
git add CHANGELOG.md frontend/src/pages/dashboard/loans/FloatingInterestRateCard.tsx frontend/src/pages/dashboard/loans/LoanDetail.tsx frontend/src/locales/en.json frontend/src/locales/th.json frontend/tests/floating-interest-rate-card.vitest.tsx
git diff --cached --check
git commit -m "feat: manage floating rates from loan detail"
```

---

### Task 7: Documentation and Full Verification

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes the completed database, service, API, and UI behavior.
- Produces operator documentation and the final verified v0.3.9 release notes.

- [ ] **Step 1: Update README workflow documentation**

Document that floating loans use inclusive effective-dated percent/per-thousand periods, future periods can be scheduled from Loan Detail regardless of loan status, preview automatically splits existing ranges, accrued days remain immutable, and missing rate coverage blocks accrual rather than assuming zero.

- [ ] **Step 2: Consolidate the changelog entry**

Under `v0.3.9 / Added`, ensure one concise feature bullet accurately covers persisted effective-dated periods, previewed replacement, per-date immutable accrual snapshots, REST endpoints, and localized Loan Detail management. Remove redundant incremental wording left by earlier task commits.

- [ ] **Step 3: Run the full backend disposable suite**

Run: `backend/scripts/test-disposable-postgres.sh`

Expected: PASS with `--max-concurrency=1`; no database-backed test is skipped.

- [ ] **Step 4: Run backend typecheck and MCP/plugin validation**

Run:

```bash
cd backend
bun run typecheck
bun test src/mcp/default.test.ts src/mcp/server.test.ts
cd ../plugins/creditsync
bun test
bun run validate
```

If the plugin directory exposes different scripts, run the checked-in equivalents listed by its `package.json`; do not modify the frozen plugin contract merely to satisfy this feature.

Expected: PASS.

- [ ] **Step 5: Run full frontend verification**

Run:

```bash
cd frontend
bun test
bun run lint
bun run build
```

Expected: PASS.

- [ ] **Step 6: Inspect the staged financial diff**

Run:

```bash
git diff --check
git status --short
rg -n "Number\(|parseFloat\(|parseInt\(" backend/src/lib/interest-rate-periods.ts backend/src/services/loan-interest-rate-service.ts backend/src/services/floating-interest-service.ts frontend/src/pages/dashboard/loans/FloatingInterestRateCard.tsx
```

Expected: no money/rate conversions through JavaScript numbers; any date-only integer parsing is reviewed and unrelated to financial values.

- [ ] **Step 7: Commit documentation**

```bash
git add README.md CHANGELOG.md
git diff --cached --check
git commit -m "docs: document floating rate timelines"
```

- [ ] **Step 8: Review commit range and clean worktree**

Run: `git log --oneline --decorate -8 && git status --short`

Expected: the task commits are present and the worktree is clean.

