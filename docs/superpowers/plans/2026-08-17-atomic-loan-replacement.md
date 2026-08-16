# Atomic Loan Replacement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a preview-confirm-execute-reverse workflow that atomically activates an existing scheduled-loan draft, marks the erroneous active loan `replaced`, preserves append-only corrections and lineage, and safely completes the prepared production replacement.

**Architecture:** Introduce a tenant-scoped `loan_replacements` aggregate and correction ledger, then implement a dedicated service that composes shared loan activation and funding primitives under one PostgreSQL transaction. REST, MCP, plugin, and frontend surfaces consume the same authoritative preview and expose exact before/after state; reversal restores persisted snapshots only while downstream state remains safe.

**Tech Stack:** Bun, TypeScript, Elysia, Drizzle ORM, PostgreSQL 18, Decimal.js/`FinancialDecimal`, MCP SDK/Zod, React, TanStack Query, Vitest, Docker Compose.

## Global Constraints

- Money crosses public interfaces as two-decimal strings and is calculated with `FinancialDecimal`/Decimal.js; never use JavaScript `Number` for money.
- Business dates use `Asia/Bangkok`, ISO timestamps, and `YYYY-MM-DD` due dates.
- Posted financial history is append-only; replacement uses corrections and status transitions, never deletes or edits posted records.
- Every write carries request/correlation ID, actor/source, idempotency key, and append-only audit history.
- The old loan status is `replaced`, displayed as `Closed — Replaced` / `ปิดแล้ว — ถูกแทนที่`, and never classified as paid.
- Execute and reverse are atomic, explicitly confirmed, idempotent, and fail closed on stale or ambiguous state.
- The frozen MCP contract, private plugin version, skills, evals, validator, and reference snapshot change together.
- Before every commit, update `CHANGELOG.md` and stage it with that task's code; update `README.md` when the user-facing workflow or setup materially changes.
- Preserve existing dirty files `.agents/skills/creditsync-slip-ocr/scripts/ocr.ts`, `frontend/src/locales/th.json`, and `tha.traineddata`; do not stage or overwrite unrelated user changes.

---

### Task 1: Add the append-only replacement schema and terminal loan status

