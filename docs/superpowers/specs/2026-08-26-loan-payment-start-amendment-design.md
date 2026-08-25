# Loan Payment-Start Amendment Design

**Date:** 2026-08-26  
**Status:** Approved in conversation

## Goal

Allow an operator to change the first repayment date of an active scheduled loan without mutating the activated contractual schedule rows, financial records, or loan terms. The command must produce an immutable amendment history, deterministic effective schedule, explicit confirmation, and a compensating reversal path.

## Scope

The first release applies to `daily`, `weekly`, and `monthly` loans in `active` status only when every schedule row has `paidTotal = "0.00"` and is not already superseded. It supports a requested `paymentStartDate` on or after the immutable contract `startDate`.

It intentionally excludes loans with any posted or partial installment payment, floating loans, single-payment loans, and changes to principal, interest, fees, installment amounts, or installment count. Those cases require the existing restructure or replacement workflow because their financial state has already begun.

For the reported loan, the amendment changes the first due date from `2026-08-23` to `2026-08-22`, keeps 100 installments at `300.00` THB, and changes the final due date from `2026-11-30` to `2026-11-29`.

## Domain Rules

1. `startDate` is an activated loan term and is never changed.
2. The request uses a `YYYY-MM-DD` Asia/Bangkok business date. It must be on or after `startDate`.
3. The backend alone regenerates dates using the original repayment type and fixed installment metadata. It must prove that scheduled principal, interest, fee, total, and installment count are identical before and after the amendment.
4. Existing `loan_schedules` contractual fields, including `due_date`, remain immutable. A schedule amendment does not update or delete them.
5. The effective repayment schedule is the latest active amendment revision when one exists; otherwise it is the original `loan_schedules` schedule.
6. A command requires a non-blank reason, request/correlation context, authenticated actor/source, and a tenant-scoped idempotency key.
7. Execution requires a fresh server-issued preview ID and preview hash plus `confirmed: true`. A changed loan/version or expired preview requires a new preview.
8. Reversal is a new immutable amendment that restores the immediately preceding effective revision. It requires an explicit reason, confirmation, and idempotency key. It never deletes an amendment or schedule revision.

## Data Model

Add `loan_schedule_amendments` as an append-only command ledger:

- `id`, `public_id`, `tenant_id`, `loan_id`
- `revision_no` and nullable `reversed_by_amendment_id`
- `kind` (`payment_start_date` or `reversal`)
- `status` (`executed` or `reversed`)
- `previous_payment_start_date`, `payment_start_date`
- `previous_revision_no`, `source_amendment_id` for a compensating reversal
- `reason`, `idempotency_key`, `request_id`, `correlation_id`, `actor_source`, `created_by_user_id`, `created_at`
- immutable preview provenance: `preview_hash`, `expected_schedule_version`, `expires_at`

Add `loan_schedule_amendment_rows` as immutable replacement-date rows:

- `id`, `public_id`, `tenant_id`, `amendment_id`, `source_schedule_id`
- `installment_no`, `due_date`
- copied `scheduled_principal`, `scheduled_interest`, `scheduled_fee`, and `scheduled_total`
- `created_at`

The rows deliberately copy all contractual amounts so the database can enforce that an amendment only changes dates. Add checks/constraints for tenant ownership, unique `(tenant_id, amendment_id, source_schedule_id)`, unique `(tenant_id, loan_id, revision_no)`, amount equality to the source schedule where PostgreSQL supports it through a trigger, valid status/kind values, non-blank reason, and immutable `UPDATE`/`DELETE` triggers on both tables.

Store short-lived preview artifacts in a new `loan_schedule_amendment_previews` table or in the existing command-preview pattern, depending on the established repository primitive. The artifact contains the loan version, requested date, generated date rows, totals digest, preview hash, expiry, actor/tenant ownership, and whether it was consumed. A preview is not a financial record and may expire; executed amendment/reversal records remain immutable.

## Effective Schedule Projection

Create one read-model service responsible for resolving a loan's effective schedule.

1. Load original `loan_schedules` ordered by installment number.
2. Load the latest executed amendment that is not reversed, or the source revision selected by an executed reversal.
3. If no effective amendment exists, return original due dates.
4. If an effective amendment exists, join its amendment rows by `source_schedule_id`, taking due dates from amendment rows and amounts/status/payment fields from original schedule rows.
5. All schedule REST views, loan-contract MCP reads, payment allocation, overdue calculation, next due date, and dashboard schedule summary use this projection.

