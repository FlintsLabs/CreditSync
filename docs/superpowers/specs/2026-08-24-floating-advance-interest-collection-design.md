# Floating Advance-Interest Collection Design

## Goal

Support two explicit floating-loan collection policies without changing their
anchored period calendar:

- **Advance collection**: the borrower prepays each complete policy period.
  A weekly loan starting on 2026-08-13 has fixed periods `[13,20)`, `[20,27)`,
  `[27,03)`. A THB 600 payment received on 2026-08-23 may pay interest for
  `[20,27)` even though that period has not ended.
- **Arrears collection**: interest remains payable only after it has accrued
  through the payment or settlement date.

For an advance-collected period, early settlement must not charge any more
interest for the portion of time already prepaid. Any late penalty is a
separate append-only charge; its default is THB `0.00` and it must never be
inferred from the payment date.

## Problem

The database already persists `advanceInterestPeriods = 1` and activation
stores the first covered period as paid. However normal payment allocation
treats every later weekly period as `accruing` until its end date, and the
historical reconciliation path rejects an interest replacement when no
payable accrual exists. This converts a confirmed THB 600 weekly advance
interest payment into principal or leaves it reversed.

That behavior is incorrect for the agreed collection policy. The initial
deduction covers only the first fixed period; it must not remove the next
period's advance-interest obligation or make that obligation unpostable.

## Scope

### Included

- Persist a clear collection timing mode derived from the existing immutable
  `advanceInterestPeriods` contract value: `advance` for `1`, `arrears` for
  `0`.
- Keep calendar periods anchored at loan activation and preserve the existing
  half-open Bangkok-date calculation.
- Materialize the next anchored period in time for an advance payment and
  allow the payment/reconciliation flow to allocate an exact interest amount
  to that period before its end date.
- Record the allocation against immutable accrual provenance with
  `effectiveDate` equal to the actual receipt date, not a fabricated due date.
- Exclude a fully prepaid future/current period from early-settlement interest;
  retain the non-refundable policy for periods already prepaid.
- Let a separate penalty workflow add THB `0.00` initially or a later,
  reasoned amount; never manufacture a penalty from lateness.
- Reconcile the existing reversed THB 600 payment for loan
  `019ffb21-f852-7375-8605-5adc6f0beb51` only after the corrected behavior
  is verified in the disposable database.

### Excluded

- Changing the principal, rate, period length, anchor date, or terms of an
  active loan.
- Refunding advance interest when a borrower closes during a prepaid period.
- Automatically assessing, waiving, or guessing penalties.
- Rewriting historical transactions; all correction remains append-only.

## Domain Rules

1. Money is a two-decimal decimal string and all calculation uses
   `decimal.js`.
2. Periods are `[periodStart, nextPeriodStart)` in `Asia/Bangkok`; payment
   timing never shifts the anchor calendar.
3. At activation, `advanceInterestPeriods = 1` deducts exactly one full
   period's interest and marks only that first period covered.
4. For advance collection, a payment can allocate interest to the earliest
   uncovered anchored period whose start date is on or before the receipt
   date. It is permitted before that period's end date.
5. For arrears collection, normal payment and reconciliation may allocate
   interest only to payable accrued/due amounts, retaining current behavior.
6. A payment made after a period starts but before it ends still covers the
   whole anchored period; its lateness affects only an explicit penalty entry.
7. A close-out charges principal plus unpaid arrears. It charges no additional
   interest for a fully prepaid period, even if the close-out date lies within
   that period.
8. All writes retain idempotency, audit public IDs, request/correlation IDs,
   and compensating reversal behavior.

## Design

### Accrual and coverage state

Reuse `loan_interest_accruals` and `floating_transaction_allocations` as the
authoritative period and payment provenance. Do not add a parallel balance or
infer coverage from payment notes.

`accrueFloatingInterestThrough` must materialize complete daily snapshots for
the current anchored period when an advance payment or reconciliation needs
them. For an advance policy, the allocation selector includes the earliest
uncovered period started by the receipt date, regardless of its present
`accruing` status. The existing first-period activation snapshots remain
paid; subsequent snapshots become paid or partially paid only through a
transaction allocation.

The allocation records the actual `effectiveDate`, links every split to its
interest accrual row, and updates `paidAmount`/status transactionally. A
partial payment is allowed only if exact component validation and the existing
allocation order support it; the unpaid remainder remains visible for review.

### Payment and reconciliation

Normal payment preview continues to keep `accruing` interest out of arrears
allocations. It gains a narrow advance-policy branch that selects the period
above and returns an explicit match reason such as `advance_interest_period`.
It must never silently direct an exact advance-interest amount to principal.

The reconciliation workflow uses the same selector so an evidence-backed,
fully reversed intake can be reposted as advance interest. It continues to
reject unsupported components and stale financial state. The existing
reconciliation error becomes impossible for a valid, materialized advance
period; it remains a fail-closed error for genuinely unsupported history.

### Settlement and penalties

Settlement derives chargeable interest from unpaid period coverage, not from
calendar elapsed time alone. It recognizes an advance allocation during the
active period as paid, applies no second interest charge, and preserves the
existing `non_refundable` rule. Penalties stay in the separate floating
penalty ledger with an explicit amount and reason; no late-payment code
creates a penalty automatically.

### Public contract and UI

Loan contract and payment preview responses expose the collection mode and
covered/prepaid period metadata using safe public IDs and decimal strings.
The Web UI presents a localized advance/arrears choice at loan creation and
labels a payment as "advance interest for 20–27 Aug" rather than calling it
principal. MCP schemas, plugin contract, skills, evals, and validator remain
closed and synchronized. A financial post remains destructive and requires
the existing inspect → preview → explicit-confirmation process.

## Acceptance Scenarios

1. **Weekly advance policy**: principal `5000.00`, weekly percent rate
   `12.0000`, start `2026-08-13`, advance enabled. Activation deducts
   `600.00`; first period `[13,20)` is paid and net payout is `4400.00`.
2. **Next-period advance payment**: a confirmed THB `600.00` receipt on
   `2026-08-23` is allocated entirely to interest for `[20,27)`, leaves
   principal at `5000.00`, and creates exact accrual/allocation provenance.
3. **Late but anchored**: the receipt in scenario 2 does not shift the next
   period to `[23,30)` and creates no penalty by default.
4. **Early close-out after payment**: closing on `2026-08-24` after scenario
   2 does not charge another THB `600.00` for `[20,27)`.
5. **Arrears policy**: the same weekly terms without advance collection cannot
   allocate an early payment to unaccrued interest and settlement charges only
   the interest accrued through its as-of date.
6. **Correction lineage**: the current reversed intake is reposted only by
   reconciliation after preview/confirmation, preserving the original slip
   and both compensating records.

## Verification

- Write database-backed failing tests before implementation for all acceptance
  scenarios, including stale previews, idempotent retries, reversed-payment
  reconciliation, and zero-default penalty behavior.
- Run `backend/scripts/test-disposable-postgres.sh` for the affected service,
  MCP, migration, and regression suites serially.
- Run backend typecheck; run frontend tests, lint, and production build after
  UI/contract changes.
- Run plugin contract tests, validator, and eval harness after MCP changes.
- Verify the real corrected payment via MCP: original intake remains reversed,
  one repost child is posted, principal is unchanged, interest component is
  `600.00`, the `[20,27)` period is covered, and audit/correlation IDs exist.
