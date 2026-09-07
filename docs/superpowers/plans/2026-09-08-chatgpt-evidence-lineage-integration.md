# ChatGPT Evidence Production-Lineage Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate the already-deployed ChatGPT payment-evidence feature into `main` while preserving both deployed migration hashes and all scheduled-payment allocation-correction safeguards.

**Architecture:** Start from current `main` in an isolated worktree and port the seven evidence commits in order, resolving shared files by composition instead of selecting one branch wholesale. Rebuild the local migration manifest and reconciliation verifier around the exact production hashes/timestamps, regenerate the combined MCP/plugin contract, then verify the merged application and production lineage without mutating financial records.

**Tech Stack:** Bun, TypeScript, Elysia, Drizzle/PostgreSQL, MinIO/S3 SDK, MCP SDK, React, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-09-08-chatgpt-evidence-lineage-integration-design.md`

## Global Constraints

- Preserve production migration hash `ba93514fd771bc17f323e32a20b88eb8850ffa219ca5d554ab2149642cb22230` at timestamp `1788739200000`.
- Preserve allocation-correction migration hash `10eb2edfb20fabb9718d6038c44f9c3748909bf59be455d30d60f9259969a39f` at timestamp `1788811800000`.
- Never edit/delete production journal rows or mutate payment amounts, transactions, allocations, schedules, balances, or evidence history.
- Preserve allocation-correction stale-state, dependency, exact-decimal, tenant, immutability, and idempotency-request-hash protections.
- Never log or return raw evidence bytes, ChatGPT file IDs/download URLs, signed URLs, storage keys, bearer tokens, QR payloads, or full financial identifiers.
- Use `decimal.js` for financial calculations; this integration must not add client-side or agent-side money calculation.
- Update `CHANGELOG.md` before every implementation commit and update `README.md` when the combined user workflow or setup changes.
- Do not merge, push, deploy, refresh the private ChatGPT app, or create controlled/live records without explicit user authorization after branch verification.

---

### Task 1: Create the isolated integration branch and establish failing lineage tests

**Files:**
- Create: `backend/src/db/chatgpt-payment-evidence-migration.test.ts`
- Modify: `backend/src/db/payment-allocation-correction-migration.test.ts`
- Modify: `backend/src/db/production-mixed-lineage-reconciliation.integration.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: current `main` at or after `fad4cab`; source commits `b01dbed`, `c6e3a5d`, `3a03636`, `e0288bb`, `0783428`, `8d4d0fd`, `456d410`.
- Produces: tests that identify exact evidence/allocation migration hashes, timestamps, order, and production-superset acceptance.

- [ ] **Step 1: Create a worktree using the required isolation workflow**

Run `superpowers:using-git-worktrees`, verify `.worktrees/` is ignored, then create branch `codex/chatgpt-evidence-lineage-integration` from `main` at `/home/flintstone/github/CreditSync/.worktrees/chatgpt-evidence-lineage-integration`.

- [ ] **Step 2: Record the immutable source and production state**

Run:

```bash
git merge-base main codex/chatgpt-evidence-upload
git log --reverse --oneline 96aba6cf200ae7ddeabfa2fed8438e89f49eaa21..codex/chatgpt-evidence-upload
git show codex/chatgpt-evidence-upload:backend/drizzle/0061_chatgpt_payment_evidence.sql | sha256sum
sha256sum backend/drizzle/0061_scheduled_payment_allocation_corrections.sql
```

Expected: the seven commits listed above and the two hashes in Global Constraints.

- [ ] **Step 3: Write failing combined-lineage assertions**

Add assertions equivalent to:

```ts
expect(entries.filter((entry) => entry.tag.includes("chatgpt_payment_evidence"))).toHaveLength(1);
expect(entries.filter((entry) => entry.tag.includes("scheduled_payment_allocation_corrections"))).toHaveLength(1);
expect(chatgpt.when).toBe(1788739200000);
expect(allocation.when).toBe(1788811800000);
expect(chatgpt.when).toBeLessThan(allocation.when);
```

Add a mixed-lineage fixture containing the three recognized legacy tail hashes followed by the exact ChatGPT and allocation hashes; require `already-complete`. Add negative fixtures for unknown hash, changed timestamp, duplicate hash, and reversed evidence/allocation order.

- [ ] **Step 4: Run tests to prove the lineage tests fail**

Run:

```bash
backend/scripts/test-disposable-postgres.sh \
  src/db/chatgpt-payment-evidence-migration.test.ts \
  src/db/payment-allocation-correction-migration.test.ts \
  src/db/production-mixed-lineage-reconciliation.integration.test.ts
```

