# Scheduled Payment Allocation Correction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an audited MCP preview-confirm-execute workflow that moves one posted scheduled repayment to another installment of the same active loan without changing its exact amount or components.

**Architecture:** Add an immutable correction proposal/group/entry ledger and a focused service that validates one uncompensated scheduled repayment, projects both schedule rows, and atomically appends a compensating transaction plus an exact replacement transaction. Rebuild touched schedules from signed transaction history, refresh the loan rollup, and expose the workflow through MCP and the synchronized private plugin.

**Tech Stack:** Bun, TypeScript, Drizzle ORM, PostgreSQL, `decimal.js`/`FinancialDecimal`, Zod, MCP SDK, Bun test, JSON plugin contract.

**Spec:** `docs/superpowers/specs/2026-09-08-scheduled-payment-allocation-correction-design.md`

## Global Constraints

- Public money is always a two-decimal string and every calculation uses `FinancialDecimal`/`decimal.js`; never use JavaScript `Number` for money.
- Use `Asia/Bangkok` for business-date and overdue semantics; timestamps remain ISO 8601.
- Move one posted scheduled repayment only between distinct schedules of the same borrower and active loan.
- Preserve source intake, source transaction, amount, received date, owner, and exact principal/interest/fee/penalty components.
- Posted rows stay immutable. Execute appends one exact compensation, one exact replacement, and immutable correction provenance.
- Reject floating loans, cross-boundary moves, split/merge, component changes, target overpayment, prior correction, active reversal, and downstream attribution/commission/settlement/reconciliation dependencies.
- Lock and revalidate deterministically; all financial effects commit atomically.
- Execute requires `confirmed: true`, unchanged preview hash/version/reason, and a stable idempotency key.
- MCP exposes safe public UUIDs and two-decimal strings only; logs/audits exclude personal, account, reference, evidence, token, signed-URL, and internal-ID data.
- Current HEAD ends at migration `0060`; this plan owns `0061_scheduled_payment_allocation_corrections`. If another `0061` lands first, stop and renumber before implementation.
- Bump the additive plugin contract from `9.0.0` to `9.1.0` across manifest, frozen contract, validator, tests, plugin docs/changelog, and frontend release metadata.
- Update root `CHANGELOG.md` before every commit and stage it with the change described.
- Do not merge, push, deploy, or mutate production under this plan. Production repair needs a post-deployment preview and separate confirmation.

## File Map

- `backend/src/db/schema.ts`, `backend/drizzle/0061_scheduled_payment_allocation_corrections.sql`, `backend/drizzle/meta/_journal.json`: persistence and migration.
- `backend/src/db/payment-allocation-correction-migration.test.ts`: migration constraints and immutability.
- `backend/src/services/payment-allocation-correction-service.ts`: preview, execute, hashing, dependency checks, rebuild, presentation.
- `backend/src/services/payment-allocation-correction-service.test.ts`: financial lifecycle, rejection, idempotency, and concurrency.
- `backend/src/services/payment-service.ts`: export only reusable lifecycle/rollup primitives; do not duplicate arithmetic.
- `backend/src/mcp/default.ts`, `backend/src/mcp/server.ts` and MCP tests: handlers, closed schemas, descriptions, annotations, audit mapping.
- `plugins/creditsync/**`, `frontend/src/lib/release.ts`: frozen contract, skill/evals, validation, and `9.1.0` metadata.
- `README.md`, `CHANGELOG.md`: operational boundary and release record.

---

### Task 1: Add the immutable correction ledger

