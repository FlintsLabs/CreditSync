# Fund Repayment Schema and API Plan

## Purpose

This document defines the proposed data model and API surface for upstream funding obligations:

- bank drawdown setup
- repayment schedule generation
- repayment recording
- outstanding balance calculation
- due queue and profitability support

The goal is to let the product answer:

- what is due to upstream funds or banks right now
- how much has already been paid
- what principal / interest / fees / VAT remain
- whether the downstream lending spread is still profitable

## Current Model

The repo already has:

- `bank_profiles`
- `bank_loans`
- `bank_transactions`

These are not enough yet for installment-grade repayment tracking, because there is no explicit schedule table and no repayment row model tied to installments.

## Proposed Data Model

### 1. `bank_profiles`

Represents the source of funds.

Suggested fields to add:

- `provider_name` text
- `reference_no` text
- `status` text default `active`
- `note` text

Purpose:

- better display naming
- easier reconciliation
- support archive / inactive state

### 2. `bank_loans`

Represents one real drawdown or bank-side loan.

Suggested fields to add:

- `repayment_cycle` text not null
  - values: `daily`, `weekly`, `monthly`, `custom`
- `repayment_mode` text not null
  - values: `fixed_installment`, `minimum_due`, `interest_only`, `custom`
- `installment_amount` numeric
- `total_installments` integer
- `processing_fee_amount` numeric default `0`
- `utilization_fee_amount` numeric default `0`
- `vat_rate` numeric default `0`
- `late_fee_mode` text
  - values: `none`, `fixed`, `daily_percent`, `fixed_plus_percent`
- `late_fee_amount` numeric default `0`
- `grace_period_days` integer default `0`
- `next_due_date` date
- `outstanding_principal` numeric
- `outstanding_interest` numeric default `0`
- `outstanding_fees` numeric default `0`
- `outstanding_penalties` numeric default `0`
- `closed_at` timestamp
- `note` text

Purpose:

- one source of truth for current upstream obligation
- enough configuration to generate a repayment schedule

### 3. `bank_loan_schedules`

Represents scheduled upstream installments.

Suggested columns:

- `id` serial primary key
- `tenant_id` text not null
- `bank_loan_id` integer not null references `bank_loans.id`
- `installment_no` integer not null
- `due_date` date not null
- `scheduled_principal` numeric not null default `0`
- `scheduled_interest` numeric not null default `0`
- `scheduled_fee` numeric not null default `0`
- `scheduled_vat` numeric not null default `0`
- `scheduled_total` numeric not null default `0`
- `status` text not null default `pending`
  - values: `pending`, `partial`, `paid`, `overdue`, `waived`
- `paid_principal` numeric not null default `0`
- `paid_interest` numeric not null default `0`
- `paid_fee` numeric not null default `0`
- `paid_vat` numeric not null default `0`
- `paid_penalty` numeric not null default `0`
- `paid_total` numeric not null default `0`
- `overdue_days` integer not null default `0`
- `remaining_due` numeric not null default `0`
- `last_paid_at` timestamp
- `created_at` timestamp default now
- `updated_at` timestamp default now

Purpose:

- the dashboard due queue reads from here
- UI can display exact installment-level state

### 4. `bank_loan_repayments`

Represents actual repayment events.

Suggested columns:

- `id` serial primary key
- `tenant_id` text not null
- `bank_loan_id` integer not null references `bank_loans.id`
- `schedule_id` integer references `bank_loan_schedules.id`
- `payment_date` timestamp not null default now
- `amount` numeric not null
- `principal_component` numeric not null default `0`
- `interest_component` numeric not null default `0`
- `fee_component` numeric not null default `0`
- `vat_component` numeric not null default `0`
- `penalty_component` numeric not null default `0`
- `payment_method` text
- `reference` text
- `note` text
- `slip_file_id` integer references `files.id`
- `recorded_by_user_id` integer references `users.id`
- `created_at` timestamp default now

Purpose:

- preserve the raw payment history
- support partial and multi-installment payment logic

### 5. `bank_loan_allocations`

Represents traceability from upstream drawdown to downstream borrower loans.

Suggested columns:

- `id` serial primary key
- `tenant_id` text not null
- `bank_loan_id` integer not null references `bank_loans.id`
- `loan_id` integer not null references `loans.id`
- `allocated_amount` numeric not null
- `created_at` timestamp default now

Purpose:

- utilization tracking
- ROI tracing
- source-to-loan linkage

