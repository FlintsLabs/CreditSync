# CreditSync MCP Tool Discovery Implementation Plan

Execution addendum (2026-10-06): The user's later instruction routes active implementation workers to GPT-6 Luna Speed (`gpt-6-luna`, `service_tier="fast"`, reasoning medium). An earlier worker used GPT-5.6 Luna before the supervisor stopped it; that historical use and preserved work are recorded in `.superpowers/sdd/2026-10-06-mcp-tool-discovery/progress.md`. Continue from preserved changes under the new routing; do not rewrite the prior attribution. Task-order ruling: server initialization guidance must not mention `tool.catalog.search` until Task 2 registers it; add that direction in Task 2.

Task 1 review policy ruling (2026-10-06): verified service behavior takes precedence over the erroneous initial read-only catalog membership for `loan.cancel.preview`. It persists a preview, is mutating but non-destructive, and has no idempotency guarantee; remove it from `readOnlyTools`, the core-read profile, and the inherited idempotent set without changing the service. This makes the corrected core-read count 38 while full remains 146 after adding search. The other verified Task 1 corrections are guidance-only and must reflect actual schemas/services.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task in the supervised tmux worker. Steps use checkbox (`- [ ]`) syntax for tracking. Repository tmux/model-routing instructions take precedence over generic execution suggestions.

**Goal:** Make CreditSync's full tool catalog discoverable, accurately guided, profile-aware, synchronized, and verified, including `loan.schedule.defer`.

**Architecture:** An exhaustive typed guidance registry feeds concise tool descriptions, bounded metadata search, named help, and generated references. Application services retain authorization and financial execution; existing MCP transports and schemas serve every operation separately. An optional eight-tool discovery profile supports clients that need a small entry surface.

**Tech Stack:** Bun, TypeScript, Zod, installed MCP v1/v2 SDKs, Elysia, decimal.js, Drizzle, disposable PostgreSQL, existing synthetic plugin harness.

**Spec:** `docs/superpowers/specs/2026-10-06-mcp-tool-discovery-design.md` (read in full before execution).

Status: approved on 2026-10-06; Tasks 1–2 complete in commits, Tasks 3–6 remain not started.

## Global Constraints

- Plugin release is **12.0.0**; preserve existing public operation names and full-endpoint defaults.
- New tool names are exactly `tool.catalog.search` and `loan.schedule.defer`; new profile is exactly `discovery`.
- Money is two-decimal strings calculated with decimal.js; business timezone is Asia/Bangkok.
- Call services directly from MCP. Do not invoke product REST endpoints or add a generic financial executor.
- Search/help are read-only metadata guidance, never authorization, previews, financial calculations, or commands.
- Query input is trimmed 1..240 characters; limit defaults to 5 and is 1..10. Cursors bind query/profile/catalog/guidance versions.
- No paid model calls, new dependencies, production actions, live financial records, push, merge, or installed-plugin edits.
- Preserve existing unrelated dirty/untracked paths. Update CHANGELOG before each commit, with explicit version/date/type; update README with material behavior/setup changes.
- Use `backend/scripts/test-disposable-postgres.sh` for DB suites; DB resets/tests run serially. Run the complete required gates once at final HEAD and repeat only affected gates after corrections.
- Maintain honest `listChanged: false`; provider tool search/deferred loading requires host support and cannot be implemented by adding an MCP schema flag.

## Review Focus

- Thai paraphrases without spaces and generic words must not route a financial action with false confidence (Task 2 dataset and ranking tests).
- Search/help on a limited profile must not return hidden write instructions or accept caller-selected profile/context (Tasks 2 and 4).
- A write-tool tutorial, stale selection, or `confirmed: true` field must not bypass evidence/identity/state gates (Tasks 3 and 5).
- Deferral replay, partial payments, floating/inactive loans, cross-tenant rows, and owner restrictions must preserve financial state and audit provenance (Task 3 disposable integration tests).
- Catalog or guidance updates between pages must invalidate cursors and produce deterministic fresh snapshots in both transports (Tasks 2, 4, and 6).

---

## Preparation: approved handoff and isolated execution

**Files:** the linked spec and this plan; no production source edits in this step.

