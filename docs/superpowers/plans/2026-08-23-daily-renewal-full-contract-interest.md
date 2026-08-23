# Daily Renewal Full-Contract Interest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend scheduled daily-loan renewal so the default full-contract-interest policy, reasoned manual adjustments, exact cash result, manual Web UI, MCP workflow, and deterministic customer summary image all use one backend-authoritative preview.

**Architecture:** Evolve the existing `renewal.preview -> renewal.execute -> renewal.reverse` aggregate rather than adding a parallel renewal subsystem. Persist the resolved policy, frozen calculation, and immutable adjustment lines; expose one presentation DTO through REST and MCP; render the customer image deterministically in the browser from that DTO without recalculating money.

**Tech Stack:** Bun, TypeScript, Elysia, Drizzle ORM, PostgreSQL 18, Decimal.js, React 19, i18next, Canvas/SVG browser APIs, CreditSync MCP/plugin contract.

**Spec:** `docs/superpowers/specs/2026-08-23-daily-renewal-full-contract-interest-design.md`

## Global Constraints

- `full_contract_interest` is the backend, Web UI, and MCP default; `accrued_to_date` remains an explicit alternative.
- Public THB values are two-decimal strings and every financial operation uses `decimal.js`; never use JavaScript `Number` for arithmetic, comparison, or formatting.
- Use `Asia/Bangkok` for renewal business dates. Timestamps remain ISO 8601 and contract/due dates remain `YYYY-MM-DD`.
- Posted repayments, schedules, renewals, adjustment lines, and audit history are immutable. Corrections and reversal are append-only compensations.
- Principal paid, contractual interest, interest received, and schedule totals are backend-authoritative and cannot be manually overridden.
- Manual lines are limited to `fee`, `penalty`, `other_charge`, and `waiver`; every line has a positive amount and non-blank reason.
- Preview, summary-data reads, and image export do not create financial records. Execute always requires an unexpired hash and explicit confirmation.
- The summary image is deterministic and presentation-only; no AI or frontend arithmetic determines financial text or values.
- Every write retains tenant/owner isolation, actor/source, request/correlation ID, stable idempotency, immutable audit history, and useful before/after state.
- Update `CHANGELOG.md` before every commit. Update `README.md` in the user-facing workflow commit. Preserve unrelated dirty files in the main worktree.
- Database-backed tests run serially through `backend/scripts/test-disposable-postgres.sh`.

---

### Task 1: Persist Renewal Policy, Frozen Composition, and Immutable Adjustment Lines

**Files:**
- Create: `backend/drizzle/0050_daily_renewal_full_contract_interest.sql`
- Modify: `backend/drizzle/meta/_journal.json`
- Modify: `backend/src/db/schema.ts:1559-1634`
- Test: `backend/src/services/loan-renewal-service.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces: `RenewalSettlementPolicy`, `loanRenewals.settlementPolicy`, `loanRenewals.composition`, and `loanRenewalAdjustmentLines`.
- Enforces: tenant-scoped renewal ownership, ordered lines, positive exact amounts, closed kinds/statuses, and database immutability.

- [ ] **Step 1: Add a failing migration-backed schema test**

Add a test that inserts a preview renewal with `settlementPolicy: "full_contract_interest"` and a frozen JSON composition, then inserts ordered charge/waiver rows. Assert a duplicate `(tenant_id, renewal_id, line_no)`, zero/negative amount, invalid kind, invalid status, cross-tenant renewal link, and `UPDATE`/`DELETE` of a posted row all fail.

Use this row shape verbatim in the test:

```ts
const line = {
    tenantId,
    renewalId: renewal.id,
    lineNo: 1,
    kind: "other_charge" as const,
    amount: "25.00",
    reason: "Documented collection expense",
    status: "posted" as const,
    actorSource: "web",
    requestId: "renewal-adjustment-schema",
    correlationId: "renewal-adjustment-schema",
    idempotencyKey: "renewal-adjustment-schema:1",
    auditPublicId: crypto.randomUUID(),
    createdByUserId: actor.id,
};
```

- [ ] **Step 2: Run the focused test to verify RED**

Run:

```bash
cd backend
./scripts/test-disposable-postgres.sh src/services/loan-renewal-service.test.ts
```

Expected: FAIL because the new columns/table mappings do not exist.

- [ ] **Step 3: Add migration 0050 and Drizzle mappings**

Migration requirements:

```sql
ALTER TABLE "loan_renewals"
  ADD COLUMN "settlement_policy" text NOT NULL DEFAULT 'full_contract_interest',
  ADD COLUMN "composition" jsonb;

