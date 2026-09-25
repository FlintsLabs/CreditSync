# Payment Workspace Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for the supervised tmux implementation required by this repository. Steps use checkbox (`- [ ]`) syntax for tracking. Use superpowers:test-driven-development for implementation and superpowers:verification-before-completion before reporting results.

**Goal:** Let operators import, edit, recover and post historical slips without cancel/recreate loops, while preserving evidence, immutable financial history and single-credit transfer identity.

**Architecture:** Add a durable workspace and shared resolution/operation layer over existing payment, recovery, identity and reconciliation services. Separate editable information, selection, evidence requirements and operation receipts; reuse accounting calculations through transaction-aware service adapters. REST, MCP and the existing payment screens consume the same capabilities and exact confirmation-bound plans.

**Tech Stack:** Existing Bun, TypeScript, Elysia, Drizzle/PostgreSQL, decimal.js, MinIO evidence gateway, React, Vitest, Playwright and MCP. No new framework, queue service or UI library.

**Spec:** `docs/superpowers/specs/2026-09-25-payment-workspace-recovery-design.md` — approved by the user on 2026-09-25.

## Global Constraints

- Financial calculations remain in backend services using decimal.js and two-decimal public strings.
- Keep transfer timestamp, Bangkok business date, target obligation date and system recording time distinct.
- Original evidence and posted financial rows remain immutable.
- Public data must be safe UUIDs and decimal strings.
- No financial effects, cancellation, identity execution or fact mutation as a side effect of preview.
- Only a ready plan with complete evidence/allocations, zero variance and no unresolved warnings can post.
- Initially retain the tenant-first mutex, a 2-second lock wait, a 15-second statement budget, a 30-second overall synchronous attempt budget, and at most three full transaction attempts for replay-safe `40P01`/`40001`.
- Keep existing screens/styles and Thai/English localization. MCP calls application services, not product REST.
- Preserve posted/cancelled history, old audit receipts and bank-reference uniqueness.
- No production test payments. No deployment, merge, push, production cleanup or newly discovered downstream reversal is authorized by approval of this plan alone.
- Each commit includes a contemporaneous versioned CHANGELOG entry; actual user-facing changes also update README in that commit. Do not claim planned functionality is already available.

## Review Focus

1. Double-click, lost response and browser reload must find one operation, including a request that committed before any operation UUID reached the client. Tasks 8 and 11 test lookup by idempotency key.
2. A user loses permissions between preview and replay: neither a saved confirmation nor a receipt may disclose another tenant's data. Tasks 6, 8 and 10 test authorization on every read/replay.
3. A signed PUT overwrites an object after HEAD: finalization must refer to verified immutable bytes, not mutable metadata. Task 2 tests object replacement and expiry.
4. A note changes while a financial edit is being reviewed: preserve the edited form/selection and do not invalidate a financial snapshot for note-only changes. Tasks 1, 6 and 11 test separate revisions and focused stale diffs.
5. Historical migration/backfill is interrupted after only some old staging rows are projected: rerunning must neither create extra requirements nor invent a confirmed identity. Tasks 1 and 12 test restart and mixed legacy/new writers.

---

## Delivery, ownership and execution gate

This plan is not implementation. The user approved the design; obtain approval of this detailed plan before starting the worker. Repository policy supplies the execution method: supervised tmux, not a new Codex task and not an unattended background agent.

This is one integrated project with two milestones, rather than independent subsystem plans: evidence coverage, transfer identity, staging membership and atomic posting share invariants and must not ship incompatible contracts.

- **Phase A:** Tasks 1–5 produce an audited service-level recovery path for the existing ten-slip shape. No direct database repair and no assertion that the entire redesign is complete.
- **Phase B:** Tasks 6–12 deliver unified preview/execution, historical impact handling, intermediary transport and Web/MCP usability.
- **Operational completion:** Task 13 prepares a fresh read-only backlog report; individually authorized recovery/posting follows only after deployed-version checks and any concrete additional decisions. Branch completion, deployment and backlog resolution are separate statuses.

Implementation baseline is documentation commit `0015183`, code baseline `250f523`. At worker start, record actual HEAD and rebase the plan's file assumptions if another approved change has landed. Existing untracked `.codex-task-logs/` and the September 12/13/20 plans/specs belong to the user; do not stage, remove or overwrite them.

After plan approval, use `superpowers:using-git-worktrees` to create an isolated branch `codex/payment-workspace-recovery`. Prefer sibling worktree `/home/flintstone/github/CreditSync-payment-workspace-recovery` only after confirming the path is unused. Start tmux session `creditsync-payment-workspace-recovery` with Codex CLI `--model gpt-5.6-luna --config model_reasoning_effort=\"medium\"`; inspect installed CLI help before selecting execution flags. If rejected/unavailable/exhausted, disclose the reason and use the current task's selected model, not an unrelated substitute. Pass both document paths, this entire plan, baseline, branch, financial rules and exclusions. Integration target is `main`, **but no merge is authorized**.

Report session, worktree, branch, active model and fallback status. Disconnect is safe only once the worker is actually running in tmux; it does not mean approval prompts or monitoring are automatic. Supervise output, diffs, tests and errors. A child reporting success is not verification.

## Verified file map and new boundaries

Existing files to reuse:

- `backend/src/services/payment-batch-service.ts`: staging, legacy batch completeness and execution. Do not add every new concern to this already large file.
- `payment-evidence-recovery-service.ts`, `payment-identity-decision-service.ts`, `payment-effective-evidence-service.ts`: authoritative recovery receipts, identity decisions and evidence coverage.
- `payment-service.ts`, `payment-reconciliation-service.ts`, `payment-reconciliation-reflow-service.ts`, `payment-allocation-correction-service.ts`: existing money calculations and compensations.
- `payment-chronology-service.ts`, `payment-chronology-guard.ts`, `payment-workflow-locks.ts`, `payment-workflow-blockers.ts`: existing guards and locking.
- `backend/src/services/intermediary-service.ts`: collection, manual debt approval, remittance and holder projection.
- `backend/src/modules/payment-batches.ts`, `backend/src/modules/payment-intakes.ts`, `backend/src/index.ts`: existing HTTP registration.
- `backend/src/mcp/default.ts`, `workflow-registry.ts`, `workflow-resolver.ts`, `tool-profiles.ts`: actual MCP service bindings/discovery. Do not assume registration lives in `server.ts`.
- `frontend/src/pages/dashboard/payments/PaymentInbox.tsx`, `PaymentInboxList.tsx`, `PaymentBatchEditor.tsx`, `PaymentCancelDialog.tsx`; `frontend/src/lib/workflow-api.ts`; locale JSON files.

New backend files, all under `backend/src/services/` unless another path is stated:

| File | Sole responsibility |
| --- | --- |
| `payment-workspace-types.ts` | Closed internal/public contracts and discriminated commands |
| `payment-workspace-service.ts` | Item projection, edits and selection events |
| `payment-evidence-slot-service.ts` | Requirements, attempt mapping and selected verified versions |
| `payment-workspace-binding-service.ts` | Receipt-authorized successor/canonical binding |
| `payment-workspace-capabilities.ts` | Legal actions and progress signatures |
| `payment-impact-plan-service.ts` | Consistent snapshot, issues, decisions and immutable preview |
| `payment-dependency-graph.ts` | Affected-obligation graph and connected groups |
| `payment-lifecycle-dependencies.ts` | Exact lifecycle-specific assisted routes |
| `payment-operation-service.ts` | Confirmation, receipt lookup and atomic group executor |
| `payment-operation-worker.ts` | Durable operation claim, resume and after-commit notification |
| `intermediary-collection-evidence-service.ts` | Collection evidence transport and policy-aware plan adapter |
| `backend/src/modules/payment-workspace.ts` | Thin closed-schema REST adapters |
| `backend/src/mcp/payment-workspace-tools.ts` | Thin closed-schema MCP adapters |

Do not create parallel payment ledgers. Add schema only for workspace/projection, slot/version mappings, plans and operation tracking that existing receipts cannot represent. At this baseline, the migration journal ends at `0085_payment_evidence_recovery_requirement_decisions`; reserve `0086_payment_workspace.sql`, `0087_payment_evidence_slots.sql` and `0088_payment_operation_plans.sql`. Recheck the journal before generation; if numbers are occupied, use the next free sequence and record that mapping in this plan.

## Shared contract decisions

Task 1 introduces these exported types. UUID/date/money aliases are TypeScript strings validated at each public boundary; they do not permit floats or unvalidated date values.

```ts
export type PublicId = string;
export type Money = string;
export type Revision = number;
export type ProductStatus = "needs_information" | "ready_to_review" |
  "processing" | "recorded" | "paused" | "cancelled";
export type PaymentRoute = "unresolved" | "direct" | "collection" | "remittance";
export type AllocationIntent = {
  borrowerPublicId: PublicId; loanPublicId: PublicId;
  schedulePublicId: PublicId | null; targetDueDate: string;
  amount: Money; intent: "on_time" | "advance" | "backdated";
};
export type WorkspaceFacts = {
  amount: Money | null; receivedAt: string | null; payerName: string | null;
  borrowerPublicId: PublicId | null; route: PaymentRoute;
  intermediaryPublicId: PublicId | null; allocations: AllocationIntent[];
};
export type WorkspaceItem = {
  publicId: PublicId; revision: Revision; financialRevision: Revision;
  status: ProductStatus; facts: WorkspaceFacts; notes: string | null;
  currentIntakePublicId: PublicId | null; stagingItemPublicId: PublicId | null;
  selectionPublicId: PublicId | null; actions: WorkspaceAction[];
};
export type ActionKind = "edit_facts" | "resolve_identity" | "upload_slot" |
  "continue_successor" | "resume_cancelled" | "bind_member" |
  "replan_chronology" | "confirm_dependency" | "refresh_plan" |
  "retry_contention" | "get_result" | "provide_dependency_input";
export type WorkspaceAction = {
  kind: ActionKind; targetPublicIds: PublicId[]; expectedStateHash: string;
  requiredInputs: string[]; confirmationRequired: boolean;
  retry: "none" | "same_key" | "after_input";
  expectedPostcondition: string; code: string;
};
export type WriteReceipt = { auditPublicId: PublicId; correlationId: string };
export type WorkspaceCommand = {
  itemPublicId: PublicId; expectedRevision: Revision;
  idempotencyKey: string; reason: string;
} & (
  { kind: "edit_facts"; changes: Partial<WorkspaceFacts> } |
  { kind: "edit_note"; notes: string | null } |
  { kind: "select"; selectionPublicId: PublicId; expectedSelectionRevision: Revision } |
  { kind: "remove"; selectionPublicId: PublicId; expectedSelectionRevision: Revision } |
  { kind: "pause" | "resume" | "cancel" }
);
```

Selections have their own revision. A move is one command with expected source and destination revisions, not two independent requests. Reads use keyset pagination with a bounded limit of 100 and an opaque cursor, never an unbounded tenant dump. New item creation accepts reviewed facts or nulls and an idempotency key; it does not accept raw account/QR/OCR dumps or attach raw file IDs.

The internal plan step is a discriminated union built from existing typed preview/execute inputs, not `Record<string, unknown>`. It supports recovery, identity, binding, scheduled payment/correction, floating reconciliation/reflow, collection recording/debt approval and remittance. Task 7 assigns unsupported lifecycle changes to concrete assisted actions instead of pretending they can execute atomically.

## Task 1: Durable editable items and auditable selections

**Files:** Create `payment-workspace-types.ts`, `payment-workspace-service.ts`, `backend/drizzle/0086_payment_workspace.sql`, `backend/src/services/payment-workspace-service.test.ts`, `backend/src/db/payment-workspace-migration.test.ts`; modify `backend/src/db/schema.ts`, `backend/drizzle/meta/_journal.json` and generated metadata.

**Interfaces:** Export `createPaymentWorkspaceItem(ctx, { clientItemKey, facts, idempotencyKey }): Promise<WorkspaceItem & WriteReceipt>`, `inspectPaymentWorkspaceItem(ctx, publicId): Promise<WorkspaceItem>`, `updatePaymentWorkspaceItem(ctx, command: WorkspaceCommand): Promise<WorkspaceItem & WriteReceipt>`, `createPaymentWorkspaceSelection(ctx, { idempotencyKey }): Promise<{ publicId: PublicId; revision: Revision } & WriteReceipt>`, and `movePaymentWorkspaceItem(ctx, { itemPublicId, expectedRevision, sourceSelectionPublicId, expectedSourceRevision, targetSelectionPublicId, expectedTargetRevision, reason, idempotencyKey }): Promise<WorkspaceItem & WriteReceipt>`. Export `listPaymentWorkspaceItems(ctx, { cursor?, limit?, status?, selectionPublicId? })` returning `{ items, nextCursor }`.

- [ ] Write a migration test applying baseline + additive migration twice through a restartable projection backfill. Seed one cancelled, one posted and one unresolved staging item. Assert original rows/identities unchanged, one stable projection per source, and no financial or identity-decision row created. Add tenant-composite foreign keys and unique source bindings.
- [ ] Write the first failing service test with the existing `users` fixture pattern:

```ts
test("note edits do not invalidate financial state", async () => {
  const tenantId = `workspace-${crypto.randomUUID()}`;
  const [owner] = await db.insert(users).values({
    tenantId, email: `${crypto.randomUUID()}@test.invalid`, role: "owner",
  }).returning();
  const ctx: CommandContext = { tenantId, actorUserId: owner!.id,
    actorSource: "web", requestId: crypto.randomUUID(), correlationId: crypto.randomUUID() };
  const item = await createPaymentWorkspaceItem(ctx, { clientItemKey: "synthetic-1",
    facts: { amount: "200.00", receivedAt: null, payerName: null,
      borrowerPublicId: null, route: "unresolved", intermediaryPublicId: null,
      allocations: [] }, idempotencyKey: "create-1" });
  const edited = await updatePaymentWorkspaceItem(ctx, {
    itemPublicId: item.publicId, expectedRevision: item.revision,
    kind: "edit_note", notes: "operator note", reason: "add context", idempotencyKey: "note-1",
  });
  expect(edited.revision).toBe(item.revision + 1);
  expect(edited.financialRevision).toBe(item.financialRevision);
  expect(edited.currentIntakePublicId).toBeNull();
});
```

