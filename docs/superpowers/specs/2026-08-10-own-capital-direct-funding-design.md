# Own Capital Direct Funding Design

## Goal

Allow an active own-capital funding profile to be selected directly when creating a borrower loan, without first creating a bank drawdown, while reporting a configurable annual opportunity cost that defaults to 2.00%.

## Scope and classification

Funding has two distinct sources:

- **External liability:** a bank/credit drawdown. A borrower loan must use a specific active drawdown and capacity is its amount less net allocations.
- **Own capital:** a capital-pool bank profile. A borrower loan may allocate directly to the profile. It does not create a bank loan, a repayment obligation, or cash interest expense.

Only profiles with `accountingMode: "capital_pool"` are eligible for direct own-capital allocation. The create/edit funding-source flow offers this mode explicitly. For a newly created capital-pool profile, `opportunityCostRate` defaults to `"2.00"`; it is always editable per profile. Existing profiles are not silently reclassified. An owner can explicitly convert a profile before it becomes eligible.

## Capacity and allocation

Add `opportunity_cost_rate numeric not null default 2.00` to `bank_profiles`, constrained to a non-negative value. Add nullable `funding_bank_profile_id` to `loans`, referencing `bank_profiles`, so a draft retains the selected direct-capital source until activation. A loan may have either `bank_loan_id` or `funding_bank_profile_id`, never both. Capacity for own capital is:

`max(0, creditLimit - sum(net loan_funding_allocations for the profile))`.

Direct allocations reuse `loan_funding_allocations` with `bank_profile_id` set and `bank_loan_id` null. Activation locks both the borrower loan and profile allocation rows, recomputes capacity inside the transaction, rejects allocations above remaining capacity with `ALLOCATION_EXCEEDS_CAPITAL`, and writes one immutable `initial` allocation. This mirrors drawdown safety without inventing a bank debt.

An activated loan cannot change its funding source directly. Reallocation and reversal use append-only allocation records as before. Existing direct profile allocations remain compatible and are treated as own-capital only when their current profile is `capital_pool`.

## User experience

The New Loan wizard replaces its single Drawdown select with a Funding Source select grouped as:

1. `Own capital` — every active capital-pool profile, displaying available capacity and annual opportunity-cost rate.
2. `External drawdowns` — every active drawdown, displaying its parent profile and remaining drawdown capacity.
3. `No source / allocate later` — retains the existing optional workflow.

The review step explicitly states whether the loan is funded by own capital or a drawdown. For own capital, it shows the selected profile, allocated principal, remaining profile capacity after activation, and 2.00% annual opportunity cost. Fund detail/list pages show the rate and both cash position and opportunity-cost-adjusted profitability.

All new wording is localized in `en.json` and `th.json`.

## Profitability treatment

Opportunity cost is an analytical, non-cash cost. It is calculated per loan allocation from its effective allocation date through the reporting as-of date:

`allocated principal × profile opportunityCostRate / 100 × elapsed Bangkok calendar days / 365`, rounded to two decimals for presentation.

It does not modify `transactions`, bank repayment records, fund ledger cash entries, outstanding balances, or borrower dues. Reports expose both `fundCostPaid` (cash cost) and `opportunityCostAccrued` (non-cash analytical cost), plus `economicSpread = borrowerRevenue - fundCostPaid - opportunityCostAccrued`. For external drawdowns, opportunity cost is zero; their actual paid/outstanding bank costs remain unchanged.

## Interfaces and access

REST loan draft/activation accepts an optional `bankProfilePublicId` in addition to `bankLoanPublicId`; both cannot be supplied. MCP remains read-only for funding sources and receives no funding-source mutation capability. Loan and funding read DTOs include public IDs, funding kind, available capacity, and opportunity-cost values as exact money/decimal strings.

Only owner/manager roles can create or modify funding profiles and allocate loans. Tenant isolation, public UUID boundaries, and audit context are mandatory for every write.

## Verification

- Migration tests preserve every existing profile and loan allocation.
- Unit tests cover 2% default, custom rate, exact day-count math, zero rate, and no cash-ledger side effect.
- Integration tests cover direct capital draft/activation, capacity rejection, concurrent activation, forbidden source, drawdown compatibility, and direct-allocation audit history.
- Frontend tests cover grouped selection, disabled/exhausted capital source, review disclosure, and both English/Thai copy.
