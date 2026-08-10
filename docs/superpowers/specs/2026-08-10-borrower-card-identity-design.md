# Borrower Card Identity Design

**Date:** 2026-08-10  
**Status:** approved for implementation planning

## Goal

Make borrower cards readable at every supported viewport while treating a national ID number as sensitive data. The card must preserve fast access to the identifier for owner workflows without exposing the full value unnecessarily in a list view.

## Scope

This design changes the borrower-list card only. It does not change borrower data, API contracts, detail-page presentation, or the existing Edit and Details flows.

## Layout

- The list uses one full-width card below `md` and two equal columns from `md` upward: `grid-cols-1 md:grid-cols-2`.
- It deliberately removes the current three-column layout. A borrower card carries identity, contact, and actions; a third column makes names and values truncate prematurely.
- A card header is a `min-w-0` identity row: a 48px avatar at the leading edge, then a flexible identity block.
- The borrower name may occupy two lines on narrow cards. It must not be shortened with a single-line ellipsis solely because the avatar is present.
- Phone, credit score, and optional map link remain in the details area. The footer retains Edit and Details, wrapping cleanly if necessary on narrow screens.

## Identity number presentation

- The card stores and uses the existing raw 13-digit `idCardNumber`; formatting is presentation-only.
- A valid 13-digit Thai ID is displayed as `X-XXXX-XXXXX-XX-X`.
- The list displays a masked default: `X-XXXX-XXXXX-XX-X` with the middle five digits replaced by bullets or `x` characters. The first group, the next four digits, final two digits, and checksum digit remain visible for recognition.
- An adjacent icon-only Copy button copies the complete raw 13-digit number. It has a localized accessible label, a tooltip, and a localized success/failure toast.
- If there is no valid 13-digit value, show the existing localized “No ID Card” state and do not render a copy control.
- The full number remains available in the borrower detail/edit experience; this design does not add a reveal control to the list.

## Avatar and aliases

- Preserve a supplied borrower photo when present.
- Otherwise use the existing initials fallback, but keep it visually secondary to the name.
- Render confirmed aliases/tags beneath the ID line. They must wrap instead of pushing the card beyond its container.

## Accessibility and localization

- All new visible copy and ARIA/tooltip text must be added in both `frontend/src/locales/en.json` and `frontend/src/locales/th.json`.
- The Copy button is keyboard reachable, has a clear focus ring, and exposes the action and borrower context through an accessible label.
- ID formatting and masking are pure utilities with unit coverage for valid, absent, and malformed values.

## Verification

- Add component coverage for full-width mobile cards, two-column `md` cards, formatted/masked ID display, copying raw digits, missing ID state, and localized copy feedback.
- Run frontend tests, lint, and production build.
- Visually check the Borrowers page at a narrow mobile viewport, `md`, and a wide desktop viewport. Confirm that no name, ID row, tag, or footer action overflows.
