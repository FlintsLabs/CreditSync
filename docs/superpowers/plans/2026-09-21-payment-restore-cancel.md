# Payment Restore Draft Cancellation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Add a dedicated audited cancellation workflow for unposted restore drafts, keep restore lineage and evidence immutable, and allow a later restore attempt after a cancelled child.

**Architecture:** Keep all restore lineage validation and child selection in `payment-reconciliation-service.ts`, which owns restore source inspection. Add a shared validated cancellation mutation kernel in `payment-cancellation-service.ts` that accepts a restore-specific guard callback; the restore service calls it only after locking and validating source/child lineage. This avoids a reverse service import and keeps ordinary `payment.cancel` unable to cancel restore children. Change the child uniqueness rule to allow any number of cancelled historical children but only one non-cancelled child per source. Synchronize the closed MCP/plugin interface and operator guidance.

**Tech Stack:** TypeScript, Bun, Drizzle ORM, PostgreSQL migrations, CreditSync MCP catalog, private CreditSync plugin contract.

**Spec:** `docs/superpowers/specs/2026-09-21-payment-restore-cancel-design.md`

## Global Constraints

- Money in public interfaces remains decimal strings and all financial state remains append-only.
- Use tenant-scoped access checks, current state hashes, stable idempotency keys, command context, correlation IDs, and audit receipts for the write.
- A cancelled child remains linked to the reversed source; cancellation never posts, reverses, reallocates, deletes evidence, or changes balances.
- Preserve exact restore behavior and keep the generic payment cancellation route rejecting restore children.
- Use the current MCP catalog and plugin manifest as the contract/version baseline; keep frozen interfaces synchronized.
- Do not deploy, publish, push, or alter production financial records.

## Review Focus

- A stale restore-draft state hash must reject without changing child, parent, evidence, or cancellation receipts.
- A linked child that is no longer a draft, belongs to another tenant/role, is in a batch, or has a transaction must be ineligible.
- A cancelled child must not block another restore attempt, while a second non-cancelled child remains impossible.
- Reusing the create key from a cancelled child must not revive it; a later attempt uses a new key.
- Identical cancellation retries must return the original receipt, while a reused key with a changed target or reason must conflict.

---

### Task 1: Make restore-child lineage retryable after cancellation

