# Floating Weekly Interest and Intermediated Disbursement Design

## Decision

Generalize floating-loan interest from a daily-only policy into an exact period-based policy. Support rates quoted per day or per week while accruing weekly interest proportionally by Bangkok business day. Add an optional, non-refundable one-period advance-interest charge. Model lender-to-intermediary funding, intermediary-to-borrower payout, and intermediary-to-lender advance-interest return as distinct, evidence-bearing cash movements reconciled under one loan disbursement workflow.

This design keeps `repaymentType: "floating"`. It does not represent weekly floating interest as a fixed weekly installment schedule and does not convert a quoted weekly rate into a persisted daily rate.

## Product Rules

### Floating interest policy

A floating loan has this public origination policy:

```ts
type FloatingInterestPolicy = {
  periodUnit: "day" | "week";
  periodLength: 1;
  rateMode: "percent" | "per_thousand";
  rate: string;
  advanceInterestPeriods: 0 | 1;
  advanceInterestRefundPolicy: "non_refundable";
};
```

- `rate` describes the contractual period and remains exact with at most four decimal places. A 12% weekly agreement remains `periodUnit: "week", rate: "12.0000"`.
- A daily period contains one Bangkok calendar day. A weekly period is a half-open interval `[periodStart, nextPeriodStart)` containing seven consecutive Bangkok calendar dates. For a start of 13 August, the covered dates are 13–19 August and the next period/due boundary is 20 August.
- Interest is simple interest on the applicable opening principal. Due or unpaid interest is never capitalized into principal.
- Interest within a weekly period accrues proportionally by elapsed day but is not payable or overdue before the weekly due date.
- A normal payment preview allocates only payable interest. It does not silently collect the current period's not-yet-due accrued interest.
- A settlement preview includes all unpaid due interest and the current period's exact accrued interest through the settlement date.
- A principal payment affects interest from the following Bangkok business date. It does not rewrite an already materialized accrual.

### Advance interest

`advanceInterestPeriods: 1` charges exactly one full contractual period at activation. For a THB 5,000 weekly floating loan at 12%, the advance interest is THB 600 and the borrower's net payout is THB 4,400.

- The advance charge covers the complete first interest period and is posted as paid at activation.
- No additional interest is collected for dates covered by that paid period.
- The second period starts after the first seven-day period ends.
- The advance charge is non-refundable. Closing or settling the loan before the first period ends does not refund or credit any unused portion.
- Closing during a later period adds the exact accrued interest for elapsed days in that period.
- Origination preview and confirmation must state the contractual principal, advance interest, net borrower payout, covered date range, and non-refundable policy separately.

## Exact Calculation and Rounding

All calculations use `decimal.js`. Public money values are two-decimal strings. The backend is the sole source of accounting calculations.

For a weekly rate, compute cumulative accrued interest at elapsed day `d`, where `d` is 1 through 7:

```text
cumulative(d) = roundHalfUp(openingPrincipal × periodRate × d ÷ 7, 2)
dailyIncrement(d) = cumulative(d) - cumulative(d - 1)
```

For THB 5,000 at 12% per week, cumulative interest is THB 85.71, 171.43, 257.14, 342.86, 428.57, 514.29, and 600.00. The difference method distributes rounding residue without losing the contractual full-period amount.

Each period keeps one opening-principal basis per effective principal segment. If principal changes during a period, materialized dates retain their snapshots and subsequent dates use the new outstanding principal. The calculator reduces exact cumulative segment totals and never derives a persistent daily rate by dividing the quoted rate.

Accrual state is represented explicitly:

- `accruing`: materialized for projection and settlement, but not normally payable
- `due`: the period has reached its due date and the amount is payable
- `paid`: the amount has been fully collected, including advance-paid first-period accruals
- `partially_paid`: a payable accrual has a positive unpaid remainder
- `reversed`: retained immutable source history superseded by a compensating record

The weekly amount becomes due at the next-period boundary after seven elapsed calendar days. It is due, not overdue, on that Bangkok date and becomes overdue on the following Bangkok calendar date if unpaid. The system uses Asia/Bangkok business dates but does not skip weekends or holidays.

## Settlement Semantics