**Files:**
- Modify: `backend/src/db/schema.ts`
- Create: `backend/drizzle/0061_scheduled_payment_allocation_corrections.sql`
- Modify: `backend/drizzle/meta/_journal.json`
- Create: `backend/src/db/payment-allocation-correction-migration.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**

```ts
export const paymentAllocationCorrectionPreviews: PgTable;
export const paymentAllocationCorrectionGroups: PgTable;
export const paymentAllocationCorrectionEntries: PgTable;
```

- [ ] **Step 1: Write the failing migration test**

Assert three tables, tenant composite FKs, `ready|blocked|executed|expired` status/reason/component checks, tenant/idempotency uniqueness, one correction per source transaction, permitted preview transition, and immutable blocked/executed/group/entry rows.

```ts
expect(tableNames).toEqual(expect.arrayContaining([
  "payment_allocation_correction_previews",
  "payment_allocation_correction_groups",
  "payment_allocation_correction_entries",
]));
await expect(updateExecutedGroup()).rejects.toThrow(/immutable/i);
```

- [ ] **Step 2: Run RED**

```bash
backend/scripts/test-disposable-postgres.sh src/db/payment-allocation-correction-migration.test.ts
```

Expected: FAIL because migration `0061` and schema exports do not exist.

- [ ] **Step 3: Implement schema and migration**

Follow `paymentReconciliationProposals` conventions. Store source payment/transaction/schedule, target schedule, loan, safe snapshots/projections, amount/components, status, reason, warnings, hash, balance version, expiry, and actor timestamps. Enforce exact conservation:

```sql
CHECK (amount > 0 AND scale(amount) <= 2
  AND amount = principal_component + interest_component + fee_component + penalty_component)
```

Allow only `ready -> executed|expired` preview transition while freezing content; `blocked`, `executed`, and `expired` previews are immutable. Reject update/delete on groups and entries. Append journal index `61` and tag `0061_scheduled_payment_allocation_corrections`.

- [ ] **Step 4: Run GREEN and commit**

```bash
backend/scripts/test-disposable-postgres.sh src/db/payment-allocation-correction-migration.test.ts
git diff --check
```

Update `CHANGELOG.md`, then:

```bash
git add CHANGELOG.md backend/src/db/schema.ts backend/drizzle/0061_scheduled_payment_allocation_corrections.sql backend/drizzle/meta/_journal.json backend/src/db/payment-allocation-correction-migration.test.ts
git commit -m "feat: add payment allocation correction ledger"
```

---

### Task 2: Build exact preview planning and dependency guards

**Files:**
- Create: `backend/src/services/payment-allocation-correction-service.ts`
- Create: `backend/src/services/payment-allocation-correction-service.test.ts`
- Modify: `backend/src/services/payment-service.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**

```ts
export interface PreviewPaymentAllocationCorrectionInput {
  paymentIntakePublicId: string;
  transactionPublicId: string;
  targetSchedulePublicId: string;
  reason: string;
}

export interface CorrectionScheduleProjection {
  schedulePublicId: string;
  dueDate: string;
  before: { paidTotal: string; paidPenalty: string; remainingDue: string; status: string };
  after: { paidTotal: string; paidPenalty: string; remainingDue: string; status: string };
}

export interface PaymentAllocationCorrectionPreview {
  publicId: string;
  status: "ready" | "blocked";
  paymentIntakePublicId: string;
  transactionPublicId: string;
  loanPublicId: string;
  source: CorrectionScheduleProjection;
  target: CorrectionScheduleProjection;
  amount: string;
  components: { principal: string; interest: string; fee: string; penalty: string };
  netLoanVariance: { amount: string; principal: string; interest: string; fee: string; penalty: string };
  warnings: Array<{ code: string; blockerPublicIds?: string[] }>;
  previewHash: string;
  expectedBalanceVersion: string;
  expiresAt: string;
}

export async function previewPaymentAllocationCorrection(
  ctx: CommandContext,
  input: PreviewPaymentAllocationCorrectionInput,
): Promise<PaymentAllocationCorrectionPreview>;
```

`PaymentAllocationCorrectionPreview` returns public IDs, source/target due dates and before/after aggregates, exact amount/components, zero net loan variance, warnings, status, hash, balance version, and expiry.

- [ ] **Step 1: Write RED preview tests**

Seed a posted `200.00` payment with `173.92` principal and `26.08` interest on installment 2 while installment 1 is pending.

