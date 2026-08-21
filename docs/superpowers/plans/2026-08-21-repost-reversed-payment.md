# Repost Reversed Payment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repost one fully reversed, evidence-backed historical payment as a new linked posted intake whose transactions allocate interest only and never reduce principal.

**Architecture:** Extend the existing payment reconciliation preview/execute service with a derived `reversed_repost` mode. Execution creates a child posted intake linked to the immutable reversed source, records replacement transactions under the child, and retains all evidence on the source. Tenant-scoped database constraints, version hashes, deterministic locks, and idempotent execution prevent duplicate or partial reposts.

**Tech Stack:** Bun, TypeScript, Elysia, Drizzle ORM, PostgreSQL 18, Decimal.js, React, i18next, CreditSync MCP/Plugin contract.

**Spec:** `docs/superpowers/specs/2026-08-21-repost-reversed-payment-design.md`

## Global Constraints

- Public money is a two-decimal string and all arithmetic uses `decimal.js`; never use JavaScript `Number` for financial values.
- The business timezone is `Asia/Bangkok`; timestamps remain ISO 8601 and historical effective dates remain `YYYY-MM-DD`.
- Original intake, evidence, repayment, reversal, accrual, and floating-allocation records remain immutable.
- Repost transactions and reconciliation entries have `principalComponent = "0.00"`, `feeComponent = "0.00"`, and `penaltyComponent = "0.00"`.
- Every write carries actor/source, request/correlation ID, reason, audit public UUID, and idempotency context.
- Only a fully reversed source with finalized `ready` evidence is eligible; evidence-free reversed duplicates fail closed.
- Preserve unrelated dirty files in the main checkout. Update `CHANGELOG.md` before every implementation commit; update `README.md` in the feature commit because the user-facing workflow changes.
- Do not push, deploy, or create production financial records without separate explicit authorization.

---

### Task 1: Persist Repost Lineage and Database Invariants

**Files:**
- Create: `backend/drizzle/0049_repost_reversed_payment.sql`
- Modify: `backend/drizzle/meta/_journal.json`
- Modify: `backend/src/db/schema.ts:1254-1545`
- Test: `backend/src/services/payment-reconciliation-service.test.ts`

**Interfaces:**
- Produces: `paymentIntakes.repostOfIntakeId: number | null` and `paymentReconciliationGroups.postedIntakeId: number | null`.
- Enforces: one child per `(tenant_id, repost_of_intake_id)` and tenant-safe self/FK lineage.

- [ ] **Step 1: Write the failing migration-backed schema test**

Add a test that inserts one reversed source, inserts one child with `repostOfIntakeId`, then proves a second child for the same source fails and a cross-tenant source link fails:

```ts
integrationTest("enforces tenant-safe one-to-one repost lineage", async () => {
    const source = await db.insert(paymentIntakes).values({
        tenantId, status: "reversed", amount: "75.00", createdByUserId: actor.id,
    }).returning().then((rows) => rows[0]!);
    await db.insert(paymentIntakes).values({
        tenantId, status: "posted", amount: "75.00", repostOfIntakeId: source.id,
        createdByUserId: actor.id, postedByUserId: actor.id,
    });
    await expect(db.insert(paymentIntakes).values({
        tenantId, status: "posted", amount: "75.00", repostOfIntakeId: source.id,
        createdByUserId: actor.id, postedByUserId: actor.id,
    })).rejects.toThrow();
});
```

- [ ] **Step 2: Run the focused disposable PostgreSQL test and verify RED**

Run:

```bash
cd backend
./scripts/test-disposable-postgres.sh ./src/services/payment-reconciliation-service.test.ts
```

Expected: FAIL because `repostOfIntakeId` and the database columns do not exist.

- [ ] **Step 3: Add the migration and Drizzle mappings**

Implement:

```sql
ALTER TABLE "payment_intakes" ADD COLUMN IF NOT EXISTS "repost_of_intake_id" integer;
ALTER TABLE "payment_reconciliation_groups" ADD COLUMN IF NOT EXISTS "posted_intake_id" integer;

ALTER TABLE "payment_intakes"
  ADD CONSTRAINT "payment_intakes_tenant_repost_source_fk"
  FOREIGN KEY ("tenant_id", "repost_of_intake_id")
  REFERENCES "payment_intakes"("tenant_id", "id");

CREATE UNIQUE INDEX "payment_intakes_tenant_repost_source_unique"
  ON "payment_intakes" ("tenant_id", "repost_of_intake_id")
  WHERE "repost_of_intake_id" IS NOT NULL;

ALTER TABLE "payment_reconciliation_groups"
  ADD CONSTRAINT "payment_reconciliation_groups_tenant_posted_intake_fk"
  FOREIGN KEY ("tenant_id", "posted_intake_id")
  REFERENCES "payment_intakes"("tenant_id", "id");
```