Expected: FAIL because `main` has no ChatGPT evidence migration/source and the strict verifier does not recognize the combined production lineage.

- [ ] **Step 5: Commit only the red tests**

Update `CHANGELOG.md` under a new `v0.3.96 - 2026-09-08` `### Changed` entry, then run:

```bash
git add CHANGELOG.md backend/src/db/chatgpt-payment-evidence-migration.test.ts backend/src/db/payment-allocation-correction-migration.test.ts backend/src/db/production-mixed-lineage-reconciliation.integration.test.ts
git commit -m "test: define combined evidence migration lineage"
```

### Task 2: Port persistence and secure import with exact deployed migration identity

**Files:**
- Create: `backend/drizzle/0061_chatgpt_payment_evidence.sql` (exact bytes from source commit)
- Modify: `backend/drizzle/meta/_journal.json`
- Modify: `backend/src/db/schema.ts`
- Create: `backend/src/services/chatgpt-file-evidence-service.ts`
- Create: `backend/src/services/chatgpt-file-evidence-service.test.ts`
- Modify: `backend/src/lib/storage.ts`
- Modify: `backend/src/db/chatgpt-payment-evidence-migration.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces `paymentIntakes.evidenceRequired`, `paymentEvidenceSupplements`, `ChatGptFileParam`, `importChatGptPaymentEvidence(...)`, and `importChatGptSupplementEvidence(...)` exactly as specified by `2026-09-06-chatgpt-payment-slip-ingestion-design.md`.
- Preserves existing allocation-correction schema mappings in `backend/src/db/schema.ts`.

- [ ] **Step 1: Port commits `b01dbed` and `c6e3a5d` without committing conflicts**

Run `git cherry-pick --no-commit b01dbed` followed by `git cherry-pick --no-commit c6e3a5d`. Resolve `schema.ts`, storage, changelog, and migration metadata by retaining both feature sets. Never resolve the migration journal with `--ours` or `--theirs` wholesale.

- [ ] **Step 2: Rebuild the journal tail explicitly**

Ensure the tail contains unique indexes and monotonic timestamps:

```json
{
  "idx": 61,
  "version": "7",
  "when": 1788739200000,
  "tag": "0061_chatgpt_payment_evidence",
  "breakpoints": true
},
{
  "idx": 62,
  "version": "7",
  "when": 1788811800000,
  "tag": "0062_scheduled_payment_allocation_corrections",
  "breakpoints": true
}
```

Rename only the allocation migration filename/tag to `0062_scheduled_payment_allocation_corrections`; do not alter its SQL bytes. Verify both hashes with `sha256sum`.

- [ ] **Step 3: Verify secure-import invariants in focused tests**

Tests must cover trusted HTTPS allowlist, redirect rejection, bounded size, MIME/checksum verification, storage failure cleanup, identical retry, mismatched-idempotency rejection, primary-posted-intake rejection, supplement-posted-intake acceptance, and omission of raw URL/file ID from persistence/log/result.

- [ ] **Step 4: Run focused database/service tests**

Run:

```bash
backend/scripts/test-disposable-postgres.sh src/db/chatgpt-payment-evidence-migration.test.ts src/db/payment-allocation-correction-migration.test.ts src/services/chatgpt-file-evidence-service.test.ts src/services/payment-allocation-correction-service.test.ts
cd backend && bun run typecheck
```

Expected: all PASS; both SQL hashes equal Global Constraints.

- [ ] **Step 5: Commit persistence and importer**

Update the current changelog entry, then stage only Task 2 files and run:

```bash
git commit -m "feat: integrate ChatGPT payment evidence persistence"
```

### Task 3: Compose payment gates, MCP handlers, and frozen contracts

**Files:**
- Modify: `backend/src/services/payment-service.ts`
- Modify: `backend/src/services/payment-service.test.ts`
- Modify: `backend/src/services/payment-batch-service.ts`
- Modify: `backend/src/services/payment-reconciliation-service.ts`
- Modify: `backend/src/mcp/server.ts`
- Modify: `backend/src/mcp/server.test.ts`
- Modify: `backend/src/mcp/default.ts`
- Modify: `backend/src/mcp/default.test.ts`
- Modify: `backend/src/mcp/contract-snapshot.ts`
- Modify: `plugins/creditsync/references/mcp-tool-contract.json`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Adds `evidence.import-chatgpt-file`, `payment.evidence-supplement.import-chatgpt-file`, and `payment.evidence-supplement.record`.
- Retains `payment.allocation-correction.preview` and `payment.allocation-correction.execute` with their closed schemas and destructive annotations.

- [ ] **Step 1: Write/retain conflict tests before composing handlers**

Require `EVIDENCE_REQUIRED_NOT_READY` for image-required preview/preflight/post and batch operations, retain data-only behavior, and assert the complete MCP catalog contains all five evidence/allocation tools exactly once. Assert tool outputs contain no `download_url`, `file_id`, storage key, signed URL, or raw evidence bytes.

- [ ] **Step 2: Port commit `3a03636` without committing conflicts**

Run `git cherry-pick --no-commit 3a03636`. Resolve shared payment/MCP files by adding evidence checks under existing transaction locks while preserving allocation-correction locking, dependency validation, decimal-string conservation, and request-hash replay behavior.

- [ ] **Step 3: Regenerate the combined contract from source**

Run the repository's MCP contract generator identified by `rg -n "mcp-contract.*write" plugins/creditsync backend package.json`. Do not copy either branch's frozen JSON over the other. Verify the generated catalog contains both tool families and remains closed.

- [ ] **Step 4: Run focused tests**

Run:

```bash
backend/scripts/test-disposable-postgres.sh src/services/payment-service.test.ts src/services/payment-allocation-correction-service.test.ts src/mcp/server.test.ts src/mcp/default.test.ts
cd backend && bun run typecheck
```

Expected: all PASS with no skipped database invariant introduced by this task.

- [ ] **Step 5: Commit combined domain and MCP behavior**

Update `CHANGELOG.md`, stage Task 3 files, and run:

```bash
git commit -m "feat: compose evidence and allocation MCP workflows"
```

### Task 4: Integrate safe evidence history and frontend presentation

**Files:**
- Create: `backend/src/services/payment-evidence-read-service.ts`
- Create: `backend/src/services/payment-evidence-read-service.test.ts`
- Modify: `backend/src/modules/transactions.ts`
- Create: `backend/src/modules/transactions.test.ts`
- Modify: `frontend/src/pages/dashboard/loans/LoanPaymentHistoryTab.tsx`
- Create: `frontend/tests/loan-payment-history-evidence.vitest.tsx`
- Modify: `frontend/src/locales/en.json`
- Modify: `frontend/src/locales/th.json`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces `SafePaymentEvidenceSummary` with public IDs, MIME, source, and optional supplement reason only.
- Uses the existing authenticated `resolveFileAccess(filePublicId)` path after click.

- [ ] **Step 1: Port commit `e0288bb` without committing conflicts**

Run `git cherry-pick --no-commit e0288bb`. Preserve current repayment-history lineage and allocation-correction UI/release metadata where shared files overlap.

- [ ] **Step 2: Verify safe read-model tests fail before final resolution**

Require tenant-scoped batching, recorded/ready-only evidence, no pending evidence, no checksums/URLs/storage keys, and no cross-tenant rows. Frontend tests must require localized primary/supplement labels and defer signed access URL creation until click.

- [ ] **Step 3: Resolve and implement the minimum combined presentation**

Return only:

```ts
type SafePaymentEvidenceSummary = {
  publicId: string;
  filePublicId: string;
  mimeType: string;
  source: "primary" | "supplement";
  reason?: "upload_channel_unavailable" | "operator_omission" | "evidence_recovered" | "other";
};
```

Update Thai and English keys together and use the active i18n language.

- [ ] **Step 4: Run focused backend/frontend tests**

Run:

```bash
backend/scripts/test-disposable-postgres.sh src/services/payment-evidence-read-service.test.ts src/modules/transactions.test.ts
cd backend && bun run typecheck
cd ../frontend && bun test tests/loan-payment-history-evidence.vitest.tsx && bun run lint && bun run build
```

Expected: all PASS.

- [ ] **Step 5: Commit the history presentation**

Update `CHANGELOG.md`, stage Task 4 files, and run:

```bash
git commit -m "feat: expose safe payment evidence history"
```

### Task 5: Synchronize plugin, release metadata, and strict reconciliation

**Files:**
- Modify: `plugins/creditsync/.codex-plugin/plugin.json`
- Modify: `plugins/creditsync/README.md`
- Modify: `plugins/creditsync/CHANGELOG.md`
- Modify: `plugins/creditsync/evals/evals.json`
- Modify: `plugins/creditsync/evals/harness.ts`
- Modify: `plugins/creditsync/references/error-recovery.md`
- Modify: `plugins/creditsync/skills/creditsync/SKILL.md`
- Modify: `plugins/creditsync/skills/reconcile-payments/SKILL.md`
- Modify: `plugins/creditsync/scripts/validate.ts`
- Modify: `plugins/creditsync/tests/eval-harness.test.ts`
- Modify: `plugins/creditsync/tests/plugin-contract.test.ts`
- Modify: `backend/scripts/reconcile-production-mixed-lineage.ts`
- Modify: `backend/src/db/production-mixed-lineage-reconciliation.integration.test.ts`
- Modify: `backend/.env.example`
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `frontend/src/lib/release.ts`
- Modify: `frontend/src/lib/release.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces one plugin release whose tool count/schema includes both evidence and allocation-correction workflows.
- Produces a reconciliation verifier that accepts only enumerated exact lineage manifests.

