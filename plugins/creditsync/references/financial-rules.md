# Financial workflow rules

The CreditSync backend and PostgreSQL ledger are authoritative. Skills orchestrate tools and display exact returned strings; they do not calculate principal, interest, charges, funding, or cash movement.

## Public contract

- THB amounts cross MCP as non-negative two-decimal strings unless an output explicitly represents a signed compensating entry.
- Business dates use `Asia/Bangkok`; wire timestamps use ISO 8601 and due dates use `YYYY-MM-DD`.
- Posted transactions and active loan terms are immutable. Corrections are append-only adjustments or reversals.
- Floating-interest periods are effective-dated policy records. Inspect and preview before execute; never change an accrued date or calculate its interest outside the backend.
- Oldest obligations allocate in the backend's order: penalty, fee, interest, then principal.
- A payment may be partial or in advance but cannot allocate beyond current outstanding obligations.

## Floating-loan settlement

- Inspect the current borrower portfolio, then call `loan.settlement.preview` for the exact loan and Bangkok `asOfDate`. Never calculate a close-out amount in conversation.
- Show `outstandingPrincipal`, `dueInterest`, `accruedNotDueInterest`, `outstandingFees`, `outstandingPenalties`, `nonRefundableAdvanceInterest`, and `settlementTotal` exactly as returned before asking for confirmation.
- `nonRefundableAdvanceInterest` is already-paid history. It is disclosed separately and is not refunded, credited, or added to the new settlement total.
- Execute only the latest exact `settlementPublicId` and `previewHash`, with explicit human confirmation, a non-blank reason, and a stable idempotency key. Reuse the key only for an identical retry.
- A stale preview, changed balance, later accrual, non-refundable refund request, or mismatched hash stops execution. Re-inspect, create a new preview, display it, and obtain fresh confirmation.
- Settlement appends the exact close-out transaction and marks the loan paid. It never edits prior accruals or reverses the original advance-interest payment.

## Canonical daily-loan example

For principal `2500.00`, installment `190.00`, and 15 daily installments, the backend preview returns principal `166.67` and interest `23.33` for installments 1–14, then principal `166.62` and interest `23.38` in installment 15. After ten fully posted installments the renewal preview returns paid principal `1666.70` and old outstanding principal `833.30`; a replacement principal of `2500.00` with no due charges yields a `1666.70` payout.

This example is a contract fixture, not permission to derive a live renewal from installment counts. Always use `loan.preview` or `renewal.preview` for the current record.

## Reversals and renewals

- A payment reversal posts compensating entries linked to the original; repeating it returns the same reversal result.
- Renewal execution requires the exact current preview hash and explicit confirmation.
- Due interest, fees, and penalties must be collected or waived with a reason before renewal execution.
- Renewal reversal is blocked while the replacement loan has active downstream transactions, adjustments, or funding changes.
- MCP may list funding sources but never create or mutate them.

## Atomic scheduled-loan replacement

- Replacement is a backend-owned `preview → explicit human confirmation → execute` workflow between one active scheduled loan and one existing funded draft for the same borrower and owner. Use only public UUIDs.
- `loan.replacement.preview` returns the exact correction, zero/no cash movement, old and replacement lifecycle effects, funding public ID, schedule dates, expiry, preview hash, and both current versions. Display every returned value; never recreate the accounting calculation or use a preview to mutate status.
- `loan.replacement.execute` requires literal `confirmed: true`, the exact fresh replacement public ID/hash/both versions, a non-blank reason, and a stable idempotency key. A stale/expired/mismatched preview, funding mismatch, or any downstream activity stops the workflow and requires re-inspection plus fresh confirmation.
- Execution is the only way to atomically append correction history, activate the existing draft, cancel remaining old schedules, and mark the old loan `replaced`. Never call ordinary activation, create another loan, or directly edit status/schedules/balances to simulate it.
- `loan.replacement.reverse` requires a separate explicit confirmation, non-blank reason, and new stable idempotency key. It creates compensating records only when the authoritative downstream check is clear; posted payments, actual payouts, or dependent workflows block reversal.

## Loan disbursements

- A loan disbursement is an actual, append-only ledger event. It does not create, recalculate, or mutate the approved loan schedule.
- Inspect `loan.disbursement.list` before a draft and display its backend-provided approved principal, net disbursed amount, signed variance, and status. Under- or over-disbursement is a warning requiring an explicit human decision; never silently make amounts fit.
- The evidence lifecycle is draft first, then `loan.disbursement.evidence.prepare`, unchanged-byte PUT using only a non-expired returned URL and its headers, and `loan.disbursement.evidence.finalize`. A `ready` prepare result is already finalized and must not be PUT/finalized again; upload absence/expiry, checksum conflict, or finalization mismatch stops without post. Do not use draft `evidenceFilePublicIds` or expose signed URLs.
- `loan.disbursement.post` requires explicit confirmation and a stable idempotency key. Reuse that key only to retry the identical post; a key conflict or locked draft stops for review.
- `loan.disbursement.reverse` requires a re-list that selects the exact `posted` event, explicit human confirmation, a non-blank reason, and its own stable idempotency key. It posts a compensating event rather than deleting the original.