```ts
expect(result).toMatchObject({
  status: "ready", amount: "200.00",
  components: { principal: "173.92", interest: "26.08", fee: "0.00", penalty: "0.00" },
  netLoanVariance: { amount: "0.00", principal: "0.00", interest: "0.00", fee: "0.00", penalty: "0.00" },
  warnings: [],
});
expect(result.source.after.status).toBe("pending");
expect(result.target.after.status).toBe("paid");
```

Add table tests for wrong tenant/borrower/loan, floating loan, same schedule, non-posted intake, non-repayment/reversed source, component mismatch, target overpayment, prior correction, blank reason, and downstream dependencies.

- [ ] **Step 2: Run RED**

```bash
backend/scripts/test-disposable-postgres.sh src/services/payment-allocation-correction-service.test.ts
```

Expected: FAIL because the service does not exist.

- [ ] **Step 3: Implement preview without financial writes**

Resolve public UUIDs tenant-safely and derive components only from the source transaction. Extract reusable schedule lifecycle/rollup helpers from `payment-service.ts` only where necessary.

Hash stable-key JSON covering payment status, source transaction/reversal lineage, both schedule contracts/aggregates and active transactions, loan state, dependency public IDs, normalized reason, and target schedule. Persist only immutable preview/audit metadata.

- [ ] **Step 4: Implement downstream checks**

Check active `paymentIntermediaryAttributions`, commission provenance, payment reconciliation entries/groups, settlement/renewal effects, and correction rows. Return only blocker public UUIDs.

```ts
if (blockers.length) return blocked("PAYMENT_ALLOCATION_CORRECTION_DEPENDENCY", blockerPublicIds);
```

- [ ] **Step 5: Run GREEN and commit**

```bash
backend/scripts/test-disposable-postgres.sh src/services/payment-allocation-correction-service.test.ts
git diff --check
```

Update `CHANGELOG.md`, then commit service, tests, helper export, and changelog as `feat: preview scheduled payment allocation corrections`.

---

### Task 3: Execute atomic compensation and replacement

**Files:**
- Modify: `backend/src/services/payment-allocation-correction-service.ts`
- Modify: `backend/src/services/payment-allocation-correction-service.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**

```ts
export interface ExecutePaymentAllocationCorrectionInput {
  correctionPreviewPublicId: string;
  previewHash: string;
  expectedBalanceVersion: string;
  confirmed: true;
  reason: string;
  idempotencyKey: string;
}

export interface ExecutedPaymentAllocationCorrection {
  correctionPublicId: string;
  paymentIntakePublicId: string;
  sourceTransactionPublicId: string;
  compensatingTransactionPublicId: string;
  replacementTransactionPublicId: string;
  sourceSchedulePublicId: string;
  targetSchedulePublicId: string;
  amount: string;
  components: { principal: string; interest: string; fee: string; penalty: string };
  auditPublicId: string;
  correlationId: string;
}

