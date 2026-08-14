# Floating Weekly and Intermediary Main Semantic Integration Design

## Purpose

Integrate `codex/floating-weekly-intermediary-flow` with the latest `main` without weakening either product line. The merged branch must retain the authoritative single-payment, waiver, and restructure behavior introduced by main while adding the complete weekly floating-interest settlement and intermediary multi-leg disbursement workflows.

This is a semantic integration, not a conflict-resolution-by-selection exercise. Where both branches changed the same calculation, service, route, MCP contract, UI, or migration lineage, the result must compose the two behaviors and preserve their financial and audit invariants.

## Authoritative Baselines

- Main migrations `0027_single_payment_restructure` through `0035_disbursement_restructure_relation` are immutable history. They are never edited, renamed, replayed, or duplicated.
- Main is authoritative for single-payment terms, floating daily/weekly period snapshots used by restructure, penalties, waivers, opening balances, external credits, and restructure/disbursement lineage.
- The feature branch is authoritative for generalized weekly floating policy and accrual settlement, intermediary profiles and assignments, multi-leg disbursement groups/events/evidence, and their REST/MCP/plugin/Web workflows.
- Existing posted financial records, audit records, activated terms, and evidence links remain append-only. Corrections use explicit compensating records.

## Migration Architecture

Add one migration, `0036_floating_weekly_intermediary_integration`, after main `0035`.

`0036` contains only schema and data changes absent from a database that has already applied main `0027–0035`. It must:

- add intermediary bank accounts, loan assignments, multi-leg groups, previews, transfer events, evidence intents, and evidence links;
- add weekly floating policy, settlement preview, activation replay, and accrual snapshot fields not already supplied by main;
- backfill legacy floating policy deterministically without changing existing financial amounts;
- preserve main's single-payment and restructure columns, constraints, backfills, triggers, and relations;
- add the branch's tenant, exact-money, overlap, idempotency, evidence, posted-record, and accrual immutability constraints;
- be validated both from a clean database and from a database stopped immediately after main `0035`.

The removed branch-local migration numbers `0027–0029` are development-only history and must not appear in the merged journal. Their net behavior is consolidated into `0036`; their SQL is not run a second time.

## Semantic Code Integration

Shared code follows composition rules:

- single-payment and restructure calculations retain main's public DTOs and behavior;
- weekly floating calculation uses exact period snapshots and the shared 100-digit `FinancialDecimal` context;
- payment and settlement allocation retain main's carried-balance/waiver ordering and the feature branch's exact multi-source fund attribution;
- legacy floating close remains rejected in favor of preview/confirm/execute settlement;
- restructure-created floating replacement loans accept the same daily/weekly policy contract as normal origination;
- actual disbursement and intermediary group posting remain distinct from approved principal and restructure cash intent;
- lifecycle, row-lock ordering, idempotency, audit correlation, reversal, and tenant authorization rules from both features remain enforced.

## Public Contracts

REST, MCP, plugin, and Web surfaces expose the union of both feature sets without reintroducing removed or stale schemas.

- MCP calls application services directly and returns public UUIDs, exact two-decimal money strings, audit public IDs, and correlation IDs for writes.
- The frozen tool contract, actual authenticated `tools/list`, plugin manifest/version, ten-or-more skills, eval catalog, harness, docs, and validators must agree exactly.
- Frontend copy remains synchronized in English and Thai; money uses exact formatters and dates use the active locale with `Asia/Bangkok`.
- Existing main single-payment/restructure routes and UI remain backward compatible according to their tests and frozen contracts.

## Error Handling and Safety

- Schema overlap or an already-present object must be resolved in the generated `0036` SQL, not hidden by broad exception handling.
- Migration validation must fail on duplicate application, missing prerequisites, changed financial rows, invalid backfills, or weakened constraints.
- Ambiguous borrower/intermediary identity, stale previews, mismatched evidence, non-zero variance, missing confirmation, and idempotency conflict remain hard stops.
- No raw account numbers, identity values, signed URLs, storage keys, QR payloads, tokens, or evidence contents may be logged or exposed.

## Verification

Completion requires:

1. static journal/snapshot tests proving main `0027–0035` remain byte-for-byte history and `0036` is the sole tail integration migration;
2. disposable PostgreSQL clean-install migration coverage through `0036`;
3. a main-through-0035 seeded upgrade test applying only `0036`, proving required backfills and unchanged pre-existing financial rows;
4. focused financial, restructure, floating settlement, intermediary, evidence, REST, MCP, and plugin tests;
5. full backend disposable suite and typecheck;
6. full configured frontend tests, native Bun tests, lint, and build;
7. full plugin tests and both validators;
8. exact-money and sensitive-data scans plus `git diff --check`;
9. a scoped review of the semantic merge and a changelog-inclusive commit.

Production deployment is explicitly outside this integration task.
