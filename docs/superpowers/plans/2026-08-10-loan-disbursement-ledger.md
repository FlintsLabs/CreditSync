# Loan Disbursement Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record multiple actual borrower payouts, including grouped transfers and optional evidence, without mutating the approved loan or repayment schedule.

**Architecture:** A new append-only `loan_disbursement_events` ledger is the source of truth for actual payout and variance. A service owns validation, evidence attachment, posting, reversal, and audit; REST, MCP, and Loan Detail use that service rather than direct database access.

**Tech Stack:** Bun, TypeScript, Elysia, Drizzle/PostgreSQL, decimal.js, MinIO signed uploads, MCP SDK/Zod, React/i18next.

## Global Constraints

- `grossAmount` is actual transfer/cash; `loanAttributedAmount` is the portion for this loan and may differ.
- Under/over disbursement is a warning only; it never changes principal, interest, schedules, or funding allocations.
- Money uses decimal strings and Decimal; posted records are never edited/deleted.
- Evidence is optional, tenant-scoped, finalized before posting, and linked by public UUID.
- Post/reverse require idempotency keys and write audit/correlation data.
- Update English and Thai locales together; each commit updates `CHANGELOG.md` and user-facing workflow commits update `README.md`.

---

### Task 1: Add an immutable disbursement-event schema

**Files:**
- Create: `backend/drizzle/0019_loan_disbursement_events.sql`
- Modify: `backend/drizzle/meta/_journal.json`, `backend/src/db/schema.ts`
- Create: `backend/src/db/loan-disbursement-migration.test.ts`

**Interfaces:** Produces `loanDisbursementEvents` with public UUID, tenant/loan, gross/attributed money, channel, source profile, payee, note, status, reversal relation, evidence file relation, actor and timestamps.

- [ ] **Step 1: Write migration contract tests**

```ts
expect(sql).toContain('CREATE TABLE "loan_disbursement_events"');
expect(sql).toContain('"gross_amount" numeric NOT NULL');
expect(sql).toContain('"loan_attributed_amount" numeric NOT NULL');
expect(journal.entries.at(-1)?.tag).toBe("0019_loan_disbursement_events");
```

- [ ] **Step 2: Run the test and observe failure**

Run: `cd backend && bun test src/db/loan-disbursement-migration.test.ts`

Expected: FAIL because migration and schema are absent.

- [ ] **Step 3: Add additive table/migration and Drizzle declaration**

```sql
CREATE TABLE "loan_disbursement_events" (
  "id" serial PRIMARY KEY, "public_id" uuid DEFAULT uuidv7() NOT NULL UNIQUE,
  "tenant_id" text NOT NULL, "loan_id" integer NOT NULL REFERENCES "loans"("id"),
  "gross_amount" numeric NOT NULL, "loan_attributed_amount" numeric NOT NULL,
  "channel" text NOT NULL, "status" text NOT NULL DEFAULT 'draft',
  "reversed_event_id" integer REFERENCES "loan_disbursement_events"("id"),
  "note" text, "disbursed_at" timestamp, "posted_at" timestamp, "reversed_at" timestamp,
  "created_by_user_id" integer REFERENCES "users"("id"), "created_at" timestamp DEFAULT now()
);
```

Add checks for channels `bank_transfer|cash|adjustment`, statuses `draft|posted|reversed`, non-negative money, and a tenant/loan/status index. Add a child evidence-link table keyed to a finalized `files` row, unique per event/file.

- [ ] **Step 4: Run migration/schema tests**

Run: `cd backend && bun test src/db/loan-disbursement-migration.test.ts && bun run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/drizzle/0019_loan_disbursement_events.sql backend/drizzle/meta/_journal.json backend/src/db/schema.ts backend/src/db/loan-disbursement-migration.test.ts CHANGELOG.md
git commit -m "feat: add loan disbursement ledger schema"
```

### Task 2: Implement the application service

**Files:**
- Create: `backend/src/services/loan-disbursement-service.ts`
- Create: `backend/src/services/loan-disbursement-service.test.ts`

**Interfaces:** Produces `listLoanDisbursements`, `createDisbursementDraft`, `updateDisbursementDraft`, `prepareDisbursementEvidence`, `finalizeDisbursementEvidence`, `postDisbursement`, and `reverseDisbursement`.

- [ ] **Step 1: Write failing unit/integration tests**

```ts
expect(summary).toMatchObject({ approvedPrincipal: "5000.00", netDisbursed: "5200.00", variance: "200.00", status: "over_disbursed" });
await expect(postDisbursement(ctx, draft.publicId)).resolves.toMatchObject({ status: "posted" });
await expect(updateDisbursementDraft(ctx, posted.publicId, { note: "x" })).rejects.toMatchObject({ code: "DISBURSEMENT_LOCKED" });
expect(await reverseDisbursement(ctx, posted.publicId, "wrong payout")).toMatchObject({ status: "reversed" });
```

- [ ] **Step 2: Run test and observe failure**

Run: `cd backend && bun test src/services/loan-disbursement-service.test.ts`

Expected: FAIL because service does not exist.

