# Atomic Batch Payment Design

## Status

Approved design for accepting one or more payment slips, allocating each slip across one or more scheduled loans, editing the complete allocation set through one human instruction, confirming once, and posting the batch atomically.

## Problem

The existing payment workflow persists one preview per payment intake. A new preview stales the previous preview, previews expire, and posting one payment changes the loan and schedule state hashed by previews for later payments. When an operator uploads several consecutive slips for the same loan, previewing the set before posting causes later previews to become stale. MCP maps these conflicts to human review, so the operator may have to confirm repeatedly.

The same limitation prevents an efficient workflow when one transfer pays several loans belonging to the same borrower. The transfer amount can have multiple exact allocation combinations, and an individual slip cannot safely be matched without considering the other slips uploaded in the same operator request.

## Goals

- Accept multiple slips in one batch.
- Allow one slip to fund one or more scheduled loans.
- Allow multiple slips to fund multiple scheduled loans in one reviewed operation.
- Treat the complete batch as the unit of preview, human confirmation, idempotency, and execution.
- Let an operator provide or revise every allocation through one prompt and confirm the final preview once.
- Detect unique exact allocations and present ambiguous exact combinations without making an automatic financial decision.
- Post all items atomically or post none of them.
- Preserve individual payment intakes, evidence, transactions, fund effects, and audit history.
- Avoid repeated human confirmation when only transient state/version metadata changes and the confirmed financial semantics remain identical.

## Non-goals for the First Release

- Floating-loan allocation.
- One batch spanning several unrelated payers.
- Intermediary remittance reconciliation.
- Automatic borrower identity decisions based only on tags, fuzzy matching, or unconfirmed aliases.
- Editing or deleting posted financial records.
- Replacing the existing single-intake workflow.

## Scope

The first release supports active scheduled loans for one resolved borrower per batch. A batch may include several loans owned by that borrower. Each item has one finalized evidence file and one payment intake. One item may have several allocations, and several items may be solved jointly.

The agent may use canonical names, confirmed aliases, prior payer history, and tags to rank borrower candidates. Tags and fuzzy matches are never authoritative. If candidate resolution is not unique, the batch remains `needs_review` until the human selects the borrower and affected loans.

## Domain Model

### Payment Batch

`payment_batches` stores the aggregate lifecycle:

- `public_id`
- `tenant_id`
- `borrower_id`
- `status`: `draft`, `needs_review`, `ready`, `confirmed`, `posted`, `stale`, or `cancelled`
- `version`
- `state_hash`
- `confirmation_hash`
- `confirmed_version`
- `idempotency_key`
- actor/source, request ID, correlation ID, and audit references
- created, updated, confirmed, and posted timestamps

The batch belongs to one tenant and one resolved borrower. The borrower may remain null while candidate resolution requires review, but a batch cannot become `ready` without an exact borrower.

### Batch Item

`payment_batch_items` associates an ordered slip with its existing payment intake:

- batch ID and payment intake ID
- item order
- transfer timestamp
- exact two-decimal evidence amount
- evidence readiness
- duplicate-check result
- item warnings and ambiguity metadata

Each payment intake retains its existing lifecycle and public API representation. Evidence continues to use prepare, direct signed PUT, and finalize. A ready evidence retry must not upload or finalize the file again.

### Batch Allocation

`payment_batch_allocations` stores the latest previewed financial interpretation:

- batch item ID
- borrower, loan, and schedule IDs
- allocation order
- exact allocation amount
- previewed principal, interest, fee, and penalty components
- `match_source`: `human_explicit`, `unique_exact`, or `selected_candidate`
- stable semantic key

Preview allocations are mutable only while the batch is unposted. Posted financial effects remain append-only in the existing transaction and ledger tables.

### Batch Preview

Every preview is immutable and versioned. A new preview stales the previous preview for the same batch but does not require human confirmation until the operator asks to execute.

The preview records:

- preview public ID and version
- state hash
- preview hash
- confirmation hash
- ordered item and allocation snapshot
- exact before/after loan balances
- totals, unallocated amounts, warnings, and ambiguity candidates
- expiry

## State Machine

```text
draft
  -> needs_review  (ambiguous, duplicate candidate, incomplete, or mismatched)
  -> ready         (one complete warning-free preview)
ready
  -> ready         (operator edits allocations and creates a newer preview)
  -> confirmed     (operator confirms the latest semantic preview)
confirmed
  -> posted        (atomic execution succeeds)
  -> stale         (financial semantics changed before execution)
stale
  -> confirmed     (re-preview is semantically identical)
  -> needs_review  (re-preview changes confirmed semantics)
```

