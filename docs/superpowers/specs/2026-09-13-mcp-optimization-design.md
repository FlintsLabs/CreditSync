# CreditSync MCP Safety, Performance, and Compatibility Design

Date: 2026-09-13. Status: revised design for implementation; no rollout performed.

## Objective and boundaries

Improve evidence-aware agent workflows, tool metadata correctness, discovery cost, and curated connections while preserving legacy `/mcp`. Add MCP 2026-07-28 support through an official SDK adapter, validated against the published wire schema and real clients.

This design retains the approved agent-level evidence stop. It does not introduce a backend requirement that all financial records have evidence. Skill instructions and deterministic evals are not a security boundary and cannot guarantee that arbitrary clients never bypass the workflow.

## Global constraints

- Never edit or delete posted financial records or active terms; corrections are append-only compensation.
- Attachment-bearing agent workflows must stop before activation/post/financial execute until all relevant evidence is storage-ready and semantically reviewed.
- Financial transitions require explicit confirmation of the current proposal, stable idempotency, public audit metadata, and correlation ID. Preserve legacy command contracts; inventory unsupported idempotency or audit cases and resolve explicitly before claiming complete coverage.
- Money crosses public interfaces as two-decimal strings; existing backend services own calculations using decimal.js. Business dates use Asia/Bangkok.
- Keep `/mcp` compatible with existing clients. Profiles reduce discovery context; they do not create authorization scopes.
- Before every implementation commit, update CHANGELOG.md under a version/date heading and include README.md when setup or workflows change.
- Use disposable PostgreSQL for financial tests; never run destructive fixtures or conformance writes against a live tenant.
- Implementation is completed on an isolated codex/ branch. Merge, push, deployment, and production writes require their own authorization.

## Evidence workflows

Storage readiness proves integrity and availability, not that sender, recipient, amount, date, contract, or purpose matches. Both checks are required. OCR is supporting evidence only; do not persist raw OCR, QR data, account numbers, signed URLs, or full references in logs/evals.

Payment: inspect attachment and identity/recipient/contracts/history, obtain the required confirmation before creating intake records, create or select the exact intake, call `evidence.import-chatgpt-file`, verify its state and semantic mapping, preview, confirm the current ready proposal, then post. The importer requires `paymentIntakePublicId`; it cannot be the first operation before an intake exists.

New-loan payout: inspect and preview terms, confirm draft creation, create loan draft, create disbursement draft, prepare evidence, PUT to the current signed URL, finalize, inspect readiness and payout mapping, confirm current terms and payout, activate the loan, re-inspect the payout, then post. Current `createDisbursementDraft` permits nonterminal draft loans; verify the complete prepare/finalize path with a disposable integration test. If any dependency requires activation before evidence readiness, stop this flow and report the limitation; do not activate to unlock evidence upload. Do not misuse the payment importer for payouts.

On import/upload/finalize failure, unknown file state, missing attachment access, duplicates, or semantic mismatch, stop for human review. Do not switch an attachment-bearing request to data-only. Recipient identity is checked against the intended payment channel/payee, not automatically against the borrower. A representative payee requires explicit relationship confirmation and a fresh review before transition. Ready evidence retries do not re-upload.

If an operation might have committed before its response failed, inspect exact public IDs and reuse the original idempotency key. Report actual record/evidence states; never claim rollback or completed evidence attachment without evidence.

## ChatGPT Mobile attachment ingestion

Scope includes backend ingestion of payment and payout slips attached in ChatGPT Mobile. Support is established per observed app platform/version and connection; image visibility in the conversation alone does not prove that MCP receives a downloadable file. Verify the actual supported attachment mechanism and current official documentation before adapting schemas. Never invent download URLs from file IDs. Missing backend-readable access stops the workflow and leaves mobile support pending for that connection.

Keep `evidence.import-chatgpt-file` for an existing payment intake. Add `loan.disbursement.evidence.import-chatgpt-file` for an exact tenant-owned disbursement draft, with stable idempotency and the existing ChatGPT file object shape where supported. Authorize the target before downloading. The payout importer composes the existing prepare/upload/finalize services and must work before parent-loan activation. It creates no payment intake and performs no activation/post. The backend transfers file bytes to storage; the mobile client/agent does not need direct MinIO connectivity. Existing direct-upload callers remain supported.

Use a bounded HTTPS downloader with source-origin validation, DNS/IP and redirect checks, connection-time protection against DNS rebinding, byte/time limits, MIME/signature verification and server-calculated SHA-256. Reuse the existing evidence size/type rules. Do not send backend credentials to the file host or log signed URLs, raw evidence or sensitive extracted fields. Results expose only safe public associations, state and audit/correlation metadata.

