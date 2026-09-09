# ChatGPT Payment-Slip Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store ChatGPT-attached payment slips as verified evidence, require them before image-first posts, retain late proof append-only, and preview ready slips from contract history.

**Architecture:** A server-side importer streams an OpenAI file parameter only from a configured HTTPS host into MinIO and verifies its checksum and metadata. A supplemental-evidence ledger records post-hoc proof without changing financial rows. The transaction reader returns safe file UUID summaries, and the existing signed-access preview component renders them.

**Tech Stack:** Bun, TypeScript, Elysia, Drizzle/PostgreSQL, S3 SDK/MinIO, Zod, MCP SDK, React, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-06-chatgpt-payment-slip-ingestion-design.md`

## Global Constraints

- Keep money as backend-owned two-decimal strings; this feature must not calculate money.
- Do not log, persist, return, or audit raw bytes, file IDs, temporary URLs, signed URLs, storage keys, QR data, or headers.
- Accept JPEG/PNG/PDF only, enforce `EVIDENCE_MAX_BYTES`, require HTTPS/OpenAI allowlisted hosts, and reject redirects.
- Keep existing direct `evidence.prepare` / `evidence.finalize` behavior for Web users.
- Posted financial rows and ready evidence stay immutable; late evidence is a separate append-only record.
- Every write has actor/source, request/correlation IDs, audit data, and stable idempotency where retriable.
- Update Thai and English copy together. Update `CHANGELOG.md` under `v0.3.71 - 2026-09-06` before each commit; stage only task files.

---

### Task 1: Add evidence-required and supplemental-evidence persistence

**Files:**
- Create: `backend/drizzle/0061_chatgpt_payment_evidence.sql`
- Modify: `backend/drizzle/meta/_journal.json`
- Modify: `backend/src/db/schema.ts`
- Create: `backend/src/db/chatgpt-payment-evidence-migration.test.ts`

**Interfaces:**
- Add `paymentIntakes.evidenceRequired: boolean`.
- Add `paymentEvidenceSupplements` with statuses `draft | ready | recorded` and reasons `upload_channel_unavailable | operator_omission | evidence_recovered | other`.

- [ ] **Step 1: Write failing migration tests**

```ts
integrationTest("recorded supplement cannot update/delete and leaves payment financial rows unchanged", async () => {});
integrationTest("reason other requires a non-blank note; standard reasons do not", async () => {});
```

- [ ] **Step 2: Run the test and observe failure**

Run: `cd backend && bun test src/db/chatgpt-payment-evidence-migration.test.ts`

Expected: FAIL because migration/schema mappings do not exist.

- [ ] **Step 3: Add the smallest additive migration**

Add `payment_intakes.evidence_required boolean NOT NULL DEFAULT false`. Create `payment_evidence_supplements` with tenant-scoped FKs to intake/file/users, public UUID, file hash/MIME/size, status, reason/note, idempotency key, actor/timestamps, audit/correlation fields, status/reason constraints, partial unique idempotency index, intake/status index, and triggers rejecting update/delete once `recorded`. Register it after user-owned migration `0060` without editing `0060`.

- [ ] **Step 4: Verify the migration test passes**

Run: `cd backend && bun test src/db/chatgpt-payment-evidence-migration.test.ts`

Expected: PASS.

- [ ] **Step 5: Changelog and commit**

```bash
git add CHANGELOG.md backend/drizzle/0061_chatgpt_payment_evidence.sql backend/drizzle/meta/_journal.json backend/src/db/schema.ts backend/src/db/chatgpt-payment-evidence-migration.test.ts
git commit -m "feat: add payment evidence supplement ledger"
```

### Task 2: Implement bounded ChatGPT-file evidence import

**Files:**
- Create: `backend/src/services/chatgpt-file-evidence-service.ts`
- Create: `backend/src/services/chatgpt-file-evidence-service.test.ts`
- Modify: `backend/src/lib/storage.ts`

**Interfaces:**

```ts
type ChatGptFileParam = { downloadUrl: string; fileId: string; mimeType?: string | null; fileName?: string | null };
importChatGptPaymentEvidence(ctx, intakePublicId, file, idempotencyKey): Promise<SafeEvidenceResult>;
importChatGptSupplementEvidence(ctx, intakePublicId, file, idempotencyKey): Promise<SafeEvidenceResult>;
```

- [ ] **Step 1: Write failing service tests**

```ts
test("streams a trusted HTTPS ChatGPT file to MinIO and returns only public IDs, MIME, size, hash, audit and correlation IDs", async () => {});
test("rejects untrusted host, HTTP, redirect, unsupported MIME, oversize body, and storage mismatch", async () => {});
test("identical idempotency retry returns original ready evidence without persisting temporary URL or file ID", async () => {});
test("primary import rejects posted intake; supplementary draft import permits exact posted intake", async () => {});
```

- [ ] **Step 2: Run the test and observe failure**

Run: `cd backend && bun test src/services/chatgpt-file-evidence-service.test.ts`

Expected: FAIL because the importer is absent.

- [ ] **Step 3: Implement the importer with injected fetch/storage gateways**

Parse `downloadUrl`, require HTTPS and a hostname listed in `CHATGPT_FILE_DOWNLOAD_HOSTS`, call fetch with `redirect: "error"`, stream at most `EVIDENCE_MAX_BYTES`, identify/validate MIME, calculate SHA-256, upload server-side to a UUID object key, HEAD and verify tenant/intake metadata plus size/MIME/hash, then atomically mark primary evidence or supplement draft `ready`. Hash the external `fileId` only for idempotency comparison; never store it. Emit safe audit payloads only.

- [ ] **Step 4: Verify focused tests and typecheck**

Run: `cd backend && bun test src/services/chatgpt-file-evidence-service.test.ts && bunx tsc --noEmit`

Expected: PASS.

- [ ] **Step 5: Changelog and commit**

```bash
git add CHANGELOG.md backend/src/lib/storage.ts backend/src/services/chatgpt-file-evidence-service.ts backend/src/services/chatgpt-file-evidence-service.test.ts
git commit -m "feat: ingest ChatGPT payment evidence securely"
```

### Task 3: Make evidence readiness authoritative and expose MCP commands

**Files:**
- Modify: `backend/src/services/payment-service.ts`
- Modify: `backend/src/services/payment-batch-service.ts`
- Modify: `backend/src/services/payment-service.test.ts`
- Modify: `backend/src/services/payment-batch-service.test.ts`
- Modify: `backend/src/mcp/server.ts`
- Modify: `backend/src/mcp/default.ts`
- Modify: `backend/src/mcp/server.test.ts`
- Modify: `backend/src/mcp/default.test.ts`

**Interfaces:**
- Add `EVIDENCE_REQUIRED_NOT_READY` gate to payment preview, preflight, post, batch preview, and batch execute.
- Add `evidence.import-chatgpt-file`, `payment.evidence-supplement.import-chatgpt-file`, `payment.evidence-supplement.record`.

- [ ] **Step 1: Write failing domain and MCP tests**

```ts
integrationTest("image-required intake cannot preview, preflight, or post without ready primary evidence", async () => {});
integrationTest("ready imported evidence permits normal payment; data-only payment remains unchanged", async () => {});
test("file tools advertise a complete top-level file parameter and never expose download_url/file_id", async () => {});
test("record command requires confirmed true, valid reason/note, and stable idempotency key", async () => {});
```

- [ ] **Step 2: Run the focused tests and observe failure**

Run: `cd backend && bun test src/services/payment-service.test.ts src/services/payment-batch-service.test.ts src/mcp/server.test.ts src/mcp/default.test.ts`

Expected: FAIL because readiness gates and tools are absent.

- [ ] **Step 3: Implement one locked readiness predicate and closed tool schemas**

Use a shared predicate under existing intake locks: when `evidenceRequired` is true it requires a ready primary `payment_evidence`, never a supplement. Apply it before writing proposals/preflight/post and use equivalent all-item logic in batches. Register the new tool names in all MCP maps. The top-level `chatgptFile` schema must require `download_url` and `file_id`, declare optional `mime_type`/`file_name`, and set `_meta["openai/fileParams"] = ["chatgptFile"]`. Map snake case at the adapter boundary, return safe result presenters only, and classify all commands destructive with accurate idempotency annotations.

- [ ] **Step 4: Regenerate contract and run focused verification**

Run: `cd backend && bun test src/services/payment-service.test.ts src/services/payment-batch-service.test.ts src/mcp/server.test.ts src/mcp/default.test.ts && bunx tsc --noEmit && cd ../plugins/creditsync && bun run scripts/mcp-contract.ts --write`

Expected: PASS and only the frozen MCP contract changes from the generator.

- [ ] **Step 5: Changelog and commit**

```bash
git add CHANGELOG.md backend/src/services/payment-service.ts backend/src/services/payment-batch-service.ts backend/src/services/payment-service.test.ts backend/src/services/payment-batch-service.test.ts backend/src/mcp/server.ts backend/src/mcp/default.ts backend/src/mcp/server.test.ts backend/src/mcp/default.test.ts plugins/creditsync/references/mcp-tool-contract.json
git commit -m "feat: require and import ChatGPT payment evidence"
```

### Task 4: Return safe evidence summaries and show slips in contract history

**Files:**
- Create: `backend/src/services/payment-evidence-read-service.ts`
- Create: `backend/src/services/payment-evidence-read-service.test.ts`
- Modify: `backend/src/modules/transactions.ts`
- Create: `backend/src/modules/transactions.test.ts`
- Modify: `frontend/src/pages/dashboard/loans/LoanPaymentHistoryTab.tsx`
- Create: `frontend/tests/loan-payment-history-evidence.vitest.tsx`
- Modify: `frontend/src/locales/en.json`
- Modify: `frontend/src/locales/th.json`

**Interfaces:**

```ts
type SafePaymentEvidenceSummary = {
  publicId: string; filePublicId: string; mimeType: string;
  source: "primary" | "supplement";
  reason?: "upload_channel_unavailable" | "operator_omission" | "evidence_recovered" | "other";
};
```

- [ ] **Step 1: Write failing backend and rendered UI tests**

```ts
test("transaction history returns only ready primary and recorded supplement file UUIDs for authorized tenant rows", async () => {});
test("summary omits pending/rejected evidence, hashes, URLs, keys, and other tenants", async () => {});
it("shows primary and labelled supplemental slip buttons and resolves a signed file URL only after click", async () => {});
it("shows no button when no ready evidence exists", async () => {});
```

- [ ] **Step 2: Run the tests and observe failure**

Run: `cd backend && bun test src/services/payment-evidence-read-service.test.ts src/modules/transactions.test.ts && cd ../frontend && bun test tests/loan-payment-history-evidence.vitest.tsx`

Expected: FAIL because transaction `evidence` and table buttons do not exist.

- [ ] **Step 3: Implement batched safe reader and table buttons**

Query primary/supplement records and their file rows in tenant-scoped batches for already-authorized transaction intake IDs. Add `evidence: SafePaymentEvidenceSummary[]` to `GET /transactions`; retain legacy `slipUrl` behavior. In `LoanPaymentHistoryTab`, add a localized Slip column and one existing `EvidencePreviewButton` per summary using `resolveFileAccess(filePublicId)`. Do not cache access URLs in the row model. Add Thai/English copy for primary, supplemental, reason values, view slip, and unavailable evidence.

- [ ] **Step 4: Verify focused frontend/backend tests, lint, and build**

Run: `cd backend && bun test src/services/payment-evidence-read-service.test.ts src/modules/transactions.test.ts && bunx tsc --noEmit && cd ../frontend && bun test tests/loan-payment-history-evidence.vitest.tsx && bun run lint && bun run build`

Expected: PASS.

- [ ] **Step 5: Changelog and commit**

```bash
git add CHANGELOG.md backend/src/services/payment-evidence-read-service.ts backend/src/services/payment-evidence-read-service.test.ts backend/src/modules/transactions.ts backend/src/modules/transactions.test.ts frontend/src/pages/dashboard/loans/LoanPaymentHistoryTab.tsx frontend/tests/loan-payment-history-evidence.vitest.tsx frontend/src/locales/en.json frontend/src/locales/th.json
git commit -m "feat: preview payment slips from loan history"
```

### Task 5: Synchronize plugin, config, full verification, and real ChatGPT test

**Files:**
- Modify: `plugins/creditsync/.codex-plugin/plugin.json`
- Modify: `plugins/creditsync/README.md`
- Modify: `plugins/creditsync/CHANGELOG.md`
- Modify: `plugins/creditsync/skills/creditsync/SKILL.md`
- Modify: `plugins/creditsync/skills/reconcile-payments/SKILL.md`
- Modify: `plugins/creditsync/references/error-recovery.md`
- Modify: `plugins/creditsync/evals/evals.json`
- Modify: `plugins/creditsync/evals/harness.ts`
- Modify: `backend/.env.example`, `.env.example`

- [ ] **Step 1: Write failing plugin tests/evals**

```ts
test("contract and skills require ChatGPT file import before image-first preview/post", async () => {});
test("late supplement is recorded only after explicit confirmation and includes no file URL/ID in output", async () => {});
```

- [ ] **Step 2: Run plugin tests and observe failure**

Run: `cd plugins/creditsync && bun test tests/plugin-contract.test.ts tests/eval-harness.test.ts`

Expected: FAIL because new commands/scenarios are undocumented.

- [ ] **Step 3: Synchronize artifacts and add non-secret config documentation**

Increment plugin `8.0.0 → 8.1.0`, document import-before-preview/post and late-evidence confirmation/retry, add positive/negative executable evals, update error recovery, and add only a documented placeholder for `CHATGPT_FILE_DOWNLOAD_HOSTS` to examples. Never commit live host allowlists, credentials, URLs, or files.

- [ ] **Step 4: Run full verification**

Run: `cd backend && ./scripts/test-disposable-postgres.sh && bunx tsc --noEmit && cd ../frontend && bun test && bun run lint && bun run build && cd ../plugins/creditsync && bun test && bun run scripts/validate.ts`

Expected: all PASS. Stop and report any existing unrelated failure without weakening the gate.

- [ ] **Step 5: Controlled ChatGPT acceptance and final commit**

Use only a controlled non-financial tenant: attach one slip in ChatGPT, import it, retry identical import, preview/post, and open it from contract history. Separately record `upload_channel_unavailable` supplemental evidence against a controlled posted intake and prove transaction/schedule/balance counts do not change. Update changelogs, then commit scoped plugin/config changes:

```bash
git add CHANGELOG.md backend/.env.example .env.example plugins/creditsync
git commit -m "docs: synchronize ChatGPT evidence workflow"
```

## Plan Self-Review

- Tasks 1–5 cover every spec requirement: persistence, secure import/retry, backend posting gate, closed MCP file metadata, append-only late evidence, safe read model, contract UI, plugin synchronization, and controlled acceptance.
- All later types use the exact names introduced above: `ChatGptFileParam`, `SafePaymentEvidenceSummary`, `paymentEvidenceSupplements`, and the three MCP tool names.
- No task directs an engineer to mutate existing posted financial records or to log raw evidence data.
