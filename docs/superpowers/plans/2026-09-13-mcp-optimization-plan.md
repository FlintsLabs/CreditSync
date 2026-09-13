# CreditSync MCP Safety, Performance, and 2026 Compatibility Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans task-by-task, with test-driven implementation and independent review. Repository instructions select a supervised tmux Codex worker for this substantial implementation; do not recursively delegate workers.

**Goal:** Improve evidence-aware agent behavior, correctness and discovery performance, and add verified MCP 2026-07-28 compatibility while retaining legacy clients.

**Architecture:** Share an immutable catalog across handlers, transport projections and snapshots. Serve curated route-selected profiles. Keep legacy and modern protocol handling separate at the boundary, using official SDK codecs and existing application services.

**Tech Stack:** Bun, TypeScript, Elysia, Zod, decimal.js, PostgreSQL, existing MCP SDK v1 plus verified pinned modern SDK packages, plugin eval harness.

**Spec:** [2026-09-13-mcp-optimization-design.md](../specs/2026-09-13-mcp-optimization-design.md)

## Global Constraints

- Never edit or delete posted financial records or active terms; corrections are append-only compensation.
- Attachment-bearing agent workflows must stop before activation/post/financial execute until all relevant evidence is storage-ready and semantically reviewed.
- Financial transitions require explicit confirmation of the current proposal, stable idempotency, public audit metadata, and correlation ID. Preserve legacy command contracts; inventory unsupported idempotency or audit cases and resolve explicitly before claiming complete coverage.
- Money crosses public interfaces as two-decimal strings; existing backend services own calculations using decimal.js. Business dates use Asia/Bangkok.
- Keep `/mcp` compatible with existing clients. Profiles reduce discovery context; they do not create authorization scopes.
- Before every implementation commit, update CHANGELOG.md under a version/date heading and include README.md when setup or workflows change.
- Use disposable PostgreSQL for financial tests; never run destructive fixtures or conformance writes against a live tenant.
- Implementation is completed on an isolated codex/ branch. Merge, push, deployment, and production writes require their own authorization.

## Preflight and execution ownership

- [ ] Read both documents and current AGENTS.md. Inspect Git status and preserve unrelated files. Create an isolated codex/mcp-optimization worktree from the verified integration target.
- [ ] Launch supervised tmux session creditsync-mcp-optimization with Codex CLI model gpt-5.6-luna and explicit model_reasoning_effort="medium". If unavailable, use the current task's selected model and report why. Pass both document paths, worktree/branch/target, gates, constraints, dirty ownership and exclusions.
- [ ] Record the baseline tool count from MCP_TOOL_NAMES, plugin version, backend SDK version, discovery payload bytes and latency. Do not treat pretty frozen JSON size as host prompt tokens.
- [ ] Verify published modern SDK packages and conformance revision against official sources. Record exact versions/commands in operations documentation when adding dependencies. If unavailable, complete independent safety/catalog work but mark modern compatibility unverified.

## Task 1: Evidence-aware agent stops

**Files:** Modify plugins/creditsync/skills/creditsync/SKILL.md, related payment/disbursement skills found in the plugin, plugins/creditsync/evals/evals.json and plugins/creditsync/tests/eval-harness.test.ts. Add backend/src/mcp/evidence-workflow.test.ts for disposable service-path verification if no existing test covers draft evidence before activation. Update CHANGELOG.md and README.md.

- [ ] Add failing evals for attachment import failure, inaccessible attachment, pending evidence, duplicate slip and recipient mismatch. Expected outcome: human review, no activate/post/execute, truthful draft/evidence status. Assert the call trace, not just final response wording.
- [ ] Add a positive retry scenario with ready evidence: no second PUT/finalize; fresh inspection and confirmation precede post.
- [ ] Run `bun test plugins/creditsync/tests/eval-harness.test.ts` from repository root and confirm new assertions fail for the intended workflow gap.
- [ ] Replace the universal first-import rule with the two flows in the spec. Payment import requires an existing exact intake; disbursement uses prepare/PUT/finalize on a payout draft. Preserve identity, channel, history and confirmation checks before intake creation.
- [ ] Add a disposable test proving loan draft -> disbursement draft -> evidence prepare/finalize -> ready inspection works before activation. Use a fake storage gateway and isolated tenant; require stored evidence association and unchanged draft loan status.
- [ ] If that path is blocked, make the agent stop with an explicit limitation; do not activate or create a payment intake to bypass it. Document the failing dependency rather than silently enlarging backend scope.
- [ ] Run evals and the disposable runner for DB-backed verification. Document that these are agent instructions/scripted eval guarantees, not backend enforcement against arbitrary clients.
- [ ] Update documentation and changelog, review the staged files, then commit this task separately.

