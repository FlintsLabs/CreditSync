# Posted Payment Supplemental Evidence Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a signed direct-upload lifecycle and Web UI for append-only supplemental evidence on an exact posted payment.

**Architecture:** Extend the existing `payment_evidence_supplements` ledger with expiring upload intents and implement prepare/finalize services using the current MinIO gateway. Expose strict MCP and REST contracts, keep the existing confirmed record command, and add a localized payment-history editor that uploads directly to signed storage before recording.

**Tech Stack:** Bun, TypeScript, Elysia, Drizzle/PostgreSQL, MinIO/S3 signed PUT, React, Vitest/Bun test, i18next, CreditSync MCP/plugin.

**Spec:** `docs/superpowers/specs/2026-09-09-posted-payment-supplement-upload-design.md`

## Global Constraints

- Posted payments and financial transactions remain immutable; no reverse/repost or mutation of amount, allocations, components, balances, schedules, or commission.
- THB values remain two-decimal strings and all business dates use `Asia/Bangkok`.
- Every write is tenant-scoped, actor-attributed, request/correlation-aware, audited, and idempotent where supported.
- Signed URLs, object keys, raw hashes, file bytes, account data, and full references never appear in logs or durable public responses beyond the existing safe checksum field contract.
- Only JPEG, PNG, and PDF are accepted; storage HEAD must match MIME, size, SHA-256, tenant, and intake metadata.
- Root and plugin changelogs are updated before each related commit; README files change with user-facing workflow changes.
- No push or production action beyond the explicitly authorized merge/deploy and post-deployment evidence operation.

---

### Task 1: Extend the supplemental evidence schema

**Files:**
- Create: `backend/drizzle/0064_payment_evidence_supplement_upload.sql`
- Modify: `backend/drizzle/meta/_journal.json`
- Modify: `backend/src/db/schema.ts`
- Test: `backend/src/db/payment-evidence-supplement-upload-migration.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces: nullable `uploadExpiresAt` on `paymentEvidenceSupplements`, a compatible draft metadata constraint, and tenant/checksum uniqueness for non-null supplemental hashes.

- [ ] Write a database test that applies migrations and asserts the new column, partial checksum index, revised draft/ready constraints, and recorded-row update/delete rejection.
- [ ] Run `bun test src/db/payment-evidence-supplement-upload-migration.test.ts` from `backend/` and verify RED because the migration is absent.
- [ ] Add the migration and Drizzle schema definition, preserving legacy all-null draft rows while allowing fully declared draft upload intents.
- [ ] Run the focused database test through `./scripts/test-disposable-postgres.sh src/db/payment-evidence-supplement-upload-migration.test.ts` and verify GREEN.
- [ ] Update the root changelog under a new explicit version/date if the planning version is already committed, then commit schema, migration, test, and changelog together.

### Task 2: Implement signed supplement prepare/finalize services

**Files:**
- Modify: `backend/src/services/chatgpt-file-evidence-service.ts`
- Test: `backend/src/services/payment-evidence-supplement-service.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces: `preparePaymentEvidenceSupplement(ctx, intakePublicId, input, gateway)` and `finalizePaymentEvidenceSupplement(ctx, intakePublicId, supplementPublicId, gateway)`.
- Consumes: existing `EvidenceStorageGateway`, `files`, `paymentEvidence`, `paymentEvidenceSupplements`, `paymentIntakes`, audit helpers, and command context.

- [ ] Write failing integration tests for exact posted-intake binding, actor/tenant access, supported metadata, stable idempotent replay, signed re-prepare before expiry, expired cleanup, and safe public output.
- [ ] Add failing tests for duplicate SHA-256 against primary evidence, same/different supplement intake, and concurrent preparation; identify the production function that each test would fail without.
- [ ] Run the focused disposable suite and verify failures are caused by missing prepare behavior.
- [ ] Implement validation, tenant/checksum advisory locking, prepare/re-sign/expiry handling, file/supplement creation, audit, and storage cleanup on signing failure.
- [ ] Write failing finalize tests for exact binding, HEAD mismatch fields, expiry, already-ready replay, and concurrent finalize.
- [ ] Implement finalize as the sole `draft -> ready` transition with storage verification and audit.
- [ ] Add a financial snapshot assertion around prepare/finalize/record proving intake amount/status, proposal allocations, transactions/components, schedules, and loan balances are unchanged.
- [ ] Run focused tests GREEN, backend typecheck, update changelog, and commit.

### Task 3: Add REST and MCP contracts