Normal payment allocation remains explicit and uses the existing ordering contract: penalties and fees, oldest payable interest, then principal. The current weekly period's `accruing` amount is visible but excluded from automatic normal-payment allocation.

Settlement preview computes:

```text
outstanding principal
+ unpaid due interest
+ current-period interest accrued through settlement date
+ applicable fees and penalties
= exact settlement amount
```

Examples for THB 5,000 at 12% weekly:

- No advance interest, settlement after three elapsed days: THB 5,257.14.
- One advance period, settlement during the covered first period: THB 5,000 additional payment; the paid THB 600 is not refunded.
- One advance period, settlement after three elapsed days of period two: THB 5,257.14 additional payment.

Settlement uses `preview -> explicit human confirmation -> execute`, locks the loan, rechecks the preview version and balances, and posts append-only financial entries. Posted accruals, payments, advance charges, transfers, and evidence links are immutable. Reversal uses compensating entries with a reason and idempotency key.

## Persistence Model

### Loan policy

Add loan-level policy columns or an equivalent one-to-one policy table:

- `interest_period_unit`: `day` or `week`
- `interest_period_length`: positive integer constrained to `1` in this release
- `advance_interest_periods`: `0` or `1`
- `advance_interest_refund_policy`: `non_refundable`
- `interest_period_anchor_date`: Bangkok `YYYY-MM-DD`, the inclusive start of the first half-open period

Generalize the existing daily mode/rate naming in application code to period mode/rate. Effective-dated `loan_interest_rate_periods` must snapshot `period_unit` and `period_length` alongside rate type and rate. A timeline replacement may change the future rate but must not change an accrued date. Changing the period unit on an active loan is out of scope; it requires a new loan or a later dedicated renewal workflow.

Extend accrual snapshots with the period identifier, period start/end, day index, period unit/length, contractual rate, opening principal, cumulative amount, daily increment, paid amount, and state. Database uniqueness prevents more than one active accrual for a loan and accrual date while preserving reversed rows.

### Compatibility migration

Migrate every existing floating daily-interest loan to:

```ts
{
  periodUnit: "day",
  periodLength: 1,
  advanceInterestPeriods: firstDayTreatment === "deduct" ? 1 : 0,
  advanceInterestRefundPolicy: "non_refundable"
}
```

Preserve legacy daily columns for one compatibility cycle and keep existing accrual snapshots authoritative. New writes target the generalized policy. Compatibility reads must be observable and removable in a later migration; legacy columns are not removed in this feature.

## Intermediary Profiles and Loan Assignments

An intermediary is a first-class entity distinct from a borrower. Its profile includes canonical name, confirmed aliases, optional phone and notes, reusable bank accounts, active status, and append-only audit history.

Relate intermediaries to loans through effective-dated assignments:

```ts
type LoanIntermediaryAssignment = {
  loanPublicId: string;
  intermediaryPublicId: string;
  role: "disbursement" | "collection" | "both";
  effectiveFrom: string;
  effectiveTo: string | null;
  status: "active" | "ended";
};
```

Assignments preserve history when responsibility changes. One intermediary may manage many loans, and one loan may have different intermediaries over time. A cash movement must resolve an active assignment with the required role on its event date.

The intermediary UI has dedicated list and detail routes. Detail shows active managed loans, historical assignments, total lender funding received, borrower payouts, advance-interest returns, collections held, remittances posted, current balance held, unreconciled groups, and every associated transfer and evidence item. Filters include borrower/loan, date, amount, transfer role, status, and bank reference.

## Intermediated Disbursement and Transfer Groups

Represent the three economic legs independently under one reconciliation group:

1. `funding_to_intermediary`: lender sends contractual funding to the intermediary.
2. `borrower_net_payout`: intermediary sends net cash to the borrower.
3. `advance_interest_return`: intermediary returns the withheld advance interest to the lender.

For the example:

```text
lender funding received by intermediary                 5,000.00
- borrower net payout                                   4,400.00
- advance interest returned to lender                     600.00
- explicitly retained intermediary balance                  0.00
= reconciliation variance                                   0.00
```

The group stores expected contractual principal, expected borrower net payout, expected advance-interest return, and expected retained balance. A transfer role is a logical target that may contain multiple immutable transfer events. For example, a THB 4,400 borrower payout may have events of THB 2,000 and THB 2,400 with separately viewable slips.

