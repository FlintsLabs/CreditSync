# Payment Restore Draft Cancellation Design

## Goal

Provide an audited way to cancel an unposted payment restore draft so it no longer blocks borrower payment chronology, while preserving the reversed source payment, uploaded evidence, and full cancellation history.

## Context

`payment.restore.create` creates one draft child linked to a fully reversed payment intake. The generic `payment.cancel` workflow rejects every restore child because restore drafts are owned by the restore workflow. The database currently enforces one child per source for all statuses, so merely marking a child cancelled would also prevent a later restore attempt. A cancelled child is already excluded from the chronology check because cancelled intakes are terminal.

## Design

### Dedicated command

Add `payment.restore.cancel` with a closed request containing:

- `restoreDraftPublicId`
- `expectedStateHash`
- a normalized non-empty `reason`
- a stable `idempotencyKey`

The MCP response uses the existing payment cancellation receipt fields: payment intake ID, status, reason, cancellation time, cancellation receipt ID, audit ID, and correlation ID.

### Eligibility and effects

- Only a `draft` child with a non-null `repostOfIntakeId` may be cancelled through this command.
- Its source must still be `reversed`; the command must not modify or cancel the source.
- Reject a stale state hash, wrong tenant or role, batch membership, transaction dependency, or any child that is already ready, posted, reversed, or otherwise outside the draft lifecycle.
- On success, atomically set the child status to `cancelled`, persist the normalized reason and cancellation metadata, write the immutable cancellation receipt and audit log, and invalidate any current ready proposal.
- Preserve evidence records and file objects. The command creates no repayment, reversal, allocation, refund, or balance change.
- A repeated request with the same key and same payload returns the original receipt. Reusing a key with a different target or payload returns an idempotency conflict.
- The generic `payment.cancel` command continues to reject restore children; the restore command is the only path that may cancel them.

### Restore retries after cancellation

Keep cancelled child rows as immutable history while allowing one non-cancelled child per source:

- Replace the unconditional unique index on `(tenant_id, repost_of_intake_id)` with a partial unique index that excludes `status = 'cancelled'`.
- Make restore source inspection and `payment.restore.create` ignore cancelled children when checking for an active restore attempt.
- A new restore attempt after cancellation requires a new idempotency key and creates a new child. Repeating the original create key must not revive the cancelled child.

### Discovery and contract

- Add a restore-specific cancellation capability to `intake.get`, exposing eligibility, the current state hash, and a safe blocked reason independently of the generic `payment.cancel` capability.
- Register `payment.restore.cancel` as a destructive financial-workflow tool in the backend catalog, MCP schemas, profiles, dispatch, and authorization policy.
- Synchronize the frozen plugin contract, profile snapshots, plugin skill guidance, eval catalog/harness, validator requirements, and plugin changelog/version with the current manifest version as the baseline.
- Document the workflow as `intake.get` → explicit user confirmation → `payment.restore.cancel` → `intake.get` verification. Cancellation does not imply a refund or prove the original transfer did not occur.

## Acceptance criteria

1. A valid restore draft can be cancelled exactly once with current-state, authorization, reason, and idempotency checks.
2. The source remains reversed and byte-for-byte financial history remains unchanged; evidence remains attached to the cancelled child.
3. The cancelled child no longer blocks chronology, and a new restore draft can be created for the same source with a new idempotency key.
4. Generic cancellation still rejects restore drafts, and all unsupported or stale states fail without mutation.
5. MCP outputs remain closed and the plugin's frozen contract, profiles, guidance, and version metadata match the backend tool catalog.

## Explicit scope exclusions

- Do not execute, reverse, or reallocate the source payment as part of cancellation.
- Do not delete the restore child, its evidence, the reversed source, or prior audit records.
- Do not weaken payment chronology checks or allow cancellation of posted children.
- Do not deploy, publish, or alter any production financial record while implementing the workflow.

## Repository findings

- Restore service: `backend/src/services/payment-reconciliation-service.ts`.
- Cancellation service: `backend/src/services/payment-cancellation-service.ts`.
- Payment intake output and MCP tools: `backend/src/mcp/server.ts` and `backend/src/mcp/default.ts`.
- Restore-child uniqueness: `backend/src/db/schema.ts` and the existing migration `backend/drizzle/0049_repost_reversed_payment.sql`; implementation needs a forward migration.
- Plugin contract and policy: `plugins/creditsync/references/mcp-tool-contract.json`, profile snapshots, `plugins/creditsync/skills/reconcile-payments/SKILL.md`, and `plugins/creditsync/scripts/validate.ts`.
