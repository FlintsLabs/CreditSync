# Backdated Payment Reconciliation Review Transition Design

## Status

Approved design. Implementation remains gated on an approved detailed implementation plan.

## Problem

An ordinary payment preview can be `ready` even though posting later discovers that the payment is backdated relative to immutable floating-loan allocations. `payment.post` correctly rejects that chronology with `FLOATING_BACKDATED_ALLOCATION_REQUIRES_RECONCILIATION`, and `payment.reconcile.preflight` correctly remains read-only. However, historical reconciliation accepts only a `needs_review` intake or a fully reversed intake, while the private MCP contract has no narrowly scoped command that can move this failed `ready` intake into reconciliation review.

The Web API already exposes a generic review action backed by `reviewPaymentIntake`, but exposing that generic state editor through MCP would grant more authority than the agent needs. The missing capability is a dedicated, explicit, auditable transition for a verified backdated-payment conflict.

## Goals

- Add a private MCP command that moves an accessible payment intake from `ready` to `needs_review` only for historical payment reconciliation.
- Require an explicit reason, expected source status, command context, and stable idempotency key.
- Preserve the existing read-only behavior of `payment.reconcile.preflight`.
- Invalidate active ordinary payment-match proposals so they cannot be posted after the workflow changes.
- Keep financial ledgers, payment transactions, accruals, balances, schedules, and evidence unchanged.
- Let the existing reconciliation preflight, preview, confirmation, and execute flow handle the reviewed intake afterward.

## Non-goals

- Do not expose the Web UI's generic `draft` / `needs_review` status editor through MCP.
- Do not make `payment.reconcile.preflight` or `payment.post` change intake state as a side effect.
- Do not force-post a backdated payment or bypass floating-interest provenance checks.
- Do not create, reverse, edit, or delete financial ledger records during the review transition.
- Do not automate reconciliation execution or reuse an earlier ordinary payment preview as reconciliation authorization.
- Do not alter the existing reconciliation calculation or support new reconciliation components.

## MCP Contract

Add the destructive tool `payment.reconcile.mark-review` with a closed input schema:

```json
{
  "paymentIntakePublicId": "uuid",
  "expectedStatus": "ready",
  "reason": "Backdated floating payment requires reconciliation",
  "idempotencyKey": "stable-command-key"
}
```

`expectedStatus` is the literal `ready`. It makes the caller's state assumption explicit and prevents the command from becoming a general transition API. `reason` is trimmed, non-empty, and length-bounded. `idempotencyKey` is required in the closed tool input. The handler uses the command-context key when the MCP transport has already promoted that same value; if both values are present and differ, it fails with `IDEMPOTENCY_CONFLICT` rather than choosing one silently.

The safe response contains:

- payment intake public UUID;
- before and after status;
- invalidated proposal count;
- audit public UUID;
- correlation UUID.

It excludes payer identity, bank reference, raw evidence, QR data, internal numeric IDs, and financial details that are unnecessary for confirming the transition.

## Eligibility and State Transition

The command acquires a tenant-scoped row lock before evaluating eligibility. It succeeds only when all of the following are true:

- the intake exists in the caller's tenant;
- the locked current status equals `ready` and the supplied `expectedStatus`;
- the reason is non-blank;
- the intake has a latest ordinary payment-match proposal that demonstrates explicit allocations;
- the intake is blocked by the existing backdated floating-allocation chronology rule when the current proposal is evaluated for posting feasibility;
- the intake has not already been posted, reversed, marked duplicate, or reconciled.

The service must reuse the backend's authoritative chronology/provenance validation rather than infer eligibility from an error string supplied by the agent. A generic ready intake that could still follow ordinary posting is rejected.

On success, one database transaction:

1. changes the intake from `ready` to `needs_review`;
2. marks every active ordinary payment-match proposal for that intake as `stale`;
3. records an idempotency result bound to the intake, expected status, normalized reason, and operation type;
4. appends an audit record with before/after status, normalized reason, invalidated proposal count, actor/source, request ID, and correlation ID.

The transition does not update money fields, loan rows, schedules, accruals, transactions, evidence, or reconciliation records.

## Idempotency and Concurrency

An identical retry with the same idempotency key returns the original successful public result without adding another audit event. Reusing the key for another intake, reason, expected status, or operation returns `IDEMPOTENCY_CONFLICT`.

Concurrent transition, post, review, or reconciliation attempts serialize on the intake lock. If another operation changes the intake before this command obtains the lock, the command fails with a state-conflict error and performs no partial writes. The implementation must not rely on the pre-lock snapshot already used by the generic Web review service.

If existing persistence cannot durably bind this non-financial workflow command and replay its result, add the smallest tenant-scoped idempotency record required. Do not weaken the requirement by treating an already-`needs_review` intake as proof that this particular command previously succeeded.

