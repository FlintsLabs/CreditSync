# Floating Loan Restructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable safe atomic `floating -> floating` restructures with correct carried-balance payment allocation.

**Architecture:** Keep the existing `loan.restructure.preview/execute/reverse` lifecycle. Add a floating-source balance adapter backed by the floating settlement service, then extend the payment allocation kernel so replacement floating loans settle carried components before current floating accruals. Preserve the current single-payment behavior and public identifiers.

**Tech Stack:** Bun, TypeScript, Drizzle ORM, PostgreSQL, `decimal.js` via `FinancialDecimal`, MCP/plugin contract tests.

**Spec:** `docs/superpowers/specs/2026-08-19-floating-loan-restructure-design.md`

## Global Constraints

- Active loan terms and posted financial records are immutable; use append-only restructure/opening-balance/disbursement records.
- Money crosses public interfaces as two-decimal decimal strings and uses `FinancialDecimal`/`decimal.js`.
- Use `Asia/Bangkok` business dates and explicit floating rate policy data.
- Preview must precede execution; execution requires the exact unexpired preview hash, balance version, confirmation, reason, and idempotency key.
- Preserve unrelated dirty files and do not create live-tenant financial records while testing.

### Task 1: Add failing service coverage for floating-source preview

**Files:**
- Modify: `backend/src/services/loan-restructure-service.test.ts`
- Test: `backend/src/services/loan-restructure-service.test.ts`

**Interfaces:**
- Consumes: `previewLoanRestructure()` with an active floating source loan.
- Produces: executable expectations for the floating-source preview contract.

- [ ] Add an integration test that seeds an active daily floating loan with principal `4000.00`, rate `15.0000` per-thousand, settles on a current business date, requests `additionalPrincipal: "1000.00"`, and supplies a floating replacement policy with the same rate.
- [ ] Assert the preview returns `replacementPrincipal: "5000.00"`, payout `1000.00`, floating replacement terms, and no single-payment-only error.
- [ ] Run `backend/scripts/test-disposable-postgres.sh src/services/loan-restructure-service.test.ts` and verify the new test fails with `LOAN_NOT_RESTRUCTURABLE`.

### Task 2: Implement a reusable floating restructure balance snapshot

**Files:**
- Modify: `backend/src/services/loan-settlement-service.ts`
- Modify: `backend/src/services/loan-restructure-service.ts`
- Test: `backend/src/services/loan-restructure-service.test.ts`

**Interfaces:**
- Consumes: active floating loan, settlement business date, command context.
- Produces: principal, carried interest/fees/penalties, external-credit allocation inputs, balance version, and safe presentation fields.

- [ ] Extract or export a transaction-safe floating settlement snapshot helper from `loan-settlement-service.ts`; it must accrue through the supplied Bangkok date and calculate due interest, accrued-not-due interest, fees, penalties, and non-refundable advance-interest history without mutating posted records.
- [ ] Update restructure preview source selection to retain the existing single-payment calculation and use the floating snapshot for `repaymentType === "floating"`.
- [ ] Include floating accrual rows, penalty ledger rows, disbursement rows, rate periods, loan rollups, and transactions in the source balance version.
- [ ] Define the floating branch’s carried-component policy: unpaid eligible interest/fees/penalties are carried into the replacement; principal reduces only by explicit external settlement credit; additional principal is added afterward.
- [ ] Run the focused disposable service test and confirm Task 1 passes without changing single-payment assertions.

### Task 3: Add failing payment-allocation coverage for floating replacements

**Files:**
- Modify: `backend/src/services/payment-service.test.ts`
- Modify: `backend/src/services/floating-allocation-regressions.test.ts`

**Interfaces:**
- Consumes: an executed restructure whose replacement loan is floating and has opening-balance components.
- Produces: allocation assertions for carried and newly accrued components.

- [ ] Add a test for a floating replacement with carried interest and a new daily accrual; post a payment and assert the transaction splits carried interest before new floating interest and principal.
- [ ] Add a test that a replacement with carried penalty/fee cannot skip those opening components.
- [ ] Run the targeted disposable suites and verify the tests fail against the current floating branch, which currently allocates only floating penalty/new interest/principal.

### Task 4: Implement floating replacement carried-component allocation

**Files:**
- Modify: `backend/src/services/payment-service.ts`
- Modify: `backend/src/services/floating-interest-service.ts` only if the shared obligation API needs a focused extension
- Test: `backend/src/services/payment-service.test.ts`

**Interfaces:**
- Consumes: current restructure opening components, active replacement transactions, floating obligations, and payment amount.
- Produces: exact transaction components and immutable floating allocation rows for only newly accrued floating components.

- [ ] Refactor the existing restructure bucket calculation so it can return carried buckets without requiring a schedule row.
- [ ] In the floating payment branch, allocate in this order: carried penalty, carried fee, carried interest, current floating penalty, current floating interest, principal; preserve existing backdated-allocation guards.
- [ ] Record floating allocation rows only for current floating penalty/interest; keep carried components auditable through opening-balance components and transaction components.
- [ ] Update loan rollups and fund effects with the complete component split, preserving idempotency and reversal behavior.
- [ ] Run the focused payment and floating regression suites until green.

### Task 5: Add execution, stale-state, and reversal coverage

**Files:**
- Modify: `backend/src/services/loan-restructure-service.test.ts`
- Modify: `backend/src/services/loan-settlement-service.test.ts` if shared snapshot coverage belongs there

**Interfaces:**
- Consumes: floating-source preview and exact execute inputs.
- Produces: lifecycle guarantees for old/replacement loans and downstream blockers.

- [ ] Assert execution marks the old floating loan `restructured`, creates an active floating replacement with principal `5000.00`, writes its rate period, opening components, and a `1000.00` disbursement draft.
- [ ] Assert a payment or rate-period change after preview makes execution fail with `STALE_RESTRUCTURE_PREVIEW` and creates no replacement.
- [ ] Assert reversal remains blocked after replacement payment, disbursement posting, or rate activity, and remains compensating when safe.
- [ ] Run all affected disposable PostgreSQL suites.

### Task 6: Synchronize MCP/plugin contract and verify

**Files:**
- Modify: `backend/src/mcp/default.ts` only if tool description/validation is source-limited
- Modify: `plugins/creditsync/skills/restructure-loan/SKILL.md`
- Modify: `plugins/creditsync/evals/evals.json`
- Modify: `plugins/creditsync/README.md`
- Modify: `plugins/creditsync/references/mcp-tool-contract.json` only if the generated/frozen contract changes
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: unchanged public restructure tool names with broadened source support.
- Produces: synchronized agent instructions, evals, and release documentation.

- [ ] Update the restructure skill and evals from “single-payment source” to “supported active source including floating”, while retaining explicit preview/confirmation boundaries.
- [ ] Add a positive floating-source restructure eval and negative stale/missing-confirmation cases if the frozen contract supports them.
- [ ] Run backend typecheck, focused disposable suites, MCP/plugin tests and validator, and frontend checks required by the repository before completion.
- [ ] Update the newest changelog version with the feature summary, then review the final diff and commit all feature/docs/tests together.