## Task 1B: ChatGPT Mobile attachment ingestion

**Depends on:** Task 1 evidence stops. Complete importer contracts before Task 2 catalog freezing. Actual mobile validation is a Task 7 runtime gate, not a prerequisite for independent local implementation.

**Files:** Modify backend/src/services/chatgpt-file-evidence-service.ts and its .test.ts, backend/src/services/loan-disbursement-service.ts only where necessary to reuse evidence lifecycle, backend/src/mcp/server.ts, backend/src/mcp/default.ts and their tests. Update plugin skills, evals, manifest/version and frozen contract together. Create docs/operations/chatgpt-mobile-evidence.md. If durable payout import state needs persistence, add a reviewed migration using the repository's existing migration conventions; do not reuse payment-owned rows for payout imports. Update README.md and CHANGELOG.md.

**New tool:** `loan.disbursement.evidence.import-chatgpt-file`. Preserve the existing payment importer contract. Proposed closed input mirrors its attachment object but requires the payout draft ID:

```ts
type DisbursementChatGptImportInput = {
  disbursementPublicId: string; // public UUID, validated against tenant and draft state
  idempotencyKey: string;
  chatgptFile: {
    download_url: string;
    file_id: string;
    mime_type?: "image/jpeg" | "image/png" | "application/pdf";
    file_name?: string;
  };
};
```

**Output:** Safe public draft/evidence IDs, authoritative evidence state and audit public ID(s)/correlation ID using existing write-envelope conventions. No download/signed URL, raw OCR, account data or storage credentials in the result. A successful import requires finalized ready evidence linked to the exact draft; failures must not return a success envelope claiming ready.

- [ ] Inspect existing download, storage, idempotency and tenant checks before sharing code. Verify current official ChatGPT attachment documentation and capture a redacted real mobile request shape in authorized staging. Record iOS/Android, app version/date, connection type and which file metadata actually reaches the tool. Do not assume that model image visibility implies downloadable backend access or invent a URL from file_id.
- [ ] Treat the input above as the existing importer-compatible wire contract, not proof that every mobile connection supplies it. If the supported host provides a different file mechanism, document and implement a compatible adapter based on that observed mechanism; retain old payment callers. If no backend-readable attachment is provided, stop with an actionable reattachment/connection limitation and leave mobile acceptance pending.
- [ ] Write failing tests for payout draft import with a draft parent loan, wrong tenant, posted/reversed payout target, missing file metadata and unsupported file type. Assert that importer calls neither loan activation nor payout/payment posting and creates no payment intake.
- [ ] Reuse or extract the existing bounded downloader. Authorize the target before network/file processing; require HTTPS and approved source origins; validate DNS/IP destinations and every redirect; block loopback, private/link-local destinations, embedded credentials and unsafe ports. Prevent DNS-rebinding bypass at connection time. Do not forward CreditSync bearer credentials to the download origin.
- [ ] Apply existing evidence MIME/size limits consistently, verify actual bytes rather than extension or supplied MIME, stream with an enforced byte cap and timeout, compute SHA-256 server-side, and invoke the existing prepare -> storage upload -> finalize service lifecycle. Mobile/agent does not need direct MinIO network access. Preserve existing direct-upload tools for other callers.
- [ ] Bind stable idempotency to tenant, target draft and logical attachment identity, not the expiring URL. Test concurrent same-key imports converge to one evidence association; incompatible target/content with the same key conflicts. Reusing a ready import returns its existing safe result without download/upload/finalize.
- [ ] Persist enough bounded import progress to recover after download/upload/finalize or response failure. Retry inspects current storage/evidence state and resumes; a refreshed URL for the same logical file must not create duplicate evidence. Changed file identity or checksum requires review before a new import. Never automatically delete posted associations or override duplicate-business-record checks.
- [ ] Add failures for expired source URL, timeout, oversized stream, MIME spoofing, unsafe redirect, checksum/storage mismatch, storage outage and lost response after finalize. All failures preserve recoverable state, redact URLs/tokens and cause an agent stop before financial transition. Failed temporary uploads follow existing bounded cleanup policy.
- [ ] Add payment and payout mobile-shaped evals, multiple attachments, ready retry and recipient mismatch. Every required attachment must be ready and reviewed; storage ready alone never authorizes posting. If reattachment is needed, identify the affected attachment without exposing its URL or contents.
- [ ] Run DB-independent downloader tests separately and all persistence/lifecycle tests through `bun run test` in backend/. Run backend typecheck, plugin tests/validator and regenerate the contract for the new tool before committing.
- [ ] Write a real-device staging checklist using synthetic JPEG/PNG/PDF slips: attach in ChatGPT Mobile -> exact draft import -> backend storage/finalize -> read-back shows ready evidence linked to that draft. Include interrupted request/retry, expired URL/reattachment and deliberate recipient mismatch. Verify draft financial state remains unchanged during ingestion. Financial posting, if tested, is restricted to an explicitly authorized disposable/staging tenant and explicit confirmation.
- [ ] Update README.md, mobile operations guide and CHANGELOG.md; commit separately. Report local importer verification and real-mobile support as separate statuses.

