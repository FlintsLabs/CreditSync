# Cancelled Payment Replacement Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` to implement this plan task-by-task in the supervised tmux worker required by AGENTS.md. Approval of this document and its spec is required before delegation.

**Goal:** Reuse finalized evidence from cancelled, never-posted payments through an audited replacement draft, then use normal preview/post allocation.

**Architecture:** Append-only replacement lineage and evidence references preserve cancelled records and global hash ownership. Shared evidence and lineage resolution maintain duplicate protection and proof of readiness across read, preview and post paths.

**Tech Stack:** Bun, TypeScript, Drizzle/PostgreSQL, decimal.js, Zod MCP tools.

**Spec:** `docs/superpowers/specs/2026-09-22-cancelled-payment-replacement.md`

## Global constraints

- Two-decimal money strings and decimal.js; Asia/Bangkok business dates.
- Never alter cancelled/posted records or their original evidence and audit records.
- Every write uses command context, tenant/role authorization, correlation/request IDs, idempotency and append-only audit.
- Preserve existing untracked files and use isolated branch `codex/cancelled-payment-replacement` from the then-current main revision; do not merge implicitly.
- No production writes or real-slip fixtures during implementation.
- Verification commands below are proposed for approval; no tests have been added or run during planning.

## Review focus

1. Competing requests for the same source: exactly one replacement, deterministic retry/conflict.
2. Replacement itself cancelled: an unbranched chain, no double use of evidence.
3. Global hash ownership and unrelated matching intakes: keep duplicate protection, do not blank hashes.
4. Batch and standalone evidence views: identical readiness and history without double counting.
5. Tenant/role and stale state: no information leak, no write after ownership or eligibility changes.

## Task 1: Schema, eligibility and atomic replacement

Files: `backend/src/db/schema.ts`; a new generated migration under `backend/drizzle/` and its journal; new `backend/src/services/payment-replacement-service.ts`; new `backend/src/services/payment-replacement-service.test.ts`; new `backend/src/db/payment-replacement-migration.test.ts`.

Interfaces (public IDs only at service boundary):

```ts
type ReplacementInspection = {
  sourcePaymentIntakePublicId: string;
  allowed: boolean;
  blockers: string[];
  stateHash: string;
  replacementPaymentIntakePublicId: string | null;
};
type ReplacementRequest = {
  paymentIntakePublicId: string;
  reason: string;
  idempotencyKey: string;
  expectedStateHash: string;
};
// inspectPaymentReplacement(ctx, sourceUuid, executor?) -> ReplacementInspection
// createPaymentReplacement(ctx, request) -> draft UUID + source UUID + audit UUID + correlation ID
```

- [ ] Add synthetic disposable-DB cases for cancelled source with one ready slip, cancelled batch membership, no source mutation, wrong role/tenant, missing evidence, postedAt/transactions, stale hash, retries, changed request and concurrent distinct keys.
- [ ] Run these failing cases through the disposable database runner, recording actual failure.
- [ ] Implement tenant-scoped immutable lineage and evidence-reference schema. Unique source and child constraints prevent branches; evidence references retain their original owner. Add database constraints/triggers preventing invalid relationships and mutation. Generate the next migration using current repository journal; do not invent or reuse an occupied migration number.
- [ ] Implement inspect and create in a dedicated service. Acquire source/lineage locks in deterministic order; recheck eligibility under lock; compare state hash; copy authoritative data; append references, requirement/provenance, audit and receipt atomically. Idempotent replay must recheck authorization but return its original receipt before stale-state rejection.
- [ ] Add and pass chain cancellation tests: A(cancelled) -> B(cancelled) -> C(draft), with exactly one child for each source. Block competing creation from A and any source with financial transactions.

## Task 2: Evidence resolution, duplicate checks and normal posting

Files: new `backend/src/services/payment-effective-evidence-service.ts`; `payment-service.ts`, `payment-evidence-read-service.ts`, `financial-evidence-requirement-service.ts`, `payment-batch-service.ts`, `payment-cancellation-service.ts` in the same directory; relevant existing tests and a new replacement posting integration suite.

