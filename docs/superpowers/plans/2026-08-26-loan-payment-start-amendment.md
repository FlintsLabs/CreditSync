# Loan Payment-Start Amendment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace mutable first-payment-date editing with an append-only, preview-confirm-execute-reverse amendment workflow for fully unpaid active scheduled loans.

**Architecture:** Preserve `loan_schedules` as immutable contractual rows and record replacement due dates in immutable amendment revisions. A single effective-schedule projection overlays the current revision onto the original rows; REST views, MCP reads, payment allocation, overdue calculations, and schedule summaries use that projection. Execution is protected by a short-lived preview hash, loan/schedule locks, tenant-scoped idempotency, audit metadata, and compensating reversal.

**Tech Stack:** Bun, TypeScript, Elysia, Drizzle ORM, PostgreSQL triggers, Zod MCP schemas, React/Vite, i18next, Vitest/Bun test.

**Spec:** `docs/superpowers/specs/2026-08-26-loan-payment-start-amendment-design.md`

## Global Constraints

- Financial values remain exact two-decimal strings and use `FinancialDecimal`/`decimal.js`; no JavaScript `Number` arithmetic for money.
- All date validation and schedule generation use `YYYY-MM-DD` Asia/Bangkok business-date semantics; backend owns calculation.
- Activated loan terms and original `loan_schedules` contractual fields remain immutable at the database boundary.
- Release 1 permits `daily`, `weekly`, and `monthly` loans in `active` status only when every original schedule row is fully unpaid.
- Every write requires actor/source, request and correlation ID, non-blank reason, and stable idempotency key; execution/reversal append history only.
- MCP inputs/outputs use public UUIDs and two-decimal strings only; schemas remain closed and all write results include audit/correlation public IDs.
- Update English and Thai copy, root/plugin documentation, frozen MCP contract, plugin manifest/version, skills, evals, and validators in the same change.
- Before any commit, update `CHANGELOG.md`; update `README.md` for changed user workflows. Preserve unrelated dirty worktree changes.

---

### Task 1: Add immutable amendment and preview persistence

**Files:**
- Create: `backend/drizzle/0058_loan_payment_start_amendments.sql`
- Modify: `backend/drizzle/meta/_journal.json`
- Modify: `backend/src/db/schema.ts`
- Create: `backend/src/db/loan-payment-start-amendment-migration.test.ts`

**Interfaces:**
- Produces Drizzle tables `loanScheduleAmendments`, `loanScheduleAmendmentRows`, and `loanScheduleAmendmentPreviews`.
- Produces statuses `payment_start_date | reversal` and immutable preview fields consumed by Task 3.

- [ ] **Step 1: Write failing migration/schema tests**

```ts
test("registers immutable payment-start amendment tables after schedule deferrals", () => {
  expect(journal.entries.at(-1)?.tag).toBe("0058_loan_payment_start_amendments");
  expect(migration).toContain('CREATE TABLE "loan_schedule_amendments"');
  expect(migration).toContain('CREATE TABLE "loan_schedule_amendment_rows"');
  expect(migration).toContain('CREATE TABLE "loan_schedule_amendment_previews"');
  expect(migration).toContain('loan_schedule_amendments_append_only');
  expect(migration).toContain('loan_schedule_amendment_rows_append_only');
});
```

- [ ] **Step 2: Run the migration test and verify it fails**

Run: `cd backend && bun test src/db/loan-payment-start-amendment-migration.test.ts`  
Expected: FAIL because migration/schema are absent.

- [ ] **Step 3: Implement the additive migration and Drizzle schema**

Create all three tenant-scoped tables, public UUIDs, composite tenant foreign keys, unique `(tenant_id, loan_id, revision_no)`, unique `(tenant_id, amendment_id, source_schedule_id)`, tenant idempotency uniqueness for execute/reverse, reason checks, and append-only triggers. Keep preview rows separately mutable only for consumption/expiry bookkeeping. Store row amount copies and add a trigger that rejects a row when copied amounts differ from its source schedule. Do not alter `loan_schedules` or weaken `loan_schedules_activated_contract_immutable`.