## Task 2: Cached catalog and truthful metadata

**Files:** Modify backend/src/mcp/server.ts, backend/src/mcp/server.test.ts, backend/src/mcp/contract-snapshot.ts, plugins/creditsync/references/mcp-tool-contract.json, plugins/creditsync/scripts/mcp-contract.ts and plugin contract tests. Update affected count documentation and CHANGELOG.md.

**Shared interfaces:** Export from server.ts initially to avoid unnecessary schema migration/circular imports. Keep definitions logically separate from transport; extract a catalog module only with its schema dependencies, never import server.ts back from profiles.

```ts
export type ToolProfile = "full" | "core-read" | "payments" | "loans" | "disbursements" | "admin";
export type McpToolDefinition = Readonly<{
  name: McpToolName;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  annotations: {
    title: string;
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
}>;
export type ToolPolicy = Readonly<{
  kind: "read_only" | "mutating" | "financial";
  requiresAudit: boolean;
}>;
```

- [ ] Add failing invariants for no readOnlyHint + destructiveHint overlap; financial tools destructive with declared audit policy; every name represented exactly once. Explicitly cover loan.payment-start-date.update.
- [ ] Include Task 1B's payout importer in catalog, audit/recovery classification and snapshots. Review external-download hints against its actual effects. Derive counts including this tool and Task 6 composites (baseline 130 + 1 + 3 = 134 if no other membership changes).
- [ ] Add a raw tools/call test: unknown name returns a protocol error and never invokes a service. Keep known-tool business failures as tool results.
- [ ] Generate and deeply freeze TOOL_CATALOG once at module load. Cache transport output-schema projections too; tools/list must perform no schema generation.
- [ ] Remove loan.payment-start-date.update from read-only classification. Inventory all write handlers, including newer execute tools, against audit/idempotency/recovery behavior. Determine idempotent/openWorld hints from actual effects; do not assert openWorldHint false for external import solely by convention.
- [ ] Keep public audit metadata on writes and financial failure-after-commit recovery behavior explicit. Add a test that audit lookup failure after a successful command does not imply rollback or recommend a fresh idempotency key.
- [ ] Generate plugin success snapshots and separate wire assertions from the same catalog; preserve the documented error-envelope projection in contract-snapshot.ts.
- [ ] Replace stale manual tool counts with generated values or links to the generated contract. Synchronize plugin version/manifests when contract changes require it.
- [ ] Run `bun test backend/src/mcp/server.test.ts`, plugin contract tests and `bun run plugins/creditsync/scripts/validate.ts` from root. Update CHANGELOG.md and commit.

## Task 3: Origin protection and complete dual-era transport

**Files:** Modify backend/package.json and its existing lockfile, backend/src/mcp/server.ts, backend/src/mcp/security.ts, backend/src/mcp/server.test.ts and backend/src/mcp/security.test.ts. Inspect backend/src/index.ts for CORS header integration. Update deployment docs, README.md and CHANGELOG.md.