ALTER TABLE "loan_renewals"
  ADD CONSTRAINT "loan_renewals_settlement_policy_check"
  CHECK ("settlement_policy" IN ('full_contract_interest', 'accrued_to_date'));

CREATE TABLE "loan_renewal_adjustment_lines" (
  "id" serial PRIMARY KEY,
  "public_id" uuid DEFAULT uuidv7() NOT NULL UNIQUE,
  "tenant_id" text NOT NULL,
  "renewal_id" integer NOT NULL,
  "line_no" integer NOT NULL,
  "kind" text NOT NULL,
  "amount" numeric(30,2) NOT NULL,
  "reason" text NOT NULL,
  "status" text DEFAULT 'posted' NOT NULL,
  "reverses_line_id" integer,
  "actor_source" text NOT NULL,
  "request_id" text NOT NULL,
  "correlation_id" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "audit_public_id" uuid NOT NULL,
  "created_by_user_id" integer,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "loan_renewal_adjustment_lines_amount_check" CHECK ("amount" > 0),
  CONSTRAINT "loan_renewal_adjustment_lines_reason_check" CHECK (length(btrim("reason")) > 0),
  CONSTRAINT "loan_renewal_adjustment_lines_kind_check" CHECK ("kind" IN ('fee','penalty','other_charge','waiver')),
  CONSTRAINT "loan_renewal_adjustment_lines_status_check" CHECK ("status" IN ('posted','reversed'))
);
```

Add tenant-safe composite FKs to `loan_renewals`, `users`, and the self-reversal target; unique indexes on `(tenant_id, id)`, `(tenant_id, renewal_id, line_no)`, and `(tenant_id, idempotency_key)`. Add a trigger that rejects `UPDATE` and `DELETE` on adjustment rows. Remove the default from `settlement_policy` after backfilling existing rows so all new service writes remain explicit.

Mirror every column, index, check, and FK in `schema.ts`. Append journal index `50` using the exact migration timestamp chosen for this migration.

- [ ] **Step 4: Run the schema test to verify GREEN**

Run the Step 2 command. Expected: all renewal tests pass, including the new database-invariant test.

- [ ] **Step 5: Update changelog and commit**

Add a concise `v0.3.38` `### Added` bullet for persisted full-interest renewal policy and immutable manual adjustment lines, then run:

```bash
git add CHANGELOG.md backend/drizzle/0050_daily_renewal_full_contract_interest.sql backend/drizzle/meta/_journal.json backend/src/db/schema.ts backend/src/services/loan-renewal-service.test.ts
git diff --cached --check
git commit -m "feat: persist full-interest renewal terms"
```

---

### Task 2: Build the Exact Renewal Composition Kernel

**Files:**
- Create: `backend/src/lib/loan-renewal-composition.ts`
- Create: `backend/src/lib/loan-renewal-composition.test.ts`
- Modify: `backend/src/services/loan-renewal-service.ts:21-232`
- Modify: `backend/src/services/loan-renewal-service.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: immutable old schedule rows, active posted repayments, requested replacement principal, policy, and manual lines.
- Produces: `calculateRenewalComposition(input): RenewalComposition` and exported closed input/output types.

- [ ] **Step 1: Define types and write failing kernel tests**

Create these public types:

```ts
export type RenewalSettlementPolicy = "full_contract_interest" | "accrued_to_date";
export type RenewalAdjustmentKind = "fee" | "penalty" | "other_charge" | "waiver";
export type RenewalManualAdjustment = { kind: RenewalAdjustmentKind; amount: string; reason: string };

