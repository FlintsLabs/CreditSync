# CreditSync Workflow Resolver and Evidence Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Help agents select current named tools while preventing financial transitions over backend-known incomplete evidence.

**Architecture:** Domain-service evidence guards are independent of agent behavior; an immutable workflow registry powers one read-only resolver and shared guidance. Versioned discovery remains compatible with existing v1/v2 clients and curated profiles.

**Tech Stack:** Bun, TypeScript, Elysia, existing MCP SDKs v1/v2, Zod, PostgreSQL, decimal.js, plugin eval harness.

**Spec:** `docs/superpowers/specs/2026-09-14-workflow-resolver-evidence-safety-design.md`

## Global Constraints

- Posted financial records and active loan terms are immutable; no retrospective updates, deletes, or automatic reversal/reposting.
- Money remains two-decimal strings, computed by existing decimal.js services; timestamps use ISO 8601 and business dates use Asia/Bangkok.
- Authorization derives from server tenant/actor and the route-selected profile. Caller-reported state, version and attachment count are hints, never authority.
- The resolver is guidance, not authorization, confirmation, or an execution permit.
- No attachment declaration and no evidence attempt preserves legitimate legacy data-only behavior. The backend cannot detect an attachment that the client never reports.
- Preserve `/mcp`, public UUIDs, existing result envelopes and v1/v2 transport compatibility.
- Do not claim platform refresh, mobile file handoff, semantic slip verification, or human confirmation from backend storage readiness alone.
- Every implementation commit updates versioned/dated CHANGELOG first and README when setup/workflow changes. Do not commit production credentials, sample slips or private identifiers.
- Run database-backed tests only through the disposable PostgreSQL runner, serialized. Never point this runner at a live/restored production database.
- Owner approval received 2026-09-14: isolated worktree, supervised Codex CLI Luna high, independent verification, changelog/version updates, commit, merge main, push and controlled deployment. Production financial writes and historical incident remediation remain excluded.

## Sequence and review boundaries

Tasks 1–3 close the known safety gap and can ship independently. Tasks 4–6 add resolver and client adoption. Tasks 7–8 complete cross-channel acceptance and rollout. Do not postpone the service guard until agents adopt the new tool.

### Task 1: Define evidence-state policy and reproduce the incident

**Files:** Create `backend/src/services/financial-evidence-policy.ts`, `backend/src/services/financial-evidence-policy.test.ts`; modify `backend/src/services/payment-service.test.ts`; read `payment-service.ts`, `payment-batch-service.ts`, `chatgpt-file-evidence-service.ts`.

**Interface produced:** pure `evaluateFinancialEvidence(state)`; consumes counts from authoritative service queries, never OCR/client-computed money.

```ts
type FinancialEvidenceState = {
  required: boolean;
  expectedCount: number;
  readyCount: number;
  pendingCount: number;
  rejectedCount: number;
};
type EvidenceDecision = { allowed: boolean; code: 'READY' | 'EVIDENCE_REQUIRED_NOT_READY' };
// export function evaluateFinancialEvidence(state: FinancialEvidenceState): EvidenceDecision
```

- [x] Add a failing pure regression with literal values, including a false legacy flag with a known pending intent:

```ts
expect(evaluateFinancialEvidence({required:false,expectedCount:0,readyCount:0,pendingCount:1,rejectedCount:0}))
  .toEqual({allowed:false,code:'EVIDENCE_REQUIRED_NOT_READY'});
expect(evaluateFinancialEvidence({required:true,expectedCount:2,readyCount:1,pendingCount:1,rejectedCount:0}).allowed).toBe(false);
expect(evaluateFinancialEvidence({required:false,expectedCount:0,readyCount:0,pendingCount:0,rejectedCount:0}).allowed).toBe(true);
```

- [x] Run `bun test backend/src/services/financial-evidence-policy.test.ts`; capture the intended red assertions, not an import/fixture failure. These tests are pure and do not access a database.
- [x] Implement the pure policy: required minimum is at least one for required/known evidence; any unresolved required intent blocks; unknown readiness is not ready. Run the same tests and require green.
- [x] Commit the pure policy, green tests and CHANGELOG. Explicitly state that service enforcement is delivered in Task 2, not by this policy-only checkpoint.

