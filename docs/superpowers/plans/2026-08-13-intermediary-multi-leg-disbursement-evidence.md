# Intermediary Multi-Leg Disbursement and Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add reusable intermediary profiles and loan assignments, then reconcile lender funding, split borrower payouts, advance-interest returns, retained balances, and every associated slip without double-posting cash or loan accounting.

**Architecture:** Extend the existing intermediary domain with effective-dated assignments and bank accounts. Introduce disbursement groups containing expected role totals and immutable transfer events; each event owns one or more finalized evidence items. A preview/hash/confirmation transaction posts a zero-variance group and links its borrower payout and advance-interest result to the loan policy delivered by the first plan.

**Tech Stack:** Bun, TypeScript, Elysia, Drizzle ORM, PostgreSQL, `decimal.js`, MinIO signed PUT/head verification, React, TanStack Query, i18next, Vitest, CreditSync MCP/plugin.

## Global Constraints

- Execute after `2026-08-13-floating-weekly-interest-settlement.md`; consume its `floatingInterestPolicy`, `advanceInterest`, and `netBorrowerPayout` projections.
- Profiles use canonical-name/confirmed-alias search before create; bank/payee text alone never resolves identity.
- One logical role may contain multiple transfer events; every event may contain multiple independently viewable evidence items.
- Require exact reconciliation: funding = borrower payout + advance return + explicitly retained balance.
- Do not create borrower payment transactions from disbursement groups or duplicate existing intermediary collection/remittance ledger entries.
- Posted/reversed rows and finalized evidence links are immutable; reversal is compensating, reasoned, idempotent, and audited.
- Evidence follows `prepare -> direct signed PUT -> finalize`; signed URLs, raw QR, and file contents never enter logs/audit.
- All public IDs are UUIDs; all public money values are two-decimal strings calculated with `decimal.js`.
- Update Thai and English copy together. Update `CHANGELOG.md` before every commit and `README.md` for the new workflow.

---

## File Map

- Create `backend/drizzle/0028_intermediary_assignments_disbursement_groups.sql`: profiles extension, assignments, bank accounts, groups/events/evidence/previews.
- Modify `backend/src/db/schema.ts`: new tables/relations and constraints.
- Split focused new logic from `backend/src/services/intermediary-service.ts` into `intermediary-profile-service.ts` and `intermediated-disbursement-service.ts`; preserve collection/remittance behavior.
- Create `backend/src/services/transfer-evidence-service.ts`: reusable group-event evidence lifecycle and access descriptor.
- Modify `backend/src/modules/intermediaries.ts`: profile/detail/assignment routes.
- Create `backend/src/modules/intermediated-disbursements.ts`: group/event/evidence/preview/post/reverse routes.
- Extend MCP server/default and CreditSync plugin with profile, assignment, and disbursement orchestration.
- Replace the single remittance page with intermediary list/detail routes while retaining remittance workspace access.
- Add Loan Detail `Money paths and slips` presentation using `EvidencePreviewButton`.

### Task 1: Persist intermediary profiles, bank accounts, and assignments

**Files:**
- Create: `backend/drizzle/0028_intermediary_assignments_disbursement_groups.sql`
- Create: `backend/src/db/intermediary-assignment-disbursement-migration.test.ts`
- Modify: `backend/src/db/schema.ts`, Drizzle journal/snapshot
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces `intermediaryBankAccounts`, `loanIntermediaryAssignments`, `intermediatedDisbursementGroups`, `intermediatedTransferEvents`, evidence intents/links, and group previews.

- [ ] **Step 1: Write failing migration assertions**

Require tenant-safe compound FKs, role checks (`disbursement|collection|both`), effective-date checks, non-overlapping active assignment protection, supported transfer roles/statuses, exact non-negative amounts, immutable-posted triggers, event idempotency/reference uniqueness, evidence uniqueness, and proposal expiry/hash/version.

