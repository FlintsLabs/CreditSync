---
name: manage-disbursements
description: Use when listing, drafting, evidencing, posting, reviewing variance for, or reversing an actual CreditSync loan disbursement.
---

# Manage CreditSync Loan Disbursements

## Overview

An actual disbursement is an append-only funding-ledger event, separate from loan approval and its schedule. It never changes approved principal, installment amounts, due dates, or the schedule. CreditSync calculates and reports disbursement variance; do not calculate a replacement figure or silently make it fit.

## Draft, evidence, and post

1. Resolve the loan public UUID through the borrower portfolio and call `loan.disbursement.list`. Show the backend's approved principal, net disbursed amount, signed variance, status, and any current events.
2. Collect the exact actual gross amount, loan-attributed amount, channel, disbursed timestamp, and optional returned public bank-profile UUID, payee hint, and note. Use two-decimal money strings and an ISO timestamp. Do not use internal IDs.
3. Call `loan.disbursement.draft`. It creates an editable event only. Do not supply `evidenceFilePublicIds`; that field is intentionally rejected until evidence is finalized.
4. If evidence is supplied, calculate its SHA-256 from the unchanged local bytes. Call `loan.disbursement.evidence.prepare` with the draft UUID, supported MIME type, byte size, checksum, and optional original name. Inspect the result before a PUT; do not reveal signed URLs or headers.
5. PUT only those unchanged bytes to the returned signed URL before expiry, with exactly the returned required headers. Then call `loan.disbursement.evidence.finalize` with the draft and evidence public UUID. If preparation/finalization fails, stop; do not post an unverified-evidence claim.
6. Re-list the loan and show the current backend variance. If status is `under_disbursed` or `over_disbursed`, explicitly warn the operator; it never authorizes a schedule mutation.
7. Show the exact draft public UUID, amounts, channel, timestamp, finalized-evidence state, variance, and the stable post idempotency key. Obtain explicit confirmation to post that exact event.
8. Call `loan.disbursement.post` with only `{ disbursementPublicId, idempotencyKey }`. Retain that key for retrying the same intent only. Report returned status, audit IDs, and correlation ID.

## Reversal

1. Re-list the parent loan and identify the exact posted disbursement public UUID. Do not guess an event or reverse a draft/reversed event.
2. Explain that reversal posts a compensating ledger event, then obtain explicit human confirmation and a specific non-blank reason.
3. Call `loan.disbursement.reverse` with `{ disbursementPublicId, reason, idempotencyKey }`, using a new stable key for this reversal intent. Report returned status, audit IDs, and correlation ID.

## Stop gates

| Condition | Required action |
| --- | --- |
| `under_disbursed` or `over_disbursed` | Show exact signed variance and wait for an explicit decision; never change the loan schedule. |
| Missing post confirmation | Leave the event as draft; do not call post. |
| Evidence failure or expired upload | Stop and re-prepare as required; do not claim evidence was attached. |
| Idempotency-key conflict | Stop and inspect the existing operation; never generate a new key to bypass it. |
| Missing reversal reason/confirmation | Do not call reverse. |
| Locked, posted, or reversed draft | Do not edit or repost; use the supported reversal workflow if appropriate. |

Follow the root `creditsync` skill and `financial-rules.md` for inspect-before-write, authorization, and append-only accounting boundaries.
