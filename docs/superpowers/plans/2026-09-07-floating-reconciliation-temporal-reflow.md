# Floating Reconciliation Temporal Reflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve chronological floating-interest allocation meaning for future backdated reconciliations, add an append-only preview-confirm-execute repair for already affected reconciliation groups, and stop daily Loan List health from double-counting the current obligation.

**Architecture:** Add an immutable reflow proposal/group/entry ledger and a focused temporal-reflow service. The service deterministically selects active later interest allocations, appends compensating reversal rows, replays the displaced amount through the existing authoritative `resolveFloatingInterestAllocationPlan`, and rebuilds touched accrual caches from signed allocation provenance inside one locked transaction. Future reconciliation preview/execute uses the same kernel; existing data uses dedicated MCP repair tools. The payment-health correction is a separate guarded projection change.

**Tech Stack:** Bun, TypeScript, Elysia, Drizzle ORM, PostgreSQL, `decimal.js`, Zod, MCP SDK, Bun test/Vitest, JSON plugin contract.

**Spec:** `docs/superpowers/specs/2026-09-07-floating-reconciliation-temporal-reflow-design.md`

## Global Constraints

- Money crosses public boundaries as two-decimal strings and all arithmetic uses `FinancialDecimal`/`decimal.js`; do not use `Number` for money.
- Use the `Asia/Bangkok` business date derived from each existing transaction timestamp. Preserve original transaction, intake, received-at, component totals, and contract terms.
- Posted financial rows remain immutable. Reflow creates only append-only `floating_transaction_allocations` reversal/payment provenance and immutable repair metadata.
- A reversal amount is the exact negative of its source allocation and sets `reversedAllocationId`; a replacement remains attached to the same source transaction and conserves its displaced interest exactly.
- Lock in stable loan/effective-date/transaction/allocation/id order, then rebuild and revalidate the plan under those locks. Any stale state, missing provenance, over-allocation, negative paid total, or variance aborts the whole transaction.
- Public/MCP results expose UUIDs and two-decimal strings only. Audit payloads exclude database IDs, payer/account details, QR data, raw evidence, tokens, and signed URLs.
- Repair preview persists only immutable proposal/audit metadata. Execute requires `confirmed: true`, the same normalized reason, current preview hash and balance version, and a non-empty idempotency key.
- The existing MCP output schemas are closed and will gain temporal-reflow fields, so this is a breaking frozen-contract update: move the private plugin and release metadata from `9.0.0` to `10.0.0` together.
- Before every implementation commit, update the root `CHANGELOG.md` under `v0.3.83 - 2026-09-07` and stage that entry with the code it describes. Keep plugin-facing changes under `10.0.0` in `plugins/creditsync/CHANGELOG.md`.
- Update root `README.md`, plugin README, reconciliation skill, frozen contract, validator, and evals because the operator workflow changes.
- Do not merge, push, deploy, or execute a production repair under this plan. Production preview and execution remain separate explicitly authorized operations after deployment.

---

### Task 1: Add immutable repair persistence and migration guards

