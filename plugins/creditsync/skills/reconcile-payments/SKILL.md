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

For image-first capture, when the user supplies an image, treat it as a supplied image, calculate its exact byte size and SHA-256 locally, and require evidence before `payment.preview` or `payment.post`. After intake creation:

1. Call `evidence.prepare` with intake public UUID, MIME type, byte size, SHA-256, and evidence type.
2. Inspect the prepare result **before any PUT**. If it reports `duplicate`, call `intake.get` with the returned original `intakePublicId`, report the original, and stop. Do not upload, finalize, preview, or post.
3. Only for a non-duplicate prepare result, PUT the unchanged bytes to its returned signed URL using exactly its required headers before expiry.
4. Call `evidence.finalize` with the evidence public UUID.
5. Verify the finalized evidence is `ready` and remains bound to the prepared evidence/file UUID, MIME type, byte size, and SHA-256. If upload data is missing/expired, the PUT fails, or finalize returns a mismatch/non-ready state, stop before `payment.preview` or `payment.post`.

If no image is supplied, data-only capture is valid and skips all evidence calls. Do not manufacture evidence. Do not log or repeat raw QR payloads or signed upload URLs.

## Match and post

1. Resolve canonical borrowers/aliases and inspect candidate portfolios when identity is not explicit.
2. Call `payment.preview` with the intake public UUID. Include explicit allocations when the operator identifies loans/schedules, grouped payments, intermediary payers, or partial payments.
3. Display backend status, allocation targets, exact amounts, warnings, difference, expiry, and proposal public UUID.
4. `ready`: call `payment.post` only for that latest proposal public UUID. The agent may finish this unambiguous flow.
5. `needs_review`: show candidates and obligations, then wait for a human allocation choice. Fuzzy matches never auto-post.
6. Re-preview after any edit or stale/not-latest result.

One transfer may allocate across many loans and borrowers. Never force an allocation to make totals fit; let the backend validate the sum and outstanding obligations.

## Attribute payment sources and commission

After posting, call `payment.intermediary-attribution.list` for the exact payment before any source-attribution write and inspect current effective agents with `loan.commission-participant.list` when an intermediary is proposed. Present the operator with explicit choices: leave the amount unattributed, create a `direct` entry without an intermediary UUID, or create one or more `intermediary` entries for a confirmed multi-agent split. Do not infer attribution from payer hints, participant history, or fuzzy identity, and do not silently fill any remainder.

Call `payment.intermediary-attribution.create` only for the exact confirmed payment, optional transaction, source kind, intermediary when required, and amount. It is an actual append-only write requiring `confirmed: true` and a stable idempotency key; each split entry is a separate confirmed command, and the same key may be reused only for an identical retry. Re-list after changes and report the backend result and audit/correlation identifiers.

To correct attribution, re-list, select the exact existing entry, obtain a non-blank reason and separate explicit confirmation, then call `payment.intermediary-attribution.reverse` with a new stable idempotency key. This appends compensation and never edits or deletes the original. To show commission before or after payment reversal, use `loan.commission.preview` for posted payments and `loan.commission.reverse` only as a read-only compensating preview for posted reversal payments. The latter is not a financial write, accepts no confirmation/reason/idempotency key, and returns no audit identifiers.

## Reverse

Inspect the posted intake and show the entries that will be compensated. Obtain a non-blank reason, then call `payment.reverse` with both `{ paymentIntakePublicId, reason }`. The frozen 1.0 tool has no client idempotency-key field; the backend makes repeat reversal of that intake idempotent. Report the resulting audit/correlation identifiers. A reversal does not delete the original transaction.

## Quick reference

| State | Continue? |
| --- | --- |
| hard duplicate | No; inspect original intake |
| duplicate from `evidence.prepare` | No PUT/finalize/preview/post; inspect original intake |
| semantic warning | Preview, disclose warning, then follow returned state |
| `ready` latest proposal | May post exact proposal |
| `needs_review` or fuzzy | Human chooses allocations |
| stale/expired | Re-inspect and re-preview |

Follow the root `creditsync` skill and the matching/error references. Backend previews, not agent calculations, decide accounting readiness.
