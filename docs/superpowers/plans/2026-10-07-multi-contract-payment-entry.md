# Multi-contract Payment Entry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. The required execution method is supervised tmux under AGENTS.md for substantial implementation; launch only after this plan is approved. Do not spawn additional agents by default. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Record one optional-evidence receipt across several contracts and open its shared evidence from each participating contract's history.

**Architecture:** Keep one payment intake and persist explicit allocations with the existing match-preview API. Add frontend state/model and orchestration helpers for exact sums, optional evidence, and resumable submission. Extend transaction reads with a safe receipt public ID for history links; reuse existing backend financial services and evidence associations.

**Tech Stack:** Bun, React, TypeScript, Vite, Vitest/Testing Library, decimal.js, i18next, Elysia/Drizzle, disposable PostgreSQL.

**Spec:** `docs/superpowers/specs/2026-10-07-multi-contract-payment-entry.md` (records the already approved in-chat design).

## Global Constraints

- Public money is a two-decimal decimal string; all financial arithmetic and comparisons use `decimal.js` and exact string formatters.
- Business timezone is `Asia/Bangkok`; timestamps are ISO 8601.
- Preserve existing Thai/English localization and UI components. No new dependencies, font changes, or framework changes.
- Evidence is optional, JPEG/PNG/PDF only, at most 20 distinct supporting files per receipt; backend size validation is authoritative.
- No automatic posting, accounting calculations, migrations, MCP contract changes, or live financial records for testing.
- Preserve unrelated dirty files. Update CHANGELOG before each commit and README with changed user workflows.

## Review Focus

- A lost create response or failed second upload must not create a second receipt or omit promised evidence (Task 2 retry tests).
- A changed/removed row must not be overwritten by a delayed installment response (Task 1/2 interaction tests).
- Amounts above JavaScript's safe integer limit must retain cents, and the sum must respect the existing public money bound (Task 1 model tests).
- A cross-borrower receipt or duplicate warning must remain in review and never auto-post (Task 2 workflow tests).
- Receipt links and evidence must not reveal another tenant's or owner's records; legacy transactions must remain usable (Task 3 disposable tests).

## Workspace and tmux handoff

- Root checkout: `/home/flintstone/github/CreditSync`, currently `main` at `bdfd4c8a` (recheck before execution).
- Proposed feature branch: `codex/multi-contract-payment-entry`; use a new isolated worktree and tmux session `creditsync-multi-contract-payment-entry`.
- Obtain plan approval before delegation, per AGENTS.md. Check the available Luna catalog immediately before launch; use the latest verified supported Luna identifier, currently `gpt-6-luna`, with explicit medium reasoning and Fast tier. Report rejection/fallback instead of silently changing models.
- Carry the current task's existing form/history/localization changes into the worktree as prerequisites: `frontend/src/pages/dashboard/transactions/TransactionForm.tsx`, `frontend/src/pages/dashboard/loans/LoanPaymentHistoryTab.tsx`, `frontend/src/locales/th.json`, `frontend/src/locales/en.json`. Save their baseline diffs and hashes first; inspect ownership and preserve unrelated changes in these files.
- Carry these two documents. Do not copy unrelated dirty backend files, untracked fixtures, evidence folders, logs, nginx changes, or existing dirty README/CHANGELOG wholesale. Start documentation changes from the worktree versions and reconcile only this task's additions later.
- Worker may commit this task and its owned UI prerequisites with accurate changelog coverage. Default completion is on the feature branch; merging requires explicit integration authorization under AGENTS.md.
- Pass the worker this spec/plan, repository/worktree/branch paths, acceptance criteria, exact gates below, dirty-file ownership, financial rules, and scope exclusions. Supervise and independently inspect the final diff/HEAD/gates.

## Task 1: Exact multi-contract entry model

**Files:**
- Create `frontend/src/pages/dashboard/transactions/transaction-entry-model.ts`
- Create `frontend/src/pages/dashboard/transactions/transaction-entry-model.test.ts`

**Interfaces:**
- `ReceiptAllocationDraft`: `{ id: string; borrowerPublicId: string; loanPublicId: string; schedulePublicId: string; amount: string }`.
- `buildReceiptAllocations(rows: ReceiptAllocationDraft[], locale: string): PaymentAllocationInput[]` validates public IDs, positive amounts, and unique contract/installment targets, stripping locale grouping and normalizing exactly two decimals.
- `receiptAllocationTotal(rows: ReceiptAllocationDraft[], locale: string): string` sums validated amounts using the existing financial Decimal precision and rejects totals above the public bound.
- `bangkokReceiptInput(iso: string): string` and `bangkokReceiptTimestamp(localValue: string): string` convert datetime-local display/ISO without relying on browser timezone; validate real dates.
- Keep state helpers colocated with the feature; reuse existing exact money utilities rather than copying accounting logic.