- [ ] Run `bash backend/scripts/test-disposable-postgres.sh src/services/payment-workspace-service.test.ts`; expect missing service/export or failed assertions, not an environment failure.
- [ ] Implement revision-checked projection edits with audit and command receipts in one transaction. Increment `financialRevision` only for financially relevant facts/routing/selection/evidence changes. Keep immutable membership events and a separate current-selection projection; historical `payment_batch_items` uniqueness stays intact. Posted facts route to correction, not an UPDATE of their intake. Cancel uses existing cancellation capability/receipt, not a workspace-only label.
- [ ] Use explicit tables `payment_workspace_items`, `payment_workspace_selections`, `payment_workspace_membership_events`, and `payment_workspace_command_receipts`. Scope every relation by tenant; receipt uniqueness is tenant + command kind + idempotency key with a payload fingerprint. Add unique source-intake/staging bindings where present and one current selection per item. Events/receipts reject UPDATE/DELETE; mutable projections use expected revisions. Backfill has a persisted version/cursor and no inferred confirmation. Selection commands recheck selection revision/access as well as item revision. Edits to an already-bound mutable intake must update its reviewed facts and invalidate affected identity/proposal authorization atomically, or return a specific identity-review action when shared canonical facts cannot safely change.

```ts
const financialChange = command.kind !== "edit_note";
const nextRevision = item.revision + 1;
const nextFinancialRevision = item.financialRevision + (financialChange ? 1 : 0);
// Persist the projection, append event and receipt together under expectedRevision.
// A receipt replay checks access and request fingerprint before returning its result.
```

- [ ] Add stale-edit, select/remove/pause/resume/move, batch-cancel disclosure, cross-tenant, changed-key-payload and concurrent-move tests. Verify paused related obligations remain visible to chronology while unrelated items do not create a batch dependency. Removing one selection must not call whole-batch cancellation.
- [ ] Run both new tests through separate disposable-script invocations and `bun run --cwd backend typecheck`. Add CHANGELOG and README descriptions of the gated workspace service; commit `feat: add durable payment workspace selections` with exact task files.

## Task 2: Evidence slots independent of upload retries

**Files:** Create `payment-evidence-slot-service.ts`, `backend/drizzle/0087_payment_evidence_slots.sql`, `payment-evidence-slot-service.test.ts`; modify `schema.ts`, migration metadata, `payment-effective-evidence-service.ts`, `payment-evidence-recovery-service.ts`, `payment-batch-service.ts`, `payment-service.ts`.

**Interfaces:** Export `getPaymentEvidenceSlots(ctx, itemPublicId)`, `preparePaymentEvidenceSlot(ctx, { itemPublicId, slotPublicId, expectedRevision, mimeType, size, sha256, idempotencyKey }, gateway?)`, `finalizePaymentEvidenceSlot(ctx, { itemPublicId, attemptPublicId, expectedRevision, idempotencyKey }, gateway?)`, and `selectPaymentEvidenceSlotVersion(ctx, { itemPublicId, slotPublicId, evidencePublicId: PublicId | null, expectedRevision, reason, idempotencyKey })`. Prepare returns an attempt UUID and short-lived transport only when upload is needed; finalization returns a ready version UUID and `WriteReceipt`. Slot view: `{ publicId, purpose, required, selectedEvidencePublicId, ready, attemptCount }`. Export pure `summarizePaymentEvidenceSlots(slots): { requiredCount, readyRequiredCount, complete }`.

- [ ] Write the failing pure test and DB tests for three failed/expired attempts followed by one valid image, still one required slot:

```ts
expect(summarizePaymentEvidenceSlots([
  { publicId: "slot-1", purpose: "transfer", required: true,
    selectedEvidencePublicId: "evidence-4", ready: true, attemptCount: 4 },
])).toEqual({ requiredCount: 1, readyRequiredCount: 1, complete: true });
```

- [ ] Run `bash backend/scripts/test-disposable-postgres.sh src/services/payment-evidence-slot-service.test.ts`; require an assertion/export failure before implementation.
- [ ] Add immutable slot-selection events, attempt→slot links and selected-ready-version projection with tenant checks. Public mutation never accepts a storage file ID. Distinguish legacy floor from new slots: only a receipt-backed explicit requirement decision can reduce a legacy floor. Reuse existing effective-evidence coverage authorization, including cancelled ancestors.

```ts
const required = slots.filter(slot => slot.required);
return { requiredCount: required.length,
  readyRequiredCount: required.filter(slot => slot.ready).length,
  complete: required.every(slot => slot.ready) };
```

- [ ] Split prepare/finalize into reserve/read → external storage → short revalidate/commit. Reserve an attempt/object key first; no signed URL generation, HEAD or OCR under financial locks. Finalization must bind an immutable verified object version. If current storage has no safe version binding, copy conditionally to a server-only final key outside the transaction, verify checksum there, then bind it; do not rely on a mutable ETag alone. Expired PUT, failed copy and revision drift retain resumable attempt state.
- [ ] Test detached required slot, replace-after-post denial/supplement route, reused ready attempt, lost response, cancel during HEAD, overwrite after HEAD, cross-tenant ready evidence and cancelled-child coverage. Delayed fake HEAD must not prevent an unrelated short DB command from completing. Logs must omit signed URL, raw reference and image contents.
- [ ] Run focused slot and existing canonical-evidence/recovery suites in separate disposable invocations, then backend typecheck. Update CHANGELOG/README and commit `fix: decouple payment evidence requirements from upload attempts`.

## Task 3: Bind recovered/canonical intakes without orphan staging

**Files:** Create `payment-workspace-binding-service.ts`, `payment-workspace-binding-service.test.ts`; modify `payment-batch-service.ts`, `payment-workflow-blockers.ts`; extend `payment-workflow-recovery.test.ts`, `payment-batch-staging.integration.test.ts`.

**Interfaces:** Export `bindPaymentWorkspaceIntake(ctx, { itemPublicId, paymentIntakePublicId, expectedRevision, expectedSelectionRevision, reason, idempotencyKey }, tx?): Promise<WorkspaceItem & WriteReceipt>`. Binding is not identity authorization. Export `classifyPaymentMembershipConflict(error): "member_position" | "intake_membership" | "bank_identity" | null` using actual named constraints, including nested `cause`.

- [ ] Write the failing constraint-classification test, with actual names copied from `schema.ts`/migrations (do not classify every `23505` identically):

```ts
expect(classifyPaymentMembershipConflict({ cause: { code: "23505",
  constraint: "unrelated_unique_constraint" } })).toBeNull();
expect(classifyPaymentMembershipConflict({ cause: { code: "23505",
  constraint: "payment_batch_items_tenant_batch_order_unique" } })).toBe("member_position");
expect(classifyPaymentMembershipConflict({ cause: { code: "23505",
  constraint: "payment_batch_items_tenant_intake_unique" } })).toBe("intake_membership");
expect(classifyPaymentMembershipConflict(new Error("storage unavailable"))).toBeNull();
```

