# Changelog

## v0.3.12 - 2026-08-14

### Added
- Added the detailed implementation plan for the approved supervised tmux and `gpt-5.3-codex-spark` delegation policy, including RED/GREEN policy checks, exact `AGENTS.md` copy, verification, and commit boundaries.
- Added the approved design for supervised tmux delegation of substantial implementation work to `gpt-5.3-codex-spark`, retaining planning in the user-selected model with explicit fallback, worktree isolation, status, and completion-verification rules.
- Added the v0.3.12 TDD implementation plan for tenant-bound borrower identity-card signed uploads, Codex-extracted identity application, synchronized Web/REST/MCP delivery, and CreditSync Plugin `8.0.0`'s 67-tool frozen contract.
- Added the approved design for tenant-bound borrower identity-card uploads through MCP, using signed prepare/finalize storage verification followed by idempotent application of Codex-extracted identity fields with Thai checksum validation and masked audit provenance.
- Added exact compensating floating-settlement reversal across REST, MCP Plugin `7.0.0`'s 64-tool frozen contract, and localized Web confirmation, preserving negative transaction/allocation/fund provenance and restoring loan/accrual state only when no downstream activity exists.
- Added localized Loan Detail and intermediary-profile transfer ledgers for all three intermediary money paths, exact split payouts, sender/payee/date/reference/status inspection, every finalized slip, zero-variance/evidence-ready confirmation, and idempotent posting.
- Added a localized responsive intermediary directory and profile workspace with canonical-name/alias search, profile creation, exact managed-loan portfolio totals, Loan Detail links, historical assignments, masked payment destinations, unreconciled-group warnings, and retained collection/remittance access.
- Added 14 closed-schema intermediary profile, masked-bank-account, assignment, managed-loan, and multi-leg disbursement MCP tools plus CreditSync Plugin `6.0.0` orchestration for the complete 63-tool union contract: exact three-slip evidence, weekly settlement, main-authoritative restructure/waiver flows, zero-variance confirmation, stale-state stops, and compensating reversal.
- Added localized Web controls and backend-owned previews for daily or weekly floating-interest policy origination, exact due-versus-accruing loan summaries, and explicitly confirmed settlement with automatic stale-preview refresh.
- Added tenant-safe intermediary bank accounts and effective-dated loan assignments, plus exact intermediated disbursement groups, split transfer events, multi-evidence persistence, and expiring reconciliation previews with overlap, idempotency, uniqueness, and immutability protections.
- Added audited intermediary profile APIs for confirmed-alias reuse, masked reusable bank accounts, effective-dated assignment history, and role-filtered active managed loans with strict tenant-safe command contracts.
- Added strict authenticated APIs for audited intermediary disbursement groups and split transfer events, deriving exact contractual targets from immutable activation snapshots and persisting versioned reconciliation previews with role-level under/over warnings, explicit retained balances, evidence readiness, and automatic stale-proposal invalidation.
- Added tenant-scoped multi-slip evidence for every intermediary transfer event with signed PUT preparation, exact MinIO ownership and checksum finalization, immutable finalized links, redacted audit provenance, and short-lived on-demand access descriptors.
- Added explicitly confirmed atomic posting and compensating reversal for zero-variance intermediary disbursement groups, linking exact borrower payout and activation-time advance-interest projections by public provenance IDs while preserving optional evidence, collection/remittance ledgers, and Decimal-only held balances.

### Changed
- Routed substantial approved implementation work through supervised tmux Codex sessions using `gpt-5.3-codex-spark`, with current-model fallback, isolated worktree handoff, explicit authority boundaries, progress supervision, and independent completion/integration verification.
- Replaced nested repayment-schedule cards on loan details with a compact responsive table and localized column headers.
- Surfaced up to three borrower tags with an overflow count in the Loan Detail borrower summary.