### Task 2: Sticky requirements, locking and payment enforcement

**Files:** Create `backend/src/services/financial-evidence-requirement-service.ts`, `backend/src/services/financial-evidence-requirement-service.test.ts`, `backend/drizzle/0075_financial_evidence_requirements.sql`; modify journal/schema, `payment-service.ts`, `chatgpt-file-evidence-service.ts`, `payment-batch-service.ts`, their tests, MCP intake-create schema and payment REST input schema in the existing payment module.

**Interfaces produced:** `registerFinancialEvidenceRequirement(tx, ctx, target, expectedCount)` and `assertFinancialEvidenceReady(tx, ctx, target)`. `target` is `{kind:'payment_intake'|'loan_disbursement', publicId:string}`; transaction and context use existing `DbTransaction`/`CommandContext`. The assertion uses Task 1 policy, authorized joins and exact finalized associations.

- [x] Extend the existing payment database fixture to create a false-flag intake, preview, prepare evidence, simulate PUT failure, then post the old proposal. Assert rejection, unchanged schedule/loan/transaction/funding totals and no posted audit. Keep all IDs/data synthetic. Run `bun run --cwd backend test src/services/payment-service.test.ts` to capture the expected failure before wiring the guard.

- [x] Confirm next migration slot against current journal; migration 0075 was already present, so the append-only distinct-attempt floor uses migration 0076.
- [x] Add migration tests for XOR typed parents, tenant FKs, one requirement per target, expected count 1–20 and no retroactive posted-record update. Use explicit typed parent columns, not an unchecked polymorphic public ID.
- [x] Add `attachmentRequirement: {expectedCount: integer 1..20}` as an optional closed property on mutable intake and payout creation. Omitted means legacy behavior, not proof there was no attachment.
- [x] Implement declaration with context/audit and conflict-safe upsert under parent lock; only mutable parents permit increasing counts. Mirror the payment flag only on mutable rows. Use this sequence:

```text
authorize exact target → lock parent → confirm mutable → register/increase requirement
→ create or reuse evidence intent → commit → storage work → finalize under parent lock
```

- [x] Register requirements before accepted prepare/import can fail in DNS, signer, download or storage. Retry cleanup retains the requirement; repeated attempt identities do not increase count.
- [x] Wire guards into preview readiness and the payment kernel, including batch/restore consumers; recheck after locking, never rely on a resolver result or old proposal.
- [x] Keep terminal successful post replay ahead of new mutable-state requirements, returning the original receipt; normal new writes with unresolved evidence reject.
- [x] Test both prepare/post interleavings with existing barrier patterns, ready+pending attachments, multiple declared attachments, same-file retries, expired cleanup, cancelled retention, tenant isolation, and direct service/REST bypass attempts. Assert no financial writes on rejection.
- [x] Run the scoped disposable payment, requirement, batch staging/atomic, restore-floating, payout, loan-application, and ChatGPT importer suites. Backend typecheck has no backend errors; the existing frontend `decimal.js` dependency resolution error remains documented.

### Task 3: Payout/activation parity and other financial entry points

**Files:** Modify `backend/src/services/loan-disbursement-service.ts`, `loan-application-service.ts`, their tests, `loan-settlement-service.ts`, `loan-renewal-service.ts`, `loan-restructure-service.ts`, `intermediary-service.ts`, `intermediated-disbursement-service.ts` only where the audited entry-point inventory identifies consumed evidence targets; update applicable tests and `docs/operations/agent-mcp-plugin.md`.

**Consumes:** Task 2 register/assert functions. **Produces:** a checked-in enforcement matrix in the operations guide: entry point, target relation, guard location, supported attachment transport, terminal replay behavior.

- [x] Add payout regression: optional-evidence draft → prepare → signing/PUT failure → post must reject. Ready evidence plus a second pending intent must also reject.
- [x] Guard `postDisbursement` under the existing loan→event→intent locking order. Known associated payout requirements block loan activation; do not infer target relationships from borrower names or transfer amounts.
- [ ] Inventory every financial tool from catalog policy. For each alternate execute path, test consumption of a guarded target cannot bypass the assertion. Distinguish a path that has no pre-execution evidence target from one that consumes an existing payment/payout.
- [ ] Preserve old batch `tenant/staging` lineage, current intermediary checks and typed evidence scopes. Do not impose `intake` metadata on every storage object.
- [ ] For attachment-bearing floating settlement/renewal/intermediary paths without a supported importer, record human-review-only routing. Do not introduce fake payment intakes or generic financial execution. This scope does not claim backend awareness of unreported files.
- [ ] Use this acceptance table in database tests, extending each service's real fixture:

```text
known pending payout + activate/post                  → reject, no new ledger/audit write
all required payout evidence ready + confirmed post   → existing valid receipt
successful historical post replay + pending legacy   → original receipt, no mutation
same operation through REST rather than MCP           → same service guard
unrelated borrower's pending evidence                  → no cross-target blocking/leakage
```

- [ ] Run scoped disposable payout, application, settlement, renewal and intermediary tests plus typecheck. Commit only the independently verified guard scope with CHANGELOG; explicitly retain unsupported transport boundaries in docs.

### Task 4: Immutable workflow registry and deterministic resolver policy

**Files:** Create `backend/src/mcp/workflow-registry.ts`, `workflow-resolver.ts`, `workflow-resolver.test.ts`; modify `catalog-types.ts` only for shared types when necessary. No transport handler in this task.

**Interfaces:**

```ts
type WorkflowIntent = 'inspect'|'receive_payment'|'close_loan'|'originate_loan'|
  'disburse_loan'|'attach_evidence'|'renew_loan'|'intermediary_collection'|'tool_help';
type ResolverInput = {
  intent: WorkflowIntent;
  target?: {kind:'borrower'|'loan'|'payment_intake'|'loan_disbursement';publicId:string};
  attachments:'none'|'present'|'unknown'; expectedAttachmentCount?:number;
  knownWorkflowVersion?:string; knownCatalogVersion?:string; toolName?:McpToolName;
};
type ResolverStep = {toolName:McpToolName; arguments:Record<string,string>;
  requiredInputs:string[]; requiresConfirmation:boolean};
type ResolverObservation = {
  state:'unresolved'|'mutable'|'posted'; loanType?:'scheduled'|'floating';
  evidenceReady:boolean; supportedAttachmentTransport:boolean;
};
type ResolverResult = {
  workflowId:string; workflowVersion:string; catalogVersion:string; policyRevision:string;
  observed:ResolverObservation;
  status:'needs_input'|'next_step'|'confirmation_required'|'blocked'|'refresh_required'|'connection_required';
  nextSteps:ResolverStep[]; // at most 3, checked by the output schema
  blockers:Array<{code:string;message:string}>; // at most 8
  prohibitedTools:McpToolName[]; // at most 8
  reevaluateOn:Array<'target_change'|'evidence_change'|'preview_expiry'|'version_change'>;
};
// resolveWorkflowPolicy(input: ResolverInput, observed: ResolverObservation,
//   profile: ToolProfile): ResolverResult
```

- [ ] Write literal routing tests before policy code. Scheduled close-out does not select floating settlement; posted intake with attachment selects supplement import; mutable intake with inaccessible file never suggests post; unknown identity returns needs_input; unsupported attachment transport returns blocked; wrong profile returns connection_required.
- [ ] Add the critical resolver regression:

```ts
const result = resolveWorkflowPolicy(
  {intent:'receive_payment',attachments:'present'},
  {state:'mutable',evidenceReady:false,supportedAttachmentTransport:true}, 'payments');
expect(result.status).toBe('needs_input'); // No exact target supplied.
expect(result.nextSteps.some(step=>step.toolName==='payment.post')).toBe(false);
```

- [ ] Implement explicit rules from the spec; schema-close inputs and output status/limits. Suggested arguments contain only inspected public identifiers, never confirmation or invented keys. Status names match the spec exactly.
- [ ] Assert every recommended tool exists in the catalog; every financial tool is mapped or marked human-review-only; route suggestions cannot escape profile membership. Adding a new tool without classification must fail CI.
- [ ] Run `bun test backend/src/mcp/workflow-resolver.test.ts`. Commit registry/policy tests with CHANGELOG; no application service writes are introduced.

### Task 5: Register `workflow.resolve` and shared version/bootstrap guidance

