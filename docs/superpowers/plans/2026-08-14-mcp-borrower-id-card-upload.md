# MCP Borrower ID-Card Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add tenant-bound signed identity-card image upload and idempotent application of Codex-extracted borrower identity fields through REST, Web, MCP, and CreditSync Plugin `8.0.0`.

**Architecture:** A dedicated `borrower_id_card_upload_intents` ledger binds each stored file to one tenant and borrower through `pending → ready → applied`. A focused borrower ID-card service owns prepare, storage verification, Thai ID validation, atomic apply, masked audit history, and replay behavior; REST and MCP adapt directly to that service. The Web form uses the same prepare/direct-PUT/finalize lifecycle while MCP adds three closed-schema tools and synchronizes the frozen 67-tool plugin contract.

**Tech Stack:** Bun, TypeScript, Elysia, Drizzle ORM/PostgreSQL, MinIO-compatible signed PUT storage, React, Vitest/Testing Library, Model Context Protocol SDK, Zod.

## Global Constraints

- Use Bun for installs, tests, typechecks, scripts, and builds.
- Public money rules are unchanged; do not introduce JavaScript-number handling into financial paths.
- Use `Asia/Bangkok` for business dates and ISO 8601 timestamps.
- Never print, log, summarize, or persist raw OCR text, signed URLs outside prepare responses, storage keys, bearer tokens, or unmasked identity-card values in audit/readable output.
- MCP calls application services directly and never calls REST internally.
- Every write carries command context, request/correlation ID, actor/source, and append-only audit history; apply requires a stable idempotency key.
- The workflow order is exact borrower resolution → local Codex extraction/validation → prepare → unchanged-byte signed PUT → finalize → apply.
- MIME types are exactly `image/jpeg` and `image/png`; size is bounded by `EVIDENCE_MAX_BYTES`; SHA-256 is 64 hexadecimal characters.
- Apply requires non-empty `name`, `address`, and a valid 13-digit Thai identity-card checksum; failure keeps the verified image but leaves the borrower unchanged and returns `reviewRequired`.
- Update `frontend/src/locales/en.json` and `frontend/src/locales/th.json` together for user-facing copy.
- CreditSync Plugin becomes `8.0.0`, MCP schema remains `1.0`, and the frozen catalogue grows from 64 to 67 tools.
- Before every commit, update `CHANGELOG.md`; feature, workflow, or infrastructure commits also update `README.md` when applicable and stage those documents with the change.
- Preserve unrelated dirty frontend changes; stage only files owned by the current task.

---

## File Structure