## Repayment Logic

### Schedule generation

When a drawdown is created:

1. store drawdown setup on `bank_loans`
2. generate schedule rows in `bank_loan_schedules`
3. compute and store:
- `next_due_date`
- `outstanding_principal`
- `outstanding_interest`
- `outstanding_fees`
- `outstanding_penalties`

### Payment posting

When a repayment is recorded:

1. create a row in `bank_loan_repayments`
2. apply the payment to one or more `bank_loan_schedules`
3. update installment statuses:
- `pending` -> `partial`
- `partial` -> `paid`
- `pending` -> `overdue` when date has passed
4. recompute bank loan rollups

### Overdue handling

Overdue should be derived from:

- current date
- unpaid `remaining_due`
- `grace_period_days`
- `late_fee_mode`

Penalty should either be:

- generated lazily on read
- or materialized into schedule rows during a daily recalculation job

For the first implementation, lazy recomputation is simpler and safer.

## API Proposal

### Drawdown APIs

#### `POST /bank-loans`

Create a new drawdown and generate its repayment schedule.

Body:

- `bankProfileId`
- `amount`
- `interestRate`
- `startDate`
- `termMonths`
- `repaymentCycle`
- `repaymentMode`
- `installmentAmount`
- `processingFeeAmount`
- `utilizationFeeAmount`
- `vatRate`
- `lateFeeMode`
- `lateFeeAmount`
- `gracePeriodDays`
- `note`

#### `GET /bank-loans/:id`

Return drawdown detail plus rollups:

- source info
- current outstanding balances
- next due date
- installments paid
- net allocated amount

#### `PUT /bank-loans/:id`

Update editable fields. If structural fields change, the schedule may need regeneration.

#### `POST /bank-loans/:id/close`

Close a drawdown after validation that no outstanding amount remains, or support force close with reason.

### Schedule APIs

#### `GET /bank-loans/:id/schedule`

Return schedule rows:

- due date
- scheduled total
- paid total
- remaining due
- overdue days
- status

#### `POST /bank-loans/:id/schedule/recalculate`

Optional admin endpoint for recalculating penalties or regenerated derived totals.

### Repayment APIs

#### `POST /bank-loans/:id/repayments`

Create an upstream repayment.

Body:

- `paymentDate`
- `amount`
- `scheduleIds[]` optional
- `paymentMethod`
- `reference`
- `note`
- `slipFileId`
- override fields if needed:
  - `feeComponent`
  - `vatComponent`
  - `penaltyComponent`

Behavior:

- apply to selected schedule rows, or auto-apply oldest due rows first

#### `GET /bank-loans/:id/repayments`

Return payment history for the drawdown.

### Allocation APIs

#### `POST /bank-loans/:id/allocations`

Allocate part of the drawdown to a borrower loan.

#### `GET /bank-loans/:id/allocations`

List allocations and remaining unallocated balance.

### Dashboard APIs

#### `GET /dashboard/fund-due-queue`

Return due fund repayments:

- source name
- drawdown label
- due date
- scheduled total
- remaining due
- fee
- VAT
- penalty
- status

#### `GET /dashboard/fund-summary`

Return upstream rollups:

- due today
- overdue total
- next 7 days due
- paid this month
- fees this month
- penalties this month

#### `GET /dashboard/profitability`

Return:

- borrower inflow by period
- fund outflow by period
- net spread by period
- cumulative spread

## UI Mapping

### Dashboard

Powered by:

- `dashboard/fund-due-queue`
- `dashboard/fund-summary`
- `dashboard/profitability`

### Fund Source Detail

Powered by:

- `GET /bank-profiles/:id`
- `GET /bank-loans?bankProfileId=:id`
- aggregated source summary endpoint later

### Drawdown Detail

Powered by:

- `GET /bank-loans/:id`
- `GET /bank-loans/:id/schedule`
- `GET /bank-loans/:id/repayments`
- `GET /bank-loans/:id/allocations`

## Recommended Delivery Order

1. extend `bank_loans`
2. add `bank_loan_schedules`
3. add `bank_loan_repayments`
4. build create drawdown + schedule generation
5. build record repayment flow
6. add due queue
7. add profitability rollups

## Notes

- Keep installment-level calculations deterministic and testable.
- Avoid hiding fees and VAT inside one total without preserving their components.
- Support partial payments from the start.
- Never derive profitability only from principal movements; separate principal from cost and revenue clearly.
