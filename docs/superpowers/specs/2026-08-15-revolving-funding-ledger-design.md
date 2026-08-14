# Revolving Funding Ledger Design

## Goal

Add an exact, auditable funding ledger for revolving external liabilities such as an SCB UP2ME credit card and SCB Speedy Cash. Operators and MCP agents must be able to capture drawdowns, provider charges, repayments, corrections, and borrower-loan funding allocations without forcing revolving products into the existing fixed-installment bank-loan schedule.

The first concrete use case is an SCB UP2ME credit-card cash advance whose provider terms are 16% annual interest, a one-time 3% cash-advance fee, 7% VAT on that fee only, and manually entered debt-collection charges of either 50.00 plus 3.50 VAT or 100.00 plus 7.00 VAT. Provider evidence is optional; Web and MCP manual entry are authoritative only after explicit posting.

## Scope

### Included

- Revolving funding accounts under existing tenant-scoped bank profiles.
- Separate product policies for `credit_card` and `revolving_personal_loan`.
- Draft, preview, explicit confirmation, posting, read, adjustment, and compensating reversal workflows.
- Drawdowns, provider charge events, provider repayments, and append-only loan funding allocations.
- Exact estimated-interest previews that never become accounting facts automatically.
- Manual Web workflows and a focused first MCP contract for drawdowns, charges, allocations, and balances.
- Optional evidence through the existing signed prepare, direct PUT, finalize pattern.
- Additive migration and controlled dry-run conversion of the existing SCB UP2ME profile.

### Deferred

- Automated bank-statement ingestion or reconciliation.
- Automated provider-repayment posting through MCP.
- Automatic debt-collection-fee generation from overdue state.
- Purchase transaction tracking and rewards accounting beyond the extensible transaction-type enum.
- A generic double-entry accounting platform for unrelated liabilities.

## Existing-System Constraints

The current `bank_loans` model represents amortizing or scheduled liabilities. `generateBankLoanSchedule` combines processing and utilization fees into one fixed amount, repeats that amount on every generated installment, and computes VAT over interest plus fees. Those rules cannot represent a one-time credit-card cash-advance fee whose VAT base is fee-only. Although `minimum_due` exists as a repayment-mode label, it does not change the fixed schedule calculation into a statement-cycle revolving balance.

Existing `bank_loans`, `bank_loan_schedules`, repayments, allocation summaries, and capital-pool behavior remain compatible and unchanged. Revolving products use additive tables and application services. An active borrower loan is funded through an append-only allocation event rather than by mutating its locked terms.

## Architecture

An existing `bank_profile` owns one or more revolving accounts. A revolving account defines provider/product policy but does not itself assert a cash balance. Posted ledger events establish balances:

```text
Bank Profile
└── Revolving Account
    ├── Drawdown events
    ├── Provider charge events
    ├── Provider repayment events
    ├── Compensating reversal/adjustment events
    └── Loan funding allocation events
```

Web, REST, and MCP adapters call the same application-service boundary. Adapters do not reproduce calculations, infer a provider charge, or mutate accounting rows directly.

## Data Model

### `funding_revolving_accounts`

Each row is tenant-scoped and belongs to a `bank_profile`.

- Public UUID and tenant-safe foreign keys.
- `productType`: `credit_card` or `revolving_personal_loan`.
- `annualInterestRate`: exact percentage string with up to four decimal places.
- `interestAccrual`: initially `daily`.
- `creditLimit`: exact non-negative money.
- Optional `statementDay` and `paymentDueDay` for forecasts.
- Optional versioned `minimumPaymentPolicy` used only for previews.
- `status`: `active` or `closed`.
- Audit timestamps and actor provenance.

Product-policy defaults are explicit templates, not hidden behavior. SCB UP2ME Credit Card defaults to 16% annual interest, fee-only VAT, and no interest-free period for cash advances. SCB Speedy Cash defaults to no cash-advance fee and stores the customer-specific annual rate, which may be as high as 25%. Operators can review policy values before account creation.

### `funding_drawdown_events`

- Account and optional provider reference.
- `transactionType`: `cash_advance`, `transfer`, `purchase`, or `adjustment`.
- Exact `amount`, effective timestamp, Bangkok business date, and optional note.
- Lifecycle: `draft`, `posted`, or `reversed`.
- Command context, actor/source, correlation ID, idempotency key, and audit link.
- Optional evidence links that become usable only after storage finalization.
- Reversal provenance linking the immutable original and compensating event.

A drawdown is the upstream liability principal. It is separate from borrower cash disbursement and from the allocation of funding to a borrower loan.

### `funding_charge_events`

