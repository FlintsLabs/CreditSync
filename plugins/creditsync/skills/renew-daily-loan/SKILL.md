---
name: renew-daily-loan
description: Use when previewing, confirming, executing, or reversing a CreditSync daily-loan renewal or reset, especially when charges, waivers, or borrower cash movement must be reviewed.
---

# Renew a CreditSync Daily Loan

## Overview

A renewal is always `inspect → preview → explain → explicit confirmation → execute`. CreditSync computes recovered principal, settlement, waiver, and cash movement; its returned `composition` is authoritative and agents must never reproduce those formulas in the conversation.

## Preview

1. Resolve the borrower and inspect `borrower.portfolio`; verify the old loan is the intended daily loan.
2. Call `renewal.preview` with the old loan public UUID, requested new principal, and any chosen policy/adjustments. Omission means `full_contract_interest`; use `accrued_to_date` only when the operator explicitly selects it.
3. Prefer ordered structured `adjustments` (`fee`, `penalty`, `other_charge`, or `waiver`). Every positive two-decimal amount requires its own non-blank reason. Never mix structured adjustments with legacy aggregate waiver fields.
4. Present the old contract's full `contractualInterest` separately from `receivedInterest`, `remainingContractInterest`, and the new contract's interest/repayment terms. List every manual line and reason, complete payment dates/amounts, recovered amount, fees, penalties, waivers, requested principal, exact cash direction/amount, expiry, and preview hash.

Preview calls persist workflow state. Avoid speculative variants, and never infer a payout from prior installment counts.

## Execute

Ask the operator to explicitly confirm the exact current preview every time. Then call `renewal.execute` with:

- renewal public UUID;
- latest unexpired preview hash;
- literal `confirmed: true`;
- a non-blank operator reason; and
- a stable idempotency key for this execution intent.

If the backend reports stale, expired, underfunded, or changed charges, return to preview and confirmation. Do not reuse the previous confirmation. Report new/old loan public IDs, cash movement, and audit/correlation identifiers from the result.

If `cashDirection` is `collection`, stop until the operator explicitly acknowledges that collection, then send `confirmedCashDirection: "collection"`. Never send that field for payout or zero-cash previews. Any policy, amount, order, or reason change requires a new preview and new confirmation; execute cannot alter frozen terms.

Generating or exporting a renewal summary image is presentation-only and never executes the renewal. Treat its figures as persisted backend summary data, not permission for a financial write.

## Reverse

The frozen MCP 1.0 surface has no renewal-detail/get tool. Reverse only when both the exact successful `renewal.execute` result and the borrower public UUID retained from the same-task pre-execution resolution are available. `renewal.execute` returns the renewal, old-loan, and new-loan public UUIDs; **`renewal.execute` does not return a borrower UUID**. If either the execute result or retained borrower UUID is unavailable, stop and direct the operator to the Web UI renewal detail; never invent either value.

Use the retained borrower UUID to inspect only the current loan states exposed by `borrower.portfolio`. That portfolio does not expose transactions, adjustments, or funding activity, so it cannot prove that reversal is safe. `renewal.reverse` is the authoritative atomic downstream-activity check. It may safely reject the command with `RENEWAL_REVERSE_BLOCKED`, the backend message, and only the aggregate `downstreamEntryCount`; report that count and message, then stop without claiming individual blocker types or IDs.

1. Verify the same-task execute result, retained pre-execution borrower UUID, and the exposed current state of the old and new loans.
2. Explain the compensating effects and obtain a non-blank reversal reason.
3. Call `renewal.reverse` with the known renewal public UUID, that non-blank reason, and a stable reversal idempotency key.
4. Treat the tool result as authoritative. If it returns `RENEWAL_REVERSE_BLOCKED`, report its backend message and aggregate downstream entry count, then stop; never infer or invent individual entries.

A retry of the same intent reuses its idempotency key. A materially changed preview, execution reason, or reversal reason is a new intent and needs a new key.

## Quick reference

| Condition | Action |
| --- | --- |
| Charges unresolved | Human selects collect/waive/cancel before preview execution |
| Waiver positive | Exact waiver plus reason required |
| Policy omitted | Full old-contract interest is charged by default |
| Cash direction is collection | Stop for explicit collection acknowledgement |
| Fresh preview, no confirmation | Explain and stop |
| Stale/expired preview | Re-preview and reconfirm |
| `RENEWAL_REVERSE_BLOCKED` | Report backend message plus aggregate count and stop; no reversal occurred |
| Execute result or retained borrower UUID unavailable | Stop and use Web UI renewal detail |

## Common mistakes

- Calling paid installments “refundable principal” without using the preview.
- Treating interest, fees, or penalties as principal.
- Combining old-contract interest with the new contract's interest instead of presenting them separately.
- Omitting a manual adjustment line or its reason from the explanation.
- Claiming that summary-image generation executed or changed a renewal.
- Executing because the cash amount looks familiar rather than receiving explicit confirmation.
- Reversing with a new idempotency key on every retry.

Follow the root `creditsync` skill and the financial/error references.
