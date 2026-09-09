# Batch Payment Capture MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add compact, evidence-safe MCP operations that capture and prepare/finalize many payment slips for one atomic payment batch.

**Architecture:** Extend the existing `payment_batches` aggregate rather than adding a second payment path. A new service capture operation creates one batch plus ordered intake/item records in one transaction; batch-scoped evidence methods validate the item-to-intake membership and delegate to the current evidence lifecycle. Existing `payment.batch.preview` and `payment.batch.execute` remain the only accounting preview/post stages.

**Tech Stack:** Bun, TypeScript, Elysia, Drizzle ORM/PostgreSQL, Zod, MCP SDK, `decimal.js`.

**Spec:** `docs/superpowers/specs/2026-08-25-batch-payment-capture-design.md`

## Global Constraints

- Public MCP money fields are exact two-decimal strings; financial calculations remain backend-owned and use `decimal.js`.
- Dates use Asia/Bangkok business semantics; timestamps remain ISO 8601.
- A supplied slip must be `ready` evidence before batch preview or execute; no raw bytes, account data, signed URLs, QR payloads, or tokens enter logs/audits/responses.
- Capture, evidence prepare/finalize, preview, and execution include command context, request/correlation IDs, safe public fields, and append-only audit records.
- Existing single-payment and lower-level batch tools remain backward compatible.
- Batch execution remains explicit-confirmation, semantic-hash guarded, idempotent, and all-or-nothing.
- Update `CHANGELOG.md` before every commit. Bump plugin version from `7.4.0` to `7.5.0` and synchronize validator, contract, docs, skills, and evals in the release commit.
- Run database-mutating backend tests only through `backend/scripts/test-disposable-postgres.sh` and never concurrently.

---

### Task 1: Add a transaction-safe multi-item capture service

**Files:**
- Modify: `backend/src/services/payment-batch-service.ts`
- Modify: `backend/src/services/payment-batch-service.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**

```ts
export type CapturePaymentBatchItemInput = {
    clientItemKey: string;
    amount: string;
    receivedAt: string;
    payerName?: string | null;
    bankReference?: string | null;
    intakeIdempotencyKey: string;
};

export async function capturePaymentBatch(
    ctx: CommandContext,
    input: {
        idempotencyKey: string;
        borrowerPublicId?: string | null;
        notes?: string | null;
        items: CapturePaymentBatchItemInput[];
    },
): Promise<PaymentBatchCaptureView>;
```

- [ ] **Step 1: Write failing disposable-PostgreSQL tests**

Add tests that call `capturePaymentBatch` with two valid items and assert one batch, two ordered batch items, two draft intakes, and two `created` audit records plus the batch audit. Add a same-key retry assertion that returns identical batch/item/intake public UUIDs without new rows. Add failure cases for duplicate client keys, duplicate item order implied by input position, invalid money, conflicting reused intake idempotency key, and a hard duplicate bank reference; assert no partial rows are created.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `cd backend && ./scripts/test-disposable-postgres.sh src/services/payment-batch-service.test.ts`

Expected: FAIL because `capturePaymentBatch` is not exported.

- [ ] **Step 3: Implement capture in one database transaction**

Validate 1–50 items, unique trimmed `clientItemKey` values, exact money strings, timestamps, and stable idempotency keys. Resolve the optional explicit borrower using the same tenant-safe lookup as `createPaymentBatch`. Under one transaction, return a prior identical capture by batch idempotency key; otherwise create the batch, create each existing-format `paymentIntakes` row, insert ordered `paymentBatchItems`, and write safe audit events. Reuse the existing duplicate-reference logic from payment intake creation rather than reimplementing matching policy. Return a safe mapping:

```ts
{ clientItemKey, paymentIntakePublicId, batchItemPublicId, status, duplicate: boolean }
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `cd backend && ./scripts/test-disposable-postgres.sh src/services/payment-batch-service.test.ts`

Expected: PASS with all rollback/idempotency assertions passing.

- [ ] **Step 5: Commit the service slice**

