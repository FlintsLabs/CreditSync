# Single-Payment Settlement and Loan Restructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add exact lump-sum maturity loans and an append-only settlement/restructure workflow that can waive non-principal balances, add principal, and create any supported replacement contract without rewriting financial history.

**Architecture:** Extend the existing loan term kernel with closed single-payment terms, then add a dedicated restructure aggregate and service beside (not inside) daily renewal. REST and MCP call the same application services; the Web UI consumes preview/execute endpoints and never recreates accounting calculations. Work is ordered so every financial layer is testable before the next public adapter is added.

**Tech Stack:** Bun, TypeScript, Elysia, Drizzle/PostgreSQL, Decimal.js, React 19, Vitest, i18next, MCP SDK, CreditSync Codex plugin.

## Global Constraints

- Public money is a two-decimal decimal string and all financial arithmetic uses `decimal.js`; never use `Number` for money.
- Business dates use `Asia/Bangkok`; timestamps remain ISO 8601 and due dates use `YYYY-MM-DD`.
- Posted financial records and activated loan terms are immutable; correction uses append-only compensation with reason and audit context.
- Every financial write carries command context, correlation/request ID, actor/source, idempotency where supported, and useful before/after audit state.
- Additional approved principal is not an actual payout; actual cash uses the existing disbursement draft/evidence/post lifecycle.
- REST and MCP share application services; MCP never calls REST and exposes only public UUIDs and safe fields.
- Frontend user copy is added to `frontend/src/locales/en.json` and `frontend/src/locales/th.json` together.
- Before each commit, update `CHANGELOG.md`; update `README.md` with the material workflow before the final feature commit.
- Database-backed financial verification must run through `backend/scripts/test-disposable-postgres.sh` and may not be replaced by skipped tests.

---

### Task 1: Exact single-payment and settlement calculation kernel

**Files:**
- Create: `backend/src/lib/single-payment.ts`
- Create: `backend/src/lib/single-payment.test.ts`
- Modify: `backend/src/lib/calculator.ts`
- Modify: `backend/src/lib/loan-schedule.ts`
- Modify: `backend/src/lib/public-loan-terms.test.ts`

**Interfaces:**
- Produces: `SinglePaymentTerms`, `normalizeSinglePaymentTerms()`, `calculateSinglePaymentSettlement()`, and a one-row schedule for `repaymentType: "single_payment"`.
- Consumes: `parseMoney()`, `serializeMoney()`, Decimal.js, posted principal exposure segments, and Bangkok date utilities.

- [ ] **Step 1: Write failing tests for mutually exclusive term policies and the one-row maturity schedule**

