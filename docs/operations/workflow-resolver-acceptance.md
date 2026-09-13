# Workflow resolver and evidence-safety acceptance

This matrix separates implementation evidence from host adoption, device transport, and controlled rollout. Local tests use synthetic identifiers and disposable PostgreSQL only. Resolver output is read-only guidance; evidence-service guards remain authoritative for preview, activation, posting, and ledger writes.

| Capability | Backend/service evidence | Resolver/plugin evidence | Host/device evidence | Status |
| --- | --- | --- | --- | --- |
| Sticky payment/payout requirements and failed-attempt floors | Disposable importer, requirement, migration, payment, payout and activation regressions; typecheck | N/A | N/A | Implemented locally; supervisor combined-suite review pending |
| Exact finalized evidence association | Tenant/file/finalization/target linkage reads and negative fixtures | Resolver service tests return blocked/ready observations only | N/A | Implemented locally |
| Deterministic `workflow.resolve` | Pure policy and authoritative disposable-service tests; closed-schema routing, borrower authorization, exact associations, aggregate overflow/non-ready observations, and no domain writes | Frozen 135-tool contract, six profile snapshots, 10.3.0 scripted evals | N/A | Implemented locally; supervisor review and combined-suite integration pending |
| Full `/mcp` and curated profile routing | Modern full/core-read dispatch test; legacy protocol matrix remains covered | `workflow.resolve` is read-only and profile-bound | Installed client adoption not inferred | Local transport evidence only |
| Missing/unreported attachment | Resolver/evidence stop tests; backend cannot detect a file never reported by host | Evals stop on unknown file, omitted file, transport failure, stale versions, pending evidence | Actual host behavior untested | Pending host acceptance |
| ChatGPT payment/payout file handoff | Synthetic importer and read-back tests | Skills document top-level `chatgptFile`, stable retry, and no fabricated IDs | iOS/Android app and connection handoff untested | Pending device acceptance |
| Backup/restore safety | Runbook requires a separate synthetic disposable DB for reset suites | N/A | No production restore or deployment performed here | Documentation complete; operator rehearsal pending |

## Required operator evidence before release

- Verify the pinned conformance checkout and run the official conformance/discovery gates against the reviewed artifact.
- Run the combined disposable backend suite after alternate-owned Task3 changes are integrated; do not reset or test a restored real-data database.
- Test each configured host/profile and both mobile platforms with synthetic payment and payout attachments, including retry, omitted/unavailable files, all-file requirements, and read-back.
- Keep merge, push, production backup, deployment, canary, and real financial-record actions with the supervisor/operator. Do not mark mobile or host adoption passed from these repository fixtures.