- [ ] Add DB scenario: cancelled source with incomplete evidence → existing recovery preview/confirmed execution → complete child slot → explicit identity decision where needed → bind into unresolved staging. Assert `paymentIntakeId`, `batchItemId`, validated staging and selected evidence all agree; a rollback injected between bindings leaves none of the partial links.
- [ ] Run `bash backend/scripts/test-disposable-postgres.sh src/services/payment-workspace-binding-service.test.ts` and observe RED.
- [ ] Implement under one tenant-first transaction. Inspect lineage/identity receipt, compare exact amount and confirmed time, tenant/owner and ready evidence; follow an existing successor before creating anything. For a canonical already used by a historical batch, preserve old membership and bind the new workspace projection; never insert a forbidden second historical membership to simulate moving it. A legacy unresolved staging row may be marked resolved only when its new binding is representable; old execution must reject new-only selection states explicitly.

```ts
const existing = await tx.select().from(paymentIntakes).where(and(
  eq(paymentIntakes.tenantId, ctx.tenantId),
  eq(paymentIntakes.publicId, input.paymentIntakePublicId),
));
if (!existing[0]) throw new DomainError("PAYMENT_NOT_FOUND", "Payment not found", 404);
// Check current access, lineage, exact facts and effective coverage before any links.
```

- [ ] Add posted-canonical result-only disposition, cancel-child/resume twice, cross-batch duplicate, occupied order vs identity collision, concurrent bind and incompatible facts tests. Derive execution order from business timestamp, obligation date, then UUID as stable tie-breaker—not concurrent insert order.
- [ ] Run binding, staging and recovery suites separately; typecheck. Update CHANGELOG/README and commit `fix: bind recovered payments into their workspace selection`.

## Task 4: One composable transaction boundary and bounded waits

**Files:** Modify `payment-workflow-locks.ts`, `payment-workflow-locks.test.ts`, `payment-workflow-concurrency.test.ts`; add transaction-aware entry points in `payment-service.ts`, `payment-batch-service.ts`, `payment-allocation-correction-service.ts`, `payment-reconciliation-service.ts`, `payment-reconciliation-reflow-service.ts`, `intermediary-service.ts`; create `docs/payment-workflow-lock-order.md`.

**Interfaces:** Preserve existing callers. Add `postPaymentInTransaction`, `executePaymentAllocationCorrectionInTransaction`, `executePaymentReconciliationInTransaction`, `executePaymentReconciliationReflowInTransaction`, `createIntermediaryCollectionInTransaction`, `manualApproveIntermediaryCollectionInTransaction` and `postIntermediaryRemittanceInTransaction`. Each keeps its existing service's typed public arguments in order and appends `tx: DbTransaction`; its return type is the existing service's return type. Public wrappers start a bounded transaction and call these variants. Reuse existing executor parameters in batch, recovery and identity services instead of creating duplicate variants. Extend `withPaymentWorkflowTransaction` options with `deadlineAtMs?: number`, using monotonic elapsed-time accounting internally. Internal variants must not start nested root transactions, call storage or publish success.

- [ ] Write tests for nested SQL cause classification and deadline exhaustion; retain current function name and existing options:

```ts
expect(isTransientPaymentWorkflowError({ cause: { code: "40P01" } })).toBe(true);
expect(isTransientPaymentWorkflowError({ cause: { code: "23505" } })).toBe(false);
await expect(withPaymentWorkflowTransaction(async () => "unreachable", {
  deadlineAtMs: Date.now() - 1,
})).rejects.toMatchObject({ code: "PAYMENT_OPERATION_DEADLINE" });
```

- [ ] Run lock tests and a DB concurrency test through the disposable runner; require RED for the new bound.
- [ ] Map all interacting writer call paths before changes, including cancellation, identity, recovery, evidence finalize, intermediary approval/remittance, loan rate/waiver/renewal/settlement/commission/disbursement changes and legacy endpoints. Record the common order: tenant → sorted identity keys → sorted borrowers → sorted selection/batch → sorted intake/preview rows → sorted loans/obligations. Existing nested calls must not acquire an earlier lock while retaining a later one. All competing paths take tenant mutex first. Limit changes in lifecycle services to this shared coordination boundary and tested assisted routes, not unrelated financial policy rewrites.
- [ ] Apply local statement/lock timeouts and a transaction-level time budget. PostgreSQL 18 in the disposable runner supports transaction timeout; check deployed DB version read-only before relying on it operationally. If unsupported, use a tested connection cancellation/rollback strategy, not `Promise.race` abandoning a live transaction. Bound each attempt by remaining overall time and count at most three full retries. Never retry a committed financial side effect outside receipt lookup.

```ts
await tx.execute(sql`SET LOCAL lock_timeout = '2000ms'`);
await tx.execute(sql`SET LOCAL statement_timeout = '15000ms'`);
// Set the transaction timeout to the remaining deadline before taking locks.
// Smaller remaining budgets override 15000ms; external I/O is outside this callback.
```

- [ ] Exercise post/post, post/cancel, finalize/cancel, identity/recovery and selection-edit/post using independent connections and explicit barriers in one serialized file. Assert one valid result or typed bounded contention, no partial writes, locks released after rollback, transaction retries ≤3, and no retry of domain/uniqueness/permission errors. Verify atomic composition by injecting failure after a nested service mutation.
- [ ] Run locks/concurrency and affected accounting suites separately, then typecheck. Update CHANGELOG, lock-order doc and README; commit `fix: bound and compose payment workflow transactions`.

## Task 5: Legal next actions and Phase A regression

**Files:** Create `payment-workspace-capabilities.ts`, `payment-workspace-capabilities.test.ts`, `payment-workspace-phase-a.integration.test.ts`; modify `payment-workflow-blockers.ts`, `backend/src/mcp/workflow-resolver.ts` and corresponding tests.

**Interfaces:** Export `evaluatePaymentWorkspaceCapabilities(snapshot): WorkspaceAction[]`, where `snapshot` contains accessible item, lineage, evidence, identity, dependencies and operation receipts. Export `paymentWorkspaceStateSignature(snapshot): string` with canonical sorting, and `detectPaymentRecoveryCycle({ previousSignatures, currentSignature, attemptedMutation }): boolean`. Define snapshot type in the same file and do not include raw secrets or unrelated note revisions.

- [ ] Write pure loop tests:

```ts
expect(detectPaymentRecoveryCycle({ previousSignatures: ["same"],
  currentSignature: "same", attemptedMutation: false })).toBe(false);
expect(detectPaymentRecoveryCycle({ previousSignatures: ["same"],
  currentSignature: "same", attemptedMutation: true })).toBe(true);
```

- [ ] Add synthetic ten-transfer scenario (September 15–24, each `200.00`, input deliberately shuffled), two cancelled originals, incomplete historical attempts, nine current intakes and unresolved day-16 staging. Use synthetic identities—not user's UUIDs or raw slip references. Complete via existing explicit recovery/identity previews plus Tasks 1–3. Assert exactly ten dispositions, original times, no ledger effects before financial confirmation and no repeated cancel requirement.
- [ ] Run capability and phase-A tests separately; require RED for the missing legal action/binding integration.
- [ ] Implement capabilities from the same preconditions called by commands. Existing posted result yields `get_result`; cancelled-with-child yields `continue_successor`; incomplete evidence yields slot action, not invalid cancelled upload. For each supported action require current targets, expected state, required inputs and postcondition. Unknown errors retain data and diagnostic UUID; no generic advice to cancel/recreate.

