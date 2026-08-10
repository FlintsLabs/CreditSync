# Loan-list Payment-health Indicators Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show an immediately recognizable, localized overdue or due-now payment indicator on every affected loan card, including next-day overdue behavior for floating daily-interest loans.

**Architecture:** Add a pure Decimal-based payment-health kernel, then a tenant-scoped service that loads schedules or materializes floating accruals and returns one additive `paymentHealth` DTO through the existing loan-list endpoint. Render that DTO through a focused frontend component so the list performs one request and the detail schedule uses the same visual language without calculating financial state in the browser.

**Tech Stack:** Bun, TypeScript, Elysia, Drizzle ORM, PostgreSQL, decimal.js, React, React Router, react-i18next, Tailwind CSS, lucide-react, Vitest, Testing Library.

## Global Constraints

- Treat `Asia/Bangkok` as the business timezone; timestamps remain ISO 8601 and due/accrual dates remain `YYYY-MM-DD`.
- Public money values remain two-decimal decimal strings and every new backend money calculation uses `decimal.js`; never use JavaScript `Number` for financial calculations, comparisons, aggregation, or formatting.
- Loan lifecycle status and payment health are separate. An `active` loan can have `paymentHealth.status === "overdue"`.
- Scheduled loans use the existing grace-period and late-fee terms; floating interest dated today is due now and becomes overdue only on the following Bangkok business date.
- Floating principal alone is not overdue. Only an explicit unpaid dated accrual contributes to floating payment health.
- Preserve tenant/owner access filters, public UUIDs, immutable financial records, and the existing single `/loans` frontend request.
- Add English and Thai copy together and keep the indicator understandable without relying on color alone.
- No database migration or MCP contract change is required.
- Every implementation commit updates `CHANGELOG.md` with explicit project version `v0.3.7`; the user-facing UI commit also updates `README.md`.

---

## File Structure

- Create `backend/src/lib/loan-payment-health.ts`: pure exact calculation and shared public DTO.
- Create `backend/src/lib/loan-payment-health.test.ts`: deterministic unit coverage for scheduled and floating state precedence, grace periods, exact money, and Bangkok-date inputs.
- Create `backend/src/services/loan-payment-health-service.ts`: tenant-scoped schedule/accrual loader that materializes current floating accruals and calls the pure kernel.
- Create `backend/src/services/loan-payment-health-service.test.ts`: disposable-PostgreSQL coverage for tenant isolation, floating materialization, partial accruals, and idempotent repeated reads.
- Modify `backend/src/modules/loan-contract-routes.ts`: append `paymentHealth` to each list item without changing existing fields.
- Create `frontend/src/pages/dashboard/loans/LoanPaymentHealthBadge.tsx`: focused accessible presentation for overdue/due-now state.
- Modify `frontend/src/pages/dashboard/loans/LoanList.tsx`: accept the additive DTO and render the indicator while retaining lifecycle status and full-card navigation.
- Modify `frontend/src/pages/dashboard/loans/LoanDetail.tsx`: replace raw schedule-status text with localized badges using the same destructive treatment for overdue rows.
- Modify `frontend/src/locales/en.json` and `frontend/src/locales/th.json`: matching status, count, amount, and age copy.
- Modify `frontend/tests/loan-list.vitest.tsx`: list response, exact-money, visual state, localization, navigation, and one-request assertions.
- Modify `README.md`: document list-level repayment-health visibility for operators.
- Modify `CHANGELOG.md`: record each committed backend/frontend deliverable under `v0.3.7`.

---

### Task 1: Build the exact payment-health kernel

**Files:**
- Create: `backend/src/lib/loan-payment-health.ts`
- Create: `backend/src/lib/loan-payment-health.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes:

```ts
export type LoanPaymentHealthInput = {
    lifecycleStatus: string;
    repaymentType: string;
    businessDate: string;
    gracePeriodDays?: number | null;
    lateFeeMode?: string | null;
    lateFeeAmount?: string | null;
    schedules: Array<{
        dueDate: string;
        remainingDue: string;
        paidPenalty: string;
        baseStatus: string;
    }>;
    accruals: Array<{
        accrualDate: string;
        interestAmount: string;
        paidAmount: string;
        status: string;
    }>;
};
```

- Produces:

```ts
export type LoanPaymentHealth = {
    status: "current" | "due_today" | "overdue" | "settled";
    dueTodayAmount: string;
    overdueAmount: string;
    overdueItemCount: number;
    maxOverdueDays: number;
};

