# Backdated Payment Reconciliation Review Transition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a narrow, audited, idempotent MCP command that moves only an authoritatively verified backdated floating-payment intake from `ready` to `needs_review`, then allows the existing historical reconciliation workflow to proceed.

**Architecture:** Reuse the real `postPayment` allocator inside a transaction that is always rolled back to produce a no-write execution-feasibility result. Build `markPaymentReconciliationReview` around that shared probe, tenant-scoped locks, stale-proposal invalidation, and audit-backed idempotent replay; expose it through a closed MCP contract and synchronize the private plugin as version `9.0.0`.

**Tech Stack:** Bun, TypeScript, Elysia, Drizzle ORM, PostgreSQL, Zod, MCP SDK, Vitest/Bun test, JSON plugin contract.

**Spec:** `docs/superpowers/specs/2026-09-07-backdated-payment-review-transition-design.md`

## Global Constraints

- Money remains two-decimal strings and all financial calculations remain backend-owned with `decimal.js`; this feature adds no agent-side arithmetic.
- Use `Asia/Bangkok` business dates and keep the intake's existing ISO timestamp unchanged.
- Active terms and posted financial records remain immutable; this command creates no transaction, accrual, schedule, balance, or evidence mutation.
- Every write carries actor/source, request ID, correlation ID, a stable idempotency key, and append-only audit history.
- `payment.reconcile.preflight` remains read-only and must perform no durable write even when the real posting allocator is probed.
- The review transition and reconciliation execution require separate explicit human confirmations.
- MCP schemas stay closed, tenant-scoped, public-UUID-only, and free of raw payment/evidence identifiers beyond the selected intake UUID.
- Adding a tool changes the frozen `8.0.0` contract, so the private plugin, compatibility text, validator, release display, and tests move together to `9.0.0`.
- Update `CHANGELOG.md` before the implementation commit; update the root `README.md` because the operator workflow changes.
- Do not deploy, push, mutate production, or post the blocked 4 September payment as part of implementation.

---

### Task 1: Add a rollback-only ordinary payment feasibility probe

**Files:**
- Modify: `backend/src/services/payment-reconciliation-service.ts`
- Modify: `backend/src/services/payment-reconciliation-service.test.ts`
- Test: `backend/src/services/floating-allocation-regressions.test.ts`

**Interfaces:**
- Consumes: `postPayment(ctx, paymentIntakePublicId, { proposalPublicId }, tx)` from `backend/src/services/payment-service.ts`.
- Produces: `probePaymentPostFeasibility(ctx, input)` returning a discriminated result with `status: "postable" | "blocked"`, safe public identifiers, and a `DomainError` code for blocked execution. A private `probePaymentPostFeasibilityInTransaction(tx, ctx, input)` variant uses a nested transaction/savepoint so Task 2 can revalidate under the same outer locks.
- Produces: ordinary-proposal `preflightPaymentExecution` results whose `execute_feasibility` check comes from the real allocator and whose transaction is always rolled back.

- [ ] **Step 1: Write failing integration tests for the no-write probe**

Add fixtures that create a ready backdated floating payment proposal behind a later immutable floating allocation. Assert:

```ts
const before = await financialSnapshot(tenantId, loanPublicIds);
const result = await preflightPaymentExecution(ctx, {
    paymentIntakePublicId: backdatedIntake.publicId,
    proposalPublicId: backdatedProposal.publicId,
    reason: "Check ordinary posting feasibility",
});

expect(result).toMatchObject({
    status: "review_required",
    wouldWrite: false,
    reviewRequired: true,
    warning: { code: "FLOATING_BACKDATED_ALLOCATION_REQUIRES_RECONCILIATION" },
});
expect(await financialSnapshot(tenantId, loanPublicIds)).toEqual(before);
```

Also test a current postable proposal returns `ready_to_execute` and still leaves intake, proposals, transactions, accruals, floating allocations, loan balances, and schedules unchanged.

- [ ] **Step 2: Run the focused tests and verify the current false-positive behavior**

Run:

```bash
backend/scripts/test-disposable-postgres.sh \
  src/services/payment-reconciliation-service.test.ts \
  src/services/floating-allocation-regressions.test.ts
```

