# Restore Draft Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a mistakenly reversed payment be restored through an evidence-bearing linked draft while preserving immutable source and ledger history.

**Architecture:** Extend the exact restore service so it creates one draft child before evidence upload. Preview and execution operate on that child, require its finalized evidence, derive all financial components from the reversed source, and post the same child atomically.

**Tech Stack:** Bun, TypeScript, Drizzle ORM, PostgreSQL, Decimal.js, CreditSync MCP and plugin contract.

**Spec:** `docs/superpowers/specs/2026-08-25-restore-draft-evidence-design.md`

## Global Constraints

- Money remains two-decimal strings and all financial arithmetic uses `decimal.js`.
- Financial writes are append-only and require actor, reason, request/correlation context, audit history, and idempotency.
- The source payment remains `reversed`; normal duplicate protection remains enabled.
- Do not deploy, push, merge, or create production financial data.

### Task 1: Restore-draft service behavior

**Files:**
- Modify: `backend/src/services/payment-reconciliation-service.test.ts`
- Modify: `backend/src/services/payment-reconciliation-service.ts`

- [ ] Write a failing integration test that creates a fully reversed `83.33` principal / `16.67` interest source without evidence, calls `payment.restore.create`, and asserts exactly one linked `draft` child with no financial transactions or copied bank reference.
- [ ] Run `cd backend && ./scripts/test-disposable-postgres.sh ./src/services/payment-reconciliation-service.test.ts`; verify the new test fails because create is unavailable.
- [ ] Implement idempotent `createPaymentRestoreDraft`, including source locks, exact-reversal checks, one-child lineage, audit event, request context, and source-derived draft fields.
- [ ] Run the focused test and confirm it passes.

### Task 2: Evidence-bound preview and execute

**Files:**
- Modify: `backend/src/services/payment-reconciliation-service.test.ts`
- Modify: `backend/src/services/payment-reconciliation-service.ts`

- [ ] Write failing tests proving preview rejects source-only/no evidence and succeeds only after finalized evidence belongs to the restore draft; assert execute posts that same child and preserves its evidence.
- [ ] Run the focused test and confirm RED.
- [ ] Update inspection, preview hash, stale checks, and execution locking to require the linked draft and its ready evidence, then post the draft rather than inserting another child.
- [ ] Run the focused test and confirm GREEN.

### Task 3: MCP contract and documentation

**Files:**
- Modify: `backend/src/mcp/default.ts`
- Modify: `backend/src/mcp/server.ts`
- Modify: `backend/src/mcp/server.test.ts`
- Modify: `plugins/creditsync/references/mcp-tool-contract.json`
- Modify: `plugins/creditsync/scripts/validate.ts`
- Modify: `plugins/creditsync/skills/reconcile-payments/SKILL.md`
- Modify: `plugins/creditsync/README.md`

- [ ] Add a closed destructive `payment.restore.create` schema and handler that requires `paymentIntakePublicId`, non-blank reason, and idempotency key.
- [ ] Add a server catalog test and update the frozen plugin contract/validator allow-list and restore guidance with the create → evidence → preview → execute order.
- [ ] Run MCP server and plugin contract tests.

### Task 4: Verify and record

**Files:**
- Modify: `CHANGELOG.md`

- [ ] Run disposable backend suite, backend typecheck, MCP tests, plugin tests/validator, and `git diff --check`.
- [ ] Update changelog with the workflow change before committing.
- [ ] Commit only the scoped implementation on `codex/restore-draft-evidence`; do not merge, push, or deploy.