export function computeLoanPaymentHealth(input: LoanPaymentHealthInput): LoanPaymentHealth;
```

- [ ] **Step 1: Write failing unit tests for scheduled state and precedence**

Create table-driven tests with the Bangkok business date supplied explicitly so they never depend on the machine clock:

```ts
import { describe, expect, test } from "bun:test";
import { computeLoanPaymentHealth } from "./loan-payment-health";

const base = {
    lifecycleStatus: "active",
    repaymentType: "daily",
    businessDate: "2026-08-11",
    gracePeriodDays: 0,
    lateFeeMode: "none",
    lateFeeAmount: "0.00",
    accruals: [],
};

describe("computeLoanPaymentHealth", () => {
    test("separates due-now installments from overdue installments", () => {
        expect(computeLoanPaymentHealth({
            ...base,
            schedules: [
                { dueDate: "2026-08-10", remainingDue: "125.25", paidPenalty: "0.00", baseStatus: "partial" },
                { dueDate: "2026-08-11", remainingDue: "50.10", paidPenalty: "0.00", baseStatus: "pending" },
            ],
        })).toEqual({ status: "overdue", dueTodayAmount: "50.10", overdueAmount: "125.25", overdueItemCount: 1, maxOverdueDays: 1 });
    });

    test("keeps an unpaid installment due-now while it is inside grace", () => {
        expect(computeLoanPaymentHealth({
            ...base,
            gracePeriodDays: 2,
            schedules: [{ dueDate: "2026-08-10", remainingDue: "80.00", paidPenalty: "0.00", baseStatus: "pending" }],
        })).toMatchObject({ status: "due_today", dueTodayAmount: "80.00", overdueAmount: "0.00", maxOverdueDays: 0 });
    });
});
```

- [ ] **Step 2: Add failing exact-money and late-fee tests**

Assert that values beyond JavaScript safe integer range aggregate exactly and that fixed/daily-percent penalties are included without binary floating-point drift:

```ts
test("aggregates overdue money exactly beyond Number safe integer range", () => {
    expect(computeLoanPaymentHealth({
        ...base,
        lateFeeMode: "fixed",
        lateFeeAmount: "0.10",
        schedules: [
            { dueDate: "2026-08-09", remainingDue: "9007199254740993.01", paidPenalty: "0.00", baseStatus: "pending" },
            { dueDate: "2026-08-10", remainingDue: "0.20", paidPenalty: "0.00", baseStatus: "pending" },
        ],
    })).toMatchObject({ overdueAmount: "9007199254740993.41", overdueItemCount: 2, maxOverdueDays: 2 });
});
```

- [ ] **Step 3: Add failing floating next-day tests**

Cover an unpaid accrual dated today, an earlier partial accrual, a paid accrual, and floating principal with no accrual rows:

```ts
test("marks floating interest overdue only from the following Bangkok date", () => {
    const floating = { ...base, repaymentType: "floating", schedules: [] };
    const accruals = [{ accrualDate: "2026-08-11", interestAmount: "15.00", paidAmount: "0.00", status: "accrued" }];

    expect(computeLoanPaymentHealth({ ...floating, businessDate: "2026-08-11", accruals }))
        .toMatchObject({ status: "due_today", dueTodayAmount: "15.00", overdueAmount: "0.00" });
    expect(computeLoanPaymentHealth({ ...floating, businessDate: "2026-08-12", accruals }))
        .toMatchObject({ status: "overdue", dueTodayAmount: "0.00", overdueAmount: "15.00", overdueItemCount: 1, maxOverdueDays: 1 });
    expect(computeLoanPaymentHealth({ ...floating, accruals: [] })).toMatchObject({ status: "current" });
});
```

- [ ] **Step 4: Run the kernel tests and verify they fail**

Run:

```bash
cd backend
bun test src/lib/loan-payment-health.test.ts
```

Expected: FAIL because `loan-payment-health.ts` and `computeLoanPaymentHealth` do not exist.

- [ ] **Step 5: Implement the minimal Decimal-based kernel**

Implement date-age calculation from `YYYY-MM-DD` values without local-browser time assumptions, compute scheduled penalties with `Decimal`, subtract `paidPenalty`, and classify all rows before choosing state precedence:

```ts
import Decimal from "decimal.js";

const zero = () => new Decimal(0);

function calendarDays(from: string, to: string) {
    const start = Date.parse(`${from}T00:00:00Z`);
    const end = Date.parse(`${to}T00:00:00Z`);
    return Math.max(0, Math.floor((end - start) / 86_400_000));
}

