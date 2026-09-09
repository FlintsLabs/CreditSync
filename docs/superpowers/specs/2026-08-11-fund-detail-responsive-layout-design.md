# Fund detail responsive layout design

## Goal

Make the funding-source detail page readable when the navigation sidebar leaves a medium-width content area, including iPad portrait and compact desktop windows. Preserve the existing financial values, actions, and routes.

## Breakpoint behavior

The page must not use a three-column summary grid until the viewport is wide enough for three readable cards beside the persistent sidebar.

| Viewport/layout | Summary cards | Funding allocations |
| --- | --- | --- |
| Phone | One column | Contract cards |
| Tablet and compact desktop | Two columns | Contract cards |
| Very wide desktop (`2xl`) | Three columns | Existing full table |

The summary grid will use one column by default, two columns from the medium breakpoint, and three columns only from `2xl`. This avoids three narrow cards at ordinary 1280px desktop widths when the sidebar is visible.

## Summary cards

The available-capital card keeps its money value as an exact formatted string. At medium widths it uses a compact, tabular numeral style with a smaller responsive size and allows the text container to shrink, so the amount does not overlap the icon or adjacent cards. The limit, net allocated amount, utilization bar, and utilization label remain in separate, readable rows.

Settlement and profitability cards retain their current metrics. The two-column grid prevents their labels and values from being compressed into overlapping text.

## Funding allocation presentation

Below `2xl`, replace the seven-column allocation table with one linked contract card per allocation:

- Header: contract public ID link and contract status.
- Secondary: borrower name and funding route.
- Financial details: net allocated amount and outstanding principal.
- Record details: latest allocation date.

The detail fields use a two-column definition grid at tablet widths and one column on phones. The existing "include settled loans" control and loading/empty states remain unchanged. At `2xl` and above, retain the existing table for dense portfolio scanning.

## Accessibility and interaction

- The whole card must not replace the contract link; the existing explicit contract link remains keyboard accessible.
- Labels stay visible beside every financial value; color is not the only status cue.
- Status remains textual, and the settled toggle keeps its associated checkbox label.

## Scope and verification

Only `FundDetail` and its focused Vitest coverage change. No backend contract, allocation calculations, locale copy, or financial records change.

Tests will verify that the compact layout exposes all allocation fields and contract links, while the wide layout retains the tabular representation. Run the focused test, full frontend test suite, lint, and production build.
