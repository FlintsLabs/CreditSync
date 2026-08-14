---
name: manage-intermediated-disbursements
description: Use when recording, evidencing, previewing, posting, inspecting, or reversing a CreditSync loan payout routed through an intermediary.
---

# Manage intermediated disbursements

## Overview

An intermediated payout is one append-only group of actual cash-transfer legs. CreditSync derives the expected amounts from the active loan; the agent must preserve the exact identities, assignment, amounts, payees, evidence, retained balance, and backend preview.

## Identity and assignment

1. Resolve the borrower with `borrower.search`, require one exact canonical match or confirmed alias, then inspect the active loan with `borrower.portfolio`.
2. Resolve the intermediary with `intermediary.search`. Continue only with one exact canonical name or confirmed alias; never select by bank name or fuzzy ranking.
3. Call `intermediary.profile.get` and require an active disbursement assignment (role `disbursement` or `both`) for the exact loan and transfer time. `intermediary.managed-loan.list` can confirm the intermediary's scoped portfolio.
4. Assignment changes are separate administrative writes. Use `intermediary.assignment.create` or `intermediary.assignment.end` only after an authorized human confirms the exact parties, role, effective time, and stable idempotency key. Save bank details through `intermediary.bank-account.save`; report only the returned masked account.

## Create, evidence, preview, and post

1. Call `intermediary.disbursement.create` with the exact loan and intermediary public UUIDs, explicit retained balance, and a stable idempotency key. Stop on any unexplained retained balance; never hide or silently reallocate it.
2. Create each supplied transfer leg with `intermediary.disbursement.event.create`: funding to intermediary, borrower net payout, and advance-interest return when applicable. Preserve the exact two-decimal amount, transfer timestamp, sender/payee hints, bank reference, and role. Stop on any duplicate reference or idempotency conflict.
3. Attach every supplied slip to its exact event. Hash the unchanged bytes, call `intermediary.disbursement.evidence.prepare`, PUT only those unchanged bytes to a current returned upload URL with every required header, then call `intermediary.disbursement.evidence.finalize`. If prepare reports `ready`, do not PUT or finalize again. Missing/expired upload data, a hash conflict, or a finalize mismatch stops the workflow.
4. Call `intermediary.disbursement.get` and compare all recorded amounts, roles, payees, normalized reference displays, and evidence status/count/public IDs/MIME types with the supplied transfers. General MCP inspection must never expose or request an evidence access URL through MCP, and must also exclude storage keys and checksums; evidence viewing belongs to the REST/Web UI access flow.
5. Call `intermediary.disbursement.preview`. Continue only when the fresh preview is `ready`, evidence is ready, warnings are empty, retained balance is `0.00`, and `variance: 0.00`. Present the exact proposal public UUID, expected and actual role totals, evidence state, retained balance, variance, warnings, and expiry.
6. Obtain explicit confirmation for that exact fresh preview. Call `intermediary.disbursement.post` with `{ groupPublicId, proposalPublicId, confirmed: true, idempotencyKey }`. A stale or expired preview invalidates confirmation: re-inspect, request a fresh preview, present it, and stop for new confirmation.

## Reversal

1. Re-list with `intermediary.disbursement.list`, then inspect the exact group with `intermediary.disbursement.get`. Require `status: posted`; never reverse a draft, stale local UUID, or already reversed group.
2. Explain the compensating reversal and obtain explicit confirmation plus a specific non-blank reason.
3. Call `intermediary.disbursement.reverse` with the exact group UUID, `confirmed: true`, reason, and a new stable idempotency key. Report the returned audit public ID and correlation ID.

## Stop gates

| Condition | Required action |
| --- | --- |
| Ambiguous borrower/intermediary or inactive loan | Stop for exact human identity selection. |
| Missing active assignment | Stop; do not create a group or infer authorization. |
| Duplicate transfer, mismatch, or evidence failure | Stop before preview/post and inspect the existing state. |
| Non-zero retained balance, variance, or warnings | Present the exact backend result and stop for review. |
| Missing confirmation or stale preview | Do not post; fresh state requires fresh confirmation. |
| Missing posted group, reason, or reversal confirmation | Do not reverse. |

Follow the root `creditsync` skill and `financial-rules.md` for authorization, exact decimal strings, audit context, and append-only accounting.
