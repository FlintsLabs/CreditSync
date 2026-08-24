# Loan Schedule Deferral Design

**Date:** 2026-08-25
**Status:** Approved in conversation

## Goal

Allow a web user to defer an unpaid scheduled installment when a borrower requests a postponement, without treating that installment as overdue, while adding a replacement installment at the end of the contract.

## Rules

- A deferral is allowed only when the selected schedule row has `paidTotal = 0.00` and still has a positive scheduled amount.
- A partially paid installment cannot be deferred. It remains `partial`/`due`/`overdue` according to the existing payment-health rules and exposes the remaining balance.
- The original row remains visible with status `deferred` and its original contractual amounts/date preserved for history.
- The command creates one replacement row at the end of the schedule with the original row's contractual principal, interest, fee, and total, due on the next calendar day after the current schedule end date.
- The replacement row may itself be deferred later if it still has no payment.
- A deferral requires a non-blank reason and an idempotency key. It creates audit history containing source and replacement public IDs, original due date, replacement due date, amount fields, reason, request/correlation context, and actor.
- Summary counts exclude deferred rows from paid, overdue, due-today, and pending counts; total installments includes replacement rows.
- Existing posted transactions and commission attribution are not modified.
- Money remains two-decimal decimal strings and date arithmetic uses the Asia/Bangkok business date.

## Data model

Add an append-only `loan_schedule_deferrals` table linking the source schedule row to the replacement schedule row. The table stores tenant/loan ownership, public IDs, reason, actor, idempotency key, request/correlation IDs, and created timestamp. Add a `deferred` status to the schedule status contract and a nullable `deferredAt`/link as needed by the existing schema conventions; contractual fields on existing activated rows remain immutable. The source row's mutable operational fields are transitioned to a terminal `deferred` state with zero remaining balance so payment allocation cannot target it; the replacement row carries the outstanding contractual amount.

## API and UI

Add `POST /loans/:loanPublicId/schedule/:schedulePublicId/defer` with `{ reason }`, command context from request headers, and the standard domain error envelope. The response returns source/replacement row summaries, the updated loan schedule totals, audit public ID, and correlation ID.

The schedule table adds a deferral action only for rows with zero paid amount and positive remaining amount. The action opens a reason dialog, confirms the old and new due dates and amount, submits an idempotency key, refreshes schedule and summary data, and displays the new `deferred` status. Partially paid rows show paid/remaining amounts and no deferral action. English and Thai translations are updated together.

## Error handling

- Reject missing/blank reasons with validation error.
- Reject missing idempotency key.
- Reject loans that are not active scheduled loans, inaccessible loans/rows, paid rows, partially paid rows, already deferred rows, or rows with no remaining contractual amount.
- Lock the loan and source schedule row in one database transaction; re-check eligibility under lock; make the operation idempotent by tenant plus idempotency key.
- Invalidate the loan cache after a successful command.

## Verification

Backend tests cover successful deferral, zero-paid eligibility, partial-payment rejection, repeated idempotency, replacement-at-tail date/amounts, summary exclusion, and audit output. Frontend tests cover status rendering, partial-payment display, action visibility, confirmation/reason submission, and refresh behavior. Run disposable PostgreSQL backend tests/typecheck plus frontend test/lint/build.
