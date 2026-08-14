# App-wide Table Pagination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add consistent, localized pagination to every CreditSync table, using server-side pages for persistent records and client-side pages for finite authoritative previews.

**Architecture:** A shared frontend `DataTablePagination` renders navigation for both modes, while a pure `useClientPagination` hook slices preview rows without touching financial calculations. Persistent REST reads return a common `Page<T>` envelope and use stable tenant-bound database ordering; URL search parameters own persistent table state.

**Tech Stack:** Bun, React 19, React Router, TypeScript, Tailwind/shadcn UI, i18next, Elysia, Drizzle ORM, PostgreSQL, Vitest, Testing Library.

## Global Constraints

- Persistent collections use server-side pagination; finite authoritative previews use client-side pagination.
- Persistent page state lives in URL query parameters; preview page state stays local.
- Persistent page sizes are exactly `10`, `25`, and `50`, defaulting to `10`; preview page size is fixed at `10`.
- Pagination must never recalculate, round, reorder, or mutate financial values; money remains an exact two-decimal string formatted by existing exact-money helpers.
- All persistent database queries are tenant/access scoped and deterministically ordered with a unique tie-breaker.
- Frontend copy must be added to both `frontend/src/locales/en.json` and `frontend/src/locales/th.json`.
- Do not change financial write, preview, confirmation, posting, reversal, MCP, or plugin contracts.
- Do not add a database migration or a new data-grid dependency.
- Preserve unrelated dirty files and update `CHANGELOG.md` before every commit; update `README.md` in the final feature commit because this changes an app-wide user workflow.

---

### Task 1: Shared pagination models, component, hook, and URL helpers

**Files:**
- Create: `frontend/src/components/ui/DataTablePagination.tsx`
- Create: `frontend/src/lib/pagination.ts`
- Create: `frontend/tests/data-table-pagination.vitest.tsx`
- Modify: `frontend/src/locales/en.json`
- Modify: `frontend/src/locales/th.json`

**Interfaces:**
- Produces: `Page<T> = { items: T[]; page: number; pageSize: number; total: number; totalPages: number }`.
- Produces: `parsePagination(searchParams, prefix?)`, `writePagination(searchParams, { page, pageSize }, prefix?)`, and `useClientPagination<T>(items, resetKey, 10)`.
- Produces: `<DataTablePagination page pageSize total totalPages disabled onPageChange onPageSizeChange? pageSizeOptions? hideWhenSinglePage? />`.

- [ ] **Step 1: Write failing component/helper tests** covering zero-data hiding, persistent one-page visibility, preview one-page hiding, localized range/page labels, all four boundary buttons, clamping, `10/25/50`, preservation of unrelated URL parameters, invalid URL normalization, client slicing, and reset-key changes.
- [ ] **Step 2: Run `bun run test -- data-table-pagination.vitest.tsx`** and confirm missing-module failures.
- [ ] **Step 3: Implement pure helpers and component.** Use one-based pages and compute `first = total === 0 ? 0 : (page - 1) * pageSize + 1`, `last = Math.min(page * pageSize, total)`. `writePagination` must clone `URLSearchParams`, preserve unrelated keys, and use namespaced keys `${prefix}Page` / `${prefix}PageSize` when a prefix exists.
- [ ] **Step 4: Add paired `common.pagination` keys** for range, page summary, rows per page, first, previous, next, and last.
- [ ] **Step 5: Run the focused test, full frontend test, and lint.** Expected: all pass.
- [ ] **Step 6: Update `CHANGELOG.md`, stage only Task 1 files, and commit** with `feat: add shared table pagination controls`.

### Task 2: Shared backend pagination contract and transaction list

**Files:**
- Create: `backend/src/lib/pagination.ts`
- Create: `backend/src/lib/pagination.test.ts`
- Modify: `backend/src/modules/transactions.ts`
- Create: `backend/src/modules/transactions.test.ts`
- Modify: `frontend/src/pages/dashboard/transactions/TransactionList.tsx`
- Modify: `frontend/tests/transaction-list.vitest.tsx`

**Interfaces:**
- Produces: `paginationQuerySchema` accepting optional integer `page` and `pageSize` with supported sizes only.
- Produces: `normalizePagination(input): { page: number; pageSize: 10 | 25 | 50; offset: number }` and `pageEnvelope(items, page, pageSize, total)`.
- Changes `GET /transactions` to return `Page<TransactionDto>` sorted by `transactionDate DESC, id DESC`.