export interface RenewalCompositionInput {
    settlementPolicy: RenewalSettlementPolicy;
    renewalDate: string;
    requestedPrincipal: string;
    originalPrincipal: string;
    contractStartDate: string;
    contractDueDate: string;
    schedules: Array<{ dueDate: string; principal: string; interest: string; fee: string }>;
    payments: Array<{ transactionPublicId: string; paidAt: string; amount: string; principal: string; interest: string; fee: string; penalty: string }>;
    accruedDueInterest: string;
    dueFees: string;
    duePenalties: string;
    adjustments: RenewalManualAdjustment[];
}
```

The first test uses 24 schedule rows whose totals are exactly principal `2000.00`, interest `400.00`, and total `2400.00`, plus ten `100.00` payments totaling principal `833.33` and interest `166.67`. Assert:

```ts
expect(calculateRenewalComposition(input)).toMatchObject({
    settlementPolicy: "full_contract_interest",
    requestedPrincipal: "2000.00",
    contractualInterest: "400.00",
    totalPaid: "1000.00",
    receivedPrincipal: "833.33",
    receivedInterest: "166.67",
    remainingContractInterest: "233.33",
    recoveredBeforeAdjustments: "600.00",
    manualCharges: "0.00",
    manualWaivers: "0.00",
    cashDirection: "payout",
    cashAmount: "600.00",
});
```

Add tests for explicit `accrued_to_date`, total paid below contractual interest, mixed manual lines, waiver above eligible charges, invalid money/reason/kind at runtime, 29-digit exact values, and conservation.

- [ ] **Step 2: Run unit tests to verify RED**

Run:

```bash
cd backend
bun test src/lib/loan-renewal-composition.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the pure Decimal kernel**

Implement `calculateRenewalComposition` with `FinancialDecimal`/`decimal.js`. Derive every total from inputs, serialize through the existing money helpers, and return the complete `RenewalComposition` defined in the spec. Reject waiver overflow with `RENEWAL_WAIVER_EXCEEDS_ELIGIBLE_CHARGES`.

Keep these equations explicit in code:

```ts
const contractualInterest = sum(schedules.map((row) => row.interest));
const totalPaid = sum(payments.map((row) => row.amount));
const receivedPrincipal = sum(payments.map((row) => row.principal));
const receivedInterest = sum(payments.map((row) => row.interest));
const remainingContractInterest = max(contractualInterest.minus(receivedInterest), zero);
const recoveredBeforeAdjustments = max(totalPaid.minus(contractualInterest), zero);
const oldOutstandingPrincipal = max(originalPrincipal.minus(receivedPrincipal), zero);
const policyInterest = settlementPolicy === "full_contract_interest" ? remainingContractInterest : accruedDueInterest;
const settlementAmount = policyInterest.plus(dueFees).plus(duePenalties).plus(manualCharges).minus(manualWaivers);
const netCash = requestedPrincipal.minus(oldOutstandingPrincipal).minus(settlementAmount);
```

Do not call this kernel from the browser.

- [ ] **Step 4: Integrate snapshot loading without persisting writes**

Refactor `renewalSnapshot` to load schedule/payment facts and call the kernel. Preserve active-repayment reversal filtering. Resolve `contractDueDate` from the final schedule and use Bangkok business date for `renewalDate`.

Add a service regression proving the default omitted policy returns `600.00` for the exact example and does not insert adjustments, a new loan, or funding movements during preview calculation.

- [ ] **Step 5: Run focused tests and commit**

Run:

```bash
bun test src/lib/loan-renewal-composition.test.ts
./scripts/test-disposable-postgres.sh src/services/loan-renewal-service.test.ts
bun run typecheck
```

Update the `v0.3.38` changelog entry, then commit:

```bash
git add CHANGELOG.md backend/src/lib/loan-renewal-composition.ts backend/src/lib/loan-renewal-composition.test.ts backend/src/services/loan-renewal-service.ts backend/src/services/loan-renewal-service.test.ts
git diff --cached --check
git commit -m "feat: calculate full-interest renewal composition"
```

