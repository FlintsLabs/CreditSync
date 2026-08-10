# Intermediary Collection and Remittance Design

## Goal

Record the complete two-leg path when a borrower pays an intermediary and the intermediary later remits one grouped amount to the lender. A borrower payment is not posted to the loan until both legs are matched and explicitly approved, except for a separately authorized manual approval with a required reason.

The workflow is manual-first and AI-assisted. Every operation must remain available in the Web UI without AI. MCP agents may extract data, search, and propose allocations, but they must not silently select ambiguous items or post a remittance without explicit human confirmation.

## Current behavior and gap

CreditSync payment intakes represent money received by the lender. They can already allocate one received amount across several borrowers and loans, but they do not represent money that a borrower has paid to an intermediary while the lender is still waiting for remittance.

Posting each borrower slip immediately would reduce the borrower obligation before the lender receives the money. Posting the intermediary's later grouped transfer as another payment would then pay the same obligations twice. Notes alone cannot enforce balance, prevent duplicate settlement, or provide a reliable intermediary position. The feature therefore requires separate collection and remittance ledgers linked to the existing immutable payment transaction workflow.

## Domain model

### Intermediary

An intermediary is a tenant-scoped counterparty, separate from a borrower and from an application user. It has a public UUID, canonical display name, optional confirmed aliases and notes, active/inactive status, and append-only audit history. Account identifiers are optional sensitive metadata and must be masked on reads and excluded from logs.

### Intermediary collection

An intermediary collection records one amount that a borrower paid to an intermediary. It contains:

- tenant, owner, intermediary, borrower, and loan public identities;
- exact two-decimal amount;
- borrower-paid timestamp in the `Asia/Bangkok` business timezone;
- optional bank reference, note, and finalized evidence files;
- command context, idempotency key, actor/source, request ID, and correlation ID;
- optional settlement remittance and posted payment-transaction linkage; and
- lifecycle state.

Collection states are:

- `pending_remittance`: captured and awaiting the intermediary's transfer;
- `allocated`: reserved by one editable remittance draft;
- `settled`: included in a posted remittance and posted to the borrower loan;
- `manual_approved`: posted without a remittance through the exceptional approval flow;
- `reversed`: compensated without deleting the original history.

A collection in `pending_remittance` or `allocated` does not change loan balances, interest, schedules, cash, or funding ledgers. Only `settled` or `manual_approved` has a corresponding posted borrower payment.

After a remittance-backed settlement posts, the collection's borrower-paid timestamp is the effective payment date used for the loan, interest, and overdue position. The remittance received timestamp and the later system posting timestamp remain separate facts in the cash and audit records. CreditSync must not substitute either of those later timestamps for the borrower-paid timestamp, and it must not apply the effective payment before the settlement actually posts.

### Intermediary remittance

An intermediary remittance records one grouped transfer from an intermediary to the lender. It contains:

- intermediary, tenant, owner, and public UUID;
- exact gross amount received by the lender;
- received timestamp, optional destination account/profile, bank reference, note, and evidence;
- a versioned list of explicitly selected collections;
- exact selected total and remaining balance;
- versioned preview identity, expiry, and state hash; and
- command/audit context and lifecycle timestamps.

Remittance states are `draft`, `needs_review`, `ready`, `posted`, and `reversed`. The remaining balance is always computed by the backend with `decimal.js` as gross remittance amount minus the selected collection amounts. It is never stored or calculated with JavaScript floating point.

## Manual-first workflows

### Capture a borrower-to-intermediary collection

The operator can create a collection without AI by selecting an intermediary, borrower, and loan, then entering amount, paid date/time, bank reference, note, and optional evidence. Saving creates `pending_remittance`; it does not create a borrower transaction.

The form supports exact manual entry even when there is no slip. When a slip is supplied, prepare, direct signed PUT, and finalize remain separate steps. A failed or expired upload shows an actionable status and permits a fresh upload intent without pretending that the evidence is ready.

### Create and allocate a grouped remittance

The operator opens **Intermediary money → New remittance**, selects the intermediary, and enters the grouped amount, received date/time, reference, destination, note, and optional slip. The grouped amount is the starting balance.

The draft then displays only eligible `pending_remittance` collections for that intermediary. Operators can search and filter by borrower, loan, bank reference, amount, date range, status, and evidence presence. Selecting a collection reserves it for the draft and subtracts its exact amount from the remaining balance; deselecting it releases the reservation and restores the balance. Draft selections persist so work can resume later.

The UI continuously displays:

```text
gross remittance amount - selected collection total = remaining balance
```

Selection is never automatic. A preview with a non-zero balance returns `needs_review` and the exact shortfall or over-allocation. A zero balance may become `ready` after the backend revalidates every selected collection. Posting requires the latest ready preview and explicit human confirmation.

### Manual approval exception

An authorized operator may manually approve a collection before any remittance exists. This is a destructive exception, not a shortcut in the normal flow. It requires a non-blank reason, idempotency key, explicit confirmation, elevated tenant permission, and an audit entry that visibly distinguishes the resulting transaction from a remittance-backed settlement.

Manual approval posts the borrower payment exactly once and changes the collection to `manual_approved`. A later remittance must not be able to select it. If money later arrives for that item, the operator must resolve it as an unmatched intermediary amount or reverse the exception before normal settlement.

## Posting and accounting

Remittance preview records the exact collection public UUIDs, amounts, borrower/loan targets, calculated components, selected total, remaining balance, expiry, and a hash of relevant current state. Preview does not mutate the loan.

Remittance post executes atomically and in a stable lock order:

1. lock the remittance and selected collection rows;
2. verify the latest preview is unexpired and its state hash is current;
3. verify every collection belongs to the same tenant and intermediary and is still reserved by this remittance;
4. recompute the gross, selected total, and zero remaining balance with exact decimals;
5. post each borrower payment through the existing backend payment-allocation service, using the collection's borrower-paid timestamp as the effective payment timestamp while retaining the distinct remittance-received and system-posted timestamps;
6. mark the collections `settled`, the remittance `posted`, and persist immutable cross-ledger links; and
7. append audit records containing public IDs, actor/source, request ID, correlation ID, and before/after state.

The grouped transfer itself increases lender cash only once. The borrower allocations reduce obligations only once. The accounting links distinguish the lender cash receipt from its several borrower-payment components so dashboards cannot double-count the grouped amount.

Posted collections, remittances, and borrower transactions are immutable. Reversal is compensating, requires a reason and idempotency key, and is allowed only when downstream records permit it. A successful remittance reversal compensates the borrower transactions and returns eligible collections to `pending_remittance`; it never deletes the original events or evidence.

## Web UI

Add an **Intermediary money** area with three views:

- **Awaiting remittance**: pending collections, grouped by intermediary with exact outstanding totals;
- **Remittance batches**: drafts, review items, ready proposals, posted batches, and balance details; and
- **History and exceptions**: settled, reversed, and manually approved collections with audit context.

The remittance editor uses a two-pane desktop layout and a sequential mobile layout. One pane lists filterable eligible collections; the other lists selected collections, gross amount, selected total, and remaining balance. No selection occurs merely because a filter or AI suggestion is applied.

Evidence rows show MIME type, status, and a thumbnail for images when ready. A **View evidence** action resolves a short-lived authenticated file-access URL and opens an image/PDF viewer or a new tab. Pending, failed, and expired evidence states explain why preview is unavailable and provide a retry action. Raw signed URLs are never rendered, logged, or persisted as public values.

All user-facing copy is added to both Thai and English locale files. Dates use the active locale and Bangkok business time; money uses exact decimal-string formatters.

## MCP contract and agent boundaries

Add tenant-scoped tools for:

- `intermediary.search`, `intermediary.list`, `intermediary.create`, and `intermediary.update`;
- `intermediary.collection.create`, `intermediary.collection.get`, and `intermediary.collection.list`;
- `intermediary.collection.manual_approve`;
- `intermediary.remittance.create`, `intermediary.remittance.get`, and `intermediary.remittance.list`;
- `intermediary.remittance.preview`, `intermediary.remittance.post`, and `intermediary.remittance.reverse`; and
- collection/remittance evidence prepare and finalize tools where the shared evidence contract cannot be reused directly.

Reads are marked read-only. Preview persists an expiring versioned proposal. Post, manual approval, and reversal are marked destructive and return audit public IDs plus correlation IDs. All schemas are closed and expose UUIDs and two-decimal money strings only.

An MCP agent may inspect unmatched collections and propose an explicit subset whose total fits a remittance balance. The proposal is advisory. If no exact subset exists, more than one exact subset exists, any identity is fuzzy, evidence or amounts conflict, or state is stale, the agent reports candidates and stops for human selection. It must display the selected items, selected total, remaining balance, warnings, expiry, and proposal public UUID before asking for confirmation. It may never silently choose oldest-first or force totals to fit.

The Web UI and MCP call the same application services. No lifecycle state or command is exclusive to AI, and remote MCP never calls the REST API internally.

## Duplicate, concurrency, and error rules

- Tenant-scoped idempotency keys protect collection creation, remittance creation/posting, manual approval, and reversal.
- Normalized bank references and evidence SHA-256 values detect hard duplicates and link the operator to the original item.
- A collection can be reserved by at most one mutable remittance at a time. Abandoning or reversing a draft releases its reservations.
- Concurrent preview/post attempts lock and revalidate state so a collection cannot settle twice.
- Over-allocation, under-allocation, intermediary mismatch, ambiguous identity, multiple exact candidate subsets, stale previews, and pending evidence remain review conditions rather than inferred corrections.
- Evidence finalization verifies tenant ownership, MIME type, byte size, checksum, metadata, and expiry. Upload errors are visible and retryable through a new valid intent.

## Migration of the four current borrower slips

The four existing unposted payment intakes for the borrower identified by the confirmed alias `พี่พล`, each for `75.00` on 2026-08-07 through 2026-08-10, must not be posted as lender receipts. After the operator selects the actual intermediary, a controlled migration converts or links them to four `pending_remittance` collections while preserving their timestamps, bank references, source provenance, and audit history. Their combined intermediary position is `300.00`.

The existing pending evidence intents require a safe retry after the signed-upload metadata defect is corrected. Migration must not attach raw file IDs or mark evidence ready without full storage validation. The original intake records remain traceable and cannot later be posted independently after conversion.

## Verification

Database-backed tests cover exact and partial remittances, borrower-paid effective dates distinct from remittance/post timestamps, manual selection persistence, multi-borrower batches, multiple exact subset candidates, intermediary mismatch, collection reservation races, concurrent and idempotent post, stale previews, duplicate references/evidence, manual approval permissions, reversal blockers, tenant isolation, audit/correlation records, and absence of double-counted cash or loan payments.

Frontend tests cover fully manual collection/remittance entry, filters, selecting and deselecting collections, exact remaining-balance presentation, save-and-resume drafts, disabled post for non-zero balances, explicit confirmation, manual approval reasons, localized copy, responsive layout, and evidence thumbnail/full-view/error/retry states.

MCP contract, plugin manifest/version, skills, validator, and eval fixtures are regenerated together. Eval scenarios cover one exact proposed subset, several exact subsets requiring human choice, no exact subset, partial balance, stale state, manual approval, duplicate evidence, and compensating reversal. Financial verification includes disposable PostgreSQL suites, backend typecheck, frontend test/lint/build, and plugin tests/validator.
