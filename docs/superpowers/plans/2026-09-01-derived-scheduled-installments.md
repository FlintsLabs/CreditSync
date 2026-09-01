# Derived Scheduled Installments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let weekly and monthly loans accept `totalInstallments` alone and derive the amount from the existing rate calculation, while retaining count-plus-amount as an explicit fixed-total override.

**Architecture:** Keep `termMonths` as the annual-interest duration. Add one Decimal-backed resolution helper in the calculator and use it from preview, draft creation, draft update, and schedule generation. For weekly/monthly: neither field uses legacy cadence; count-only derives the schedule; count plus amount is fixed-total; amount-only is invalid. Persist the resolved `scheduledInstallmentMode` (`rate_derived` or `fixed_total`) with each draft so a nominal display amount cannot later be reinterpreted as a fixed contractual amount. Daily behavior is out of scope.

**Tech Stack:** Bun, TypeScript, Elysia, Drizzle/PostgreSQL, `decimal.js` via `FinancialDecimal`, React, Vitest.

**Spec:** This plan supersedes the pair-only decision in `docs/superpowers/specs/2026-08-31-custom-scheduled-installments-design.md`. Approved contract: count-only uses annual-rate pricing; count-plus-amount uses `count × amount − principal` as scheduled interest; amount-only rejects for weekly/monthly.

## Global Constraints

- Public money is a two-decimal string; all financial computation uses `FinancialDecimal`.
- Non-fixed weekly/monthly interest remains `principal × interestRate × termMonths / 12`.
- `termMonths` remains required and is the pricing duration even if count-only changes the number of schedule rows.
- The generated schedule is authoritative. A derived schedule may put its cent residual in the last row.
- A persisted nominal amount is never sufficient to determine pricing mode. Every new weekly/monthly draft with an explicit count must persist `scheduledInstallmentMode`; historical rows with no mode retain legacy inference for backward compatibility.
- A fixed-total pair may not have `installmentAmount × totalInstallments < principal`.
- Do not change daily-entry or existing daily fixed-installment semantics.
- Do not mutate active contracts, posted schedules, payments, or any other financial history.
- Preserve user changes and resolve existing merge conflicts before staging implementation work.
- Update README, English/Thai locales, plugin contract, and CHANGELOG when public wording or contract semantics change.

---

### Task 1: Lock the revised contract with calculator tests

**Files:**
- Modify: `backend/src/lib/calculator.test.ts`
- Modify: `backend/src/lib/public-loan-terms.test.ts`
- Modify: `backend/src/lib/public-loan-schedule.test.ts`

**Interfaces:**
- Consumes: `calculateLoanSchedule`, `calculatePublicLoanSchedule`, `normalizePublicLoanTerms`.
- Produces: regression coverage for the four weekly/monthly input combinations and exact final-row rounding.

- [ ] **Step 1: Add the count-only monthly case**

```ts
it("derives a three-row monthly schedule from count-only public terms", () => {
    const rows = calculatePublicLoanSchedule({
        principal: "1200.00", interestRate: "12.00", termMonths: 3,
        repaymentType: "monthly", startDate: "2026-08-10", totalInstallments: 3,
    });
    expect(rows.map((row) => row.amount)).toEqual(["412.00", "412.00", "412.00"]);
    expect(rows.reduce((sum, row) => sum.plus(row.interestComponent), new FinancialDecimal("0.00")).toFixed(2)).toBe("36.00");
});
```

- [ ] **Step 2: Add the count-only weekly override and legacy fallback cases**

```ts
it("uses supplied weekly count with term-based annual interest", () => {
    const rows = calculatePublicLoanSchedule({
        principal: "1200.00", interestRate: "12.00", termMonths: 3,
        repaymentType: "weekly", startDate: "2026-08-10", totalInstallments: 10,
    });
    expect(rows).toHaveLength(10);
    expect(rows.reduce((sum, row) => sum.plus(row.amount), new FinancialDecimal("0.00")).toFixed(2)).toBe("1236.00");
});

it("retains legacy weekly cadence when count and amount are omitted", () => {
    expect(calculatePublicLoanSchedule({
        principal: "1200.00", interestRate: "12.00", termMonths: 3,
        repaymentType: "weekly", startDate: "2026-08-10",
    })).toHaveLength(12);
});
```