- `backend/src/lib/thai-national-id.ts`: normalization, checksum validation, and masking with no database or transport dependencies.
- `backend/src/lib/thai-national-id.test.ts`: pure validation/masking regressions.
- `backend/src/db/schema.ts`: Drizzle definition for borrower identity-card upload intents and tenant-safe references.
- `backend/drizzle/0037_borrower_id_card_upload_intents.sql`: additive table, indexes, constraints, and immutability trigger.
- `backend/drizzle/meta/0037_snapshot.json`, `backend/drizzle/meta/_journal.json`: generated migration metadata.
- `backend/src/services/borrower-id-card-service.ts`: prepare, finalize, apply, replay, storage binding, privacy-safe presentation, and audits.
- `backend/src/services/borrower-id-card-service.test.ts`: disposable-PostgreSQL behavior and database-boundary tests.
- `backend/src/modules/borrowers.ts`: authenticated REST adapters for prepare/finalize/apply.
- `backend/src/modules/borrowers.test.ts`: closed REST schemas, auth, ordering, and safe output regressions.
- `backend/src/mcp/server.ts`: three names, Zod schemas, descriptions, annotations, and safe output definitions.
- `backend/src/mcp/default.ts`: direct service adapters and injectable storage dependency.
- `backend/src/mcp/server.test.ts`, `backend/src/mcp/default.test.ts`: metadata, contract, service wiring, and output safety.
- `frontend/src/lib/borrower-id-card-upload.ts`: digest, prepare, direct PUT, and finalize orchestration independent of React.
- `frontend/src/lib/borrower-id-card-upload.test.ts`: direct PUT and failure ordering tests.
- `frontend/src/pages/dashboard/borrowers/BorrowerForm.tsx`: adopt the new upload orchestrator and retain human field review.
- `frontend/tests/borrower-form.vitest.tsx`: UI state, retry, and localization regressions.
- `frontend/src/locales/en.json`, `frontend/src/locales/th.json`: synchronized upload/review copy.
- `plugins/creditsync/skills/manage-borrowers/SKILL.md`: exact agent workflow and stop boundaries; create the focused skill if the package currently lacks one and register it in plugin metadata.
- `plugins/creditsync/evals/evals.json`, `plugins/creditsync/evals/harness.ts`: positive/negative ordered workflow fixtures and forbidden effects.
- `plugins/creditsync/references/mcp-tool-contract.json`: regenerated authenticated 67-tool snapshot.
- `plugins/creditsync/.codex-plugin/plugin.json`, `plugins/creditsync/README.md`, `plugins/creditsync/CHANGELOG.md`: plugin `8.0.0` metadata and operator documentation.
- `plugins/creditsync/scripts/validate.ts`, `plugins/creditsync/tests/plugin-contract.test.ts`, `plugins/creditsync/tests/eval-harness.test.ts`, `plugins/creditsync/tests/operations-docs.test.ts`: 67-tool/version/skill/eval gates.
- `README.md`, `CHANGELOG.md`: project workflow and release record.

---

### Task 1: Pure Thai Identity Validation and Redaction

**Files:**
- Create: `backend/src/lib/thai-national-id.ts`
- Create: `backend/src/lib/thai-national-id.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces: `normalizeThaiNationalId(value: string): string | null`.
- Produces: `isValidThaiNationalId(value: string): boolean`.
- Produces: `maskThaiNationalId(value: string | null | undefined): string | null`.
- Normalized values are 13 ASCII digits; masking returns `x-xxxx-xxxxx-xx-N` without revealing the first 12 digits.

- [ ] **Step 1: Write failing pure tests**

```ts
import { describe, expect, test } from "bun:test";
import { isValidThaiNationalId, maskThaiNationalId, normalizeThaiNationalId } from "./thai-national-id";

describe("Thai national identity safety", () => {
    test("normalizes separators only when exactly thirteen digits remain", () => {
        expect(normalizeThaiNationalId("1-2345-67890-12-1")).toBe("1234567890121");
        expect(normalizeThaiNationalId("1234")).toBeNull();
    });

    test("validates the official weighted checksum", () => {
        expect(isValidThaiNationalId(validFixture)).toBe(true);
        expect(isValidThaiNationalId(`${validFixture.slice(0, 12)}${validFixture[12] === "0" ? "1" : "0"}`)).toBe(false);
    });

    test("masks every digit except the checksum digit", () => {
        expect(maskThaiNationalId(validFixture)).toBe(`x-xxxx-xxxxx-xx-${validFixture[12]}`);
        expect(maskThaiNationalId(null)).toBeNull();
    });
});
```

Use a synthetic checksum-valid fixture generated inside the test; never copy a real person's identifier into source control.

- [ ] **Step 2: Run the test and verify RED**

Run: `cd backend && bun test src/lib/thai-national-id.test.ts`

Expected: FAIL because `./thai-national-id` does not exist.

- [ ] **Step 3: Implement the minimal pure helper**

```ts
export function normalizeThaiNationalId(value: string): string | null {
    const digits = value.replace(/\D/g, "");
    return digits.length === 13 ? digits : null;
}