Idempotency binds tenant, target and logical file identity rather than an expiring URL. Concurrent/repeated requests converge on the same evidence association; changed target/content conflicts. A ready retry returns existing evidence without retransferring it. Persist recoverable progress for partial storage/finalization failures; inspect state before resuming. A refreshed URL is usable only for the same logical attachment; changed identity/content needs review. Reattachment does not automatically clear duplicate or mismatch findings. No automatic edits/deletions of posted associations are allowed.

Automated tests cover missing access, expired URLs, unsafe destinations/redirects, MIME/size violations, storage errors, tenant/target isolation, concurrent retries and lost responses after finalize. Real-device staging tests use synthetic JPEG/PNG/PDF evidence and cover both payment and payout flows, multiple required attachments, interruption, reattachment and recipient mismatch. Record iOS/Android and app/connection details without secrets. Each claimed supported platform must pass attachment -> backend storage -> ready association read-back; untested platforms remain pending. Storage readiness never substitutes for semantic review and explicit financial confirmation.

## Catalog, profiles, and discovery

One immutable catalog contains safe tool definitions and audit/recovery classification. Generate schemas once, with explicit transport-era projection where necessary. Keep success-only plugin snapshots distinct from wire snapshots containing error envelopes. Derive counts from catalog membership: baseline 130 plus one payout importer and three composite reads implies 134 unless other catalog changes occur.

Profiles: full, core-read, payments, loans, disbursements, admin. Route selects the profile; model arguments cannot change it. Exact allowlists include required dependency reads and evidence tools. Out-of-profile calls are unavailable. The union of curated profiles covers the catalog; core-read contains no mutations. Shared bearer access to multiple routes is not permission isolation.

Payments includes its existing importer and intake dependencies. Loans and disbursements include payout draft/import/read-back dependencies required for evidence readiness before activation. No importer belongs in core-read.

Discovery uses deterministic order, cached definitions and opaque cursors bound to profile and catalog version. Modern/profile page size is 25. Initially retain legacy full-list behavior for `/mcp` unless all supported legacy clients are verified to paginate. A final page omits nextCursor. Cache hints apply to modern discovery only, and public scope requires authorization-independent definitions. Cache identity includes profile, era and catalog version; no caching tools/call results.

Pagination bounds each response, not the complete tool context. Measure discovery through the last page and test actual host behavior with selected connections; enabling all profiles can increase duplicate context.

## Dual-era transport

Use official SDK 2026-07-28 support alongside the existing v1 compatibility path. Resolve and pin actual published package versions and lockfile integrity before coding adapters; do not invent versions or hand-roll a partial protocol if the dependency cannot be obtained.

Validate exact Origin allowlist before body parsing, allow absent Origin for nonbrowser clients, retain Host and bearer protections. Modern protocol validation includes headers and body metadata consistency, discovery, required request metadata and wire response envelope, including resultType. Follow the published schema for required versus optional metadata rather than copying examples blindly. SDK owns wire encoding; do not inject modern fields into legacy application results. Maintain an explicit supported-version matrix and legacy initialization behavior.

## Verification and release

Run independent metadata, HTTP, cursor, profile, composite parity and evidence-stop tests, then full backend disposable suites, backend typecheck, plugin tests/validator and official conformance against a local fixture. Pin the conformance runner revision and document exact invocation and supported scenarios. Unsupported OAuth deployment capabilities are documented limitations, not hidden implementation failures.

Prepare staging configuration and metrics before rollout. Actual canary execution depends on an authorized environment. Measure p50/p95 latency, complete discovery bytes/time, schema cache hits, profile usage, rejected origins/headers, and workflow stops without high-cardinality identities or PII. Performance acceptance uses a captured before/after baseline, not fabricated thresholds.

Mobile acceptance is a separate runtime gate in docs/operations/chatgpt-mobile-evidence.md, authored during implementation. Track sanitized import outcomes and time-to-ready alongside financial workflow stops. A passing mocked attachment test does not establish mobile compatibility; report local verification and real-device staging results separately.

Retain full endpoint for at least one major release and 30 days after profiles launch. Removal also requires zero usage for 30 consecutive days, successful client migration and explicit release approval.

## Sources

- https://modelcontextprotocol.io/specification/2026-07-28
- https://modelcontextprotocol.io/specification/2026-07-28/server/tools
- https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/caching
- https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/pagination
- https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http
- https://ts.sdk.modelcontextprotocol.io/v2/migration/support-2026-07-28
- https://github.com/modelcontextprotocol/conformance
