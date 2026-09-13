# Workflow resolver and evidence safety design

Status: approved by the owner on 2026-09-14 for supervised Codex CLI Luna high implementation in an isolated worktree, independent verification, changelog/version updates, merge to main, push and controlled deployment. Baseline `main` commit `8d45b22`, inspected 2026-09-14 Asia/Bangkok. Production financial writes and incident remediation remain excluded.

## Problem and selected approach

An attachment-bearing close-out used intake creation, preview, legacy evidence preparation and payment posting while evidence remained pending and `evidenceRequired=false`. The deployed importer exists, but its presence and agent instructions did not enforce its use. The cached client catalog and the exact hidden tool-call payloads are not proven causes.

Use three cooperating layers: a read-only `workflow.resolve` tool backed by a deterministic registry; versioned discovery/bootstrap guidance; and authoritative evidence guards in domain services/transactions. A resolver-only change cannot secure financial writes. A generic write dispatcher would hide named financial contracts and is excluded. A mandatory resolver ticket on every legacy call would break existing clients; that is not part of this release.

The resolver is guidance, not authorization, confirmation, or an execution permit. It never persists previews, creates drafts, uploads files, computes money, or executes recommendations. Existing named tools remain the only financial interfaces.

## Safety guarantees and limits

- Posted financial records and active loan terms are immutable; no retrospective updates, deletes, or automatic reversal/reposting.
- Money remains two-decimal strings, computed by existing decimal.js services; timestamps use ISO 8601 and business dates use Asia/Bangkok.
- Authorization derives from server tenant/actor and the route-selected profile. Caller-reported state, version and attachment count are hints, never authority.
- Once the backend receives an attachment declaration or accepts an evidence preparation/import for a mutable target, that requirement is sticky. Storage/DNS/signing failures, retries and reservation cleanup cannot erase it.
- A pending required attachment blocks preview readiness and financial transition. A ready attachment cannot hide another pending required attachment. Exact target/tenant/file association and finalized state are required.
- No attachment declaration and no evidence attempt preserves legitimate legacy data-only behavior. The backend cannot detect an attachment that the client never reports; document this residual risk instead of promising universal enforcement.
- Read-only resolver results and health checks cannot register attachment requirements. Mutable create/prepare/import boundaries must do that work.
- Historical pending evidence stays pending. The recovery scanner's pending warnings are not permission to post. Posted records use supported append-only supplemental evidence only, after exact target review and confirmation.
- Preserve `/mcp`, public UUIDs, existing result envelopes and v1/v2 transport compatibility. An intentionally stricter financial safety rejection is documented as a behavior change.
- Do not claim platform refresh, mobile file handoff, semantic slip verification, or human confirmation from backend storage readiness alone.

## Evidence enforcement design

Add a narrow `financial_evidence_requirements` table, rather than backfilling immutable posted rows. It has public UUID, tenant, exactly one typed FK to a payment intake or loan-disbursement event, minimum required count, creating actor, source, request/correlation IDs and timestamps. Enforce tenant-parent integrity and one requirement per target. Counts are bounded 1–20 and may only increase while mutable. No client-facing downgrade/clear operation is introduced.

Optional `attachmentRequirement: { expectedCount: integer }` on mutable intake/disbursement creation allows supported clients to declare files before their bytes are available. Absence preserves legacy data-only behavior; an explicit zero is invalid. Prepare/import registers at least one requirement and raises the floor to the existing target's distinct required intents, under the same parent lock used by posting. Preserve payment `evidenceRequired=true` for mutable payment targets as a compatible mirror; the new requirement and actual existing intents are authoritative even when the old flag is false.

Do not count repeated retries as new files. Existing ready batch staging lineage remains valid through exact tenant/file/hash/intake linkage. Distinct pending/rejected intents remain blocking until reviewed; do not delete them or lower the requirement to escape a blocker. If no existing safe correction workflow can resolve an abandoned required attachment, return human review rather than invent one. Posted supplement preparation is a separate immutable-history workflow and must not retroactively reopen a financial requirement.

Use the same lock order for declaration/prepare/import/finalize/post. Check terminal idempotent replays first: a prior successful post returns its original receipt, not a new write or a historical evidence backfill. Test both concurrent interleavings: prepare wins and blocks post; post wins and subsequent attachment preparation is rejected/routed to supplement. Network I/O must not hold the financial transaction open. Failures retain the separately committed requirement; finalization rechecks current state under lock.

Initial hard enforcement covers payment previews/posts (including batch and restore consumers of the payment kernel), direct payout posting and activation with known associated payout requirements. Inventory settlement, renewal, replacement, restructure and intermediary execute paths. They must not silently bypass a registered requirement on a target they consume. Where a flow has no supported pre-execution evidence target/importer, attachment-bearing routing returns human review, not a pretend equivalent payment flow. Building new floating-settlement or intermediary ChatGPT attachment transports is a separate design, not an implicit deliverable.