- [ ] **Step 2: Run migration test and confirm failure**

Run: `cd backend && bun test src/db/intermediary-assignment-disbursement-migration.test.ts`

- [ ] **Step 3: Add schema/migration and generate snapshot**

Use additive tables; do not alter or backfill existing collections/remittances into disbursement events.

- [ ] **Step 4: Run disposable schema suites**

Run: `backend/scripts/test-disposable-postgres.sh src/db/intermediary-assignment-disbursement-migration.test.ts src/db/intermediary-schema.test.ts src/db/loan-disbursement-migration.test.ts`

- [ ] **Step 5: Update changelog and commit**

```bash
git add CHANGELOG.md backend/drizzle/0028_intermediary_assignments_disbursement_groups.sql backend/drizzle/meta backend/src/db/schema.ts backend/src/db/intermediary-assignment-disbursement-migration.test.ts
git commit -m "feat: persist intermediary loan assignments"
```

### Task 2: Profile, bank-account, assignment, and managed-loan services

**Files:**
- Create: `backend/src/services/intermediary-profile-service.ts`
- Create: `backend/src/services/intermediary-profile-service.test.ts`
- Modify: `backend/src/services/intermediary-service.ts`
- Modify: `backend/src/modules/intermediaries.ts`
- Modify: `backend/src/modules/intermediaries.test.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces `getIntermediaryProfile`, `saveIntermediaryBankAccount`, `assignIntermediaryToLoan`, `endIntermediaryAssignment`, and `listManagedLoans`.

- [ ] **Step 1: Write failing tenant/identity/effective-date tests**

Cover confirmed alias search, reusable masked bank-account output, multiple historical assignments, active managed-loan list, role mismatch, overlapping dates, inactive intermediary, and cross-tenant denial.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `backend/scripts/test-disposable-postgres.sh src/services/intermediary-profile-service.test.ts src/modules/intermediaries.test.ts`

- [ ] **Step 3: Implement focused service and strict REST routes**

Expose safe masked account fields only. Every assignment write is audited and requires idempotency; ending an assignment never deletes it.

- [ ] **Step 4: Run tests/typecheck**

Run the Step 2 command, then `cd backend && bun x tsc --noEmit`.

- [ ] **Step 5: Update changelog and commit**

```bash
git add CHANGELOG.md backend/src/services/intermediary-profile-service* backend/src/services/intermediary-service.ts backend/src/modules/intermediaries*
git commit -m "feat: manage intermediary loan assignments"
```

### Task 3: Disbursement groups, split events, and exact preview

**Files:**
- Create: `backend/src/services/intermediated-disbursement-service.ts`
- Create: `backend/src/services/intermediated-disbursement-service.test.ts`
- Create: `backend/src/modules/intermediated-disbursements.ts`
- Create: `backend/src/modules/intermediated-disbursements.test.ts`
- Modify: `backend/src/index.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces `createIntermediatedDisbursementGroup`, `createTransferEvent`, `list/getIntermediatedDisbursementGroup`, and `previewIntermediatedDisbursement`.
- Preview returns expected/actual totals by role, retained balance, variance, warnings, evidence readiness, proposal UUID/hash/version/expiry.

- [ ] **Step 1: Write failing exact reconciliation tests**

```ts
expect(preview).toMatchObject({
  expectedFunding: "5000.00",
  actualBorrowerPayout: "4400.00",
  actualAdvanceInterestReturn: "600.00",
  retainedBalance: "0.00",
  variance: "0.00",
  status: "ready",
});
```

Also test borrower events `2000 + 2400`, under/over funding, explicit retained balance, inactive assignment, wrong loan/intermediary, duplicate event key/reference, and stale proposal.

- [ ] **Step 2: Run service/route tests and confirm failure**

Run: `backend/scripts/test-disposable-postgres.sh src/services/intermediated-disbursement-service.test.ts src/modules/intermediated-disbursements.test.ts`

