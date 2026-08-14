# Single-Payment Settlement/Restructure Verification

Verified on 2026-08-14 in the isolated `codex/single-payment-restructure` worktree. This report covers the release diff from design baseline `52b7c5f9912acd777994c7f4ee78dbf1d7145974` through the current branch. No production deployment or live-tenant financial write was performed.

## Requirement evidence

- The Decimal-only kernel, one-row single-payment maturity schedule, greater-of fixed/retroactive exposure selection, concurrent contracted late penalty, and component waivers are covered by backend unit and disposable PostgreSQL suites.
- Draft/preview/activation, settlement/restructure, later waiver, early settlement, external-credit allocation, top-up disbursement linkage, ordered payment allocation, idempotency, stale-preview/concurrency checks, reversal blockers, and append-only database invariants are covered by service, REST, MCP, migration, and PostgreSQL tests.
- The REST adapters, 47-tool frozen MCP schema-version `1.0` contract, Plugin `2.5.0` with nine skills, executable eval stop gates, and synchronized contract snapshot pass their contract validators.
- Localized Web creation/restructure/review/detail flows pass the complete frontend suite. English and Thai contain the same 1,031 leaf-key paths; a dedicated parity test protects this invariant.
- The ordered migration chain through `0035_disbursement_restructure_relation.sql` applies to a fresh disposable PostgreSQL database. `0035_snapshot.json` represents the final Drizzle schema; a fresh generator run reports no schema changes.

## Fresh verification evidence

| Gate | Result |
| --- | --- |
| `cd backend && ./scripts/test-disposable-postgres.sh` | 362 pass, 2 cache-only skip, 0 fail; 2,514 assertions across 364 tests/60 files |
| Cache-gated suites with a disposable Dragonfly plus disposable PostgreSQL | 12 pass, 0 fail; includes both tests skipped by the PostgreSQL-only full run |
| `cd backend && bun test` without database services | 177 pass, 187 expected DB-dependent skips, 0 fail |
| `cd backend && bun run typecheck` | Pass |
| `cd frontend && bun run test` | 30 files, 119 tests pass |
| `cd frontend && bun run lint` | Pass |
| `cd frontend && bun run build` | Pass |
| `bun test plugins/creditsync/tests` | 32 pass, 0 fail; 802 assertions |
| `bun plugins/creditsync/scripts/validate.ts` | Pass: Plugin 2.5.0, nine skills, 47 tools, no bundled MCP/secrets |
| plugin-creator validator | Pass |
| authenticated local MCP contract capture | Pass; schema `1.0`, 47 tools, committed contract matches advertised contract |
| `cd backend && bun run generate --name final_schema_drift_check` | `No schema changes, nothing to migrate` |

The first full PostgreSQL run exposed a stale static test that required migration `0030` to be the journal's final entry. The contract was corrected to require its durable index/tag instead; the fresh full rerun passed. Schema generation also exposed missing snapshot metadata for handcrafted migrations `0034`–`0035`; committing the final `0035` snapshot removed the false duplicate-column proposal without adding a redundant migration.

The final aggregate review additionally found and closed three cross-task gaps: waiver execute/reverse now re-authorizes portfolio access after locking (including idempotent replay), settlement rejects later active source-loan payments or posted payouts that would otherwise be excluded from a backdated snapshot, and every replacement contract starts exactly on its settlement date. The final PostgreSQL counts above include these regression tests; a focused cache run passed 12 tests and 80 assertions against Dragonfly.

## Release audits

- `git diff --check` reports no whitespace errors.
- Release-diff secret, private-key, bearer-literal, raw signed-query, and identity-value scan reports no hits. No `.env` or production secret is included.
- Financial conversion review found `Number` only for integer day/count fields and environment TTL seconds. Public money remains two-decimal strings and calculations use Decimal.js.
- Migration mutation review found the intentional `0027` legacy backfill plus lifecycle/immutability triggers. Application mutation hits are preview/executed/reversed state transitions, schedule neutralization during compensating reversal, and tests that prove mutation rejection; no posted ledger row is edited or deleted to correct value.
- English/Thai locale parity is 1,031/1,031 leaf paths with zero missing keys.
- Plugin manifest, frozen contract, skills, eval catalog/harness, and validators agree on Plugin 2.5.0, nine skills, and 47 tools.
- Final worktree review must still run after this report is committed: `git diff --check`, `git status --short`, and commit-range review remain the delivery controller's final gate.

## Advisories and production boundary

- Vite emits its existing advisory that the main minified JavaScript chunk is approximately 582 kB (>500 kB). The build succeeds; code splitting is a future performance improvement, not a financial correctness failure.
- The full PostgreSQL command does not configure Dragonfly and therefore reports two cache-invalidation skips. Both were rerun successfully against an isolated disposable Dragonfly container and disposable PostgreSQL; that container was stopped and removed immediately afterward.
- No application containers were rebuilt, no production migration was applied, and no test financial record was created in a live tenant. Follow the production checklist in `agent-mcp-plugin.md`, inspect migrations through `0035`, run schema-only production checks, and reconcile all financial ledgers before reopening writes.