- [ ] **Step 3: Add fixed-total, invalid amount-only, and residual cases**

```ts
it("keeps count plus amount as a fixed-total override", () => {
    const rows = calculatePublicLoanSchedule({
        principal: "30000.00", interestRate: "0.00", termMonths: 3,
        repaymentType: "weekly", startDate: "2026-08-31",
        totalInstallments: 10, installmentAmount: "5000.00",
    });
    expect(rows).toHaveLength(10);
    expect(rows.every((row) => row.amount === "5000.00")).toBe(true);
});

it("rejects amount-only scheduled input", () => {
    expect(() => normalizePublicLoanTerms({
        principal: "1200.00", interestRate: "12.00", termMonths: 3,
        repaymentType: "monthly", installmentAmount: "412.00",
    })).toThrow("Installment amount requires total installments");
});
```

Add a count-only amount of `1010.00 / 3` test expecting `336.67, 336.67, 336.66`, plus exact principal/interest sum assertions.

- [ ] **Step 4: Run focused tests and confirm red**

Run: `cd backend && bun test src/lib/calculator.test.ts src/lib/public-loan-terms.test.ts src/lib/public-loan-schedule.test.ts`

Expected: count-only weekly/monthly currently either follows legacy count or is rejected by the pair validation.

- [ ] **Step 5: Commit the test baseline**

```bash
git add backend/src/lib/calculator.test.ts backend/src/lib/public-loan-terms.test.ts backend/src/lib/public-loan-schedule.test.ts
git commit -m "test: define derived scheduled installment contract"
```

### Task 2: Create a single exact calculator resolution path

**Files:**
- Modify: `backend/src/lib/calculator.ts`
- Test: `backend/src/lib/calculator.test.ts`
- Test: `backend/src/lib/public-loan-terms.test.ts`
- Test: `backend/src/lib/public-loan-schedule.test.ts`

**Interfaces:**
- Consumes: `PublicLoanTerms` for weekly/monthly schedules.
- Produces: an exported resolver used by the calculator and application service to persist resolved count and nominal amount.

- [ ] **Step 1: Add calculator resolution types**

```ts
export type ScheduledInstallmentMode = "rate_derived" | "fixed_total";

export interface ResolvedScheduledTerms {
    terms: NormalizedPublicLoanTerms;
    mode: ScheduledInstallmentMode;
    installments: number | null;
    scheduledInterest: string | null;
    nominalInstallmentAmount: string | null;
}
```

- [ ] **Step 2: Implement `resolveScheduledPublicTerms(input)`**

```ts
const installments = terms.totalInstallments
    ?? (terms.repaymentType === "weekly" ? terms.termMonths * 4 : terms.termMonths);
const principal = parseMoney(terms.principal);
const annualInterest = principal.times(terms.interestRate).div(100).times(terms.termMonths).div(12)
    .toDecimalPlaces(2, FinancialDecimal.ROUND_HALF_UP);
const fixedTotal = terms.installmentAmount === undefined ? null : parseMoney(terms.installmentAmount).times(installments);
if (fixedTotal?.lessThan(principal)) throw new Error("Installment total cannot be less than principal");
const scheduledInterest = fixedTotal === null ? annualInterest : fixedTotal.minus(principal);
const nominal = fixedTotal === null
    ? principal.plus(scheduledInterest).div(installments).toDecimalPlaces(2, FinancialDecimal.ROUND_HALF_UP)
    : parseMoney(terms.installmentAmount!);
```

For a weekly/monthly `installmentAmount` without `totalInstallments`, throw `"Installment amount requires total installments"`. Keep daily, floating, and single-payment branches unchanged.

- [ ] **Step 3: Use the same basis in `calculateLoanSchedule`**

Make the weekly/monthly branch use resolver count and scheduled interest. For mode `fixed_total`, set every row total to the caller amount. For `legacy` and `derived`, retain exact component allocation and give the last row the residual. Do not duplicate annual-interest arithmetic in more than one helper.

- [ ] **Step 4: Run focused tests and confirm green**

Run: `cd backend && bun test src/lib/calculator.test.ts src/lib/public-loan-terms.test.ts src/lib/public-loan-schedule.test.ts`

Expected: all sums conserve exactly and every count-only case derives the stated result.

