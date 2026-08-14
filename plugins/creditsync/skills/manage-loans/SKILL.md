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
| Edit active terms | inspect and refuse direct edit | Use supported new/correcting flow |

## Common mistakes

- Deriving installment values in the conversation instead of displaying `loan.preview`.
- Activating before the schedule summary and decision are visible.
- Quietly creating a second loan while calling it an edit.
- Passing an internal numeric ID or unverified funding source.
- Omitting the activation idempotency key or translating a weekly policy into a daily rate.

Follow the root `creditsync` skill for inspect-before-write, stale-state handling, and authorization.