- Account and optional drawdown parent.
- `chargeType`: `interest`, `cash_advance_fee`, `fee_vat`, `collection_fee`, `collection_fee_vat`, `late_fee`, `penalty`, or `manual_adjustment`.
- Exact amount, effective date, note, source, and optional parent-charge link.
- Lifecycle, idempotency, audit, and reversal fields matching drawdowns.
- Optional calculation snapshot containing normalized inputs and result strings for human inspection; the posted amount remains the authoritative fact.

VAT events require a compatible parent fee in the same tenant/account. A VAT event records its own exact amount and does not apply a global VAT rate to interest or unrelated charges.

### `funding_repayment_events` and components

A repayment event records exact cash paid to the provider. Its immutable components allocate the amount among principal, interest, fee, VAT, and penalty balances. Web posting is included in the first delivery; MCP repayment writes are deferred while repayment-read projections remain available.

The preview may recommend provider-policy ordering, but posting persists the explicit confirmed components. Component totals must equal the repayment amount exactly.

### `funding_allocation_events`

Allocation events associate posted drawdown principal with borrower loans without editing active loan terms. They support one drawdown funding multiple loans and one loan using multiple sources. Each posted allocation is immutable, idempotent, audited, and reversible only through a compensating allocation. Aggregate active allocations may not exceed the drawdown's posted principal net of principal reversals.

## Balance Rules

Only posted, non-reversed net event effects contribute to accounting balances. Drafts and forecasts are displayed separately.

```text
principal outstanding
= posted drawdowns
- posted principal repayment components
± posted principal adjustments and reversals

interest outstanding
= posted interest charges
- posted interest repayment components
± posted interest adjustments and reversals

fees outstanding
= posted fees, VAT, and penalties
- their posted repayment components
± posted fee/VAT/penalty adjustments and reversals
```

Every calculation uses the shared high-precision `decimal.js` context. Public money crosses REST and MCP as two-decimal strings and is never converted through JavaScript `Number`.

## Calculation and Preview Rules

For an SCB UP2ME credit-card cash advance of 47,000.00:

- Cash-advance fee preview: `47000.00 × 3.0000% = 1410.00`.
- Fee VAT preview: `1410.00 × 7.0000% = 98.70`.
- Estimated interest for a date range: outstanding principal segments × `16.0000%` × covered days ÷ the actual 365- or 366-day year.
- There is no cash-advance grace period.

The preview shows formulas, dates, rate basis, VAT base, and before/after balances. Estimated interest is informational until an operator or MCP agent enters and explicitly posts the provider charge. Statement evidence is optional.

Debt-collection fees are never inferred. An operator enters either 50.00 with a separate 3.50 VAT event or 100.00 with a separate 7.00 VAT event when the provider actually charges it. The UI may offer these as reviewed presets and must disclose that the applicable SCB rule requires overdue debt above 1,000.00 and a collection cycle of at least one month; the preset does not prove eligibility.

## Lifecycle and Mutation Rules

All financial entry types follow:

```text
create draft → inspect/update → preview → explicit confirmation → post
```

- Draft financial entries are editable and may be abandoned.
- Post rechecks account status, capacity, exact balance version, dependencies, and preview hash/expiry under deterministic locks.
- Posted entries and their components cannot be updated or deleted at the database boundary.
- Corrections use an explicit compensating reversal or adjustment with a reason.
- Reversal selects one exact posted event, locks downstream dependencies, and refuses unsafe reversal rather than rewriting history.
- Every financial write carries command context, correlation ID, actor/source, and idempotency key.

## REST and Web Design

The Funding Profile workspace gains separate tabs or sections for amortizing drawdowns and revolving accounts. Revolving-account detail presents:

- Exact principal, interest, fees, VAT, penalties, available credit, and allocated/unallocated principal.
- Draft values clearly separated from posted balances.
- Filterable event ledgers with event type, effective date, status, note, and audit identifiers.
- Drawdown creation with fee/VAT preview presets.
- Manual provider-charge entry, including reviewed debt-collection presets.
- Manual repayment entry with explicit component preview.
- Allocation preview and confirmation for existing borrower loans.
- Reasoned reversal/adjustment actions and optional evidence upload.

All user-facing strings are added to English and Thai locales together. Exact values use the active i18n locale for presentation while requests retain decimal strings.

## MCP Design

The first MCP delivery exposes a closed-schema subset:

- `funding.revolving.list`
- `funding.revolving.get`
- `funding.drawdown.create`
- `funding.drawdown.update`
- `funding.drawdown.preview`
- `funding.drawdown.post`
- `funding.drawdown.reverse`
- `funding.charge.create`
- `funding.charge.update`
- `funding.charge.preview`
- `funding.charge.post`
- `funding.charge.reverse`
- `funding.allocation.preview`
- `funding.allocation.post`