- [ ] **Step 3: Implement drafts/events/preview using Decimal and row locks**

Derive expected advance/net amounts from the loan's persisted activation result, not caller arithmetic. Require a disbursement-role assignment effective on each transfer timestamp.

- [ ] **Step 4: Run focused tests/typecheck**

Run Step 2 again, then `cd backend && bun x tsc --noEmit`.

- [ ] **Step 5: Update changelog and commit**

```bash
git add CHANGELOG.md backend/src/index.ts backend/src/services/intermediated-disbursement-service* backend/src/modules/intermediated-disbursements*
git commit -m "feat: reconcile intermediary disbursement paths"
```

### Task 4: Multi-evidence lifecycle and retrieval for every event

**Files:**
- Create: `backend/src/services/transfer-evidence-service.ts`
- Create: `backend/src/services/transfer-evidence-service.test.ts`
- Modify: `backend/src/modules/intermediated-disbursements.ts`
- Modify: `backend/src/modules/intermediated-disbursements.test.ts`
- Modify: existing evidence-access module/routes as appropriate
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces `prepareTransferEvidence`, `finalizeTransferEvidence`, `listTransferEvidence`, and `getTransferEvidenceAccess`.

- [ ] **Step 1: Write failing lifecycle tests**

Cover multiple evidence items on one event, separate evidence on split events, ready retry without re-upload, expiry, MIME/size/SHA/metadata mismatch, duplicate provenance, cross-tenant access, short-lived retrieval descriptor, and immutable post link.

- [ ] **Step 2: Run focused evidence tests and confirm failure**

Run: `backend/scripts/test-disposable-postgres.sh src/services/transfer-evidence-service.test.ts src/modules/intermediated-disbursements.test.ts`

- [ ] **Step 3: Implement prepare/finalize/retrieve with MinIO metadata checks**

Object metadata includes tenant, group, and event public UUID. Audit only public IDs/checksum/status, never URL/header/content.

- [ ] **Step 4: Run evidence and existing disbursement/remittance evidence suites**

Run: `backend/scripts/test-disposable-postgres.sh src/services/transfer-evidence-service.test.ts src/services/loan-disbursement-service.test.ts src/services/intermediary-service.test.ts`

- [ ] **Step 5: Update changelog and commit**

```bash
git add CHANGELOG.md backend/src/services/transfer-evidence-service* backend/src/modules/intermediated-disbursements*
git commit -m "feat: attach slips to intermediary transfers"
```

### Task 5: Atomic post, loan linkage, held balance, and reversal

**Files:**
- Modify: `backend/src/services/intermediated-disbursement-service.ts`
- Modify: `backend/src/services/intermediated-disbursement-service.test.ts`
- Modify: `backend/src/services/loan-disbursement-service.ts`
- Modify: `backend/src/services/intermediary-service.ts`
- Modify: `backend/src/modules/intermediated-disbursements.ts`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces `postIntermediatedDisbursement(ctx, groupPublicId, proposalPublicId, confirmed)` and `reverseIntermediatedDisbursement(ctx, groupPublicId, reason)`.

- [ ] **Step 1: Write failing atomicity/no-double-post tests**

Assert one balanced post records borrower actual payout THB 4,400, advance interest THB 600 once, lender funding THB 5,000, intermediary held balance zero, and no borrower repayment transaction. Test missing evidence supplied by operator, concurrent post, replay key, stale proposal, non-zero variance, and compensating reversal.

- [ ] **Step 2: Run financial integration tests and confirm failure**

Run: `backend/scripts/test-disposable-postgres.sh src/services/intermediated-disbursement-service.test.ts src/services/loan-disbursement-service.test.ts src/services/intermediary-service.test.ts`

- [ ] **Step 3: Implement one locked transaction and ledger projections**

Do not force existing `grossAmount/loanAttributedAmount` variance semantics to represent all three legs. Link the group to the loan's actual payout projection and advance charge via public provenance IDs.

