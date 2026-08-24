# Unfunded Loan Cancellation Design

## Goal

Add an auditable cancellation workflow for an active loan that was never actually disbursed, exposed through REST and CreditSync MCP, so an unfunded contract can be cancelled without silently forgiving a real funded balance.

## Scope

The workflow supports only `unfunded` cancellation. It is eligible only when the accessible loan is active, has no effective posted payment or close-account transaction, has no posted actual disbursement and `netDisbursed = 0.00`, and has no downstream blocker. Eligibility is checked at preview and execute time.

Execution sets the loan and unpaid schedules to `cancelled`, zeroes collectible rollup fields, preserves all financial and audit history, and records before/after state and reason. It never deletes transactions, intakes, schedules, disbursement events, or audits.

## Public APIs

- REST `POST /loans/:id/cancel/preview` with `{ reason }`.
- REST `POST /loans/cancel/:previewId/execute` with confirmation, expected balance version, preview hash, reason, and an idempotency key header.
- MCP `loan.cancel.preview` and `loan.cancel.execute` with closed public-ID/money schemas.

Execution is atomic, explicitly confirmed, stale-preview protected, idempotent, audited, and cache-invalidating. Stable errors cover ineligible, funded, posted-payment, downstream, stale-preview, and access cases.

## Verification

Cover success with non-zero contractual balances but zero actual funding, funded/payment/downstream rejection, stale preview, duplicate execute, cross-tenant access, schedule cancellation, audit/correlation output, closed schemas, MCP annotations, contract synchronization, plugin validation, and disposable PostgreSQL tests.