### Fixed
- Kept Payment Inbox filters within the narrow review panel at tablet widths and explained pending evidence uploads inline instead of presenting an unusable slip-preview action.
- Synchronized the generated `0036` Drizzle snapshot with the settlement reversal's immutable original-interest and next-due-date columns, with a static lineage regression that prevents future add-column drift.
- Preserved exact original settlement fund-ledger coordinates during compensating reversal after later funding reallocation, and normalized every executable plugin eval result and stable error fixture against the complete frozen MCP schemas without scenario exemptions.
- Bound delayed floating-settlement reversals to the Bangkok reversal date, restored exact pre-execution loan rollups from immutable preview snapshots, blocked post-settlement rate-timeline authority and paid-loan rate mutations under the loan lock, and validated settlement-reversal eval fixtures against the complete frozen MCP output schema.
- Included authoritative due floating penalties in settlement previews, stale balance versions, execution allocations, materialized penalty provenance, and exact close-zero checks.
- Included authoritative due floating penalties in payment-preview availability so an exact penalty-plus-interest-plus-principal receipt previews and posts with full Decimal conservation without making accruing-not-due interest normally payable.
- Made public schedule due dates follow normalized Bangkok business dates independently of the runtime timezone, aligned settled floating-loan REST coverage with its exact informational accruing-interest projection, restored real time after frozen-clock floating regressions, and restored the fully migrated disposable schema after isolated historical-migration tests without masking their original failures.
- Made main-compatible MCP loan activation retries derive a stable per-loan fallback idempotency key across requests, restored all 18 weekly floating allocation/penalty/reversal/immutability regressions on current service projections while retaining the legacy-close rejection, and synchronized the private plugin catalogue and validator to all 11 shipped skills.
- Reconciled authenticated MCP input/output schemas and direct service adapters across legacy single-payment activation/restructure and generalized floating policies, retained request-scoped compatibility for activation callers without an explicit idempotency key, and synchronized the frozen plugin contract and eval catalogue to the actual 63 advertised tools.
- Accepted generalized floating-interest policies on loan-restructure REST previews while retaining strict nested-key rejection, and preserved legacy daily `start_next_day` boundaries across projected and materialized accruals without changing deducted-first-day or generalized weekly behavior.
- Semantically composed main's single-payment and restructure contracts with the generalized weekly-floating lifecycle, preserving legacy floating-policy compatibility, immutable advance-period correction bases, exact audited settlement/accrual allocation provenance, pure payment-health reads, and carried-balance and compensating-reversal guards.
- Corrected additive `0036` upgrade projection to derive each floating accrual's contractual period amount from its immutable principal/rate snapshots with exact two-decimal half-up rounding, covered for both percentage and per-thousand rates, and to retain weekly versus daily units on existing rate periods.
- Preserved exact per-source multi-fund payment and settlement attribution at the 29-integer-digit public-money boundary by applying the shared high-precision Decimal context across allocation aggregation, ratio calculation, cent rounding, and final-source remainder conservation.
- Preserved full 29-digit Decimal precision across floating-interest accrual, correction, settlement preview, stale checks, execution, and funding-ledger allocation; rejected floating loans from the legacy closing-summary and direct-close routes; and enforced append-only accrual facts at the PostgreSQL boundary while retaining service-owned payment lifecycle updates and compensating replacements.
- Required public audit and correlation UUIDs on intermediary bank-account, assignment-create/end, and transfer-evidence prepare/finalize MCP results, including operation-specific idempotent replay metadata and fail-closed missing-audit handling, while preserving the existing REST response DTOs.
- Made the literal Bun frontend test gate preload a Bun-compatible DOM and Testing Library matcher setup, and aborted/rejected superseded actual-disbursement ledger reads so a failed newer refresh cannot leave an intermediary post pending.
- Made superseded actual-disbursement reads reject instead of falsely completing, generation-guarded stale read errors while clearing current errors on success, and invalidated deferred post-balance scope controllers on navigation or unmount.
- Unified initial and imperative actual-disbursement reads behind scope/generation ordering, moved intermediary navigation scope updates before passive effects, and made profile transfer tests deterministic with real group-detail fixtures and scoped warning assertions.
- Made intermediary post completion await installation of the refreshed Loan Detail disbursement ledger, guarded deferred profile-balance refreshes against navigation scope changes, cleared blocking refresh warnings only after complete same-key retry success, and aligned Web preview-warning types with backend objects.
- Recomputed intermediary proposal expiry from the live clock on every proposal change, added explicit expired-proposal refresh/re-review, adopted authoritative group and parent financial projections after posting, and blocked stale presentation when that refresh fails.
- Bound intermediary-transfer confirmation and command keys to the exact unexpired proposal ID/hash, refreshed stale proposals for mandatory re-review, cleared prior-profile transfer actions immediately on scope changes, and invalidated pending signed-slip resolution on component unmount.
- Discarded signed transfer-evidence descriptors when their preview closes, including in-flight resolutions, so reopening always requests a fresh short-lived URL.
- Included inactive exact canonical-name and confirmed-alias matches in intermediary search-before-create candidate review, with localized lifecycle status and automatic invalidation of reviewed candidates after any proposed identity edit.
- Preserved 29-digit intermediary portfolio totals with the shared high-precision financial decimal path, replaced declared group-retained summaries with the authenticated authoritative held-balance projection, required exact canonical-name/alias candidate review before profile creation, localized directory statuses and retryable failures, and distinguished missing profiles from service outages.
- Required literal confirmation in the intermediated-disbursement eval harness, validated retained-balance calls and every intermediary-flow input/output against the full frozen JSON schemas, bound each supplied slip's evidence/file UUID and immutable MIME/size/SHA-256 across prepare, ready retry, finalize, and safe inspection, verified signed-upload descriptors against unchanged fixture bytes, and stopped before preview/post on any event or evidence binding mismatch.
- Prevented duplicate intermediary payouts across distinct groups for one active loan, rejected posting after loan closure, required group-level reversal for intermediary-linked payouts, reserved internal payout and compensating keys from public commands, aligned loan-before-event locking across disbursement flows to prevent cross-workflow deadlocks, and exposed source transfer public IDs on reversal results and detail reads.
- Canonicalized reusable intermediary bank identity on required uppercase bank codes with safe legacy ambiguity stops, rejected fully exposed four-digit account masks, replayed original assignment-create audit snapshots after later ends, and grouped multi-role managed portfolios by loan to prevent double-counting.
- Preserved exact loan-detail and settlement money strings beyond JavaScript's safe-integer range, labeled rate timelines by their locked daily/weekly contract, and attached stable idempotency keys to Web loan activation commands.
- Removed native-number conversions from bank-loan allocation state, loan closing, funding matching, loan origination calculators, and the Fund detail allocation summary; aligned REST, MCP, backend, and frontend public money to the existing 32-character unsigned contract (29 integer digits plus two decimals), kept daily interest-rate input distinct from that money-length limit, retained isolated 100-digit Decimal contexts for intermediate calculations, rejected result carry beyond the public bound, and made malformed allocation input stop with localized validation instead of crashing the page.
- Refreshed authoritative loan and profitability state after Web settlement, hid stale accounting when that refresh fails, kept the post-write refresh warning accessible inside the open confirmation dialog, surfaced initial preview errors beside the action, localized loan statuses, scoped non-refundable warnings to advance deductions, and preserved command keys across safe retries while requiring a new key after stale re-preview.
- Hardened intermediary assignment and disbursement persistence against whitespace-only command, provenance, and identity values including tabs and newlines, nullable reversal evidence, and PostgreSQL special numeric money values while retaining exact two-decimal and non-negative invariants where applicable.
- Rejected intermediated transfer events before write when cumulative role totals or signed variance exceed the public-money contract, closed the reconciliation-preview request body, and serialized assignment ends against existing transfer history so backdating cannot invalidate an accepted event.
- Closed every intermediary transfer-evidence query contract, rejected expired or over-15-minute storage access descriptors at the service boundary, and verified finalized-evidence retries never inspect storage again.

### Infra
- Kept the frontend TypeScript 6 build gate operational while the configured `baseUrl` compatibility alias remains in use.
- Consolidated weekly-floating and intermediary persistence into additive migration `0036` after main's immutable single-payment/restructure `0027`–`0035` lineage, preserving seeded financial rows while validating both clean installation and main-through-`0035` upgrade paths.

## v0.3.11 - 2026-08-13

