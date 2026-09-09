# CreditSync Agent, Remote MCP, and Plugin 1.0.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:test-driven-development` for every behavior change. Preserve all pre-existing working-tree changes and never reset them.

**Goal:** Make CreditSync's borrower, payment, loan, reversal, and daily-loan renewal workflows available through the web API and a private HTTPS MCP server, then package the workflows as CreditSync Plugin 1.0.0.

**Architecture:** Elysia REST routes and the MCP adapter run in the existing backend process but call shared application services directly. PostgreSQL is the source of truth, MinIO stores optional evidence, financial events are append-only, and MCP uses stateless Streamable HTTP with private bearer authentication.

**Tech stack:** Bun, TypeScript, Elysia, Drizzle/PostgreSQL, MinIO/S3, Dragonfly, React/Vite, `decimal.js`, MCP TypeScript SDK 1.x, Zod 4.

## Global Constraints

- Work on branch `codex/creditsync-agent-mcp`; preserve the dirty v0.2.4 baseline and unrelated user changes.
- Use Bun commands and update root `CHANGELOG.md` with explicit CreditSync `v0.3.0` content in every implementation commit. Update `README.md` in commits that change workflows, configuration, deployment, or user-facing features.
- Public money values are two-decimal strings; all business calculations use Decimal, never binary floating point.
- Business timezone is `Asia/Bangkok`; due dates are `YYYY-MM-DD`, timestamps ISO 8601.
- External interfaces expose UUID public IDs, not numeric database IDs.
- Web and MCP call the same application services; MCP must not call REST internally.
- Slips are optional. The agent extracts image/QR data; the backend does not invoke OCR/AI for this workflow.
- Funding sources are read-only through MCP.
- Posted financial entries and audit logs are append-only. Corrections use compensating reversal records.
- New/changed user copy must be added to both Thai and English locale files.

---

### Task 1: Baseline typecheck and exact money kernel

**Deliverable:** A green backend typecheck gate and Decimal-based daily-loan/payment primitives.

- Add a backend TypeScript config and scripts that typecheck project sources with Bun types and skip third-party declaration noise; fix the existing source-level errors surfaced by that gate without changing business behavior.
- Add `decimal.js` and money helpers that parse non-negative two-decimal public money strings, quantize with half-up rounding, sum safely, and serialize with exactly two decimals.
- Replace the borrower-loan schedule calculation path with Decimal math while preserving supported repayment types.
- For daily fixed-installment terms, accept principal, installment amount, and total installments. `2500.00`, `190.00`, `15` must yield principal `166.67` for installments 1-14, `166.62` for installment 15, interest `23.33` for 1-14, `23.38` for 15, and total `2850.00`.
- Add allocation primitives that apply money oldest schedule first in order penalty, fee, interest, principal; support partial and advance payments without over-allocation.
- Tests must be written first and observed failing for parsing, rounding, the exact daily schedule, partial allocation, advance allocation, zero/invalid input, and sum conservation.
- Verify `bun test`, `bun run typecheck`, and the existing frontend build.

### Task 2: Agent workflow schema, migration, and audit foundation

**Deliverable:** Additive Drizzle schema and migration supporting aliases, intakes, matching, evidence, reversals, renewals, and append-only history.

- Add `borrower_aliases`, `payment_intakes`, `payment_evidence`, `payment_match_proposals`, `payment_match_allocations`, `loan_renewals`, and `loan_adjustments` with tenant IDs, UUIDv7 public IDs, timestamps, actor fields, and the status fields required by the product spec.
- Extend transactions with payment intake, entry type (`repayment|reversal`), reversed transaction reference, idempotency key, and posted timestamp. Extend audit logs with actor source, request ID, and correlation ID.
- Add tenant-scoped uniqueness for operation/idempotency keys, borrower-normalized aliases, bank-reference hashes, QR hashes, evidence hashes, and one reversal per original transaction. Same alias on different borrowers remains legal.
- Add an audit-log trigger rejecting update/delete.
- Backfill a posted `legacy` payment intake for every existing transaction and evidence rows for legacy slip references without dropping old columns. Existing active loans and schedules remain unchanged.
- Add schema/migration tests against a disposable PostgreSQL database when `TEST_DATABASE_URL` is set; unit tests must still run without that environment variable.

