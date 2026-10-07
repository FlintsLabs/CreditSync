# CreditSync MCP tool discovery and guidance

Status: proposed for user review. Product implementation has not started.
Date: 2026-10-06 (Asia/Bangkok).
Baseline: main at `0f77e82c`; recheck HEAD and dirty-file ownership before execution.

Execution addendum (2026-10-06): Task 1 is being implemented by the delegated worker using GPT-6 Luna Speed (`gpt-6-luna`, `service_tier="fast"`, reasoning medium), per the user's later explicit routing instruction. The earlier worker used GPT-5.6 Luna before the supervisor stopped it; its work was preserved and reviewed, and its model use is recorded in the progress ledger. This routing update applies to subsequent workers for this task and does not alter historical attribution.

## Purpose and evidence

The user requested implementation of the researched practices for reducing wrong tool selection, missed tools, invalid arguments, and unsafe workflow transitions when many plugins/tools are available. Success means that CreditSync capabilities are searchable, independently callable, accurately documented, profile-aware, and tested against the serving contract. Model selection accuracy must be measured separately from deterministic contract tests.

The current repository declares 145 tools and plugin 11.0.0 with 11 skills. Profile counts are full 145, core-read 38, payments 67, loans 45, disbursements 41, and admin 36, taken from `plugins/creditsync/references/mcp-profiles/index.json`.

`loan.schedule.defer` is absent from the repository MCP names, schemas, handlers, profiles, and frozen contract, although `backend/src/services/loan-schedule-deferral-service.ts` and migration 0057 exist. The tool advertised to this chat is named `mcp__creditsync__loan_schedule_defer`. A read-only live `workflow.resolve` request for its help on 2026-10-06 returned `TOOL_HELP_REQUIRES_WORKFLOW_RESOLUTION`, rather than `TOOL_NAME_REQUIRED`, with catalog version `mcp-catalog-faa641b33fc14de5`. The repository snapshot is `mcp-catalog-1b04c1db0aaaf82a`. This confirms a catalog mismatch; it does not verify execution of the financial command or identify the deployed Git commit.

Current `tool_help` requires an exact tool name and only suggests tools classified under `inspect`. Other tools fall back to human review in `workflow-registry.ts`. Existing plugin evals use an executable synthetic harness; they are not evidence of a model discovering the right tool from a user prompt. Modern transport intentionally advertises `listChanged: false` because it does not expose notification subscriptions.

## Selected approach

Implement an exhaustive, typed guidance registry, one read-only capability search tool, complete named help through the existing resolver, an optional small discovery profile, and missing schedule-deferral registration. Keep each actual operation separately exposed and keep financial authorization in the application services.

Alternatives considered:

- Descriptions alone: smaller change, but cannot provide bounded capability search or detect stale guidance.
- Registry plus search, help, profiles, and verification: selected because it improves both discovery and correct usage within the existing MCP architecture.
- A new custom AI host with dynamic allowlists and provider tool search: potentially useful, but adds a separate application and provider integration outside the present backend/plugin task.

## Scope and compatibility

- Add public tools `tool.catalog.search` and `loan.schedule.defer`. Existing public tool names stay stable.
- Add the `discovery` profile without removing tools from existing profiles or changing the existing full endpoint default.
- Expand named help and add deferral guidance to `workflow.resolve`.
- Improve descriptions and guidance for every catalog tool, not just the new tools.
- Generate plugin references, schemas, counts, versions, and documentation from the serving catalog and guidance registry.
- Release plugin **12.0.0**, since richer resolver outputs can affect consumers with closed output schemas. Freeze that contract; subsequent breaking changes require 13.0.0.
- Use the existing Bun, TypeScript, Zod, MCP SDK, Decimal, and PostgreSQL stack. No dependency upgrades or external AI service are required.
- Do not rewrite accounting algorithms, create new financial migrations, rename legacy tools, or restructure unrelated subsystems.
- Production deployment, installed-plugin replacement, push, merge, live financial writes, and paid model evaluations require their own authorization. This implementation finishes on an isolated feature branch.

## Guidance registry

Create `backend/src/mcp/tool-guidance.ts` with a `Record<McpToolName, ToolGuidance>` covering every name exactly once. Each entry contains a concise purpose, domain, when-to-use guidance, prerequisites, actual side effects, retry guidance, human-confirmation requirements, common errors/recovery, bilingual search terms, and related tool names. Tool-specific details must be read from their real schemas and services; do not infer behavior only from a name suffix such as `preview` or `reverse`.

