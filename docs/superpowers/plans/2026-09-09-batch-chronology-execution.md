# CreditSync batch chronology safety — execution log

Plan: `docs/superpowers/plans/2026-09-09-batch-chronology-safety.md`
Branch: `codex/batch-chronology-safety`
Base: `fde6b51`
Scope: implement and verify all seven approved tasks; no merge, push, deploy, production access, financial writes, or paid OCR.

## Progress

- [x] Baseline verification and repository mapping
- [ ] Task 1: durable batch staging and retry (service/API, resumable receipts/evidence checks, posted-membership DB gates, and read-only resumable workspace API now green; split/dependencies remain)
- [ ] Task 2: shared chronology guard (partial; all-writer locking and decision persistence remain)
- [ ] Task 3: floating multi-contract planner (partial; projected sequential state and accounting parity remain)
- [ ] Task 4: bound atomic execute (existing rollback/concurrency green; preview binding and all-borrower chronology recheck remain)
- [ ] Task 5: reconciliation and restore (unaccepted worker changes; provenance and reflow review findings remain)
- [ ] Task 6: REST, MCP, UI and contract synchronization (upload-first four-step UI and default test discovery now green; candidate discovery, split/decision/cancel public contract, and frozen MCP sync remain)
- [ ] Task 7: full verification and handoff

## Verification log

### 2026-09-09 — baseline

- `bash backend/scripts/test-disposable-postgres.sh` — blocked before tests: `drizzle-kit: command not found`.
- `cd backend && bun run typecheck` — blocked: `tsc: command not found`.
- `cd frontend && bun run test` — blocked: `vitest: command not found`.
- `cd frontend && bun run lint` — blocked: `eslint: command not found`.
- `cd frontend && bun run build` — blocked: `tsc: command not found`.
- `cd plugins/creditsync && bun test && bun run validate` — partial: 7 documentation tests passed; dependency/module resolution failed for `ajv` and backend MCP SDK imports.

Dependencies were absent from the checkout; installation and baseline rerun are pending.

Dependencies were then installed with `bun install` in `backend/`, `frontend/`, and `plugins/creditsync/` (no production access). Baseline rerun results:

- `cd frontend && bun run test` — 252 passed, 0 failed.
- `cd frontend && bun run lint` — passed.
- `cd frontend && bun run build` — passed; existing chunk-size warning only.
- `cd backend && bun run typecheck` — passed.
- `cd plugins/creditsync && bun test && bun run validate` — 56 tests passed; validator passed (`9.2.0`, 11 skills, 116 tools).
- `cd backend && bash scripts/test-disposable-postgres.sh` — 857 passed, 3 skipped, 1 failed; baseline full-suite MCP adapter test timed out at 10s. Independent focused rerun `./scripts/test-disposable-postgres.sh src/mcp/default.test.ts` — 16 passed, 0 failed, 566 expectations. This is baseline evidence, not final acceptance.

### 2026-09-09 — implementation checkpoints

- TDD chronology: `bun test src/services/payment-chronology-guard.test.ts` first went red because epoch ordering changed blocker order; expectation was corrected, then 8 passed / 0 failed. `bun run typecheck` passed. Coverage now includes offset-equivalent instants, invalid timestamp gap skip, Bangkok date comparison, and runtime terminal filtering.
- TDD staging integration: `./scripts/test-disposable-postgres.sh src/services/payment-batch-service.test.ts` passed 7 / 0 (20 expectations). It verifies staging with null amount/time and null intake/item, fake signed prepare/finalize, review-created intake, and evidence provenance. It also verifies shared floating 07/08 preview components at 75.00 interest each with zero transaction writes.
- The first floating DB run was red on `loans_interest_period_policy_completeness_check`; the fixture was corrected with the required daily policy fields and the same disposable integration command passed.
- Existing atomic execute integration gates passed in that run: injected second-stage failure left intake/transactions/schedule unchanged, and concurrent same-key execution produced one repayment.
- REST additions: upload-first staging/review routes under `/payment-batches/stage` and `/payment-batches/staging/:id/...`; restore draft/evidence/preview/execute/backfill routes under `/payment-restores`.
- Restore execute now binds the preview's source floating provenance in restore mode and uses the same floating ledger balance version; an end-to-end restore integration test is still required.
- `./scripts/test-disposable-postgres.sh src/db/atomic-batch-payment-migration.test.ts` — 3 passed, 0 failed, 21 expectations; real DB staging nullability, tenant FK, and unique client key checks passed. The migration source-text checks remain only supplemental.
- `cd frontend && bun run test` — 252 passed, 0 failed across 53 files; existing navigation warning emitted.
- `cd frontend && bun run lint` — completed successfully (no diagnostics returned).
- `cd frontend && bun run build` — passed; existing >500 kB chunk warning only.
- `cd plugins/creditsync && bun test && bun run validate` — 56 passed, 0 failed; validator passed (`9.2.0`, 11 skills, 116 tools).
- `cd backend && bun run typecheck` — passed after staging, nullable floating schedule, borrower-lock, chronology, and restore changes.