Expected: FAIL because ordinary-proposal preflight currently checks proposal metadata but does not run the posting allocator and reports the backdated proposal as executable.

- [ ] **Step 3: Implement the rollback sentinel and shared feasibility probe**

In `payment-reconciliation-service.ts`, add a private sentinel and exported result type:

```ts
const paymentPostProbeRollback = Symbol("payment-post-probe-rollback");

export type PaymentPostFeasibility =
    | { status: "postable"; paymentIntakePublicId: string; proposalPublicId: string }
    | { status: "blocked"; paymentIntakePublicId: string; proposalPublicId: string; error: DomainError };
```

Implement the probe by opening `db.transaction`, calling `postPayment` with that transaction, rejecting `{ stale: true }`, and throwing the sentinel after a successful simulated post so PostgreSQL rolls back every write. Put that logic in `probePaymentPostFeasibilityInTransaction`, using `tx.transaction(...)` as a nested savepoint when an outer transaction already owns the required locks. Catch only the sentinel as `postable`; convert a `DomainError` into `blocked`; rethrow unknown infrastructure errors.

```ts
export async function probePaymentPostFeasibility(
    ctx: CommandContext,
    input: { paymentIntakePublicId: string; proposalPublicId: string },
): Promise<PaymentPostFeasibility> {
    try {
        await db.transaction(async (tx) => {
            const result = await postPayment(ctx, input.paymentIntakePublicId, {
                proposalPublicId: input.proposalPublicId,
            }, tx);
            if ("stale" in result) {
                throw new DomainError("STALE_PAYMENT_PROPOSAL", "Payment proposal changed during feasibility check", 409);
            }
            throw paymentPostProbeRollback;
        });
    } catch (error) {
        if (error === paymentPostProbeRollback) return { status: "postable", ...input };
        if (error instanceof DomainError) return { status: "blocked", ...input, error };
        throw error;
    }
    throw new DomainError("PAYMENT_PREFLIGHT_FAILED", "Payment feasibility probe ended unexpectedly", 500);
}
```

If Bun/Drizzle wraps a thrown symbol, use a private `Error` subclass and identity/code check instead; never commit a transaction and compensate afterward.

- [ ] **Step 4: Route ordinary proposal preflight through the probe**

Keep the existing proposal/intake presentation logic, but replace the unconditional `execute_feasibility: pass` with the probe result. For `blocked`, append a failed check with the exact safe domain code and return `review_required`; do not map arbitrary infrastructure failures to operator-review results.

- [ ] **Step 5: Run focused tests**

Run the Step 2 command again.

Expected: PASS; the backdated case reports the exact conflict with `wouldWrite: false`, while a normal proposal reports `ready_to_execute` without persistent changes.

---

### Task 2: Implement the dedicated audited review transition

**Files:**
- Modify: `backend/src/services/payment-reconciliation-service.ts`
- Modify: `backend/src/services/payment-reconciliation-service.test.ts`
- Modify: `backend/src/services/payment-service.test.ts`

**Interfaces:**
- Consumes: `probePaymentPostFeasibility` from Task 1, `paymentIntakes`, `paymentMatchProposals`, `paymentReconciliationGroups`, `auditLogs`, and `createAuditLog`.
- Produces:

```ts
export interface MarkPaymentReconciliationReviewInput {
    paymentIntakePublicId: string;
    expectedStatus: "ready";
    reason: string;
    idempotencyKey: string;
}

export interface MarkPaymentReconciliationReviewResult {
    paymentIntakePublicId: string;
    beforeStatus: "ready";
    afterStatus: "needs_review";
    invalidatedProposalCount: number;
    auditPublicId: string;
    correlationId: string;
}

export async function markPaymentReconciliationReview(
    ctx: CommandContext,
    input: MarkPaymentReconciliationReviewInput,
): Promise<MarkPaymentReconciliationReviewResult>;
```

- [ ] **Step 1: Write failing service tests for eligibility and atomic effects**

Cover the accepted backdated case and assert exactly:

```ts
expect(result).toMatchObject({
    paymentIntakePublicId: intake.publicId,
    beforeStatus: "ready",
    afterStatus: "needs_review",
    invalidatedProposalCount: 1,
    correlationId: ctx.correlationId,
});
expect(refreshedIntake.status).toBe("needs_review");
expect(refreshedProposal.status).toBe("stale");
expect(audits).toHaveLength(1);
expect(audits[0]!.payload).toMatchObject({
    beforeStatus: "ready",
    afterStatus: "needs_review",
    reason: "Backdated floating payment requires reconciliation",
    idempotencyKey: "review-backdated-1",
});
expect(await financialSnapshot(tenantId, loanPublicIds)).toEqual(beforeFinancial);
```

Add negative cases for a postable ready proposal; missing/blank reason or key; `draft`, `needs_review`, `posted`, `reversed`, and `duplicate`; already-started reconciliation; wrong tenant; and stale/non-latest proposal.

- [ ] **Step 2: Write failing idempotency and concurrency tests**

Assert an identical retry returns the first result and leaves one audit row. Reuse of the key with another intake, expected status, or normalized reason must return `IDEMPOTENCY_CONFLICT`. Race the transition against `postPayment` and the generic Web `reviewPaymentIntake`; assert one serial outcome, no partial proposal state, and no financial mutation when review wins.

- [ ] **Step 3: Run focused service tests and verify failures**

Run:

```bash
backend/scripts/test-disposable-postgres.sh \
  src/services/payment-reconciliation-service.test.ts \
  src/services/payment-service.test.ts
```

Expected: FAIL because `markPaymentReconciliationReview` does not exist.

- [ ] **Step 4: Implement validation and audit-backed command idempotency**

Normalize `reason` and the command key first. Compute a SHA-256 fingerprint over:

```ts
{
    operation: "payment.reconcile.mark-review",
    paymentIntakePublicId,
    expectedStatus: "ready",
    reason,
}
```

Inside one transaction, take a tenant-and-operation-scoped PostgreSQL advisory lock derived from the idempotency key, then query `audit_logs` for `entityType = "payment_intake"`, `action = "reconciliation_review_marked"`, and the same payload key. If found, compare the stored request fingerprint and reconstruct only the safe stored result. A mismatch returns `IDEMPOTENCY_CONFLICT`; malformed stored output returns `IDEMPOTENT_RESULT_NOT_FOUND`.

Follow the established `lockCommand`, `priorCommandAudit`, request-fingerprint, and replay-result pattern in `backend/src/services/intermediary-profile-service.ts`; extract a shared helper only if it reduces duplication without broad refactoring. No database migration is planned because `audit_logs` already provides durable tenant-scoped command evidence and the advisory lock serializes first use.

- [ ] **Step 5: Implement locked eligibility and transition**

Before changing state, lock the tenant-owned intake, its latest proposal, target loans, and relevant allocation rows in deterministic order. Call `probePaymentPostFeasibilityInTransaction(tx, ctx, input)` so the simulated post runs in a nested rollback-only savepoint while the outer transaction retains those locks. Accept only the exact code `FLOATING_BACKDATED_ALLOCATION_REQUIRES_RECONCILIATION`; map a postable result or another failure to `PAYMENT_RECONCILIATION_REVIEW_NOT_ELIGIBLE` with safe details.

Reject an existing `payment_reconciliation_groups` row. Update only:

```ts
await tx.update(paymentIntakes).set({
    status: "needs_review",
    updatedByUserId: ctx.actorUserId,
    updatedAt: now,
});

const staleRows = await tx.update(paymentMatchProposals).set({
    status: "stale",
    updatedByUserId: ctx.actorUserId,
    updatedAt: now,
}).where(and(
    eq(paymentMatchProposals.tenantId, ctx.tenantId),
    eq(paymentMatchProposals.paymentIntakeId, intake.id),
    inArray(paymentMatchProposals.status, ["draft", "ready", "needs_review"]),
)).returning({ publicId: paymentMatchProposals.publicId });
```

Append one audit entry with the fingerprint, idempotency key, before/after status, normalized reason, invalidated count, and safe replay result. Do not place payer name, bank reference, evidence metadata, raw proposal snapshots, or internal IDs in the audit payload.

