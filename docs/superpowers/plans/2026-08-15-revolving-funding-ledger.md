# Revolving Funding Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an exact, append-only revolving funding ledger for SCB UP2ME Credit Card and Speedy Cash, with manual/Web/MCP drawdowns, provider charges, repayments, corrections, and borrower-loan allocations.

**Architecture:** Keep scheduled `bank_loans` unchanged and add tenant-scoped revolving-account and event tables behind one application service. A pure Decimal kernel produces informational policy previews; only explicitly confirmed posted events affect balances, and all corrections use compensating entries. REST, Web, and a synchronized focused MCP/plugin contract call the same service.

**Tech Stack:** Bun, TypeScript, Elysia, Drizzle ORM, PostgreSQL, `decimal.js`, Zod/MCP SDK, React 19, Vitest, Testing Library, i18next.

## Global Constraints

- Public money is a two-decimal decimal string; use the shared high-precision `decimal.js` context and never JavaScript `Number` for financial arithmetic, comparison, aggregation, or formatting.
- Use `Asia/Bangkok` business dates, ISO 8601 timestamps, and `YYYY-MM-DD` effective dates.
- Draft events are editable; posted events are immutable at the database boundary and corrections are append-only compensating reversal/adjustment events with reasons.
- Every financial write carries command context, request/correlation ID, actor/source, idempotency key, and append-only audit history.
- Evidence is optional; when supplied it follows prepare → direct signed PUT → finalize and no signed URL or private evidence data enters audit output.
- Estimated interest and presets remain informational until an exact manual/MCP amount is explicitly confirmed and posted.
- VAT is an exact separate charge linked to a compatible fee; never apply VAT to interest through a global rate.
- Active borrower loans are funded through append-only allocation events; never mutate locked loan terms.
- REST and MCP accept/return safe public UUIDs and two-decimal strings only; MCP uses closed schemas and inspect → preview → explicit confirmation → post.
- Update `frontend/src/locales/en.json` and `frontend/src/locales/th.json` together for user-facing copy.
- Synchronize the frozen MCP contract, plugin version/manifest, skills, evals, and validator whenever tools change.
- Run database suites serially through `backend/scripts/test-disposable-postgres.sh`; a skipped DB test is not sufficient.
- Before every commit, add an accurate entry under the current explicit version/date in `CHANGELOG.md` and stage only the entry belonging to that commit.
- Preserve unrelated dirty files, especially the in-progress `0037` identity-card migration and existing `CHANGELOG.md` hunk; never discard or stage them.
- Do not create production financial records, push, deploy, or run the conversion script with `--apply` without separate authorization.

## File Map

- `backend/src/db/schema.ts`, `backend/drizzle/0038_revolving_funding_ledger.sql`, `backend/src/db/revolving-funding-ledger-migration.test.ts`: additive tables, tenant-safe keys, idempotency, lifecycle checks, and immutable-posted triggers.
- `backend/src/lib/revolving-funding-calculator.ts`: pure Decimal fee, VAT, and daily-interest preview kernel.
- `backend/src/services/revolving-funding-service.ts`: tenant-scoped reads, drafts, previews, posting, balance rollups, repayments, reversals, deterministic locking, audit, and replay.
- `backend/src/services/revolving-funding-evidence-service.ts`: optional evidence prepare/finalize ownership wrapper using existing transfer-evidence primitives.
- `backend/src/modules/revolving-funding-routes.ts`: thin REST contracts and command-context adapters.
- `backend/src/services/loan-funding-service.ts`, `backend/src/modules/loan-funding-presenters.ts`: capacity-aware allocation into existing append-only loan funding.
- `frontend/src/pages/dashboard/funds/RevolvingAccountPanel.tsx`, `RevolvingEventDialog.tsx`: localized account ledger, draft/preview/confirm, repayment, and correction UI.
- `backend/src/mcp/{default,server,contract-snapshot}.ts`, `plugins/creditsync/**`: focused closed-schema revolving tools and synchronized private plugin.
- `backend/scripts/create-revolving-account.ts`: exact-profile dry-run-first idempotent conversion command.