- [ ] Add failing raw HTTP tests: absent Origin allowed, configured exact origin allowed, other/null/malformed origin rejected with 403 before JSON parsing. Preserve Host rejection, bearer auth and rate limiting.
- [ ] Parse MCP_ALLOWED_ORIGINS as exact origin values; reject invalid configuration and wildcard entries. Add modern request headers to CORS handling where browser access is configured.
- [ ] Pin verified official modern SDK packages alongside the existing v1 adapter. Use SDK era codecs for envelopes and error codes; do not implement a headers-only imitation of 2026 support.
- [ ] Add a version matrix covering each supported legacy version and 2026-07-28. Preserve legacy initialize/initialized behavior and legacy requests that legitimately omit headers; use modern routing metadata for modern requests.
- [ ] Test modern server discovery, required per-request protocol/capability metadata, optional versus malformed client identity, wire resultType and server identity metadata according to the pinned official schema.
- [ ] Test MCP-Protocol-Version, Mcp-Method and conditional Mcp-Name against body method/name and protocol metadata. Header/body mismatch returns HTTP 400 with the SDK's applicable protocol error; unsupported version and missing required metadata must be rejected without invoking tools.
- [ ] Verify GET remains 405 in POST-only mode, and legacy response envelopes contain no injected modern-only members. Exercise actual v1 and modern clients, not only mocked handlers.
- [ ] Run `bun test backend/src/mcp/server.test.ts backend/src/mcp/security.test.ts` from root and `bun run typecheck` from backend/. Document exact dependency versions, supported versions and Origin setup, then commit.

## Task 4: Pagination, cache hints and discovery benchmark

**Files:** Modify backend/src/mcp/server.ts, backend/src/mcp/contract-snapshot.ts, backend/src/mcp/server.test.ts and plugins/creditsync/scripts/mcp-contract.ts. Create backend/scripts/benchmark-mcp-discovery.ts. Update CHANGELOG.md.

Modern wire example (SDK adds wire-only members):

```json
{"resultType":"complete","tools":[],"ttlMs":300000,"cacheScope":"public"}
```

When another page exists, include nextCursor as an opaque string. Omit it on the final page. Legacy responses retain their era's shape.

- [ ] Add failing tests for first/subsequent/final pages, malformed cursor, catalog-version mismatch and cross-profile cursor reuse. Cursor rejection is Invalid Params (-32602). If cursors expire, explicitly test expiry and align lifetime with cache TTL.
- [ ] Implement deterministic 25-tool pages for modern/profile discovery. Bind opaque cursors to profile and catalog version; validate their decoded structure and bounds. Never use a cursor to change profile or authorization.
- [ ] Preserve initial unpaginated legacy full `/mcp` discovery unless supported-client tests demonstrate complete pagination. Record this compatibility exception explicitly.
- [ ] Return ttlMs 300000 and public cache scope only for authorization-independent definitions on modern discovery. Partition caches by profile, era and catalog version; inspect definitions for PII/credentials and never cache tools/call results.
- [ ] Make snapshot clients collect all pages, reject repeated cursors and duplicate tool names, and preserve deterministic order. Test empty-string cursor handling with a fake paginated server.

```ts
// Do not use `while (cursor)`: an empty string can be a valid next cursor.
const hasNextPage = (cursor: unknown) => cursor !== undefined && cursor !== null;
```

- [ ] Benchmark uncached schema generation versus cached listing and complete discovery over all pages. Report cold/warm time, total bytes, page count and schema-generation invocation count. Keep timing comparisons informational; assert zero per-request schema-generation calls deterministically.
- [ ] Run MCP and plugin snapshot tests, validator and benchmark. Record results, update CHANGELOG.md, then commit.

## Task 5: Route-selected capability profiles

**Files:** Create backend/src/mcp/tool-profiles.ts and generated profile snapshots under plugins/creditsync/references/mcp-profiles/. Modify server.ts, default.ts, server.test.ts, snapshot tooling, docs/operations/agent-mcp-plugin.md, README.md and CHANGELOG.md.

**Interface:** `TOOL_PROFILES: Readonly<Record<ToolProfile, readonly McpToolName[]>>`; `toolsForProfile(profile: ToolProfile): readonly McpToolDefinition[]`. Profiles import only the necessary types; server supplies catalog definitions without circular runtime imports.

| Route | Curated contents |
| --- | --- |
| /mcp | Full legacy-compatible catalog |
| /mcp/core-read | Borrower/portfolio, intake, contracts/schedules/history, disbursement reads and read-only diagnostics |
| /mcp/payments | Intake/evidence, matching, posting, reversal/reconciliation and required reads |
| /mcp/loans | Preview/draft/activation, rates, settlement/replacement/renewal/restructure/waiver and borrower/funding/evidence dependencies |
| /mcp/disbursements | Loan/intermediary payouts, transfer evidence, remittance and required reads |
| /mcp/admin | Diagnostics, funding, commissions, intermediary administration and operational reads |

