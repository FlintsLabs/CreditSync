# Dashboard Mobile Repayment Queues Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace nested repayment item cards with responsive divider-separated queue rows that are flat on mobile and contained by a section card from the medium breakpoint upward.

**Architecture:** Keep the existing Dashboard data resources, exact-money formatting, navigation callbacks, and queue state in `Dashboard.tsx`. Introduce shared presentation class constants for the two parallel queue sections and rows so borrower and fund queues use one responsive visual contract without forcing their distinct metadata into a new domain abstraction.

**Tech Stack:** React 19, TypeScript 6, Tailwind CSS 4 utilities, React Router, react-i18next, Vitest, Testing Library, Bun.

## Global Constraints

- Preserve all queue APIs, ordering, accounting behavior, exact-money strings, localization, loading, retry, empty, and five-item collapsed behavior.
- Mobile queue sections have no outer border, radius, shadow, or card-colored inset surface.
- At `md` and wider, restore an enclosing card surface for each queue.
- Entries remain native full-row buttons with visible keyboard focus and a minimum 44px interaction height.
- Entries use dividers on a shared surface rather than individual borders or rounded item cards at every width.
- Verify resilient layout at 320px, 406px, 768px, and desktop widths when a controllable browser surface is available.
- Do not modify the existing uncommitted Payment Inbox or locale changes in the shared worktree.

---

## File Structure

- Modify `frontend/src/pages/dashboard/Dashboard.tsx`: define shared responsive queue section/list/row presentation classes and apply them to both repayment queues.
- Modify `frontend/tests/dashboard-responsive-layout.test.ts`: freeze the mobile-flat, desktop-contained, divider-row, focus, and minimum-target contracts at source level.
- Modify `CHANGELOG.md`: record the implemented responsive queue change under `v0.3.11 - 2026-08-13` in `### Changed`.

### Task 1: Responsive Flat Repayment Queue Pattern

**Files:**
- Modify: `frontend/tests/dashboard-responsive-layout.test.ts`
- Modify: `frontend/src/pages/dashboard/Dashboard.tsx`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: existing `BorrowerDueItem`, `FundDueItem`, `BorrowerQueueMeta`, `StatusBadge`, `openBorrower(item)`, and `openFund(item)` behavior.
- Produces: `QUEUE_SECTION_CLASS`, `QUEUE_HEADER_CLASS`, `QUEUE_CONTENT_CLASS`, and `QUEUE_ROW_CLASS` string constants used by both queue panels.

- [ ] **Step 1: Write the failing responsive layout test**

Add this test to `frontend/tests/dashboard-responsive-layout.test.ts`:

```ts
it("uses flat divider-separated repayment queues on mobile with desktop containment", () => {
  expect(dashboardSource).toContain(
    'const QUEUE_SECTION_CLASS = "border-0 bg-transparent shadow-none md:rounded-lg md:border md:bg-card md:text-card-foreground md:shadow-sm";',
  );
  expect(dashboardSource).toContain(
    'const QUEUE_HEADER_CLASS = "px-0 pb-3 pt-0 md:p-6";',
  );
  expect(dashboardSource).toContain(
    'const QUEUE_CONTENT_CLASS = "divide-y divide-border/70 p-0 md:px-6 md:pb-6";',
  );
  expect(dashboardSource).toContain(
    'const QUEUE_ROW_CLASS = "group flex min-h-16 w-full items-center justify-between gap-3 py-4 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 md:px-3";',
  );
  expect(dashboardSource.match(/className=\{QUEUE_SECTION_CLASS\}/g)).toHaveLength(2);
  expect(dashboardSource.match(/className=\{QUEUE_ROW_CLASS\}/g)).toHaveLength(2);
  expect(dashboardSource).not.toContain(
    'className="group flex w-full flex-col items-stretch gap-3 rounded-xl border p-3 text-left',
  );
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run `cd frontend && bun test tests/dashboard-responsive-layout.test.ts`.

Expected: FAIL because the shared queue class constants do not exist and the old rounded bordered row class remains.

- [ ] **Step 3: Add the minimal shared responsive class contract**

In `frontend/src/pages/dashboard/Dashboard.tsx`, after `type Resource<T>`, add:

```ts
const QUEUE_SECTION_CLASS =
  "border-0 bg-transparent shadow-none md:rounded-lg md:border md:bg-card md:text-card-foreground md:shadow-sm";
