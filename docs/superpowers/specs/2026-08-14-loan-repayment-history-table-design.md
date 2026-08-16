# Loan Repayment History Table Design

## Goal

Present Loan Detail repayment history as the same compact shadcn-style table used by the repayment schedule on every viewport, replacing the separate mobile flat-list branch.

## Scope

- Change only the non-empty repayment-history presentation in `LoanRepaymentHistory` and its focused frontend tests.
- Reuse the shared shadcn table primitives already introduced for the repayment schedule.
- Preserve fetching, ordering, exact money formatting, statuses, record capture, errors, empty state, and payment-review navigation.
- Do not change backend, API contracts, payment allocation, financial records, or production data.

## Design

Render one semantic table at all breakpoints with six columns: received date/time, received amount, bank reference, allocation, status, and details action. The table uses a minimum width inside the shared responsive overflow wrapper, so narrow screens scroll horizontally instead of switching to cards or flat rows.

Rows use the same divider, muted header, compact mobile padding, relaxed `sm` padding, right-aligned tabular money, and status badges as the repayment schedule. The details column contains a compact outline button that opens the same payment review route. API row order is unchanged.

## Allocation Presentation

For posted records, show only non-zero principal, interest, fee, and penalty components in source order, using `Decimal` for exact zero checks and `formatMoneyExact` for display. If there are no non-zero posted components, show the latest allocation when present; otherwise show an em dash. This avoids noisy zero components while preserving the useful fallback.

## Responsive and Accessibility Behavior

- Use native `table`, `thead`, `tbody`, `tr`, `th`, and `td` semantics through shared primitives.
- Use the existing localized column and action strings.
- Keep amounts, references, badges, and action labels from wrapping where that improves scanability.
- Remove the separate `md:hidden` button list and `ChevronRight`; the details button remains keyboard accessible.

## Verification

Update focused component coverage to assert one semantic table, localized column headers, exact received amount, reference, non-zero allocation components, absence of zero components, status, and details navigation. Assert the old `mobile-repayment-row` branch no longer exists. Run focused and full frontend tests, lint, production build, and whitespace checks.

## Non-goals

- Pagination, sorting, filtering, or search.
- Inline editing or financial posting changes.
- A mobile-specific alternate layout.
- Backend, database, MCP, plugin, or deployment configuration changes.