---

### Task 1: Add the Additive Revolving Ledger Schema

**Files:**
- Modify: `backend/src/db/schema.ts`
- Create: `backend/drizzle/0038_revolving_funding_ledger.sql`
- Modify: `backend/drizzle/meta/_journal.json`
- Create: `backend/drizzle/meta/0038_snapshot.json`
- Create: `backend/src/db/revolving-funding-ledger-migration.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:** Produces Drizzle exports `fundingRevolvingAccounts`, `fundingDrawdownEvents`, `fundingChargeEvents`, `fundingRepaymentEvents`, `fundingRepaymentComponents`, `fundingAllocationEvents`, and `fundingRevolvingPreviews`.

- [ ] **Step 1: Write the failing schema/migration test**

```ts
test("installs tenant-safe immutable revolving facts", async () => {
  const sql = await Bun.file(`${backendRoot}drizzle/0038_revolving_funding_ledger.sql`).text();
  expect(sql).toContain('CREATE TABLE "funding_revolving_accounts"');
  expect(sql).toContain('CREATE TABLE "funding_drawdown_events"');
  expect(sql).toContain('CREATE TABLE "funding_charge_events"');
  expect(sql).toContain('CREATE TABLE "funding_repayment_events"');
  expect(sql).toContain('CREATE TABLE "funding_allocation_events"');
  expect(sql).toContain('funding_revolving_posted_facts_are_immutable');
  expect(sql).toContain('funding_revolving_idempotency_unique');
  expect(getTableConfig(fundingChargeEvents).checks.map(x => x.name))
    .toContain("funding_charge_events_amount_check");
});
```

- [ ] **Step 2: Run RED** — Run `cd backend && bun test src/db/revolving-funding-ledger-migration.test.ts`; expect missing exports/migration.
- [ ] **Step 3: Add exact tables and constraints** — Use `numeric(32,2)`-compatible public money constraints; status checks (`draft`, `posted`, `reversed`); account/product enums; parent-fee compatibility; tenant composite foreign keys; active idempotency indexes; reversal uniqueness; preview hash/version/expiry/result fields; actor/audit/correlation provenance. Database triggers allow draft updates but reject update/delete of posted financial facts and repayment components.
- [ ] **Step 4: Generate and review Drizzle metadata** — Run the repository's Bun-first Drizzle generation command, confirm the output is `0038`, and inspect that no unrelated `0037` content is regenerated or staged.
- [ ] **Step 5: Run GREEN** — Run `cd backend && bun test src/db/revolving-funding-ledger-migration.test.ts src/db/own-capital-direct-funding-migration.test.ts && bun run typecheck`; expect PASS.
- [ ] **Step 6: Commit** — Update/stage the matching changelog entry and the Task 1 files only; commit `feat: add revolving funding ledger schema`.

### Task 2: Build the Exact Revolving Policy Calculator

**Files:**
- Create: `backend/src/lib/revolving-funding-calculator.ts`
- Create: `backend/src/lib/revolving-funding-calculator.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:** Produces:

```ts
type RevolvingProductPolicy = {
  productType: "credit_card" | "revolving_personal_loan";
  annualInterestRate: string;
  cashAdvanceFee: { mode: "none" } | { mode: "percent"; rate: string };
  feeVatRate: string;
};
previewCashAdvance(input: { amount: string; policy: RevolvingProductPolicy }): {
  principal: string; fee: string; feeVat: string; immediateLiability: string;
};
previewDailyInterest(input: {
  principalSegments: Array<{ amount: string; fromDate: string; throughDate: string }>;
  annualInterestRate: string;
}): { segments: Array<{ days: number; denominatorDays: 365 | 366; amount: string }>; total: string };
```

- [ ] **Step 1: Write failing exact-policy tests**