### Added
- Added closed-schema floating-loan settlement MCP tools and CreditSync Plugin `3.0.0` orchestration that displays exact close-out components, requires explicit confirmation and idempotency, re-previews stale state, and refuses to refund already-paid advance interest.
- Added expiring, balance-versioned floating-loan settlement previews and explicitly confirmed idempotent close-out execution that collects exact due and accrued-not-due interest, preserves non-refundable advance history, serializes concurrent payments with row locks, and retains compensating reversal boundaries.
- Added period-aware floating-interest accrual with exact weekly daily projections, immutable rate/principal segment snapshots, Bangkok boundary due promotion, due-only normal payment allocation, and period-grouped payment health.
- Added strict generalized floating-interest origination with exact weekly previews, editable draft policy snapshots, idempotent activation, and atomic non-refundable advance-interest coverage across seven immutable paid daily snapshots.
- Added additive floating period-policy persistence with legacy daily-policy backfill, immutable period/accrual snapshots, and tenant-safe expiring settlement previews.
- Added a Decimal-only floating-interest period-policy kernel with normalized day/weekly contracts, Bangkok half-open boundaries, and cumulative-difference daily accrual rounding.
- Added ordered TDD implementation plans for generalized floating weekly interest and exact settlement, followed by intermediary profiles, loan assignments, multi-leg disbursement reconciliation, and independently viewable transfer evidence.
- Added the approved design for exact daily-prorated floating weekly interest, non-refundable one-period advance interest, intermediary profiles and loan assignments, and fully evidenced multi-leg disbursement reconciliation.
- Added the approved design for borrower-scoped sequential daily-loan collection queues, independently priced follow-on advances, derived downstream collection dates, and previewed append-only payment holidays with optional charges.
- Added a shared accessible Radix tooltip primitive with keyboard, pointer, and touch interaction support for concise contextual guidance.
- Added the v0.3.11 TDD implementation plan for semantic fund-metric icons, accessible localized definition tooltips, clarified net-cash labels, and clean frontend deployment.
- Added the approved design for semantic fund-metric icons and accessible localized definition tooltips across settlement, profitability, and reconciliation summaries.
- Added a Decimal-only funding-attribution kernel that reduces signed allocation history into exact positive per-source shares before attributing borrower payment components.
- Added the v0.3.11 TDD implementation plan for exact direct-capital fund profitability, historical payment attribution, contract-to-ledger reconciliation, localized presentation, and read-only production verification.
- Added the v0.3.11 TDD implementation plan for post-activation append-only multi-source loan funding across database invariants, shared services, REST, MCP/plugin, localized Web controls, and guarded historical allocation.
- Added the approved design for exact direct-capital and drawdown fund-source profitability, full historical payment attribution, and read-only contract-to-ledger revenue reconciliation without mutating financial history.
- Added the approved design for post-activation, append-only multi-source loan funding allocation with compensating adjustments, exact preview/execute workflows, and synchronized Web and MCP visibility.
- Added exact source-attributed collected interest to funding-usage rows, including proportional multi-source allocation and append-only reversal handling.
- Added the v0.3.11 TDD implementation plan for a responsive flat funding-usage list with localized semantic statuses and exact source-attributed collected interest.
- Added the approved responsive fund-usage flat-list design with localized semantic statuses and exact source-attributed collected interest that remains correct across multi-source funding and compensating reversals.
- Added a strict `loan.disbursement.update` MCP PATCH tool for audited, non-empty partial edits to draft-only payout metadata while preserving finalized evidence, with synchronized CreditSync Plugin 2.4.0 skills, contract, and eval stop gates.
- Added the v0.3.11 TDD implementation plan for the strict MCP disbursement-draft PATCH tool, plugin 2.4.0 synchronization, and production deployment.
- Added the approved design for a strict, audited MCP PATCH tool that updates only editable loan-disbursement draft fields, preserves evidence, and requires re-inspection plus fresh post confirmation.
- Added the v0.3.11 TDD implementation plan for repairing and deploying the strict `intake.get` evidence contract with synchronized plugin validation.
- Added the approved design for repairing the strict `intake.get` evidence contract, regression coverage, synchronized plugin validation, and read-only production verification.
- Added the approved design and TDD implementation plan for a flat, divider-separated mobile repayment-history list with concise exact allocation summaries.
- Added the v0.3.11 implementation plan for flat mobile Dashboard repayment queues with divider rows and responsive desktop section containment.
- Added the approved responsive Dashboard repayment-queue design, using flat divider-separated mobile lists and desktop section containment without nested item cards.
- Added the approved design for a Git-backed CreditSync Codex marketplace that tracks `main`, resolves the in-repository plugin path, and documents explicit snapshot refresh and reinstall behavior.
- Added the v0.3.11 implementation plan for marketplace identity validation, Git installation and update documentation, and full plugin-package verification.
- Added the Git-backed `creditsync-marketplace` catalog with exact source-path and package validation plus consistent install, refresh, reinstall, and new-task instructions.

### Fixed
- Required literal confirmation in the floating-settlement eval harness, recorded every exact preview component before confirmation/execute, and corrected the breaking generalized MCP contract release to Plugin `3.0.0`.
- Kept settled and otherwise inactive floating loans readable by deriving payment health from persisted accruals without materializing new interest, while active-loan reads retain serialized accrual locking.
- Serialized floating-interest materialization with settlement and payment writes through the tenant-scoped loan row lock, reloading lifecycle state before accrual changes so paid loans cannot gain concurrent future accruals.
- Prevented backdated floating-loan settlements from closing across later active accruals, and recorded exact funded principal-return, interest-income, fee-income, and penalty-income effects atomically through the shared payment ledger allocation path.
- Fixed weekly floating-interest backdating and corrections to use append-only replacement snapshots with transaction-date provenance, through-date payable filtering, atomic contextual accrual audits, exact period metadata, legacy daily health dates, paid-allocation conflict stops, and cumulative-consistent sparse correction suffixes.
- Rejected unknown top-level and nested floating-origination fields before Elysia normalization, and persisted tenant-scoped activation command keys/results so only exact same-key retries replay while conflicting keys stop without financial side effects.
- Prorated floating-interest accruals from the exact unrounded contractual period amount before cumulative cent rounding, preventing fractional-cent weekly overcharges.

## v0.3.10 - 2026-08-12

### Added
- Added an intermediary collection and remittance workflow with exact explicit allocation, historical posted-payment linking without duplicate financial entries, signed remittance-slip evidence, 11 closed-schema MCP tools, an operator dashboard, and the CreditSync Plugin 2.3.0 orchestration skill.
- Added the v0.3.10 test-first implementation plan for semantic Payment Inbox status colors.
- Added the approved Payment Inbox semantic status-color design for accessible green, gray, amber, blue, red, and orange state distinctions.
- Added compact, localized, on-demand evidence preview dialogs across Payment Inbox, transaction and reconciliation slips, loan disbursement evidence, and borrower ID-card images, with tenant-safe file access descriptors and graceful image, PDF, fallback, retry, and open-original states.
- Added the v0.3.10 test-first implementation plan for shared lazy evidence previews across financial and borrower identity-document surfaces.
- Added the approved shared evidence-preview design for compact, lazy-loaded modal previews of payment slips, disbursement evidence, reconciliation uploads, and borrower ID-card images.
- Added tenant- and owner-scoped Payment Inbox pagination with validated payer search, status filtering, and inclusive Asia/Bangkok business-date filters while preserving the existing MCP list contract.
- Added the v0.3.10 test-first implementation plan for paginated Payment Inbox queries and a responsive flat inbox list.
- Added the approved scalable Payment Inbox design for flat list rows, server-side search and filters, newest-first pagination, localization, and responsive review navigation.
- Added the v0.3.10 test-first implementation plan for semantic positive, negative, and zero transaction-total colors.
- Added the approved semantic transaction-total color design for green positive, red negative, and neutral zero amounts using exact decimal sign classification.
- Added an idempotent, append-only floating-interest accrual correction operation that retains reversed source rows, recalculates exact daily amounts from effective rate periods, and records adjustment and audit context.
- Added the approved app-wide authenticated mobile-spacing and Dashboard flat cash-metric design to reduce edge padding consistently and remove nested-card styling from the cash summary.
- Added the implementation plan for shared authenticated mobile page edges and responsive flat Dashboard cash metrics.

