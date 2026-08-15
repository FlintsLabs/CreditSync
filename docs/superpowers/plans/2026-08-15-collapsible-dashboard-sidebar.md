# Collapsible Dashboard Sidebar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the approved Compact Rail desktop sidebar so users can toggle between the existing 256px navigation and a persistent, accessible 72px icon rail without changing the mobile drawer.

**Architecture:** A focused `useSidebarCollapsed` hook owns defensive local-storage initialization and writes. `DashboardLayout` remains the responsive layout owner and renders expanded/collapsed desktop navigation from the existing authorized navigation array, while `AppBar` accepts explicit desktop sidebar presentation props and preserves its existing mobile call sites. Existing Radix tooltip, Lucide, router, i18n, and shared control primitives provide the interaction layer without new dependencies.

**Tech Stack:** React 19, TypeScript 6, React Router 7, react-i18next, Tailwind CSS, Radix Tooltip, Lucide React, Vitest, Testing Library, Bun.

## Global Constraints

- The approved visual target is the third generated 2026-08-15 concept, `Compact Rail`.
- Expanded width remains exactly 256px (`w-64`); collapsed width is exactly 72px (`w-[72px]`).
- Store only `true` or `false` under `creditsync:sidebar-collapsed`; missing, malformed, unreadable, or unwritable storage falls back safely without blocking render or toggle.
- Keep the existing mobile header and overlay drawer unchanged below the `md` breakpoint.
- Preserve navigation order, authorization filtering, routes, active styling, theme/account behavior, and language behavior.
- Add English and Thai user-facing copy together; do not mix hardcoded languages in one flow.
- Reuse existing dependencies and assets; add no package solely for this feature.
- Use semantic buttons/links, localized accessible names, `aria-expanded`, `aria-current="page"`, keyboard-visible focus, hover/focus tooltips, and reduced-motion-safe transitions.
- Do not change backend, financial calculations, routes, page content, or accounting behavior.

---

### Task 1: Defensive sidebar preference hook

**Files:**
- Create: `frontend/src/hooks/useSidebarCollapsed.ts`
- Test: `frontend/tests/sidebar-preference.vitest.tsx`

**Interfaces:**
- Consumes: browser `window.localStorage` when available.
- Produces: `SIDEBAR_COLLAPSED_STORAGE_KEY = "creditsync:sidebar-collapsed"` and `useSidebarCollapsed(): readonly [boolean, () => void]`.

- [ ] **Step 1: Write the failing preference tests**

Create `frontend/tests/sidebar-preference.vitest.tsx` with a small harness that exposes state and toggle behavior:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SIDEBAR_COLLAPSED_STORAGE_KEY,
  useSidebarCollapsed,
} from "../src/hooks/useSidebarCollapsed";

function Harness() {
  const [collapsed, toggle] = useSidebarCollapsed();
  return <button type="button" aria-pressed={collapsed} onClick={toggle}>
    {collapsed ? "collapsed" : "expanded"}
  </button>;
}

describe("useSidebarCollapsed", () => {
  beforeEach(() => localStorage.clear());

  it("defaults to expanded when no valid preference exists", () => {
    localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, "invalid");
    render(<Harness />);
    expect(screen.getByRole("button")).toHaveTextContent("expanded");
  });

  it("restores a collapsed preference", () => {
    localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, "true");
    render(<Harness />);
    expect(screen.getByRole("button")).toHaveAttribute("aria-pressed", "true");
  });

  it("toggles and persists the explicit preference", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button"));
    expect(localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY)).toBe("true");
    await user.click(screen.getByRole("button"));
    expect(localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY)).toBe("false");
  });

  it("still toggles in memory when storage throws", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button"));
    expect(screen.getByRole("button")).toHaveTextContent("collapsed");
    vi.restoreAllMocks();
  });
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `cd frontend && bun test tests/sidebar-preference.vitest.tsx`

Expected: FAIL because `../src/hooks/useSidebarCollapsed` does not exist.

- [ ] **Step 3: Implement the minimal defensive hook**