```ts
expect(previewCashAdvance({ amount: "47000.00", policy: up2me })).toEqual({
  principal: "47000.00", fee: "1410.00", feeVat: "98.70", immediateLiability: "48508.70",
});
expect(previewCashAdvance({ amount: "47000.00", policy: speedyCash })).toMatchObject({
  fee: "0.00", feeVat: "0.00", immediateLiability: "47000.00",
});
expect(previewCollectionFee("one_cycle")).toEqual({ fee: "50.00", feeVat: "3.50" });
expect(previewCollectionFee("multiple_cycles")).toEqual({ fee: "100.00", feeVat: "7.00" });
```

- [ ] **Step 2: Run RED** — Run `cd backend && bun test src/lib/revolving-funding-calculator.test.ts`; expect missing module.
- [ ] **Step 3: Implement minimal Decimal calculations** — Parse with shared public-money/rate validators, round money half-up only at explicit event boundaries, split interest spans by calendar year, use 365/366 denominators, and return formulas/normalized inputs without persisting anything.
- [ ] **Step 4: Add boundary tests** — Cover safe-integer overflow values, leap day, zero fee, invalid percent, negative amount, reversed date range, VAT on fee only, and prove the result never contains VAT on interest.
- [ ] **Step 5: Run GREEN and commit** — Run focused test and `bun run typecheck`; update changelog and commit `feat: calculate revolving funding previews`.

### Task 3: Implement Account, Drawdown, Charge, and Balance Services

**Files:**
- Create: `backend/src/services/revolving-funding-service.ts`
- Create: `backend/src/services/revolving-funding-service.test.ts`
- Modify: `backend/src/lib/public-id.ts`
- Modify: `CHANGELOG.md`

**Interfaces:** Produces:

```ts
listRevolvingAccounts(ctx): Promise<RevolvingAccountSummary[]>;
getRevolvingAccount(ctx, accountPublicId): Promise<RevolvingAccountDetail>;
createDrawdownDraft(ctx, input): Promise<DrawdownEvent>;
updateDrawdownDraft(ctx, eventPublicId, changes): Promise<DrawdownEvent>;
previewDrawdown(ctx, eventPublicId): Promise<RevolvingPreview>;
postDrawdown(ctx, { previewPublicId, previewHash, confirmed: true }): Promise<CommandResult>;
createChargeDraft(ctx, input): Promise<ChargeEvent>;
updateChargeDraft(ctx, eventPublicId, changes): Promise<ChargeEvent>;
previewCharge(ctx, eventPublicId): Promise<RevolvingPreview>;
postCharge(ctx, { previewPublicId, previewHash, confirmed: true }): Promise<CommandResult>;
reverseRevolvingEvent(ctx, { eventType, eventPublicId, reason, confirmed: true }): Promise<CommandResult>;
```

- [ ] **Step 1: Write failing tenant/balance tests** — Seed two tenants and prove exact posted-only rollups, available credit, unallocated principal, draft exclusion, tenant isolation, and safe serialization beyond JavaScript's safe integer range.
- [ ] **Step 2: Run RED** — Run `cd backend && ./scripts/test-disposable-postgres.sh src/services/revolving-funding-service.test.ts`; expect missing exports.
- [ ] **Step 3: Implement account reads and canonical balance hashing** — Resolve public IDs tenant-safely; aggregate signed posted facts with `Decimal`; return separate principal, interest, fee, VAT, penalty, available-credit, allocated, and unallocated strings; hash ordered facts as `balanceVersion`.
- [ ] **Step 4: Write failing lifecycle tests** — Cover editable drafts, no-evidence posting, preview formula snapshot, explicit confirmation, short expiry, same-key replay, changed-payload conflict, duplicate provider reference, capacity rejection, inactive account, and stale balance version.
- [ ] **Step 5: Implement preview/post under deterministic locks** — Lock account then event, recompute exact balances/policy, validate preview hash/expiry/state, post atomically with audit result, and persist safe replay output. A drawdown preview may propose fee/VAT drafts but must not silently post them; a combined confirmed command posts the explicitly displayed principal/fee/VAT set atomically.
- [ ] **Step 6: Write reversal/adjustment tests** — Prove immutable originals, reason requirement, exact compensating events, duplicate reversal rejection, downstream allocation stop, and audit/correlation provenance.
- [ ] **Step 7: Implement reversal and run GREEN** — Run the disposable service suite plus typecheck; update changelog and commit `feat: add revolving drawdown and charge workflows`.