- [ ] Obtain explicit approval of both documents, citing AGENTS.md's pre-delegation requirement. Do not infer approval from silence.
- [ ] Recheck main HEAD and `git status --short`; preserve `.codex-task-logs/`, `.slips/`, and the pre-existing untracked 2026-09-12/13/20 planning documents. Check existing worktrees/session names before creating new ones.
- [ ] Apply `superpowers:using-git-worktrees` and create branch `codex/mcp-tool-discovery` at the approved baseline in `/home/flintstone/github/CreditSync-worktrees/mcp-tool-discovery` (choose a non-conflicting suffix if occupied).
- [ ] Copy the approved spec/plan into the feature worktree, recording source paths and avoiding unrelated untracked files. Do not overwrite newer tracked versions.
- [ ] Start `creditsync-mcp-tool-discovery` using the latest verified Luna release and explicitly configure medium reasoning plus Fast service tier (currently `gpt-6-luna`, `service_tier="fast"`). Set the three task-specific shell variables to the actual worktree, local log directory, and prompt file; no credentials belong in any of them. Pass repository/worktree/branch/main target, both document paths, acceptance criteria, ordered tasks, verification gates, financial rules, dirty-file ownership, and scope exclusions through that prompt file. Confirm runtime permissions and supervise any approval block before allowing implementation to continue.
- [ ] Report actual session/worktree/branch/model/fallback state and disconnect safety. Supervise output, approval prompts, Git state, commits, and tests; use the current task model only if Luna fails and report why.

## Task 1: exhaustive tool guidance and shared instructions

**Files:** create `backend/src/mcp/tool-guidance.ts`, `backend/src/mcp/tool-guidance.test.ts`; modify `backend/src/mcp/server.ts`, `backend/src/mcp/modern.ts`, `backend/src/mcp/server.test.ts`, `CHANGELOG.md`, `README.md`, `AGENTS.md`.

**Interfaces:** export `ToolGuidance`, `TOOL_GUIDANCE: Readonly<Record<McpToolName, ToolGuidance>>`, `TOOL_GUIDANCE_VERSION: string`, `MCP_SERVER_INSTRUCTIONS: string`, and `describeTool(toolName: McpToolName): string`. Guidance imports catalog types only; no runtime import cycle through server/default/workflow modules.

- [x] Write failing coverage tests: registry keys equal `MCP_TOOL_NAMES`; exact typed fields and bounds from the spec hold; every related name is a real tool; guidance hash changes with meaningful content and is stable across object key order. Empty side-effect lists remain valid for reads.
- [x] Add behavioral description assertions for persisted previews, read-only `loan.commission.reverse`, distinct payment/payout evidence importers, cancelled replacement versus reversed restore, and first-date correction versus deferral. Read actual service/schema behavior for the remaining entries.
- [x] Run `bun test backend/src/mcp/tool-guidance.test.ts` and record the expected missing-registry failures.
- [x] Implement the registry for all current tools and later extend it for both new names. Move existing purpose strings into the registry, compose concise descriptions with important use/side-effect/retry constraints, and keep schema/policy/annotation definitions authoritative in the catalog.
- [x] Replace legacy and modern server initialization instructions with the same constant. Do not invent modern deferred-loading or notification capabilities.
- [x] Run guidance/server/modern tests with fixture handlers; verify changed descriptions are identical across the advertised transport definitions and no schema generation is introduced in `tools/list` request handling.
- [x] Update root changelog under a dated project version before committing. Commit the registry/instructions with their tests and behavior documentation; do not add unrelated files.

## Task 2: bounded profile-aware capability search

**Files:** create `backend/src/mcp/tool-catalog-search.ts`, `backend/src/mcp/tool-catalog-search.test.ts`; modify `catalog-types.ts`, `server.ts`, `default.ts`, `tool-profiles.ts`, `server.test.ts`, `modern.test.ts`, `CHANGELOG.md`.

**Interfaces:** export `ToolCatalogSearchInput`, `ToolCatalogSearchResult`, and `searchToolCatalog(input: ToolCatalogSearchInput, context: { profile: ToolProfile; catalogVersion: string; guidanceVersion: string; catalog: readonly McpToolDefinition[] }): ToolCatalogSearchResult`. Search reads supplied immutable metadata; the default handler uses the serving catalog and server-selected context.

