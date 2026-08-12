# CreditSync Plugin Changelog

## 2.3.0 - 2026-08-12

### Added

- Added the intermediary collection/remittance MCP workflow, exact allocation preview, remittance-slip evidence lifecycle, historical payment linking without double posting, and the `reconcile-intermediary-remittances` orchestration skill.

### Changed

- Published the package through the Git-backed `creditsync-marketplace` catalog with exact repository-path validation and documented refresh, reinstall, and new-task pickup behavior.

## 2.1.0 - 2026-08-10

### Added

- Added the `manage-disbursements` skill, root routing, and scripted positive/negative lifecycle evals for variance, evidence ordering, confirmation, idempotency, schedule immutability, and reasoned reversal.

### Fixed

- Re-listed and selected the exact posted disbursement before reversal, and stopped when the event is missing or no longer posted.
- Branched evidence preparation between already-finalized `ready` state and a valid non-expired upload, with explicit stops for upload expiry, checksum conflict, and finalize mismatch.

## 2.0.0 - 2026-08-10

### Added

- Added the six frozen loan-disbursement MCP tool contracts for list, draft, evidence prepare/finalize, post, and reversal.

### Compatibility

- Released a new major plugin package because the frozen tool catalogue grows from 20 to 26 tools. The MCP payload schema version remains `1.0`.

### Fixed

- Made `loan.disbursement.draft` reject evidence-ID arrays with a stable instruction to use the durable evidence prepare/finalize lifecycle.

## 1.0.0 - 2026-08-10

### Added

- Added five tested orchestration skills for borrowers, payments, loan activation, and daily-loan renewal/reversal.
- Added the private app manifest, repository marketplace entry, matching/financial/error references, frozen 20-tool contract, and positive/negative eval catalog.
- Added executable package validation for discovery, marketplace resolution, deferred capabilities, tool drift, eval coverage, and common secret patterns.

### Security

- Kept endpoint URLs, bearer credentials, raw QR values, OCR, OAuth, hooks, UI, and bundled MCP process configuration out of the package.

### Compatibility

- Frozen CreditSync MCP tool names, schemas, annotations, and workflows at schema version `1.0`. Breaking contract changes require plugin `2.0.0`.

### Fixed

- Replaced the name-only contract with a deterministic full metadata snapshot captured by an authenticated local MCP SDK Client `tools/list` call.
- Added executable scripted-MCP evals for exact ordered/repeated calls, supported arguments, stale/duplicate/review/unauthorized branches, explicit confirmation, reversal reasons/idempotency, and forbidden writes/upload effects.
- Allowed both the documented non-live app placeholder and syntactically valid registered technical IDs during package validation.
- Stopped image-first reconciliation on duplicate evidence before PUT/finalize/preview/post, and documented honest payment/renewal reversal prerequisites for the frozen tool surface.
- Corrected token-byte hashing, metadata-preserving MinIO recovery, and MCP-only rollback guidance.
- Corrected renewal-reversal provenance: the borrower UUID is retained before execution rather than read from `renewal.execute`, portfolio inspection is limited to exposed loan states, and `renewal.reverse` is the authoritative atomic blocker check.
- Aligned the blocked-reversal eval and instructions with the backend's sanitized `RENEWAL_REVERSE_BLOCKED` contract: backend message plus aggregate `downstreamEntryCount`, with no invented blocker records.