- [ ] **Step 4: Run financial suites and typecheck**

Run Step 2 again, then `cd backend && bun x tsc --noEmit`.

- [ ] **Step 5: Update changelog and commit**

```bash
git add CHANGELOG.md backend/src/services/intermediated-disbursement-service* backend/src/services/loan-disbursement-service.ts backend/src/services/intermediary-service.ts backend/src/modules/intermediated-disbursements.ts
git commit -m "feat: post intermediary disbursements atomically"
```

### Task 6: REST/MCP/plugin orchestration and frozen contract

**Files:**
- Modify: `backend/src/mcp/server.ts`, `backend/src/mcp/default.ts`, tests/snapshot
- Modify: `plugins/creditsync/.codex-plugin/plugin.json`, docs/changelog
- Create: `plugins/creditsync/skills/manage-intermediated-disbursements/SKILL.md`
- Modify: root routing, intermediary/disbursement skills, contract, validator, evals/harness/tests
- Modify: `README.md`, `CHANGELOG.md`

**Interfaces:**
- Produces profile/assignment reads and writes plus group/event/evidence/preview/post/reverse MCP tools with closed schemas.

- [ ] **Step 1: Write failing contract and eval tests first**

Positive case: search exact borrower/intermediary → inspect assignment → create group/events → finalize three slips → inspect zero variance → explicit confirm → post. Negative cases: ambiguity, missing assignment/evidence, duplicate, mismatch, retained unexplained balance, stale preview, missing confirmation.

- [ ] **Step 2: Run backend MCP and plugin suites to confirm failure**

Run: `cd backend && bun test src/mcp/server.test.ts src/mcp/default.test.ts`

Run: `cd plugins/creditsync && bun test`

- [ ] **Step 3: Implement direct service handlers and synchronize all plugin artifacts**

Mark reads read-only and post/reverse destructive. Never expose signed URLs in general tool output; evidence access remains an authorized UI/API retrieval.

- [ ] **Step 4: Run strict validation**

Run: `cd backend && bun test src/mcp/server.test.ts src/mcp/default.test.ts && bun x tsc --noEmit`

Run: `cd plugins/creditsync && bun test && bun run validate`

- [ ] **Step 5: Update README/changelogs and commit**

```bash
git add CHANGELOG.md README.md backend/src/mcp plugins/creditsync
git commit -m "feat: orchestrate intermediary disbursements"
```

### Task 7: Intermediary list/detail and managed-loan UI

**Files:**
- Create: `frontend/src/pages/dashboard/intermediaries/IntermediaryList.tsx`
- Create: `frontend/src/pages/dashboard/intermediaries/IntermediaryDetail.tsx`
- Modify: `frontend/src/pages/dashboard/intermediaries/IntermediaryRemittances.tsx`
- Modify: `frontend/src/App.tsx`, `frontend/src/layouts/DashboardLayout.tsx`
- Modify: locales
- Create: `frontend/tests/intermediary-profile.vitest.tsx`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes profile overview, managed loans, assignments, balance, and unreconciled groups from Tasks 2–5.

- [ ] **Step 1: Write failing UI tests**

Assert search/create profile, active managed-loan list linking to Loan Detail, historical assignments, exact overview totals, unreconciled warning, and retained access to collections/remittances.

- [ ] **Step 2: Run test and confirm failure**

Run: `cd frontend && bun test tests/intermediary-profile.vitest.tsx`

- [ ] **Step 3: Implement localized responsive routes**

Use flat mobile divider rows and comparison-friendly desktop tables. Do not show raw account numbers; use backend masked values.

- [ ] **Step 4: Run focused test/lint/build**

Run: `cd frontend && bun test tests/intermediary-profile.vitest.tsx && bun run lint && bun run build`

- [ ] **Step 5: Update changelog and commit**