- [x] Write failing tests for exact names, Thai and English capability phrases, multiple plausible tools, unrelated requests, limit boundaries, stable ordering, and absent-profile matches. Assert no borrower reads, audit insertions, persisted previews, or command handler calls.
- [x] Add cursor tests for query/profile/catalog/guidance changes, malformed and overflow/out-of-range offsets, and bounded complete traversal. Unknown queries return `no_match`; an unavailable capability returns empty matches and only appropriate connection/profile guidance.
- [x] Run `bun test backend/src/mcp/tool-catalog-search.test.ts` and verify failures describe the missing implementation.
- [x] Implement normalization and ranked metadata matching as specified. Keep Thai aliases curated; avoid treating lexical similarity as an automatic borrower/financial decision. Filter actual match names and related names through the active profile.
- [x] Register the closed input/output schemas for `tool.catalog.search`; add it to all current profiles as read-only/non-destructive/idempotent/closed-world. Use structured results plus a concise textual summary.
- [x] In `executeMcpToolCall`, inject server-selected profile/catalog/workflow context for this metadata handler only after schema validation, as for `workflow.resolve`. Reject attempts to send `profile`, `tenantId`, `__profile`, or execution fields in public input. Add default handler without product REST or a generic executor.
- [x] Verify legacy and modern transport calls return schema-valid results, denied malformed inputs never invoke the handler, and no financial/audit envelope is attached to search results.
- [x] Update changelog and commit search registration, tests, and public behavior together.
- [x] Complete Task 1 review corrections and Task 2 follow-ups: real bounded output enums/maxima; strict cursor key, overflow, cross-snapshot, and ranked-result bounds; full serving metadata filtered by server-selected profile; bilingual high-risk phrase distinctions; valid closed-input tests for both transports with handler/audit lookup guards; accurate preview/confirmation/retry/source attribution guidance. Leave plugin artifacts for Task 5.

## Task 3: register and safely guide installment deferral

**Files:** modify `backend/src/mcp/catalog-types.ts`, `server.ts`, `default.ts`, `tool-profiles.ts`, `tool-guidance.ts`, `workflow-registry.ts`, `workflow-resolver.ts`, `workflow-resolver-service.ts`, `workflow-version.ts`; modify `backend/src/services/loan-schedule-deferral-service.ts`; create `backend/src/services/loan-schedule-deferral.integration.test.ts`; extend `server.test.ts`, `default.test.ts`, and resolver tests; update changelog.

**Interfaces:** add `inspectLoanScheduleDeferral(ctx: CommandContext, loanPublicId: string, schedulePublicId: string)` as an authorized read-only helper returning eligible/blocked reason and exact safe source/replacement review data. Existing `deferLoanSchedule(ctx, loanPublicId, schedulePublicId, { reason })` remains the command. Resolver gains `defer_installment` and optional `schedulePublicId`.

- [ ] Write missing-tool and schema tests for `loan.schedule.defer`: exact required UUID/reason/idempotency/`confirmed: true` input; unknown or false confirmation fields fail before execution; safe decimal-string output, destructive/idempotent/financial policy, and full/loans-only visibility.
- [ ] Add disposable integration fixtures for an active scheduled loan and fully unpaid source. Assert replacement due date is the day after the schedule tail, source becomes deferred, contractual installment count stays unchanged, principal/interest/fee/total are conserved, no payment transaction is inserted, and the deferral ledger/audit are linked to the command context.
- [ ] Test same-key identical replay returns the existing replacement; concurrent identical retries produce one ledger/audit/replacement and resume it; changed-payload key reuse conflicts; partial/floating/inactive/cross-tenant/cross-owner requests stop without writes. Assert required public audit IDs and correlation IDs are retrievable through the normal MCP audit adapter.
- [ ] Run the focused tests through `bash backend/scripts/test-disposable-postgres.sh src/services/loan-schedule-deferral.integration.test.ts src/mcp/default.test.ts`; capture the intended missing-adapter failures without a production database.
- [ ] Register strict safe output, handler calling the existing service, risk/idempotency sets, financial envelope, and audit target `loan_schedule_deferral` / `deferred`. Do not recreate calculations in the MCP adapter.
- [ ] Implement the service inspection helper by reusing actual eligibility/access/date policies. Add resolver observation and review data for exact loan/schedule selection. Missing schedule requires inspection/selection; ineligible or unauthorized source stops; eligible source returns confirmation-required guidance with required inputs, never confirmation or execution.
- [ ] Extend resolver tests for missing target/schedule, selected wrong-loan schedule, inactive/floating/partial source, profile restrictions, stale catalog/workflow versions, and successful no-write confirmation guidance. Execution must revalidate current state in the existing transaction.
- [ ] Run focused disposable tests and backend typecheck. Fix adapter/audit/authorization/replay defects necessary for the specified behavior. Report for review only if the repair requires new financial terms or policy outside the spec.
- [ ] Update changelog and commit registration/service inspection/resolver safety tests together.

