# Floating accrual payment history — implementation plan

Date: 2026-10-07 (Asia/Bangkok)
Status: Approved by user on 2026-10-07; tmux implementation authorized, no merge/push/deploy.

Specification: `docs/superpowers/specs/2026-10-07-floating-accrual-payment-history.md`.
Goal: selected daily interest dates, independent actual receipt timestamps, direct preview/confirmation in Accrue, and visible per-date receipt history.

## Execution and ownership

AGENTS.md requires tmux for this substantial backend/schema/frontend change and approval of spec plus detailed plan before delegation. At execution, use an isolated worktree and `codex/floating-accrual-payments`, integration target `main`, session `creditsync-accrual-payments`. Verify the available Luna catalog, then start the latest supported Luna (currently `gpt-6-luna`) with reasoning `medium` and `service_tier="fast"`; report any fallback explicitly. Root supervises and independently verifies the worker result. No merge, push, deploy, or production mutation.

The shared main checkout is dirty and another payment-entry task owns frontend locale, payment-history/transaction-form, and nginx edits. Preserve those edits and all untracked slips/logs/docs. Snapshot Git state before creating the worktree. Carry this chat's earlier verified accrual-projection fix as an explicitly recorded baseline: the four backend files changed in that fix plus its accrual-table render test and corresponding README/changelog hunks. Do not copy unrelated dirty locale/form/nginx changes. Record baseline hashes and include the approved baseline in the resulting branch without claiming it belongs to the new selected-date feature alone.

Read the actual worker `AGENTS.md`, current migration journal, plugin manifest/validator inventory, and MCP profile index. Do not hardcode the next migration number, plugin version, or tool count from this plan.

## Task 1 — targeted allocation domain and storage

Files: modify `backend/src/db/schema.ts`; add the next generated migration and metadata under `backend/drizzle/`; create `backend/src/services/floating-accrual-payment-service.ts` and its test file.

Interfaces:

```ts
type SelectedAccrualTarget = { accrualDate: string; amount: string };
type SelectedAccrualPaymentInput = {
  amount: string; receivedAt: string; targets: SelectedAccrualTarget[];
  paymentIntakePublicId?: string; notes?: string | null; bankReference?: string | null;
};
```

- Write failing disposable-DB tests for spec examples 1–4 with literal `80.00`, `160.00`, `30.00`, `50.00` expectations. Verify which dates stay unpaid and which actual timestamps remain unchanged.
- Define `payment_match_floating_targets`: tenant, public UUID, match allocation ID, loan ID, accrual date, exact amount. Use composite tenant-scoped FKs, required supporting unique indexes, unique allocation/date constraints, positive amount/scale checks, and immutable target records. Existing proposals append new versions instead of editing target records.
- Implement an authoritative resolver using floating-interest as-of projection and current active reversal lineage. Reject duplicate dates, future dates/receipts, missing rate coverage, other-loan/tenant targets, over-allocation, sum mismatch, unsupported lifecycle/policy and zero/negative/invalid amounts. No Number conversions for money.
- Add tests for monetary precision beyond JS safe integers, pending evidence requirements, historical target capacity already allocated later, and no ledger writes during the projection part of preview.
- Run the new tests through `bash backend/scripts/test-disposable-postgres.sh src/services/floating-accrual-payment-service.test.ts`; confirm expected red before implementation and green afterward.

## Task 2 — preview, posting, and chronology

Files: modify `backend/src/services/payment-service.ts` and `backend/src/services/payment-chronology-service.ts` only where selected-date semantics require it; extend the new service tests and `backend/src/services/floating-allocation-regressions.test.ts`.

Interfaces produced:

```ts
previewFloatingAccrualPayment(ctx: CommandContext, loanPublicId: string,
  input: SelectedAccrualPaymentInput)
postFloatingAccrualPayment(ctx: CommandContext, loanPublicId: string,
  input: { paymentIntakePublicId: string; proposalPublicId: string; confirmed: true })
```

- Red-test one intake/proposal containing exact target dates, subsequent re-preview versions, immutable stored targets, and mismatched idempotency payload rejection.
- Reuse intake creation and the proposal lifecycle in a transaction. Scope selected metadata through an internal service input; do not change frozen MCP request/output schemas. Hash selected dates/amounts, receipt timestamp, and relevant current financial/penalty/lineage state. Reopened generic review must preserve selected semantics or stop explicitly.
- Add a selected-interest branch to `postPaymentKernel`: load persisted targets, lock and revalidate, materialize required accruals through actual receipt date, resolve real accrual records, append one repayment transaction with interest-only components and exact target allocations, reconcile penalties with existing append-only services, refresh rollups/cache, and return receipt/audit/correlation IDs.
- Test same-day newer interest paid while older interest remains unpaid, later collection of the older target, multi-date noncontiguous targets, partial payments, and concurrent same-target posting. Selected actions never move money to unselected dates or principal.
- Red-test spec example 5 separately: disjoint historical interest-only receipt is accepted when safe; overlapping capacity, downstream paid-penalty conflicts and principal dependencies are blocked. Keep generic FIFO chronology guards unchanged. No blanket guard deletion or silent receipt-date adjustment.
- Test stable retries, expired/current-version conflicts, atomic rollback, reversal of targeted receipts restoring only their target balances, complete reversal lineage, and existing latest-payment reversal restrictions. Verify floating integrity returns zero issues for every supported scenario.

## Task 3 — authenticated routes and receipt read model

