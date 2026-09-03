# Floating Interest Provenance and Reconciliation Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ทำให้การจ่ายดอกเบี้ยลอยตัวที่ถูกบันทึกเป็นเงินต้นสามารถ reverse และ reconcile กลับเป็นดอกเบี้ยได้อย่างถูกต้อง โดย preview ต้องตรวจ provenance ได้ครบก่อน execute และไม่กระทบประวัติการเงินเดิม

**Architecture:** แยกการแก้ข้อมูลเดิมออกจากการ reverse payment ทั่วไปอย่างชัดเจน ใช้ append-only accrual correction ที่คำนวณโดย backend แล้วจึงสร้าง reconciliation replacement ที่ผูก allocation กับ accrual rows จริง การ preview และ execute จะใช้ validation/provenance resolver ชุดเดียวกัน และทุก financial write จะอยู่ใน transaction พร้อม idempotency, audit และ balance-version checks

**Tech Stack:** Bun, TypeScript, Drizzle ORM, PostgreSQL, decimal.js/FinancialDecimal, CreditSync MCP

**Spec:** `/home/flintstone/.codex/attachments/8172e6ff-b204-46e4-a513-130120fb31c4/pasted-text.txt`

## Global Constraints

- ห้ามแก้ไขหรือลบ posted financial records; แก้ด้วย append-only reversal/adjustment เท่านั้น
- เงินทุกค่าที่ข้าม public interface ต้องเป็น decimal string สองตำแหน่ง และการคำนวณใช้ `FinancialDecimal`/`decimal.js`
- ใช้ business date ของ `Asia/Bangkok`; งวด weekly ใช้ขอบเขต `[periodStart, nextPeriodStart)`
- ห้ามใช้ชื่อหรือ fuzzy match เป็นตัวตัดสินใจทางการเงินโดยอัตโนมัติ
- Financial write ต้องผ่าน `inspect -> preview -> explicit confirmation -> post/execute` พร้อม command context, correlation ID, idempotency key และ audit history
- ห้ามเขียน production data โดยตรงจากสคริปต์ ad-hoc และห้าม log raw QR, account number, full evidence หรือข้อมูลส่วนบุคคลเกินจำเป็น
- ต้องคง compatibility กับสัญญา MCP/plugin ที่ใช้งานอยู่ และเพิ่ม schema version เมื่อ response เปลี่ยนสาระสำคัญ

## File Map

- Modify `backend/src/services/floating-interest-service.ts`: รวมตัวคำนวณ/ตรวจ available accrual provenance สำหรับ preview และ execute และกำหนด advance-period semantics ให้จุดใช้งานทั้งหมดเหมือนกัน
- Modify `backend/src/services/payment-reconciliation-service.ts`: เรียก resolver เดียวกันใน preview, บันทึก provenance plan ใน proposal และ revalidate แบบ stale-safe ตอน execute
- Modify `backend/src/services/payment-reverse-with-accrual-service.ts`: ให้ reverse workflow ระบุผลว่า materialize ได้จริงหรือยัง และไม่รายงานว่าแก้พร้อม reconcile หากยังไม่มี accrual ที่ใช้งานได้
- Modify `backend/src/services/payment-service.ts`: คงการ reverse แบบ compensating และตรวจว่า principal reproject ไม่ทำลาย/กลบ accrual provenance ของงวดถัดไป
- Modify MCP route/schema files ที่ register payment reconciliation/reversal tools: เปิด workflow correction ที่ audited ถ้าจำเป็น โดยไม่ expose internal numeric IDs
- Modify `plugins/creditsync/skills/reconcile-payments/SKILL.md` and payment eval fixtures: บังคับ preflight/dry-run ก่อนทุก payment post/reconcile/reversal ที่มีความเสี่ยง
- Test `backend/src/services/floating-interest-service.test.ts`, `backend/src/services/payment-service.test.ts`, `backend/src/services/payment-reconciliation-service.test.ts`, `backend/src/services/floating-allocation-regressions.test.ts`, และ MCP contract/validator tests ที่เกี่ยวข้อง
- Modify `CHANGELOG.md` and `README.md` only if the final implementation changes user-facing workflow or setup

## Task 1: Lock the failing financial scenarios with regression tests

**Files:**
- Test: `backend/src/services/floating-interest-service.test.ts`
- Test: `backend/src/services/payment-service.test.ts`
- Test: `backend/src/services/payment-reconciliation-service.test.ts`
- Test: `backend/src/services/floating-allocation-regressions.test.ts`

**Interfaces:**
- Consumes existing loan/payment helpers and the current floating policy API.
- Produces executable regression cases for the later service changes.