```ts
export function detectPaymentRecoveryCycle(input: {
  previousSignatures: readonly string[]; currentSignature: string; attemptedMutation: boolean;
}) {
  return input.attemptedMutation && input.previousSignatures.includes(input.currentSignature);
}
```

- [ ] Property-test action legality by generating bounded deterministic sequences of edit/remove/pause/recover/preview attempts. Store action-attempt progress for mutating orchestration only; repeated GET/preview does not consume a recovery attempt. A changed evidence/dependency fingerprint counts as progress; changing a note alone does not mask a loop.
- [ ] Run phase-A, resolver and blocker regressions; typecheck. Update docs/CHANGELOG and commit `feat: expose state-valid payment recovery actions`. Record Phase A as service-level verified only; do not post actual slips or claim full completion.

## Task 6: Complete impact previews with stable confirmation snapshots

**Files:** Create `payment-impact-plan-service.ts`, `payment-dependency-graph.ts`, their tests, `backend/drizzle/0088_payment_operation_plans.sql`; modify schema/metadata, `payment-chronology-service.ts`, `payment-chronology-guard.ts`, `payment-batch-accounting-planner.ts`.

**Interfaces:** Export `preparePaymentImpactPlan(ctx, input: PreparePaymentImpactPlanInput): Promise<PaymentImpactPlan & WriteReceipt>`. Define input as `{ selectionPublicId, expectedSelectionRevision, itemPublicIds, mode: "all_or_nothing" | "ready_groups", decisions, reason, idempotencyKey }`. `decisions` is a closed union of existing typed identity/recovery/requirement/dependency decisions, each explicitly scoped and reasoned. No arbitrary JSON instructions.

`PaymentImpactPlan` contains `publicId`, `status: "ready" | "needs_information" | "blocked"`, `selectedItemPublicIds`, `excludedItemPublicIds`, `groups`, `issues`, `notices`, `variance`, `previewHash`, `confirmationHash`, `expiresAt`, `snapshotVersion`. Each group has UUID, item UUIDs, dependency-version fingerprint, ready/blocked state, ordered typed steps and before/after component/holder totals. Each issue has code, targets and `WorkspaceAction[]`. Confirmation hash binds tenant, requesting authority/scope, ordered groups, mode, facts/financial revisions, evidence versions, decisions/reasons, underlying preview hashes and expiry.

- [ ] Add a test that two identical prepares yield equal financial snapshot/hash and do not change item facts or invalidate each other; notes may differ without changing the financial hash. Add missing amount + missing evidence + unresolved recipient together: return all three issues, not first-guard failure.
- [ ] Add exact decimal assertion for a pure total helper used by the planner, `sumPaymentPlanAmounts(amounts: readonly Money[]): Money`:

```ts
expect(sumPaymentPlanAmounts(["9007199254740993.01", "0.09"]))
  .toBe("9007199254740993.10");
```

- [ ] Run `bash backend/scripts/test-disposable-postgres.sh src/services/payment-impact-plan-service.test.ts` to RED.
- [ ] Extract read-only calculation portions from legacy preview services. Use a bounded consistent read snapshot with no exclusive financial mutex for calculations; persist the plan separately with dependency fingerprint, then recheck on execution. A legacy preview that writes decisions or requires an exclusive lock cannot be called unchanged here. Cached analysis carries versions and expires; it is not authorization.
- [ ] Bundled identity/recovery decisions use a pure projected-state planner: represent proposed successor IDs and exact inherited coverage without creating them; calculate subsequent binding/allocation against that projected state. Store preconditions and projected result hashes in the immutable plan. At execution, check the original snapshot once, execute the explicitly approved decisions in order, and require each resulting state to match the projection. Do not weaken individual identity/recovery guards or call a side-effecting preview to manufacture authority. If a combined result cannot be computed in advance, return the precise prerequisite action and leave financial execution disabled. Test bundled recovery→binding→payment rollback and a projected evidence mismatch.

```ts
export function sumPaymentPlanAmounts(amounts: readonly Money[]): Money {
  return amounts.reduce((total, amount) => total.plus(amount), new Decimal(0)).toFixed(2);
}
```

- [ ] Build edges from proven shared obligations/active allocation lineage/identity/lifecycle effects, not borrower equality alone. Unclassified older attachments surface as item questions, not blanket borrower blocks. Related pending work offers inclusion or supported explicit deferral; never auto-issue `confirm_no_older_pending`. Group by connected components, stable chronological ordering and UUID tie-breaker.
- [ ] Test day-15 exact scheduled obligation after day-20 posting, unrelated older draft, same-obligation older draft, Bangkok midnight, unknown/future timestamp, overpayment→settlement route, changed evidence/balance/permission stale diffs, exact grouped sum and ambiguous per-contract split. Read all accessible borrower loan statuses before candidate resolution; truncation/ambiguous aliases remain unresolved, never auto-select.
- [ ] Run impact/chronology/planner suites and typecheck. Update CHANGELOG/README; commit `feat: prepare complete payment impact plans`.

## Task 7: Historical correction and explicit lifecycle dependencies

**Files:** Create `payment-lifecycle-dependencies.ts`, `payment-lifecycle-dependencies.test.ts`; modify `payment-dependency-graph.ts`, `payment-reconciliation-service.ts`, `payment-reconciliation-reflow-service.ts`, `payment-allocation-correction-service.ts`; read `loan-renewal-service.ts`, `loan-settlement-service.ts`, `loan-waiver-service.ts`, `loan-commission-service.ts`, `loan-disbursement-service.ts`, `intermediary-service.ts`.

**Interfaces:** Export `inspectPaymentLifecycleDependencies(ctx, { loanPublicIds, fromBusinessDate }, executor): Promise<PaymentLifecycleDependency[]>`. Each dependency: `{ kind, publicId, expectedStateHash, affectedLoanPublicIds, effectSummary, route }`, with route discriminated as `integrated_compensation` (typed underlying preview references) or `assisted` (exact authorized service operation, required inputs, reason and expected postcondition). Export `planFloatingPaymentHistory(ctx, input, executor)` returning typed proposed compensation/repost steps or explicit issues, not executing them.

- [ ] Write table-driven tests for renewal, settlement, waiver, payout, commission and remittance dependencies. For assisted routes assert exact operation and required input, not `human_investigation`:

```ts
for (const dependency of dependencies) {
  expect(dependency.publicId).toBeTruthy();
  expect(dependency.expectedStateHash).toBeTruthy();
  if (dependency.route.kind === "assisted") {
    expect(dependency.route.operation).not.toBe("human_investigation");
    expect(dependency.route.requiredInputs.length).toBeGreaterThan(0);
    expect(dependency.route.expectedPostcondition).toBeTruthy();
  }
}
```

