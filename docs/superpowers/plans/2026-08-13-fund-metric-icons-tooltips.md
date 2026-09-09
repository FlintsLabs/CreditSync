# Fund Metric Icons and Tooltips Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add semantic icons and accessible localized definition tooltips to every settlement, profitability, and reconciliation metric on Fund Detail.

**Architecture:** Add a shared Radix Tooltip UI primitive, then compose it through a focused `FundMetricLabel` feature component. `FundDetail` supplies icon, localized label, and localized description while preserving backend-owned calculations and exact value formatting.

**Tech Stack:** React 19, TypeScript, Tailwind CSS, Lucide React, Radix Tooltip, i18next, Vitest, Testing Library, Bun.

## Global Constraints

- Do not change backend calculations, financial records, API contracts, or exact decimal formatting.
- Keep semantic icons decorative; the information control must be keyboard-focusable and expose a localized accessible name.
- Tooltip content must work on hover, focus, and touch without containing borrower identities or transaction evidence.
- Update Thai and English locale files together without discarding unrelated Payment Inbox edits already present in those files.
- Use `bun` for dependency management, tests, lint, and builds.
- Update `CHANGELOG.md` in the same implementation commit.

---

### Task 1: Shared Accessible Tooltip Primitive

**Files:**
- Modify: `frontend/package.json`
- Modify: `frontend/bun.lock`
- Create: `frontend/src/components/ui/tooltip.tsx`
- Test: `frontend/tests/fund-detail.vitest.tsx`

**Interfaces:**
- Consumes: Radix Tooltip primitives from `@radix-ui/react-tooltip`.
- Produces: `TooltipProvider`, `Tooltip`, `TooltipTrigger`, and `TooltipContent` React components with forwarded refs and project-consistent classes.

- [ ] **Step 1: Add a failing interaction test**

Extend the Fund Detail test with an assertion that focuses an information button named `About Realized spread` and expects the definition `Revenue already recognized after cash source costs.` to appear.

```tsx
it("opens an accessible metric definition from the information control", async () => {
    const user = userEvent.setup();
    renderDetail();

    const info = await screen.findByRole("button", { name: "About Realized spread" });
    await user.tab();
    info.focus();

    expect(await screen.findByRole("tooltip")).toHaveTextContent(
        "Revenue already recognized after cash source costs.",
    );
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `cd frontend && bun run test -- tests/fund-detail.vitest.tsx`

Expected: FAIL because the `About Realized spread` button does not exist.

- [ ] **Step 3: Install the Radix tooltip dependency**

Run: `cd frontend && bun add @radix-ui/react-tooltip`

Expected: `frontend/package.json` and `frontend/bun.lock` include the dependency without unrelated package changes.

- [ ] **Step 4: Add the shared tooltip primitive**

Create `frontend/src/components/ui/tooltip.tsx` with Radix exports following the existing lowercase Radix UI files. The content uses `z-50 max-w-80 rounded-md border bg-popover px-3 py-2 text-sm text-popover-foreground shadow-md`, side offset `6`, and a portal. Set the provider delay to `250` milliseconds.

- [ ] **Step 5: Keep RED scoped to the missing feature component**

Run: `cd frontend && bun run test -- tests/fund-detail.vitest.tsx`

Expected: the same missing information-button assertion fails; existing Fund Detail tests pass.

- [ ] **Step 6: Commit the independently usable primitive**

Before committing, add the tooltip primitive to the current `v0.3.11` `### Added` changelog group. Stage only `CHANGELOG.md`, `frontend/package.json`, `frontend/bun.lock`, and `frontend/src/components/ui/tooltip.tsx`.

```bash
git commit -m "feat: add accessible tooltip primitive"
```

---

### Task 2: Fund Metric Labels, Icons, and Localized Definitions

**Files:**
- Create: `frontend/src/pages/dashboard/funds/FundMetricLabel.tsx`
- Modify: `frontend/src/pages/dashboard/funds/FundDetail.tsx`
- Modify: `frontend/src/locales/en.json`
- Modify: `frontend/src/locales/th.json`
- Modify: `frontend/tests/fund-detail.vitest.tsx`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: `TooltipProvider`, `Tooltip`, `TooltipTrigger`, and `TooltipContent` from Task 1; `LucideIcon` from `lucide-react`.
- Produces:

```ts
interface FundMetricLabelProps {
    icon: LucideIcon;
    label: string;
    description: string;
    infoLabel: string;
}
```

The component renders a decorative 16px semantic icon, visible label text, and a 32px information button that opens the localized tooltip.

- [ ] **Step 1: Complete failing accessibility and copy coverage**

Update the focused test to assert all 14 information buttons are present, the semantic SVGs have `aria-hidden="true"`, the representative tooltip opens, and the renamed labels `Cumulative net cash received` and `Cumulative net cash paid` render. Add a locale parity assertion that each English tooltip key exists in Thai.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `cd frontend && bun run test -- tests/fund-detail.vitest.tsx`

Expected: FAIL because metric buttons, icons, definitions, and renamed labels are absent.

- [ ] **Step 3: Implement `FundMetricLabel` minimally**

Create the component with this structure:

```tsx
export function FundMetricLabel({ icon: Icon, label, description, infoLabel }: FundMetricLabelProps) {
    return (
        <span className="inline-flex min-w-0 items-center gap-1.5">
            <Icon aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span>{label}</span>
            <Tooltip>
                <TooltipTrigger asChild>
                    <button type="button" aria-label={infoLabel} className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                        <Info aria-hidden="true" className="h-4 w-4" />
                    </button>
                </TooltipTrigger>
                <TooltipContent>{description}</TooltipContent>
            </Tooltip>
        </span>
    );
}
```

- [ ] **Step 4: Add matching localized definitions**

Add `fundDetail.metricInfo.about`, plus label/description keys for realized spread, unrealized spread, cumulative net cash received/paid, borrower cash collected, fund cost paid, deployed principal, net cash position, realized ROI, opportunity cost, economic spread, contract revenue, ledger revenue, and reconciliation difference in both locale files. Definitions state plain meaning and a short formula where useful.

- [ ] **Step 5: Replace scoped labels in Fund Detail**

Import `TrendingUp`, `Clock3`, `WalletCards`, `CircleMinus`, `HandCoins`, `ReceiptText`, `ArrowUpRight`, `Landmark`, `Percent`, `Timer`, `Scale`, `FileCheck2`, `BookOpenCheck`, and `TriangleAlert`. Wrap the summary area in one `TooltipProvider`, render `FundMetricLabel` for every scoped metric, and leave value elements and exact formatters unchanged.

- [ ] **Step 6: Run the focused test and verify GREEN**

Run: `cd frontend && bun run test -- tests/fund-detail.vitest.tsx`

Expected: all Fund Detail tests pass, including tooltip interaction, icon decoration, label rename, exact value, and reconciliation assertions.

- [ ] **Step 7: Run full frontend verification**

Run:

```bash
cd frontend
bun run test
bun run lint
bun run build
```

Expected: all tests and lint pass; production build succeeds with only the existing chunk-size advisory.

- [ ] **Step 8: Commit the feature**

Update the current `v0.3.11` changelog with one concise `### Changed` bullet covering semantic icons, accessible localized tooltips, and clarified net-cash labels. Preserve and stage the user's unrelated Payment Inbox hunks separately from this feature; use interactive staging or a clean worktree if locale edits overlap.

```bash
git commit -m "feat: explain fund metrics with icons"
```

---

### Task 3: Clean Deployment and Read-Only Verification

**Files:**
- No source changes.

**Interfaces:**
- Consumes: the committed frontend artifact from Task 2 and existing production Docker Compose files.
- Produces: production containers built from a clean committed worktree.

- [ ] **Step 1: Create a clean detached deployment worktree**

Create a detached worktree at the feature commit and link the existing root `.env.production`; do not deploy the dirty main worktree.

- [ ] **Step 2: Build without stale source layers**

Run `docker compose -p creditsync --env-file <root>/.env.production -f docker-compose.app.yml build --no-cache frontend`, then recreate `frontend`. Backend does not require rebuilding because this feature changes no backend code.

- [ ] **Step 3: Verify production read-only**

Confirm `http://127.0.0.1:8088/` returns HTTP 200, inspect frontend logs for startup errors, and verify the profitability endpoint remains read-only and returns the existing exact values.

- [ ] **Step 4: Remove the deployment worktree**

Remove and prune the temporary deployment worktree. Confirm the original five uncommitted Payment Inbox files remain present and unchanged.