### Fixed
- Serialized every fund-source settlement, profitability, opportunity-cost, and reconciliation amount as an exact two-decimal public string.
- Calculated fund-source settlement and profitability from direct profile allocations as well as drawdowns, attributed historical borrower cash and revenue exactly, and exposed the read-only difference from append-only ledger revenue.
- Prevented evidence-bearing `intake.get` calls from failing strict MCP output validation by exposing the tenant-safe public file UUID through the synchronized evidence contract.
- Prevented the Dashboard command-center and repayment-queue grids from expanding past narrow mobile viewports and clipping trailing actions, amounts, and statuses.
- Colored negative transaction totals red and zero totals neutrally while retaining green for positive totals and preserving the visible amount sign.
- Prevented floating repayments from reducing principal when an active legacy accrual has an impossible zero-principal basis, requiring correction before allocation instead.
- Restored floating principal and paid daily-interest state when reversing the latest posted repayment.
- Excluded append-only reversed floating-interest accruals from Dashboard payable totals so corrected source rows are not counted alongside their active replacements.

### Changed
- Added semantic icons and accessible localized definition tooltips to Fund Detail settlement, profitability, and reconciliation metrics, and clarified cumulative net-cash labels so returned principal is not mistaken for borrower overpayment.
- Displayed exact fund-source settlement and profitability values with a localized semantic contract-to-ledger reconciliation card that never mutates financial records.
- Replaced nested funding-usage cards and the duplicate desktop table with one responsive divider list featuring borrower-first hierarchy, exact source interest, and localized semantic loan-status badges.
- Replaced nested mobile repayment-history cards and full-width review buttons with compact divider-separated transaction rows, non-zero exact allocation summaries, and full-row review navigation while retaining the desktop table.
- Flattened both Dashboard repayment queues on mobile into full-width divider-separated rows, retained clear keyboard focus and exact amount/status alignment, and restored section containment at desktop widths without nested item cards.
- Applied distinct accessible semantic colors to Payment Inbox status badges: green ready, gray draft, amber review, blue posted, red reversed, and orange duplicate.
- Replaced nested Payment Inbox item cards with responsive divider-separated rows, localized payer/status/date filters, result counts, and retained-filter pagination at 25 records per page.
- Standardized authenticated page-edge padding at 16px on mobile while retaining the existing desktop spacing, removed the Dashboard's redundant inner inset, and flattened its cash metrics into responsive divided cells within one summary card.

### Infra
- Added a guarded operational correction command for reversing and reapplying a specifically identified misallocated floating repayment after repairing its accrual history.

## v0.3.9 - 2026-08-11

### Added
- Added a localized floating-interest Loan Detail card showing the exact current daily interest and full timeline, with future effective/expiry dates and preview-before-confirm management available across loan statuses.
- Added three closed-schema MCP tools and CreditSync plugin 2.2.0 orchestration for listing, previewing, and explicitly confirming audited floating-interest timeline changes.
- Added closed-schema REST endpoints for listing, previewing, and idempotently executing floating-interest timeline changes with audit correlation and tenant-cache invalidation.
- Created an initial open-ended rate period for every new floating draft, linked first-day deductions to their source period, and resolved each catch-up accrual date against its own immutable rate snapshot.
- Added tenant-scoped floating-rate list, expiring preview, and idempotent execute services with exact current-interest summaries, automatic timeline splitting, accrued-date protection, concurrency locking, and append-only audit context.
- Added tenant-safe effective-dated floating-interest period and preview storage, legacy-rate backfill, database overlap/precision constraints, and immutable accrual-to-period linkage.
- Added a tested exact-decimal kernel for validating, resolving, splitting, merging, and versioning inclusive floating-interest rate periods.
- Extended the approved floating-interest design and TDD plan with safe MCP list/preview/confirmed-execute tools and a synchronized CreditSync plugin 2.2.0 contract with 7 skills and 29 tools.
- Added the v0.3.9 TDD implementation plan for effective-dated floating-interest periods, previewed range replacement, immutable per-date accruals, REST contracts, and localized Loan Detail management.
- Added the approved effective-dated floating-interest timeline design with scheduled rate changes, previewed automatic range splitting, immutable accrual snapshots, and loan-detail management.
- Added v0.3.9 implementation plans for the Thai-first landing/login redesign, localized loan-list contract summaries, and outstanding-versus-original principal visibility.
- Self-hosted Sarabun in WOFF2 weights 400, 500, 600, and 700 with its SIL Open Font License for the Thai interface.
- Added the v0.3.9 TDD implementation plan for self-hosted Sarabun typography and Thai/English root-language synchronization.
- Added the approved v0.3.9 design for self-hosting Sarabun at weights 400, 500, 600, and 700 and applying it globally whenever the active interface language is Thai.
- Added the v0.3.9 TDD implementation plan for the approved global dark-mode surface hierarchy and responsive visual verification.
- Added the approved v0.3.9 global dark-mode surface-hierarchy design for distinct canvas, card, overlay, control, and nested-panel levels while preserving light mode and financial semantics.
- Added a localized Loan Detail confirmation action for activating persisted drafts without automatically posting disbursements.
- Added a TDD implementation plan for activating persisted loan drafts from Loan Detail and verifying the production workflow.
- Added an approved design for safely activating existing loan drafts from Loan Detail with a localized confirmation summary and no automatic disbursement posting.
- Added the approved Dashboard Daily Command Center design and selected visual reference, covering action-first hierarchy, exact dashboard money contracts, resilient section loading, responsive behavior, localization, accessibility, and design QA.
- Added a task-by-task implementation plan for exact dashboard contracts, action-first responsive UI, scoped loading failures, and visual design QA.
- Added production-preview desktop and mobile design-QA evidence with responsive interaction and console checks.
- Added an approved design for surfacing floating daily-interest arrears as one Dashboard row per loan with exact totals, overdue-item counts, and maximum overdue age.
- Added a TDD implementation plan for a shared borrower-health projection, exact Dashboard floating-arrears contracts, aggregate queue presentation, and production verification.
- Added a tenant-scoped Dashboard borrower-health projection that reuses the scheduled and floating payment-health application service.
- Added browser-QA evidence confirming one floating loan row, aggregate arrears metadata, and schedule-free repayment navigation.

### Fixed
- Prevented dark-mode cards and popovers from visually collapsing into the application canvas, with a focused surface-hierarchy regression test.
- Allowed floating-loan previews to return their daily-interest policy, first-day deduction, exact net disbursement, and next interest date through the strict public MCP contract.
- Preserved exact decimal-string money across dashboard totals, funding gaps, available drawdowns, comparisons, and sorting beyond the JavaScript safe-integer range.
- Prevented the Dashboard from crashing after profitability data loads by serializing its public money contract as two-decimal strings.
- Included floating daily-interest arrears in Dashboard borrower totals and queues as one exact aggregate row per overdue loan.