- [ ] **Step 1: Write failing backend tests** for defaults, invalid page/pageSize `400`, tenant/access isolation, stable same-date tie ordering, page metadata, empty/out-of-range pages, and exact string money.
- [ ] **Step 2: Run focused backend tests with `bun test src/lib/pagination.test.ts src/modules/transactions.test.ts`** and confirm RED.
- [ ] **Step 3: Implement count plus limited transaction query.** Include `page` and `pageSize` in the tenant-cache key and resolve signed slip URLs only for the returned page.
- [ ] **Step 4: Update Transaction List tests first** to expect `Page<TransactionDto>`, URL restoration, page changes, page-size reset to 1, unrelated-query preservation, and no stale page rows.
- [ ] **Step 5: Implement Transaction List with shadcn `Table` and `DataTablePagination`.** Use the default `page/pageSize` URL keys and retain exact amount color/slip behavior.
- [ ] **Step 6: Run focused backend/frontend tests, backend typecheck, frontend lint.** Expected: all pass.
- [ ] **Step 7: Update `CHANGELOG.md`, stage Task 2 files, and commit** with `feat: paginate transaction history`.

### Task 3: Loan schedule and repayment-history server pages

**Files:**
- Modify: `backend/src/modules/loan-contract-routes.ts`
- Modify: `backend/src/modules/loan-payment-history-routes.ts`
- Modify: `backend/src/services/payment-service.ts`
- Modify: `backend/src/modules/loan-payment-history.test.ts`
- Modify or create: `backend/src/modules/loan-contract-routes.test.ts`
- Modify: `frontend/src/pages/dashboard/loans/LoanDetail.tsx`
- Modify: `frontend/src/pages/dashboard/loans/LoanRepaymentHistory.tsx`
- Modify: `frontend/tests/loan-detail-schedule.vitest.tsx`
- Modify: `frontend/tests/loan-repayment-history.vitest.tsx`

**Interfaces:**
- `GET /loans/:id/schedule?page=&pageSize=` returns `Page<LoanScheduleRowDto>` ordered by `installmentNo ASC, id ASC`.
- `GET /loans/:id/payment-intakes?page=&pageSize=` returns `Page<LoanPaymentHistoryDto>` ordered by `receivedAt DESC, id DESC` after determining loan membership without exposing other-loan intakes.
- URL prefixes are `schedule` and `repayments` because both controls share Loan Detail search parameters.

- [ ] **Step 1: Write failing backend tests** for metadata, second pages, deterministic ordering, tenant/access isolation, loan membership, allocation/components restricted to returned intake IDs, invalid inputs, and exact strings.
- [ ] **Step 2: Run focused backend tests** and confirm existing array responses fail.
- [ ] **Step 3: Implement schedule count/limit/offset and refactor `listLoanPaymentIntakes`** so filtering occurs in SQL/existence conditions before count and page fetch; do not page the tenant-wide candidate array in memory.
- [ ] **Step 4: Write failing frontend integration tests** asserting `schedulePage/schedulePageSize` and `repaymentsPage/repaymentsPageSize`, 10 visible rows, independent navigation, refresh restoration, and out-of-range URL correction.
- [ ] **Step 5: Implement the two page consumers.** Remove `schedule.slice(0, 8)`; use response metadata; keep `nextDueRow` correctness by deriving it from loan/payment-health authority rather than assuming the displayed page contains the next due row.
- [ ] **Step 6: Run focused suites, backend typecheck, frontend lint/build.** Expected: all pass.
- [ ] **Step 7: Update `CHANGELOG.md`, stage Task 3 files, and commit** with `feat: paginate loan detail tables`.

### Task 4: Intermediary managed-loan server page without changing MCP

**Files:**
- Modify: `backend/src/services/intermediary-profile-service.ts`
- Modify: `backend/src/modules/intermediaries.ts`
- Modify: `backend/src/modules/intermediaries.test.ts`
- Modify: `frontend/src/pages/dashboard/intermediaries/IntermediaryDetail.tsx`
- Modify: `frontend/tests/intermediary-profile.vitest.tsx`

**Interfaces:**
- Keep the existing service/MCP `listManagedLoans(ctx, id, { role })` array contract.
- Add a REST-only paged adapter/service function returning `Page<ManagedLoan>` so the frozen MCP contract is unchanged.
- `GET /intermediaries/:id/managed-loans?role=&page=&pageSize=` returns the page ordered by `nextDueDate ASC NULLS LAST, loan.id ASC`; duplicate roles remain grouped per loan before page boundaries.
- URL prefix is `managedLoans`.

