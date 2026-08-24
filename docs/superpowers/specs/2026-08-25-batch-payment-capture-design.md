# Batch Payment Capture MCP Design

## Status

Approved design for reducing multi-slip payment latency without weakening evidence, preview, confirmation, idempotency, or append-only financial records.

## Problem

CreditSync already has atomic `payment.batch.*` tools, but an agent must currently create every intake and add every batch item separately. A seven-slip request therefore performs repeated write calls before it can issue one preview and one execute. The existing per-item evidence APIs also require repeated prepare/finalize calls even though the signed uploads themselves can run concurrently.

## Goal

Add closed MCP batch-capture and batch-evidence tools so a multi-slip request uses one capture call, one prepare call, concurrent signed uploads, one finalize call, one preview call, and one explicitly confirmed execute call.

## Non-goals

- Do not combine preview and execution into one call.
- Do not upload evidence bytes through MCP or expose signed URLs in summaries.
- Do not change the existing single-payment or existing `payment.batch.*` contracts.
- Do not infer borrower identity or financial allocations from fuzzy evidence.

## MCP Additions

### `payment.batch.capture`

Creates one payment batch and its ordered payment intakes/items in one database transaction. Input is closed and contains:

- a stable batch idempotency key;
- an optional explicit borrower public UUID and safe note;
- 1–50 ordered items, each with a client item key, exact two-decimal amount, received ISO timestamp, optional payer name, optional bank reference, and stable intake idempotency key.

The service validates tenant access, amount format, duplicate bank references, idempotency-key conflicts, and duplicate item keys. It returns the safe batch representation plus a mapping from every client item key to its batch-item and intake public UUID. A hard duplicate returns the existing intake/item mapping and does not create another financial record.

### `payment.batch.evidence.prepare-many`

Accepts one batch UUID and 1–50 evidence descriptors keyed to current batch-item UUIDs. Each descriptor provides the payment intake UUID, MIME type, byte size, SHA-256, and evidence type. It delegates to existing evidence preparation while validating batch ownership and item/intake pairing. The response provides one safe result per item. The agent performs returned signed PUT operations concurrently and never logs their URLs or headers.

### `payment.batch.evidence.finalize-many`

Accepts the batch UUID and the evidence public UUID for every uploaded item. It finalizes each item atomically from the batch perspective: if any item is not ready or does not match its prepared immutable metadata, no batch preview may become ready. The response returns per-item evidence status and aggregate `allEvidenceReady`.

## Workflow

1. OCR all supplied slips concurrently and preserve uncertainty.
2. Read the named contract/borrower and relevant payment history concurrently.
3. Call `payment.batch.capture` once with all validated structured slip data.
4. For supplied images, calculate SHA-256 and byte size locally, call `prepare-many`, PUT the unchanged bytes concurrently, then call `finalize-many`.
5. Call existing `payment.batch.preview` once with exact explicit schedule allocations.
6. Display the complete backend preview, totals, variance, warnings, and target schedules.
7. Call existing `payment.batch.execute` exactly once after explicit human confirmation. Execution remains atomic and idempotent.
8. Re-read the batch and affected contracts once to verify posted results.

## Safety Rules

- `payment.batch.capture`, both evidence operations, and execution have command context, request/correlation IDs, audit records, and idempotency enforcement.
- Money remains two-decimal strings and uses backend `decimal.js` calculation only.
- Supplied slips require every item to reach evidence `ready` before preview or execution; a duplicate or failed evidence item stops the whole batch.
- `payment.batch.preview` and `payment.batch.execute` retain their current semantic-hash, stale-preview, explicit-confirmation, and transaction-locking behavior.
- Posted intake, evidence, transaction, schedule, fund-effect, and audit records remain immutable; corrections remain compensating workflows.

## Compatibility and Rollout

The current `intake.create`, `payment.preview`, `payment.post`, and lower-level `payment.batch.*` tools remain available. The reconciliation skill routes two or more supplied slips to the new capture workflow, while a one-slip request keeps the existing single-payment workflow unless explicitly batched.

The frozen MCP contract, server catalog, plugin version/validator, plugin skill, eval harness, README, and changelog must be synchronized in the release that exposes the tools.

## Verification

- Unit tests for closed schemas, idempotent capture retry, conflicting keys, duplicate references, batch/item ownership, and ordered response mapping.
- Disposable-PostgreSQL integration tests proving capture creates all intakes/items or none, and that prepare/finalize-many blocks preview until all evidence is ready.
- MCP adapter/server tests covering schemas, read-only/destructive annotations, and safe output fields.
- Plugin validation and eval scenarios for seven consecutive daily slips, a hard duplicate, one failed evidence item, and a stale preview before execute.
- Backend typecheck and disposable database suite; plugin validator; frontend test/lint/build only if UI copy changes.