export async function executePaymentAllocationCorrection(
  ctx: CommandContext,
  input: ExecutePaymentAllocationCorrectionInput,
): Promise<ExecutedPaymentAllocationCorrection>;
```

The result includes correction, intake, source/compensation/replacement transaction, source/target schedule, audit, and correlation public IDs plus exact amount/components.

- [ ] **Step 1: Write RED execution tests**

```ts
expect(compensation).toMatchObject({
  entryType: "reversal", amount: "-200.00",
  principalComponent: "-173.92", interestComponent: "-26.08",
  reversedTransactionId: source.id, scheduleId: sourceSchedule.id,
});
expect(replacement).toMatchObject({
  entryType: "repayment", amount: "200.00",
  principalComponent: "173.92", interestComponent: "26.08",
  scheduleId: targetSchedule.id, paymentIntakeId: intake.id,
  transactionDate: source.transactionDate,
});
```

Assert intake remains posted, schedule states swap correctly, loan totals are unchanged, lineage/audit is complete, and injected failure leaves no partial rows.

- [ ] **Step 2: Run RED**

```bash
backend/scripts/test-disposable-postgres.sh src/services/payment-allocation-correction-service.test.ts
```

- [ ] **Step 3: Implement lock/revalidation and append-only execute**

Lock intake, loan, ordered schedules, ordered transactions, preview, and correction rows. Recompute hash/version/dependencies under lock. Insert stable internal transaction keys:

```ts
const reversalKey = `payment-allocation-correction:${preview.publicId}:reversal`;
const replacementKey = `payment-allocation-correction:${preview.publicId}:replacement`;
```

Rebuild each schedule from signed canonical transactions, reject negative/overpaid/component-variant state, refresh loan rollup, create correction/audit records, and mark preview executed in one transaction.

- [ ] **Step 4: Add idempotency and concurrency tests**

```ts
expect(new Set(results.map((x) => x.correctionPublicId)).size).toBe(1);
expect(await correctionTransactionCount()).toBe(2);
```

Require same-key replay and conflicting-key rejection.

- [ ] **Step 5: Run GREEN and commit**

```bash
backend/scripts/test-disposable-postgres.sh src/services/payment-allocation-correction-service.test.ts
git diff --check
```

Update `CHANGELOG.md`, then commit as `feat: execute payment allocation corrections`.

---

### Task 4: Expose the guarded MCP workflow

**Files:**
- Modify: `backend/src/mcp/default.ts`
- Modify: `backend/src/mcp/server.ts`
- Modify: `backend/src/mcp/default.test.ts`
- Modify: `backend/src/mcp/server.test.ts`
- Modify: `backend/src/mcp/security.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**

```ts
"payment.allocation-correction.preview"
"payment.allocation-correction.execute"
```

Preview receives intake, transaction, target schedule, and reason. Execute receives preview ID, hash, balance version, literal confirmation, exact reason, and idempotency key. Both schemas are strict.

- [ ] **Step 1: Write RED MCP tests**

Assert tool names, closed schemas, UUID/hash/money output validation, handler routing, transport/argument idempotency consistency, destructive execute annotation, non-destructive preview annotation, and safe output.

```ts
expect(toolNames).toContain("payment.allocation-correction.preview");
expect(executeAnnotations.destructiveHint).toBe(true);
```

- [ ] **Step 2: Run RED**

```bash
cd backend
bun test src/mcp/default.test.ts src/mcp/server.test.ts src/mcp/security.test.ts
```

- [ ] **Step 3: Implement handlers, schemas, annotations, and audit mapping**

Call the service directly, never REST. Follow `payment.reconcile.execute` command-context/idempotency conflict handling. Preview persists metadata, so set `readOnlyHint: false`, `destructiveHint: false`; execute is destructive.

- [ ] **Step 4: Run GREEN and commit**

```bash
cd backend
bun test src/mcp/default.test.ts src/mcp/server.test.ts src/mcp/security.test.ts
bun run typecheck
cd ..
git diff --check
```

Update `CHANGELOG.md`, then commit as `feat: expose payment allocation correction MCP tools`.

---

### Task 5: Synchronize plugin contract and operator workflow