export function isValidThaiNationalId(value: string): boolean {
    const digits = normalizeThaiNationalId(value);
    if (!digits) return false;
    const sum = digits.slice(0, 12).split("").reduce((total, digit, index) => total + Number(digit) * (13 - index), 0);
    return (11 - (sum % 11)) % 10 === Number(digits[12]);
}

export function maskThaiNationalId(value: string | null | undefined): string | null {
    if (!value) return null;
    const digits = normalizeThaiNationalId(value);
    return digits ? `x-xxxx-xxxxx-xx-${digits[12]}` : null;
}
```

- [ ] **Step 4: Run focused and backend unit tests**

Run: `cd backend && bun test src/lib/thai-national-id.test.ts`

Expected: PASS with no raw fixture printed.

- [ ] **Step 5: Update changelog, stage exact files, and commit**

Add one concise `### Added` bullet under `v0.3.12`, then run:

```bash
git add CHANGELOG.md backend/src/lib/thai-national-id.ts backend/src/lib/thai-national-id.test.ts
git commit -m "feat: validate Thai borrower identity safely"
```

---

### Task 2: Tenant-Bound Upload-Intent Persistence and Database Immutability

**Files:**
- Modify: `backend/src/db/schema.ts`
- Create: `backend/drizzle/0037_borrower_id_card_upload_intents.sql`
- Create: `backend/drizzle/meta/0037_snapshot.json`
- Modify: `backend/drizzle/meta/_journal.json`
- Create: `backend/src/services/borrower-id-card-service.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces Drizzle table export `borrowerIdCardUploadIntents`.
- Status union at the service boundary: `"pending" | "ready" | "applied"`.
- Required columns: public/tenant/borrower/file IDs, status, evidence hash, MIME, declared size, upload expiry, finalized/applied timestamps, apply request hash, idempotency key, created/updated actor IDs, created/updated timestamps.
- Tenant-safe composite foreign keys use existing `(tenant_id, id)` uniqueness on borrowers/files or add the missing referenced uniqueness before defining them.

- [ ] **Step 1: Write failing database-boundary tests**

Add tests that seed two tenants and assert:

```ts
test("database rejects a file or borrower from another tenant", async () => {
    await expect(insertIntent({ tenantId: tenantA, borrowerId: borrowerA.id, fileId: fileB.id }))
        .rejects.toMatchObject({ code: "23503" });
});

test("database prevents mutation or deletion after apply", async () => {
    const applied = await seedAppliedIntent();
    await expect(db.update(borrowerIdCardUploadIntents).set({ evidenceHash: "b".repeat(64) }).where(eq(borrowerIdCardUploadIntents.id, applied.id)))
        .rejects.toThrow(/immutable/i);
    await expect(db.delete(borrowerIdCardUploadIntents).where(eq(borrowerIdCardUploadIntents.id, applied.id)))
        .rejects.toThrow(/immutable/i);
});
```

- [ ] **Step 2: Run on disposable PostgreSQL and verify RED**

Run: `cd backend && ./scripts/test-disposable-postgres.sh src/services/borrower-id-card-service.test.ts`

Expected: FAIL because the table export and migration are absent.

- [ ] **Step 3: Add the Drizzle table and generate migration metadata**

Use Drizzle definitions matching existing evidence-intent tables. Include unique indexes on `(tenant_id, evidence_hash)`, `(tenant_id, idempotency_key)` where non-null, and `(tenant_id, public_id)`. Generate with the project's Bun Drizzle command; do not hand-author the snapshot JSON.

- [ ] **Step 4: Add migration constraints and immutability trigger**

The SQL must include status checks, positive size, SHA-256 format, allowed MIME values, ready/applied timestamp consistency, and a trigger that permits only:

```text
pending -> pending  (upload expiry/actor timestamp refresh only)
pending -> ready    (finalized fields only)
ready   -> applied  (apply hash/key/timestamp/actor only)
```

It must reject binding-field changes and every delete of a ready/applied intent.

- [ ] **Step 5: Run disposable tests and migration lineage checks**

Run:

```bash
cd backend
./scripts/test-disposable-postgres.sh src/services/borrower-id-card-service.test.ts
bun test src/db/migration-lineage.test.ts
```

Expected: PASS; if the repository uses a differently named migration-lineage test, locate it with `rg --files src | rg 'migration.*test'` and run that exact file.

- [ ] **Step 6: Update changelog and commit exact persistence files**

```bash
git add CHANGELOG.md backend/src/db/schema.ts backend/drizzle/0037_borrower_id_card_upload_intents.sql backend/drizzle/meta/0037_snapshot.json backend/drizzle/meta/_journal.json backend/src/services/borrower-id-card-service.test.ts
git commit -m "feat: persist borrower ID card upload intents"
```

---

### Task 3: Prepare, Finalize, and Atomic Apply Service

**Files:**
- Create: `backend/src/services/borrower-id-card-service.ts`
- Modify: `backend/src/services/borrower-id-card-service.test.ts`
- Modify: `backend/src/services/borrower-service.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: `isValidThaiNationalId`, `normalizeThaiNationalId`, `maskThaiNationalId` from Task 1.
- Consumes: `borrowerIdCardUploadIntents` from Task 2.
- Produces:

```ts
export type BorrowerIdCardStorageGateway = {
    preparePut(request: SignedPutRequest): Promise<{ uploadUrl: string; expiresAt: Date; requiredHeaders?: Record<string, string> }>;
    head(key: string, bucket?: string): Promise<StoredObjectHead>;
};

export async function prepareBorrowerIdCard(
    ctx: CommandContext,
    borrowerPublicId: string,
    input: { mimeType: "image/jpeg" | "image/png"; size: number; sha256: string; originalName?: string | null },
    gateway?: BorrowerIdCardStorageGateway,
): Promise<BorrowerIdCardPrepareResult>;

export async function finalizeBorrowerIdCard(
    ctx: CommandContext,
    borrowerPublicId: string,
    intentPublicId: string,
    gateway?: BorrowerIdCardStorageGateway,
): Promise<BorrowerIdCardFinalizeResult>;

export async function applyBorrowerIdCardExtractedData(
    ctx: CommandContext,
    borrowerPublicId: string,
    input: { intentPublicId: string; name: string; idCardNumber: string; address: string },
): Promise<BorrowerIdCardApplyResult>;
```

- Apply reads the idempotency key only from `ctx.idempotencyKey`; public transport schemas may accept `idempotencyKey` and the MCP wrapper removes it into command context, matching existing financial commands.

- [ ] **Step 1: Extend failing service tests for prepare/finalize**

Cover identical pending retry, ready retry without `head`, conflicting checksum metadata, expired intent, cross-tenant borrower, object metadata mismatch, and safe output. The fake gateway must capture requests but never print signed URLs.

- [ ] **Step 2: Run focused disposable tests and verify RED**

Run: `cd backend && ./scripts/test-disposable-postgres.sh src/services/borrower-id-card-service.test.ts`

Expected: FAIL because service functions are absent.

- [ ] **Step 3: Implement minimal prepare/finalize service**

Use object keys of the form:

```ts
const key = `borrower-id-cards/${ctx.tenantId}/${borrower.publicId}/${intentPublicId}`;
```

Storage metadata must include exact tenant, borrower, and intent public UUIDs. Prepare inserts the file and intent transactionally before signing; signing failure removes only the still-pending rows created by that attempt. Finalize verifies all bound metadata before its `pending → ready` update and audit insert.

- [ ] **Step 4: Run prepare/finalize tests and verify GREEN**

Run: `cd backend && ./scripts/test-disposable-postgres.sh src/services/borrower-id-card-service.test.ts`

Expected: prepare/finalize cases PASS.

- [ ] **Step 5: Write failing apply tests**

