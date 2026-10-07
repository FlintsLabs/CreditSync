# Payment Workflow Recovery Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans task-by-task. Execution must follow the repository's supervised tmux policy after this proposal is approved.

**Status:** Proposed for review; implementation, tests, migration and deployment have not started.

**Goal:** Every supported payment blocker has a safe, actionable recovery path, while duplicate posting and mutation of posted/cancelled history remain prohibited.

**Architecture:** Introduce append-only payment identity decisions and explicit recovery drafts. Use the same decision evaluator in inspection, preview and posting. Acquire financial locks consistently and make retries return the existing operation receipt.

**Tech Stack:** Bun, TypeScript, Drizzle/PostgreSQL, decimal.js, existing React UI and CreditSync MCP.

**Spec:** The proposed design and acceptance criteria below form the design brief for this plan. User approval is required before implementation.

## Proposed design

### Scope and choices

The reviewed paths are cancellation, duplicate review, replacement, evidence, single payment and batch posting. Actual database deadlock has not been reproduced; the three confirmed static findings concern workflow dead ends.

Options considered:

1. Add exceptions to each existing guard: smallest patch, but leaves divergent rules and new combinations of blocked states.
2. Shared identity decisions plus explicit recovery operations: recommended; larger change with consistent inspection/posting behavior and preserved history.
3. Ignore cancelled rows during duplicate checks: rejected because cancellation does not prove that a bank transfer is different or safely reusable.

### A. Identity decisions

The five-minute name/amount match is a candidate signal, never proof. Present immutable pairwise decisions: `same_payment` or `distinct_payment`, with reason, actor, request/correlation IDs, preview hash and idempotency key. Time differences must be displayed and explicitly confirmed, rather than rejected solely because timestamps differ.

Same-payment decisions join an existing identity group through a new event, including when a replacement exists. Lock both groups in deterministic order, re-read their members and financial effects, then permit union only when it cannot introduce more than one active posting for the same receipt. Group union with two independent active postings requires an explicit reversal/reconciliation workflow first. Posted decisions cannot retroactively rewrite allocations.

Distinct-payment decisions apply to exact reviewed pairs and identity snapshots, not a global exemption for a payer/time range. Matching bank/QR identity or other contradictory evidence blocks this decision and supplies the explicit investigation/reconciliation route. A new third intake remains unreviewed until its own decision is confirmed. Old decisions remain auditable; a correction appends a superseding decision and checks downstream effects.

Existing executed reviews retain their meaning through a compatibility reader. Do not silently reinterpret historical membership or modify old review rows.

### B. Evidence recovery

Cancellation remains available for abandoned drafts even if an upload failed. A cancelled record and its failed/pending attempts stay immutable.

Create an explicit recovery draft linked to the source. Copy only validated ready evidence references; upload replacement evidence onto the new draft. Show original requirement, failed attempts, reused evidence and remaining required slots. Resolve an erroneous declared requirement only through a reasoned, confirmed append-only recovery decision; never silently lower expectedCount.

Keep a recovery draft blocked from posting until every required slot is satisfied and the same-payment decision authorizes its relationship to the source. A failed upload is not automatically excused by another receipt's evidence. Canonical evidence reuse requires explicit confirmation of the exact receipt and coverage; conflicting evidence remains blocked for investigation.

Only one active successor may consume a source identity. Cancelling a recovery child permits a new successor from that child while preserving the complete chain; retries resume the existing child. Reversed posted receipts remain under the existing restore workflow.

### C. Actionable blocked states

Inspection returns a typed list of blockers and executable next steps: identity review, evidence recovery, continue existing successor, fresh preview, dependency reversal/reconciliation, or human investigation with the exact conflict. The UI/MCP must not recommend a review operation that rejects the current lifecycle state. No generic “try again” loop for permanent business conflicts.

### D. Concurrency