**Files:**
- Modify: `plugins/creditsync/references/mcp-tool-contract.json`
- Modify: `plugins/creditsync/skills/reconcile-payments/SKILL.md`
- Modify: `plugins/creditsync/references/error-recovery.md`
- Modify: `plugins/creditsync/evals/evals.json`
- Modify: `plugins/creditsync/evals/harness.ts`
- Modify: `plugins/creditsync/tests/eval-harness.test.ts`
- Modify: `plugins/creditsync/tests/operations-docs.test.ts`
- Modify: `plugins/creditsync/tests/plugin-contract.test.ts`
- Modify: `plugins/creditsync/scripts/validate.ts`
- Modify: `plugins/creditsync/.codex-plugin/plugin.json`
- Modify: `plugins/creditsync/.app.json`
- Modify: `plugins/creditsync/package.json`
- Modify: `plugins/creditsync/README.md`
- Modify: `plugins/creditsync/CHANGELOG.md`
- Modify: `frontend/src/lib/release.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**

```text
inspect intake + transaction + schedules + dependencies
→ correction preview
→ display exact before/after and zero variance
→ explicit confirmation
→ correction execute with unchanged guards
→ re-inspect history + contract + audit/correlation IDs
```

- [ ] **Step 1: Write RED plugin tests/evals**

Add ready, blocker, stale, and idempotent-retry scenarios. Require preview before execute and forbid reverse/post/execute before confirmation.

```ts
expect(ready.calls.map((x) => x.name)).toEqual(expect.arrayContaining([
  "intake.get", "loan.contract.get",
  "payment.allocation-correction.preview",
  "payment.allocation-correction.execute",
]));
```

- [ ] **Step 2: Run RED**

```bash
cd plugins/creditsync
bun test
```

- [ ] **Step 3: Regenerate the authenticated frozen contract**

Use the existing local authenticated MCP environment:

```bash
cd plugins/creditsync
bun run scripts/mcp-contract.ts
```

Verify exactly two additive tools with closed schemas, descriptions, annotations, and audit outputs; do not hand-edit generated schema content.

- [ ] **Step 4: Update workflow docs/evals and version `9.1.0`**

Document all hard stops and post-execute verification. Synchronize every listed metadata file and correct the currently stale plugin README heading/package version while updating it.

- [ ] **Step 5: Run GREEN and commit**

```bash
cd plugins/creditsync
bun test
bun run validate
cd ../..
python3 /home/flintstone/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py plugins/creditsync
cd frontend
bun test src/lib/release.test.ts
cd ..
git diff --check
```

Update `CHANGELOG.md`, then commit as `feat: document payment allocation correction workflow`.

---

### Task 6: Document and run full verification

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Test: every file changed by Tasks 1-5

**Interfaces:** None.

- [ ] **Step 1: Document operational boundaries**

Describe same-loan restriction, exact conservation, preview-confirm-execute, blockers, post-execute inspection, and the separate deployment/production authorization boundary.

- [ ] **Step 2: Run targeted gates**

```bash
backend/scripts/test-disposable-postgres.sh src/db/payment-allocation-correction-migration.test.ts
backend/scripts/test-disposable-postgres.sh src/services/payment-allocation-correction-service.test.ts
cd backend
bun test src/mcp/default.test.ts src/mcp/server.test.ts src/mcp/security.test.ts
bun run typecheck
cd ..
```

- [ ] **Step 3: Run complete serialized backend verification**

```bash
backend/scripts/test-disposable-postgres.sh
cd backend
bun run typecheck
cd ..
```

A skipped database suite is insufficient.

- [ ] **Step 4: Run frontend and plugin verification**

```bash
cd frontend
bun test
bun run lint
bun run build
cd ../plugins/creditsync
bun test
bun run validate
cd ../..
python3 /home/flintstone/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py plugins/creditsync
```

- [ ] **Step 5: Review diff and commit docs**

```bash
git diff --check
git status --short
git diff --stat
git diff -- backend/src/db/schema.ts backend/src/services/payment-allocation-correction-service.ts backend/src/mcp/server.ts plugins/creditsync/references/mcp-tool-contract.json README.md CHANGELOG.md
```

Confirm no secrets, raw references, production IDs, direct mutation of posted rows, floating behavior changes, unexplained changes, or release-version drift. Update `CHANGELOG.md`, then commit README/changelog as `docs: add payment allocation correction operations`; skip an empty commit.

- [ ] **Step 6: Independent review**

Use `superpowers:requesting-code-review` on the complete branch diff. Resolve findings with focused RED/GREEN changes and rerun affected gates. Report branch completion separately from merge, push, deployment, and production repair.

---

## Post-Deployment Production Repair (Not Authorized Here)

After separate deployment authorization, inspect the initiating payment and preview movement from 2026-09-07 to 2026-09-06. Proceed only when the backend reports amount `200.00`, principal `173.92`, interest `26.08`, fee/penalty `0.00`, zero variance, no warnings, source becoming pending, and target becoming paid.

Obtain a new explicit confirmation, execute with unchanged guards and a fresh idempotency key, then re-read payment history, both schedules, loan rollup, audit public ID, and correlation ID. Any changed component, target, warning, blocker, stale state, or variance stops without mutation.
