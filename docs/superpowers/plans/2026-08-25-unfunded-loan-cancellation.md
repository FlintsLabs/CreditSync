# Unfunded Loan Cancellation Implementation Plan

**Goal:** Add a preview/execute unfunded-loan cancellation workflow through REST and CreditSync MCP with append-only audit and strict no-funding/no-posted-payment guards.

**Architecture:** A dedicated cancellation service owns eligibility, preview persistence, stale-state checks, idempotent execution, and atomic loan/schedule updates. REST and MCP call the same service and expose closed DTOs.

## Tasks

1. Add `loanCancellationPreviews` schema, migration, indexes, checks, and migration contract test.
2. Implement the service with decimal-safe disbursement totals, eligibility guards, persisted preview, stale checks, idempotent execution, atomic status/rollup/schedule updates, audit, and cache invalidation.
3. Expose REST preview and execute routes with closed request schemas and command context.
4. Register MCP handlers, schemas, annotations, descriptions, frozen contract, skills, evals, and validator coverage.
5. Run focused tests, disposable PostgreSQL verification, typechecks, plugin tests/validator, changelog/docs review, and final diff checks.

## Constraints

- Money is represented as exact two-decimal strings and calculated with `decimal.js`.
- Use tenant filters, actor/request/correlation context, idempotency, and append-only audit history.
- Never delete or mutate posted financial history.
- Execute only an unchanged explicitly confirmed preview.
- Do not merge or deploy without explicit authorization.
