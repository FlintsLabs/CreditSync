# Cancelled payment replacement

Date: 2026-09-22
Status: Approved by the user on 2026-09-22; implementation and verification authorized

## Outcome

An authorized operator can create a new draft payment from a cancelled, never-posted payment and reuse its finalized slip. The cancelled record, evidence, cancellation receipt, and batch remain unchanged. A fresh allocation preview and confirmed post are still required. One receipt can fund several scheduled installments using the existing payment allocation engine.

## Verified causes

- `payment-service.ts` marks an intake duplicate when a matching ready evidence hash belongs to another intake, including a cancelled intake.
- `payment_evidence_tenant_evidence_hash_unique` reserves the hash across the tenant. Deleting evidence or clearing its hash would destroy provenance.
- `createPaymentIntake` also checks bank-reference/QR hashes and semantic duplicates. Fixing only file preparation is insufficient.
- `workflow-resolver-service.ts` maps cancelled and duplicate intakes to the same observed state as posted intakes, suggesting evidence supplementation incorrectly.
- `payment.restore` handles reversed posted payments, not cancelled drafts.

## Contract

Add `payment.replacement.inspect` (read-only) and `payment.replacement.create` (audited draft creation). Inspect returns eligibility, blockers, safe source data, an existing replacement when present, and a state hash. Create requires source public UUID, reason, idempotency key, and expected state hash. The creation command does not post money.

The replacement copies amount, receivedAt, payer, ownership, source classification, origin loan, evidence requirements and private deduplication identity from authoritative source data. It does not accept edited payment data. Allocation targets are selected in the normal preview, allowing a corrected loan/schedule mapping. Public responses must not expose raw references, accounts, fingerprints, signed URLs or OCR.

Eligibility requires an accessible cancelled source with cancellation provenance, no posting timestamp, no transactions or reconciliation/restore dependents, and complete finalized ready evidence. Batch-owned sources require a cancelled owning batch. Reject pending/rejected/incomplete evidence and foreign-tenant or unauthorized requests.

Only one successor may be created from a source. If that successor is later cancelled, another replacement can be created from that cancelled successor. The lineage is append-only and cannot fork. Repeating an identical idempotent command returns the same result; changed payloads conflict. Concurrent commands cannot create two successors. Posted or reversed successors remain occupied and cannot be replaced through this workflow.

## Storage and evidence

Add an append-only replacement lineage table with tenant-scoped foreign keys, unique source and unique child, immutable receipt/request fingerprint and audit context. Keep restore lineage separate. Use immutable evidence-reference rows linking the new intake to the original ready evidence; preserve the original file/hash and its owning intake. Support reuse through a cancellation chain without copying or moving stored evidence.

Centralize effective payment evidence resolution for direct and inherited evidence. Apply it to intake reads, preview/post evidence requirements, snapshots, payment history, and batch reads/snapshots where replacements can be included. Referenced evidence is never counted twice and cannot be finalized or mutated through the child. Tenant and actor access must be checked before returning metadata or download access.

Hard and semantic duplicate detection must resolve replacement lineage. The known cancelled ancestors are provenance, not warnings against their own authorized replacement. Unrelated matching intakes continue to block or require review. Duplicate legacy children cannot be used to post and are not silently rewritten. Generic uploads should identify an eligible cancelled source and direct the caller to replacement inspection; they must not silently create a replacement or weaken global deduplication.

## Agent flow

`inspect cancelled source -> replacement inspect -> replacement create -> current contract/schedule inspection -> ordinary payment preview -> confirmed ready post`

Expose eligibility and lineage in intake reads. Resolver must distinguish cancelled, duplicate, reversed and posted terminal behavior and must not route cancelled receipts into posted evidence supplementation. Confirmation already provided for a specific payment allocation remains valid if the resulting preview has the same data, zero variance, no warnings and current state.

## Acceptance

- Synthetic 200.00 receipt can replace a cancelled batch member and post exactly 100.00 to each of two consecutive scheduled installments, retaining the original receipt timestamp.
- Original cancelled intake/batch/evidence and financial balances remain unchanged until the child posts.
- Retry, concurrent creation, subsequent cancellation/replacement, stale preview, cross-tenant access, wrong role, posted/reversed source, unrelated duplicates and incomplete evidence are covered.
- Existing standard intake, batch, restore, cancellation and evidence workflows remain valid.

## Delivery boundary

Implement and verify in an isolated `codex/` branch using supervised tmux as required by AGENTS.md. Preserve existing untracked task files. Deliver code, migration, contract/plugin changes, tests and documentation. Production deployment and the already-confirmed real payment remain follow-up operational steps after the implementation is reviewed and the release target is settled. No direct production database correction or synthetic production payments.
