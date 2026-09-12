# Intermediary Remittance Chronology Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make intermediary remittance Preview and Post use one deterministic effective-time ordering so valid floating-loan batches cannot fail because database row order differs from the confirmed proposal.

**Architecture:** Keep `intermediaryRemittanceAllocations.allocationOrder` as selection metadata, but normalize the loaded collection rows through one canonical chronological sorter before calculating the remittance state hash, returning Preview IDs, or iterating Post. The sorter will order by `borrowerPaidAt`, then `createdAt`, then `publicId`; floating chronology safety guards remain unchanged and continue to evaluate each loan independently.

**Tech Stack:** Bun, TypeScript, Drizzle ORM, PostgreSQL, `bun:test`, Decimal.js financial values.

**Spec:** `/home/flintstone/.codex/attachments/0fe86b47-1f91-4eab-be1c-4698b968681c/pasted-text.txt`

## Global Constraints

- Do not post remittance `01a096f8-ca59-7b48-948a-daab76d71442` or mutate production financial records.
- Do not disable or weaken `FLOATING_BACKDATED_ALLOCATION_REQUIRES_RECONCILIATION`.
- Use backend-defined timestamps and two-decimal money strings; do not recreate accounting calculations in tests or production code.
- Preserve atomic remittance posting and idempotency; a failed post must leave all selected collections and payment ledgers unchanged.
- Preserve unrelated working-tree changes on `main`; implementation occurs on `codex/intermediary-remittance-chronology`.
- Update `CHANGELOG.md` before any commit; no commit will be made until verification is complete.

---

### Task 1: Add failing chronology regression coverage

**Files:**
- Modify: `backend/src/services/intermediary-service.test.ts`

**Interfaces:**
- Consumes: Existing intermediary collection/remittance service functions and database fixtures.
- Produces: Failing tests that demonstrate nondeterministic selection order, same-time tie breaking, multi-loan isolation, genuine backdated rejection, preview/post parity, reversed-input invariance, and atomic failure behavior.

- [x] **Step 1: Add a pure sorter contract test** for `sortIntermediaryCollectionsChronologically` using three synthetic rows supplied as Sep 9, Sep 8, Sep 10 and asserting Sep 8, Sep 9, Sep 10.
- [x] **Step 2: Add deterministic tie-breaker tests** with equal `borrowerPaidAt`, first differing `createdAt`, then equal `createdAt` and different `publicId`; assert the same result for repeated and reversed inputs.
- [x] **Step 3: Add an integration test** that creates one floating loan and three collections in Sep 9, Sep 8, Sep 10 order, saves the remittance with reversed/randomized IDs, previews it, posts the confirmed Preview, and asserts transaction dates are Sep 8, Sep 9, Sep 10.
- [x] **Step 4: Add a multi-loan integration test** with one floating loan and one scheduled/non-floating loan; assert unrelated-loan rows do not create a false floating backdated error and each loan's posted dates remain monotonic.
- [x] **Step 5: Add a genuine-backdated integration test** with an immutable later floating repayment already posted; assert posting the older collection still returns `FLOATING_BACKDATED_ALLOCATION_REQUIRES_RECONCILIATION`.
- [x] **Step 6: Add Preview/Post parity and atomicity assertions**: the Preview's normalized collection IDs must match the service's posting sequence, and a rejected post must leave transaction, intake, collection, and remittance states unchanged.
- [x] **Step 7: Run the focused test file** with `TEST_DATABASE_URL` configured and verify the new tests fail for the missing ordering behavior rather than due to syntax or fixture errors.

### Task 2: Implement one canonical collection ordering path

**Files:**
- Modify: `backend/src/services/intermediary-service.ts:368-372`

**Interfaces:**
- Consumes: Loaded `intermediaryCollections` rows and their persisted `borrowerPaidAt`, `createdAt`, and `publicId` values.
- Produces: `sortIntermediaryCollectionsChronologically<T>()` and a `remittanceSelection()` result whose `collections` array is normalized identically for Preview and Post.

- [x] **Step 1: Define the sorter input contract** as a generic row requiring `borrowerPaidAt: Date`, `createdAt: Date`, and `publicId: string`, so unit tests do not need database-only fields.
- [x] **Step 2: Implement a non-mutating stable comparator** with keys `borrowerPaidAt.getTime()`, `createdAt.getTime()`, and `publicId.localeCompare`; return a copied array.
- [x] **Step 3: Update `remittanceSelection()`** to map the selected collection rows from the allocation query and pass them through the sorter; do not use `IN` result order or caller-supplied ID order.
- [x] **Step 4: Keep Preview and Post on the same `remittanceSelection()` result** so the state hash, Preview response, and Post loop share identical normalized semantics.
- [x] **Step 5: Preserve per-loan safety semantics** by leaving `postPayment()` and `assertNoLaterFloatingPayment()` unchanged; global iteration may interleave loans, but the guard continues to filter by `loan_id`.
- [x] **Step 6: Run the focused tests** and verify the new chronology and parity tests pass without modifying the reconciliation guard.

### Task 3: Verify affected behavior and production safety

**Files:**
- Modify: `CHANGELOG.md` only if a commit is created, under a new explicit version/date heading.

**Interfaces:**
- Consumes: Updated intermediary service and regression suite.
- Produces: Verified code diff and read-only Preview result for the affected remittance.

- [x] **Step 1: Run focused service tests** using `bun test backend/src/services/intermediary-service.test.ts` or the repository's disposable PostgreSQL harness when integration tests require it.
- [x] **Step 2: Run related chronology/reconciliation tests** covering `payment-chronology-service`, floating allocation regressions, payment reconciliation, and intermediary remittance behavior.
- [x] **Step 3: Run backend typecheck** with `bun run typecheck`.
- [x] **Step 4: Inspect the diff and verify** no changes touch the production remittance, no financial write tools were called, and no unrelated dirty files were copied into the branch.
- [x] **Step 5: Use only the read-only/preview MCP calls** for remittance `01a096f8-ca59-7b48-948a-daab76d71442`; do not call remittance Post.
- [x] **Step 6: Report root cause, changed functions, ordering rule, unchanged safety guard, tests, preview result, and confirmation that no production financial records were mutated.
