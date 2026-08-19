---
name: restructure-loan
description: Use when settling a CreditSync single-payment or floating loan into a replacement contract, waiving eligible balances, adding principal, or reversing those audited actions.
---

# Restructure a CreditSync Loan

This workflow supports active single-payment and floating loans. For a floating-to-floating restructure, the preview snapshots projected interest and penalty through the settlement date, carries eligible unpaid components into the replacement loan, and may return a separate additional-principal disbursement draft.

## Required sequence

Use `inspect → preview → explain → exact confirmation → execute`. CreditSync is the accounting authority; never calculate settlement interest, penalty, waiver availability, replacement principal, schedule, or cash movement in conversation.

1. Resolve the borrower with `borrower.search`. Stop on ambiguous identity, then inspect the exact current loan with `borrower.portfolio`.
2. Collect settlement date, replacement terms, additional principal, any external settlement credit, and component-specific waiver amounts and reasons.
3. Call `loan.restructure.preview` with public UUIDs and two-decimal strings. Treat its `previewHash`, `oldBalanceVersion`, and expiry as one indivisible approval snapshot.
4. Display gross, waived, external-credit, and net principal/interest/fee/penalty separately; display replacement principal, terms/schedule, and exact cash direction/amount. Additional principal does not prove that cash was paid: an actual payout remains a separate disbursement draft returned after execution.
5. Stop for any unexpected cash, identity ambiguity, mismatch, stale/expired preview, missing waiver reason, or changed terms.
6. After the owner confirms the exact latest preview, call `loan.restructure.execute` with `confirmed: true`, the returned restructure UUID/hash/balance version, a non-blank reason, and a stable idempotency key.
7. Report the old/new loan UUIDs, optional disbursement draft UUID, audit UUIDs, and correlation UUID. If a payout draft exists, route its posting through `manage-disbursements`; do not imply it is posted.

## Later waivers

Only interest, fee, or penalty is eligible; principal is never waived. Inspect the replacement loan, obtain a specific reason, call `loan.waiver.preview`, show available/waived/remaining amounts, then obtain exact confirmation. Execute with the returned preview UUID/hash/balance version, `confirmed: true`, the identical reason, and a stable idempotency key. A stale preview requires a new preview and new confirmation.

## Reversals

Reversal is append-only compensation, not deletion. Use only an exact restructure or waiver public UUID retained from a trustworthy result or inspected Web UI record. Ask for a specific reason and confirmation, then use a new stable idempotency key. `loan.restructure.reverse` and `loan.waiver.reverse` perform the authoritative downstream checks. On a blocked response, report only safe backend details and stop; never invent blockers, reverse newer activity automatically, or bypass the conflict with a new intent.

Follow the root `creditsync` skill and the financial/error references for authorization, retry, and data-handling rules.
