# Dashboard Mobile Repayment Queues Design

## Status

Approved in conversation on 2026-08-13.

## Goal

Make the borrower and fund repayment queues easy to scan and operate on narrow screens without the nested-card appearance, while preserving the Dashboard's section hierarchy on wider screens.

## Scope

- Update both repayment queue panels in `frontend/src/pages/dashboard/Dashboard.tsx` so the paired queues remain visually consistent.
- Preserve all queue data, exact-money formatting, localization, loading, error, empty, expand/collapse, and navigation behavior.
- Do not change backend contracts, accounting logic, queue ordering, or the five-item collapsed limit.

## Responsive Structure

### Mobile

- Present each queue as a flat section without an outer border, corner radius, shadow, or card-colored inset surface.
- Keep the section heading, description, and count as one compact header with the count aligned to the trailing edge.
- Render queue entries on a shared surface as full-width rows separated by dividers, not as individually bordered cards.
- Use the page's existing horizontal edge; do not add a second content inset around the row list.
- Keep borrower or funding identity and due metadata on the leading side. Keep the exact amount and status together on the trailing side when space permits, with a controlled stacked fallback for very narrow content.
- Make the entire row the navigation target and provide a visible pressed, hover, and keyboard-focus state.

### Tablet And Desktop

- Restore the queue's enclosing card treatment at the existing medium breakpoint to preserve Dashboard module grouping.
- Keep entries as divider-separated list rows inside the section rather than restoring nested item cards.
- Retain the existing two-column queue layout at the large breakpoint and the wider Dashboard command-center layout at the extra-large breakpoint.

## Visual Hierarchy

- One containment level per queue: the enclosing section on desktop and the page section itself on mobile.
- Use whitespace and subtle dividers to group rows.
- Borrower or drawdown identity remains the primary row label.
- Amount remains a strong tabular-number value; due metadata and status are secondary.
- The overdue badge retains its existing destructive semantic color.
- Add a trailing chevron only if needed to make row navigation apparent without crowding the amount/status column.

## Accessibility

- Preserve semantic headings and `aria-busy` state.
- Each row remains a native `button` so keyboard activation and accessible naming continue to work.
- Use a visible `focus-visible` ring and avoid relying on hover alone.
- Maintain at least a 44px interactive row height; the intended content produces a 64–72px row in normal states.
- Keep text reflow resilient at 320px CSS width and at browser zoom; do not hide financial values or status.
- Dividers are decorative and must not be the only indication that a row is actionable.

## Component Boundary

- Extract or introduce a small queue-section/list-row presentation boundary only if it removes the duplicated borrower/fund responsive classes without mixing their distinct navigation and metadata rules.
- Keep financial formatting in the existing backend-owned response and `formatMoneyExact`; do not recreate calculations in the UI.

## Verification

- Add or update source-level responsive layout assertions for the mobile-flat and desktop-contained behavior.
- Add component tests that confirm borrower and fund rows remain buttons, retain exact displayed amounts/status, and invoke their existing navigation targets.
- Run the focused Dashboard tests, frontend typecheck/lint, and frontend build.
- Visually verify at approximately 320px, 406px, 768px, and desktop width in both light and dark themes when the browser surface is available.

## Non-Goals

- Redesigning the Dashboard header, priority queue, cash summary, or detail cards.
- Changing queue APIs, pagination, sorting, accounting, or repayment workflows.
- Introducing platform-specific iOS or Android components; the implementation adapts their list and containment principles to the existing web design system.
