# Atomic Loan Replacement Design

## Purpose

CreditSync needs a safe way to replace an active scheduled loan when its persisted contract terms are wrong, without representing the correction as borrower repayment, renewal cash flow, or ordinary restructuring. The workflow must activate an already-reviewed replacement draft and mark the original loan as replaced in one transaction while preserving the complete financial and audit history.

The first use case replaces an active daily loan whose start date was entered one day late. The original loan has no paid principal and no effective posted borrower disbursement. Its calculated `4,200.00` interest is an artifact of the incorrect date and must neither be collected nor carried into the replacement. The prepared replacement draft retains principal `36,000.00` and daily payments of `300.00` for 200 days, starts on `2026-07-11`, and has its first installment due on `2026-07-12`.

## Scope

The feature adds a dedicated `loan-replacement` lifecycle for an active loan and an existing draft replacement. It does not change renewal semantics, broaden single-payment restructuring, edit posted financial records, delete schedules, or infer that a replaced loan was repaid.

The initial implementation supports scheduled loans (`daily`, `weekly`, and `monthly`) whose replacement can be activated by the existing loan-origination service. Floating and single-payment loans remain on their existing settlement and restructuring workflows.

## Terminology and Status

Add `replaced` as a terminal loan status. The user-facing label is **Closed — Replaced** in English and **ปิดแล้ว — ถูกแทนที่** in Thai.

A replaced loan:

- is excluded from active portfolios and active-loan operational queues;
- is not classified as paid, settled, renewed, cancelled, or restructured;
- retains its original principal, terms, schedules, transactions, and audit history;
- exposes outbound lineage to the replacement loan;
- has no collectible outstanding balance after execution because a reasoned correction closes the erroneous exposure.

The replacement loan exposes inbound lineage to the replaced loan.

## Data Model

Add an append-only `loan_replacements` table with tenant-scoped foreign keys to the old loan, replacement loan, actor users, and execution/reversal audits. Each record contains:

- public UUID, tenant ID, old loan ID, and replacement loan ID;
- status: `preview`, `executed`, `reversed`, or `expired`;
- reason and actor source;
- old-loan balance version and replacement-draft version;
- preview hash, request hash, and expiry;
- immutable pre-execution snapshots for both loans and affected schedules;
- execution and reversal idempotency keys and request hashes;
- request ID, correlation ID, actor IDs, audit public IDs, and timestamps.

Add tenant-safe indexes that prevent more than one executed, non-reversed replacement from consuming the same old loan or replacement loan. Add database guards that reject mutation or deletion of executed/reversed replacement records except for the narrowly defined lifecycle transition performed by the service.

The old loan gains no mutable pointer column. Lineage is derived from `loan_replacements`, avoiding contradictory bidirectional state. The existing `cloned_from_loan_id` on the replacement remains compatible but is not the authoritative replacement ledger.

## Preview

`previewLoanReplacement(ctx, input)` accepts:

- `oldLoanPublicId`;
- `replacementDraftPublicId`;
- a nonblank correction reason.

Preview locks nothing permanently and performs no financial write. Persisting the preview record is allowed, but it must not change loans, schedules, allocations, transactions, or disbursements.

The preview validates:

- the actor can administer both loans within one tenant;
- the old loan is `active` and the replacement is `draft`;
- both loans belong to the same borrower and owner scope;
- the replacement has an active, sufficient funding source;
- the replacement terms can be activated by the authoritative backend calculation;
- the old loan has no posted payment, effective posted disbursement, executed renewal/restructure/settlement, or other downstream record that prevents correction;
- no prior executed replacement consumes either loan;
- all balances, schedules, and funding versions match the preview fingerprint.

The response contains exact decimal strings and shows:

- old principal, outstanding principal, interest, fees, and penalties that will be corrected to zero;
- replacement terms, first and last due dates, total repayment, and funding source;
- cash direction `none` and cash amount `0.00`;
- warnings, preview hash, public ID, balance/version fingerprints, and expiry.

For the initial use case, preview must explicitly show that `4,200.00` is not collected or carried forward, the replacement starts `2026-07-11`, and installment 1 is due `2026-07-12`.

## Atomic Execution

`executeLoanReplacement(ctx, input)` requires:

- replacement preview public ID;
- preview hash and all expected versions;
- the same nonblank reason;
- `confirmed: true`;
- a nonblank idempotency key.

