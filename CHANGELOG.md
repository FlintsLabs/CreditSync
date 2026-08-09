# Changelog

## v0.3.4 - 2026-08-10

### Added
- Added CreditSync Plugin `1.0.0` with a private app manifest, repository marketplace, five sequentially tested workflow skills, matching/financial/error references, and positive/negative eval contracts.
- Added executable plugin validation for manifest discovery, frozen MCP tool names, marketplace paths, forbidden deferred capabilities, eval coverage, and common secret patterns.
- Added deployment, Cloudflare HTTPS MCP, bearer rotation, MinIO evidence, private registration, backup/restore, reconciliation, and operational rollback documentation.

### Changed
- Documented application release `v0.3.4` as the truthful integration release while retaining the plugin's independent `1.0.0` contract and the existing frozen MCP schema version `1.0`.
- Documented that the committed private-app technical ID is a non-runnable registration placeholder and that live installation/authentication remains an operator step.

### Fixed
- Preserved stable REST and MCP drawdown-capacity errors for already-overallocated legacy states by reporting zero allocatable remaining capacity without weakening atomic rejection or rollback.
- Serialized draft-loan activation on its tenant funding drawdown and rejected exact Decimal principal allocations beyond the signed net remaining capacity, with atomic rollback for serial and concurrent conflicts.
- Kept persisted payment-intake review warnings inside the frozen MCP 1.0 output schema so real default-adapter posting, retrieval, and reversal calls remain valid after the web review changes.
- Hardened Plugin `1.0.0` with a deterministic full `tools/list` metadata snapshot and executable scripted-MCP evals covering exact call order/arguments, repeated alias operations, duplicate/stale/review/unauthorized stops, confirmation, reversal, idempotency, and forbidden upload/write effects.
- Accepted real registered private-app technical IDs without weakening the documented non-live placeholder state, and corrected duplicate-evidence and renewal-reversal orchestration to match the frozen MCP surface.
- Corrected operator guidance so bearer hashes exclude trailing newlines, MinIO recovery preserves and verifies evidence metadata/checksums, and disabling MCP does not take the shared REST backend offline.
- Corrected Plugin `1.0.0` renewal reversal to retain borrower identity before execution, derive renewal/old/new loan IDs from the same-task execute result, inspect only portfolio-exposed loan states, and rely on the atomic backend reversal command to return downstream blockers safely.
- Aligned Plugin `1.0.0` blocked-renewal behavior with the real sanitized backend error: `RENEWAL_REVERSE_BLOCKED`, its backend message, and aggregate `downstreamEntryCount` only, without invented transaction or adjustment identities.

## v0.3.3 - 2026-08-10

### Added
- Added persisted semantic-duplicate review warnings and a required, audited reason for payment reversals across REST, MCP, and the web review flow.
- Added Vitest/jsdom component coverage for payment splits, warning gates, intake-selection races, reversal confirmation, exact loan-term handoff, borrower alias/history states, and renewal retry idempotency.

### Changed
- Changed manual payment entry to create a review-first intake, allowing evidence and explicit multi-loan allocations to be reviewed before posting.
- Restored recommended frontend lint severities globally and confined unavoidable legacy React/TypeScript exceptions to explicit existing files.
- Recorded the independent-review fix matrix and final verification evidence in the Task 7 implementation report.

### Fixed
- Preserved identical user-entered daily-loan terms from preview through draft creation instead of deriving fixed terms from rounded preview rows.
- Preserved exact public money strings in confirmation displays, retained payment preview baselines, ignored stale intake responses, and reused renewal execution/reversal keys for retries of the same intent.
- Distinguished loading, empty, forbidden, and failed audit states; localized workflow domain errors and audit actions; and displayed renewal interest, fee, and penalty components separately.
- Bound ready payment proposals to the exact allocation-editor revision, invalidating them on every edit/add/remove/selection change and discarding stale in-flight preview responses before Post can reappear.
- Preserved the frozen MCP schema-version 1.0 `payment.reverse` input by keeping `reason` optional and supplying a stable audit reason for legacy clients, while REST/web reversals continue to require an operator reason.
- Caught manual Payment Inbox refresh failures and announced the localized error without leaving the refresh control busy.

## v0.3.2 - 2026-08-10

### Added
- Added localized Payment Inbox review surfaces for duplicate status, signed evidence, explicit allocation previews and differences, posting, reversal, and audit/correlation identifiers.
- Added borrower alias confirmation/deactivation with revision history, explicit loan draft activation, and daily-renewal previews covering recovered principal, charges, waivers, cash movement, replacement schedules, confirmation, and reversal.
- Added focused Bun tests for exact-money workflow DTOs, payment create-preview-post ordering, duplicate short-circuiting, and renewal idempotency headers.