- [ ] **Step 6: Run focused service tests**

Run the Step 3 command again.

Expected: PASS, including replay, tenant isolation, races, proposal invalidation, and zero financial mutation.

---

### Task 3: Expose the transition through the MCP server

**Files:**
- Modify: `backend/src/mcp/server.ts`
- Modify: `backend/src/mcp/default.ts`
- Modify: `backend/src/mcp/server.test.ts`
- Modify: `backend/src/mcp/default.test.ts`
- Modify: `backend/src/mcp/loan-agent-tools.test.ts`

**Interfaces:**
- Consumes: `markPaymentReconciliationReview` from Task 2.
- Produces: MCP tool `payment.reconcile.mark-review` with a closed schema and safe output matching `MarkPaymentReconciliationReviewResult`.

- [ ] **Step 1: Write failing MCP contract and handler tests**

Assert the advertised tool has:

```ts
expect(tool.inputSchema).toMatchObject({
    additionalProperties: false,
    required: ["paymentIntakePublicId", "expectedStatus", "reason", "idempotencyKey"],
});
expect(tool.annotations).toMatchObject({
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
});
```

Assert `expectedStatus` is the literal `ready`, reason/key are non-blank and bounded, output contains safe public IDs/status/count only, and unknown fields are rejected. Add a default-handler test proving argument/context key mismatch returns `IDEMPOTENCY_CONFLICT` and no service call occurs.

- [ ] **Step 2: Run focused MCP tests and verify failure**

Run:

```bash
backend/scripts/test-disposable-postgres.sh \
  src/mcp/server.test.ts \
  src/mcp/default.test.ts \
  src/mcp/loan-agent-tools.test.ts
```

Expected: FAIL because the tool is absent from `MCP_TOOL_NAMES`, schemas, annotations, and handlers.

- [ ] **Step 3: Register the closed MCP contract**

Add `payment.reconcile.mark-review` adjacent to the other reconciliation tools in `MCP_TOOL_NAMES`. Define:

```ts
"payment.reconcile.mark-review": z.object({
    paymentIntakePublicId: uuid,
    expectedStatus: z.literal("ready"),
    reason: shortText,
    idempotencyKey: z.string().trim().min(1).max(200),
}).strict(),
```

Add a strict output schema for `paymentIntakePublicId`, `beforeStatus`, `afterStatus`, `invalidatedProposalCount`, `auditPublicId`, and `correlationId`. Register the tool as destructive and idempotent, but not as a financial posting tool: it returns its own audit/correlation fields and must not be wrapped into a second audit envelope.

- [ ] **Step 4: Wire the default handler and audit metadata**

Import `markPaymentReconciliationReview`. Resolve the canonical key as follows:

```ts
const argumentKey = asString(input, "idempotencyKey").trim();
const contextKey = ctx.idempotencyKey?.trim();
if (contextKey && contextKey !== argumentKey) {
    throw new DomainError("IDEMPOTENCY_CONFLICT", "Command and transport idempotency keys differ", 409);
}
return markPaymentReconciliationReview(
    { ...ctx, idempotencyKey: contextKey ?? argumentKey },
    {
        paymentIntakePublicId: asString(input, "paymentIntakePublicId"),
        expectedStatus: "ready",
        reason: asString(input, "reason"),
        idempotencyKey: argumentKey,
    },
);
```

Add the safe description and audit action mapping `payment_intake/reconciliation_review_marked`. Ensure error conversion marks state and eligibility conflicts as review-required without returning private fields.

- [ ] **Step 5: Run focused MCP tests**

Run the Step 2 command again.

Expected: PASS with exact tool ordering, strict schemas, annotations, safe outputs, handler coverage, and no regressions to read-only preflight.

---

### Task 4: Synchronize plugin 9.0.0 and orchestration guidance