```ts
export const loanScheduleAmendments = pgTable("loan_schedule_amendments", {
  publicId: uuid("public_id").default(sql`uuidv7()`).notNull().unique(),
  tenantId,
  loanId: integer("loan_id").notNull(),
  revisionNo: integer("revision_no").notNull(),
  kind: text("kind").$type<"payment_start_date" | "reversal">().notNull(),
  paymentStartDate: date("payment_start_date").notNull(),
  sourceAmendmentId: integer("source_amendment_id"),
  reason: text("reason").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  requestId: text("request_id").notNull(),
  correlationId: text("correlation_id").notNull(),
  actorSource: text("actor_source").notNull(),
  createdByUserId: integer("created_by_user_id").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
```

- [ ] **Step 4: Run migration/schema tests and disposable migration**

Run: `cd backend && bun test src/db/loan-payment-start-amendment-migration.test.ts && ./scripts/test-disposable-postgres.sh src/db/loan-payment-start-amendment-migration.test.ts`  
Expected: PASS; a second attempt to update/delete amendment rows is rejected by PostgreSQL.

- [ ] **Step 5: Commit the persistence boundary**

Update `CHANGELOG.md`, then commit only the migration, schema, metadata, and migration test.

### Task 2: Build the effective-schedule projection

**Files:**
- Create: `backend/src/services/loan-effective-schedule-service.ts`
- Create: `backend/src/services/loan-effective-schedule-service.test.ts`
- Modify: `backend/src/modules/loan-contract-routes.ts`
- Modify: `backend/src/services/loan-application-service.ts`
- Modify: `backend/src/services/payment-service.ts`
- Modify: `backend/src/services/loan-schedule-deferral-service.ts`
- Modify: `backend/src/lib/loan-rollup.ts`

**Interfaces:**
- Produces `resolveEffectiveLoanSchedule(executor, { tenantId, loanId }): Promise<EffectiveLoanScheduleRow[]>`.
- `EffectiveLoanScheduleRow` preserves original schedule `publicId`, amount/payment/status fields and adds `contractualDueDate`, `dueDate`, `amendmentPublicId | null`, and `amendmentRevisionNo | null`.
- Consumes immutable amendment rows from Task 1.

- [ ] **Step 1: Write failing projection tests**

```ts
test("overlays only due dates from the latest effective amendment", async () => {
  const rows = await resolveEffectiveLoanSchedule(db, { tenantId, loanId });
  expect(rows.map(({ contractualDueDate, dueDate }) => [contractualDueDate, dueDate]))
    .toEqual([["2026-08-23", "2026-08-22"], ["2026-08-24", "2026-08-23"]]);
  expect(rows[0]).toMatchObject({ scheduledTotal: "300.00", paidTotal: "0.00", amendmentRevisionNo: 1 });
});

test("uses original dates when no amendment exists and predecessor dates after a reversal", async () => {
  // Assert original dates first; create amendment then compensating reversal and assert original dates again.
});
```

- [ ] **Step 2: Run the projection tests and verify they fail**

Run: `cd backend && ./scripts/test-disposable-postgres.sh src/services/loan-effective-schedule-service.test.ts`  
Expected: FAIL because the projection service does not exist.

- [ ] **Step 3: Implement one authoritative projection**

Resolve the active revision from append-only amendment lineage, overlay only the amendment row due dates, and retain original schedule IDs/amounts/payment state. Use the projection in contract schedule responses, REST schedule response, `summarizeLoanSchedule`, overdue computation, payment-match eligibility, and next-due-date calculations. Do not duplicate schedule date selection in route code.