- [ ] **Step 1: Add the advance-period boundary test.** Seed a weekly floating loan with principal `2000.00`, rate `15.0000`, anchor/start `2026-08-24`, `advanceInterestPeriods: 1`; assert the first period is non-refundable/paid and a payment on Bangkok date `2026-09-01` resolves to the second anchored period, not principal.
- [ ] **Step 2: Add the bad historical-payment test.** Seed or use the existing fixture that has a `300.00` repayment with `principalComponent: "300.00"` and `interestComponent: "0.00"`; reverse it through the supported compensating workflow and assert the original remains immutable, principal is restored to `2000.00`, and no false first-period refund is created.
- [ ] **Step 3: Add the preview/execute consistency test.** Reproduce an interest-only reconciliation where no real accrual allocation is available; assert preview returns a non-ready review result or a typed provenance warning and execute cannot reach the current late `RECONCILIATION_INTEREST_PROVENANCE_UNAVAILABLE` path after a `ready` preview.
- [ ] **Step 4: Add the valid correction test.** After an audited accrual correction/materialization, assert preview exposes an exact `300.00` allocation plan with concrete accrual provenance and execute creates one replacement interest transaction plus one allocation per applicable accrual row; repeated idempotency returns the same result.
- [ ] **Step 5: Run only the new tests and verify they fail for the current behavior.** Use the disposable PostgreSQL test runner; record the failing assertion/error codes without touching any production tenant.

## Task 2: Implement one authoritative floating-interest allocation/provenance resolver

**Files:**
- Modify: `backend/src/services/floating-interest-service.ts`
- Test: `backend/src/services/floating-interest-service.test.ts`

**Interfaces:**
- Produce an internal resolver with an explicit result shape, for example:

```ts
type FloatingInterestAllocationPlan = {
  loanPublicId: string;
  throughDate: string;
  periodStartDate: string;
  periodEndDate: string;
  requestedAmount: string;
  availableAmount: string;
  allocations: Array<{
    accrualId: number;
    accrualPublicId: string;
    amount: string;
    dueDate: string;
  }>;
  provenanceReady: boolean;
  warnings: Array<{ code: string; details: Record<string, string> }>;
};

async function resolveFloatingInterestAllocationPlan(
  tx: Executor,
  loan: typeof loans.$inferSelect,
  receivedAt: Date,
  requestedAmount: string,
  context: CommandContext,
  mode: "preview" | "execute",
): Promise<FloatingInterestAllocationPlan>
```

- It must use `interestPeriodFor`, `accrueFloatingInterestThroughInTransaction`, existing allocation reversals, and the same advance-period selection semantics as posting.

- [ ] **Step 1: Define the resolver’s period rules.** Convert `receivedAt` to Bangkok business date; for the target case resolve `2026-09-01` to the anchored period beginning `2026-08-31`, while treating the initial `2026-08-24` period as already paid and non-refundable.
- [ ] **Step 2: Separate preview projection from execute materialization.** In `mode: "preview"`, use projected/virtual rows and do not persist accruals; in `mode: "execute"`, materialize the complete required target period to its exclusive end minus one Bangkok calendar day inside the same transaction. Never recreate interest arithmetic outside the backend policy functions.
- [ ] **Step 3: Build exact allocations from active accrual rows.** Exclude reversed rows and already-consumed amounts, preserve `interestAccrualId`, use decimal-string subtraction, and require the allocation sum to equal `requestedAmount`.
- [ ] **Step 4: Return typed warnings for missing/corrupt provenance.** Distinguish “period not yet payable”, “no active accrual rows”, “amount exceeds available accrual”, and “corrupt zero-principal accrual”; do not silently fall through to principal for an explicitly interest-only request.
- [ ] **Step 5: Add unit/integration assertions for boundary, partial payment, repeated reads, and reversed allocation history.** Verify preview is deterministic and leaves accrual/allocation tables unchanged, while execute creates only the required immutable rows.

## Task 3: Make reconciliation preview and execute use the same plan

**Files:**
- Modify: `backend/src/services/payment-reconciliation-service.ts`
- Test: `backend/src/services/payment-reconciliation-service.test.ts`

**Interfaces:**
- Consumes `resolveFloatingInterestAllocationPlan`.
- Stores a serialized public-safe provenance plan or its digest in `sourceSnapshot`/proposal data.
- Execute re-resolves against locked current state and rejects stale/mismatched plans before any financial insert.

