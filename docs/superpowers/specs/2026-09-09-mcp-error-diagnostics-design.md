# MCP Error Diagnostics Design

## Purpose

Make every CreditSync MCP failure useful to both the operator and the agent. Expected failures must return a safe, actionable explanation that tells the user what happened and what to do next. Unexpected, retryable, and integration failures must also create a tenant-scoped diagnostic record that an authorized ChatGPT agent can inspect by correlation ID instead of stopping at a generic error code.

The design keeps diagnostics operational and non-financial. It does not weaken existing fail-closed behavior, human-confirmation boundaries, immutable financial records, audit requirements, or secret handling.

## Goals

- Return understandable MCP errors with a stable code, safe message, suggested action, retryability, review requirement, and correlation ID.
- Capture bounded request breadcrumbs in memory and persist them only for unexpected, retryable, or integration failures.
- Store persisted diagnostics in PostgreSQL for 30 days and emit the same safe summary to structured stdout.
- Let tenant `owner` and `manager` actors inspect diagnostics through strict read-only MCP tools.
- Make diagnostic persistence best-effort so logging failure never masks or changes the original MCP result.
- Keep the frozen MCP contract, private plugin, skills, evals, and validator synchronized.

## Non-Goals

- A general log explorer, infrastructure shell, Docker log reader, SQL console, or arbitrary full-text search tool.
- Persisting every successful MCP request or every breadcrumb.
- Exposing stack traces, exception messages, request bodies, database queries, signed URLs, object keys, credentials, file identifiers, hashes, evidence contents, QR payloads, account details, borrower identity data, or financial references.
- Replacing append-only financial audit logs with operational diagnostics.
- Automatically retrying financial writes or continuing after stale, ambiguous, duplicate, mismatched, or confirmation-required results.

## Chosen Approach

Use a hybrid error model:

1. Known domain errors are translated into actionable public errors and normally are not persisted as diagnostics.
2. Unexpected errors, retryable errors, and failures involving storage, network, database, cache, or another integration are persisted with sanitized breadcrumbs.
3. Every public MCP error includes its correlation ID.
4. ChatGPT may call a separate read-only diagnostic tool when the public error is insufficient. The error response itself never contains internal details.

PostgreSQL is the diagnostic source of truth because the MCP backend can query it safely and consistently. Structured stdout remains an operational fallback. File logs and Docker socket access are excluded because they are difficult to query safely, may be rotated, and would broaden backend privileges.

## Architecture

### Request Diagnostic Scope

The MCP tool boundary creates one request-local diagnostic scope containing:

- tenant ID;
- tool name;
- request ID;
- correlation ID;
- actor public identity or role only when needed for authorization, never email/name;
- monotonic start time;
- a bounded breadcrumb buffer.

The scope is carried through asynchronous work with a small request-context abstraction backed by `AsyncLocalStorage`. Services and integration adapters call a narrow `recordMcpBreadcrumb` API without receiving raw logger or database dependencies. Code outside an MCP request receives a no-op recorder.

Breadcrumbs are allowlisted typed events, not arbitrary objects. The buffer holds at most 20 entries. Each entry contains a stage, outcome, elapsed time, and a small safe metadata projection. When full, it retains the first breadcrumb, the most recent entries, and a `breadcrumbs_truncated` marker.

### Instrumentation Boundaries

Initial instrumentation covers central boundaries that provide high diagnostic value across all MCP tools:

- MCP validation and preflight;
- handler/service execution;
- PostgreSQL transaction/query failures at explicit service boundaries;
- cache access and rate limiting;
- S3/MinIO prepare, PUT, HEAD, GET, and delete operations;
- ChatGPT attachment DNS, download, validation, and storage import;
- other external HTTP integrations already invoked by MCP handlers.

Instrumentation records stages and outcomes, not input payloads. Financial service internals may add named stages but must never emit balances, amounts, allocation details, customer identity, or evidence data into diagnostics.

### Error Classification

A central classifier converts thrown values into two projections:

- `PublicMcpError`: safe information returned to ChatGPT;
- `PersistedMcpDiagnostic`: operational information stored for authorized follow-up.

Public error fields:

- `code`;
- `message`;
- `suggestedAction`;
- `retryable`;
- `reviewRequired`;
- existing batch-specific recovery flags where applicable;
- sanitized `details` under the existing denylist/allowlist rules;
- `correlationId`.

Diagnostic classification fields:

- category: `domain`, `validation`, `authorization`, `database`, `cache`, `network`, `storage`, `external_service`, `timeout`, or `internal`;
- failure class: a stable allowlisted identifier such as `dns_resolution`, `connect_timeout`, `connection_reset`, `http_status`, `redirect_rejected`, `metadata_mismatch`, `constraint_violation`, or `unknown`;
- safe upstream status when available;
- retryability and review requirement;
- terminal stage and bounded breadcrumbs.

Raw exception messages and stack traces are not persisted or returned. Runtime-specific error/cause codes are mapped through an allowlist; unknown values collapse to `unknown`.

### Persistence Policy

Persist one terminal row when any of the following is true:

- the error is not a `DomainError`;
- the public error is retryable;
- the category is database, cache, network, storage, external service, timeout, or internal;
- an explicitly allowlisted domain code requires operational investigation.

Expected validation, authorization, ambiguity, stale-state, duplicate, and human-confirmation errors remain actionable public responses and structured stdout events but are not stored unless they also satisfy an integration/retryability rule.

Persistence is best-effort and happens after the public error has been classified. If insertion fails, the system emits a safe `mcp_diagnostic_persist_failed` stdout event and returns the original public error unchanged. Diagnostic read tools do not recursively persist failures in the diagnostic subsystem.

## Data Model

Add append-only table `mcp_diagnostic_events`:

- `id` internal serial primary key;
- `public_id` UUIDv7, unique;
- `tenant_id` required;
- `tool_name` required and bounded;
- `request_id` required UUID;
- `correlation_id` required UUID;
- `category` required allowlisted text;
- `failure_class` required allowlisted text;
- `error_code` required bounded text;
- `terminal_stage` required bounded text;
- `retryable` and `review_required` required booleans;
- `upstream_status` nullable integer with a valid HTTP status constraint;
- `duration_ms` required non-negative integer;
- `breadcrumbs` required JSONB array validated by the application serializer;
- `occurred_at` required timestamp;
- `expires_at` required timestamp set to `occurred_at + 30 days`.

Indexes:

- tenant plus correlation ID and occurred time;
- tenant plus request ID and occurred time;
- tenant plus occurred time descending;
- expiry time for cleanup.

The table has no foreign keys to financial entities and no delete/update public API. A scheduled maintenance operation deletes only rows whose `expires_at` is in the past. Retention cleanup is operational deletion, not mutation of financial history.

## Public MCP Contract

### Existing Error Envelope

Extend the common MCP error envelope with:

- required `correlationId` UUID;
- required `suggestedAction` from a bounded public string catalog.

Known error mappings should be specific enough to guide the next action. Examples include attaching the file again, preparing a new upload URL, re-running preview, inspecting a duplicate, requesting confirmation, or contacting an owner with the correlation ID. Messages must not encourage automatic retries of financial writes unless idempotency and current-state checks explicitly permit it.

### `system.error-diagnostic.get`

Strict input:

- required `correlationId` UUID.

Behavior:

- requires the configured MCP principal to be an active tenant `owner` or `manager`;
- queries only the principal's tenant;
- returns the exact diagnostic event or `DIAGNOSTIC_NOT_FOUND`;
- never accepts tenant ID from the caller.

Safe output:

- diagnostic public ID;
- tool name;
- correlation and request IDs;
- category, failure class, error code, terminal stage;
- retryability, review requirement, safe upstream status;
- duration and timestamps;
- sanitized breadcrumbs;
- a safe operator-oriented summary and recommended next check.

### `system.error-diagnostic.list`

Strict input:

- optional tool name, error code, category, and outcome filters;
- optional ISO date-time range limited to the retained 30-day window;
- optional correlation ID or request ID;
- cursor pagination;
- limit default 20, maximum 100.

At least one narrowing filter is required unless the requested window is no more than 24 hours. Results are tenant-scoped, newest first, and use the same safe projection as `get`. The tool does not return aggregate customer or financial data.

