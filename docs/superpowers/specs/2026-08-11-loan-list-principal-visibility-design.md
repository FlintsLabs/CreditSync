# Loan List Principal Visibility Design

## Goal

Make every loan card communicate both the current outstanding principal and the original principal at a glance.

## Card presentation

- Keep the existing large amount as the current outstanding principal.
- Place a second, muted line directly beneath it: `/ Original principal <exactly formatted amount>`.
- Use the active application language for the label and the existing exact-decimal formatter for both amounts.
- Do not derive balances in the frontend or alter loan, repayment, or funding records.

## Data and behavior

The loan-list read model must provide the immutable original principal separately from the current outstanding principal. The card renders the two server-supplied decimal strings without numeric coercion. Missing data is not silently substituted with a calculated value.

## Accessibility and responsive behavior

The secondary line remains visible on all card sizes, uses the normal muted text token for readable contrast, and follows the main amount in the card's document order.

## Verification

Add component coverage showing exact, localized current and original-principal values on a loan card. Run the focused test first red, then green after the minimal UI and contract change; finally run the applicable frontend checks.