- [ ] **Step 5: Commit calculator work**

```bash
git add backend/src/lib/calculator.ts backend/src/lib/calculator.test.ts backend/src/lib/public-loan-terms.test.ts backend/src/lib/public-loan-schedule.test.ts
git commit -m "feat: derive scheduled installments from count"
```

### Task 3: Use resolved terms in preview, drafts, and draft updates

**Files:**
- Modify: `backend/src/services/loan-application-service.ts`
- Modify: `backend/src/services/loan-application-service.test.ts`
- Modify: `backend/src/modules/loan-contract-routes.test.ts`

**Interfaces:**
- Consumes: `resolveScheduledPublicTerms`.
- Produces: resolved `totalInstallments` and nominal `installmentAmount` in preview, draft persistence, and draft presentation.

- [ ] **Step 1: Add service-level red tests**

```ts
test("derives count-only monthly draft terms", async () => {
    const draft = await createLoanDraft(ctx, {
        borrowerPublicId: borrower.publicId, principal: "1200.00", interestRate: "12.00",
        repaymentType: "monthly", termMonths: 3, totalInstallments: 3, startDate: "2026-08-10",
    });
    expect(draft).toMatchObject({ totalInstallments: 3, installmentAmount: "412.00", status: "draft" });
});
```

Add draft-update coverage for changing count-only `3 → 2` (expect `618.00`), clearing both fields (legacy cadence), and amount-only update rejection.

- [ ] **Step 2: Resolve after daily-entry normalization**

In `normalizeTerms`, retain the daily-entry overrides, call `normalizePublicLoanTerms`, then call `resolveScheduledPublicTerms`. Return resolved terms so `previewLoan`, `createLoanDraft`, `updateLoanDraft`, and `updateLoanPaymentStartDate` share exactly one result.

- [ ] **Step 3: Preserve explicit update semantics**

An update that changes only count derives a new amount. An update that clears both fields restores legacy schedule defaults. An update that supplies only amount fails; it must not silently retain an old count.

- [ ] **Step 4: Add REST preview coverage**

```ts
expect(preview.body).toMatchObject({
    terms: { totalInstallments: 3, installmentAmount: "412.00" },
    schedule: [{ amount: "412.00" }],
});
```

Use a POST `/loans/preview` request with principal `1200.00`, annual rate `12.00`, three months, monthly repayment, and `totalInstallments: 3`.

- [ ] **Step 5: Run service and route tests**

Run: `cd backend && ./scripts/test-disposable-postgres.sh src/services/loan-application-service.test.ts src/modules/loan-contract-routes.test.ts`

Expected: preview/create/update/activation use the same resolved schedule; active loan rows are never recalculated.

- [ ] **Step 6: Commit service work**

```bash
git add backend/src/services/loan-application-service.ts backend/src/services/loan-application-service.test.ts backend/src/modules/loan-contract-routes.test.ts
git commit -m "feat: persist derived scheduled loan terms"
```

### Task 4: Align browser, MCP, and plugin callers

**Files:**
- Modify: `frontend/src/lib/workflow-model.ts`
- Modify: `frontend/tests/workflow-model.test.ts`
- Modify: `frontend/src/pages/dashboard/loans/LoanWizard.tsx`
- Modify: `frontend/tests/loan-wizard.vitest.tsx`
- Modify: `frontend/src/locales/en.json`
- Modify: `frontend/src/locales/th.json`
- Modify: `backend/src/mcp/server.ts`
- Modify: `backend/src/mcp/server.test.ts`
- Modify: `backend/src/mcp/default.test.ts`
- Modify: `plugins/creditsync/references/mcp-tool-contract.json`

**Interfaces:**
- Consumes: existing optional public `totalInstallments` and `installmentAmount` fields.
- Produces: count-only input accepted; amount-only rejected; backend-derived amount displayed and returned.

- [ ] **Step 1: Replace pair validation in the browser model**

```ts
const hasCount = Boolean(form.totalInstallments?.trim());
const hasAmount = Boolean(form.installmentAmount?.trim());
if ((form.repaymentType === "weekly" || form.repaymentType === "monthly") && hasAmount && !hasCount) {
    throw new Error("Installment amount requires total installments");
}
if (hasCount) terms.totalInstallments = positiveInteger(form.totalInstallments!, "totalInstallments");
if (hasAmount) terms.installmentAmount = normalizeMoney(form.installmentAmount!);
```

