# Atomic Batch Payment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an evidence-backed, editable, one-confirmation payment batch that can allocate multiple slips across multiple scheduled loans for one resolved borrower and post every item atomically.

**Architecture:** Add a versioned `payment_batches` aggregate beside the existing single-intake workflow. A deterministic exact-combination solver and explicit-allocation preview service produce one semantic confirmation hash for the complete batch; execution re-simulates under deterministic PostgreSQL locks and either writes every existing payment/ledger effect in one transaction or writes none. REST, MCP, plugin, and Web UI adapters consume the same application service and preserve the existing single-payment path.

**Tech Stack:** Bun, TypeScript, Elysia, Drizzle ORM, PostgreSQL, `decimal.js`, Zod, React, Vitest, MCP SDK 1.30.0.

**Spec:** `docs/superpowers/specs/2026-08-23-atomic-batch-payment-design.md`

## Global Constraints

- First release supports active scheduled loans for one resolved borrower per batch; floating loans and intermediary remittances are out of scope.
- Money crosses interfaces as two-decimal decimal strings and all arithmetic uses `decimal.js`; never use JavaScript `Number` for financial values.
- Business timestamps and due dates follow Asia/Bangkok, ISO 8601, and `YYYY-MM-DD` rules.
- Tags and fuzzy matches rank candidates only; they never authorize an identity or financial allocation.
- Evidence follows prepare -> direct signed PUT -> finalize and must be `ready` before a slip-backed item can enter a ready preview.
- Posted transactions, schedules, fund effects, and audit records remain append-only/immutable; corrections use compensating workflows.
- Batch execution carries actor/source, request/correlation ID, an execution idempotency key, and complete audit public IDs.
- Existing `intake.create -> payment.preview -> payment.post` behavior remains compatible.
- Update `CHANGELOG.md` before every implementation commit; update `README.md` in the commit that exposes the new operator workflow.
- Use Bun commands and `backend/scripts/test-disposable-postgres.sh`; never run database-mutating test files concurrently against the disposable database.

---

## File and Responsibility Map

- `backend/drizzle/0051_atomic_batch_payments.sql`: generated batch, item, preview, allocation, indexes, checks, tenant-safe foreign keys, plus reviewed posted-row immutability triggers.
- `backend/src/db/schema.ts`: Drizzle definitions for the new batch tables.
- `backend/src/db/atomic-batch-payment-migration.test.ts`: migration contract and PostgreSQL constraint/trigger verification.
- `backend/src/services/payment-batch-types.ts`: closed domain input/output types and semantic snapshot types shared by solver and service.
- `backend/src/services/payment-batch-solver.ts`: bounded deterministic exact-combination solver with no persistence.
- `backend/src/services/payment-batch-solver.test.ts`: pure solver tests, including ambiguous and joint multi-slip cases.
- `backend/src/services/payment-batch-service.ts`: create/add/get/preview/confirm/execute lifecycle, locking, hashes, duplicate checks, and atomic posting.
- `backend/src/services/payment-batch-service.test.ts`: disposable-PostgreSQL integration coverage for lifecycle, semantics, concurrency, rollback, and idempotency.
- `backend/src/services/payment-service.ts`: export focused internal posting primitives that accept an existing transaction without weakening single-payment safety.
- `backend/src/modules/payment-batches.ts`: authenticated REST adapter.
- `backend/src/modules/payment-batches.test.ts`: REST schema, auth, and error contract tests.
- `backend/src/index.ts`: register the REST adapter.
- `backend/src/mcp/default.ts`: MCP handlers calling batch services directly.
- `backend/src/mcp/server.ts`: tool names, closed schemas, annotations, and richer recovery flags.
- `backend/src/mcp/default.test.ts`, `backend/src/mcp/server.test.ts`: real-adapter and protocol contract tests.
- `backend/src/mcp/contract-snapshot.ts`: frozen advertised MCP contract.
- `frontend/src/pages/dashboard/payments/payment-batch-model.ts`: exact display/editor model and request conversion.
- `frontend/src/pages/dashboard/payments/PaymentBatchEditor.tsx`: batch upload, candidate review, allocation editing, one confirmation, and execution status.
- `frontend/src/pages/dashboard/payments/PaymentBatchEditor.test.tsx`: localized operator-flow tests.
- `frontend/src/pages/dashboard/payments/PaymentInbox.tsx`: entry point and batch-detail integration.
- `frontend/src/locales/en.json`, `frontend/src/locales/th.json`: synchronized copy.
- `plugins/creditsync/skills/reconcile-payments/SKILL.md`: agent batch workflow and stop-all rules.
- `plugins/creditsync/references/mcp-tool-contract.json`: regenerated frozen contract.
- `plugins/creditsync/references/matching-policy.md`, `plugins/creditsync/references/error-recovery.md`: candidate and retry/human-review policy.
- `plugins/creditsync/evals/evals.json`, `plugins/creditsync/evals/harness.ts`: multi-slip/multi-loan evals.
- `plugins/creditsync/.codex-plugin/plugin.json`, `plugins/creditsync/scripts/validate.ts`: version 7.4.0 and synchronized validator expectations.
- `README.md`, `CHANGELOG.md`: operator workflow and release record.

