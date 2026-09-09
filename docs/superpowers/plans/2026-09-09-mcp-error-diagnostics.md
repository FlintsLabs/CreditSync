# MCP Error Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add actionable errors and safe, tenant-scoped, 30-day MCP failure diagnostics that authorized ChatGPT agents can inspect by correlation ID.

**Architecture:** Create a bounded request-local diagnostic scope at the MCP tool boundary, classify every thrown error into separate public and operational projections, and persist only unexpected, retryable, or integration failures to PostgreSQL with stdout fallback. Add strict owner/manager read-only tools for exact and bounded diagnostic queries, while keeping raw errors, payloads, secrets, evidence, and financial data outside both persistence and public responses.

**Tech Stack:** Bun, TypeScript, Node `AsyncLocalStorage`, Elysia, Drizzle/PostgreSQL, Zod, MCP SDK, Bun test, CreditSync private plugin/eval harness.

**Spec:** `docs/superpowers/specs/2026-09-09-mcp-error-diagnostics-design.md`

## Global Constraints

- Preserve all financial confirmation, idempotency, immutable-ledger, preview, duplicate, stale-state, and human-review boundaries.
- Diagnostic persistence is operational and best-effort; it must never mask the original MCP error or change financial state.
- Persist only unexpected, retryable, explicitly selected operational, or integration failures; do not persist ordinary validation, authorization, ambiguity, duplicate, stale-state, or confirmation-required errors.
- Keep at most 20 typed breadcrumbs per request and persist them only with an eligible failure.
- Never store or return raw exception messages, stack traces, request/response bodies, SQL, headers, environment values, filenames, URLs, signed URLs, object keys, credentials, file IDs, hashes, evidence contents, QR payloads, identity data, account data, financial amounts, or full references.
- Store diagnostic records in PostgreSQL for 30 days; structured stdout is the fallback, not the query source of truth.
- Diagnostic reads are tenant-scoped and restricted to active `owner` or `manager` actors.
- Both diagnostic MCP tools are closed-schema, read-only, idempotent, non-destructive, and `openWorldHint: false`.
- Update root/plugin changelogs before each implementation commit and update README/operations documentation with the new workflow.
- Use Bun commands and serialize disposable PostgreSQL suites through `backend/scripts/test-disposable-postgres.sh`.

---

### Task 1: Add the append-only diagnostic table and retention indexes

