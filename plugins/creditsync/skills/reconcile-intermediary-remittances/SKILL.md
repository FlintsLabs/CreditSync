---
name: reconcile-intermediary-remittances
description: Use when recording borrower payments held by a collector or intermediary, attaching remittance slips, balancing remittances, and posting the exact reconciliation in CreditSync.
---

# Reconcile intermediary remittances

This skill covers borrower collections returned by an intermediary. For outbound loan disbursement transfer legs routed through an intermediary, use `manage-intermediated-disbursements`.

1. Search the intermediary by canonical name before creating one. Never infer identity from a bank name alone.
2. Inspect the borrower and active loan. Create one collection for each borrower payment with its actual borrower-paid timestamp and amount. A collection is non-financial until remittance posting.
3. If that borrower payment is already posted, pass its `paymentIntakePublicId`; CreditSync validates timestamp, loan, and exact amount and will not post it twice.
4. Create the remittance with the gross amount actually received from the intermediary and its bank reference.
5. For a slip, call `intermediary.remittance.evidence.prepare`, PUT the exact file only to the returned current signed URL with every required header, then call `intermediary.remittance.evidence.finalize`. Do not repeat upload/finalize when the result is already `ready`.
6. Save the explicit collection selection. Call `intermediary.remittance.preview` and show gross amount, selected total, remaining balance, warnings, and collection IDs.
7. Post only when the latest proposal is `ready`, balance is `0.00`, and the user has explicitly confirmed the exact allocation. Supply a stable idempotency key.

Stop for human review on ambiguous intermediary/borrower identity, duplicate or mismatched evidence, linked-payment mismatch, stale proposal, or any non-zero balance. Never split or invent allocation amounts merely to make a remittance balance.
