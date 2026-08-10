# Shared Date and Time Input Design

## Goal

Standardize date and date-time controls across CreditSync and make quick-repayment notes comfortably support multiple lines.

## Shared date-time field

Create a reusable UI component for `date` and `datetime-local` values. The component keeps the browser-native input and picker behavior, while presenting the editable value and a calendar icon in a full-width `flex items-center justify-between` container.

The right-side icon is an accessible button. Activating it calls the native input's `showPicker()` when supported and otherwise focuses the input. The component forwards its ref and ordinary input props, supports required and disabled states, and uses the same border, focus ring, sizing, and disabled treatment as the existing shared `Input`.

Migrate every current date or date-time editor to the component:

- funding drawdown start date;
- funding rollover date;
- funding repayment date;
- loan start date;
- transaction received date and time;
- loan disbursement date and time;
- quick-repayment received date and time.

No value conversion is introduced. Callers continue to own their existing `YYYY-MM-DD` or local date-time string state and payloads.

## Quick-repayment notes

Replace the single-line notes input with a native textarea that starts at three rows, spans the form width, and allows vertical resizing. It retains the existing label, controlled state, and submitted `notes` payload.

## Accessibility and responsive behavior

The date-time input remains labelable through its forwarded `id`. The calendar button has a localized-independent screen-reader label derived from the associated field semantics, does not submit surrounding forms, and remains keyboard accessible. Both controls remain full-width on narrow screens.

## Verification

Add component tests proving that the shared control renders the correct input type, keeps the icon on the right, opens or focuses the native picker from its button, and forwards changes. Update quick-repayment coverage to verify the notes control is a three-row textarea with vertical resize styling and that submitted note text remains unchanged. Run frontend tests, lint, and production build.