The projection is read-only and does not duplicate posted payment balances. Versioning means a later reversal simply selects the prior immutable set of dates.

## Command Workflow

### Preview

`loan.payment-start-date.preview` accepts `{ loanPublicId, paymentStartDate, reason }`.

It validates access, scheduled-loan type, active status, no payment activity, date ordering, and no active conflicting amendment. It generates the proposed dates and returns:

- preview public ID, expiry, preview hash, expected schedule/loan version
- prior and proposed first/last due dates
- number of affected rows
- original and proposed payment-start dates
- explicit invariants: identical installment count and identical aggregate principal, interest, fee, and total

### Execute

`loan.payment-start-date.execute` accepts `{ amendmentPreviewPublicId, previewHash, expectedScheduleVersion, confirmed: true, reason, idempotencyKey }`.

Within one transaction, it locks the loan and all schedule rows, rechecks every preview invariant, creates the amendment and all amendment rows, writes an audit record, marks the preview consumed, and invalidates tenant caches. It returns amendment public ID, revision number, effective first/last due date, audit public ID, and correlation ID.

### Reverse

`loan.payment-start-date.reverse` accepts `{ amendmentPublicId, confirmed: true, reason, idempotencyKey }`.

It locks the selected amendment and loan, ensures no payment activity has started after the amendment, writes a compensating reversal amendment that points to the selected prior revision, writes audit history, and invalidates caches. The reversal's effective schedule is the selected amendment's predecessor; no original or amendment row is altered.

## API, MCP, and UI

Replace the broken direct-update behavior with separate preview/execute/reverse endpoints under the loan contract route. Retire `POST /loans/:id/payment-start-date` as a mutable operation; keep a compatibility response that directs callers to preview/execute for one release, then remove it in the next major MCP contract version.

Replace MCP `loan.payment-start-date.update` with three closed tools. `preview` is destructive only in the sense that it creates an expiring command artifact; `execute` and `reverse` are destructive and idempotent. Reads remain `loan.contract.get` and a new amendment-list read tool if needed by the UI. Each write returns audit and correlation public IDs. The frozen plugin manifest, validator, eval scenarios, skill instructions, README tool list, and MCP output schemas are updated atomically.

The loan detail screen shows the effective schedule and a visible “Amended” indicator with original date, effective date, amendment revision, reason, actor, and reversal lineage. The change dialog calls preview first, renders the server-calculated impact, requires explicit confirmation, then executes. It hides the action when eligibility fails and explains that paid/partially paid loans require restructure/replacement. English and Thai locale files change together.

## Errors and Safety

Use domain errors, never generic internal errors, for invalid business inputs and database-trigger conflicts. Required cases include `LOAN_NOT_SCHEDULED`, `LOAN_NOT_ACTIVE`, `PAYMENT_START_DATE_BEFORE_CONTRACT_START`, `PAYMENT_START_AMENDMENT_PAYMENT_ACTIVITY_EXISTS`, `PAYMENT_START_AMENDMENT_CONFLICT`, `PAYMENT_START_AMENDMENT_PREVIEW_EXPIRED`, `PAYMENT_START_AMENDMENT_PREVIEW_STALE`, `PAYMENT_START_AMENDMENT_INVARIANT_FAILED`, and `PAYMENT_START_AMENDMENT_NOT_REVERSIBLE`.

Database errors that indicate immutable schedule mutation must map to a stable 409 domain error and be logged with safe code/context only. Raw SQL, disabling immutable triggers, and direct schedule-date updates are forbidden.

## Verification and Deployment

Tests must first demonstrate that the old direct update violates the immutable trigger. New service/database tests cover successful no-payment daily/weekly/monthly amendments, first-day equals contract start, date validation, full amount/count equality, idempotency replay/conflict, stale/expired previews, tenant/access isolation, concurrent execution locking, original-row immutability, effective projection, reversal, and rejection after any payment activity.

MCP contract tests cover closed schemas, annotations, safe errors, audit/correlation metadata, and preview-to-execute state checks. Frontend tests cover eligibility, impact confirmation, amended/reversed rendering, and Thai/English copy. Run `backend/scripts/test-disposable-postgres.sh`, backend typecheck, frontend tests/lint/build, and plugin validator/tests. Deploy migration first, then backend, then frontend; verify new tables/triggers, execute a controlled test-tenant amendment, inspect the effective schedule, audit entry, MCP health, and backend logs. Production tenant records are never used as test fixtures.