Cover exact atomic update, required fields, invalid checksum, duplicate tenant identity, ready requirement, wrong borrower binding, identical replay, conflicting replay, masked audit payload, and rollback when audit insertion fails.

```ts
expect(result).toMatchObject({
    status: "applied",
    reviewRequired: false,
    changedFields: ["name", "idCardNumber", "address", "idCardImageUrl"],
});
expect(JSON.stringify(audit.payload)).not.toContain(validRawFixture);
```

- [ ] **Step 6: Run apply tests and verify RED**

Run: `cd backend && ./scripts/test-disposable-postgres.sh src/services/borrower-id-card-service.test.ts`

Expected: FAIL because apply is not implemented.

- [ ] **Step 7: Implement minimal atomic apply and masked audit**

Lock the borrower and intent in stable order, normalize/validate all inputs before update, enforce tenant uniqueness, hash the normalized command including borrower/intent UUIDs, and update borrower + intent + audit in one transaction. Return `reviewRequired: true` with safe error codes for incomplete or invalid extraction; do not partially update.

Factor an accessible borrower lookup from `borrower-service.ts` into an exported service helper rather than duplicating role/tenant access logic.

- [ ] **Step 8: Run focused and existing borrower tests**

Run:

```bash
cd backend
./scripts/test-disposable-postgres.sh src/services/borrower-id-card-service.test.ts src/services/borrower-service.test.ts
bun run typecheck
```

Expected: PASS.

- [ ] **Step 9: Update changelog and commit service files**

```bash
git add CHANGELOG.md backend/src/services/borrower-id-card-service.ts backend/src/services/borrower-id-card-service.test.ts backend/src/services/borrower-service.ts
git commit -m "feat: apply verified borrower ID card data"
```

---

### Task 4: Authenticated REST and Web Signed-Upload Migration

**Files:**
- Modify: `backend/src/modules/borrowers.ts`
- Modify: `backend/src/modules/borrowers.test.ts`
- Create: `frontend/src/lib/borrower-id-card-upload.ts`
- Create: `frontend/src/lib/borrower-id-card-upload.test.ts`
- Modify: `frontend/src/pages/dashboard/borrowers/BorrowerForm.tsx`
- Modify: `frontend/tests/borrower-form.vitest.tsx`
- Modify: `frontend/src/locales/en.json`
- Modify: `frontend/src/locales/th.json`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- REST endpoints:

```text
POST /borrowers/:id/id-card/upload-intents
POST /borrowers/:id/id-card/upload-intents/:intentId/finalize
POST /borrowers/:id/id-card/upload-intents/:intentId/apply
```

- `apply` receives `{ name, idCardNumber, address }` and requires `Idempotency-Key`.
- Frontend orchestrator:

```ts
export async function uploadBorrowerIdCard(input: {
    borrowerPublicId: string;
    file: File;
    apiClient?: typeof api;
    fetchImpl?: typeof fetch;
}): Promise<{ intentPublicId: string; filePublicId: string; status: "ready" }>;
```

- [ ] **Step 1: Write failing REST contract tests**

Assert auth, UUID params, closed bodies, MIME/size/SHA validation, command context headers, safe prepare/finalize/apply responses, `Idempotency-Key` requirement, and service error status mapping.

- [ ] **Step 2: Run REST tests and verify RED**

Run: `cd backend && ./scripts/test-disposable-postgres.sh src/modules/borrowers.test.ts`

Expected: new endpoint requests return 404.

- [ ] **Step 3: Add thin Elysia adapters**

Call the Task 3 service functions directly. Do not place storage, validation, audit, or replay logic in routes. Keep request/response schemas closed and use the existing `commandContext`/`domainFailure` helpers.

- [ ] **Step 4: Run REST tests and verify GREEN**

Run: `cd backend && ./scripts/test-disposable-postgres.sh src/modules/borrowers.test.ts`

Expected: PASS.

