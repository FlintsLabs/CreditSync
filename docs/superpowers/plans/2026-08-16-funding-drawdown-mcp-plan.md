# Funding Drawdown and Loan Allocation MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Decimal-safe REST and MCP workflows for creating a bank funding drawdown, generating its liability schedule, and allocating it to an existing borrower loan atomically when requested.

**Architecture:** Extract bank-drawdown and funding-allocation application services from the existing REST routes. Add draft/active drawdown lifecycle and command idempotency metadata, then expose closed MCP tools that call those services. Keep bank liability, loan funding allocation, and actual borrower disbursement as separate ledgers; use a composite command only for the explicit drawdown-plus-allocation transaction.

**Tech Stack:** Bun, TypeScript, Elysia, Drizzle ORM, PostgreSQL, `decimal.js`/`FinancialDecimal`, MCP SDK, Vitest.

## Global Constraints

- Money crossing public interfaces is a two-decimal decimal string; do not use JavaScript floating point for financial values.
- Use `Asia/Bangkok` business timezone, ISO timestamps, and `YYYY-MM-DD` dates.
- Active loan terms and posted financial records are immutable; corrections are append-only compensating records.
- Every financial write carries actor/source, request/correlation ID, idempotency key where supported, and audit history.
- Funding allocation never changes borrower loan principal, interest, schedule, or actual disbursement history.
- Preserve unrelated dirty files: `frontend/src/locales/th.json` and `tha.traineddata` are user-owned and out of scope.
- Before any commit, update `CHANGELOG.md` in the same commit.

---

### Task 1: Introduce Decimal bank-loan schedule primitives

**Files:**
- Modify: `backend/src/lib/bank-loan-schedule.ts`
- Create: `backend/src/lib/bank-loan-schedule.test.ts`
- Inspect: `backend/src/lib/financial-decimal.ts`, `backend/src/lib/money.ts`

**Interfaces:**
- Consumes: `amount`, `interestRate`, `startDate`, `termMonths`, `repaymentCycle`, `totalInstallments`, `installmentAmount`, and fee/rate strings from bank-loan service input.
- Produces: `generateBankLoanSchedule(input: BankLoanScheduleInput): BankLoanScheduleRow[]` where all money fields are strings and the final row exactly clears principal.

- [ ] **Step 1: Write failing schedule tests**

Add tests for monthly 36,000.00 at 25.00% annual rate for 10 installments, explicit fixed installment, zero-interest division, fee/VAT components, daily-cycle installment inference, and final-principal rounding. Assert exact string fields rather than approximate JavaScript numbers.

- [ ] **Step 2: Run the focused test and verify failure**

Run: `cd backend && bun test src/lib/bank-loan-schedule.test.ts`

Expected: the new Decimal contract tests fail because the current generator accepts numeric inputs and calculates with `Number`.

- [ ] **Step 3: Replace numeric calculation with `FinancialDecimal`**

Change the generator input money/rate fields to strings, calculate periodic rates with `FinancialDecimal`, serialize each component with the project rounding policy, and force the final principal component to the exact remaining balance. Keep date stepping in `dayjs`; do not use `Number` for money.

- [ ] **Step 4: Update direct callers and rerun focused tests**

Adapt the bank-loan REST route and any tests that call the generator to pass serialized strings. Run: `cd backend && bun test src/lib/bank-loan-schedule.test.ts src/modules/bank-loans.test.ts`

Expected: all focused schedule and existing bank-loan route tests pass with no floating-point financial values in the generator.

- [ ] **Step 5: Commit the calculation boundary**

Update `CHANGELOG.md` under the active version with a `### Fixed` entry, then run:

```bash
git add CHANGELOG.md backend/src/lib/bank-loan-schedule.ts backend/src/lib/bank-loan-schedule.test.ts
git commit -m "fix: calculate bank loan schedules with Decimal"
```

### Task 2: Add bank-drawdown command service and lifecycle metadata

**Files:**
- Modify: `backend/src/db/schema.ts`
- Create: `backend/drizzle/0040_bank_drawdown_command_hardening.sql`
- Create: `backend/src/db/bank-drawdown-migration.test.ts`
- Create: `backend/src/services/bank-loan-service.ts`
- Create: `backend/src/services/bank-loan-service.test.ts`
- Inspect: `backend/src/services/command-context.ts`, `backend/src/lib/audit-log.ts`, `backend/src/modules/bank-loans.ts`

**Interfaces:**
- Consumes: tenant-scoped `CommandContext`, active `bank_profiles`, Decimal schedule input, and idempotency metadata.
- Produces:

```ts
previewBankDrawdown(ctx, input): Promise<BankDrawdownPreview>
createBankDrawdownDraft(ctx, input): Promise<BankDrawdownDraft>
activateBankDrawdown(ctx, input): Promise<BankDrawdownActivationResult>
```

- [ ] **Step 1: Write migration and service contract tests first**

Cover the new `draft` status, tenant-scoped idempotency uniqueness, required request/correlation/actor fields, inactive-profile rejection, credit-limit rejection, same-payload idempotent replay, conflicting-key rejection, and activation schedule creation.

- [ ] **Step 2: Run focused tests to establish the failing state**

Run: `cd backend && bun test src/db/bank-drawdown-migration.test.ts src/services/bank-loan-service.test.ts`

Expected: failures identify the missing migration columns, service exports, and lifecycle behavior.

- [ ] **Step 3: Add the guarded migration and schema declarations**

Add `draft` support, tenant-scoped `idempotency_key`, `request_id`, `correlation_id`, `created_by_user_id`, and `updated_by_user_id` fields/constraints needed by the service. Preserve existing rows and do not infer historical relationships. Add indexes for profile/status and idempotency lookup.

- [ ] **Step 4: Implement Decimal-normalized preview**

Validate the funding profile, amount, annual rate, date, term, cycle, fees, and repayment mode. Generate the exact schedule through Task 1 and return summary totals, first/last due dates, and schedule rows without persistence.

- [ ] **Step 5: Implement idempotent draft creation**

Lock the profile and idempotency key, reject an inactive profile or credit-limit overflow, insert a `draft` bank loan with audit context, and return the existing draft on an identical retry. Reject the same key when the payload hash differs.

- [ ] **Step 6: Implement explicit activation**

Lock the draft, revalidate its profile and terms, generate immutable `bank_loan_schedules`, update status to `active`, set outstanding balances and `nextDueDate`, and write an activation audit event. Replays with the same activation idempotency key must return the existing active result.

- [ ] **Step 7: Run focused service and migration tests**

Run: `cd backend && bun test src/db/bank-drawdown-migration.test.ts src/services/bank-loan-service.test.ts src/lib/bank-loan-schedule.test.ts`

Expected: migration and service tests pass, including exact Decimal totals and idempotent lifecycle behavior.

- [ ] **Step 8: Commit the bank-drawdown service**

Update `CHANGELOG.md` with the new draft/activate funding workflow, then commit the migration, schema, service, and tests together.

### Task 3: Extract and implement funding-allocation service

**Files:**
- Create: `backend/src/services/loan-funding-service.ts`
- Create: `backend/src/services/loan-funding-service.test.ts`
- Modify: `backend/src/modules/loan-funding-routes.ts`
- Modify: `backend/src/modules/loan-funding-presenters.ts`
- Inspect: `backend/src/db/schema.ts`, `backend/src/lib/access.ts`, `backend/src/services/domain-error.ts`

**Interfaces:**
- Consumes: active bank drawdown/profile public IDs, active borrower loan public ID, allocation amount/date, note, and idempotency key.
- Produces:

```ts
previewFundingAllocation(ctx, input): Promise<FundingAllocationPreview>
createFundingAllocation(ctx, input): Promise<FundingAllocationResult>
listLoanFundingAllocations(ctx, loanPublicId): Promise<FundingAllocationView[]>
```

- [ ] **Step 1: Add failing allocation invariant tests**

Test successful exact allocation, profile-only allocation, drawdown allocation, inactive source rejection, cross-tenant rejection, allocation above drawdown remainder, allocation above loan unfunded principal, immutable loan rejection, idempotent replay, and stable lock ordering under concurrent attempts.

- [ ] **Step 2: Run the focused test file**

Run: `cd backend && bun test src/services/loan-funding-service.test.ts`

Expected: failures identify missing service methods and invariant enforcement.

- [ ] **Step 3: Move route business rules into the service**

Implement tenant/role checks, profile/drawdown resolution, remaining capacity calculation with `FinancialDecimal`, stable row locks, append-only allocation insertion, and audit creation. Keep REST handlers as request validation and response adapters.

- [ ] **Step 4: Add explicit allocation preview**

Return source profile/drawdown, target loan, requested amount, remaining capacities, resulting funding state, and warnings without inserting an allocation. Reject invalid targets before preview persistence if the existing API pattern does not require a persisted preview.

- [ ] **Step 5: Update REST route delegation and tests**

Change `loan-funding-routes.ts` to call the service and retain existing endpoint shapes where compatible. Add route regression coverage for the TTB So fast to 36,000.00 allocation case.

- [ ] **Step 6: Run allocation and existing funding tests**

