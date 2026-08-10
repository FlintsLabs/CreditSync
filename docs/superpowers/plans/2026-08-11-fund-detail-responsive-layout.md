# Fund Detail Responsive Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the funding-source detail page readable in tablet and compact-desktop content areas without changing financial calculations or backend APIs.

**Architecture:** Keep the existing `FundDetail` data flow intact. Apply responsive Tailwind classes so the summary uses two cards per row until `2xl`, and render an accessible contract-card representation below `2xl` alongside the existing wide-screen table.

**Tech Stack:** React, TypeScript, Tailwind CSS, React Router, Vitest, Testing Library, i18next.

## Global Constraints

- Preserve exact-money values from `formatMoneyExact`; do not add client-side financial calculations.
- Keep backend contracts, allocation data, and financial records unchanged.
- Preserve existing contract navigation, settled-loan toggle, loading state, and empty state.
- Use existing localized labels; do not add hardcoded user-facing copy where a key exists.
- Keep the desktop allocation table at `2xl` and above.
- Update `CHANGELOG.md` for the implementation commit as required by repository policy.

---

### Task 1: Lock responsive content hierarchy with a focused regression test

**Files:**
- Modify: `frontend/tests/fund-detail.vitest.tsx`
- Modify: `frontend/src/pages/dashboard/funds/FundDetail.tsx`

**Interfaces:**
- Consumes: mocked `FundingUsage` with one direct allocation.
- Produces: `data-testid="funding-summary-grid"` and `data-testid="funding-usage-cards"` for stable layout assertions.

- [ ] **Step 1: Write the failing responsive-layout test**

```tsx
it("uses a two-column compact summary and exposes each allocation as a contract card", async () => {
    renderDetail();
    const summary = await screen.findByTestId("funding-summary-grid");
    expect(summary).toHaveClass("md:grid-cols-2", "2xl:grid-cols-3");
    const cards = screen.getByTestId("funding-usage-cards");
    expect(cards).toHaveTextContent("Current borrower");
    expect(cards).toHaveTextContent("Direct own-capital allocation");
    expect(cards).toHaveTextContent(/7,000\.00/);
    expect(cards).toHaveTextContent(/5,000\.00/);
    expect(screen.getByRole("link", { name: LOAN_ID })).toHaveAttribute("href", `/loans/${LOAN_ID}`);
});
```

- [ ] **Step 2: Run the test and observe the expected failure**

Run: `cd frontend && bun run test -- tests/fund-detail.vitest.tsx`

Expected: FAIL because the summary still has `md:grid-cols-3` and no compact allocation-card region.

- [ ] **Step 3: Implement the responsive structural boundary**

```tsx
<div data-testid="funding-summary-grid" className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
    {/* existing summary cards */}
</div>
<div data-testid="funding-usage-cards" className="space-y-3 2xl:hidden">
    {/* linked allocation cards */}
</div>
<div className="hidden 2xl:block overflow-x-auto">
    {/* existing allocation table */}
</div>
```

- [ ] **Step 4: Run the focused test and verify it passes**

Run: `cd frontend && bun run test -- tests/fund-detail.vitest.tsx`

Expected: PASS.

### Task 2: Prevent compact-card amount and metadata collisions

**Files:**
- Modify: `frontend/src/pages/dashboard/funds/FundDetail.tsx`
- Modify: `frontend/tests/fund-detail.vitest.tsx`

**Interfaces:**
- Consumes: existing summary values and each `FundingUsageAllocation`.
- Produces: a shrink-safe exact-money display and a labelled compact allocation-card definition list.

- [ ] **Step 1: Add a failing compact amount assertion**

```tsx
expect(screen.getByTestId("funding-available-amount")).toHaveClass("min-w-0", "tabular-nums", "text-2xl");
```

- [ ] **Step 2: Run the test and observe the expected failure**

Run: `cd frontend && bun run test -- tests/fund-detail.vitest.tsx`

Expected: FAIL because the available amount has no compact, shrink-safe presentation classes.

- [ ] **Step 3: Implement the amount and contract metadata presentation**

```tsx
<div data-testid="funding-available-amount" className="min-w-0 text-2xl font-bold tabular-nums sm:text-3xl">
    {formatMoneyExact(availableAmount, i18n.language)}
</div>
<dl className="grid gap-3 text-sm sm:grid-cols-2">
    {/* borrower, route, net allocation, outstanding principal, and latest allocation */}
</dl>
```

- [ ] **Step 4: Run the focused test and verify it passes**

Run: `cd frontend && bun run test -- tests/fund-detail.vitest.tsx`

Expected: PASS with all compact allocation metadata and the contract link present.

### Task 3: Verify and record the responsive release

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `frontend/src/pages/dashboard/funds/FundDetail.tsx`
- Modify: `frontend/tests/fund-detail.vitest.tsx`

**Interfaces:**
- Consumes: the approved responsive design and completed layouts.
- Produces: a verified responsive frontend release record.

- [ ] **Step 1: Add the release note**

```markdown
### Fixed
- Made funding-source summaries and loan allocations readable in tablet and compact-desktop layouts without horizontal content collisions.
```

- [ ] **Step 2: Run full frontend verification**

Run: `cd frontend && bun run test && bun run lint && bun run build`

Expected: all frontend tests, lint, and production build pass; Vite's existing chunk-size advisory may remain non-fatal.

- [ ] **Step 3: Commit the verified change**

```bash
git add frontend/src/pages/dashboard/funds/FundDetail.tsx frontend/tests/fund-detail.vitest.tsx CHANGELOG.md
git commit -m "fix: make funding detail responsive"
```

## Self-review

- Spec coverage: Task 1 implements the compact summary and allocation cards; Task 2 prevents amount collisions and preserves every allocation field; Task 3 records and verifies the release.
- Placeholder scan: no incomplete behaviors or unspecified verification commands remain.
- Type consistency: all tasks use existing `FundingUsageAllocation`, `formatMoneyExact`, route links, and localization keys from `FundDetail`.
