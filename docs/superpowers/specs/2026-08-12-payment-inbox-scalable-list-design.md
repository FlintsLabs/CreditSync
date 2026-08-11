# Payment Inbox Scalable List Design

## Goal

Make the payment inbox easy to scan without nested-card styling and keep it usable as intake volume grows, while preserving the existing payment review and posting workflow.

## Approved interaction

- Keep one outer inbox card and render payments as flat, full-width rows separated by dividers.
- Give the selected row a subtle background and inset accent instead of another border.
- Show payer, received date/time, status, and exact formatted amount in each row.
- Add localized payer search, status, start-date, and end-date controls above the list.
- Sort newest first on the backend and paginate on the backend at 25 rows per page.
- Show the result range and total, with previous/next controls. Reset to page one when any filter changes.
- Keep the existing responsive stacked row on narrow screens and use aligned columns at larger widths.

## API contract

`GET /payment-intakes` accepts optional `search`, `status`, `from`, `to`, `page`, and `pageSize` query parameters. It returns `{ items, page, pageSize, total, totalPages }`. Tenant scoping remains mandatory. Date filters use `YYYY-MM-DD` in the Asia/Bangkok business timezone and include the complete selected day.

Search is a case-insensitive payer-name substring match. Status accepts one known payment-intake status. Page size is capped at 100. Invalid query values return a closed validation error rather than silently widening the result.

## State and errors

List refreshes retain active filters and page. If the current page becomes empty after a mutation, the UI requests the previous valid page. List failures use the existing localized alert and leave financial actions untouched.

## Verification

- Backend route tests cover tenant-safe filtering, newest-first ordering, date boundaries, pagination metadata, and invalid query values.
- Frontend tests cover request parameters, filtering/page resets, flat row semantics, pagination controls, empty results, and existing detail-selection behavior.
- Run backend disposable database tests and typecheck plus frontend tests, lint, and build.
