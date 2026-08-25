# Exact Restore of a Reversed Payment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore one mistakenly reversed payment as a new linked posted child while preserving the original principal/interest component split.

**Architecture:** Add a dedicated restore service path beside the existing interest-only reconciliation path. The service derives exact source allocations from immutable reversed transactions, persists an expiring proposal, and executes under deterministic locks into a child intake and append-only ledger entries. Extend the MCP registry and frozen plugin contract with the explicit preview/execute pair.

**Tech Stack:** Bun, TypeScript, Elysia, Drizzle ORM, PostgreSQL, Decimal.js, CreditSync MCP contract and plugin validator.

**Spec:** `docs/superpowers/specs/2026-08-25-exact-restore-reversed-payment-design.md`

## Global Constraints

- Money remains two-decimal strings and all arithmetic uses `decimal.js`.
- Original records remain immutable; restore creates compensating provenance and a new child intake.
- No bank reference, QR hash, or evidence is copied to the child.
- Every write includes reason, actor/source, request/correlation ID, idempotency key, audit ID, and tenant-safe lineage.
- No production financial records, deployment, push, or merge without separate authorization.

### Task 1: Add failing service tests

**Files:**
- Modify: `backend/src/services/payment-reconciliation-service.test.ts`

- [ ] Add an integration test for a reversed source whose original transaction is `83.33` principal plus `16.67` interest; assert restore preview derives both components and rejects caller edits.
- [ ] Add tests for missing ready evidence, incomplete reversal, existing child, stale preview, and idempotent retry.
- [ ] Run `cd backend && ./scripts/test-disposable-postgres.sh ./src/services/payment-reconciliation-service.test.ts`; confirm RED because restore functions do not exist.

### Task 2: Implement exact restore service

**Files:**
- Modify: `backend/src/services/payment-reconciliation-service.ts`
- Modify: `backend/src/db/schema.ts` only if proposal metadata needs a mode field

- [ ] Add `previewPaymentRestore` that locks/inspects the reversed source, derives exact component allocations, hashes the source snapshot, and persists a ready proposal.
- [ ] Add `executePaymentRestore` that rechecks all invariants, creates one child intake without bank-reference/evidence fields, inserts exact replacement transactions and reconciliation entries, updates balances with Decimal.js, and returns source/child IDs.
- [ ] Reuse existing lineage constraints and audit/idempotency tables; reject mixed caller allocations and any source that is not fully reversed/evidence-ready.
- [ ] Run the focused disposable test suite and typecheck; confirm GREEN.

### Task 3: Expose MCP contract

**Files:**
- Modify: `backend/src/mcp/default.ts`
- Modify: `backend/src/mcp/server.ts`
- Modify: `backend/src/mcp/server.test.ts`
- Modify: `plugins/creditsync/references/mcp-tool-contract.json`
- Modify: `plugins/creditsync/scripts/validate.ts`
- Modify: `plugins/creditsync/skills/reconcile-payments/SKILL.md`
- Modify: `plugins/creditsync/README.md`
- Modify: `plugins/creditsync/CHANGELOG.md`

- [ ] Register closed input/output schemas for `payment.restore.preview` and `payment.restore.execute`, marking execute destructive.
- [ ] Add contract tests and regenerate/validate the frozen contract.
- [ ] Document that restore is exact-source-component only and requires preview plus explicit confirmation.

### Task 4: Verify and document

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `README.md` if workflow setup/behavior is user-facing

- [ ] Run backend disposable tests, typecheck, MCP tests, plugin tests, and validator.
- [ ] Run `git diff --check` and inspect for secrets/raw evidence/reference logging.
- [ ] Update changelog before any commit. Do not commit or integrate unless requested.