### Changed
- Extended the frozen loan-route composition test to include the floating-interest list, preview, and execute endpoints.
- Clarified commit discipline so every commit stages its changelog entry with the related changes under an explicit version, date, and Added/Changed/Fixed/Infra group.
- Applied Sarabun across Thai-language screens while preserving the existing system font stack for English and monospace data presentation.
- Synchronized the root HTML language with initial and runtime Thai/English i18next selections so language-dependent typography and accessibility metadata update together.
- Raised dark-mode cards, navigation, overlays, controls, and nested panels onto distinct semantic surface levels across the application.
- Rebuilt the responsive operations dashboard as a Daily Command Center with a consolidated cash position, urgency-ranked actions, five-item repayment queues, localized statuses, independent loading and retry states, and collapsible mobile financial details.
- Displayed floating daily-interest arrears as one localized borrower-queue row per loan with overdue-item count, maximum age, and schedule-free repayment navigation.

### Infra
- Reconciled the divergent remote main history while retaining the current audited financial architecture and rejecting obsolete Number-based analytics and legacy AI-tool routes.
- Made disposable PostgreSQL verification wait through the PostgreSQL 18 initialization restart before running migrations and tests.

## v0.3.8 - 2026-08-11

### Added
- Added a shared account navigation and safe local sign-out contract, plus the approved implementation plan for the unified Account and Preferences page.
- Added the localized, read-only Account and Preferences page with explicit language and appearance choices, accessible feedback, session controls, and safe identity fallbacks.

### Changed
- Connected Profile, Settings, desktop/mobile navigation, and the legacy `/dashboard/settings` path to the canonical protected Account and Preferences destination.
- Documented that account identity is read-only and display preferences remain device-local rather than backend-synchronized.

### Fixed
- Kept appearance changes active in memory when browser theme persistence is unavailable.

## v0.3.7 - 2026-08-11

### Added
- Added accessible Thai/English due-now and overdue indicators on loan cards, with exact amounts, installment/day counts, overdue age, and localized detail-schedule badges.
- Added tenant-safe loan-list payment-health summaries for fixed schedules and materialized floating daily-interest accruals without per-card API requests.
- Added an exact Decimal payment-health kernel for scheduled arrears, grace periods, late fees, and next-day floating-interest overdue classification.
- Added a task-by-task implementation plan for exact scheduled and floating loan payment-health summaries, localized card indicators, detail badges, and full verification.
- Added an approved design for localized payment-health indicators on loan-list cards, including fixed-schedule arrears and next-day floating daily-interest overdue rules.
- Added an approved unified Account and Preferences design with read-only Google/tenant identity, client-side language and theme controls, functional navigation, and safe logout behavior.
- Added authenticated REST endpoints for manual intermediary setup, collection capture and approval, remittance draft selection, preview, posting, and reversal.
- Added tenant-admin manual approval and reasoned compensating reversal for intermediary collections, preserving original borrower-paid dates and immutable repayment history.
- Added atomic posting for exact intermediary remittance selections, creating one immutable loan payment per collection at the original borrower-to-intermediary payment timestamp.
- Added idempotent intermediary remittance drafts with persisted explicit collection selection, exact Decimal balance summaries, exclusive active reservations, and versioned ready/needs-review previews.
- Added manual intermediary creation/search/update and idempotent borrower-to-intermediary collection capture that preserves exact amounts and effective dates without posting a loan transaction.
- Added the tenant-scoped intermediary, borrower-collection, grouped-remittance, explicit-allocation, and versioned-proposal ledger schema with exact-money checks, active reservation uniqueness, and immutable settled/post records.
- Added a task-by-task implementation plan for the approved intermediary collection/remittance ledger, manual workspace, evidence viewer, MCP orchestration, controlled intake migration, and full verification.
- Added an approved manual-first, AI-assisted design for two-leg intermediary collections and grouped remittances, including explicit balance allocation, exceptional manual approval, evidence viewing, immutable posting, and MCP safety boundaries.
- Added an approved design for shared date/date-time inputs with right-aligned picker icons and expandable quick-repayment notes.
- Added loan-list cards that show outstanding principal with a muted original-principal reference.
- Added an approved design for loan-list cards to show outstanding and original principal together.
- Added source-level funding-usage reads and a localized funding-source table showing the borrower contracts funded by each source, their net allocation, route, allocation date, outstanding principal, and status.
- Added loan-scoped repayment-intake history with quick capture, tenant-safe origin-loan links, and legacy allocation/transaction discovery without altering posted financial records.
- Added a borrower-first repayment flow: desktop quick capture opens a dialog, mobile opens the prefilled full form, and both continue to Payment Inbox for review before posting.

### Changed
- Documented the approved responsive layout for funding-source details at tablet and compact-desktop widths.

### Fixed
- Kept the payment-intake origin-loan migration test additive after later migrations are registered.
- Signed every payment/disbursement evidence header returned to upload clients and added floating-loan compensating reversal support.
- Ordered new intermediary composite-key indexes before their tenant-safe foreign keys so the additive migration applies cleanly to a fresh PostgreSQL database.
- Made funding-source summaries and loan allocations readable in tablet and compact-desktop layouts without content collisions.
- Preserved the frozen MCP `intake.create` output contract after repayment-history responses gained an origin-loan reference.
- Made own-capital availability and utilization subtract net direct loan allocations instead of only bank drawdowns, while keeping external-source credit availability based on issued drawdowns.
- Clarified that own-capital allocations are direct and do not create a bank drawdown record.
- Isolated funding-usage integration tests from tenant-cache state between disposable database resets.
- Moved the mobile account avatar into the top header, added the shared favicon mark beside the CreditSync title, and removed the duplicate account menu from the drawer.
- Reduced borrower-card header and action-row vertical padding for a denser mobile list without changing the shared card component.

## v0.3.6 - 2026-08-10

### Added
- Added the approved loan-list contract-summary design: localized repayment terms, clearly labelled start/creation dates, and removal of internal funding/profitability metrics from list cards.
- Added the localized loan-detail disbursement ledger UI with draft, optional signed-upload evidence, posting, and compensating reversal controls.
- Added fixed daily-repayment term summaries and clear own-capital versus bank-drawdown funding labels on loan details.
- Added an approved Thai-first landing and login redesign specification focused on a trustworthy operations overview, clear Google sign-in entry, localization, accessibility, and verification boundaries.
- Added an approved design for entering fixed daily loans from either a borrower-proposed daily payment or a flat daily-interest term.
- Added a task-by-task implementation plan for daily loan entry modes, shared Decimal calculations, API/MCP parity, and wizard verification.
- Added Decimal-based normalization for fixed daily loans entered from a proposed daily payment or from flat daily interest terms.
- Added additive daily-loan entry metadata and service previews so the selected input method is auditable alongside derived schedule terms.
- Added optional daily-loan entry contracts to REST and remote MCP loan preview and draft workflows.
- Added the daily-loan wizard flow for day/month durations, borrower-proposed payments, flat-interest terms, and localized calculation summaries.
- Added an approved design for an auditable multi-payout loan disbursement ledger with grouped-transfer attribution and optional evidence.
- Added a task-by-task implementation plan for the loan disbursement ledger, evidence workflow, REST/MCP adapters, and loan-detail UI.
- Added an additive immutable loan-disbursement event ledger schema with grouped-transfer attribution, source/payee metadata, reversal links, and optional evidence links.
- Added a tenant-scoped loan-disbursement application service for draft lifecycle, posting, compensating reversals, Decimal-safe variance summaries, evidence attachment, and audit history.
- Added durable idempotency and checksum-verified evidence-intent persistence for loan-disbursement posts and reversals.
- Added reproducible disposable-PostgreSQL coverage for concurrent loan-disbursement posting and evidence-prepare retries.
- Added authenticated REST and Remote MCP adapters for loan-disbursement drafts, evidence, posting, reversal, and variance reads with UUID-only identifiers and exact money strings.
- Released CreditSync Plugin `2.0.0` with the regenerated frozen 26-tool MCP contract, preserving MCP payload schema version `1.0`.
- Released CreditSync Plugin `2.1.0` with the additive disbursement orchestration skill and executable lifecycle safety evals for evidence ordering, variance, confirmation, idempotency, schedule immutability, and reasoned reversal.