Reads carry `readOnlyHint`; post, reversal, and allocation writes are destructive. Writes return safe structured content plus a readable summary, audit public UUIDs, and correlation ID. MCP must inspect before writing, use explicit confirmation for posting, stop on ambiguity, duplicate/provider-reference conflict, stale preview, insufficient capacity, or idempotency conflict, and never expose full card numbers, bearer tokens, signed URLs, or private evidence contents.

The frozen MCP contract, plugin manifest/version, CreditSync skills, validator, and eval scenarios change atomically. Provider repayment MCP writes are a later phase; Web manual repayments and read projections ship in the first phase.

## Error Handling and Concurrency

- Reject negative, malformed, special numeric, or out-of-public-bound values.
- Reject a VAT event without a compatible parent fee.
- Reject allocation beyond posted drawdown capacity.
- Require account, drawdown, loan, and event tenant ownership at every boundary.
- Lock account, drawdown, allocation, and affected loan rows in a documented deterministic order.
- Bind a short-lived preview to normalized inputs, relevant event versions, balances, and dependency IDs.
- Recompute inside the posting transaction; stale previews return a stable conflict requiring re-review.
- Idempotent replay returns the original result; reuse for different normalized inputs returns a conflict.
- Reversals retain originals and create explicit compensating provenance.

## Migration and Existing Data

The migration is additive. It creates revolving-account and event tables, tenant-safe composite foreign keys, exact-money and lifecycle checks, active uniqueness constraints, idempotency indexes, and database triggers preventing update/delete of posted facts.

No existing `bank_loans`, schedules, repayments, funding allocations, or borrower-loan rows are rewritten or backfilled automatically. A controlled script:

1. Resolves the exact SCB UP2ME bank-profile public UUID.
2. Previews creation of one `credit_card` revolving account with reviewed policy values.
3. Reports conflicts and performs zero writes by default.
4. Requires an explicit apply flag and command context to create the account idempotently.

Creating the real 47,000.00 drawdown, its fees, or an allocation to loan `01a00031-2aeb-76ab-bf81-3a7d967d3d8c` is an operator financial workflow after deployment, not migration behavior. Production migration verification must not create test financial records.

## Verification

### Unit and schema tests

- Exact 47,000.00 → 1,410.00 fee → 98.70 VAT preview.
- Exact 50.00 → 3.50 and 100.00 → 7.00 collection-fee VAT presets.
- Leap-year and non-leap-year daily interest segments without `Number`.
- Event state, amount, parent, tenant, idempotency, and immutability constraints.
- Existing amortizing bank-loan schedule behavior remains unchanged.

### Database-backed integration tests

- Draft update, preview, post, idempotent replay, conflict, adjustment, and reversal.
- Optional-evidence and no-evidence posting.
- Exact repayment-component conservation.
- Capacity enforcement and concurrent allocation/posting races.
- Tenant isolation, permission checks, stale previews, and blocked downstream reversal.
- Active borrower-loan allocation without changing immutable loan terms.

### REST, MCP, and frontend tests

- Closed request schemas, public UUIDs, decimal-string money, audit/correlation results, hints, and redaction.
- Contract snapshot, plugin validator, and safe orchestration evals for inspect-before-write and confirmation stops.
- Localized Thai/English workflows, exact large-value rendering, draft/posted separation, retry states, and accessible confirmation dialogs.

### Required gates

- Backend disposable PostgreSQL suite and typecheck.
- Frontend tests, lint, and production build.
- Plugin tests and validator.
- Migration clean-install and upgrade-path tests.
- Production read-only checks of expected tables, columns, triggers, and successful migration logs after authorized deployment.

## Rollout

1. Ship additive schema, services, REST reads/writes, and manual Web workflows behind the existing tenant-admin funding permissions.
2. Ship the synchronized focused MCP contract and plugin update.
3. Run the SCB UP2ME revolving-account conversion script in dry-run mode and obtain explicit operator approval before apply.
4. Enter real drawdowns, charges, repayments, and allocations through preview/confirmation workflows only.
5. Consider automated statement reconciliation and MCP repayment writes as separately designed follow-up work.

## Acceptance Criteria

- CreditSync represents UP2ME cash-advance principal, one-time 3% fee, fee-only 7% VAT, daily 16% interest charges, and manual collection fees without duplicating fees across installments or taxing interest.
- Speedy Cash can use a distinct revolving account with its contractual annual rate and no default cash-advance fee.
- Manual Web and MCP entry require no evidence but retain full command and audit provenance.
- Drafts remain editable; posted financial facts remain immutable and corrections are compensating.
- Existing scheduled funding, active borrower loans, and user changes remain intact.
- The existing active borrower loan can be funded through an append-only allocation without changing its locked terms.