### Task 1: Persist the Batch Aggregate Safely

**Files:**
- Create: `backend/drizzle/0051_atomic_batch_payments.sql`
- Create: `backend/src/db/atomic-batch-payment-migration.test.ts`
- Modify: `backend/src/db/schema.ts`
- Modify: `backend/drizzle/meta/_journal.json`
- Generate: `backend/drizzle/meta/0051_snapshot.json`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces: Drizzle exports `paymentBatches`, `paymentBatchItems`, `paymentBatchPreviews`, and `paymentBatchAllocations`.
- Produces: unique `(tenant_id, id)` keys for tenant-safe references and `(tenant_id, idempotency_key)` for create/execute retry safety.
- Consumes: existing `paymentIntakes`, `borrowers`, `loans`, `loanSchedules`, `users`, and audit conventions from `backend/src/db/schema.ts`.

- [ ] **Step 1: Write a migration shape test that fails before the SQL exists**

```ts
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

test("atomic batch payment migration defines tenant-safe lifecycle tables", async () => {
    const sql = await readFile(new URL("../../drizzle/0051_atomic_batch_payments.sql", import.meta.url), "utf8");
    for (const table of ["payment_batches", "payment_batch_items", "payment_batch_previews", "payment_batch_allocations"]) {
        expect(sql).toContain(`CREATE TABLE \"${table}\"`);
    }
    expect(sql).toContain("payment_batches_tenant_idempotency_unique");
    expect(sql).toContain("payment_batch_items_tenant_intake_unique");
    expect(sql).toContain("payment_batch_previews_tenant_batch_version_unique");
    expect(sql).toContain("payment_batch_allocations_tenant_preview_order_unique");
    expect(sql).toContain("payment_batch_posted_immutable");
});
```

- [ ] **Step 2: Run the focused test and verify the missing-file failure**

Run: `cd backend && bun test src/db/atomic-batch-payment-migration.test.ts`

Expected: FAIL because `0051_atomic_batch_payments.sql` does not exist.

- [ ] **Step 3: Add the schema definitions**

Define the Drizzle tables with these exact statuses and columns:

```sql
status text NOT NULL DEFAULT 'draft'
  CHECK (status IN ('draft','needs_review','ready','confirmed','posted','stale','cancelled')),
