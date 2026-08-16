# Loan Agents, Commission Attribution, and Detail Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add optional multi-agent commission contracts, post-payment source attribution, MCP/REST commands, and four localized Loan Detail tabs without mutating posted financial history.

**Architecture:** Keep `loan_intermediary_assignments` as the effective-dated source of current agent relationships, add a separate append-only commission-participant ledger for rates, and add a separate append-only payment-attribution ledger for payment sources. Backend services own Decimal calculations and authorization; REST and MCP expose the same command services; the frontend composes Information, Agents, Payment History, and Repayment Schedule tabs from authoritative endpoints.

**Tech Stack:** Bun, Elysia, Drizzle/PostgreSQL, `decimal.js` via `FinancialDecimal`, React/Vite, React Testing Library/Vitest, i18next, MCP closed Zod contracts.

## Global Constraints

- Money crosses public interfaces as two-decimal decimal strings and all financial calculations use `FinancialDecimal`; never use JavaScript floating point.
- Agent percentages are exact decimal strings, bounded from 0 to 100, and active overlapping participant rates per loan cannot exceed 100%.
- Posted financial records are immutable; changes use append-only compensating records with a reason, actor, correlation ID, idempotency key where supported, and audit history.
- A loan can be activated and paid without an agent or payment source attribution.
- Payment source attribution is independent from commission eligibility and is never inferred automatically from a loan assignment.
- Tenant isolation and existing owner/manager access filters apply to every read and write.
- Use `Asia/Bangkok` for business dates and ISO timestamps; keep English/Thai locale keys synchronized.
- Every commit updates `CHANGELOG.md`; user-facing workflow changes also update `README.md`.

---

### Task 1: Commission participant and payment attribution data model