function resultMoney(value: Decimal) {
    return value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}
```

For scheduled rows, calculate `effectiveOverdueDays = max(0, calendarDays(dueDate, businessDate) - gracePeriodDays)`. Include a row in due-now when `dueDate <= businessDate`, its exact unpaid total is positive, and effective overdue days are zero. Include a row in overdue when effective overdue days are positive. For floating rows, use `Decimal.max(interestAmount - paidAmount, 0)` and compare `accrualDate` directly to `businessDate`.

Choose `settled` only when lifecycle status is `paid` or `closed` and both exact totals are zero; otherwise use precedence `overdue`, `due_today`, `current`.

- [ ] **Step 6: Run unit tests and backend typecheck**

Run:

```bash
cd backend
bun test src/lib/loan-payment-health.test.ts
bun run typecheck
```

Expected: all kernel tests PASS and TypeScript exits 0.

- [ ] **Step 7: Update the changelog and commit the kernel**

Under `CHANGELOG.md` → `v0.3.7` → `Added`, add:

```markdown
- Added an exact Decimal payment-health kernel for scheduled arrears, grace periods, late fees, and next-day floating-interest overdue classification.
```

Commit:

```bash
git add backend/src/lib/loan-payment-health.ts backend/src/lib/loan-payment-health.test.ts CHANGELOG.md
git commit -m "feat: calculate exact loan payment health"
```

---

### Task 2: Expose tenant-safe payment health through the loan-list endpoint

**Files:**
- Create: `backend/src/services/loan-payment-health-service.ts`
- Create: `backend/src/services/loan-payment-health-service.test.ts`
- Modify: `backend/src/modules/loan-contract-routes.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: `computeLoanPaymentHealth(input): LoanPaymentHealth` from Task 1; `accrueFloatingInterestThrough(tx, loan, through, actorUserId)` from `backend/src/services/floating-interest-service.ts`.
- Produces:

```ts
export async function getLoanPaymentHealth(
    executor: typeof db,
    loan: typeof loans.$inferSelect,
    input: { asOf: Date; actorUserId: number },
): Promise<LoanPaymentHealth>;
```

- Extends each `GET /loans` list item with `paymentHealth: LoanPaymentHealth` while preserving every existing field.

- [ ] **Step 1: Write the failing disposable-PostgreSQL service tests**

Seed two tenants and cover:

1. a scheduled loan with one overdue row, one due-now row, and a tenant-B row that must not contribute;
2. a floating loan with `interestStartDate`, daily policy, and unpaid accruals through `2026-08-11T12:00:00+07:00`;
3. a partially paid older accrual whose remainder alone is overdue;
4. two repeated reads that leave one unique accrual per loan/date;
5. a legacy floating loan without policy that stays `current`.

Use an explicit clock input:

```ts
const health = await getLoanPaymentHealth(db, loan, {
    asOf: new Date("2026-08-11T12:00:00+07:00"),
    actorUserId: actor.id,
});

expect(health).toEqual({
    status: "overdue",
    dueTodayAmount: "15.00",
    overdueAmount: "7.50",
    overdueItemCount: 1,
    maxOverdueDays: 1,
});
```

Reset the disposable tables in `beforeEach` with `TRUNCATE ... RESTART IDENTITY CASCADE`, including `loan_interest_accruals`, `loan_schedules`, `loans`, `borrowers`, and `users`.

- [ ] **Step 2: Run the service test and verify it fails**

Run:

```bash
cd backend
./scripts/test-disposable-postgres.sh src/services/loan-payment-health-service.test.ts
```

Expected: FAIL because `getLoanPaymentHealth` does not exist.

- [ ] **Step 3: Implement the tenant-scoped loader**

Derive the Bangkok business date once:

```ts
export function bangkokBusinessDate(value: Date) {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(value);
    const read = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)!.value;
    return `${read("year")}-${read("month")}-${read("day")}`;
}
```

For `floating`, call `accrueFloatingInterestThrough(executor, loan, asOf, actorUserId)` and filter returned rows by both `tenantId === loan.tenantId` and `loanId === loan.id` before mapping them into the kernel. For scheduled products, query `loanSchedules` with both tenant and loan predicates. Pass empty arrays for the unused source.

- [ ] **Step 4: Run the service test and typecheck**

Run:

```bash
cd backend
./scripts/test-disposable-postgres.sh src/services/loan-payment-health-service.test.ts
bun run typecheck
```

