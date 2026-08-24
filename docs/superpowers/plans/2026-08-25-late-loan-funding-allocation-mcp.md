# Late Loan Funding Allocation MCP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the existing audited loan funding-allocation service through MCP so an active, non-terminal loan can be funded after activation before disbursement is posted.

**Architecture:** Reuse `loan-funding-service.ts`, which already validates tenant access, active funding sources, capacity, idempotency, and audit logging. Add closed MCP tools for funding preview, allocation creation, and allocation listing; preserve the existing REST behavior and keep the loan contract immutable while recording append-only funding allocation rows.

**Tech Stack:** Bun, TypeScript, Elysia, Zod, Drizzle, MCP server, Vitest.

**Spec:** This plan implements the user-approved requirement to add a funding source after loan activation when no terminal state or posted disbursement prevents the allocation.

## Global Constraints

- Money is represented as two-decimal strings and calculated with `FinancialDecimal`.
- Funding writes require tenant authorization, idempotency, correlation/request context, and append-only audit history.
- Funding changes remain blocked for renewed/canceled/terminal loans through the existing `isMutableFundingLoan` guard.
- MCP tool schemas are closed and public identifiers are UUIDs.
- Do not post or alter the user's pending disbursement as part of this code change; only add the funding allocation capability and then use it explicitly.

---

### Task 1: Add failing MCP funding-allocation tests

**Files:**
- Modify: `backend/src/mcp/default.test.ts`
- Modify: `backend/src/mcp/server.test.ts` only if tool schema registration needs a contract assertion

**Interfaces:**
- Consumes: Existing `previewFundingAllocation`, `createFundingAllocation`, and `listLoanFundingAllocations` service functions.
- Produces: Tests proving MCP can preview a post-activation allocation, create it idempotently, and list the resulting row with audit metadata.

- [x] **Step 1: Write the failing tests** for `funding-allocation.preview`, `funding-allocation.create`, and `funding-allocation.list` using an active loan with no allocation and an active bank profile.
- [ ] **Step 2: Run the focused MCP test file and confirm failure because the MCP tools are not registered.
- [ ] **Step 3: Add assertions that a second create with the same idempotency key returns the same public allocation and does not create a second row.

### Task 2: Expose funding allocation operations through MCP

**Files:**
- Modify: `backend/src/mcp/server.ts`
- Modify: `backend/src/mcp/default.ts`
- Modify: `backend/src/mcp/default.test.ts`

**Interfaces:**
- `funding-allocation.preview`: `{ loanPublicId, bankProfilePublicId?, bankLoanPublicId?, allocatedAmount, allocationDate, allocationType?, note? }` -> preview with source, target, requested amount, resulting funding, warnings.
- `funding-allocation.create`: same allocation input, with MCP context idempotency key -> allocation row plus `auditPublicId` and `correlationId`.
- `funding-allocation.list`: `{ loanPublicId }` -> public allocation rows.

- [x] **Step 1: Add the three names to `MCP_TOOL_NAMES` and closed Zod input/output schemas.
- [ ] **Step 2: Import the existing funding service functions and register handlers in `default.ts`.
- [ ] **Step 3: Mark preview/list read-only and create destructive in the MCP tool metadata following existing conventions.
- [ ] **Step 4: Run the focused tests and confirm all new MCP tests pass.

### Task 3: Verify and apply the requested current-loan funding allocation

**Files:**
- No source files beyond the MCP implementation above.

**Interfaces:**
- Consumes: The new `funding-allocation.preview` and `funding-allocation.create` MCP tools.
- Produces: An append-only 3,000.00 allocation from funding profile `019fea1f-d335-70d0-966e-5000a7c5c7eb` to loan `01a03543-1533-7918-9f96-d059d7d33b77`.

- [ ] **Step 1: Preview the exact 3,000.00 allocation dated `2026-08-24`.
- [ ] **Step 2: Create it with a unique idempotency key and verify the audit/correlation IDs.
- [ ] **Step 3: Re-list the allocation and confirm the loan is fully funded without posting the pending intermediary disbursement.

### Task 4: Run verification and document handoff

**Files:**
- Modify: `CHANGELOG.md` only if a commit is requested; no commit is created by default.
- Modify: `README.md` only if the new MCP tools change user-facing setup or documented workflows.

- [ ] **Step 1: Run the focused MCP tests.
- [ ] **Step 2: Run backend typecheck and relevant backend tests.
- [ ] **Step 3: Inspect the final diff and git status; report exactly what was changed and what remains unposted.
