# Close Pending Restore and Schedule Work Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete, verify, and document the pending exact-payment-restore schedule repair and loan-schedule deferral UI work without changing posted financial records.

**Architecture:** Retain immutable payment records and derive only `loan_schedules` aggregates from non-reversed repayment transactions. Expose the repair through a closed, tenant-scoped MCP command with command context and audit history; separately surface existing deferral reasons through the loan-contract API and schedule UI.

**Tech Stack:** Bun, TypeScript, Elysia, Drizzle/PostgreSQL, Decimal.js, React, Vitest, CreditSync MCP/plugin validator.

**Spec:** `docs/superpowers/specs/2026-08-25-restore-draft-evidence-design.md`

## Global Constraints

- Money is two-decimal decimal strings and all arithmetic uses `decimal.js`.
- Posted payment and transaction records are immutable; the repair may update only derived schedule aggregate fields.
- Every financial command requires tenant-scoped command context, reason, idempotency key, and append-only audit history.
- The controlled backfill targets only restore child `01a039ef-a87b-7814-ae12-b23bfc896379`; it must not create a payment or transaction.
- Preserve unrelated user changes in the dirty working tree.

---

### Task 1: Verify and finish exact-restore schedule aggregate updates

**Files:**
- Modify: `backend/src/services/payment-reconciliation-service.ts`
- Modify: `backend/src/services/payment-reconciliation-service.test.ts`

**Interfaces:**
- Produces: `restoreScheduleAggregate(schedule, amounts)` and exact restore execution that writes `paidTotal`, `paidPenalty`, `remainingDue`, and `status` for the linked schedule.

- [ ] **Step 1: Run the focused restore regression test against the disposable database.**

Run: `TEST_DATABASE_URL=... bun test backend/src/services/payment-reconciliation-service.test.ts`

Expected: the test asserting the restored schedule is `paid` initially fails if the aggregate update is incomplete, or passes with the current change.

- [ ] **Step 2: Keep the schedule update derived from the exact restored transaction components.**

Implementation requirements:

```ts
const aggregate = restoreScheduleAggregate(schedule, amounts);
await tx.update(loanSchedules).set({ ...aggregate, updatedAt: new Date() })
```

The helper must add principal, interest, and fee to `paidTotal`, add penalties to `paidPenalty`, clamp `remainingDue` at zero, and set `paid` only when the remaining scheduled due is zero.

- [ ] **Step 3: Re-run the focused restore regression test.**

Expected: the exact restore leaves the linked schedule at `paidTotal: "100.00"`, `remainingDue: "0.00"`, and `status: "paid"` while preserving one restore child and its evidence.

### Task 2: Complete and harden the explicit stale-schedule backfill

**Files:**
- Modify: `backend/src/services/payment-reconciliation-service.ts`
- Modify: `backend/src/services/payment-reconciliation-service.test.ts`
- Modify: `backend/src/mcp/default.ts`
- Modify: `backend/src/mcp/server.ts`

**Interfaces:**
- Produces: `backfillPostedRestoreSchedule(ctx, { paymentIntakePublicId, reason, idempotencyKey })`.
- Produces: closed destructive MCP tool `payment.restore.schedule_backfill` with the same input.

- [ ] **Step 1: Make the backfill test cover a posted restore child, derived aggregate repair, audit, and idempotent replay.**

The test fixture must create a reversed source, one posted child linked by `repostOfIntakeId`, one scheduled repayment transaction, and a stale pending schedule. Assert the first call returns `changed: true`, leaves exactly one repayment transaction, and the replay returns `changed: false`.

- [ ] **Step 2: Validate the target before touching schedule state.**

Implementation requirements:

```ts
if (intake.status !== "posted" || intake.repostOfIntakeId === null) throw new DomainError(...);
if (!source || source.status !== "reversed") throw new DomainError(...);
if (scheduleIds.length !== 1) throw new DomainError(...);
```

Lock the source/child intake rows and target schedule. Sum only repayment transactions that lack a reversal, use `Decimal`, update only schedule aggregate columns when state differs, and write `restore_schedule_backfilled` audit history for both changed and no-op calls.

- [ ] **Step 3: Add the MCP adapter and schema registration.**

The tool must accept public UUIDs, a nonblank reason, and idempotency key; create command context; call the service; return only public IDs, `changed`, and correlation/audit IDs. Mark it destructive and do not expose raw transaction or evidence contents.