**Files:**
- Create: `backend/drizzle/0039_loan_agents_commission_attribution.sql`
- Modify: `backend/src/db/schema.ts`
- Create: `backend/src/services/loan-commission-service.ts`
- Create: `backend/src/services/payment-attribution-service.ts`
- Test: `backend/src/services/loan-commission-service.test.ts`
- Test: `backend/src/services/payment-attribution-service.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces `listLoanCommissionParticipants(ctx, loanPublicId)`, `addLoanCommissionParticipant(ctx, input)`, `updateLoanCommissionParticipant(ctx, input)`, `endLoanCommissionParticipant(ctx, input)`, and `previewLoanCommission(ctx, input)`.
- Produces `createPaymentAttribution(ctx, input)`, `listPaymentAttributions(ctx, paymentPublicId)`, and `reversePaymentAttribution(ctx, input)`.
- Later tasks consume public UUIDs, exact money/rate strings, audit public IDs, and stable domain error codes.

- [ ] **Step 1: Write failing database tests for participant versions.**

  Seed two tenants, one loan, and two intermediaries. Assert adding two participants at 30.00% and 20.00% succeeds, adding an overlapping rate that would exceed 100.00% returns a 409 domain error, a foreign-tenant intermediary/loan is rejected, and update/end preserve the old row while appending a new effective-dated row.

- [ ] **Step 2: Write failing tests for exact commission preview.**

  Seed posted payments with interest components `200.25` and `99.75`, then assert a 30.00% participant receives `90.00`, principal/fee/penalty components do not contribute, and reversal input produces a compensating negative preview rather than changing the original result.

- [ ] **Step 3: Write failing tests for payment attribution.**

  Assert one payment can be attributed to direct payment, intermediary A, and intermediary B with exact amounts summing to the payment amount; a split over the payment amount fails; duplicate idempotency replays the same result; foreign records fail; and reversal appends a compensating attribution with a required reason.

- [ ] **Step 4: Add schema and migration.**

  Add `loan_commission_participants` with tenant/loan/intermediary foreign keys, public UUID, exact numeric rate, role/note, effective dates, status, idempotency key, actor metadata, and audit-safe constraints/indexes. Add `payment_intermediary_attributions` with tenant/payment/transaction/intermediary nullable references, exact attributed amount, source kind (`direct` or `intermediary`), reason, reversal linkage, idempotency, and immutable-posting guards. Do not add mutable agent columns to `loans` or `transactions`.

- [ ] **Step 5: Implement Decimal-only service operations.**

  Use row locks and tenant-scoped queries for overlap validation. Calculate commission as `interestComponent × rate / 100` with `FinancialDecimal`; serialize every amount/rate with the existing exact money formatter. Use append-only reversal rows and audit context for every mutation.

- [ ] **Step 6: Run focused disposable tests and typecheck.**

  Run `backend/scripts/test-disposable-postgres.sh src/services/loan-commission-service.test.ts src/services/payment-attribution-service.test.ts` and `cd backend && bun run typecheck`. Expected: all new database cases pass and no type errors.

- [ ] **Step 7: Commit.**

  Update `CHANGELOG.md`, then commit schema, migration, services, and tests as `feat: add loan commission and payment attribution ledgers`.

### Task 2: REST and MCP command contracts

**Files:**
- Modify: `backend/src/modules/loan-contract-routes.ts`
- Modify: `backend/src/modules/intermediary-routes.ts`
- Modify: `backend/src/mcp/server.ts`
- Modify: `backend/src/mcp/default.ts`
- Test: `backend/src/modules/loan-agent-routes.test.ts`
- Test: `backend/src/mcp/loan-agent-tools.test.ts`
- Modify: `backend/src/mcp/evals/*` and frozen contract fixtures as required
- Modify: `CHANGELOG.md`

**Interfaces:**
- REST exposes tenant-authorized loan participant list/add/update/end, commission preview/list, payment attribution list/create/reverse, and Loan Detail summary fields.
- MCP adds closed schemas for `loan.commission-participant.list/add/update/end`, `loan.commission.preview/list/calculate/reverse`, and `payment.intermediary-attribution.create/list/reverse`.
- All writes return public audit ID and correlation ID; destructive operations require explicit confirmation.

- [ ] **Step 1: Add RED route and MCP contract tests.**

  Assert unauthorized loan access returns the existing stable error, every money/rate field is a string, schemas reject unknown keys, missing confirmation/reason/idempotency fails closed, and tool outputs validate against the frozen contract.

- [ ] **Step 2: Implement REST handlers through the services from Task 1.**

  Resolve public UUIDs to tenant-owned internal IDs, preserve existing access filters, pass actor/request/correlation context, and never calculate commission in route code.

- [ ] **Step 3: Register MCP input/output schemas and adapter dispatch.**

  Add tool names to the closed tool registry, Zod input/output schemas, default adapter mappings, read-only/destructive annotations, and human-readable summaries. Ensure `update` uses end-old-plus-create-new semantics.

- [ ] **Step 4: Add eval scenarios.**

  Cover no-agent activation, adding an agent after payment, two agents with split rates, direct payment attribution, multi-source attribution, exact commission preview, duplicate idempotency replay, and compensating reversal.

- [ ] **Step 5: Run backend route/MCP gates.**

  Run the focused route/MCP tests, plugin validator/evals, disposable PostgreSQL suite for changed tests, and backend typecheck. Expected: all schemas remain synchronized and no frozen contract drift remains.

- [ ] **Step 6: Commit.**

  Update `CHANGELOG.md`, then commit as `feat: expose loan agent and attribution commands`.

### Task 3: Loan Detail tabbed frontend and Loan List agent display

**Files:**
- Modify: `frontend/src/pages/dashboard/loans/LoanDetail.tsx`
- Create: `frontend/src/pages/dashboard/loans/LoanDetailTabs.tsx`
- Create: `frontend/src/pages/dashboard/loans/LoanAgentsTab.tsx`
- Create: `frontend/src/pages/dashboard/loans/LoanPaymentHistoryTab.tsx`
- Create: `frontend/src/pages/dashboard/loans/LoanInformationTab.tsx`
- Create: `frontend/src/pages/dashboard/loans/LoanRepaymentScheduleTab.tsx`
- Modify: `frontend/src/pages/dashboard/loans/LoanList.tsx`
- Modify: `frontend/src/locales/en.json`
- Modify: `frontend/src/locales/th.json`
- Test: `frontend/tests/loan-detail-tabs.vitest.tsx`
- Test: `frontend/tests/loan-agents-tab.vitest.tsx`
- Test: `frontend/tests/loan-payment-attribution.vitest.tsx`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Information is the default tab; tab state remains on the existing loan route and loads only the selected tab's data.
- Agents consumes participant versions and exposes add/update/end actions with confirmation and exact rate validation.
- Payment History consumes posted payments, attribution records, and commission summaries; it shows `Unattributed` until explicitly assigned.
- Repayment Schedule consumes the existing authoritative schedule and adds commission generated from collected interest.

- [ ] **Step 1: Add RED tests for tab behavior.**

  Assert Information is selected by default, each tab has stable accessible labels, tab-specific loading/empty/error states render, changing tabs preserves the route, and no unrelated fetch occurs.

- [ ] **Step 2: Add RED tests for agent and attribution states.**

  Assert no-agent empty state, multiple participant rows with rates and totals, add/update/end validation, direct payment, one-agent payment, multi-agent split, and unattributed payment rendering in both locales.

- [ ] **Step 3: Implement tab shell and information tab.**

  Extract existing Loan Detail sections without changing financial calculations; keep current back navigation, status, funding, payout, and exact money formatting.

- [ ] **Step 4: Implement Agents tab.**

  Render the participant table, total percentage, effective dates, active/ended states, and explicit add/update/end actions. Use controlled forms and backend validation errors; never infer a participant from payment source.

- [ ] **Step 5: Implement Payment History and schedule additions.**

  Render attribution chips and exact split amounts, provide an explicit attribution editor with direct-payment option, show commission per payment, and add commission columns to the existing repayment schedule without duplicating schedule calculations.

- [ ] **Step 6: Add Loan List agent summary/search.**

  Extend the existing loan DTO/view model with current agent name/alias, display a compact `Agent` badge on cards including overdue cards, and include confirmed agent names/aliases in search. Missing assignment renders `Unassigned`.

- [ ] **Step 7: Update locales, README, and focused frontend tests.**

  Keep English/Thai keys in parity. Run `cd frontend && bun test`, `bun run lint`, and `bun run build`.

- [ ] **Step 8: Commit.**

  Update `CHANGELOG.md`, then commit as `feat: add loan detail agents and payment attribution tabs`.

### Task 4: Integration verification and handoff

**Files:**
- Modify: `.superpowers/sdd/2026-08-16-loan-agents-commission-tabs/progress.md`
- Modify: `CHANGELOG.md` only if verification documentation needs a release note

- [ ] **Step 1: Inspect the complete diff and generated migration lineage.**

  Confirm no posted financial row is mutable, no raw identity/payment evidence is logged, all public money/rate fields are decimal strings, and no unrelated dirty files are staged.

- [ ] **Step 2: Run all verification gates.**

  Run backend disposable tests serially, backend typecheck, frontend full tests/lint/build, MCP/plugin tests and validator, and `git diff --check`.

- [ ] **Step 3: Perform final review.**

  Review tenant isolation, commission percentage overlap, exact rounding, attribution sum/reversal behavior, MCP closed schemas, tab accessibility, locale parity, and preserved existing payment/funding behavior.

- [ ] **Step 4: Record handoff.**

  Record commits, test outputs, known environment limitations, and whether merge/deploy is authorized. Do not merge, push, or deploy without explicit user authorization.