```ts
expect(normalizeSinglePaymentTerms({
  dueDate: "2026-08-19",
  fixedAgreedInterest: "500.00",
  interestPolicy: "fixed_only",
  latePenalty: { mode: "none" },
}, "2026-08-10")).toMatchObject({ fixedAgreedInterest: "500.00" });

expect(calculatePublicLoanSchedule({
  principal: "5000.00", interestRate: "0.00", termMonths: 1,
  repaymentType: "single_payment", startDate: "2026-08-10",
  singlePayment: { dueDate: "2026-08-19", fixedAgreedInterest: "500.00", interestPolicy: "fixed_only", latePenalty: { mode: "none" } },
})).toEqual([{ installmentNo: 1, dueDate: "2026-08-19", amount: "5500.00", principalComponent: "5000.00", interestComponent: "500.00", remainingPrincipal: "0.00" }]);
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `cd backend && bun test src/lib/single-payment.test.ts src/lib/public-loan-terms.test.ts`

Expected: FAIL because the single-payment interfaces and repayment type do not exist.

- [ ] **Step 3: Implement normalization and exact schedule generation**

Implement closed unions for `fixed_only` and `greater_of_fixed_or_retroactive`; require due date after start date; forbid retroactive terms on fixed-only; emit one immutable schedule row.

- [ ] **Step 4: Add failing calculation tests for both `max()` branches, equality, multiple exposures, repayments, penalty, and waiver**

```ts
expect(calculateSinglePaymentSettlement({
  settlementDate: "2026-08-24", dueDate: "2026-08-19",
  fixedAgreedInterest: "500.00",
  retroactive: { rateType: "percent_per_day", rate: "1.0000" },
  exposures: [{ amount: "5000.00", fromDate: "2026-08-10", toDate: "2026-08-24" }],
  latePenalty: { mode: "fixed_amount_per_day", amountPerDay: "20.00", graceDays: 0 },
  waivers: { interest: "100.00", fees: "0.00", penalties: "40.00" },
})).toMatchObject({ selectedInterest: "700.00", grossPenalty: "100.00", netInterest: "600.00", netPenalty: "60.00" });
```

- [ ] **Step 5: Implement the Decimal-only settlement trace**

Return fixed candidate, retroactive candidate, selected branch, exposure/day trace, gross components, component waivers, and net components. Interest continues through settlement; penalty begins after due date plus grace; never add fixed and retroactive interest.

- [ ] **Step 6: Run kernel tests and typecheck**

Run: `cd backend && bun test src/lib/single-payment.test.ts src/lib/public-loan-terms.test.ts src/lib/public-loan-schedule.test.ts && bun run typecheck`

Expected: all pass.

### Task 2: Additive database model and immutability

**Files:**
- Create: `backend/drizzle/0023_single_payment_restructure.sql`
- Create: `backend/src/db/single-payment-restructure-migration.test.ts`
- Modify: `backend/src/db/schema.ts`
- Modify: `backend/src/db/agent-workflow-schema.test.ts`

**Interfaces:**
- Produces: loan single-payment/accrual-cycle columns and Drizzle tables `loanRestructures`, `loanOpeningBalanceComponents`, `loanRestructureWaivers`, and durable request-key records.
- Consumes: existing tenant composite keys, UUIDv7 defaults, audit conventions, disbursement and renewal immutability patterns.

- [ ] **Step 1: Write schema/migration contract tests**

Assert additive columns for due date, fixed agreed interest, interest policy, retroactive rate type/rate, floating accrual cycle, and late-penalty policy. Assert tenant-scoped old/new loan relations, exact numeric columns, status checks, unique request keys, and update/delete rejection after execute/reverse.

- [ ] **Step 2: Run tests and verify failure**

Run: `cd backend && bun test src/db/single-payment-restructure-migration.test.ts src/db/agent-workflow-schema.test.ts`

- [ ] **Step 3: Implement schema and SQL migration**

Use additive nullable loan columns; backfill `floating_accrual_cycle = 'daily'` only for existing floating loans; do not infer historical single-payment loans. Store gross/waived/net component amounts independently and use source public lineage.

- [ ] **Step 4: Add database enforcement tests**

Test forbidden over-waiver, invalid term combinations, cross-tenant relations, mutation of executed aggregates/opening components, and duplicate idempotency keys.

- [ ] **Step 5: Run disposable PostgreSQL migration tests**

Run: `cd backend && ./scripts/test-disposable-postgres.sh src/db/single-payment-restructure-migration.test.ts`

Expected: migration applies and every database invariant passes against PostgreSQL.

### Task 3: Loan draft, preview, activation, and presentation

**Files:**
- Modify: `backend/src/services/loan-application-service.ts`
- Modify: `backend/src/services/loan-application-service.test.ts`
- Modify: `backend/src/modules/loan-route-schemas.ts`
- Modify: `backend/src/modules/loan-contract-routes.ts`
- Modify: `backend/src/modules/loans-route-composition.test.ts`

**Interfaces:**
- Produces: `LoanTermsInput.singlePayment`, `FloatingDailyInterest.accrualCycle`, persisted/presented single-payment terms, and activated one-row schedule.
- Consumes: Task 1 normalization/schedule functions and Task 2 schema.

- [ ] **Step 1: Add failing service tests for preview, draft, update, activation, and immutable terms**

Test `5000.00 + 500.00` due `2026-08-19`, exact draft round-trip, one schedule row on activation, direct-capital funding, and rejection of term edits after activation.

- [ ] **Step 2: Run focused service tests and verify failure**

Run: `cd backend && bun test src/services/loan-application-service.test.ts`

- [ ] **Step 3: Implement service and public presenter support**

Persist normalized closed terms, keep `interestRate` compatibility without using it to recreate fixed interest, set `nextDueDate` to the exact due date, and keep additional payout independent.

- [ ] **Step 4: Add REST schema and route tests**

Test exact string DTOs, unknown-field rejection, invalid policy combinations, floating `accrualCycle`, and stable domain errors.

- [ ] **Step 5: Implement REST schemas/routes and run tests**

Run: `cd backend && bun test src/services/loan-application-service.test.ts src/modules/loans-route-composition.test.ts && bun run typecheck`

### Task 4: Settlement/restructure and later-waiver application services

**Files:**
- Create: `backend/src/services/loan-restructure-service.ts`
- Create: `backend/src/services/loan-restructure-service.test.ts`
- Create: `backend/src/services/loan-waiver-service.ts`
- Create: `backend/src/services/loan-waiver-service.test.ts`
- Modify: `backend/src/services/payment-service.ts`
- Modify: `backend/src/services/payment-service.test.ts`
- Modify: `backend/src/services/loan-disbursement-service.ts`

**Interfaces:**
- Produces: `previewLoanRestructure()`, `executeLoanRestructure()`, `reverseLoanRestructure()`, `previewLoanWaiver()`, `executeLoanWaiver()`, `reverseLoanWaiver()` and public DTO presenters.
- Consumes: command context, Task 1 kernel, Task 2 tables, Task 3 loan creation/activation primitives, existing disbursement drafts, audit/cache utilities.

- [ ] **Step 1: Write failing preview tests**

Cover source-loan access, actual posted disbursement exposure, fixed-vs-retroactive selection, concurrent penalty, component waivers, external credits, additional principal, replacement terms, cash direction, version/hash/expiry, and no persistence during preview.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `cd backend && bun test src/services/loan-restructure-service.test.ts`

- [ ] **Step 3: Implement preview with one authoritative balance snapshot**

Use existing loan rollups and posted event ledgers. Produce `replacementPrincipal = outstandingPrincipal + additionalPrincipal`; never include interest/fees/penalties in that basis.

- [ ] **Step 4: Write failing execute/idempotency/concurrency tests**

Test atomic old-loan transition, replacement activation, immutable opening components, append-only waivers/credits, additional-principal disbursement draft, same-key replay, different-payload conflict, stale balance rejection, and rollback on injected persistence failure.

- [ ] **Step 5: Implement execute under row locks and one transaction**

Require `confirmed: true`, matching public preview/hash, balance version, idempotency key, and reason. Return old/new public IDs, optional disbursement draft public ID, audit public IDs, and correlation ID.

- [ ] **Step 6: Write and implement reversal tests**

Block on downstream payments, posted disbursements, rate changes, later restructure/renewal, and later waivers. When safe, append compensation, restore the exact old status, neutralize rather than delete the replacement, and preserve history.

- [ ] **Step 7: Write and implement later-waiver tests**

Support interest/fee/penalty only, partial/full amounts, required reason, stale preview, idempotent execution, compensating reversal, and explicit principal rejection.

- [ ] **Step 8: Update payment allocation tests and implementation**

Assert `penalty -> fee -> carried interest -> due new interest -> principal`, exact conservation, and early-settlement waiver of unearned new interest.

- [ ] **Step 9: Run disposable financial suites and typecheck**

Run: `cd backend && ./scripts/test-disposable-postgres.sh src/services/loan-restructure-service.test.ts src/services/loan-waiver-service.test.ts src/services/payment-service.test.ts && bun run typecheck`

### Task 5: REST adapters and read models

**Files:**
- Create: `backend/src/modules/loan-restructures.ts`
- Create: `backend/src/modules/loan-restructures.test.ts`
- Create: `backend/src/modules/loan-waivers.ts`
- Create: `backend/src/modules/loan-waivers.test.ts`
- Modify: `backend/src/modules/loans.ts`
- Modify: `backend/src/modules/loan-contract-routes.ts`
- Modify: `backend/src/modules/loans-route-composition.test.ts`

**Interfaces:**
- Produces: tenant-scoped REST list/detail/preview/execute/reverse endpoints and loan-detail lineage/opening-component fields.
- Consumes: Task 4 services only; adapters perform validation/authentication and do not calculate balances.

- [ ] **Step 1: Write failing authenticated route tests**

Test closed request bodies, public UUIDs, exact money, owner/tenant scoping, preview without mutation, confirmation/idempotency headers, audit/correlation responses, and stable conflict codes.

- [ ] **Step 2: Implement thin Elysia routes and mount them**

Use shared route helpers and invalidate tenant caches after successful writes. Add safe old/new lineage and component totals to Loan Detail.

- [ ] **Step 3: Run route and composition tests**

Run: `cd backend && bun test src/modules/loan-restructures.test.ts src/modules/loan-waivers.test.ts src/modules/loans-route-composition.test.ts && bun run typecheck`

### Task 6: MCP contract and CreditSync plugin synchronization

**Files:**
- Modify: `backend/src/mcp/server.ts`
- Modify: `backend/src/mcp/default.ts`
- Modify: `backend/src/mcp/server.test.ts`
- Modify: `backend/src/mcp/default.test.ts`
- Modify: `backend/src/mcp/contract-snapshot.ts`
- Modify: `plugins/creditsync/.codex-plugin/plugin.json`
- Modify: `plugins/creditsync/.app.json`
- Create: `plugins/creditsync/skills/restructure-loan/SKILL.md`
- Modify: `plugins/creditsync/skills/creditsync/SKILL.md`
- Modify: `plugins/creditsync/skills/manage-loans/SKILL.md`
- Modify: `plugins/creditsync/references/financial-rules.md`
- Modify: `plugins/creditsync/references/error-recovery.md`
- Modify: `plugins/creditsync/references/mcp-tool-contract.json`
- Modify: `plugins/creditsync/evals/evals.json`
- Modify: `plugins/creditsync/evals/harness.ts`
- Modify: `plugins/creditsync/evals/skill-tests.md`
- Modify: `plugins/creditsync/scripts/validate.ts`
- Modify: `plugins/creditsync/tests/plugin-contract.test.ts`
- Modify: `plugins/creditsync/tests/eval-harness.test.ts`
- Modify: `plugins/creditsync/README.md`
- Modify: `plugins/creditsync/CHANGELOG.md`

**Interfaces:**
- Produces: closed MCP tools `loan.restructure.preview/execute/reverse` and `loan.waiver.preview/execute/reverse`, plus extended loan preview/draft terms.
- Consumes: Task 4 services and Task 5 public DTO semantics.

- [ ] **Step 1: Add failing MCP contract tests**

Assert read/destructive annotations, strict schemas, no internal IDs, exact money, audit/correlation on writes, and sanitized errors. Execute must require `confirmed: true`, preview hash/version, reason, and idempotency key.

- [ ] **Step 2: Implement adapters and regenerate/freeze contract**

Wire directly to application services. Run the repository contract generator rather than hand-editing generated JSON where the script owns it.

- [ ] **Step 3: Add plugin orchestration and eval stop gates**

Positive eval: inspect -> preview -> exact confirmation -> execute. Negative evals: ambiguous borrower, stale preview, missing waiver reason, missing confirmation, unexpected additional cash, and unsafe reversal.

- [ ] **Step 4: Run MCP and plugin verification**

Run: `cd backend && bun test src/mcp/server.test.ts src/mcp/default.test.ts`

Run: `bun test plugins/creditsync/tests && bun plugins/creditsync/scripts/validate.ts`

Expected: strict contract snapshot, plugin tests, evals, and validator pass.

### Task 7: Localized Web loan creation and restructure workflow

**Files:**
- Modify: `frontend/src/lib/workflow-model.ts`
- Modify: `frontend/src/pages/dashboard/loans/LoanWizard.tsx`
- Modify: `frontend/src/pages/dashboard/loans/LoanDetail.tsx`
- Create: `frontend/src/pages/dashboard/loans/LoanRestructurePanel.tsx`
- Create: `frontend/src/pages/dashboard/loans/LoanOpeningBalances.tsx`
- Modify: `frontend/src/locales/en.json`
- Modify: `frontend/src/locales/th.json`
- Modify: `frontend/tests/loan-wizard.vitest.tsx`
- Create: `frontend/tests/loan-restructure-panel.vitest.tsx`
- Modify: `frontend/tests/loan-detail-activation.vitest.tsx`

**Interfaces:**
- Produces: single-payment wizard inputs, exact preview review, restructure wizard, component waiver controls, additional-principal disclosure, lineage/opening-balance detail.
- Consumes: Task 3 and Task 5 REST DTOs; `formatMoneyExact()`; active i18n language.

- [ ] **Step 1: Write failing workflow-model and wizard tests**

Test exact single-payment request construction, due-date validation delegated to backend, mutually exclusive policy controls, optional penalty, Thai/English labels, and preview totals.

- [ ] **Step 2: Implement single-payment creation UI**

Add due date, fixed agreed interest, interest policy/rate, and optional daily penalty/grace controls. Display the one-row preview and explain that fixed and retroactive interest are alternatives.

- [ ] **Step 3: Write failing restructure panel tests**

Test load/error states, gross/waived/net component display, required waiver reasons, external-payment distinction, additional principal, every replacement type, preview expiry/stale conflicts, exact confirmation, and returned disbursement-draft notice.

- [ ] **Step 4: Implement the restructure wizard and read model**

Keep backend preview authoritative. Disable execute until the displayed preview is explicitly confirmed. Show `restructured from/to`, opening components, waived amounts, and actual payout status on Loan Detail.

- [ ] **Step 5: Add both locale trees and accessibility behavior**

Use labels, field descriptions, alert roles, focus movement, keyboard controls, responsive layouts, and active-language date/number formatting.

- [ ] **Step 6: Run frontend verification**

Run: `cd frontend && bun run test && bun run lint && bun run build`

Expected: all tests, lint, typecheck, and production build pass.

### Task 8: Documentation, full verification, and delivery

**Files:**
- Modify: `README.md`
- Modify: `docs/operations/agent-mcp-plugin.md`
- Modify: `CHANGELOG.md`
- Modify: `plugins/creditsync/CHANGELOG.md`

**Interfaces:**
- Produces: operator documentation, migration/deployment checklist, complete release notes, and verified deliverable.
- Consumes: all prior tasks.

- [ ] **Step 1: Document the user and agent workflows**

Document single-payment terms, settlement/restructure, fixed-vs-retroactive selection, optional concurrent penalty, waiver vs external payment, additional disbursement, confirmation gates, reversal blockers, and production migration checks.

- [ ] **Step 2: Run full backend disposable verification**

Run: `cd backend && ./scripts/test-disposable-postgres.sh && bun run typecheck`

Expected: every database-backed suite runs (not skips), all tests pass, and typecheck passes.

- [ ] **Step 3: Run full frontend and plugin verification**

Run: `cd frontend && bun run test && bun run lint && bun run build`

Run: `bun test plugins/creditsync/tests && bun plugins/creditsync/scripts/validate.ts`

- [ ] **Step 4: Inspect the final change set and financial invariants**

Run: `git diff --check && git status --short && git diff --stat`

Confirm no raw secrets, identity values, signed URLs, `Number` money conversion, mutable posted records, missing locale keys, unsynchronized plugin contracts, or unrelated checkout changes.

- [ ] **Step 5: Update versioned changelogs and create final commit(s)**

Each commit stages its matching `CHANGELOG.md` entry. The final commit includes README/operations documentation and accurately summarizes the verified staged set.