- [ ] Define explicit name allowlists from the actual catalog; do not use broad substring selection for permission-sensitive membership.
- [ ] Add failing tests for core-read mutation exclusion, exact profile listings, out-of-profile calls without handler invocation, dependency completeness and curated union coverage of full catalog.
- [ ] Register the five curated routes with server-selected profile. Keep common auth/origin/rate-limit protections on every route. Profiles alone do not restrict a bearer that can access the full endpoint.
- [ ] Replay each profile's representative workflow using only that profile, including evidence stops; add necessary dependencies explicitly. Document any workflow intentionally requiring two connections.
- [ ] Include payment import and intake reads in payments; include payout draft/import/evidence-inspection dependencies in loans and disbursements so mobile new-loan evidence can become ready before activation without enabling full. Keep importers out of core-read.
- [ ] Generate profile snapshots and counts from the catalog. Validate complete page traversal and no unauthorized extra tools.
- [ ] Measure complete discovery bytes and tool counts against full; demonstrate at least one end-to-end workflow per profile. Test actual host connection selection because opening every profile can duplicate tool context.
- [ ] Run MCP tests and plugin validator; update private connection setup in operations docs and README.md, CHANGELOG.md, then commit.

## Task 6: Bounded composite reads

**Files:** Modify backend/src/mcp/default.ts, backend/src/mcp/server.ts, backend/src/mcp/default.test.ts, tool-profiles.ts, generated contracts and relevant plugin skills/evals. Update CHANGELOG.md and README.md.

- [ ] Add failing service-parity tests for borrower.resolve-and-portfolio, loan.inspect-context and payment.match-context using existing fixtures. Assert no insert/update/audit financial command occurs, and tenant access is identical to underlying reads.
- [ ] Define closed schemas: borrower query or public UUID with mutually exclusive selection; exact loan/intake public UUID for the other tools; view enum summary/schedule/history where applicable; default limit 25 and maximum 100 for collections. Ambiguous borrower matches remain candidates, never an automatic selection.
- [ ] Specify named cursors for each independently paginated child collection. Reject view-incompatible cursors and preserve backend ordering. Do not silently truncate data and present it as a complete portfolio/history.
- [ ] Compose existing read services directly. Return their authoritative decimal strings, warnings and evidence state; do not recompute financial values. Keep previews/executes/posts separate.
- [ ] Test empty, ambiguous, unauthorized, multi-page and maximum-limit cases, plus monetary values beyond Number safe integer precision.
- [ ] Add the tools to appropriate profiles, regenerate all snapshots/counts and update skills to use bounded summaries before detail pages. Expected count is the post-Task-1B catalog + 3, not a hardcoded 130.
- [ ] Run default/MCP tests and disposable integration tests, backend typecheck, plugin tests/validator. Update documentation and changelog, then commit.

## Task 7: Conformance, verification and rollout handoff

**Files:** Modify backend/package.json (there is no root package.json), docs/operations/agent-mcp-plugin.md and plugins/creditsync/tests/plugin-contract.test.ts. Create backend/scripts/mcp-conformance.ts, docs/operations/mcp-conformance-baseline.yml and docs/operations/mcp-canary-runbook.md. Update README.md and CHANGELOG.md.

- [ ] Inspect an existing checkout or clone the official conformance repository into a suitable external analysis workspace; read its actual runner and scenario requirements. Pin its revision and verify the real CLI before adding the backend script `mcp:conformance`.
- [ ] Create a local fixture with the required conformance tools and adapters, separate from live CreditSync financial data. Run transport, discovery, tools/list/call, pagination, schema and error scenarios supported by the pinned suite; keep application-specific tests for requirements not covered upstream.
- [ ] Baseline only explained deployment limitations, including private bearer/OAuth gaps where applicable. Record scenario, reason, upstream revision and owner; never baseline a broken implemented feature to obtain a green result.
- [ ] Execute the following gates at the final feature HEAD and preserve concise results. All DB-backed suites use the disposable runner serially; never run raw DB tests against backend/.env.