```bash
git add CHANGELOG.md frontend/src/App.tsx frontend/src/layouts/DashboardLayout.tsx frontend/src/pages/dashboard/intermediaries frontend/src/locales frontend/tests/intermediary-profile.vitest.tsx
git commit -m "feat: show intermediary managed loans"
```

### Task 8: Money paths, split transfers, and every slip in Web UI

**Files:**
- Create: `frontend/src/pages/dashboard/loans/IntermediatedDisbursementPanel.tsx`
- Create: `frontend/src/pages/dashboard/intermediaries/IntermediaryTransferLedger.tsx`
- Modify: `frontend/src/pages/dashboard/loans/LoanDetail.tsx`
- Reuse/modify: `frontend/src/components/evidence/EvidencePreviewButton.tsx`
- Modify: locales
- Create: `frontend/tests/intermediated-disbursement-flow.vitest.tsx`
- Modify: `README.md`, `CHANGELOG.md`

**Interfaces:**
- Consumes group/event/evidence DTOs and authorized evidence-access endpoint.

- [ ] **Step 1: Write failing flow tests**

Render three roles, split THB 4,400 into THB 2,000 + 2,400, expose one `View slip` action per finalized evidence item, show sender/payee/date/reference/status, and block confirmation on non-zero variance or non-ready supplied evidence.

- [ ] **Step 2: Run focused test and confirm failure**

Run: `cd frontend && bun test tests/intermediated-disbursement-flow.vitest.tsx`

- [ ] **Step 3: Implement group/event/evidence UI and explicit confirmation**

Resolve signed evidence only after the user selects `View slip`. Do not cache signed URLs beyond the preview component lifetime.

- [ ] **Step 4: Run frontend gates**

Run: `cd frontend && bun test tests/intermediated-disbursement-flow.vitest.tsx tests/evidence-preview-button.vitest.tsx && bun run lint && bun run build`

- [ ] **Step 5: Update README/changelog and commit**

```bash
git add CHANGELOG.md README.md frontend/src/pages/dashboard/loans frontend/src/pages/dashboard/intermediaries frontend/src/components/evidence frontend/src/locales frontend/tests/intermediated-disbursement-flow.vitest.tsx
git commit -m "feat: inspect intermediary money paths"
```

### Task 9: End-to-end verification and read-only production checks

**Files:**
- Modify only files required by a verified defect, with matching changelog entry.

- [ ] **Step 1: Run serialized backend suites**

Run: `backend/scripts/test-disposable-postgres.sh src/services/intermediary-profile-service.test.ts src/services/intermediated-disbursement-service.test.ts src/services/transfer-evidence-service.test.ts src/services/loan-disbursement-service.test.ts src/services/intermediary-service.test.ts src/modules/intermediated-disbursements.test.ts src/mcp/default.test.ts`

- [ ] **Step 2: Run type, frontend, and plugin gates**

Run: `cd backend && bun x tsc --noEmit`

Run: `cd frontend && bun test && bun run lint && bun run build`

Run: `cd plugins/creditsync && bun test && bun run validate`

- [ ] **Step 3: Verify no native-number financial conversion and no sensitive logging**

Run: `rg -n "Number\(|parseFloat\(|parseInt\(|uploadUrl|signedUrl|qrPayload" backend/src/services/intermediated-disbursement-service.ts backend/src/services/transfer-evidence-service.ts frontend/src/pages/dashboard/intermediaries frontend/src/pages/dashboard/loans/IntermediatedDisbursementPanel.tsx`

Review every match; money must remain Decimal/string and sensitive URLs/payloads must not be logged.

- [ ] **Step 4: Verify production-style migration, MCP health, frontend health, and read-only reconciliation**

Use the documented Compose commands. Inspect tables/constraints and backend migration logs, call MCP health inside the backend container, check the public frontend, and query an existing authorized group only if one exists. Do not create test financial records in a live tenant.

- [ ] **Step 5: Commit only verified corrections**

If no defect is found, do not create a verification-only commit.
