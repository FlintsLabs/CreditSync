# App-wide Table Pagination Design

## Objective

Establish pagination as a required part of every tabular design in CreditSync and retrofit every current application table with consistent, localized, accessible pagination. Persistent history and directory tables must scale through server-side pagination; finite financial previews must paginate only their already-authoritative rows in the browser.

## Design Principles

- Pagination is mandatory for every table, including tables with only one current page.
- Pagination must never recalculate, round, reorder, or mutate financial values. Public money remains an exact two-decimal string and existing `decimal.js` formatting remains authoritative.
- Persistent collections use server-side pagination so response size does not grow with history.
- Preview tables use client-side pagination because the backend preview is one immutable review unit and the UI must not create a second accounting calculation.
- Persistent table state is shareable and restorable through URL query parameters. Preview table state is ephemeral component state.
- The common experience uses active-language copy, keyboard-accessible controls, deterministic ordering, and responsive horizontal scrolling.

## Inventory and Classification

### Persistent collections: server-side pagination

- Payment Inbox: retain its existing server-side contract and replace its custom controls with the shared control.
- Transaction List.
- Loan Detail repayment schedule.
- Loan Detail repayment history.
- Intermediary Detail managed-loan table.
- Fund Detail persistent allocation, rollover, repayment, or schedule tables where rows originate from stored records.

Each affected read endpoint returns `items`, `page`, `pageSize`, `total`, and `totalPages`. Results must use an explicit stable business sort followed by a unique public-ID tie-breaker. Queries remain tenant-bound and read-only.

### Finite previews: client-side pagination

- Loan Wizard schedule preview.
- Loan Renewal replacement-schedule preview.
- Loan Restructure replacement-schedule preview.
- Fund Detail modal/preview tables whose rows are already returned as one authoritative preview.

Preview pagination slices the returned row array only. It is fixed at 10 rows per page, resets to page 1 whenever the preview identity or row collection changes, and must not affect confirmation, execution payloads, totals, or backend calculations.

## Shared UI Components and Models

Create a reusable `DataTablePagination` component for both modes. Its input contract includes:

- `page`: one-based current page.
- `pageSize`: positive row count per page.
- `total`: total row count.
- `totalPages`: normalized total page count.
- `onPageChange(page)`.
- optional `onPageSizeChange(pageSize)` and `pageSizeOptions` for persistent collections.
- optional accessible label namespace where a screen needs more specific wording.

The control displays the localized visible range, current page and total pages, first/previous/next/last controls, and a `10 / 25 / 50` page-size selector for persistent tables. Preview tables have a fixed page size of 10 and no selector.

Rules:

- Hide the whole control when `total` is zero.
- For persistent tables, keep the control available when data exists so the page-size choice remains discoverable, including a one-page result.
- For preview tables, hide the control when there are 10 or fewer rows.
- Disable boundary controls rather than removing them.
- Clamp proposed navigation to `1..max(totalPages, 1)`.
- Use semantic buttons and localized `aria-label` text.
- Do not place pagination inside the horizontally scrolling table viewport; it remains readable at the card width.

Create a small pure client pagination helper/hook for preview tables. It accepts the complete row list and reset identity, then returns the current slice plus pagination metadata. It owns no domain logic.

## URL and Navigation State

Persistent tables store `page` and `pageSize` in URL search parameters. Screens containing multiple independent persistent tables use stable namespaced keys, such as `schedulePage` and `repaymentsPage`, to prevent collisions.

- Missing or invalid values normalize to page 1 and page size 10.
- Supported page sizes are exactly 10, 25, and 50.
- Changing a filter or page size resets page to 1.
- Browser back/forward and refresh restore the selected page.
- If a response proves that the requested page exceeds the last page, replace the URL with the last valid page and refetch once.
- Existing unrelated query parameters must be preserved.

Preview tables never write pagination state into the URL.

## Backend Data Flow

For each persistent endpoint that currently returns an unbounded array:

1. Validate `page` and `pageSize` using the closed REST query schema.
2. Apply tenant and domain filters before counting.
3. Count the exact filtered collection.
4. Fetch one page using a deterministic order and calculated offset.
5. Return normalized pagination metadata with the existing safe row DTOs.

Page and page-size values may use ordinary integers because they are navigation metadata, not financial values. All money continues to cross the interface as decimal strings. Pagination endpoints remain read-only and introduce no audit writes.

Where the same endpoint is consumed outside the Web UI, preserve compatibility only when doing so does not leave an unbounded public read. The implementation plan must enumerate each caller and update it deliberately rather than silently changing array semantics.

## Loading, Empty, and Error Behavior

- While a new server page loads, keep the table shell stable, disable pagination controls, and show the existing localized loading treatment.
- Do not display stale rows as belonging to a newly selected page.
- An empty filtered result shows the existing empty state and no pagination control.
- A failed page request preserves the requested URL state, shows the existing retryable error treatment, and does not advance the visible page.
- Rapid navigation must ignore or abort superseded responses according to the screen's existing request-ordering pattern.

## Responsive Behavior

Tables retain their shadcn-style header, rows, compact spacing, and minimum width. Narrow screens scroll the table horizontally. Pagination is a separate wrapping footer: range and page-size controls may stack above navigation buttons without causing horizontal page overflow.

## Localization

Add paired English and Thai keys for:

- visible item range;
- page `current / total`;
- rows per page;
- first, previous, next, and last page accessible labels.

Payment Inbox migrates from screen-specific pagination copy to the common namespace unless it needs a screen-specific noun. No mixed hardcoded Thai/English copy is permitted.

## Design Policy Documentation

Update the project's contributor-facing guidance so future table designs explicitly require a pagination decision. The rule must state:

- persistent/unbounded data defaults to server-side pagination;
- finite authoritative previews use client-side pagination;
- persistent state uses URL parameters;
- exact financial values are never recomputed by pagination;
- pagination behavior and boundaries require tests.

## Testing and Verification

### Shared frontend tests

- zero, one-page, middle-page, first-page, and last-page rendering;
- disabled boundary controls and clamped navigation;
- `10 / 25 / 50` selector behavior;
- localized accessible labels and range copy;
- preview slicing and reset when preview identity changes.

### Screen integration tests

- persistent page/page-size URL restoration and preservation of unrelated parameters;
- page-size and filter changes reset to page 1;
- out-of-range response normalization;
- response ordering during rapid page changes;
- no duplicated or missing rendered rows across fixture pages;
- preview confirmation and execution still receive the complete authoritative preview, not the visible slice.

### Backend tests

- validation rejects unsupported or malformed pagination values;
- exact filtered counts and metadata;
- stable ordering with a unique tie-breaker;
- tenant isolation on every page;
- empty and out-of-range pages;
- money DTOs remain exact decimal strings.

Run affected backend unit tests, database-backed suites through `backend/scripts/test-disposable-postgres.sh`, backend typecheck, and the complete frontend test/lint/build gates. Plugin tests are required only if an affected endpoint changes an MCP/plugin contract; otherwise MCP contracts remain out of scope.

## Rollout and Deployment

Implement in one isolated feature branch with TDD and review gates. Deploy backend before frontend when server response contracts change, using the production compose files. Verify migrations only if implementation proves a schema change is required; this design expects none. After deployment, verify backend health internally, frontend HTTP health locally and publicly, container start/image state, and representative paginated reads without creating or changing production financial records.

## Scope Exclusions

- No sorting or filtering redesign beyond the reset behavior necessary for pagination.
- No virtualized rows, infinite scroll, cursor pagination, or new data-grid dependency.
- No changes to financial allocation, schedule calculation, posting, reversal, or confirmation semantics.
- No database schema migration unless endpoint analysis demonstrates an unavoidable indexing requirement and it receives separate review.
- No MCP/plugin contract changes unless an existing tool directly exposes an affected REST-shaped response, which must be identified before implementation.
