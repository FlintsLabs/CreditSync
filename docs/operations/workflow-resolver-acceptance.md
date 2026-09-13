# Workflow resolver and evidence-safety acceptance

This matrix separates implementation evidence from host adoption, device transport, and controlled rollout. Local tests use synthetic identifiers and disposable PostgreSQL only. Resolver output is read-only guidance; evidence-service guards remain authoritative for preview, activation, posting, and ledger writes.

## Verified release candidate — 2026-09-14

Application release `v0.4.46`, plugin `10.3.0`, artifact source `691dda70392f796825210dc3e6bbb0074a84e123`. Implementation used isolated worktrees and supervised Codex CLI Luna high; independent review findings were fixed and closed before integration. Both Docker images were built from a clean Git archive and carry that source revision label.

- Full serialized disposable backend suite: 150 files, 1,169 passed, zero failed. Three existing cache-conditional skips were covered separately by a disposable PostgreSQL/Dragonfly run: 16 passed, zero failed/skipped.
- Frontend: 67 files, 315 passed; lint and TypeScript/Vite build passed. The tested frontend tree is identical in the artifact source.
- Backend typecheck, plugin validator, and 68 plugin/evidence-recovery tests passed.
- Pinned official conformance revision `7169291ec0b68eb370fddcd9947313ab0d5e4156`: six scenarios, 58 checks passed, zero unexpected failures. This is fixture-based protocol evidence, not host/device acceptance or OAuth authorization-server conformance.
- Discovery benchmark: zero per-request schema-generation delta. Current counts and membership come from the generated profile index and snapshots, not historical documentation counts.
- Read-only release-probe/fingerprint assertions: eight tests passed. Backup restoration and live rollout were verified separately below.

| Capability | Backend/service evidence | Resolver/plugin evidence | Host/device evidence | Status |
| --- | --- | --- | --- | --- |
| Sticky payment/payout requirements and failed-attempt floors | Full combined disposable suite, importer/requirement/migration, service/REST, concurrency, exact historical replay and intermediary post-time recheck regressions | N/A | N/A | Independently reviewed and locally verified |
| Exact finalized evidence association | Tenant/file/finalization/target linkage reads and negative fixtures | Resolver service tests return blocked/ready observations only | N/A | Implemented locally |
| Deterministic `workflow.resolve` | Pure policy and authoritative disposable-service tests; actual-schema borrower XOR/argument routing, authorization, exact associations, aggregate overflow/non-ready observations, and no domain writes | Frozen generated contract, six profile snapshots, 10.3.0 scripted evals | N/A | Independently reviewed and locally verified |
| Full `/mcp` and curated profile routing | Modern full/core-read dispatch test; legacy protocol matrix remains covered | `workflow.resolve` is read-only and profile-bound | Installed client adoption not inferred | Local transport evidence only |
| Missing/unreported attachment | Resolver/evidence stop tests; backend cannot detect a file never reported by host | Evals stop on unknown file, omitted file, transport failure, stale versions, pending evidence | Actual host behavior untested | Pending host acceptance |
| ChatGPT payment/payout file handoff | Synthetic importer and read-back tests | Skills document top-level `chatgptFile`, stable retry, and no fabricated IDs | iOS/Android app and connection handoff untested | Pending device acceptance |
| Backup/restore safety | Fresh quiesced PostgreSQL/MinIO backup; isolated restore/migration; 94 old-table fingerprints unchanged and two new empty tables | Read-only recovery and all-profile MCP probes passed on restored data and production | Real-device transport remains untested | Rehearsal and production deployment verified |

## Production rollout — 2026-09-14

- Merged and pushed the verified implementation into `main` (`30b7c30` integration commit). Subsequent handoff edits are documentation-only; deployed backend/frontend/plugin code remains identical to artifact source `691dda7`.
- Backend image: `creditsync-backend:workflow-691dda7`, digest `sha256:9c5e2a939bd5006718d0c49aac1154ac3826f775826bf83db17dacfedd5547f9`.
- Frontend image: `creditsync-frontend:workflow-691dda7`, digest `sha256:d453c5e46d013be46542db5a7909638bafeb8d0b5746a3d8c7b5bc3a10b9efb5`. Both images carry the full source revision label; frontend deployment timestamp is `2026-09-13T21:32:31Z` (Asia/Bangkok: 14 September).
- Protected backup set `workflow-691dda7.r5l9d6`: PostgreSQL custom dump, stopped-volume MinIO archive, checksums, fingerprints and rollout logs. Directory permissions are `700`; files are `600`. Checksums and isolated restoration passed. Rehearsal containers are stopped; backup and rehearsal volumes are retained.
- Migration journal advanced from 79 records / watermark `1789084800002` to 82 / `1789084800005`. All 94 existing public-table row fingerprints remained unchanged in both rehearsal and production; only the two new requirement/attempt tables were added, empty at migration verification. The three import-binding columns were verified explicitly.
- Lifecycle-aware recovery passed in rehearsal and production: 262 finalized-file checks passed; 53 historical pending warnings remain (49 missing uploads, four MIME mismatches). Warnings were not repaired, finalized, or treated as financial permission.
- Production read-only probes passed for all six profiles, legacy full discovery, current resolver versions, stale-version rejection, invalid Origin/header rejection, and invalid bearer HTTP 401. Backend health and frontend HTTP passed; Cloudflare re-established four connections and the secure MCP tunnel returned HTTP 200 from both health/readiness endpoints. Both ingress services are running again.
- Read-only incident checks still show the historical payment as posted with zero ready / one pending evidence record, and the original payout as posted with zero evidence. No financial test writes, historical record edits, evidence repairs, reversal, or reposting were performed.

Schema-compatible rollback images are retained as `creditsync-backend:before-workflow-resolver-20260914` and `creditsync-frontend:before-workflow-resolver-20260914`. Compatibility is not proof of evidence-safety parity: keep financial ingress paused and review safety before reopening financial workflows on the older application. Never down-migrate or delete financial history as rollback.

## Remaining host/device and long-running canary acceptance

- Test each configured host/profile and both mobile platforms with synthetic payment and payout attachments, including retry, omitted/unavailable files, all-file requirements, and read-back.
- Refresh/reconnect existing ChatGPT connections and verify actual `workflow.resolve` visibility/version before attachment-bearing writes. A server-side catalog probe does not prove host adoption or mobile descriptor delivery.
- The rollout proves a bounded read-only smoke/canary, not long-term latency, production financial-workflow adoption, or real-device reliability. Continue the existing canary/retention runbook; keep the full endpoint available until its original migration and approval criteria are met.
- Any real financial-record action or historical supplemental-evidence repair needs its own explicit confirmation and scope. Do not mark mobile or host adoption passed from repository fixtures or storage readiness alone.
