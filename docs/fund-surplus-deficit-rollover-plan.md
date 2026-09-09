# Fund Surplus, Deficit, and Rollover Plan

## Problem To Solve

For bank-funded lending, real operations often look like this:

1. The business lends money out to borrowers.
2. Some borrowers have not repaid yet.
3. The bank repayment due date arrives anyway.
4. The operator pays the bank first.
5. This creates a temporary deficit if collections are behind, or a surplus if collections are ahead.
6. Over time, the system must show:
   - accumulated profit
   - accumulated deficit
   - cash already absorbed by the operator
   - cash available to roll into a new fund or drawdown

The business may then want to:

- carry surplus into another fund source
- use retained surplus as new starting capital
- refinance or re-fund an older obligation with a newer one
- keep a visible history of these carry-forward decisions

## Current Limitation

The current system supports:

- upstream drawdowns
- bank repayment schedules
- repayment posting

But it does not yet have a clear model for:

- bank-side realized surplus or deficit by drawdown
- accumulated spread after partial borrower underpayment
- rolling surplus into another funding source
- refinancing one drawdown with another drawdown
- carrying losses forward visibly

So the answer right now is:

- not fully supported yet

## Recommended Conceptual Model

Separate these concepts clearly:

### 1. Funding Obligation

Represents what is owed upstream to the bank or funder.

Examples:

- scheduled installment
- interest due
- fees
- VAT
- penalties

### 2. Downstream Collection Position

Represents what has been collected from borrower loans funded by that source.

Examples:

- principal collected
- interest collected
- fees collected
- overdue borrower balances

### 3. Funding Spread Position

Represents the difference between:

- downstream inflow attributable to the source
- upstream outflow already paid

This must be visible even when timing is mismatched.

### 4. Carry-Forward / Rollover

Represents explicit business decisions such as:

- retain surplus inside the same fund
- move surplus into a new fund source
- absorb deficit from owner capital
- refinance an old bank drawdown with a new bank drawdown

## Key Business States To Show

For each bank-funded source or drawdown, the UI should show:

- total allocated principal
- total borrower principal collected
- total borrower interest collected
- total bank principal paid
- total bank interest paid
- total bank fees and VAT paid
- net realized spread
- unrealized spread
- current deficit or surplus
- carry-forward amount
- rollover history

## Recommended Data Additions

### 1. `fund_position_snapshots` or derived rollup

This can be computed first, materialized later if needed.

Metrics:

- `collected_principal_total`
- `collected_interest_total`
- `bank_principal_paid_total`
- `bank_interest_paid_total`
- `bank_fee_paid_total`
- `bank_vat_paid_total`
- `realized_spread`
- `unrealized_spread`
- `surplus_balance`
- `deficit_balance`

Purpose:

- make fund-level profitability and cash strain visible

### 2. `fund_rollover_entries`

Represents moving surplus, deficit support, or refinance value across funds.

Suggested columns:

- `id`
- `tenant_id`
- `from_bank_profile_id` nullable
- `from_bank_loan_id` nullable
- `to_bank_profile_id` nullable
- `to_bank_loan_id` nullable
- `entry_type`
  - `surplus_transfer`
  - `deficit_support`
  - `refinance_in`
  - `refinance_out`
  - `capitalization`
  - `manual_adjustment`
- `amount`
- `effective_date`
- `note`
- `created_by_user_id`
- `created_at`

Purpose:

- preserve all rollover decisions
- support auditability
- separate calculation from business decisions

### 3. Optional `fund_reserve_accounts`

If the business wants a cleaner structure later:

- profit reserve
- loss reserve
- owner support reserve

This is optional. Start with rollover entries first.

## Calculation Model

## Realized vs Unrealized

### Realized spread

Amount already locked in by actual cash events.

Formula concept:

- borrower cash collected attributable to the source
- minus bank cash paid

### Unrealized spread

Expected but not yet realized margin.

Formula concept:

- projected borrower inflow still expected
- minus projected upstream cost still expected

This distinction matters because a source may look profitable in total but still be in a current cash deficit.

## Surplus and Deficit

### Surplus

When attributed borrower inflows exceed bank repayments already paid.

This surplus may be:

- retained in the same source
- moved into a new source
- converted into owner capital

### Deficit

When bank repayments already paid exceed attributed borrower inflows collected so far.

This deficit may be:

- temporary timing gap
- actual underperformance
- operator-supported cash injection

The system should show both:

- current deficit
- cumulative deficit support provided

## Re-Funding / Refinance Scenarios

### Case A: Re-fund from surplus

Example:

- drawdown A already generated positive spread
- the operator wants to seed drawdown B or a new capital pool

Action:

- create `fund_rollover_entries` row
- reduce surplus balance on source A
- increase starting balance on source B

### Case B: Deficit support from owner capital

Example:

- bank drawdown A is negative because borrowers are late
- owner adds temporary support cash

Action:

- create `fund_rollover_entries` row with `deficit_support`
- link owner capital source or manual capital support

### Case C: Bank refinance

Example:

- drawdown A is still open
- operator uses new drawdown B to settle or support drawdown A

Action:

- create rollover entry:
  - `refinance_out` on B
  - `refinance_in` on A

This must be visible in source and drawdown history.

## UX Proposal

### Fund Source Detail

Add a `Position` section with:

- realized spread
- unrealized spread
- current surplus / deficit
- cumulative support injected
- available carry-forward balance

### Drawdown Detail

Add a `Spread Position` card with:

- borrower collections attributed
- bank repayments posted
- current timing gap
- realized profit/loss
- carry-forward actions

### Rollover Actions

Add a `Rollover / Re-Fund` action allowing:

- move surplus into another source
- convert surplus into pool capital
- support deficit from owner capital
- refinance one drawdown from another

### Dashboard

Add operational cards:

- `Bank Deficit Exposure`
- `Carry-Forward Surplus Available`
- `Refinance Candidates`
- `Sources Under Stress`

## Charts

### 1. Realized vs Unrealized Spread

Lines:

- realized spread
- unrealized spread
- cumulative bank outflow

Purpose:

- show whether apparent profitability is actually liquid yet

### 2. Surplus / Deficit Trend

Bars:

- period surplus
- period deficit

Line:

- cumulative carry-forward balance

### 3. Re-Fund Flow Chart

Sankey or flow view:

- source A surplus
- moved into source B
- used to support drawdown C

Purpose:

- show capital recycling clearly

## API Direction

### Position Endpoints

- `GET /bank-profiles/:id/position`
- `GET /bank-loans/:id/position`

Return:

- realized spread
- unrealized spread
- surplus balance
- deficit balance
- carry-forward available

### Rollover Endpoints

- `GET /fund-rollovers`
- `POST /fund-rollovers`

### Dashboard Endpoints

- `GET /dashboard/fund-stress`
- `GET /dashboard/carry-forward-summary`

## Product Rule Recommendation

Do not automatically move surplus into another fund without an explicit rollover event.

Why:

- accounting must stay auditable
- the operator may choose to retain, withdraw, or reassign the surplus

Recommended rule:

- calculations derive surplus/deficit
- user actions create rollover decisions

## Bottom Line

If you want the system to support:

- bank due first, borrower still unpaid
- visible cumulative profit/loss by fund
- surplus carry-forward into another fund
- deficit support and refinancing between funds

Then the system needs:

- position tracking
- rollover entries
- explicit surplus/deficit handling

Without those layers, the system can show repayments, but it cannot explain capital recycling and cumulative funding performance clearly enough.