version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
state_hash text,
confirmation_hash text,
confirmed_version integer,
create_idempotency_key text NOT NULL,
execute_idempotency_key text,
execute_request_hash text,
posted_at timestamptz
```

Use `numeric` for all amounts and JSONB only for warnings/candidate snapshots that do not replace relational financial rows. Add tenant-composite foreign keys and triggers that reject update/delete of posted batch, item, preview, and allocation rows except the exact status transitions made inside the posting transaction.

- [ ] **Step 4: Generate the named migration, add immutability triggers, and run migration tests**

Run: `cd backend && bun x drizzle-kit generate --name atomic_batch_payments`

Expected generation: `drizzle/0051_atomic_batch_payments.sql` and `drizzle/meta/0051_snapshot.json`. Review the generated SQL, then append the trigger functions/tests required by the approved design; do not rename or hand-create a competing migration.

Run: `cd backend && bun test src/db/atomic-batch-payment-migration.test.ts src/db/agent-workflow-schema.test.ts`

Expected: PASS; generated SQL must remain `0051_atomic_batch_payments.sql` and match the reviewed definitions.

- [ ] **Step 5: Verify PostgreSQL constraints with the disposable database**

Extend the migration test to insert cross-tenant references, duplicate intake membership, invalid statuses, and mutations after `posted`; expect PostgreSQL constraint/trigger rejection for each.

Run: `cd backend && ./scripts/test-disposable-postgres.sh src/db/atomic-batch-payment-migration.test.ts`

Expected: PASS with no skipped database assertion.

- [ ] **Step 6: Record and commit the schema slice**

Add a `### Added` changelog bullet under the current version describing the batch aggregate and immutability constraints.

```bash
git add CHANGELOG.md backend/drizzle/0051_atomic_batch_payments.sql backend/drizzle/meta/_journal.json backend/drizzle/meta/0051_snapshot.json backend/src/db/schema.ts backend/src/db/atomic-batch-payment-migration.test.ts
git commit -m "feat: add atomic payment batch schema"
```

### Task 2: Build the Deterministic Joint Exact-combination Solver

**Files:**
- Create: `backend/src/services/payment-batch-types.ts`
- Create: `backend/src/services/payment-batch-solver.ts`
- Create: `backend/src/services/payment-batch-solver.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces: `solvePaymentBatch(input: BatchSolveInput): BatchSolveResult`.
- Produces: `BatchObligation`, `BatchSlip`, `BatchCandidate`, `ExplicitBatchAllocation`, and `BatchWarning` types.
- Consumes: exact two-decimal strings and stable public IDs; has no database dependency.

- [ ] **Step 1: Define the closed solver types and failing unique/ambiguous tests**

```ts
export type BatchObligation = {
    borrowerPublicId: string;
    loanPublicId: string;
    schedulePublicId: string;
    dueDate: string;
    remainingDue: string;
    principalDue: string;
    interestDue: string;
    feeDue: string;
    penaltyDue: string;
};

export type BatchSlip = {
    itemPublicId: string;
    amount: string;
    receivedAt: string;
    requestedDueDate?: string;
    allowAdvance?: boolean;
    allowBackdated?: boolean;
};
```

Test 30.00 + 20.00 versus 50.00 as two materially distinct candidates for a 50.00 slip. Test a second slip jointly so no schedule appears twice.

- [ ] **Step 2: Run tests and verify the missing solver failure**

Run: `cd backend && bun test src/services/payment-batch-solver.test.ts`

Expected: FAIL because `solvePaymentBatch` is not implemented.

- [ ] **Step 3: Implement bounded integer-cent search**

Parse decimal strings with `Decimal`, assert two decimal places, convert to integer-cent strings/BigInt only inside the solver, sort obligations by due date then loan/schedule UUID, and backtrack deterministically. Enforce constants:

```ts
export const MAX_BATCH_ITEMS = 50;
export const MAX_BATCH_OBLIGATIONS = 200;
export const MAX_BATCH_CANDIDATES = 25;
export const MAX_SOLVER_STATES = 100_000;
```

Return `BATCH_SOLVER_LIMIT_REACHED` with `needs_review` when a cap is reached. Never select the first candidate automatically when more than one materially distinct result exists.

- [ ] **Step 4: Add policy tests**

Cover deterministic ordering, exact unique match, ambiguous match, joint multi-slip consumption, requested due date, forbidden implicit advance/backdated payment, gaps, zero/negative/three-decimal rejection, candidate cap, and identical-output deduplication.

Run: `cd backend && bun test src/services/payment-batch-solver.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the pure solver**

Update the changelog with one consolidated solver bullet.