## Error Model

- `PAYMENT_INTAKE_NOT_FOUND`: no accessible tenant-owned intake.
- `PAYMENT_RECONCILIATION_REVIEW_STATE_CONFLICT`: locked status is not the expected `ready` state.
- `PAYMENT_RECONCILIATION_REVIEW_NOT_ELIGIBLE`: the current intake/proposal does not reproduce the authoritative backdated floating chronology conflict.
- `PAYMENT_RECONCILIATION_ALREADY_EXISTS`: reconciliation has already started or completed for this intake.
- `PAYMENT_RECONCILIATION_REASON_REQUIRED`: reason is blank.
- `IDEMPOTENCY_KEY_REQUIRED`: no stable command key was supplied.
- `IDEMPOTENCY_CONFLICT`: the key is bound to different command semantics.

All state, eligibility, and idempotency failures are fail-closed and produce no ledger mutation. MCP returns structured safe errors with `reviewRequired` set where operator action is necessary.

## Operational Flow

The agent workflow is:

```text
intake.get
  -> payment.reconcile.preflight (read-only; detects backdated conflict)
  -> show the exact intake, reason, and intended review transition
  -> explicit human confirmation
  -> payment.reconcile.mark-review
  -> payment.reconcile.preflight with explicit interest allocations
  -> payment.reconcile.preview
  -> show current preview, provenance, totals, warnings, and expiry
  -> fresh explicit human confirmation
  -> payment.reconcile.execute
```

The confirmation for `mark-review` authorizes only the workflow-state transition. It does not authorize `payment.reconcile.execute`. A fresh reconciliation preview and separate execution confirmation are mandatory. Ordinary payment proposals invalidated by the transition cannot be reused.

## Components and Integration

- Add a dedicated service command instead of calling the generic `reviewPaymentIntake` directly from MCP. Shared private helpers may be extracted for row locking, proposal invalidation, and auditing when this preserves existing Web behavior.
- Register the tool in the MCP name catalog, strict input/output schemas, handler map, destructive annotations, idempotency metadata, safe summaries, audit-action mapping, and frozen contract.
- Keep `payment.reconcile.preflight` in the read-only tool set.
- Update the root CreditSync and `reconcile-payments` skills so agents stop on the backdated-post error, run preflight, request review-transition confirmation, mark review, then run a new reconciliation preview and request execution confirmation.
- Update plugin README, changelog/version, eval catalog, scripted harness, validator expectations, and generated contract together.
- No frontend behavior change is required; the existing Web review control remains generic and unchanged.

## Verification

Backend disposable-PostgreSQL coverage must prove:

- eligible `ready` backdated floating intake transitions to `needs_review`;
- all active ordinary proposals become `stale` in the same transaction;
- no transaction, accrual, schedule, loan-balance, or evidence row changes;
- a normal postable `ready` intake is rejected as not eligible;
- `draft`, `needs_review`, `posted`, `reversed`, and `duplicate` sources are rejected without mutation;
- tenant isolation prevents cross-tenant lookup and mutation;
- identical idempotent retry returns the original result and one audit event;
- mismatched idempotent retry is rejected;
- concurrent post/review commands cannot produce an invalid intermediate state;
- reconciliation preflight and preview succeed only after the transition and still enforce complete interest provenance;
- stale ordinary proposals cannot be posted after transition.

MCP/plugin coverage must prove:

- the input and output schemas are closed and expose only safe public fields;
- the tool is destructive and idempotent, while preflight remains read-only;
- missing reason/key, stale status, non-eligible intake, and tenant failures are safe and structured;
- the scripted agent sequence includes two distinct human confirmations and forbids `payment.post` after review transition;
- the frozen contract, plugin manifest/version, skill guidance, evals, and validator remain synchronized.

Required verification gates are the backend disposable database suite and typecheck, relevant frontend tests if shared Web review code changes, plugin tests and validator, frozen-contract regeneration check, and a final diff review for money safety, audit completeness, and accidental exposure of sensitive payment fields.

## Rollout and Case Recovery

Deploy the backend/MCP and synchronized private plugin before attempting the blocked 4 September 2026 payment again. After deployment:

1. inspect the exact intake and rerun no-write preflight;
2. obtain explicit confirmation to mark it for reconciliation review;
3. invoke `payment.reconcile.mark-review` with a stable idempotency key and reason;
4. run fresh reconciliation preflight and preview against all five confirmed interest-only allocations totaling `165.00`;
5. obtain a separate execution confirmation;
6. execute only a current `ready` reconciliation preview with zero warnings and unchanged provenance.

Production posting, deployment, and this case's final reconciliation remain separate explicit authorizations. Implementation and tests must not create test financial records in a live tenant.