### Task 4: Add Optional Evidence to Revolving Events

**Files:**
- Create: `backend/src/services/revolving-funding-evidence-service.ts`
- Create: `backend/src/services/revolving-funding-evidence-service.test.ts`
- Modify: `backend/src/services/transfer-evidence-service.ts`
- Modify: `CHANGELOG.md`

**Interfaces:** Produces `prepareRevolvingEvidence`, `finalizeRevolvingEvidence`, and `listRevolvingEvidence` for an exact draft drawdown/charge/repayment owner.

- [ ] **Step 1: Write failing evidence tests** — Assert tenant/event ownership, allowed MIME/size, SHA-256 binding, expiry, unchanged object metadata, ready retry without re-upload, and rejection of raw file-ID attachment.
- [ ] **Step 2: Run RED** — Run the focused disposable evidence test; expect missing service.
- [ ] **Step 3: Implement the owner adapter** — Reuse existing signed upload primitives, introduce a revolving-event owner kind, return signed URL only from prepare, and expose only `filePublicId` after finalize.
- [ ] **Step 4: Add audit-redaction tests** — Assert logs/results contain no signed URL, checksum, object key, bearer token, or evidence body; prove posting without evidence still succeeds.
- [ ] **Step 5: Run GREEN and commit** — Run evidence and transfer-evidence suites plus typecheck; update changelog and commit `feat: support optional revolving evidence`.

### Task 5: Implement Manual Provider Repayments

**Files:**
- Modify: `backend/src/services/revolving-funding-service.ts`
- Modify: `backend/src/services/revolving-funding-service.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:** Produces `createRepaymentDraft`, `updateRepaymentDraft`, `previewRepayment`, `postRepayment`, and `reverseRepayment`; repayment input includes exact principal/interest/fee/VAT/penalty components whose sum equals cash amount.

- [ ] **Step 1: Write failing conservation tests**

```ts
const preview = await previewRepayment(ctx, draft.publicId);
expect(preview.components).toEqual({
  principal: "1000.00", interest: "20.60", fee: "50.00", vat: "3.50", penalty: "0.00",
});
expect(preview.amount).toBe("1074.10");
```

- [ ] **Step 2: Run RED** — Run the focused disposable service test; expect missing repayment functions.
- [ ] **Step 3: Implement explicit-component posting** — Validate exact conservation, prohibit overpayment per component unless an explicit signed adjustment is included, lock account/repayment, create immutable components, update no mutable rollup columns, and derive balances from ledger rows.
- [ ] **Step 4: Add failure/reversal tests** — Cover component mismatch, cross-tenant parent, stale preview, concurrent repayment, idempotent replay, and compensating reversal restoring exact component balances.
- [ ] **Step 5: Run GREEN and commit** — Run service suite/typecheck; update changelog and commit `feat: record revolving provider repayments`.

### Task 6: Integrate Append-only Borrower-Loan Funding Allocations

**Files:**
- Create: `backend/src/services/loan-funding-service.ts`
- Create: `backend/src/services/loan-funding-service.test.ts`
- Modify: `backend/src/modules/loan-funding-presenters.ts`
- Modify: `backend/src/modules/loan-funding-routes.ts`
- Modify: `backend/src/modules/bank-profiles.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:** Extends funding source union with `{ type: "revolving_drawdown"; accountPublicId; drawdownPublicId }`; produces `previewRevolvingAllocation` and `postRevolvingAllocation` while preserving existing allocation reads.