---

### Task 3: Persist Preview Inputs and Enforce Stale-State Safety

**Files:**
- Modify: `backend/src/services/loan-renewal-service.ts:209-420`
- Modify: `backend/src/services/loan-renewal-service.test.ts`
- Modify: `backend/src/modules/loan-renewals.ts`
- Modify: `backend/src/modules/loan-renewals.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: `RenewalSettlementPolicy`, `RenewalManualAdjustment`, and `calculateRenewalComposition` from Task 2.
- Produces: `PreviewLoanRenewalInput` with structured policy/adjustments and a durable presentation-ready preview.

- [ ] **Step 1: Write failing preview and boundary tests**

Change the input contract to:

```ts
export interface PreviewLoanRenewalInput {
    requestedPrincipal: string;
    settlementPolicy?: RenewalSettlementPolicy;
    adjustments?: RenewalManualAdjustment[];
    waivedCharges?: string;
    waiverReason?: string;
}
```

Test that omission resolves/persists `full_contract_interest`; explicit `accrued_to_date` survives round-trip; adjustment order and reasons are frozen; legacy `waivedCharges` maps to one waiver line; sending legacy waiver fields together with `adjustments` fails with `RENEWAL_ADJUSTMENT_INPUT_CONFLICT`.

At REST, add closed schemas for policy and adjustment lines. Assert unknown keys, invalid literals, zero amounts, blank reasons, and more than 50 adjustment rows fail before service execution.

- [ ] **Step 2: Run focused tests to verify RED**

Run:

```bash
cd backend
./scripts/test-disposable-postgres.sh src/services/loan-renewal-service.test.ts src/modules/loan-renewals.test.ts
```

Expected: failures show the policy and adjustment inputs are not yet accepted/persisted.

- [ ] **Step 3: Persist a frozen preview and strengthen the hash**

Normalize the request once. Persist the resolved policy and full composition JSON on `loan_renewals`. Include in the preview hash/state version:

- old loan lifecycle and immutable terms;
- complete schedule IDs/dates/components;
- active payment and compensating-reversal UUIDs/components;
- selected policy;
- ordered normalized adjustments;
- derived composition;
- funding allocation state;
- Bangkok renewal date and expiry.

Return the persisted composition directly in `presentPreview`; do not recalculate for presentation.

- [ ] **Step 4: Add stale-state regression cases**

After preview, mutate each allowed source independently through real commands: post/reverse a payment, change funding allocation, and advance a due charge. Assert execute fails with `STALE_RENEWAL_PREVIEW`, posts no renewal ledger rows, and requires a new preview.

- [ ] **Step 5: Run focused tests and commit**

Run the Step 2 command plus `bun run typecheck`. Update changelog and commit:

```bash
git add CHANGELOG.md backend/src/services/loan-renewal-service.ts backend/src/services/loan-renewal-service.test.ts backend/src/modules/loan-renewals.ts backend/src/modules/loan-renewals.test.ts
git diff --cached --check
git commit -m "feat: preview configurable daily renewals"
```

---

### Task 4: Execute and Reverse the New Ledger Composition Atomically

**Files:**
- Modify: `backend/src/services/loan-renewal-service.ts:420-940`
- Modify: `backend/src/services/loan-renewal-service.test.ts`
- Modify: `backend/src/modules/loan-renewals.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: persisted policy/composition and normalized adjustment lines from Task 3.
- Produces: an executed new loan, exact append-only adjustment entries, and compensating reversal behavior.

- [ ] **Step 1: Write the failing exact execution test**

For the `2000/2400/10-payment` fixture, execute the default preview and assert:

```ts
expect(executed).toMatchObject({
    settlementPolicy: "full_contract_interest",
    oldLoanPublicId: oldLoan.publicId,
    requestedPrincipal: "2000.00",
    cashDirection: "payout",
    cashAmount: "600.00",
});
```

