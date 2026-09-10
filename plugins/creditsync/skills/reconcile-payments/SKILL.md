---
name: reconcile-payments
description: Use when capturing, reviewing, matching, posting, or reversing CreditSync payments from structured data or optional slip evidence, including split and intermediary transfers.
---

# Reconcile CreditSync Payments

When ChatGPT supplies a payment-slip file parameter, create the intake and immediately call `evidence.import-chatgpt-file` with that opaque top-level parameter and a stable idempotency key. The backend performs the bounded allowlisted download and storage; never retrieve, echo, log, or place file bytes, file IDs, download URLs, signed URLs, account details, QR payloads, or full references in summaries. Continue only from a `ready` result. An identical retry reuses the same idempotency key. If the parameter or import is unavailable, stop before preview/post; do not reinterpret an image-first request as data-only.

For evidence received after an exact payment is already `posted`, do not alter or repost it. Call `payment.evidence-supplement.import-chatgpt-file`, inspect the ready supplement and exact payment target, then obtain a separate explicit confirmation and reason before `payment.evidence-supplement.record`. This is append-only supplemental history.

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
3. Immediately before confirmation, call `payment.reconcile.preflight` for every payment/reconciliation write. It is a no-write feasibility check (`wouldWrite: false`); show exact allocations, accrual provenance, preview hash, expected balance version, and checks. Any `review_required`, warning, stale/duplicate/mismatch, missing evidence, or incomplete provenance is a hard stop; never call an execute/post tool.
4. Display backend status, allocation targets, exact amounts, warnings, difference, expiry, and proposal public UUID.
5. `ready`: ask for explicit confirmation only after preflight returns `ready_to_execute`, then call `payment.post` only for that latest proposal public UUID. If state changes, run a fresh preflight and obtain fresh confirmation.
6. `needs_review`: show candidates and obligations, then wait for a human allocation choice. Fuzzy matches never auto-post.
7. Re-preview after any edit or stale/not-latest result.

One transfer may allocate across many loans and borrowers. Never force an allocation to make totals fit; let the backend validate the sum and outstanding obligations.

## Inspect one loan's payment history

After resolving the exact loan public UUID through `borrower.portfolio`, call `loan.payment-history.list` to retrieve the payment intakes associated with that contract. Present the returned intake status, received amount/date, latest allocation, and posted principal/interest/fee/penalty components exactly as returned; this tool is read-only and does not recalculate or mutate financial records.

## Attribute payment sources and commission

After posting, call `payment.intermediary-attribution.list` for the exact payment before any source-attribution write and inspect current effective agents with `loan.commission-participant.list` when an intermediary is proposed. Present the operator with explicit choices: leave the amount unattributed, create a `direct` entry without an intermediary UUID, or create one or more `intermediary` entries for a confirmed multi-agent split. Do not infer attribution from payer hints, participant history, or fuzzy identity, and do not silently fill any remainder.

Call `payment.intermediary-attribution.create` only for the exact confirmed payment, optional transaction, source kind, intermediary when required, and amount. It is an actual append-only write requiring `confirmed: true` and a stable idempotency key; each split entry is a separate confirmed command, and the same key may be reused only for an identical retry. Re-list after changes and report the backend result and audit/correlation identifiers.

To correct attribution, re-list, select the exact existing entry, obtain a non-blank reason and separate explicit confirmation, then call `payment.intermediary-attribution.reverse` with a new stable idempotency key. This appends compensation and never edits or deletes the original. To show commission before or after payment reversal, use `loan.commission.preview` for posted payments and `loan.commission.reverse` only as a read-only compensating preview for posted reversal payments. The latter is not a financial write, accepts no confirmation/reason/idempotency key, and returns no audit identifiers.

## Reverse

## Correct a scheduled allocation