Create `frontend/src/hooks/useSidebarCollapsed.ts`:

```ts
import { useCallback, useState } from "react";

export const SIDEBAR_COLLAPSED_STORAGE_KEY = "creditsync:sidebar-collapsed";

function readInitialPreference(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export function useSidebarCollapsed(): readonly [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(readInitialPreference);
  const toggle = useCallback(() => {
    setCollapsed((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(next));
      } catch {
        // The in-memory preference remains usable when storage is unavailable.
      }
      return next;
    });
  }, []);
  return [collapsed, toggle] as const;
}
```

- [ ] **Step 4: Run the focused test and confirm GREEN**

Run: `cd frontend && bun test tests/sidebar-preference.vitest.tsx`

Expected: PASS for missing/malformed state, restoration, persistence, and unavailable storage.

---

### Task 2: Accessible expanded and Compact Rail desktop navigation

**Files:**
- Modify: `frontend/src/components/AppBar.tsx`
- Modify: `frontend/src/layouts/DashboardLayout.tsx`
- Modify: `frontend/src/locales/en.json`
- Modify: `frontend/src/locales/th.json`
- Modify: `frontend/tests/account-navigation.vitest.tsx`
- Modify: `frontend/tests/dashboard-responsive-layout.test.ts`
- Test: `frontend/tests/collapsible-dashboard-sidebar.vitest.tsx`

**Interfaces:**
- Consumes: `useSidebarCollapsed(): readonly [boolean, () => void]`, the current authorized `navigation` array, `TooltipProvider`, `Tooltip`, `TooltipTrigger`, `TooltipContent`, `/favicon.svg`, and existing `AppBar`, `ModeToggle`, `UserAccountMenu`, `LanguageSwitcher`, and `Button` behavior.
- Produces: `AppBar({ showAccount?: boolean, compact?: boolean, sidebarToggle?: { collapsed: boolean; onToggle: () => void; label: string } })` and a desktop sidebar that exposes `data-sidebar-state="expanded" | "collapsed"` for stable behavioral tests.

- [ ] **Step 1: Add the failing rendered-layout tests**

Create `frontend/tests/collapsible-dashboard-sidebar.vitest.tsx`. Render `DashboardLayout` at `/loans` through `MemoryRouter`, `Routes`, and a child route; set an owner user in local storage so the full authorized menu is present. Assert these exact behaviors:

```tsx
const sidebar = screen.getByTestId("desktop-sidebar");
expect(sidebar).toHaveAttribute("data-sidebar-state", "expanded");
expect(sidebar).toHaveClass("w-64");
expect(screen.getByRole("button", { name: "Collapse sidebar" })).toHaveAttribute("aria-expanded", "true");
expect(screen.getAllByRole("link", { name: "Loans" })[0]).toHaveAttribute("aria-current", "page");

await user.click(screen.getByRole("button", { name: "Collapse sidebar" }));
expect(sidebar).toHaveAttribute("data-sidebar-state", "collapsed");
expect(sidebar).toHaveClass("w-[72px]");
expect(screen.getByRole("button", { name: "Expand sidebar" })).toHaveAttribute("aria-expanded", "false");
expect(screen.getAllByRole("link", { name: "Loans" })[0]).toHaveAccessibleName("Loans");
expect(localStorage.getItem("creditsync:sidebar-collapsed")).toBe("true");
```

Add separate tests that preload `creditsync:sidebar-collapsed=true`, verify the compact state on the first render, click every desktop navigation link by its localized accessible name, and confirm the existing mobile toggle still has `Open navigation` while the mobile drawer markup/classes remain unchanged.

- [ ] **Step 2: Extend the existing source-contract tests before implementation**

In `frontend/tests/dashboard-responsive-layout.test.ts`, add assertions that the layout source contains `md:w-[72px]`/`w-[72px]` compact width, `motion-reduce:transition-none`, and the unchanged mobile main/content classes. In `frontend/tests/account-navigation.vitest.tsx`, retain the canonical Settings assertion and add a collapsed-preference case that still finds the Settings desktop link by accessible name and exact `/settings` href.