### Changed
- Migrated the manual repayment form from the disabled legacy transaction write to the payment-intake create, explicit-preview, and post workflow.
- Updated Thai and English workflow copy together and formatted workflow money and dates with the active application locale.
- Aligned the frontend lint gate with the existing non-Compiler React codebase while retaining strict TypeScript production builds.

## v0.3.1 - 2026-08-10

### Added
- Added the approved Connected Capital design specification for the CreditSync favicon and PWA app icon asset set.
- Added the implementation plan and ignored local workflow directories for isolated favicon development.
- Added the Connected Capital SVG favicon, browser PNG variants, Apple touch icon, and PWA manifest assets to the frontend.

## v0.3.0 - 2026-08-09

### Added
- Added a Decimal-based money kernel, exact daily fixed-installment schedule generation, and oldest-first repayment allocation primitives.
- Added a Bun-backed backend TypeScript typecheck gate and focused money-kernel tests.
- Added the v0.3.0 agent-workflow data foundation for borrower aliases, payment intake/evidence matching, transaction reversals, loan renewals and adjustments, tenant-scoped idempotency, and append-only audit history.
- Added shared borrower and loan-application services with normalized alias search, public-ID presenters, command-context audit metadata, borrower portfolios, editable loan drafts, previews, and idempotent activation.
- Added the complete payment-intake workflow: data-only capture, signed S3/MinIO evidence PUTs and verified finalization, hard-duplicate idempotency, semantic warnings, deterministic/explicit grouped matching, review queues, atomic posting, and compensating reversal.
- Added the daily-loan renewal workflow with versioned expiring previews, exact posted-principal recovery, charge settlement or reasoned waiver, confirmed idempotent execution, proportional funding carry-forward, fresh schedules, and append-only reversal.
- Added the private stateless Remote MCP server with 20 versioned borrower, payment, evidence, loan, renewal, and read-only funding-source tools backed directly by shared application services.
- Added SHA-256 bearer-token rotation, fixed tenant/actor principals, host allowlisting, Dragonfly-backed rate limiting with a safe local fallback, sanitized correlation logging, and an MCP health check.
- Added PostgreSQL and Dragonfly regression coverage for exact schedules and activation rollups, concurrent activation, the authenticated draft lifecycle, public funding DTOs, mutation audits, duplicate aliases, and cache invalidation, including large-value monthly, weekly, and daily money cases.

### Changed
- Loan creation is now draft-first: `POST /loans` stores editable terms without a schedule, while `POST /loans/:id/activate` locks the terms and creates the schedule once. The current web wizard performs both steps to preserve its existing confirm-and-create flow.
- Borrower and loan-application REST adapters now delegate to the shared services and use public UUID identifiers at their external command boundaries.
- Payment REST adapters now delegate to the shared payment application service and use UUID command boundaries and exact money strings; legacy `GET /transactions` remains readable while legacy repayment writes return 405 so all balance mutations share one Decimal allocator and lock order.
- Renewal REST adapters now expose preview, execute, and reverse commands under `/loan-renewals`, with UUID identifiers, exact money strings, explicit confirmation/reason fields, and required execution/reversal idempotency keys.
- Production Nginx and backend Compose configuration now expose `/mcp` with streaming-safe proxy settings, preserved MCP/auth/correlation headers, and explicit private MCP environment configuration.
- Loan schedule, closing, allocation-state, profitability, funding-allocation, and funding-reallocation REST payloads now expose public UUIDs and two-decimal money strings; funding mutations accept public funding UUIDs and money strings.
- Updated the loan detail, matching, and closing frontend flows for the exact public loan DTOs.

