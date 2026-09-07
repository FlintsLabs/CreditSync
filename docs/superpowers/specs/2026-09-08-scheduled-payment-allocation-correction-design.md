# Scheduled Payment Allocation Correction Design

**Date:** 2026-09-08

**Status:** Approved design, pending implementation plan

**Scope:** MCP-only correction of a posted scheduled payment that targets the wrong installment

## Problem

CreditSync permits an operator to explicitly select a scheduled installment when
previewing a payment. Once posted, the resulting transaction, proposal, and
financial history are immutable. The existing payment reversal and restore flows
preserve the original installment allocation, while `payment.reconcile.*` is
deliberately limited to reviewed floating-interest payments. There is therefore
no safe public workflow for correcting a posted daily or installment payment that
was assigned to the wrong schedule row.

The initiating case is a THB 200.00 payment received on 2026-09-06. It was posted
to the correct borrower and active THB 4,000.00 daily loan, with components of
THB 173.92 principal and THB 26.08 interest, but the explicit proposal selected
the 2026-09-07 installment. The 2026-09-06 installment consequently remains
pending even though the cash receipt and loan-level component totals are correct.

## Goals

- Correct a posted scheduled repayment from one installment to another within
  the same borrower and loan.
- Preserve the exact original amount and principal, interest, fee, and penalty
  component split.
- Keep posted transactions and financial records immutable through append-only
  compensating and replacement entries.
- Require a current preview, explicit confirmation, reason, idempotency key,
  balance version, and complete audit history.
- Recompute both touched schedule aggregates from canonical transaction history
  and refresh the loan rollup atomically.
- Expose the workflow through the private MCP plugin and keep the frozen contract,
  skills, validator, and eval scenarios synchronized.
- Repair the initiating production payment only through a separately authorized,
  freshly confirmed preview after deployment.

## Non-goals

- Moving a payment to another borrower or loan.
- Changing the payment amount or any financial component.
- Splitting or merging transactions or installments.
- Correcting floating-loan allocations, settlements, renewals, disbursements,
  intermediary remittances, or funding allocations.
- Editing or deleting posted transactions, proposals, schedules, or audit rows.
- Adding a Web UI in the first version.
- Automatically mutating production data during deployment.

## Chosen Approach

Add a dedicated `payment.allocation-correction` preview-confirm-execute workflow.
It uses its own immutable proposal, execution group, and entry ledger rather than
broadening the interest-only historical reconciliation contract or combining
separate reversal and restore commands.

The dedicated workflow keeps the operator intent narrow and makes the correction
atomic. It can validate both source and target schedule state before writing, append
the compensating and replacement transactions together, rebuild both schedule
aggregates, refresh the loan rollup, and either commit all effects or none.

## Data Model

### Correction Previews

`payment_allocation_correction_previews` stores:

- tenant, source payment intake, source transaction, source schedule, target
  schedule, and loan foreign keys;
- immutable safe source and target snapshots;
- exact original amount and component split;
- proposed before/after schedule projections;
- normalized reason, warnings, preview hash, expected balance version, status,
  expiry, creator, and timestamps.

Preview rows are append-only. Ready previews may transition only to executed or
expired. Executed previews cannot be updated or deleted.

### Correction Groups

`payment_allocation_correction_groups` stores one executed correction with its
preview, tenant, source payment, source transaction, source and target schedules,
reason, idempotency key, correlation ID, actor/source, audit public ID, and
execution timestamp.

Tenant plus idempotency key is unique. A source transaction may have only one
active executed correction. Reuse of the same key with identical input returns
the original result; conflicting reuse fails closed.

### Correction Entries

`payment_allocation_correction_entries` links the correction group to:

- the immutable source repayment transaction;
- the new compensating reversal transaction;
- the new replacement repayment transaction;
- the source and target schedules;
- the exact signed amount and component values;
- audit and actor metadata.

Groups and entries reject update and delete at the database boundary.

## Preview Contract

Add MCP tool `payment.allocation-correction.preview`. Input contains:

- `paymentIntakePublicId`;
- `transactionPublicId`;
- `targetSchedulePublicId`;
- non-blank `reason`.

The service resolves tenant-scoped public UUIDs and verifies that the source
transaction belongs to the supplied posted payment. It must be an uncompensated
scheduled repayment whose source schedule, target schedule, borrower, and loan
all belong to the same tenant and active loan.

Preview returns only safe public fields and two-decimal strings:

- source payment and transaction public IDs;
- loan, source schedule, and target schedule public IDs and due dates;
- exact amount and component split;
- before/after projections for both schedule rows;
- unchanged loan-level net component totals;
- warnings, status, preview hash, expected balance version, and expiry.

A preview is `ready` only when all safety checks pass and the full original
transaction can be transferred without overpayment. A warning or failed check
makes the preview non-executable.

## Eligibility and Safety Rules

Execution is allowed only when all of the following remain true:

- The payment intake is `posted` and belongs to the actor's accessible tenant and
  portfolio.
- The source is one positive scheduled repayment transaction and is not already
  reversed or corrected.
- Source and target schedules belong to the same active loan and are different.
- The replacement retains amount and every component exactly.
- The target schedule has enough compatible remaining obligation for the complete
  replacement. Silent overpayment is rejected.
- The correction does not cross borrower, loan, tenant, repayment type, or
  schedule lineage boundaries.
- No active intermediary attribution, settled commission, renewal, settlement,
  reconciliation, or other downstream record depends on the source transaction
  in a way that would make provenance ambiguous. Returned blocker identifiers are
  public UUIDs only.
- No prior correction exists for the source transaction.
- The preview is current, unexpired, warning-free, and matches the locked state.

The first version does not recursively correct downstream records. It stops for
human review instead.

## Execute Contract

Add destructive MCP tool `payment.allocation-correction.execute`. Input contains:

- correction preview public ID;
- unchanged preview hash and expected balance version;
- exact normalized preview reason;
- `confirmed: true`;
- non-blank idempotency key.

Execution acquires deterministic locks in this order:

1. source payment intake;
2. loan;
3. source and target schedules ordered by ID;
4. source transaction and any compensation rows ordered by ID;
5. preview and existing correction group.

After revalidation, one database transaction:

1. Appends a negative compensating transaction against the source schedule,
   linked to the immutable source transaction.
2. Appends a positive replacement repayment against the target schedule with
   the exact source amount, components, received date, owner, and payment intake
   provenance.
3. Records the immutable correction group and entry.
4. Rebuilds source and target schedule `paidTotal`, `paidPenalty`, `remainingDue`,
   overdue days, and lifecycle status from active signed transaction history.
5. Refreshes the affected loan rollup.
6. Writes one safe audit record containing public identifiers, reason, command
   context, exact before/after projections, and conservation checks.
7. Marks the preview executed and commits all changes atomically.

The payment intake remains `posted`; its amount, bank reference, evidence, payer,
received date, and posted date do not change. Its transaction history exposes the
original, compensating, and replacement entries so the correction is visible.

## Hashing, Versioning, and Idempotency

The balance version and preview hash cover:

- payment status and identity;
- source transaction amount, components, entry type, schedule, and reversal
  lineage;
- source and target schedule contractual amounts and current aggregates;
- active transactions affecting either schedule;
- loan status and economic rollup fields;
- downstream dependency identifiers;
- normalized reason and target schedule.

Any financial activity affecting the payment, loan, source schedule, target
schedule, or dependency set makes the preview stale. Same-key identical execute
retries return the original correction. Concurrent execute calls can create only
one correction group and one transaction pair.

## Schedule Rebuild Semantics

The service must not increment or decrement cached schedule totals by assumption.
After appending the correction entries, it recomputes each touched schedule from
the signed sum of canonical active repayment, reversal, and correction
transactions using `decimal.js` through the project's exact-money helpers.

- `paidTotal` is the non-penalty component sum, clamped only according to existing
  contractual invariants.
- `paidPenalty` is the signed penalty component sum.
- `remainingDue` is contractual scheduled total minus non-penalty paid amount.
- Status and overdue days use the existing schedule lifecycle function at the
  current Bangkok business time.

