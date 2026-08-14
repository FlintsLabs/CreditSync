# Loan List Borrower Labels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show confirmed aliases and borrower tags beneath borrower names on Loan List cards and make all labels searchable.

**Architecture:** Extend the authenticated cached `GET /loans` projection with two explicit label arrays gathered only for borrowers already visible through loan access filters. Keep display normalization and search behavior in a small pure frontend model, while `LoanList` owns rendering and interaction. Add tenant-cache invalidation after committed alias mutations so cached list labels refresh immediately.

**Tech Stack:** Bun, TypeScript, Elysia, Drizzle ORM/PostgreSQL, React 19, React Router, react-i18next, Testing Library, Vitest, Tailwind UI primitives.

## Global Constraints

- Return only `confirmed` aliases; never expose pending or inactive aliases.
- Preserve tenant and portfolio access scope; labels must never expand visible loans.
- Preserve all public financial values as exact two-decimal strings; do not introduce `Number` arithmetic.
- Keep aliases and tags as identity aids only; never auto-select a borrower or make a financial decision from them.
- Use `Asia/Bangkok` for existing date rendering and keep English/Thai copy synchronized.
- No schema, migration, MCP, plugin, deployment, or production-data changes.
- Update `CHANGELOG.md` before every implementation commit, and update `README.md` with the user-facing Loan List capability.
- Preserve unrelated dirty files and stage only files named by the active task.

## File Map

- Create `backend/src/modules/loan-list-borrower-labels.test.ts`: database-backed REST contract, visibility, status, and cache-refresh regressions.
- Modify `backend/src/modules/loan-contract-routes.ts`: project visible borrower IDs, fetch confirmed aliases, and attach label arrays.
- Modify `backend/src/services/borrower-service.ts`: invalidate tenant cache after successful alias add/confirm/deactivate transactions.
- Create `frontend/src/pages/dashboard/loans/loan-list-model.ts`: pure label normalization, overflow, and search helpers.
- Create `frontend/tests/loan-list-model.test.ts`: pure edge-case coverage without mocks.
- Modify `frontend/src/pages/dashboard/loans/LoanList.tsx`: consume arrays, search labels, and render badges/overflow.
- Modify `frontend/tests/loan-list.vitest.tsx`: observable card rendering, search, and localization behavior.
- Modify `frontend/src/locales/en.json` and `frontend/src/locales/th.json`: search placeholder and accessible overflow copy.
- Test `frontend/tests/locale-parity.vitest.ts`: run the existing behavioral parity gate without changing it unless a demonstrated gap requires a RED/GREEN update.
- Modify `README.md`: mention nickname/tag visibility and Loan List search.
- Modify `CHANGELOG.md`: record backend freshness and user-facing feature in the same commits they describe.

---

### Task 1: Tenant-safe Loan List label contract and cache freshness

**Files:**
- Create: `backend/src/modules/loan-list-borrower-labels.test.ts`
- Modify: `backend/src/modules/loan-contract-routes.ts`
- Modify: `backend/src/services/borrower-service.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: `loanAccessFilters(user)`, `borrowers.tags`, `borrowerAliases`, `withTenantCache`, and `invalidateTenantCache(tenantId)`.
- Produces: each `GET /loans` item gains `borrowerAliases: string[]` and `borrowerTags: string[]`.

- [ ] **Step 1: Write the failing database-backed route tests**

Create fixtures for an owner-visible loan with tags `['VIP', 'ตลาดเช้า']`, confirmed alias `นก`, pending alias `รอตรวจ`, and inactive alias `ชื่อเก่า`; also create a collector-owned loan, another collector's loan in the same tenant, and a cross-tenant loan. Authenticate through `new Elysia().use(loansRoute)` and assert literal DTO behavior:

```ts
expect(ownerRows).toEqual(expect.arrayContaining([
  expect.objectContaining({
    publicId: visibleLoan.publicId,
    borrowerAliases: ["นก"],
    borrowerTags: ["VIP", "ตลาดเช้า"],
  }),
]));
expect(JSON.stringify(ownerRows)).not.toContain("รอตรวจ");
expect(JSON.stringify(ownerRows)).not.toContain("ชื่อเก่า");
expect(collectorRows.map((row: { publicId: string }) => row.publicId)).toEqual([collectorLoan.publicId]);
expect(JSON.stringify(collectorRows)).not.toContain("hidden-alias");
```

Add a cache regression that lists once, adds and confirms an alias through `addBorrowerAlias`/`confirmBorrowerAlias`, lists again, deactivates it, and lists a third time. Expected arrays are `[]`, `["fresh-alias"]`, then `[]` without waiting for TTL.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
cd backend
./scripts/test-disposable-postgres.sh src/modules/loan-list-borrower-labels.test.ts
```