- [ ] **Step 3: Run focused sidebar tests and confirm RED**

Run:

```bash
cd frontend
bun test tests/collapsible-dashboard-sidebar.vitest.tsx tests/dashboard-responsive-layout.test.ts tests/account-navigation.vitest.tsx tests/locale-parity.vitest.ts
```

Expected: FAIL because the toggle labels, compact state, persisted layout, and new locale keys are absent.

- [ ] **Step 4: Add synchronized locale keys**

Add under `nav` in both locale files:

```json
// frontend/src/locales/en.json
"collapseSidebar": "Collapse sidebar",
"expandSidebar": "Expand sidebar"
```

```json
// frontend/src/locales/th.json
"collapseSidebar": "ย่อแถบเมนู",
"expandSidebar": "ขยายแถบเมนู"
```

Keep JSON syntax valid and let `locale-parity.vitest.ts` enforce identical leaf paths.

- [ ] **Step 5: Extend `AppBar` with an explicit compact desktop contract**

Define:

```ts
type AppBarProps = {
  showAccount?: boolean;
  compact?: boolean;
  sidebarToggle?: {
    collapsed: boolean;
    onToggle: () => void;
    label: string;
  };
};
```

When `compact` is false, retain the `CreditSync` heading, theme action, and account action. When true, render `/favicon.svg` as the real compact brand asset with an accessible-hidden image, keep the theme/account icon actions reachable, and avoid clipping their dropdown portals. When `sidebarToggle` exists, render a shared `Button` with `PanelLeftClose` or `PanelRightOpen`, `aria-label={label}`, `aria-expanded={!collapsed}`, `onClick={onToggle}`, visible focus styles, and a Radix tooltip containing the same localized label. Existing `<AppBar />` and `<AppBar showAccount={false} />` calls must continue to work without new required props.

- [ ] **Step 6: Implement the desktop Compact Rail in `DashboardLayout`**

Import `useSidebarCollapsed` and tooltip primitives. Replace only the desktop sidebar branch with state-driven classes:

```tsx
const [isSidebarCollapsed, toggleSidebar] = useSidebarCollapsed();
const sidebarToggle = {
  collapsed: isSidebarCollapsed,
  onToggle: toggleSidebar,
  label: t(isSidebarCollapsed ? "nav.expandSidebar" : "nav.collapseSidebar"),
};

<aside
  data-testid="desktop-sidebar"
  data-sidebar-state={isSidebarCollapsed ? "collapsed" : "expanded"}
  className={cn(
    "sticky top-0 hidden h-screen shrink-0 flex-col overflow-y-auto border-r bg-card transition-[width] duration-200 motion-reduce:transition-none md:flex",
    isSidebarCollapsed ? "w-[72px]" : "w-64",
  )}
>
```

Pass `compact={isSidebarCollapsed}` and `sidebarToggle={sidebarToggle}` to `AppBar`. Wrap desktop items in one `TooltipProvider`. For each link:

- Always set `aria-label={item.name}`.
- Set `aria-current={isActive ? "page" : undefined}`.
- Use `justify-center p-0 size-10 mx-auto` in compact mode and the current expanded classes otherwise.
- Keep the Lucide icon `shrink-0`; render visible item text only when expanded.
- In compact mode, wrap the link with `TooltipTrigger asChild` and render `TooltipContent side="right">{item.name}</TooltipContent>`.

For the footer, keep `LanguageSwitcher` reachable in both states, hide only the visible “Language” label in compact mode, and center the button. Do not touch the `md:hidden` mobile header/drawer branch.

- [ ] **Step 7: Run focused tests and confirm GREEN**

Run:

```bash
cd frontend
bun test tests/sidebar-preference.vitest.tsx tests/collapsible-dashboard-sidebar.vitest.tsx tests/dashboard-responsive-layout.test.ts tests/account-navigation.vitest.tsx tests/locale-parity.vitest.ts
```

Expected: PASS with expanded/default, compact/restored, navigation, localization, Settings-route, storage-failure, and mobile-regression coverage.

