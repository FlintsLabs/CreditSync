# MCP optimization verification report

Status on `codex/mcp-optimization` after local acceptance. This is a feature-branch handoff, not a main-branch merge, deployment, canary, or mobile acceptance report. No full-backend suite, production, or real-device result is claimed here.

## Implementation status

- Catalog: the generated product catalog contains 134 tools. Frozen profile snapshots are generated from the actual advertised wire catalog: full 134, core-read 36, payments 57, loans 44, disbursements 39, and admin 34.
- Transport: legacy full `/mcp` remains unpaginated for compatibility; curated legacy routes paginate at 25, while modern 2026-07-28 uses the installed official v2 SDK, closed schemas, per-request metadata, opaque profile/catalog-bound cursors, final-page cursor omission, and public definition cache hints.
- Profiles: full, core-read, payments, loans, disbursements, and admin have explicit allowlists. Profiles are discovery routing, not authorization. The disbursement profile includes intermediary collection/remittance dependencies; profile replay uses schema-valid synthetic workflows and stops before a financial call after evidence failure.
- Conformance: the fixture injects six named no-side-effect tools into the same Elysia adapter/shared dispatcher, including the official stateless capability/stream/logging probes. It does not append tools to responses, rewrite aliases, overwrite incoming `Mcp-Name`, or convert unsupported requests into successes.
- Observability: the default adapter emits low-cardinality `mcp_metric` records for profile/era/operation/status/latency/wire bytes, successful discovery schema-cache hits, invalid origin/host/bearer/version/header rejections, and evidence-stop class. Streaming responses intentionally omit a byte count until a finite response exists.
- Evidence/mobile: preserve [`chatgpt-mobile-evidence.md`](./chatgpt-mobile-evidence.md); real iOS/Android and connection-specific transport remain pending. The supervisor’s read-only pre-canary check found evidence count 0 for the active loan and posted payout; no financial changes were made.
- Composite reads: integrated from the independently reviewed helper commit, preserving service-ranked borrower candidates, exact decimals, all allocations, and bounded snapshot-bound child pages. Detail views retain the existing service-owned full reads used for authoritative calculations and cursor snapshots.

## Gates

Results below distinguish worker-targeted checks from independent supervisor verification of the current feature code. The full disposable backend run is in progress; no full-suite success is claimed until it finishes.

| Gate | Result | Notes |
| --- | --- | --- |
| `bun run --cwd backend typecheck` | pass | TypeScript compiler completed with no errors. |
| disposable MCP/review regression command below | supervisor pass | 65 tests, 0 failures, 1,651 assertions. Includes the corrected pre-upgrade migration fixture, financial audit policy, profiles, cursors, fail-closed conformance parsing and 429/503 metrics. |
| `bun test backend/src/mcp/profiles.test.ts` | pass | 6 tests, 0 failures, 938 assertions; all five curated profile workflows use closed valid arguments and schema-valid synthetic outputs, with exact traces, evidence-stop, and out-of-profile denial. |
| `bun run plugins/creditsync/scripts/mcp-profiles.ts` | pass | Regenerated six snapshots from the actual catalog; counts are 134/36/57/44/39/34. |
| `bun test plugins/creditsync/tests` | supervisor pass | 58 tests, 0 failures, 1,803 assertions, including executable evidence-stop/retry traces and frozen contracts. Re-run after final documentation edits. |
| `bun run plugins/creditsync/scripts/validate.ts` | supervisor pass | Synchronized 10.2.0 contract, 11 skills, 134 tools, no bundled MCP/secrets. Private app reference remains a non-live placeholder. |
| `cd backend && bun run mcp:discovery:benchmark` | pass | Complete cold/warm modern discovery measured for all six profiles: full 6 pages/810,145 bytes/134 tools; core-read 2/295,884/36; payments 3/358,640/57; loans 2/362,567/44; disbursements 2/212,409/39; admin 2/118,295/34. Legacy full was 134 tools/2,335,871 bytes. Schema projection was compared uncached/cached for every profile and request schema-generation delta was 0. Bytes are wire bytes, not host-token estimates. |
| `cd backend && MCP_CONFORMANCE_ROOT=/absolute/verified/checkout bun run mcp:conformance` | supervisor pass | Fresh-install checkout at SHA `7169291ec0b68eb370fddcd9947313ab0d5e4156`, package `0.2.0-alpha.11`; 6 scenarios, 58/58 checks, 0 failures, plus valid/invalid JSON Schema fixture dispatch. `server-stateless` passed 28/28, including transport/discovery/version/clientInfo/unknown-method/capability and SDK subscription envelopes. |
| full `cd backend && bun run test` | final supervisor rerun pending | Initial 143-file run: 1,062 passed, one pre-upgrade fixture failed because it incorrectly included migration 0074 while excluding 0073. That fixture now passes without removing any upgrade/replay/sentinel assertions. The final rerun includes all 144 files and is not replaced by targeted passes. |
| frontend tests/lint/build | not applicable to this backend/plugin transport change | Reassess if supervisor integration changes shared frontend setup. |

