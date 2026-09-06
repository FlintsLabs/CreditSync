# ChatGPT Payment-Slip Ingestion and Contract History Evidence Design

## Status

Proposed design. It replaces the current agent-side signed-PUT requirement when a payment slip is supplied in ChatGPT, while keeping the existing direct-upload APIs for the Web UI and other clients.

## Problem

CreditSync can read a slip attached to a ChatGPT conversation, but the existing MCP evidence tools accept only a MIME type, byte size, and SHA-256. They return a MinIO signed PUT URL and require the calling client to upload the original bytes itself. The ChatGPT tool-only integration cannot perform that PUT, leaving evidence intents pending even when payment posting has completed.

The current contract payment-history table also reads the generic transaction list and therefore cannot show the ready payment-evidence files that are attached to a payment intake.

## Goals

- Let a user attach a JPEG, PNG, or PDF slip in ChatGPT and have CreditSync ingest the original file bytes into tenant-owned storage without Base64 tool arguments.
- Keep the public MCP contract free of raw evidence bytes, raw QR contents, arbitrary fetch URLs, storage keys, and signed URLs.
- Require an image-first ChatGPT payment flow to have ready evidence before preview or post, while retaining valid data-only payment capture.
- Permit a separately confirmed, append-only supplemental evidence record for an already posted payment, including the explicit reason `upload_channel_unavailable`.
- Show safe slip-preview buttons for ready evidence in the contract payment-history table.

## Non-goals

- Do not change money amounts, transactions, payment allocations, loan balances, schedules, or a posted intake to attach a file.
- Do not allow generic user-supplied URLs, Base64 payloads, direct file IDs, raw file bytes, or unverified storage objects in MCP commands.
- Do not replace existing `evidence.prepare` / `evidence.finalize` flows used by the Web UI and other compatible clients.
- Do not expose a permanent object URL or evidence contents in an MCP response, application log, audit payload, or browser route response.

## Architecture

### ChatGPT file-parameter import

Add `evidence.import-chatgpt-file` as a destructive, idempotent MCP tool. Its closed schema contains the target payment-intake public UUID, stable idempotency key, evidence type, and one top-level ChatGPT file parameter. The parameter uses the required ChatGPT file-object schema (`download_url`, `file_id`, optional `mime_type`, optional `file_name`) and is declared in tool metadata as `openai/fileParams`.

ChatGPT supplies this object only after a user attaches or selects a file. The service treats it as a platform capability, not as a generic fetch URL: it requires HTTPS, validates the configured OpenAI download-host allowlist, rejects redirects, and never persists, returns, logs, or audits either `download_url` or `file_id`.

The service streams the download through a bounded reader, independently identifies the allowed MIME type, enforces `EVIDENCE_MAX_BYTES`, computes SHA-256 while streaming, and writes the same bytes to MinIO through the server-side storage gateway. It verifies the stored object metadata and checksum before creating an immutable `ready` evidence record. It returns only safe public IDs, MIME type, size, checksum, status, audit public ID, and correlation ID.

The idempotency record binds the intake UUID, evidence type, file ID fingerprint, MIME type, byte size, and final SHA-256. An identical retry returns the same ready evidence. A retry after a partial storage failure resumes or safely replaces only a pending draft; it never creates a second ready evidence record. A mismatched file or idempotency payload fails closed.

### Image-first payment gate

Add `evidenceRequired` to a payment intake as explicit workflow state. ChatGPT capture marks it true before importing an attached slip. `payment.preview`, `payment.reconcile.preflight`, `payment.post`, and the batch equivalents reject an intake/item with `evidenceRequired = true` unless it has at least one matching ready evidence record. A data-only capture leaves the field false and remains compatible.

Existing prepare/finalize flows set the same ready condition. The backend, rather than the plugin skill alone, owns this gate so a caller cannot post first and try to attach the supplied slip afterward.

### Posted-payment supplementary evidence

Create a new append-only `payment_evidence_supplements` table rather than altering `payment_evidence` rows attached to the original intake. Each row includes tenant, public UUID, posted payment-intake ID, ready file ID, immutable checksum/MIME/size, reason enum, optional note, created/finalized actor and timestamps, idempotency key, audit public ID, and correlation ID.

