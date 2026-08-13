# MCP Intake Evidence Contract Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `intake.get` return finalized payment evidence through the strict public MCP contract and deploy the verified backend repair.

**Architecture:** Preserve the existing payment-service presenter and strict MCP validation. Add the missing nullable public file UUID to the `intake.get` evidence output schema, protect it with a database-backed MCP regression, regenerate the frozen plugin contract, and deploy only the backend container.

**Tech Stack:** Bun 1.3, TypeScript, Zod 4, Model Context Protocol SDK, PostgreSQL 18 disposable tests, Docker Compose.

## Global Constraints

- Money remains two-decimal decimal strings; this repair performs no financial calculation or write.
- Keep all MCP output schemas closed and expose only public UUIDs.
- Never expose object keys, signed URLs, bearer tokens, raw evidence contents, or internal numeric IDs.
- Keep CreditSync plugin manifest/version unchanged unless existing synchronization tooling explicitly requires a metadata change.
- Use `backend/scripts/test-disposable-postgres.sh` for the database-backed regression and keep database tests serialized.
- Before every commit, update `CHANGELOG.md` under `## v0.3.11 - 2026-08-13` and stage it with the described change.
- Production verification is read-only: do not preview, post, reverse, or mutate any financial record.

---

### Task 1: Add the MCP evidence regression and repair the schema

**Files:**
- Modify: `backend/src/mcp/default.test.ts:472-500`
- Modify: `backend/src/mcp/server.ts:370-379`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: `evidence.prepare`, `evidence.finalize`, and `intake.get` through the existing authenticated MCP test client.
- Produces: `intake.get.data.evidence[]` items with `filePublicId: string | null`, validated as a public UUID or null.

- [ ] **Step 1: Write the failing database-backed regression**

After `evidence.finalize`, call `intake.get` and assert the real MCP result:

```ts
const finalized = (await call("evidence.finalize", {
    paymentIntakePublicId: intakePublicId,
    evidencePublicId: evidence.publicId,
})).data;
const inspected = (await call("intake.get", { paymentIntakePublicId: intakePublicId })).data;
expect(inspected.evidence).toEqual([
    expect.objectContaining({
        publicId: evidence.publicId,
        status: "ready",
        filePublicId: finalized.filePublicId,
    }),
]);
```

Remove the earlier pre-evidence `intake.get` call so this test cannot pass by exercising only an empty evidence array. The production mutation this catches is omission of `filePublicId` from the strict MCP evidence schema.

- [ ] **Step 2: Run the regression and verify RED**

Run:

```bash
backend/scripts/test-disposable-postgres.sh src/mcp/default.test.ts
```

Expected: FAIL when the post-finalize `intake.get` returns `INVALID_TOOL_OUTPUT`; all prior tool calls reach that point successfully.

- [ ] **Step 3: Implement the minimal strict-schema repair**

Add the field to the evidence item under `toolDataSchemas["intake.get"]`:

```ts
filePublicId: uuid.nullable(),
```

Keep the evidence object `.strict()` and do not alter `getPaymentIntake`, evidence storage, or payment business logic.

- [ ] **Step 4: Run focused verification and verify GREEN**

Run:

```bash
backend/scripts/test-disposable-postgres.sh src/mcp/default.test.ts
bun test src/mcp/server.test.ts
bun run typecheck
```

Expected: the database-backed all-tools suite, 10 MCP server contract tests, and TypeScript typecheck all exit 0.

- [ ] **Step 5: Record the repair in the changelog**

Add one `### Fixed` bullet under v0.3.11 stating that evidence-bearing `intake.get` calls no longer fail strict output validation and now return the safe public file UUID.

### Task 2: Synchronize and validate the frozen CreditSync plugin contract

**Files:**
- Modify: `plugins/creditsync/references/mcp-tool-contract.json`
- Test: `plugins/creditsync/tests/plugin-contract.test.ts`
- Test: `plugins/creditsync/tests/eval-harness.test.ts`

**Interfaces:**
- Consumes: advertised MCP `tools/list` metadata generated from `backend/src/mcp/server.ts`.
- Produces: a canonical frozen contract whose `intake.get` evidence item requires `filePublicId` with JSON Schema type `string` UUID or `null` and remains closed to undeclared fields.

- [ ] **Step 1: Demonstrate the frozen contract mismatch before regeneration**

Run from the repository root:

```bash
bun test plugins/creditsync/tests/plugin-contract.test.ts
```

