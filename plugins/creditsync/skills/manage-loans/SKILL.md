---
name: manage-loans
description: Use when previewing, drafting, or activating a CreditSync loan, or when a requested edit may conflict with immutable active loan terms.
---

# Manage CreditSync Loans

## Overview

Loan creation is `preview → draft → activate`. Terms become immutable after activation; the backend-generated schedule is the only accounting schedule to present or persist.

## Create and activate

1. Resolve the borrower with `borrower.search` and inspect `borrower.portfolio`. Stop for ambiguous identity.
2. Collect exact requested terms: principal, interest rate, term, repayment type, start date, and any required installment count/amount. Keep public money as two-decimal strings. For floating loans, collect `floatingInterestPolicy`: day/week unit, literal period length `1`, percent/per-thousand rate, zero/one advance period, and literal `non_refundable` refund policy. Do not use the removed daily-only policy shape.
3. Call `loan.preview`; present the exact terms plus schedule totals, count, dates, and first/final installment returned by CreditSync. Do not independently recompute or smooth the final installment.
4. Ask the operator to approve those terms and schedule summary.
5. Call `loan.draft` with the same terms and borrower public UUID. A funding source is optional and must use a public UUID returned by `funding-source.list`; never create or modify funding through MCP.
6. Show the draft public UUID and re-check that terms match the approved preview.
7. Call `loan.activate` with that draft public UUID and a stable idempotency key only after the activation decision is explicit. Reuse the same key only for an identical retry; a different loan or activation intent needs a different key. Return the activated status and audit/correlation metadata.

If requested terms change at any point, start again at `loan.preview`; do not activate a draft based on a different preview.

## Atomic scheduled-loan replacement

Use this only to replace an accessible active scheduled loan with an already-created, funded replacement draft for the same borrower and owner. It is not an edit, a direct status change, or a shortcut around activation.

1. Resolve the borrower with `borrower.search` and inspect `borrower.portfolio`. Retain only public UUIDs.
2. Call `loan.replacement.preview` with the active old-loan UUID, existing replacement-draft UUID, and a specific reason. Show the returned replacement public ID, preview hash, both versions, expiry, exact old before/after collectible balances, correction components, `cash.direction`/`cash.amount`, replacement funding public ID, dates, schedule totals, and warnings. Never calculate or alter those values.
3. Stop for any stale/expired preview, warning requiring review, borrower/owner/funding mismatch, or downstream activity. Re-inspect and request a fresh preview; previous approval never carries forward.
4. Obtain explicit human confirmation of that exact fresh preview. Then call `loan.replacement.execute` with literal `confirmed: true`, exactly the returned public ID/hash/versions, a non-blank reason, and a stable idempotency key. Reuse the key only for an identical retry.
5. Report only public lineage IDs plus the returned audit and correlation IDs. Do not expose internal IDs. The backend atomically activates the draft, appends corrections, cancels old schedule obligations, and marks the old loan `replaced`; do not call `loan.activate`, create another draft, or mutate either status directly.
6. Reversal is exceptional: inspect the exact executed result, obtain a separate non-blank reason and explicit confirmation, then call `loan.replacement.reverse` with a new stable idempotency key. Stop if the backend reports any replacement-loan downstream activity; reversal is compensating and never deletes history.

## Commission participants

Before activation or any participant change, call `loan.commission-participant.list`. Having no commission participant is valid; never invent one. For an approved agreement, `loan.commission-participant.add`, `loan.commission-participant.update`, and `loan.commission-participant.end` are effective-dated append-only writes. Show the exact intermediary, rate, role, effective boundary, and reason where applicable, then require explicit confirmation and a stable idempotency key for the actual write. Reuse a key only for an identical retry, and never rewrite historical participant versions or auto-apply a new agreement to old payments.

Use `loan.commission.preview`, `loan.commission.list`, and `loan.commission.calculate` only for exact backend-derived results over selected posted payments. `loan.commission.reverse` is a read-only compensating preview over selected posted reversal payments; it performs no financial write, needs no confirmation/reason/idempotency key, and returns no audit identifiers. Actual payment or attribution correction must use its supported append-only write workflow.

Payment source attribution is independent from the participant agreement. Inspect it with `payment.intermediary-attribution.list`; leaving a payment unattributed, recording `direct` funding, or recording a confirmed multi-agent split are distinct operator choices. Route actual append-only attribution writes and corrections through `payment.intermediary-attribution.create` and `payment.intermediary-attribution.reverse` under the `reconcile-payments` workflow.

## Existing loans

- Draft: inspect it in `borrower.portfolio`; if the required edit tool is unavailable, report that limitation rather than activating incorrect terms.
- Active, paid, or renewed: principal, installment, term, rate, and schedule are historical facts. Do not update them or describe a new draft as an edit.
- A new agreement, renewal, or audited correcting workflow may be appropriate, but only use a workflow the operator explicitly chooses and the available CreditSync tools support.
- To settle an active single-payment agreement into another supported contract without rewriting history, route to `restructure-loan`.

## Quick reference

| Request | Tools | Boundary |
| --- | --- | --- |
| Preview only | `borrower.search` → `borrower.portfolio` → `loan.preview` | No persisted loan |
| New agreement | above → approval → `loan.draft` → activation approval → `loan.activate` | Terms must remain identical |
| View funding | `funding-source.list` | Read-only |
| View commission | `loan.commission-participant.list` → `loan.commission.preview` | Read-only backend calculation |
| Change participant | list → approval → `loan.commission-participant.add` / `loan.commission-participant.update` / `loan.commission-participant.end` | Confirmed, idempotent, effective-dated append |
| Preview reversal commission | `loan.commission.reverse` with posted reversal payment UUIDs | Read-only; no audit IDs |
| Edit active terms | inspect and refuse direct edit | Use supported new/correcting flow |
| Replace active scheduled contract | search → portfolio → `loan.replacement.preview` → exact confirmation → `loan.replacement.execute` | Existing funded draft only; no direct status mutation |

## Common mistakes

- Deriving installment values in the conversation instead of displaying `loan.preview`.
- Activating before the schedule summary and decision are visible.
- Quietly creating a second loan while calling it an edit.
- Passing an internal numeric ID or unverified funding source.
- Omitting the activation idempotency key or translating a weekly policy into a daily rate.
- Treating a replacement preview as approval, reusing stale confirmation, or activating the draft directly.

Follow the root `creditsync` skill for inspect-before-write, stale-state handling, and authorization.