Mirror both columns, indexes, and foreign keys in `schema.ts`; append migration `0049_repost_reversed_payment` to `_journal.json`.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the Step 2 command. Expected: the lineage test passes.

- [ ] **Step 5: Update changelog and commit the schema unit**

Add a `v0.3.37` `### Added` bullet describing immutable reversed-payment repost lineage, then commit:

```bash
git add CHANGELOG.md backend/drizzle/0049_repost_reversed_payment.sql backend/drizzle/meta/_journal.json backend/src/db/schema.ts backend/src/services/payment-reconciliation-service.test.ts
git commit -m "feat: add reversed payment repost lineage"
```

---

### Task 2: Preview Fully Reversed Evidence-Backed Sources

**Files:**
- Modify: `backend/src/services/payment-reconciliation-service.ts:65-180`
- Modify: `backend/src/services/payment-reconciliation-service.test.ts`

**Interfaces:**
- Consumes: `paymentIntakes.repostOfIntakeId` from Task 1.
- Produces: preview `sourcePayment.mode` equal to `historical_needs_review` or `reversed_repost`, plus fully reversed transaction snapshot and `hasReadyEvidence`.

- [ ] **Step 1: Write failing preview eligibility tests**

Build a real posted floating payment, reverse it through `reversePayment`, attach/finalize ready evidence in the fixture, and assert:

```ts
const preview = await previewPaymentReconciliation(ctx, {
    paymentIntakePublicId: reversed.publicId,
    allocations: [{ borrowerPublicId, loanPublicId, amount: "45.00", component: "interest" }],
    reason: "Repost confirmed historical interest after full reversal",
});
expect(preview.sourcePayment).toMatchObject({
    mode: "reversed_repost",
    status: "reversed",
    hasReadyEvidence: true,
});
expect(preview.correction).toEqual({ principal: "0.00", interest: "45.00", fee: "0.00", penalty: "0.00" });
```

Add negative tests for: no ready evidence, an active original repayment, a partially compensated original, an existing child repost, and any component other than `interest`.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
cd backend
./scripts/test-disposable-postgres.sh ./src/services/payment-reconciliation-service.test.ts
```

Expected: reversed sources fail with `RECONCILIATION_INTAKE_INVALID`.

- [ ] **Step 3: Implement source-mode inspection and version hashing**

Add a focused helper:

```ts
type ReconciliationMode = "historical_needs_review" | "reversed_repost";

async function loadReversedRepaymentState(executor: Executor, ctx: CommandContext, intakeId: number): Promise<{
    originals: Array<typeof transactions.$inferSelect>;
    reversals: Array<typeof transactions.$inferSelect>;
}>;

async function sourceHasReadyEvidence(executor: Executor, ctx: CommandContext, intakeId: number): Promise<boolean>;

