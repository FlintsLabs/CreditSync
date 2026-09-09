# Renewal-Origin Scheduled Payment Allocation Correction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow the existing append-only scheduled payment allocation-correction workflow to accept immutable opening adjustments created by the executed renewal that produced the current loan, while preserving every real downstream blocker and then safely repair the authorized THB 200.00 production allocation.

**Architecture:** Extend dependency loading in `payment-allocation-correction-service.ts` to classify posted adjustments by explicit renewal lineage. Eligible executed-renewal `principal_transfer` and `cash_payout` rows on the renewal's new loan become hashed opening ancestors rather than warnings; every other posted adjustment remains a blocker. Keep the existing public MCP request/response schema and append-only execute path unchanged, then synchronize tests, plugin guidance, evals, and release metadata.

**Tech Stack:** Bun, TypeScript, Drizzle ORM, PostgreSQL 18 disposable integration database, Elysia MCP server, Zod MCP schemas, CreditSync private plugin/eval harness.

**Spec:** `docs/superpowers/specs/2026-09-09-renewal-origin-allocation-correction-design.md`

## Global Constraints

- THB values remain two-decimal strings and all arithmetic uses `FinancialDecimal`/`decimal.js`; never use JavaScript `Number` for money.
- Financial history remains immutable and append-only; do not edit or delete the source payment, source transaction, renewal, renewal adjustments, or posted schedules.
- Execution remains `inspect → preview → explicit human confirmation → execute` with reason, request/correlation context, stable idempotency key, preview hash, and expected balance version.
- Only an executed renewal's `principal_transfer` and `cash_payout` adjustments whose `newLoanId` and adjustment `loanId` equal the source loan are eligible opening ancestors.
- Unknown, unrelated, differently linked, or non-executed adjustments fail closed as `PAYMENT_ALLOCATION_CORRECTION_DEPENDENCY` blockers.
- Existing tenant isolation, component conservation, stale/expiry, overpayment, later-repayment, reconciliation, attribution, downstream-renewal, and idempotent concurrency guards remain intact.
- Production deployment and production financial execution are separately authorized operations; no production repair executes during deployment.
- Preserve unrelated working-tree changes in `backend/src/lib/floating-interest-policy.test.ts` and `docs/superpowers/plans/2026-09-08-weekly-floating-interest-regression-tests.md`.
- Before every commit, update the root `CHANGELOG.md`; update plugin `CHANGELOG.md` in the same commit as plugin behavior/documentation.

---

### Task 1: Reproduce Renewal-Origin False Blocker

