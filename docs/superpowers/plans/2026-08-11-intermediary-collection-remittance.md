# Intermediary Collection and Remittance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a manual-first, AI-assisted two-leg ledger that records borrower payments to intermediaries, matches them to grouped remittances received by the lender, and posts borrower payments only after an exact explicitly confirmed settlement or authorized manual approval.

**Architecture:** Add focused intermediary, collection, remittance, allocation, proposal, and evidence tables behind one `intermediary-service` application boundary. REST and MCP adapters call that service directly; a new manual Web UI creates and resumes drafts, explicitly selects pending collections against a remittance balance, previews, confirms, posts, reverses, and views evidence. Existing payment posting remains the authoritative component allocator, while intermediary rows provide immutable provenance and prevent double posting.

**Tech Stack:** Bun, TypeScript, Elysia, Drizzle/PostgreSQL, Decimal.js, React 19, React Router, i18next, Vitest/Testing Library, MCP SDK/Zod, MinIO/S3 signed uploads.

## Global Constraints

- All public money values are two-decimal strings and all arithmetic uses `decimal.js`; never use `Number` for financial values.
- The borrower-paid timestamp is the effective loan-payment timestamp only after settlement or manual approval posts; remittance-received and system-posted timestamps remain distinct.
- Use `Asia/Bangkok` business time and ISO 8601 timestamps.
- Manual Web UI commands must cover the full workflow; AI/MCP is optional assistance only.
- Selection is always explicit. The backend and MCP must never apply oldest-first or silently choose one of several exact subsets.
- Posted financial records are immutable and corrections use reasoned compensating reversal.
- Every write carries actor/source, request ID, correlation ID, append-only audit context, and an idempotency key where supported.
- Evidence is optional and follows prepare → direct signed PUT → finalize; never expose raw signed URLs in logs or persisted public responses.
- REST and MCP use public UUIDs only and MCP calls application services directly.
- Update Thai and English locale files together.
- Every commit updates `CHANGELOG.md`; user-facing workflows and setup changes update `README.md`.

---

## File map

- `backend/src/db/schema.ts`: persistent intermediary ledger schema and database constraints.
- `backend/drizzle/0023_intermediary_collection_remittance.sql`: additive migration, unique indexes, checks, and immutable-posted triggers.
- `backend/src/services/intermediary-service.ts`: domain validation, reads, drafts, explicit allocation, preview, post, manual approval, reversal, and evidence lifecycle.
- `backend/src/services/intermediary-service.test.ts`: disposable-PostgreSQL financial and concurrency tests.
- `backend/src/modules/intermediaries.ts`: authenticated REST adapter and closed request schemas.
- `backend/src/modules/intermediaries.test.ts`: REST authorization and contract tests.
- `backend/src/modules/payment-intakes.ts`, `backend/src/services/payment-service.ts`: expose ready payment evidence file UUIDs and correct signed-upload/finalize behavior.
- `backend/src/mcp/server.ts`, `backend/src/mcp/default.test.ts`: direct-service MCP tools and frozen contract coverage.
- `frontend/src/pages/dashboard/intermediaries/IntermediaryMoney.tsx`: manual collection/remittance workspace.
- `frontend/src/pages/dashboard/intermediaries/model.ts`: exact-money UI helpers and API types.
- `frontend/src/pages/dashboard/payments/PaymentInbox.tsx`: ready evidence thumbnail/view and actionable pending errors.
- `frontend/src/App.tsx`, `frontend/src/layouts/DashboardLayout.tsx`: route and navigation.
- `frontend/src/locales/en.json`, `frontend/src/locales/th.json`: complete localized copy.
- `frontend/tests/intermediary-money.vitest.tsx`, `frontend/tests/payment-inbox-evidence.vitest.tsx`: manual workflow and evidence UI tests.
- `plugins/creditsync/**`: plugin manifest/version, frozen contract, orchestration instructions, evals, and validator fixtures.
- `backend/scripts/migrate-phee-phon-intermediary-collections.ts`: controlled, dry-run-first conversion of the four unposted intakes after an intermediary UUID is supplied.
- `README.md`, `CHANGELOG.md`: operator workflow and versioned change record.

---

### Task 1: Add the immutable intermediary ledger schema

