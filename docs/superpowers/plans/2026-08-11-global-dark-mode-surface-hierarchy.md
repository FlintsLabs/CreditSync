# Global Dark Mode Surface Hierarchy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every CreditSync dark-mode screen a clear shadcn-style hierarchy between the application canvas, elevated containers, overlays, form controls, and nested interactive surfaces.

**Architecture:** Keep the existing shadcn semantic-token architecture and change only the `.dark` token values in `frontend/src/index.css`. Add a focused source-level Vitest contract so future theme changes cannot accidentally make `background` and `card` identical again; all existing shared components inherit the hierarchy without page-specific overrides.

**Tech Stack:** React 19, TypeScript 6, Tailwind CSS 4 with shadcn semantic HSL variables, Vitest 4, Bun.

## Global Constraints

- Preserve all light-mode tokens and theme-selection behavior.
- Keep the existing semantic token names and Tailwind mappings unchanged.
- Preserve component structure, spacing, typography, radius, localization, and application behavior.
- Preserve financial status colors and chart colors.
- Use Bun for dependency, test, lint, and build commands.
- Every commit must update `CHANGELOG.md` with explicit project version `v0.3.9` and a concise summary.
- Do not stage or commit unrelated existing workspace files.

## File Structure

- Create `frontend/tests/dark-theme-tokens.test.ts`: source-level contract for the dark-mode surface lightness ordering, runnable by both Bun and Vitest.
- Modify `frontend/src/index.css`: authoritative dark semantic surface palette.
- Modify `CHANGELOG.md`: record the v0.3.9 dark-mode hierarchy implementation and verification.

---

### Task 1: Protect and implement the global dark surface hierarchy

**Files:**
- Create: `frontend/tests/dark-theme-tokens.test.ts`
- Modify: `frontend/src/index.css:33-58`
- Modify: `CHANGELOG.md:3-25`

**Interfaces:**
- Consumes: Tailwind mappings in `frontend/tailwind.config.js`, including `bg-background`, `bg-card`, `bg-popover`, `bg-secondary`, `bg-muted`, `bg-accent`, `border-border`, and `border-input`.
- Produces: dark-mode CSS variables with exact values `background = 240 10% 3.9%`, `card = 240 5.9% 10%`, `popover = 240 5.9% 10%`, `secondary/muted/accent = 240 3.7% 15.9%`, and `border/input = 240 3.7% 20%`.

- [ ] **Step 1: Write the failing dark-theme token contract**

Create `frontend/tests/dark-theme-tokens.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const stylesheetPath = resolve(process.cwd(), "src/index.css");
const stylesheet = readFileSync(stylesheetPath, "utf8");
const darkBlock = stylesheet.match(/\.dark\s*\{([\s\S]*?)\n\s*\}/)?.[1] ?? "";

function token(name: string) {
    const value = darkBlock.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1]?.trim();
    expect(value, `missing --${name} in the dark theme`).toBeDefined();
    return value as string;
}

function lightness(value: string) {
    const match = value.match(/(-?\d+(?:\.\d+)?)%\s*$/);
    expect(match, `expected an HSL percentage in ${value}`).not.toBeNull();
    return Number(match?.[1]);
}

describe("dark theme surface hierarchy", () => {
    it("keeps persistent surfaces visibly above the canvas", () => {
        expect(lightness(token("card"))).toBeGreaterThan(lightness(token("background")));
        expect(lightness(token("popover"))).toBeGreaterThan(lightness(token("background")));
    });

    it("keeps nested surfaces visibly above persistent surfaces", () => {
        expect(lightness(token("secondary"))).toBeGreaterThan(lightness(token("card")));
        expect(lightness(token("muted"))).toBeGreaterThan(lightness(token("card")));
        expect(lightness(token("accent"))).toBeGreaterThan(lightness(token("card")));
    });

    it("uses stronger boundaries than the nested surfaces", () => {
        expect(lightness(token("border"))).toBeGreaterThan(lightness(token("muted")));
        expect(lightness(token("input"))).toBeGreaterThan(lightness(token("muted")));
    });
});
```

- [ ] **Step 2: Run the focused test and confirm the current palette fails**

