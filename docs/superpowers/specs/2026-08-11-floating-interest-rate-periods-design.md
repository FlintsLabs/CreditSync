# Floating Interest Rate Periods Design

## Objective

Allow each floating loan to carry an effective-dated daily-interest timeline. Operators can schedule a future rate, replace a bounded date range, and inspect the rate and daily amount that apply on any business date without changing already-posted financial history.

This replaces the single mutable floating-rate policy on `loans` as the calculation source of truth. The existing loan columns remain temporarily available only for a backward-compatible migration and are not the long-term write target.

## Domain Rules

- A rate period belongs to exactly one tenant and one loan.
- `effectiveDate` and `expiryDate` use Bangkok business dates in `YYYY-MM-DD` format and are inclusive.
- A null `expiryDate` means that the period is open-ended.
- A period has a positive rate with at most four decimal places and a type of `percent` or `per_thousand`.
- The first-day treatment remains a loan-level origination policy. Changing a later rate does not repeat a first-day deduction.
- Rate periods for a loan must not overlap after a command completes.
- A floating loan must have at most one applicable period on any accrual date.
- Posted/materialized daily accruals are immutable. A new or replaced period affects only dates that have not yet accrued.
- Rate-period commands are allowed regardless of whether the loan is draft, active, paid, defaulted, or closed. For a loan that is not accruing, the timeline may be maintained but no new accrual is generated unless the surrounding lifecycle already permits it.
- Every write carries command context, actor/source, correlation/request ID, and an idempotency key and produces append-only audit history.

## Persistence Model

Create `loan_interest_rate_periods` with:

- internal `id` and public UUIDv7 `public_id`
- `tenant_id` and `loan_id` with a tenant-safe foreign key
- `effective_date`
- nullable `expiry_date`
- `rate_type` (`percent` or `per_thousand`)
- exact numeric `rate`
- `created_by_user_id`, `created_at`, and `updated_at`

Database checks require a positive rate, supported type, and `expiry_date >= effective_date` when expiry exists. A PostgreSQL exclusion constraint over an inclusive date range prevents overlapping periods for the same tenant and loan, protecting all writers rather than only the HTTP service.

Add nullable `interest_rate_period_id` to `loan_interest_accruals`. Each newly generated accrual snapshots the period ID, type, and rate as well as its opening principal and interest amount. Existing snapshot columns remain authoritative for historical calculations.

### Migration

For every floating loan with the legacy rate columns populated, create one initial period beginning on `interest_start_date` with no expiry. Migration must be additive and idempotent. Existing accruals are not rewritten and remain valid from their stored type/rate snapshots.

After compatibility reads have been removed in a later release, the legacy `daily_interest_mode` and `daily_interest_rate` loan columns can be retired in a separate migration.

## Replacement Semantics

The write workflow is `preview -> explicit confirmation -> execute`.

Given a proposed inclusive range `[newStart, newEnd]`, where `newEnd` may be open-ended, preview computes the resulting non-overlapping timeline:

- Existing portions before `newStart` are retained and end on the preceding calendar date.
- Existing portions after a bounded `newEnd` are retained and begin on the following calendar date.
- Existing portions fully covered by the new range are superseded.
- The proposed rate occupies the requested range.
- Adjacent periods with identical type and rate are merged to keep the timeline minimal.

Execution rechecks the loan and timeline version inside one transaction so a stale preview cannot overwrite a concurrent change. Superseded period records are preserved in the audit payload; no accrued financial record is edited or deleted.

If any requested date is already materialized in `loan_interest_accruals`, preview returns a blocking conflict identifying the earliest editable date. The operator must select a range beginning on or after that date. Financial corrections for an accrued date continue to use compensating adjustments, not rate-period replacement.

## Calculation Flow

When accruing through a Bangkok business date:

1. Enumerate unmaterialized accrual dates according to the loan's interest start and first-day treatment.
2. Resolve exactly one rate period for each date.
3. Stop with a domain error if no rate applies; never silently fall back to zero or the latest rate.
4. Calculate from that date's opening outstanding principal with `decimal.js` and round the daily interest to two decimal places using the existing half-up rule.
5. Insert an immutable accrual snapshot carrying the resolved period ID, type, rate, principal, and amount.

Dates across a rate boundary are calculated separately rather than applying today's rate to all missing dates. This corrects the current implementation, which derives one interest amount and reuses it for every missing date.

## Service and API Contract

Add loan-scoped operations:

- list the active rate timeline in chronological order
- preview insertion/replacement of a date range
- execute a confirmed preview with an idempotency key