## Task 4: small entry profile and complete named tool help

**Files:** modify `backend/src/mcp/catalog-types.ts`, `tool-profiles.ts`, `workflow-resolver.ts`, `workflow-resolver-service.ts`, `workflow-registry.ts`, `server.ts`, `backend/src/index.ts`; extend `profiles.test.ts`, `workflow-resolver.test.ts`, `workflow-resolver-output.test.ts`, `workflow-resolver-service.test.ts`, `server.test.ts`, `modern.test.ts`; update `backend/scripts/benchmark-mcp-discovery.ts` and changelog.

**Interfaces:** add `ToolProfile = ... | "discovery"`. Named help's optional `toolHelp` uses registry text plus catalog-derived required input names and version. It never supplies a write as an executable next step merely because help was requested.

- [ ] Write profile tests asserting exactly eight names from the spec, all read-only annotations, no mutation handler called on denied writes, and identical pagination/authorization protections across both transport eras.
- [ ] Add complete named-help coverage for every visible tool. Test no-target help does not read financial data; write help returns documentation and prerequisites without permission; missing/hidden names and stale versions remain explicit stops; related names are filtered.
- [ ] Test that prior inspect target-state checks and all evidence/duplicate/recovery/renewal/settlement/attachment transport stops remain unchanged. Do not turn `tool_help` into generic operation execution.
- [ ] Implement the additive profile, mount `/mcp/discovery` with the existing secure default adapter, and include it in benchmark traversal. Keep existing allowlists plus the additions; do not reduce the full endpoint or silently switch existing clients.
- [ ] Implement bounded optional help with the exact fields from the spec, add optional `knownGuidanceVersion` input, and use the serving catalog to derive required names. Skip domain reads for pure documentation requests while preserving authoritative reads for actual state-aware workflow resolution.
- [ ] Set `WORKFLOW_VERSION` to `workflow-resolver-1.2.0` and policy revision to an accurate 2026-10-06 discovery/deferral revision. Keep guidance hashing independent and reject obsolete known versions.
- [ ] Run guidance/search/profile/resolver/server/modern unit tests and affected disposable resolver-service tests. Update changelog and commit the profile/help contract together.

## Task 5: synchronized plugin guidance and honest routing evaluations

**Files:** modify `plugins/creditsync/.codex-plugin/plugin.json`, `skills/*/SKILL.md` as applicable (retain 11 skills), `README.md`, `CHANGELOG.md`, `scripts/validate.ts`, `tests/plugin-contract.test.ts`, `tests/eval-harness.test.ts`, `evals/harness.ts`, `evals/evals.json`; create `evals/discovery-cases.json`, `scripts/evaluate-discovery.ts`, `scripts/grade-tool-traces.ts`, `tests/discovery-evals.test.ts`, `tests/tool-trace-grader.test.ts`; create `references/tool-guide.md` and `scripts/tool-guide.ts`; modify `backend/src/mcp/contract-snapshot.ts`; update root README/changelog and `docs/operations/agent-mcp-plugin.md`.

**Interfaces:** generated guide consumes registry/catalog only. Discovery dataset records case ID, query/profile, expected/forbidden candidate names, and expected status. Trace grader accepts sanitized recorded case IDs, model/catalog/guidance versions, actual tool names/order, outcome, and explicit confirmation-event metadata; it performs no API calls.