Run: `cd backend && bun test src/services/loan-funding-service.test.ts src/modules/bank-profiles.test.ts src/services/funding-source-service.test.ts`

Expected: all allocation invariants pass and existing funding-source read projections remain unchanged.

- [ ] **Step 7: Commit the allocation service**

Record the append-only funding-allocation service in `CHANGELOG.md`, then commit the service, route delegation, presenter updates, and tests.

### Task 4: Add REST drawdown lifecycle and atomic composite command

**Files:**
- Modify: `backend/src/modules/bank-loans.ts`
- Modify: `backend/src/modules/loan-funding-routes.ts`
- Create: `backend/src/modules/funding-drawdown-routes.ts`
- Modify: `backend/src/index.ts`
- Create: `backend/src/modules/funding-drawdown-routes.test.ts`

**Interfaces:**
- Consumes: Task 2 bank-loan service and Task 3 funding-allocation service.
- Produces REST endpoints:

```text
POST /bank-loans/preview
POST /bank-loans/drafts
POST /bank-loans/:id/activate
POST /loans/:id/funding-allocations/preview
POST /loans/:id/funding-allocations
POST /funding-source/drawdown-and-allocate
```

- [ ] **Step 1: Write route contract tests**

Cover closed body validation, string money fields, tenant-admin authorization, preview response shape, draft/activation response shape, composite success, and composite rollback when allocation cannot consume the requested amount.

- [ ] **Step 2: Run route tests before implementation**

Run: `cd backend && bun test src/modules/funding-drawdown-routes.test.ts`

Expected: new endpoint tests fail because routes and service wiring are absent.

- [ ] **Step 3: Add REST request/response schemas**

Use strict schemas with decimal strings, ISO dates, bounded positive integers, explicit repayment cycle/mode, and idempotency key. Do not expose raw database IDs or accept JavaScript numeric money for new command fields.

- [ ] **Step 4: Delegate individual lifecycle routes**

Wire preview, draft, activation, and allocation preview/create routes to the services. Map `DomainError` values to existing project HTTP responses without logging sensitive payloads.

- [ ] **Step 5: Implement the composite transaction route**

Resolve the funding profile and loan, lock in stable order, create/activate the drawdown, validate allocation, insert the allocation, write both audit events plus a correlation ID, and return both public records. Roll back all writes on any failure.

- [ ] **Step 6: Run REST verification**

Run: `cd backend && bun test src/modules/funding-drawdown-routes.test.ts src/modules/bank-loans.test.ts src/modules/bank-profiles.test.ts`

Expected: all new and existing REST tests pass without changing borrower loan schedule semantics.

- [ ] **Step 7: Commit the REST surface**

Update `CHANGELOG.md` with the REST lifecycle/composite endpoint entry and commit the route changes and tests.

### Task 5: Add MCP funding drawdown and allocation tools

**Files:**
- Modify: `backend/src/mcp/server.ts`
- Modify: `backend/src/mcp/default.ts`
- Modify: `backend/src/mcp/default.test.ts`
- Modify: `backend/src/mcp/server.test.ts`
- Create: `backend/src/mcp/funding-drawdown-tools.test.ts`

**Interfaces:**
- Consumes: Task 2/3 service operations and Task 4 response presenters.
- Produces tools:

```text
funding-source.get
funding-source.drawdown.get
funding-source.drawdown.schedule
funding-source.drawdown.preview
funding-source.drawdown.draft
funding-source.drawdown.activate
loan.funding-allocation.list
loan.funding-allocation.preview
loan.funding-allocation.create
funding-source.drawdown-and-allocate
```

- [ ] **Step 1: Add failing MCP registry and schema tests**

Assert every new tool is present in `MCP_TOOL_NAMES`, descriptions, input/output schemas, handler map, destructive annotation map, and structured-output adapter. Assert all schemas are strict and all money values are decimal strings.

- [ ] **Step 2: Run MCP focused tests to verify failure**

Run: `cd backend && bun test src/mcp/funding-drawdown-tools.test.ts src/mcp/server.test.ts src/mcp/default.test.ts`

Expected: failures identify missing registry entries, schemas, and handlers.

- [ ] **Step 3: Add read-only tool schemas and handlers**

Implement profile/drawdown/schedule/allocation reads using public UUIDs and safe fields. Mark them with `readOnlyHint` and omit raw account identifiers, credentials, and internal IDs.

- [ ] **Step 4: Add preview tool schemas and handlers**

Return exact terms, schedule summary, capacities, and warnings without posting financial records. Require explicit public IDs and reject fuzzy borrower/profile resolution.

- [ ] **Step 5: Add destructive draft/activate/allocation handlers**