Both tools advertise `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, and `openWorldHint: false`. They are not financial tools and do not return financial audit metadata.

## Authorization and Data Safety

- Resolve the actor from existing MCP principal configuration and verify the current database role on every diagnostic query.
- Permit only `owner` and `manager`; return a generic forbidden error to `collector` and `viewer`.
- Enforce tenant predicates in the service query rather than filtering results after retrieval.
- Build diagnostic rows exclusively through a typed serializer with key and value allowlists, length limits, array limits, and URL/secret/hash/reference deny rules.
- Store source destination as a category such as `chatgpt_attachment` or `minio_internal`, with an allowlisted hostname only where operationally necessary.
- Never store raw error objects, serialized request/response bodies, SQL, headers, environment values, filenames, storage keys, MIME payloads, account data, or public financial amounts.
- Emit diagnostic MCP responses with `cache-control: no-store` through the existing transport behavior.

## Actionable Error Catalog

Create a central catalog keyed by stable error code. Each entry defines:

- public message;
- suggested action;
- retryability;
- review requirement;
- optional diagnostic persistence override.

Existing `DomainError` semantics remain authoritative when stricter. Unknown exceptions map to `INTERNAL_ERROR`, advise retrying once and then inspecting the correlation ID, and always persist a diagnostic. Error catalog changes require tests proving that no sensitive source error text reaches the public response.

## Retention and Operations

Retention is 30 days. Add a Bun maintenance command that deletes expired diagnostic rows in bounded batches and reports only counts/duration to stdout. Run it from a documented scheduled job or deployment-side cron; do not run an unbounded delete on every MCP request.

Operational documentation must cover:

- querying a failure from ChatGPT by correlation ID;
- checking recent failures with bounded filters;
- interpreting categories and failure classes;
- confirming the retention job;
- fallback inspection through structured container logs;
- escalation when diagnostic persistence itself is unavailable.

No production tool may expose arbitrary SQL or Docker logs.

## Failure Behavior

- Diagnostic scope creation failure: continue with the MCP request and structured stdout only.
- Breadcrumb serialization rejection: drop the unsafe breadcrumb, add a safe rejection marker, and continue.
- Diagnostic insert failure: emit safe stdout fallback and preserve the original MCP error.
- Diagnostic read authorization failure: return forbidden without confirming whether a correlation ID exists.
- Missing/expired correlation ID: return `DIAGNOSTIC_NOT_FOUND` with a safe explanation of 30-day retention.
- Diagnostic read subsystem failure: return a generic diagnostic-unavailable response and do not recursively log into the same table.
- Public error catalog miss: return `INTERNAL_ERROR` with correlation ID and persist the classified diagnostic.

## Plugin and Contract Synchronization

Adding two MCP tools and changing the common error envelope requires synchronized updates to:

- backend MCP tool names, schemas, handlers, annotations, and metadata tests;
- generated frozen MCP contract;
- private plugin manifest/version and changelog;
- CreditSync and recovery skill guidance;
- executable evals for actionable errors, authorized diagnostic follow-up, tenant/role denial, expired diagnostics, and redaction;
- plugin validator expectations and tool-count assertions.

Agent guidance should call `system.error-diagnostic.get` automatically only when an error is unexpected, retryable without a clear cause, an integration failure, or repeated after the suggested action. It must not use diagnostics to bypass confirmation, duplicate, mismatch, stale-state, or financial safety boundaries.

## Verification

Tests must prove:

- migration shape, constraints, indexes, tenant isolation, and 30-day expiry;
- breadcrumb bounds, typed serialization, truncation, and comprehensive sensitive-field rejection;
- classification and actionable public mapping for known and unknown errors;
- persistence inclusion/exclusion policy and stdout fallback when persistence fails;
- original errors remain unchanged when logging fails;
- exact owner/manager access and collector/viewer/cross-tenant denial;
- strict `get`/`list` input, pagination, bounded time windows, safe outputs, and read-only annotations;
- no recursive diagnostic writes from diagnostic read failures;
- ChatGPT attachment, MinIO, database, cache, and generic handler failures produce useful safe stages;
- no financial state changes result from diagnostics or diagnostic reads;
- frozen contract, plugin skills, evals, version, and validator stay synchronized;
- disposable PostgreSQL tests, backend unit/integration tests, backend typecheck, plugin tests/validator, and `git diff --check` all pass.

## Rollout

1. Deploy the migration and backend diagnostics together.
2. Verify the table, indexes, MCP health, and owner/manager authorization without creating financial records.
3. Trigger a controlled non-financial known failure and confirm it returns actionable text without persistence when excluded by policy.
4. Trigger a controlled non-financial integration test failure, confirm one diagnostic row, query it through `system.error-diagnostic.get`, and verify redaction.
5. Enable the daily expiry job and confirm bounded deletion using expired synthetic diagnostic rows only.
6. Monitor diagnostic counts and persistence fallback events before relying on the tool for incident response.

## Success Criteria

- A normal operator sees an understandable next action for every known MCP error.
- An authorized ChatGPT agent can inspect an eligible failure by correlation ID and identify the failing stage without accessing raw logs or secrets.
- Expected business rejections do not flood persistent diagnostics.
- Diagnostic subsystem failures never alter financial state, mask the original error, or broaden authority.
- Stored diagnostics expire after 30 days and remain tenant-isolated throughout their lifecycle.