**Files:**
- Modify: `backend/src/services/payment-allocation-correction-service.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: existing `fixture()` and `previewPaymentAllocationCorrection()`.
- Produces: a production-shaped regression fixture with an executed `loanRenewals` row and linked `loanAdjustments` rows.

- [ ] **Step 1: Extend test imports and fixture helpers**

Import `loanAdjustments` and `loanRenewals`. Add a helper that creates an old renewed loan, an executed renewal pointing from the old loan to the fixture's active loan, and linked new-loan adjustments:

```ts
async function seedRenewalOpeningAdjustments(seeded: Awaited<ReturnType<typeof fixture>>) {
    const oldLoan = (await db.insert(loans).values({
        tenantId: seeded.tenantId,
        ownerUserId: seeded.ctx.actorUserId,
        borrowerId: seeded.loan.borrowerId,
        principalAmount: "4000.00",
        interestRate: "0.00",
        repaymentType: "daily",
        termMonths: 1,
        status: "renewed",
    }).returning())[0]!;
    const renewal = (await db.insert(loanRenewals).values({
        tenantId: seeded.tenantId,
        oldLoanId: oldLoan.id,
        newLoanId: seeded.loan.id,
        requestedPrincipal: "4000.00",
        outstandingPrincipal: "1913.08",
        dueCharges: "0.00",
        waivedCharges: "0.00",
        settlementPolicy: "full_contract_interest",
        cashDirection: "payout",
        cashAmount: "1800.00",
        renewalDate: "2026-09-05",
        previewHash: `v1:${"1".repeat(64)}`,
        expiresAt: new Date("2099-09-05T00:00:00.000Z"),
        status: "executed",
    }).returning())[0]!;
    const adjustments = await db.insert(loanAdjustments).values([
        { tenantId: seeded.tenantId, loanId: seeded.loan.id, renewalId: renewal.id, adjustmentType: "principal_transfer", amount: "1913.08", status: "posted", reason: "renewal" },
        { tenantId: seeded.tenantId, loanId: seeded.loan.id, renewalId: renewal.id, adjustmentType: "cash_payout", amount: "1800.00", status: "posted", reason: "renewal" },
    ]).returning();
    return { oldLoan, renewal, adjustments };
}
```

- [ ] **Step 2: Write the failing production-shaped preview test**

```ts
integrationTest("allows executed-renewal opening adjustments on the renewal-created loan", async () => {
    const seeded = await fixture();
    const opening = await seedRenewalOpeningAdjustments(seeded);
    const preview = await previewPaymentAllocationCorrection(seeded.ctx, {
        paymentIntakePublicId: seeded.intake.publicId,
        transactionPublicId: seeded.source.publicId,
        targetSchedulePublicId: seeded.schedules[0]!.publicId,
        reason: "Move payment to the received installment",
    });
    expect(preview.status).toBe("ready");
    expect(preview.warnings).toEqual([]);
    expect(await db.select().from(loanAdjustments).where(eq(loanAdjustments.renewalId, opening.renewal.id)))
        .toEqual(expect.arrayContaining(opening.adjustments.map((row) => expect.objectContaining({ publicId: row.publicId, status: "posted" }))));
});
```

- [ ] **Step 3: Run the focused test and verify RED**

Run:

```bash
backend/scripts/test-disposable-postgres.sh src/services/payment-allocation-correction-service.test.ts
```

Expected: the new test fails because preview status is `blocked` with both opening adjustment public IDs.

- [ ] **Step 4: Update the changelog and commit the failing regression**

Add a `v0.4.5` `### Fixed` entry stating that regression coverage reproduces renewal-origin opening adjustments being misclassified as downstream blockers.

```bash
git add backend/src/services/payment-allocation-correction-service.test.ts CHANGELOG.md
git commit -m "test: reproduce renewal allocation blocker"
```

### Task 2: Implement Causal Dependency Classification

**Files:**
- Modify: `backend/src/services/payment-allocation-correction-service.ts`
- Modify: `backend/src/services/payment-allocation-correction-service.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: `loanAdjustments`, `loanRenewals`, `transactions`, and the existing `Loaded`/`version()` pipeline.
- Produces: internal `DependencyClassification` with deterministic `blockerIds` and `openingAncestors`; no public MCP schema change.

- [ ] **Step 1: Add failing hard-blocker tests before production code**

Add separate tests proving that each row remains blocked:

```ts
integrationTest("blocks an unrelated posted adjustment on the source loan", async () => {
    const seeded = await fixture();
    const blocker = (await db.insert(loanAdjustments).values({
        tenantId: seeded.tenantId,
        loanId: seeded.loan.id,
        adjustmentType: "manual_fee",
        amount: "1.00",
        status: "posted",
        reason: "downstream",
    }).returning())[0]!;
    const preview = await previewPaymentAllocationCorrection(seeded.ctx, {
        paymentIntakePublicId: seeded.intake.publicId,
        transactionPublicId: seeded.source.publicId,
        targetSchedulePublicId: seeded.schedules[0]!.publicId,
        reason: "Move payment",
    });
    expect(preview).toMatchObject({ status: "blocked", warnings: [{ code: "PAYMENT_ALLOCATION_CORRECTION_DEPENDENCY", blockerPublicIds: [blocker.publicId] }] });
});
```

Create equivalent tests for an unknown adjustment type linked to the creating renewal, an allowed type linked to a different renewal/new loan, and an allowed type linked to a non-executed renewal. Each must return the exact blocker public ID.

- [ ] **Step 2: Run the focused test and confirm only the allow-case is RED**

```bash
backend/scripts/test-disposable-postgres.sh src/services/payment-allocation-correction-service.test.ts
```

Expected: existing blocker tests pass; the renewal-origin allow-case from Task 1 fails.

- [ ] **Step 3: Implement a typed classifier**

Add these internal types and replace the all-adjustments blocker query:

```ts
type OpeningAncestor = {
    adjustmentPublicId: string;
    adjustmentType: "principal_transfer" | "cash_payout";
    amount: string;
    status: string;
    renewalPublicId: string;
    renewalStatus: string;
    newLoanPublicId: string;
};
type DependencyClassification = { blockerIds: string[]; openingAncestors: OpeningAncestor[] };
```

Load posted adjustments with their renewal rows and classify an adjustment as an opening ancestor only when:

```ts
const allowedOpeningTypes = new Set(["principal_transfer", "cash_payout"]);
const isOpeningAncestor = adjustment.renewalId !== null
    && renewal?.status === "executed"
    && renewal.newLoanId === source.loanId
    && adjustment.loanId === source.loanId
    && allowedOpeningTypes.has(adjustment.adjustmentType);
