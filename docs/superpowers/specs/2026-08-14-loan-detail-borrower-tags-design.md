# Loan Detail Borrower Tags Design

## Goal

Show a borrower's existing tags in the borrower summary card on Loan Detail so operators can see useful customer context without opening the full borrower profile.

## Scope

- Reuse the existing `GET /borrowers/:id` response and its `tags` field.
- Change only the borrower summary card in `LoanDetail` and its frontend component coverage.
- Do not add an API request, backend route, database change, tag editing control, or financial behavior.

## Design

Extend `BorrowerData` with `tags?: string[] | null`. When the borrower has at least one tag, render a wrapping row directly below the borrower's name and above the phone number. Show the first three tags as compact secondary `Badge` components. If more than three tags exist, append muted `+N` text where `N` is the number of hidden tags.

The presentation matches the existing `BorrowerCard`: secondary badges, compact spacing, source order preserved, and no empty placeholder when tags are null or empty. The borrower profile link and all existing card content remain unchanged.

## Data and Error Behavior

The existing borrower request already returns `tags`; no new loading or failure state is needed. If `tags` is missing, null, or empty, the card renders exactly as it does today. Tags are display-only strings and must not be modified or inferred on Loan Detail.

## Accessibility and Responsive Behavior

Badges contain their tag text directly and wrap naturally within the existing card width. The tag row uses `data-testid="loan-borrower-tags"` only when tags exist so component coverage can distinguish the absent state without adding unnecessary visible copy.

## Verification

Focused Loan Detail tests verify that four API-provided tags render the first three in source order, show `+1`, hide the fourth tag, and omit the tag container when `tags` is null. Run the focused test, full frontend test suite, lint, production build, and whitespace check.

## Non-goals

- Editing, adding, deleting, sorting, or filtering tags.
- Tooltips or an expanded “show all” interaction.
- Backend, database, MCP, plugin, or production-data changes.
