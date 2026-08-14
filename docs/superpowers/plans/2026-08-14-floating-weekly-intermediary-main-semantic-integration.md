# Floating Weekly and Intermediary Main Semantic Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Semantically integrate the weekly floating-interest and intermediary multi-leg feature branch after main's immutable `0027–0035` single-payment/restructure migration series.

**Architecture:** Preserve main as the authority for single-payment/restructure behavior and add one tail migration, `0036_floating_weekly_intermediary_integration`, containing only the feature-branch schema delta. Validate the merge at database, service, REST/MCP/plugin, and Web boundaries before committing the dirty integration as one changelog-described unit.

**Tech Stack:** Bun, TypeScript, Elysia, Drizzle/PostgreSQL, Decimal.js, React 19, Vitest, i18next, MCP SDK, CreditSync Codex plugin.

## Global Constraints

- Do not modify or replay main migrations `0027–0035`; `0036` is the sole additive integration migration.
- Main behavior/contracts govern single-payment, waiver, opening-balance, and restructure workflows.
- Preserve all weekly floating-interest settlement and intermediary multi-leg functionality additively.
- Public money remains exact two-decimal strings with `FinancialDecimal`; never use native-number financial arithmetic.
- Preserve append-only ledgers, immutable activated terms, compensating reversal, command context, audit IDs, correlation IDs, and idempotency.
- Keep English/Thai copy synchronized and use `Asia/Bangkok` for business dates.
- MCP must call services directly; frozen server/plugin contracts and evals remain synchronized.
- Update `CHANGELOG.md` before the integration commit and do not deploy production.

---

### Task 1: Prove migration lineage and the main-through-0035 upgrade boundary

**Files:**
- Create: `backend/src/db/floating-weekly-intermediary-integration-migration.test.ts`
- Modify: existing migration static tests that assumed `0027–0029` or the journal tail
- Modify: `backend/drizzle/0036_floating_weekly_intermediary_integration.sql`
- Modify: `backend/drizzle/meta/0028_snapshot.json`
- Modify: `backend/drizzle/meta/0029_snapshot.json`
- Create: `backend/drizzle/meta/0036_snapshot.json`
- Modify: `backend/drizzle/meta/_journal.json`

**Interfaces:**
- Consumes: immutable main migrations `0027–0035` and the schema represented by `0035`.
- Produces: an additive `0036` migration and snapshot that introduce only weekly-floating/intermediary deltas.

- [ ] **Step 1: Write failing static lineage tests**

Assert literal journal order `0027_single_payment_restructure` through `0035_disbursement_restructure_relation`, followed only by `0036_floating_weekly_intermediary_integration`. Assert the removed branch-local migration tags/files are absent and main SQL files are unchanged from merge parent `5268363`.

- [ ] **Step 2: Run static tests and record RED**

Run: `cd backend && bun test src/db/floating-weekly-intermediary-integration-migration.test.ts src/db/floating-interest-period-policy-migration.test.ts src/db/intermediary-assignment-disbursement-migration.test.ts`

Expected: fail against the incomplete consolidated migration/snapshot assumptions.

- [ ] **Step 3: Add a main-through-0035 upgrade test**

Create a disposable PostgreSQL database, apply migrations through `0035`, seed representative single-payment/restructure/floating rows, capture exact financial rows, apply only `0036`, and assert:

```ts
expect(after.transactions).toEqual(before.transactions);
expect(after.loanSchedules).toEqual(before.loanSchedules);
expect(after.openingBalances).toEqual(before.openingBalances);
expect(integrationTables).toEqual(expect.arrayContaining([
  "loan_settlement_previews",
  "intermediated_disbursement_groups",
]));
```

- [ ] **Step 4: Complete `0036` and generated metadata**

Consolidate the net branch SQL after main `0035`, removing definitions already supplied by main. Preserve deterministic backfills, tenant keys, money checks, exclusion constraints, immutable-posted/evidence/accrual triggers, and settlement preview ownership.

- [ ] **Step 5: Run focused migration tests to GREEN**

Run: `backend/scripts/test-disposable-postgres.sh src/db/floating-weekly-intermediary-integration-migration.test.ts src/db/floating-interest-period-policy-migration.test.ts src/db/intermediary-assignment-disbursement-migration.test.ts src/db/floating-interest-accrual-immutability-migration.test.ts`

Expected: clean install and main-through-0035 upgrade both pass with unchanged seeded financial rows.

### Task 2: Reconcile shared financial and lifecycle behavior

