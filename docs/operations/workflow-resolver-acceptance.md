# Workflow resolver and evidence-safety acceptance

This matrix separates implementation evidence from host adoption, device transport, and controlled rollout. Local tests use synthetic identifiers and disposable PostgreSQL only. Resolver output is read-only guidance; evidence-service guards remain authoritative for preview, activation, posting, and ledger writes.

## Verified release candidate — 2026-09-14

Application release `v0.4.46`, plugin `10.3.0`, artifact source `691dda70392f796825210dc3e6bbb0074a84e123`. Implementation used isolated worktrees and supervised Codex CLI Luna high; independent review findings were fixed and closed before integration. Both Docker images were built from a clean Git archive and carry that source revision label.

- Full serialized disposable backend suite: 150 files, 1,169 passed, zero failed. Three existing cache-conditional skips were covered separately by a disposable PostgreSQL/Dragonfly run: 16 passed, zero failed/skipped.
- Frontend: 67 files, 315 passed; lint and TypeScript/Vite build passed. The tested frontend tree is identical in the artifact source.
- Backend typecheck, plugin validator, and 68 plugin/evidence-recovery tests passed.
- Pinned official conformance revision `7169291ec0b68eb370fddcd9947313ab0d5e4156`: six scenarios, 58 checks passed, zero unexpected failures. This is fixture-based protocol evidence, not host/device acceptance or OAuth authorization-server conformance.
- Discovery benchmark: zero per-request schema-generation delta. Current counts and membership come from the generated profile index and snapshots, not historical documentation counts.
- Read-only release-probe/fingerprint assertions: eight tests passed. Backup restoration and live rollout remain separate gates below.

| Capability | Backend/service evidence | Resolver/plugin evidence | Host/device evidence | Status |
| --- | --- | --- | --- | --- |
| Sticky payment/payout requirements and failed-attempt floors | Full combined disposable suite, importer/requirement/migration, service/REST, concurrency, exact historical replay and intermediary post-time recheck regressions | N/A | N/A | Independently reviewed and locally verified |
| Exact finalized evidence association | Tenant/file/finalization/target linkage reads and negative fixtures | Resolver service tests return blocked/ready observations only | N/A | Implemented locally |
| Deterministic `workflow.resolve` | Pure policy and authoritative disposable-service tests; actual-schema borrower XOR/argument routing, authorization, exact associations, aggregate overflow/non-ready observations, and no domain writes | Frozen generated contract, six profile snapshots, 10.3.0 scripted evals | N/A | Independently reviewed and locally verified |
| Full `/mcp` and curated profile routing | Modern full/core-read dispatch test; legacy protocol matrix remains covered | `workflow.resolve` is read-only and profile-bound | Installed client adoption not inferred | Local transport evidence only |
| Missing/unreported attachment | Resolver/evidence stop tests; backend cannot detect a file never reported by host | Evals stop on unknown file, omitted file, transport failure, stale versions, pending evidence | Actual host behavior untested | Pending host acceptance |
| ChatGPT payment/payout file handoff | Synthetic importer and read-back tests | Skills document top-level `chatgptFile`, stable retry, and no fabricated IDs | iOS/Android app and connection handoff untested | Pending device acceptance |
| Backup/restore safety | Runbook requires a separate synthetic disposable DB for reset suites | N/A | No production restore or deployment performed here | Documentation complete; operator rehearsal pending |

## Remaining rollout and adoption evidence

- Before production deployment, create a fresh quiesced PostgreSQL/MinIO backup and verify isolated restore, additive migrations, old-table fingerprints, lifecycle-aware recovery, and read-only MCP probes. Do not reset or run financial tests on restored real data.
- Test each configured host/profile and both mobile platforms with synthetic payment and payout attachments, including retry, omitted/unavailable files, all-file requirements, and read-back.
- Keep merge, push, production backup, deployment, canary, and real financial-record actions with the supervisor/operator. Do not mark mobile or host adoption passed from these repository fixtures.