Each event stores public UUID, tenant, group and role, exact amount, sender/payee hints, channel, transfer timestamp, bank reference, status, idempotency key, and audit context. Posted events cannot be edited or deleted. Group preview calculates exact totals and variance from posted/ready events. A normal post requires zero variance. A non-zero retained balance must be an explicit group target, not an unexplained variance.

Posting a balanced group atomically:

- establishes the actual borrower payout without changing approved principal;
- posts the advance interest as paid exactly once;
- reconciles the intermediary's held balance;
- preserves all three cash legs without counting lender funding, borrower payout, or returned interest twice;
- returns audit public IDs and one correlation ID.

Existing intermediary collection/remittance ledgers remain the source of truth for borrower payments held by an intermediary. Disbursement groups must not create borrower repayment transactions. Shared intermediary balance reporting combines the two workflows through ledger projections, not duplicated rows.

## Evidence Model and Retrieval

Every transfer event supports one or more evidence items. Each uploaded slip remains independently viewable from the loan, transfer group, transfer event, and intermediary profile.

Evidence uses `prepare -> direct signed PUT -> finalize`:

- Prepare accepts MIME, size, SHA-256, original name, transfer-event public UUID, and tenant context.
- Finalize checks expiry, ownership, MIME, size, SHA-256, object metadata, and duplicate provenance.
- Retrieval returns a tenant-authorized, short-lived access descriptor or signed URL on demand. Signed URLs and evidence contents are never logged or included in audit payloads.
- Finalized evidence links on posted or reversed events are immutable.
- Duplicate hashes or bank references produce a warning or blocking `needs_review` result according to exact event identity; they never silently reuse evidence across events.

The UI provides a `View slip` action for every evidence item, using the existing evidence preview component for images and PDFs. It displays amount, sender/payee, timestamp, bank reference, event role, status, uploader, and audit/correlation identifiers beside the evidence.

## Application Services

Keep calculation and orchestration boundaries independently testable:

- `floating-interest-policy`: normalize and validate exact policies.
- `floating-interest-calculator`: calculate period boundaries, cumulative interest, increments, and full-period values.
- `floating-interest-accrual-service`: materialize idempotent snapshots and promote weekly periods to due.
- `loan-settlement-service`: preview and execute exact close-out amounts including not-yet-due accrued interest.
- `intermediary-service`: manage profiles, aliases, bank accounts, and assignments.
- `intermediated-disbursement-service`: create groups/events, reconcile roles, preview, post, and reverse.
- `transfer-evidence-service`: prepare, finalize, and authorize evidence retrieval.

REST, Web, and MCP call the same application services. No frontend or agent recreates accounting calculations.

## REST, MCP, and Plugin Contracts

Replace public `floatingDailyInterest` with `floatingInterestPolicy` in preview/draft/update contracts while retaining a temporary compatibility response only where required for deployed clients. Closed schemas use public UUIDs, exact decimal strings, and Bangkok dates.

Loan preview returns at least:

```ts
{
  fullPeriodInterest: "600.00",
  advanceInterest: "600.00",
  netBorrowerPayout: "4400.00",
  firstPeriodStartDate: "2026-08-13",
  firstPeriodDueDate: "2026-08-20",
  nextAccrualDate: "2026-08-20",
  periodDays: 7,
  advanceInterestRefundPolicy: "non_refundable"
}
```

Date semantics are explicit: `firstPeriodStartDate` is included, `firstPeriodDueDate` is the excluded end and next-period start, and the seven covered dates are returned when useful. The calculation must not depend on an ambiguous inclusive/exclusive interpretation.

Add MCP operations for intermediary profile/assignment reads and writes, disbursement group creation/get/list, transfer-event creation, event evidence prepare/finalize, preview, confirmed post, and reasoned reversal. Frozen MCP contract, plugin version/manifest, skills, validator, fixtures, and positive/negative evals change together.

Agent orchestration is inspect-first:

```text
search borrower and intermediary
-> inspect active loan assignments
-> loan preview
-> create loan draft
-> inspect and explicitly confirm activation
-> create expected transfer group and individual events
-> prepare/upload/finalize every supplied slip
-> inspect each event, evidence, totals, and variance
-> show exact group to the human
-> explicitly confirm
-> post atomically
```