- [ ] **Step 5: Write failing frontend orchestrator tests**

Assert SHA-256 digest preparation, exact required PUT headers, unchanged bytes, finalize only after a successful PUT, no finalize on expired/missing URL, and no signed URL logging.

```ts
expect(fetchImpl).toHaveBeenCalledWith(uploadUrl, {
    method: "PUT",
    headers: requiredHeaders,
    body: file,
});
expect(apiClient.post).toHaveBeenLastCalledWith(
    `/borrowers/${borrowerId}/id-card/upload-intents/${intentId}/finalize`,
);
```

- [ ] **Step 6: Run frontend helper test and verify RED**

Run: `cd frontend && bun test src/lib/borrower-id-card-upload.test.ts`

Expected: FAIL because the helper is absent.

- [ ] **Step 7: Implement the minimal frontend orchestrator**

Use `crypto.subtle.digest("SHA-256", await file.arrayBuffer())`, serialize lowercase hex, call prepare, PUT unchanged `File`, confirm expiry before PUT, then finalize. Never send the image bytes through the product REST API.

- [ ] **Step 8: Write failing BorrowerForm tests**

Assert JPEG/PNG accept behavior, pending/uploaded/review text, disabled submit during upload, preserved human-entered identity fields, safe retry after failure, and removal of the legacy `/files/upload` plus `/borrowers/extract-id-card` calls.

- [ ] **Step 9: Migrate BorrowerForm and synchronized translations**

For new borrowers, save the borrower first, then run the signed upload against its public UUID and keep the human-entered fields authoritative. For existing borrowers, upload immediately and update the form's safe preview/reference after finalize. Do not invoke the MCP-only Codex extraction path from Web.

- [ ] **Step 10: Run frontend tests, lint, and build**

Run:

```bash
cd frontend
bun test src/lib/borrower-id-card-upload.test.ts tests/borrower-form.vitest.tsx
bun run lint
bun run build
```

Expected: PASS. If `borrower-form.vitest.tsx` does not yet exist, create it using the repository's established Vitest/Testing Library setup.

- [ ] **Step 11: Update README/changelog and commit exact REST/Web files**

Document signed upload behavior and Web-vs-Codex extraction boundaries, then stage only the listed files. Do not stage the unrelated Payment Inbox changes currently present.

```bash
git commit -m "feat: upload borrower ID cards with signed storage"
```

---

### Task 5: Three Closed-Schema MCP Tools and Direct Service Adapters