Cancellation is allowed only before posting. Cancellation does not delete intakes or finalized evidence.

## Intake and Evidence Flow

1. Create a batch with a stable idempotency key.
2. Create one idempotent payment intake per slip.
3. Prepare evidence intents after computing local SHA-256 and file metadata.
4. Upload independent evidence files concurrently using signed PUT URLs.
5. Finalize every evidence item.
6. Stop before preview if any required evidence is not `ready` or is a confirmed duplicate.

Evidence hashing, OCR, contract reads, and signed uploads may run concurrently. Preview and posting are batch-level operations.

## Borrower and Loan Resolution

The system searches the payer candidate against:

1. canonical borrower name;
2. confirmed borrower aliases;
3. prior confirmed payer history;
4. tags and fuzzy candidates for ranking only.

A unique canonical or confirmed-alias match may select the borrower. Other evidence can only produce candidates. The operator can explicitly identify the borrower and loans in the prompt, which overrides candidate ranking after tenant, ownership, active-loan, and identity consistency checks pass.

No persistent payer group is introduced. Relationships are resolved for the current batch and confirmed through the batch preview.

## Exact-combination Allocation

For a resolved borrower, the service loads eligible obligations from every accessible active scheduled loan. It represents money as integer cents or `decimal.js` values; JavaScript `Number` is forbidden.

For each slip, the service searches combinations whose exact total equals the slip amount. A combination may contain several obligations from several loans. When several slips are present, the solver treats the batch jointly so that the same obligation cannot be consumed by two items.

The bounded solver must:

- produce deterministic candidate ordering;
- prefer fully due obligations before future obligations unless the operator explicitly requests advance payment;
- respect an explicitly supplied schedule/date;
- cap candidate count and search work;
- return `needs_review` rather than guess when the cap is reached;
- preserve all materially distinct exact combinations needed for a human choice.

Example obligations of 30.00, 20.00, and 50.00 with a 50.00 slip produce at least:

- 50.00 to the third contract; or
- 30.00 to the first and 20.00 to the second.

Because two exact answers exist, the batch cannot become `ready` until the human selects one.

## Human-explicit Allocations

Human instructions are the preferred source of intent. The agent converts natural-language instructions into closed structured allocations and calls the preview tool. The backend does not interpret natural language.

An operator may edit the whole batch with one instruction, for example:

- move an item to another loan;
- split one slip across two loans;
- mark a transfer as advance payment for a named due date;
- remove an unposted item from the batch;
- select a candidate combination;
- replace allocations for several items at once.

Each edit creates one new batch preview version. Intermediate edits do not require confirmation. The human confirms only the complete latest preview.

## Batch Preview Presentation

The reader-facing preview includes one row per allocation with:

- slip/item label;
- transfer timestamp;
- target due date;
- borrower and loan public IDs;
- amount;
- principal, interest, fee, and penalty components;
- match source and status.

It also includes:

- evidence total;
- allocated total;
- unallocated total;
- before/after balances per loan;
- all warnings;
- candidate combinations for ambiguous items;
- explicit advance/backdated-payment labels.

The UI and agent summary must use the active language and exact decimal-string formatting.

## Confirmation Semantics

The preview exposes two independent hashes.

`stateHash` covers current accounting state required for safe execution, including target status, relevant schedule balances, immutable rate/fee terms, and affected ledger state.

`confirmationHash` covers the human-approved semantics:

- batch and item identities;
- evidence identities;
- target borrower, loans, and schedules;
- transfer timestamps and target due dates;
- allocation order and amounts;
- calculated principal, interest, fee, and penalty components;
- acknowledged warnings, if a policy permits them.

The confirmation is bound to the latest confirmation hash, not merely a proposal public ID. If execution observes state drift, it re-simulates under lock. It may retain the confirmation only when the resulting confirmation hash is byte-for-byte identical and no new warning appears. Any semantic change stops the whole batch and requires a new confirmation.

## Atomic Execution

`payment.batch.execute` performs all validation and writes in one PostgreSQL transaction.

Locks are acquired in a deterministic order:

1. payment batch;
2. payment intakes by internal ID;
3. loans by internal ID;
4. schedules by internal ID;
5. batch preview and allocations.

Under those locks, execution:

1. validates idempotency and batch lifecycle;
2. verifies every intake and evidence item is ready;
3. repeats duplicate detection;
4. verifies active targets and portfolio access;
5. re-simulates allocations in transfer/allocation order;
6. compares the resulting confirmation hash;
7. creates individual immutable repayment transactions;
8. updates schedules and loan rollups;
9. writes fund effects and individual audit events;
10. marks allocations, intakes, preview, and batch posted;
11. writes a batch-level audit event;
12. commits once.

Any error rolls back every financial write in the batch. Retry with the same execution idempotency key returns the original posted result.

## MCP Contract

The initial tool set is:

- `payment.batch.create`
- `payment.batch.item.add`
- `payment.batch.evidence.prepare`
- `payment.batch.evidence.finalize`
- `payment.batch.preview`
- `payment.batch.get`
- `payment.batch.execute`

`payment.batch.preview` accepts optional explicit allocations for all items. Without explicit allocations it returns exact-combination results and either `ready` or `needs_review`.

`payment.batch.execute` requires:

- batch public ID;
- preview public ID;
- preview hash;
- confirmation hash;
- `confirmed: true`;
- idempotency key.

All schemas are closed. Inputs and outputs expose public UUIDs and two-decimal strings only. Execute is marked destructive. Every successful write returns correlation and audit public IDs. MCP calls application services directly and never calls the product REST API.

## Error Contract

The batch workflow distinguishes machine-recoverable state changes from human decisions:

- `BATCH_NEEDS_REVIEW`
- `BATCH_DUPLICATE_EVIDENCE`
- `BATCH_ALLOCATION_MISMATCH`
- `BATCH_STATE_CHANGED_SEMANTICS_SAME`
- `BATCH_CONFIRMATION_STALE`
- `BATCH_EXECUTION_CONFLICT`
- `BATCH_ALREADY_POSTED`

MCP errors expose separate signals:

- `retryable`
- `repreviewRequired`
- `humanReviewRequired`

An HTTP 409 is not automatically a human-review request. Human review is required for ambiguous identity, ambiguous allocation, duplicate decisions, changed financial semantics, and newly introduced warnings. A state/version refresh with identical semantics can proceed without another confirmation.

## Concurrency

Evidence preparation and upload may run concurrently. Multiple batches that do not share loans may execute concurrently.

When two batches touch the same loan, deterministic locking serializes execution. The later batch re-simulates after acquiring the lock. It proceeds if its confirmation hash remains identical; otherwise it rolls back and becomes `needs_review` or `stale` without partial posting.

## Security and Financial Invariants

- Money crosses interfaces as two-decimal decimal strings and is calculated with `decimal.js`.
- Business dates use Asia/Bangkok.
- Evidence remains optional at the product level, but every slip-backed batch item supplied by this workflow must finalize its evidence before preview can become ready.
- Raw QR payloads, evidence contents, signed URLs, account numbers, identity-card values, and tokens are not logged or audited.
- Posted records are immutable and can only be corrected through compensating reversal workflows.
- Every write carries actor/source, request/correlation ID, idempotency context, and append-only audit history.
- Candidate ranking never becomes an automatic identity or financial decision when ambiguous.

## Compatibility and Rollout

The current `intake.create -> payment.preview -> payment.post` workflow remains supported for single payments.

Rollout phases:

1. Add database schema, batch domain service, solver, atomic execution, and disposable-PostgreSQL integration tests behind a feature flag.
2. Add MCP tools, closed schemas, validator updates, plugin guidance, and eval scenarios.
3. Add a localized Batch Preview editor and enable the feature flag for selected operators.

Agents select batch flow when a request contains multiple slips, multiple dates, or a slip that may affect multiple loans.

## Verification

Required scenarios include:

- one slip to one loan;
- one slip split across several loans;
- several slips across consecutive dates for one loan;
- several slips jointly allocated across several loans;
- unique and ambiguous exact combinations;
- explicit human allocation and whole-batch prompt edits;
- duplicate SHA-256, bank reference, and semantic duplicate detection;
- same-day slips without sufficient instructions;
- backdated and advance-payment ambiguity;
- identical semantic re-preview after state drift;
- changed semantic re-preview requiring confirmation;
- concurrent batches on one loan;
- injected failure after each execution stage proving full rollback;
- idempotent execute retries;
- exact audit, correlation, transaction, fund-effect, and schedule results;
- large exact decimal strings and rounding boundaries;
- Asia/Bangkok date boundaries.

Verification gates are backend unit tests, disposable PostgreSQL integration suites, backend typecheck, MCP server/default tests, frozen contract and plugin validator, plugin eval scenarios, and frontend test/lint/build when the editor is added. A skipped database suite is insufficient for the atomic financial invariant.
