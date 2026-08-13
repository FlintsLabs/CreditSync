# MCP Disbursement Draft PATCH Design

## Problem

CreditSync exposes MCP tools to create and post a loan-disbursement draft, but it does not expose the backend's existing draft-update operation. An agent that discovers an incorrect gross amount, attributed amount, payout metadata, or source cannot correct the draft safely through MCP. Creating another draft would leave duplicate draft records, while posting the incorrect draft would create an immutable financial record that requires compensation to reverse.

## Goals

- Expose a strict MCP PATCH operation for an existing loan-disbursement draft.
- Reuse the backend's tenant-scoped, row-locked, audited `updateDisbursementDraft` service.
- Preserve the dedicated evidence `prepare -> PUT -> finalize` lifecycle.
- Require agents to inspect the updated draft and variance again before obtaining a fresh post confirmation.
- Keep the backend, frozen MCP contract, CreditSync plugin instructions, executable evals, and validator synchronized.

## Non-goals

- No editing of posted or reversed disbursement events.
- No mutation of loan principal, schedules, funding allocations, interest, or repayment records.
- No evidence attachment or removal through the PATCH tool.
- No preview/execute persistence or optimistic-concurrency token for draft edits.
- No database migration.

## MCP contract

Add one tool named `loan.disbursement.update`.

### Input

```ts
{
  disbursementPublicId: UUID,
  changes: {
    grossAmount?: Money,
    loanAttributedAmount?: Money,
    channel?: "bank_transfer" | "cash" | "adjustment",
    sourceBankProfilePublicId?: UUID | null,
    payeeHint?: string | null,
    note?: string | null,
    disbursedAt?: ISODateTime
  }
}
```

Both the top-level input and `changes` object are closed schemas. `changes` must contain at least one property. Money remains a non-negative two-decimal public string. Text uses the existing MCP length/normalization rules. `evidenceFilePublicIds`, `loanPublicId`, status, internal IDs, and unknown fields are rejected at the MCP boundary.

### Output and annotations

The tool returns the existing public disbursement event DTO, including its public UUID, exact gross and attributed amounts, channel, draft status, source profile public UUID, payee/note/time, and evidence file public UUIDs. It must not return internal numeric IDs, signed URLs, storage keys, evidence contents, or identity data.

The operation is a write that mutates a financial-workflow draft, so its MCP annotations mark it destructive and non-read-only. It does not require an idempotency key because it is a partial editable-draft update rather than an immutable post; an identical retry is naturally state-equivalent and each accepted update remains audited.

## Backend data flow

The default MCP adapter passes `disbursementPublicId` and `changes` directly to `updateDisbursementDraft` under the MCP command context. The existing service remains authoritative and performs:

1. Tenant and actor accessibility checks.
2. Event and parent-loan row locks.
3. A status check that permits only `draft`.
4. Merge of only supplied PATCH fields with current stored values.
5. Exact money, channel, date, source-profile, and variance-note validation.
6. A guarded update whose predicate still requires `status = draft`.
7. Append-only `draft_updated` audit history with complete editable before/after snapshots.
8. Presentation of the updated public event while retaining finalized evidence links.

Posted or reversed events return the existing stable `DISBURSEMENT_LOCKED` conflict. Invalid source profiles, amounts, channels, dates, or missing explanatory notes use the existing domain errors. An empty `changes` object or undeclared property fails MCP input validation before the service call.

## Concurrency semantics

This design intentionally has no stale-state guard. Row locks prevent torn or partially interleaved writes, while PATCH semantics prevent a caller from overwriting fields it did not supply. If two callers concurrently edit the same field, the later locked write wins. The audit trail retains both transitions.

Because same-field last-writer-wins remains possible, MCP orchestration must never treat a successful update response as authority to post. It must re-list the loan's disbursements, locate the exact public draft UUID, show current gross/attributed amounts, signed variance, source/payee/time/note, and evidence state, then obtain a new explicit confirmation. A confirmation obtained before any update becomes invalid.

## Evidence safety

The PATCH schema deliberately excludes `evidenceFilePublicIds`. Evidence continues only through `loan.disbursement.evidence.prepare`, a direct signed PUT when a current upload URL exists, and `loan.disbursement.evidence.finalize`. Existing finalized evidence remains linked after a draft edit.

If an amount, payee, time, source, or note changes after evidence is finalized, the skill must call out that the evidence may no longer match the draft. The agent re-lists and stops for human review unless the visible evidence and current draft are explicitly confirmed together. The tool does not delete or silently replace evidence.

## Plugin and orchestration changes

Update `manage-disbursements` and root routing guidance to support:

```text
list -> select exact draft -> update -> list -> show exact state/variance/evidence -> fresh confirmation -> post
```

Add executable coverage for:

- A positive PATCH that corrects an attributed amount and then re-lists before confirmation/post.
- Rejection/stopping when a caller tries to edit a posted or reversed event.
- MCP-boundary rejection of an empty patch, evidence IDs, status, and unknown fields.
- Invalidation of any pre-update confirmation and mandatory post-update re-inspection.

Regenerate the frozen MCP contract. The catalog grows from 40 to 41 tools, so release the CreditSync plugin as `2.4.0`, update its changelog/validator expectations, and keep schema version `1.0` because the new tool is additive.

## Testing

Use TDD at each boundary:

- MCP server contract test for advertised name, closed input schema, destructive annotations, valid PATCH, and invalid empty/unknown/evidence fields.
- Database-backed default-adapter test proving the real service edits only supplied fields, preserves evidence, writes audit context, and rejects update after post.
- Existing service tests continue to cover row locking and immutable posted/reversed events; extend them only where the MCP workflow reveals an uncovered service invariant.
- Plugin contract, eval harness, frozen-contract generator, and validator must pass with 2.4.0, 8 skills, and 41 tools.

Run backend typecheck, focused disposable PostgreSQL suites, MCP server tests, plugin tests, and validator. No frontend build is required because this change adds no frontend behavior.

## Deployment and production verification

Commit the design, plan, implementation, tests, generated contract, plugin metadata, plugin changelog, and root changelog according to repository commit discipline. Deploy by rebuilding only the production backend container.

After deployment:

- Check backend migration/startup logs and internal MCP health.
- Confirm `tools/list` exposes `loan.disbursement.update` with closed PATCH schema and destructive annotation.
- Perform no production draft mutation merely to test the tool. Verify the write path against disposable PostgreSQL; production verification remains read-only unless the user separately identifies and confirms an exact draft correction.

## Success criteria

- Agents can PATCH an accessible disbursement draft without creating a duplicate draft.
- Only supplied fields change; finalized evidence links remain intact.
- Empty, unknown, evidence, status, posted, and reversed edits are rejected safely.
- The workflow re-lists and requires a fresh explicit confirmation before post.
- Frozen MCP contract, plugin 2.4.0 metadata, skills, evals, and validator remain synchronized at 41 tools.
- Production backend is healthy and advertises the new tool after deployment.