Assert the old loan is `renewed`, the new loan is active at `2000.00`, the new schedule totals `2400.00`, original repayment rows are byte-for-byte unchanged, and adjustment history contains exact principal-transfer, full-contract-interest settlement `233.33`, and cash-payout `600.00` entries.

Add a fixture with fee, penalty, other charge, and waiver lines. Assert each produces one immutable `loan_renewal_adjustment_lines` row and one linked accounting adjustment with the same amount/reason.

- [ ] **Step 2: Add atomic/idempotent/reversal RED cases**

Cover identical execution retry, conflicting key reuse, stale preview, insufficient funding, unexpected collection without explicit confirmation, partial insert failure, reversal with and without downstream activity, and concurrent execute attempts.

Extend execute input only if collection is present:

```ts
type ExecuteLoanRenewalInput = {
    previewHash: string;
    confirmed: true;
    reason: string;
    confirmedCashDirection?: "collection";
};
```

Require `confirmedCashDirection: "collection"` when the preview requires collection; payout/none must reject that extra acknowledgment.

- [ ] **Step 3: Implement locked execution**

Inside one database transaction:

1. Resolve idempotent replay before mutation.
2. Lock renewal, old loan, schedules, transactions, funding allocations, and due-charge rows deterministically.
3. Recompute and compare the complete hash.
4. Insert immutable manual lines with deterministic idempotency keys.
5. Append exact accounting adjustments for principal transfer, remaining full interest or accrued interest, due charges, manual charges/waivers, and cash movement.
6. Create the new loan and schedule.
7. Reallocate funding using the existing largest-remainder Decimal allocator.
8. Transition lifecycle and create the audit record.

Never mutate prior repayment components to make `600.00` appear.

- [ ] **Step 4: Extend compensating reversal**

Keep the existing downstream check authoritative. On safe reversal, append opposite adjustment rows and opposite accounting entries; preserve original lines with status/history intact; reverse funding movements; restore the old loan's recorded pre-execution lifecycle state; cancel the replacement without deleting its schedule.

- [ ] **Step 5: Run focused and regression suites**

Run:

```bash
cd backend
./scripts/test-disposable-postgres.sh src/services/loan-renewal-service.test.ts src/modules/loan-renewals.test.ts src/services/payment-service.test.ts
bun run typecheck
```

Expected: all pass; no database invariant is skipped.

- [ ] **Step 6: Update changelog and commit**

```bash
git add CHANGELOG.md backend/src/services/loan-renewal-service.ts backend/src/services/loan-renewal-service.test.ts backend/src/modules/loan-renewals.test.ts
git diff --cached --check
git commit -m "feat: execute full-interest daily renewals"
```

---

### Task 5: Expose One Summary DTO Through REST Without Financial Side Effects

