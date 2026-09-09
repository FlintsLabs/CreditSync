# Restore Draft Evidence for Reversed Payments

## Goal

Allow an operator who mistakenly reversed a valid payment to attach the original slip to a new, linked restore draft and post an exact replacement only after explicit review and confirmation.

## Safety boundary

- The source remains immutable and `reversed`; no evidence is ever appended to it.
- `payment.restore.create` creates or returns one tenant-safe draft child linked through `repost_of_intake_id`; it never changes a balance or creates a transaction.
- Only the restore draft may receive new evidence. Its bank reference, bank-reference hash, and QR hash remain null so normal duplicate detection cannot be bypassed.
- Preview requires the child draft, finalized ready child evidence, a fully compensated source, exact source amount/components, and no prior reconciliation execution.
- Execute posts the existing draft child; it never creates a second child, accepts caller allocations, or copies source bank data.
- A normal intake with the old bank reference remains a duplicate. OCR/evidence comparison is advisory only; execution still needs `confirmed: true` and an idempotency key.

## MCP surface

- `payment.restore.create({ paymentIntakePublicId, reason, idempotencyKey })` returns the linked draft public ID. A compatible retry returns it; conflicting context fails.
- Existing `payment.evidence.prepare` and `payment.evidence.finalize` operate on that draft.
- `payment.restore.preview({ paymentIntakePublicId, reason })` uses the linked draft and requires finalized evidence there.
- `payment.restore.execute(...)` posts that draft as the linked child with exact immutable source components.

## Verification

Cover: draft creation has no ledger effect; same command retries safely; source evidence is not required; preview rejects absent child evidence; execute posts the same evidence-bearing child once; a normal duplicate intake remains blocked.