Expected: PASS, with repeated floating reads proving the accrual uniqueness constraint remains idempotent.

- [ ] **Step 5: Add a failing REST list regression test**

In `loan-payment-health-service.test.ts`, mount the existing `loansRoute`, authenticate as tenant A, request `/loans/`, and assert the additive shape and absence of tenant-B amounts:

```ts
expect(response.status).toBe(200);
expect(body).toEqual(expect.arrayContaining([
    expect.objectContaining({
        publicId: scheduledLoan.publicId,
        paymentHealth: {
            status: "overdue",
            dueTodayAmount: "50.10",
            overdueAmount: "125.25",
            overdueItemCount: 1,
            maxOverdueDays: 1,
        },
    }),
]));
expect(JSON.stringify(body)).not.toContain(tenantBLoan.publicId);
```

Freeze the route-test clock with Bun's clock helper and restore it after the test:

```ts
import { afterEach, setSystemTime } from "bun:test";

afterEach(() => setSystemTime());

setSystemTime(new Date("2026-08-11T12:00:00+07:00"));
```

- [ ] **Step 6: Extend the list route without N+1 frontend calls**

In the existing cached loader in `backend/src/modules/loan-contract-routes.ts`, select the full internal loan under a nested key plus borrower public fields, then explicitly construct the existing public result so the numeric internal loan ID never escapes:

```ts
const rows = await db.select({
    loan: loans,
    borrowerPublicId: borrowers.publicId,
    borrowerName: borrowers.name,
}).from(loans)
    .leftJoin(borrowers, eq(loans.borrowerId, borrowers.id))
    .where(and(...conditions))
    .orderBy(desc(loans.createdAt));

return Promise.all(rows.map(async ({ loan, borrowerPublicId, borrowerName }) => ({
    id: loan.publicId,
    publicId: loan.publicId,
    borrowerId: borrowerPublicId,
    borrowerPublicId,
    borrowerName,
    principal: serializeMoney(loan.principalAmount),
    outstandingPrincipal: serializeMoney(loan.outstandingPrincipal ?? "0"),
    status: loan.status,
    createdAt: loan.createdAt,
    repaymentType: loan.repaymentType,
    interestRate: serializeMoney(loan.interestRate),
    installmentAmount: loan.installmentAmount === null ? null : serializeMoney(loan.installmentAmount),
    totalInstallments: loan.totalInstallments,
    startDate: loan.startDate,
    paymentHealth: await getLoanPaymentHealth(db, loan, { asOf: new Date(), actorUserId: user.id }),
})));
```

- [ ] **Step 7: Run the backend regression suite**

Run:

```bash
cd backend
./scripts/test-disposable-postgres.sh src/lib/loan-payment-health.test.ts src/services/loan-payment-health-service.test.ts src/modules/loans-route-composition.test.ts
bun run typecheck
```

Expected: all selected tests PASS, no skipped database assertion, and TypeScript exits 0.

- [ ] **Step 8: Update the changelog and commit the REST integration**

Under `CHANGELOG.md` → `v0.3.7` → `Added`, add:

```markdown
- Added tenant-safe loan-list payment-health summaries for fixed schedules and materialized floating daily-interest accruals without per-card API requests.
```

Commit:

```bash
git add backend/src/services/loan-payment-health-service.ts backend/src/services/loan-payment-health-service.test.ts backend/src/modules/loan-contract-routes.ts CHANGELOG.md
git commit -m "feat: expose loan payment health summaries"
```

---

### Task 3: Render localized payment-health indicators and detail statuses

**Files:**
- Create: `frontend/src/pages/dashboard/loans/LoanPaymentHealthBadge.tsx`
- Modify: `frontend/src/pages/dashboard/loans/LoanList.tsx`
- Modify: `frontend/src/pages/dashboard/loans/LoanDetail.tsx`
- Modify: `frontend/src/locales/en.json`
- Modify: `frontend/src/locales/th.json`
- Modify: `frontend/tests/loan-list.vitest.tsx`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes:

```ts
export interface LoanPaymentHealth {
    status: "current" | "due_today" | "overdue" | "settled";
    dueTodayAmount: string;
    overdueAmount: string;
    overdueItemCount: number;
    maxOverdueDays: number;
}
```

- Produces:

```tsx
export function LoanPaymentHealthBadge(props: {
    health: LoanPaymentHealth;
    repaymentType: string;
}): React.JSX.Element | null;
```

- [ ] **Step 1: Extend the list test with failing visual and accessibility assertions**

