# CreditSync Plugin Changelog

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