- [ ] **Step 1: Port commits `0783428`, `8d4d0fd`, and `456d410` without committing conflicts**

Run each `git cherry-pick --no-commit` in order. Combine plugin scenarios and tests; never retain duplicate scenario names, duplicate documentation rows, or stale tool counts.

- [ ] **Step 2: Implement exact lineage manifests**

Represent supported journal tails as explicit arrays of `{ hash, createdAt }`, including the established three legacy hashes, ChatGPT evidence hash, and allocation hash. Reject unknown, duplicate, missing, or reordered rows before any reconciliation action. Map each accepted count to the exact catalog fingerprint it verifies; do not cast an unverified count to an older schema state.

- [ ] **Step 3: Regenerate and validate the combined plugin**

Advance plugin/frontend release metadata once. Run the contract generator, then:

```bash
cd plugins/creditsync
bun test
bun run validate
python3 /home/flintstone/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py .
```

Expected: all PASS; catalog includes every evidence/allocation tool exactly once and no secret/config value.

- [ ] **Step 4: Compare the preserved pre-merge stash**

Use `git stash show -p stash@{0}` read-only. Record whether each added assertion or recovery rule is present semantically in the combined files. Do not apply or drop the stash automatically. Report any unique user-authored behavior as a blocker requiring user selection.

