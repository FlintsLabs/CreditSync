# Daily Loan Entry Modes Design

## Goal

Make fixed daily loans practical to enter when either the borrower has proposed an affordable daily payment or the operator has set the interest terms. Both paths must produce the same explicit daily schedule and the same persisted loan terms. This does not alter open-ended floating daily-interest loans.

## Scope

The feature applies only when `repaymentType` is `daily`. The repayment-type choice remains the first field in the loan-terms step. When Daily is selected, the form offers a duration unit and an entry mode:

- Duration unit: `days` or `months`; one month is always 30 daily instalments.
- Entry mode: `daily_payment` or `daily_interest`.

`floating` remains a separate open-ended product with no fixed term or fixed schedule. Monthly and weekly products retain their existing annual-rate inputs.

## Daily-payment mode

The operator enters principal, duration, and the borrower’s fixed daily payment. The system derives:

- `totalInstallments`: duration in days, or months multiplied by 30.
- `totalRepayment`: daily payment multiplied by total instalments.
- `totalInterest`: total repayment minus principal.
- `dailyInterest`: total interest divided by total instalments.
- `flatDailyRatePercent`: daily interest divided by original principal, multiplied by 100.
- Reference rates: flat daily rate multiplied by 30 for monthly and by 365 for annual.

The loan is invalid if total repayment is below principal. A zero-interest loan is valid. All display and persisted money values use decimal strings rounded half-up to two places; rate values use four decimal places for display and contract values. The generated schedule distributes principal and interest amounts across instalments with the final instalment absorbing any rounding remainder, so every schedule sums exactly to the principal and total repayment.

Example: principal `2500.00`, 15 days, payment `200.00` gives total repayment `3000.00`, total interest `500.00`, daily interest `33.33` with the final rounding remainder, and a flat daily rate of `1.3333%` (reference monthly `40.0000%`, annual `486.6667%`).

## Daily-interest mode

The operator enters principal, duration, and exactly one interest expression:

- percentage per day;
- fixed baht per day; or
- baht per 1,000 principal per day.

The daily interest is calculated from the original principal and stays fixed for the whole scheduled loan. The system derives total interest, total repayment, and fixed daily payment. For a percentage rate, daily interest is `principal × rate / 100`; for per-1,000 it is `principal / 1000 × rate`. Each daily amount is rounded half-up to two places and the final instalment carries the remainder. The UI also shows the equivalent forms, including flat daily/monthly/annual percentage, as read-only calculation results.

## Persistence and interfaces

The existing `repaymentType: "daily"`, `totalInstallments`, `installmentAmount`, `interestRate`, and schedule remain the source of truth for compatibility. Add explicit optional daily-entry metadata to the loan draft and active loan:

- `dailyTermUnit`: `days` or `months`;
- `dailyTermValue`: positive integer entered by the operator;
- `dailyEntryMode`: `daily_payment` or `daily_interest`;
- `dailyInterestInputMode`: `percent`, `fixed_amount`, or `per_thousand` when the entry mode is daily interest;
- `dailyInterestInputValue`: decimal string when the entry mode is daily interest;
- `dailyFlatRatePercent`: derived four-decimal percentage per day.

The service, not the client, derives and validates all calculated fields. REST preview/create/update and MCP preview/draft tools receive the selected input mode and values, return a `dailyLoanCalculation` summary, and continue returning existing schedule fields. Active loan terms are immutable. Existing daily loans receive null metadata and preserve their current schedules.

## Web behavior

After Daily is selected the wizard shows, in order: duration unit chips, duration value, entry-mode chips, the inputs for that mode, then a calculation card before the existing preview/confirm step. The card always shows instalment count, daily payment, total repayment, total interest, daily interest, and flat daily/monthly/annual percentages. Input labels make clear that reference percentages are flat, not reducing-balance or effective rates. Thai and English localized text is required.

## Validation and safety

- All money calculation uses `decimal.js`; JavaScript floating point is not used.
- Terms must be positive, duration must be an integer, and daily payment must be positive.
- An inferred negative interest result is rejected; no silent clamping occurs.
- A fixed daily-payment result can be zero interest but cannot be less than principal in aggregate.
- Rounding is deterministic and schedule totals reconcile exactly.
- Existing API clients that provide current daily fields remain supported; the new entry metadata is optional.

## Verification

Unit tests cover both entry modes, days/months conversion, zero interest, invalid payment below principal, percentage/fixed/per-thousand interest, rounding remainders, and the examples `2500 / 15 / 200`, `10000 / 24 / 500`, and `2000 / 1.5% / 200`. Service, REST, MCP, and frontend workflow tests verify that all paths produce identical persisted daily terms and schedules.