- [ ] **Step 1: Write failing REST tests** for grouped-loan counts, role filtering before pagination, tenant/access isolation, stable page boundaries, and exact totals.
- [ ] **Step 2: Run `bun test src/modules/intermediaries.test.ts`** and confirm RED.
- [ ] **Step 3: Implement a distinct-loan page query followed by assignments for only those loan IDs.** Do not slice duplicated assignment rows before grouping.
- [ ] **Step 4: Write failing frontend tests** for one shared responsive table, URL restoration, `10/25/50`, and retained links/roles.
- [ ] **Step 5: Replace the split mobile-list/desktop-table rendering with shadcn `Table` plus the common footer.** Preserve all profile totals and non-table sections.
- [ ] **Step 6: Run focused tests plus backend typecheck and frontend lint/build.** Expected: all pass.
- [ ] **Step 7: Update `CHANGELOG.md`, stage Task 4 files, and commit** with `feat: paginate intermediary managed loans`.

### Task 5: Fund Detail persistent tables

**Files:**
- Modify: `backend/src/modules/bank-loans.ts`
- Modify: `backend/src/modules/bank-loans.test.ts`
- Modify: `backend/src/modules/bank-profiles.ts`
- Modify: `backend/src/modules/bank-profiles.test.ts`
- Modify: `frontend/src/pages/dashboard/funds/FundDetail.tsx`
- Modify: `frontend/tests/fund-detail.vitest.tsx`

**Interfaces:**
- Page the Bank Loan list, schedule, repayments, allocations, and funding-usage allocations with the shared envelope and stable unique tie-breakers.
- Use Fund Detail URL prefixes `bankLoans`, `drawdownSchedule`, `drawdownRepayments`, `drawdownAllocations`, and `fundingUsage`.
- Keep profitability, settlement summaries, selected-row lookup, and posting payloads separate from visible page data.

- [ ] **Step 1: Inventory every caller of the five affected reads** and write it into the test names/fixtures; update all callers deliberately.
- [ ] **Step 2: Write failing backend pagination tests** for each endpoint, including admin authorization, tenant scope, filter-before-count, deterministic order, exact money, empty, and out-of-range pages.
- [ ] **Step 3: Implement count/page queries and cache-key pagination.** Never convert money with `Number`; if touched presentation currently does so, replace it with the existing exact formatter without altering persisted calculations.
- [ ] **Step 4: Write failing Fund Detail tests** proving each table has independent URL state, modal selection/record-repayment still targets the exact public ID, and complete authoritative summaries do not depend on the visible page.
- [ ] **Step 5: Implement shadcn tables and common pagination footers.** Fetch complete data only for non-tabular calculations that have a dedicated summary endpoint; never re-sum a visible page as a global total.
- [ ] **Step 6: Run bank/fund disposable PostgreSQL tests serially via `backend/scripts/test-disposable-postgres.sh` using the script's supported test-file arguments, then backend typecheck and frontend focused tests/lint/build.** Expected: all pass.
- [ ] **Step 7: Update `CHANGELOG.md`, stage Task 5 files, and commit** with `feat: paginate fund detail tables`.

### Task 6: All authoritative preview tables

**Files:**
- Modify: `frontend/src/pages/dashboard/loans/LoanWizard.tsx`
- Modify: `frontend/src/pages/dashboard/loans/LoanRenewalPanel.tsx`
- Modify: `frontend/src/pages/dashboard/loans/LoanRestructurePanel.tsx`
- Modify: `frontend/src/pages/dashboard/funds/FundDetail.tsx`
- Modify: `frontend/tests/loan-wizard.vitest.tsx`
- Modify: `frontend/tests/loan-renewal-panel.vitest.tsx`
- Modify: `frontend/tests/loan-restructure-panel.vitest.tsx`
- Modify: `frontend/tests/fund-detail.vitest.tsx`

**Interfaces:**
- Every preview table consumes the complete backend-provided row array but renders `useClientPagination(rows, previewIdentity, 10).items`.
- Confirmation/execution continues to consume the complete preview object/array.