**Files:** Modify `backend/src/mcp/server.ts`, `default.ts`, `modern.ts`, `tool-profiles.ts`, `catalog-types.ts`, `server.test.ts`, `default.test.ts`, `modern.test.ts`, `profiles.test.ts`; create `backend/src/mcp/workflow-version.ts`; regenerate frozen full/profile contracts through existing scripts.

**Consumes:** Task 4 policy and registry. **Produces:** `resolveWorkflow(ctx,input,profile)` that performs bounded authorized service reads, creates `ResolverObservation`, and returns the closed response. It must not call existing preview/execute handlers to discover state.

- [ ] Add the named tool to all profiles with read-only=true, destructive=false, no generic dispatch capability. Supply route profile via server wiring, not a model argument.
- [ ] Add tests proving stale caller-reported state cannot override backend state, foreign UUIDs leak nothing, and a resolve call leaves financial/draft/preview/evidence/audit domain tables unchanged. Safe operational metrics are allowed.
- [ ] Separate catalog hash, workflow version and policy revision. Add stale-version tests with this behavior:

```text
known versions differ → refresh_required, current versions returned, no financial next step
known versions absent → safe read/guidance allowed, client freshness unproven
same versions but state changes → reevaluate from backend, never reuse permission
```

- [ ] Update v1 instructions and modern discovery guidance supported by the installed SDK. Keep `listChanged` unchanged unless actual notification publication/delivery is implemented; notification transport work is not required for this release.
- [ ] Add bounded recovery guidance within existing compatible error `details`: stable blocker code and `workflow.resolve` recommendation. Do not change all legacy success envelopes or treat guidance fields as authentication.
- [ ] Regenerate using `bun run plugins/creditsync/scripts/mcp-contract.ts` and `bun run plugins/creditsync/scripts/mcp-profiles.ts` following each script's existing invocation contract; run plugin validator. Generated counts should reflect one added tool, not manually edited constants.
- [ ] Run `bun run --cwd backend test src/mcp/server.test.ts src/mcp/default.test.ts src/mcp/modern.test.ts src/mcp/profiles.test.ts` and typecheck. Commit contracts, code, CHANGELOG and README together.

### Task 6: Agent instructions, missing-file behavior and client update procedure

**Files:** Modify `plugins/creditsync/skills/creditsync/SKILL.md`, `skills/reconcile-payments/SKILL.md`, `skills/manage-disbursements/SKILL.md`, `skills/manage-loans/SKILL.md`, `skills/settle-floating-loans/SKILL.md`, other mapped financial skills, `evals/evals.json`, `evals/harness.ts`, `tests/eval-harness.test.ts`, `tests/plugin-contract.test.ts`, plugin manifest/README/CHANGELOG and `docs/operations/chatgpt-mobile-evidence.md`.

**Consumes:** resolver named contract and stable blockers. **Produces:** executable agent traces and a connection-update checklist, not a claim that ChatGPT automatically installs Codex skills.

- [ ] Add failing scripted cases before instruction edits: missing resolver in cached catalog, available importer but omitted file parameter, missing DNS access, prepare then post without resolving, two attachments with only one ready, stale workflow, posted intake with pending evidence and profile missing required importer.
- [ ] Require resolver at the start of a new financial intent and after errors/stale state/version changes; do not repeat it between every harmless read. Preserve full named tool schemas for actual calls.
- [ ] The expected trace for unavailable attachment access is:

```text
resolve → inspect exact mutable target → declare requirement/create target if authorized
→ importer fails or file descriptor unavailable → report blocked → no preview/post
```

- [ ] For old clients unable to see resolver, stop attachment-bearing writes and request the operator refresh/reconnect; backend still guards known evidence attempts. Do not invent a resolver invocation or signed URL.
- [ ] Document new versus ongoing conversation checks: tool visibility, workflow/catalog version, actual file descriptor arrival and backend ready read-back. Test every deployed connection/profile used on mobile; a successful `/mcp` server test does not prove host adoption.
- [ ] Run `bun test plugins/creditsync/tests` and `bun run plugins/creditsync/scripts/validate.ts`. Update plugin version consistently (proposed 10.3.0 subject to current repository version), generated references, root CHANGELOG and README before committing.

### Task 7: Cross-channel safety and read-only recovery compatibility

