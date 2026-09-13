# MCP optimization verification report

Status at the uncommitted `codex/mcp-optimization` worktree. This is a branch handoff, not an integration, deployment, canary, or mobile acceptance report. Full backend verification is intentionally deferred until the independent composite branch is integrated; no full-suite pass is claimed here.

## Implementation status

- Catalog: current generated product catalog is 131 tools, including the payout importer. Contract and profile snapshots are generated from the catalog.
- Transport: legacy v1 remains full/unpaginated; modern 2026-07-28 uses the installed official v2 SDK, closed schemas, per-request metadata, derived catalog-version cursors, 25-tool pages, final-page cursor omission, and profile-bound validation.
- Profiles: full, core-read, payments, loans, disbursements, and admin have explicit allowlists. Profiles are discovery routing, not authorization. Core-read excludes mutations and the profile union covers the catalog.
- Conformance: the fixture injects three named no-side-effect tools into the same Elysia adapter/shared dispatcher. It does not append tools to responses, rewrite aliases, overwrite incoming `Mcp-Name`, or convert unsupported requests into successes.
- Evidence/mobile: preserve [`chatgpt-mobile-evidence.md`](./chatgpt-mobile-evidence.md); real iOS/Android and connection-specific transport remain pending. The supervisor’s read-only pre-canary check found evidence count 0 for the active loan and posted payout; no financial changes were made.
- Composite reads: not integrated; supervisor owns independent review and later integration of three tools. This branch does not duplicate that work.

## Gates

The exact results below must be refreshed at the final feature HEAD after any additional supervisor integration. Commands are shown with their working directory.

| Gate | Result | Notes |
| --- | --- | --- |
| `cd backend && bun run typecheck` | pass | TypeScript compiler completed with no errors after injected-catalog changes. |
| `cd backend && bun test src/mcp/modern.test.ts src/mcp/profiles.test.ts` | pass | 11 tests, 0 failures, 836 assertions. Covers actual v2 client calls, invalid UUID/money/idempotency, discovery/pagination/cursors, Origin/header validation, all five legacy SDK-supported versions, profile exactness/dependencies, and catalog version. |
| `bun test backend/src/mcp/server.test.ts backend/src/mcp/security.test.ts` | pass | Disposable PostgreSQL runner: 37 tests, 0 failures, 557 assertions. |
| `bun test plugins/creditsync/tests/plugin-contract.test.ts plugins/creditsync/tests/operations-docs.test.ts` | pass | 23 tests, 0 failures, 351 assertions, including type-specific evidence workflow wording. |
| `bun run plugins/creditsync/scripts/validate.ts` | pass | Synchronized plugin 10.2.0, 11 skills, 131-tool contract, no bundled MCP/secrets. |
| `cd backend && bun run mcp:discovery:benchmark` | pass | Uncached/cached projection 71.68/14.85 ms; complete modern cold/warm 6 pages, 722,605 bytes, 131 tools; legacy 131 tools/720,666 bytes; request schema-generation delta 0. |
| `cd backend && MCP_CONFORMANCE_ROOT=/absolute/verified/checkout bun run mcp:conformance` | pass | Pinned checkout SHA `7169291ec0b68eb370fddcd9947313ab0d5e4156`, package `0.2.0-alpha.11`; local result was 5 scenarios, 30/30 checks, 0 failures, plus valid/invalid JSON Schema fixture dispatch check. The path must be supplied and revalidated on each run. |
| `cd backend && ./scripts/test-disposable-postgres.sh <target>` | pending/targeted only | Use disposable PostgreSQL for changed DB-dependent MCP/evidence suites. The prior supervisor handoff records Task1/1B targeted importer/migration 28 pass/0 fail and plugin 56 pass/1 fail wording reconciliation; those are not a full-suite result. |
| full `cd backend && bun run test` | not run / deferred | Must run after composite integration; the intentionally interrupted evidence-branch run is not a pass. |
| frontend tests/lint/build | not applicable to this backend/plugin transport change | Reassess if supervisor integration changes shared frontend setup. |

## Benchmark/conformance interpretation

The benchmark compares explicit uncached schema projection with the module-load cached projection and measures complete discovery through the final page. It must assert zero schema-generation calls during request discovery; timings are informational. The official selected scenarios cover list/call/error/schema/header behavior. OAuth deployment, subscriptions, and live financial writes are documented limitations/exclusions, not expected implementation failures. Runtime canary, production, and mobile results remain pending.