Public contracts use loan and period UUIDs, closed schemas, `YYYY-MM-DD` dates, exact decimal rate strings, and exact two-decimal money strings. Preview returns the before/after timeline, affected periods, current-principal daily-interest examples, warnings, a timeline version, and an expiry time. Execute returns the resulting timeline, audit public ID, and correlation ID.

Loan detail reads include:

- the period applicable today, if one exists
- the exact daily interest at current outstanding principal
- the next scheduled rate change
- the full chronological timeline

Existing generic loan update must not become an unconfirmed path around preview and execute.

## MCP and Plugin Contract

Expose the same application service directly through three MCP tools; MCP must not call the REST API internally:

- `loan.interest-rate.list` is read-only. It accepts a public loan UUID and returns the current period, exact daily interest at current outstanding principal, earliest editable date, next change, and full timeline.
- `loan.interest-rate.preview` accepts a public loan UUID, effective date, optional expiry date, rate type, and exact rate string. It returns the before/after timeline, splits/merges, warnings, `previewPublicId`, `previewHash`, and expiry time. Preview may persist workflow state but does not alter live rate periods.
- `loan.interest-rate.execute` is destructive and idempotent. It accepts `previewPublicId`, `previewHash`, `confirmed: true`, a non-empty reason, and an idempotency key and returns the resulting timeline, audit public ID, and correlation ID.

Agent orchestration is always `list -> preview -> explain exact latest preview -> explicit human confirmation -> execute`. The agent must stop before execute on ambiguity, a missing or mismatched loan UUID, accrued-date conflict, missing coverage, stale/expired preview, changed preview hash, idempotency conflict, or absent explicit confirmation. The agent never calculates daily interest or projected splits itself.

All three tools use closed input/output schemas and expose only safe public UUIDs, `YYYY-MM-DD` dates, exact decimal rate strings, and exact two-decimal money strings. Tool annotations mark list read-only, preview non-read-only/non-destructive because it persists preview workflow state, and execute destructive/idempotent.

Update the private CreditSync plugin from `2.1.0` to `2.2.0`, from 6 to 7 skills, and from 26 to 29 tools. Add `manage-floating-interest-rates`, route the root `creditsync` skill to it, and synchronize the generated MCP contract fixture, plugin manifest/version, README, changelog, validator expectations, error-recovery guidance, financial rules, positive/negative eval scenarios, deterministic eval harness, and plugin tests.

## User Interface

Loan Detail shows a localized Floating Daily Interest card containing:

- today's rate and rate type
- today's calculated interest at current outstanding principal
- the effective range
- the next scheduled change, when present
- an action to manage the timeline

The management dialog displays the timeline and accepts effective date, optional expiry date, type, and rate. Submitting first shows the server-produced before/after preview, including automatic splits and merges. The user must explicitly confirm before execution. Accrued dates are visually locked and the UI explains the earliest editable date.

Thai and English locale keys are updated together. Money uses exact decimal-string formatters and the active i18n language; the frontend never reproduces the accounting calculation.

## Error Handling

Domain errors distinguish invalid dates/rates, missing coverage, accrued-date conflicts, stale previews, idempotency conflicts, inaccessible loans, and database overlap protection. The UI retains entered values after recoverable errors and refreshes the timeline after stale-state conflicts.

No logs or audit summaries include bearer tokens, evidence contents, or other sensitive borrower data.

## Verification

Backend unit and disposable-PostgreSQL tests cover:

- inclusive boundaries and open-ended periods
- automatic left/right splitting and identical-period merging
- replacement across multiple existing periods
- rejection of accrued dates and stale previews
- database-level overlap prevention and tenant isolation
- legacy policy migration
- accrual across rate boundaries with exact Decimal calculations
- immutable snapshot behavior after later timeline changes
- idempotent execution and audit/correlation output
- strict MCP schemas, handler-to-service delegation, annotations, preview-hash confirmation, safe public outputs, and audit correlation

Frontend tests cover localized current-rate presentation, exact daily-interest strings, future-change display, previewed splits, confirmation, accrued-date blocking, and stale refresh. Verification includes backend typecheck and disposable database tests, frontend test/lint/build, and the synchronized plugin tests/validator.

Plugin validation covers the `2.2.0 / 7 skills / 29 tools` frozen contract, routing documentation, positive list/preview/execute orchestration, and negative missing-confirmation, stale-preview, accrued-date, ambiguity, and idempotency-conflict cases.

## Out of Scope

- Recalculating or mutating existing accruals
- Automatically posting compensating financial adjustments
- Changing first-day deduction policy after origination
- Adding rate types other than percent and per-thousand
- Retiring legacy loan columns in the same release
