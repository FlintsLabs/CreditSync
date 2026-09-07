# Floating Reconciliation Temporal Reflow Design

**Date:** 2026-09-07

**Status:** Approved design, pending implementation plan

**Scope:** Backdated floating-interest reconciliation, append-only repair, and Loan List payment health

## Problem

CreditSync can accept a floating-interest payment after a later payment has
already been posted. The historical reconciliation preview correctly resolves
the backdated payment against the accrual that was unpaid on the payment's
effective Bangkok date. Execution currently appends that allocation to the
historical accrual but does not reflow later allocations.

In the production incident, the payment received on 2026-09-05 had already paid
the 2026-09-04 accrual because the 2026-09-04 slip had not yet been posted.
Reconciliation then added the backdated payment to the same accrual. All five
affected loans consequently have twice the contractual amount allocated to
2026-09-04 and nothing allocated to 2026-09-05. The Loan List therefore
continues to report two overdue days on 2026-09-07.

There is a separate projection defect for daily advance-interest loans. The
payment-health service adds a special current-period advance obligation that
was designed for weekly periods to daily periods as well. This double-counts
the due-today amount.

## Goals

- Preserve chronological economic meaning when a backdated floating-interest
  payment is reconciled after later payments exist.
- Keep every posted transaction and allocation immutable; corrections are
  append-only reversals and replacement allocations.
- Provide a preview-confirm-execute repair workflow for reconciliation groups
  that were executed before temporal reflow existed.
- Rebuild derived accrual paid caches from canonical active allocation
  provenance within the same transaction.
- Make daily Loan List payment health count the current daily obligation once
  while retaining the existing weekly advance-period behavior.
- Repair the five affected production loans only after an exact, current
  preview and a new explicit human confirmation.

## Non-goals

- Editing or deleting posted transactions, reconciliation groups, or allocation
  rows.
- Changing principal, interest rates, contract dates, or payment meaning.
- Applying surplus interest to principal, fees, or penalties.
- General-purpose manual ledger editing.
- Reworking scheduled-loan allocation.

## Chosen Approach

Use the existing authoritative floating-interest allocator to replay active
later interest allocations in effective-time order after inserting a backdated
allocation. Each displaced positive allocation is first compensated by a
negative allocation linked through reversedAllocationId; the same transaction
then receives new positive allocation provenance targeting the accruals payable
at its original effective date.

This is safer than reversing and reposting whole payment intakes because the
payment transactions and amounts are already correct. Only their accrual
provenance is stale. It is safer than manual adjustments because it is
deterministic, reusable, auditable, and prevents recurrence.

## Temporal Reflow Semantics

### Ordering

For each affected loan, execution locks and processes data in stable order:

1. loan ID;
2. allocation effective date;
3. source transaction ID;
4. allocation order;
5. allocation ID.

Only active positive interest allocations with an effective date strictly
later than the reconciled payment's Bangkok business date participate. Reversed
allocations and penalty allocations do not participate.

### Replay

After the backdated allocation is appended:

1. Select every participating later interest allocation for the affected loan.
2. Append an exact negative reversal allocation for each selected allocation.
3. Replay each source transaction's displaced interest through the
   authoritative allocator as of its original effective date.
4. Append positive replacement allocations tied to the same transaction.
5. Require each transaction's replacement sum to equal its displaced amount as
   an exact two-decimal string.
6. Abort if replay is ambiguous, lacks provenance, changes component totals, or
   cannot allocate the exact amount.

The source transaction, payment intake, components, and received date remain
unchanged.

### Derived Cache Rebuild

For every touched accrual, recompute paidAmount from the signed sum of canonical
allocation rows. Set status to paid when it equals contractual interest,
partially_paid when positive but lower, and the pre-payment payable status when
zero.

Execution rejects a state where active paid interest is negative or exceeds
contractual interest. Cache updates and allocation rows commit atomically.

## Future Reconciliation Execution

executePaymentReconciliation invokes temporal reflow automatically for
historical needs_review mode after appending the backdated allocation and
before committing the reconciliation group.

Preview and preflight include a deterministic temporalReflowPlan containing:

- affected loan public IDs;
- source transaction public IDs and effective dates;
- old due-date allocations;
- proposed replacement due-date allocations;
- per-transaction and total conservation checks.

