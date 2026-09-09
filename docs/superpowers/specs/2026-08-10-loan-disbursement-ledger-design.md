# Loan Disbursement Ledger Design

## Goal

Record the actual cash disbursements made to a borrower independently from the approved principal and repayment schedule. Operators can enter multiple bank-transfer, cash, or adjustment records, optionally attach evidence, and retain an immutable audit trail without changing loan terms.

## Scope

This feature adds a tenant-scoped disbursement ledger to every loan. It does not alter the approved principal, borrower interest, repayment schedule, or funding allocation merely because actual cash transferred differs from the principal. The existing initial `loan_funding_allocations` record continues to describe the source of capital and is not a borrower disbursement record.

## Model

Each `loan_disbursements` row is a single actual payout event with a UUID public ID and contains:

- loan and tenant;
- `grossAmount`: the actual amount on a transfer slip or amount of cash handed over;
- `loanAttributedAmount`: the portion attributed to this loan; it may be different from gross amount for a grouped transfer;
- channel: `bank_transfer`, `cash`, or `adjustment`;
- disbursed timestamp, optional source bank profile, counterparty/payee hint, and required operator note when the attributed amount differs from gross amount;
- evidence file references, optional for every payout;
- lifecycle: `draft`, `posted`, or `reversed`; and a reversal link/reason for compensating history;
- actor, request ID, correlation ID, and created/posted/reversed timestamps.

The ledger calculates, without enforcing equality:

- approved principal;
- posted loan-attributed disbursements net of reversals;
- variance = actual attributed disbursements minus approved principal;
- status `under_disbursed`, `matched`, or `over_disbursed` using exact two-decimal money.

Gross transfer amount is never counted as a loan disbursement beyond its attributed portion. This permits one slip to cover multiple loans while each loan maintains a clear attributed amount and evidence link.

## Workflow

1. On the loan detail page, the Funding State card explains whether a capital source has been allocated. It does not claim a direct-capital allocation is an unmatched drawdown.
2. A new `Disbursements` card shows approved principal, net disbursed, variance, and status. A grouped transfer is visibly marked with gross and attributed amounts.
3. `Add disbursement` creates an editable draft. The operator selects channel, enters the amount, date/time, source profile when applicable, and a note. The form requires an attributed amount and requires an explanation when it differs from gross amount.
4. Optional evidence uses the existing signed MinIO upload lifecycle: prepare file, direct upload, finalize, then attach finalized file public IDs to the draft. The browser and MCP use the same capability flow; raw image bytes never pass through normal application requests.
5. `Post disbursement` locks the loan and draft row, validates evidence ownership/finalization, writes the immutable posted record, appends an audit record, and refreshes the read model. Mismatched/over/under totals produce a warning, never a block.
6. A posted event cannot be edited or deleted. `Reverse disbursement` requires a reason and creates compensating negative effect while preserving the original record. A corrected payout is a new draft and post.

## Interfaces

Add REST endpoints under `/loans/:loanPublicId/disbursements` for list, create draft, update draft, prepare evidence, finalize evidence, post, and reverse. Responses expose public IDs, money strings, lifecycle state, evidence summary, audit public ID, and correlation ID.

Add matching MCP tools:

- `loan.disbursement.list` (read-only);
- `loan.disbursement.draft`;
- `loan.disbursement.evidence.prepare` and `loan.disbursement.evidence.finalize`;
- `loan.disbursement.post`;
- `loan.disbursement.reverse`.

Tool inputs use UUID public IDs and exact money strings. Draft/post/reverse use idempotency keys; post and reverse are destructive. These tools do not update loan terms, schedules, or funding-source balances in this release.

## Detail-page design

For loans with a fixed daily schedule, render a separate `Daily repayment terms` card before Funding State. It displays duration, scheduled daily payment, total instalments, total interest, daily interest, and flat daily/monthly/annual reference rates when daily metadata exists. It labels scheduled payment as the agreed instalment, not a flexible minimum.

Regular payments below an instalment leave the scheduled remainder due. An amount above the scheduled remainder is not automatically posted as a normal payment; the UI offers the existing/next early-settlement preview flow instead. This preserves the agreed flat-interest schedule and makes any unearned-interest discount explicit.

## Safety and verification

- All money is Decimal/string based and tenant-scoped.
- Evidence is optional, immutable after finalization, and checked against tenant/loan/draft ownership before posting.
- A reversed disbursement has one compensating reversal only; repeat requests return the same result idempotently.
- Audit records include before/after, actor, request/correlation ID, and reason for a reversal or grouped allocation.
- Tests cover multiple payouts, cash, group attribution, under/matched/over variance, evidence retries, draft updates, post races, reversal idempotency, tenant isolation, and non-mutation of loan principal/schedule/funding allocation.
