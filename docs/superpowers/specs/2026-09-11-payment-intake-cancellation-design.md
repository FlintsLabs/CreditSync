# Payment intake cancellation design

## Status

Approved design for review before implementation.

## Problem

Payment intakes in `draft`, `needs_review`, or `ready` can remain pending when an operator decides not to use them. Pending intakes participate in chronology checks and can block later valid payments. The current system supports cancellation for an unposted payment batch, but not for an individual payment intake. Operators therefore have no safe, auditable terminal action for an unwanted intake.

## Goals and non-goals

Goals:

- Allow an authorized owner to cancel an individual unposted payment intake from Web or MCP.
- Preserve the intake, evidence, review history, and audit trail; never delete financial evidence.
- Remove cancelled intakes from chronology blockers and pending queues.
- Make retries idempotent and enforce the same authorization/business rules across REST and MCP.
- Keep posted financial records immutable; route them through the existing reversal workflow.

Non-goals:

- No new financial allocation or transaction is created by cancellation.
- No automatic cancellation of all records matching a borrower, payer, or date range.
- No direct cancellation of `posted` or `reversed` records.
- No change to backend-authoritative interest or payment allocation calculations.

## Lifecycle policy

| Current status | Action | Result |
|---|---|---|
| `draft` | Cancel | `cancelled` |
| `needs_review` | Cancel | `cancelled` |
| `ready` | Cancel | `cancelled` |
| `posted` | Cancel request | Reject; offer `reversal` |
| `reversed` | Cancel | Reject as terminal |
| `duplicate` | Cancel | Reject as terminal |
| `cancelled` | Cancel | Idempotent result or reject according to command key policy |

Cancellation is a terminal, non-financial state transition. The original intake remains queryable with its original fields and evidence. The record gains cancellation metadata: reason, actor, actor source, correlation/request identifiers, idempotency key, request hash, and timestamp. The reason is mandatory and must be non-blank; the API should apply the existing bounded string validation conventions.

For a posted intake, the UI and MCP must expose “reverse payment” rather than “cancel”. Reversal continues to use compensating transactions, explicit reason, dependency checks, confirmation, and idempotency as already defined by the financial domain rules.

## Authorization and concurrency

The command must load the intake inside a tenant-scoped transaction, lock the intake row, and apply the existing owner/role authorization policy used by payment mutations. The default policy is that the intake owner may cancel it; tenant-wide roles may act according to their existing access rules. An actor may not cancel another tenant's intake or bypass batch ownership checks.

The command must reject cancellation when:

- The intake is `posted` or otherwise has immutable financial effects.
- The intake is part of a posted/confirmed batch whose lifecycle requires the batch command.
- The intake is already being processed by a conflicting financial command.
- The request is stale or has a different request body for an existing idempotency key.

Cancellation and posting must serialize on the same intake/batch/borrower lock boundary. A concurrent cancel/post race has one committed winner; the loser receives a stable domain error and no partial audit or financial write.

## Service and API contract

Add one application service, for example `cancelPaymentIntake(ctx, intakePublicId, input)`, used by both REST and MCP. It must return the public intake representation plus audit public ID and correlation ID.

REST:

```text
POST /payment-intakes/:id/cancel
{
  "reason": "Duplicate upload; keeping the verified intake",
  "idempotencyKey": "..."
}
```

The idempotency key may follow the existing command-context convention, but the MCP contract must expose it explicitly because MCP calls do not depend on browser headers. The public error codes should distinguish at least `PAYMENT_CANCEL_NOT_ALLOWED`, `PAYMENT_CANCEL_BATCH_REQUIRED`, `PAYMENT_CANCEL_STALE`, `PAYMENT_NOT_FOUND`, and authorization failures. `posted` should return a clear reversal suggestion, not a generic invalid-state message.

MCP:

```text
payment.cancel({
  paymentIntakePublicId,
  reason,
  idempotencyKey
})
```

The tool is destructive because it changes workflow state, even though it creates no financial transaction. It must be tenant-scoped, expose only public IDs and safe fields, return structured content, and use the same service and authorization checks as REST.

## Batch behavior

An intake belonging to an unposted batch cannot silently be cancelled independently if that would leave a partial batch. The command should either:

1. cancel the complete unposted batch through the existing revision-bound batch cancellation workflow when the caller targets the batch, or
2. reject with `PAYMENT_CANCEL_BATCH_REQUIRED` and direct the caller to the batch action when independent cancellation would violate batch invariants.

The implementation must not mutate a confirmed/posted batch into a hidden partial state. Batch cancellation should retain item membership and evidence history while making the batch and its unposted members terminal.

## Chronology and queues

Add `cancelled` to every terminal-status predicate that excludes pending chronology items, including the shared chronology service, batch chronology, pending indexes/queries, review queues, and any MCP list filters. A cancelled intake must not be returned as an actionable review item and must not block an older/newer intake.

Existing posted/reversed/duplicate semantics remain unchanged. Cancellation must not remove or rewrite transaction history, allocations, or evidence.

## Web experience

On the payment intake detail and review queue:

- Show “Cancel” for `draft`, `needs_review`, and `ready` when the actor is authorized.
- Require a reason and a second confirmation describing that the intake will be excluded from future processing but retained in history.
- For a batch member, show the batch-level action or a clear explanation of why the item cannot be cancelled alone.
- For `posted`, show “Reverse payment” and link to the existing reversal flow.
- After success, show `cancelled`, reason, actor, and timestamp; remove it from actionable queues.
- Do not expose raw QR payloads, full account numbers, raw evidence contents, or unnecessary sensitive OCR data.

Translations must be added to both English and Thai locale files together.

## Verification plan

Backend:

- Migration/schema check for `cancelled` and cancellation metadata/constraints.
- Unit tests for allowed and forbidden transitions, reason validation, tenant/owner authorization, and idempotent replay/conflict.
- Integration tests proving cancelled older intakes no longer trigger `assertNoOlderPendingPayment`.
- Race test for concurrent cancel/post with exactly one committed outcome.
- Batch tests for unposted membership, confirmed/posted batch protection, and full cancellation invariants.
- MCP contract/eval tests for structured response, destructive metadata, authorization, and repeated calls.

Frontend:

- Detail/review-queue visibility by status and role.
- Confirmation modal, required reason, error handling, translated copy, and post-cancel refresh.
- Posted reversal routing and batch-required messaging.

Release gates:

- Disposable PostgreSQL backend suite and typecheck.
- Frontend test/lint/build.
- CreditSync plugin manifest, frozen tool metadata, skills, evals, and validator synchronized.
- No financial record is created by cancellation tests; posted reversal tests remain separate and explicitly confirmed.

## Acceptance criteria

1. An authorized owner can cancel an individual `draft`, `needs_review`, or `ready` intake with a reason from Web and MCP.
2. A cancelled intake remains visible in history with immutable original data and cancellation audit metadata.
3. Cancelled intakes no longer block chronology or appear in actionable review queues.
4. Replaying the same command is idempotent; changing the request under the same key is rejected.
5. Posted intakes cannot be cancelled and are routed to reversal.
6. Batch invariants prevent silent partial cancellation.
7. REST and MCP produce equivalent authorization, state-transition, and audit behavior.
