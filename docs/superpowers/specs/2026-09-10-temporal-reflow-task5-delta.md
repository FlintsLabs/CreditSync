# Task 5 temporal-reflow delta

## Existing reconciliation boundary

`payment_reconciliation_proposals`, `payment_reconciliation_groups`, and
`payment_reconciliation_entries` remain the transaction-level correction
ledger. They own the original intake, compensating/replacement transactions,
reason, audit, and idempotency. Temporal reflow does not create a second
payment or restore ledger and does not edit those posted rows.

The reflow companion tables added by migration 0070 hold only allocation-level
lineage: an expiring plan snapshot, one executed reflow command per existing
reconciliation group, and immutable source/reversal/replacement allocation
links. Every link is tenant-scoped and uses existing floating allocation rows
as the economic source of truth.

## Kernel contract

The kernel calls `resolveFloatingInterestAllocationPlan` for replacement
capacity and due-date selection. It does not recalculate rates, periods, or
rounding. It accepts interest-only provenance; missing source allocation,
ambiguous replacement, or any principal/fee/penalty effect returns a stable
fail-closed domain error before writes.

Execution locks borrowers/loans and then reconciliation, transaction,
allocation, and accrual rows in deterministic order. It re-reads the plan and
balance version after the locks. It appends negative reversal allocations and
positive replacements attached to the same original transaction, verifies
exact conservation, then rebuilds only derived accrual paid caches from signed
allocation provenance in the same transaction.

Original transaction date, amount, component totals, intake, loan terms, and
existing allocation rows remain immutable. Public results carry only UUIDs,
decimal strings, dates, reason, and correlation metadata; no raw evidence or
internal database identifiers are public.

Migration 0070 is additive after the current 0069 journal entry. It has no
historical backfill and does not alter prior migration SQL or checksums. Legacy
reconciliations become eligible only through a new preview that proves complete
provenance; no inferred repair is ready.