```bash
git add CHANGELOG.md backend/src/services/payment-batch-types.ts backend/src/services/payment-batch-solver.ts backend/src/services/payment-batch-solver.test.ts
git commit -m "feat: solve joint payment batch allocations"
```

### Task 3: Implement Batch Creation, Item Membership, and Reads

**Files:**
- Create: `backend/src/services/payment-batch-service.ts`
- Create: `backend/src/services/payment-batch-service.test.ts`
- Modify: `backend/src/services/payment-service.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces: `createPaymentBatch`, `addPaymentBatchItem`, `getPaymentBatch`, and `cancelPaymentBatch`.
- Produces: `PaymentBatchView` with borrower candidates, items, evidence status, latest preview, and lifecycle.
- Consumes: existing `createPaymentIntake`, `preparePaymentEvidence`, and `finalizePaymentEvidence`; no evidence bytes pass through the service.

- [ ] **Step 1: Write failing lifecycle integration tests**

Create a batch twice with the same idempotency key and assert the same public ID. Add two different intakes, reject reusing one intake in another batch, reject posted/reversed/duplicate intakes, and verify tenant/portfolio isolation.

- [ ] **Step 2: Run the disposable suite and verify failures**

Run: `cd backend && ./scripts/test-disposable-postgres.sh src/services/payment-batch-service.test.ts`

Expected: FAIL because batch service functions do not exist.

- [ ] **Step 3: Implement lifecycle functions with command context**

Use signatures:

```ts
export async function createPaymentBatch(
    ctx: CommandContext,
    input: { idempotencyKey: string; borrowerPublicId?: string | null; notes?: string | null },
): Promise<PaymentBatchView>;

export async function addPaymentBatchItem(
    ctx: CommandContext,
    batchPublicId: string,
    input: { paymentIntakePublicId: string; itemOrder: number },
): Promise<PaymentBatchView>;
```

Hash idempotent requests, reject conflicting reuse, create append-only audit events, and return only public/safe fields.

- [ ] **Step 4: Add candidate resolution without automatic fuzzy authority**

Expose canonical/confirmed-alias unique resolution and ranked prior-payer/tag candidates. Persist a selected borrower only from an authoritative unique match or explicit human public UUID. Tests must prove tag-only and fuzzy-only matches remain `needs_review`.

- [ ] **Step 5: Run tests and typecheck**

Run: `cd backend && ./scripts/test-disposable-postgres.sh src/services/payment-batch-service.test.ts`

Run: `cd backend && bun run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit batch lifecycle**

```bash
git add CHANGELOG.md backend/src/services/payment-batch-service.ts backend/src/services/payment-batch-service.test.ts backend/src/services/payment-service.ts
git commit -m "feat: add payment batch lifecycle"
```

### Task 4: Build Versioned Batch Preview and Whole-batch Editing

**Files:**
- Modify: `backend/src/services/payment-batch-service.ts`
- Modify: `backend/src/services/payment-batch-service.test.ts`
- Modify: `backend/src/services/payment-batch-types.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces: `previewPaymentBatch(ctx, batchPublicId, input): Promise<PaymentBatchPreviewView>`.
- Consumes: `solvePaymentBatch` for inferred candidates or explicit allocations supplied by the operator/agent.
- Produces: stable `stateHash`, `previewHash`, and `confirmationHash` using versioned SHA-256 format.

- [ ] **Step 1: Write failing preview tests**

Test unique inferred allocation becomes `ready`; ambiguous 30+20 versus 50 becomes `needs_review`; explicit human allocation creates a newer ready preview; the prior preview becomes stale; no intake or schedule is posted during preview.

- [ ] **Step 2: Run tests and verify failure**

Run: `cd backend && ./scripts/test-disposable-postgres.sh src/services/payment-batch-service.test.ts`

Expected: FAIL because preview is absent.

- [ ] **Step 3: Implement explicit preview input**

```ts
export type PreviewPaymentBatchInput = {
    borrowerPublicId: string;
    allocations?: Array<{
        itemPublicId: string;
        loanPublicId: string;
        schedulePublicId: string;
        amount: string;
        targetDueDate: string;
        intent: "on_time" | "advance" | "backdated";
    }>;
};
```

Require every item amount to be allocated exactly, prohibit schedule reuse beyond its current obligation, calculate components through backend-authoritative payment allocation helpers, and persist all materially distinct candidates when review is required.

- [ ] **Step 4: Implement semantic hashing**

`stateHash` covers only accounting fields needed to reproduce execution. `confirmationHash` serializes sorted item/evidence UUIDs, transfer timestamps, loan/schedule UUIDs, target due dates, amounts, calculated components, intent, and acknowledged warning codes. It excludes database IDs, preview version, `updatedAt`, and expiry timestamps.

- [ ] **Step 5: Verify full-preview edits and evidence gates**

Tests must prove one explicit request can replace allocations for several items, version increments once, missing/pending evidence blocks `ready`, and ready evidence retries do not create another intent.

Run: `cd backend && ./scripts/test-disposable-postgres.sh src/services/payment-batch-service.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit preview support**