```

Resolve the renewal and new-loan public UUIDs, format amount with `money()`, sort `openingAncestors` and `blockerIds` by public ID, and return both sets. Keep existing non-adjustment blocker detection unchanged.

- [ ] **Step 4: Include opening ancestors in the stale-state version**

Change `Loaded` to hold `dependencies: DependencyClassification`. Hash both deterministic arrays:

```ts
dependencies: {
    blockerIds: loaded.dependencies.blockerIds,
    openingAncestors: loaded.dependencies.openingAncestors,
},
```

Preview warnings use only `blockerIds`; execute reloads the same classification under lock and compares the full balance version.

- [ ] **Step 5: Run focused tests and verify GREEN**

```bash
backend/scripts/test-disposable-postgres.sh src/services/payment-allocation-correction-service.test.ts
```

Expected: all allocation-correction service tests pass with the renewal-origin case `ready` and every unsafe case `blocked`.

- [ ] **Step 6: Update changelog and commit**

Record the narrow causal-lineage allowlist and continued fail-closed behavior under `v0.4.5` `### Fixed`.

```bash
git add backend/src/services/payment-allocation-correction-service.ts backend/src/services/payment-allocation-correction-service.test.ts CHANGELOG.md
git commit -m "fix: allow renewal-origin allocation correction"
```

### Task 3: Prove Execute, Stale-State, and Immutability Semantics

**Files:**
- Modify: `backend/src/services/payment-allocation-correction-service.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: the Task 2 classifier and unchanged execute input contract.
- Produces: regression evidence for append-only execution and stale opening-lineage protection.

- [ ] **Step 1: Write an execute preservation test**

Seed opening adjustments, preview, execute, and assert:

```ts
expect(result).toMatchObject({
    amount: "200.00",
    components: { principal: "173.92", interest: "26.08", fee: "0.00", penalty: "0.00" },
    sourceSchedulePublicId: seeded.schedules[1]!.publicId,
    targetSchedulePublicId: seeded.schedules[0]!.publicId,
});
expect(await db.select().from(loanAdjustments).where(eq(loanAdjustments.renewalId, opening.renewal.id)))
    .toEqual(opening.adjustments);
```

Also assert three payment transactions exist, the compensation/replacement preserve the transaction date and exact signed components, the intake remains posted, source becomes unpaid, target becomes paid, and loan outstanding totals are unchanged.

- [ ] **Step 2: Write stale-state tests for ancestor mutation**

Create a ready preview, then in separate tests change the opening adjustment status and renewal status before execute. Execute must reject with `STALE_CORRECTION_PREVIEW` and create no correction group or financial transaction.

- [ ] **Step 3: Run focused tests and verify RED/GREEN behavior**

Run after adding each test:

```bash
backend/scripts/test-disposable-postgres.sh src/services/payment-allocation-correction-service.test.ts
```

Expected before any necessary Task 2 hash correction: stale test fails by permitting execute or returning the wrong error. Expected after the minimal hash/classifier correction: all tests pass.

- [ ] **Step 4: Verify database immutability and concurrency suites**

```bash
backend/scripts/test-disposable-postgres.sh \
  src/db/payment-allocation-correction-migration.test.ts \
  src/services/payment-allocation-correction-service.test.ts
```

Expected: immutable preview/group/entry triggers, request-hash replay, and concurrent identical execution tests pass.

- [ ] **Step 5: Update changelog and commit**

Record stale-lineage and execute-preservation coverage under `v0.4.5` `### Fixed`.