Expected: FAIL because `borrowerAliases` and `borrowerTags` are absent and alias mutations do not invalidate the cached response.

- [ ] **Step 3: Implement the minimal scoped projection**

In `loan-contract-routes.ts`, include numeric `borrowerId` and `borrowerTags` in the existing visible row projection. Inside the cache loader, fetch only confirmed aliases for the distinct non-null borrower IDs:

```ts
const visibleBorrowerIds = [...new Set(rows.flatMap((row) =>
  row.borrowerId === null ? [] : [row.borrowerId],
))];
const aliasRows = visibleBorrowerIds.length === 0 ? [] : await db.select({
  borrowerId: borrowerAliases.borrowerId,
  alias: borrowerAliases.alias,
}).from(borrowerAliases).where(and(
  eq(borrowerAliases.tenantId, user.tenantId),
  eq(borrowerAliases.status, "confirmed"),
  inArray(borrowerAliases.borrowerId, visibleBorrowerIds),
));
```

Group aliases by borrower ID and return `borrowerAliases: aliasesByBorrower.get(borrowerId) ?? []` plus `borrowerTags: borrowerTags ?? []`. Do not query aliases when no visible borrower IDs exist.

In `borrower-service.ts`, store the transaction result, call `await invalidateTenantCache(ctx.tenantId)` only after the transaction commits, then return the result in both `addBorrowerAlias` and `mutateAlias`. Never invalidate from inside the transaction.

- [ ] **Step 4: Run focused RED/GREEN verification**

Run the disposable command from Step 2 again. Expected: all focused tests PASS with no skipped database test.

- [ ] **Step 5: Run backend gates**

```bash
cd backend
bun run typecheck
./scripts/test-disposable-postgres.sh src/services/borrower-service.test.ts src/modules/loan-list-borrower-labels.test.ts
```

Expected: exit 0, no TypeScript errors, and no skipped targeted integration test.

- [ ] **Step 6: Record and commit the backend change**

Add one `### Added`/`### Fixed` entry under `v0.3.13 - 2026-08-15`, then stage only the four Task 1 files and commit:

```bash
git add backend/src/modules/loan-list-borrower-labels.test.ts backend/src/modules/loan-contract-routes.ts backend/src/services/borrower-service.ts CHANGELOG.md
git diff --cached --check
git commit -m "feat: expose borrower labels on loan list"
```

### Task 2: Pure frontend label and search model