Run:

```bash
cd frontend && bun test tests/dark-theme-tokens.test.ts
```

Expected: FAIL because the current `--card` and `--popover` equal `--background`, and `--border`/`--input` are `240 3.7% 15.9%`.

- [ ] **Step 3: Implement the minimal semantic-token change**

In the existing `.dark` block in `frontend/src/index.css`, change only these declarations:

```css
    --card: 240 5.9% 10%;
    --popover: 240 5.9% 10%;
    --border: 240 3.7% 20%;
    --input: 240 3.7% 20%;
```

Keep these existing surface declarations unchanged because they already provide the intended canvas and nested-surface levels:

```css
    --background: 240 10% 3.9%;
    --secondary: 240 3.7% 15.9%;
    --muted: 240 3.7% 15.9%;
    --accent: 240 3.7% 15.9%;
```

Do not change foreground, destructive, ring, or chart tokens.

- [ ] **Step 4: Run the focused contract and existing theme-preference tests**

Run:

```bash
cd frontend && bun test tests/dark-theme-tokens.test.ts
cd frontend && bun run test -- tests/dark-theme-tokens.test.ts tests/account-preferences.vitest.tsx
```

Expected: both test files PASS; theme selection and persistence behavior remain unchanged.

- [ ] **Step 5: Run the complete frontend verification suite**

Run each command separately:

```bash
cd frontend && bun test
cd frontend && bun run test
cd frontend && bun run lint
cd frontend && bun run build
```

Expected: all tests PASS, ESLint exits 0, and the production build exits 0.

- [ ] **Step 6: Inspect representative dark and light surfaces in the user's Chrome workflow**

Use the existing CreditSync application and inspect these states at desktop width and a mobile-width viewport:

1. Loan detail: confirm the page canvas is darker than summary cards and section cards.
2. Desktop sidebar and mobile drawer: confirm both inherit the elevated `card` surface.
3. Theme menu or account menu: confirm the `popover` surface separates from both canvas and card.
4. A form/dialog: confirm inputs, muted panels, hover/selected states, borders, text, and focus rings remain distinguishable.
5. Switch to light mode: confirm the light palette is visually unchanged.

Reject the change if card boundaries still depend only on borders, if nested surfaces disappear into cards, or if text/status colors lose legibility. If the expected hierarchy is present, save desktop and mobile dark-mode screenshots as verification evidence without adding them to production assets.

- [ ] **Step 7: Record the implementation and verification**

Under `## v0.3.9 - 2026-08-11` in `CHANGELOG.md`, add these concise entries without altering existing entries:

```markdown
### Changed
- Raised dark-mode cards, navigation, overlays, controls, and nested panels onto distinct semantic surface levels across the application.

### Fixed
- Prevented dark-mode cards and popovers from visually collapsing into the application canvas, with a focused token hierarchy regression test.
```

If the headings already exist, append each bullet beneath its matching heading rather than creating duplicate headings.

- [ ] **Step 8: Review the scoped diff and commit only task files**

Run:

```bash
git diff --check -- frontend/src/index.css frontend/tests/dark-theme-tokens.test.ts CHANGELOG.md
git diff -- frontend/src/index.css frontend/tests/dark-theme-tokens.test.ts CHANGELOG.md
git status --short
git add frontend/src/index.css frontend/tests/dark-theme-tokens.test.ts CHANGELOG.md docs/superpowers/plans/2026-08-11-global-dark-mode-surface-hierarchy.md
git diff --cached --check
git commit -m "fix: improve global dark mode hierarchy"
```

Expected: the staged diff contains only the two frontend files and `CHANGELOG.md`; commit succeeds without staging unrelated plan files or workspace changes.

---

## Completion Criteria

- The focused token contract proves the canvas, persistent surfaces, nested surfaces, and boundaries are distinct.
- All frontend tests, lint, and production build pass under Bun.
- Desktop and mobile dark-mode inspection show the requested shadcn-style surface hierarchy.
- Light mode, theme persistence, semantic financial colors, charts, layout, localization, and workflows are unchanged.
- The v0.3.9 changelog and implementation commit contain only the approved scope.