```ts
export async function resolveEffectiveLoanSchedule(
  executor: DbExecutor,
  input: { tenantId: string; loanId: number },
): Promise<EffectiveLoanScheduleRow[]> {
  const originalRows = await loadOriginalRows(executor, input);
  const revision = await resolveEffectiveRevision(executor, input);
  if (!revision) return originalRows.map((row) => presentEffectiveRow(row, row.dueDate, null));
  const replacementDates = await loadRevisionDates(executor, input.tenantId, revision.id);
  return originalRows.map((row) => presentEffectiveRow(row, replacementDates.get(row.id) ?? row.dueDate, revision));
}
```

- [ ] **Step 4: Run projection, route, and payment-health tests**

Run: `cd backend && ./scripts/test-disposable-postgres.sh src/services/loan-effective-schedule-service.test.ts src/modules/loan-contract-routes.test.ts src/services/payment-service.test.ts`  
Expected: PASS; all consumers report the same effective due dates.

- [ ] **Step 5: Commit the read model**

Update `CHANGELOG.md`, then commit projection code and its consumer/test changes.

### Task 3: Implement preview, execute, and compensating reversal service

**Files:**
- Create: `backend/src/services/loan-payment-start-amendment-service.ts`
- Create: `backend/src/services/loan-payment-start-amendment-service.test.ts`
- Modify: `backend/src/services/loan-application-service.ts`
- Modify: `backend/src/services/domain-error.ts` only if a typed shared helper is needed

**Interfaces:**
- Produces `previewLoanPaymentStartAmendment(ctx, { loanPublicId, paymentStartDate, reason })`.
- Produces `executeLoanPaymentStartAmendment(ctx, { amendmentPreviewPublicId, previewHash, expectedScheduleVersion, confirmed: true, reason })`.
- Produces `reverseLoanPaymentStartAmendment(ctx, { amendmentPublicId, confirmed: true, reason })`.
- Replaces `updateLoanPaymentStartDate`; no command may issue `UPDATE loan_schedules SET due_date`.

- [ ] **Step 1: Write failing service tests for the approved rules**

```ts
test("previews and executes an unpaid daily amendment without mutating original schedules", async () => {
  const preview = await previewLoanPaymentStartAmendment(ctx, { loanPublicId, paymentStartDate: "2026-08-22", reason: "Correct first collection date" });
  expect(preview).toMatchObject({ previousFirstDueDate: "2026-08-23", firstDueDate: "2026-08-22", affectedInstallmentCount: 100 });
  const executed = await executeLoanPaymentStartAmendment(withKey(ctx, "amend-1"), { amendmentPreviewPublicId: preview.publicId, previewHash: preview.previewHash, expectedScheduleVersion: preview.scheduleVersion, confirmed: true, reason: "Correct first collection date" });
  expect(executed.effectiveFirstDueDate).toBe("2026-08-22");
  expect(await originalScheduleDueDates(loanId)).toEqual(originalDueDates);
});

test.each(["partial", "posted"]) ("rejects amendment after %s payment activity", async (state) => {
  await arrangePaymentActivity(state);
  await expect(previewLoanPaymentStartAmendment(ctx, request)).rejects.toMatchObject({ code: "PAYMENT_START_AMENDMENT_PAYMENT_ACTIVITY_EXISTS" });
});
```

- [ ] **Step 2: Run service tests and verify they fail**

Run: `cd backend && ./scripts/test-disposable-postgres.sh src/services/loan-payment-start-amendment-service.test.ts`  
Expected: FAIL because preview/execute/reverse service functions do not exist.

- [ ] **Step 3: Implement validation and deterministic preview**

Lock/read the accessible loan, enforce active scheduled type and zero payment activity across original rows, normalize the Bangkok date, generate candidate rows using `generateLoanSchedule`, and compare every count and money component using `FinancialDecimal`. Persist an expiring preview with the exact schedule version/hash and return only public, safe fields.

- [ ] **Step 4: Implement execution and idempotency**

