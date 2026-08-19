# Payment Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an explicit, auditable MCP workflow that corrects posted payment allocations, including historical floating payments before exact-ledger cutover.

**Architecture:** Add reconciliation orchestration beside the existing payment service. Preview computes and persists an immutable correction proposal; execute locks all affected records and appends compensating reversal and corrected allocation records in one transaction. MCP exposes only the preview and confirmed execute operations, with closed schemas and idempotent command context.

**Tech Stack:** Bun, TypeScript, Elysia MCP, Drizzle ORM, PostgreSQL, decimal.js, Vitest/Bun tests, plugin contract validator.

**Spec:** `docs/superpowers/specs/2026-08-20-payment-reconciliation-design.md`

## Global Constraints

- Money crosses public interfaces as two-decimal decimal strings and must be calculated with `decimal.js`; never use JavaScript floating point or `Number` for financial values.
- Active loan terms and posted financial records are immutable; corrections are append-only compensating reversal/adjustment records with a reason.
- Every financial write needs command context, request/correlation ID, actor/source, idempotency key, and append-only audit history.
- MCP accepts/returns public UUIDs and two-decimal money strings only; write tools return audit public ID and correlation ID.
- Preview precedes every financial execute operation; stale, ambiguous, duplicate, or mismatched state stops for review.

### Task 1: Define reconciliation persistence and delta kernel

**Files:**
- Modify: `backend/src/db/schema.ts`
- Create: `backend/drizzle/0048_payment_reconciliation.sql`
- Create: `backend/src/services/payment-reconciliation-service.ts`
- Test: `backend/src/services/payment-reconciliation-service.test.ts`

- [ ] Write failing tests for exact component deltas, source linkage, cutover-date correction, amount conservation, and negative-balance rejection.
- [ ] Run the focused disposable PostgreSQL test and confirm the new tests fail for the missing service/schema.
- [ ] Add append-only reconciliation proposal/group and entry tables following existing tenant/public-id/audit/idempotency constraints. Store source payment, preview hash, expected state version, status, reason, and correction entries.
- [ ] Implement `previewPaymentReconciliation(ctx, input)` and `executePaymentReconciliation(ctx, previewPublicId, input)` with deterministic lock order and decimal-only arithmetic.
- [ ] Ensure reversal entries point to source allocation/transaction IDs and historical entries carry an explicit cutover/manual-reconciliation reason.
- [ ] Re-run focused tests and confirm they pass.
- [ ] Commit as `feat: add auditable payment reconciliation kernel`.

### Task 2: Harden ordinary floating allocation and payment reversal integration

**Files:**
- Modify: `backend/src/services/payment-service.ts`
- Modify: `backend/src/services/floating-interest-service.ts` only where the reconciliation kernel requires an active-allocation query helper
- Test: `backend/src/services/floating-allocation-regressions.test.ts`

- [ ] Add failing regression tests showing compensated later allocations do not block an approved reconciliation while active later allocations still do.
- [ ] Add a shared query/helper that defines active allocation as a payment allocation without a compensating reversal.
- [ ] Use the helper in backdated blocker checks and reversal validation without weakening ordinary payment posting.
- [ ] Verify historical corrections do not create duplicate accrual payments or negative paid amounts.
- [ ] Run the focused disposable PostgreSQL regressions and the payment service suite.
- [ ] Commit as `fix: distinguish compensated floating allocations`.

### Task 3: Expose closed MCP preview and execute tools

**Files:**
- Modify: `backend/src/mcp/server.ts`
- Modify: `backend/src/mcp/tools/payment-tools.ts` or the repository’s current payment-tool module
- Test: `backend/src/mcp/default.test.ts`
- Test: `backend/src/mcp/security.test.ts`
- Test: `backend/src/mcp/server.test.ts`

- [ ] Add failing contract tests for `payment_reconcile_preview` and `payment_reconcile_execute` schemas, confirmation, reason, idempotency, and audit output.
- [ ] Register closed input/output schemas with read/write/destructive annotations consistent with existing payment tools.
- [ ] Route preview and execute directly to the reconciliation service; MCP must not call the REST API internally.
- [ ] Return structured data plus a readable summary, without raw identity-card values, signed URLs, or evidence contents.
- [ ] Add idempotency conflict and stale-preview error mapping.
- [ ] Run MCP tests and contract validator.
- [ ] Commit as `feat: expose payment reconciliation MCP workflow`.

### Task 4: Synchronize plugin contract and documentation

**Files:**
- Modify: `plugins/creditsync/.app.json`
- Modify: `plugins/creditsync/.codex-plugin/plugin.json`
- Modify: `plugins/creditsync/references/mcp-tool-contract.json`
- Modify: `plugins/creditsync/skills/reconcile-payments/SKILL.md`
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Test: plugin tests and validator commands defined by the repository

- [ ] Add the two tools, schemas, safety notes, and examples to the frozen plugin contract.
- [ ] Document preview → confirm → execute and historical reconciliation behavior.
- [ ] Update README workflow guidance if user-facing MCP usage changes.
- [ ] Add a changelog entry under a new explicit version/date heading.
- [ ] Run plugin tests and validator.
- [ ] Commit as `docs: document payment reconciliation workflow`.

### Task 5: End-to-end verification and handoff

**Files:**
- Modify only files required by prior tasks
- Test: backend disposable suite, typecheck, MCP/plugin validator, frontend checks if impacted

- [ ] Run backend disposable PostgreSQL tests serially and typecheck.
- [ ] Run frontend test/lint/build if shared MCP types or user-facing UI changed.
- [ ] Inspect final diff for unrelated changes and verify dirty user files remain untouched.
- [ ] Build/restart the production-style backend only after all tests pass.
- [ ] Check backend MCP health from inside the container and inspect logs for startup/migration errors.
- [ ] Run a read-only contract/preview smoke test in the configured tenant; do not create or post live financial data during verification.
- [ ] Report branch commit, test results, deployment status, and any remaining data-repair action separately.