```bash
git add CHANGELOG.md backend/src/services/payment-batch-service.ts backend/src/services/payment-batch-service.test.ts backend/src/services/payment-batch-types.ts
git commit -m "feat: preview editable payment batches"
```

### Task 5: Execute the Batch Atomically

**Files:**
- Modify: `backend/src/services/payment-service.ts`
- Modify: `backend/src/services/payment-service.test.ts`
- Modify: `backend/src/services/payment-batch-service.ts`
- Modify: `backend/src/services/payment-batch-service.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces: `executePaymentBatch(ctx, batchPublicId, input): Promise<PostedPaymentBatchView>`.
- Produces: internal `postPaymentAllocationInTransaction(tx, ctx, intake, allocations)` reused by single and batch posting.
- Consumes: latest preview public ID, preview hash, confirmation hash, `confirmed: true`, and command-context idempotency key.

- [ ] **Step 1: Write failing atomic execution and rollback tests**

Seed three items across two loans. Assert all transactions/schedules/fund effects/audits post together. Inject a failure after the second item and assert all tables retain their exact pre-execution state.

- [ ] **Step 2: Write failing concurrency and idempotency tests**

Execute the same batch concurrently and assert one economic result. Execute two batches against the same loan and assert deterministic serialization, semantic re-simulation, and no partial posting.

- [ ] **Step 3: Run the disposable suite and verify failures**

Run: `cd backend && ./scripts/test-disposable-postgres.sh src/services/payment-service.test.ts src/services/payment-batch-service.test.ts`

Expected: FAIL because atomic execution is absent.

- [ ] **Step 4: Extract the existing posting primitive without changing behavior**

Move the transaction body of `postPayment` into an internal function that receives an already locked intake/proposal/allocation set. Keep the public single-payment function responsible for its existing locks, latest-proposal checks, state hash, idempotency, cache invalidation, and return shape. Run existing payment tests before adding batch use.

Run: `cd backend && ./scripts/test-disposable-postgres.sh src/services/payment-service.test.ts`

Expected: PASS with no snapshot/economic change.

- [ ] **Step 5: Implement deterministic batch locks and re-simulation**

Lock batch, intakes, loans, schedules, preview, and allocations in documented ID order. Recalculate progressive allocations inside the execution transaction. If the confirmation hash is identical, proceed even when state version metadata changed. If semantics differ, update the batch to `stale`, roll back financial writes, and return `BATCH_CONFIRMATION_STALE` after the transaction boundary.

- [ ] **Step 6: Implement all-or-nothing posting and audit lineage**

Create individual existing transactions and fund effects, mark each intake posted, mark preview/allocations posted, write one batch-level audit containing only public IDs and totals, then mark the batch posted. Return `auditPublicIds` and one correlation ID.

- [ ] **Step 7: Run full financial verification**

Run: `cd backend && ./scripts/test-disposable-postgres.sh src/services/payment-service.test.ts src/services/payment-batch-service.test.ts`

Run: `cd backend && bun run typecheck`

Expected: PASS; no skipped DB case.

- [ ] **Step 8: Commit atomic execution**

```bash
git add CHANGELOG.md backend/src/services/payment-service.ts backend/src/services/payment-service.test.ts backend/src/services/payment-batch-service.ts backend/src/services/payment-batch-service.test.ts
git commit -m "feat: post payment batches atomically"
```

### Task 6: Add the Authenticated REST Workflow

**Files:**
- Create: `backend/src/modules/payment-batches.ts`
- Create: `backend/src/modules/payment-batches.test.ts`
- Modify: `backend/src/index.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces: `/payment-batches` create/get/item/preview/execute endpoints.
- Consumes: payment batch application service only.

