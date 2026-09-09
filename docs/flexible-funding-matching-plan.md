# Flexible Funding Matching Plan

## Problem To Solve

The product must support these real-world flows:

1. A borrower loan can be created before its funding source is known.
2. A fund drawdown can be created before the downstream borrower loan is known.
3. One borrower loan may be funded by multiple drawdowns or fund sources.
4. One drawdown may be split across multiple borrower loans.
5. Allocations may need to be adjusted later without destroying historical traceability.

This means the system must support many-to-many matching and must not require a strict creation order.

## Current Limitation

The current schema still has `loans.bankLoanId`, which implies one borrower loan points to one upstream drawdown.

That is not enough for:

- partial funding from multiple drawdowns
- late matching after creation
- rebalancing allocations later

The current implementation supports upstream repayment scheduling and repayment recording, but it does not yet support flexible downstream funding allocations.
It also does not yet support capital pools whose available matching balance grows from retained profit.

## Recommended Model

The source of truth should be:

- borrower loans
- upstream drawdowns
- allocation rows between them

Instead of treating `loans.bankLoanId` as authoritative, use a dedicated allocation table as the real matching layer.

## Core Concepts

### 1. Borrower Loan

Represents the downstream obligation to your customer.

Key concepts:

- principal requested
- principal approved
- principal disbursed
- funded amount
- unfunded amount
- funding status

Suggested funding statuses:

- `unfunded`
- `partially_funded`
- `fully_funded`
- `overfunded`

### 2. Upstream Drawdown

Represents money pulled from a bank, personal capital pool, or investor source.

Key concepts:

- total amount
- allocated amount
- unallocated amount
- upstream repayment schedule
- weighted upstream cost

Suggested funding statuses:

- `unallocated`
- `partially_allocated`
- `fully_allocated`
- `closed`

### 2A. Capital Pool Source

Represents owner capital or investor capital that behaves like a revolving pool.

Key concepts:

- current balance
- available to allocate
- deployed principal
- realized profit
- retained profit

This source must not rely only on a fixed `credit_limit`.
Its available funding capacity must be derived from pool ledger movements.

### 3. Allocation

Represents a slice of upstream money assigned to a borrower loan.

This is the key entity that makes the system flexible.

One row means:

- drawdown A funded loan B with amount X

Since it is many-to-many:

- one borrower loan can have many allocation rows
- one drawdown can have many allocation rows

## Recommended Tables

### `loan_funding_allocations`

This should become the main allocation table.

Suggested columns:

- `id`
- `tenant_id`
- `bank_loan_id`
- `loan_id`
- `allocated_amount`
- `allocation_date`
- `allocation_type`
  - values: `initial`, `manual_adjustment`, `reallocation_in`, `reallocation_out`
- `note`
- `created_by_user_id`
- `created_at`

Purpose:

- support partial funding
- support many-to-many matching
- support auditability

### Optional: `loan_funding_reallocations`

If the team wants explicit movement logs between allocations later, add:

- `id`
- `tenant_id`
- `from_bank_loan_id`
- `to_bank_loan_id`
- `loan_id`
- `amount`
- `reason`
- `created_by_user_id`
- `created_at`

This is optional at first. In many cases, immutable allocation rows with adjustment types are enough.

## Recommended Schema Direction

### Short-term

- keep `loans.bankLoanId` temporarily for backward compatibility
- stop treating it as authoritative
- derive funding truth from allocation rows

### Mid-term

- make `loans.bankLoanId` nullable legacy metadata only
- drive all ROI, utilization, and funding status from allocations

### Long-term

- remove direct dependence on `loans.bankLoanId` from business logic

## Creation Order UX

The system should allow both directions.

### Flow A: Create Borrower Loan First

1. User creates borrower loan.
2. Loan is saved with `funding_status = unfunded`.
3. Loan appears in `Needs Funding` queue.
4. User later matches one or more upstream drawdowns into it.

### Flow B: Create Fund Drawdown First

1. User creates upstream drawdown.
2. Drawdown is saved with `allocation_status = unallocated`.
3. Drawdown appears in `Available Funds` queue.
4. User later assigns it to one or more borrower loans.

### Flow C: Match Later and Adjust

1. Loan and drawdown both already exist.
2. User opens matching workspace.
3. User allocates partial amounts across multiple rows.
4. User can later rebalance using adjustment allocations.

## Matching UX Proposal

### Matching Workspace

This should be a dedicated screen or split panel UI.

Left side:

- borrower loans needing funding
- principal requested
- funded amount
- unfunded amount
- due date
- expected borrower yield

Right side:

- available drawdowns
- source name
- allocated amount
- unallocated amount
- upstream cost
- next due date
- pool available balance if the source is a capital pool

Center interaction:

- choose a borrower loan
- choose one or more drawdowns
- allocate amounts manually
- see remaining gap live

### UX Rules