### Fixed
- Clarified loan-list cards with localized repayment terms, start dates, Bangkok creation timestamps, and no per-card funding/profitability lookups.
- Made v0.3.6 loan-disbursement history visibly identify grouped posted and reversed transfers with localized exact gross and loan-attributed amounts.
- Made concurrent loan-disbursement reversal verification order-independent while requiring exactly one durable creation, one idempotent replay, and one reversal audit record; serialized the shared disposable PostgreSQL suite to prevent cross-test database interference.
- Made compensating loan-disbursement reversal records immutable at the PostgreSQL boundary and preserved exact decimal-string disbursement values throughout the UI payload and grouped-transfer validation.
- Executed the reversal immutability assertions against PostgreSQL instead of only constructing query builders.
- Replaced the loan-wizard daily-calculation `any` with the exact response shape so the frontend lint gate is clean.
- Open the evidence popup synchronously before resolving its signed URL, preventing normal browser popup blockers from discarding the evidence view.
- Resolved evidence access URLs through the authenticated API client and made the protected file access route accept file public UUIDs.
- Aligned the loan-detail disbursement UI with the ledger REST response, retained idempotency headers for post/reverse retries, refreshed compensating reversals, and exposed source, payee, and evidence details.
- Enforced tenant-safe event/file evidence links and blocked update or deletion of posted loan-disbursement ledger records at the database layer.
- Returned source-bank-profile public UUIDs on disbursement events and rejected nested REST event commands whose parent loan UUID does not match.
- Rejected draft evidence-ID arrays consistently in REST and MCP instead of silently discarding them; evidence must follow the signed prepare/finalize lifecycle.
- Updated the loan-wizard regression test to exercise the accessible daily repayment radio chip and current daily-entry payload.
- Removed the duplicate custom calendar icon from the loan start-date field; the browser-native date control remains fully clickable.
- Made the disposable PostgreSQL migration integration test self-isolate from an already-migrated suite database and restore the latest migration state afterwards.
- Corrected the floating-loan precision activation regression to supply the required daily-interest policy before asserting exact Decimal persistence.

### Changed
- Documented durable lending, actual-disbursement, MCP/plugin, evidence, and verification rules for future agents in `AGENTS.md`.
- Simplified the loan-detail title and moved the full public loan ID into a compact copyable secondary line.

### Changed
- Moved repayment-type selection to the start of the loan-terms form so the remaining inputs follow the selected repayment workflow.
- Refactored the public loan REST adapter into focused contract, funding, and disbursement route modules while preserving paths, schemas, authorization, cache behavior, and financial write workflows.

## v0.3.5 - 2026-08-10

### Added
- Added additive schema support for floating daily-interest loan policies and date-unique immutable interest accrual records.
- Added Decimal-based daily-interest calculations for fixed-per-thousand and percent rate modes with explicit first-day rules.
- Added floating daily-interest policy inputs to loan preview/draft REST and MCP contracts, plus localized wizard controls.
- Added partial-payment tracking for floating-interest accruals and an immutable disbursement record for first-day deductions.

### Fixed
- Preserved floating-loan balances during payment posting instead of deriving them from an empty fixed-installment schedule.
- Hid the irrelevant annual-interest input when the wizard uses floating daily interest.
- Made the loan start-date control open its native picker from the full input area and aligned its calendar affordance to the right.
- Removed fixed term length from floating loans and changed repayment/daily-interest choices to direct chip controls.
- Added an approved borrower-card identity design specification covering responsive one/two-column layout, sensitive Thai-ID masking, full-value copy behavior, avatar hierarchy, localization, accessibility, and verification requirements.
- Added a task-by-task implementation plan for the approved borrower-card identity design.
- Added Thai national-ID formatting and masking utilities for privacy-aware borrower-list presentation.
- Added a responsive borrower identity card with masked ID display, an accessible full-value copy action, and localized copy feedback.
- Added an approved design specification for auditable floating daily-interest loans with per-thousand and percent rate modes, first-day treatment, accrual ledger, explicit payment allocation, and MCP/Web parity.
- Added an approved design specification for direct own-capital funding, configurable 2.00% annual opportunity cost, capacity enforcement, and cash-versus-economic profitability reporting.
- Added a task-by-task implementation plan for direct own-capital selection, capacity enforcement, and non-cash economic profitability.
- Added the additive own-capital opportunity-cost policy migration with a non-negative annual rate defaulting to 2.00%.
- Added Decimal-based annual opportunity-cost calculation for capital-pool reporting without creating a cash expense.
- Added an additive direct-capital funding-profile reference on loan drafts and active loans, mutually exclusive with a bank drawdown.
- Added direct own-capital selection to loan drafts, activation-time capacity enforcement, an initial profile allocation, and the same public contract through REST and MCP.
- Added non-cash own-capital opportunity cost and economic spread to the funding-profile profitability response and detail view.

### Fixed
- Corrected the direct-own-capital plan's five-day 2% annual opportunity-cost example to ฿1.37 for a ฿5,000 allocation.
- Corrected the direct-own-capital design and plan to persist a selected direct-capital profile on the loan draft before activation.

### Changed
- Changed new personal funding sources to default to an own-capital pool with a configurable 2.00% annual non-cash opportunity-cost rate, and added an explicit conversion action for existing personal sources.
- Changed the loan wizard to group own capital, bank drawdowns, and unallocated funding choices.
- Changed the Borrowers list to a one-column mobile and two-column desktop grid using the privacy-aware identity card.
- Changed borrower-card sizing to use the available list width, keeping a single card full-width in a narrow content panel while fitting additional columns only when they have room.
- Changed the borrower-detail profile avatar to 72px on small screens and 80px from `md` upward, reducing visual weight without losing profile hierarchy.