```bash
git add CHANGELOG.md backend/src/services/payment-batch-service.ts backend/src/services/payment-batch-service.test.ts
git commit -m "feat: capture payment batch items atomically"
```

### Task 2: Add batch-scoped multi-item evidence methods

**Files:**
- Modify: `backend/src/services/payment-batch-service.ts`
- Modify: `backend/src/services/payment-batch-service.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**

```ts
export async function preparePaymentBatchEvidenceMany(
    ctx: CommandContext,
    batchPublicId: string,
    items: Array<{
        batchItemPublicId: string;
        paymentIntakePublicId: string;
        mimeType: "image/jpeg" | "image/png" | "application/pdf";
        size: number;
        sha256: string;
        evidenceType?: "slip" | "qr";
    }>,
    gateway: PaymentEvidenceGateway,
): Promise<{ batchPublicId: string; items: EvidenceIntentView[] }>;
```

`finalizePaymentBatchEvidenceMany` accepts the same batch/item/intake identity plus `evidencePublicId` and returns `{ batchPublicId, allEvidenceReady, items }`.

- [ ] **Step 1: Write failing tests for membership and all-ready gating**

Test a two-item batch with valid matching pairs and assert both intents are returned in input order. Test a batch-item/intake mismatch, item from another batch, and duplicated item input; each must reject before any prepare/finalize side effect. Test one finalization failing/not-ready and assert `allEvidenceReady: false`, then finalize the second and assert `allEvidenceReady: true`. Confirm a later preview reports `needs_review` until both items are ready.

- [ ] **Step 2: Run tests and verify RED**

Run: `cd backend && ./scripts/test-disposable-postgres.sh src/services/payment-batch-service.test.ts`

Expected: FAIL because multi-item evidence service methods do not exist.

- [ ] **Step 3: Implement validation and delegation**

Load the accessible batch and its items once. Validate every public UUID pair against the batch before invoking `preparePaymentEvidence` or `finalizePaymentEvidence`. For prepare, preserve each existing evidence intent response without logging upload credentials. For finalize, collect all item results, re-read evidence status, and compute `allEvidenceReady` only when every requested/current batch item has a matching `ready` record. Do not post, preview, or alter any accounting rows.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `cd backend && ./scripts/test-disposable-postgres.sh src/services/payment-batch-service.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the evidence slice**

```bash
git add CHANGELOG.md backend/src/services/payment-batch-service.ts backend/src/services/payment-batch-service.test.ts
git commit -m "feat: batch payment evidence operations"
```

### Task 3: Expose closed MCP tools and preserve the frozen contract

**Files:**
- Modify: `backend/src/mcp/default.ts`
- Modify: `backend/src/mcp/default.test.ts`
- Modify: `backend/src/mcp/server.ts`
- Modify: `backend/src/mcp/server.test.ts`
- Modify: `backend/src/mcp/contract-snapshot.ts`
- Modify: `plugins/creditsync/references/mcp-tool-contract.json`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Write failing MCP adapter and server tests**

Add `payment.batch.capture`, `payment.batch.evidence.prepare-many`, and `payment.batch.evidence.finalize-many` to expected tool order. Assert closed schemas reject extra fields and mismatched counts, all three tools are destructive with `openWorldHint: false`, and safe output schemas omit signed URLs/headers. Add an adapter test that captures two items, prepares/finalizes them, previews once, and executes once.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `cd backend && bun test src/mcp/default.test.ts src/mcp/server.test.ts`

Expected: FAIL because the three tool names are absent.

- [ ] **Step 3: Implement MCP schemas, handlers, outputs, annotations, and recovery semantics**

Register all three tools in `MCP_TOOL_NAMES`, closed Zod input schemas, output schemas, descriptions, destructive annotations, audit action mapping, and the default handler map. The capture schema has `items: z.array(...).min(1).max(50)`; evidence schemas have matching item arrays with required public UUIDs. Responses expose only public IDs, amounts/timestamps/status, evidence readiness, warnings, audit/correlation IDs, and retry/review flags. Regenerate the frozen contract using `bun plugins/creditsync/scripts/mcp-contract.ts --write`.

