# Floating Due Payment Consistency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent floating-loan payment posts from using a component split that differs from the displayed due amount.

**Architecture:** Derive and persist a component quote during payment preview, then recompute and compare it under the post transaction lock. Reuse the floating-accrual projection for health and posting, and keep restore-preview output aligned with its public MCP schema.

**Tech Stack:** Bun, TypeScript, Elysia, Drizzle, PostgreSQL, decimal.js, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-03-floating-due-payment-consistency-design.md`

## Global Constraints

- Keep money as two-decimal decimal strings; do not use JavaScript Number for financial amounts.
- Use Asia/Bangkok business dates.
- Financial writes are append-only and stale proposals must not write transactions.
- Preserve the existing dirty `AGENTS.md` in the primary worktree.

---

### Task 1: Component quote for a floating payment preview

**Files:**
- Modify: `backend/src/services/payment-service.ts`
- Test: `backend/src/services/floating-allocation-regressions.test.ts`

**Interfaces:**
- Produces: a persisted, public component split for a floating payment proposal.
- Consumes: `floatingPaymentObligations` and `FinancialDecimal`.

- [ ] **Step 1: Write the failing test**

Create an active weekly floating loan with an unpaid 600.00 period due today;
create a 600.00 intake and preview it. Assert the preview’s component quote is
`{ principal: "0.00", interest: "600.00", fee: "0.00", penalty: "0.00" }`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test backend/src/services/floating-allocation-regressions.test.ts`

Expected: the preview has no component quote or returns a different split.

- [ ] **Step 3: Write minimal implementation**

Extract the existing floating posting priority (carried charges, current
penalty, current interest, principal) into a reusable quote helper. Include its
decimal-string output in the proposal’s persisted/hashable representation.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test backend/src/services/floating-allocation-regressions.test.ts`

Expected: PASS with the literal 600.00 interest quote.

### Task 2: Stale protection and exact posting

**Files:**
- Modify: `backend/src/services/payment-service.ts`
- Test: `backend/src/services/floating-allocation-regressions.test.ts`

**Interfaces:**
- Consumes: the Task 1 preview component quote.
- Produces: only transactions whose component fields equal the approved quote.

- [ ] **Step 1: Write the failing test**

Preview a due floating payment, alter the relevant accrual/paid state before
post, and assert `postPayment` returns stale with no new repayment transaction.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test backend/src/services/floating-allocation-regressions.test.ts`

Expected: current code posts a recomputed split instead of rejecting it.

- [ ] **Step 3: Write minimal implementation**

Under the existing post lock, recompute the floating quote and compare every
component to the proposal quote. Mark the proposal stale and return the normal
stale result on mismatch; otherwise use the approved values when inserting the
transaction and floating allocation rows.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test backend/src/services/floating-allocation-regressions.test.ts`

Expected: PASS; no transaction is created for the stale proposal.

### Task 3: Public contract and UI confirmation

**Files:**
- Modify: `backend/src/mcp/server.ts`
- Modify: `frontend/src/pages/dashboard/loans/*Payment*.tsx` or the existing payment-preview consumer
- Modify: `frontend/src/locales/en.json`
- Modify: `frontend/src/locales/th.json`
- Test: the existing relevant frontend component test or a new focused test

**Interfaces:**
- Consumes: public payment-preview component quote.
- Produces: a confirmation view showing interest, principal, fee, and penalty.

- [ ] **Step 1: Write the failing contract/UI test**

Assert the payment-preview public schema accepts the four component quote
fields and that the confirmation view renders a literal `Interest ฿600.00` and
`Principal ฿0.00` for the quote fixture.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test backend/src/mcp/default.test.ts` and the selected frontend test.

Expected: the quote is absent from the public schema and confirmation UI.

- [ ] **Step 3: Write minimal implementation**

Extend the payment-preview MCP schema and frontend response type. Render exact
money strings for the four components in the pre-post confirmation surface,
using matching English and Thai translation keys.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test backend/src/mcp/default.test.ts` and the selected frontend test.

Expected: PASS.

### Task 4: Restore-preview contract repair and verification

**Files:**
- Modify: `backend/src/mcp/server.ts` and/or `backend/src/services/payment-reconciliation-service.ts`
- Test: `backend/src/mcp/default.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces: a restore-preview response accepted by the MCP output validator.

- [ ] **Step 1: Write the failing test**

Use the existing evidence-backed reversed-payment fixture, finalize child
evidence, call `payment.restore.preview`, and assert the MCP call succeeds
with a ready preview.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test backend/src/mcp/default.test.ts`

Expected: `INVALID_TOOL_OUTPUT`.

- [ ] **Step 3: Write minimal implementation**

Make the restore preview’s returned fields exactly match `restorePreviewOutput`
without changing financial components or restore execution semantics.

- [ ] **Step 4: Run verification**

Run: `backend/scripts/test-disposable-postgres.sh`, `bun run --cwd backend typecheck`, and frontend test/lint/build commands from package scripts.

- [ ] **Step 5: Update changelog and commit**

Add a dated version entry describing the floating quote/stale guard and
restore-preview contract repair, then commit code, tests, locales, and
changelog together.