**Files:**
- Modify: `backend/src/db/schema.ts`
- Create: `backend/drizzle/0078_cancelled_restore_attempts.sql`
- Modify: `backend/drizzle/meta/0058_snapshot.json` (generate it using the repository's established Drizzle workflow)
- Modify: `backend/src/services/payment-reconciliation-service.ts`

**Produces:** One non-cancelled restore child per source; cancelled child rows remain immutable history and do not count as the active restore child.

- [x] Update the Drizzle unique index to cover `(tenant_id, repost_of_intake_id)` only where the parent link is non-null and child status is not `cancelled`.
- [x] Add a forward migration that drops `payment_intakes_tenant_repost_of_unique` and recreates the active-child partial unique index without changing any existing row.
- [x] Change restore-source inspection and `createPaymentRestoreDraft` to search for the active child only; return the existing active attempt idempotently, and create a new child only if prior children are cancelled.
- [x] Keep per-intake idempotency uniqueness unchanged so a new restore attempt requires a new key.
- [x] Regenerate or update the migration snapshot using the repository's established Drizzle workflow.

### Task 2: Add safe restore-draft cancellation

**Files:**
- Modify: `backend/src/services/payment-cancellation-service.ts`
- Modify: `backend/src/services/payment-reconciliation-service.ts`

**Produces:** `cancelPaymentRestoreDraft(ctx, restoreDraftPublicId, { expectedStateHash, reason, idempotencyKey })` in `payment-reconciliation-service.ts`, using a restore-only validated guard in the shared cancellation mutation kernel and returning the same receipt and audit shape as ordinary payment cancellation.

- [x] Export a narrowly scoped cancellation mutation helper from `payment-cancellation-service.ts` that reuses the current cancellation snapshot, actor/role validation, receipt table, audit log format, idempotency replay behavior, and takes an explicit guard for the restore lineage check; do not expose a generic bypass flag to `payment.cancel`.
- [x] Implement `cancelPaymentRestoreDraft` in `payment-reconciliation-service.ts`; under borrower, parent-intake, and child-intake locks, validate the requested intake is a draft child, its parent is fully reversed with exact compensating transactions, the child has no batch membership or transactions, and the current state hash matches before invoking the guarded mutation helper.
- [x] Preserve child evidence and the source's reversed status; write status `cancelled`, normalized reason, cancellation lifecycle metadata, and one immutable cancellation receipt atomically.
- [x] Invalidate any current ready match proposal for the child within the same transaction.
- [x] Keep `cancelPaymentIntake` and `payment.cancel` rejecting restore children.

### Task 3: Expose the restore cancellation capability and MCP operation

**Files:**
- Modify: `backend/src/mcp/server.ts`
- Modify: `backend/src/mcp/default.ts`
- Modify: `backend/src/services/payment-service.ts`
- Modify: `backend/src/mcp/catalog-types.ts`
- Modify: `backend/src/mcp/tool-profiles.ts`
- Modify: `backend/src/mcp/workflow-resolver.ts`

**Produces:** `intake.get` advertises restore-specific cancellation eligibility and `payment.restore.cancel` executes the safe domain operation.

- [x] Add a strict `restoreCancellation` capability object containing `allowed`, `stateHash`, and `blockedReason` to the `intake.get` output; only restore children use it.
- [x] Update `intake.get` assembly to show restore-specific cancellation capability separately from the generic cancellation capability.
- [x] Add a strict `payment.restore.cancel` input (`restoreDraftPublicId`, `expectedStateHash`, `reason`, `idempotencyKey`) and closed cancellation-receipt output.
- [x] Add the handler using `cancelPaymentRestoreDraft`; declare it destructive and not read-only.
- [x] Register the tool in `MCP_TOOL_NAMES`, destructive-operation declarations, role/profile lists, operation schemas, audit action mapping, help descriptions, and workflow guidance. Update workflow resolution so an eligible restore draft advertises `payment.restore.cancel` as its next step.
- [x] Keep error details sanitized and preserve the server's standard structured error envelope.

### Task 4: Synchronize the private plugin and operator docs

**Files:**
- Modify: `plugins/creditsync/references/mcp-tool-contract.json`
- Modify: `plugins/creditsync/references/mcp-profiles/*.json` and profile index as generated by repository tooling
- Modify: `plugins/creditsync/skills/reconcile-payments/SKILL.md`
- Modify: `plugins/creditsync/scripts/validate.ts`
- Modify: `plugins/creditsync/.codex-plugin/plugin.json`
- Modify: `plugins/creditsync/CHANGELOG.md`
- Modify: root `README.md` and root `CHANGELOG.md` if the new public operator workflow requires them under CreditSync documentation rules

**Produces:** The private contract, profile tool inventory, discovery guidance, and release metadata agree with the backend operation.

- [x] Regenerate the frozen MCP contract and profile snapshots using the repository's catalog-generation command, after verifying the current manifest baseline; increment plugin metadata/version consistently with the generated contract.
- [x] Document `intake.get` → explicit user confirmation → `payment.restore.cancel` → `intake.get` verification, including preserved evidence, unchanged reversed source, retry key rules, and the fact cancellation is not a refund.
- [x] Add validator expectations for the new tool in the reconciliation guidance and tool lists; update root README and root CHANGELOG because this adds a user-facing operator workflow.
- [x] Update plugin changelog entries under explicit version/date headings, and update root README and root changelog guidance where required.

### Task 5: Review the integrated change set

**Files:** All files listed above.

**Produces:** A final diff that implements the approved specification without unrelated workspace changes.

- [x] Inspect migration ordering and generated metadata; confirm the old unconditional unique index is replaced rather than duplicated.
- [x] Inspect all cancellation and restore-child lookup paths to ensure cancelled children are historical only and never revive by retry.
- [x] Inspect MCP contracts and profile arrays for exact parity with the backend catalog.
- [x] Review `git diff --check`, the complete diff, and working-tree status; preserve existing untracked user files and do not claim tests or runtime checks that were not run. No test suites are in scope for this execution.