- [ ] Add discovery cases for Thai deferral phrases, first-date correction, paid versus cancelled/reversed payments, read-only commission reversal, payment/payout evidence, renewal/replacement, unknown requests, ambiguous wording, denied profiles, and stale guidance. Keep fixture names/data synthetic.
- [ ] Write dataset tests asserting correct unambiguous first candidate, required candidate inclusion, no forbidden candidates, no hidden executable instructions, and safe ambiguity/no-match behavior. Write trace-grader tests for missed calls, wrong/forbidden calls, unmet prerequisites/confirmation, valid runs, and malformed records.
- [ ] Extend synthetic orchestration scenarios for confirmed eligible deferral and stops for unconfirmed/partial/stale/wrong-profile choices. Synchronize `evals.json` with harness scenario IDs, schema-valid arguments/outputs, and truthfully `liveMcpCallsPerformed: false`.
- [ ] Implement deterministic dataset evaluation and local trace grading. Report metadata-search results separately from model tool-choice results; absent recorded runs means model evaluation is not run, not a passing score.
- [ ] Update root skill with uncertain capability search then state-aware resolution. Update manage-loans discovery text and explicit inspect/review/confirm/defer/re-inspect instructions. Update relevant skills with importer/reversal/restore distinctions and error recovery without copying the full tutorial into every skill.
- [ ] Generate the reference guide from registry/catalog and require exact guidance coverage and valid named references in the validator. Also require profile snapshots to match the serving catalog, not merely exist.
- [ ] Set plugin release to 12.0.0; update manifest, validator/tests, contract compatibility text (next breaking release 13.0.0), plugin README/changelog, root README/changelog, and version/count claims from actual inventory. Keep connection IDs and environment/secret material out of generated artifacts.
- [ ] Regenerate `bun run plugins/creditsync/scripts/mcp-contract.ts --write`, `bun run plugins/creditsync/scripts/mcp-profiles.ts`, and `bun run plugins/creditsync/scripts/tool-guide.ts --write`. Repeat generation and verify no second-run diff.
- [ ] Run `bun test plugins/creditsync/tests`, `bun run plugins/creditsync/scripts/validate.ts`, and the deterministic discovery evaluator. Document host-native deferred-loading setup, profile connection changes, refresh/reconnect after rollout, and explicitly unverified host/model acceptance.
- [ ] Stage only task files plus accurate changelog/README entries and commit synchronized generated artifacts with their consumers.

## Task 6: final gates, review, and branch handoff

**Files:** create `docs/operations/mcp-tool-discovery-verification.md`; modify benchmark/conformance fixtures or baseline only when the new public contract requires it. Update root changelog with the verification documentation before any final documentation commit.

- [ ] Inspect the complete feature diff, changes to schemas/policy/confirmation/audit lookup, related-name/profile filters, service calls, and preservation of all unrelated user changes. Check there is no new paid service, hidden executor, raw query/evidence logging, financial arithmetic in agent guidance, or unsupported host capability claim.
- [ ] Run the full backend disposable suite once, serialized: `bash backend/scripts/test-disposable-postgres.sh`. Record skips distinctly; required deferral/audit/authorization invariants must execute.
- [ ] From backend run `bun run typecheck`, `bun run mcp:discovery:benchmark`, and `bun run mcp:conformance`. Inspect every result; compare measured discovery wire bytes for full and the eight-tool profile without calling them token counts or model accuracy.
- [ ] From frontend run `bun run test`, `bun run lint`, and `bun run build`, as the repository gates for a changed financial MCP surface.
- [ ] Run final plugin tests/validator and deterministic discovery evaluator, validate generated snapshot reproducibility, and grade recorded model traces only if actually supplied. Existing synthetic harness success cannot establish model tool-selection improvement.
- [ ] Independently supervise verification at the final reported commit. Confirm commit contents, branch HEAD, expected tool/profile counts, no unexplained tracked changes, and preservation of main/user files. Repeat only affected gates after review fixes, then record the commit each gate covered.
- [ ] Write a concise verification report with command results, remaining skipped/unverified checks, measured metadata-search metrics, model evaluation status, client refresh procedure, and observed pre-change catalog mismatch. Keep live system alignment as deployment-pending until separately authorized and verified.
- [ ] Complete the isolated branch and report session/worktree/branch/HEAD, gate results, and limitations. No merge or push has been requested; if subsequently authorized, use the stated integration target and verify `git merge-base --is-ancestor <feature> <target>` after merging.

## Plan self-review

All spec requirements map to Tasks 1..6: exhaustive guidance/description truth (1), discovery/query/version/profile safety (2), missing financial operation and state-aware deferral (3), small entry surface/complete help (4), generated contract/skills/versions/datasets/host setup (5), and independent verification/reporting (6). Review-focus cases have explicit owning tests. Search and help use registry/catalog metadata, deferral uses authorized services, and provider-host capabilities are documented rather than fabricated. Implementation remains blocked on the explicit pre-delegation approval required by AGENTS.md.
