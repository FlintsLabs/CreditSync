# Changelog

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
