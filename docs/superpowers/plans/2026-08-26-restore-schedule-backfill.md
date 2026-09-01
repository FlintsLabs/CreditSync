# Restore Schedule Aggregate Fix and Backfill Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure exact payment restores update the linked scheduled installment and safely repair the already-posted payment without creating a duplicate ledger payment.

**Architecture:** Centralize schedule aggregate recalculation from posted repayment transactions, call it from exact restore execution, and expose a guarded one-time backfill routine for posted restore children whose linked schedule still has a nonzero balance. The backfill changes only derived schedule aggregates, records an audit event, and is idempotent.

**Tech Stack:** Bun, TypeScript, Drizzle ORM, PostgreSQL, Decimal.js, CreditSync MCP/service layer.

**Spec:** `docs/superpowers/specs/2026-08-25-restore-draft-evidence-design.md`

## Global Constraints

- Money remains two-decimal strings and all arithmetic uses `decimal.js`.
- Posted financial records and source payments remain immutable; only derived schedule aggregates may be repaired.
- Backfill must be tenant-scoped, explicit-target, idempotent, and append-only audited.
- Do not create a second payment, mutate bank references, or bypass MCP/service invariants.

---

### Task 1: Regression test for exact restore schedule state

**Files:**
- Modify: `backend/src/services/payment-reconciliation-service.test.ts`
- Modify: `backend/src/services/payment-reconciliation-service.ts`

- [ ] Add a failing integration assertion that an exact restore with a scheduled source leaves the target schedule with `paidTotal: "100.00"`, `remainingDue: "0.00"`, and `status: "paid"`.
- [ ] Run the focused disposable PostgreSQL test and confirm it fails because the schedule remains pending.
- [ ] Add the minimal schedule aggregate update to restore execution using the exact replacement transaction components and existing lifecycle rules.
- [ ] Re-run the focused test and confirm it passes.

### Task 2: Idempotent backfill for the already-posted restore

**Files:**
- Create: `backend/src/services/payment-schedule-backfill-service.ts`
- Create: `backend/src/services/payment-schedule-backfill-service.test.ts`
- Modify: `backend/src/mcp/default.ts`
- Modify: `backend/src/mcp/server.ts`

- [ ] Add a failing service test for an explicit posted restore child and linked schedule whose aggregate is stale; assert the repair is derived from repayment transactions, writes an audit event, and a second invocation is a no-op.
- [ ] Implement a tenant-scoped backfill function that accepts the restore child public ID, locks the intake/loan/schedule, verifies `posted` status and restore lineage, sums non-reversed repayment components by schedule, computes `paidTotal` and `remainingDue` with Decimal.js, and updates only the schedule aggregate.
- [ ] Add a closed destructive MCP command for the explicit backfill target with reason and idempotency key, returning public IDs/correlation ID and a `changed` flag.
- [ ] Run focused service and MCP tests.

### Task 3: Contract, validator, and documentation

**Files:**
- Modify: `plugins/creditsync/references/mcp-tool-contract.json`
- Modify: `plugins/creditsync/scripts/validate.ts`
- Modify: `plugins/creditsync/skills/reconcile-payments/SKILL.md`
- Modify: `plugins/creditsync/README.md`
- Modify: `CHANGELOG.md`

- [ ] Freeze the new MCP schema and document that backfill is only for derived schedule state after a verified posted restore.
- [ ] Add a changelog entry under a new explicit version/date heading before any commit.
- [ ] Run plugin validator and `git diff --check`.

### Task 4: Verification and controlled backfill

- [ ] Run the backend disposable suite, backend typecheck, MCP tests, plugin tests/validator, and relevant frontend checks if contracts affect generated UI.
- [ ] Invoke the new MCP backfill command only for the verified restore child `01a039ef-a87b-7814-ae12-b23bfc896379` with an idempotency key and reason.
- [ ] Re-read the loan contract and confirm installment 2 is `paid`, remaining due is `0.00`, and the payment ledger remains exactly one posted restore child plus the original reversed source.