Execution runs in one PostgreSQL transaction and acquires stable advisory and row locks for the replacement record, old loan, replacement draft, schedules, funding source, and relevant downstream ledgers. It re-runs every preview invariant against locked rows.

The transaction then:

1. activates the replacement draft through shared loan-origination primitives and creates its immutable schedule;
2. allocates the replacement principal to its persisted funding source without duplicating an existing allocation;
3. appends reasoned correction records for the old outstanding principal, interest, fees, and penalties so no amount is treated as borrower payment or cash movement;
4. marks remaining old schedules `cancelled` with zero remaining due while preserving their original scheduled components;
5. changes the old loan status from `active` to `replaced` and sets collectible rollups and `nextDueDate` to zero/null;
6. marks the replacement ledger `executed`, links both loans through authoritative lineage, and appends complete before/after audit records.

Any failed step rolls back all changes. An idempotent replay with the same key and request hash returns the original result; a mismatched payload returns `IDEMPOTENCY_CONFLICT`.

## Reversal

`reverseLoanReplacement(ctx, input)` requires the executed replacement public ID, a nonblank reason, and an idempotency key.

Reversal is allowed only when the replacement loan has no posted payment, effective posted disbursement, renewal, restructure, settlement, waiver, remittance, commission, or other downstream record that would make restoration ambiguous. It runs atomically and:

- appends compensating reversals for correction and funding-allocation effects;
- cancels the replacement loan and its remaining schedules without deleting them;
- restores the old loan and old schedules exactly from the pre-execution snapshot;
- marks the replacement ledger `reversed` and appends reversal audit records.

If any downstream dependency exists, reversal fails with `reviewRequired: true` and makes no change.

## Interfaces

Expose tenant-scoped REST commands and three synchronized MCP tools:

- `loan_replacement_preview` with read-only annotations;
- `loan_replacement_execute` marked destructive and requiring explicit confirmation;
- `loan_replacement_reverse` marked destructive.

All tools use closed schemas, public UUIDs, ISO dates, and two-decimal money strings. Execute and reverse responses include replacement data, both loan public IDs, audit public IDs, and correlation ID. The frozen MCP contract, plugin manifest/version, skills, validator, and eval scenarios must be updated together.

Frontend Loan Detail and Loan List surfaces show the localized terminal status and lineage links. The confirmation view displays exact before/after balances, the absence of cash flow, the corrected schedule dates, funding source, warnings, reason, and expiry before enabling Execute.

## Failure Handling

Preview or execution stops for human review on borrower mismatch, funding mismatch, stale versions, expired previews, prior replacement, ambiguous payment/disbursement history, or unsupported downstream records. Validation errors identify the exact blocking public IDs without exposing internal IDs, credentials, raw evidence, or signed URLs.

No code path may update or delete posted financial records. Money calculations use `decimal.js`/`FinancialDecimal`; JavaScript `Number` is prohibited for monetary values.

## Verification

Database and service tests must prove:

- the approved active-loan plus existing-draft case executes atomically;
- the replacement first due date is `2026-07-12`;
- `4,200.00` is neither collected nor carried forward;
- the old loan is `replaced`, has no collectible balance, and is excluded from active portfolios;
- the replacement loan is active exactly once and receives the intended TTB funding allocation;
- idempotent retries do not duplicate schedules, allocations, correction records, or audits;
- stale previews, borrower mismatch, funding mismatch, and insufficient capacity fail closed;
- posted payments/disbursements and unsupported downstream records require review;
- injected failures roll back every mutation;
- reversal restores the snapshot when safe and fails closed after downstream activity;
- tenant isolation and database immutability guards hold.

Required gates are the disposable PostgreSQL backend suites, backend unit tests and typecheck, MCP tests and validator, and frontend test/lint/build. A skipped database suite is insufficient for this financial invariant.

## Rollout and First Execution

Deploy the additive migration and service/tool changes before attempting the prepared production replacement. Run a fresh preview against the persisted old loan and replacement draft, compare every exact value with this design, obtain explicit confirmation, execute once with a unique idempotency key, and independently verify lineage, schedules, funding allocation, audits, active-loan filtering, and the absence of cash movement.

Do not activate the prepared draft or alter the original active loan before this workflow is deployed and the fresh preview is confirmed.