**Files:**
- Modify: `backend/src/mcp/server.ts`
- Modify: `backend/src/mcp/server.test.ts`
- Modify: `backend/src/mcp/default.ts`
- Modify: `backend/src/mcp/default.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Adds names in order after `borrower.alias`:

```ts
"borrower.id-card.prepare",
"borrower.id-card.finalize",
"borrower.id-card.apply-extracted-data",
```

- Prepare input matches Task 3 plus `borrowerPublicId`.
- Finalize input is `{ borrowerPublicId, intentPublicId }`.
- Apply input is `{ borrowerPublicId, intentPublicId, name, idCardNumber, address, idempotencyKey }`.
- Prepare/finalize/apply outputs are strict `schemaVersion: "1.0"` envelopes and all three include `auditPublicIds` plus `correlationId`; prepare alone may additionally carry the short-lived signed PUT descriptor in structured content.
- Readable summaries mention status and changed field names only; they never include raw identity number, address, signed URL, object key, or checksum.

- [ ] **Step 1: Write failing MCP metadata tests**

Assert exact names/order, closed nested schemas, titles/descriptions, and annotations:

```ts
expect(annotations("borrower.id-card.prepare")).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false });
expect(annotations("borrower.id-card.finalize")).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false });
expect(annotations("borrower.id-card.apply-extracted-data")).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false });
```

- [ ] **Step 2: Run server tests and verify RED**

Run: `cd backend && bun test src/mcp/server.test.ts`

Expected: FAIL because the three tools are absent.

- [ ] **Step 3: Add names, strict Zod inputs/outputs, annotations, and safe summaries**

Do not reuse the broad borrower output containing raw `idCardNumber`. Define dedicated safe intent/apply output schemas. Add all three to the financial/audited write sets where public audit metadata is required; if prepare intentionally returns signed URL, exclude that field from readable text and audit projection.

- [ ] **Step 4: Run server tests and verify GREEN**

Run: `cd backend && bun test src/mcp/server.test.ts`

Expected: PASS.

- [ ] **Step 5: Write failing direct-adapter tests**

Inject a fake `BorrowerIdCardStorageGateway`, invoke the authenticated local MCP client in exact prepare/finalize/apply order, assert storage calls and database result, and assert the MCP server never performs an internal HTTP request.

- [ ] **Step 6: Run default MCP tests and verify RED**

Run: `cd backend && ./scripts/test-disposable-postgres.sh src/mcp/default.test.ts`

Expected: FAIL because default handlers are absent.

- [ ] **Step 7: Implement minimal direct service adapters**

Extend the existing dependency interface with `borrowerIdCardStorageGateway`, map tool inputs to Task 3 service functions, and preserve `idempotencyKey` in MCP command context through the server's existing extraction mechanism.

- [ ] **Step 8: Run MCP suites and typecheck**

Run:

```bash
cd backend
bun test src/mcp/server.test.ts
./scripts/test-disposable-postgres.sh src/mcp/default.test.ts
bun run typecheck
```

Expected: PASS with 67 unique tool handlers.

- [ ] **Step 9: Update changelog and commit MCP server/adapters**

```bash
git add CHANGELOG.md backend/src/mcp/server.ts backend/src/mcp/server.test.ts backend/src/mcp/default.ts backend/src/mcp/default.test.ts
git commit -m "feat: add MCP borrower ID card workflow"
```

---

### Task 6: CreditSync Plugin 8.0.0 Workflow, Contract, and Evals

**Files:**
- Create or modify: `plugins/creditsync/skills/manage-borrowers/SKILL.md`
- Modify: `plugins/creditsync/.codex-plugin/plugin.json`
- Modify: `plugins/creditsync/README.md`
- Modify: `plugins/creditsync/CHANGELOG.md`
- Modify: `plugins/creditsync/evals/evals.json`
- Modify: `plugins/creditsync/evals/harness.ts`
- Modify: `plugins/creditsync/scripts/validate.ts`
- Modify: `plugins/creditsync/tests/plugin-contract.test.ts`
- Modify: `plugins/creditsync/tests/eval-harness.test.ts`
- Modify: `plugins/creditsync/tests/operations-docs.test.ts`
- Regenerate: `plugins/creditsync/references/mcp-tool-contract.json`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Plugin version is exactly `8.0.0` in every metadata/documentation location.
- Frozen tool count is exactly 67.
- `manage-borrowers` workflow requires exact borrower search/portfolio resolution before prepare, local image extraction without repeating sensitive values, unchanged-byte upload, exact intent/file identity checks, finalize `ready`, complete validated apply, and post-apply portfolio reinspection.

- [ ] **Step 1: Write failing plugin contract/version tests**

Change expectations to `8.0.0` and 67 tools; assert the three tools' full metadata equals the authenticated local `tools/list` response and that the borrower skill is registered.

- [ ] **Step 2: Write failing positive and negative eval tests**

Add at minimum:

```text
positive: exact borrower → prepare → PUT → finalize → apply → portfolio
negative: ambiguous borrower stops before prepare
negative: expired signed URL forbids PUT/finalize/apply
negative: changed bytes or finalize metadata mismatch forbids apply
negative: invalid/incomplete extracted fields forbids apply
negative: prepare/finalize intent or file UUID mismatch forbids apply
negative: apply response contains a different borrower UUID and stops success claim
negative: readable summaries never contain the raw synthetic identity fixture
```

- [ ] **Step 3: Run plugin tests and verify RED**

Run: `cd plugins/creditsync && bun test`

Expected: FAIL on version/tool/skill/eval expectations.

- [ ] **Step 4: Implement skill, harness fixtures, docs, and validator synchronization**

Keep synthetic identity fixtures only. The harness upload effect must verify unchanged bytes, required headers, expiry, and exact prepared intent/file binding. It must represent signed URLs as opaque fixture values and never include them in human-readable expected summaries.

- [ ] **Step 5: Regenerate the authenticated MCP contract**

Run: `cd plugins/creditsync && bun run scripts/mcp-contract.ts --write`

Expected: writes exactly 67 advertised tools from the authenticated local SDK client path.

- [ ] **Step 6: Run plugin tests and validator**

Run:

```bash
cd plugins/creditsync
bun test
bun run scripts/validate.ts
```

Expected: plugin validation reports `8.0.0`, registered skill count, and 67 tools with no bundled secrets.

- [ ] **Step 7: Update project/plugin docs and changelogs, then commit**

Document the exact agent workflow, human review stops, tool-count/version change, and operator contract-refresh command.

```bash
git commit -m "feat: release CreditSync plugin 8 ID card workflow"
```

---

### Task 7: Full Verification and Safe Handoff

**Files:**
- Modify if verification reveals omissions: only files already listed in Tasks 1–6.
- Modify: `CHANGELOG.md` for any verified correction included in the final commit.

**Interfaces:**
- No new interface; this task verifies the complete approved design and staged change set.

- [ ] **Step 1: Run backend unit/typecheck gates**

```bash
cd backend
bun test src/lib/thai-national-id.test.ts src/mcp/server.test.ts
bun run typecheck
```

- [ ] **Step 2: Run serial disposable-PostgreSQL suites**

```bash
cd backend
./scripts/test-disposable-postgres.sh \
  src/services/borrower-id-card-service.test.ts \
  src/services/borrower-service.test.ts \
  src/modules/borrowers.test.ts \
  src/mcp/default.test.ts
