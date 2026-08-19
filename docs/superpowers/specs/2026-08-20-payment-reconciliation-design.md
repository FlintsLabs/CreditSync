# Payment Reconciliation Design

**Status:** Approved for implementation

## Goal

Allow the private CreditSync MCP workflow to correct an incorrectly allocated or chronologically backdated payment without editing or deleting posted financial records, including payments before the exact floating-ledger cutover date.

## Problem

`payment_post` correctly rejects a backdated floating payment when later immutable allocation history exists. The current reversal workflow creates compensating records, but the normal payment matcher still sees compensated allocations as blockers, and there is no explicit reconciliation workflow for historical/cutover cases. This leaves an operator unable to correct a payment whose interest/principal allocation was wrong.

## Recommended approach

Add a dedicated two-phase reconciliation workflow:

1. `payment_reconcile_preview` validates the selected posted payment, target allocations, chronology, exact amount, and correction scope without writing financial records.
2. `payment_reconcile_execute` requires the preview hash, expected state version, explicit confirmation, reason, and idempotency key. It appends compensating reversal records and corrected allocation records atomically.

The workflow must not mutate or delete the original payment, transaction, accrual, or allocation. It may use a controlled reconciliation ledger for historical dates that predate exact floating allocation provenance. Every generated record must reference the source record and reconciliation audit entry.

## Scope

### In scope

- MCP schemas, handlers, service functions, audit and correlation metadata.
- Interest/principal/penalty allocation corrections for posted payment intakes.
- Historical dates before exact-ledger cutover when the operator supplies an explicit correction allocation.
- Excluding already compensated allocations from future-immutable allocation blockers.
- Idempotent retries and stale-preview rejection.
- Plugin manifest, frozen contract, skills, validator, and MCP tests.

### Out of scope

- Direct database mutation tools.
- Deleting or editing posted records.
- Automatic financial decisions from fuzzy borrower or loan matching.
- Changing ordinary payment allocation behavior unless required to make the reconciliation invariant correct.

## Public workflow contract

`payment_reconcile_preview` accepts:

- `paymentIntakePublicId: string`
- `allocations: Array<{ borrowerPublicId: string; loanPublicId: string; amount: string; schedulePublicId?: string }>`
- `reason: string`

It returns a ready preview containing the source payment, current allocation snapshot, proposed allocation, exact signed correction by component, warnings, `previewHash`, `expectedBalanceVersion`, `expiresAt`, and public IDs of any historical reconciliation groups that will be created.

`payment_reconcile_execute` accepts:

- `reconciliationPreviewPublicId: string`
- `previewHash: string`
- `expectedBalanceVersion: string`
- `confirmed: true`
- `reason: string`
- `idempotencyKey: string`

It returns the reconciliation public ID, source payment public ID, compensating transaction/allocation public IDs, audit public IDs, and correlation ID. Repeating the same idempotency key returns the original result; a changed request fails with an idempotency conflict.

## Financial invariants

- All monetary values are two-decimal decimal strings calculated with `decimal.js`.
- The corrected allocation total must equal the source payment amount unless the preview explicitly records an approved unallocated variance; default behavior rejects variance.
- Reversal and replacement entries are append-only and linked to their source entries.
- A compensated allocation is not treated as an active later immutable allocation.
- Historical reconciliation cannot reduce paid interest below zero or create negative outstanding principal.
- The operation locks the affected payment intake, loans, accrual rows, and reconciliation group in deterministic order.
- Every write includes actor/source, request ID, correlation ID, idempotency key, reason, before/after snapshots, and audit public ID.

## Compatibility and safety

The existing `payment_reverse` MCP contract must be extended to pass its idempotency key, or the new reconciliation service must provide the required command context internally. Existing ordinary payment posting remains strict; only the explicit reconciliation workflow can bypass the backdated blocker, and only after preview validation and confirmation.

## Verification

- Unit tests for allocation deltas, compensated allocation filtering, stale preview, idempotency, and historical cutover.
- Disposable PostgreSQL integration tests covering a wrong principal allocation corrected to interest-only and a later-payment reversal followed by backdated reconciliation.
- MCP contract/validator/plugin tests and closed-schema checks.
- Backend typecheck and disposable test suite; frontend tests/lint/build where the contract or UI types are affected.
- Production-like MCP health check after deployment; no live financial records are created during verification.