For a posted scheduled repayment allocated to the wrong installment, first inspect the exact intake, source transaction, both schedules, loan contract, and downstream dependencies. Call `payment.allocation-correction.preview` with the source transaction, target schedule, and a non-blank reason. Show the exact source/target before-and-after aggregates, unchanged amount and components, and zero loan variance. A blocked, stale, expired, dependent, overpayment, floating, cross-loan, or same-schedule result is a hard stop.

An executed renewal's `principal_transfer` and `cash_payout` rows are eligible opening ancestors only when verified through the creating renewal's lineage and both the renewal's new loan and adjustment loan are the current source loan. They are included in stale-state validation but are not warnings. Every unknown adjustment remains blocked, including an unknown type, unrelated or differently linked renewal, non-executed renewal, later repayment, attribution, reconciliation, or downstream renewal.

After explicit human confirmation, call `payment.allocation-correction.execute` with the unchanged preview hash, balance version, exact normalized reason, `confirmed: true`, and a stable idempotency key. The operation is same-loan only and append-only: it preserves the posted intake/source transaction and adds one exact compensation plus one replacement. Re-inspect the intake history, both schedules, loan rollup, correction public ID, audit public ID, and correlation ID. Deployment and any real production repair require separate authorization and a fresh preview.

Inspect the posted intake and show the entries that will be compensated. Obtain a non-blank reason, then call `payment.reverse` with both `{ paymentIntakePublicId, reason }`. The frozen 1.0 tool has no client idempotency-key field; the backend makes repeat reversal of that intake idempotent. Report the resulting audit/correlation identifiers. A reversal does not delete the original transaction.

For a floating-loan correction where the original payment must be reversed and any missing interest through the original payment date must be restored as payable accruals, use `payment.reverse-with-accrual.preview` first. Show the exact source payment, affected floating loans, Bangkok through-date, projected missing accrual count/amount, and preview hash. Only after explicit confirmation call `payment.reverse-with-accrual.execute` with the unchanged hash, literal `confirmed: true`, a non-blank reason, the fixed `ensure_due_through_payment_date` mode, and a stable idempotency key. The operation is atomic: if rate coverage or provenance is unavailable, both reversal and accrual materialization fail together. It never posts a new payment; after success, use the returned accruals and run the normal interest-only reconciliation workflow for the supplied payment.

## Reconcile or repost a historical interest-only intake

For an existing executed reconciliation that predates temporal-reflow provenance, inspect the reconciliation group, source intake, finalized evidence metadata, source transactions, and floating-interest allocation lineage first. For a complete interest-only legacy chain, call `payment.reconcile.reflow.preview` with the reconciliation public UUID and a non-blank reason. The preview is read-only and shows the Bangkok effective date, exact per-loan chronological impact, displaced/replacement totals, source transaction lineage, expiry, hash, and expected balance version. Missing lineage or any principal, fee, or penalty component is a hard stop.

After explicit confirmation, call `payment.reconcile.reflow.execute` with the unchanged preview hash, expected balance version, reason, `confirmed: true`, and a stable idempotency key. The append-only repair compensates and replays only the signed interest allocation lineage; original transactions, dates, and components remain immutable. Re-run an identical request only to recover a lost response; it returns the same repair group, audit, correlation, and transaction public IDs. A changed key payload, stale/expired preview, different tenant, already-repaired reconciliation, or incomplete provenance must stop without a financial write. This repair is not a replacement for ordinary reconciliation, restore, or unsupported principal/fee/penalty repair.

When an ordinary ready proposal's no-write preflight returns exactly `FLOATING_BACKDATED_ALLOCATION_REQUIRES_RECONCILIATION`, stop ordinary posting and inspect the exact intake. Show that `payment.reconcile.mark-review` will change only `ready` to `needs_review` and invalidate every ordinary proposal, then obtain explicit confirmation for that transition alone. Call it with `expectedStatus: "ready"`, a non-blank reason, and a stable idempotency key. Do not use it for any other preflight error and never call `payment.post` afterward. Re-inspect, run a fresh reconciliation preflight and preview, show provenance/totals/warnings/expiry, and obtain a separate explicit confirmation before `payment.reconcile.execute`.