Negative totals, component variance, source over-restoration, target overpayment,
or loan-level net changes abort the transaction.

## Error Handling

The workflow fails closed with stable domain errors for invalid public IDs,
inaccessible or cross-tenant targets, non-posted payments, non-repayment sources,
floating transactions, same-schedule requests, component mismatch, target
overpayment, active downstream dependencies, prior correction, stale or expired
preview, reason mismatch, balance-version mismatch, and idempotency conflict.

No partial correction may commit. Errors and audit payloads must not expose names,
account numbers, full references, raw evidence, bearer tokens, QR payloads, or
internal numeric database IDs.

## MCP and Plugin Integration

The two tools are added to the MCP input/output schemas, default handlers,
annotations, command-context adapters, tool descriptions, audit-result mapping,
and server contract tests. Preview is read-oriented but persists proposal and
audit metadata; execute is destructive.

Synchronize the frozen MCP contract, private plugin manifest/version, root and
plugin payment skills, error-recovery reference, validator expectations, eval
catalog, executable scenarios, README, and changelogs. The skill must require:

1. inspect the exact posted intake, transaction, schedules, and dependencies;
2. call preview;
3. show exact before/after schedule effects and conservation totals;
4. obtain explicit human confirmation;
5. call execute with unchanged guards and a stable idempotency key;
6. re-inspect the payment and loan contract after execution.

## Test Strategy

Database-backed tests first reproduce the initiating defect: post a THB 200.00
daily payment to the second installment while the first remains unpaid. They then
verify:

- preview projects source restoration and target settlement exactly;
- execute appends one negative and one positive transaction with preserved
  THB 173.92 principal and THB 26.08 interest;
- the source and target schedule aggregates and lifecycle statuses are rebuilt;
- the payment remains posted and loan-level principal/interest effects are
  unchanged;
- audit, correlation, reason, actor, and correction lineage are complete;
- same-key retry is idempotent and conflicting reuse is rejected;
- stale preview and concurrent execute fail safely;
- cross-tenant, cross-borrower, cross-loan, floating, same-schedule, overpayment,
  reversed, previously corrected, and downstream-dependent cases are rejected;
- update/delete attempts against executed correction records fail at the database
  boundary;
- MCP handler, schema, annotation, audit lookup, frozen contract, plugin validator,
  and eval workflows remain synchronized.

Verification gates are targeted RED/GREEN disposable PostgreSQL tests, the full
serialized disposable backend suite, backend typecheck, frontend test/lint/build
when shared contracts are touched, plugin tests and validator, changelog and README
review, and independent final diff review.

## Initiating Production Repair

Implementation and deployment do not change the initiating payment. After the new
version is deployed, the operator must inspect the exact posted payment and run a
fresh preview that shows:

- THB 200.00 moves from the 2026-09-07 installment to 2026-09-06;
- principal remains THB 173.92;
- interest remains THB 26.08;
- fee and penalty remain THB 0.00;
- the 2026-09-06 installment becomes paid;
- the 2026-09-07 installment becomes pending;
- loan-level net amount and components have zero variance;
- warnings and downstream blockers are empty.

Only a new explicit human confirmation of that current preview authorizes execute.
After execution, re-read the payment history, both schedules, loan rollup, audit
public ID, and correlation ID. Deployment and production mutation remain separate
authorization boundaries.

## Acceptance Criteria

- A posted scheduled repayment can be moved only to another installment of the
  same active loan through preview-confirm-execute.
- Original posted records remain immutable and visible.
- The correction is represented by balanced append-only compensating and
  replacement transactions with complete public lineage.
- Exact payment amount and component totals are conserved at zero variance.
- Both affected schedules and the loan rollup are correct after one atomic commit.
- Stale, ambiguous, dependent, overpaying, duplicate, or unauthorized corrections
  produce no financial writes.
- MCP/plugin contracts and tests describe and enforce the same workflow.
- The initiating production case is not mutated until post-deployment preview and
  explicit confirmation.
