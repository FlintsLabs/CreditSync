---
name: settle-floating-loans
description: Use when previewing, closing, or reversing a CreditSync floating loan, including daily or weekly policies, accrued interest, advance interest, or a stale close-out preview.
---

# Settle floating loans

Close-out is `inspect → preview → explain → explicit confirmation → execute`. CreditSync owns accrual materialization and every amount. Never calculate, prorate, round, refund, or rewrite the composition in conversation.

## Required workflow

1. Resolve the borrower and call `borrower.portfolio`. Select the exact active floating loan public UUID; stop for ambiguous identity or any other loan status/type.
2. Collect the Bangkok `asOfDate` as `YYYY-MM-DD`, then call `loan.settlement.preview` with only `{ loanPublicId, asOfDate }`.
3. Show the preview public UUID, expiry, balance version/hash, and every exact two-decimal component: `outstandingPrincipal`, `dueInterest`, `accruedNotDueInterest`, `outstandingFees`, `outstandingPenalties`, `nonRefundableAdvanceInterest`, and `settlementTotal`.
4. Explain that `nonRefundableAdvanceInterest` is already-paid history: it is not added to the new settlement total and must not be refunded. There is no override or refund field.
5. Obtain explicit confirmation of that exact preview and a specific non-blank reason. A request to inspect, quote, preview, explore, or refund is not confirmation.
6. Call `loan.settlement.execute` with the unchanged settlement UUID/hash, literal `confirmed: true`, the reason, and a stable idempotency key for this exact execution intent.
7. Report the close-account transaction components, paid loan state, audit public IDs, and correlation ID. Retry only the identical intent with the same key.

## Compensating reversal

1. Use only the exact executed settlement public UUID retained from the same-task execute result or selected by the owner in the Web UI. Never guess or substitute a loan UUID.
2. Explain that reversal appends negative transaction, allocation, accrual, funding-effect, and audit records; it never edits or deletes posted history.
3. Obtain an explicit non-blank reason and confirmation for that exact settlement. Use a new stable idempotency key for this exact reversal intent.
4. Call `loan.settlement.reverse` with only `{ settlementPublicId, reason, idempotencyKey }`. Report the negative transaction components, restored active loan state, audit public ID, and correlation ID.
5. Retry only the identical reversal intent with the same key. Stop on idempotency conflict, an already-reversed settlement, or authoritative downstream-activity blocker; report the backend code/message for human review.

## Stop gates

- On stale, expired, changed balance, later accrual, or not-latest state, re-inspect and re-preview. Prior confirmation does not carry over; stop for fresh confirmation.
- Stop on an idempotency conflict; inspect the existing operation and never bypass it with a new key.
- Stop if asked to refund non-refundable advance interest, alter a component, use an internal ID, settle a non-active/non-floating loan, or call REST/SQL.
- A settlement is append-only financial history. Do not edit/delete its transaction or reverse earlier payments underneath it; use only `loan.settlement.reverse` for its compensating reversal.

Follow the root `creditsync` skill for authorization, safe output, and general inspect-before-write rules.