### Task 3: Shared borrower and loan application services

**Deliverable:** REST-safe services and draft-first loans with immutable activation.

- Define `CommandContext` with tenant, actor user, actor source (`web|mcp|system`), request ID, correlation ID, and optional idempotency key; define stable domain errors and public presenters.
- Add borrower service operations for normalized search, create/update, portfolio, alias add/confirm/deactivate, and complete before/after audit history. Normalize with Unicode NFKC, collapsed whitespace, lowercasing where applicable, and punctuation removal while preserving original text.
- Exact canonical/confirmed-alias resolution may return a unique borrower; duplicate exact aliases return candidates and never auto-resolve. Fuzzy search only ranks candidates.
- Add loan preview, draft creation/update, and activation services. Activation locks terms, creates schedules once, and is idempotent. Existing active loans are compatible.
- Refactor borrower and loan REST routes to call these services. `POST /loans` creates a draft; `POST /loans/:id/activate` locks and activates it.
- Add integration tests for tenant/owner visibility, alias ambiguity, audit context, draft editing, activation idempotency, and active-term immutability.

### Task 4: Payment intake, evidence, matching, posting, and reversal

**Deliverable:** Complete data-only/image-first payment workflow, including grouped allocation and corrections.

- Add payment intake create/list/get/review operations. Statuses are `draft|needs_review|ready|posted|reversed|duplicate`.
- Hard duplicates are tenant-scoped operation/idempotency, normalized bank-reference hash, QR-payload hash, or evidence SHA-256. Return the existing intake public ID instead of creating a second intake. Similar amount/time/name is a warning only.
- Add signed MinIO PUT preparation and finalize operations. Validate MIME type (`image/jpeg`, `image/png`, `application/pdf`), declared size, SHA-256, object existence, tenant ownership, and expiry. Never log raw QR/slip/identity data.
- Add versioned match previews. Explicit allocations are ready only when their sum equals the intake. Automatic matching is ready only for one uniquely confirmed borrower/name and one uniquely exact obligation. Everything fuzzy, duplicated, ambiguous, or mismatched needs review.
- Support one intake across multiple borrowers, loans, and schedules. Before post, lock intake/loans/schedules, recompute against the latest state, and reject stale proposals.
- Posting writes one immutable transaction per loan allocation and updates schedule/loan/fund rollups atomically. Reversal writes compensating entries; retrying a reversal returns the existing reversal.
- Expose REST endpoints for intake, evidence upload intent/finalize, preview, post, review queue, and reversal while retaining legacy transaction reads.
- Tests first: data-only, hard duplicates, semantic warning, explicit split, unique exact match, ambiguous nickname, partial/advance payment, mismatch, stale preview, concurrent/double post, reversal, and double reversal.

### Task 5: Daily-loan renewal services and REST workflow

**Deliverable:** Preview/confirm/execute/reverse renewal with exact principal recovery.

- Preview computes principal actually paid, outstanding principal, due interest/fees/penalties, requested new principal, settlement/waiver choices, and cash direction/amount. It stores a versioned preview hash and expiry.
- Ten fully paid installments in the `2500/190/15` example produce paid principal `1666.70`, old outstanding principal `833.30`, and cash payout `1666.70` for a new `2500.00` loan when no charges are due.
- Execute requires the preview public ID/hash, explicit confirmation, reason, and idempotency key. Lock/recompute the old loan and reject stale previews. Set old loan to `renewed`, create/activate the new loan and fresh schedule, carry old funding allocations proportionally, and record cash payout plus settlement/waiver events without treating non-cash principal transfer as borrower cash.
- Reverse is append-only and permitted only after downstream transactions on the new loan are reversed. It cancels the new loan through compensating records and restores the old loan state.
- Add REST preview/execute/reverse endpoints and audit records.
- Tests first for the exact example, partial principal paid, settle-from-payout, waived charges requiring reason, stale preview, insufficient funding allocation, idempotent execute, blocked reverse, and successful reverse.

