---
name: creditsync
description: Use when managing CreditSync borrowers, payment reconciliation, intermediary remittances or disbursements, loans, floating-interest timelines or settlements, renewals, or financial reversals through the private CreditSync app.
---

# CreditSync

## Overview

Use CreditSync as an orchestration surface over its private MCP app. The backend is the accounting authority: inspect current records, ask it to preview, and write only the exact reviewed result.

## Required operating contract

1. Confirm that the CreditSync app exposes the required named tools before promising an action. If a tool is unavailable or authorization fails, stop and report the missing connection or permission.
2. Inspect before every write. Search and retrieve the current borrower, intake, loan, proposal, or renewal by public UUID; never invent IDs or select a tenant/actor.
3. Use `payment.preview`, `loan.preview`, `loan.interest-rate.preview`, `loan.settlement.preview`, `renewal.preview`, `loan.disbursement.list`, or `intermediary.disbursement.preview` for accounting outcomes. Never replace backend results with agent arithmetic.
4. Present exact money strings, targets, warnings, expiry, cash direction, and proposal/preview identity before a financial write.
5. Re-read or re-preview after state changes. After a disbursement draft update, re-list it and obtain fresh confirmation because any earlier confirmation is invalid. Post only the latest inspected backend result.
6. For a supplied payment-slip image, require verified evidence to be `ready` before `payment.preview` or `payment.post`; if no image is supplied, data-only payment capture may skip evidence.

## State decisions

| Backend state | Required action |
| --- | --- |
| `ready` | The agent may post the exact latest proposal after showing its allocation summary. |
| `needs_review` | Show candidates, obligations, warnings, and difference; wait for a human allocation decision. |
| `duplicate` | Return the original intake public ID, inspect it, and do not post or create another payment. |
| stale/expired/not-latest | Re-inspect and request a new preview; never reuse the old hash or proposal. |
| unauthorized/forbidden | Stop without retrying under another identity. |

Every activation, post, reversal, and renewal uses explicit public IDs. Supply confirmation, reason, or a stable idempotency key exactly when that named tool schema requires it; never invent unsupported fields. Reversals create compensating records, not deletion.

## Routing

- Borrower identity, aliases, create/update: use `manage-borrowers`.
- Intake, optional evidence, matching, posting, or payment reversal: use `reconcile-payments`.
- Loan preview, draft, and activation: use `manage-loans`.
- Floating-loan interest timeline inspection and scheduled changes: use `manage-floating-interest-rates`.
- Floating-loan exact close-out preview and execution: use `settle-floating-loans`.
- Actual loan disbursement draft creation/editing, optional payout evidence, variance review, posting, or reversal: use `manage-disbursements`.
- Actual loan payouts routed through an intermediary, including assignment checks, transfer legs, per-event evidence, exact preview, posting, or reversal: use `manage-intermediated-disbursements`.
- Borrower payments held by a collector, remittance slips, exact allocation, and posting: use `reconcile-intermediary-remittances`.
- Daily-loan reset/renewal and reversal: use `renew-daily-loan`.
- Single-payment settlement/restructure, component waiver, additional principal, and their reversals: use `restructure-loan`.

Use the plugin references for the frozen tool contract, matching policy, financial rules, and error recovery. Do not use generic HTTP, SQL, or web requests as a substitute for a missing CreditSync tool.

## Common mistakes

- Treating preview tools as harmless reads: they can persist workflow state, so avoid speculative calls.
- Posting a payment after a supplied image was not uploaded/finalized: stop when evidence is missing, unavailable, duplicate, mismatched, or not ready. Data-only requests without a supplied image remain valid.
- Creating a borrower to escape an ambiguous nickname: resolve candidates first.
- Editing posted transactions or active terms: use a supported reversal, renewal, or new draft flow.
- Logging or echoing raw QR payloads, evidence contents, bearer tokens, or sensitive identity fields.
