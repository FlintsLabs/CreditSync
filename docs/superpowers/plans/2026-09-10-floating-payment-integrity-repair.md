# Floating Payment Integrity Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make floating-payment allocation mismatches detectable, repairable with an auditable append-only workflow, and operationally documented for future agents.

**Architecture:** Keep immutable posted payments and allocations unchanged. Detect active allocation overfill and post-order anomalies with a reusable Decimal-based checker, block new floating posts on corrupted provenance, and repair confirmed cases by reversing and reposting complete grouped batches in business-date order with stable idempotency. Store the operational decision rules in `AGENTS.md` and verify production before and after deployment.

**Tech Stack:** Bun, TypeScript, Elysia services, Drizzle/PostgreSQL, decimal.js, Docker Compose.

**Spec:** `AGENTS.md` Product and Financial Domain Rules, Lending Workflows, MCP and Plugin Safety, and Verification and Deployment sections.

## Global Constraints

- Use `decimal.js`/`FinancialDecimal` for all money calculations and two-decimal strings.
- Use `Asia/Bangkok` business dates and retain ISO timestamps.
- Posted financial records are immutable; repair only through compensating reversal/replacement records.
- Require inspect → preview → explicit confirmation → post for financial writes.
- Use tenant-scoped command context, correlation/request IDs, idempotency keys, and audit logs.
- Do not log raw slip contents, QR payloads, account numbers, or unmasked identity values.
- Do not deploy until the relevant tests, production scan, health check, and post-deploy scan pass.

### Task 1: Preserve the existing repair and add integrity regression coverage

**Files:**
- Modify: `backend/src/lib/floating-allocation-integrity.ts`
- Test: `backend/src/lib/floating-allocation-integrity.test.ts`
- Modify: `backend/src/services/payment-service.ts`

**Interfaces:**
- `findFloatingAllocationIssues` reports only active allocation overfill/after-fill and reversed-accrual targets; advance-period due dates are not treated as corruption.
- `postPayment` rejects a new floating post when the selected loan has non-empty integrity issues.

- [ ] **Step 1: Write and run the failing regression test**

Run `bun test backend/src/lib/floating-allocation-integrity.test.ts` after asserting that an allocation after an already-filled accrual is reported.

- [ ] **Step 2: Implement the minimal checker and post guard**

Use signed Decimal totals, ignore payment allocations compensated by a reversal, and return a 409 repair-required error before inserting a new payment transaction.

- [ ] **Step 3: Run focused and type checks**

Run `bun test backend/src/lib/floating-allocation-integrity.test.ts` and `bun run --cwd backend typecheck`; expect zero failures and zero TypeScript errors.

### Task 2: Add repeatable inspect, repair, and verification scripts

**Files:**
- Create: `backend/scripts/check-floating-allocation-integrity.ts`
- Create: `backend/scripts/repair-floating-payment-batch.ts`
- Create: `backend/scripts/verify-floating-payment-repair.ts`

**Interfaces:**
- Checker scans every floating loan and emits redacted public IDs, issue codes, dates, and decimal amounts; default behavior is read-only.
- Repair accepts `TARGET_PAYMENT_INTAKE_PUBLIC_ID`, `PRECEDING_PAYMENT_INTAKE_PUBLIC_ID`, and `EXECUTE_REPAIR=yes`; it verifies grouped interest-only batches, reverses older business-date batch first, reposts in date order, and resumes idempotently after a partial operational retry.
- Verifier reads payment health at a fixed audit date and emits only public loan IDs and health fields.

- [ ] **Step 1: Run checker against production before deployment**

Use the production database connection through the host-mapped PostgreSQL container without printing credentials; record affected-loan and issue counts.

- [ ] **Step 2: Run repair only for an explicitly confirmed mapping**

Execute the repair script with stable idempotency keys. Stop on ambiguous, non-interest-only, missing-accrual, downstream-reversal, or stale-state conditions.

- [ ] **Step 3: Run checker and verifier after repair**

Require zero integrity issues and health dates/amounts consistent with the repaired accrual provenance.

### Task 3: Document the agent operating procedure

**Files:**
- Modify: `AGENTS.md`
- Modify: `CHANGELOG.md`
- Modify: `README.md` if the operational workflow is user-facing

**Interfaces:**
- Agents must run the checker before any floating payment repair and must distinguish contractual advance-period due dates from allocation-to-wrong-accrual errors.
- Agents must repair grouped batches in business-date order, preserve old records, and verify all floating loans afterward.

- [ ] **Step 1: Add the exact runbook to `AGENTS.md`**

Document detection signals, the safe repair sequence, idempotent retry behavior, confirmation boundary, and required post-repair commands.

- [ ] **Step 2: Add a dated changelog entry**

Record the checker, guard, append-only repair workflow, and production verification under a new explicit version/date heading.

- [ ] **Step 3: Update README operational status**

Describe the floating allocation integrity checker and repair workflow without exposing production identifiers.

### Task 4: Full verification, integration, and deployment

**Files:**
- No additional source files; verify the complete staged tree.

**Interfaces:**
- Main branch must contain the tested feature commit.
- Production backend must run the committed source after Docker rebuild.

- [ ] **Step 1: Run required verification gates**

Run `bun run --cwd backend typecheck`, focused tests, backend disposable PostgreSQL tests, frontend test/lint/build, and plugin validator/tests applicable to changed contracts.

- [ ] **Step 2: Commit and merge**

Create a `codex/` feature branch, commit changelog with code/docs, merge into updated `main`, and verify the feature commit is an ancestor of `main`.

- [ ] **Step 3: Push and deploy**

Push `main` to `origin`, rebuild/restart the production backend/frontend using the documented Compose commands, and check MCP health from inside the backend container.

- [ ] **Step 4: Verify production after deployment**

Run the checker across all floating contracts, inspect backend logs, verify the target loan and one unaffected loan, and stop if any integrity issue or health mismatch remains.