Inventory actual locks and nested service calls before changes. Define one shared order across every interacting writer, including group decisions, create, preview, cancel, replacement, evidence and single/batch post. Identity locking must cover the same candidate scope used by duplicate detection; the current minute hash does not cover a five-minute window. Start with a transaction-scoped tenant identity mutex for identity-changing operations if a finer key cannot be proven correct, measure contention, and acquire it before affected row locks everywhere it is used.

Discover borrower/batch/intake IDs before locking, acquire sorted locks in the agreed hierarchy, then re-read and reject changed membership. Do not add an advisory lock beneath existing row locks on one path while acquiring it first on another. Keep storage/network calls outside transactions.

Use bounded retries only for confirmed transient database transaction failures and only around the complete replay-safe transaction. Proposed maximum: three total attempts, with bounded backoff. Never retry stale preview, evidence conflict, permissions or idempotency conflicts automatically. Timeouts return a resumable operation identifier; a lost response must not create a second financial effect.

## Global constraints

- Money uses two-decimal strings and decimal.js; business dates use Asia/Bangkok.
- Financial and cancelled records remain immutable; all corrections are append-only with complete command/audit context.
- Require preview, explicit human confirmation, current snapshots, complete evidence and zero allocation variance before financial posting.
- Keep tenant/role boundaries and hard evidence checks. Do not expose raw QR, full references, secrets or signed URLs in logs.
- No production data repair is implied by this plan. Prepare a read-only impact report and obtain case-specific confirmation for actual recovery decisions.
- No product code changes in this planning task. Preserve existing untracked documents and .codex-task-logs/.
- Before each implementation commit update versioned CHANGELOG.md; update README.md with changed workflows in the same commit.

## Review focus

1. Same payer makes two real payments within five minutes: explicit distinct decision must allow both without exempting a third receipt (Tasks 1–2).
2. New duplicate appears after replacement creation or after posting: group extension must not reopen a second posting route (Tasks 2, 5).
3. Cancelled upload has partial, expired, failed or conflicting evidence: recovery must preserve provenance and require missing evidence (Task 3).
4. Two operators confirm overlapping groups or cancel/post simultaneously: one serial outcome, no duplicate money or unbounded wait (Tasks 4–5).
5. Response is lost after commit or an older client retries: same operation receipt, compatible historical review behavior (Tasks 2, 4–5).

## Task 1 — Capture regression scenarios and centralize blocker classification

**Files:** Modify backend/src/services/payment-duplicate-guard.ts and backend/src/mcp/workflow-resolver.ts. Create backend/src/services/payment-workflow-recovery.test.ts and backend/src/services/payment-workflow-blockers.ts.

**Interface:** `PaymentWorkflowBlocker = { code: string; intakePublicIds: string[]; nextAction: 'identity_review' | 'evidence_recovery' | 'continue_successor' | 'refresh_preview' | 'reconciliation' | 'human_investigation'; retryable: boolean }`.

- [ ] Build disposable fixtures using the existing duplicate-review/replacement test setup: cancelled ready source plus same-payer candidate at +60 seconds; source with an executed group plus a new candidate; cancelled candidate with one failed upload.
- [ ] Assert current mismatch failures first, then specify intended nextAction for each scenario. Add +300-second and +301-second boundaries, two distinct real transfers and tenant separation.
- [ ] Implement a shared blocker classifier; retain old external error codes while adding structured recovery information. Do not weaken post validation.
- [ ] Run the targeted disposable DB suite and workflow resolver tests; review the diff and commit with changelog.

## Task 2 — Add append-only identity decisions and group extension

**Files:** Create backend/src/services/payment-identity-decision-service.ts and backend/src/services/payment-identity-decision-service.test.ts. Modify backend/src/db/schema.ts, backend/src/services/payment-duplicate-review-service.ts, backend/src/services/payment-duplicate-guard.ts and backend/src/services/payment-replacement-service.ts. Add the next available migration under backend/drizzle/ with matching migration metadata.