- never hide the current funded vs unfunded amount
- never allow allocation beyond remaining unallocated drawdown balance
- never allow allocation beyond current available pool balance for capital-pool sources
- never allow allocation beyond remaining unfunded borrower principal unless the user explicitly confirms an overfunded state
- preserve all allocation events historically

## Status Calculations

### Borrower loan funding state

Compute:

- `funded_amount = sum(allocations to loan)`
- `funding_gap = principal_amount - funded_amount`

Rules:

- if `funded_amount = 0` -> `unfunded`
- if `0 < funded_amount < principal_amount` -> `partially_funded`
- if `funded_amount = principal_amount` -> `fully_funded`
- if `funded_amount > principal_amount` -> `overfunded`

### Drawdown allocation state

Compute:

- `allocated_amount = sum(allocations from drawdown)`
- `unallocated_amount = drawdown_amount - allocated_amount`

Rules:

- if `allocated_amount = 0` -> `unallocated`
- if `0 < allocated_amount < drawdown_amount` -> `partially_allocated`
- if `allocated_amount = drawdown_amount` -> `fully_allocated`
- if repayments close the drawdown -> `closed`

### Capital pool allocation state

Compute:

- `pool_balance`
- `available_to_allocate`
- `deployed_principal`
- `retained_profit`

This gives the system live matching capacity for `เงินตัวเอง` or investor pools.

## Profitability Model

This flexible matching model allows clearer profitability views.

### Per borrower loan

Show:

- downstream principal
- downstream expected interest
- total allocated upstream capital
- weighted average upstream cost
- blended fund rate
- gross spread
- net spread after fees, VAT, and penalties
- contribution from retained-profit capital pools

### Per drawdown

Show:

- principal
- allocated amount
- unallocated amount
- upstream scheduled interest
- upstream fees and VAT
- downstream linked revenue
- drawdown-level net contribution

### Per fund source

Aggregate all drawdowns under the same source:

- total capital committed
- total allocated
- total repaid upstream
- linked downstream revenue
- source-level ROI

## Calculation Rules

### Weighted cost on a borrower loan

If one borrower loan is funded by multiple drawdowns, compute cost by weighted allocation.

Example:

- borrower loan principal = 100,000
- drawdown A allocated 60,000 at upstream cost 18%
- drawdown B allocated 40,000 at upstream cost 12%

Weighted cost rate:

- `(60,000 * 18% + 40,000 * 12%) / 100,000`

This weighted rate becomes the upstream cost basis for loan-level profitability.

If one source is a capital pool:

- bank-funded portions use explicit upstream cost
- capital-pool portions use the pool's configured hurdle rate or internal capital cost basis
- retained profit can remain in the pool and increase future matching capacity

### Time-based profitability

For daily / weekly / monthly profitability views:

- allocate upstream cost by schedule dates or accrual dates
- allocate downstream borrower inflow by actual transaction dates
- compute spread by period

Outputs:

- daily profit
- weekly profit
- monthly profit
- cumulative profit

## Charts To Support This Model

### 1. Loan Funding Composition

Stacked bar or stacked segments per borrower loan:

- source A allocation
- source B allocation
- source C allocation
- funding gap

Purpose:

- show how each loan is funded

### 2. Drawdown Deployment

Stacked bar per drawdown:

- allocated amount
- unallocated amount

Purpose:

- show remaining capacity fast

### 3. Weighted Cost vs Yield

Dual-line chart:

- weighted upstream cost
- downstream effective yield
- net spread line

Purpose:

- show whether the spread is still healthy

### 4. Profitability by Period

Line or bar chart by:

- day
- week
- month

Series:

- borrower income
- fund cost
- net spread

## API Direction

### Borrower loan funding endpoints

- `GET /loans/:id/funding`
- `POST /loans/:id/funding-allocations`
- `GET /loans/:id/funding-allocations`

### Drawdown allocation endpoints

- `POST /bank-loans/:id/allocations`
- `GET /bank-loans/:id/allocations`

### Matching workspace endpoints

- `GET /funding/unmatched-loans`
- `GET /funding/unallocated-drawdowns`
- `GET /funding/available-pools`
- `POST /funding/match`
- `POST /funding/reallocate`

### Profitability endpoints

- `GET /loans/:id/profitability`
- `GET /bank-loans/:id/profitability`
- `GET /bank-profiles/:id/profitability`
- `GET /dashboard/spread`

## Implementation Recommendation

### Phase A

- introduce allocation table
- calculate loan funding state
- calculate drawdown allocation state
- build matching workspace baseline

### Phase B

- move UI away from direct `loan.bankLoanId` assumptions
- add blended cost calculations
- add borrower-loan-level profitability

### Phase C

- add reallocation workflow
- add forecast and richer charts

## Bottom Line

If the product must support:

- loan first
- fund first
- one loan funded by many sources
- one source funding many loans
- re-matching later

Then the system must use a many-to-many allocation model as the real source of truth.

Without that, the current single-link approach will be too rigid for the workflows you described.
