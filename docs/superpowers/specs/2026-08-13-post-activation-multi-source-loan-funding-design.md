# Post-activation Multi-source Loan Funding Design

## Purpose

Allow an operator or CreditSync agent to attribute an existing loan's principal to one or more funding sources after the loan has been activated. Funding attribution is an append-only accounting relationship and must remain independently adjustable without changing immutable loan terms, schedules, payments, or actual disbursement records.

The feature must make a funding source page answer which loans used that source and by how much. It must also support incomplete historical data: an active loan may temporarily be unfunded or partially funded while its source information is entered later.

## Existing System

CreditSync already stores multi-source attribution in `loan_funding_allocations`. Positive and negative rows are aggregated into the net funding state. Existing REST routes can list allocations, report the allocation gap, add allocations, and reallocate between drawdowns. Fund detail and loan detail already consume parts of this model.

The missing capability is a complete, consistent workflow across Web and MCP for adding or correcting funding after activation. In particular, the frozen MCP contract cannot currently create a funding allocation, so an agent can attach a source to a disbursement event but cannot create the accounting allocation that funding-source reporting uses.

## Domain Model

`loan_funding_allocations` remains the source of truth. The implementation must not rewrite `loans.fundingBankProfileId` or mutate activated loan terms.

Each allocation records:

- tenant and loan;
- funding profile and optional bank drawdown;
- signed two-decimal allocation amount;
- business date and allocation type;
- adjustment group and, when applicable, the source allocation being compensated;
- reason or note;
- actor, request/correlation context, and idempotency context;
- immutable creation metadata.

A positive row adds attributed principal. A correction appends compensating negative and/or positive rows. Existing rows are never updated or deleted.

One loan may use multiple profiles or drawdowns. For every committed transaction:

- net allocation across all sources must not exceed original principal;
- net allocation for any individual source must not become negative;
- an allocation may leave the loan unfunded or partially funded;
- full funding means net allocation equals original principal exactly;
- allocation never changes approved principal, interest, schedule, outstanding balances, payments, or disbursement history.

Funding changes are allowed for draft, active, paid, and defaulted loans. Canceled loans and loans superseded by renewal are locked against new attribution. Existing renewal carry-forward and settlement behavior must continue to consume the allocation ledger.

## Append-only Correction Semantics

A correction must reference the allocation it compensates and include an explicit reason. Reducing TTB by THB 2,000 and adding THB 2,000 of own capital is one atomic operation containing a negative TTB row and a positive own-capital row under a shared group ID.

Direct corrections within one profile may append only the necessary compensation row. Reallocations across profiles or drawdowns append balanced out/in rows. A correction is rejected if it exceeds the active net amount available from its source, would overfund the loan, or would violate a drawdown's available balance.

Database protection must reject update and delete operations on allocation rows. Reversal linkage and idempotency uniqueness must prevent the same source allocation or command from being compensated twice unintentionally.

## Web Experience

Loan Detail shows an exact funding state:

- unfunded;
- partially funded, including the remaining gap;
- fully funded;
- overfunded only as a visible legacy/invariant warning, never as a newly permitted result.

An operator with tenant-wide financial access can select **Add funding source**, choose an active profile or eligible drawdown, enter an exact amount, business date, and optional note, preview the resulting state, and confirm it. The operator may repeat this until the loan is fully funded.

Each allocation history entry offers an **Adjust** action when the loan remains eligible. Adjustment requires a reason and presents the compensating entries before confirmation. The UI never edits or removes the original row.

Fund Detail groups net allocations by loan and shows borrower, loan status, allocated principal from this source, collected interest attribution, and a link to Loan Detail. Multiple ledger rows for the same source and loan collapse into the correct net amount while their history remains inspectable.

All new copy is added to Thai and English locale files together. Dates, numbers, and money use the active i18n language and exact decimal-string formatters.

## REST and Application Services

Funding logic moves behind a tenant-scoped application service shared by REST and MCP. Neither MCP nor another internal consumer calls the REST API.

The service exposes operations equivalent to:

- inspect a loan's allocation ledger and exact current state;
- preview adding allocation or atomically reallocating/adjusting sources;
- execute a confirmed preview idempotently.

