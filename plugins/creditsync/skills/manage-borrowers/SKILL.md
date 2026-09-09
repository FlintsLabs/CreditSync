---
name: manage-borrowers
description: Use when searching, identifying, creating, updating, or managing confirmed aliases for CreditSync borrowers, especially when names or Thai nicknames may be ambiguous.
---

# Manage CreditSync Borrowers

## Overview

Resolve identity before mutation. Canonical names and confirmed aliases are evidence; fuzzy candidates are suggestions that always require human resolution.

## Workflow

### Find or create

1. Call `borrower.search` with the supplied real name, nickname, or identifying text.
2. Interpret the backend resolution:
   - `unique`: call `borrower.portfolio` for the returned public UUID before any update.
   - `ambiguous` or multiple candidates: show canonical names and safe distinguishing portfolio context, then ask the operator to select one. Do not create or auto-select.
   - `none`: ask the operator to confirm that this is a new person, then call `borrower.create` using only supplied facts.
3. Inspect the returned borrower after creation. Do not copy a candidate's personal details into a new record.

### Update

1. Search or retrieve the borrower and show the fields that will change.
2. Preserve exact public UUIDs and call `borrower.update` with only the confirmed `changes` object.
3. Return the audit/correlation metadata when provided and re-read the portfolio if the next action depends on it.

### Alias lifecycle

- Add a nickname with `borrower.alias` action `add` only after the correct borrower is selected.
- Confirmation is a separate `borrower.alias` action `confirm` using the alias public UUID. Ask the operator when the source is not already an explicit human confirmation.
- Deactivate incorrect or obsolete aliases; do not delete history.
- The same normalized alias may identify multiple borrowers. That state remains ambiguous even if each alias is individually confirmed.

## Quick reference

| Intent | Tools in order | Stop condition |
| --- | --- | --- |
| Resolve nickname | `borrower.search` → `borrower.portfolio` | More than one candidate |
| Create person | `borrower.search` → confirmation → `borrower.create` | Any plausible existing candidate |
| Update person | `borrower.search`/`borrower.portfolio` → `borrower.update` | Identity or field value unclear |
| Confirm alias | `borrower.search` → `borrower.portfolio` → `borrower.alias` add/confirm | Borrower not explicitly selected |

## Common mistakes

- Assuming the first fuzzy match is the person named by the operator.
- Creating a duplicate record to continue a payment workflow.
- Confirming a nickname based only on a matching payment amount.
- Displaying full sensitive identity values when a safe suffix or existing label is enough.

Follow the root `creditsync` skill for authorization, inspect-before-write, and error handling.