In a single transaction lock the loan and source schedule rows with `FOR UPDATE`, reload/revalidate the preview, reject expiry/staleness, write amendment ledger plus one date row per source schedule, create the audit record, consume preview, and invalidate cache after commit. Return audit/correlation identifiers. Replay the same tenant/key/request exactly; reject a reused key with different intent.

- [ ] **Step 5: Implement compensating reversal**

Reject a reversed/non-latest amendment or any payment activity. Create a new `kind: "reversal"` revision whose date rows equal the predecessor effective revision; retain the target amendment unchanged and link reversal lineage. Assert the projection returns the predecessor schedule after the new revision.

- [ ] **Step 6: Add failure mapping and regression coverage**

Remove the old direct schedule-update loop. Convert database immutable-trigger failures to stable 409 domain errors, never `INTERNAL_ERROR`. Cover date-before-start, inactive/floating/single-payment loans, stale/expired preview, concurrent execute, idempotency replay/conflict, tenant/owner isolation, amounts/count mismatch, reversal, and original-row trigger rejection.

- [ ] **Step 7: Run the focused backend suite and typecheck**

Run: `cd backend && ./scripts/test-disposable-postgres.sh src/services/loan-payment-start-amendment-service.test.ts src/services/loan-effective-schedule-service.test.ts src/services/loan-application-service.test.ts && bun run typecheck`  
Expected: PASS.

- [ ] **Step 8: Commit the command service**

Update `CHANGELOG.md`, then commit the service, removed broken updater, tests, and safe error mapping.

### Task 4: Replace REST and MCP contract atomically

**Files:**
- Modify: `backend/src/modules/loan-contract-routes.ts`
- Modify: `backend/src/modules/loans-route-composition.test.ts`
- Modify: `backend/src/mcp/default.ts`
- Modify: `backend/src/mcp/server.ts`
- Modify: `backend/src/mcp/default.test.ts`
- Modify: `backend/src/mcp/server.test.ts`
- Modify: `README.md`

**Interfaces:**
- REST: `POST /loans/:id/payment-start-date/preview`, `POST /loans/:id/payment-start-date/execute`, `POST /loans/:id/payment-start-date/:amendmentId/reverse`.
- MCP: `loan.payment-start-date.preview`, `loan.payment-start-date.execute`, `loan.payment-start-date.reverse`.
- Retires `loan.payment-start-date.update` from `MCP_TOOL_NAMES`, handlers, schemas, annotations, audit target, and README.

- [ ] **Step 1: Write failing route and MCP contract tests**

```ts
expect(routeComposition).toContain("POST /loans/:id/payment-start-date/preview");
expect(advertisedMcpToolMetadata().find((tool) => tool.name === "loan.payment-start-date.execute")?.annotations)
  .toMatchObject({ destructiveHint: true, idempotentHint: true, readOnlyHint: false });
expect(MCP_TOOL_NAMES).not.toContain("loan.payment-start-date.update");
```

- [ ] **Step 2: Run contract tests and verify they fail**

Run: `cd backend && bun test src/modules/loans-route-composition.test.ts src/mcp/server.test.ts src/mcp/default.test.ts`  
Expected: FAIL because the new routes/tools are absent and the old update tool remains.

- [ ] **Step 3: Implement closed REST and MCP handlers**

Pass route command context headers through all writes. Define strict Zod schemas with UUIDs, date strings, version hashes, literal `confirmed: true`, reasons, and idempotency keys. Mark preview read-only only if preview rows are not persisted; otherwise mark it destructive/idempotent and make the tool description explicit. Execute/reverse are destructive financial tools and must resolve audit metadata via the amendment entity/action, not the original loan action.

- [ ] **Step 4: Verify safe outputs and errors**

Assert response data contains public amendment/preview IDs, effective dates, exact decimal strings, audit/correlation IDs, and no internal IDs/stack/SQL. Assert invalid database mutation surfaces a stable domain code.

- [ ] **Step 5: Run backend protocol suite**