- [ ] **Step 1: Validate every floating interest allocation during preview.** For each requested allocation, resolve the exact accrual plan and amount; if provenance is unavailable, return a review-required response or a dedicated domain error before inserting a `ready` proposal.
- [ ] **Step 2: Preserve public-safe provenance in the proposal.** Store accrual public IDs, period dates, amounts, and resolver version/digest; do not store raw account or evidence data.
- [ ] **Step 3: Revalidate before execute.** Lock loans, accruals, transactions, source intake, and proposal; recompute the resolver plan and compare both preview hash and provenance digest before creating the repost child/replacement transaction.
- [ ] **Step 4: Replace the broad accrual scan.** Use the resolver’s ordered allocations rather than scanning every active accrual row, so a `300.00` interest correction cannot accidentally consume another period.
- [ ] **Step 5: Preserve atomicity.** Ensure every failure occurs before durable replacement allocation, or rolls back the full transaction; add a test proving no child intake, replacement transaction, paidAmount update, or audit “executed” record remains after a provenance failure.

## Task 3A: Add a mandatory no-write execution preflight (“dry run”)

**Files:**
- Modify: `backend/src/services/payment-reconciliation-service.ts`
- Modify: `backend/src/services/payment-reverse-with-accrual-service.ts`
- Modify: `plugins/creditsync/skills/reconcile-payments/SKILL.md`
- Modify: `plugins/creditsync/README.md`
- Test: `backend/src/services/payment-reconciliation-service.test.ts`
- Test: `plugins/creditsync/tests/plugin-contract.test.ts`
- Test: `plugins/creditsync/tests/eval-harness.test.ts`
- Modify: `plugins/creditsync/evals/evals.json` and `plugins/creditsync/evals/harness.ts`

**Interfaces:**
- Add a backend-safe preflight result used by the plugin before human confirmation. The result must contain:

```ts
type PaymentExecutionPreflight = {
  status: "ready_to_execute" | "review_required" | "blocked";
  wouldWrite: false;
  sourcePaymentPublicId: string;
  affectedLoanPublicIds: string[];
  exactAmount: string;
  proposedComponents: { principal: string; interest: string; fee: string; penalty: string };
  allocationPlan: Array<{ loanPublicId: string; component: "interest" | "principal" | "fee" | "penalty"; amount: string; accrualPublicIds?: string[] }>;
  checks: Array<{ name: string; status: "pass" | "fail" | "warning"; code?: string }>;
  previewHash: string;
  expectedBalanceVersion: string;
  reviewRequired: boolean;
};
```

- The preflight may create only an expiring preview/proposal record if that is required by the existing backend workflow; it must not create an intake, transaction, accrual, allocation, child payment, or balance mutation. Its response must still explicitly say `wouldWrite: false` and identify any preview persistence.

- [ ] **Step 1: Define the preflight check list.** Require source intake/evidence readiness, exact borrower/loan identity, duplicate/idempotency status, active contract, Bangkok date, amount conservation, component split, floating period, available accrual provenance, allocation completeness, and execute-time lock/revalidation feasibility.
- [ ] **Step 2: Make preflight fail closed.** Return `review_required` or `blocked` for missing provenance, ambiguous decomposition, stale source, duplicate, warning that affects allocation, missing evidence, unsupported component, or any condition that current execute could reject. Never return `ready_to_execute` with a known possible `RECONCILIATION_INTEREST_PROVENANCE_UNAVAILABLE` failure.
- [ ] **Step 3: Add a no-write invariant test.** Snapshot payment intakes, transactions, accruals, floating allocations, loan balances, and audit rows before and after preflight; assert all financial tables and balances are unchanged. If preview proposal persistence remains part of the architecture, assert only the documented proposal/audit records are created and no financial record is created.
- [ ] **Step 4: Make the plugin call preflight and display it before confirmation.** The plugin must show “ตรวจสอบแล้วว่าสามารถทำรายการได้” only when every required check passes, show exact allocations and the preview hash/version, and ask for confirmation only after that result. If preflight is not `ready_to_execute`, it must stop and not call any execute/post tool.
- [ ] **Step 5: Add negative eval scenarios.** Cover a ready-looking preview that fails at execute, missing accrual provenance, stale preview, duplicate payment, amount mismatch, ambiguous contract match, and a valid floating second-period `300.00` payment. Assert forbidden calls include every financial execute/post call for the first six scenarios.
- [ ] **Step 6: Require a fresh preflight immediately before execute.** The confirmation must bind to the exact preflight/preview hash and balance version; if any state changes, the plugin must inspect and run a new dry run, then request fresh confirmation.

## Task 4: Add an audited historical correction path for the existing bad payment

