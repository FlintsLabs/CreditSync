# Dashboard Daily Command Center Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an exact-money, resilient, action-first dashboard matching the selected Daily Command Center reference across desktop and mobile.

**Architecture:** Correct the six dashboard REST outputs at their backend source, then consume them through a typed frontend dashboard model and independently retryable loader. Compose focused summary, priority, due-queue, and secondary-detail components in the existing dashboard route and shell.

**Tech Stack:** Bun, Elysia, Drizzle, decimal.js, React 19, TypeScript, React Router, react-i18next, Tailwind CSS, Vitest, Testing Library, Playwright.

## Global Constraints

- Public money and percentages are two-decimal decimal strings and never pass through JavaScript `Number` arithmetic.
- Business dates use `Asia/Bangkok`; due dates remain `YYYY-MM-DD`.
- Preserve tenant-admin authorization and existing read-only routes.
- Add no financial writes, inferred risk decisions, forecasts, or invented timestamps.
- Update English and Thai locale files together.
- Every commit updates `CHANGELOG.md`; user-facing workflow changes also update `README.md`.
- Use the selected reference at `docs/superpowers/specs/assets/dashboard-command-center-reference.png` and require `design-qa.md` to end with `final result: passed`.

---

### Task 1: Exact dashboard REST values

**Files:**
- Create: `backend/src/lib/dashboard-money.ts`
- Create: `backend/src/lib/dashboard-money.test.ts`
- Modify: `backend/src/modules/dashboard.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces `sumDashboardMoney(values: string[]): string`, `subtractDashboardMoney(left: string, right: string): string`, and exact allocation aggregation helpers based on `Decimal`.
- Dashboard summary, funding alerts, due queues, and profitability return money/percent strings.

- [ ] Write tests using `9007199254740993.01`, exact subtraction, allocation gaps, and positive filtering.
- [ ] Run `cd backend && bun test src/lib/dashboard-money.test.ts`; expect missing-module failure.
- [ ] Implement the Decimal helpers and replace dashboard `Number`, floating reduction, epsilon comparison, `Math.max`, and numeric money outputs.
- [ ] Run the focused test and `bun run typecheck`; expect both to pass.
- [ ] Add a `v0.3.9` Fixed changelog bullet and commit `fix: preserve exact dashboard money`.

### Task 2: Frontend dashboard model and priority ordering

**Files:**
- Create: `frontend/src/pages/dashboard/dashboard-model.ts`
- Create: `frontend/tests/dashboard-command-center.vitest.tsx`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces exact dashboard response types, `buildPriorityItems(data): PriorityItem[]`, localized status-key helpers, and money-sign comparison without `Number`.

- [ ] Write tests for priority order, zero omission, exact values beyond safe integer range, and status/repayment localization keys.
- [ ] Run `cd frontend && bun run test -- tests/dashboard-command-center.vitest.tsx`; expect missing exports.
- [ ] Implement the minimal typed model with fixed route mapping and Decimal-string helpers from `workflow-model`.
- [ ] Run the focused test; expect pass.
- [ ] Add an Added changelog bullet and commit `feat: add dashboard command center model`.

### Task 3: Resilient action-first dashboard UI

**Files:**
- Create: `frontend/src/pages/dashboard/use-dashboard-data.ts`
- Create: `frontend/src/pages/dashboard/DashboardCommandCenter.tsx`
- Modify: `frontend/src/pages/dashboard/Dashboard.tsx`
- Modify: `frontend/src/locales/en.json`
- Modify: `frontend/src/locales/th.json`
- Modify: `frontend/tests/dashboard-command-center.vitest.tsx`
- Modify: `CHANGELOG.md`

**Interfaces:**
- `useDashboardData()` returns independent `{data, loading, error, retry}` states for all six reads.
- `DashboardCommandCenter` renders summary, priority queue, due queues, scoped errors/retries, view-all controls, and mobile disclosures.

- [ ] Add failing component tests for one `h1`, single summary relationship, primary CTA, priority order/routes, localized statuses, view-all, and partial API failure that preserves healthy sections.
- [ ] Run focused tests and confirm expected hierarchy/loading failures.
- [ ] Implement independent requests and the selected desktop/mobile composition, retaining existing action routes and admin gate.
- [ ] Add complete matching en/th copy and remove raw English statuses from the flow.
- [ ] Run focused tests, full frontend tests, lint, and build; expect pass.
- [ ] Add Added/Changed changelog bullets and commit `feat: redesign dashboard as daily command center`.

### Task 4: Documentation and visual design QA

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Create: `design-qa.md`
- Create: `docs/design-audits/dashboard-command-center-desktop.png`
- Create: `docs/design-audits/dashboard-command-center-mobile.png`

**Interfaces:**
- Produces reproducible verification evidence and a passing comparison against the selected reference.

- [ ] Document the action-first dashboard and exact/resilient read behavior in README and v0.3.9 changelog.
- [ ] Run backend focused tests/typecheck plus frontend full test/lint/build.
- [ ] Capture the same synthetic state at 1440x1024 and 390x844 with Playwright; test primary navigation, disclosures, retry, console errors, and horizontal overflow.
- [ ] Combine source and implementation captures into one comparison image, inspect it, fix all P0/P1/P2 findings, and repeat capture if fixes occur.
- [ ] Write `design-qa.md` with evidence, required fidelity surfaces, interaction results, comparison history, and exact `final result: passed`.
- [ ] Commit docs and QA evidence as `docs: verify dashboard command center design`.
- [ ] Invoke `superpowers:verification-before-completion`, rerun fresh gates, then use `superpowers:finishing-a-development-branch`.
