# Posted Payment Supplemental Evidence Upload Design

## Purpose

Allow an operator to attach a late payment-slip image to an exact posted payment without reversing, reposting, or mutating any financial record. The existing payment remains `posted` and immutable. The new evidence is an append-only supplemental record with an explicit reason and audit trail.

## Scope

The feature extends the existing `payment_evidence_supplements` lifecycle and `payment.evidence-supplement.record` command with a signed direct-upload channel:

`prepare -> direct signed PUT -> finalize -> confirm exact payment mapping -> record(reason)`

It adds backend service methods, REST routes for the Web UI, MCP tools for agents, synchronized plugin contracts/evals, and a localized "Attach supplemental evidence" action in loan payment history.

It does not change payment amounts, match allocations, transaction components, loan balances, schedules, commissions, or payment status. It does not reverse or repost a payment. It does not add a generic file-management API.

## Existing Foundation

The repository already has:

- `payment_evidence_supplements`, linked to one `payment_intake_id` with creator/recorder, reason, timestamps, idempotency keys, audit ID, and an immutability trigger after `recorded`.
- ChatGPT-hosted file import for late evidence.
- `payment.evidence-supplement.record`, which requires an exact posted intake, a ready supplement, explicit confirmation, reason, and idempotency key.
- Read models and payment-history UI rendering for recorded supplemental evidence.

The missing channel is a signed PUT lifecycle for browser/local files.

## Data Model

Add nullable `upload_expires_at` to `payment_evidence_supplements`. A `draft` row created by `prepare` may contain `evidence_hash`, `mime_type`, and `declared_size`; legacy all-null draft rows remain valid for compatibility. `ready` and `recorded` rows continue to require complete metadata and `ready_at`.

Add a tenant-scoped unique partial index on supplemental `evidence_hash` when non-null. Service-level checks also compare the checksum against primary payment evidence so one image cannot be attached as both primary and supplemental evidence. Preparation serializes checksum decisions with a tenant/checksum advisory transaction lock to close cross-table races.

The existing recorded-row immutability trigger remains unchanged. Draft rows may be removed only when an upload intent expires or signed preparation fails. Ready rows can transition only through the existing confirmed `record` operation.

## Backend Lifecycle

### Prepare

`preparePaymentEvidenceSupplement(ctx, intakePublicId, input, gateway)`:

- requires an authenticated actor, a valid UUID, and an intake whose exact status is `posted`;
- validates MIME (`image/jpeg`, `image/png`, `application/pdf`), positive bounded size, and lowercase 64-character SHA-256;
- requires a stable idempotency key;
- locks the intake and tenant/checksum decision;
- rejects a checksum already present in primary evidence or a supplement for another intake;
- replays a ready intent for the same intake, or safely re-signs an unexpired matching draft;
- removes an expired matching draft and its unreferenced file before retrying;
- creates a `files` row and draft supplement linked to the exact intake, stores declared metadata and expiry, and returns only public IDs, signed URL, expiry, and required headers;
- audits successful preparation without exposing signed URLs, object keys, raw file data, or account data.

### Upload

The browser or agent sends bytes directly to the returned signed MinIO URL using the exact required headers. The application backend does not proxy file bytes.

### Finalize

`finalizePaymentEvidenceSupplement(ctx, intakePublicId, supplementPublicId, gateway)`:

- rechecks actor access, exact posted intake binding, supplement ownership, status, and expiry;
- compares storage HEAD metadata, MIME, size, SHA-256, tenant, and intake public ID;
- changes only `draft -> ready`, sets `ready_at`, and emits an audit event;
- is idempotent for an already-ready supplement;
- never changes the payment or ledger.

### Record

The existing confirmed record command remains authoritative. It must continue to lock the exact posted intake and exact ready supplement, require `confirmed: true`, reason, and idempotency key, then append recorder/time/reason/audit metadata. A replay with a different intake, supplement, reason, or note is rejected.

## Public Interfaces

Add strict MCP tools:

- `payment.evidence-supplement.prepare`
- `payment.evidence-supplement.finalize`

Keep `payment.evidence-supplement.record` unchanged.

Add authenticated Web routes:

- `POST /payment-intakes/:id/evidence-supplements/upload-intents`
- `POST /payment-intakes/:id/evidence-supplements/:supplementId/finalize`
- `POST /payment-intakes/:id/evidence-supplements/:supplementId/record`

Every write carries request/correlation context and a stable `Idempotency-Key` where required. Public responses contain UUIDs and safe metadata only.

## Web UI

In loan payment history, each posted payment exposes a localized "Attach supplemental evidence" action. The editor:

1. accepts JPEG, PNG, or PDF;
2. computes SHA-256 in the browser and calls prepare;
3. performs the signed PUT and finalize;
4. shows the exact payment date and amount plus the selected filename;
5. requires a reason and explicit confirmation;
6. records the supplement with a stable idempotency key;
7. reloads history and displays the supplemental slip through the existing evidence preview control.

The UI disables duplicate submission while saving, preserves the command idempotency key across retries, localizes Thai and English strings together, and does not display or persist signed URLs.

## Failure Behavior

- Non-posted or inaccessible intake: fail closed.
- Unsupported MIME, invalid size/hash, mismatched metadata, expired intent, wrong intake/supplement binding, duplicate checksum, or stale status: stop without recording evidence.
- Upload failure: leave the draft retriable until expiry; do not record.
- Record failure: leave the supplement ready and retriable; do not alter payment state.
- Any unexpected database or storage error: no financial changes and no claim of success.

## Verification

Tests must prove:

- migration/schema compatibility and recorded immutability;
- prepare/finalize idempotency, expiry/re-sign behavior, exact intake binding, metadata validation, tenant isolation, checksum duplicate/race protection, and safe outputs;
- `record` still requires confirmation and never changes amount, allocations, transactions, components, schedules, or balances;
- strict MCP schemas/annotations, default handlers, frozen contract, plugin docs/evals, and validator synchronization;
- REST authorization and route contracts;
- UI upload/confirm/retry/error behavior and Thai/English copy;
- backend disposable PostgreSQL suites, typecheck, frontend tests/lint/build, and plugin tests/validator.

## Production Follow-up

After merge and deployment, use the new lifecycle for the slips dated 6, 7, and 8 September 2026. Inspect each posted intake first, prepare/upload/finalize one image to its exact intake, present the three ready mappings, obtain explicit confirmation, record with reason `operator_omission`, and re-inspect evidence plus unchanged financial state.