**Files:**
- Modify: `backend/src/db/schema.ts`
- Create: `backend/drizzle/0061_payment_reconciliation_reflow.sql`
- Modify: `backend/drizzle/meta/_journal.json`
- Create: `backend/src/db/payment-reconciliation-reflow-migration.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**

Add three tenant-scoped tables:

```ts
paymentReconciliationReflowProposals // ready | executed | expired
paymentReconciliationReflowGroups    // immutable executed command/idempotency record
paymentReconciliationReflowEntries   // source, reversal, and replacement allocation lineage
```

The proposal stores `reconciliationGroupId`, `previewHash`, `expectedBalanceVersion`, safe `sourceSnapshot`, `proposedReflow`, `warnings`, normalized `reason`, expiry, and creator/executor fields. The group stores `origin: "automatic" | "repair"`, an optional reflow-proposal foreign key required only for repair, the reconciliation foreign key, status, reason, an idempotency key, correlation ID, audit UUID, actor, and timestamp. Each entry stores group/loan/transaction/source-allocation/reversal-allocation/replacement-allocation foreign keys plus effective date, old/new due dates, exact positive displaced amount, audit UUID, actor, and timestamp. Enforce one group per reconciliation: future automatic execution creates it immediately; legacy reconciliation can create one repair group.

- [ ] **Step 1: Write the failing migration test**

Assert the three tables, composite tenant foreign keys, two-decimal positive amount check, status checks, tenant/idempotency uniqueness, one executed repair per reconciliation, and immutable update/delete triggers. Also assert cross-tenant references and mutation of proposal snapshots/group/entries are rejected.

- [ ] **Step 2: Run RED**

```bash
backend/scripts/test-disposable-postgres.sh src/db/payment-reconciliation-reflow-migration.test.ts
```

Expected: FAIL because migration `0061` and schema exports do not exist.

- [ ] **Step 3: Implement schema and SQL migration**

Follow the composite tenant-FK and `uuidv7()` conventions beside `paymentReconciliationProposals`. Add a dedicated trigger function that rejects update/delete on reflow groups and entries, and rejects proposal updates except the single `ready -> executed` transition that fills executor fields without changing preview content. Use explicit `numeric` checks:

```sql
CHECK (amount > 0 AND scale(amount) <= 2
  AND amount NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric))
```

Append journal entry index `61`, tag `0061_payment_reconciliation_reflow`, without regenerating or rewriting prior migrations.

- [ ] **Step 4: Run GREEN and commit**

```bash
backend/scripts/test-disposable-postgres.sh src/db/payment-reconciliation-reflow-migration.test.ts
git diff --check
```

Update `CHANGELOG.md`, then commit:

```bash
git add CHANGELOG.md backend/src/db/schema.ts backend/drizzle/0061_payment_reconciliation_reflow.sql backend/drizzle/meta/_journal.json backend/src/db/payment-reconciliation-reflow-migration.test.ts
git commit -m "feat: add reconciliation reflow ledger"
```

---

### Task 2: Build the deterministic temporal-reflow kernel

**Files:**
- Create: `backend/src/services/floating-allocation-reflow-service.ts`
- Create: `backend/src/services/floating-allocation-reflow-service.test.ts`
- Modify: `backend/src/services/floating-interest-service.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**

```ts
export interface TemporalReflowPlan {
  affectedLoanPublicIds: string[];
  effectiveAfterDate: string;
  transactions: Array<{
    transactionPublicId: string;
    effectiveDate: string;
    displacedAmount: string;
    before: Array<{ allocationPublicId: string; accrualPublicId: string; dueDate: string; amount: string }>;
    after: Array<{ accrualPublicId: string; dueDate: string; amount: string }>;
    conserved: true;
  }>;
  displacedTotal: string;
  replacementTotal: string;
}

export async function buildTemporalReflowPlan(
  tx: Executor,
  ctx: CommandContext,
  input: {
    loanIds: number[];
    effectiveAfterDate: string;
    projectedIncomingAllocations?: Array<{
      loanId: number;
      accrualId: number;
      amount: string;
      effectiveDate: string;
    }>;
  },
): Promise<TemporalReflowPlan>;

export async function executeTemporalReflow(
  tx: Executor,
  ctx: CommandContext,
  input: { plan: TemporalReflowPlan; reason: string; auditPublicId: string; idempotencyPrefix: string },
): Promise<{ entries: ExecutedTemporalReflowEntry[]; touchedAccrualPublicIds: string[] }>;
```

- [ ] **Step 1: Write RED database tests for the incident timeline**

Create a daily floating loan with THB 30.00 accruals on 2026-09-04 and 2026-09-05. Post the later transaction effective 2026-09-05 while September 4 is oldest unpaid, then materialize a backdated September 4 allocation. Assert the plan moves only the later allocation:

```ts
expect(plan.transactions).toEqual([expect.objectContaining({
  effectiveDate: "2026-09-05",
  displacedAmount: "30.00",
  before: [expect.objectContaining({ dueDate: "2026-09-04", amount: "30.00" })],
  after: [expect.objectContaining({ dueDate: "2026-09-05", amount: "30.00" })],
  conserved: true,
})]);
```

Cover multiple allocations per transaction, deterministic ordering, already-reversed rows, penalty exclusion, effective-date boundary exclusion, exact decimal sums beyond JS safe integer range, incomplete provenance, and insufficient replacement capacity.

- [ ] **Step 2: Run RED**

```bash
backend/scripts/test-disposable-postgres.sh src/services/floating-allocation-reflow-service.test.ts
```

Expected: FAIL because the reflow service does not exist.

- [ ] **Step 3: Implement planning without durable writes**

Select positive interest allocations strictly after `effectiveAfterDate`; exclude any allocation targeted by a reversal. Sort by loan ID, effective date, transaction ID, allocation order, and allocation ID. For future preview, apply `projectedIncomingAllocations` to the in-memory paid state before replay; execute and legacy repair pass the already-materialized database state. Simulate removing each transaction's active selected allocations from paid-state in memory, then call the authoritative allocator for the transaction's original effective date against that simulated state. If the existing allocator cannot accept an overlay, extract a pure row-selection helper from `resolveFloatingInterestAllocationPlan`; do not duplicate rate, period, due-date, or rounding logic.

The plan builder must throw stable domain errors such as `TEMPORAL_REFLOW_PROVENANCE_INCOMPLETE` and `TEMPORAL_REFLOW_AMOUNT_VARIANCE`; it must never silently omit a selected amount.

- [ ] **Step 4: Implement append-only execution and cache rebuild**

For each source allocation append:

```ts
{
  entryType: "reversal",
  amount: new FinancialDecimal(source.amount).negated().toFixed(2),
  reversedAllocationId: source.id,
  transactionId: source.transactionId,
  effectiveDate: source.effectiveDate,
  reason,
}
```

Then append positive `payment` allocations for the authoritative replacement plan using the same transaction and the next available allocation order. After all rows exist, rebuild each touched accrual's `paidAmount` from `SUM(floating_transaction_allocations.amount)` and set `paid`, `partially_paid`, or its valid zero-paid prepayment status. Reject negative or greater-than-interest totals before updating any cache.

- [ ] **Step 5: Add execution, lineage, failure, and retry-safety tests**

Assert originals are unchanged, every source has one linked negative reversal, replacements use the same transaction, signed and active sums conserve exactly, both September 4/5 accruals become exactly paid, and no transaction/intake/principal/fee/penalty changes. Verify duplicate source reversal, stale plan, and injected mid-execution failure roll back all new rows/cache updates.

- [ ] **Step 6: Run GREEN and commit**

```bash
backend/scripts/test-disposable-postgres.sh src/services/floating-allocation-reflow-service.test.ts
bun run --cwd backend typecheck
git diff --check
```

Update `CHANGELOG.md`, then commit the kernel and its tests.

---

### Task 3: Integrate automatic reflow into future reconciliation

**Files:**
- Modify: `backend/src/services/payment-reconciliation-service.ts`
- Modify: `backend/src/services/payment-reconciliation-service.test.ts`
- Modify: `backend/src/services/floating-allocation-regressions.test.ts`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Write RED reconciliation regression tests**

Reproduce the September 4/5 ordering through `previewPaymentReconciliation` and `executePaymentReconciliation`. Assert preview and preflight expose the same deterministic `temporalReflowPlan`, the preview hash/balance version changes when allocation due date, effective date, amount, entry type, reversal link, transaction, or accrual changes, and execute results in September 4 and 5 each paid exactly once.