- [ ] **Step 3: Implement service boundaries**

Lock loan/event rows during post/reverse, verify actor tenant access, require note when gross differs from attributed, calculate net posted attributed amounts minus reversals, and append audit entries. Reuse the existing `files` signer/finalizer service; only finalized tenant-owned file public IDs can attach to a draft. Reversal returns its existing compensating result for the same idempotency key.

- [ ] **Step 4: Run focused service tests and typecheck**

Run: `cd backend && bun test src/services/loan-disbursement-service.test.ts && bun run typecheck`

Expected: PASS for cash, grouped transfer, under/matched/over, evidence retry, immutable post, tenant isolation, and idempotent reversal.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/loan-disbursement-service.ts backend/src/services/loan-disbursement-service.test.ts CHANGELOG.md
git commit -m "feat: manage loan disbursement events"
```

### Task 3: Expose REST and MCP adapters

**Files:**
- Modify: `backend/src/modules/loans.ts`, `backend/src/mcp/server.ts`, `backend/src/mcp/default.ts`
- Modify: `backend/src/mcp/server.test.ts`
- Create: `backend/src/modules/loan-disbursements.test.ts`

**Interfaces:** Adds `/loans/:id/disbursements` endpoints and MCP `loan.disbursement.list|draft|evidence.prepare|evidence.finalize|post|reverse`.

- [ ] **Step 1: Write failing adapter tests**

```ts
expect(await call("loan.disbursement.draft", input)).toMatchObject({ structuredContent: { status: "draft" } });
expect((await httpPost(`/loans/${loanId}/disbursements`, input)).status).toBe(200);
```

- [ ] **Step 2: Add closed TypeBox/Zod schemas and handlers**

Use public UUIDs, two-decimal money strings, `bank_transfer|cash|adjustment`, `grossAmount`, `loanAttributedAmount`, date/time, source profile, payee hint, note, evidence IDs, and idempotency key. Mark list read-only and post/reverse destructive; return audit public ID and correlation ID for writes.

- [ ] **Step 3: Run backend suite**

Run: `cd backend && bun test && bun run typecheck`

Expected: PASS, including malformed input and legacy loan workflows.

- [ ] **Step 4: Commit**

```bash
git add backend/src/modules/loans.ts backend/src/modules/loan-disbursements.test.ts backend/src/mcp/server.ts backend/src/mcp/default.ts backend/src/mcp/server.test.ts CHANGELOG.md
git commit -m "feat: expose loan disbursement workflows"
```

### Task 4: Loan-detail UI and daily-terms card

**Files:**
- Modify: `frontend/src/pages/dashboard/loans/LoanDetail.tsx`, `frontend/src/lib/api.ts`
- Modify: `frontend/src/locales/en.json`, `frontend/src/locales/th.json`, `README.md`
- Create: `frontend/tests/loan-disbursement-view.test.ts`

- [ ] **Step 1: Write view-model tests**

```ts
expect(formatDisbursementSummary({ approvedPrincipal: "5000.00", netDisbursed: "4800.00", variance: "-200.00" }).status).toBe("under_disbursed");
```

- [ ] **Step 2: Build cards and dialogs**

Add Daily repayment terms before Funding State, then a Disbursements card with approved/net/variance/status, grouped-transfer marker, evidence link, draft add/edit form, upload/finalize flow, post and reasoned reverse actions. Correct Funding State copy to describe direct-capital allocation separately from a bank drawdown. Do not offer edit on posted rows.

- [ ] **Step 3: Localize and verify**

Run: `cd frontend && bun test && bun run build`

Expected: PASS; mobile layout remains one column and money/date use active locale.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/dashboard/loans/LoanDetail.tsx frontend/src/lib/api.ts frontend/src/locales/en.json frontend/src/locales/th.json frontend/tests/loan-disbursement-view.test.ts README.md CHANGELOG.md
git commit -m "feat: show auditable loan disbursements"
```

### Task 5: Production migration and workflow verification

- [ ] **Step 1: Deploy backend migration**

Run: `docker compose --env-file .env.production -f docker-compose.app.yml up --build -d backend`

Expected: log contains `migrations applied successfully`.

- [ ] **Step 2: Verify real workflow**

Create a cash draft, a grouped bank transfer with evidence, post both, confirm an over/under warning does not alter the schedule, reverse one with reason, and verify audit/history and MCP responses.

- [ ] **Step 3: Deploy frontend and record release verification**

Run: `docker compose --env-file .env.production -f docker-compose.app.yml up --build -d frontend`

Expected: current containers are running and `curl -fsS http://127.0.0.1:8088/` returns HTTP 200.

## Self-Review

- Spec coverage: Tasks 1–2 cover independent ledger, evidence, variance, grouped amounts, immutability and reversal; Task 3 provides REST/MCP parity; Task 4 covers detail UI and fixed daily terms; Task 5 covers real deployment.
- Type consistency: `grossAmount`, `loanAttributedAmount`, channels, status, public IDs, evidence IDs, and idempotency keys retain the same names through schema, service, adapters, and UI.
