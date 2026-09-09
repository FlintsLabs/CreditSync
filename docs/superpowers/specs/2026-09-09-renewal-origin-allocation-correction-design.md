# Renewal-Origin Scheduled Payment Allocation Correction Design

**Date:** 2026-09-09

**Status:** Approved design

**Scope:** Extend the existing same-loan scheduled payment allocation-correction workflow so a payment posted after a renewal may be moved between installments of the renewal-created loan while preserving valid renewal opening adjustments.

## Context

The existing `payment.allocation-correction.preview` → explicit confirmation → `payment.allocation-correction.execute` workflow safely moves one posted scheduled repayment between installments of the same active loan. It preserves the original intake and transaction, appends an exact compensating reversal and replacement repayment, rebuilds both schedule rows, refreshes the loan rollup, and records immutable audit lineage.

The initiating production case is a THB 200.00 payment received from น.ส. วรารัตน์ on 2026-09-06. The payment amount, borrower, active daily loan, and component split are correct, but its explicit allocation selected the 2026-09-07 installment rather than the 2026-09-06 installment.

The active daily loan was created by an executed renewal on 2026-09-05. That renewal created two posted opening adjustments on the new loan: a `principal_transfer` of THB 1,913.08 and a `cash_payout` of THB 1,800.00. The current correction dependency query treats every posted `loan_adjustments` row on the loan as downstream, so these opening rows block the correction even though they predate the payment and establish the loan's opening economic state.

## Root Cause

`payment-allocation-correction-service.ts` identifies dependencies by selecting all posted adjustments whose `loan_id` equals the source transaction's loan. It does not distinguish:

- renewal-origin adjustments that created the current loan and are causal ancestors of every later payment; from
- adjustments created after or independently of the source payment that may depend on the payment or its schedule allocation.

The safety guard is therefore conservative in the wrong dimension. It correctly fails closed, but produces a false blocker for any scheduled payment on a renewal-created loan.

## Goals

- Permit a same-loan scheduled allocation correction when the only posted loan adjustments are immutable opening adjustments created by the executed renewal that produced the current loan.
- Preserve those opening adjustments unchanged.
- Continue blocking later or unrelated adjustments, downstream renewals, active intermediary attributions, reconciliation lineage, and later repayments on either touched schedule.
- Preserve exact amount and principal, interest, fee, and penalty components.
- Keep preview expiry, explicit confirmation, idempotency, stale-state hashing, tenant isolation, append-only correction entries, audit history, and canonical schedule rebuild behavior unchanged.
- Keep the backend MCP catalog, frozen private plugin contract, reconciliation skill, validator, eval scenarios, README, and changelogs synchronized.
- Repair the initiating production payment only after deployment, a fresh warning-free preview, and a separate explicit confirmation of that exact preview.

## Non-Goals

- Editing, deleting, reversing, or recalculating the renewal or its opening adjustments.
- Allowing corrections across loans, borrowers, tenants, or schedule lineages.
- Moving floating-loan allocations or changing the payment's component split.
- Adding a generic dependency override or force flag.
- Inferring causality from timestamps alone.
- Automatically executing a production correction during deployment.

## Considered Approaches

### 1. Causal renewal lineage — chosen

Classify a posted loan adjustment as an allowed opening ancestor only when all of the following hold:

- the adjustment has a non-null `renewal_id`;
- that renewal is `executed`;
- the renewal's `new_loan_id` equals the source transaction's loan;
- the adjustment's `loan_id` also equals that new loan;
- its type is one of the renewal-created new-loan opening types: `principal_transfer` or `cash_payout`.

All other posted adjustments remain blockers. This uses durable relational lineage and a narrow type allowlist, so a future adjustment type fails closed until deliberately reviewed.

### 2. Timestamp filtering — rejected

Ignoring adjustments created before the source transaction is simple, but creation time and effective time can differ. Imports, backdated operations, clock differences, and delayed posting make temporal ordering weaker than explicit lineage.

### 3. Operator override — rejected

An `allowDependencies` or `force` input would broaden authority and could bypass unrelated downstream financial records. It is incompatible with the product's fail-closed financial rules.

## Dependency Classification

Replace the undifferentiated adjustment query with explicit classification:

1. Load posted adjustments for the source loan together with their renewal lineage.
2. Put only executed renewal-origin `principal_transfer` and `cash_payout` rows for which `renewal.newLoanId === source.loanId` into `openingAncestorAdjustmentIds`.
3. Put every other posted adjustment into `blockerPublicIds`.
4. Keep all existing attribution, reconciliation, downstream renewal, and later repayment blockers unchanged.

The opening ancestor IDs are not warnings and do not make the preview blocked. They are included in the balance-version input so a change to their status or lineage makes a ready preview stale. No raw internal database IDs are returned.

