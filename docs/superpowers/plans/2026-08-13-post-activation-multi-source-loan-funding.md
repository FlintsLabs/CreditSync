# Post-activation Multi-source Loan Funding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Web and MCP users append, preview, confirm, and compensate exact multi-source funding allocations after activation without mutating loan terms or posted financial records.

**Architecture:** Keep `loan_funding_allocations` as the canonical append-only ledger and move all rules into a shared tenant-scoped application service. Persist expiring previews and idempotent results, expose them through REST and three closed-schema MCP tools, then add localized Loan Detail controls while Fund Detail aggregates net ledger rows.

**Tech Stack:** Bun, TypeScript, Elysia, Drizzle ORM, PostgreSQL, `decimal.js`, Zod/MCP SDK, React 19, Vitest, Testing Library, i18next.

## Global Constraints

- Public money is always a two-decimal string; use `decimal.js`, never `Number`, for financial arithmetic, comparison, or formatting.
- Use `Asia/Bangkok`, ISO 8601 timestamps, and `YYYY-MM-DD` allocation dates.
- Loan terms and posted records remain immutable; corrections are append-only compensating rows with reasons.
- Every write has actor/source, request/correlation ID, idempotency key, and audit history.
- MCP uses public UUIDs, closed schemas, safe fields, and inspect → preview → confirm → execute.
- Update `frontend/src/locales/en.json` and `th.json` together.
- Synchronize MCP contract, plugin version/manifest, skills, evals, and validator.
- Run DB suites serially with `backend/scripts/test-disposable-postgres.sh`.
- Before each commit update `CHANGELOG.md` under `v0.3.11 - 2026-08-13` and stage it with the change.
- Preserve unrelated dirty Payment Inbox files and locale hunks; never discard or stage them.

## File Map

- `backend/src/db/schema.ts`, `backend/drizzle/0027_post_activation_multi_source_funding.sql`: immutable ledger, previews, reversal and idempotency constraints.
- `backend/src/services/loan-funding-service.ts`: inspect, preview, execute, locking, exact validation, audit, replay.
- `backend/src/modules/loan-funding-routes.ts`: thin REST adapters.
- `backend/src/mcp/{default,server,contract-snapshot}.ts`: three strict MCP tools.
- `frontend/src/pages/dashboard/loans/LoanFundingPanel.tsx`: funding state and confirmed management UI.
- `plugins/creditsync/**`: plugin 2.5.0 contract, skill, docs, evals, validation.
- `backend/scripts/allocate-loan-funding.ts`: guarded preview-first historical command.

---

### Task 1: Append-only Schema and Migration

