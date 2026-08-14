# MCP Borrower ID-Card Upload Design

## Goal

Add a tenant-safe MCP workflow that lets an agent upload a borrower identity-card image, verify and bind the stored object, then apply agent-extracted identity fields to that borrower with complete audit provenance. Image interpretation remains a Codex/client responsibility; the backend does not run OCR in this workflow.

## Scope

This design covers identity-card images only. It does not add borrower profile-photo upload, asynchronous OCR jobs, automatic extraction in the backend, or raw OCR text storage. The supported extracted fields are the existing borrower fields `name`, `idCardNumber`, and `address`.

The existing Web borrower form may continue to work during migration, but the implementation should reuse the new storage service where practical and must not weaken the MCP contract to accommodate the legacy multipart endpoint.

## Workflow

1. The agent inspects the supplied image locally and resolves the exact borrower before any write.
2. The agent validates that it extracted a non-empty name, address, and 13-digit Thai identity-card number whose checksum is valid. It does not repeat the raw number in conversation or readable tool summaries.
3. The agent calls `borrower.id-card.prepare` with the borrower public UUID, MIME type, byte size, SHA-256 digest, and optional original filename.
4. The agent uploads the unchanged bytes directly to the returned, unexpired signed PUT URL with every required header.
5. The agent calls `borrower.id-card.finalize` with the exact borrower and intent public UUID returned by prepare.
6. After finalize returns `ready`, the agent calls `borrower.id-card.apply-extracted-data` with that intent and the three extracted fields.
7. The backend atomically updates the borrower and records masked before/after audit provenance. The response contains changed field names, safe image identity, audit public UUID, and correlation UUID, but no raw identity-card value, storage key, checksum, signed URL, or OCR text.

The ordering is intentional: borrower identity data is not changed unless the supporting image has first been stored and verified successfully.

## MCP Contract

### `borrower.id-card.prepare`

Input is a closed schema containing:

- `borrowerPublicId`: public borrower UUID.
- `mimeType`: `image/jpeg` or `image/png`.
- `size`: positive integer bounded by `EVIDENCE_MAX_BYTES`.
- `sha256`: exactly 64 hexadecimal characters.
- `originalName`: optional nullable string of at most 500 characters.

The tool resolves tenant-scoped borrower access before reserving an upload intent. The intent binds tenant, borrower, file, MIME type, declared size, and checksum. Its MinIO metadata binds the object to the tenant, borrower public UUID, and intent public UUID.

A pending, unexpired retry with identical immutable metadata may return a refreshed signed URL for the same intent. A ready retry returns safe ready state without another signed URL. Reuse of the checksum for another borrower or conflicting MIME/size returns a conflict. An expired pending intent may be replaced only through the service-owned cleanup path.

The pending response contains intent and file public UUIDs, upload URL, expiry, and required headers. Signed upload data is the only intentional short-lived secret in the workflow and must not be copied into audit logs or readable summaries.

### `borrower.id-card.finalize`

Input is a closed schema containing `borrowerPublicId` and `intentPublicId`.

Finalize verifies tenant and borrower binding, pending status, expiry, object existence, MIME type, exact byte length, SHA-256 checksum, and all required storage metadata. Success marks the intent `ready`, binds the finalized file to that borrower-specific intent, and writes an audit event. It does not yet change borrower identity fields or `borrowers.idCardImageUrl`.

Finalize is retry-safe. Repeating it for the same ready intent returns the original safe result and audit metadata without inspecting storage or writing another audit event.

### `borrower.id-card.apply-extracted-data`

Input is a closed schema containing:

- `borrowerPublicId`: the exact borrower bound to the intent.
- `intentPublicId`: a ready, unapplied intent.
- `name`: trimmed non-empty canonical name.
- `idCardNumber`: a 13-digit Thai identity-card number; formatting separators may be accepted at parsing but storage uses the project's canonical representation.
- `address`: trimmed non-empty address.
- `idempotencyKey`: stable non-blank key.

The command locks the borrower and intent, validates tenant and borrower binding, requires finalized `ready` evidence, validates all three fields and the Thai identity-card checksum, and checks identity-card uniqueness within the tenant. It then updates `name`, `idCardNumber`, `address`, and `idCardImageUrl` atomically, marks the intent `applied`, stores a hash of the normalized command for replay detection, and creates one audit event.

