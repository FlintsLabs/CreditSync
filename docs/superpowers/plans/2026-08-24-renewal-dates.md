# Renewal Effective and Payment Start Dates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add explicit, persisted daily-renewal effective and payment-start dates so a renewal can start on one business date and collect its first installment on a different date.

**Architecture:** Extend the renewal service input and `loan_renewals` persistence with frozen date fields. Preview validates and hashes the selected dates while calculating the old-loan composition as of the effective date; execute reuses those dates, rejects post-effective activity, and passes both dates into replacement schedule generation. Keep omitted fields backward compatible for legacy MCP clients and existing renewal rows.

**Tech Stack:** Bun, TypeScript, Elysia/MCP, Drizzle ORM, PostgreSQL, Decimal.js, Bun tests, CreditSync plugin JSON/TypeScript validator.

**Spec:** `docs/superpowers/specs/2026-08-24-renewal-dates-design.md`

## Global Constraints

- Money crosses public interfaces as two-decimal decimal strings and uses `decimal.js`; never use JavaScript floating point for financial values.
- Use `Asia/Bangkok` business dates, ISO timestamps, and `YYYY-MM-DD` due dates.
- Renewal remains `preview -> explicit confirmation -> execute`; execute must use the exact unchanged preview hash/state.
- Active loan terms and posted financial records remain immutable; changes use append-only correction/reversal semantics.
- Preserve unrelated dirty frontend changes; do not stage or modify them unless a task explicitly requires the renewal UI.
- Before any commit, update `CHANGELOG.md` under an explicit version/date heading and commit it with the described changes.

### Task 1: Add failing service tests for explicit renewal dates

**Files:**
- Modify: `backend/src/services/loan-renewal-service.test.ts`
- Read: `backend/src/services/loan-renewal-service.ts`, `backend/src/lib/loan-schedule.ts`

**Interfaces:**
- Consumes: Existing `previewLoanRenewal` and `executeLoanRenewal` service APIs.
- Produces: Failing regression cases that define `renewalDate`, `paymentStartDate`, date validation, and frozen execution behavior.

- [ ] **Step 1: Add a test that preview returns explicit dates and uses them in composition.**

  Seed a daily loan with a known schedule and use a fixed system clock. Call:

  ```ts
  const preview = await previewLoanRenewal(ctx, oldLoan.publicId, {
      requestedPrincipal: "2000.00",
      renewalDate: "2026-08-22",
      paymentStartDate: "2026-08-23",
  });

  expect(preview.renewalDate).toBe("2026-08-22");
  expect(preview.paymentStartDate).toBe("2026-08-23");
  expect(preview.composition.renewalDate).toBe("2026-08-22");
  ```

- [ ] **Step 2: Add a test that execute creates the replacement with the requested start and first due dates.**

  Execute the exact preview and assert the new loan has `startDate = "2026-08-22"`, `paymentStartDate = "2026-08-23"`, and its first schedule due date is `2026-08-23`.

- [ ] **Step 3: Add validation tests for ordering and future dates.**

  Assert these calls reject with exact domain codes:

  ```ts
  await expect(previewLoanRenewal(ctx, loanId, {
      requestedPrincipal: "2000.00",
      renewalDate: "2026-08-22",
      paymentStartDate: "2026-08-21",
  })).rejects.toMatchObject({ code: "PAYMENT_START_DATE_BEFORE_RENEWAL" });
  ```

  Also cover a renewal date before the old loan start and a renewal date after the Bangkok business date.

- [ ] **Step 4: Add a test rejecting posted activity after a backdated renewal date.**

  Seed or post a transaction dated after `renewalDate`, then assert preview fails with `RENEWAL_DATE_AFTER_POSTED_ACTIVITY` rather than silently excluding the activity.

- [ ] **Step 5: Add compatibility tests for omitted dates and legacy renewal rows.**

  Assert omitted dates retain the current default behavior and a legacy renewal with no stored payment-start date can still execute without changing its generated schedule semantics.

- [ ] **Step 6: Run only the targeted service tests and confirm RED.**

  Run:

  ```bash
  bun test backend/src/services/loan-renewal-service.test.ts
  ```

  Expected: the new tests fail because the input type, persistence, output, and execute behavior do not yet support explicit dates.