The balance version and preview hash cover allocation due date, effective date,
amount, entry type, reversal link, transaction ID, and accrual ID. Any later
financial activity makes the preview stale.

## Existing-Data Repair Workflow

Add two tenant-scoped MCP tools:

- payment.reconcile.reflow.preview
- payment.reconcile.reflow.execute

Preview accepts an executed reconciliation public ID and non-empty reason. It
makes no financial change, identifies only later allocations made stale by that
reconciliation, and persists an expiring immutable proposal. Its result includes
before/after mappings, exact totals, warnings, hash, balance version, and expiry.

Execute requires the proposal public ID, unchanged hash and balance version,
confirmed true, exact preview reason, and a non-empty idempotency key. It
appends reversal and replacement allocations, rebuilds touched accrual caches,
and records one audit entry and one immutable repair group. Same-key retries
return the original result; conflicting key reuse is rejected.

Both tools expose public UUIDs and two-decimal strings only. They are added to
the frozen MCP contract, private plugin manifest, plugin skills, validator, and
eval scenarios. Execute is destructive. Preview changes only proposal and audit
metadata.

## Payment-Health Correction

The special advance-period projection in getLoanPaymentHealth runs only for
weekly floating policy. Daily floating loans already have one due group per
accrual date and must not receive the additional weekly advance group.

For a daily THB 2,000 loan at 15 per thousand:

- one daily obligation is THB 30.00;
- after payments through 2026-09-05 are reflowed, health as of 2026-09-07 is
  THB 30.00 overdue with maxOverdueDays equal to 1;
- due today is THB 30.00, not THB 60.00.

Weekly advance-period behavior remains unchanged.

## Concurrency and Failure Handling

- Acquire deterministic row locks for loans, accruals, transactions,
  allocations, reconciliation groups, and repair proposals.
- Revalidate the temporal plan after locks.
- A stale preview, concurrent allocation, incomplete provenance, amount
  variance, duplicate repair, or idempotency conflict aborts without financial
  writes.
- No partial reflow may commit.
- Repairing an already repaired reconciliation is rejected unless it is an
  exact same-key replay.

## Audit and Safety

Every execute records command context, actor/source, request and correlation
IDs, reason, idempotency key, reconciliation public ID, repair proposal public
ID, and safe before/after public allocation snapshots.

Audit payloads and logs exclude payer names, account data, QR payloads, raw
evidence, bearer tokens, and database IDs. Production repair uses the same
preview-confirm-execute boundary as other financial workflows.

## Test Strategy

Database-backed temporal tests post a 2026-09-05 payment while 2026-09-04 is
the oldest unpaid accrual, then reconcile a 2026-09-04 payment. They require the
backdated payment to remain on 2026-09-04 and the later payment to move to
2026-09-05, with exact conservation, append-only lineage, cache rebuild,
idempotent replay, key conflict, stale preview, and concurrency coverage.

Repair tests seed the already-broken state and verify exact preview mappings,
no replacement payment transaction, immutable originals, balanced reversal and
replacement rows, duplicate-repair rejection, and same-key replay.

Payment-health tests verify one current daily obligation, one overdue day after
repair, unchanged weekly behavior, and exact decimal handling.

Verification gates are the targeted RED/GREEN database tests, complete
disposable PostgreSQL backend suite, backend typecheck, frontend tests/lint/
build, plugin tests/validator, changelog and README review, and independent diff
review. Deployment and production repair require separate authorization.

## Production Remediation Acceptance Criteria

The production preview shows exactly five affected loans and conserves THB
165.00 as THB 45.00, 30.00, 15.00, 45.00, and 30.00.

For each loan, the later payment allocation moves from the 2026-09-04 accrual
to 2026-09-05. Principal, fee, penalty, payment intake, and transaction amount
do not change.

After confirmed execution:

- no accrual has active paid interest above contractual interest;
- both 2026-09-04 and 2026-09-05 accruals are paid exactly;
- Loan List health as of 2026-09-07 reports one overdue daily obligation per
  affected loan;
- five-loan overdue and due-today totals are each THB 165.00;
- loan …dea96 reports THB 30.00 overdue, one maximum overdue day, and THB 30.00
  due today;
- audit and correlation IDs are returned and repair is idempotent.