Keep the daily-entry early return. Do not calculate money in the browser.

- [ ] **Step 2: Add frontend tests**

Test that a monthly count-only form serializes `totalInstallments: 3` with no amount; amount-only throws the precise message; a wizard preview response with `terms.installmentAmount: "412.00"` renders the returned amount.

- [ ] **Step 3: Keep REST/MCP schema fields optional and test behavior**

Do not make `installmentAmount` required in Elysia or Zod schemas. Add MCP preview/draft count-only monthly tests asserting `installmentAmount: "412.00"`, and amount-only tests asserting `INVALID_LOAN_TERMS`.

- [ ] **Step 4: Update localized help copy and regenerate plugin contract**

State in both locales that count alone derives an amount, while entering amount creates a fixed-total override. Regenerate the frozen JSON contract with the repository’s existing plugin validation/export process; do not hand-edit unrelated JSON sections.

- [ ] **Step 5: Run caller tests**

Run: `cd frontend && bun test tests/workflow-model.test.ts tests/loan-wizard.vitest.tsx`

Run: `cd backend && ./scripts/test-disposable-postgres.sh src/mcp/server.test.ts src/mcp/default.test.ts`

Run: `bun test plugins/creditsync/tests/plugin-contract.test.ts`

Expected: REST, MCP, and frontend exhibit one contract and all values remain decimal strings.

- [ ] **Step 6: Commit caller alignment**

```bash
git add frontend/src/lib/workflow-model.ts frontend/tests/workflow-model.test.ts frontend/src/pages/dashboard/loans/LoanWizard.tsx frontend/tests/loan-wizard.vitest.tsx frontend/src/locales/en.json frontend/src/locales/th.json backend/src/mcp/server.ts backend/src/mcp/server.test.ts backend/src/mcp/default.test.ts plugins/creditsync/references/mcp-tool-contract.json
git commit -m "feat: support count-only scheduled loan terms"
```

### Task 5: Replace contradictory documentation and run full gates

**Files:**
- Modify: `docs/superpowers/specs/2026-08-31-custom-scheduled-installments-design.md`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: the verified contract from Tasks 1–4.
- Produces: public documentation that distinguishes rate-derived and fixed-total schedules.

- [ ] **Step 1: Replace the prior pair-only decision table**

| weekly/monthly input | schedule source | interest source |
| --- | --- | --- |
| neither field | legacy cadence from `termMonths` | annual rate × `termMonths / 12` |
| `totalInstallments` only | supplied count | annual rate × `termMonths / 12` |
| both fields | supplied count and amount | `count × amount − principal` |
| `installmentAmount` only | rejected | not applicable |

- [ ] **Step 2: Update README and CHANGELOG**

Document that count-only derives a nominal backend amount and an exact final residual row. Document that the pair is fixed-total pricing. Add a dated changelog entry before staging the commit.

- [ ] **Step 3: Run every verification gate**

Run: `cd backend && bun run typecheck`

Run: `cd backend && ./scripts/test-disposable-postgres.sh`

Run: `cd frontend && bun test && bun run lint && bun run build`

Run: `bun test plugins/creditsync/tests/plugin-contract.test.ts`

Expected: all commands exit 0. Investigate unrelated suite failures independently rather than narrowing the final gate.

- [ ] **Step 4: Inspect and commit**

Run: `git diff --check && git status --short`

Confirm no merge conflict remains, no user-owned work was overwritten, and no financial-data migration was added.

```bash
git add docs/superpowers/specs/2026-08-31-custom-scheduled-installments-design.md README.md CHANGELOG.md
git commit -m "docs: clarify scheduled installment pricing contract"
```

## Plan Self-Review

- Tasks 1–2 cover all four inputs, annual-rate calculation, fixed-total override, and exact residual behavior.
- Task 3 covers preview, draft persistence, update semantics, and activation safety.
- Task 4 covers frontend, REST, MCP, locales, and frozen plugin contract.
- Task 5 removes the contradictory prior documentation and requires all project verification gates.
- Daily behavior, active contracts, and posted financial history are explicitly preserved.