**Files:**
- Create: `frontend/src/pages/dashboard/loans/loan-list-model.ts`
- Create: `frontend/tests/loan-list-model.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: optional `borrowerAliases`/`borrowerTags` arrays from the Task 1 DTO.
- Produces: `getBorrowerLabels(loan): string[]`, `getVisibleBorrowerLabels(loan, limit = 3): { visible: string[]; overflow: number }`, and `loanMatchesSearch(loan, query): boolean`.

- [ ] **Step 1: Write failing pure tests**

Test real functions with hand-derived literals:

```ts
const loan = {
  id: "loan-123",
  publicId: "loan-123",
  borrowerName: "สมหญิง ใจดี",
  borrowerAliases: [" นก ", "VIP", ""],
  borrowerTags: ["vip", "ตลาดเช้า", "เจ้าประจำ"],
};
expect(getBorrowerLabels(loan)).toEqual(["นก", "VIP", "ตลาดเช้า", "เจ้าประจำ"]);
expect(getVisibleBorrowerLabels(loan)).toEqual({ visible: ["นก", "VIP", "ตลาดเช้า"], overflow: 1 });
expect(loanMatchesSearch(loan, "เจ้าประจำ")).toBe(true);
expect(loanMatchesSearch(loan, "loan-123")).toBe(true);
expect(loanMatchesSearch(loan, "ไม่พบ")).toBe(false);
```

Also assert missing/null arrays behave as empty arrays and Unicode case-insensitive duplicate handling preserves the first trimmed value.

- [ ] **Step 2: Run the focused test and verify RED**

```bash
cd frontend
bun x vitest run tests/loan-list-model.test.ts
```

Expected: FAIL because `loan-list-model.ts` does not exist.

- [ ] **Step 3: Implement the minimal pure model**

Define a narrow exported input type and normalize identity with `trim().normalize("NFKC").toLocaleLowerCase("und")` for de-duplication/search. Preserve source order, aliases before tags, ignore blanks, and search canonical name, both arrays, `id`, and `publicId`.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the Step 2 command. Expected: all model tests PASS.

- [ ] **Step 5: Record and commit the model**

Update the existing `v0.3.13` changelog feature entry to mention defensive normalization, then:

```bash
git add frontend/src/pages/dashboard/loans/loan-list-model.ts frontend/tests/loan-list-model.test.ts CHANGELOG.md
git diff --cached --check
git commit -m "feat: add loan list label model"
```

### Task 3: Localized Loan List badges and label-aware search

**Files:**
- Modify: `frontend/src/pages/dashboard/loans/LoanList.tsx`
- Modify: `frontend/tests/loan-list.vitest.tsx`
- Modify: `frontend/src/locales/en.json`
- Modify: `frontend/src/locales/th.json`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: Task 1 DTO arrays and Task 2 helpers.
- Produces: three visible secondary badges, localized accessible overflow text, and label-aware filtering.

- [ ] **Step 1: Write failing component behavior tests**

Extend the API fixture with aliases/tags containing a cross-source duplicate and four unique labels. Render `LoanList`, then assert the first three labels are visible inside the borrower's card, the fourth is not rendered, and `+1` has an accessible label. Add a second loan with omitted arrays and assert it has no label container. Use `userEvent.type` in the real search input to verify a hidden fourth label isolates the correct card. Repeat the search assertion under Thai and assert the localized placeholder/overflow accessible name.

- [ ] **Step 2: Run the component test and verify RED**

```bash
cd frontend
bun x vitest run tests/loan-list.vitest.tsx
```

Expected: FAIL because cards do not render labels and search ignores aliases/tags.

- [ ] **Step 3: Implement the minimal localized UI**

Extend `LoanRow` with optional nullable arrays, replace the inline search predicate with `loanMatchesSearch`, and render `getVisibleBorrowerLabels(loan)` directly below `CardTitle` using the existing `Badge` component with wrapping compact spacing. Render `+N` only when overflow is positive and use:

```tsx
<span aria-label={t("loans.borrowerLabels.more", { count: overflow })}>+{overflow}</span>
```

Add synchronized locale values equivalent to:

```json
"search": "Name, nickname, tag, or loan #",
"borrowerLabels": { "more_one": "1 more borrower label", "more_other": "{{count}} more borrower labels" }
```

and natural Thai copy `ชื่อ ชื่อเล่น แท็ก หรือเลขสัญญา` / `ป้ายกำกับลูกหนี้เพิ่มเติม {{count}} รายการ`. Add a short README Loan Agreements bullet explaining the visible labels and search behavior.

- [ ] **Step 4: Run focused tests and verify GREEN**

```bash
cd frontend
bun x vitest run tests/loan-list-model.test.ts tests/loan-list.vitest.tsx tests/locale-parity.vitest.ts
```

Expected: all focused tests PASS; locale parity reports no missing keys.

- [ ] **Step 5: Run frontend gates**

```bash
cd frontend
bun test
bun run lint
bun run build
```

Expected: exit 0 for the full test suite, lint, TypeScript build, and Vite production build.

- [ ] **Step 6: Record and commit the user-facing feature**

Update `CHANGELOG.md` under `v0.3.13`, verify README wording matches the shipped behavior, then:

```bash
git add frontend/src/pages/dashboard/loans/LoanList.tsx frontend/tests/loan-list.vitest.tsx frontend/src/locales/en.json frontend/src/locales/th.json README.md CHANGELOG.md
git diff --cached --check
git commit -m "feat: show borrower labels on loan cards"
```

### Task 4: Final cross-layer verification and scope audit

**Files:**
- Verify only; modify files only to fix a demonstrated failure through a new RED/GREEN cycle.

**Interfaces:**
- Consumes: completed backend contract and frontend feature.
- Produces: fresh evidence that the approved spec and repository gates pass at HEAD.

- [ ] **Step 1: Run complete relevant verification**

```bash
cd backend
./scripts/test-disposable-postgres.sh src/services/borrower-service.test.ts src/modules/loan-list-borrower-labels.test.ts
bun run typecheck
cd ../frontend
bun test
bun run lint
bun run build
cd ..
git diff --check HEAD~3..HEAD
```

- [ ] **Step 2: Audit requirements and repository state**

Confirm from actual JSON/tests that only confirmed aliases ship, both arrays are scoped to visible loans, hidden labels remain searchable, no empty row renders, copy is bilingual, README/CHANGELOG match, and no financial field changed. Run `git status --short` and distinguish pre-existing dirty files from feature changes.

- [ ] **Step 3: Inspect commit contents**

```bash
git log --oneline -4
git show --stat --oneline HEAD~2..HEAD
```

Expected: three focused implementation commits after the documentation commits, with no unrelated tracked files included. Do not push, deploy, or merge without explicit authorization.
