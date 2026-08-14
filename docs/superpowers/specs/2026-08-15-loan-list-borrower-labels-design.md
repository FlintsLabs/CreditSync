# Loan List Borrower Labels Design

## Goal

Help operators identify borrowers directly from Loan Agreements by showing every useful borrower label beneath the canonical name and allowing the existing search box to match those labels.

## Scope

- Extend `GET /loans` with borrower labels already owned by the borrower profile.
- Return confirmed borrower aliases separately from borrower tags.
- Render a compact combined label row on each Loan List card.
- Search the loaded Loan List by canonical name, confirmed aliases, borrower tags, or loan public ID.
- Update the English and Thai search copy together.
- Do not add or edit aliases or tags from Loan List.
- Do not change loan terms, balances, schedules, funding, or any financial workflow.

## Backend Design

The Loan List loader will retain its existing loan and borrower access filters. After loading the visible loan rows, it will fetch labels only for the distinct visible borrower IDs in the same tenant and access scope:

- `borrowerAliases`: alias text whose status is exactly `confirmed`.
- `borrowerTags`: the borrower's existing tag strings.

Pending and inactive aliases must not be returned. Label lookup must not expand the set of visible loans or expose labels for a borrower outside the authenticated loan portfolio. The response preserves the current money-string fields and adds only `borrowerAliases: string[]` and `borrowerTags: string[]`.

The cached Loan List response includes these fields. Borrower updates already invalidate tenant caches; alias add/confirm/deactivate operations will gain the same post-transaction invalidation so label changes do not remain stale for the 30-second Loan List TTL. Tests will verify both paths. No schema or migration is required.

## Frontend Design

Each card combines aliases first and borrower tags second. It trims display candidates, removes blank values, and de-duplicates values case-insensitively while preserving the first source value and source order.

Directly beneath the canonical borrower name, the card shows up to three compact secondary badges. When additional labels exist, it shows muted `+N` text for the hidden count. If no usable labels exist, it renders no label container or reserved spacing. Labels wrap naturally on narrow cards and never replace or truncate the canonical name.

The existing client-side search matches every normalized alias and tag, including labels hidden behind `+N`. Search continues to match the canonical name and loan public ID. Thai and English placeholders will explicitly mention names, nicknames/tags, and contract/loan numbers.

## Data and Error Behavior

Older or partial API responses that omit either array are treated as empty arrays. Malformed blank labels are ignored on the frontend as a defensive presentation measure. Failure to load the Loan List keeps the current page behavior; there is no separate label request or partial loading state.

Aliases and tags are identity aids only. They must never be used to auto-select a borrower or make a financial decision.

## Accessibility and Responsive Behavior

Badge text remains visible text and participates in normal reading order immediately after the canonical name. The overflow count receives a localized accessible label describing the number of additional labels. The row wraps within the card without horizontal scrolling.

## Testing and Verification

Backend coverage will verify:

- confirmed aliases and borrower tags are returned for visible loan borrowers;
- pending and inactive aliases are excluded;
- tenant and portfolio scope are preserved;
- cached list data refreshes after relevant borrower-label mutations.

Frontend coverage will verify:

- aliases precede tags and duplicates/blanks are removed;
- the first three labels and correct `+N` count render;
- no empty label row renders;
- search matches an alias or tag even when hidden by overflow;
- existing canonical-name and loan-ID search still works;
- Thai and English locale keys remain synchronized.

Verification gates are focused RED/GREEN tests, backend disposable PostgreSQL coverage for the list contract and scope, backend typecheck, frontend tests, frontend lint, frontend production build, and whitespace validation.

## Non-goals

- Showing pending or inactive aliases.
- Editing labels from Loan List.
- Adding an expansion popover, tooltip list, or filter facet.
- Server-side pagination or search changes.
- Database, MCP, plugin, deployment, or production-data changes.