- [ ] **Step 1: Write failing tests with 11+ rows** for page 2, fixed size 10, reset after a new preview ID/hash/row identity, and hidden footer for 10 rows or fewer.
- [ ] **Step 2: Add regression assertions** that execute/confirm payloads and displayed totals still use the full authoritative preview rather than the visible slice.
- [ ] **Step 3: Run focused tests** and confirm RED.
- [ ] **Step 4: Convert remaining raw preview tables to shadcn `Table`, apply client pagination, and place the footer outside horizontal scroll containers.** Do not add preview URL parameters.
- [ ] **Step 5: Run all affected frontend tests, lint, and build.** Expected: all pass.
- [ ] **Step 6: Update `CHANGELOG.md`, stage Task 6 files, and commit** with `feat: paginate financial preview tables`.

### Task 7: Payment Inbox migration and policy documentation

**Files:**
- Modify: `frontend/src/pages/dashboard/payments/PaymentInboxList.tsx`
- Modify: `frontend/src/pages/dashboard/payments/payment-inbox-list-model.ts`
- Modify: `frontend/tests/payment-inbox.vitest.tsx`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Payment Inbox keeps its current `PaymentIntakePage` server response and replaces custom previous/next controls with `DataTablePagination`.
- Its URL keys remain `page` and `pageSize`; filters reset page 1.

- [ ] **Step 1: Write failing Payment Inbox tests** for first/previous/next/last, page-size selection, range, filter reset, and URL restoration.
- [ ] **Step 2: Replace custom controls with the shared component** and align model types with `Page<PaymentIntakeListItem>` without changing backend payment contracts.
- [ ] **Step 3: Document common table navigation in `README.md`.** Include server/client classification, URL state, exact-money prohibition, and test requirements. Do not edit the source checkout's dirty `AGENTS.md`; the supervisor owns adding the same approved rule there while preserving the user's unrelated uncommitted instructions.
- [ ] **Step 4: Consolidate the `v0.3.13` changelog entry** so it accurately describes the entire staged app-wide change without duplicate bullets.
- [ ] **Step 5: Run focused Payment Inbox tests and `git diff --check`.** Expected: pass and no whitespace errors.
- [ ] **Step 6: Commit** with `docs: standardize paginated table workflows`, including `README.md`, Payment Inbox changes, locales, and changelog.

### Task 8: Full verification, review, and deployment readiness

**Files:**
- Modify only files required to fix verification findings; update `CHANGELOG.md` in the same fix commit.

- [ ] **Step 1: Run `bun test` and `bun run typecheck` in `backend/`.** Expected: pass.
- [ ] **Step 2: Run all changed database-backed test files through `backend/scripts/test-disposable-postgres.sh` serially.** Expected: pass with no skipped invariant test.
- [ ] **Step 3: Run `bun run test && bun run lint && bun run build` in `frontend/`.** Expected: pass.
- [ ] **Step 4: Search every frontend table with `rg -n '<Table|<table' frontend/src`** and prove each application table has either `DataTablePagination` or an explicit <=10-row non-collection justification documented in the spec/plan. No raw application table may be silently omitted.
- [ ] **Step 5: Search for unsafe touched money conversion with `rg -n 'Number\(|parseFloat\(' <changed-files>`** and eliminate any pagination-related conversion of financial values.
- [ ] **Step 6: Run `git diff --check`, inspect `git status --short`, review every commit/diff against the approved spec, and ensure no MCP/plugin/schema changes or unrelated dirty files entered commits.**
- [ ] **Step 7: If fixes are needed, add a focused regression test, update `CHANGELOG.md`, and commit the fix.** Re-run the affected gate plus all full gates.
- [ ] **Step 8: Report branch HEAD, commits, exact test counts, verification output, and any justified exclusions to the supervising agent. Do not merge, push, or deploy; the supervisor owns authorized integration and production deployment.**

## Supervisor Integration and Deployment Gates

1. Independently inspect the worker diff and rerun full backend/frontend gates at worker HEAD.
2. Preserve unrelated source-checkout changes; merge the feature branch into `main` only after clean verification.
3. Add the approved table-design pagination rule to the source checkout's already-dirty `AGENTS.md` without discarding or committing unrelated user-owned edits; verify the rule is present after integration.
4. Prove integration with `git merge-base --is-ancestor <feature-branch> main`.
5. Record current backend/frontend container image IDs and start times.
6. Because REST contracts change, deploy backend first, verify internal `http://127.0.0.1:3000/mcp/health`, then deploy frontend. Use production compose files and do not use `--remove-orphans`.
7. Verify both containers are running, public frontend and local `http://127.0.0.1:8088/` return `200`, backend logs show no migration/error regression, and representative paginated GETs are healthy without creating production records.
8. Distinguish merge, push, and deploy in the final report. Push is not authorized by this request.