- [ ] Run `bash backend/scripts/test-disposable-postgres.sh src/services/payment-lifecycle-dependencies.test.ts` to RED.
- [ ] Implement direct scheduled allocation when outstanding obligation/penalty/waiver rules permit it; scheduled correction delegates to the existing correction preview. Floating history delegates to backend accrual/reflow, covers only affected intervals and retains rate/advance-interest policies. Where insertion/business-date orders differ, preserve the specified older-batch reversal → affected later-batch reversal → older repost → later repost order and reject unsupported dependency orderings explicitly.
- [ ] Implement and test this assisted routing table; these are retained blockers with a usable action, not an automatic reversal promise:

| Dependency | Required route |
| --- | --- |
| Renewal | Inspect affected original/renewed contracts and renewal reversal capability; request separate reversal confirmation/reason if allowed, otherwise identify exact downstream dependency first |
| Settlement | Inspect settlement and later effects; offer its supported compensating reversal with explicit reason/confirmation, then replan |
| Waiver | Show waived component/date and waiver reversal capability; require explicit decision about reinstating charges |
| Payout | Keep payout ledger immutable; show exact posted payout and request separate cash recovery/evidence or supported payout reversal decision; never infer cash returned |
| Commission | Show exact unpaid/paid commission dependency; use existing reversal capability if supported, otherwise require documented return/adjustment evidence and authorized accounting decision |
| Remittance | Inspect collections already credited and held balance; use remittance reversal/reallocation capability only with exact additional confirmation and evidence |

- [ ] Tests must execute each offered service route through its supported transitions on disposable data and then replan; for genuinely missing external input, submit that input and verify progress or the next concrete dependency. Do not pass a test merely by checking an action label. Unsupported paid-commission compensation stays a specifically documented assisted accounting action, never a fabricated new ledger write.
- [ ] Test reversed accrual, overallocated accrual, rate boundary, advance-period due date, immutable originals and rollback midway through floating reflow. Run applicable reconciliation/correction/loan lifecycle suites plus allocation-integrity checks on the disposable fixture; typecheck. Update docs/CHANGELOG and commit `feat: plan historical payment dependencies and correction routes`.

## Task 8: Atomic confirmed execution, receipts and restart recovery

**Files:** Create `payment-operation-service.ts`, `payment-operation-worker.ts`, their tests; extend operation schema from Task 6 and `backend/src/index.ts` for lifecycle-managed worker startup behind a feature flag.

**Interfaces:** Export `executePaymentImpactPlan(ctx, { planPublicId, previewHash, confirmationHash, confirmed: true, idempotencyKey }): Promise<PaymentOperation & WriteReceipt>`, `getPaymentOperation(ctx, { operationPublicId } | { idempotencyKey }): Promise<PaymentOperation>`, `resumePaymentOperation(ctx, operationPublicId)` (worker-only), and `runPaymentOperationWorker({ signal: AbortSignal })`. `PaymentOperation` includes UUID, status (`queued`, `running`, `committed`, `needs_repreview`, `failed`), mode, group statuses/receipts, safe issue/diff and result UUIDs. Failed attempts are append-only history; a committed receipt cannot be rewritten as failed by an outer catch.

- [ ] Add DB tests: response lost immediately after commit then lookup by idempotency key; same key/different hash conflict; actor access revoked; crash before transaction/after group commit/before notification; rollback after one internal step. Assert receipt and ledger are committed in the same transaction.

```ts
const first = await executePaymentImpactPlan(ctx, confirmedInput);
const replay = await executePaymentImpactPlan(ctx, confirmedInput);
expect(replay.publicId).toBe(first.publicId);
expect(await getPaymentOperation(ctx, { idempotencyKey: confirmedInput.idempotencyKey }))
  .toMatchObject({ publicId: first.publicId, status: "committed" });
await expect(executePaymentImpactPlan(ctx, {
  ...confirmedInput, confirmationHash: "different",
})).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
```

- [ ] Run `bash backend/scripts/test-disposable-postgres.sh src/services/payment-operation-service.test.ts` to RED.
- [ ] Implement request fingerprint/receipt lookup first, checking access even on replay. Resolve precomputed typed steps using Task 4 transaction-aware variants. Under locks re-read roles, revisions, identity, evidence, balances and dependencies; reject stale state before effects. Do not run a previously approved side-effecting preview again to silently expand scope.
- [ ] Store immutable plan snapshots in `payment_impact_plans`; durable state in `payment_operations`; immutable group commit results in `payment_operation_group_receipts`; append-only attempts in `payment_operation_attempts`; notification work in `payment_operation_outbox`. Use tenant-scoped command-key and operation/group uniqueness. Keep mutable lease/status projection separate from immutable receipts, and index tenant/status/next-attempt for claiming. No raw evidence, bank reference, signed transport or tokens in plan JSON, fingerprints' source logs or failure diagnostics. Receipt lookup by idempotency key is scoped to command/tenant and current authority, never a global lookup.
- [ ] All-or-nothing is one bounded transaction for the entire supported selection. Ready-groups mode binds the explicitly chosen ready group IDs and excluded groups to confirmation and gives each connected group an atomic receipt. If a group becomes stale, stop it and surface results for already committed independently approved groups. Never split one dependency group to fit timeouts.
- [ ] Persist durable job identity before deferring expensive plan preparation; queue computation without an open transaction. Claim jobs with short leases, owner token and expiry; a resumed worker checks receipt and revision before effects. Use DB operation/outbox rows with unique operation/group event keys for after-commit publication. Worker crashes and notification retries cannot repost money. An oversized atomic execution returns a concrete scope/correction action, never silently changes mode.
- [ ] Add two-worker claim/restart tests, queued role revocation, lock-timeout resume, 30-second budget and retry-count tests with controlled clocks/barriers. Confirm no success notification before COMMIT and operation polling is read-only. Update CHANGELOG/README; commit `feat: execute payment plans atomically with durable receipts` after operation/concurrency tests and typecheck.

## Task 9: Collection evidence and intermediary-aware payment plans

**Files:** Create `intermediary-collection-evidence-service.ts`, its tests; modify `intermediary-service.ts`, `payment-impact-plan-service.ts`, `payment-operation-service.ts`, schema/migration metadata only where existing file relations cannot represent collection evidence; extend `intermediary-service.test.ts`.

**Interfaces:** Export `prepareIntermediaryCollectionEvidence(ctx, collectionPublicId, input, gateway?)` and `finalizeIntermediaryCollectionEvidence(ctx, collectionPublicId, evidencePublicId, gateway?)`, matching existing remittance transport validation and Task 2 immutable-byte binding. Define typed plan decision `collectionTreatment: "record_only" | "approve_borrower_credit"` with policy/reference, exact scope and explicit reason; remittance has separate evidence and UUID.

- [ ] Test a collection-only receipt with no remittance: held `200.00`, operator received `0.00`, debt credit follows explicit chosen policy. Test manual borrower credit, then remittance and retry: credit remains `200.00`, not `400.00`.

```ts
expect(new Decimal(after.borrowerCredited).minus(before.borrowerCredited).toFixed(2))
  .toBe("0.00"); // Remittance of an already credited collection adds no debt credit.
expect(after.intermediaryHeld).toBe("0.00");
```