Add scheduled overdue, floating overdue, due-now, and current rows to the single mocked `/loans` response. Use a safe large exact amount such as `"9007199254740993.01"` and assert its full localized digits survive rendering.

```tsx
expect(await screen.findByText("Scheduled Overdue")).toBeInTheDocument();
expect(screen.getByText("Overdue 2 installments")).toBeInTheDocument();
expect(screen.getByText("Overdue 3 days")).toBeInTheDocument();
expect(screen.getByText(/THB\s*9,007,199,254,740,993\.01/)).toBeInTheDocument();
expect(screen.getByText(/up to 3 days overdue/i)).toBeInTheDocument();
expect(screen.getByText(/Due now/)).toBeInTheDocument();
expect(screen.queryByText("Current")).not.toBeInTheDocument();
expect(vi.mocked(api.get).mock.calls.map(([url]) => url)).toEqual(["/loans"]);
```

Assert the lifecycle `ACTIVE` text remains visible on the same overdue card. Use `userEvent.click` with a small router probe or inspect the card link's `href` to verify it still navigates to `/loans/:publicId`.

- [ ] **Step 2: Add a failing Thai localization case**

Switch i18n to Thai, render a floating overdue row, and assert exact copy:

```tsx
await i18n.changeLanguage("th");
expect(await screen.findByText("ค้างชำระ 3 วัน")).toBeInTheDocument();
expect(screen.getByText(/ค้างสูงสุด 3 วัน/)).toBeInTheDocument();
```

Restore English in `beforeEach` as the existing test already does.

- [ ] **Step 3: Run the frontend test and verify it fails**

Run:

```bash
cd frontend
bun test tests/loan-list.vitest.tsx
```

Expected: FAIL because the DTO and visual component are not rendered.

- [ ] **Step 4: Implement the focused badge component**

Use `Badge`, `AlertTriangle`, `CalendarClock`, `useTranslation`, and `formatMoneyExact`. Return `null` for `current` and `settled`. Do not call `Number`:

```tsx
export function LoanPaymentHealthBadge({ health, repaymentType }: Props) {
    const { t, i18n } = useTranslation();
    if (health.status === "current" || health.status === "settled") return null;

    if (health.status === "overdue") {
        const countKey = repaymentType === "floating"
            ? "loans.paymentHealth.overdueDays"
            : "loans.paymentHealth.overdueInstallments";
        return (
            <div className="space-y-1" aria-label={t("loans.paymentHealth.overdueAria")}>
                <Badge variant="destructive" className="gap-1"><AlertTriangle aria-hidden="true" className="h-3.5 w-3.5" />{t(countKey, { count: health.overdueItemCount })}</Badge>
                <p className="text-xs font-medium text-destructive">{t("loans.paymentHealth.overdueSummary", { amount: formatMoneyExact(health.overdueAmount, i18n.language), days: health.maxOverdueDays })}</p>
            </div>
        );
    }

    return <Badge className="gap-1 border-amber-500/40 bg-amber-500/15 text-amber-800 dark:text-amber-200"><CalendarClock aria-hidden="true" className="h-3.5 w-3.5" />{t("loans.paymentHealth.dueNow", { amount: formatMoneyExact(health.dueTodayAmount, i18n.language) })}</Badge>;
}
```

- [ ] **Step 5: Integrate the list DTO and preserve navigation/lifecycle status**

Add `paymentHealth: LoanPaymentHealth` to `LoanRow`, render `LoanPaymentHealthBadge` below the existing outstanding/original principal block, and leave the existing lifecycle status text intact. Do not add schedule requests, effects, or client-side date comparisons.

For backward compatibility during a rolling frontend/backend deployment, normalize a missing additive field to this non-warning fallback only at the display boundary:

```ts
const currentHealth: LoanPaymentHealth = {
    status: "current", dueTodayAmount: "0.00", overdueAmount: "0.00", overdueItemCount: 0, maxOverdueDays: 0,
};
```

The backend must still fail rather than inventing `current` when its own authoritative calculation fails; this fallback is only for an older backend response that lacks the additive field.

- [ ] **Step 6: Add matching English and Thai keys**

Add under `loans.paymentHealth`:

```json
// en.json
{
  "overdueInstallments_one": "Overdue {{count}} installment",
  "overdueInstallments_other": "Overdue {{count}} installments",
  "overdueDays_one": "Overdue {{count}} day",
  "overdueDays_other": "Overdue {{count}} days",
  "overdueSummary": "{{amount}} · up to {{days}} days overdue",
  "dueNow": "Due now {{amount}}",
  "overdueAria": "This loan has an overdue balance"
}
```