- [x] Add failing model tests: `1000.00 + 2000.00 = 3000.00`, `0.10 + 0.20 = 0.30`, `9007199254740993.01 + 0.09 = 9007199254740993.10`, duplicate targets rejected, two different schedules accepted, malformed/zero/negative/excess-precision amounts rejected, sum overflow rejected.
- [x] Add Bangkok tests: `2026-10-07T12:12` maps to `2026-10-07T05:12:00.000Z`, round trip works, invalid date is rejected. Run under a non-Bangkok browser/system timezone in the interaction gate.
- [x] Run `bun run test -- src/pages/dashboard/transactions/transaction-entry-model.test.ts` from `frontend`; confirm expected failures, implement helpers, rerun to pass.

## Task 2: Form, optional evidence, and review handoff

**Files:**
- Modify `frontend/src/pages/dashboard/transactions/TransactionForm.tsx`
- Create `frontend/src/pages/dashboard/transactions/transaction-entry-workflow.ts`
- Create `frontend/src/pages/dashboard/transactions/transaction-entry-workflow.test.ts`
- Create `frontend/tests/transaction-form.vitest.tsx`
- Modify `frontend/src/lib/workflow-api.ts`, `frontend/tests/workflow-api.test.ts`
- Modify `frontend/src/locales/th.json`, `frontend/src/locales/en.json`
- Reference `frontend/src/pages/dashboard/payments/PaymentInbox.tsx`, existing allocation/review behavior, without restructuring it.

**Interfaces:**
- Extend `PaymentWorkflowInput` with optional `attachmentRequirement: { expectedCount: number }`; add an optional command-context argument to `createPaymentWorkflow` for `Idempotency-Key`, `X-Request-Id`, `X-Correlation-Id`. Preserve existing callers and review-first contract.
- Define `ReceiptCommandContext` as `{ idempotencyKey: string; requestId: string; correlationId: string }`, `ReceiptEntrySnapshot` as `{ receipt: PaymentWorkflowInput; allocations: PaymentAllocationInput[]; files: File[]; context: ReceiptCommandContext }`, and `ReceiptEntryProgress` as `{ intakePublicId?: string; files: Record<string, { evidencePublicId: string; status: "pending" | "ready" }> }`, keyed by file SHA-256.
- `submitReceiptForReview(client: HttpClient, snapshot: ReceiptEntrySnapshot, progress: ReceiptEntryProgress, onProgress: (next: ReceiptEntryProgress) => void, dependencies?: { put: typeof fetch; sha256: (file: File) => Promise<string> }): Promise<{ intakePublicId: string }>` consumes those types. Provide browser defaults for injected dependencies. Report typed failure codes and the retained intake ID without logging payloads.
- API sequence: POST `/payment-intakes`; for each selected file POST `/:id/evidence/upload-intents`, signed PUT using returned required headers, POST `/:id/evidence/:evidenceId/finalize`; POST `/:id/match-preview` with all explicit allocations; navigate to `/payments?intake=<id>`.
- Do not add a post call. A `ready` upload intent is already complete and is reused. Inspect idempotency replays via GET `/:id`, compare exact immutable receipt fields/count, and stop other duplicate reasons for review. Retain progress after every successful step so retries do not recreate the intake or replay completed files.

- [x] Add failing orchestration tests: two allocations/one create/no post; evidence-free count omitted; selected count declared; correct prepare/PUT/finalize ordering; ready file skips PUT/finalize; second-file failure then retry makes no second create; lost-create response retries with the same key; mismatching idempotency replay and duplicate evidence stop before allocation preview.
- [x] Add form interaction tests: query loan preselected, add/remove rows, independent borrower/contract/schedule changes, floating row has no fixed schedule selector, stale schedule response ignored, zero-difference requirement with files, no-evidence total derived from rows, amount blur formatting, file validation/removal, locked submitted snapshot, pending-draft link on failure, Cancel destination, and no automatic post even on a ready preview.
- [x] Run focused tests to confirm failures; implement model consumption, responsive rows, evidence section, receipt summary, retry state, and localization. Deduplicate selected content hashes before registering the expected count; reject duplicates before creating an intake.
- [x] Default the payer from the originating borrower for the preselected single-contract shortcut; make the payer explicit/editable independently of allocation rows. Do not change it when additional borrowers are selected. Preserve all warning review paths.
- [x] Keep the selected file manifest immutable after creation. Keep the operator on the form during recoverable failures, with retry/open-draft actions. Going back discloses the saved unposted draft; it does not issue a financial cancellation or deletion.
- [x] Run `bun run test -- src/pages/dashboard/transactions/transaction-entry-model.test.ts src/pages/dashboard/transactions/transaction-entry-workflow.test.ts tests/transaction-form.vitest.tsx tests/workflow-api.test.ts tests/payment-inbox.vitest.tsx` from `frontend`; expect all pass.