**Files:**
- Create: `backend/drizzle/0064_mcp_error_diagnostics.sql`
- Modify: `backend/drizzle/meta/_journal.json`
- Create: `backend/src/lib/mcp-diagnostic-types.ts`
- Modify: `backend/src/db/schema.ts`
- Create: `backend/src/db/mcp-error-diagnostics-migration.test.ts`
- Modify: `backend/src/db/combined-migration-lineage.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces: shared diagnostic unions/types, `mcpDiagnosticEvents` Drizzle table, and migration `0064_mcp_error_diagnostics`.
- Consumes: existing tenant IDs, UUIDv7 database default, and migration-journal conventions.

- [ ] **Step 1: Write the failing migration shape test**

```ts
test("adds tenant-scoped MCP diagnostics with bounded retention indexes", async () => {
    const sql = await Bun.file(`${backendRoot}drizzle/0064_mcp_error_diagnostics.sql`).text();
    expect(sql).toContain("CREATE TABLE \"mcp_diagnostic_events\"");
    expect(sql).toContain("mcp_diagnostic_events_tenant_correlation_idx");
    expect(sql).toContain("mcp_diagnostic_events_tenant_request_idx");
    expect(sql).toContain("mcp_diagnostic_events_tenant_occurred_idx");
    expect(sql).toContain("mcp_diagnostic_events_expires_idx");
    expect(sql).toContain("upstream_status");
    expect(sql).toContain("duration_ms");
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `cd backend && bun test src/db/mcp-error-diagnostics-migration.test.ts`

Expected: FAIL because migration `0064_mcp_error_diagnostics.sql` and `mcpDiagnosticEvents` do not exist.

- [ ] **Step 3: Add the migration and schema mapping**

Define `McpDiagnosticCategory`, `McpDiagnosticStage`, `McpDiagnosticFailureClass`, `SafeDiagnosticMetadataKey`, and `McpDiagnosticBreadcrumb` in `backend/src/lib/mcp-diagnostic-types.ts` so the database layer does not import from MCP runtime modules. Make `SafeDiagnosticMetadataKey` the explicit union `"runtimeCodeCategory" | "httpStatus" | "timeout" | "attempt" | "itemCount"`; do not accept arbitrary keys. Use this application shape:

```ts
export const mcpDiagnosticEvents = pgTable("mcp_diagnostic_events", {
    id: serial("id").primaryKey(),
    publicId: uuid("public_id").default(sql`uuidv7()`).notNull().unique(),
    tenantId,
    toolName: text("tool_name").notNull(),
    requestId: uuid("request_id").notNull(),
    correlationId: uuid("correlation_id").notNull(),
    category: text("category").notNull(),
    failureClass: text("failure_class").notNull(),
    errorCode: text("error_code").notNull(),
    terminalStage: text("terminal_stage").notNull(),
    retryable: boolean("retryable").notNull(),
    reviewRequired: boolean("review_required").notNull(),
    upstreamStatus: integer("upstream_status"),
    durationMs: integer("duration_ms").notNull(),
    breadcrumbs: jsonb("breadcrumbs").$type<McpDiagnosticBreadcrumb[]>().default([]).notNull(),
    occurredAt: timestamp("occurred_at").defaultNow().notNull(),
    expiresAt: timestamp("expires_at").notNull(),
});
```

Add SQL checks for non-negative duration, HTTP status `100..599` when present, known category values, non-empty bounded text fields, and `expires_at > occurred_at`. Add the four indexes required by the spec and journal entry index `64`.

- [ ] **Step 4: Add disposable PostgreSQL assertions**

Assert the table/columns/check constraints/indexes through `information_schema`, `pg_constraint`, and `pg_indexes`. Insert rows for two tenants and prove both coexist without cross-tenant uniqueness. Do not add an update/delete trigger because the bounded expiry job must delete expired rows; later tasks expose no public mutation service.

- [ ] **Step 5: Run migration verification GREEN**

Run: `cd backend && ./scripts/test-disposable-postgres.sh src/db/mcp-error-diagnostics-migration.test.ts src/db/combined-migration-lineage.test.ts`

Expected: both files PASS against a fresh disposable PostgreSQL database.

- [ ] **Step 6: Update changelog and commit**

```bash
git add backend/drizzle/0064_mcp_error_diagnostics.sql backend/drizzle/meta/_journal.json backend/src/lib/mcp-diagnostic-types.ts backend/src/db/schema.ts backend/src/db/mcp-error-diagnostics-migration.test.ts backend/src/db/combined-migration-lineage.test.ts CHANGELOG.md
git commit -m "feat: add MCP diagnostic event storage"
```

### Task 2: Build typed breadcrumb capture and safe error presentation

**Files:**
- Create: `backend/src/mcp/diagnostic-context.ts`
- Create: `backend/src/mcp/diagnostic-context.test.ts`
- Create: `backend/src/mcp/error-presentation.ts`
- Create: `backend/src/mcp/error-presentation.test.ts`
- Modify: `backend/src/mcp/server.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces: `withMcpDiagnosticScope`, `recordMcpBreadcrumb`, `currentMcpDiagnosticSnapshot`, `presentMcpError`, and `shouldPersistMcpDiagnostic`.
- Consumes: `CommandContext`, `DomainError`, MCP tool name, and the existing sanitized error semantics.

- [ ] **Step 1: Write failing breadcrumb-boundary tests**

```ts
test("retains bounded safe breadcrumbs without arbitrary values", async () => {
    await withMcpDiagnosticScope(ctx, "evidence.import-chatgpt-file", async () => {
        for (let index = 0; index < 25; index++) {
            recordMcpBreadcrumb({ stage: "external.download", outcome: "started", elapsedMs: index });
        }
        const snapshot = currentMcpDiagnosticSnapshot();
        expect(snapshot.breadcrumbs).toHaveLength(20);
        expect(snapshot.breadcrumbs.some((item) => item.stage === "breadcrumbs_truncated")).toBe(true);
    });
});
```

Also test no-op behavior outside a scope, nested async isolation, concurrent request isolation, monotonic elapsed times, and rejection of metadata keys matching `name|email|alias|phone|card|address|qr|reference|url|token|secret|hash|amount|payload|header|query|sql|file|key`.

- [ ] **Step 2: Run diagnostic context tests RED**

Run: `cd backend && bun test src/mcp/diagnostic-context.test.ts`

Expected: FAIL because the request-local API is absent.

- [ ] **Step 3: Implement the typed request-local recorder**

```ts
export type McpDiagnosticBreadcrumb = {
    stage: McpDiagnosticStage;
    outcome: "started" | "succeeded" | "failed" | "rejected";
    elapsedMs: number;
    metadata?: Readonly<Record<SafeDiagnosticMetadataKey, string | number | boolean | null>>;
};

export function withMcpDiagnosticScope<T>(
    ctx: CommandContext,
    toolName: McpToolName,
    work: () => Promise<T>,
): Promise<T>;

export function recordMcpBreadcrumb(input: Omit<McpDiagnosticBreadcrumb, "elapsedMs"> & { elapsedMs?: number }): void;
```

Use `AsyncLocalStorage`, copy/freeze accepted values, and retain no raw thrown object. Export snapshots as immutable copies.

- [ ] **Step 4: Write failing error-presentation tests**

Cover known actionable codes such as `CHATGPT_FILE_UNAVAILABLE`, `EVIDENCE_UPLOAD_EXPIRED`, stale preview, duplicate, confirmation required, forbidden, rate limited, and unknown exceptions. Assert every projection includes correlation ID and `suggestedAction`, stricter existing retry/review flags win, unknown exceptions do not expose their message, and only eligible classes return `persist: true`.

- [ ] **Step 5: Implement the catalog and classifier**

```ts
export type PublicMcpError = {
    code: string;
    message: string;
    suggestedAction: string;
    retryable: boolean;
    reviewRequired: boolean;
    repreviewRequired?: boolean;
    humanReviewRequired?: boolean;
    details: Record<string, unknown>;
    correlationId: string;
};

export function presentMcpError(error: unknown, correlationId: string): {
    publicError: PublicMcpError;
    diagnostic: SafeDiagnosticClassification;
    persist: boolean;
};
```

Move the existing `safeToolError` policy from `server.ts` into this module. Use exact-code mappings first, then stable status/code-family fallbacks. Do not interpolate raw error messages into unknown/internal public messages.

Pass an explicit operation recovery policy into error presentation. Test a truly read-only transient failure separately from mutating operations, including a successful financial commit followed by `AUDIT_METADATA_UNAVAILABLE` or `INVALID_TOOL_OUTPUT`. For uncertain writes, require authoritative inspection before any permitted same-key replay; never suggest blind retry or a new idempotency key. Preserve confirmation and stale-preview requirements. Do not infer replay safety solely from annotations or `retryable`.

- [ ] **Step 6: Run unit tests and typecheck GREEN**

Run: `cd backend && bun test src/mcp/diagnostic-context.test.ts src/mcp/error-presentation.test.ts && bun run typecheck`

- [ ] **Step 7: Update changelog and commit**

```bash
git add backend/src/mcp/diagnostic-context.ts backend/src/mcp/diagnostic-context.test.ts backend/src/mcp/error-presentation.ts backend/src/mcp/error-presentation.test.ts backend/src/mcp/server.ts CHANGELOG.md
git commit -m "feat: classify actionable MCP errors safely"
```

### Task 3: Persist eligible failures without changing MCP outcomes

**Files:**
- Create: `backend/src/services/mcp-diagnostic-service.ts`
- Create: `backend/src/services/mcp-diagnostic-service.test.ts`
- Modify: `backend/src/mcp/server.ts`
- Modify: `backend/src/mcp/server.test.ts`
- Modify: `backend/src/mcp/default.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces: `persistMcpDiagnosticBestEffort`, injectable `CreateMcpHttpPluginInput.persistDiagnostic`, and MCP boundary integration.
- Consumes: `mcpDiagnosticEvents`, diagnostic snapshots, classification, structured logger, and `CommandContext`.

- [ ] **Step 1: Write failing persistence-policy tests**

```ts
test("persists one eligible terminal failure and preserves the original public error", async () => {
    const result = await invokeFailingTool(new Error("secret internal detail"));
    expect(result.structuredContent).toMatchObject({
        error: { code: "INTERNAL_ERROR", correlationId: expect.any(String) },
    });
    const rows = await db.select().from(mcpDiagnosticEvents);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0])).not.toContain("secret internal detail");
});
```

Add cases for excluded validation/confirmation errors, included retryable `DomainError`, exactly one row per failed tool call, stdout summary parity, and two concurrent failures with isolated breadcrumbs.

- [ ] **Step 2: Run focused tests RED**

Run: `cd backend && ./scripts/test-disposable-postgres.sh src/services/mcp-diagnostic-service.test.ts src/mcp/server.test.ts`

Expected: FAIL because terminal diagnostics are not persisted and the error envelope lacks correlation/action fields.

- [ ] **Step 3: Implement diagnostic serialization and insertion**

```ts
export async function persistMcpDiagnosticBestEffort(input: {
    ctx: CommandContext;
    toolName: McpToolName;
    publicError: PublicMcpError;
    classification: SafeDiagnosticClassification;
    snapshot: McpDiagnosticSnapshot;
    logger: (entry: Record<string, unknown>) => void;
    executor?: typeof db;
}): Promise<void>;
```

Set `occurredAt` once and `expiresAt` exactly 30 days later. Serialize through the typed breadcrumb projector. Catch insertion errors, emit only `{ event: "mcp_diagnostic_persist_failed", tool, requestId, correlationId, code }`, and never throw.

Bound total persistence waiting (pool acquisition included) to 500 ms. Use a dedicated bounded diagnostic pool, query/lock timeouts, and cancellation; do not allow abandoned insertions to accumulate. Guard logger calls, observe late rejection, and clear deadline timers. Never automatically retry a timed-out insert because its commit outcome may be unknown.

- [ ] **Step 4: Wrap each tool call in the diagnostic scope**

Add `persistDiagnostic` to `CreateMcpHttpPluginInput`; `createDefaultMcpHttpPlugin` wires it to `persistMcpDiagnosticBestEffort`, while transport tests inject a deterministic implementation. Establish the scope in an application-owned authenticated `tools/call` dispatch adapter before SDK input validation, using the same closed schemas. SDK validation runs before registered handlers, so the handler catch cannot cover it. Normalize invalid tool arguments into the public envelope without invoking preflight/services; preserve strict advertised schemas and avoid SDK-internal patches. Add `validation`, `preflight`, and `handler` breadcrumbs at their actual boundaries. Keep malformed JSON/JSON-RPC and unauthenticated failures as safe protocol/HTTP errors with correlation headers and no tenant diagnostic persistence.

On catch, classify with the operation recovery policy, snapshot the scope, and await eligible persistence for at most 500 ms before returning the classified public error. Enforce this deadline at the response boundary even for an injected never-settling persistence function. Successful insertion permits immediate lookup; failure/timeout permits not-found and must not be presented as proof that the original command failed.

- [ ] **Step 5: Prove logging failure cannot mask the original error**

Inject a persistence function that rejects. Assert the MCP result still contains the original stable code/message/action/correlation ID and the logger receives `mcp_diagnostic_persist_failed` without raw error text.

Also test a never-settling insertion, exhausted pool, blocked query, late rejection, and throwing logger with controlled timers. Assert the 500 ms persistence deadline, cancellation/resource bounds, no unhandled rejection or automatic retry, and unchanged public error. Through the real MCP transport, send malformed tool arguments and assert safe correlation/action fields, zero handler calls, and no persisted validation row; separately test malformed protocol and missing authentication without tenant diagnostics.

- [ ] **Step 6: Run tests and typecheck GREEN**

Run: `cd backend && ./scripts/test-disposable-postgres.sh src/services/mcp-diagnostic-service.test.ts src/mcp/server.test.ts`

Run: `cd backend && bun run typecheck`

- [ ] **Step 7: Update changelog and commit**

```bash
git add backend/src/services/mcp-diagnostic-service.ts backend/src/services/mcp-diagnostic-service.test.ts backend/src/mcp/server.ts backend/src/mcp/server.test.ts backend/src/mcp/default.ts CHANGELOG.md
git commit -m "feat: persist eligible MCP failures"
```

### Task 4: Instrument shared integration failure stages

**Files:**
- Modify: `backend/src/lib/storage.ts`
- Modify: `backend/src/lib/storage.test.ts`
- Modify: `backend/src/lib/cache.ts`
- Create: `backend/src/lib/cache.test.ts`
- Modify: `backend/src/services/chatgpt-file-evidence-service.ts`
- Modify: `backend/src/services/chatgpt-file-evidence-service.test.ts`
- Modify: `backend/src/mcp/rate-limit.ts`
- Modify: `backend/src/mcp/rate-limit.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces: safe breadcrumbs for cache, rate-limit, ChatGPT download, and S3/MinIO stages.
- Consumes: `recordMcpBreadcrumb`; no integration receives tenant payloads or logger instances.

- [ ] **Step 1: Write failing stage tests**

For each integration, run it inside `withMcpDiagnosticScope` with injected failures and assert only safe stages/categories are captured. Required terminal stages are `cache.connect`, `rate_limit.consume`, `chatgpt_file.dns`, `chatgpt_file.download`, `chatgpt_file.validate`, `storage.bucket`, `storage.put`, `storage.head`, `storage.get`, and `storage.delete`.

- [ ] **Step 2: Verify RED without instrumentation**

Run: `cd backend && bun test src/lib/storage.test.ts src/lib/cache.test.ts src/services/chatgpt-file-evidence-service.test.ts src/mcp/rate-limit.test.ts`

Expected: FAIL because snapshots have no integration-stage breadcrumbs.

- [ ] **Step 3: Add minimal start/success/failure recording**

Use this pattern around each boundary:

```ts
recordMcpBreadcrumb({ stage: "storage.put", outcome: "started" });
try {
    const result = await s3.send(command);
    recordMcpBreadcrumb({ stage: "storage.put", outcome: "succeeded" });
    return result;
} catch (error) {
    recordMcpBreadcrumb({
        stage: "storage.put",
        outcome: "failed",
        metadata: safeIntegrationFailureMetadata(error),
    });
    throw error;
}
```

The metadata mapper may return only allowlisted runtime code category, safe HTTP status, and timeout boolean. It must never return endpoint, bucket, key, URL, headers, query, response body, or raw message.

- [ ] **Step 4: Add evidence-specific regression coverage**

Prove DNS failure, fetch rejection, non-2xx response, redirect rejection, MIME mismatch, storage PUT failure, HEAD mismatch, and cleanup failure are distinguishable by stage/failure class while the existing public evidence errors and fail-closed workflow remain unchanged.

- [ ] **Step 5: Run focused tests and typecheck GREEN**

Run: `cd backend && bun test src/lib/storage.test.ts src/lib/cache.test.ts src/services/chatgpt-file-evidence-service.test.ts src/mcp/rate-limit.test.ts && bun run typecheck`

- [ ] **Step 6: Update changelog and commit**

```bash
git add backend/src/lib/storage.ts backend/src/lib/storage.test.ts backend/src/lib/cache.ts backend/src/lib/cache.test.ts backend/src/services/chatgpt-file-evidence-service.ts backend/src/services/chatgpt-file-evidence-service.test.ts backend/src/mcp/rate-limit.ts backend/src/mcp/rate-limit.test.ts CHANGELOG.md
git commit -m "feat: trace safe MCP integration stages"
```

### Task 5: Add owner/manager diagnostic query tools

**Files:**
- Modify: `backend/src/services/mcp-diagnostic-service.ts`
- Modify: `backend/src/services/mcp-diagnostic-service.test.ts`
- Modify: `backend/src/mcp/server.ts`
- Modify: `backend/src/mcp/server.test.ts`
- Modify: `backend/src/mcp/default.ts`
- Modify: `backend/src/mcp/default.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces: `getMcpDiagnosticTrace(ctx, correlationId)` and `listMcpDiagnostics(ctx, input)`, exposed as `system.error-diagnostic.get` and `system.error-diagnostic.list`.
- Consumes: current actor row, tenant-scoped diagnostic table, cursor/time filters, and safe diagnostic projector.

- [ ] **Step 1: Write failing authorization and query tests**

Create owner, manager, collector, and viewer actors plus two tenants. Assert owner/manager can read only their tenant, collector/viewer receive `DIAGNOSTIC_FORBIDDEN`, cross-tenant and expired IDs return the same `DIAGNOSTIC_NOT_FOUND`, and no caller-supplied tenant field is accepted. Insert two events with the same correlation ID and prove `get` returns the bounded trace newest first.

- [ ] **Step 2: Write failing pagination and bounds tests**

Assert `get` requires one UUID. Assert `list` defaults to 20, caps at 100, orders newest first, uses opaque cursor pagination, rejects ranges older than 30 days, and requires either a narrowing filter or a window no larger than 24 hours.

- [ ] **Step 3: Implement service queries and safe projection**

```ts
export type ListMcpDiagnosticsInput = {
    correlationId?: string;
    requestId?: string;
    toolName?: McpToolName;
    errorCode?: string;
    category?: McpDiagnosticCategory;
    from?: string;
    to?: string;
    cursor?: string;
    limit?: number;
};

export async function getMcpDiagnosticTrace(ctx: CommandContext, correlationId: string): Promise<{ correlationId: string; items: SafeMcpDiagnostic[] }>;
export async function listMcpDiagnostics(ctx: CommandContext, input: ListMcpDiagnosticsInput): Promise<{ items: SafeMcpDiagnostic[]; nextCursor: string | null }>;
```

Load the actor by `ctx.actorUserId` and `ctx.tenantId`, require `canAccessTenantWideData`, and put the tenant predicate in every SQL query.

- [ ] **Step 4: Add strict MCP schemas and handlers**

Add both names to `MCP_TOOL_NAMES`, closed Zod input/output schemas, descriptions, default handlers, and the read-only/idempotent sets. Keep them out of destructive and financial sets. Ensure the common error schema now requires `correlationId` and `suggestedAction`.

- [ ] **Step 5: Verify metadata and transport behavior**

Assert both tools advertise `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: false`; responses contain no denied fields; and diagnostic-tool failures do not create recursive rows.

- [ ] **Step 6: Run disposable MCP suites GREEN**

Run: `cd backend && ./scripts/test-disposable-postgres.sh src/services/mcp-diagnostic-service.test.ts src/mcp/default.test.ts src/mcp/server.test.ts`

Run: `cd backend && bun run typecheck`

- [ ] **Step 7: Update changelog and commit**

```bash
git add backend/src/services/mcp-diagnostic-service.ts backend/src/services/mcp-diagnostic-service.test.ts backend/src/mcp/server.ts backend/src/mcp/server.test.ts backend/src/mcp/default.ts backend/src/mcp/default.test.ts CHANGELOG.md
git commit -m "feat: expose read-only MCP error diagnostics"
```

### Task 6: Add bounded 30-day cleanup and operations guidance

**Files:**
- Create: `backend/scripts/cleanup-mcp-diagnostics.ts`
- Create: `backend/scripts/cleanup-mcp-diagnostics.test.ts`
- Modify: `backend/package.json`
- Create: `docs/operations/mcp-error-diagnostics.md`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces: `bun run diagnostics:cleanup` with bounded batches and operator documentation.
- Consumes: `mcp_diagnostic_events.expires_at` and `DATABASE_URL`.

- [ ] **Step 1: Write the failing cleanup test**

Seed expired rows across two tenants plus current and boundary-time rows. Run one cleanup batch with an injected clock and limit. Assert expired rows are deleted globally in expiry order, the batch limit is honored, current/boundary rows remain, and output contains counts/duration only.

- [ ] **Step 2: Verify RED**

Run: `cd backend && ./scripts/test-disposable-postgres.sh scripts/cleanup-mcp-diagnostics.test.ts`

Expected: FAIL because the cleanup command is absent.

- [ ] **Step 3: Implement bounded deletion**

Delete at most `MCP_DIAGNOSTIC_CLEANUP_BATCH_SIZE`, default 1,000 and maximum 10,000, using a CTE that selects expired IDs ordered by expiry. Loop only when `--drain` is explicitly supplied; the scheduled default performs one bounded batch.

- [ ] **Step 4: Add the package command and operations guide**

Add `"diagnostics:cleanup": "bun run scripts/cleanup-mcp-diagnostics.ts"`. Document daily scheduling, 30-day retention, correlation-ID lookup, role requirements, safe fallback stdout events, and controlled non-financial verification. Do not prescribe mounting the Docker socket.

- [ ] **Step 5: Run cleanup tests and typecheck GREEN**

Run: `cd backend && ./scripts/test-disposable-postgres.sh scripts/cleanup-mcp-diagnostics.test.ts`

Run: `cd backend && bun run typecheck`

- [ ] **Step 6: Update changelog and commit**

```bash
git add backend/scripts/cleanup-mcp-diagnostics.ts backend/scripts/cleanup-mcp-diagnostics.test.ts backend/package.json docs/operations/mcp-error-diagnostics.md README.md CHANGELOG.md
git commit -m "docs: operate MCP diagnostic retention"
```

### Task 7: Synchronize the private plugin, recovery guidance, and evals

**Files:**
- Modify: `plugins/creditsync/.codex-plugin/plugin.json`
- Modify: `plugins/creditsync/references/mcp-tool-contract.json`
- Modify: `plugins/creditsync/references/error-recovery.md`
- Modify: `plugins/creditsync/skills/creditsync/SKILL.md`
- Modify: `plugins/creditsync/evals/evals.json`
- Modify: `plugins/creditsync/evals/harness.ts`
- Modify: `plugins/creditsync/tests/plugin-contract.test.ts`
- Modify: `plugins/creditsync/tests/eval-harness.test.ts`
- Modify: `plugins/creditsync/tests/operations-docs.test.ts`
- Modify: `plugins/creditsync/README.md`
- Modify: `plugins/creditsync/CHANGELOG.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces: synchronized 114-tool frozen contract and agent recovery workflow.
- Consumes: authenticated backend `tools/list`, the two diagnostic tools, and the extended error envelope.

- [ ] **Step 1: Write failing plugin contract assertions**

Change expected tool count from 112 to 114 and assert the two exact tool names, closed schemas, safe outputs, and read-only annotations. In backend transport and plugin eval tests, assert every returned tool error includes `correlationId` and `suggestedAction`; the MCP `tools/list` output schema remains the success schema.

- [ ] **Step 2: Add failing executable recovery evals**

Cover: actionable expected error without diagnostic lookup; unexpected error followed by `system.error-diagnostic.get`; repeated retryable integration error followed by lookup; owner/manager success; collector/viewer denial; missing/expired diagnostic; redacted breadcrumbs; and a rule that diagnostics never authorize bypassing confirmation, duplicate, stale, mismatch, or review stops.

- [ ] **Step 3: Update plugin guidance and version**

Bump `.codex-plugin/plugin.json` from `9.1.0` to `9.2.0`. Add recovery instructions to call `get` automatically only for unexpected/repeated retryable/integration failures and use bounded `list` only when correlation ID is unavailable.

- [ ] **Step 4: Regenerate and inspect the frozen contract**

Run: `cd plugins/creditsync && bun run scripts/mcp-contract.ts --write`

Expected: contract contains 114 tools and the two additions. Inspect the generated diff and reject any unrelated tool removal or schema widening; verify the error-envelope change separately through backend transport and plugin eval tests because MCP `tools/list` advertises success output schemas.

- [ ] **Step 5: Run plugin tests and validator GREEN**

Run: `cd plugins/creditsync && bun test tests/plugin-contract.test.ts tests/eval-harness.test.ts tests/operations-docs.test.ts`

Run: `cd plugins/creditsync && bun run validate`

- [ ] **Step 6: Update both changelogs and commit**

```bash
git add plugins/creditsync/.codex-plugin/plugin.json plugins/creditsync/references/mcp-tool-contract.json plugins/creditsync/references/error-recovery.md plugins/creditsync/skills/creditsync/SKILL.md plugins/creditsync/evals/evals.json plugins/creditsync/evals/harness.ts plugins/creditsync/tests/plugin-contract.test.ts plugins/creditsync/tests/eval-harness.test.ts plugins/creditsync/tests/operations-docs.test.ts plugins/creditsync/README.md plugins/creditsync/CHANGELOG.md CHANGELOG.md
git commit -m "feat: add MCP diagnostic recovery tools"
```

### Task 8: Run full verification and controlled rollout checks

**Files:**
- Review: every file changed from the feature-branch merge base.
- Modify if required by findings: `CHANGELOG.md`

**Interfaces:**
- Produces: independently verified implementation ready for review/merge/deploy.
- Consumes: all previous tasks and the production verification rules in `AGENTS.md`.

- [ ] **Step 1: Run backend unit suites**

Run: `cd backend && bun test src/mcp/diagnostic-context.test.ts src/mcp/error-presentation.test.ts src/lib/storage.test.ts src/lib/cache.test.ts src/services/chatgpt-file-evidence-service.test.ts src/mcp/rate-limit.test.ts`

Expected: all PASS with no skipped diagnostic behavior.

- [ ] **Step 2: Run database-backed suites serially**

Run: `cd backend && ./scripts/test-disposable-postgres.sh src/db/mcp-error-diagnostics-migration.test.ts src/db/combined-migration-lineage.test.ts src/services/mcp-diagnostic-service.test.ts src/mcp/default.test.ts src/mcp/server.test.ts scripts/cleanup-mcp-diagnostics.test.ts`

Expected: all PASS against a disposable PostgreSQL database; skipped DB tests are insufficient.

- [ ] **Step 3: Run backend and plugin verification**

Run: `cd backend && bun run typecheck`

Run: `cd plugins/creditsync && bun test && bun run validate`

Expected: all commands exit 0 and the frozen contract reports 114 tools.

- [ ] **Step 4: Inspect security and financial invariants**

Run: `git diff --check`

Review the full diff for raw error serialization, unbounded queries, missing tenant predicates, role bypass, recursive logging, payload/URL/hash leakage, changed financial tool annotations, automatic write retries, and any mutation to financial tables. Confirm diagnostic tables/services are the only new persistence path.

- [ ] **Step 5: Request independent code review and repair findings with TDD**

Use `superpowers:requesting-code-review`. Fix every Critical/Important finding, rerun the focused RED/GREEN test for each repair, and repeat all gates affected by the change.

- [ ] **Step 6: Verify deployment without live financial records**

After separately authorized merge/deploy, verify migration success and table/index shape through production PostgreSQL, check backend logs, call MCP health from inside the backend container, trigger one controlled non-financial known error and one controlled synthetic integration diagnostic, query the latter as owner/manager, and verify no secret-bearing fields plus 30-day expiry. Do not create or mutate production financial records for this check.
