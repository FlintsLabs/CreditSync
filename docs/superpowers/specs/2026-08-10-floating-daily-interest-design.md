# Floating Daily Interest Design

## Goal

Support open-ended borrower loans whose interest accrues daily from the outstanding principal, using either a fixed amount per 1,000 THB per day or a percentage per day. The same financial results must be available through the web application and Remote MCP.

## Scope

This feature adds a new `floating_daily` interest policy to loans with `repaymentType: "floating"`. Existing fixed-schedule loans and existing floating loans remain unchanged. It does not create an infinite payment schedule and does not change funding-source write permissions through MCP.

## Loan terms

The floating-daily policy is available only when repayment type is `floating` and contains:

- `dailyInterestMode`: `per_thousand` or `percent`
- `dailyInterestRate`: a decimal string with two to four decimal places
- `firstDayTreatment`: `deduct` or `start_next_day`
- `interestStartDate`: the Bangkok business date of disbursement

The rate formulas are:

- `per_thousand`: `outstandingPrincipal / 1000 × dailyInterestRate`, rounded half-up to two decimals for each accrued calendar day. Example: 5,000.00 at 15.00 produces 75.00 per day.
- `percent`: `outstandingPrincipal × dailyInterestRate / 100`, rounded half-up to two decimals for each accrued calendar day. Example: 5,000.00 at 1.50 produces 75.00 per day.

The rate applies to the opening principal for the business day. A principal payment on a day lowers the rate beginning the next business day. Interest never compounds: unpaid interest stays an interest balance and is not added to principal.

`deduct` records a paid first-day interest accrual on the disbursement date and exposes net cash paid out as `principal - firstDayInterest`. `start_next_day` charges no interest on the disbursement date and creates the first accrual on the following Bangkok date. Both options make the next-day interest due without requiring a fixed schedule.

## Ledger and persistence

Add immutable `loan_interest_accruals` rows. Each row is tenant-scoped and unique on `(tenant_id, loan_id, accrual_date)`, and records:

- public UUID, loan, accrual date, opening principal, rate mode/value, interest amount
- status: `accrued`, `paid`, `reversed`, or `waived`
- optional source transaction and reversal reference
- actor, creation time, and audit correlation

Add nullable policy columns to `loans` for the daily interest mode, rate, first-day treatment, and interest start date. Normal loans leave all of these null. Add `loan_disbursements` as an immutable record of gross principal, initial interest deduction, net cash paid, and disbursement timestamp so a first-day deduction is visible and auditable rather than hidden in a note.

The accrual service runs inside the same database transaction as every floating-loan balance read that needs current dues, payment preview/post, principal adjustment, close, reversal, and loan-detail fetch. It creates missing rows in date order and locks the loan before calculating. Retrying is safe because the database uniqueness constraint prevents duplicate days. Reversal uses compensating transaction/accrual records and never deletes history.

## Payment behavior

Floating loans have no `loan_schedules` rows. A payment allocation may therefore reference a loan without a schedule. Before preview or post, the service accrues interest through the payment's Bangkok received date using the opening-principal rule.

For a floating-daily allocation, payment order is `penalty → fee → accrued interest → principal`. This release does not create a new late-fee policy for floating loans, so normally the payable components are accrued interest then principal. A partial payment can pay interest only; any principal amount paid reduces the next day's daily interest. A payment cannot exceed the current due balance. Posting creates a normal transaction with exact interest/principal components and updates the affected accrual rows to paid or partial through their remaining amount.

Automatic matching must not auto-post a floating loan in this release. It may show the current calculated due as a candidate, but a human or agent must submit an explicit allocation and receive a fresh preview. This avoids silently assigning a payment to an open-ended obligation.

Payment reversal restores the exact interest/principal components, restores the affected accrual state, and recomputes future accruals only through compensating records. It must reject a reversal if a later principal-affecting payment would make the prior-day opening-balance chain inconsistent; the operator must reverse later payments first.

## Interfaces

REST and MCP loan preview/draft/activation contracts gain an optional `floatingDailyInterest` object only for `repaymentType: "floating"`:

```ts
type FloatingDailyInterest = {
  mode: "per_thousand" | "percent";
  rate: string;
  firstDayTreatment: "deduct" | "start_next_day";
};
```

The result includes `firstDayInterest`, `netDisbursement`, `nextInterestDate`, `dailyInterestAtCurrentPrincipal`, and a current `accruedInterest` balance. Existing clients remain compatible because the object is optional and the existing annual `interestRate` stays `"0.00"` for floating-daily loans.

Add an MCP read-only `get_floating_interest_summary` tool and extend preview/draft/activation schemas. Tool results retain schema version `1.0` only if optional output fields are backwards compatible; otherwise introduce a clearly versioned tool schema and preserve existing tool inputs.

## Web behavior

The new-loan wizard shows floating-daily fields only after selecting Floating. It offers the two rate modes with context-aware labels, first-day treatment, and a preview card that shows gross principal, first-day interest, net cash paid, next interest date, and current daily interest. The detail page shows the policy, current principal, accrued interest, and a date-ordered accrual ledger. Payment Inbox displays the current floating-loan breakdown before the user confirms an explicit allocation.

All visible strings are added to English and Thai locales. Money and dates use the active locale and Bangkok business date.

## Safety and verification

- All money uses `decimal.js`; no floating-point arithmetic.
- The business day is `Asia/Bangkok`, stored as `YYYY-MM-DD` for accrual dates.
- Active policy terms are immutable. Corrections require an audited adjustment or reversal.
- Backfill is not required: existing loans have no floating-daily policy and no generated accruals.
- Unit and integration coverage includes both rate modes, rounding, first-day options, partial principal payment timing, no compounding, idempotent accrual creation, explicit payment/post/reversal, tenant isolation, and stale/concurrent posting.
- Migration tests must apply from v0.3.5 and verify no existing schedule/loan totals change.
