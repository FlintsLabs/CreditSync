# Floating Advance-Interest Summary Design

## Goal

Show the agreed advance-interest deduction and net borrower payout on an active floating-loan detail page. The backend remains the sole accounting calculator; the frontend only formats returned decimal strings.

## Scope

- Extend the presented loan-detail contract with an optional `floatingPayoutSummary` for floating loans with a complete interest policy.
- Return `fullPeriodInterest`, `advanceInterest`, `netBorrowerPayout`, `periodDays`, `firstPeriodStartDate`, and `firstPeriodDueDate` as authoritative backend values.
- Render those values through the existing `FloatingInterestSummary` component.
- Compare the contract summary with posted actual-disbursement totals. A mismatch is a visible warning only and never changes principal, policy, schedules, or ledgers.
- Add matching Thai and English copy.

Identity images, evidence records, settlement behavior, and financial posting are outside this change.

## Backend Design

`presentLoan` derives `floatingPayoutSummary` by reusing the existing floating-policy calculation used by loan preview and activation. All money uses `decimal.js` and is serialized as two-decimal strings. Dates use the contract start date and the policy period calendar.

The summary represents agreed contract economics:

- `fullPeriodInterest`: interest for one complete policy period.
- `advanceInterest`: the full-period interest when `advanceInterestPeriods` is one, otherwise `0.00`.
- `netBorrowerPayout`: principal minus advance interest.
- `periodDays` and period dates: backend-calculated calendar boundary for the first period.

The response does not infer that every difference between gross and attributed disbursement is interest. Actual payout reconciliation remains a separate comparison against posted disbursement events.

## Frontend Design

The loan-detail response type accepts the optional summary. For floating loans, `LoanDetail` passes all six values to `FloatingInterestSummary`, which already contains the approved layout for full-period interest, advance interest, net payout, period length, and period dates.

When posted disbursement totals are available and differ from the contract summary, show a localized warning with the contract net payout and posted gross payout. Draft and reversed events do not count as actual payout. Missing summary data keeps the existing policy-only view rather than showing fabricated zero values.

For the corrected weekly loan, the card must show:

- full-period interest `600.00` THB;
- advance interest `600.00` THB;
- net borrower payout `4,400.00` THB;
- seven-day weekly period beginning `2026-08-13`.

## Error and Compatibility Behavior

- Scheduled and single-payment loan responses remain unchanged apart from an absent optional field.
- An incomplete floating policy produces `floatingPayoutSummary: null`; it does not throw or calculate partially.
- Exact decimal strings are preserved end to end.
- A payout mismatch is informational and cannot mutate accounting state.

## Verification

Use TDD:

1. Backend test first proves that a `5,000.00` principal, weekly 12% policy with one advance period returns `600.00` advance interest and `4,400.00` net payout.
2. Backend compatibility test proves a floating loan with no advance period returns `0.00` advance interest and full principal as net payout.
3. Frontend test first proves Loan Detail renders the supplied values and does not calculate them locally.
4. Frontend mismatch test proves only posted disbursements drive the informational comparison.
5. Run backend typecheck/tests and frontend test/lint/build before merge and deployment.