**Files:**
- Modify: `plugins/creditsync/.codex-plugin/plugin.json`
- Modify: `plugins/creditsync/CHANGELOG.md`
- Modify: `plugins/creditsync/README.md`
- Modify: `plugins/creditsync/skills/creditsync/SKILL.md`
- Modify: `plugins/creditsync/skills/reconcile-payments/SKILL.md`
- Modify: `plugins/creditsync/references/error-recovery.md`
- Modify: `plugins/creditsync/evals/evals.json`
- Modify: `plugins/creditsync/evals/harness.ts`
- Modify: `plugins/creditsync/tests/eval-harness.test.ts`
- Modify: `plugins/creditsync/tests/operations-docs.test.ts`
- Modify: `plugins/creditsync/tests/plugin-contract.test.ts`
- Modify: `plugins/creditsync/scripts/validate.ts`
- Regenerate: `plugins/creditsync/references/mcp-tool-contract.json`
- Modify: `backend/src/mcp/contract-snapshot.ts`
- Modify: `frontend/src/lib/release.ts`
- Modify: `frontend/tests/collapsible-dashboard-sidebar.vitest.tsx`

**Interfaces:**
- Consumes: the advertised MCP contract from Task 3.
- Produces: a validated private plugin `9.0.0` whose skills enforce review-transition confirmation separately from reconciliation execution confirmation.

- [ ] **Step 1: Write failing plugin and eval tests**

Add one positive eval with ordered calls:

```json
{
  "id": "backdated-floating-mark-review-and-reconcile",
  "kind": "positive",
  "skill": "reconcile-payments",
  "expectedCalls": [
    "intake.get",
    "payment.reconcile.preflight",
    "payment.reconcile.mark-review",
    "payment.reconcile.preflight",
    "payment.reconcile.preview",
    "payment.reconcile.execute"
  ],
  "forbiddenCalls": ["payment.post"],
  "humanBoundary": "Mark-review and reconciliation execute require separate explicit confirmations."
}
```

Add negative evals proving no mark-review before confirmation, no execute under the mark-review confirmation, no ordinary post after transition, no reuse of a stale ordinary proposal, and no transition for unrelated preflight errors.

- [ ] **Step 2: Run plugin tests and verify failure**

Run:

```bash
cd plugins/creditsync
bun test
bun run validate
```

Expected: FAIL because version/tool contract/guidance/eval fixtures are not synchronized.

- [ ] **Step 3: Update orchestration guidance and recovery documentation**

Document this exact branch:

```text
ordinary preview
-> no-write preflight returns FLOATING_BACKDATED_ALLOCATION_REQUIRES_RECONCILIATION
-> inspect and show exact intake/reason
-> human confirms mark-review only
-> payment.reconcile.mark-review
-> fresh reconciliation preflight and preview
-> show provenance/totals/warnings/expiry
-> separate human confirmation
-> payment.reconcile.execute
```

State that `payment.reconcile.preflight` never changes status, `mark-review` accepts only eligible `ready` sources, and every ordinary proposal becomes stale. Keep `payment.post` forbidden after transition.

- [ ] **Step 4: Bump and regenerate the frozen contract**

Set plugin/validator/tests/frontend release display and compatibility strings to `9.0.0`. Regenerate from the backend:

```bash
bun plugins/creditsync/scripts/mcp-contract.ts --write
```

Do not hand-edit the generated JSON. Update plugin changelog with the new tool, rollback-only preflight feasibility, confirmation boundary, and safety behavior.

- [ ] **Step 5: Implement eval harness fixtures and assertions**

Model two distinct confirmation checkpoints in the scripted harness. The blocked branch must terminate before `mark-review`; the transitioned branch must reject `payment.post`; execute appears only after the fresh ready reconciliation preview and second confirmation.

- [ ] **Step 6: Run plugin and release tests**

Run:

```bash
cd plugins/creditsync
bun test
bun run validate
cd ../../frontend
bun test
```

Expected: PASS with plugin `9.0.0`, the regenerated contract exactly matching backend tool order/schema/annotations, 11 skills retained, and frontend release metadata synchronized.

---

### Task 5: Update product documentation, run all gates, and commit atomically

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Review: every file changed in Tasks 1–4

**Interfaces:**
- Consumes: all tested behavior from Tasks 1–4.
- Produces: one reviewable feature commit with synchronized code, tests, docs, plugin contract, and changelogs.

- [ ] **Step 1: Update README and changelog before staging**