### Fixed
- Replaced customer national-ID examples in the borrower-card implementation plan with synthetic test data so sensitive identity data is not committed to source control.

## v0.3.4 - 2026-08-10

### Added
- Added CreditSync Plugin `1.0.0` with a private app manifest, repository marketplace, five sequentially tested workflow skills, matching/financial/error references, and positive/negative eval contracts.
- Added executable plugin validation for manifest discovery, frozen MCP tool names, marketplace paths, forbidden deferred capabilities, eval coverage, and common secret patterns.
- Added deployment, Cloudflare HTTPS MCP, bearer rotation, MinIO evidence, private registration, backup/restore, reconciliation, and operational rollback documentation.

### Changed
- Documented application release `v0.3.4` as the truthful integration release while retaining the plugin's independent `1.0.0` contract and the existing frozen MCP schema version `1.0`.
- Documented that the committed private-app technical ID is a non-runnable registration placeholder and that live installation/authentication remains an operator step.

### Fixed
- Normalized frontend container asset permissions so generated favicon, touch-icon, and web-manifest files remain readable by nginx under restrictive host umasks.
- Preserved stable REST and MCP drawdown-capacity errors for already-overallocated legacy states by reporting zero allocatable remaining capacity without weakening atomic rejection or rollback.
- Serialized draft-loan activation on its tenant funding drawdown and rejected exact Decimal principal allocations beyond the signed net remaining capacity, with atomic rollback for serial and concurrent conflicts.
- Kept persisted payment-intake review warnings inside the frozen MCP 1.0 output schema so real default-adapter posting, retrieval, and reversal calls remain valid after the web review changes.
- Hardened Plugin `1.0.0` with a deterministic full `tools/list` metadata snapshot and executable scripted-MCP evals covering exact call order/arguments, repeated alias operations, duplicate/stale/review/unauthorized stops, confirmation, reversal, idempotency, and forbidden upload/write effects.
- Accepted real registered private-app technical IDs without weakening the documented non-live placeholder state, and corrected duplicate-evidence and renewal-reversal orchestration to match the frozen MCP surface.
- Corrected operator guidance so bearer hashes exclude trailing newlines, MinIO recovery preserves and verifies evidence metadata/checksums, and disabling MCP does not take the shared REST backend offline.
- Corrected Plugin `1.0.0` renewal reversal to retain borrower identity before execution, derive renewal/old/new loan IDs from the same-task execute result, inspect only portfolio-exposed loan states, and rely on the atomic backend reversal command to return downstream blockers safely.
- Aligned Plugin `1.0.0` blocked-renewal behavior with the real sanitized backend error: `RENEWAL_REVERSE_BLOCKED`, its backend message, and aggregate `downstreamEntryCount` only, without invented transaction or adjustment identities.

## v0.3.3 - 2026-08-10

### Added
- Added persisted semantic-duplicate review warnings and a required, audited reason for payment reversals across REST, MCP, and the web review flow.
- Added Vitest/jsdom component coverage for payment splits, warning gates, intake-selection races, reversal confirmation, exact loan-term handoff, borrower alias/history states, and renewal retry idempotency.

### Changed
- Changed manual payment entry to create a review-first intake, allowing evidence and explicit multi-loan allocations to be reviewed before posting.
- Restored recommended frontend lint severities globally and confined unavoidable legacy React/TypeScript exceptions to explicit existing files.
- Recorded the independent-review fix matrix and final verification evidence in the Task 7 implementation report.

### Fixed
- Preserved identical user-entered daily-loan terms from preview through draft creation instead of deriving fixed terms from rounded preview rows.
- Preserved exact public money strings in confirmation displays, retained payment preview baselines, ignored stale intake responses, and reused renewal execution/reversal keys for retries of the same intent.
- Distinguished loading, empty, forbidden, and failed audit states; localized workflow domain errors and audit actions; and displayed renewal interest, fee, and penalty components separately.
- Bound ready payment proposals to the exact allocation-editor revision, invalidating them on every edit/add/remove/selection change and discarding stale in-flight preview responses before Post can reappear.
- Preserved the frozen MCP schema-version 1.0 `payment.reverse` input by keeping `reason` optional and supplying a stable audit reason for legacy clients, while REST/web reversals continue to require an operator reason.
- Caught manual Payment Inbox refresh failures and announced the localized error without leaving the refresh control busy.

## v0.3.2 - 2026-08-10

### Added
- Added localized Payment Inbox review surfaces for duplicate status, signed evidence, explicit allocation previews and differences, posting, reversal, and audit/correlation identifiers.
- Added borrower alias confirmation/deactivation with revision history, explicit loan draft activation, and daily-renewal previews covering recovered principal, charges, waivers, cash movement, replacement schedules, confirmation, and reversal.
- Added focused Bun tests for exact-money workflow DTOs, payment create-preview-post ordering, duplicate short-circuiting, and renewal idempotency headers.

### Changed
- Migrated the manual repayment form from the disabled legacy transaction write to the payment-intake create, explicit-preview, and post workflow.
- Updated Thai and English workflow copy together and formatted workflow money and dates with the active application locale.
- Aligned the frontend lint gate with the existing non-Compiler React codebase while retaining strict TypeScript production builds.

## v0.3.1 - 2026-08-10

### Added
- Added the approved Connected Capital design specification for the CreditSync favicon and PWA app icon asset set.
- Added the implementation plan and ignored local workflow directories for isolated favicon development.
- Added the Connected Capital SVG favicon, browser PNG variants, Apple touch icon, and PWA manifest assets to the frontend.

## v0.3.0 - 2026-08-09

### Added
- Added a Decimal-based money kernel, exact daily fixed-installment schedule generation, and oldest-first repayment allocation primitives.
- Added a Bun-backed backend TypeScript typecheck gate and focused money-kernel tests.
- Added the v0.3.0 agent-workflow data foundation for borrower aliases, payment intake/evidence matching, transaction reversals, loan renewals and adjustments, tenant-scoped idempotency, and append-only audit history.
- Added shared borrower and loan-application services with normalized alias search, public-ID presenters, command-context audit metadata, borrower portfolios, editable loan drafts, previews, and idempotent activation.
- Added the complete payment-intake workflow: data-only capture, signed S3/MinIO evidence PUTs and verified finalization, hard-duplicate idempotency, semantic warnings, deterministic/explicit grouped matching, review queues, atomic posting, and compensating reversal.
- Added the daily-loan renewal workflow with versioned expiring previews, exact posted-principal recovery, charge settlement or reasoned waiver, confirmed idempotent execution, proportional funding carry-forward, fresh schedules, and append-only reversal.
- Added the private stateless Remote MCP server with 20 versioned borrower, payment, evidence, loan, renewal, and read-only funding-source tools backed directly by shared application services.
- Added SHA-256 bearer-token rotation, fixed tenant/actor principals, host allowlisting, Dragonfly-backed rate limiting with a safe local fallback, sanitized correlation logging, and an MCP health check.
- Added PostgreSQL and Dragonfly regression coverage for exact schedules and activation rollups, concurrent activation, the authenticated draft lifecycle, public funding DTOs, mutation audits, duplicate aliases, and cache invalidation, including large-value monthly, weekly, and daily money cases.