```json
// th.json
{
  "overdueInstallments_one": "ค้างชำระ {{count}} งวด",
  "overdueInstallments_other": "ค้างชำระ {{count}} งวด",
  "overdueDays_one": "ค้างชำระ {{count}} วัน",
  "overdueDays_other": "ค้างชำระ {{count}} วัน",
  "overdueSummary": "{{amount}} · ค้างสูงสุด {{days}} วัน",
  "dueNow": "ถึงกำหนดชำระ {{amount}}",
  "overdueAria": "สัญญานี้มียอดค้างชำระ"
}
```

- [ ] **Step 7: Localize and emphasize schedule status on loan detail**

Import `Badge` and render schedule rows with explicit variants:

```tsx
<Badge variant={row.status === "overdue" ? "destructive" : row.status === "paid" ? "secondary" : "outline"}>
    {t(`loans.paymentHealth.scheduleStatus.${row.status}`, { defaultValue: row.status })}
</Badge>
```

Add matching `scheduleStatus` values for `pending`, `partial`, `overdue`, and `paid` in both locale files. Keep the exact schedule amount and due date unchanged.

- [ ] **Step 8: Run the focused frontend test**

Run:

```bash
cd frontend
bun test tests/loan-list.vitest.tsx
```

Expected: PASS for red overdue, amber due-now, exact large money, English/Thai copy, lifecycle separation, navigation, and one `/loans` request.

- [ ] **Step 9: Update user documentation and changelog**

Add a concise README capability bullet stating that the loan-agreement list visually distinguishes due-now and overdue scheduled/floating obligations before detail navigation.

Under `CHANGELOG.md` → `v0.3.7` → `Added`, add:

```markdown
- Added accessible Thai/English due-now and overdue indicators on loan cards, with exact amounts, installment/day counts, overdue age, and localized detail-schedule badges.
```

- [ ] **Step 10: Run frontend quality gates**

Run:

```bash
cd frontend
bun test tests/loan-list.vitest.tsx
bun run lint
bun run build
```

Expected: all commands exit 0.

- [ ] **Step 11: Commit the user-facing indicator**

```bash
git add frontend/src/pages/dashboard/loans/LoanPaymentHealthBadge.tsx frontend/src/pages/dashboard/loans/LoanList.tsx frontend/src/pages/dashboard/loans/LoanDetail.tsx frontend/src/locales/en.json frontend/src/locales/th.json frontend/tests/loan-list.vitest.tsx README.md CHANGELOG.md
git commit -m "feat: show overdue health on loan cards"
```

---

### Task 4: Run full verification and record evidence

**Files:**
- Modify only if a verification failure requires an in-scope correction; include every corrected file and `CHANGELOG.md` in the corresponding fix commit.

**Interfaces:**
- Consumes: all Task 1-3 deliverables.
- Produces: a verified loan-list payment-health feature with no skipped database invariant test.

- [ ] **Step 1: Run the complete disposable backend suite**

Run:

```bash
cd backend
./scripts/test-disposable-postgres.sh
```

Expected: all backend tests PASS with database-backed payment-health cases executed, not skipped.

- [ ] **Step 2: Run backend typecheck independently**

Run:

```bash
cd backend
bun run typecheck
```

Expected: exit 0.

- [ ] **Step 3: Run the complete frontend suite and build gates**

Run:

```bash
cd frontend
bun test
bun run lint
bun run build
```

Expected: all tests PASS, ESLint exits 0, and the production Vite build succeeds.

- [ ] **Step 4: Inspect the final diff and contract safety**

Run:

```bash
git diff HEAD~3 --check
git status --short
git log -4 --oneline
```

Confirm manually from the diff that:

- no internal numeric IDs, raw financial evidence, tokens, or secrets are exposed;
- `/loans` remains the only list-page request;
- money formatting never passes payment-health strings through `Number`;
- floating today's accrual is due-now and only earlier unpaid accrual dates are overdue;
- all three implementation commits contain a `v0.3.7` changelog update, and the UI commit contains the README update;
- unrelated pre-existing untracked files remain untouched.

If a gate fails, return to the task that owns the failing behavior, add a focused regression assertion, make the smallest in-scope correction, repeat that task's explicit staging/commit protocol with a precise `v0.3.7` `Fixed` changelog entry, and rerun all Task 4 gates. If every gate passes without changes, do not create an empty verification commit.