The agent stops on ambiguous identities, inactive assignment, missing supplied evidence, duplicate reference/hash, amount or payee mismatch, non-zero unexplained variance, stale preview, expired upload, idempotency conflict, or missing explicit confirmation.

## Web UI

### Loan Wizard and Loan Detail

For floating loans, the wizard provides period (`daily` or `weekly`), rate mode, exact rate, and advance-interest option (`none` or `one non-refundable period`). Server preview shows contractual principal, full-period interest, daily accrual examples, first due date, advance charge, net payout, and non-refundable warning.

Loan Detail shows the contractual quoted rate, current period range and elapsed days, accruing/not-yet-due interest, due/overdue interest, paid advance interest, next due date, settlement preview action, intermediary assignments, and a `Money paths and slips` section. Rate-timeline UI labels the period unit and does not call a weekly rate a daily rate.

### Intermediary workspace

Add a top-level Intermediaries workspace with profile search/list/create/edit and detail views. The detail view contains overview metrics, managed loans, money paths and slips, borrower collections, remittances, and audit history. Mobile uses flat divider rows; desktop may use tables where they improve comparison. Thai and English copy are updated together, and exact money/date formatters use the active language.

## Errors and Safety Gates

Domain errors distinguish unsupported policies, invalid precision, period-boundary errors, missing rate coverage, immutable accrued dates, stale settlement/rate/group previews, inactive assignments, evidence mismatch/expiry/duplicate, unbalanced groups, and idempotency conflicts.

All financial writes require command context, request/correlation ID, actor/source, idempotency key, and append-only audit history. Database constraints enforce tenant-safe foreign keys, supported enum-like values, non-negative exact amounts, event/reference uniqueness where appropriate, active-accrual uniqueness, immutable posted rows, and one successful post per idempotency key. Raw identity values, signed URLs, QR payloads, tokens, and evidence content are excluded from logs and audit summaries.

## Verification

Backend unit and disposable-PostgreSQL tests cover:

- THB 5,000 at 12% weekly reaches exactly THB 600.00 after seven days;
- cumulative amounts and increments distribute rounding exactly;
- days one through six accrue without becoming payable or overdue;
- the next-period boundary after seven elapsed dates is due and the following Bangkok date is overdue;
- settlement after three days is THB 5,257.14 without advance interest;
- one advance period produces THB 600 paid interest and THB 4,400 net payout;
- settlement during the covered period does not refund advance interest;
- settlement on day three of period two adds THB 257.14;
- principal changes affect only subsequent dates;
- rate changes preserve immutable accrual snapshots and quoted period units;
- legacy daily policies migrate without changing financial results;
- intermediary assignment history and tenant isolation;
- exact reconciliation of `5000 = 4400 + 600 + 0`;
- split borrower payouts of THB 2,000 and THB 2,400, each with retrievable evidence;
- multiple evidence items on one transfer event;
- duplicate, missing, expired, mismatched, under-, and over-funded groups stop safely;
- concurrent/idempotent post behavior and append-only reversal;
- no double-post between disbursement and existing collection/remittance ledgers.

Frontend tests cover localized wizard preview, exact weekly/accruing/due/overdue states, non-refundable warnings, settlement composition, intermediary profile and managed-loan navigation, split-event reconciliation, and viewable evidence for every event. Verification includes backend typecheck and serialized disposable database suites, frontend tests/lint/build, and synchronized plugin tests, validator, and eval harness.

## Rollout

Use additive migrations and compatibility reads. Backfill daily policies, verify policy/accrual counts and exact sampled projections, then enable weekly origination behind an application feature gate if operational rollout requires it. Do not rewrite historical accruals. Production verification inspects expected columns/constraints, migration logs, MCP health inside the backend container, public frontend health, and read-only reconciliation projections without creating live financial records.

## Out of Scope

- Period units other than day and week
- Period lengths other than one
- Refundable or prorated advance-interest refunds
- Compound interest
- Changing the period unit of an active loan
- Automatically accepting unexplained intermediary balances or transfer variance
- Deleting posted transfers, accruals, payments, or evidence
- Replacing the existing borrower collection/remittance workflow