### Changed
- Loan creation is now draft-first: `POST /loans` stores editable terms without a schedule, while `POST /loans/:id/activate` locks the terms and creates the schedule once. The current web wizard performs both steps to preserve its existing confirm-and-create flow.
- Borrower and loan-application REST adapters now delegate to the shared services and use public UUID identifiers at their external command boundaries.
- Payment REST adapters now delegate to the shared payment application service and use UUID command boundaries and exact money strings; legacy `GET /transactions` remains readable while legacy repayment writes return 405 so all balance mutations share one Decimal allocator and lock order.
- Renewal REST adapters now expose preview, execute, and reverse commands under `/loan-renewals`, with UUID identifiers, exact money strings, explicit confirmation/reason fields, and required execution/reversal idempotency keys.
- Production Nginx and backend Compose configuration now expose `/mcp` with streaming-safe proxy settings, preserved MCP/auth/correlation headers, and explicit private MCP environment configuration.
- Loan schedule, closing, allocation-state, profitability, funding-allocation, and funding-reallocation REST payloads now expose public UUIDs and two-decimal money strings; funding mutations accept public funding UUIDs and money strings.
- Updated the loan detail, matching, and closing frontend flows for the exact public loan DTOs.

### Fixed
- Hardened the v0.3.0 MCP contract with signed compensating-transaction outputs, PostgreSQL-backed actual-client coverage for all 20 default service mappings, and quota-preserving Dragonfly-to-memory fallback.
- Hardened daily-loan renewals with exact integer-cent funding carry, shared loan-first funding locks, execution-time preview validation, tenant-safe funding provenance, stable concurrent idempotency, exact old-loan state restoration, and operation-scoped reversal replay protection.
- Corrected backend source typing issues surfaced by the new typecheck gate without changing existing workflow behavior.
- Restored bank-loan close timestamp persistence after repayment and hardened daily installment, public schedule-money, and allocation due-date validation.
- Aligned the loan wizard and create API with the two-decimal public-money contract from schedule calculation through loan creation.
- Enforced tenant-safe workflow relationships and reversal references in PostgreSQL, while hardening migration idempotency, uniqueness, and full financial-state preservation tests.
- Conserved principal, interest, fees, row totals, and remaining due across daily, weekly, and monthly schedules, including non-even final installments and values above JavaScript's safe-integer range, by carrying canonical money strings through schedule generation and activation rollups.
- Mapped routine borrower and loan authorization, visibility, state, and duplicate-alias failures to stable domain error codes and statuses.
- Restored tenant cache invalidation after borrower updates so cached loan lists immediately reflect borrower-name changes.
- Serialized payment preview/post/reversal state transitions with PostgreSQL row locks, rejected and marked stale proposals after concurrent balance changes, and kept schedule, loan, transaction, fund-ledger, and audit effects atomic and append-only.
- Persisted exact signed-evidence expiry, hardened delayed signing/finalization races, attributed fund effects only to net economic funded shares, and restored exact schedule/loan lifecycle state on posting and reversal.
- Derived renewal principal from posted non-reversed transaction components instead of cached balances, rejected stale or underfunded executions under PostgreSQL locks, and separated non-cash principal transfer from borrower cash adjustments.

## v0.2.4 - 2026-08-09

### Changed
- Updated backend and frontend dependencies to their latest compatible releases, including the current major releases of Redis, LINE SDK, Google Auth, Vite, ESLint, and Tailwind CSS.
- Migrated the frontend PostCSS, Tailwind, TypeScript, and Vite configuration for the updated toolchain.

## v0.2.3 - 2026-05-11

### Added
- Added a personal lending control center roadmap focused on owner-only daily operations, bot inbox usage, reconciliation, documents, traceability, and export.
- Loan closing now copies a ready-to-send payoff message instead of only copying the raw balance.

### Fixed
- New borrower loans now initialize outstanding principal, interest, fees, and next due date from the generated schedule immediately after creation.
- Generated borrower loan schedules now explicitly start with `paid_total = 0.00`.

## v0.2.2 - 2026-04-08

### Changed
- Borrowers, loans, transactions, and uploaded files now carry an owner user so non-admin accounts can be scoped to their own records.
- Tenant admins (`owner`, `manager`) keep tenant-wide visibility while `collector` and `viewer` accounts are restricted to their own portfolio data.
- Auto-created Google users now become `viewer` by default unless they are the first user in the tenant.

### Fixed
- Dashboard, fund, reconciliation, and audit APIs are now blocked for non-admin roles instead of exposing tenant-wide financial data.
- Frontend navigation now hides admin-only sections for non-admin users and avoids loading admin-only loan metrics in personal views.

## v0.2.1 - 2026-04-07

### Changed
- File uploads now persist internal storage references and resolve to time-limited signed URLs at read time instead of storing permanent public object links.
- Backend storage access now supports S3-compatible presigned URLs by default and can be configured for Azure Blob SAS links through environment variables.
- Frontend resource routes now use first-level paths such as `/funds/:id`, `/borrowers/:id`, and `/loans/:id` instead of nesting everything under `/dashboard`.
- Core URL-facing entities now carry `public_id` UUIDv7 identifiers for cleaner external URLs while preserving internal numeric keys.

### Fixed
- Borrower ID-card images, reconciliation upload evidence, and repayment slip links no longer depend on indefinitely public object URLs.
- Production-style Nginx and env defaults now route signed file URLs through `/files/*` to MinIO instead of the app root.
- Docker tunnel services now join the application network instead of host networking, so Cloudflare ingress can target `frontend`, `backend`, and `minio` by service name.

## v0.2.0 - 2026-04-07

### Added
- Funding source, drawdown, repayment schedule, and fund repayment workflows.
- Matching workspace for allocating one loan across multiple drawdowns and reallocating later.
- Operational dashboard with due queues, alerts, reconciliation status, and profitability widgets.
- Loan detail, profitability, allocation-state, and related backend summary APIs.
- Manual reconciliation workflow for borrower payments, fund repayments, and uploaded evidence.
- Overdue and penalty calculation support for borrower and fund schedules.
- Dragonfly cache integration for read-heavy backend endpoints with tenant-scoped invalidation.

### Changed
- Split Docker flow into production-style infra and app compose files, with Dragonfly added to infra.
- Frontend and backend dashboards now rely on live APIs instead of mock-first summaries in key areas.
- Repository docs now describe local dev, production-style Docker flows, and cache configuration.

### Fixed
- Reconciliation dashboard semantics aligned with actual bank repayment records.
- Fund detail deep-link behavior no longer forces users back to the originally targeted drawdown.
- Cache usage is fallback-safe when Dragonfly is unavailable.