### Task 6: Private stateless Remote MCP server

**Deliverable:** Authenticated `/mcp` in the existing Elysia/Bun backend using shared services.

- Use stable MCP TypeScript SDK 1.x, Zod 4, and `WebStandardStreamableHTTPServerTransport` in stateless mode. Build a fresh server/transport per request; do not add legacy SSE, server sessions, generic SQL, arbitrary fetch, or MCP funding writes.
- Authenticate bearer tokens by SHA-256 against `MCP_API_TOKEN_HASHES` using constant-time comparison. Resolve actor only from `MCP_TENANT_ID` and `MCP_ACTOR_EMAIL`; clients cannot choose identity. Accept two hashes for rotation.
- Validate `MCP_ALLOWED_HOSTS`, add Dragonfly-backed rate limiting with safe in-memory fallback, request/correlation IDs, sanitized structured logs, and a non-sensitive health endpoint.
- Register all named tools from the product plan: borrower search/portfolio/create/update/alias; intake get/list/create; evidence prepare/finalize; payment preview/post/reverse; loan preview/draft/activate; renewal preview/execute/reverse; funding-source list.
- Every tool uses public IDs, money strings, Zod input/output, `schemaVersion: "1.0"`, concise text plus structured content, safe annotations, and stable sanitized errors `{code,message,retryable,reviewRequired,details}`. Financial writes return audit and correlation public IDs.
- Update environment examples, backend compose configuration, and Nginx `/mcp` proxy with buffering disabled and MCP headers/timeouts preserved.
- Contract tests must initialize, list/call tools, validate auth/host/schema failures, verify no cross-tenant identity input, and test idempotent retries.

### Task 7: Web workflows and localization

**Deliverable:** Human review/confirmation surfaces matching the service behavior.

- Add a Payment Inbox/Review workflow with statuses, duplicate warnings, optional evidence, allocation editor, preview differences, post confirmation, and reversal action.
- Add borrower alias management and revision-history display.
- Update loan creation to preview/draft/activate and add a daily-renewal dialog showing recovered principal, old outstanding, charges, waivers, cash payout, new schedule, and explicit confirmation.
- Show audit/correlation IDs on relevant detail views.
- Add all copy to both Thai and English locale files and format currency/dates using active i18n language.
- Add focused component/flow tests where test infrastructure permits; always run frontend lint and production build.

### Task 8: CreditSync Plugin 1.0.0, evals, documentation, and release verification

**Deliverable:** Private repository plugin package and complete release gates.

- Create `plugins/creditsync/.codex-plugin/plugin.json`, `.app.json`, assets, README, changelog, and skills named `creditsync`, `manage-borrowers`, `reconcile-payments`, `manage-loans`, and `renew-daily-loan`.
- Root skill enforces inspect-before-write, use of preview tools instead of agent arithmetic, safe handling of duplicate/stale/review states, and tool availability checks. Focused skills orchestrate services but never reproduce formulas.
- Add `.agents/plugins/marketplace.json`. Do not add `.mcp.json`, hooks, UI, OAuth, public submission metadata, or secrets. `.app.json` contains a placeholder private technical app ID documented for replacement after private registration.
- Package version is `1.0.0`; freeze tool names and schemas. Add executable/static validation for manifests, skill discovery, references, missing secrets, and marketplace paths.
- Add eval prompts covering positive borrower/alias, data-only payment, slip payment, split loans/borrowers, intermediary, partial payment, renewal, and reversal; negative ambiguity, mismatch, duplicate, active-term edit, unsettled renewal charges, and unauthorized access.
- Update root README/CHANGELOG for v0.3.0, deployment, token generation/rotation, MinIO evidence, MCP connection, plugin installation, backup/recovery, and operational rollback.
- Final gates: backend test/typecheck, migration integration test when DB is available, frontend lint/build, MCP contract tests, plugin validation, secret/PII log scan, and focused whole-branch code review.
