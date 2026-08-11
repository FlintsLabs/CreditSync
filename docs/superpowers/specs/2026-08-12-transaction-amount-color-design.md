# Transaction Amount Color Design

## Goal

Make the sign of each transaction total immediately understandable without changing any financial data or transaction behavior.

## Design

The transaction list will apply semantic text color to the total amount only:

- Positive totals use the existing green treatment (`text-green-600`).
- Negative totals use a red treatment (`text-red-600`) to communicate a deduction or reversal.
- Zero totals use the default text color so they are not presented as either incoming or outgoing value.

The amount's existing sign and currency presentation remain visible. Component columns are out of scope.

## Exactness and Accessibility

Sign classification will use `decimal.js` against the public decimal string instead of JavaScript `Number`, following CreditSync's money rules. Color is supplementary: the visible minus sign remains the primary non-color cue for negative values.

## Testing

A focused transaction-list test will load positive, negative, and zero totals and assert their semantic classes. The test will be observed failing before the production change and passing afterward. Frontend typecheck and the relevant test suite will be run after implementation.