### Fixed
- Hardened the v0.3.0 MCP contract with signed compensating-transaction outputs, PostgreSQL-backed actual-client coverage for all 20 default service mappings, and quota-preserving Dragonfly-to-memory fallback.
- Hardened daily-loan renewals with exact integer-cent funding carry, shared loan-first funding locks, execution-time preview validation, tenant-safe funding provenance, stable concurrent idempotency, exact old-loan state restoration, and operation-scoped reversal replay protection.
- Corrected backend source typing issues surfaced by the new typecheck gate without changing existing workflow behavior.
- Restored bank-loan close timestamp persistence after repayment and hardened daily installment, public schedule-money, and allocation due-date validation.
- Aligned the loan wizard and create API with the two-decimal public-money contract from schedule calculation through loan creation.
- Enforced tenant-safe workflow relationships and reversal references in PostgreSQL, while hardening migration idempotency, uniqueness, and full financial-state preservation tests.
- Conserved principal, interest, fees, row totals, and remaining due across daily, weekly, and monthly schedules, including non-even final installments and values above JavaScript's safe-integer range, by carrying canonical money strings through schedule generation and activation rollups.
- Mapped routine borrower and loan authorization, visibility, state, and duplicate-alias failures to stable domain error codes and statuses.
- Restored tenant cache invalidation after borrower updates so cached loan lists immediately reflect borrower-name changes.
- Serialized payment preview/post/reversal state transitions with PostgreSQL row locks, rejected and marked stale proposals after concurrent balance changes, and kept schedule, loan, transaction, fund-ledger, and audit effects atomic and append-only.
- Persisted exact signed-evidence expiry, hardened delayed signing/finalization races, attributed fund effects only to net economic funded shares, and restored exact schedule/loan lifecycle state on posting and reversal.
- Derived renewal principal from posted non-reversed transaction components instead of cached balances, rejected stale or underfunded executions under PostgreSQL locks, and separated non-cash principal transfer from borrower cash adjustments.

## v0.2.4 - 2026-08-09

### Changed
- Updated backend and frontend dependencies to their latest compatible releases, including the current major releases of Redis, LINE SDK, Google Auth, Vite, ESLint, and Tailwind CSS.
- Migrated the frontend PostCSS, Tailwind, TypeScript, and Vite configuration for the updated toolchain.

## v0.2.3 - 2026-05-11

### Added
- Added a personal lending control center roadmap focused on owner-only daily operations, bot inbox usage, reconciliation, documents, traceability, and export.
- Loan closing now copies a ready-to-send payoff message instead of only copying the raw balance.

### Fixed
- New borrower loans now initialize outstanding principal, interest, fees, and next due date from the generated schedule immediately after creation.
- Generated borrower loan schedules now explicitly start with `paid_total = 0.00`.

## v0.2.2 - 2026-04-08

### Changed
- Borrowers, loans, transactions, and uploaded files now carry an owner user so non-admin accounts can be scoped to their own records.
- Tenant admins (`owner`, `manager`) keep tenant-wide visibility while `collector` and `viewer` accounts are restricted to their own portfolio data.
- Auto-created Google users now become `viewer` by default unless they are the first user in the tenant.

### Fixed
- Dashboard, fund, reconciliation, and audit APIs are now blocked for non-admin roles instead of exposing tenant-wide financial data.
- Frontend navigation now hides admin-only sections for non-admin users and avoids loading admin-only loan metrics in personal views.

## v0.2.1 - 2026-04-07

### Changed
- File uploads now persist internal storage references and resolve to time-limited signed URLs at read time instead of storing permanent public object links.
- Backend storage access now supports S3-compatible presigned URLs by default and can be configured for Azure Blob SAS links through environment variables.
- Frontend resource routes now use first-level paths such as `/funds/:id`, `/borrowers/:id`, and `/loans/:id` instead of nesting everything under `/dashboard`.
- Core URL-facing entities now carry `public_id` UUIDv7 identifiers for cleaner external URLs while preserving internal numeric keys.

### Fixed
- Borrower ID-card images, reconciliation upload evidence, and repayment slip links no longer depend on indefinitely public object URLs.
- Production-style Nginx and env defaults now route signed file URLs through `/files/*` to MinIO instead of the app root.
- Docker tunnel services now join the application network instead of host networking, so Cloudflare ingress can target `frontend`, `backend`, and `minio` by service name.

## v0.2.0 - 2026-04-07

### Added
- Funding source, drawdown, repayment schedule, and fund repayment workflows.
- Matching workspace for allocating one loan across multiple drawdowns and reallocating later.
- Operational dashboard with due queues, alerts, reconciliation status, and profitability widgets.
- Loan detail, profitability, allocation-state, and related backend summary APIs.
- Manual reconciliation workflow for borrower payments, fund repayments, and uploaded evidence.
- Overdue and penalty calculation support for borrower and fund schedules.
- Dragonfly cache integration for read-heavy backend endpoints with tenant-scoped invalidation.

### Changed
- Split Docker flow into production-style infra and app compose files, with Dragonfly added to infra.
- Frontend and backend dashboards now rely on live APIs instead of mock-first summaries in key areas.
- Repository docs now describe local dev, production-style Docker flows, and cache configuration.

### Fixed
- Reconciliation dashboard semantics aligned with actual bank repayment records.
- Fund detail deep-link behavior no longer forces users back to the originally targeted drawdown.
- Cache usage is fallback-safe when Dragonfly is unavailable.