- `./scripts/test-disposable-postgres.sh src/db/atomic-batch-payment-migration.test.ts` — 4 passed, 0 failed, 23 expectations. Real PostgreSQL now rejects inserting or moving a batch member under a posted parent; the guard checks both OLD and NEW membership, not only the old parent.
- `./scripts/test-disposable-postgres.sh src/services/payment-batch-staging.integration.test.ts src/db/atomic-batch-payment-migration.test.ts` — 13 passed, 0 failed, 64 expectations. Staging retry, owner access, immutable ready evidence, expiry/MIME/size metadata, changed review payload, append-only receipts, and revision-bound cancellation all passed.
- `cd frontend && bun run test` — 62 files, 274 tests passed after enabling `src/**/*.{test,vitest}.{ts,tsx}` discovery and repairing the discovered Bun-only clock import/assertions.
- `cd frontend && bun run lint` — passed.
- `cd frontend && bun run build` — passed; existing chunk-size warning only.
- `cd plugins/creditsync && bun test && bun run validate` — 56 tests passed; validator passed (9.2.0, 11 skills, 116 tools).
- `cd backend && bun run typecheck` — passed after cancellation/schema/UI-adjacent backend changes.
- `./scripts/test-disposable-postgres.sh src/services/floating-allocation-regressions.test.ts` — 21 passed, 0 failed, 122 expectations after preserving component-specific penalty compensation errors; chronology protection remains enforced by the later allocation guard.
- `cd frontend && bun run test -- --run src/pages/dashboard/payments/PaymentBatchEditor.test.tsx` — 1 passed; `bun run lint` passed; `bun run build` passed with the existing >500 kB chunk warning. The preview path now uses same-call staging results, covering resumable retry semantics that React state updates cannot guarantee synchronously.
- `cd backend && bun run typecheck` — passed after the floating error-precedence and resumable preview fixes.
- Correction 1: the disposable runner now uses `--parallel=1` because `--max-concurrency=1` does not serialize test files; this addresses the observed 40P01 cross-worker reset cycle. The two named service files passed together 36/36 and 143 expectations. The subsequent full rerun was blocked by Docker/PostgreSQL `No space left on device` after 850 pass / 3 skip / 56 cascading DB-write failures; no financial assertion was relaxed. Evidence: `/tmp/creditsync-batch-resume-correction1-rerun2/`.
- Cleanup correction: the runner now creates one generated, labeled volume per invocation, records its exact name, and removes that volume plus its exact container in the EXIT trap. Migration smoke passed 4/4 with 23 expectations; failure-path smoke reached Bun's invalid-filter failure and left zero labeled containers/volumes. Logs: `post-cleanup-smoke.log` and `post-cleanup-failure.log`.
- User-resume full suite at HEAD `98b80b0`: 905 passed, 3 skipped, 1 failed. The single failure exposed principal reprojection running before the shared later-floating-payment guard. Added the guard before principal reprojection; `./scripts/test-disposable-postgres.sh src/services/payment-service.test.ts` then passed 37/37 with 185 expectations. Full suite must be rerun at the resulting commit.

Known acceptance gaps at this checkpoint: staging retry/cross-tenant/partial-finalize DB cases; warning acknowledgement persistence and all-borrower chronology; shuffled 09/07/08 and 75+45 multi-contract assertions; restore new-evidence end-to-end; MCP frozen contract/plugin sync; frontend four-step UI and discovered tests; full final verification.

The latest checkpoint closes the specifically named staging/posted-parent and frontend discovery gaps, but the execution log remains incomplete: temporal reflow, full component replay, split/dependency public APIs, candidate/access completeness, all-writer chronology audit, frozen contract synchronization, browser QA, and final full-suite result are still open.

## TDD evidence

Red/green commands will be appended per task before implementation claims.

### 2026-09-09 — user-resume workspace continuation

- Workspace RED: `backend/scripts/test-disposable-postgres.sh src/services/payment-batch-staging.integration.test.ts` failed because the new `getPaymentBatchWorkspace` service export did not exist.
- Workspace GREEN: the same serialized disposable test passed 10/10 with 46 expectations. The API returns staging public IDs, client keys, lifecycle revision, normalized amount/time when reviewed, evidence status/metadata, review reason/range, and public intake/batch-item links; raw file IDs, storage keys, hashes, signed URLs, and OCR contents are excluded.
- The full serialized suite at commit `310e088` remains the latest backend gate: 906 passed, 3 skipped, 0 failed, 5799 expectations. This continuation's workspace change requires a new full-suite run before final acceptance.
- At commit `a39daa0`, the first post-workspace full suite exposed one 5-second timeout in the intermediary remittance selection test (`906 pass / 3 skip / 1 fail / 1 error`, 5801 expectations). The exact file then passed in three isolated disposable runs (6/6 each, 0.93–1.51s), without changing timeout or financial assertions. A clean serialized rerun at the same HEAD passed `907 / 3 skipped / 0 failed`, 5804 expectations, 910 tests in 210.46s; no owned container or volume remained.
- Final non-DB gates at `a39daa0`: `cd backend && bun run typecheck` passed; `cd frontend && bun run test` passed 274 tests in 62 files, lint passed, and build passed with the existing chunk-size warning; `cd plugins/creditsync && bun test` passed 56 tests/1688 expectations and `bun run validate` passed (9.2.0, 11 skills, 116 tools).