**Interfaces:** Preview consumes explicit participant public IDs, `decision: 'same_payment' | 'distinct_payment'`, reason and idempotency key. It produces previewPublicId, previewHash, participant snapshots, conflicts and expiresAt. Execute consumes that preview/hash, `confirmed: true` and its idempotency key, and returns decisionPublicId, auditPublicId and correlationId. Reuse existing service conventions for context/executor types.

- [ ] Write failing tests for +60-second confirmed same-payment, exact-pair distinct-payment, a third receipt still blocked, group extension before and after replacement creation, and two active posted groups rejected.
- [ ] Add immutable decision/event tables, tenant-qualified foreign keys, operation receipts and snapshot hashes. Corrections append superseding events; no UPDATE/DELETE of decision history.
- [ ] Implement preview/execute and one authorization reader shared by inspect/preview/post. Read historical memberships through an adapter. Lock and revalidate the full affected identity groups before execute.
- [ ] Test expired/stale previews, conflicting bank identity, overlapping decisions, reversed downstream records, forbidden actors and changed tenant ownership. Confirm grouping never authorizes two active posted receipts.
- [ ] Run targeted disposable DB tests and typecheck, review compatibility and commit with changelog/README.

## Task 3 — Recover cancelled evidence through linked drafts

**Files:** Modify backend/src/services/payment-replacement-service.ts, backend/src/services/payment-effective-evidence-service.ts and backend/src/services/financial-evidence-requirement-service.ts. Create backend/src/services/payment-evidence-recovery-service.ts and backend/src/services/payment-evidence-recovery-service.test.ts; extend schema/migration for recovery receipts and evidence-slot decisions.

**Interfaces:** Recovery preview consumes source public ID, reason and proposed reuse/required-slot decisions. Execute consumes a confirmed current preview and idempotency key; returns recoveryIntakePublicId, auditPublicId and correlationId. Source inspection reports the existing successor on retry.

- [ ] Write failing cases for zero uploads, failed attempt, expired pending upload, partial two-file upload, conflicting ready evidence and cancellation of an unposted recovery child.
- [ ] Implement recovery drafts without modifying source requirements, attempts, files or cancellation receipts. Use the identity authorization from Task 2 and existing signed-upload prepare/finalize services on the child.
- [ ] Keep incomplete drafts blocked; require explicit reason/confirmation for any new requirement interpretation and preserve original/remaining slot counts in audit and preview.
- [ ] Verify repeated execution resumes one successor, lost upload responses do not multiply slots, conflicting evidence cannot be silently inherited, and restore drafts use their owning workflow.
- [ ] Run targeted disposable DB tests, inspect append-only invariants and commit with changelog/README.

## Task 4 — Establish common lock order and bounded transaction recovery

**Files:** Inspect and modify interacting writers in backend/src/services/payment-service.ts, payment-batch-service.ts, payment-cancellation-service.ts, payment-replacement-service.ts, payment-duplicate-review-service.ts and the new identity/recovery services. Create backend/src/services/payment-workflow-locks.ts and backend/src/services/payment-workflow-concurrency.test.ts.

- [ ] Record a lock-order table for every entry point, including nested calls, borrower locks, identity/advisory locks, batches, intakes, proposals, loans and schedules. Include createPaymentIntake, which currently performs duplicate reads before insertion.
- [ ] Add deterministic two-connection barriers inside one disposable DB test file; cover preview versus batch post, overlapping group extension, same-identity create versus post, cancel versus evidence finalization and replacement versus group extension. Do not run destructive fixture files concurrently.
- [ ] Implement shared lock acquisition according to the reviewed table and revalidation after locks. Any identity mutex must precede affected row locks on all participating paths. Verify the five-minute detection boundary shares synchronization even across minute changes.
- [ ] Implement bounded full-transaction retry only for replay-safe transient SQLSTATEs, preserving request/idempotency keys. Add a test that commits then loses the response and proves the retry returns the original receipt.
- [ ] Assert bounded completion, no unhandled deadlock, no duplicate transactions, unchanged totals and useful timeout/retry exhaustion errors. Repeat each barrier scenario 20 times within its isolated test file.
- [ ] Run targeted concurrency tests and full backend disposable suite; review locks independently from business logic and commit with changelog.

