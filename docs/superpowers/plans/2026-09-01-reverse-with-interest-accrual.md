# Reverse With Interest Accrual Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an audited preview/execute workflow that reverses a floating-loan payment and materializes missing interest accruals through the original payment date atomically.

**Architecture:** Reuse `reversePayment` and `accrueFloatingInterestThrough` as transaction-aware domain kernels. Add a focused orchestration service for preview/execute, persist reversal-to-accrual lineage, and expose a new MCP command pair while leaving frozen `payment.reverse` unchanged.

**Tech Stack:** Bun, TypeScript, Drizzle PostgreSQL, Decimal.js/FinancialDecimal, MCP server contract, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-01-reverse-with-interest-accrual-design.md`

## Global Constraints

- Money crosses public interfaces as two-decimal decimal strings and must be calculated with `decimal.js`.
- Use Asia/Bangkok business dates and ISO timestamps.
- Posted financial records are immutable; corrections are append-only compensating records.
- Every write carries command context, request/correlation ID, actor/source, idempotency, and audit history.
- MCP writes require inspect/preview/explicit confirmation/execute and closed schemas.
- Preserve all unrelated dirty files in the worktree.

### Task 1: Add accrual materialization lineage

**Files:**
- Create: `backend/drizzle/0058_reverse_interest_accrual_lineage.sql`
- Modify: `backend/src/db/schema.ts`
- Test: `backend/src/db/reverse-interest-accrual-lineage-migration.test.ts`

**Interfaces:**
- Produces `loan_interest_accruals.materialization_source`, `source_payment_intake_id`, `source_reversal_transaction_id`, and `materialization_reason` with tenant-scoped foreign keys and safe checks.

- [ ] Write a failing migration/schema test proving lineage columns and constraints are present.
- [ ] Run `bun test backend/src/db/reverse-interest-accrual-lineage-migration.test.ts` and observe the expected failure.
- [ ] Add the migration and Drizzle schema fields without changing existing accrual values.
- [ ] Run the migration test and the existing accrual immutability tests.
- [ ] Verify the migration only adds nullable lineage metadata and does not weaken immutability.

### Task 2: Extract a transaction-aware reverse kernel result

**Files:**
- Modify: `backend/src/services/payment-service.ts`
- Test: `backend/src/services/payment-service.test.ts`

**Interfaces:**
- `reversePayment` continues returning the legacy result.
- New internal result exposes reversed transactions and affected floating loans to the orchestration service without duplicating reversal logic.

- [ ] Add a failing regression test that the internal reverse result identifies every affected floating loan and original reversal transaction.
- [ ] Run the focused test and confirm it fails because the result is not exposed.
- [ ] Refactor the existing loop minimally so the result is available inside the caller-owned transaction.
- [ ] Keep existing direct `reversePayment` behavior unchanged and run all payment-service reversal tests.

### Task 3: Implement preview/execute orchestration

**Files:**
- Create: `backend/src/services/payment-reverse-with-accrual-service.ts`
- Create: `backend/src/services/payment-reverse-with-accrual-service.test.ts`
- Modify: `backend/src/services/payment-service.ts`

**Interfaces:**
- `previewReverseWithInterestAccrual(ctx, paymentIntakePublicId, input)` returns source snapshot, reversal effects, through date, accrual preview, warnings, preview hash, balance version and expiry.
- `executeReverseWithInterestAccrual(ctx, previewPublicId, input)` returns reversed payment, reversal transaction IDs, created/promoted accrual IDs, audit IDs and correlation ID.

- [ ] Add failing tests for floating principal-only payment → reverse + newly due accrual, scheduled-loan rejection, and missing-rate rollback.
- [ ] Run the focused service tests and verify the failures are behavioral, not setup errors.
- [ ] Implement preview using locked read snapshots and backend accrual projection/materialization logic; do not calculate in the caller.
- [ ] Implement execute in one database transaction, invoke the existing reverse kernel, materialize through the original payment business date, attach lineage, audit, and refresh rollups.
- [ ] Add idempotency and stale-hash/version checks; preserve old reverse path.
- [ ] Run the focused tests plus payment and floating-interest regression suites.

### Task 4: Expose MCP contract

**Files:**
- Modify: `backend/src/mcp/server.ts`
- Modify: `backend/src/mcp/default.ts`
- Modify: `plugins/creditsync/references/mcp-tool-contract.json`
- Modify: `plugins/creditsync/README.md`
- Modify: `plugins/creditsync/skills/reconcile-payments/SKILL.md`
- Test: `backend/src/mcp/default.test.ts`
- Test: `plugins/creditsync/tests/plugin-contract.test.ts`

**Interfaces:**
- Add closed schemas for `payment.reverse-with-accrual.preview` and `.execute`.
- Mark preview read-only and execute destructive; return public IDs only.

- [ ] Add failing MCP dispatch/contract tests for both commands, confirmation, reason, hash/version, and idempotency validation.
- [ ] Run focused MCP and plugin contract tests to verify they fail before dispatch exists.
- [ ] Register handlers, schemas, descriptions, annotations, and skill guidance.
- [ ] Run MCP default tests, plugin contract tests, and validator.

### Task 5: End-to-end verification and documentation

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `README.md` only if workflow/setup documentation changes are required.
- Test: existing backend disposable PostgreSQL suite and plugin validator.

- [ ] Add a concise changelog entry under a new dated version heading describing the new reverse-with-accrual workflow.
- [ ] Run backend disposable tests and typecheck.
- [ ] Run frontend test/lint/build if repository gate requires it for the changed contract.
- [ ] Run plugin tests and validator.
- [ ] Inspect final diff and confirm unrelated dirty files remain unchanged.