**Files:**
- Modify: `backend/src/modules/payment-intakes.ts`
- Test: `backend/src/modules/payment-intakes.test.ts`
- Modify: `backend/src/mcp/default.ts`
- Modify: `backend/src/mcp/server.ts`
- Test: `backend/src/mcp/default.test.ts`
- Test: `backend/src/mcp/server.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces: three Web routes from the spec and strict MCP tools `payment.evidence-supplement.prepare` / `finalize` while preserving `record`.

- [ ] Write failing REST tests for authentication, UUID/body validation, idempotency propagation, prepare/finalize/record sequencing, and domain-error presentation.
- [ ] Implement the routes with closed Elysia schemas and existing command context.
- [ ] Write failing MCP catalog/default-handler tests covering strict inputs/outputs, read/write/destructive annotations, safe output fields, and unchanged record contract.
- [ ] Implement MCP handlers and tool metadata without exposing internal IDs, object keys, or signed URLs after finalize/record.
- [ ] Run focused REST/MCP tests and typecheck, update changelog, and commit.

### Task 4: Add the localized payment-history upload editor

**Files:**
- Modify: `frontend/src/pages/dashboard/loans/LoanPaymentHistoryTab.tsx`
- Create: `frontend/src/pages/dashboard/loans/LoanPaymentHistoryTab.test.tsx`
- Modify: `frontend/src/locales/en.json`
- Modify: `frontend/src/locales/th.json`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: the new REST routes and existing `resolveFileAccess`/`EvidencePreviewButton` display path.
- Produces: an accessible per-payment "Attach supplemental evidence" editor with file selection, reason/note, exact mapping summary, explicit confirmation, retry-stable idempotency, and reload.

- [ ] Write failing component tests for opening the editor on the selected payment, accepted file types, SHA-256 prepare payload, signed PUT headers/body, finalize, explicit confirmation gate, record payload, reload, duplicate/error display, and double-submit prevention.
- [ ] Implement the smallest editor state and API flow that makes the tests pass; never retain or render signed URLs after upload.
- [ ] Add matching Thai/English keys for labels, reasons, mapping confirmation, progress, and errors.
- [ ] Run focused frontend tests, lint, and build; update README and changelog, then commit.

### Task 5: Synchronize the CreditSync plugin

**Files:**
- Modify: `plugins/creditsync/manifest.json`
- Modify: `plugins/creditsync/references/mcp-tool-contract.json`
- Modify: `plugins/creditsync/skills/reconcile-payments/SKILL.md`
- Modify: `plugins/creditsync/README.md`
- Modify: `plugins/creditsync/evals/evals.json`
- Modify: `plugins/creditsync/evals/harness.ts`
- Modify: `plugins/creditsync/tests/plugin-contract.test.ts`
- Modify: `plugins/creditsync/tests/operations-docs.test.ts`
- Modify: `plugins/creditsync/tests/eval-harness.test.ts`
- Modify: `plugins/creditsync/CHANGELOG.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces: synchronized frozen MCP contract and executable workflow `prepare -> PUT -> finalize -> present exact mapping -> confirm -> record`.

- [ ] Write failing contract/docs/eval assertions for the two new tools, exact call order, confirmation separation, duplicate stop, and unchanged financial state.
- [ ] Update plugin guidance and executable evals; bump the plugin minor version because tools are added.
- [ ] Regenerate the frozen contract from the authenticated local MCP catalog and inspect the diff for only intended/current advertised changes.
- [ ] Run all plugin tests and `bun run scripts/validate.ts`, update both changelogs, and commit.

### Task 6: Full verification, review, merge, and deploy

**Files:**
- Review all files changed from the feature branch base.

**Interfaces:**
- Produces: reviewed commit range integrated into `main` and a healthy production backend/frontend.

- [ ] Run the relevant backend database suites serially with `backend/scripts/test-disposable-postgres.sh`, including migration, supplement service, payment service/batch, REST, MCP, and evidence read tests.
- [ ] Run backend `bun run typecheck`.
- [ ] Run frontend `bun test`, `bun run lint`, and `bun run build`.
- [ ] Run plugin `bun test` and `bun run scripts/validate.ts`.
- [ ] Run `git diff --check`, inspect all financial invariants, and request an independent code review; fix every Critical/Important finding with TDD.
- [ ] Verify the feature branch is clean and contains the required changelog entries, then merge into `main` while preserving unrelated dirty files.
- [ ] Verify ancestry, rebuild production backend and frontend with the documented Docker Compose commands, inspect migration/log output, query the new production column/index/constraints, and confirm backend MCP health plus public frontend availability.

### Task 7: Attach the three historical slips

**Files:**
- No repository files.

**Interfaces:**
- Consumes: the deployed supplemental prepare/finalize/record flow and the three exact posted intake public IDs.

- [ ] Re-inspect the 6, 7, and 8 September 2026 posted intakes and confirm evidence remains absent and financial snapshots are current.
- [ ] Compute each local slip SHA-256, prepare one upload intent per exact intake, direct PUT with required headers, finalize, and inspect all three ready supplements.
- [ ] Present date, amount, intake public ID, filename, and ready supplement public ID without exposing signed URLs, object keys, raw account data, or full references.
- [ ] Obtain a fresh explicit human confirmation for the three exact mappings.
- [ ] Record each supplement with reason `operator_omission` and stable idempotency keys.
- [ ] Re-inspect payment history and contract state, proving all three supplemental slips are visible and payment amounts/components/schedules/balances are unchanged.