## Task 5 — Expose recovery through MCP and existing UI

**Files:** Modify backend/src/mcp/workflow-resolver.ts and the existing payment tool registrations discovered through `rg -n 'payment.replacement.duplicate-review.preview' backend/src/mcp`. Update backend/src/mcp/default.test.ts, plugins/creditsync/.codex-plugin/plugin.json, plugins/creditsync/references/mcp-profiles/index.json and affected plugin contracts/skills/evals. Update existing payment UI components located with `rg -n 'PAYMENT_DUPLICATE_REQUIRES_REVIEW|replacement' frontend/src`, plus frontend/src/locales/en.json and th.json.

- [ ] Add closed-schema tools for identity and evidence recovery previews/execute, with correct read/write annotations and audit results. Keep public UUIDs/money strings and application-service calls.
- [ ] Display the source, existing successor, exact blocking records, proposed identity decision, missing evidence and next step. Expose only actions that are legal for the current state/role.
- [ ] Add transport tests exercising inspect → preview → confirmation → execute → fresh allocation preview → post, including retry after response loss. Add UI tests for all blocker actions and disabled posting with unresolved requirements.
- [ ] Update plugin version/counts from current inventory, synchronize frozen contracts and validate them. Confirm old clients fail clearly or retain prior behavior.
- [ ] Run frontend tests/lint/build and plugin tests/validator, review Thai/English copy and commit with changelog/README.

## Task 6 — Release gates and operational recovery report

- [ ] Run `bash backend/scripts/test-disposable-postgres.sh` from the repository root. All financial DB suites must run without skipped invariant tests.
- [ ] In backend run `bun run typecheck`; in frontend run `bun run test`, `bun run lint`, `bun run build`; run the current plugin package's test/validator scripts after reading its package.json.
- [ ] Rehearse additive migrations on a disposable restored database; compare historical financial/audit rows and prove old review authorization still works. Do not create test records in a live tenant.
- [ ] Produce a read-only impact report: blocked intake public IDs, blocker category, proposed next action and whether human evidence/identity confirmation is required. No bulk automatic recovery.
- [ ] Prepare deployment and rollback instructions. A rollback must preserve new decision events and prevent older code from writing through states it cannot interpret; do not drop recovery tables to roll back.
- [ ] After explicit release authorization, integrate/push/deploy, verify migrations and backend/internal MCP plus frontend health. If merge is authorized verify feature ancestry in main.
- [ ] Complete any individually confirmed operational recoveries and re-read payment history, evidence lineage and schedule totals. Report code completion, deployment and financial recovery separately.

## Acceptance criteria

- All three reviewed dead-end scenarios have a usable, audited next step.
- Correctly confirmed distinct transfers within five minutes can both post; the same transfer can have at most one active posting.
- New duplicates can be reviewed after an earlier group/replacement exists without rewriting that history.
- Incomplete cancelled evidence has a recovery route; posting still requires complete valid evidence.
- Every blocked result identifies a legal next operation or the specific human decision needed; no resolver loop recommends an ineligible operation.
- Tested concurrent operations finish within configured bounds, preserve financial totals and return stable idempotent receipts.
- No guarantee of eliminating every possible future lock is claimed; timeouts, bounded retry and explicit recovery cover transient contention while regression tests cover the supported interleavings.

## Execution handoff

After approval, use an isolated `codex/payment-workflow-recovery` worktree and supervised tmux session `creditsync-payment-workflow-recovery`, Codex CLI `gpt-5.6-luna` with reasoning `medium`, as required by AGENTS.md. Pass this plan, acceptance criteria, dirty-file ownership and production exclusions to the worker. Validate worker output independently. Report any model fallback explicitly. This planning turn does not start the worker or change production.
