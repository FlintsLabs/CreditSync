# Dashboard Mobile Spacing and Cash Metrics Design

## Goal

Make the Dashboard use narrow mobile screens more efficiently and remove the visual impression of cards nested inside another card in the cash-due summary.

## Scope

- Change only the Dashboard page container and its three cash summary metrics.
- Preserve all data loading, exact-money formatting, localization, semantic colors, and navigation behavior.
- Do not change shared card primitives or spacing on other pages.

## Responsive Layout

The Dashboard `main` container will use 8px padding on narrow screens. The existing 32px padding at the `lg` breakpoint remains unchanged. Bottom padding stays at 40px so the last section retains sufficient breathing room, while the explicit mobile top padding is removed in favor of the requested uniform 8px edge spacing.

The cash metrics remain stacked below `sm` and remain a three-column grid from `sm` upward.

## Cash Summary Treatment

The outer cash-summary section remains the single card surface, including its heading, live badge, border, gradient, radius, and shadow. Each `MoneyMetric` becomes a flat metric cell without its own border, background, or rounded corners.

On mobile, adjacent metric cells use horizontal separators. From `sm` upward, separators switch to vertical dividers between columns. The existing icon colors, labels, positive/negative value colors, typography, truncation, and tabular numerals remain unchanged.

## Accessibility and States

The existing heading relationship, `aria-busy` state, loading skeletons, and section error treatment remain intact. Dividers are decorative CSS borders and add no redundant screen-reader content.

## Verification

- Add a focused source-level regression test for the responsive container padding and flat metric styling.
- Run the Dashboard frontend tests and frontend lint.
- Build the frontend to verify Tailwind class generation and TypeScript compilation.
- Visually check a narrow mobile viewport and a desktop viewport when browser tooling is available.