## Task 3: Receipt links and shared evidence in each contract's history

**Files:**
- Modify `backend/src/modules/transactions.ts`
- Modify `backend/src/modules/payment-intakes.test.ts`
- Modify `backend/src/services/payment-evidence-read-service.test.ts` only if the existing helper needs additional direct coverage.
- Modify `frontend/src/pages/dashboard/loans/LoanPaymentHistoryTab.tsx`
- Modify `frontend/tests/loan-payment-history-evidence.vitest.tsx`
- Modify both locale files.

**Interfaces:**
- `/transactions` adds nullable `paymentIntakePublicId: string | null` by a tenant-qualified, actor-access-qualified join to `payment_intakes`. Preserve existing access filters/cache scope/evidence fields and avoid exposing new numeric database IDs or evidence contents. An intake outside the actor's accessible scope must not gain a public link through this join.
- History consumes the public ID to render “ดูรายการรับเงิน” / “View receipt” linking to `/payments?intake=<publicId>`. Per-contract amounts stay sourced from the posted transaction, and evidence previews use the existing safe evidence summaries and access resolver.

- [x] Add a disposable regression fixture with two active contracts, exact scheduled amounts `100.00` and `200.00`, one receipt `300.00`, and one ready evidence file. Preview/post using existing services in the disposable database, then assert two transaction rows with their own exact amounts, the same intake public ID, and identical evidence public/file IDs. Assert other tenant/owner access excludes protected rows and legacy null-intake transactions retain null links.
- [x] Add history rendering tests for contract amount, shared preview controls, receipt link, multiple files, and legacy evidence-free rows.
- [x] Run the new backend regression to confirm failure, implement the additive read join/link, and rerun to pass. No financial service or schema changes.
- [x] Verify opening either history link selects the same intake and its complete allocation list in the existing inbox review.

## Task 4: Review, documentation, and verification

**Files:** `README.md`, `CHANGELOG.md`, plus the task-owned files above.

- [x] Update README to describe one receipt/many contracts, optional supporting files, separate-transfer batch behavior, review-before-post, and shared-history evidence.
- [x] Add a newest explicit version/date CHANGELOG heading using the next available version at commit time; group this feature and owned prerequisite fixes accurately. Preserve concurrent documentation changes during eventual integration.
- [x] From `frontend`, run `bun run test`, `bun run lint`, `bun run build`; all must pass.
- [x] From `backend`, run `bun run typecheck` and `bash scripts/test-disposable-postgres.sh src/modules/payment-intakes.test.ts src/modules/loan-payment-history.test.ts src/services/payment-service.test.ts src/services/payment-evidence-read-service.test.ts`. Database tests must actually execute, serially, against the disposable database.
- [x] Perform one bounded browser inspection with mocked/synthetic API fixtures: desktop/mobile, Thai/English, keyboard/focus, upload failure/retry, stale schedule response, Cancel, grouped evidence/history links, and a browser timezone different from Bangkok. Fix defects in one batch and confirm. Do not create live tenant financial records.
- [x] Run the Impeccable detector once over changed UI targets, applying its craft-floor guidance before UI edits. Investigate actionable findings without unrelated style changes.
- [x] Inspect final diff for exact Decimal use, no legacy POST `/transactions`, no auto-post, no sensitive logging, tenant/access preservation, documentation accuracy, and unrelated-file preservation. Record commands and results at the final feature HEAD.
- [x] Commit reviewed task files with CHANGELOG/README. Report branch/worktree/tmux/model, commit, verification evidence, and integration/deployment status accurately. Backend production deployment would need authority beyond the earlier frontend-only deployment request; no production action is part of this plan's implementation gates.

## Self-review

All approved requirements map to Tasks 1–3, with Task 4 covering localization/render/verification. The five review risks each have explicit tests. The plan preserves one receipt, existing accounting/review/evidence services, independent row amounts, and immutable posted records. No unresolved implementation choice requires a new product decision; plan approval is required by the repository's tmux handoff rule.