REST routes use the shared service and retain public UUIDs and decimal strings. Existing direct-create routes may be preserved for compatibility but must enforce the same locks, append-only rules, audit context, and idempotency guarantees. Web confirmation uses preview then execute rather than a blind write.

## MCP Contract and Agent Workflow

Add three closed-schema tools:

1. `loan.funding.list` — read-only inspection of allocation history, per-source net amounts, original principal, net allocated principal, remaining gap, and state.
2. `loan.funding.preview` — read-only preview for an allocation addition or correction/reallocation. It returns exact proposed ledger entries, before/after funding state, warnings, a preview public ID, and expiry.
3. `loan.funding.execute` — destructive, explicitly confirmed execution using the preview public ID and an idempotency key.

Every write returns audit public IDs and a correlation ID. Schemas expose only public UUIDs and two-decimal money strings.

The agent workflow is inspect, preview, present exact before/after allocations and gap, obtain explicit human confirmation, then execute. Execution stops for ambiguity, stale or expired preview, changed allocation state, inactive source, cross-tenant reference, insufficient source balance, negative source net, principal over-allocation, locked loan, or idempotency conflict.

The frozen MCP contract, private plugin manifest/version, funding skill, eval scenarios, and validator fixtures must be updated together.

## Concurrency, Idempotency, and Audit

Preview records contain a canonical request hash, the relevant loan/allocation state version or snapshot hash, expiry, actor context, and proposed entries. Execute validates that the preview belongs to the caller's tenant, is confirmed, has not expired, and still matches current state.

Execute runs in one database transaction. It locks the loan and all referenced funding sources/drawdowns in stable ID order, recomputes principal capacity and per-source nets using `decimal.js`, inserts the ledger entries, and writes append-only audit records.

An idempotency key reused with the same canonical request returns the original result. Reuse with a different request fails with a conflict. Audit payloads include useful before/after allocation state, public references, reason, actor source, request ID, correlation ID, and idempotency key without exposing private database IDs or credentials.

## Error Handling

REST, Web, and MCP map domain failures consistently for:

- total allocation exceeding principal;
- adjustment exceeding the source's active net allocation;
- missing, inactive, inaccessible, or cross-tenant funding source;
- insufficient drawdown capacity;
- canceled or renewal-superseded loan;
- expired or stale preview;
- already-compensated allocation;
- idempotency payload conflict;
- concurrent state change.

No failure may partially insert a multi-entry correction.

## Migration and Compatibility

The migration adds only the constraints and preview/idempotency/audit structures needed for safe append-only execution. It does not guess or backfill funding sources for historical loans. Existing loans with no allocations appear as unfunded until an operator records their real source.

Legacy `loans.bankLoanId` and `loans.fundingBankProfileId` remain readable for compatibility but are not updated after activation and are not the canonical multi-source model. Reporting and new workflows use net `loan_funding_allocations`.

After deployment, the already-posted TTB disbursement for the “แม่พี่เกมส์” loan can be followed by one separate TTB allocation of THB 10,000 dated 2026-07-31. This creates no duplicate disbursement and changes no loan term.

## Verification

Test-driven implementation covers:

- one and multiple funding profiles on draft and active loans;
- unfunded, partial, and fully funded states;
- paid/defaulted eligibility and canceled/superseded locks;
- atomic compensating adjustments and reallocations;
- rejection of negative per-source nets and total over-allocation;
- drawdown capacity and tenant isolation;
- database-level update/delete immutability;
- concurrent writers against the same loan/source;
- preview expiry and stale-state detection;
- matching and conflicting idempotency retries;
- complete audit and correlation context;
- REST and MCP closed-schema contracts;
- localized Loan Detail management and Fund Detail aggregation;
- plugin contract, skill, validator, and eval synchronization.

Before completion, run the disposable PostgreSQL backend suite serially, backend typecheck, frontend tests/lint/build, and applicable plugin tests and validator. A skipped database test is not sufficient for the new financial invariants.

## Out of Scope

- Inferring allocation automatically from a slip, account number, or disbursement source.
- Mutating posted disbursement events to make funding allocation match.
- Recalculating loan terms, schedules, payments, or historical profitability.
- Automatically filling funding for historical loans without explicit operator confirmation.