async function inspectReconciliationSource(executor: Executor, ctx: CommandContext, intake: IntakeRow) {
    if (intake.status === "needs_review") return { mode: "historical_needs_review" as const, originals: [], reversals: [], hasReadyEvidence: false };
    if (intake.status !== "reversed") throw new DomainError("RECONCILIATION_INTAKE_INVALID", "Only needs_review or fully reversed intakes can be reconciled", 409);
    const { originals, reversals } = await loadReversedRepaymentState(executor, ctx, intake.id);
    const hasReadyEvidence = await sourceHasReadyEvidence(executor, ctx, intake.id);
    const child = await executor.query.paymentIntakes.findFirst({ where: and(
        eq(paymentIntakes.tenantId, ctx.tenantId),
        eq(paymentIntakes.repostOfIntakeId, intake.id),
    ) });
    if (!originals.length || reversals.length !== originals.length) throw new DomainError("RECONCILIATION_SOURCE_NOT_FULLY_REVERSED", "Every source repayment must have one compensating reversal", 409);
    if (!hasReadyEvidence) throw new DomainError("RECONCILIATION_SOURCE_EVIDENCE_REQUIRED", "A finalized ready source evidence record is required", 409);
    if (child) throw new DomainError("RECONCILIATION_SOURCE_ALREADY_REPOSTED", "The reversed source already has a repost child", 409);
    return { mode: "reversed_repost" as const, originals, reversals, hasReadyEvidence: true };
}
```

Include original/reversal IDs and signed components, ready-evidence presence, and repost-child absence in `sourceSnapshot`, `previewHash`, and `expectedBalanceVersion`. Keep the MCP input component literal `interest`.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the Step 2 command. Expected: all preview eligibility tests pass.

- [ ] **Step 5: Update changelog and commit preview behavior**

Consolidate the changelog bullet with source eligibility and commit:

```bash
git add CHANGELOG.md backend/src/services/payment-reconciliation-service.ts backend/src/services/payment-reconciliation-service.test.ts
git commit -m "feat: preview reversed payment reposts"
```

---

### Task 3: Execute an Idempotent Child Repost Atomically

**Files:**
- Modify: `backend/src/services/payment-reconciliation-service.ts:180-330`
- Modify: `backend/src/services/payment-reconciliation-service.test.ts`

**Interfaces:**
- Consumes: preview source mode and lineage columns from Tasks 1–2.
- Produces: `{ reconciliationPublicId, sourcePaymentPublicId, postedPaymentPublicId, correctedTransactionPublicIds, auditPublicIds, correlationId }`.

- [ ] **Step 1: Write the failing two-loan repost execution test**

Use a reversed `75.00` source with ready evidence and two active floating loans. Preview allocations `45.00` and `30.00`, then execute and assert:

```ts
const executed = await executePaymentReconciliation(ctx, preview.publicId, {
    previewHash: preview.previewHash,
    expectedBalanceVersion: preview.expectedBalanceVersion,
    confirmed: true,
    reason: preview.reason,
    idempotencyKey: "repost-20260816-pajam-v1",
});
const source = await intakeByPublicId(sourcePublicId);
const child = await intakeByPublicId(executed.postedPaymentPublicId);
expect(source.status).toBe("reversed");
expect(child).toMatchObject({ status: "posted", repostOfIntakeId: source.id, amount: "75.00" });
expect(await evidenceFor(child.id)).toHaveLength(0);
expect((await transactionsFor(child.id)).map((row) => [row.principalComponent, row.interestComponent])).toEqual([
    ["0.00", "45.00"], ["0.00", "30.00"],
]);
expect(await principalsFor(targetLoanIds)).toEqual(["3000.00", "2000.00"]);
```

Also assert source ready evidence is unchanged, historical accruals are paid exactly, floating allocation keys are unique, group `postedIntakeId` is the child, and reconciliation entries are immutable.

- [ ] **Step 2: Add failing atomic stop/retry tests**

Cover stale preview, insufficient unpaid interest, second source repost, conflicting idempotency key, and identical retry:

```ts
const replay = await executePaymentReconciliation(ctx, preview.publicId, command);
expect(replay).toEqual(executed);
expect(await childCountFor(source.id)).toBe(1);
await expect(executePaymentReconciliation(ctx, otherPreview.publicId, { ...command, previewHash: otherPreview.previewHash }))
    .rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
```

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```bash
cd backend
./scripts/test-disposable-postgres.sh ./src/services/payment-reconciliation-service.test.ts
```

Expected: execute rejects the reversed source or does not create a child.

- [ ] **Step 4: Implement deterministic locked execution**

Under the existing transaction:

```ts
const postedIntake = source.mode === "reversed_repost"
    ? await tx.insert(paymentIntakes).values({
        tenantId: ctx.tenantId,
        ownerUserId: intake.ownerUserId,
        source: ctx.actorSource === "mcp" ? "mcp" : "web",
        status: "posted",
        amount: serializeMoney(intake.amount),
        receivedAt: intake.receivedAt,
        payerName: intake.payerName,
        originLoanId: intake.originLoanId,
        repostOfIntakeId: intake.id,
        notes: `Reposted after reversal from ${intake.publicId}`,
        idempotencyKey: `repost-child:${input.idempotencyKey}`,
        postedAt: new Date(),
        createdByUserId: ctx.actorUserId,
        updatedByUserId: ctx.actorUserId,
        postedByUserId: ctx.actorUserId,
    }).returning().then((rows) => rows[0]!)
    : intake;
```

Create replacement transactions under `postedIntake.id`, leave source and evidence unchanged, set group `postedIntakeId`, and return both public UUIDs. Recompute source inspection after locks before inserting any rows. Catch no uniqueness error as success unless an identical group idempotency replay already resolves to the same preview and payload.

- [ ] **Step 5: Run focused and floating regression suites**

Run:

```bash
cd backend
./scripts/test-disposable-postgres.sh ./src/services/payment-reconciliation-service.test.ts ./src/services/floating-allocation-regressions.test.ts
bun run typecheck
```

Expected: all tests pass; no skipped database invariant.

- [ ] **Step 6: Update changelog and commit execution behavior**

Update the existing `### Added`/`### Fixed` bullets and commit:

```bash
git add CHANGELOG.md backend/src/services/payment-reconciliation-service.ts backend/src/services/payment-reconciliation-service.test.ts
git commit -m "feat: execute reversed payment reposts"
```

---

### Task 4: Expose Repost Lineage Through REST and MCP

**Files:**
- Modify: `backend/src/services/payment-service.ts:145-165, 280-465`
- Modify: `backend/src/services/payment-reconciliation-service.ts`
- Modify: `backend/src/mcp/server.ts:353-375`
- Modify: `backend/src/mcp/contract-snapshot.ts`
- Modify: `backend/src/modules/payment-intakes.test.ts`
- Modify: `backend/src/modules/loan-payment-history.test.ts`
- Modify: `backend/src/mcp/server.test.ts`
- Modify: `plugins/creditsync/.codex-plugin/plugin.json`
- Modify: `plugins/creditsync/README.md`
- Modify: `plugins/creditsync/references/mcp-tool-contract.json`
- Modify: `plugins/creditsync/scripts/validate.ts`
- Modify: `plugins/creditsync/skills/reconcile-payments/SKILL.md`
- Modify: `plugins/creditsync/tests/plugin-contract.test.ts`

**Interfaces:**
- Produces intake fields `repostOfIntakePublicId: string | null`, `repostedByIntakePublicId: string | null`.
- Produces execute field `postedPaymentPublicId: string` while retaining `sourcePaymentPublicId`.

- [ ] **Step 1: Write failing REST/MCP contract tests**

Assert source and child lineage from `intake.get`, intake listing, and loan payment history. Assert MCP execute output requires `postedPaymentPublicId` and preview source mode remains a safe structured field:

```ts
expect(childDto).toMatchObject({ repostOfIntakePublicId: source.publicId, repostedByIntakePublicId: null });
expect(sourceDto).toMatchObject({ repostOfIntakePublicId: null, repostedByIntakePublicId: child.publicId });
expect(reconciliationExecuteOutput.parse(result).postedPaymentPublicId).toBe(child.publicId);
```

- [ ] **Step 2: Run contract tests and verify RED**

Run:

```bash
cd backend
bun test src/modules/payment-intakes.test.ts src/modules/loan-payment-history.test.ts src/mcp/server.test.ts
```

Expected: lineage/output fields are absent or rejected by the closed schema.

- [ ] **Step 3: Implement tenant-safe lineage presentation**

Batch-load source/child rows for list/history endpoints and extend `presentIntake` through an explicit presentation context:

```ts
type IntakeLineage = { repostOfIntakePublicId: string | null; repostedByIntakePublicId: string | null };

function presentIntake(row: IntakeRow, lineage: IntakeLineage = { repostOfIntakePublicId: null, repostedByIntakePublicId: null }) {
    return {
        id: row.publicId,
        publicId: row.publicId,
        source: row.source,
        status: row.status,
        amount: serializeMoney(row.amount),
        receivedAt: row.receivedAt,
        payerName: row.payerName,
        bankReference: row.bankReference,
        warnings: row.warnings ?? [],
        notes: row.notes,
        postedAt: row.postedAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        ...lineage,
    };
}
```

Never expose internal integer IDs. Add `postedPaymentPublicId` to the closed MCP output and regenerate the canonical contract:

```bash
bun run plugins/creditsync/scripts/mcp-contract.ts --write
```

Bump the private plugin minor version from `7.2.0` to `7.3.0`, update validator counts/compatibility text, and document that repost requires source inspection, ready evidence, exact preview, and confirmation.

- [ ] **Step 4: Run backend and plugin contract tests and verify GREEN**

Run:

```bash
cd backend
bun test src/modules/payment-intakes.test.ts src/modules/loan-payment-history.test.ts src/mcp/server.test.ts
bun run typecheck
cd ../plugins/creditsync
bun test
bun run validate
```

- [ ] **Step 5: Update README/changelog and commit the public contract**

Document child/source lineage and interest-only repost safety in `README.md`; update `CHANGELOG.md`, then commit all contract/plugin changes together.

```bash
git add CHANGELOG.md README.md backend/src/services/payment-service.ts backend/src/services/payment-reconciliation-service.ts backend/src/mcp backend/src/modules/payment-intakes.test.ts backend/src/modules/loan-payment-history.test.ts plugins/creditsync
git commit -m "feat: expose payment repost lineage"
```

---