- [ ] **Step 1: Write failing allocation tests** — Allocate 47,000.00 from one posted UP2ME drawdown to active loan `01a00031-2aeb-76ab-bf81-3a7d967d3d8c` fixture, prove loan terms/status remain byte-for-byte unchanged, and show drawdown allocated/unallocated balances.
- [ ] **Step 2: Run RED** — Run disposable loan-funding tests; expect unsupported source type.
- [ ] **Step 3: Extract and implement the shared allocation service** — Move existing allocation validation/write logic out of `loan-funding-routes.ts` without changing its REST behavior, then add the revolving source union. Lock borrower loan then revolving account/drawdown in canonical ID order, reject draft/reversed drawdowns and net allocations above posted principal, and create/reverse append-only allocation rows with public provenance.
- [ ] **Step 4: Add multi-source/race tests** — One drawdown funds multiple loans, one loan uses existing drawdown plus revolving source, concurrent allocations cannot exceed capacity, and reversal stops when downstream fund attribution forbids it.
- [ ] **Step 5: Update presenters/rollups** — Include revolving route public IDs and exact cost buckets without converting through `Number`; retain existing bank-loan/capital-pool outputs.
- [ ] **Step 6: Run GREEN and commit** — Run loan-funding, bank-profile, attribution, and settlement suites plus typecheck; update changelog and commit `feat: allocate revolving funding to active loans`.

### Task 7: Expose Thin REST Workflows

**Files:**
- Create: `backend/src/modules/revolving-funding-routes.ts`
- Create: `backend/src/modules/revolving-funding-routes.test.ts`
- Modify: `backend/src/index.ts`
- Modify: `backend/src/modules/loan-funding-routes.ts`
- Modify: `CHANGELOG.md`

**Interfaces:** Adds `/funding-revolving-accounts/:id`, `/drawdowns`, `/charges`, `/repayments`, `/previews`, `/post`, `/reverse`, evidence prepare/finalize, and loan allocation preview/post endpoints using public UUIDs.

- [ ] **Step 1: Write failing closed-contract HTTP tests** — Cover account read, drawdown create/update/preview/post, charge pair, repayment components, allocation, reversal, unknown-key rejection, missing confirmation/idempotency, and exact public strings.
- [ ] **Step 2: Run RED** — Run `cd backend && ./scripts/test-disposable-postgres.sh src/modules/revolving-funding-routes.test.ts`; expect 404.
- [ ] **Step 3: Implement thin Elysia adapters** — Build command context from request headers/user, enforce tenant-admin writes, map domain errors to stable status/code, and invalidate funding caches only after committed writes.
- [ ] **Step 4: Add permission and redaction tests** — Viewer denial, tenant isolation, signed URL only on prepare, no private metadata in reads/audits, stale preview conflict, and retry semantics.
- [ ] **Step 5: Run GREEN and commit** — Run route, loan-funding route, auth, and typecheck gates; update changelog and commit `feat: expose revolving funding REST workflows`.

### Task 8: Build the Localized Funding UI

**Files:**
- Create: `frontend/src/pages/dashboard/funds/RevolvingAccountPanel.tsx`
- Create: `frontend/src/pages/dashboard/funds/RevolvingEventDialog.tsx`
- Create: `frontend/src/pages/dashboard/funds/revolving-account-model.ts`
- Create: `frontend/tests/revolving-account-panel.vitest.tsx`
- Modify: `frontend/src/pages/dashboard/funds/FundDetail.tsx`
- Modify: `frontend/src/locales/en.json`
- Modify: `frontend/src/locales/th.json`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Interfaces:** `RevolvingAccountPanel({ bankProfilePublicId, canManage })` consumes Task 7 REST DTOs and owns drawdown/charge/repayment/allocation dialogs.