- [ ] **Step 2: Run RED**

```bash
backend/scripts/test-disposable-postgres.sh \
  src/services/payment-reconciliation-service.test.ts \
  src/services/floating-allocation-regressions.test.ts
```

- [ ] **Step 3: Extend preview and preflight snapshots**

After computing each backdated provenance plan, build `temporalReflowPlan` against the projected state that includes the proposed historical allocation. Include it in `sourceSnapshot`, returned preview/preflight, `expectedBalanceVersion`, and `previewHash`. Do not put database IDs in the persisted public snapshot.

- [ ] **Step 4: Execute automatic reflow atomically**

After inserting the historical floating allocation and before marking the reconciliation group executed, acquire deterministic locks, rebuild the plan without a projected overlay, compare it to the stored plan/hash, and call `executeTemporalReflow` with the reconciliation audit UUID and group-based idempotency prefix. Persist an `origin: "automatic"` reflow group and its entries linked to the reconciliation group so later repair preview recognizes it as already reflowed.

- [ ] **Step 5: Test staleness, concurrency, and idempotent reconciliation replay**

Race a later payment allocation against reconciliation execute; exactly one serial state may commit. Confirm stale previews fail without financial writes, and identical reconciliation idempotency retry returns the original public result without another reflow.

- [ ] **Step 6: Run GREEN and commit**

Run the Step 2 tests plus backend typecheck, update `CHANGELOG.md`, and commit.

---

### Task 4: Add the existing-data repair preview-confirm-execute service

**Files:**
- Create: `backend/src/services/payment-reconciliation-reflow-service.ts`
- Create: `backend/src/services/payment-reconciliation-reflow-service.test.ts`
- Modify: `backend/src/services/floating-allocation-reflow-service.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**

```ts
export async function previewPaymentReconciliationReflow(
  ctx: CommandContext,
  input: { reconciliationPublicId: string; reason: string },
): Promise<ReflowPreview>;

export async function executePaymentReconciliationReflow(
  ctx: CommandContext,
  input: {
    reflowPreviewPublicId: string;
    previewHash: string;
    expectedBalanceVersion: string;
    confirmed: true;
    reason: string;
    idempotencyKey: string;
  },
): Promise<ReflowExecuteResult>;
```

- [ ] **Step 1: Write RED repair tests against an already-broken reconciliation**

Seed the immutable broken state: backdated reconciliation and later transaction both point at September 4. Preview must return one before/after move, zero warnings, exact totals, UUID-only snapshots, hash/version/expiry, and persist no financial changes.

- [ ] **Step 2: Cover all refusal paths**

Reject wrong tenant, unexecuted/non-floating reconciliation, no reflow needed, already repaired reconciliation, missing reason, expired/stale preview, hash/version/reason mismatch, incomplete provenance, warning-bearing plan, `confirmed !== true`, blank key, and conflicting key reuse.

- [ ] **Step 3: Implement preview**

Load the exact executed reconciliation and its floating replacement allocations. Derive the historical cutoff from their effective date, build the plan, require at least one move and zero warnings, calculate a balance version over every participating loan/accrual/transaction/allocation/reversal link, persist an expiring immutable proposal, and write a metadata-only audit event.

- [ ] **Step 4: Write RED execute/idempotency/concurrency tests**

Assert execute appends correct rows, creates exactly one repair group/entry set and audit record, marks the proposal executed, and returns public repair/reconciliation/audit/correlation IDs. Same-key same-request replay returns the original result; same key with changed request returns `IDEMPOTENCY_CONFLICT`. Race two proposals and a new allocation; only a current plan commits.

- [ ] **Step 5: Implement locked execute**

Check idempotency before proposal mutation, lock proposal/reconciliation/loans/transactions/allocations/accruals in deterministic order, recompute balance version and plan, compare exact serialized public plan, then execute the kernel and persist group/entries/audit atomically. A repair group unique constraint is the last-line duplicate guard.

- [ ] **Step 6: Run GREEN and commit**

```bash
backend/scripts/test-disposable-postgres.sh \
  src/services/payment-reconciliation-reflow-service.test.ts \
  src/services/floating-allocation-reflow-service.test.ts
