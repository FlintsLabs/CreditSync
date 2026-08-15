# Production loan list schema compatibility

## Problem

Production `GET /api/loans` fails with PostgreSQL `42703` because the ORM expands the full `loans` table selection, including floating-interest columns that are not present in the deployed production schema. The frontend catches that failure but leaves the list empty, so it incorrectly renders the normal empty state.

## Approved scope

- Make the loan-list query select only the fields required by the list response and payment-health calculation that exist in production.
- Preserve tenant/access filters, borrower aliases/tags, exact decimal serialization, and existing response shape.
- Render a localized load-error state instead of the normal empty state when the request fails, with a retry action if consistent with existing UI patterns.
- Add regression tests using TDD and update Thai and English translations together.
- Update `CHANGELOG.md` under a new explicit version/date heading before committing.

## Safety constraints

- Do not run database migrations or alter production financial data.
- Do not modify loan calculations, lifecycle behavior, immutable records, or public money handling.
- Do not touch unrelated dirty files or the separate sidebar worktree.
- Do not push. Integration target is local `main`; deployment is handled by the supervising agent after independent verification.

## Acceptance criteria

1. The backend loan-list query no longer references absent floating-interest columns merely because Drizzle expands `loans`.
2. Existing loan list fields, borrower labels, access rules, and payment-health behavior remain intact.
3. A failed loan-list request displays a localized error state and does not display the no-loans state.
4. Backend regression tests and typecheck pass; frontend tests, lint, and build pass.
5. The commit includes the matching changelog entry.
