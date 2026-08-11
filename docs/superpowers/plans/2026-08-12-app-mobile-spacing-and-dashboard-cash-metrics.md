# App Mobile Spacing and Dashboard Cash Metrics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply 8px mobile page padding to every authenticated route and flatten the Dashboard cash metrics into divided cells within their single outer card.

**Architecture:** Keep authenticated page-edge spacing owned by `DashboardLayout`, removing Dashboard's redundant inner padding. Keep the cash-summary surface owned by the Dashboard section and make `MoneyMetric` a flat responsive cell with horizontal mobile separators and vertical separators from `sm` upward.

**Tech Stack:** React 19, TypeScript 6, Tailwind CSS 4, Vitest 4, Bun

## Global Constraints

- Public landing/login layouts, dialogs, shared card primitives, and component-internal spacing must not change.
- Authenticated mobile page padding is 8px; the existing 32px padding starts at `md`.
- Cash metrics stack below `sm` and use three columns from `sm` upward.
- Exact-money formatting, localization, semantic colors, loading, and accessibility behavior remain unchanged.

---

### Task 1: Responsive Page Edges and Flat Cash Metrics

**Files:**
- Create: `frontend/tests/dashboard-responsive-layout.test.ts`
- Modify: `frontend/src/layouts/DashboardLayout.tsx`
- Modify: `frontend/src/pages/dashboard/Dashboard.tsx`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: `DashboardLayout` as the shared authenticated route shell and `MoneyMetric` as the Dashboard-only cash value cell.
- Produces: shared `p-2 md:p-8` authenticated page edges and responsive cash-metric dividers without changing component APIs.

- [x] **Step 1: Add the failing responsive-layout regression test**

Create `frontend/tests/dashboard-responsive-layout.test.ts` using `readFileSync` and `resolve` to read the two production components. Assert these literal contracts independently:

```ts
expect(layoutSource).toContain('className="flex-1 overflow-x-hidden p-2 md:p-8"');
expect(dashboardSource).toContain('className="flex-1 space-y-6 pb-10"');
expect(dashboardSource).toContain('border-b border-border/70 p-4 last:border-b-0 sm:border-b-0 sm:border-r sm:last:border-r-0');
expect(dashboardSource).toContain('className="grid sm:grid-cols-3"');
```

These assertions catch restoration of 16px mobile page padding, reintroduction of Dashboard double padding, or reintroduction of isolated nested metric cards.

- [x] **Step 2: Run the focused test and confirm RED**

Run: `bun test tests/dashboard-responsive-layout.test.ts`

Expected: FAIL because the layout still uses `p-4`, Dashboard still owns `p-4 ... pt-6 lg:p-8`, and `MoneyMetric` is still a rounded bordered card.

- [x] **Step 3: Implement the minimal responsive styling**

In `DashboardLayout.tsx`, change the page-content main classes to `flex-1 overflow-x-hidden p-2 md:p-8`.

In `Dashboard.tsx`, change the root main classes to `flex-1 space-y-6 pb-10`; change the cash grid to `grid sm:grid-cols-3`; and change `MoneyMetric` to a flat cell using `min-w-0 border-b border-border/70 p-4 last:border-b-0 sm:border-b-0 sm:border-r sm:last:border-r-0` while retaining its existing children and value styles.

- [x] **Step 4: Run the focused test and confirm GREEN**

Run: `bun test tests/dashboard-responsive-layout.test.ts`

Expected: PASS.

- [x] **Step 5: Run frontend verification**

Run from `frontend/`:

```bash
bun test
bun run lint
bun run build
```

Expected: all tests pass, lint exits 0, and the production build completes.

- [x] **Step 6: Record and commit the implementation**

Add one concise `### Changed` entry under `v0.3.10 - 2026-08-12` describing the app-wide authenticated mobile page padding and flat Dashboard cash metrics. Verify `git diff --check`, stage the implementation, test, plan, and changelog files, then commit with:

```bash
git commit -m "fix: refine authenticated mobile spacing"
```
