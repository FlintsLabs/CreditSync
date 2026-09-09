# Repayment History Mobile List Design

## Status

Approved in conversation on 2026-08-13.

## Goal

Replace the nested-card mobile repayment history with a compact transaction list that is easier to scan while retaining every financial value, status, and review action.

## Scope

- Change only the mobile presentation in `LoanRepaymentHistory`.
- Preserve the desktop table, quick-capture workflow, API contract, ordering, exact-money formatting, navigation, loading, error, and empty states.
- Keep Thai and English copy synchronized.

## Mobile Layout

- The section remains the single containment surface; repayment records are flat rows separated by subtle dividers.
- Each row is one native button that opens the existing payment-review route.
- The first line shows exact amount on the leading side and status on the trailing side.
- The received date/time sits below the amount.
- Bank reference appears as a compact, truncatable metadata line.
- Posted allocation appears as a concise component summary. Zero-value principal, interest, fee, or penalty components are omitted from this visual summary only.
- When no posted component breakdown exists, retain the latest-allocation summary.
- Replace the full-width nested outline button with a small trailing `View details` label and chevron inside the row.

## Responsive And Accessibility Requirements

- Keep the existing desktop table at `md` and wider.
- Use `min-w-0`, truncation, and zero-minimum flex children so long bank references cannot expand the viewport.
- Preserve the complete bank reference in accessible text/title even when the visual line truncates.
- Keep the entire record a native button with a minimum 64px target, visible focus ring, hover/pressed feedback, and a useful accessible name derived from visible content.
- Preserve semantic status badges and exact decimal-string display through `formatMoneyExact`.

## Verification

- Add component coverage proving the mobile list has no nested record cards or nested action buttons, omits zero posted components, shows non-zero components, retains the reference, and navigates when the row is activated.
- Run the focused repayment-history test, the full frontend suite, lint, and production build.
- Inspect the narrow mobile layout after deployment when a browser capture surface is available.

## Non-Goals

- Backend or accounting changes.
- Copy-to-clipboard behavior for bank references.
- Pagination, filtering, sorting, or changes to the desktop table.