- [ ] **Step 5: Commit synchronization and strict reconciliation**

Update root/plugin changelogs and README, stage Task 5 files, and run:

```bash
git commit -m "feat: reconcile ChatGPT evidence production lineage"
```

### Task 6: Full verification, independent review, and deployment handoff

**Files:**
- Verify all files changed by Tasks 1–5.
- Modify only files required to fix findings; each fix must include `CHANGELOG.md` and a focused regression test.

**Interfaces:**
- Produces a clean, reviewed feature branch ready for an explicit merge/deploy decision.

- [ ] **Step 1: Run the full required gates**

Run serially for the database suite and independently for non-database gates:

```bash
backend/scripts/test-disposable-postgres.sh
cd backend && bun run typecheck
cd ../frontend && bun test && bun run lint && bun run build
cd ../plugins/creditsync && bun test && bun run validate
python3 /home/flintstone/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py .
git diff --check
git status --short
```

Expected: all tests pass, no database test required for a changed invariant is skipped, and the worktree is clean after commits.

- [ ] **Step 2: Perform independent review**

Review `main...HEAD` for migration replay safety, production hash identity, tenant isolation, immutable financial/evidence rows, idempotency concurrency, SSRF/redirect/size/MIME defenses, output redaction, MCP schema closure, plugin version/tool-count consistency, and preservation of allocation-correction safeguards. Fix every validated P0/P1/P2 finding with a regression test and rerun affected gates.

- [ ] **Step 3: Verify production read-only before handoff**

Query only `drizzle.__drizzle_migrations`, `information_schema`, MCP health, and frontend HTTP status. Require both exact hashes once, the expected evidence/allocation tables and columns, backend health 200, and frontend 200. Do not create an acceptance payment/evidence record.

- [ ] **Step 4: Present branch integration choices**

Use `superpowers:finishing-a-development-branch`. Default to keeping the isolated branch/worktree. Merge only if the user explicitly chooses local merge; push/PR only if explicitly chosen.

- [ ] **Step 5: Deploy only after explicit authorization**

After merge authorization and merged-result verification, start infra and rebuild app with:

```bash
docker compose --env-file .env.production -f docker-compose.infra.yml up -d
docker compose --env-file .env.production -f docker-compose.app.yml up --build -d
```

Post-deploy, require migration logs to show success without duplicate DDL, no unexpected journal row, exact table/column checks, MCP health 200, frontend 200, and healthy containers. If any condition fails, stop and report; do not edit the production journal.
