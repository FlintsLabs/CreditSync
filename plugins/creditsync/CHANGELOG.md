# CreditSync Plugin Changelog

## 8.0.0 - 2026-09-01

- Added explicit scheduled-installment mode metadata so weekly/monthly count-only terms remain rate-derived while count-plus-amount terms remain fixed-total across MCP workflows.

## 7.7.0 - 2026-08-25

### Added

- Added `payment.restore.create` for creating one safe evidence-bearing restore draft before exact restoration of a mistakenly reversed payment.

### Changed

- Updated restore guidance and the frozen MCP contract for the required create → evidence → preview → execute workflow.

## 7.6.0 - 2026-08-25

### Added

- Added `payment.restore.preview` and `payment.restore.execute` for explicit, idempotent exact restoration of a mistakenly reversed payment as a linked child while preserving the original component split and evidence lineage.

### Changed

- Synchronized the frozen MCP contract and reconciliation guidance with exact reversed-payment restoration safeguards.

## 7.5.0 - 2026-08-25

### Added

- Added `loan.cancel.preview` and `loan.cancel.execute` for explicitly confirmed, idempotent cancellation of active loans that have no actual disbursement, no effective posted payment, and no downstream financial activity.

### Changed

- Synchronized the frozen 99-tool MCP contract and loan-management guidance with public audit/correlation metadata and append-only unfunded cancellation safeguards.

## 7.4.0 - 2026-08-25

### Added

- Added `funding-allocation.preview`, `funding-allocation.create`, and `funding-allocation.list` for attaching an active funding profile or drawdown to an active non-terminal loan after activation.

### Changed

- Synchronized the frozen 94-tool MCP contract, strict public money/UUID schemas, idempotency metadata, and append-only audit guidance for deferred funding allocation.

## 7.1.0 - 2026-08-17

### Added

- Added the closed `loan.replacement.preview`, explicitly confirmed/idempotent `loan.replacement.execute`, and compensating `loan.replacement.reverse` tools with public-only lineage, audit, and correlation fields.
- Added executable inspect-preview-confirm-execute and stop-boundary evals for missing confirmation, stale previews, downstream activity, and forbidden direct status mutation.

### Changed

- Froze the additive 78-tool MCP contract and synchronized replacement financial rules and orchestration guidance.
- Synchronized the restructure tool description and guidance for active single-payment and floating-to-floating loan workflows.

### Fixed

- Required explicit confirmation for `loan.replacement.reverse` and marked replacement preview as a persistence-writing, non-idempotent MCP operation in the frozen contract.
- Nested the canonical bank-profile name inside replacement preview outputs and replaced prose-only correction warnings with closed structured warning codes and exact financial details in the frozen contract and executable eval fixtures.
- Added the closed public-only nullable `replacementLineage` field to `borrower.portfolio` loan items and made replacement evals derive active/draft IDs from inspected borrower-scoped portfolio state before previewing.

## 7.0.0 - 2026-08-14

### Added

- Added eleven closed commission-participant, exact commission, and payment source-attribution tools; actual writes carry confirmation, idempotency, audit, and append-only compensation boundaries, while commission reversal remains an explicitly read-only preview.
- Added the closed-schema destructive `loan.settlement.reverse` tool and synchronized settlement orchestration for explicit reason/confirmation, stable idempotency, append-only negative provenance, and downstream-activity stops.

### Changed

- Froze the actual 75-tool MCP `tools/list` contract while retaining all 11 orchestration skills.

### Compatibility

- Retained MCP payload schema version `1.0`; the additive catalogue now contains 75 tools and existing tool schemas remain frozen.

## 6.0.0 - 2026-08-14

### Added

- Added the six main-authoritative single-payment restructure and component-waiver tools to the weekly-floating and intermediary contract, with executable positive and stop-boundary evals.

### Changed

- Froze the actual authenticated 63-tool union contract and retained all 11 orchestration skills, including exact floating settlement, intermediary multi-leg evidence, and main-authoritative restructure/waiver workflows.

### Compatibility

- Released a new major plugin because the frozen catalogue grows from 57 to 63 tools and the loan origination/restructure schemas now accept both legacy floating terms and generalized day-or-week policies. MCP payload schema version remains `1.0`.

## 5.0.0 - 2026-08-14

### Changed

- Required `auditPublicId` and `correlationId` UUIDs in the closed MCP results for intermediary bank-account save, assignment create/end, and transfer-evidence prepare/finalize while preserving their existing REST response DTOs.

### Fixed

- Replayed the authoritative stored audit identifiers for idempotent administrative commands and already-prepared or finalized evidence instead of reporting a successful write without traceable command metadata.

### Compatibility

- Released a new major plugin because five frozen output schemas now require audit/correlation fields. The catalogue remains 57 tools and 10 skills, and MCP payload schema version remains `1.0`.

## 4.0.0 - 2026-08-14

### Added

- Added 14 closed-schema intermediary profile, masked-bank-account, assignment, managed-loan, and intermediated-disbursement MCP tools plus the `manage-intermediated-disbursements` skill and executable three-slip positive/negative orchestration evals.

### Changed

- Expanded the frozen contract to 57 tools and 10 skills, with exact assignment, safe per-event evidence inspection metadata, zero retained-balance/variance, fresh confirmation, stale-state, and compensating-reversal boundaries.

### Fixed

- Required literal intermediated-disbursement confirmation, validated its complete scripted inputs and outputs with a full JSON Schema parser, sent the declared retained balance, bound each supplied slip's evidence/file UUID and immutable MIME/size/SHA-256 across prepare, ready retry, finalize, and inspection, compared exact roles/references/amounts/payees before preview, and verified upload descriptors against unchanged fixture bytes.

### Compatibility

- Released a new major plugin because the frozen tool catalogue grows from 43 to 57 tools. MCP payload schema version remains `1.0`.

## 3.0.0 - 2026-08-13

### Added

- Added closed-schema `loan.settlement.preview` and explicitly confirmed, idempotent `loan.settlement.execute` tools plus the `settle-floating-loans` skill and positive/stopped-flow evals.

### Changed

- Generalized floating origination to preserve day-or-week policy data, required a stable activation idempotency key, and synchronized the manifest, local validation command, references, and frozen 43-tool contract.

### Fixed

- Required literal settlement confirmation instead of treating omission as approval, and recorded the exact displayed preview composition before confirmation and execution in the executable eval harness.

### Compatibility

- Released a new major plugin because generalized floating origination replaces the legacy daily-only input and loan activation now requires an idempotency key. MCP payload schema version remains `1.0`.

## 2.4.0 - 2026-08-13

### Added

- Added the strict `loan.disbursement.update` PATCH tool for non-empty partial edits to draft-only payout metadata, with retained finalized evidence and audited before/after state.

### Changed

- Required re-listing the current draft and obtaining fresh post confirmation after every update, with explicit stop gates for locked events and unsupported fields.

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
