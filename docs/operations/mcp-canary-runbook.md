# MCP optimization canary runbook

This runbook is a measurement and rollback procedure. Local tests and the official conformance fixture do not constitute staging, production, or mobile acceptance. Do not put borrower identity, public record IDs, file IDs, URLs, checksums, or raw tool arguments in metrics.

## Before enabling profiles

1. Verify the generated tool contract, its count, and profile snapshots at the deployed feature revision. `/mcp` remains the full legacy endpoint; profiles are discovery conveniences, not authorization scopes.
2. Keep `MCP_ALLOWED_ORIGINS` as exact origins. Confirm absent Origin is allowed for non-browser clients and unexpected, `null`, malformed, or configured-but-unlisted origins are rejected before body parsing. Confirm Host, bearer, and rate limits independently.
3. Capture a baseline from the same host class and connection population: legacy full-list bytes/time/tool count; modern complete paginated bytes/time/page count/tool count; schema-generation count; and status-class counts. Timing is informational until compared with a matched baseline.
4. Confirm the retention owner, alert destination, previous image/plugin snapshot, PostgreSQL/MinIO backups, and the endpoint kill switch before any canary writes.

## Measurements

Use bounded, low-cardinality labels only: `era`, `profile`, `operation_class`, `status_class`, and `failure_category`. Record p50 and p95 request latency for discovery, call validation, and safe reads. For discovery record complete traversal, not only page one:

- bytes, milliseconds, page count, and tool count for cold and warm modern traversal;
- legacy full-list bytes, milliseconds, and tool count;
- cached schema projection hits and module-load schema-generation count; every request must add zero schema-generation calls;
- profile usage and out-of-profile/invalid-cursor counts;
- rejected Origin, Host, bearer, protocol-version, method, and name-mismatch counts;
- evidence workflow stops by category and mobile import `ready`, `pending`, `review_required`, or failure category plus time-to-ready bucket.

Do not cache tool-call results. Public cache hints apply only to authorization-independent definition discovery. Export sanitized counters before rotating logs; retain the raw operational sample for at least one major release and 30 days after profiles launch.

## Canary sequence and stop conditions

1. Enable read-only canary traffic on one authorized route and compare complete discovery and validation measurements with baseline.
2. Verify one representative workflow per advertised profile using synthetic/disposable data where it writes. Confirm dependencies are present, core-read performs no mutation, and profile selection cannot alter tenant/actor authorization.
3. Keep financial writes disabled until error-after-commit audit lookup, idempotent retry, evidence stop, and recovery observations are reviewed. Never use a missing evidence attachment as a reason to bypass the workflow.
4. Stop the canary for any unexpected origin/header acceptance, tenant/actor mismatch, unknown-tool service invocation, schema-generation regression, duplicate/reordered discovery tool, audit/recovery loss, financial side effect from core-read, or evidence workflow that proceeds after a stop condition.

Rollback disables MCP ingress or routes clients to the previously verified endpoint/image while preserving the database and object store. Do not edit/delete posted records or down-migrate. Reconcile sanitized request counts and financial/audit totals before reopening writes.

## Retention and removal

Retain `/mcp` full-endpoint compatibility for at least one major release and 30 days after profiles launch. It may be removed only after zero measured usage for 30 consecutive days, a successful client migration with recorded verification, and explicit release approval. Keep profile and mobile canary records for the same retention window.

## Runtime and mobile status

No staging/production canary is claimed by this branch. Real ChatGPT iOS/Android attachment transport, app-version compatibility, and connection-specific file handoff remain pending. Execute [`chatgpt-mobile-evidence.md`](./chatgpt-mobile-evidence.md) separately for payment and payout using synthetic files; automated fixtures do not establish real-device support.