| Working directory | Gate |
| --- | --- |
| repository root | `bun test backend/src/mcp` for suites confirmed DB-independent; DB-dependent MCP suites run through the disposable runner |
| repository root | `bun test plugins/creditsync/tests` |
| repository root | `bun run plugins/creditsync/scripts/validate.ts` |
| backend/ | `bun run test` (existing disposable PostgreSQL runner) |
| backend/ | `bun run typecheck` |
| backend/ | `bun run mcp:conformance` (script added in this task) |

- [ ] Run frontend test/lint/build if changes affect shared frontend contracts/setup; otherwise record why frontend gates are not applicable. A skipped disposable financial test is not sufficient evidence for a changed financial invariant.
- [ ] Prepare canary configuration and measurement procedures for p50/p95, complete discovery bytes/time, schema-cache hits, profile usage, invalid Origin/header counts and evidence workflow stops. Exclude PII/public record IDs from metric labels.
- [ ] Independently review final diff, commits and changelog discipline; ensure no unexplained tracked changes or overwritten user files. Report feature-branch completion separately from merge, deployment and canary completion.
- [ ] Run actual staging/canary only in an available authorized environment. If unavailable, deliver the tested branch and runbook and mark runtime acceptance pending, not passed.
- [ ] Execute docs/operations/chatgpt-mobile-evidence.md on available authorized iOS and Android clients. Record platform/app version, date, connection/profile, synthetic file type, import/read-back result and retry outcome with sanitized evidence. Mark each untested platform/connection as pending; automated mobile-shaped fixtures do not establish real-device compatibility.
- [ ] Include mobile import success/failure category and time-to-ready in canary metrics without signed URLs, file IDs, borrower identity or record IDs as labels. Confirm payment and payout paths both work and failed/unverified imports produce no financial transitions.
- [ ] For an authorized read-only scenario check, inspect loan 01a099f1-3d60-7735-869a-9f0ee9e13263 and disbursement 01a099f1-6d29-76ce-9ed1-687fbc994a43. Report current evidence status/count; zero evidence must never be described as attached/complete. Do not change these financial records.
- [ ] Document full-endpoint retention: at least one major release and 30 days after profiles launch; removal additionally requires zero usage for 30 consecutive days, successful migration and explicit release approval.
- [ ] Update operations handoff, README.md and CHANGELOG.md and commit. Do not merge/push/deploy automatically.

## Acceptance and completion reporting

- [ ] Attachment-aware eval traces stop before financial transitions on failed/unverified/mismatched evidence; positive retries and pre-activation payout evidence are verified. Agent-level limits are stated accurately.
- [ ] Mobile importer tests cover tenant isolation, unsafe downloads, storage failures and durable retry; payout import never creates a payment intake or activates/posts a loan. Ready evidence remains subject to semantic review and explicit financial confirmation.
- [ ] Real ChatGPT Mobile attachment -> backend download/storage -> ready evidence -> exact draft read-back passes separately for each claimed platform/connection and both payment/payout workflows. Untested devices or unavailable file access are explicitly pending, not silently declared supported.
- [ ] Metadata invariants, public audit/recovery behavior and unknown-tool protocol errors pass.
- [ ] Schema generation occurs once; pagination/cache/profile snapshots and legacy discovery compatibility pass.
- [ ] Curated workflows work with their declared dependencies and show measured discovery reduction; pagination alone is not claimed to reduce total context.
- [ ] Actual legacy and modern clients pass transport/envelope checks; official conformance has no unexplained failures.
- [ ] Required plugin/backend/typecheck/disposable financial gates pass at the reported HEAD. Generated contracts/counts and documentation agree.
- [ ] Report separate statuses for implementation, local verification, staging/canary, integration and release approval. Pending environment-dependent work remains explicitly pending.

## Review corrections incorporated

The revised plan removes the universal payment importer first-step, distinguishes agent policy from backend enforcement, expands modern protocol beyond headers, corrects pagination wire/cursor handling, preserves legacy full discovery until client evidence supports pagination, measures whole discovery rather than individual pages, places scripts in backend/package.json, separates runtime rollout from local completion, and derives all tool counts from the catalog.

The mobile extension adds Task 1B for observed attachment transport, a dedicated payout importer, bounded backend download/storage, durable idempotent recovery and real-device acceptance. Tasks 2, 5, 6 and 7 include the new contract, profile dependencies, generated counts and runtime gates.