- [ ] **Step 1: Write failing route contract tests**

Cover unauthorized access, closed request bodies, tenant isolation, exact decimal strings, explicit allocations, `confirmed: true`, idempotency header, and safe error bodies.

- [ ] **Step 2: Run tests and verify missing routes**

Run: `cd backend && bun test src/modules/payment-batches.test.ts`

Expected: FAIL with 404/missing module.

- [ ] **Step 3: Implement routes**

Add:

```text
POST /payment-batches
GET  /payment-batches/:id
POST /payment-batches/:id/items
POST /payment-batches/:id/preview
POST /payment-batches/:id/execute
```

Evidence endpoints continue to operate on each item intake through the existing signed-upload routes; the batch read returns intake/evidence public IDs needed by the client.

- [ ] **Step 4: Run route tests and backend typecheck**

Run: `cd backend && bun test src/modules/payment-batches.test.ts`

Run: `cd backend && bun run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit REST adapters**

```bash
git add CHANGELOG.md backend/src/index.ts backend/src/modules/payment-batches.ts backend/src/modules/payment-batches.test.ts
git commit -m "feat: expose payment batch API"
```

### Task 7: Expose Closed MCP Batch Tools and Recovery Semantics

**Files:**
- Modify: `backend/src/mcp/server.ts`
- Modify: `backend/src/mcp/default.ts`
- Modify: `backend/src/mcp/server.test.ts`
- Modify: `backend/src/mcp/default.test.ts`
- Modify: `backend/src/mcp/contract-snapshot.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces tools: `payment.batch.create`, `payment.batch.item.add`, `payment.batch.evidence.prepare`, `payment.batch.evidence.finalize`, `payment.batch.get`, `payment.batch.preview`, and `payment.batch.execute`.
- Batch evidence tools delegate to the existing payment-evidence service using the selected batch item intake; they preserve prepare -> signed PUT -> finalize and return the batch/item public IDs needed for safe continuation.
- Produces error flags `retryable`, `repreviewRequired`, and `humanReviewRequired` while retaining compatibility for existing `reviewRequired` consumers during one plugin version.

- [ ] **Step 1: Write failing advertised-contract tests**

Assert tool order, closed schemas, read/write/destructive annotations, two-decimal formats, `confirmed: true`, and safe public outputs. Assert stale-state-with-identical-semantics is repreviewable without human review, while changed allocation semantics requires human review.

- [ ] **Step 2: Run focused MCP tests and verify failures**

Run: `cd backend && bun test src/mcp/server.test.ts src/mcp/default.test.ts`

Expected: FAIL because batch tools and recovery flags are absent.

- [ ] **Step 3: Implement handlers and schemas**

Handlers call the batch service directly. Mark create/item/preview as writes, get as read-only, and execute as destructive. Do not expose signed URLs after evidence readiness or include raw payer/evidence fields in errors.

- [ ] **Step 4: Replace blanket 409 human-review mapping**

Map domain errors explicitly:

```ts
const repreviewCodes = new Set(["BATCH_STATE_CHANGED_SEMANTICS_SAME", "BATCH_EXECUTION_CONFLICT"]);
const humanReviewCodes = new Set(["BATCH_NEEDS_REVIEW", "BATCH_DUPLICATE_EVIDENCE", "BATCH_ALLOCATION_MISMATCH", "BATCH_CONFIRMATION_STALE"]);
```