const QUEUE_HEADER_CLASS = "px-0 pb-3 pt-0 md:p-6";
const QUEUE_CONTENT_CLASS =
  "divide-y divide-border/70 p-0 md:px-6 md:pb-6";
const QUEUE_ROW_CLASS =
  "group flex min-h-16 w-full items-center justify-between gap-3 py-4 text-left transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 md:px-3";
```

For both borrower and fund queue panels:

- Set the `Card` to `className={QUEUE_SECTION_CLASS}`.
- Compose the existing flex header classes with `QUEUE_HEADER_CLASS` while retaining `flex flex-row items-start justify-between gap-3`.
- Replace `CardContent className="space-y-2"` with `className={QUEUE_CONTENT_CLASS}`.
- Replace each item button's rounded bordered stacked class with `className={QUEUE_ROW_CLASS}`.
- Make the identity span `className="min-w-0 flex-1 pr-2"`.
- Make the amount/status span `className="shrink-0 space-y-1 text-right"` so the amount remains aligned at narrow widths.
- Wrap loading skeletons, error content, empty content, and the show-all action only where needed so divider styles do not change their semantics.
- Keep all callbacks, keys, formatting, translation lookups, and conditional branches unchanged.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run `cd frontend && bun test tests/dashboard-responsive-layout.test.ts`.

Expected: PASS with 3 tests and 0 failures.

- [ ] **Step 5: Run Dashboard behavior regression tests**

Run `cd frontend && bun test tests/dashboard-responsive-layout.test.ts tests/dashboard-command-center.vitest.ts`.

Expected: PASS; exact-money navigation and floating-arrears metadata behavior remain unchanged.

- [ ] **Step 6: Record the implementation in the changelog**

Under `CHANGELOG.md` → `## v0.3.11 - 2026-08-13` → `### Changed`, add:

```md
- Flattened both Dashboard repayment queues on mobile into full-width divider-separated rows, retained clear keyboard focus and exact amount/status alignment, and restored section containment at desktop widths without nested item cards.
```

- [ ] **Step 7: Run the frontend verification gates**

Run each command separately:

```bash
cd frontend && bun test tests/dashboard-responsive-layout.test.ts tests/dashboard-command-center.vitest.ts
cd frontend && bun run lint
cd frontend && bun run build
```

Expected: every command exits `0`; Vitest reports 0 failed tests, ESLint reports 0 errors, and Vite completes a production build.

- [ ] **Step 8: Inspect the final scoped diff**

Run:

```bash
git diff --check -- frontend/src/pages/dashboard/Dashboard.tsx frontend/tests/dashboard-responsive-layout.test.ts CHANGELOG.md
git diff -- frontend/src/pages/dashboard/Dashboard.tsx frontend/tests/dashboard-responsive-layout.test.ts CHANGELOG.md
```

Expected: no whitespace errors; the diff contains only the shared queue presentation contract, both queue applications, the focused regression test, and the matching changelog entry. Confirm the existing Payment Inbox and locale modifications remain unstaged and unchanged.

- [ ] **Step 9: Commit the verified implementation**

```bash
git add -- frontend/src/pages/dashboard/Dashboard.tsx frontend/tests/dashboard-responsive-layout.test.ts CHANGELOG.md
git commit -m "fix: flatten mobile dashboard repayment queues"
```

Expected: one commit containing the code, test, and changelog entry; no pre-existing Payment Inbox or locale files are staged.