- [ ] **Step 8: Update project documentation for the user-facing workflow**

Add a concise README note in the authenticated navigation/UI section: desktop users can collapse navigation to an icon rail, labels remain available on hover/focus, and the choice is remembered per browser. Under `## v0.3.13 - 2026-08-15` → `### Added` in `CHANGELOG.md`, consolidate the existing Compact Rail design bullet into one implementation bullet that covers the approved design, accessible rail, localized controls, and browser-local persistence.

- [ ] **Step 9: Commit the complete feature atomically**

Before committing, verify the staged changelog version/date/type matches the implementation. Preserve unrelated dirty files and stage only the files named in Tasks 1–2 plus `README.md` and `CHANGELOG.md`.

```bash
git add frontend/src/hooks/useSidebarCollapsed.ts \
  frontend/tests/sidebar-preference.vitest.tsx \
  frontend/src/components/AppBar.tsx \
  frontend/src/layouts/DashboardLayout.tsx \
  frontend/src/locales/en.json frontend/src/locales/th.json \
  frontend/tests/collapsible-dashboard-sidebar.vitest.tsx \
  frontend/tests/dashboard-responsive-layout.test.ts \
  frontend/tests/account-navigation.vitest.tsx \
  README.md CHANGELOG.md
git diff --cached --check
git commit -m "feat(ui): add collapsible dashboard sidebar"
```

Expected: one feature commit containing implementation, tests, README, and the matching changelog entry, with unrelated worktree changes unstaged.

---

### Task 3: Full verification and visual design QA

**Files:**
- Create: `design-qa.md`
- Modify only if QA finds a defect: files from Tasks 1–2.

**Interfaces:**
- Consumes: approved Compact Rail image, current expanded production screenshot, locally rendered `/loans` page, and the Task 2 implementation commit.
- Produces: verified frontend gates and `design-qa.md` ending with exactly `final result: passed` or `final result: blocked`.

- [ ] **Step 1: Run the full frontend verification gates**

Run sequentially with Bun:

```bash
cd frontend
bun test
bun run lint
bun run build
```

Expected: all tests pass, ESLint exits 0, and TypeScript/Vite production build exits 0. Do not report success if a gate is skipped or fails.

- [ ] **Step 2: Start and inspect the local frontend**

Run the existing Bun-first development command from `frontend/` on an available local port. Open `/loans` in the Codex in-app browser at the same 878x915 viewport as the approved evidence. Use a safe local authenticated fixture/session only; do not create or mutate production financial data.

- [ ] **Step 3: Verify interaction states manually**

Check expanded, hover/focus tooltip, collapsed, active Loans link, theme dropdown, account dropdown, language toggle, reload restoration, keyboard focus order, reduced-motion emulation, and the below-`md` mobile drawer. Confirm content expands without horizontal overflow and the current page does not remount or reset when toggling.

- [ ] **Step 4: Run blocking visual comparison**

Capture the implemented collapsed state at 878x915. Compare it side-by-side with the exact third generated Compact Rail result and compare the expanded state with the original production screenshot. Record layout, typography, spacing, icon, tooltip, focus, and overflow findings in `design-qa.md` with priorities P0–P3.

Expected: fix every P0/P1/P2, recapture, and repeat until the report ends with `final result: passed`. If the reference, local capture, or browser comparison is unavailable, write `final result: blocked` and stop without claiming visual completion.

- [ ] **Step 5: Verify repository and commit integrity**

Run:

```bash
git status --short
git show --stat --oneline HEAD
git diff --check
```

Expected: the feature commit contains only the intended sidebar files; existing unrelated user changes remain preserved and unexplained new tracked changes do not exist. If QA required code edits, update the v0.3.13 changelog entry before staging and amending or creating the matching scoped commit.

- [ ] **Step 6: Report branch completion precisely**

Report the commit, exact test/lint/build results, visual-QA result, preview URL, and any remaining P3 polish. Do not claim push, deployment, production update, or merge unless separately authorized and verified.