Existing non-batch 409 behavior remains unchanged in this task to avoid an unrelated contract migration.

- [ ] **Step 5: Add a real-adapter batch scenario**

Create two intakes with ready fixture evidence, preview explicit allocations across two schedules, execute once, retry idempotently, and inspect loan payment history/audits.

- [ ] **Step 6: Run MCP and type verification**

Run: `cd backend && bun test src/mcp/server.test.ts src/mcp/default.test.ts`

Run: `cd backend && bun run typecheck`

Expected: PASS.

- [ ] **Step 7: Commit MCP support**

```bash
git add CHANGELOG.md backend/src/mcp/server.ts backend/src/mcp/default.ts backend/src/mcp/server.test.ts backend/src/mcp/default.test.ts backend/src/mcp/contract-snapshot.ts
git commit -m "feat: add payment batch MCP workflow"
```

### Task 8: Synchronize CreditSync Plugin 7.4.0

**Files:**
- Modify: `plugins/creditsync/.codex-plugin/plugin.json`
- Modify: `plugins/creditsync/scripts/validate.ts`
- Modify: `plugins/creditsync/skills/reconcile-payments/SKILL.md`
- Modify: `plugins/creditsync/references/matching-policy.md`
- Modify: `plugins/creditsync/references/error-recovery.md`
- Regenerate: `plugins/creditsync/references/mcp-tool-contract.json`
- Modify: `plugins/creditsync/evals/evals.json`
- Modify: `plugins/creditsync/evals/harness.ts`
- Modify: `plugins/creditsync/tests/validator.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: final MCP tool list and frozen contract from Task 7.
- Produces: plugin 7.4.0 guidance and eval coverage for multi-slip/multi-loan stop-all behavior.

- [ ] **Step 1: Add failing validator/eval expectations**

Require skill guidance for all seven batch tools, exact-combination ambiguity, one confirmation for the latest complete preview, stop-all behavior, evidence-ready retry, and no automatic tag/fuzzy allocation.

- [ ] **Step 2: Run validator and verify failure**

Run: `cd plugins/creditsync && bun test tests/validator.test.ts && bun run validate`

Expected: FAIL because version, contract, guidance, and eval cases are stale.

- [ ] **Step 3: Update skill and policy references**

Document agent behavior:

```text
inspect all slips and targets
prepare/finalize evidence concurrently
preview the complete batch once
stop all items on any ambiguity
apply human explicit allocations in one preview revision
show the complete semantic summary
obtain one explicit confirmation
execute once with stable idempotency
verify every posted intake and loan balance
```

- [ ] **Step 4: Add eval scenarios**

Include one unique exact combination, one ambiguous 30+20 versus 50 choice, one human explicit multi-item edit, one duplicate that blocks the whole batch, one same-semantics repreview without repeat confirmation, and one changed-semantics case requiring confirmation.

- [ ] **Step 5: Regenerate and validate the frozen contract**

Run: `cd plugins/creditsync && bun run scripts/mcp-contract.ts --write`

Run: `cd plugins/creditsync && bun test && bun run validate`

Expected: PASS and plugin version exactly `7.4.0` everywhere.

- [ ] **Step 6: Commit synchronized plugin**

```bash
git add CHANGELOG.md plugins/creditsync
git commit -m "feat: teach plugin atomic payment batches"
```

### Task 9: Build the Localized Batch Preview Editor

**Files:**
- Create: `frontend/src/pages/dashboard/payments/payment-batch-model.ts`
- Create: `frontend/src/pages/dashboard/payments/payment-batch-model.test.ts`
- Create: `frontend/src/pages/dashboard/payments/PaymentBatchEditor.tsx`
- Create: `frontend/src/pages/dashboard/payments/PaymentBatchEditor.test.tsx`
- Modify: `frontend/src/pages/dashboard/payments/PaymentInbox.tsx`
- Modify: `frontend/src/locales/en.json`
- Modify: `frontend/src/locales/th.json`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: REST batch view/preview/execute contract from Task 6.
- Produces: `toExplicitBatchAllocations(editorRows)` with exact decimal strings and one complete preview revision request.

- [ ] **Step 1: Write failing model tests**

Test one slip split across loans, multiple slips edited in one state update, exact total/unallocated calculation with `decimal.js`, deterministic row ordering, and no browser-locale money arithmetic.

- [ ] **Step 2: Run model tests and verify failure**

Run: `cd frontend && bun test src/pages/dashboard/payments/payment-batch-model.test.ts`

Expected: FAIL because the model does not exist.

- [ ] **Step 3: Implement the editor model**

Keep all money fields as strings, use `Decimal` for totals, identify rows by stable item/allocation UUIDs, and produce one closed preview request containing every row.

- [ ] **Step 4: Write failing component tests**

Render ambiguous candidates, select an alternative, edit several allocations, request one re-preview, require the latest ready preview before enabling confirm, display before/after balances, and verify one execute call after confirmation.

- [ ] **Step 5: Implement the component and upload concurrency**

Hash/prepare/upload/finalize files with bounded concurrency of four. Do not preview until every required evidence item is ready. Keep execute disabled when any warning, unallocated amount, stale revision, or pending evidence remains.

- [ ] **Step 6: Add synchronized Thai and English copy**

Add matching keys for batch statuses, ambiguity choices, advance/backdated labels, total evidence/allocated/unallocated, one-confirmation summary, stale-semantic retry, and full-batch stop messages.

- [ ] **Step 7: Run frontend gates**

Run: `cd frontend && bun test`

Run: `cd frontend && bun run lint`

Run: `cd frontend && bun run build`

Expected: PASS.

- [x] **Step 8: Commit the Web UI**

```bash
git add CHANGELOG.md frontend/src/pages/dashboard/payments frontend/src/locales/en.json frontend/src/locales/th.json
git commit -m "feat: add payment batch preview editor"
```

### Task 10: Document, Verify, and Release the Complete Workflow

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/superpowers/specs/2026-08-23-atomic-batch-payment-design.md` only if implementation discoveries require an approved clarification
- Modify: `docs/superpowers/plans/2026-08-23-atomic-batch-payment.md` only to check completed steps or record exact command corrections