Run: `cd backend && ./scripts/test-disposable-postgres.sh src/mcp/default.test.ts src/mcp/server.test.ts src/modules/loans-route-composition.test.ts && bun run typecheck`  
Expected: PASS.

- [ ] **Step 6: Commit the API/MCP contract**

Update `CHANGELOG.md` and `README.md`, then commit all REST/MCP changes and tests together.

### Task 5: Add the dashboard amendment workflow and effective-schedule history

**Files:**
- Modify: `frontend/src/pages/dashboard/loans/LoanRepaymentScheduleTab.tsx`
- Create: `frontend/src/pages/dashboard/loans/loan-payment-start-amendment-model.ts`
- Create: `frontend/src/pages/dashboard/loans/loan-payment-start-amendment-model.test.ts`
- Modify: `frontend/tests/loan-detail-schedule.vitest.tsx`
- Modify: `frontend/src/locales/en.json`
- Modify: `frontend/src/locales/th.json`

**Interfaces:**
- `canAmendPaymentStartDate(loan, rows): boolean` returns true only for active scheduled zero-paid schedules.
- `buildPaymentStartAmendmentPreviewRequest(loanPublicId, paymentStartDate, reason)` returns the REST preview body.

- [ ] **Step 1: Write failing UI/model tests**

```ts
expect(canAmendPaymentStartDate(activeDailyLoan, unpaidRows)).toBe(true);
expect(canAmendPaymentStartDate(activeDailyLoan, [{ ...unpaidRows[0], paidTotal: "0.01" }])).toBe(false);
await user.click(screen.getByRole("button", { name: /change first payment date/i }));
expect(api.post).toHaveBeenCalledWith(`/loans/${loanId}/payment-start-date/preview`, { paymentStartDate: "2026-08-22", reason: "Customer agreement" });
```

- [ ] **Step 2: Run frontend tests and verify they fail**

Run: `cd frontend && bun test tests/loan-detail-schedule.vitest.tsx src/pages/dashboard/loans/loan-payment-start-amendment-model.test.ts`  
Expected: FAIL because the amendment dialog/model is absent.

- [ ] **Step 3: Implement the two-stage dialog**

Add a schedule-level action that is hidden when eligibility fails. Collect a reason and date constrained to the immutable contract start date, call preview, show server-returned original/proposed first and final dates plus invariant totals/count, require a confirmation checkbox, execute with a generated idempotency key, then reload loan/schedule/summary. Present server errors without translating backend financial arithmetic.

- [ ] **Step 4: Render amendment provenance**

Show an “Amended” badge and tooltip/detail for rows with an effective amendment: contractual date, effective date, revision number, and reversal state. Maintain the existing deferral control and ensure a deferred schedule cannot be amended by the release-1 eligibility gate.

- [ ] **Step 5: Add exact bilingual copy**

Add matching `loanDetail.paymentStartAmendment.*` keys in `en.json` and `th.json` for action, eligibility explanation, preview impact, confirmation, execute/reverse, error, and provenance strings. Use active i18n locale for dates and exact decimal formatter for money.

- [ ] **Step 6: Run frontend checks**

Run: `cd frontend && bun test && bun run lint && bun run build`  
Expected: PASS.

- [ ] **Step 7: Commit the dashboard workflow**

Update `CHANGELOG.md` and `README.md` if user instructions changed, then commit UI/model/tests/locales together.

### Task 6: Synchronize the private plugin and operational documentation

**Files:**
- Modify: `plugins/creditsync/.codex-plugin/plugin.json`
- Modify: `plugins/creditsync/README.md`
- Modify: `plugins/creditsync/CHANGELOG.md`
- Modify: `plugins/creditsync/skills/manage-loans/SKILL.md`
- Modify: `plugins/creditsync/references/mcp-tool-contract.json`
- Modify: `plugins/creditsync/evals/evals.json`
- Modify: `plugins/creditsync/evals/harness.ts`
- Modify: `plugins/creditsync/tests/plugin-contract.test.ts`
- Modify: `plugins/creditsync/tests/operations-docs.test.ts`