```bash
git add backend/src/services/payment-allocation-correction-service.test.ts CHANGELOG.md
git commit -m "test: verify renewal-safe correction execution"
```

### Task 4: Synchronize MCP and Private Plugin Guidance

**Files:**
- Modify: `backend/src/mcp/default.test.ts`
- Modify: `backend/src/mcp/server.test.ts`
- Modify: `plugins/creditsync/skills/reconcile-payments/SKILL.md`
- Modify: `plugins/creditsync/README.md`
- Modify: `plugins/creditsync/evals/harness.ts`
- Modify: `plugins/creditsync/tests/operations-docs.test.ts`
- Modify: `plugins/creditsync/CHANGELOG.md`
- Verify/regenerate only if changed: `plugins/creditsync/references/mcp-tool-contract.json`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: unchanged `payment.allocation-correction.preview` and `.execute` schemas.
- Produces: agent guidance and eval coverage that distinguishes eligible opening ancestors from actual downstream blockers.

- [ ] **Step 1: Add failing documentation and eval assertions**

Extend `operations-docs.test.ts` to require these concepts in the reconciliation skill: `executed renewal`, `principal_transfer`, `cash_payout`, `opening ancestor`, and `unknown adjustment remains blocked`.

Add an eval scenario where preview is `ready` for renewal-origin opening adjustments and execution occurs only after the scripted explicit-confirmation step. Keep the existing blocker scenario unchanged for actual blockers.

- [ ] **Step 2: Run plugin tests and verify RED**

```bash
cd plugins/creditsync && bun test tests/operations-docs.test.ts evals/harness.test.ts
```

Expected: new wording/eval assertions fail before guidance and fixtures are updated.

- [ ] **Step 3: Update MCP integration tests and plugin guidance**

Document that opening adjustments are accepted only through verified creating-renewal lineage and are included in stale-state validation. Explicitly retain the stop condition for unknown or unrelated adjustments. Update README operator guidance with the same boundary.

In MCP tests, assert the existing closed input/output schemas are unchanged and a ready preview still exposes only safe public UUIDs and decimal strings.

- [ ] **Step 4: Validate or regenerate the frozen contract**

Run:

```bash
cd backend && bun test src/mcp/server.test.ts src/mcp/default.test.ts
cd ../plugins/creditsync && bun run scripts/validate.ts
```

If validation reports no schema drift, leave `mcp-tool-contract.json` byte-identical. If advertised schema generation changes despite the intended backward-compatible contract, regenerate using the repository's existing contract generator, inspect the exact diff, and include it only when it matches the approved design.

- [ ] **Step 5: Run plugin tests and validator GREEN**

```bash
cd plugins/creditsync && bun test && bun run scripts/validate.ts
```

Expected: all plugin tests, eval scenarios, tool count, schema closure, annotations, and validator checks pass.

- [ ] **Step 6: Update release metadata and commit**

Update both changelogs under explicit version/date headings and update root/plugin README guidance in the same commit.

```bash
git add backend/src/mcp/default.test.ts backend/src/mcp/server.test.ts \
  plugins/creditsync/skills/reconcile-payments/SKILL.md plugins/creditsync/README.md \
  plugins/creditsync/evals/harness.ts plugins/creditsync/tests/operations-docs.test.ts \
  plugins/creditsync/references/mcp-tool-contract.json plugins/creditsync/CHANGELOG.md \
  README.md CHANGELOG.md
git commit -m "docs: synchronize renewal-safe correction workflow"
```

### Task 5: Full Verification, Review, and Integration

**Files:**
- Review: all files changed on the feature branch
- Modify only for validated fixes: affected source/test/docs files and `CHANGELOG.md`

**Interfaces:**
- Consumes: Tasks 1-4.
- Produces: a reviewed feature branch whose exact diff and verification evidence are ready to merge and deploy.

- [ ] **Step 1: Run backend financial gates**

```bash
cd backend
../backend/scripts/test-disposable-postgres.sh \
  src/db/payment-allocation-correction-migration.test.ts \
  src/services/payment-allocation-correction-service.test.ts \
  src/services/payment-service.test.ts \
  src/services/loan-renewal-service.test.ts \
  src/mcp/default.test.ts \
  src/mcp/server.test.ts
bun run typecheck
```

