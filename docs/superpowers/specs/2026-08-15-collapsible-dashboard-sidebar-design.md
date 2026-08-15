# Collapsible Dashboard Sidebar Design

## Summary

Add an optional compact desktop navigation rail to `DashboardLayout`. The expanded sidebar remains the default and preserves the current CreditSync navigation. A user can collapse it to a 72px icon rail, regain horizontal space for the active page, and expand it again without losing context.

The approved visual target is the third generated concept from the 2026-08-15 sidebar ideation set (`Compact Rail`).

## Goals

- Let desktop users reclaim horizontal space while keeping every primary destination one click away.
- Preserve the current monochrome CreditSync visual language, menu order, active state, theme/account access, and language control.
- Keep navigation understandable through tooltips, accessible names, focus treatment, and a clearly reversible collapse action.
- Leave the existing mobile drawer behavior unchanged.

## Non-goals

- Reordering or regrouping navigation destinations.
- Redesigning `AppBar`, page content, mobile navigation, or authorization-based menu visibility.
- Adding backend persistence, cross-device preference synchronization, or a new settings preference.
- Changing routes or page-level accounting behavior.

## Desktop States

### Expanded

- Width remains `w-64` (256px).
- The CreditSync brand, theme control, account control, navigation labels, and language label remain visible.
- Add a localized collapse button to the desktop sidebar header using a panel-left-close style icon.
- The control has a minimum 40x40px pointer target, a visible keyboard focus ring, and a localized tooltip/title equivalent to “ย่อแถบเมนู” / “Collapse sidebar”.

### Collapsed

- Width becomes 72px with a smooth width transition that respects `prefers-reduced-motion`.
- Show a compact CreditSync mark at the top, followed by an expand control using a panel-right-open style icon.
- Navigation destinations become centered 40x40px icon buttons. The selected destination keeps the current soft accent background and foreground treatment.
- Every navigation icon exposes its localized label through an accessible name and a hover/focus tooltip. Tooltips must not be the only source of an accessible name.
- Theme, account, and language actions remain reachable. Hide text labels while keeping their existing behavior and accessible names.
- The main content flexes into the released space; no overlay is introduced and no page state is reset.

## Interaction And Persistence

- The desktop toggle changes only the desktop sidebar state.
- Store the preference in local storage under `creditsync:sidebar-collapsed` as `true` or `false`.
- Default to expanded when the key is missing, malformed, or storage is unavailable.
- Read and write storage defensively so privacy modes or quota failures never prevent rendering or toggling.
- Persist the user’s explicit choice across reloads in the same browser.
- Do not automatically collapse based on viewport width. At widths below the existing `md` breakpoint, continue using the current mobile header and drawer.

## Localization

Add English and Thai keys together:

- `nav.collapseSidebar`: “Collapse sidebar” / “ย่อแถบเมนู”
- `nav.expandSidebar`: “Expand sidebar” / “ขยายแถบเมนู”

Existing translated navigation labels provide icon tooltips and accessible names.

## Component Boundaries

- Keep responsive layout ownership in `frontend/src/layouts/DashboardLayout.tsx`.
- Extract local-storage preference parsing and persistence to a focused frontend helper or hook only if doing so makes behavior directly testable without coupling tests to the full routed layout.
- Reuse the existing Lucide icon dependency and shared button, tooltip, class-name, app bar, language, and account components where available. Do not add a new dependency solely for this feature.

## Accessibility

- Toggle controls use semantic buttons with `aria-label` and `aria-expanded`.
- Navigation links retain semantic link behavior and a discernible localized name in both states.
- Tooltips appear on hover and keyboard focus and must not obscure the selected item or toggle.
- Focus order follows the visual order from header actions through navigation and footer actions.
- Active navigation continues to be communicated visually and should expose `aria-current="page"`.
- Motion is disabled or reduced when the operating system requests reduced motion.

## Verification

- Unit-test preference parsing, unavailable storage, toggle persistence, and reload restoration.
- Component-test expanded and collapsed labels, tooltips/accessibility names, `aria-expanded`, `aria-current`, and navigation links.
- Confirm mobile navigation remains unchanged at widths below `md`.
- Run the focused frontend tests, `bun run lint`, and `bun run build`.
- Visually compare expanded and collapsed desktop states against the current screen and approved Compact Rail target at the same viewport.

## Acceptance Criteria

- A desktop user can collapse the 256px sidebar to a 72px icon rail and expand it again.
- The choice survives a reload in the same browser and safely falls back to expanded when persistence is unavailable.
- All authorized destinations and header/footer actions remain usable in both states.
- Active, hover, focus, tooltip, and reduced-motion behavior is accessible and consistent with the existing design system.
- Mobile drawer behavior and page state are unchanged.
