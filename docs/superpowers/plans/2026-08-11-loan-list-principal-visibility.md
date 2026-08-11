# Loan List Principal Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the outstanding and original principal together on every loan-list card.

**Architecture:** Extend the existing tenant-scoped `/loans` list projection additively with the persisted `outstandingPrincipal` decimal string. Keep `principal` as the immutable original principal for existing consumers. The React card receives both values and renders outstanding as the primary amount with an exact-formatted, localized original-principal line beneath it.

**Tech Stack:** Bun, Elysia, Drizzle, React, TypeScript, i18next, Vitest, Testing Library.

## Global Constraints

- Public money remains a two-decimal decimal string; never convert loan money to JavaScript `Number`.
- Use `serializeMoney` in the backend and `formatMoneyExact` in the frontend.
- Update `frontend/src/locales/en.json` and `frontend/src/locales/th.json` together for user-facing copy.
- The list is read-only: do not modify loan terms, repayments, schedules, funding allocations, or financial records.
- Update `CHANGELOG.md` with an explicit current project version before committing implementation.

---

### Task 1: Expose outstanding principal in the loan-list contract

**Files:**
- Modify: `backend/src/services/loan-application-service.test.ts:535-537`
- Modify: `backend/src/modules/loan-contract-routes.ts:38-65`

**Interfaces:**
- Consumes: persisted `loans.principalAmount` and `loans.outstandingPrincipal` numeric columns.
- Produces: `GET /loans` rows with `principal: string` (original) and `outstandingPrincipal: string` (current balance).

- [ ] **Step 1: Write the failing REST-contract assertion**

In the existing lifecycle integration test, replace the list expectation with:

```ts
expect(list.body[0]).toMatchObject({
    publicId: created.body.publicId,
    principal: "1200.00",
    outstandingPrincipal: "1200.00",
    startDate: "2026-08-10",
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `bun test backend/src/services/loan-application-service.test.ts`

Expected: FAIL because `GET /loans` does not return `outstandingPrincipal`.

- [ ] **Step 3: Add the minimal route projection and serialization**

In the list query select map, add `outstandingPrincipal: loans.outstandingPrincipal`; in the returned mapper add:

```ts
outstandingPrincipal: serializeMoney(row.outstandingPrincipal ?? "0"),
```

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `bun test backend/src/services/loan-application-service.test.ts`

Expected: PASS.

### Task 2: Present both principals on loan cards

**Files:**
- Modify: `frontend/tests/loan-list.vitest.tsx:12-32`
- Modify: `frontend/src/pages/dashboard/loans/LoanList.tsx:13-24,156-162`
- Modify: `frontend/src/locales/en.json:398-426`
- Modify: `frontend/src/locales/th.json:398-426`

**Interfaces:**
- Consumes: loan list rows with `principal: string`, `outstandingPrincipal: string`, and the active i18n language.
- Produces: a card primary value for current outstanding principal and a muted `originalPrincipal` line containing the immutable principal.

- [ ] **Step 1: Write the failing component assertion**

Add `outstandingPrincipal: "3750.00"` to the daily fixture. Then add assertions that a mistaken production change showing only the original principal would fail:

```ts
expect(screen.getByText(/฿3,750\.00/)).toBeInTheDocument();
expect(screen.getByText(/Original principal.*฿5,000\.00/)).toBeInTheDocument();
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `cd frontend && bun test tests/loan-list.vitest.tsx`

Expected: FAIL because `LoanRow` has no `outstandingPrincipal` and the card shows `principal` alone.

- [ ] **Step 3: Implement the minimal card and localization change**

Add `outstandingPrincipal: string` to `LoanRow`. Replace the card's primary money output with:

```tsx
<div className="text-2xl font-bold">{formatMoneyExact(loan.outstandingPrincipal, i18n.language)}</div>
<p className="mt-1 text-xs text-muted-foreground">
    / {t("loans.originalPrincipal", "Original principal")} {formatMoneyExact(loan.principal, i18n.language)}
</p>
```

Add matching keys:

```json
// en.json
"originalPrincipal": "Original principal"
// th.json
"originalPrincipal": "เงินต้นตั้งต้น"
```

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `cd frontend && bun test tests/loan-list.vitest.tsx`

Expected: PASS.

### Task 3: Verify the full change and record it

**Files:**
- Modify: `CHANGELOG.md:3-10`

**Interfaces:**
- Consumes: passing list-contract and loan-card tests.
- Produces: a documented v0.3.7 user-facing loan-list improvement.

- [ ] **Step 1: Add the release note**

Under `## v0.3.7 - 2026-08-11`, add this concise entry if it is not already present:

```markdown
- Added loan-list cards that show outstanding principal with a muted original-principal reference.
```

- [ ] **Step 2: Run the applicable quality gates**

Run:

```bash
bun test backend/src/services/loan-application-service.test.ts
cd frontend && bun test && bun run lint && bun run build
```

Expected: every command exits 0.

- [ ] **Step 3: Inspect and commit only task files**

Run:

```bash
git diff --check
git add backend/src/modules/loan-contract-routes.ts backend/src/services/loan-application-service.test.ts frontend/src/pages/dashboard/loans/LoanList.tsx frontend/tests/loan-list.vitest.tsx frontend/src/locales/en.json frontend/src/locales/th.json CHANGELOG.md docs/superpowers/plans/2026-08-11-loan-list-principal-visibility.md
git commit -m "feat: show outstanding principal on loan cards"
```

Expected: the commit contains only the listed implementation and plan files; unrelated untracked plans remain unstaged.