**Files:** Modify applicable payment/payout REST module tests, `frontend/src/lib/workflow-api.ts` and its consuming payment/disbursement views only if the stricter error requires user-facing handling; update `frontend/src/locales/en.json` and `th.json` together; extend `backend/scripts/evidence-recovery-policy.test.ts`; create `docs/operations/workflow-resolver-acceptance.md`.

**Produces:** an acceptance matrix with independent backend, resolver, scripted-agent, real-host and real-device evidence columns.

- [ ] Test a client that never calls resolver: legacy prepare with false flag followed by post still blocks. Verify the same guard through direct service and REST entry points.
- [ ] Assert legacy batch-ready lineage remains accepted; existing pending historical uploads stay warnings in the recovery scanner but do not become financial transition permissions. No blanket migration of old posted evidence flags.
- [ ] Verify UI blocker handling preserves the current draft and displays the missing evidence state; no silent retry/post button workaround. Test both languages if UI changes.
- [ ] Add stale preview and concurrent registration/finalization tests; assert all declared required attachments are ready, not merely one matching checksum.
- [ ] Run final gates:

```bash
bun run --cwd backend test
bun run --cwd backend typecheck
bun test backend/scripts/evidence-recovery-policy.test.ts plugins/creditsync/tests
bun run plugins/creditsync/scripts/validate.ts
bun run --cwd backend mcp:discovery:benchmark
MCP_CONFORMANCE_ROOT=/tmp/creditsync-conformance-install.rk1bTn/repo bun run --cwd backend mcp:conformance
```

The displayed conformance checkout was used by the prior release. Before execution, verify it still exists and is at revision `7169291ec0b68eb370fddcd9947313ab0d5e4156` as documented in the existing baseline; recreate that pinned checkout using the existing conformance runbook if unavailable. If frontend code changes, also run its test/lint/build scripts. A skipped new database invariant is not acceptance.
- [ ] Review generated tool counts, profile coverage, no per-request schema generation and resolver response bounds. Record latency/bytes without private IDs, file URLs, names or high-cardinality metrics. Commit acceptance evidence with CHANGELOG.

### Task 8: Controlled rollout and handoff

**Files:** Update `docs/operations/workflow-resolver-acceptance.md`, `agent-mcp-plugin.md`, `mcp-canary-runbook.md`, `backup-recovery.md` only for genuinely changed procedures, root README/CHANGELOG.

- [ ] Obtain approval for the completed implementation/spec and target deployment. Use supervised Luna medium/high in an isolated `codex/` worktree per AGENTS.md; do not infer new production financial write authority from this plan.
- [ ] Before release, use a fresh PostgreSQL/MinIO recovery point and isolated restore rehearsal. Revalidate migration order, public-table fingerprints and lifecycle-aware evidence recovery. Apply no data repair to make the gate pass.
- [ ] Release evidence enforcement first; expose resolver and updated clients next. Verify old clients receive stable safe blockers, new clients see resolver, and `/mcp` remains usable.
- [ ] On an explicitly authorized non-production tenant, test mobile payment import, payout import, all-file requirements, unavailable file access, retry and late supplemental evidence. Financial transitions need explicit confirmation; start with ingestion/read-back-only cases.
- [ ] Preserve this exact separation in the handoff:

```text
implementation / local tests / host catalog adoption / mobile file transport /
backend safety rejection / merge / push / deployment / long-running canary
```

- [ ] Do not mark mobile passed without actual device/app/connection observations. Stop on unexpected writes, missing evidence bypass, tenant mismatch, invalid rollback image or fingerprint change. Roll back application traffic only to an image compatible with additive schema; never delete financial history.
- [ ] Existing incident remediation is out of scope: a posted payment may receive confirmed append-only supplemental evidence in a separate authorized task, not normal finalize/repost.

## Plan self-review

- Evidence guarantees map to Tasks 1–3; resolver/interfaces to Tasks 4–5; host behavior to Task 6; compatibility and release evidence to Tasks 7–8.
- No resolver invocation is treated as authorization or durable attachment registration.
- Unsupported floating/intermediary attachment transport is explicit; no new generic financial tool is hidden in the scope.
- Legacy historical records and data-only workflows are preserved; known evidence attempts become stricter by design.
- The owner approved this scope on 2026-09-14. Implementation and deployment remain conditional on the verification and recovery gates above; actual mobile acceptance must be reported separately.
