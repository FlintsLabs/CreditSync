# Payment Intake Cancellation Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to execute this plan task-by-task; the task agent independently reviews the worker's results.

**Goal:** Let authorized operators cancel unwanted unposted intakes through Web and MCP with preserved evidence, durable receipts and correct chronology behavior.

**Architecture:** One cancellation service owns authorization, state fingerprints, locking and receipts. REST and MCP delegate directly to it. Batch cancellation reuses its transaction-level kernel; posted payments retain their reversal workflow.

**Tech Stack:** Bun, TypeScript, Elysia, Drizzle/PostgreSQL, React, i18next, MCP SDK, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-11-payment-intake-cancellation-design.md`, including Review decisions, which supersede earlier ambiguous wording.

## Global constraints

- Preserve original money/time/evidence and immutable financial records; cancellation creates no financial transaction.
- Money remains two-decimal strings using decimal.js; business time is Asia/Bangkok.
- Tenant and portfolio authorization apply to inspection, execution and replay. Do not expose internal IDs, credentials, bank references or evidence contents in logs.
- No automatic cancellation of existing production data; no push, merge, deployment or financial posting is authorized by this plan.
- Before each implementation commit update CHANGELOG.md under an explicit version/date; update README.md alongside user-facing changes. Use actual current versions, not stale chat version numbers.
- Database tests run only through the disposable PostgreSQL runner and never concurrently against its shared database.

## Execution setup and handoff

- [ ] Obtain approval of this concrete plan before implementation delegation, as required by project AGENTS.md.
- [ ] Inspect current Git state and create isolated branch `codex/payment-intake-cancellation` in an isolated worktree based on approved main HEAD. Preserve `.codex-task-logs/` and all unrelated user changes.
- [ ] For this multi-subsystem implementation, use tmux session `creditsync-payment-intake-cancellation` with Codex CLI `--model gpt-5.6-luna --config 'model_reasoning_effort="medium"'`. If unavailable, use the current task model and report why. Pass absolute worktree/spec/plan paths, target main, ordered tasks, acceptance criteria, gates, scope exclusions and dirty-file ownership.
- [ ] Report session/worktree/branch/model and disconnect safety; supervise output and approvals, inspect changes, and independently verify each deliverable. Completion means verified feature branch, not integration into main.

## Shared interfaces and file ownership

Create `backend/src/services/payment-cancellation-service.ts` for public command and capability; create `backend/src/services/payment-intake-access.ts` only to extract existing access/presentation helpers without changing their behavior. Keep accounting in payment-service.ts.

```ts
type CancelPaymentInput = { reason: string; idempotencyKey: string; expectedStateHash: string };
type CancellationCapability = {
  allowed: boolean; stateHash: string; blockedReason: string | null;
  batchPublicId: string | null;
};
type PaymentCancellationResult = {
  paymentIntakePublicId: string; status: 'cancelled'; reason: string;
  cancelledAt: string; cancellationPublicId: string;
  auditPublicId: string; correlationId: string;
};
// ctx/executor use existing CommandContext and DbExecutor types.
// getPaymentCancellationCapability(ctx, intakePublicId, executor?)
// cancelPaymentIntake(ctx, intakePublicId, input): Promise<PaymentCancellationResult>
// cancelLockedPaymentIntake(ctx, tx, intakeRow, normalizedRequest, batchContext?)
// Last function is internal only: caller holds borrower/batch/intake locks.
```

## Task 1: Schema, receipts and database invariants

**Files:** Modify `backend/src/db/schema.ts`; generate next migration and metadata in `backend/drizzle/`; create `backend/src/db/payment-intake-cancellation-migration.test.ts`.

- [ ] Write disposable migration tests for existing rows plus new `cancelled`, invalid transitions, delete protection and receipt immutability. Seed only synthetic tenants using existing migration test fixtures.
- [ ] Run `bash backend/scripts/test-disposable-postgres.sh src/db/payment-intake-cancellation-migration.test.ts`; expect failure for missing cancellation schema.
- [ ] Add cancellation metadata to intake and immutable `payment_intake_cancellations` receipts with public UUID, tenant/intake FK, operation key, request hash, reason, original status, actor/source, request/correlation IDs, audit FK, timestamp and original result. Enforce tenant-local unique command key and one cancellation receipt per intake. Use tenant-composite FKs.
- [ ] Add `cancelled` to intake CHECK. Require complete metadata only for cancelled rows. Extend existing immutability guards: cancelled cannot update/delete or reactivate; transition to cancelled requires an eligible original state, linked receipt and no posted financial effect. Retain existing posted/reversed protections and duplicate uniqueness indexes.
- [ ] Generate Drizzle migration via `bun run --cwd backend generate`; add explicit guards to the generated SQL. Test upgrade from previous migration and direct SQL attacks including stale preview-driven revival. Re-run focused disposable test and backend typecheck, then commit schema, tests and changelog.

## Task 2: Authorized cancellation command and concurrency

**Files:** Create access/cancellation services named above and `backend/src/services/payment-cancellation-service.integration.test.ts`; modify `backend/src/services/payment-service.ts` for shared helper imports/presentation.

**Consumes:** Task 1 schema. **Produces:** shared interfaces above and safe capability/detail metadata.

- [ ] Write synthetic service fixtures for owner, other owner, viewer, manager, other tenant and each intake status. Test that read access alone does not grant mutation permission.
- [ ] Write behavior assertions using actual public service calls:

```ts
const capability = await getPaymentCancellationCapability(ctx, intakeId);
const input = { reason: 'Entered in error', idempotencyKey: crypto.randomUUID(), expectedStateHash: capability.stateHash };
const result = await cancelPaymentIntake(ctx, intakeId, input);
expect(result.status).toBe('cancelled');
expect(await cancelPaymentIntake(ctx, intakeId, input)).toEqual(result);
await expect(cancelPaymentIntake(ctx, intakeId, { ...input, reason: 'changed' })).rejects.toBeDefined();
// Query tenant-scoped fixtures: exactly one cancellation audit/receipt,
// unchanged financial transactions, original amount/time/evidence unchanged.
```

- [ ] Run focused disposable test; expect missing service/schema behavior failures. Implement normalization (1–2000 chars), canonical request hash, safe capability hash and authorized transaction with borrower-first locks. Under locks recheck ownership, membership, latest proposal and state. Check same-key replay before stale fingerprint comparison; reject changed payload/key reuse across targets.
- [ ] Reject terminal states and linked restore/reconciliation/collection/remittance dependencies using explicit error codes; no cancellation should free or consume a replacement reservation silently. Posted error points to reversal without executing it.
- [ ] Persist receipt, intake cancellation metadata, proposal invalidation and audit atomically. Return original receipt on retry, including original audit/correlation IDs. Do not log raw payloads. Expose actor public UUID/display name only where authorized.
- [ ] Add controlled concurrent cancel/post, cancel/review, cancel/preview and cancel/batch-attach tests with barriers; assert one coherent outcome, no revival, no double audit and no deadlock. All competing writers must recheck state after their locks.
- [ ] Run focused service tests and `bun run --cwd backend typecheck`; review access-helper extraction for behavior parity, update changelog and commit.

## Task 3: Terminal workflow guards, batch and chronology

**Files:** Modify `backend/src/services/payment-service.ts`, `payment-batch-service.ts`, `payment-chronology-service.ts`, `payment-chronology-guard.ts`; extend `payment-batch-staging.integration.test.ts`, `payment-batch-atomic.integration.test.ts`, `payment-chronology-guard.test.ts`, and cancellation integration tests.

**Consumes:** cancellation kernel and receipt schema. **Produces:** terminal-state enforcement across all entry paths.

- [ ] Add failing tests: cancelled intake cannot review, match, post, prepare/finalize evidence or attach to batch. Test signed-upload finalization arriving after cancel preserves old evidence and cannot revive intake. Test automatic allocation excludes cancelled inputs.
- [ ] Add chronology regression with older mapped synthetic intake and later ready intake: posting later fails before cancellation and succeeds after cancellation and fresh preview. A second uncancelled blocker must still block. Repeat for unposted batch members/staging mappings.
- [ ] Guard every lifecycle mutation using locked-state allowlists and database constraints. Keep existing duplicate semantics unchanged; document current SQL/pure-guard difference in regression expectations.
- [ ] Make direct command reject any batch member. Extend explicit revision-bound batch cancellation to lock borrowers, batch and eligible children in canonical order; call internal kernel per child with deterministic keys derived from batch cancellation key and child UUID. A failed child rolls back everything. Preserve terminal duplicate/reversed rows and reject posted effects or unsupported dependencies.
- [ ] Preserve historical batch cancellation receipts on replay; do not retrofit cancelled children for old cancelled batches. Test existing split followed by destination cancel, staged-only batch, stale revision, confirmed unposted batch, posted batch rejection, and cancel/execute races.
- [ ] Inspect chronology SQL/index predicates: `cancelled` already appears in shared SQL and pure guard, so preserve this and verify via tests rather than claim it is missing. Exclude cancelled intakes from review queues; retain explicit history filters and safe cancellation metadata.
- [ ] Run changed service tests through disposable runner, update changelog and commit.

## Task 4: REST and MCP contracts

**Files:** Modify `backend/src/modules/payment-intakes.ts`, `backend/src/mcp/server.ts`, `backend/src/mcp/contract-snapshot.ts`, `backend/src/mcp/default.test.ts`, `backend/src/mcp/security.test.ts`, `backend/src/mcp/error-presentation.test.ts`; create `backend/src/modules/payment-intake-cancellation.test.ts`.

**Consumes:** authorized command/capability. **Produces:** REST `POST /payment-intakes/:id/cancel`, MCP `payment.cancel`, detail/list metadata and cancelled filter.

- [ ] Add failing parity tests for success, same-key replay, inaccessible UUID, viewer denial, missing/extra fields, stale state, batch dependency and posted reversal guidance.
- [ ] Implement closed UUID/body schema with `reason`, `idempotencyKey`, `expectedStateHash`. REST uses body key for command context; reject conflicting nonempty header key. MCP supplies `paymentIntakePublicId` and calls the application service directly.
- [ ] Return `schemaVersion`, public result, audit UUID and correlation ID under existing MCP envelope conventions. Annotate `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: true`; no REST calls inside MCP. Map errors using existing domain presenter without exposing unavailable batch/tenant data.
- [ ] Extend both detail and list response schemas and all applicable filter unions for cancelled state; verify existing consumers and snapshots still validate.
- [ ] Run focused disposable route/MCP/security tests and typecheck, update changelog and commit.

## Task 5: Web cancellation and history

**Files:** Modify `frontend/src/pages/dashboard/payments/PaymentInbox.tsx`, `PaymentInboxList.tsx`, `payment-inbox-list-model.ts`, `frontend/src/lib/workflow-api.ts`, `frontend/src/locales/en.json`, `frontend/src/locales/th.json`; create `frontend/src/pages/dashboard/payments/PaymentInbox.test.tsx` and `PaymentCancelDialog.tsx`.

**Consumes:** server capability and command response. **Produces:** status-aware cancellation/reversal navigation and history receipt.

- [ ] Add UI tests for owner/nonowner/viewer capability, eligible states, required reason, one confirmation, retry key reuse, stale-state refresh, batch link, retained evidence, and posted reversal button. No cancellation button for terminal states.
- [ ] Use a dialog showing amount/time, reason and text: `ยกเลิกรายการนี้จากคิวดำเนินการ โดยเก็บประวัติและหลักฐานไว้ การดำเนินการนี้ไม่ใช่การคืนเงินหรือยกหนี้` with matching English copy. Submit only on explicit confirm. Freeze stateHash and key for that request; a changed reason/fresh inspection begins a new intent.
- [ ] Disable submit while pending; re-fetch detail/list/audit after success. On stale state refresh and require user review; never retry automatically against a new hash. Route batch members to current batch/split flow; keep posted reversal reason/confirmation workflow.
- [ ] Replace current `canEdit` negative-state list with eligible allowlist plus server capability where applicable; cancelled must not expose edit/upload/preview/post. Show cancelled filter/badge, actor/time/reason and retained evidence. Use active locale and existing decimal formatters.
- [ ] Run `bun run --cwd frontend test`, `bun run --cwd frontend lint`, `bun run --cwd frontend build`; update README and changelog and commit.

## Task 6: Plugin and operational documentation

**Files:** Modify `plugins/creditsync/references/mcp-tool-contract.json`, `plugins/creditsync/evals/evals.json`, `plugins/creditsync/evals/harness.ts`, relevant skills under `plugins/creditsync/skills/`, `plugins/creditsync/README.md`, `plugins/creditsync/CHANGELOG.md`, version-bearing plugin manifests, root README/CHANGELOG. Existing validator: `plugins/creditsync/scripts/validate.ts`; contract generation: `plugins/creditsync/scripts/mcp-contract.ts`.

- [ ] Add eval cases for inspect → explicit cancellation confirmation → cancel → verify, retries/conflicts, batch routing, posted reversal routing, stale request, and denied cancellation. Prohibit cancellation inferred from payer-name similarity or automatic bulk cleanup.
- [ ] Document dependency limitations, cancelled evidence still participating in duplicate detection, and the distinction between cancellation and refund. Explain that clearing one blocker does not guarantee post success and that ordinary preview lacks full chronology feasibility.
- [ ] Generate frozen contract through authenticated LOCAL synthetic MCP tools/list following existing generator instructions; no production credentials. Bump actual plugin version consistently across manifests/docs/snapshot expectations.
- [ ] Run `bun test plugins/creditsync/tests` and `bun run --cwd plugins/creditsync validate`; update changelog and commit all synchronized contract artifacts together.

## Task 7: Independent verification and branch handoff

- [ ] Review full diff for scope, auth parity, original data preservation, cancellation/post races, batch atomicity, restore/intermediary constraints and exact test evidence. Correct failing tests before handoff.
- [ ] Run full `bash backend/scripts/test-disposable-postgres.sh` followed by `bun run --cwd backend typecheck`; skipped DB tests do not count as success.
- [ ] Run frontend test/lint/build and plugin tests/validator once at final HEAD. Do not repeat unchanged passing suites without a reason.
- [ ] Exercise Web with synthetic local fixtures: cancel needs_review, stale ready request, batch redirect/cancel, cancelled history and posted reversal routing. Use browser cache in place; never create financial test records in live tenant.
- [ ] Check `git diff --check`, final commits, changelog/README accuracy and no unexplained tracked changes. Report tests actually run, any remaining limitation, feature branch and commit. No merge/push/deploy by default.

## Coverage self-review

Schema/retention → Task 1; permissions/idempotency/staleness → Task 2; lifecycle/races/batch/chronology → Tasks 2–3; REST/MCP → Task 4; Web/reversal routing/translations → Task 5; plugin/docs → Task 6; full acceptance/independent checks → Task 7. The production blocker diagnosis and any cancellation of real pending intakes remain separate work.