bun run --cwd backend typecheck
git diff --check
```

Update `CHANGELOG.md`, then commit.

---

### Task 5: Correct daily payment-health projection

**Files:**
- Modify: `backend/src/services/loan-payment-health-service.ts`
- Modify: `backend/src/services/loan-payment-health-service.test.ts`
- Modify: `backend/src/lib/loan-payment-health.test.ts`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Write RED daily and weekly projection tests**

For a THB 2,000 daily loan at 15 per thousand, after paid accruals through September 5 and as-of September 7, assert `overdueAmount: "30.00"`, `maxOverdueDays: 1`, and `dueToday: "30.00"`. Keep a weekly advance-period fixture asserting its existing projected current-period obligation is unchanged.

- [ ] **Step 2: Run RED**

```bash
backend/scripts/test-disposable-postgres.sh src/services/loan-payment-health-service.test.ts
```

The focused backend regression must fail before the weekly-policy guard is added.

- [ ] **Step 3: Restrict the advance-period branch to weekly policy**

Change the branch to require weekly semantics explicitly:

```ts
const weeklyPolicy = loan.interestPeriodUnit === "week"
  || loan.floatingAccrualCycle === "weekly";

if (weeklyPolicy && loan.advanceInterestPeriods === 1) {
  // existing anchored weekly advance projection unchanged
}
```

- [ ] **Step 4: Run GREEN and commit**

```bash
backend/scripts/test-disposable-postgres.sh src/services/loan-payment-health-service.test.ts
bun run --cwd backend typecheck
```

Update `CHANGELOG.md`, then commit.

---

### Task 6: Expose closed MCP repair tools and temporal plans

**Files:**
- Modify: `backend/src/mcp/server.ts`
- Modify: `backend/src/mcp/default.ts`
- Modify: `backend/src/mcp/server.test.ts`
- Modify: `backend/src/mcp/default.test.ts`
- Modify: `CHANGELOG.md`

**Tools:**

```text
payment.reconcile.reflow.preview
  { reconciliationPublicId: uuid, reason: non-empty short text }

payment.reconcile.reflow.execute
  { reflowPreviewPublicId: uuid, previewHash, expectedBalanceVersion,
    confirmed: true, reason: non-empty short text, idempotencyKey }
