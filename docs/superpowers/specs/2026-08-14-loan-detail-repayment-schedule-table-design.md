# Loan Detail Repayment Schedule Table Design

## Goal

Replace the stacked installment cards on the loan detail page with a compact shadcn-style data table that uses space efficiently while preserving the same schedule data and status semantics.

## Scope

- Change only the repayment schedule presentation in `LoanDetail`.
- Preserve the existing API request, schedule ordering, eight-row display limit, exact money formatter, empty state, and status-to-badge mapping.
- Do not change loan calculations, payment allocation, schedule records, or backend behavior.

## Design

The existing outer `Card` remains the section container. Its content contains one semantic table with four columns: installment, due date, remaining amount, and status. The header uses muted shadcn styling; rows use a single bottom divider instead of individual borders. Installment labels remain localized, amounts use tabular numerals and right alignment, and status remains a compact `Badge`.

The table sits in the standard shadcn responsive wrapper (`relative w-full overflow-auto`). It has a modest minimum width so narrow phones can scroll horizontally without collapsing labels or wrapping money values. Cell padding is compact on small screens and relaxed from the `sm` breakpoint. No alternate card layout is rendered on mobile.

## Component Boundary

Add `frontend/src/components/ui/table.tsx` containing the standard reusable shadcn table primitives: `Table`, `TableHeader`, `TableBody`, `TableFooter`, `TableHead`, `TableRow`, `TableCell`, and `TableCaption`. `LoanDetail` imports and composes these primitives; the primitives contain styling only and know nothing about loans.

## Localization and Accessibility

- Add paired English and Thai column labels under `loanDetail.scheduleColumns`.
- Use native `table`, `thead`, `tbody`, `tr`, `th`, and `td` semantics.
- Right-align the amount header and cells consistently.
- Keep status text localized through the existing `loans.paymentHealth.scheduleStatus.*` keys.

## Verification

A focused Loan Detail component test supplies more than eight schedule rows and verifies a semantic table, localized headers, exact displayed values, localized badges, preserved order, and the eight-row limit. Run the focused test, full frontend test suite, lint, and production build.

## Non-goals

- Pagination or a “show all” interaction.
- Sorting, filtering, row selection, or payment actions.
- Backend/API changes.
- Redesigning other card-based sections on the loan detail page.