**Interfaces:**
- Frozen plugin metadata exposes exactly the new preview/execute/reverse tools and no `loan.payment-start-date.update` tool.
- Agent workflow is inspect → preview → show exact impact → human confirmation → execute → re-inspect; reversal re-inspects, requires separate reason/confirmation, and stops on payment activity.

- [ ] **Step 1: Write failing plugin contract/eval assertions**

```ts
expect(contract.tools.map((tool) => tool.name)).toContain("loan.payment-start-date.preview");
expect(contract.tools.map((tool) => tool.name)).not.toContain("loan.payment-start-date.update");
expect(evals.some((scenario) => scenario.name.includes("payment-start amendment stale preview"))).toBe(true);
```

- [ ] **Step 2: Run plugin tests and verify they fail**

Run: `cd plugins/creditsync && bun test && bun run validate`  
Expected: FAIL because frozen metadata and evals still name the direct update tool.

- [ ] **Step 3: Update plugin version and frozen contract**

Bump plugin version consistently in manifest, README, and plugin changelog. Regenerate or deliberately update the exact tool contract snapshot from backend metadata. Add evals for successful preview/execute, stale preview, payment-activity stop, idempotent replay, and compensating reversal; retain no secret values.

- [ ] **Step 4: Update the manage-loans skill**

Replace the direct-update paragraph with the exact preview/confirmation/execute/re-inspect flow. Require agents to display original and proposed date bounds, count and money invariants from backend, and stop for stale, ambiguous, paid, partial, or mismatch states. Require a separate reversal confirmation/reason.

- [ ] **Step 5: Run full plugin validation**

Run: `cd plugins/creditsync && bun test && bun run validate && python3 /home/flintstone/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py .`  
Expected: PASS with tool, version, skill, eval, and validator contracts synchronized.

- [ ] **Step 6: Commit plugin synchronization**

Update root/plugin changelogs first, then commit plugin/documentation/tests together.

### Task 7: Full verification and controlled deployment handoff

**Files:**
- Modify: `CHANGELOG.md` only if final verification exposes an omitted release note.

**Interfaces:**
- Produces a verified feature branch; no production data mutation is part of implementation verification.

- [ ] **Step 1: Check worktree ownership before final verification**

Run: `git status --short`  
Expected: only task-owned staged/committed changes plus explicitly preserved unrelated files reported at handoff.

- [ ] **Step 2: Run backend database and type checks**

Run: `cd backend && ./scripts/test-disposable-postgres.sh && bun run typecheck`  
Expected: PASS; no test is skipped for amendment database invariants.

- [ ] **Step 3: Run frontend and plugin gates**

Run: `cd frontend && bun test && bun run lint && bun run build && cd ../plugins/creditsync && bun test && bun run validate`  
Expected: PASS.

- [ ] **Step 4: Inspect the final diff and MCP metadata**

Run: `git diff main...HEAD --check && cd backend && bun test src/mcp/server.test.ts`  
Expected: no whitespace errors; only preview/execute/reverse tools are advertised.

- [ ] **Step 5: Prepare deployment verification instructions without deploying**

Record this ordered rollout: apply migration through normal backend startup; verify amendment tables/triggers in the production Postgres container; deploy backend; call `http://127.0.0.1:3000/mcp/health` inside backend; deploy frontend; verify `http://127.0.0.1:8088/`; use an explicitly authorized controlled tenant to preview/execute/reverse one fully unpaid loan; inspect effective schedule and public audit IDs; review backend logs for domain errors only. Do not create test financial records in a live tenant.

- [ ] **Step 6: Commit any final verification-only correction**

If verification required a correction, update `CHANGELOG.md` before staging it with the correction; otherwise do not create an empty commit.