**Files:**
- Modify: `backend/src/services/payment-reverse-with-accrual-service.ts`
- Modify: `backend/src/services/payment-service.ts`
- Modify: MCP registration/schema files for payment correction/reconciliation if needed
- Test: `backend/src/services/payment-service.test.ts`
- Test: `backend/src/services/payment-reconciliation-service.test.ts`

**Interfaces:**
- Consumes the append-only reversal already created for the target intake and the resolver from Task 2.
- Produces either a complete `ready` correction preview or a typed blocking result; never silently reposts principal/interest.

- [ ] **Step 1: Separate “reverse” from “repair allocation”.** Keep generic reverse behavior unchanged for normal payments; add an explicit correction mode requiring reason, confirmed target, idempotency key, and exact source intake/transaction IDs.
- [ ] **Step 2: Use `correctFloatingInterestAccruals` only through an audited service workflow.** Validate no active interest allocation or dependent penalty history blocks correction; create compensating reversed/replacement accrual rows and a `loanAdjustments` record, never update/delete the original accrual.
- [ ] **Step 3: Reproject the full affected suffix.** For a generalized weekly policy, correct from the earliest affected accrual date through the materialized suffix so later opening principal/cumulative values cannot remain stale.
- [ ] **Step 4: Re-run the authoritative allocation resolver after correction.** Require the target `300.00` to map fully to the second period; otherwise stop with review-required status.
- [ ] **Step 5: Add idempotency and retry tests.** A repeated request must return the original adjustment/reconciliation IDs and must not create duplicate accrual replacements, child intakes, or allocations.

## Task 5: Expose and document the safe MCP workflow

**Files:**
- Modify: MCP tool registration/schema/manifest files identified by `rg -n "payment_reconcile|reverse_with_accrual|creditsync.*7\\.0\\.0"`
- Modify: relevant plugin validator/eval fixtures
- Modify: `README.md` if the operator workflow changes
- Modify: `CHANGELOG.md`

**Interfaces:**
- Existing public UUID and decimal-string conventions remain unchanged.
- New/changed responses explicitly include `ready`, `reviewRequired`, warning codes, preview hash, expected balance version, and audit/correlation IDs as applicable.

- [ ] **Step 1: Update the frozen MCP contract.** Mark reads as read-only and correction/reconciliation writes as destructive; keep schemas closed and avoid internal database IDs.
- [ ] **Step 2: Add contract cases for the target workflow.** Cover reverse bad principal payment, correction preview, successful interest-only repost, stale preview, duplicate retry, and unavailable provenance.
- [ ] **Step 3: Update operator-facing guidance.** State that a reverse alone restores the balance but does not convert principal to interest; correction must complete before reconciliation can be posted.
- [ ] **Step 4: Run plugin validator and contract tests.** Confirm manifest/version/skills/evals remain synchronized.

## Task 6: Full verification and controlled production-operation checklist

**Files:**
- No production data files are modified by this task.
- Test/build outputs only.

- [ ] **Step 1: Run backend typecheck and disposable database suites.** Use `backend/scripts/test-disposable-postgres.sh` and run financial test files serially.
- [ ] **Step 2: Run frontend tests, lint, and build.** Confirm no mixed-language or stale workflow copy is introduced.
- [ ] **Step 3: Run MCP/plugin validator and relevant integration tests.** Confirm schemas and destructive-tool metadata.
- [ ] **Step 4: Review the final diff and changelog.** Verify no direct SQL data-repair script, raw evidence logging, floating-point money math, or unrelated dirty-file changes were added.
- [ ] **Step 5: Only after separate explicit approval, execute the target repair in production.** First inspect current intake/loan state, create the correction preview, show the exact second-period `300.00` allocation and warnings, obtain confirmation, execute once with an idempotency key, then verify payment history and loan balances through MCP. Do not merge/deploy or repair other loans as part of this plan.

## Acceptance Criteria

- A weekly floating payment after one advance-covered period is classified as interest for the correct anchored period, not principal.
- The initial advance interest remains paid and non-refundable; no duplicate charge or refund is created.
- Reconciliation preview cannot return `ready` when execute would fail due to unavailable interest provenance.
- A valid correction creates append-only accrual replacements and an auditable interest allocation tied to concrete accrual provenance.
- The payment plugin always performs a no-write execution preflight before asking for confirmation; it never presents confirmation for a plan that backend cannot execute.
- A dry run leaves financial tables, loan balances, posted payments, accrual allocations, and transaction history unchanged.
- The target `300.00` correction is idempotent, atomic, and leaves the original bad transaction immutable.
- All financial tests, typecheck, frontend gates, MCP contract tests, and validators pass.
- No production data is changed until a separate explicit execution confirmation is provided.
