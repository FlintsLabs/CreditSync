# Fund Usage Flat List and Source Interest Design

## Goal

Make the funding-source loan usage section easier to scan on mobile and desktop by removing nested item cards, improving status semantics, and showing the exact interest collected for the current funding source.

## Scope

- Replace the bordered card used for each funded loan with a flat, divider-separated list row inside the existing section card.
- Preserve the settled-loan toggle, loan navigation, funding-route summary, exact net allocation, outstanding principal, and latest allocation date.
- Add a localized semantic status badge.
- Add exact net interest collected for the current funding source on each loan.
- Prefer one responsive list implementation at all widths when it remains as scannable as the current desktop table, avoiding duplicated presentation logic.

## Backend Contract

The tenant-scoped `GET /bank-profiles/:id/funding-usage` response adds `collectedInterest` to each allocation row as a two-decimal decimal string.

For each loan, sum posted transaction `interestComponent` values, including negative compensating reversals, to obtain net collected interest. Divide the current profile's net allocation by the loan's total net allocation, multiply interest by that share, and round once to two decimals with `decimal.js` using half-up rounding. Return `0.00` when the current profile has no positive net share, the loan has no positive total allocation, or no interest has been collected.

This attribution prevents the same interest from being counted in full on multiple funding-source pages. A loan funded entirely by the current profile reports all of its net collected interest.

## Presentation

Each row uses this hierarchy:

- Primary: borrower name and semantic localized status badge.
- Secondary: truncated loan public ID and funding route.
- Financial metrics: net allocated, outstanding principal, and interest collected for this source.
- Metadata: latest allocation date.

Rows use separators, spacing, and a subtle hover/focus surface instead of individual rounded borders. The whole row links to the loan with a visible keyboard focus state. Narrow screens use a compact metric grid; wider screens align fields into a stable horizontal grid.

Status badges use accessible semantic colors: green for active, neutral gray for paid/closed, amber for draft/pending, and red for problem states. Visible labels come from Thai and English locale keys rather than raw backend values.

## Exactness and Safety

- Financial values remain decimal strings across the public API.
- Backend calculations use `decimal.js`; frontend rendering uses the existing exact money formatter.
- Reversed payments reduce collected interest through negative append-only transaction components.
- No loan, transaction, or funding allocation is mutated by this read model.
- Tenant and settled-loan scoping remain unchanged.

## Tests

- Backend integration coverage for fully funded, proportional multi-source, reversal, zero/no allocation, tenant isolation, and two-decimal serialization cases.
- Frontend coverage for flat hierarchy, localized semantic statuses, exact interest rendering, loan navigation, settled toggle behavior, and removal of nested item-card styling.
- Run focused backend tests, frontend Vitest, lint/typecheck, and production frontend build.

## Success Criteria

- The section reads as one card containing a clear list, not cards nested inside a card.
- Each loan exposes source-attributed collected interest without double counting across funding profiles.
- Status is visually meaningful and localized.
- Mobile content fits without horizontal clipping; desktop remains efficiently scannable.