- [ ] **Step 4: Run MCP tests and contract verification**

Run: `cd backend && bun test src/mcp/default.test.ts src/mcp/server.test.ts && bun run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit the MCP slice**

```bash
git add CHANGELOG.md backend/src/mcp/default.ts backend/src/mcp/default.test.ts backend/src/mcp/server.ts backend/src/mcp/server.test.ts backend/src/mcp/contract-snapshot.ts plugins/creditsync/references/mcp-tool-contract.json
git commit -m "feat: expose batch payment capture mcp"
```

### Task 4: Route multi-slip agents through the compact workflow

**Files:**
- Modify: `plugins/creditsync/skills/reconcile-payments/SKILL.md`
- Modify: `plugins/creditsync/skills/creditsync/SKILL.md`
- Modify: `plugins/creditsync/evals/evals.json`
- Modify: `plugins/creditsync/evals/harness.ts`
- Modify: `plugins/creditsync/tests/eval-harness.test.ts`
- Modify: `plugins/creditsync/tests/operations-docs.test.ts`
- Modify: `plugins/creditsync/.codex-plugin/plugin.json`
- Modify: `plugins/creditsync/scripts/validate.ts`
- Modify: `plugins/creditsync/README.md`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Write failing compact-batch eval scenarios**

Add a positive `payment-batch-capture-consecutive-slips` scenario whose exact calls are `payment.batch.capture → payment.batch.evidence.prepare-many → payment.batch.evidence.finalize-many → payment.batch.preview → payment.batch.execute`. Add negative scenarios where a hard duplicate capture and one failed evidence result forbid preview/execute. Assert item upload effects occur only between prepare-many and finalize-many.

- [ ] **Step 2: Run eval tests and verify RED**

Run: `cd plugins/creditsync && bun test tests/eval-harness.test.ts tests/operations-docs.test.ts`

Expected: FAIL because catalog/harness guidance does not yet contain the compact tools.

- [ ] **Step 3: Update routing and release artifacts**

Require the reconciliation skill to select compact capture for two or more supplied slips; require concurrent local OCR and signed PUT uploads, one batch preview, one explicit confirmation, one execute, and final verification reads. Preserve the single-slip path. Update root skill, plugin README, root README, eval harness/catalog, validator expected tool guidance, and plugin version checks from `7.4.0` to `7.5.0`. Update manifest version to `7.5.0`.

- [ ] **Step 4: Run plugin validation and frontend gates where applicable**

Run: `cd plugins/creditsync && bun test tests/eval-harness.test.ts tests/operations-docs.test.ts && bun run validate`

Run: `cd frontend && bun test && bun run lint && bun run build`

Expected: PASS; if no frontend file changes occur, record the clean baseline result without adding UI scope.

- [ ] **Step 5: Commit the workflow slice**

```bash
git add CHANGELOG.md README.md plugins/creditsync
git commit -m "feat: optimize multi-slip payment workflow"
```

### Task 5: End-to-end verification and deployment readiness

**Files:**
- Modify only if verification reveals a defect; otherwise no source changes.

- [ ] **Step 1: Run the complete required backend suite serially**

Run: `cd backend && ./scripts/test-disposable-postgres.sh src/services/payment-batch-service.test.ts src/mcp/default.test.ts src/mcp/server.test.ts && bun run typecheck`

Expected: PASS with no skipped batch database tests.

- [ ] **Step 2: Verify repository and release consistency**

Run: `git diff main --check && git status --short && cd plugins/creditsync && bun run validate`

Expected: no unexplained tracked changes and a synchronized 7.5.0 plugin contract.

- [ ] **Step 3: Stop for a new failing-test task if verification reveals a defect**

Do not fold a verification defect into this task. Add a focused failing test for the observed defect, make the smallest correction in a separate TDD cycle, rerun both the focused gate and this complete verification task, then commit that correction with its updated changelog entry.
