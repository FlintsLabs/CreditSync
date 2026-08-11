# Global Dark Mode Surface Hierarchy Design

## Goal

Improve CreditSync's dark mode across the authenticated application so page backgrounds, navigation, cards, overlays, form controls, and nested panels remain visibly distinct instead of collapsing into one near-black surface. Light mode and application behavior remain unchanged.

## Selected Direction

Use the existing shadcn semantic color system and change the dark-mode tokens globally. This is preferred over page-specific overrides because the shared `Card`, dialog, dropdown, input, tabs, badge, and layout components already consume semantic tokens.

The visual hierarchy will follow the supplied shadcn reference:

1. The application canvas remains the darkest surface.
2. Cards and navigation use a clearly elevated charcoal surface.
3. Popovers and dialogs use the elevated surface appropriate to overlays.
4. Muted, secondary, accent, and input surfaces provide a distinguishable nested level.
5. Borders remain subtle separators instead of being the only way to recognize a card.

## Scope

- Update dark-mode semantic tokens in `frontend/src/index.css`.
- Keep the existing token names and Tailwind mappings unchanged.
- Preserve light-mode tokens.
- Preserve component structure, spacing, typography, radius, and behavior.
- Preserve semantic financial status colors and chart colors unless contrast verification shows a direct regression caused by the surface changes.
- Add a focused source-level test that protects the intended dark surface hierarchy.
- Update the project changelog with an explicit version and concise summary when the implementation is committed.

## Token Responsibilities

- `background`: darkest application canvas.
- `card`: elevated persistent container, including desktop and mobile navigation.
- `popover`: elevated transient container such as menus.
- `secondary`, `muted`, and `accent`: nested/interactive surfaces, with enough separation from `card` to make grouping and hover states visible.
- `input`: form-control boundary/surface support.
- `border`: quiet but visible separator on both canvas and cards.
- `foreground` and muted foreground: retain readable contrast against every surface where currently used.

Exact HSL values will be selected together as a system and verified rather than copied independently from a screenshot. The intended ordering is `background < card/popover < muted/secondary/accent` by perceived lightness in dark mode.

## Accessibility and Interaction

- Body text, muted text, controls, and state labels must remain readable on their actual surfaces.
- Keyboard focus rings, hover states, selected navigation, disabled states, and overlays must remain distinguishable.
- Theme selection and persistence behavior are unchanged.
- Responsive layouts are unchanged; desktop sidebar and mobile drawer inherit the new hierarchy through `bg-card`.
- Screenshot review alone cannot prove WCAG conformance, so verification includes computed-token/contrast checks and existing automated frontend checks.

## Verification

- Run the focused theme test first.
- Run frontend tests, lint, and production build with Bun.
- Inspect the rendered dark theme at desktop and mobile widths, including a representative detail page, form/dialog, dropdown, and navigation state.
- Confirm light mode has no visual-token regression.
- Compare the rendered dark-mode hierarchy against the supplied shadcn reference, focusing on surface separation rather than copying unrelated layout or typography.

## Out of Scope

- Redesigning individual pages or financial workflows.
- Introducing a third theme or per-user server-side theme storage.
- Replacing the current shadcn/Tailwind token architecture.
- Changing branding, content, localization, or accounting behavior.