Use these exact registry fields:

```ts
type ToolGuidance = Readonly<{
  purpose: string;
  domain: "borrowers" | "payments" | "loans" | "disbursements"
    | "intermediaries" | "funding" | "diagnostics" | "discovery";
  whenToUse: readonly string[];
  prerequisites: readonly string[];
  sideEffects: readonly string[];
  retrySafety: string;
  requiresHumanConfirmation: boolean;
  commonErrors: readonly Readonly<{ code: string; recovery: string }>[];
  searchTerms: Readonly<{ en: readonly string[]; th: readonly string[] }>;
  relatedTools: readonly McpToolName[];
}>;
```

An empty side-effect list means no side effects. Confirmation guidance describes the human workflow and does not imply that every tool accepts a `confirmed` argument. Individual help/search results are bounded: arrays of guidance text contain at most 8 strings of at most 320 characters each; common errors and related tools contain at most 8 entries. Advertised tool descriptions are at most 1,800 characters, with detailed instructions in named help instead of repeated across all schemas.

The serving catalog remains authoritative for input/output schemas, annotations, and operation policy. Guidance references those definitions rather than duplicating risk booleans or complete schemas. Root required input names in help are derived from the actual advertised input schema. Related tool names shown to clients are filtered through the active profile.

Descriptions are generated from the registry and accurately state purpose, use conditions, important side effects, and retry/confirmation constraints. Both transport eras and generated references use the same description. Avoid excessively long tutorial text in every definition; detailed help is loaded when requested.

Export `TOOL_GUIDANCE_VERSION`, a deterministic hash of the canonical guidance registry. `catalogVersion` remains derived from the serving catalog; `workflowVersion` remains an independent version. Search cursors and supplied known versions must detect stale guidance as well as stale catalog definitions.

Use one concise server-instructions constant in the legacy and modern initialization paths. It names `tool.catalog.search` for uncertain capability selection and `workflow.resolve` for state-aware financial workflow guidance, while retaining inspect, confirmation, evidence, and backend-authority rules.

## Capability search

Register `tool.catalog.search` as read-only, non-destructive, idempotent, closed-world, and non-financial. It reads catalog metadata only; it does not read borrower records, calculate money, persist previews, or execute another tool.

Closed input:

```ts
type ToolCatalogSearchInput = {
  query: string; // trimmed, 1..240 characters
  limit?: number; // integer 1..10, default 5
  cursor?: string;
  knownCatalogVersion?: string;
  knownGuidanceVersion?: string;
};
```

The server supplies profile and versions after schema validation. Callers cannot supply tenant, actor, profile, hidden context fields, or an execution operation.

Closed output includes `profile`, `catalogVersion`, `guidanceVersion`, `status`, `matches`, `hasMore`, `nextCursor`, and `requiredProfiles`. Status is `matches`, `needs_clarification`, `no_match`, `connection_required`, or `refresh_required`. Each match has fields `toolName`, `purpose`, `domain`, `whenToUse`, `prerequisites`, `sideEffects`, `retrySafety`, `requiresHumanConfirmation`, and `relatedTools`, derived from the registry and filtered serving definitions. It is a candidate, never an authorization or an automatic command choice. `nextCursor` is a string or null; `hasMore` is boolean; `requiredProfiles` is an array of profile names.

Search normalizes Unicode, case, punctuation, and whitespace and supports curated Thai/English phrases. Rank exact tool-name matches first, curated capability phrases second, then meaningful lexical overlap. Generic words alone must not establish a unique financial action. Stable tie-breaking follows catalog order. Ambiguous requests retain multiple candidates and request clarification. Unknown requests return `no_match` and no fabricated tools.

Match payloads contain only tools callable on the active profile. If the requested capability exists only on another profile, return `connection_required`, empty matches, and suitable profile names; do not return executable hidden-tool instructions. Cursors are opaque, bounded, and bound to normalized query, profile, catalog version, guidance version, and result offset. Changed versions/query/profile invalidate them.

## Small discovery profile and host integration

Expose `/mcp/discovery` with exactly these eight tools:

1. `tool.catalog.search`
2. `workflow.resolve`
3. `borrower.search`
4. `borrower.resolve-and-portfolio`
5. `loan.inspect-context`
6. `payment.match-context`
7. `intake.get`
8. `funding-source.list`

It uses the existing authentication, actor authorization, origin/host checks, rate limiting, pagination, and output validation. All eight tools must actually be read-only. Profile membership is a discovery filter, not a replacement for application authorization, and a bearer that also accesses `/mcp` is not restricted by choosing this profile.

Add search to every existing profile. Actual write tools remain individually exposed in their existing domain profiles. A client may connect to the required domain profile after discovery; a search response cannot load or activate a hidden tool by itself. Document avoiding unnecessary simultaneous connections to overlapping profiles.

Provider-hosted deferred loading, `tool_choice`, dynamic allowlists, and native tool search are host/API features. Document the supported integration paths and distinguish them from the CreditSync metadata search tool. Do not add unsupported provider properties to MCP wire definitions, claim automatic loading in every ChatGPT/Codex client, or advertise unsupported list-change notifications. Keep `listChanged: false`; document refresh/reconnect and version checks after rollout.

## Complete named help and resolver safety

For `workflow.resolve` with `intent: "tool_help"`, return optional `toolHelp` derived from the registry for every named tool visible on the active profile. Its exact fields are `toolName`, `guidanceVersion`, `purpose`, `whenToUse`, `prerequisites`, `sideEffects`, `retrySafety`, `commonErrors`, `requiresHumanConfirmation`, `requiredInputs`, and `relatedTools`. `requiredInputs` comes from the actual input schema. Add optional `knownGuidanceVersion` to resolver input; stale help guidance requires refresh before returning a next step. Help without a financial target must not perform domain-data reads.

Help is documentation, not permission. Existing target/state/version gates and status meanings remain authoritative. An inspection step may be returned only under the existing inspection conditions. Named write help returns no executable write step and retains the requirement to resolve/inspect the workflow. Unknown names and tools absent from the profile remain explicit missing-tool/connection cases. Do not equate `confirmed: true` with proof that a human approved the action.

Add `defer_installment` to resolver intents and an optional `schedulePublicId` field used for that intent. The exact loan remains a normal loan target. Without a selected schedule, return the visible loan inspection step and require selection. With an exact schedule, use a read-only service inspection of the accessible active scheduled loan, fully unpaid source, and current tail. Return exact backend-produced source/target dates and amount components for review. Ineligible or inaccessible selections must stop. Only an eligible current selection can produce `confirmation_required` with `loan.schedule.defer` and its required inputs; the resolver does not set confirmation or execute the command.

All existing payment duplicate/evidence/recovery, renewal, settlement, intermediary, target-kind, and stale-version stop paths must continue to pass. Additive help must not create a shortcut through those gates.

## Schedule-deferral registration

Closed input exactly matches the tool already advertised to this chat:

```ts
{
  loanPublicId: UUID,
  schedulePublicId: UUID,
  reason: NonBlankString,
  idempotencyKey: NonBlankString,
  confirmed: true
}
```

The handler calls `deferLoanSchedule` directly with the existing command context. Register financial/destructive/idempotent annotations and policy, strict safe output, and the audit target `loan_schedule_deferral` / `deferred`. Expose it on full and loans, not on read-only profiles.

Output contains the loan/source/replacement public UUIDs, `sourceStatus: "deferred"`, replacement installment number and due date, principal/interest/fee/total decimal strings, audit public UUID(s), and correlation UUID. It records no payment. Service rules remain authoritative: an active scheduled loan, a fully unpaid eligible source, next day after the existing tail, stable idempotent replay, and an append-only deferral audit. Inspect, present exact changes, obtain explicit human confirmation, defer, and re-inspect the schedule/history.

Add a reusable read-only inspection helper in the deferral service for resolver guidance. Execution still revalidates in its transaction; a read inspection is not a persisted or guaranteed current preview. Fix adapter, audit, authorization, and replay correctness necessary for the specified behavior. Concurrent identical retries must produce at most one deferral and resume the same replacement, with no partial writes. Escalate only if a repair requires a new financial-policy choice outside this spec.

## Synchronization, documentation, and evaluation