**Files:**
- Modify: `backend/src/db/schema.ts`
- Create: `backend/drizzle/0027_post_activation_multi_source_funding.sql`
- Modify: `backend/drizzle/meta/_journal.json`
- Create: `backend/src/db/loan-funding-append-only-migration.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:** Produces `loanFundingPreviews`; allocation reversal, command-context, and idempotency columns; database rejection of allocation `UPDATE`/`DELETE`.

- [ ] **Step 1: Write the failing migration test**

```ts
test("makes allocations immutable and previews replay-safe", async () => {
  const sql = await Bun.file(`${backendRoot}drizzle/0027_post_activation_multi_source_funding.sql`).text();
  expect(sql).toContain('CREATE TABLE "loan_funding_previews"');
  expect(sql).toContain('loan_funding_allocations_reversed_allocation_unique');
  expect(sql).toContain('loan_funding_previews_execution_idempotency_unique');
  expect(sql).toContain('BEFORE UPDATE OR DELETE ON "loan_funding_allocations"');
  expect(getTableColumns(loanFundingPreviews)).toHaveProperty("stateVersion");
});
```

- [ ] **Step 2: Verify RED** — Run `cd backend && bun test src/db/loan-funding-append-only-migration.test.ts`; expect missing migration/table.
- [ ] **Step 3: Add schema and migration** — Store preview request/hash, state version, proposed entries, expiry, execution idempotency/hash/result; add tenant indexes and a trigger raising `loan_funding_allocations records are immutable`. Do not backfill guessed sources.
- [ ] **Step 4: Verify GREEN** — Run `cd backend && bun test src/db/loan-funding-append-only-migration.test.ts src/db/loan-renewal-hardening-migration.test.ts && bun run typecheck`.
- [ ] **Step 5: Commit**

```bash
git add backend/src/db/schema.ts backend/drizzle/0027_post_activation_multi_source_funding.sql backend/drizzle/meta/_journal.json backend/src/db/loan-funding-append-only-migration.test.ts CHANGELOG.md
git commit -m "feat: make loan funding allocations append only"
```

### Task 2: Exact Funding State Kernel

**Files:**
- Create: `backend/src/services/loan-funding-service.ts`
- Create: `backend/src/services/loan-funding-service.test.ts`
- Modify: `backend/src/modules/loan-funding-presenters.ts`
- Modify: `CHANGELOG.md`

**Interfaces:** Produces `listLoanFunding(ctx, loanPublicId, asOf?)` and `LoanFundingState = { loanPublicId, principalAmount, netAllocatedPrincipal, remainingGap, overfundedAmount, state, sourceNets, allocations, stateVersion }`.

- [ ] **Step 1: Write failing state and eligibility tests**

```ts
await seedAllocation(ttb, "6000.00"); await seedAllocation(own, "2500.00");
expect(await listLoanFunding(ctx, loan.publicId)).toMatchObject({
  principalAmount: "10000.00", netAllocatedPrincipal: "8500.00",
  remainingGap: "1500.00", state: "partially_funded",
});
expect(["draft", "active", "paid", "defaulted"].every(canAllocateFunding)).toBe(true);
expect(["canceled", "renewed"].some(canAllocateFunding)).toBe(false);
```

- [ ] **Step 2: Verify RED** — Run `cd backend && ./scripts/test-disposable-postgres.sh src/services/loan-funding-service.test.ts`; expect missing exports.
- [ ] **Step 3: Implement exact state** — Resolve public IDs tenant-safely, aggregate signed rows with `Decimal`, serialize exact strings, sort sources stably, and hash canonical ledger rows for `stateVersion`.
- [ ] **Step 4: Add failing invariant tests** — Reject additions above remaining principal, reductions below a source net, inactive/cross-tenant profiles, insufficient drawdown, and locked loan with exact domain codes.
- [ ] **Step 5: Implement validation and verify GREEN** — Run the disposable service test plus `bun run typecheck`; include values beyond JS safe integer range.
- [ ] **Step 6: Commit** — Stage the service, tests, presenter, and changelog; commit `feat: add exact loan funding state service`.

### Task 3: Preview and Atomic Execute

**Files:**
- Modify: `backend/src/services/loan-funding-service.ts`
- Modify: `backend/src/services/loan-funding-service.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:** Produces `previewLoanFundingChange(ctx, loanPublicId, { entries })` and `executeLoanFundingChange(ctx, { previewPublicId, previewHash, reason })`; entries contain profile UUID, optional drawdown UUID, signed amount, date, optional reversed allocation UUID.

- [ ] **Step 1: Write failing preview test**

```ts
const preview = await previewLoanFundingChange(ctx, loan.publicId, { entries: [
  { bankProfilePublicId: ttb.publicId, amount: "6000.00", allocationDate: "2026-07-31" },
  { bankProfilePublicId: own.publicId, amount: "4000.00", allocationDate: "2026-07-31" },
] });
expect(preview.before.state).toBe("unfunded");
expect(preview.after).toMatchObject({ state: "fully_funded", remainingGap: "0.00" });
expect(await allocationsFor(loan.id)).toHaveLength(0);
```

- [ ] **Step 2: Verify RED** — Run disposable service test; expect preview function missing.
- [ ] **Step 3: Implement preview** — Canonicalize entries, persist `v1:<sha256>`, current state version and proposed entries, expire in 15 minutes, and never insert allocations.
- [ ] **Step 4: Write failing execute tests** — Prove one atomic two-source insert, one audit record, same-key/same-payload replay, changed-payload conflict, stale/expired preview rejection, concurrent ceiling enforcement, and atomic `-2000/+2000` correction.

```ts
const result = await executeLoanFundingChange({ ...ctx, idempotencyKey: "funding-1" }, executeInput);
expect(result.data.after.state).toBe("fully_funded");
expect(result.auditPublicIds).toHaveLength(1);
expect((await allocationsFor(loan.id)).map(x => x.allocatedAmount)).toEqual(["6000.00", "4000.00"]);
```

- [ ] **Step 5: Implement execute** — Lock loan then profiles/drawdowns in ID order, recompute state/capacity, validate hash/version/expiry, insert all rows and audit atomically, persist safe replay result.
- [ ] **Step 6: Verify GREEN** — Run disposable service suite and backend typecheck; no skipped DB invariants.
- [ ] **Step 7: Commit** — Commit service/tests/changelog as `feat: preview and execute funding allocations`.

### Task 4: REST Workflow

**Files:**
- Modify: `backend/src/modules/loan-funding-routes.ts`
- Create: `backend/src/modules/loan-funding-routes.test.ts`
- Modify: `backend/src/modules/loan-route-schemas.ts`
- Modify: `CHANGELOG.md`

**Interfaces:** `GET /loans/:id/funding-allocations`; `POST /loans/:id/funding-preview`; `POST /loans/:id/funding-execute` with `Idempotency-Key`.

