---
name: renew-daily-loan
description: Use when previewing, confirming, executing, or reversing a CreditSync daily-loan renewal or reset, especially when charges, waivers, or borrower cash movement must be reviewed.
---

# Renew a CreditSync Daily Loan

## Overview

A renewal is always `inspect → preview → explain → explicit confirmation → execute`. CreditSync computes recovered principal, settlement, waiver, and cash movement; never reproduce those formulas in the conversation.

## Preview

1. Resolve the borrower and inspect `borrower.portfolio`; verify the old loan is the intended daily loan.
2. Call `renewal.preview` with the old loan public UUID, requested new principal, and the chosen charge treatment.
3. If any amount is waived, include the exact `waivedCharges` and a non-blank operator `waiverReason`. If charges remain unresolved, stop and ask whether to collect, waive with reason, or cancel.
4. Present the returned old/new linkage and exact `principalPaid`, `outstandingPrincipal`, interest, fee, penalty, total due charges, settlement amount, waived charges, requested principal, cash direction, cash amount, expiry, and preview hash.

Preview calls persist workflow state. Avoid speculative variants, and never infer a payout from prior installment counts.

## Execute

Ask the operator to explicitly confirm the exact current preview every time. Then call `renewal.execute` with:

- renewal public UUID;
- latest unexpired preview hash;
- literal `confirmed: true`;
- a non-blank operator reason; and
- a stable idempotency key for this execution intent.

If the backend reports stale, expired, underfunded, or changed charges, return to preview and confirmation. Do not reuse the previous confirmation. Report new/old loan public IDs, cash movement, and audit/correlation identifiers from the result.

## Reverse

The frozen MCP 1.0 surface has no renewal-detail/get tool. Reverse only when the exact successful `renewal.execute` result is still available in the current task and supplies the renewal, old-loan, new-loan, and borrower public UUIDs. Use `borrower.portfolio` to inspect the current state of both loans and downstream activity. If that same-task result is unavailable, stop and direct the operator to the Web UI renewal detail; never invent a renewal UUID or claim an unsupported inspection.

1. Verify the same-task execute result and inspect the current borrower portfolio containing both loans.
2. Explain the compensating effects and obtain a non-blank reversal reason.
3. Call `renewal.reverse` with the known renewal public UUID, that non-blank reason, and a stable reversal idempotency key.
4. If downstream transactions or adjustments block reversal, report them and stop; never delete or bypass them.

A retry of the same intent reuses its idempotency key. A materially changed preview, execution reason, or reversal reason is a new intent and needs a new key.

## Quick reference

| Condition | Action |
| --- | --- |
| Charges unresolved | Human selects collect/waive/cancel before preview execution |
| Waiver positive | Exact waiver plus reason required |
| Fresh preview, no confirmation | Explain and stop |
| Stale/expired preview | Re-preview and reconfirm |
| Downstream activity exists | Reverse downstream activity first |
| Execute result unavailable in this task | Stop and use Web UI renewal detail |

## Common mistakes

- Calling paid installments “refundable principal” without using the preview.
- Treating interest, fees, or penalties as principal.
- Executing because the cash amount looks familiar rather than receiving explicit confirmation.
- Reversing with a new idempotency key on every retry.

Follow the root `creditsync` skill and the financial/error references.
