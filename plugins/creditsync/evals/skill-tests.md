# Skill application evidence

These are local scripted-MCP orchestration results, not live accounting executions. No production CreditSync tools were called and no financial writes were made.

## RED baseline

Before the plugin skills existed, a fresh agent was tested against stale payment, ambiguous nickname, duplicate plus allocation mismatch, active-loan edit, and unresolved-renewal scenarios. It already stopped safely in all five cases. The baseline therefore did **not** reproduce an unsafe financial write. It did reveal two orchestration risks worth documenting: borrower creation has no schema-level duplicate precondition, and payment/renewal previews persist workflow state even though they sound read-only.

## GREEN application tests

Each skill was authored and tested sequentially with a fresh agent reading only that skill and the relevant frozen MCP schema:

| Skill | Applied scenario | Result |
| --- | --- | --- |
| `creditsync` | expired payment, ambiguous nickname, unresolved renewal | Re-inspected/re-previewed, stopped at identity and charge boundaries, made no financial write. |
| `manage-floating-interest-rates` | scheduled future rate and missing confirmation | Listed and previewed the automatic split; executed only the exact confirmed hash and stopped without execute when confirmation was absent. |
| `settle-floating-loans` | exact weekly close-out, missing confirmation, stale balance, non-refundable advance request | Showed every backend component, executed only the exact confirmed preview with a stable key, re-inspected/re-previewed stale state, and refused to refund already-paid advance interest. |
| `manage-borrowers` | two borrowers share confirmed nickname; phone suffix selects one | Inspected selected portfolio, created no duplicate, recognized alias was already confirmed. |
| `reconcile-payments` | intermediary split differs by `10.00`; duplicate reference | Uploaded optional evidence in the right order, stopped on `needs_review`, and returned original duplicate. |
| `manage-loans` | installment changed after preview; active-term edit requested | Re-previewed changed terms, required separate activation approval, refused active edit. |
| `manage-disbursements` | actual payout with optional evidence, variance, post, and reversal | Used draft → evidence prepare → unchanged-byte PUT → finalize → explicit post → re-list/select posted event before reversal; treated `ready` evidence as finalized and stopped on upload/finalize failures. |
| `manage-intermediated-disbursements` | assigned three-leg payout with one slip per transfer, exact reconciliation, stale state, and reversal | Required exact borrower/intermediary identity and an active assignment, finalized each supplied slip, posted only a fresh zero-variance/zero-retained-balance preview after confirmation, and stopped on every ambiguity or mismatch. |
| `renew-daily-loan` | `2500.00` context, unresolved fees, downstream payment blocks reversal | Treated `1670` as an estimate, used backend fields only, stopped before execution/reversal, identified downstream payment reversal first. |

The final renewal test identified that `payment.reverse` 1.0 has no client idempotency-key input. The root/payment skills were refactored to require only fields supported by each named schema while still requiring an operational reversal reason. Loan activation now sends its own stable idempotency key, and floating origination carries the generalized day-or-week policy returned by the backend.

A final all-skill/schema audit found one omitted `renewal.reverse` reason in the written call sequence. After adding that required field, the scoped re-audit passed with no unsupported tool names or inputs and all six negative stop gates intact.

## Executable harness

`evals/harness.ts` now executes every catalog workflow against injected MCP responses. The scripted adapter fails on any wrong call order or argument object, including repeated alias add/confirm and stale preview/re-preview calls. The suite checks every supplied top-level argument against the actual advertised input schema, and asserts forbidden financial writes for duplicate, ambiguous, `needs_review`, stale, unsettled, unconfirmed, and unauthorized states.

The evidence-duplicate case also records non-MCP upload effects and proves `evidence.prepare` duplicate state stops before PUT, finalize, preview, or post. Reversal cases prove the payment reason and renewal reason/idempotency key are sent, and that renewal reversal stops when the current task does not hold the exact execute result because MCP 1.0 has no renewal-detail tool.

The renewal-reversal fixture carries the actual scripted `renewal.execute` result (renewal/old-loan/new-loan public IDs) together with the borrower UUID retained before execution. It proves the execute result itself has no borrower UUID, reads only current loan states from `borrower.portfolio`, and treats `renewal.reverse` as the authoritative atomic downstream-activity check. Missing retained context stops for Web UI inspection. The exact `RENEWAL_REVERSE_BLOCKED` fixture reports only the backend message and aggregate `downstreamEntryCount`, without inventing individual blocker records or claiming a reversal occurred.

The disbursement lifecycle fixture proves the exact draft → evidence prepare → PUT → finalize → post → re-list/select posted event → reverse ordering. The ready-evidence retry never PUTs/finalizes again; expired upload, checksum conflict, and finalize mismatch stop before post. The variance fixture stops before post and the schedule-mutation fixture proves that no loan preview, draft, or activation is attempted. Both post and reverse use different stable idempotency keys, while reversal carries a specific human-confirmed reason.

The intermediated-disbursement fixtures prove exact borrower and intermediary resolution, active assignment inspection, a three-leg group, unchanged-byte PUT/finalize for every supplied slip, group re-inspection, zero retained balance and variance, exact preview presentation, and explicit confirmation before post. The harness validates every intermediary-flow input and scripted output through the complete frozen JSON schemas, including formats, literals, nested types, and closed objects; each upload effect records the current prepare URL/headers plus verified byte length and SHA-256 without retaining the evidence bytes. It binds every slip's evidence/file UUID and MIME/size/SHA-256 across prepare, already-ready retry, finalize, and inspection, and requires audit/correlation UUIDs from both evidence writes. Mutation cases replace finalized evidence/file UUIDs, a ready checksum, and inspected event/evidence fields; all stop before preview/post. Ambiguous identity, missing assignment/evidence/confirmation, duplicate transfer, amount/payee/reference/evidence mismatch, unexplained retained balance, and stale preview all stop safely; stale state is inspected and re-previewed but requires fresh confirmation before any second post.

The settlement fixtures prove portfolio inspection → exact preview presentation → explicit confirmation → execute with the same settlement ID and preview hash. The harness records the presentation before confirmation and asserts principal, due interest, accrued-not-due interest, fees, penalties, non-refundable advance history, total, expiry, balance version, and preview hash exactly. Omitted confirmation and a requested refund of `nonRefundableAdvanceInterest` stop before execute. A stale execute response triggers portfolio re-inspection, exact re-presentation, and re-preview, but the old approval is discarded and no second execute occurs until fresh human confirmation is supplied.

The executable `scripts/validate.ts` runs the harness and compares the committed full metadata snapshot to an authenticated local MCP SDK Client `tools/list` response. Live private-app evals remain an operator release step after replacing the `.app.json` registration placeholder and configuring credentials.