### Task 2: Implement date parsing, validation, and as-of snapshot semantics

**Files:**
- Modify: `backend/src/services/loan-renewal-service.ts`
- Test: `backend/src/services/loan-renewal-service.test.ts`
- Read: `backend/src/lib/loan-renewal-composition.ts`

**Interfaces:**
- Consumes: Failing tests from Task 1 and existing `RenewalComposition` fields.
- Produces: `PreviewLoanRenewalInput` with optional `renewalDate`/`paymentStartDate`; deterministic date helpers; snapshots calculated as of the selected effective date.

- [ ] **Step 1: Add typed optional date fields and strict `YYYY-MM-DD` parsing helpers.**

  Add:

  ```ts
  export interface PreviewLoanRenewalInput {
      requestedPrincipal: string;
      renewalDate?: string;
      paymentStartDate?: string;
      settlementPolicy?: RenewalSettlementPolicy;
      adjustments?: RenewalManualAdjustment[];
      waivedCharges?: string;
      waiverReason?: string;
  }
  ```

  Parse dates as Asia/Bangkok business dates, reject malformed values with `INVALID_RENEWAL_DATE`, and avoid `new Date("YYYY-MM-DD")` comparisons that shift across timezones.

- [ ] **Step 2: Validate dates against the old loan and current business date.**

  Resolve the default renewal date to the current Bangkok business date only when omitted. Resolve an omitted payment-start date to `undefined` to preserve legacy schedule behavior. Reject dates with the exact domain codes from the spec.

- [ ] **Step 3: Make renewal snapshots use the selected date.**

  Pass a date representing the selected Bangkok business date to `renewalSnapshot`. Filter repayment activity used for composition to activity on or before that date, and reject any old-loan repayment/reversal after the selected date with `RENEWAL_DATE_AFTER_POSTED_ACTIVITY`. Keep the complete ledger in the state hash so a later write makes the preview stale.

- [ ] **Step 4: Include both dates in the preview hash, audit payload, and public preview output.**

  Add `renewalDate` and `paymentStartDate` to the hash payload and `presentPreview` result. Ensure the composition's `renewalDate` is the selected date rather than the wall-clock date.

- [ ] **Step 5: Run targeted tests and make them GREEN.**

  Run:

  ```bash
  bun test backend/src/services/loan-renewal-service.test.ts
  ```

  Expected: Task 1 tests pass, except execute/schedule assertions that require Task 3.

### Task 3: Persist dates and use them during renewal execution

**Files:**
- Modify: `backend/src/db/schema.ts`
- Create: `backend/drizzle/0055_renewal_effective_payment_dates.sql`
- Modify: `backend/src/services/loan-renewal-service.ts`
- Test: `backend/src/services/loan-renewal-service.test.ts`
- Test: `backend/src/db/loan-renewal-hardening-migration.test.ts`

**Interfaces:**
- Consumes: Date values and frozen hashes from Task 2.
- Produces: Persisted `loan_renewals.renewal_date` and nullable `loan_renewals.payment_start_date`; execute behavior that creates replacement loans with frozen dates.

- [ ] **Step 1: Add a failing migration/schema assertion.**

  Assert Drizzle exposes `renewalDate` and `paymentStartDate` on `loanRenewals` and the migration journal includes `0055_renewal_effective_payment_dates`.

- [ ] **Step 2: Add the additive migration.**

  Add nullable `date` columns to `loan_renewals`. Backfill `renewal_date` from `preview_snapshot.composition.renewalDate` where available; leave `payment_start_date` null for legacy rows. Do not rewrite executed financial records.

- [ ] **Step 3: Persist the resolved dates during preview.**

  Store `renewalDate` for every new preview and `paymentStartDate` when explicitly resolved. Keep legacy null semantics for rows predating this feature.

- [ ] **Step 4: Change execute to use frozen dates and re-snapshot as of the frozen renewal date.**

  Replace `const effectiveAt = new Date()` for financial date calculations with the persisted renewal business date while retaining wall-clock time for expiry/audit timestamps. Recompute the hash with the frozen dates and reject stale state.