Use reconciliation only for an operator-reviewed historical intake that remains `needs_review`, or a `reversed` source whose original repayments are all exactly compensated and which retains finalized `ready` evidence. First inspect the exact intake, its source/child lineage, and affected loans, then call `payment.reconcile.preview` with every explicit allocation using component `interest` plus a non-blank reason. Immediately before confirmation, call `payment.reconcile.preflight`; proceed only when it returns `ready_to_execute`, `wouldWrite: false`, current hash/version, passing checks, and complete accrual provenance. The backend derives `historical_needs_review` or `reversed_repost`, verifies no prior child exists, and returns the source snapshot, signed component correction, exact amount conservation, preview hash, balance version, expiry, and any historical group IDs. The preview must show `principal: "0.00"`.

Execution appends only the explicit interest allocations and does not synthesize a reversal. For `reversed_repost`, it preserves the source and evidence unchanged, creates one linked posted child, and returns both `sourcePaymentPublicId` and `postedPaymentPublicId`; evidence is not copied. Other posted intakes and principal, fee, or penalty components are rejected. Call `payment.reconcile.execute` only after displaying the exact preview and obtaining explicit human confirmation, passing the unchanged preview hash/version, reason, and a new stable idempotency key. Stale, expired, mismatched, ambiguous, missing-evidence, partially reversed, already-reposted, or conflicting retries stop for review. Same-key identical retries return the original reconciliation result.

## Restore a mistakenly reversed payment exactly

When an operator confirms that a posted payment was reversed by mistake, inspect the exact reversed intake and its source/child lineage, then call `payment.restore.create` with a non-blank reason and stable idempotency key. This creates one linked `draft` child with no financial effect, no bank reference, and no copied evidence. Call `payment.restore.evidence.prepare` with that `restoreDraftPublicId`, MIME type, byte size, SHA-256, and optional original name. PUT the unchanged slip only to the returned current signed URL with its exact required headers, then call `payment.restore.evidence.finalize` with the same restore draft and prepared evidence UUID. These tools reject ordinary payment drafts; never append evidence to the immutable reversed source. Next call `payment.restore.preview` with the source payment and same reason. The backend derives the original transaction component split; callers cannot change the amount, target loan, schedule, principal, interest, fee, or penalty values. Require finalized ready draft evidence and complete exact compensating reversals. Display the source snapshot and exact correction before calling `payment.restore.execute` with explicit confirmation, unchanged hashes, the same reason, and a new stable idempotency key. Execution posts that same child, keeps the source `reversed`, and returns both source and posted child public IDs. Stale, missing-evidence, partial-reversal, duplicate-child, or conflicting-idempotency results stop for review.

If a verified posted exact-restore child has a stale derived scheduled-installment aggregate, inspect its lineage and schedule first. Use `payment.restore.schedule-backfill` only with the exact restore-child public ID, a non-blank repair reason, and a stable idempotency key. It is a destructive, append-only audited repair of derived schedule fields only: it must never create another payment, transaction, or evidence record. Re-run it only as an identical retry; a no-op result is expected once the aggregate already reflects non-reversed repayment transactions.

## Atomic scheduled-loan batches

For resumable upload-first batches, call `payment.batch.stage`, inspect `payment.batch.workspace`, prepare/finalize each staging evidence item, then review normalized amount/time and borrower/contract mapping before preview. For two or more already-resolved slips, `payment.batch.capture` remains available. Preview once after every evidence item is ready; use explicit borrower-aware allocations for floating targets or multiple contracts, and use `payment.batch.decision` only with the current preview revision/date range. Every edit, split, decision, or cancellation requires its returned revision and stable idempotency key; a stale response requires re-inspection. Verify every posted intake and every affected loan balance after execution. A stale or changed-semantic response sets `repreviewRequired`; duplicate, mismatch, or ambiguous results set `humanReviewRequired` and must stop without partial posting. Single-slip requests keep the existing intake workflow.

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