## Benchmark/conformance interpretation

The benchmark compares explicit uncached schema projection with the module-load cached projection and measures complete discovery through the final page. It asserts zero schema-generation calls during request discovery; timings are informational and byte counts are wire measurements. "Cold" denotes the first traversal for that profile in one process, not an isolated process startup for every profile. The official scenarios cover list/call/error/schema/header behavior, stateless transport/discovery/capability checks, and the SDK's subscription envelopes. Application list-change publication, cross-request event delivery, live financial writes and real mobile behavior are not established by that fixture. Runtime canary, production, and mobile results remain pending.

The review regression command was run from `backend/`:

```bash
bash scripts/test-disposable-postgres.sh --timeout 15000 src/db/cancellation-upgrade-order.test.ts src/mcp/server.test.ts src/mcp/modern.test.ts src/mcp/profiles.test.ts src/mcp/contract-snapshot.test.ts src/mcp/conformance-result.test.ts
```

A concurrent run had two 5-second catalog-test timeouts. The isolated run above passed; those tests completed in 2.7–2.9 seconds. No assertions were removed. The final full-suite run uses the normal runner and no concurrent heavy gates.

## Plan coverage and boundaries

| Plan area | Implementation and verification source |
| --- | --- |
| Task 1 — evidence stops | Plugin skills plus executable eval traces cover inaccessible/pending/duplicate/mismatched evidence, all attachments, confirmation and ready retry. These are agent-level guarantees, not enforcement against arbitrary MCP callers. |
| Task 1B — mobile-shaped ingestion | `chatgpt-file-evidence-service.test.ts`, `loan-disbursement-service.test.ts`, MCP default-adapter tests and migration tests cover draft-parent import, tenant isolation, network/content/storage checks, durable retry/audit identity and no activation/payment-intake/post side effects. Real-device acceptance remains separate. |
| Task 2 — catalog and metadata | One immutable catalog supplies both protocol projections and snapshots; invariant and audit-recovery tests cover payment-start-date mutation, allocation correction, unknown calls and unchanged legacy receipt shapes. |
| Tasks 3–4 — transport and discovery | Actual v1/v2 client tests, raw HTTP tests, shared cursor tests, empty/repeated-cursor collector tests, six official scenarios and per-profile discovery benchmark cover the approved dual-era contract. |
| Task 5 — profiles | Explicit allowlists, curated union, schema-valid routed workflow traces, out-of-profile denial, evidence-stop traces and generated wire-derived snapshots cover all five curated profiles. Actual host connection selection is a runtime gate. |
| Task 6 — composite reads | `composite-reads.test.ts` verifies authoritative-service parity, ambiguity/tenant isolation, exact decimals, bounded named child pages, stale cursors and no financial effects. Full internal detail reads used by existing accounting services are intentionally retained. |
| Task 7 — handoff | Pinned official runner with fail-closed result parsing, disposable tests, plugin/typecheck gates, safe metrics, canary/mobile runbooks and full-endpoint retention criteria. No expected implementation failures are baselined. |

Implementation used supervised Luna high in isolated worktrees. Independent reviews covered evidence races/receipts, composite parity and the final transport/catalog patch; review fixes include conformance-summary validation and complete rejection metrics. Application release notes use v0.4.45 and the plugin uses 10.2.0. The approved spec/plan are committed with the feature history; implementation checkpoints consolidate related tasks under supervisor-owned commits.

The original scenario was inspected read-only before canary: the loan was active, the payout posted, and its evidence count was **0**. It must not be described as having attached evidence. No original financial record was changed. Real iOS/Android payment and payout transport, staging/canary, production deployment and main-branch integration are not claimed. Full `/mcp` retirement still requires the documented release/30-day usage conditions and explicit approval.