- [ ] Run `bash backend/scripts/test-disposable-postgres.sh src/services/intermediary-collection-evidence-service.test.ts` to RED.
- [ ] Implement upload ownership/MIME/size/checksum/expiry and confirmed intermediary assignment; a displayed payee name is only a routing candidate. Validate sender/on-behalf and receiving profile separately. Maintain collection gross, borrower allocation, operator receipt and held amount as four decimal-string values in preview and result.
- [ ] Delegate recording/manual approval/remittance to transaction-aware existing services. Evidence-optional channel requires supported policy and reason; it does not claim a file was verified. Wrong recipient, unclear channel, unsupported policy and absent remittance evidence produce concrete review actions. No generic financial `confirmed: true` substitutes for collection treatment.
- [ ] Test partial remittance, fees/variance warnings, already posted remittance, correction dependency, cross-tenant evidence and concurrent manual approve/remit. Change the registry's attachment blocker only in Task 10 after this real transport passes. Update CHANGELOG/README; commit `feat: support evidenced intermediary collection plans` after intermediary/operation tests and typecheck.

## Task 10: REST and MCP parity with legacy compatibility

**Files:** Create `backend/src/modules/payment-workspace.ts`, its tests, `backend/src/mcp/payment-workspace-tools.ts`, its tests; modify `backend/src/index.ts`, `backend/src/mcp/default.ts`, `tool-profiles.ts`, `workflow-registry.ts`, `workflow-resolver.ts`, `workflow-version.ts`, `plugins/creditsync/.codex-plugin/plugin.json`, frozen contract/profile JSON, relevant plugin skills, evals and validator tests.

**Interfaces:** Names fixed here; adapters directly invoke services from Tasks 1–9:

| REST under `/payment-workspace` | MCP capability name |
| --- | --- |
| `GET /items`, `GET /items/:id` | `payment.workspace.list`, `payment.workspace.inspect` |
| `POST /items`, `POST /items/:id/command` | `payment.workspace.create`, `payment.workspace.update` |
| `POST /selections`, `POST /items/:id/move` | `payment.workspace.selection.create`, `payment.workspace.move` |
| `POST /items/:id/evidence/prepare`, `/finalize`, `/select` | `payment.workspace.evidence.prepare`, `.finalize`, `.select` |
| `POST /items/:id/bind` | `payment.workspace.bind` |
| `POST /plans` | `payment.workspace.plan` |
| `POST /plans/:id/execute` | `payment.workspace.execute` |
| `GET /operations/:id`, `GET /operations?key=` | `payment.workspace.operation.get` (closed UUID-or-key union) |

Wire names follow existing capability→advertised tool normalization; regenerate the inventory, do not manually assume underscore names. Remittance/collection evidence adapters also remain callable through their domain tools. All writes return audit/correlation identifiers. Evidence signed transport is transient authorized output, excluded from audit snapshots and diagnostics.

- [ ] Write parity tests using the same fixture/context and service spies: equal facts/groups/actions/money from REST and MCP, no internal REST fetch. Add invalid extra property, float money, missing confirmation, wrong-tenant ID, unknown cursor and stale revision cases.

```ts
expect(restResult.groups).toEqual(mcpResult.groups);
expect(restResult.actions).toEqual(mcpResult.actions);
expect(tool.inputSchema.additionalProperties).toBe(false);
```

- [ ] Run new module/MCP tests through the disposable runner; require RED before wiring.
- [ ] Implement closed discriminated schemas; cap lists and string lengths. Reads have `readOnlyHint`; money execute and cancellation/reversal are destructive. Preview persists only plan/audit, so do not falsely mark it read-only if the advertised contract treats such writes as mutations. Sanitize errors while retaining safe participant UUIDs and diagnostic correlation.
- [ ] Keep old tools/routes operational for legacy-only states using shared validation/locks; new-only selected states return an explicit new-workspace action. Test old batch execute cannot bypass removed/paused items or evidence slots. Update resolver to offer collection evidence only after Task 9 support exists, and prevent repeated-state automation loops.
- [ ] Read current manifest/inventory again (baseline plugin `11.0.0`, full 145 tools, payments 67; these are observations, not target counts). Regenerate with `bun run plugins/creditsync/scripts/mcp-contract.ts --write` and `bun run plugins/creditsync/scripts/mcp-profiles.ts`, bump plugin contract version according to actual compatibility and synchronize skill/eval instructions. Retain explicit inspect→preview→human confirmation→post.
- [ ] Run `bun test plugins/creditsync/tests`, `bun run --cwd plugins/creditsync validate`, backend MCP/REST suites and typecheck. Update README/CHANGELOG; commit `feat: expose recoverable payment workspace through REST and MCP`.

## Task 11: Usable inbox editing, preview and operation status

**Files:** Modify `frontend/src/pages/dashboard/payments/PaymentInbox.tsx`, `PaymentInboxList.tsx`, `PaymentBatchEditor.tsx`, `PaymentCancelDialog.tsx`, `frontend/src/lib/workflow-api.ts`, `frontend/src/locales/th.json`, `en.json`; create `PaymentWorkspaceEditor.tsx`, `PaymentImpactPreview.tsx`, `PaymentOperationStatus.tsx` in the same payments directory; create `frontend/tests/payment-workspace.vitest.tsx`, `frontend/e2e/payment-workspace.spec.ts`.

**Interfaces:** Components consume the shared public DTO shapes, not backend runtime imports. `PaymentWorkspaceEditor` receives item, actions and revision-aware command callbacks. `PaymentImpactPreview` receives exact plan, mode and confirmation callback; `PaymentOperationStatus` receives an operation UUID or saved idempotency key and read-only refresh callback. API functions mirror Task 10 without calculating interest or reconstructing allocations client-side.

- [ ] Write UI tests before implementation: editing amount/date/contract does not call cancel; removing selection preserves item/evidence; pause/resume retains input; read-only inspection does not trigger automatic recovery. Mock API DTOs with synthetic labels and exact decimal strings.
- [ ] Add a lost-response/reload test: save only nonsensitive operation key/selection identifiers in session storage, retrieve receipt by key before offering retry, and verify one execute command across response recovery. Do not persist raw slips, references, signed URLs or bearer tokens.
- [ ] Run `bun run --cwd frontend test tests/payment-workspace.vitest.tsx` to RED.
- [ ] Implement three focused components in the existing visual system. Main actions: edit, upload/replace, remove from selection, pause, preview; cancellation is an explicitly separate destructive dialog with exact scope. Show ready/held groups, missing inputs and before/after amounts. Display collection holder and remittance state separately from borrower debt. No requirement for the user to manually choose staging/recovery/replacement service names.

```tsx
<Button disabled={plan.status !== "ready" || busy}
  onClick={() => onConfirm(plan.publicId, plan.previewHash, plan.confirmationHash)}>
  {t("paymentWorkspace.confirmPlan")}
</Button>
```