**Files:**
- Create: `backend/src/services/loan-renewal-summary-service.ts`
- Create: `backend/src/services/loan-renewal-summary-service.test.ts`
- Modify: `backend/src/modules/loan-renewals.ts`
- Modify: `backend/src/modules/loan-renewals.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: persisted renewal composition and adjustment/payment lineage.
- Produces: `getLoanRenewalSummary(ctx, renewalPublicId)` and `GET /loan-renewals/:id/summary`.

- [ ] **Step 1: Write failing summary-read tests**

Test preview and executed renewals. Assert the DTO contains:

```ts
{
  status: "preview" | "executed" | "reversed" | "expired",
  watermark: "preview_not_executed" | "renewal_executed" | "renewal_reversed",
  renewalPublicId,
  borrower: { displayName },
  oldContract: { publicId, startDate, dueDate },
  replacement: { publicId: string | null, principal, installmentAmount, totalInstallments },
  composition,
  generatedAt,
}
```

Assert tenant/owner isolation, expired preview watermark, complete payments in JSON, no raw ID-card/bank/evidence fields, and zero financial writes before/after the GET.

- [ ] **Step 2: Run focused test to verify RED**

Run:

```bash
cd backend
./scripts/test-disposable-postgres.sh src/services/loan-renewal-summary-service.test.ts src/modules/loan-renewals.test.ts
```

Expected: FAIL because the summary service/route does not exist.

- [ ] **Step 3: Implement the read model and closed route**

Load persisted composition; never recompute settlement values during GET. Resolve safe borrower display name and replacement schedule summary. Enforce the same tenant/portfolio visibility as renewal preview. Add `GET /loan-renewals/:id/summary` with UUID params and no body/query fields.

- [ ] **Step 4: Run tests and commit**

Run focused tests and backend typecheck. Update changelog, then commit:

```bash
git add CHANGELOG.md backend/src/services/loan-renewal-summary-service.ts backend/src/services/loan-renewal-summary-service.test.ts backend/src/modules/loan-renewals.ts backend/src/modules/loan-renewals.test.ts
git diff --cached --check
git commit -m "feat: expose renewal summary data"
```

---

### Task 6: Synchronize MCP, Plugin 7.4.0, and Orchestration Evals

**Files:**
- Modify: `backend/src/mcp/default.ts:435-449`
- Modify: `backend/src/mcp/default.test.ts`
- Modify: `backend/src/mcp/server.ts:1120-1140,1444-1464,1751-1753`
- Modify: `backend/src/mcp/server.test.ts`
- Modify: `backend/src/mcp/contract-snapshot.ts`
- Modify: `plugins/creditsync/.codex-plugin/plugin.json`
- Modify: `plugins/creditsync/README.md`
- Modify: `plugins/creditsync/references/mcp-tool-contract.json`
- Modify: `plugins/creditsync/skills/renew-daily-loan/SKILL.md`
- Modify: `plugins/creditsync/evals/catalog.json`
- Modify: `plugins/creditsync/evals/harness.ts`
- Modify: `plugins/creditsync/tests/plugin-contract.test.ts`
- Modify: `plugins/creditsync/scripts/validate.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: preview/execute outputs from Tasks 3-5.
- Produces: synchronized frozen MCP input/output schemas and plugin version `7.4.0`; tool count remains unchanged.

- [ ] **Step 1: Add failing strict-contract tests**

Extend `renewal.preview` input with:

```ts
settlementPolicy: z.enum(["full_contract_interest", "accrued_to_date"]).optional(),
adjustments: z.array(z.object({
    kind: z.enum(["fee", "penalty", "other_charge", "waiver"]),
    amount: money,
    reason: z.string().trim().min(1).max(500),
}).strict()).max(50).optional(),
```

Test omission defaults to full interest, explicit accrued policy remains explicit, adjustment order is preserved, blank reason/extra fields fail, execute cannot alter preview terms, and an unexpected collection stops without execute.

- [ ] **Step 2: Run MCP/plugin tests to verify RED**

Run:

```bash
cd backend
./scripts/test-disposable-postgres.sh src/mcp/default.test.ts
bun test src/mcp/server.test.ts
cd ../plugins/creditsync
bun test
bun run validate
```

Expected: frozen schemas and plugin fixtures fail until synchronized.

- [ ] **Step 3: Update adapters and outputs**

Map policy/adjustments into `previewLoanRenewal`. Expand `renewalOutput` with the complete strict composition and payments. Keep execute/reverse destructive hints and preview read semantics unchanged. Return only safe public UUIDs and strings.

- [ ] **Step 4: Upgrade plugin to 7.4.0 and update guidance/evals**

Update the renewal skill to require:

- showing the default full old-contract interest and new-contract interest separately;
- listing every manual line/reason;
- stopping on collection until explicitly acknowledged;
- re-previewing after any change;
- treating backend composition as authoritative;
- never claiming image export executes a renewal.

Add positive evals for default `600.00` payout and explicit accrued policy, plus negative evals for blank adjustment reason, waiver overflow, stale hash, unexpected collection, and missing confirmation.

- [ ] **Step 5: Run gates and commit**

Run the Step 2 commands and backend typecheck. Update changelog and commit all synchronized files:

```bash
git add CHANGELOG.md backend/src/mcp plugins/creditsync
git diff --cached --check
git commit -m "feat: expose full-interest renewal through MCP"
```