Generate frozen `mcp-tool-contract.json`, all profile snapshots, index counts, and a bounded/reference tool guide from the actual definitions and guidance registry. Compare complete authenticated local `tools/list` traversal against the frozen contract in both transport eras and every profile. Unknown/duplicate/missing guidance and stale snapshots are validation failures. Regeneration must be deterministic and leave no second-run diff.

Update existing skills and their discovery descriptions as necessary, keeping the 11-skill inventory. The root skill teaches uncertain capability search followed by state-aware resolution; manage-loans teaches deferral and separates it from first-date correction, renewal, replacement, and payment posting. Teach specific error recovery and explicit connection changes. Do not place the whole catalog tutorial in the root skill.

Add a standalone deterministic discovery evaluation dataset with Thai/English paraphrases, exact names, similar tools, ambiguity, absent profiles, unknown capabilities, and stale versions. Measure expected candidate recall, first-choice accuracy for unambiguous fixtures, inappropriate matches, and safe no-match/clarification behavior. Extend synthetic workflow scenarios for deferral/help/no-write stops. These measure catalog search and deterministic orchestration, not a live model's tool-selection accuracy.

Provide a local trace-grading script for sanitized recorded model runs, with case ID, actual tool names/order, outcome, and no raw user/evidence contents. Report missed expected calls, wrong/forbidden calls, and unmet prerequisite/confirmation steps separately. Require recorded runs to compare a model baseline with the new catalog; when none are supplied, report model evaluation as not run. No paid API calls are part of this implementation.

## Acceptance and verification

1. Every serving tool has complete, behavior-accurate guidance; all related names exist and public schemas remain closed where appropriate.
2. Search/help never perform a financial write, leak hidden execution instructions, choose a borrower, authorize a command, or persist user query text.
3. Thai and English deferral queries find the new tool on loans/full and request the loans connection on discovery/core-read; first-date correction, renewal, settlement, payment capture, and commission reversal remain distinguishable.
4. Discovery exposes exactly eight read-only tools. Existing profiles retain their prior capabilities plus explicitly added tools.
5. Deferral integration tests prove no payment insertion, conserved amount components, correct source/replacement state, public audit metadata, replay/conflict behavior, and partial/floating/inactive/tenant/owner rejection.
6. Named help covers all visible tools; read/write guidance never bypasses existing resolver stop paths.
7. Frozen artifacts, plugin 12.0.0, skills, evals, validator, guide, README, and release notes agree with the final catalog. Expected full count is baseline plus two; derive actual counts instead of copying historical numbers.
8. Required commands pass: full serialized disposable backend suite; backend typecheck; frontend test/lint/build as the project financial-feature gates; plugin tests and validator; discovery dataset/grader tests; local discovery benchmark and MCP conformance. A skipped database invariant is not a pass.
9. Final report distinguishes deterministic checks, disposable database execution, model evaluation, host acceptance, branch completion, integration, and deployment. Live model/host acceptance remains explicitly unverified unless actually performed.

## Execution and ownership

Per AGENTS.md, this is substantial multi-file work delegated through supervised tmux only after the user approves this spec and its detailed plan. Proposed session: `creditsync-mcp-tool-discovery`; branch: `codex/mcp-tool-discovery`; worktree: `/home/flintstone/github/CreditSync-worktrees/mcp-tool-discovery`; integration target: main, with no merge authorization supplied.

Implementation worker: Codex CLI `gpt-5.6-luna`, `model_reasoning_effort="medium"`; if unavailable/rejected/exhausted, use the current task's selected model and report the reason. Preserve all pre-existing untracked directories and prior plans/specs. Keep secrets, environment files, .slips, and .codex-task-logs out of worker prompts/logs/commits. Root reviews the final diff and independently confirms all gates on the reported HEAD before completion.

## Source references

- [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling): clear definitions, constrained schemas, small initial tool sets, code-owned deterministic operations.
- [OpenAI tool search](https://developers.openai.com/api/docs/guides/tools-tool-search): deferred loading, namespace guidance, discovery tradeoffs, host/API distinctions.
- [OpenAI plugin guidelines](https://developers.openai.com/plugins/plugin-guidelines): truthful descriptions, separate reviewed operations, explicit annotations, no hidden generic executor.
- [MCP tools specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools): discovery, schema validation, errors, authorization, notification capability honesty.
- [Evaluate agent workflows](https://developers.openai.com/api/docs/guides/agent-evals): traces and repeatable datasets for actual tool choice and workflow evaluation.
