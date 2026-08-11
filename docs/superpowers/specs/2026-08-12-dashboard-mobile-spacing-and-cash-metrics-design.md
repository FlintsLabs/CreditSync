# Authenticated App Mobile Spacing and Dashboard Cash Metrics Design

## Goal

Make every authenticated app page use narrow mobile screens more efficiently and remove the visual impression of cards nested inside another card in the Dashboard cash-due summary.

## Scope

- Change the shared authenticated layout padding and the Dashboard's three cash summary metrics.
- Preserve all data loading, exact-money formatting, localization, semantic colors, and navigation behavior.
- Do not change public landing/login layouts, dialogs, shared card primitives, or component-internal spacing.

## Responsive Layout

The shared authenticated `DashboardLayout` page-content container will use 8px padding on narrow screens. Its existing 32px padding from the `md` breakpoint remains unchanged. This central rule gives every routed app page consistent mobile edges without duplicating padding classes across individual pages.

The Dashboard currently adds a second page-level padding layer inside the shared layout. That redundant padding will be removed while retaining 40px bottom breathing room. Other pages already rely on the shared layout and need no page-level spacing changes.

The cash metrics remain stacked below `sm` and remain a three-column grid from `sm` upward.

## Cash Summary Treatment

The outer cash-summary section remains the single card surface, including its heading, live badge, border, gradient, radius, and shadow. Each `MoneyMetric` becomes a flat metric cell without its own border, background, or rounded corners.

On mobile, adjacent metric cells use horizontal separators. From `sm` upward, separators switch to vertical dividers between columns. The existing icon colors, labels, positive/negative value colors, typography, truncation, and tabular numerals remain unchanged.

## Accessibility and States

The existing heading relationship, `aria-busy` state, loading skeletons, and section error treatment remain intact. Dividers are decorative CSS borders and add no redundant screen-reader content.

## Verification

- Add focused source-level regression coverage for the shared responsive container padding, removal of redundant Dashboard padding, and flat metric styling.
- Run the Dashboard frontend tests and frontend lint.
- Build the frontend to verify Tailwind class generation and TypeScript compilation.
- Visually check a narrow mobile viewport and a desktop viewport when browser tooling is available.