- [ ] Define `effectivePaymentEvidence(executor, ctx, intakeIds)` returning deduplicated tenant-scoped direct and referenced ready/pending/rejected evidence rows, with an explicit consuming intake ID and source evidence ID. Use immutable references from Task 1; prohibit caller-supplied file IDs.
- [ ] Add failure cases for child intake reads/history/readiness disagreeing, pending/rejected original evidence, duplicate evidence counts, and unauthorized evidence access.
- [ ] Integrate resolver into intake inspection, evidence requirement/hash/fingerprint checks, snapshots, ordinary preview/post and history. Enumerate remaining `paymentEvidence`/`payment_evidence` queries and document why each direct read is still correct or replace it. Batch snapshot and readiness queries must include inherited evidence when the child can enter a batch.
- [ ] Make duplicate lookup lineage-aware for bank/QR identity, semantic matches and file hashes. Original cancelled ancestors are allowed only for their explicit successor; unrelated candidates retain existing blockers. Standard evidence upload finding a cancelled source returns a clear replacement-review route without moving hashes or silently creating a draft.
- [ ] Ensure a replacement can be cancelled with normal audited cancellation and its successor subsequently created without relaxing restore restrictions.
- [ ] Add synthetic 200.00 receipt scenario: create cancelled batch source, replace, preview allocations 100.00 + 100.00 to exact schedule UUIDs, require ready/zero variance/no warnings, post, then re-read transactions and schedules. Assert one 200.00 receipt, two allocations, original timestamp and unchanged source. Repeat post and assert no additional transactions.
- [ ] Add stale-preview and simultaneous-post cases. Reuse existing borrower locks and normal schedule accounting; do not implement new money allocation arithmetic.

## Task 3: MCP and deterministic workflow guidance

Files: `backend/src/mcp/server.ts`, `tool-profiles.ts`, `workflow-resolver-service.ts`, `workflow-resolver.ts`, `workflow-registry.ts`, `workflow-version.ts`, relevant MCP tests; `plugins/creditsync/references/mcp-tool-contract.json`, `references/mcp-profiles/index.json`, `.codex-plugin/plugin.json`, `scripts/validate.ts`, affected skills and evals.

- [ ] Register strict public-schema tools `payment.replacement.inspect` and `payment.replacement.create` calling application services directly. Inspect is read-only; create is an audited mutation returning audit/correlation IDs. Add safe lineage/eligibility to intake reads without private hashes or evidence content.
- [ ] Add resolver cases for cancelled eligible source, cancelled blocked source, duplicate, reversed, posted and a current replacement. Cancelled sources must never receive the posted-evidence-supplement route.
- [ ] Add missing-input, stale hash, idempotency conflict, duplicate and authorization contract cases. Resolver guidance cannot authorize financial posting.
- [ ] Update plugin profile counts from actual registered inventory, frozen contract, version and validator together (current inspected version 10.3.0; choose a compatible next version based on the final schema diff).
- [ ] Add agent evals for cancelled-slip replacement, no hash/name workaround, no automatic post from OCR, and a confirmed 200.00 two-installment payment.

## Task 4: Verification, documentation and delivery

- [ ] Once this plan including verification is approved, run database suites serially via the repository runner, followed by the following gates. Resolve failures within scope and record unrelated baseline failures honestly.

```bash
bash backend/scripts/test-disposable-postgres.sh
bun run --cwd backend typecheck
bun run --cwd frontend test
bun run --cwd frontend lint
bun run --cwd frontend build
bun test plugins/creditsync/tests
bun run plugins/creditsync/scripts/validate.ts
```

- [ ] Update README with cancelled -> replacement -> preview -> post semantics, inherited evidence and repeat-cancellation behavior. Update CHANGELOG under a real version/date heading before each implementation commit; include related docs in the same commit.
- [ ] Review final diff, schema upgrade constraints, contract snapshot, gate outputs and branch ownership. Report commit IDs and what was actually tested. Do not report deployed or posted from local test success.
- [ ] Leave production records intact. Prepare release/migration checklist and the already-confirmed real payment mapping for subsequent operation: 200.00 received Sep21 19:05 Bangkok, scheduled allocations Sep20 and Sep21 100.00 each, new loan ending `704a4dd74322`. Refresh authoritative source/contract and preview after deployment before any real post.

## Tmux handoff after approval

Session: `creditsync-cancelled-payment-replacement`. Worker: Codex CLI `--model gpt-5.6-luna --config model_reasoning_effort="medium"`, in isolated worktree/branch. Pass this plan, spec, AGENTS.md, acceptance criteria, dirty-file ownership and production exclusion. If Luna is unavailable, report the reason before falling back to the current task model. Supervise output, approval prompts, Git state and verification; independently inspect worker completion. Integration target is main for review only, with no automatic merge.