**Files:**
- Modify: `backend/src/db/schema.ts`
- Create: `backend/drizzle/0023_intermediary_collection_remittance.sql`
- Modify: `backend/drizzle/meta/_journal.json`
- Test: `backend/src/db/intermediary-schema.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces tables `intermediaries`, `intermediary_collections`, `intermediary_remittances`, `intermediary_remittance_allocations`, `intermediary_remittance_proposals`, and evidence link/intents following existing payment evidence ownership patterns.
- Produces status unions matching the approved spec and tenant-scoped foreign keys/indexes consumed by `intermediary-service.ts`.

- [ ] **Step 1: Write a failing database test for constraints and immutability**

Create integration assertions that insert one intermediary, collection, remittance, allocation, and proposal, reject a second active allocation of the same collection, reject cross-tenant links, and reject update/delete of posted remittances and settled collections.

```ts
expect(secondReservation).rejects.toMatchObject({ code: "23505" });
expect(crossTenantLink).rejects.toBeDefined();
expect(updatePosted).rejects.toBeDefined();
expect(deleteSettled).rejects.toBeDefined();
```

- [ ] **Step 2: Run the schema test and verify failure**

Run: `cd backend && bun test src/db/intermediary-schema.test.ts`
Expected: FAIL because the intermediary tables do not exist.

- [ ] **Step 3: Add exact schema and generated migration**

Use UUID public IDs, composite tenant foreign keys, numeric money columns, explicit status checks, unique active reservation constraints, audit actor fields, timestamps, and PostgreSQL triggers that block mutation/deletion after posting while allowing the service's explicit state transition into immutable states.

```ts
export const intermediaryCollections = pgTable("intermediary_collections", {
  id: serial("id").primaryKey(),
  publicId: uuid("public_id").default(sql`uuidv7()`).notNull().unique(),
  tenantId,
  intermediaryId: integer("intermediary_id").notNull(),
  borrowerId: integer("borrower_id").notNull(),
  loanId: integer("loan_id").notNull(),
  amount: numeric("amount").notNull(),
  borrowerPaidAt: timestamp("borrower_paid_at").notNull(),
  status: text("status").default("pending_remittance").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  bankReference: text("bank_reference"),
  bankReferenceHash: text("bank_reference_hash"),
  note: text("note"),
  postedPaymentIntakeId: integer("posted_payment_intake_id"),
  createdByUserId: integer("created_by_user_id"),
  updatedByUserId: integer("updated_by_user_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
```

- [ ] **Step 4: Run migration and schema tests**

Run: `cd backend && bun x drizzle-kit generate && bun test src/db/intermediary-schema.test.ts`
Expected: PASS with the new migration numbered after `0022`.

- [ ] **Step 5: Update changelog and commit**

```bash
git add backend/src/db backend/drizzle CHANGELOG.md
git commit -m "feat: add intermediary settlement ledger schema"
```

### Task 2: Implement manual intermediary and collection services

**Files:**
- Create: `backend/src/services/intermediary-service.ts`
- Create: `backend/src/services/intermediary-service.test.ts`
- Modify: `backend/src/services/payment-service.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces `createIntermediary`, `searchIntermediaries`, `listIntermediaries`, `updateIntermediary`, `createIntermediaryCollection`, `getIntermediaryCollection`, and `listIntermediaryCollections`.
- Collection input is `{ intermediaryPublicId, borrowerPublicId, loanPublicId, amount, borrowerPaidAt, bankReference?, note? }`; output uses UUIDs and exact money strings.
- Consumes existing `CommandContext`, tenant access rules, `parseMoney`, borrower/loan access checks, and audit creation.

- [ ] **Step 1: Write failing service tests**

Cover canonical/alias search, manual collection creation without evidence, exact money/date validation, borrower/loan mismatch, tenant isolation, idempotent replay, duplicate bank reference, and confirmation that collection creation does not change loan balances or create transactions.

```ts
const created = await createIntermediaryCollection(ctx("collection-1"), {
  intermediaryPublicId: intermediary.publicId,
  borrowerPublicId: borrower.publicId,
  loanPublicId: loan.publicId,
  amount: "75.00",
  borrowerPaidAt: "2026-08-07T14:51:00+07:00",
  bankReference: "016219145104BTF08823",
});
expect(created.status).toBe("pending_remittance");
expect(await postedTransactionCount(loan.id)).toBe(0);
```

- [ ] **Step 2: Run targeted tests and verify failure**

Run: `cd backend && bun test src/services/intermediary-service.test.ts`
Expected: FAIL because service exports are missing.

- [ ] **Step 3: Implement validation, idempotency, audit, and read models**

Normalize references using the existing payment reference policy, validate accessible borrower/loan ownership, return semantic warnings without auto-selection, and keep every collection non-financial until a later post command.

- [ ] **Step 4: Run service tests and backend typecheck**

Run: `cd backend && bun test src/services/intermediary-service.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Update changelog and commit**

```bash
git add backend/src/services CHANGELOG.md
git commit -m "feat: capture intermediary borrower collections"
```

### Task 3: Implement remittance drafts, explicit allocation, preview, and atomic posting

**Files:**
- Modify: `backend/src/services/intermediary-service.ts`
- Modify: `backend/src/services/intermediary-service.test.ts`
- Modify: `backend/src/services/payment-service.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces `createIntermediaryRemittance`, `getIntermediaryRemittance`, `listIntermediaryRemittances`, `saveRemittanceAllocations`, `previewIntermediaryRemittance`, and `postIntermediaryRemittance`.
- `saveRemittanceAllocations(ctx, remittancePublicId, { collectionPublicIds })` persists the exact operator selection and returns `{ grossAmount, selectedTotal, remainingBalance, status }`.
- `previewIntermediaryRemittance` returns a versioned proposal with allocations, warnings, expiry, and state hash; `postIntermediaryRemittance` requires proposal UUID plus explicit `confirmed: true`.

- [ ] **Step 1: Add failing financial workflow tests**

Test zero-balance readiness, partial and over-selected `needs_review`, persisted selections, rejection of another intermediary's collection, collection reservation races, stale preview, concurrent/idempotent post, effective borrower-paid dates, separate remittance timestamps, and no cash/payment double count.

```ts
const preview = await previewIntermediaryRemittance(ctx(), remittance.publicId);
expect(preview).toMatchObject({ status: "ready", selectedTotal: "700.00", remainingBalance: "0.00" });
const posted = await postIntermediaryRemittance(ctx("post-700"), remittance.publicId, {
  proposalPublicId: preview.publicId,
  confirmed: true,
});
expect(posted.collections.every((row) => row.status === "settled")).toBe(true);
expect(posted.transactions[0].effectiveAt).toBe(collection.borrowerPaidAt.toISOString());
```

- [ ] **Step 2: Run targeted tests and verify failure**

Run: `cd backend && bun test src/services/intermediary-service.test.ts`
Expected: FAIL on missing remittance methods.

- [ ] **Step 3: Implement draft selection and preview**

Use `Decimal` for `gross - selected`, reserve collections with unique active allocation rows, produce `ready` only at `0.00`, and hash ordered public IDs, amounts, statuses, loan states, and proposal expiry inputs.

- [ ] **Step 4: Implement atomic post through a reusable payment-service transaction boundary**

Extract or add a payment posting primitive that accepts an existing database transaction and explicit effective timestamp. Lock remittance, collections, loans, and proposal in deterministic order; then create one lender cash receipt and linked borrower transaction components without duplicating the gross amount.

- [ ] **Step 5: Run service tests, disposable PostgreSQL suite, and typecheck**

Run: `cd backend && bun test src/services/intermediary-service.test.ts && ./scripts/test-disposable-postgres.sh && bun run typecheck`
Expected: PASS with no skipped intermediary financial invariant.

- [ ] **Step 6: Update changelog and commit**

```bash
git add backend/src/services CHANGELOG.md
git commit -m "feat: settle explicit intermediary remittances"
```

### Task 4: Add manual approval, compensating reversal, and evidence reliability

**Files:**
- Modify: `backend/src/services/intermediary-service.ts`
- Modify: `backend/src/services/intermediary-service.test.ts`
- Modify: `backend/src/lib/storage.ts`
- Modify: `backend/src/services/payment-service.ts`
- Test: `backend/src/lib/storage.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces `manualApproveIntermediaryCollection(ctx, collectionPublicId, { reason, confirmed: true })` and `reverseIntermediaryRemittance(ctx, remittancePublicId, { reason })`.
- Produces shared collection/remittance evidence prepare/finalize functions returning `filePublicId` only after ready.
- Corrects `createSignedPutUrl` so returned required headers exactly match signed headers and finalization sees content type, size, checksum, tenant, and parent metadata.

- [ ] **Step 1: Write failing manual-approval and reversal tests**

Assert tenant-admin permission, required reason/confirmation/idempotency, effective borrower-paid date, exclusion of manually approved collections from remittances, compensating reversal, blocked downstream reversal, and immutable originals.

- [ ] **Step 2: Write a failing signed-upload contract test**

Use a storage gateway fixture that compares every returned required header with the signed request and then verifies finalize receives matching content type, length, checksum, tenant, and parent metadata.

- [ ] **Step 3: Run tests and verify failure**

Run: `cd backend && bun test src/lib/storage.test.ts src/services/intermediary-service.test.ts src/services/payment-service.test.ts`
Expected: FAIL on unsigned required headers and missing exception/reversal services.

- [ ] **Step 4: Implement one signed-upload contract and exception/reversal commands**

Ensure S3 presigning signs all required headers or remove headers that must not be sent; keep direct PUT unchanged bytes. Make reversal append compensating entries and release eligible collections only after atomic downstream checks.

- [ ] **Step 5: Run targeted and disposable tests**

Run: `cd backend && bun test src/lib/storage.test.ts src/services/intermediary-service.test.ts src/services/payment-service.test.ts && ./scripts/test-disposable-postgres.sh`
Expected: PASS.

- [ ] **Step 6: Update changelog and commit**

```bash
git add backend/src/lib/storage.ts backend/src/lib/storage.test.ts backend/src/services CHANGELOG.md
git commit -m "fix: secure intermediary evidence and reversals"
```

### Task 5: Expose authenticated REST commands

**Files:**
- Create: `backend/src/modules/intermediaries.ts`
- Create: `backend/src/modules/intermediaries.test.ts`
- Modify: `backend/src/index.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Adds `/intermediaries`, `/intermediary-collections`, and `/intermediary-remittances` CRUD/read workflow endpoints.
- Post/manual-approve/reverse commands require `Idempotency-Key`; previews accept exact selected collection UUID arrays and post requires `{ proposalPublicId, confirmed: true }`.
- Evidence endpoints mirror `/payment-intakes/:id/evidence/upload-intents` and finalize with parent-scoped ownership.

- [ ] **Step 1: Write failing REST contract tests**

Test manual creation, list filters, draft resume, allocation save, zero/non-zero preview, explicit post confirmation, missing/blank idempotency keys, owner/manager versus collector access, tenant isolation, evidence responses, and stable public UUID/money shapes.

- [ ] **Step 2: Run REST tests and verify 404 failures**

Run: `cd backend && bun test src/modules/intermediaries.test.ts`
Expected: FAIL because routes are not registered.

- [ ] **Step 3: Implement thin Elysia adapters and register the route**

Use closed `t.Object` schemas, `commandContext(user, request)`, status mapping from `DomainError`, and no duplicated accounting calculations in route code.

- [ ] **Step 4: Run REST, security, and type checks**

Run: `cd backend && bun test src/modules/intermediaries.test.ts src/modules/files.test.ts src/modules/payment-intakes.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Update changelog and commit**

```bash
git add backend/src/modules/intermediaries.ts backend/src/modules/intermediaries.test.ts backend/src/index.ts CHANGELOG.md
git commit -m "feat: expose intermediary settlement API"
```

### Task 6: Build the complete manual Web UI and evidence viewer

**Files:**
- Create: `frontend/src/pages/dashboard/intermediaries/model.ts`
- Create: `frontend/src/pages/dashboard/intermediaries/IntermediaryMoney.tsx`
- Create: `frontend/tests/intermediary-money.vitest.tsx`
- Create: `frontend/tests/payment-inbox-evidence.vitest.tsx`
- Modify: `frontend/src/pages/dashboard/payments/PaymentInbox.tsx`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/layouts/DashboardLayout.tsx`
- Modify: `frontend/src/locales/en.json`
- Modify: `frontend/src/locales/th.json`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes Task 5 REST payloads and `resolveFileAccessUrl(filePublicId)`.
- Produces a manual collection form, remittance draft form, filterable pending collection selector, saved selections, exact balance card, preview/confirmation/post, manual approval, reversal, and evidence thumbnail/full view/retry states.

- [ ] **Step 1: Write failing UI workflow tests**

Render with Thai and English API fixtures. Manually create a collection without a slip, create a `700.00` remittance, select/deselect rows, assert exact balance changes, save/reload draft, disable post at non-zero balance, require confirmation at zero, and require manual-approval reason.

- [ ] **Step 2: Write failing evidence-view tests**

Assert pending evidence renders explanation/retry without a view action; ready image/PDF evidence calls `/files/:filePublicId/access-url` and opens the viewer/new tab without exposing the signed URL in DOM text.

- [ ] **Step 3: Run UI tests and verify failure**

Run: `cd frontend && bun test tests/intermediary-money.vitest.tsx tests/payment-inbox-evidence.vitest.tsx`
Expected: FAIL because components/routes do not exist and Payment Inbox has no view action.

- [ ] **Step 4: Implement exact UI model and manual workspace**

Use string money helpers from `workflow-model`, persisted draft API state, explicit checkboxes with accessible labels, responsive two-pane/stacked layout, and no client-side accounting decisions beyond display arithmetic.

- [ ] **Step 5: Implement evidence thumbnail/view/retry in both workflows**

Open the blank popup synchronously before resolving authenticated access URLs, reuse the proven disbursement viewer pattern, and surface domain error codes through localized copy.

- [ ] **Step 6: Run frontend test, lint, and build**

Run: `cd frontend && bun test && bun run lint && bun run build`
Expected: PASS.

- [ ] **Step 7: Update changelog and commit**

```bash
git add frontend/src frontend/tests CHANGELOG.md
git commit -m "feat: add manual intermediary settlement workspace"
```

### Task 7: Add MCP tools, orchestration policy, frozen contract, and evals

**Files:**
- Modify: `backend/src/mcp/server.ts`
- Modify: `backend/src/mcp/default.test.ts`
- Modify: `backend/src/mcp/contract-snapshot.ts`
- Modify: `plugins/creditsync/skills/creditsync/SKILL.md`
- Create: `plugins/creditsync/skills/reconcile-intermediary-remittances/SKILL.md`
- Modify: `plugins/creditsync/references/matching-policy.md`
- Modify: `plugins/creditsync/references/error-recovery.md`
- Modify: `plugins/creditsync/evals/evals.json`
- Modify: `plugins/creditsync/evals/harness.ts`
- Modify: `plugins/creditsync/evals/skill-tests.md`
- Modify: `plugins/creditsync/references/mcp-tool-contract.json`
- Modify: `plugins/creditsync/README.md`
- Modify: `plugins/creditsync/CHANGELOG.md`
- Modify: `plugins/creditsync/tests/plugin-contract.test.ts`
- Modify: `plugins/creditsync/tests/eval-harness.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Adds read/search/create/update, collection capture/read/list/manual-approve, remittance create/read/list/preview/post/reverse, and required evidence tools from the approved spec.
- Agent subset suggestions are explicit allocation arrays; zero, one, or several exact candidate subsets are reported without backend auto-selection.

- [ ] **Step 1: Write failing MCP server and contract tests**

Assert closed schemas, read-only/destructive hints, UUID/money contracts, direct service calls, audit/correlation outputs, confirmed post, and refusal of automatic subset selection.

- [ ] **Step 2: Add failing safety eval scenarios**

Fixtures cover one exact suggested subset awaiting confirmation, multiple exact subsets stopping for human choice, no exact subset, partial balance, stale preview, fuzzy intermediary, manual approval, duplicate evidence, and compensating reversal.

- [ ] **Step 3: Run backend/plugin tests and verify failure**

Run: `cd backend && bun test src/mcp/default.test.ts && cd ../plugins/creditsync && bun test tests/plugin-contract.test.ts tests/eval-harness.test.ts`
Expected: FAIL because tools, skill, contract, and scenarios are missing.

- [ ] **Step 4: Implement direct-service MCP tools and orchestration skill**

Keep schemas closed; return structured data plus readable summaries; mark all reads and destructive commands correctly; require latest proposal and explicit confirmation for post/manual approval.

- [ ] **Step 5: Regenerate and validate the frozen contract**

Run: `cd plugins/creditsync && bun run scripts/mcp-contract.ts && bun run scripts/validate.ts`
Expected: validator success with manifest/tool counts and a deliberate plugin version bump recorded in both changelogs.

- [ ] **Step 6: Run MCP/plugin tests and commit**

Run: `cd backend && bun test src/mcp/default.test.ts src/mcp/server.test.ts && cd ../plugins/creditsync && bun test`
Expected: PASS.

```bash
git add backend/src/mcp plugins/creditsync CHANGELOG.md
git commit -m "feat: orchestrate intermediary remittance matching"
```

### Task 8: Migrate the four unposted borrower intakes safely

**Files:**
- Create: `backend/scripts/migrate-phee-phon-intermediary-collections.ts`
- Create: `backend/scripts/migrate-phee-phon-intermediary-collections.test.ts`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Script requires the `--intermediary-public-id` flag with a validated public UUID value and defaults to dry-run.
- It resolves the four exact unposted intake UUIDs from the approved spec, verifies borrower/loan, amount/date/reference/status, creates or replays four collection idempotency keys, marks source intakes as converted/non-postable with audit links, and never finalizes evidence without storage validation.

- [ ] **Step 1: Write a failing dry-run and apply test**

Assert dry-run reports four rows totaling `300.00` without writes; apply creates four `pending_remittance` collections, preserves effective timestamps/references, blocks original intake posting, and is idempotent on rerun.

- [ ] **Step 2: Run the script test and verify failure**

Run: `cd backend && bun test scripts/migrate-phee-phon-intermediary-collections.test.ts`
Expected: FAIL because the script is missing.

- [ ] **Step 3: Implement explicit-target dry-run-first migration**

Require production operator confirmation outside the script, avoid name-only matching, print public UUID/status/count/total summaries without raw identity data, and use one transaction for apply.

- [ ] **Step 4: Run dry-run against the configured environment only after the operator supplies the intermediary UUID**

Run: `cd backend && test -n "$CONFIRMED_INTERMEDIARY_PUBLIC_ID" && bun run scripts/migrate-phee-phon-intermediary-collections.ts --intermediary-public-id "$CONFIRMED_INTERMEDIARY_PUBLIC_ID"`
Expected: `DRY RUN: 4 collections, total 300.00, 0 writes`.

- [ ] **Step 5: Document operations and commit without applying to production**

```bash
git add backend/scripts README.md CHANGELOG.md
git commit -m "ops: prepare intermediary intake migration"
```

### Task 9: Full verification and production-style smoke checks

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Verifies all deliverables without creating live financial records.

- [ ] **Step 1: Run backend financial and type gates**

Run: `cd backend && ./scripts/test-disposable-postgres.sh && bun run typecheck`
Expected: all tests PASS; no intermediary invariant is skipped.

- [ ] **Step 2: Run frontend gates**

Run: `cd frontend && bun test && bun run lint && bun run build`
Expected: PASS.

- [ ] **Step 3: Run plugin gates**

Run: `cd plugins/creditsync && bun test && bun run scripts/validate.ts`
Expected: PASS with synchronized tool contract and plugin version.

- [ ] **Step 4: Start production-style containers and verify migrations/health**

Run:

```bash
docker compose --env-file .env.production -f docker-compose.infra.yml up -d
docker compose --env-file .env.production -f docker-compose.app.yml up --build -d
docker compose --env-file .env.production -f docker-compose.app.yml exec backend bun -e "fetch('http://127.0.0.1:3000/mcp/health').then(r => { console.log(r.status); if (!r.ok) process.exit(1) })"
curl -fsS http://127.0.0.1:8088/ >/dev/null
```

Expected: MCP health `200`, public frontend succeeds, backend logs show migration `0023`, and PostgreSQL contains the new tables/constraints.

- [ ] **Step 5: Verify no unauthorized production mutation and commit docs**

Confirm no live remittance, collection, borrower payment, manual approval, or migration apply command ran. Record exact deployment/migration instructions and pending operator step for the intermediary UUID.

```bash
git add README.md CHANGELOG.md
git commit -m "docs: document intermediary settlement operations"
```