- [ ] Invalidation clears the confirmation control when financially relevant hash changes, retains selection and editable form state, and shows changed facts/dependencies. Note-only changes do not clear financial confirmation. Prevent double submits while exposing saved operation status. Preserve backend authoritative warnings; do not turn `blocked` into enabled UI by filtering messages.
- [ ] Add Thai/English keys together; use existing exact-money formatters and active language/Bangkok dates. Test long Thai names, glyphs/marks, amounts beyond safe integers, narrow layout, focus return after dialog/errors, keyboard selection and reduced-motion preference. No font/library replacement.
- [ ] Browser-test editing → upload retry → preview → stale refresh → explicit confirm → lost-response receipt, plus intermediary collection state and cancelled-source resume. Use existing Playwright local config and synthetic route fixtures; label mocked-browser vs real backend evidence separately. Verify installed Chromium path before overrides.
- [ ] Run frontend tests/lint/build and `bun run --cwd frontend test:e2e e2e/payment-workspace.spec.ts`. Update README/CHANGELOG; commit `feat: add editable payment workspace and impact confirmation UI`.

## Task 12: Full invariant matrix, migration rehearsal and branch verification

**Files:** Create `backend/src/services/payment-workspace-state-machine.test.ts`, `payment-workspace-concurrency.integration.test.ts`, `backend/src/db/payment-workspace-compatibility.test.ts`, `docs/payment-workspace-operations.md`; extend touched suites/evals rather than creating a second accounting harness.

**Interfaces:** No new public capability. Tests invoke public service commands and transaction hooks/barriers limited to test options, not production bypass flags.

- [ ] Add deterministic seeded operation-sequence tests with bounded generated sequences: import/edit/evidence detach/replace/select/remove/pause/cancel/recover/preview/execute. Assert after every step: immutable posted data, exact conservation, at most one active effect per identity, authorized evidence coverage, and legal next actions. Failed commands cannot leave partial event/receipt state.

```ts
expect(new Decimal(totalAllocated).plus(totalUnallocated).toFixed(2)).toBe(totalReceived);
expect(activeEffectsPerIdentity.every(count => count <= 1)).toBe(true);
expect(postedOriginalSnapshotAfter).toEqual(postedOriginalSnapshotBefore);
```

- [ ] Cover the full spec §14 matrix, not just the original incident: same-payer equal-amount distinct transfers plus an unreviewed third; cross-batch posted duplicate; cancellation chain; wrong-role receipt replay; missing required image; backdate renewal/waiver/remittance; response loss; concurrent post/cancel/finalize/merge/move. Test both contender arrival orders with independent connections inside one serialized file.
- [ ] Rehearse baseline→new migrations with posted/cancelled history and mixed legacy rows; stop and restart projection backfill; verify legacy floors and identity decisions unchanged. Disable feature gate and assert old writers reject unsupported new states while new receipts/history remain readable. Rollback means disable writers, not delete new schema/history.
- [ ] Execute each release gate at the final feature HEAD. Commands from repository root:

```bash
bash backend/scripts/test-disposable-postgres.sh
bun run --cwd backend typecheck
bun run --cwd frontend test
bun run --cwd frontend lint
bun run --cwd frontend build
bun test plugins/creditsync/tests
bun run --cwd plugins/creditsync validate
bun run --cwd frontend test:e2e e2e/payment-workspace.spec.ts
git diff --check
```

- [ ] Do not run multiple destructive backend files concurrently. A skipped changed financial invariant is a failed release gate. Distinguish dependency/environment failures, baseline unrelated failures and regressions, but do not report a green release until required failures are resolved or explicitly accepted as a release blocker.
- [ ] Write a verification report with HEAD, commands, pass/fail/skips, timing bounds, tested DB version, migration checks, browser screenshots/traces and residual assisted routes. Artifacts exclude private evidence and secrets. Update CHANGELOG/README before commit `test: verify payment workspace recovery and compatibility`.
- [ ] Controller independently checks final diff, commits, branch status, user-change preservation and required gates. Obtain an independent code review if available; do not claim one when unavailable. Complete on isolated branch by default; no push/deploy/merge. Report any difference between branch completion and the spec's operational completion.

## Task 13: Actual backlog read-only report and separately authorized rollout

**Files:** Create `docs/payment-workspace-backlog-recovery-runbook.md` with procedure and redacted report template, not raw customer slips or references. No production write script with default execution.

**Interfaces:** Use existing CreditSync MCP inspect/loan portfolio/history/collection/remittance tools and new workspace reads after version checks. Any operational command uses the exact reviewed plan and idempotency key; no raw SQL repair.

- [ ] Before reading actual slips, load `creditsync-slip-ocr` and follow its evidence handling. Inspect the deployed version and capabilities read-only. If new code is not deployed, report that deployment authorization is needed; do not pretend local tests repaired production.
- [ ] Re-inspect the specified contract `01a09e2e-2070-7f2b-9a49-fa76a5055c2e`, canonical borrower/confirmed aliases and full accessible portfolio; all original cancelled intakes, new staging/drafts/successors, later postings, evidence readiness, recipient profile and collection/remittance history. Do not trust earlier transcribed bank references; compare fresh evidence without persisting raw QR/reference/account data.
- [ ] Report one row per September 15–24 transfer with confirmed Bangkok time, `200.00` amount where freshly verified, current disposition, canonical/successor reference, target obligation/allocation, evidence requirement, holder and missing decision. Aggregate only exact decimal strings. A changed amount/time from the old conversation is a review issue, not permission to overwrite.
- [ ] Clearly separate unchanged previous authority (listed payments and cancellation of original 15/16 drafts) from new authority needed for identity decisions, intermediary treatment, downstream compensations or deployment. Ask only the concrete missing decision. No broad cancellation/cleanup or assumed remittance.
- [ ] After separately authorized deployment: verify migrations/columns, logs, backend internal `/mcp/health` through Docker and frontend `http://127.0.0.1:8088/`; do not create a live test payment. Preserve feature-gate rollback and support receipt reads.
- [ ] After individually authorized execution: re-read histories and schedule/accrual integrity, exact posted/reversed allocations, duplicate identity effects and intermediary balances. Floating repairs require `check-floating-allocation-integrity.ts` and `verify-floating-payment-repair.ts` on the authorized target with their documented environment, never guessed script arguments. No completion claim if downstream dependency or evidence remains unresolved.

## Self-review and spec coverage

| Approved spec | Implementing tasks |
| --- | --- |
| §§1–4 workspace, distinct actions, stable identity and history | 1, 3, 5, 11 |
| §5 slots, retries, legacy floors, outside-lock I/O | 2, 4, 12 |
| §6 complete preview, exact confirmation, stale diff | 6, 8, 10, 11 |
| §7 scheduled/floating history, dependency groups, partial-mode choice | 6, 7, 8 |
| §8 successor/identity/staging/member repair | 3, 5, 12 |
| §9 collection vs remittance and transport | 9, 10, 11 |
| §§10–11 bounded transactions, receipts, valid actions, cycles | 4, 5, 8, 12 |
| §12 Web/MCP, additive migrations and compatibility | 1, 2, 6, 10, 11, 12 |
| §§13–15 two phases, real backlog, authorization and verification | 5, 12, 13 |

All review-focus cases have an owning task. Test snippets define new expected behavior, not claims that tests already ran. Method/type names in the shared contract are the integration boundary; if code inspection requires a changed interface, update producer, consumer tests and plan together without weakening confirmation or atomicity. Approval of this plan authorizes implementation within these boundaries, not deployment or money movement.