**Files:**
- Modify: `backend/src/db/schema.ts`
- Create: `backend/drizzle/0042_atomic_loan_replacement.sql`
- Modify: `backend/drizzle/meta/_journal.json`
- Create: `backend/src/db/atomic-loan-replacement-migration.test.ts`
- Modify: `backend/src/db/agent-workflow-schema.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces: Drizzle tables `loanReplacements` and `loanReplacementCorrections`.
- Produces statuses `preview | executed | reversed | expired` for replacement records and `replaced` for loans.
- Produces tenant-scoped foreign keys, lifecycle checks, idempotency indexes, and immutability triggers consumed by Task 2.

- [ ] **Step 1: Write failing migration-contract tests**

Add assertions that migration `0042` creates `loan_replacements` and `loan_replacement_corrections`, extends the loan-status constraint with `replaced`, registers the journal entry after `0041`, and declares tenant-scoped old/replacement loan, actor, audit, and correction relations.

```ts
expect(sqlText).toContain('CREATE TABLE "loan_replacements"');
expect(sqlText).toContain("status IN ('preview', 'executed', 'reversed', 'expired')");
expect(sqlText).toContain("'replaced'");
expectTenantForeignKey("loanReplacements", "old_loan_id", "loans");
expectTenantForeignKey("loanReplacements", "replacement_loan_id", "loans");
```

- [ ] **Step 2: Run the focused tests and confirm RED**

Run: `cd backend && bun test src/db/atomic-loan-replacement-migration.test.ts src/db/agent-workflow-schema.test.ts`

Expected: FAIL because migration `0042`, tables, relations, and `replaced` status do not exist.

- [ ] **Step 3: Implement the additive schema and migration**

Define exact numeric correction columns (`principal`, `interest`, `fee`, `penalty`), immutable snapshots/version hashes, preview expiry, lifecycle actor/audit fields, and partial unique indexes preventing multiple non-reversed executions for either loan. Add triggers that reject deletion and mutation of executed/reversed rows outside the legal lifecycle transition.

```ts
export const loanReplacements = pgTable("loan_replacements", {
  id: serial("id").primaryKey(),
  publicId: uuid("public_id").defaultRandom().notNull().unique(),
  tenantId: text("tenant_id").notNull(),
  oldLoanId: integer("old_loan_id").notNull(),
  replacementLoanId: integer("replacement_loan_id").notNull(),
  status: text("status").notNull().default("preview"),
  reason: text("reason").notNull(),
  oldBalanceVersion: text("old_balance_version").notNull(),
  replacementDraftVersion: text("replacement_draft_version").notNull(),
  previewHash: text("preview_hash").notNull(),
  requestHash: text("request_hash").notNull(),
  preExecutionSnapshot: jsonb("pre_execution_snapshot"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  // request/correlation, execute/reverse keys, actor, audit, and timestamps
});
```

- [ ] **Step 4: Add database lifecycle and tenant-isolation tests**

Use disposable PostgreSQL fixtures to prove cross-tenant references fail, duplicate executed lineage fails, legal `preview → executed → reversed` transitions succeed, and update/delete attempts against executed/reversed rows fail with the replacement immutability error.

- [ ] **Step 5: Run migration and schema tests**

Run: `cd backend && ./scripts/test-disposable-postgres.sh src/db/atomic-loan-replacement-migration.test.ts src/db/agent-workflow-schema.test.ts`

Expected: PASS with no skipped DB suite.

- [ ] **Step 6: Update changelog and commit Task 1**

```bash
git add CHANGELOG.md backend/src/db/schema.ts backend/drizzle/0042_atomic_loan_replacement.sql backend/drizzle/meta/_journal.json backend/src/db/atomic-loan-replacement-migration.test.ts backend/src/db/agent-workflow-schema.test.ts
git commit -m "feat: add atomic loan replacement ledger"
```

### Task 2: Implement authoritative preview, execution, and reversal services

**Files:**
- Create: `backend/src/services/loan-replacement-service.ts`
- Create: `backend/src/services/loan-replacement-service.test.ts`
- Modify: `backend/src/services/loan-application-service.ts`
- Modify: `backend/src/services/loan-funding-service.ts`
- Modify: `backend/src/services/loan-disbursement-service.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces:

```ts
previewLoanReplacement(ctx: CommandContext, input: {
  oldLoanPublicId: string;
  replacementDraftPublicId: string;
  reason: string;
}): Promise<LoanReplacementPreview>

executeLoanReplacement(ctx: CommandContext, input: {
  replacementPublicId: string;
  previewHash: string;
  expectedOldBalanceVersion: string;
  expectedReplacementDraftVersion: string;
  reason: string;
  confirmed: true;
}): Promise<LoanReplacementExecution>

reverseLoanReplacement(ctx: CommandContext, input: {
  replacementPublicId: string;
  reason: string;
}): Promise<LoanReplacementReversal>
```

- Consumes shared transaction-capable activation/funding primitives extracted from the existing services without changing standalone loan activation behavior.

- [ ] **Step 1: Write RED tests for the approved exact case**

Seed an active `36,000.00` daily loan with `4,200.00` calculated interest, no paid principal/effective posted disbursement, an active TTB drawdown, and a funded replacement draft starting `2026-07-11`. Assert preview reports cash `none/0.00`, corrections `36,000.00/4,200.00`, and installment 1 due `2026-07-12`.

```ts
expect(preview).toMatchObject({
  cash: { direction: "none", amount: "0.00" },
  correction: { principal: "36000.00", interest: "4200.00", fee: "0.00", penalty: "0.00" },
  replacement: { firstDueDate: "2026-07-12" },
});
```

- [ ] **Step 2: Run the service test and confirm RED**

Run: `cd backend && ./scripts/test-disposable-postgres.sh src/services/loan-replacement-service.test.ts`

Expected: FAIL because the service and replacement tables are absent from behavior.

- [ ] **Step 3: Extract transaction-capable activation and allocation primitives**

Refactor existing activation/funding internals to accept a Drizzle transaction and command context, preserving the public `activateLoan` and allocation functions as wrappers. Do not duplicate schedule math or funding-capacity calculations.

```ts
export async function activateLoanInTransaction(
  tx: DbTransaction,
  ctx: CommandContext,
  loan: LoanRow,
  options: { replacementId?: number },
): Promise<ActivatedLoanResult>;
```

- [ ] **Step 4: Implement preview with exact fingerprints**

Build deterministic SHA-256 versions from canonical old balances/schedules/downstream IDs and replacement draft terms/funding allocation. Persist a 15-minute preview, exact before/after values, warnings, and audit action `previewed`; do not mutate financial rows.

- [ ] **Step 5: Implement atomic execute**

Acquire stable advisory locks and `FOR UPDATE` rows in old-loan/replacement-loan/funding order. Recompute versions, activate the existing draft, append replacement corrections, cancel old remaining schedules, set old loan `replaced` with zero collectible rollups/null next due date, persist lineage execution metadata, and append one command-scoped execution audit with public before/after state.

- [ ] **Step 6: Implement fail-closed downstream checks**

Reject borrower/owner mismatch, stale/expired previews, funding mismatch/capacity deficit, non-active/non-draft states, posted payments, effective posted disbursements, executed renewal/restructure/settlement, or prior executed replacement. Return public blocker IDs and `reviewRequired: true` without leaking internal IDs.

- [ ] **Step 7: Implement compensating reversal**

When no downstream records exist on the replacement, append compensating correction/allocation entries, cancel the replacement and schedules, restore old loan/schedules from the immutable snapshot, and mark the replacement aggregate reversed. Reject reversal after any posted payment/disbursement or dependent workflow.

- [ ] **Step 8: Add concurrency, rollback, and idempotency tests**

Cover identical replay, conflicting key payload, parallel execution, injected activation failure, stale versions, mismatches, downstream blockers, safe reversal, and blocked reversal. Assert no duplicate schedules, allocations, corrections, or audits and no partial state after failure.

- [ ] **Step 9: Run service regression gates**

Run:

```bash
cd backend
./scripts/test-disposable-postgres.sh src/services/loan-replacement-service.test.ts src/services/loan-application-service.test.ts src/services/loan-funding-service.test.ts src/services/loan-renewal-service.test.ts src/services/loan-restructure-service.test.ts src/services/loan-disbursement-service.test.ts
bun run typecheck
```

Expected: PASS with no skipped DB tests.

- [ ] **Step 10: Update changelog and commit Task 2**

```bash
git add CHANGELOG.md backend/src/services/loan-replacement-service.ts backend/src/services/loan-replacement-service.test.ts backend/src/services/loan-application-service.ts backend/src/services/loan-funding-service.ts backend/src/services/loan-disbursement-service.ts
git commit -m "feat: execute reversible loan replacements"
```

### Task 3: Add REST lifecycle routes and loan lineage projections

**Files:**
- Create: `backend/src/modules/loan-replacements.ts`
- Create: `backend/src/modules/loan-replacements.test.ts`
- Modify: `backend/src/modules/loans.ts`
- Modify: `backend/src/modules/loan-contract-routes.ts`
- Modify: `backend/src/modules/loan-route-schemas.ts`
- Modify: `backend/src/services/borrower-service.ts`
- Modify: `backend/src/services/dashboard-borrower-health-service.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces authenticated tenant-scoped endpoints:
  - `POST /loans/replacements/preview`
  - `POST /loans/replacements/:publicId/execute`
  - `POST /loans/replacements/:publicId/reverse`
- Produces `replacementLineage` and terminal `replaced` status in loan detail/list/portfolio projections.

- [ ] **Step 1: Write failing route and projection tests**

Assert closed schemas, owner/manager authorization, exact public payloads, correlation/audit IDs, route composition, old/new lineage, and exclusion of `replaced` loans from active list/health projections while retaining them in All/Done/history views.

- [ ] **Step 2: Run route tests and confirm RED**

Run: `cd backend && ./scripts/test-disposable-postgres.sh src/modules/loan-replacements.test.ts src/modules/loans-route-composition.test.ts src/modules/loan-list-projection.test.ts`

- [ ] **Step 3: Implement routes and presenters**

Delegate all writes to Task 2 services. Keep reason/confirmation/idempotency validation at the service boundary and map `DomainError` consistently with renewal/restructure routes.

- [ ] **Step 4: Add lineage and status-aware projections**

Return only public IDs and safe summary fields. Ensure `replaced` is terminal but not paid, and preserve current `restructured` lineage behavior independently.

- [ ] **Step 5: Run REST and projection gates**

Run:

```bash
cd backend
./scripts/test-disposable-postgres.sh src/modules/loan-replacements.test.ts src/modules/loan-contract-routes.test.ts src/modules/loan-list-projection.test.ts src/modules/loan-list-borrower-labels.test.ts src/modules/loans-route-composition.test.ts
bun run typecheck
```

- [ ] **Step 6: Update changelog and commit Task 3**

```bash
git add CHANGELOG.md backend/src/modules/loan-replacements.ts backend/src/modules/loan-replacements.test.ts backend/src/modules/loans.ts backend/src/modules/loan-contract-routes.ts backend/src/modules/loan-route-schemas.ts backend/src/services/borrower-service.ts backend/src/services/dashboard-borrower-health-service.ts
git commit -m "feat: expose loan replacement lifecycle"
```

### Task 4: Synchronize MCP tools and the private CreditSync plugin

**Files:**
- Modify: `backend/src/mcp/default.ts`
- Modify: `backend/src/mcp/server.ts`
- Modify: `backend/src/mcp/default.test.ts`
- Modify: `backend/src/mcp/server.test.ts`
- Modify: `backend/src/mcp/contract-snapshot.ts`
- Modify: `plugins/creditsync/manifest.json`
- Modify: `plugins/creditsync/references/mcp-tool-contract.json`
- Modify: `plugins/creditsync/references/financial-rules.md`
- Modify: `plugins/creditsync/skills/manage-loans/SKILL.md`
- Modify: `plugins/creditsync/skills/creditsync/SKILL.md`
- Modify: `plugins/creditsync/evals/evals.json`
- Modify: `plugins/creditsync/evals/harness.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces MCP tools `loan.replacement.preview`, `loan.replacement.execute`, and `loan.replacement.reverse` (public MCP names; user-facing aliases may render with underscores in clients).
- Preview has `readOnlyHint`; execute/reverse have `destructiveHint`; execute requires literal `confirmed: true`.

- [ ] **Step 1: Write RED MCP schema/annotation/adapter tests**

Assert closed Zod inputs, exact outputs, stable command idempotency, audit/correlation propagation, destructive annotations, and rejection without explicit confirmation or reason.

- [ ] **Step 2: Run MCP tests and confirm RED**

Run: `cd backend && bun test src/mcp/default.test.ts src/mcp/server.test.ts`

- [ ] **Step 3: Register adapters and schemas**

Map all arguments without internal IDs, add output schemas containing exact money strings and public lineage IDs, and route handlers exclusively through Task 2 services.

- [ ] **Step 4: Update frozen contract and plugin version**

Bump the private plugin minor version, regenerate/validate `mcp-tool-contract.json`, and update manifest tool counts and synchronized skill instructions. Add one positive inspect-preview-confirm-execute eval and negatives for missing confirmation, stale preview, posted downstream activity, and direct status mutation.

- [ ] **Step 5: Run MCP/plugin gates**

Run:

```bash
cd backend
bun test src/mcp/default.test.ts src/mcp/server.test.ts src/mcp/security.test.ts
bun run typecheck
cd ../plugins/creditsync
bun test
bun run validate
```

- [ ] **Step 6: Update changelog and commit Task 4**

```bash
git add CHANGELOG.md backend/src/mcp plugins/creditsync
git commit -m "feat: add MCP loan replacement tools"
```

### Task 5: Add localized frontend preview, confirmation, status, and lineage UI

**Files:**
- Create: `frontend/src/pages/dashboard/loans/LoanReplacementPanel.tsx`
- Create: `frontend/tests/loan-replacement-panel.vitest.tsx`
- Modify: `frontend/src/pages/dashboard/loans/LoanDetail.tsx`
- Modify: `frontend/src/pages/dashboard/loans/LoanInformationTab.tsx`
- Modify: `frontend/src/pages/dashboard/loans/LoanList.tsx`
- Modify: `frontend/src/pages/dashboard/loans/loan-list-model.ts`
- Modify: `frontend/src/locales/en.json`
- Modify: `frontend/src/locales/th.json`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes Task 3 preview/execute/reverse REST responses and `replacementLineage` projections.
- Produces an owner/manager-only replacement panel with exact before/after balances, warnings, dates, funding, reason, expiry, and explicit confirmation.

- [ ] **Step 1: Write failing component and model tests**

Assert the panel displays `36,000.00`, corrected `4,200.00`, cash `0.00`, start `11/07/2026`, first due `12/07/2026`, TTB funding, and disables Execute until the latest preview is explicitly confirmed. Assert `replaced` appears in Done/All, not Active, and is never rendered as Paid.

- [ ] **Step 2: Run frontend tests and confirm RED**

Run: `cd frontend && bun test tests/loan-replacement-panel.vitest.tsx tests/loan-list-model.vitest.ts`

- [ ] **Step 3: Implement the replacement panel**

Use backend-owned exact values, active i18n locale, query invalidation for both loan IDs and lists, visible stale/blocked errors, and a separate reversal confirmation requiring a reason.

- [ ] **Step 4: Add localized status and lineage**

Add English/Thai keys together. Show `Closed — Replaced` / `ปิดแล้ว — ถูกแทนที่` and links to the old/new loan without exposing internal IDs.

- [ ] **Step 5: Document the workflow and run frontend gates**

Run:

```bash
cd frontend
bun test
bun run lint
bun run build
```

Expected: PASS with no hardcoded mixed-language copy.

- [ ] **Step 6: Update README/changelog and commit Task 5**

```bash
git add CHANGELOG.md README.md frontend/src/pages/dashboard/loans/LoanReplacementPanel.tsx frontend/src/pages/dashboard/loans/LoanDetail.tsx frontend/src/pages/dashboard/loans/LoanInformationTab.tsx frontend/src/pages/dashboard/loans/LoanList.tsx frontend/src/pages/dashboard/loans/loan-list-model.ts frontend/src/locales/en.json frontend/src/locales/th.json frontend/tests/loan-replacement-panel.vitest.tsx
git commit -m "feat: add loan replacement confirmation UI"
```

### Task 6: Run full verification and independent review

**Files:**
- Modify: `CHANGELOG.md` only if verification fixes are required.

**Interfaces:**
- Consumes all prior deliverables.
- Produces a reviewed feature branch with no unexplained tracked changes and all required gates passing at HEAD.

- [ ] **Step 1: Run database-backed backend suites serially**

```bash
cd backend
./scripts/test-disposable-postgres.sh \
  src/db/atomic-loan-replacement-migration.test.ts \
  src/services/loan-replacement-service.test.ts \
  src/modules/loan-replacements.test.ts \
  src/services/loan-application-service.test.ts \
  src/services/loan-funding-service.test.ts \
  src/services/loan-renewal-service.test.ts \
  src/services/loan-restructure-service.test.ts \
  src/services/loan-disbursement-service.test.ts
bun test
bun run typecheck
```

- [ ] **Step 2: Run frontend and plugin gates**

```bash
cd frontend && bun test && bun run lint && bun run build
cd ../plugins/creditsync && bun test && bun run validate
```

- [ ] **Step 3: Inspect migration, diff, and commit discipline**

Run `git diff main...HEAD --check`, inspect every migration/catalog change, verify changelog entries match each commit, confirm README/plugin version/tool count, and confirm unrelated user-owned files were preserved.

- [ ] **Step 4: Request code and security review**

Review atomicity, lock ordering, tenant isolation, idempotency, snapshot restoration, money arithmetic, immutable ledger constraints, MCP destructive annotations, and production rollout boundaries. Fix validated findings with TDD and a changelog-bearing commit.

### Task 7: Deploy and execute the prepared production replacement safely

**Files:**
- No source changes unless a verified defect requires returning to an earlier task.

**Interfaces:**
- Consumes deployed MCP replacement tools and the prepared production IDs.
- Produces one executed replacement with independently verified state and no cash movement.

- [ ] **Step 1: Confirm exact deployment artifact and production preconditions**

Verify the reviewed commit SHA, clean backend/frontend build contexts, PostgreSQL backup/recovery readiness, old loan still `active`, replacement still `draft`, TTB drawdown still active, no posted payment/effective posted disbursement, and no conflicting downstream workflow. Do not log credentials or evidence.

- [ ] **Step 2: Deploy production-style backend and frontend**

```bash
docker compose --env-file .env.production -f docker-compose.app.yml up --build -d backend
docker compose --env-file .env.production -f docker-compose.app.yml up --build -d frontend
```

Verify migration success in backend logs, expected replacement tables/constraints through PostgreSQL, MCP health from inside the backend, and frontend health at `http://127.0.0.1:8088/`.

- [ ] **Step 3: Create a fresh replacement preview through MCP**

Use old loan `01a00ae2-8e33-7fab-82c8-b0e43882c307` and replacement draft `01a00c03-ca35-704d-b1cf-2abf26737d5b` with reason `Correct contract start date from 2026-07-12 to 2026-07-11; first installment remains 2026-07-12`. Verify exact correction `36,000.00` principal and `4,200.00` interest, cash `none/0.00`, TTB drawdown `01a00c03-82f4-765a-9deb-fcaca3327dfd`, and first due date `2026-07-12`.

- [ ] **Step 4: Obtain final exact-preview confirmation**

Present the preview public ID, hash, expiry, before/after balances, funding, schedule dates, warnings, and absence of cash movement. Do not execute without explicit confirmation of this fresh preview.

- [ ] **Step 5: Execute once with a unique idempotency key**

Call `loan.replacement.execute` with `confirmed: true`, the exact fresh versions/hash/reason, and a unique key. Replay the identical request once to verify idempotency; do not generate a second key for retry.

- [ ] **Step 6: Independently verify production state**

Confirm old loan `replaced` with zero collectible balances/null next due date, replacement active with 200 immutable schedules and first due `2026-07-12`, one exact `36,000.00` TTB allocation, correction and audit records, lineage in both details, old loan absent from Active but present in Done/All, and no payout/collection transaction created.

- [ ] **Step 7: Preserve reversal boundary**

Do not reverse unless explicitly requested. Record the downstream-free reversal precondition and stop if any payment/disbursement arrives after execution.

## Plan Self-Review

- Spec coverage: schema, status semantics, preview, atomic execution, funding, corrections, lineage, reversal, REST, MCP/plugin, frontend, full verification, deployment, and the prepared production execution all have explicit tasks.
- Placeholder scan: every step contains concrete files, commands, expected outcomes, and failure behavior.
- Type consistency: public service signatures, REST operations, MCP names, status values, and version/hash fields are consistent across tasks.
- Scope: the plan adds only scheduled-loan correction replacement; renewal, single-payment restructure, floating settlement, and ordinary loan closure semantics remain unchanged.
