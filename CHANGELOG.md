# Changelog

## v0.3.0 - 2026-08-09

### Added
- Added a Decimal-based money kernel, exact daily fixed-installment schedule generation, and oldest-first repayment allocation primitives.
- Added a Bun-backed backend TypeScript typecheck gate and focused money-kernel tests.
- Added the v0.3.0 agent-workflow data foundation for borrower aliases, payment intake/evidence matching, transaction reversals, loan renewals and adjustments, tenant-scoped idempotency, and append-only audit history.
- Added shared borrower and loan-application services with normalized alias search, public-ID presenters, command-context audit metadata, borrower portfolios, editable loan drafts, previews, and idempotent activation.

### Changed
- Loan creation is now draft-first: `POST /loans` stores editable terms without a schedule, while `POST /loans/:id/activate` locks the terms and creates the schedule once. The current web wizard performs both steps to preserve its existing confirm-and-create flow.
- Borrower and loan-application REST adapters now delegate to the shared services and use public UUID identifiers at their external command boundaries.

### Fixed
- Corrected backend source typing issues surfaced by the new typecheck gate without changing existing workflow behavior.
- Restored bank-loan close timestamp persistence after repayment and hardened daily installment, public schedule-money, and allocation due-date validation.
- Aligned the loan wizard and create API with the two-decimal public-money contract from schedule calculation through loan creation.
- Enforced tenant-safe workflow relationships and reversal references in PostgreSQL, while hardening migration idempotency, uniqueness, and full financial-state preservation tests.

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