Supported reasons are `upload_channel_unavailable`, `operator_omission`, `evidence_recovered`, and `other`; `other` requires a non-blank note. Database constraints and triggers reject update/delete once finalized.

The command sequence is:

1. `payment.evidence-supplement.import-chatgpt-file` creates/uploads/verifies one draft supplement for an exact accessible posted payment intake.
2. The tool returns the safe ready summary and asks the operator to confirm the exact payment, evidence, reason, and note.
3. `payment.evidence-supplement.record` accepts `confirmed: true`, the reason/note, and a stable idempotency key, then appends the final supplement and audit record.

The existing four 6 September 2026 payment intakes use this workflow with `upload_channel_unavailable`. Their payment and transaction rows remain unchanged. Expired pending evidence intents are not marked ready or reused as proof of upload.

### Contract payment-history slip preview

Extend the authorized loan payment-history read model to return a safe `evidence` array for each intake-backed payment: ready primary evidence and ready supplementary evidence, represented only by public UUID, file public UUID, MIME type, source (`primary` or `supplement`), and supplement reason when applicable. Never return storage keys, checksums, download URLs, or raw evidence metadata to this table.

Replace the contract tab's broad `/transactions` client-side filter with the existing loan payment-history endpoint so it retains payment-intake lineage and evidence summaries. Render one `EvidencePreviewButton` per returned file using the existing authenticated `/files/:publicId/access-url` endpoint. That endpoint creates a short-lived signed access URL only after tenant and ownership checks. Pending/rejected evidence has no button; the UI shows a localized unavailable state only where useful.

## Tool and Plugin Contract

- Keep `evidence.prepare` and `evidence.finalize` unchanged.
- Add `evidence.import-chatgpt-file` and both `payment.evidence-supplement.*` tools to the MCP catalog, closed Zod schemas, annotations, safe output schemas, and default handlers.
- Mark all three as destructive, with `idempotentHint` where the command supports retry.
- Add the OpenAI file-parameter metadata only to top-level file fields; do not nest or copy the file object into tool summaries.
- Regenerate the frozen MCP contract. Update plugin version, README, `reconcile-payments` skill, root skill, error-recovery reference, eval catalog/harness, and validator expectations together.

## Security and Data Integrity

- The import service permits only HTTPS downloads from the configured ChatGPT/OpenAI file-delivery allowlist, with DNS/IP validation, no redirects, bounded streaming, and strict response MIME validation. It treats unavailable/expired files as retryable upload failures, never as successful evidence.
- Logs and audit payloads contain public IDs, operation state, safe file metadata, and hashes only. They exclude bytes, raw OCR, QR payloads, account values, file IDs, temporary URLs, auth headers, and storage keys.
- A ready evidence record is immutable. A supplement is an immutable provenance record, not a mutation of posted financial data.
- Every write has command context, request/correlation IDs, actor/source, audit history, and an idempotency boundary.
- The backend uses `decimal.js` for all financial behavior; this feature does not calculate money.

## Verification

- Disposable-PostgreSQL tests for ChatGPT file import success, identical retry, expired source URL, untrusted host, redirect, MIME/size/checksum mismatch, storage failure cleanup, posted-intake rejection, and image-required post/preflight rejection.
- Database migration tests for supplement tenant keys, enum/note constraints, immutable finalized rows, and no transaction/schedule/balance mutation.
- MCP server tests for strict file-parameter schemas, metadata, annotations, safe outputs, and no raw URL/file-ID leakage.
- Plugin contract/eval coverage for successful image-first capture, retry, unavailable ChatGPT file, and late evidence confirmation; retain data-only and signed-PUT flows.
- Frontend tests for primary/supplementary slip buttons, authenticated signed access resolution, unavailable evidence, and Thai/English translations.
- Run backend disposable tests and typecheck; frontend test/lint/build; plugin tests and validator; then test a real ChatGPT attachment in Developer Mode before rollout.

## Rollout

1. Deploy the backend migration and server changes without changing existing evidence behavior.
2. Refresh the private ChatGPT app so it receives the new file-parameter schemas.
3. Validate one non-production/controlled payment attachment end-to-end in ChatGPT Developer Mode.
4. Use the confirmed supplemental-evidence workflow for the four existing payments; retain an audit report of public operation IDs only.
5. Enable the new image-first skill guidance after the real attachment test passes.