Update the README payment workflow to include the dedicated mark-review branch and two confirmations. Add `v0.3.77 - 2026-09-07` to `CHANGELOG.md`, consolidating the change into concise `Added` and `Fixed` bullets: the new MCP transition and the ordinary preflight's real rollback-only execution probe.

- [ ] **Step 2: Run backend database suites serially**

Run:

```bash
backend/scripts/test-disposable-postgres.sh \
  src/services/payment-reconciliation-service.test.ts \
  src/services/payment-service.test.ts \
  src/services/floating-allocation-regressions.test.ts \
  src/mcp/default.test.ts \
  src/mcp/server.test.ts \
  src/mcp/loan-agent-tools.test.ts
```

Expected: PASS with no skipped database invariants.

- [ ] **Step 3: Run backend static verification**

Run:

```bash
cd backend
bun run typecheck
```

Expected: PASS.

- [ ] **Step 4: Run frontend verification**

Run:

```bash
cd frontend
bun test
bun run lint
bun run build
```

Expected: PASS; no Thai/English copy change is expected, and release metadata displays `9.0.0`.

- [ ] **Step 5: Run plugin verification and frozen-contract diff check**

Run:

```bash
cd plugins/creditsync
bun test
bun run validate
cd ../..
bun plugins/creditsync/scripts/mcp-contract.ts > /tmp/creditsync-mcp-contract.json
diff -u plugins/creditsync/references/mcp-tool-contract.json /tmp/creditsync-mcp-contract.json
```

Expected: all commands PASS and `diff` produces no output. The temporary file contains no secrets and may be removed after verification.

- [ ] **Step 6: Review the complete diff for financial and privacy invariants**

Run:

```bash
git diff --check
git diff --stat
git diff -- backend/src/services/payment-reconciliation-service.ts backend/src/mcp/server.ts backend/src/mcp/default.ts
git status --short
```

Confirm no posting/reconciliation formula was copied into the MCP/plugin layer; no raw payer, bank, QR, evidence, token, URL, or internal ID entered logs/contracts; preflight transactions always roll back; all ordinary proposals are stale after transition; and unrelated user changes remain untouched.

- [ ] **Step 7: Stage the synchronized change and verify staged metadata**

Run:

```bash
git add \
  CHANGELOG.md README.md \
  backend/src/services/payment-reconciliation-service.ts \
  backend/src/services/payment-reconciliation-service.test.ts \
  backend/src/services/payment-service.test.ts \
  backend/src/services/floating-allocation-regressions.test.ts \
  backend/src/mcp/server.ts backend/src/mcp/default.ts \
  backend/src/mcp/server.test.ts backend/src/mcp/default.test.ts \
  backend/src/mcp/loan-agent-tools.test.ts backend/src/mcp/contract-snapshot.ts \
  frontend/src/lib/release.ts \
  frontend/tests/collapsible-dashboard-sidebar.vitest.tsx \
  plugins/creditsync
git diff --cached --check
git diff --cached --stat
```

Before commit, verify that the root version/date/change types describe the staged set and that plugin `9.0.0` changelog/manifest/contract/validator agree. If unrelated dirty files exist, replace broad frontend/plugin paths with the exact owned files and leave user changes unstaged.

- [ ] **Step 8: Commit the feature**

Run:

```bash
git commit -m "feat: add backdated payment review transition"
```

Expected: one commit containing implementation, tests, root/plugin documentation, both changelogs, plugin version, and generated contract. Do not push, deploy, or invoke the new tool against production.

- [ ] **Step 9: Verify committed HEAD**

Run:

```bash
git status --short
git show --stat --oneline --decorate HEAD
git show --format= --check HEAD
```

Expected: clean working tree, expected synchronized files only, and no whitespace errors.

---

## Post-Implementation Operational Handoff

After deployment is separately authorized and completed, recover the blocked 4 September 2026 payment only through the production MCP sequence in the design spec. Re-inspect the exact intake and proposal, rerun preflight, obtain confirmation for mark-review, invoke the new tool with a stable key, generate a fresh interest-only reconciliation preview totaling `165.00`, obtain a second confirmation, and execute only if the preview is current, ready, warning-free, and provenance-complete.
