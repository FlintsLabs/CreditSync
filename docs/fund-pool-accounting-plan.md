# Fund Pool Accounting Plan

## Problem To Solve

Some fund sources are not external bank liabilities.

Examples:

- owner's own capital
- investor capital
- pooled internal cash

These sources behave differently from bank drawdowns:

- they do not always have fixed upstream installments
- their available balance can grow when borrower repayments and interest come back
- their cash can be re-used for new lending
- profit can stay inside the pool instead of being withdrawn immediately

This means a static `credit_limit` is not enough.

## Current Limitation

The current model treats a fund source mostly as:

- a source profile
- a drawdown container
- an upstream repayment obligation

It does not yet model:

- a live cash balance
- reinvested profit
- owner withdrawals
- pool growth over time
- matching directly from evolving pool balance

So right now, a self-funded pool that grows from collected interest is not fully supported.

## Recommended Fund Source Modes

Add a clear accounting mode on fund sources.

Suggested field on `bank_profiles`:

- `accounting_mode`
  - `external_liability`
  - `capital_pool`

Meaning:

### `external_liability`

Use for:

- banks
- formal lenders
- installment obligations

Behavior:

- availability comes from drawdowns
- cost comes from repayment schedule, fees, VAT, penalties

### `capital_pool`

Use for:

- owner's own money
- investor money
- internal revolving pool

Behavior:

- availability comes from current pool balance
- balance increases when principal is returned and profit is retained
- balance decreases when money is deployed to borrower loans or withdrawn

## Recommended Accounting Model

The system should track a pool using ledger entries, not only a static balance column.

## Main Concepts

### 1. Pool Balance

Represents current cash value still available in the pool.

### 2. Deployed Principal

Represents how much of the pool is currently out with borrowers.

### 3. Realized Profit

Represents interest and other profit already collected from borrowers.

### 4. Retained Profit

Represents profit that stays in the pool for reinvestment.

### 5. Withdrawn Profit / Capital

Represents money taken out of the pool by owner or investor.

## Recommended Tables

### `fund_ledger_entries`

This should become the source of truth for pool movements.

Suggested columns:

- `id`
- `tenant_id`
- `bank_profile_id`
- `entry_date`
- `entry_type`
  - `capital_injection`
  - `loan_allocation_out`
  - `principal_return_in`
  - `interest_income_in`
  - `fee_income_in`
  - `loss_writeoff`
  - `owner_withdrawal`
  - `investor_distribution`
  - `manual_adjustment`
- `amount`
- `loan_id` nullable
- `bank_loan_id` nullable
- `transaction_id` nullable
- `note`
- `created_by_user_id`
- `created_at`

Purpose:

- explain exactly why a pool balance changed
- support auditability
- support derived current balance calculations

### Optional derived columns on `bank_profiles`

These can be cached / denormalized:

- `current_balance`
- `available_to_allocate`
- `deployed_principal`
- `realized_profit`
- `retained_profit`
- `withdrawn_amount`

If added, they should be derived from ledger entries, not treated as independent truth.

## How Matching Works For Capital Pools

### Case A: Borrower loan funded directly from pool

When user allocates pool money into a borrower loan:

1. create a `loan_funding_allocations` row
2. create `fund_ledger_entries` row:
   - `entry_type = loan_allocation_out`
   - amount = allocated amount

Effect:

- `available_to_allocate` decreases
- `deployed_principal` increases

### Case B: Borrower repays principal

When borrower principal is repaid:

1. determine allocation proportions across sources
2. return principal proportionally to each source
3. for capital pool source:
   - create `principal_return_in` ledger entry

Effect:

- `available_to_allocate` increases
- `deployed_principal` decreases

### Case C: Borrower pays interest

When borrower interest is collected:

1. determine source allocation proportions or weighted funding basis
2. split interest into:
   - upstream cost coverage
   - net profit
3. for capital pool source, if profit is retained:
   - create `interest_income_in` entry

Effect:

- pool balance grows
- future matching capacity increases

### Case D: Owner withdraws profit

When the owner takes money out:

1. create `owner_withdrawal` ledger entry

Effect:

- current balance decreases
- available allocation capacity decreases

## Calculation Rules

### Current Pool Balance

For a pool source:

`current_balance = sum(inflow ledger entries) - sum(outflow ledger entries)`

### Available To Allocate

Recommended simple rule:

`available_to_allocate = current_balance`

If the business wants stricter control:

`available_to_allocate = current_balance - reserved_amount`

### Deployed Principal

`deployed_principal = total allocations out - principal returned in - writeoffs`

### Realized Profit

`realized_profit = interest_income_in + fee_income_in - loss_writeoff`

### Retained Profit

If profit stays in the pool by default:

`retained_profit = realized_profit - investor_distribution - owner_withdrawal_from_profit`

## Mixed Funding Example

Borrower loan principal: `100,000`

Funding:

- bank drawdown A: `60,000`
- owner capital pool: `40,000`

Borrower later pays:

- principal returned: `20,000`
- interest paid: `4,000`

Principal return allocation:

- 60% to drawdown A
- 40% back to capital pool

Interest handling:

- allocate upstream cost first to drawdown-funded portion
- remaining net spread attributable to pool becomes pool profit

If the pool retains profit:

- create `interest_income_in` for the pool
- its balance grows
- that increased balance becomes matchable capital for future loans

## UI Proposal

### Fund Source Detail For Capital Pool

The header should show:

- current balance
- available to allocate
- deployed principal
- realized profit
- retained profit
- withdrawn amount

### Pool Ledger Tab

Show entries with:

- date
- type
- direction
- amount
- linked loan if any
- linked transaction if any
- note

### Matching UI

When selecting a capital pool as a funding source:

- show `available_to_allocate` live
- warn if allocation exceeds available balance
- show how much balance remains after allocation

### Profitability UI

For capital pool sources, show:

- capital in
- capital currently deployed
- profit returned
- retained profit
- cash available now
- ROI on deployed capital

## Chart Suggestions

### 1. Pool Balance Over Time

Lines:

- current balance
- deployed principal
- retained profit

### 2. Cash In vs Cash Out

Bars:

- principal returned
- interest income
- owner withdrawals
- new allocations

### 3. Capital Efficiency

Lines:

- deployed capital
- available idle cash
- realized ROI

## API Direction

### Pool Summary

- `GET /bank-profiles/:id/pool-summary`

Returns:

- current balance
- available to allocate
- deployed principal
- realized profit
- retained profit
- withdrawn amount

### Pool Ledger

- `GET /bank-profiles/:id/ledger`
- `POST /bank-profiles/:id/ledger`

### Matching Support

When matching from a pool:

- `POST /funding/match`
  - create allocation
  - create pool outflow ledger entry

### Borrower Payment Settlement

When borrower payment is recorded:

- settlement logic should split incoming value across funding sources
- capital pool portions should create inflow ledger entries

## Product Rule Recommendation

Add a fund-level option:

- `reinvest_profit_mode`
  - `retain_in_pool`
  - `manual_distribution`

Meaning:

### `retain_in_pool`

- profit automatically increases matchable pool balance

### `manual_distribution`

- profit is tracked but not added to available matching balance until a distribution decision is made

## Bottom Line

If you want:

- self-funding capital pools
- profit retained inside the pool
- pool balance growing over time
- future lending capacity increasing from collected interest

Then the system needs a ledger-based pool accounting model in addition to drawdown allocation.

Without that, matching from `เงินตัวเอง` will remain too static and will not reflect real revolving capital behavior.