**Interfaces:**
- Consumes: all prior task deliverables.
- Produces: operator documentation and final verified release candidate without deployment.

- [x] **Step 1: Update operator documentation**

Document when the agent chooses batch flow, how one slip can split across loans, why ambiguity stops the whole batch, how whole-batch prompt edits work, one-confirmation semantics, and how retries avoid duplicate posting. Do not include real borrower data, references, signed URLs, or evidence.

- [ ] **Step 2: Run complete backend financial gates**

Run: `cd backend && ./scripts/test-disposable-postgres.sh`

Run: `cd backend && bun run typecheck`

Expected: PASS; database suites run serially and none of the new financial invariant tests skip.

- [ ] **Step 3: Run complete MCP/plugin gates**

Run: `cd backend && bun test src/mcp/server.test.ts src/mcp/default.test.ts`

Run: `cd plugins/creditsync && bun test && bun run validate`

Expected: PASS and committed contract equals advertised contract.

- [x] **Step 4: Run complete frontend gates**

Run: `cd frontend && bun test && bun run lint && bun run build`

Expected: PASS.

- [ ] **Step 5: Audit the final diff and database safety**

Verify no `Number` financial arithmetic, no raw evidence/reference/QR/signed URL logging, no internal MCP-to-REST calls, no unexpected tool contract drift, no unexplained tracked changes, and no production action. Inspect all staged files and confirm the changelog version/date/type accurately describe the release.

- [ ] **Step 6: Commit release documentation**

```bash
git add README.md CHANGELOG.md docs/superpowers/specs/2026-08-23-atomic-batch-payment-design.md docs/superpowers/plans/2026-08-23-atomic-batch-payment.md
git commit -m "docs: document atomic payment batches"
```

- [ ] **Step 7: Record final evidence**

Capture the final HEAD, test command results, plugin version, migration number, and `git status --short`. Do not push, merge, deploy, or run production migrations without separate explicit authorization.