- [ ] **Step 1: Write failing HTTP contract tests**

```ts
const preview = await json(app.handle(authPost(`/loans/${LOAN_ID}/funding-preview`, input)));
expect(preview.after.state).toBe("fully_funded");
const result = await json(app.handle(authPost(`/loans/${LOAN_ID}/funding-execute`, {
  previewPublicId: preview.publicId, previewHash: preview.previewHash, reason: "Confirmed",
}, { "Idempotency-Key": "rest-funding-1" })));
expect(result.data.after.remainingGap).toBe("0.00");
```

- [ ] **Step 2: Verify RED** — Run `cd backend && ./scripts/test-disposable-postgres.sh src/modules/loan-funding-routes.test.ts`.
- [ ] **Step 3: Make routes thin service adapters** — Build `CommandContext`, require tenant-wide write access, preserve scoped reads, map domain errors, invalidate cache only after execute.
- [ ] **Step 4: Verify permissions/contracts** — Test closed body shapes, missing idempotency header, viewer denial, tenant isolation, stale and conflict errors; run route and bank-profile suites plus typecheck.
- [ ] **Step 5: Commit** — Commit routes/tests/schemas/changelog as `feat: expose confirmed loan funding workflow`.

### Task 5: MCP Tools and Plugin 2.5.0