Require idempotency keys, route through the services, and return public IDs, audit public IDs, correlation ID, status, and safe summaries. Mark activation/allocation/composite tools destructive.

- [ ] **Step 6: Add composite handler and replay tests**

Test the TTB So fast case with amount `"36000.00"`, rate `"25.00"`, term `10`, and target loan public ID. Verify one successful retry returns the same records and a changed payload with the same key is rejected.

- [ ] **Step 7: Run MCP verification**

Run: `cd backend && bun test src/mcp/funding-drawdown-tools.test.ts src/mcp/server.test.ts src/mcp/default.test.ts src/mcp/security.test.ts`

Expected: all MCP contract, security, structured-output, annotation, and idempotency tests pass.

- [ ] **Step 8: Commit the MCP contract**

Update `CHANGELOG.md` and the frozen plugin contract metadata required by the repository, then commit the MCP registry, handlers, schemas, and tests together.

### Task 6: Synchronize plugin skills, evals, and documentation

**Files:**
- Modify: the private CreditSync plugin manifest and frozen contract files identified by the repository validator
- Modify: the funding workflow skill and relevant agent instructions
- Modify: plugin evaluation scenarios and validator fixtures
- Modify: `README.md` if setup/API/MCP usage is documented there
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: the final MCP tool names, schemas, annotations, and output contracts from Task 5.
- Produces: synchronized plugin version/manifest, skill workflow, eval scenarios, validator fixtures, and user-facing API documentation.

- [ ] **Step 1: Locate contract synchronization files with repository search**

Run: `rg -n "MCP_TOOL_NAMES|funding-source.list|plugin.*7.0.0|eleven skills|validator|eval" . --glob '!node_modules/**' --glob '!frontend/dist/**'`

Record every file that must change; do not invent a second contract source.

- [ ] **Step 2: Add the funding workflow skill scenario**

Document inspect profile -> inspect loan -> preview -> explicit confirmation -> create/activate drawdown -> preview allocation -> allocate -> verify funding state. State that actual borrower disbursement is separate and that ambiguous profile/loan/date/amount stops the workflow.

- [ ] **Step 3: Add positive and negative eval fixtures**

Cover the TTB So fast 36,000.00 allocation, inactive profile, over-limit drawdown, allocation over unfunded principal, duplicate idempotency conflict, and attempted use of a borrower disbursement tool as a bank drawdown.

- [ ] **Step 4: Run the contract validator and plugin tests**

Run the repository's documented plugin validator and tests, plus `cd backend && bun test src/mcp/default.test.ts src/mcp/server.test.ts`.

Expected: tool count, schemas, annotations, skill references, eval fixtures, and validator output are synchronized.

- [ ] **Step 5: Update README and changelog where behavior is user-facing**

Document the separation between bank drawdown, funding allocation, and actual borrower disbursement, plus the example command fields and required confirmation. Update `CHANGELOG.md` under the correct version/change type.

- [ ] **Step 6: Commit synchronization artifacts**

Commit only the contract, skill, eval, validator, README, and changelog files that describe this feature.

### Task 7: Run full verification and perform independent financial review

**Files:**
- Inspect all feature diffs from Tasks 1-6
- Modify only files required by verification findings

**Interfaces:**
- Consumes: final implementation branch and all prior focused test results.
- Produces: verified branch with no unexplained tracked changes and evidence for every required gate.

- [ ] **Step 1: Check worktree ownership and diff scope**

Run: `git status --short` and `git diff --stat`. Confirm unrelated `frontend/src/locales/th.json` and `tha.traineddata` remain untouched.

- [ ] **Step 2: Run backend disposable PostgreSQL tests**

Run: `backend/scripts/test-disposable-postgres.sh`

Expected: database-backed suites pass without skipped tests covering the new funding invariants.

- [ ] **Step 3: Run backend typecheck and focused financial tests**

Run the repository's Bun typecheck command and the full bank-loan, funding, loan-application, and MCP test groups. Confirm Decimal schedule totals for the 36,000.00/25.00%/10-month case.

- [ ] **Step 4: Run frontend and plugin gates**

Run the repository's frontend test/lint/build commands and the plugin tests/validator required by Task 6.

- [ ] **Step 5: Review database and MCP contracts manually**

Verify draft/active constraints, tenant foreign keys, idempotency uniqueness, audit payload safety, strict MCP schemas, destructive annotations, and that no actual disbursement was created by drawdown/allocation commands.

- [ ] **Step 6: Record final verification and commit any fixes**

If a verification fix changes behavior, update `CHANGELOG.md` in the same commit. Re-run the affected gate and record exact commands/results in the handoff.

