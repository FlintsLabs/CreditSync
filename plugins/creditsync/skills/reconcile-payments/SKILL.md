---
name: reconcile-payments
description: Use when capturing, reviewing, matching, posting, or reversing CreditSync payments from structured data or optional slip evidence, including split and intermediary transfers.
---

# Reconcile CreditSync Payments

## Overview

Treat intake, evidence, matching, posting, and reversal as separate stages. A slip is optional; only a current `ready` proposal can become a posted payment.

## Capture

1. Extract only the supplied amount, received time, payer/intermediary hint, bank reference, and QR payload. Preserve uncertainty; never invent missing text.
2. Call `intake.create` with exact money/date strings and a stable idempotency key for this capture intent.
3. If the result is `duplicate`, inspect its returned public UUID with `intake.get`, report the original, and stop before matching or posting.
4. For a new intake, show semantic warnings. They are review signals, not hard duplicates.

For image-first capture, calculate the file SHA-256 locally. After intake creation:

1. Call `evidence.prepare` with intake public UUID, MIME type, byte size, SHA-256, and evidence type.
2. PUT the unchanged bytes to the returned signed URL using exactly its required headers before expiry.
3. Call `evidence.finalize` with the evidence public UUID.

Do not send evidence when data-only capture is sufficient. Do not log or repeat raw QR payloads or signed upload URLs.

## Match and post

1. Resolve canonical borrowers/aliases and inspect candidate portfolios when identity is not explicit.
2. Call `payment.preview` with the intake public UUID. Include explicit allocations when the operator identifies loans/schedules, grouped payments, intermediary payers, or partial payments.
3. Display backend status, allocation targets, exact amounts, warnings, difference, expiry, and proposal public UUID.
4. `ready`: call `payment.post` only for that latest proposal public UUID. The agent may finish this unambiguous flow.
5. `needs_review`: show candidates and obligations, then wait for a human allocation choice. Fuzzy matches never auto-post.
6. Re-preview after any edit or stale/not-latest result.

One transfer may allocate across many loans and borrowers. Never force an allocation to make totals fit; let the backend validate the sum and outstanding obligations.

## Reverse

Inspect the posted intake and show the entries that will be compensated. Obtain a non-blank reason, then call `payment.reverse` with the intake public UUID. The frozen 1.0 tool has no client idempotency-key field; the backend makes repeat reversal of that intake idempotent. Report the resulting audit/correlation identifiers. A reversal does not delete the original transaction.

## Quick reference

| State | Continue? |
| --- | --- |
| hard duplicate | No; inspect original intake |
| semantic warning | Preview, disclose warning, then follow returned state |
| `ready` latest proposal | May post exact proposal |
| `needs_review` or fuzzy | Human chooses allocations |
| stale/expired | Re-inspect and re-preview |

Follow the root `creditsync` skill and the matching/error references. Backend previews, not agent calculations, decide accounting readiness.