```

- [ ] **Step 1: Write RED schema and handler tests**

Assert exact tool names, closed input/output schemas, UUID/two-decimal patterns, structured/readable results, preview metadata-write annotations, destructive execute annotations, confirmation enforcement, forwarded command context, safe domain errors, and absence of database IDs/sensitive evidence.

- [ ] **Step 2: Run RED**

```bash
cd backend && bun test src/mcp/server.test.ts src/mcp/default.test.ts
```

- [ ] **Step 3: Add tool contracts and handlers**

Import the Task 4 service functions into `default.ts`, register both names in `MCP_TOOL_NAMES`, and extend existing reconciliation preview/preflight output schemas with required `temporalReflowPlan`. Keep every Zod object `.strict()` and return both structured content and concise Thai/English-neutral readable summaries.

- [ ] **Step 4: Run GREEN and commit**

Run Step 2 and backend typecheck, update `CHANGELOG.md`, then commit.

---

### Task 7: Synchronize plugin 10.0.0, operator docs, release metadata, and evals

**Files:**
- Modify: `plugins/creditsync/.codex-plugin/plugin.json`
- Modify: `plugins/creditsync/references/mcp-tool-contract.json`
- Modify: `plugins/creditsync/scripts/validate.ts`
- Modify: `plugins/creditsync/tests/plugin-contract.test.ts`
- Modify: `plugins/creditsync/skills/reconcile-payments/SKILL.md`
- Modify: `plugins/creditsync/references/financial-rules.md`
- Modify: `plugins/creditsync/references/error-recovery.md`
- Modify: `plugins/creditsync/evals/evals.json`
- Modify: `plugins/creditsync/evals/harness.ts`
- Modify: `plugins/creditsync/CHANGELOG.md`
- Modify: `plugins/creditsync/README.md`
- Modify: `frontend/src/lib/release.ts`
- Modify: relevant release metadata test found with `rg -n "9\\.0\\.0|pluginVersion" frontend/src`
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Write/update RED contract and eval tests**

Add scenarios for future reconciliation temporal plan confirmation, repair preview without financial writes, refusal to execute without confirmation, stale/ambiguous plan refusal, exact same-key replay, and the five-loan THB 165.00 remediation preview. Assert tool count/name/schema parity between backend and frozen contract.

- [ ] **Step 2: Bump compatibility boundary to 10.0.0**

Because existing closed reconciliation outputs change, update manifest, validator pins, plugin changelog/README, frontend release display/tests, and the `AGENTS.md` current-version note together. Refresh the frozen contract from the authoritative backend schema using the repository's existing generator/validation pattern; do not hand-edit generated ordering inconsistently.

- [ ] **Step 3: Update operator guidance**

Document:

```text
future reconciliation: inspect -> preview (including temporal plan)
  -> explicit confirmation -> execute

existing repair: reconciliation inspect -> reflow.preview
  -> explicit confirmation -> reflow.execute
```

State that preview metadata is non-financial, execute is destructive, warnings/variance/staleness stop execution, and deploy/production repair require separate authorization.

- [ ] **Step 4: Run plugin and release checks**

```bash
cd plugins/creditsync && bun test && bun run validate
cd frontend && bun test
```

- [ ] **Step 5: Update changelogs and commit**

Update root/plugin changelogs and READMEs before staging, run `git diff --check`, then commit all synchronized contract/docs/release changes together.

---

### Task 8: Full verification, independent review, and branch handoff

**Files:**
- Modify only files required to fix verified failures or review findings
- Modify: `CHANGELOG.md` with any resulting correction before its commit

- [ ] **Step 1: Run the complete serial backend database suite**

```bash
backend/scripts/test-disposable-postgres.sh
```

No skipped database test is acceptable for the new financial invariants.

- [ ] **Step 2: Run all remaining gates**

```bash
bun run --cwd backend typecheck
cd frontend && bun test && bun run lint && bun run build
cd ../plugins/creditsync && bun test && bun run validate
cd ../.. && git diff --check && git status --short
```

- [ ] **Step 3: Inspect migration and financial invariants manually**

Review the final diff and test evidence for: deterministic locks/order, exact decimal conservation, reversal lineage, cache reconstruction from signed canonical rows, tenant isolation, stale preview detection, idempotency replay/conflict, audit safety, closed public schemas, unchanged transaction/intake/component totals, and preserved weekly behavior.

- [ ] **Step 4: Request independent code review**

Use `superpowers:requesting-code-review` against the complete feature-branch diff. Address every valid finding test-first, rerun affected focused gates, update `CHANGELOG.md`, and commit the correction. Do not dismiss financial/concurrency/schema findings without concrete evidence.

- [ ] **Step 5: Re-run full verification at final HEAD**

Repeat Steps 1-2 after the final correction commit. Record command results and final commit SHA in the tmux handoff.

- [ ] **Step 6: Hand off the isolated branch without integration**

Report tmux session, worktree, feature branch, integration target `main`, active model `gpt-5.6-luna` with medium reasoning, commits, verification results, remaining risks, and whether the client may disconnect. Do not merge, push, deploy, or run production preview/repair until the user separately authorizes each requested action.
