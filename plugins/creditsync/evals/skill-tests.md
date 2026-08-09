# Skill application evidence

These are documentation TDD results, not live accounting executions. No production CreditSync tools were called and no financial writes were made.

## RED baseline

Before the plugin skills existed, a fresh agent was tested against stale payment, ambiguous nickname, duplicate plus allocation mismatch, active-loan edit, and unresolved-renewal scenarios. It already stopped safely in all five cases. The baseline therefore did **not** reproduce an unsafe financial write. It did reveal two orchestration risks worth documenting: borrower creation has no schema-level duplicate precondition, and payment/renewal previews persist workflow state even though they sound read-only.

## GREEN application tests

Each skill was authored and tested sequentially with a fresh agent reading only that skill and the relevant frozen MCP schema:

| Skill | Applied scenario | Result |
| --- | --- | --- |
| `creditsync` | expired payment, ambiguous nickname, unresolved renewal | Re-inspected/re-previewed, stopped at identity and charge boundaries, made no financial write. |
| `manage-borrowers` | two borrowers share confirmed nickname; phone suffix selects one | Inspected selected portfolio, created no duplicate, recognized alias was already confirmed. |
| `reconcile-payments` | intermediary split differs by `10.00`; duplicate reference | Uploaded optional evidence in the right order, stopped on `needs_review`, and returned original duplicate. |
| `manage-loans` | installment changed after preview; active-term edit requested | Re-previewed changed terms, required separate activation approval, refused active edit. |
| `renew-daily-loan` | `2500.00` context, unresolved fees, downstream payment blocks reversal | Treated `1670` as an estimate, used backend fields only, stopped before execution/reversal, identified downstream payment reversal first. |

The final renewal test identified that `payment.reverse` 1.0 has no client idempotency-key input. The root/payment skills were refactored to require only fields supported by each named schema while still requiring an operational reversal reason.

A final all-skill/schema audit found one omitted `renewal.reverse` reason in the written call sequence. After adding that required field, the scoped re-audit passed with no unsupported tool names or inputs and all six negative stop gates intact.

The executable `scripts/validate.ts` checks that every eval call name belongs to the frozen 20-tool contract. Live private-app evals remain an operator release step after replacing the `.app.json` registration placeholder and configuring credentials.