- [ ] **Step 4: Run focused service and MCP adapter tests.**

Expected: valid repair succeeds once, retry is a no-op, and wrong tenant/status/lineage/multiple schedules fail safely.

### Task 3: Complete deferral-reason API and UI changes

**Files:**
- Modify: `backend/src/services/loan-schedule-deferral-service.ts`
- Modify: `backend/src/services/loan-schedule-deferral-service.test.ts`
- Modify: `backend/src/modules/loan-contract-routes.ts`
- Modify: `frontend/src/pages/dashboard/loans/LoanRepaymentScheduleTab.tsx`
- Modify: `frontend/src/locales/en.json`
- Modify: `frontend/src/locales/th.json`
- Test: `frontend/tests/loan-detail-schedule.vitest.tsx`

**Interfaces:**
- Produces: `getDeferralReasonForSchedule(scheduleId, deferralRows): string | null`.
- Produces: contract schedule rows with `deferralReason`, `deferredSourceSchedulePublicId`, and `deferredReplacementSchedulePublicId`.

- [ ] **Step 1: Keep reason lookup pure and test both source and replacement schedules.**

```ts
return deferralRows.find((row) => row.sourceScheduleId === scheduleId || row.replacementScheduleId === scheduleId)?.reason ?? null;
```

- [ ] **Step 2: Return the reason from the contract route without changing deferral ledger records.**

The route projection must derive the reason from loaded deferral rows and return `null` for non-deferred schedules.

- [ ] **Step 3: Render the localized info action only when a reason exists.**

The schedule tab must expose an accessible button, show the reason in a dialog, and maintain Thai/English parity in locale keys. The UI must not reconstruct or mutate schedule state.

- [ ] **Step 4: Run focused backend and frontend tests.**

Expected: reason lookup succeeds for both ends of a deferral and the dialog opens from a deferred schedule row.

### Task 4: Verify responsive loan UI adjustments and documentation

**Files:**
- Modify: `frontend/src/layouts/DashboardLayout.tsx`
- Modify: `frontend/src/pages/dashboard/loans/LoanList.tsx`
- Test: `frontend/tests/dashboard-responsive-layout.test.ts`
- Test: `frontend/tests/loan-list.vitest.tsx`
- Modify: `plugins/creditsync/references/mcp-tool-contract.json`
- Modify: `plugins/creditsync/scripts/validate.ts`
- Modify: `plugins/creditsync/skills/reconcile-payments/SKILL.md`
- Modify: `plugins/creditsync/README.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Run frontend tests covering the `min-w-0` containment and borrower tag text sizing.**

Expected: card and dashboard layout tests pass without changing visible financial values.

- [ ] **Step 2: Register and validate the new closed MCP backfill command.**

Synchronize the frozen contract, manifest/validator expectations, and payment-reconciliation skill guidance. Include the operation’s restore-only safety boundary and required confirmation workflow.

- [ ] **Step 3: Update the changelog and user-facing documentation before committing.**

Add a newest explicit `## vX.Y.Z - 2026-09-01` entry that accurately groups restore aggregate repair, safe backfill, and schedule-deferral reason visibility. Update README only for changed user-facing or setup behavior.

### Task 5: Full verification and authorized controlled backfill

**Files:**
- Run: `backend/scripts/backfill-restore-schedule.ts`

- [ ] **Step 1: Run required verification gates.**

Run backend disposable database tests and typecheck, frontend test/lint/build, and plugin tests/validator. Resolve only failures caused by this scope; report pre-existing failures separately.

- [ ] **Step 2: Dry-run the explicit backfill target.**

Run:

```bash
TARGET_PAYMENT_INTAKE_PUBLIC_ID=01a039ef-a87b-7814-ae12-b23bfc896379 bun backend/scripts/backfill-restore-schedule.ts
```

Expected: output identifies the target and idempotency key without writing.

- [ ] **Step 3: Execute the approved one-time derived-state repair.**

Run the same command with `EXECUTE_BACKFILL=yes`. Confirm it reports a changed/no-op result, then re-read the contract and payment history to verify no second payment/transaction was created and the repaired installment is paid with zero remaining due.

- [ ] **Step 4: Review final diff and commit the scoped work.**

Run `git diff --check`, inspect staged files, ensure the changelog matches the implementation, then commit all scoped files together without including unrelated changes.