- [ ] **Step 1: Write failing account-ledger test** — Render separate principal/interest/fee/VAT/penalty/available/allocated values; prove drafts are labeled and excluded from posted totals; display exact values beyond JS safe integer range.
- [ ] **Step 2: Run RED** — Run `cd frontend && bun test tests/revolving-account-panel.vitest.tsx`; expect missing component.
- [ ] **Step 3: Implement read-only panel/model** — Keep exact strings, use `formatMoneyExact`, semantic tables with pagination, active i18n language, explicit loading/empty/error/retry states, and no native-number conversion.
- [ ] **Step 4: Write failing drawdown/charge test** — Enter 47,000.00, preview 1,410.00 fee and 98.70 VAT, require confirmation, post with stable idempotency key, then enter the 50.00/3.50 collection preset without inferring eligibility.
- [ ] **Step 5: Implement draft/preview/confirmation dialogs** — Separate estimate from posted accounting, display formulas/VAT base, support optional evidence, disable stale confirmation, and require a reason for corrections.
- [ ] **Step 6: Write and implement repayment/allocation tests** — Exact component conservation, active-loan allocation preview, immutable original ledger visibility, and compensating reversal state.
- [ ] **Step 7: Add paired locales and README** — Document UP2ME versus Speedy Cash, manual authoritative posting, optional evidence, and append-only corrections; patch only this feature's locale/changelog hunks.
- [ ] **Step 8: Verify and commit** — Run focused tests, full frontend tests, `bun run lint`, and `bun run build`; commit `feat: add revolving funding workspace`.

### Task 9: Add the Focused MCP Contract and Synchronize the Plugin

**Files:**
- Modify: `backend/src/mcp/default.ts`, `backend/src/mcp/default.test.ts`
- Modify: `backend/src/mcp/server.ts`, `backend/src/mcp/server.test.ts`
- Modify: `backend/src/mcp/contract-snapshot.ts`
- Modify: `plugins/creditsync/.codex-plugin/plugin.json`, `plugins/creditsync/.app.json`
- Modify: `plugins/creditsync/references/mcp-tool-contract.json`, `financial-rules.md`, `error-recovery.md`
- Create: `plugins/creditsync/skills/manage-revolving-funding/SKILL.md`
- Modify: `plugins/creditsync/skills/creditsync/SKILL.md`
- Modify: `plugins/creditsync/evals/evals.json`, `plugins/creditsync/evals/skill-tests.md`
- Modify: `plugins/creditsync/tests/*.test.ts`, `plugins/creditsync/README.md`, `plugins/creditsync/CHANGELOG.md`
- Modify: `CHANGELOG.md`

**Interfaces:** Adds the 14 tools approved in the design: revolving list/get; drawdown create/update/preview/post/reverse; charge create/update/preview/post/reverse; allocation preview/post. Plugin version increments from the version present at implementation HEAD and its declared tool/skill counts are recomputed, not guessed from this plan.

- [ ] **Step 1: Write failing MCP schema/annotation tests** — Require closed inputs, public UUIDs, decimal strings, `readOnlyHint` for reads, `destructiveHint` for post/reverse/allocation, explicit `confirmed: true`, audit public IDs, and correlation ID.
- [ ] **Step 2: Run RED** — Run backend MCP server tests; expect absent tool names.
- [ ] **Step 3: Implement schemas/handlers** — Call Task 3/6 services directly, never REST; return safe structured/readable content; register rate-limit/security metadata and frozen contract projections.
- [ ] **Step 4: Add orchestration-stop tests** — Duplicate provider reference, stale preview, insufficient capacity, ambiguous account, missing confirmation, idempotency conflict, and evidence-ready retry must stop before a second financial write.
- [ ] **Step 5: Run backend MCP GREEN** — Run disposable MCP default tests, then server/security/rate-limit tests and typecheck.
- [ ] **Step 6: Synchronize plugin atomically** — Update manifest/version/counts, frozen JSON schemas, new skill routing, financial rules, recovery guide, eval fixtures, and docs. The skill must enforce `inspect → draft → preview → explicit confirmation → post` and reasoned compensation.
- [ ] **Step 7: Validate plugin** — Run `cd plugins/creditsync && bun run scripts/mcp-contract.ts --check && bun run scripts/validate.ts && bun test`; expect PASS with no scenario exemptions.
- [ ] **Step 8: Commit** — Stage synchronized backend/plugin/changelog files only; commit `feat: add MCP revolving funding workflow`.