```

Do not run these files concurrently because they share a destructively reset disposable database.

- [ ] **Step 3: Run frontend gates**

```bash
cd frontend
bun test
bun run lint
bun run build
```

- [ ] **Step 4: Run plugin gates**

```bash
cd plugins/creditsync
bun test
bun run scripts/validate.ts
```

- [ ] **Step 5: Inspect secrets/privacy and generated contract**

```bash
rg -n "uploadUrl|objectKey|idCardNumber|OCR Scanned|ผล OCR" \
  backend/src/services/borrower-id-card-service.ts \
  backend/src/mcp \
  plugins/creditsync \
  frontend/src/pages/dashboard/borrowers
jq '.tools | length' plugins/creditsync/references/mcp-tool-contract.json
git diff --check
git status --short
```

Manually verify every hit is an input/schema/private prepare field or masked/safe handling, not a readable summary, audit leak, fixture copied from a real person, or committed signed value. Expected tool count: `67`.

- [ ] **Step 6: Review staged scope and changelog accuracy**

Confirm the newest `v0.3.12 - 2026-08-14` entries describe the staged implementation, Plugin `8.0.0`, 67-tool contract, migration, Web behavior, and verification. Ensure the unrelated Payment Inbox files remain unstaged.

- [ ] **Step 7: Commit verification-only fixes if any**

If verification required changes, rerun the affected gate and commit only those fixes with their changelog entry. If no files changed, do not create an empty commit.

- [ ] **Step 8: Report handoff evidence**

Report commit hashes, exact commands and outcomes, migration number, Plugin `8.0.0`, 67-tool count, and any production deployment steps not executed. Do not include identity-card values, signed URLs, storage keys, or raw OCR text.