**Files:**
- Modify: `backend/src/mcp/default.ts`, `default.test.ts`, `server.ts`, `server.test.ts`, `contract-snapshot.ts`
- Modify: `plugins/creditsync/.codex-plugin/plugin.json`, `.app.json`, `README.md`, `CHANGELOG.md`
- Modify: `plugins/creditsync/references/{mcp-tool-contract.json,financial-rules.md,error-recovery.md}`
- Modify: `plugins/creditsync/skills/creditsync/SKILL.md`, `skills/manage-loans/SKILL.md`
- Create: `plugins/creditsync/skills/manage-loan-funding/SKILL.md`
- Modify: `plugins/creditsync/evals/{evals.json,skill-tests.md}` and `plugins/creditsync/tests/*.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:** Adds strict `loan.funding.list`, `loan.funding.preview`, `loan.funding.execute`; plugin becomes version `2.5.0` with eight skills.

- [ ] **Step 1: Write failing MCP tests**

```ts
expect(tool("loan.funding.list").annotations).toMatchObject({ readOnlyHint: true });
expect(tool("loan.funding.execute").annotations).toMatchObject({ destructiveHint: true });
expect(() => schemas["loan.funding.preview"].parse({ loanPublicId: LOAN_ID, entries, extra: true })).toThrow();
```

- [ ] **Step 2: Verify RED** — Run backend MCP server/default tests; expect absent names.
- [ ] **Step 3: Add schemas and handlers** — Expose only public UUIDs/two-decimal strings, return structured content/readable summaries, and register annotations, rate limiting, security and frozen snapshot.
- [ ] **Step 4: Verify backend MCP** — Run disposable `default.test.ts`, then server/security tests and typecheck.
- [ ] **Step 5: Write failing plugin tests** — Expect version 2.5.0, three tools, eight skills, and the exact phrase `inspect → preview → explicit confirmation → execute` in the new skill.
- [ ] **Step 6: Synchronize plugin** — Document stop gates for stale preview, overflow, negative source net, inactive source, locked loan and conflicts. Add an eval where a posted TTB disbursement exists but only allocation may be created.
- [ ] **Step 7: Validate** — Run `cd plugins/creditsync && bun run scripts/mcp-contract.ts --check && bun run scripts/validate.ts && bun test`.
- [ ] **Step 8: Commit** — Commit backend MCP, entire synchronized plugin, and changelog as `feat: add MCP loan funding workflow`.

### Task 6: Localized Loan Funding UI

**Files:**
- Create: `frontend/src/pages/dashboard/loans/LoanFundingPanel.tsx`
- Modify: `frontend/src/pages/dashboard/loans/LoanDetail.tsx`
- Modify carefully: `frontend/src/locales/en.json`, `frontend/src/locales/th.json`
- Create: `frontend/tests/loan-funding-panel.vitest.tsx`
- Modify: `frontend/tests/fund-detail.vitest.tsx`
- Modify: `CHANGELOG.md`

**Interfaces:** `LoanFundingPanel({ loanPublicId, principalAmount, loanStatus, canManage })`; consumes REST state, active funding sources, preview and execute.

- [ ] **Step 1: Write failing add/preview/confirm test**

```tsx
expect(await screen.findByText("ยังไม่ได้จัดสรรแหล่งเงินทุน")).toBeInTheDocument();
await user.click(screen.getByRole("button", { name: "เพิ่มแหล่งเงินทุน" }));
await user.selectOptions(screen.getByLabelText("แหล่งเงินทุน"), TTB_ID);
await user.type(screen.getByLabelText("จำนวนเงิน"), "10000.00");
await user.click(screen.getByRole("button", { name: "ดูตัวอย่าง" }));
expect(api.post).toHaveBeenCalledWith(`/loans/${LOAN_ID}/funding-preview`, expect.any(Object));
expect(await screen.findByText("จัดสรรครบแล้ว")).toBeInTheDocument();
```

- [ ] **Step 2: Verify RED** — Run `cd frontend && bun test tests/loan-funding-panel.vitest.tsx`.
- [ ] **Step 3: Implement panel** — Use exact money helpers, multiple entry rows, exact before/after split/gap, reason on adjustments, generated execute idempotency key, and locked/permission states.
- [ ] **Step 4: Add compensation/Fund Detail tests** — Preview atomic `-2000.00` TTB and `+2000.00` own capital; show original history; Fund Detail collapses ledger rows into one net loan row.
- [ ] **Step 5: Add Thai/English keys without overwriting dirty locale hunks** — Patch only `loanFunding` objects; use interactive staging for locales.
- [ ] **Step 6: Verify frontend** — Run focused panel, fund-detail and activation tests, then `bun run lint && bun run build`.
- [ ] **Step 7: Commit only funding hunks**

```bash
git add frontend/src/pages/dashboard/loans/LoanFundingPanel.tsx frontend/src/pages/dashboard/loans/LoanDetail.tsx frontend/tests/loan-funding-panel.vitest.tsx frontend/tests/fund-detail.vitest.tsx CHANGELOG.md
git add -p frontend/src/locales/en.json frontend/src/locales/th.json
git diff --cached -- frontend/src/pages/dashboard/payments frontend/tests/payment-inbox.vitest.tsx
git commit -m "feat: manage loan funding after activation"
```

### Task 7: Guarded Historical Allocation and Complete Verification

**Files:**
- Create: `backend/scripts/allocate-loan-funding.ts`
- Create: `backend/src/scripts/allocate-loan-funding.test.ts`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Interfaces:** Requires explicit loan/profile UUID, amount, date, reason and idempotency key; defaults to preview-only; execute additionally requires confirmed preview UUID/hash and calls the application service, never direct SQL.

- [ ] **Step 1: Write failing command-safety test**

```ts
expect(parseArgs(baseArgs)).toMatchObject({ execute: false, amount: "10000.00", allocationDate: "2026-07-31" });
expect(() => parseArgs([...baseArgs, "--execute"])).toThrow("confirmed preview");
expect(source).not.toContain("update(loans)");
expect(source).not.toContain("loan_disbursement_events");
```

- [ ] **Step 2: Verify RED** — Run `cd backend && bun test src/scripts/allocate-loan-funding.test.ts`.
- [ ] **Step 3: Implement preview-first script and README procedure** — Print only safe public fields and stop for explicit confirmation. It must never create/edit a disbursement.
- [ ] **Step 4: Run all verification serially**

```bash
cd backend && ./scripts/test-disposable-postgres.sh && bun run typecheck
cd frontend && bun test && bun run lint && bun run build
cd plugins/creditsync && bun run scripts/mcp-contract.ts --check && bun run scripts/validate.ts && bun test
git diff --check && git status --short
```

- [ ] **Step 5: Commit** — Commit script/test/README/changelog as `infra: add guarded historical funding allocation`.
- [ ] **Step 6: Use `superpowers:verification-before-completion` and `superpowers:requesting-code-review`** — Resolve findings before deployment.
- [ ] **Step 7: Deploy before production mutation** — Start infra/app, verify migration `0027` and trigger in production PostgreSQL, inspect migration logs, and check MCP health inside the backend container.
- [ ] **Step 8: Preview the real TTB allocation** — Resolve the exact production loan/profile public UUIDs read-only; inspect the existing posted THB 10,000 disbursement and zero allocation; preview one TTB `10000.00` allocation dated `2026-07-31`; show preview ID/hash/expiry and wait for explicit confirmation.
- [ ] **Step 9: Execute once and verify both directions** — After confirmation, execute idempotently; Loan Detail must be fully funded, TTB Fund Detail must list THB 10,000, disbursement count must be unchanged, and audit/correlation IDs must exist.

## Final Review Gate

- [ ] Compare all tasks to `docs/superpowers/specs/2026-08-13-post-activation-multi-source-loan-funding-design.md`.
- [ ] Confirm no active term, posted disbursement/payment, or old allocation row is mutated.
- [ ] Confirm public money remains exact strings and all comparisons use `decimal.js`.
- [ ] Confirm changelog/README and plugin 2.5.0 describe the staged behavior exactly.