The tool is destructive and idempotent. An identical retry returns the original result. Reusing the intent or idempotency key with different extracted data returns a conflict. Validation failure returns `reviewRequired: true`, leaves the borrower unchanged, and keeps the verified image available for human review.

## Persistence

Add a borrower identity-card upload-intent table rather than treating arbitrary `files` rows as attachable references. Each row has public UUID, tenant ID, borrower ID, file ID, status (`pending`, `ready`, `applied`), checksum, MIME type, declared size, upload expiry, finalized/applied timestamps, normalized command hash, idempotency key, actor columns, and timestamps.

Database constraints enforce tenant-safe foreign-key relationships and immutable binding fields after insertion. Applied intents and their file associations cannot be updated or deleted. A borrower may retain historical finalized identity-card images; `borrowers.idCardImageUrl` points to the latest successfully applied storage reference. Old files are not deleted automatically.

## Security and Privacy

- Never return or log raw identity-card values, raw OCR text, signed URLs outside prepare, storage keys, bearer tokens, or checksums outside the prepare/finalize protocol fields required for verification.
- Audit payloads store masked identity-card values and useful before/after state for name, address, image public UUID, and changed-field names.
- Read tools expose only whether an identity-card image is available and its safe public file/intent identity where necessary; signed read access remains an authenticated, short-lived Web concern.
- The MCP server calls borrower/storage services directly and never calls the REST API internally.
- Every write carries command context, request/correlation ID, actor/source, and append-only audit history. Apply additionally requires an idempotency key.
- Fuzzy borrower matching never authorizes this workflow. The agent must resolve one exact borrower before prepare.

## Failure Behavior

- Missing or ambiguous borrower resolution stops before prepare.
- Invalid MIME, size, or digest stops before reserving storage.
- Missing, expired, changed, or incorrectly owned objects fail finalize and do not change the borrower.
- Incomplete extraction, invalid Thai checksum, tenant duplicate identity, or stale/conflicting intent returns a structured review-required/conflict response and does not partially update the borrower.
- Upload success without successful finalize leaves a pending intent only; it does not attach the image.
- Finalize success without apply leaves a verified image for review but preserves current borrower fields and current applied image.
- No rollback deletes material evidence. Corrections use a newly prepared image and a new audited apply command.

## Frontend

The borrower create/edit UI keeps JPEG/PNG selection and preview, but should migrate from the generic multipart upload to the same prepare, direct PUT, and finalize service contract. The UI does not use Codex extraction and therefore must continue to let a human enter or review the three borrower fields before saving. Thai and English copy must be updated together.

The borrower detail view continues to resolve short-lived authenticated image access and must not render raw storage references. Pending or failed uploads display a localized review/retry state.

## Plugin and Versioning

The three tools increase the advertised MCP tool count from 64 to 67 and constitute an additive plugin contract change. Update the plugin manifest/version, frozen authenticated `tools/list` metadata snapshot, README, skill routing, validator expectations, and positive/negative eval scenarios together. Tool annotations are:

- `borrower.id-card.prepare`: non-read-only, destructive, non-idempotent.
- `borrower.id-card.finalize`: non-read-only, destructive, idempotent.
- `borrower.id-card.apply-extracted-data`: non-read-only, destructive, idempotent.

The borrower-management skill must enforce exact identity resolution, unchanged-byte upload, ready-state inspection, complete extraction, checksum validation, and stop-before-apply behavior on ambiguity or mismatch.

## Testing and Verification

Backend service and disposable-PostgreSQL coverage must prove successful prepare/finalize/apply, identical retries, conflicting retries, expired upload, storage metadata mismatch, checksum reuse across borrowers, tenant isolation, invalid Thai identity checksum, incomplete extraction, tenant duplicate identity, immutable applied intents, masked audit payloads, and atomic borrower/image updates.

MCP tests must verify closed input/output schemas, annotations, direct service adapters, safe structured/readable output, audit and correlation UUIDs, and authenticated `tools/list` metadata. Plugin tests and evals must cover the exact ordered workflow, already-ready retries, expired signed URLs, changed bytes, finalize identity mismatch, invalid extracted identity, forbidden apply before finalize, and absence of raw sensitive values from summaries.

Frontend tests must cover direct PUT headers, finalize-before-save ordering, pending/review states, safe preview access, error recovery, and synchronized Thai/English copy.

Before completion run backend typecheck and disposable database suites, frontend tests/lint/build, and plugin tests/validator. A skipped database suite is not sufficient for the new identity and immutability invariants.
