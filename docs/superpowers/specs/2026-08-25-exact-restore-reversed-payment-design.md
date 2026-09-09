# Exact Restore of a Reversed Payment

## Goal

Provide an explicit MCP preview/execute workflow that restores one mistakenly reversed payment as a new linked posted intake, preserving the original component split and immutable lineage.

## Safety boundary

- Only a tenant-accessible `reversed` intake with complete exact compensating reversals and finalized ready evidence is eligible.
- The restored child copies the source repayment components exactly; no caller-supplied amount or component edits are accepted.
- The source remains `reversed`; evidence and bank-reference data remain on the source only.
- A source may have at most one restored child. Preview and execute are expiring, hash-bound, confirmed, reasoned, idempotent, and append-only.
- The workflow never restores a partially reversed, posted, needs-review, or already-restored source.

## MCP surface

Add `payment.restore.preview({ paymentIntakePublicId, reason })` and `payment.restore.execute({ restorePreviewPublicId, previewHash, expectedBalanceVersion, reason, confirmed, idempotencyKey })`. Preview returns the exact source snapshot, proposed component rows, and hashes. Execute returns source/child payment public IDs, replacement transaction IDs, audit IDs, and correlation ID.

## Accounting behavior

Execution creates a child intake with `repostOfIntakeId`, creates replacement repayment transactions with the source loan/schedule and exact signed components, updates only the corresponding loan balances, recreates interest provenance where required, and records immutable reconciliation entries. The child has no bank reference, QR hash, or evidence row.

## Verification

Tests must cover the 83.33 principal + 16.67 interest case, source immutability, child lineage, evidence non-copying, exact balance restoration, no duplicate child, stale preview, missing evidence, partial reversal, cross-tenant access, conflicting idempotency, and identical retry.
