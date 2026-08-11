# Dashboard Floating Daily-Interest Overdue Design

## Goal

Make the Dashboard report overdue floating daily-interest obligations from the same payment-health source as the Loan List. A floating loan appears once in the borrower queue while preserving the count and maximum age of its unpaid daily accruals.

## Product semantics

- A floating loan has no fixed principal schedule or fixed term.
- When its explicit policy charges interest daily, each materialized daily-interest accrual is payable on its accrual date.
- An unpaid accrual becomes overdue on the following Asia/Bangkok business date; an accrual due today remains due today.
- Principal remains unscheduled and is not treated as overdue merely because the loan is open.
- The first-day treatment policy continues to determine when the first accrual exists. Dashboard code must not infer or recreate this policy.

## Dashboard contract

- `overdueBorrowerCount` counts overdue borrower **loans**, not overdue schedules or accrual days.
- The borrower due queue returns one row per floating loan, even when several daily accruals are unpaid.
- A floating queue row exposes exact two-decimal strings for `remainingDue` and `totalDueNow`, both representing the aggregated payable interest for that row.
- It exposes `overdueItemCount` for the number of unpaid overdue daily accruals and `overdueDays` for their maximum overdue age.
- A floating row has no schedule identifier. Its repayment action prefills only the public loan identifier; no synthetic schedule is created or sent.
- Scheduled-loan queue behavior remains one row per schedule. Scheduled rows may expose `overdueItemCount: 1` when overdue so the frontend has one uniform display contract.
- The priority list continues to omit zero-count items and labels its borrower count using the number of overdue loans.

## Architecture and data flow

1. Load the tenant's active borrower loans for Dashboard borrower payment health.
2. Evaluate each loan through `getLoanPaymentHealth`, which owns Asia/Bangkok date selection, floating-interest materialization, exact aggregation, grace rules, and overdue classification.
3. Build Dashboard summary counts from loan health rather than independently counting overdue schedule snapshots.
4. Build the borrower due queue from the same health results:
   - floating: one aggregate loan row;
   - scheduled: retain schedule-level actionable rows.
5. Preserve existing tenant-admin authorization and short tenant cache boundaries.

The Dashboard must not call its own REST API internally. It calls the application service directly in the backend process.

## UI behavior

- Floating rows show borrower name, floating repayment type, exact aggregated amount, localized overdue status, `ค้าง {{count}} รายการ`, and `สูงสุด {{days}} วัน` (with matching English copy).
- Scheduled rows retain their installment and due-date presentation.
- Clicking a floating row navigates to `/transactions/new?loanId=<public-loan-id>`.
- Clicking a scheduled row retains both `loanId` and `scheduleId` query parameters.
- Loading, empty, partial-error, and five-row initial queue behavior remain unchanged.

## Failure and safety behavior

- If payment-health evaluation fails, the affected Dashboard resource returns an error; the frontend keeps other independently loaded sections visible and offers its existing retry action.
- No financial record is edited or deleted. Floating accrual materialization remains idempotent and append-only under its existing service.
- Money stays as exact decimal strings at the Dashboard public boundary. The UI does not calculate accounting amounts.

## Testing and verification

- Backend regression: multiple overdue floating accruals aggregate into one Dashboard row with exact total, `overdueItemCount`, and `maxOverdueDays`.
- Backend regression: `overdueBorrowerCount` counts one floating loan once and includes scheduled overdue loans without counting their individual rows as separate loans.
- Frontend regression: floating queue copy renders count/maximum age and its action omits `scheduleId`.
- Existing loan payment-health tests remain green, including the next-Bangkok-day overdue rule and exact large-value aggregation.
- Run backend tests/typecheck, frontend tests/lint/build, then production browser verification after deployment.

## Out of scope

- Creating fixed schedules for floating loans.
- Making principal due daily.
- Changing daily-interest rates, first-day treatment, repayment allocation, or accrual posting behavior.
- Redesigning the Dashboard hierarchy or Loan List cards.