**Files:**
- Modify only verified conflicts in `backend/src/lib`, `backend/src/services`, and `backend/src/modules`
- Modify matching tests beside each changed implementation

**Interfaces:**
- Consumes: main single-payment/restructure terms and branch weekly-floating/intermediary services.
- Produces: one composed implementation preserving both public behaviors.

- [ ] **Step 1: Run focused overlap suites and record every RED**

Run serialized:

```bash
backend/scripts/test-disposable-postgres.sh \
  src/services/loan-application-service.test.ts \
  src/services/floating-interest-service.test.ts \
  src/services/loan-settlement-service.test.ts \
  src/services/loan-restructure-service.test.ts \
  src/services/payment-service.test.ts \
  src/services/intermediated-disbursement-service.test.ts \
  src/services/transfer-evidence-service.test.ts
```

- [ ] **Step 2: Diagnose each failure to a merge-parent semantic difference**

For every failure, compare `5268363:<path>`, `5e14785:<path>`, and merged `<path>`. Record which main contract must remain and which additive branch behavior must be restored; do not select an entire parent file.

- [ ] **Step 3: Add a failing regression before each semantic correction**

Cover at minimum restructure-created weekly floating terms, exact 29-digit multi-source attribution, legacy floating-close rejection, settlement/restructure lock ordering, carried-balance allocation order, intermediary payout provenance, and reversal blockers.

- [ ] **Step 4: Implement minimal composed corrections**

Use shared `FinancialDecimal`, retain main DTOs and statuses, and add branch behavior without changing main single-payment/restructure results.

- [ ] **Step 5: Run overlap suites and backend typecheck to GREEN**

Run the Step 1 command, then `cd backend && bun x tsc --noEmit`.

### Task 3: Synchronize REST, MCP, plugin, and Web union contracts

**Files:**
- Modify verified conflicts under `backend/src/mcp`, `backend/src/modules`, `plugins/creditsync`, and `frontend`
- Modify synchronized English/Thai locales and matching tests

**Interfaces:**
- Consumes: the composed services from Task 2.
- Produces: exact REST DTOs, authenticated MCP `tools/list`, plugin frozen contract/evals, and localized Web flows for both feature sets.

- [ ] **Step 1: Run contract and UI suites and record RED**

```bash
cd backend && bun test src/mcp/server.test.ts
backend/scripts/test-disposable-postgres.sh src/mcp/default.test.ts src/modules/loan-closing-summary.test.ts src/modules/loan-restructures.test.ts src/modules/intermediated-disbursements.test.ts
cd frontend && bun run test
cd plugins/creditsync && bun test && bun run validate
```

- [ ] **Step 2: Add regressions for any missing union surface**

Assert actual tool-list/schema equality, write audit/correlation UUIDs, plugin skill/eval coverage, main restructure tools, branch settlement/intermediary tools, localized copy parity, and lazy evidence access.

- [ ] **Step 3: Implement minimal contract reconciliation**

Update handlers and schemas from the composed services, regenerate/freeze the actual contract once, and synchronize manifest/version/docs/evals/skills. Do not call REST from MCP or expose sensitive storage/account fields.

- [ ] **Step 4: Run all Task 3 gates to GREEN**

Use the exact Step 1 commands plus frontend native `bun test`, lint, and build.

### Task 4: Full verification, review, and integration commit

**Files:**
- Modify: `CHANGELOG.md`
- Modify only files required by a verified integration defect

**Interfaces:**
- Produces: a clean branch containing latest main and one reviewed semantic-integration commit.

- [ ] **Step 1: Run the complete serialized backend gate**

Run: `backend/scripts/test-disposable-postgres.sh`

- [ ] **Step 2: Run all type, frontend, and plugin gates**

```bash
cd backend && bun x tsc --noEmit
cd frontend && bun run test && bun test && bun run lint && bun run build
cd plugins/creditsync && bun test && bun run validate
```

- [ ] **Step 3: Verify generated schema and safety scans**

Run Drizzle generation/no-drift checks, `git diff --check`, locale parity, exact-money scans, sensitive logging scans, and compare main migration hashes `0027–0035` to merge parent `5268363`.

- [ ] **Step 4: Request scoped semantic-integration review**

Review the merge base, merge commit, and dirty integration diff for migration lineage, financial behavior, frozen contracts, tests, documentation, and preservation of main behavior.

- [ ] **Step 5: Update changelog and commit**

Ensure the `v0.3.12` entry describes the staged integration accurately, then commit all migration metadata, tests, semantic corrections, spec, plan, and documentation together.

Suggested commit: `fix: integrate floating workflows after restructure migrations`.