Expected: database suites run rather than skip, all tests pass, and typecheck exits zero.

- [ ] **Step 2: Run frontend and plugin gates**

```bash
cd frontend && bun test && bun run lint && bun run build
cd ../plugins/creditsync && bun test && bun run scripts/validate.ts
```

Expected: all commands exit zero without introducing localized UI copy changes.

- [ ] **Step 3: Review immutable financial invariants**

Inspect `git diff main...HEAD` and verify:

- no migration or persisted financial row is edited;
- no force/override input exists;
- the allowlist is exactly `principal_transfer` and `cash_payout` on the executed renewal-created loan;
- every non-eligible adjustment remains in deterministic blockers;
- opening lineage participates in stale hashing;
- execute remains confirmation-gated, atomic, idempotent, and exact-component preserving;
- unrelated user changes are absent from the feature branch.

- [ ] **Step 4: Request independent code review and fix validated findings with TDD**

Run the repository's review workflow against `main...HEAD`. For each validated finding, add a failing regression test, verify RED, apply the minimal fix, and rerun the affected gates. Update `CHANGELOG.md` before any fix commit.

- [ ] **Step 5: Merge only after explicit authorization**

After review and user authorization, merge the feature branch into `main` without including unrelated working-tree changes. Verify:

```bash
git merge-base --is-ancestor codex/renewal-origin-allocation-correction main
```

Expected: exit zero.

### Task 6: Deploy Capability and Repair the Authorized Production Allocation

**Files:**
- No source edits expected after the verified merge.
- Production state changes only through deployment and CreditSync MCP financial commands.

**Interfaces:**
- Consumes: merged and verified service/plugin capability plus the exact production intake, transaction, loan, and target schedule public IDs.
- Produces: one append-only correction with audit and correlation IDs, or a hard stop if any gate is not ready.

- [ ] **Step 1: Obtain explicit deployment authorization**

Show the merged commit, verification gates, deployment commands, and rollback boundary. Do not deploy until the user explicitly authorizes production deployment.

- [ ] **Step 2: Deploy backend/plugin capability**

Use the repository production compose workflow to rebuild only the backend unless another changed runtime component requires deployment:

```bash
docker compose --env-file .env.production -f docker-compose.app.yml up --build -d backend
```

Verify backend migration logs contain no unexpected migration and check MCP health from inside the backend container against `http://127.0.0.1:3000/mcp/health`.

- [ ] **Step 3: Re-inspect production state read-only**

Confirm the exact intake remains posted for THB 200.00 at 2026-09-06 15:38 Asia/Bangkok, the source allocation is the 2026-09-07 schedule, the target is the unpaid 2026-09-06 schedule, the component split is THB 173.92 principal plus THB 26.08 interest, the creating renewal is executed, and both opening adjustments remain posted and unchanged.

- [ ] **Step 4: Create a fresh production correction preview**

Call `payment.allocation-correction.preview` with the exact public IDs and normalized reason. Require:

```text
status = ready
warnings = []
amount = 200.00
components = { principal: 173.92, interest: 26.08, fee: 0.00, penalty: 0.00 }
netLoanVariance = all 0.00
source dueDate = 2026-09-07, after remainingDue = 200.00
target dueDate = 2026-09-06, after remainingDue = 0.00
```

Any mismatch, warning, stale state, or expiry is a hard stop.

- [ ] **Step 5: Obtain explicit confirmation of the fresh preview**

Show exact before/after source and target rows, amount/components, expiry, and zero variance. Ask the user to confirm execution of that preview. Do not treat earlier design, implementation, merge, or deployment approvals as financial-post confirmation.

- [ ] **Step 6: Execute once and verify authoritative production state**

After confirmation, call `payment.allocation-correction.execute` with unchanged preview hash/version/reason, `confirmed: true`, and a stable operation-specific idempotency key. Re-inspect intake history, both schedules, loan contract/rollup, renewal and opening adjustments, correction record, audit public ID, and correlation ID.

Completion requires authoritative evidence that the 2026-09-06 schedule is paid THB 200.00, the 2026-09-07 schedule is unpaid THB 200.00, the payment and opening adjustments remain immutable, net loan components are unchanged, and exactly one correction group with one compensation/replacement pair exists.