### Task 5: Present Reposted Lineage in Payment History

**Files:**
- Modify: `frontend/src/pages/dashboard/payments/payment-inbox-list-model.ts`
- Modify: `frontend/src/pages/dashboard/payments/PaymentInbox.tsx`
- Modify: `frontend/src/pages/dashboard/payments/PaymentInboxList.tsx`
- Modify: `frontend/src/pages/dashboard/loans/LoanRepaymentHistory.tsx`
- Modify: `frontend/src/locales/en.json`
- Modify: `frontend/src/locales/th.json`
- Create: `frontend/src/pages/dashboard/loans/LoanRepaymentHistory.test.tsx`

**Interfaces:**
- Consumes: nullable source/child public UUIDs from Task 4.
- Produces: localized lineage badges/links without changing financial calculations in the browser.

- [ ] **Step 1: Write failing presentation tests**

Render one reversed source and one posted child and assert localized labels and navigation targets:

```tsx
expect(screen.getByText("ลงใหม่หลังย้อนรายการ")).toBeInTheDocument();
await user.click(screen.getByRole("link", { name: "ดูรายการเดิม" }));
expect(mockNavigate).toHaveBeenCalledWith(expect.stringContaining(`intake=${sourcePublicId}`));
```

Assert the child allocation displays only backend-returned interest and the source remains visually `reversed`.

- [ ] **Step 2: Run frontend test and verify RED**

Run:

```bash
cd frontend
bun test --run
```

Expected: repost labels/links are absent.

- [ ] **Step 3: Add typed lineage fields and localized presentation**

Extend models:

```ts
repostOfIntakePublicId?: string | null;
repostedByIntakePublicId?: string | null;
```

Show a semantic `posted (reposted after reversal)` label on the child and a `reposted by` link on the source. Add matching keys to both `en.json` and `th.json`. Use existing backend money fields and `formatMoneyExact`; do not recalculate allocations or totals.

- [ ] **Step 4: Run frontend verification**

Run:

```bash
cd frontend
bun test --run
bun run lint
bun run build
```

Expected: tests, lint, and build pass; only the existing bundle-size warning is acceptable.

- [ ] **Step 5: Update changelog and commit presentation**

Update `CHANGELOG.md` under the same version/date and commit:

```bash
git add CHANGELOG.md frontend/src/pages/dashboard/payments frontend/src/pages/dashboard/loans/LoanRepaymentHistory.tsx frontend/src/pages/dashboard/loans/LoanRepaymentHistory.test.tsx frontend/src/locales/en.json frontend/src/locales/th.json
git commit -m "feat: show reversed payment repost lineage"
```

---

### Task 6: Final Financial Verification and Release Readiness

**Files:**
- Review: all files changed since the spec commit
- Modify: `CHANGELOG.md` or `README.md` only if verification reveals inaccurate release notes

**Interfaces:**
- Verifies the complete database → service → MCP/REST → frontend/plugin workflow.

- [ ] **Step 1: Run backend database and type gates**

```bash
cd backend
./scripts/test-disposable-postgres.sh ./src/services/payment-reconciliation-service.test.ts ./src/services/floating-allocation-regressions.test.ts
bun run typecheck
bun test src/modules/payment-intakes.test.ts src/modules/loan-payment-history.test.ts src/mcp/server.test.ts
```

- [ ] **Step 2: Run frontend gates**

```bash
cd frontend
bun test --run
bun run lint
bun run build
```

- [ ] **Step 3: Run plugin gates**

```bash
cd plugins/creditsync
bun test
bun run validate
```

- [ ] **Step 4: Inspect the final diff and migration safety**

```bash
git diff --check
git status --short
git log --oneline --decorate -8
```

Confirm: no raw evidence/reference/QR values, no credentials, no unrelated dirty files, no `Number` financial arithmetic, and all release notes match the staged behavior.

- [ ] **Step 5: Perform a controlled disposable end-to-end replay**

Using only the disposable PostgreSQL test environment, reproduce a `75.00` fully reversed source with ready evidence and repost it as `45.00`/`30.00` interest. Verify source `reversed`, child `posted`, source evidence unchanged, principal unchanged, target historical accruals paid, one reconciliation group, and identical retry row counts unchanged.

- [ ] **Step 6: Create the final implementation commit only if verification required documentation corrections**

```bash
git add CHANGELOG.md README.md
git commit -m "docs: finalize reversed payment repost workflow"
```

Skip this commit when no documentation correction is necessary. Do not merge, push, deploy, or execute the real ป้าแจ่ม payment until the user separately authorizes those actions after implementation verification.