- [ ] **Step 5: Pass both dates into schedule generation and persist the replacement loan field.**

  Change the execute path to:

  ```ts
  const startDate = renewal.renewalDate ?? legacyRenewalDate;
  const paymentStartDate = renewal.paymentStartDate ?? undefined;
  generated = generateLoanSchedule({
      principal: renewal.requestedPrincipal,
      interestRate: oldLoan.interestRate,
      termMonths: oldLoan.termMonths,
      repaymentType: oldLoan.repaymentType as "daily",
      startDate,
      paymentStartDate,
      totalInstallments: oldLoan.totalInstallments ?? undefined,
      installmentAmount: oldLoan.installmentAmount ?? undefined,
  });
  ```

  Set the new loan's `startDate` and `paymentStartDate` to those exact values. Preserve legacy behavior when `payment_start_date` is null.

- [ ] **Step 6: Run targeted service and migration tests.**

  Run:

  ```bash
  bun test backend/src/services/loan-renewal-service.test.ts backend/src/db
  ```

  Expected: all date, execution, legacy, and schema tests pass.

### Task 4: Extend MCP schemas and handler mapping

**Files:**
- Modify: `backend/src/mcp/server.ts`
- Modify: `backend/src/mcp/default.ts`
- Test: `backend/src/mcp/server.test.ts`
- Test: `backend/src/mcp/default.test.ts`

**Interfaces:**
- Consumes: Service input/output from Tasks 2–3.
- Produces: Closed MCP `renewal.preview` input with optional `renewalDate` and `paymentStartDate`; output with frozen dates; unchanged execute request shape.

- [ ] **Step 1: Add failing MCP schema tests.**

  Add a real-adapter/server test that sends both date fields, asserts the handler receives them, and asserts the response returns them. Add a compatibility test that omits both fields and remains accepted.

- [ ] **Step 2: Extend the closed Zod input schema.**

  Add `renewalDate: date.optional()` and `paymentStartDate: date.optional()` to `renewal.preview` in `backend/src/mcp/server.ts`.

- [ ] **Step 3: Map the fields in the default MCP handler.**

  Pass the two input values through to `previewLoanRenewal` without changing `renewal.execute`.

- [ ] **Step 4: Extend the strict renewal output schema.**

  Add `renewalDate` and nullable `paymentStartDate` to `renewalOutput`, preserving schema version and closed-object behavior.

- [ ] **Step 5: Run MCP tests and contract checks.**

  Run:

  ```bash
  bun test backend/src/mcp/server.test.ts backend/src/mcp/default.test.ts
  ```

  Expected: MCP accepts explicit dates, rejects unknown fields, and preserves omission compatibility.

### Task 5: Synchronize plugin guidance, manifest, evals, and validator

**Files:**
- Modify: `plugins/creditsync/skills/renew-daily-loan/SKILL.md`
- Modify: `plugins/creditsync/README.md`
- Modify: `plugins/creditsync/references/mcp-tool-contract.json`
- Modify: `plugins/creditsync/scripts/mcp-contract.ts`
- Modify: `plugins/creditsync/package.json` only if the release/version tests require a bump
- Modify: `plugins/creditsync/evals/evals.json`
- Modify: `plugins/creditsync/evals/harness.ts`
- Modify: `plugins/creditsync/scripts/validate.ts`
- Test: `plugins/creditsync/tests/plugin-contract.test.ts`
- Test: `plugins/creditsync/tests/operations-docs.test.ts`

**Interfaces:**
- Consumes: MCP contract from Task 4.
- Produces: Versioned plugin documentation and eval coverage for explicit renewal dates.

- [ ] **Step 1: Add a failing contract/eval assertion.**

  Assert the renewal preview contract documents and accepts `renewalDate` and `paymentStartDate`, and that the eval fixture expects both values in preview output.

- [ ] **Step 2: Update the renewal skill.**

  Require agents to ask for or resolve both dates, show them in the exact preview summary, and stop before execute if the dates do not match the operator's request. State that `paymentStartDate` is not assumed to be the next day.

- [ ] **Step 3: Add positive and negative eval scenarios.**

  Add a positive case for renewal on 2026-08-22 with first payment on 2026-08-23 and a negative case that forbids execute when the preview's dates differ from the requested dates.