## Resolver contract

`workflow.resolve` is available in every profile, including core-read. Closed input: intent enum, optional typed public target UUID, `attachments` enum (`none`, `present`, `unknown`), optional expected count 1–20, optional known catalog/workflow versions. No money, URLs, raw file IDs, tenant/actor, confirmation flag or arbitrary tool arguments.

Intent enum: `inspect`, `receive_payment`, `close_loan`, `originate_loan`, `disburse_loan`, `attach_evidence`, `renew_loan`, `intermediary_collection`, `tool_help`. `tool_help` also accepts a catalog tool name constrained by the route profile. Unsupported combinations fail validation.

Output: workflow ID/version, catalog version, policy revision, observed target state and evidence summary, status (`needs_input`, `next_step`, `confirmation_required`, `blocked`, `refresh_required`, `connection_required`), up to three named next steps, up to eight blockers/prohibited operations and an explicit reevaluation condition. A step contains tool name, safe partial arguments containing only verified public IDs, required input field names and confirmation requirement. Never supply `confirmed:true` or manufacture idempotency keys, preview IDs or upload URLs.

All reads use current authorized backend state. Foreign targets return the same unavailable response as inaccessible targets. Profile restrictions also filter suggestions: if the workflow needs another connection, return `connection_required`, without invoking or silently expanding into full access. No global cache of target-specific resolver responses. Cache only immutable registry/schema metadata.

Scheduled close-out resolves through authoritative loan inspection and the applicable supported payment/close-out path. Floating close-out without attachments may recommend its existing settlement preview; with attachments and no supported pre-execution evidence association it blocks for review. An exact posted intake resolves to supplement import/record, never normal import/post.

## Registry, versions and bootstrap

Store intent rules and prerequisite/transition descriptions in `backend/src/mcp/workflow-registry.ts`; import known tool names/types from the catalog. All named recommendations must exist, have compatible annotations and satisfy dependency coverage. Financial tools must be mapped to a supported workflow or explicitly classified human-review-only; never generate a generic execute tool from this registry.

Keep application release, plugin version, MCP protocol version, catalog hash and workflow revision separate. The catalog hash includes actual wire-visible definitions; workflow version changes when sequencing/safety changes even if schemas do not. Return current versions from resolver. Stale known versions trigger refresh guidance and no financial recommendation; absent versions allow safe discovery but prove nothing about the host's catalog.

Put concise resolver-first guidance in server instructions, resolver description and relevant tool descriptions, plus each plugin workflow skill. Do not assume Codex plugin files are automatically loaded into ChatGPT. New/old mobile conversations must independently show the tool is visible and receives a downloadable file descriptor.

Retain deterministic lists and existing cache hints. Advertise list-change notifications only if actual subscription publication/delivery is implemented and tested; do not toggle the capability merely to imply refresh works. A manual connection refresh/new conversation is an operator acceptance step, not something the resolver claims to have performed. Legacy clients unaware of the resolver still encounter backend safety gates.

## Acceptance and release

Reproduce the actual unsafe order with synthetic data: create with default false → preview → prepare → upload failure → old preview/post. It must produce a stable evidence blocker and zero financial writes. Include prepare/post races, ready+pending multiple files, retry cleanup, terminal idempotent replay, batch staging lineage, direct REST/domain invocation and cross-tenant failures.

Verify resolver selection with fixture tables; old catalog/client behavior with both real SDK transports; scripted agent evals with omitted resolver and failed import; and actual device tests in an explicitly authorized disposable tenant. Unit/scripted evals do not demonstrate ChatGPT model behavior or mobile transport. Use no real loan/payment writes in acceptance.

Release safety enforcement before relying on resolver adoption. Forecast app v0.4.46 and plugin 10.3.0, but recheck versions at implementation time. Generate tool counts (baseline 134, expected +1), contracts and profiles from the catalog. Every commit includes a dated/versioned CHANGELOG entry; update README for workflows/setup. Implementation requires approved plan, isolated `codex/` worktree, supervised Luna medium/high per repository policy, independent review and explicit later merge/deployment authority. This planning turn does not authorize production changes.

## Standards checked

- [MCP tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools): model-controlled discovery, deterministic catalogs and actual list-change subscription semantics.
- [MCP caching](https://modelcontextprotocol.io/specification/2026-07-28/server/utilities/caching): definition caching is distinct from target-specific execution state.

MCP does not standardize `workflow.resolve`; this is CreditSync application guidance layered on ordinary tools.