Files: create `backend/src/modules/loan-accrual-payment-routes.ts` and its tests; register in `backend/src/modules/loans.ts`; create `backend/src/services/loan-accrual-history-service.ts` and tests; modify the web path in `backend/src/services/loan-application-service.ts` and `backend/src/modules/loan-contract-routes.ts`.

- Implement the two closed REST schemas from the spec, with public UUID path/receipt identifiers, positive decimal strings, ISO receipt timestamp, at most 366 unique date targets, required idempotency and explicit confirmation for post. Call services directly.
- Route tests cover portfolio/tenant authorization, foreign proposals, required context/confirmation, stale previews, replayed commands, and public error responses with no internals.
- Produce safe web accrual receipt metadata: per-allocation amount, actual receivedAt, recordedAt, intake/transaction UUID, active/reversed status and source kind (`receipt`, `advance_deduction`, `legacy_unattributed`). Batch queries by tenant/loan, including reversed lineage, not one query per row.
- Test split receipts, reversed receipt visibility with zero net paid effect, advance deduction without invented receipt, legacy unknown receipt dates, historical reads and persisted/projected accrual rows. Keep existing MCP contract field shape and UUID identifiers intact.
- Verify web table amounts and payment-health values remain consistent. Preserve earlier fix counting today's daily interest once and the Bangkok-date cache key.

## Task 4 — Accrue payment dialog and visible history

Files: create `frontend/src/pages/dashboard/loans/LoanAccrualPaymentDialog.tsx`, `loan-accrual-payment-model.ts` and meaningful tests; modify `LoanAccrualsTab.tsx`, `LoanAccrualsTab.test.tsx`, `LoanDetail.tsx`, and `frontend/src/locales/{th,en}.json` with semantic hunks only.

- Extend the existing web row type with receipt-history metadata. Add per-row Pay buttons, receipt date/time and allocated amounts, partial/paid/reversed labels and links; preserve existing styles and Thai Sarabun font.
- Build one modal: selected dates and amounts, editable actual Bangkok receipt datetime, total, optional note/reference, review result, and explicit confirmation. Clicking a row preselects its interest date but defaults actual receipt time to now. Require explicit per-date amounts for multi-date requests; frontend may sum exact amounts for display but never calculates interest/penalty accounting.
- Reuse existing api headers and stable keys. Keep intake identity through re-preview, dialog reopening, duplicates/network errors and post-success refresh failure. Editing any field invalidates review and confirmation. Prevent double submission and automatically inspect/recover existing posted results.
- Use Bangkok datetime conversion utilities independent of browser timezone. Tests set a non-Bangkok browser zone and assert the exact submitted ISO timestamp. Do not reuse `new Date(datetimeLocal)` as browser-local accounting time.
- Test chosen-day-first/older-day-later flow, partial/multiple receipts, no post before explicit confirmation, stale state requiring another review, warning/variance blockers, preserved draft/receipt IDs, unknown legacy dates, advance deduction labels, and refresh failures that do not trigger another post.
- Support mobile and desktop dialogs, keyboard focus/escape/return, long Thai strings, loading/error/disabled states, and reduced motion. UI labels clearly distinguish interest date, receipt date, and recorded date.

## Task 5 — review, verification and documentation

- Run the relevant new tests first with red/green evidence. Then run serialized disposable suites covering targeted service/routes/history, payment service, payment chronology guard, floating interest/allocation/reversal/reflow and loan payment-health/application behavior. Use `backend/scripts/test-disposable-postgres.sh`; never point test suites at production or concurrently reset one disposable DB.
- Run `bun run typecheck` in backend; `bun run test`, `bun run lint`, `bun run build` in frontend; `bun test` and `bun run validate` in `plugins/creditsync`. If shared payment presentation affects MCP conformance, run its existing gate as well. Report failures/skips by name; DB skips do not satisfy this feature.
- Run one desktop/mobile browser QA batch on a disposable tenant or mocked safe fixture, covering row selection, receipt history, two-step review/post, focus, Thai wrap and post-refresh. Repair in a batch, then one confirmation pass. No test receipts in a live tenant.
- Follow Impeccable craft floor before UI edits and run its detector once for changed UI targets using the user's telemetry-disabled launcher settings. Do not enable hooks or install a new UI framework/library.
- Update README and changelog with the selected-interest-only policy, visible timestamp distinctions, migration requirement and known historical safety blockers. Every commit includes its corresponding version/date/type changelog entry; do not stage shared unrelated changes or secrets.
- Independently inspect final commits/diff, confirm tests at final HEAD, preserved dirty-file ownership, receipt/allocation invariants and baseline provenance. Deliver branch/worktree/session identifiers and verification evidence. No merge, push or production deployment.

## Review focus

1. UI targeting an interest date must not turn into FIFO during preview, posting, generic review, retry or reversal.
2. Historical receipt dates must not hide later active allocations and create over-allocation.
3. Interest-only targeting must leave unpaid principal/fees/penalties visible and must not weaken general payment policy.
4. Legacy paid amounts and advance deductions must not acquire fabricated actual receipt timestamps.
5. A post that succeeded before a connection/refresh failure must be recovered, never submitted as a new receipt.

Self-review: the spec's confirmed examples, history display, date distinctions, lifecycle/permissions, concurrency, integrity, locale and verification requirements map to Tasks 1–5. No worker may bypass a failed gate, edit immutable posted records, or broaden this scope to production repair.