The first implementation does not add a new public output field. The existing preview contract remains closed and backward compatible: `warnings` stays empty when only eligible opening ancestors exist, and existing `PAYMENT_ALLOCATION_CORRECTION_DEPENDENCY` warnings continue returning public blocker UUIDs for actual blockers.

## Preview Flow

The existing preview input remains unchanged:

- `paymentIntakePublicId`;
- `transactionPublicId`;
- `targetSchedulePublicId`;
- non-blank `reason`.

Preview performs the existing eligibility checks, classifies dependencies, computes exact source and target projections, and persists an immutable preview. It is `ready` only when:

- source and target are different schedules on the same active non-floating loan;
- the complete original amount fits the target schedule;
- component conservation is exact;
- no actual downstream blocker exists; and
- only zero or more eligible renewal-origin opening ancestors are present.

The expected balance version hashes the current opening-ancestor public IDs, types, amounts, statuses, renewal public IDs, renewal status, and new-loan public ID in deterministic order in addition to the existing source, schedule, loan, and blocker state.

## Execute Flow

Execution remains `preview → explicit confirmation → execute`. It accepts the unchanged preview hash, expected balance version, normalized reason, `confirmed: true`, and stable idempotency key.

Inside the existing transaction and lock order, execution reloads and reclassifies dependencies. It fails stale or blocked if an opening ancestor changes, its renewal ceases to be executed, its lineage no longer identifies the current loan as the new loan, an unknown posted adjustment appears, or any existing downstream dependency appears.

On success it preserves the existing append-only behavior:

1. Append an exact negative compensating transaction to the source schedule.
2. Append an exact positive replacement transaction to the target schedule.
3. Persist the immutable correction group and two correction entries.
4. Rebuild both schedule aggregates from canonical signed transactions.
5. Refresh the loan economic rollup without changing net loan amount or components.
6. Write an audit row with public identifiers, before/after projections, exact conservation, reason, request ID, actor source, and correlation ID.
7. Mark the preview executed atomically.

The original intake, source transaction, renewal, and renewal adjustments remain immutable.

## Safety and Error Handling

- Unknown or unlinked adjustment types remain hard blockers.
- Adjustments linked to a renewal that created a different loan remain hard blockers.
- Adjustments linked to a non-executed renewal remain hard blockers.
- Opening-ancestor classification is tenant scoped and requires both loan and renewal lineage to match.
- Deterministic ordering is required before hashing dependency snapshots.
- Existing `PAYMENT_ALLOCATION_CORRECTION_DEPENDENCY`, stale preview, expiry, idempotency conflict, already-corrected, overpayment, same-schedule, cross-loan, inactive-loan, and floating-loan failures remain fail closed.
- No production repair may execute from a blocked, warning-bearing, expired, or stale preview.

## Test Strategy

Add disposable-PostgreSQL service tests that first reproduce the production-shaped false blocker and then prove:

- an executed renewal's `principal_transfer` and `cash_payout` adjustments on its new loan do not block a later scheduled payment correction;
- the preview remains zero variance and execution preserves exact components and both opening adjustments;
- an unrelated posted adjustment on the same loan still blocks;
- a renewal-linked adjustment with an unknown type still blocks;
- an adjustment linked to a non-executed or different renewal still blocks;
- changing an opening adjustment or renewal lineage after preview makes execution stale;
- existing later-repayment, idempotency, concurrency, tenant, immutability, overpayment, and component-conservation tests remain green.

Update MCP/default integration tests and plugin evals so an agent inspects the exact payment and contract, accepts eligible opening lineage without treating it as a warning, stops on real blockers, obtains explicit confirmation, executes with unchanged guards, and re-inspects the result.

## Documentation and Release Synchronization

The implementation must update together:

- backend service tests and MCP integration coverage;
- private plugin reconciliation skill and operations documentation;
- frozen MCP tool contract if generated output changes; otherwise verify byte-for-byte compatibility;
- plugin eval harness and validator expectations;
- root and plugin changelogs;
- README operator guidance where the eligibility boundary is described.

No database migration is expected because this design changes dependency classification and stale-state hashing without changing persisted schemas.

## Production Repair Gate

Deployment and the real correction are separate actions. After verified deployment:

1. Re-inspect the exact intake, source transaction, contract, source schedule, target schedule, and renewal lineage.
2. Create a fresh correction preview for the 2026-09-06 installment.
3. Require `status: ready`, empty warnings, zero loan variance, exact THB 200.00 amount, and unchanged THB 173.92 principal / THB 26.08 interest components.
4. Show the source and target before/after schedule state and request explicit confirmation of that preview.
5. Execute once with a stable idempotency key only after confirmation.
6. Verify the original intake remains posted, the source installment becomes unpaid/overdue as appropriate, the target installment becomes paid, loan-level components remain unchanged, opening renewal adjustments remain posted and unchanged, and audit/correlation IDs exist.

Production verification must not create unrelated financial records.