### Task 10: Add the Dry-run SCB UP2ME Account Command

**Files:**
- Create: `backend/scripts/create-revolving-account.ts`
- Create: `backend/scripts/create-revolving-account.test.ts`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Interfaces:** CLI requires `--bank-profile-public-id`, `--product-type`, `--annual-interest-rate`, and optional `--apply`; default output is a zero-write preview. Apply creates only the revolving account, never drawdowns/charges/allocations.

- [ ] **Step 1: Write failing dry-run test** — Resolve an exact SCB UP2ME profile, print normalized credit-card policy and `DRY RUN`, assert zero new rows and zero audits.
- [ ] **Step 2: Run RED** — Run `cd backend && bun test scripts/create-revolving-account.test.ts`; expect missing script.
- [ ] **Step 3: Implement guarded CLI** — Refuse ambiguous/missing/inactive profiles, require exact public UUID, use service creation with idempotency on apply, redact profile reference details, and never accept or print credentials.
- [ ] **Step 4: Add apply/replay tests** — Explicit apply creates one account/audit; rerun returns the same account; changed policy conflicts; no financial event rows are created.
- [ ] **Step 5: Run GREEN and commit** — Run focused tests/typecheck; document the exact dry-run command but do not execute `--apply`; commit `feat: add revolving account setup command`.

### Task 11: Full Verification and Completion Audit

**Files:**
- Modify only if verification reveals a scoped defect: files introduced or modified in Tasks 1–10
- Modify: `CHANGELOG.md` only when a verification fix is committed

**Interfaces:** Produces verification evidence at one exact HEAD; no production mutation.

- [ ] **Step 1: Run focused backend unit gates** — `cd backend && bun test src/lib/revolving-funding-calculator.test.ts src/db/revolving-funding-ledger-migration.test.ts`; expect PASS.
- [ ] **Step 2: Run serial database-backed gates** — Use `backend/scripts/test-disposable-postgres.sh` for revolving service/evidence/routes, loan-funding, bank-profile, MCP default, attribution, and settlement suites; expect no skipped financial invariant.
- [ ] **Step 3: Run backend static gates** — `cd backend && bun run typecheck`; expect PASS.
- [ ] **Step 4: Run frontend gates** — `cd frontend && bun test && bun run lint && bun run build`; expect PASS.
- [ ] **Step 5: Run plugin gates** — `cd plugins/creditsync && bun run scripts/mcp-contract.ts --check && bun run scripts/validate.ts && bun test`; expect PASS.
- [ ] **Step 6: Audit financial invariants** — Search changed code for `Number(`, `parseFloat`, mutable posted-row updates/deletes, raw card data, signed URLs in audits, open MCP objects, and unpaired locale keys; every hit must be absent or documented as non-financial and safe.
- [ ] **Step 7: Verify migration paths** — Clean install and upgrade from the prior migration through `0038`; inspect tables, composite FKs, unique indexes, triggers, and preservation of seeded `bank_loans`/allocations.
- [ ] **Step 8: Review the final diff and Git state** — Confirm expected commits, no unexplained tracked changes, unrelated user files remain untouched/unstaged, README and both changelogs match delivered behavior, and no real SCB drawdown/charge/allocation was created.
- [ ] **Step 9: Commit only scoped verification fixes** — For each fix, first add a matching changelog entry and create a focused commit; rerun the affected gate and then the complete gate set at final HEAD.

## Implementation Handoff

This is substantial multi-subsystem implementation. At execution time, use an isolated `codex/` worktree and either `superpowers:subagent-driven-development` or `superpowers:executing-plans`. Under the repository's tmux policy, obtain approval for this plan before delegating; if tmux is selected, supervise a `gpt-5.3-codex-spark` worker continuously and independently verify every commit and gate. Do not merge, push, deploy, run production migrations, or create the real SCB account/drawdown/allocation without explicit authorization.