Expected: FAIL because the committed frozen contract differs from the newly advertised `intake.get` output schema.

- [ ] **Step 2: Regenerate the frozen contract**

Run:

```bash
bun run plugins/creditsync/scripts/mcp-contract.ts --write
```

Expected: reports 40 advertised MCP tools written to `plugins/creditsync/references/mcp-tool-contract.json`.

- [ ] **Step 3: Inspect the generated diff**

Run:

```bash
git diff -- plugins/creditsync/references/mcp-tool-contract.json
```

Expected: only the `intake.get` evidence output schema gains required nullable `filePublicId`; no tool names, input schemas, annotations, or unrelated outputs change.

- [ ] **Step 4: Run plugin verification**

Run:

```bash
bun test plugins/creditsync/tests/plugin-contract.test.ts plugins/creditsync/tests/eval-harness.test.ts
bun run plugins/creditsync/scripts/validate.ts
```

Expected: plugin contract/eval tests and validator exit 0 while retaining plugin version 2.3.0, 8 skills, and 40 tools.

### Task 3: Verify, commit, deploy, and inspect production read-only

**Files:**
- Modify: `CHANGELOG.md`
- Verify: all files staged for the implementation commit

**Interfaces:**
- Consumes: verified backend image source and root `.env.production` without printing secrets.
- Produces: production backend serving the repaired `intake.get` contract, healthy MCP endpoint, and a successful read of a previously failing intake.

- [ ] **Step 1: Review the final change set**

Run:

```bash
git diff --check
git status --short
git diff --stat
git diff -- backend/src/mcp/default.test.ts backend/src/mcp/server.ts CHANGELOG.md
```

Expected: only the focused test, schema, generated frozen contract, plan, and changelog changes are present; no frontend or secret files are modified.

- [ ] **Step 2: Run fresh pre-commit verification**

Run:

```bash
backend/scripts/test-disposable-postgres.sh src/mcp/default.test.ts
(cd backend && bun test src/mcp/server.test.ts && bun run typecheck)
bun test plugins/creditsync/tests/plugin-contract.test.ts plugins/creditsync/tests/eval-harness.test.ts
bun run plugins/creditsync/scripts/validate.ts
```

Expected: every command exits 0 with no skipped database invariant test.

- [ ] **Step 3: Commit the implementation**

Run:

```bash
git add CHANGELOG.md backend/src/mcp/default.test.ts backend/src/mcp/server.ts plugins/creditsync/references/mcp-tool-contract.json docs/superpowers/plans/2026-08-13-mcp-intake-get-evidence-contract.md
git diff --cached --check
git commit -m "fix: align MCP intake evidence contract"
```

Expected: commit succeeds with changelog, tests, code, generated contract, and plan together.

- [ ] **Step 4: Rebuild and restart only the production backend**

From the production checkout `/home/flintstone/github/CreditSync`, first confirm the deployment checkout contains the implementation commit without overwriting unrelated working changes. Integrate the branch commit by a safe non-destructive method, then run:

```bash
docker compose --env-file .env.production -f docker-compose.app.yml up --build -d backend
```

Expected: backend image builds, container is recreated, and no frontend or infrastructure container is rebuilt unnecessarily.

- [ ] **Step 5: Verify backend startup and MCP health**

Run:

```bash
docker compose --env-file .env.production -f docker-compose.app.yml logs --tail=120 backend
docker compose --env-file .env.production -f docker-compose.app.yml exec -T backend bun -e 'const response = await fetch("http://127.0.0.1:3000/mcp/health"); console.log(response.status, await response.text()); if (!response.ok) process.exit(1)'
```

Expected: logs show successful startup/migrations without fatal errors, and health returns HTTP 200 with service `creditsync-mcp`.

- [ ] **Step 6: Verify the original production symptom read-only**

Call `intake.get` through the connected CreditSync MCP for payment intake `019ff5f9-a0e3-752b-862f-b5ccdb57270e`.

Expected: the tool returns the intake, finalized evidence metadata including nullable/public `filePublicId`, and latest proposal without `INVALID_TOOL_OUTPUT`. Do not call `payment.preview`, `payment.post`, `payment.reverse`, or any other write tool.

- [ ] **Step 7: Record deployment evidence**

Capture the implementation commit ID, container health response, and sanitized read result status in the handoff. Do not include signed URLs, evidence contents, raw identity values, tokens, or secrets.