- [ ] **Step 4: Update contract version/manifest only according to repository release discipline.**

  Use the next plugin version required by the current manifest/version tests, update the frozen contract snapshot, and keep all eleven skills synchronized. Do not invent a separate public field or open-ended schema.

- [ ] **Step 5: Run plugin tests and validator.**

  Run:

  ```bash
  bun test plugins/creditsync/tests/plugin-contract.test.ts plugins/creditsync/tests/operations-docs.test.ts
  bun plugins/creditsync/scripts/validate.ts
  ```

### Task 6: Add frontend renewal date controls if the existing renewal UI exposes preview

**Files:**
- Modify: `backend/src/modules/loan-renewals.ts`
- Test: `backend/src/modules/loan-renewals.test.ts`
- Modify: `frontend/src/pages/dashboard/loans/LoanRenewalPanel.tsx`
- Modify: `frontend/src/pages/dashboard/loans/loan-renewal-model.ts`
- Modify: `frontend/src/locales/en.json`
- Modify: `frontend/src/locales/th.json`
- Test: `frontend/tests/LoanRenewalPanel.test.tsx`
- Test: `frontend/tests/loan-renewal-model.test.ts`

**Interfaces:**
- Consumes: REST/MCP-equivalent backend fields from Tasks 2–4.
- Produces: Localized date inputs for renewal effective date and payment-start date, backend-owned preview display, and confirmation invalidation when either date changes.

- [ ] **Step 1: Locate the existing renewal form and add a failing UI test.**

  Extend `frontend/tests/LoanRenewalPanel.test.tsx` to assert the form submits both dates, displays the returned dates, and invalidates the previous confirmation after editing either date. Extend `backend/src/modules/loan-renewals.test.ts` for REST request/response mapping.

- [ ] **Step 2: Add localized labels/help text in both locale files.**

  Explain “Renewal effective date” and “First payment date” without mixing Thai and English in the same flow.

- [ ] **Step 3: Implement date controls using `YYYY-MM-DD` values.**

  In `LoanRenewalPanel.tsx`, default to the current/backend-provided values, prevent payment start before renewal in the UI, pass the values through `loan-renewal-model.ts`, and leave authoritative validation to the backend. Update the loan preview request to use the selected renewal and payment-start dates.

- [ ] **Step 4: Run the targeted frontend test, lint, and typecheck.**

  Run the repository's frontend commands from `frontend/package.json`, including the targeted test and build/typecheck gates.

### Task 7: Full verification, documentation, and handoff

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `README.md` only if user-facing setup/operation documentation changes
- Inspect: all staged files and existing dirty-file ownership

**Interfaces:**
- Consumes: Completed implementation from Tasks 1–6.
- Produces: Verified feature, synchronized docs, and a clean scoped diff ready for review.

- [ ] **Step 1: Run backend disposable PostgreSQL tests serially.**

  Run:

  ```bash
  backend/scripts/test-disposable-postgres.sh
  ```

- [ ] **Step 2: Run backend typecheck and relevant MCP/plugin tests.**

  Run the backend typecheck command from `backend/package.json`, the renewal/MCP test files, plugin tests, and validator. Treat skipped database tests as insufficient.

- [ ] **Step 3: Run frontend test/lint/build gates if Task 6 changed the UI.**

  Use the exact Bun scripts in `frontend/package.json` and report any pre-existing dirty-file failures separately.

- [ ] **Step 4: Review the final diff for financial invariants.**

  Verify exact date persistence, schedule first due date, legacy fallback, stale hash behavior, no floating-point money arithmetic, audit/correlation context, and no raw slip/account data in logs or docs.

- [ ] **Step 5: Update `CHANGELOG.md` and `README.md` if required, then commit the scoped implementation.**

  Stage only files owned by this feature and the changelog entry. Do not stage the user's unrelated frontend changes. Use a concise feature commit message.

- [ ] **Step 6: Report verification results and distinguish preview, execution, and deployment.**

  State what was implemented, exact test commands/results, any preserved unrelated changes, and that no production deployment or external push occurred unless separately authorized.