---

### Task 7: Add Frontend Renewal Models, Manual Inputs, and Exact Approval UI

**Files:**
- Create: `frontend/src/pages/dashboard/loans/loan-renewal-model.ts`
- Create: `frontend/src/pages/dashboard/loans/loan-renewal-model.test.ts`
- Modify: `frontend/src/lib/workflow-api.ts:63-79`
- Modify: `frontend/src/pages/dashboard/loans/LoanRenewalPanel.tsx`
- Create: `frontend/src/pages/dashboard/loans/LoanRenewalPanel.test.tsx`
- Modify: `frontend/src/locales/en.json:979-1015`
- Modify: `frontend/src/locales/th.json:979-1015`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: REST preview/summary contracts from Tasks 3 and 5.
- Produces: manual operator workflow with no client-side financial calculation.

- [ ] **Step 1: Write failing model and component tests**

Model tests assert:

- initial policy is `full_contract_interest`;
- adding a line produces `{ kind: "fee", amount: "", reason: "" }` without calculating totals;
- any edit clears the current preview/confirmation and execution intent key;
- the view maps backend money strings directly to localized formatting;
- a collection preview requires both normal confirmation and collection-specific acknowledgment.

Component tests render the panel and prove manual policy/rows are sent exactly, the returned payment history and deductions appear, and clicking edit after preview invalidates the approval snapshot.

- [ ] **Step 2: Run frontend tests to verify RED**

Run:

```bash
cd frontend
bun test src/pages/dashboard/loans/loan-renewal-model.test.ts src/pages/dashboard/loans/LoanRenewalPanel.test.tsx
```

Expected: FAIL because the model/UI controls do not exist.

- [ ] **Step 3: Implement model/API contract**

Move renewal types and draft-line helpers out of the large component. Extend preview API input with explicit policy and lines. Keep `executeRenewal` limited to preview UUID/hash, reason, confirmation, idempotency, and optional collection acknowledgment.

- [ ] **Step 4: Implement the manual UI**

Replace aggregate waiver inputs with:

- policy select defaulted to the localized full-interest label;
- repeatable adjustment rows with kind, decimal input, mandatory reason, and remove action;
- read-only preview sections for contract/payment history, full vs received interest, deductions/waivers, recovered-before-adjustments, exact cash result, and new schedule;
- an approval dialog repeating policy, old interest, new interest, deductions, and payout/collection;
- separate collection acknowledgment when applicable.

Disable edit controls after preview or provide one “แก้ไขรายการ” action that discards preview before unlocking them. Do not sum values in React.

- [ ] **Step 5: Update translations and README**

Add matching Thai/English keys for both policies, four adjustment kinds, validation errors, composition labels, collection acknowledgment, and edit/re-preview actions. Document the workflow and default full-interest consequence in README without describing it as refundable principal.

- [ ] **Step 6: Run frontend gates and commit**

Run:

```bash
cd frontend
bun test
bun run lint
bun run build
```

Update changelog, then commit:

```bash
git add CHANGELOG.md README.md frontend/src
git diff --cached --check
git commit -m "feat: add manual full-interest renewal UI"
```

---

### Task 8: Generate Deterministic Preview and Executed Summary Images

**Files:**
- Create: `frontend/src/pages/dashboard/loans/renewal-summary-image.ts`
- Create: `frontend/src/pages/dashboard/loans/renewal-summary-image.test.ts`
- Create: `frontend/src/pages/dashboard/loans/RenewalSummaryCard.tsx`
- Create: `frontend/src/pages/dashboard/loans/RenewalSummaryCard.test.tsx`
- Modify: `frontend/src/pages/dashboard/loans/LoanRenewalPanel.tsx`
- Modify: `frontend/src/locales/en.json`
- Modify: `frontend/src/locales/th.json`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: exact `GET /loan-renewals/:id/summary` DTO.
- Produces: deterministic PNG download; creates no backend write and performs no money arithmetic.

- [ ] **Step 1: Write failing renderer tests**

Define:

```ts
export function buildRenewalSummarySvg(summary: LoanRenewalSummary, locale: string): string;
export async function renewalSummaryPng(summary: LoanRenewalSummary, locale: string): Promise<Blob>;
```

Test that the SVG contains exact backend strings `1000.00`, `400.00`, `233.33`, and `600.00`; preview uses a prominent `PREVIEW — NOT EXECUTED`/Thai equivalent watermark; executed uses a distinct status; raw ID-card/account/QR/evidence fields cannot enter the typed DTO; long histories render count, total, first date, and last date instead of overflowing.

Mock canvas only for SVG-to-PNG conversion. Assert renderer code contains no Decimal/Number financial summation.

- [ ] **Step 2: Run tests to verify RED**

Run:

```bash
cd frontend
bun test src/pages/dashboard/loans/renewal-summary-image.test.ts src/pages/dashboard/loans/RenewalSummaryCard.test.tsx
```

Expected: FAIL because renderer/card do not exist.

- [ ] **Step 3: Implement safe deterministic SVG and PNG conversion**

Use a fixed `1080 × 1350` SVG layout with escaped text, bundled/local font stack, fixed sections, and exact localized date/currency formatting of backend strings. Load the SVG into an `Image`, draw to a canvas, and return `canvas.toBlob(..., "image/png")`. If canvas export fails, show a stable UI error and keep the SVG available for retry; do not fall back to AI generation.

- [ ] **Step 4: Add summary card and download action**

Fetch summary by renewal UUID only after preview exists. Display the same card in the UI and provide “ดาวน์โหลดภาพสรุป”. Use filename `renewal-<masked-uuid>-preview.png` or `renewal-<masked-uuid>-executed.png`. Export never calls execute and never changes confirmation state.

- [ ] **Step 5: Run frontend gates and commit**

Run full frontend tests/lint/build. Update changelog and commit:

```bash
git add CHANGELOG.md frontend/src/pages/dashboard/loans frontend/src/locales/en.json frontend/src/locales/th.json
git diff --cached --check
git commit -m "feat: export deterministic renewal summaries"
```

---

### Task 9: Run Complete Financial, Contract, and Deployment Verification

**Files:**
- Verify only unless a gate exposes an in-scope defect.

**Interfaces:**
- Consumes: Tasks 1-8 at one candidate HEAD.
- Produces: merge-ready evidence with no production financial writes.

- [ ] **Step 1: Verify migration and branch integrity**

Run:

```bash
git status --short
git diff --check
git log --oneline main..HEAD
```

Confirm no unrelated main-worktree changes are included and every implementation commit includes an accurate `CHANGELOG.md` update.

- [ ] **Step 2: Run complete backend gates serially**

Run:

```bash
cd backend
./scripts/test-disposable-postgres.sh
bun run typecheck
```

Expected: zero failures; database invariants are not skipped.

- [ ] **Step 3: Run frontend and plugin gates**

Run:

```bash
cd frontend
bun test
bun run lint
bun run build
cd ../plugins/creditsync
bun test
bun run validate
```

Expected: zero failures; validator reports plugin `7.4.0`, 11 skills, and the unchanged MCP tool count.

- [ ] **Step 4: Perform an independent whole-branch review**

Review `main...HEAD` against the approved spec. Reject integration for any browser-side financial arithmetic, mutable posted records, missing full-interest default, unbounded waiver, stale-state gap, tenant leak, missing collection acknowledgment, summary-image side effect, MCP/plugin drift, or untranslated user-facing copy.

- [ ] **Step 5: Merge/deploy only with explicit authorization**

After approval, fast-forward the verified feature branch into the stated integration target while preserving user-owned dirty files. Deploy with:

```bash
docker compose --env-file .env.production -f docker-compose.infra.yml up -d
docker compose --env-file .env.production -f docker-compose.app.yml up --build -d
```

Verify migration 0050 columns/table/constraints through PostgreSQL, successful backend migration logs, MCP health inside the backend container, local frontend HTTP 200, and public frontend HTTP 200. Do not create a production renewal as a smoke test.
