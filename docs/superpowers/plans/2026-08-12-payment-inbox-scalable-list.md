# Payment Inbox Scalable List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace nested payment cards with a responsive flat list backed by tenant-safe server-side search, filters, and pagination.

**Architecture:** Extend the existing payment application service with one validated list-query contract that composes tenant/owner scope with optional filters and executes filtered count and page queries. Keep list presentation in a focused frontend component/model while `PaymentInbox` retains detail and financial workflow state.

**Tech Stack:** Bun, TypeScript, Elysia, Drizzle/PostgreSQL, React 19, react-i18next, Tailwind CSS, Vitest/Testing Library.

## Global Constraints

- Public money remains exact two-decimal strings and continues through `formatMoneyExact`; do not use `Number` for money.
- Date filters are `YYYY-MM-DD` business dates in `Asia/Bangkok` and include the complete selected day.
- English and Thai user-facing copy must be updated together.
- The default page size is 25 and the backend cap is 100.
- Existing payment preview, post, evidence, reversal, audit, owner-scope, and tenant-scope behavior must remain unchanged.

---

### Task 1: Paginated payment-intake query contract

**Files:**
- Modify: `backend/src/services/payment-service.ts`
- Modify: `backend/src/modules/payment-intakes.ts`
- Test: `backend/src/modules/payment-intakes.test.ts`

**Interfaces:**
- Consumes: `CommandContext` and the existing payment-intake access rules.
- Produces: `listPaymentIntakes(ctx, input: PaymentIntakeListInput): Promise<PaymentIntakePage>` where the page contains `items`, `page`, `pageSize`, `total`, and `totalPages`.

- [ ] **Step 1: Write the failing integration tests**

Add fixtures across tenant/owner, status, payer name, and Bangkok date boundaries. Assert a request such as `/payment-intakes?search=สมชาย&status=ready&from=2026-08-11&to=2026-08-11&page=2&pageSize=2` returns literal pagination metadata and only matching newest-first rows. Add invalid status/date/page/pageSize cases expecting `400` and `INVALID_PAYMENT_LIST_QUERY`.

- [ ] **Step 2: Verify the focused backend test fails**

Run: `cd backend && ../backend/scripts/test-disposable-postgres.sh src/modules/payment-intakes.test.ts`

Expected: FAIL because the route only accepts `status` and returns a bare array.

- [ ] **Step 3: Implement validation and the filtered page query**

Define the closed status set, strict date pattern/calendar validation, integer parsing, Bangkok UTC boundaries (`00:00 +07:00` through the next day exclusive), escaped case-insensitive payer search, count query, stable `receivedAt DESC, id DESC` ordering, `limit`, and `offset`. Preserve tenant and non-wide-role owner predicates in both count and page queries.

Update the Elysia query schema to accept only optional strings for `search`, `status`, `from`, `to`, `page`, and `pageSize`, then pass all values to the service.

- [ ] **Step 4: Verify the backend test passes**

Run: `cd backend && ../backend/scripts/test-disposable-postgres.sh src/modules/payment-intakes.test.ts`

Expected: PASS with filtering, pagination metadata, validation, and access scope protected.

- [ ] **Step 5: Commit the backend slice with its changelog update**

Update the v0.3.10 `Added` entry to describe the implemented API, then stage backend tests/service/route and `CHANGELOG.md` and commit `feat: paginate payment intake queries`.

### Task 2: Responsive flat inbox list

**Files:**
- Create: `frontend/src/pages/dashboard/payments/payment-inbox-list-model.ts`
- Create: `frontend/src/pages/dashboard/payments/PaymentInboxList.tsx`
- Modify: `frontend/src/pages/dashboard/payments/PaymentInbox.tsx`
- Modify: `frontend/src/locales/en.json`
- Modify: `frontend/src/locales/th.json`
- Test: `frontend/tests/payment-inbox.vitest.tsx`

**Interfaces:**
- Consumes: `GET /payment-intakes` page response from Task 1 and callbacks `onSelect(publicId)` and `onQueryChange(query)`.
- Produces: `PaymentInboxList` with typed `PaymentInboxQuery`, `PaymentIntakeSummary`, and `PaymentIntakePage` contracts; pure `toPaymentInboxParams(query)` serializes request parameters.

- [ ] **Step 1: Write failing frontend behavior tests**

Change the default list fixture to the paginated response. Add tests that assert the real UI has one list container with divider-separated buttons, no per-row bordered card marker, accessible search/status/date controls, a literal `1–2 of 27` result summary, and enabled next navigation. Assert typing a search and changing a status resets page to one and results in request params `{ search: "Borrower", status: "ready", page: "1", pageSize: "25" }`; assert next requests page `2` while retaining filters.

- [ ] **Step 2: Verify the frontend test fails**

Run: `cd frontend && bun test tests/payment-inbox.vitest.tsx`

Expected: FAIL because controls, page response handling, and flat list semantics do not exist.

- [ ] **Step 3: Implement the pure query model and flat list component**

Create types and a serializer that omits empty filters but always emits page and page size. Render a compact filter grid, `role="list"`, `role="listitem"` rows separated by `divide-y`, selected `aria-current="true"`, stacked mobile metadata, aligned desktop status/amount, localized result range, and previous/next buttons. Use a subtle selected background and inset accent without a per-row border/radius.

- [ ] **Step 4: Wire server state into `PaymentInbox`**

Replace `items` with page metadata and query state. Fetch payment intakes with `params: toPaymentInboxParams(query)`, retain the existing parallel active-loan fetch only for initial load/refresh, reset to page one on filter changes, and retain query/page through manual refresh and detail mutations. If a mutation leaves a non-first page empty, move to the previous page.

- [ ] **Step 5: Add synchronized translations**

Add English and Thai keys for search placeholder, all statuses, from/to labels, clear filters, result range, previous page, next page, and filtered empty state.

- [ ] **Step 6: Verify focused frontend tests pass**

Run: `cd frontend && bun test tests/payment-inbox.vitest.tsx`

Expected: PASS including all pre-existing payment workflow tests.

- [ ] **Step 7: Commit the frontend slice with its changelog update**

Update the v0.3.10 `Changed` section with the flat responsive list behavior, stage component/model/tests/locales and `CHANGELOG.md`, then commit `feat: scale payment inbox navigation`.

### Task 3: Full verification and production-readiness review

**Files:**
- Modify if verification finds a defect: only files from Tasks 1-2
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: completed backend and frontend slices.
- Produces: verified build with no skipped financial-invariant coverage for the changed list contract.

- [ ] **Step 1: Run backend verification**

Run `cd backend && ./scripts/test-disposable-postgres.sh` and `cd backend && bun run typecheck`. Expected: all tests pass and TypeScript reports no errors.

- [ ] **Step 2: Run frontend verification**

Run `cd frontend && bun test`, `cd frontend && bun run lint`, and `cd frontend && bun run build`. Expected: all tests pass, lint reports no errors, and Vite completes a production build.

- [ ] **Step 3: Inspect the final diff and changelog**

Run `git diff --check`, `git status --short`, and review every changed hunk. Confirm the changelog version/date/type accurately describes the staged implementation and no secret or unrelated file is present.

- [ ] **Step 4: Commit verification fixes if needed**

If verification required code changes, re-run the focused failing/passing test cycle, update `CHANGELOG.md`, stage only in-scope files, and commit `fix: verify scalable payment inbox`.
