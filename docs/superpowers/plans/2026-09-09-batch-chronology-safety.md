# CreditSync batch chronology safety — approved implementation plan

User approved implementation on 2026-09-09. Base: fde6b51. This document records the approved chat plan for the isolated implementation worker.

## Execution ownership

Worktree: /Users/kanokpichasonsmacbookair/Documents/GitHub/CreditSync-batch-chronology-safety
Branch: codex/batch-chronology-safety. Integration target: main, but do NOT merge, push or deploy. Parent supervisor owns integration/review. No production MCP calls, financial records, production environments, credentials, or external paid OCR. Initial checkout clean; this plan is supervisor-owned and may be committed with an accurate CHANGELOG entry. Preserve unrelated changes.

Use executing-plans and TDD. Read AGENTS.md and applicable skills. Run baseline first. Work sequentially through all tasks, keeping progress and red/green command results in a companion execution log. Implement, verify and commit each coherent task with CHANGELOG updated first and README in feature commits. Do not stop after a partial slice and call the plan complete. Report real blockers and unmet acceptance honestly. Do not spawn nested tmux workers.

## Global safety and decisions

- Reuse existing atomic batch service and backend accounting engine. Money is two-decimal strings, decimal.js calculations. Bangkok business timezone.
- No posting during capture/upload/OCR. Whole batch atomic including multiple borrowers. One item fails: rollback all and never invoke following item.
- Missing calendar day is an evidence warning, not proof of missed payment. Default hold all. User may acknowledge no older evidence pending with reason and reviewed date range, then obtain NEW preview. This never bypasses a known older draft, duplicate, unresolved identity/evidence, future transfer timestamp or downstream floating collision.
- Explicit split into a new batch with fresh confirmation permits a ready prefix; preserve provenance/dependencies, never silently post a subset or duplicate intake.
- 75+45=120/day is synthetic regression, not permanent borrower matching. Do not commit real names or UUIDs. Multiple candidates require human choice; fuzzy matching ranks only.
- All relevant Web/REST/MCP posting paths share borrower locks sorted by ID; reread state after locks; unresolved borrower blocks its own batch, not whole tenant. Known older pending intake blocks later posting, including across batches. Reject single-post of batch member.
- effectiveDate derives from actual transfer timestamp in Asia/Bangkok; ingestion timestamp separate. Sort by date/time, never file/itemOrder. Unknown time requires review. Stable ties only if allocation equivalent; otherwise explicit sequence choice.
- Posted history append-only. Reconciliation uses compensating/replay entries, never deletes or changes original transaction amount/date/components. Unsupported principal/fee/penalty reflow or missing provenance must fail closed at preview AND execute.
- Every write has command context, actor/source, request/correlation, idempotency and audit. MCP direct services, closed UUID/money schemas, safe result metadata. Never log raw OCR, account/reference/QR, evidence contents, signed URLs or credentials.

## Ordered tasks

### 1. Durable batch staging and retry

Add staging item before intake exists (1–50 slips), unique tenant/batch/clientItemKey. Signed prepare/PUT/finalize evidence belongs to staging draft until validated review creates intake with provenance. No fabricated amount/time. OCR proposals use existing local Tesseract pipeline; transient raw text, review normalized fields before persistence. Per-item errors keep batch unposted and resumable. Persist operation fingerprints/results. Same key same payload returns original IDs/audit; changed payload conflict. Reordered capture matches keys, never array index. Cross-tenant and partial evidence-finalize retries tested.

Migration A: additive staging, revision/decision/operation receipts, fingerprints, reviewed range/reason, split/dependency links. Draft membership audited mutable, posted immutable. Preserve tenant composite FKs. Legacy posted rows read unchanged, companion metadata instead of economic backfill. Legacy draft previews require new preview.

### 2. Shared chronology guard

Implement shared lock/inspect path for batch, single-payment, reconciliation and restore. Test older drafts across batches and single-post bypass, concurrent requests, Bangkok midnight. Classify missing evidence, backdated transfer, advance obligation vs future transfer separately. Audited decisions bind revision; edits invalidate them. No pending unknown borrower tenant-wide lock. Calendar evidence gaps do not invent daily obligations for non-daily contracts.

### 3. Floating multi-contract planner

Migration B: scheduled/floating allocation discriminant; schedule required only for scheduled target, floating period/provenance retained. Snapshot evidence/sequence/accounting inputs; add borrower/date lookup indexes. Do not change past migrations or weaken immutable triggers.

Extract/reuse authoritative accounting planner so sequential projected state feeds later slips; preview writes no financial ledger. Complete accessible borrower loan candidates, explicit ambiguous resolution, multiple allocations per slip. Calculate real principal/interest/fee/penalty, never placeholder all-principal components. Test synthetic 75+45, changed principal, advance, zero variance, ambiguity, chronological input invariance.

### 4. Bound atomic execute

Preview binds revision/membership, amount/timestamp/mapping, finalized evidence IDs/checksums, allocation components/sequence, accounting state, decisions/reasons, 15-minute expiry. After sorted borrower locks validate latest preview/version/TTL/hashes and recomputed state. Reject stale; never silently replace confirmed proposal with fresh per-item previews. Entire ledger, allocations, balances, intake/batch status and audit in one transaction. Cache/notifications post-commit or outbox. Persist exact idempotent execution receipt. Test >=3 items with second failing: zero financial side effects and third not invoked. Test lost response after commit and concurrent keys.

### 5. Reconciliation / restore

Read existing 2026-09-07 temporal reflow spec/plan and current code; memory of another remote branch is NOT evidence of local completion. Reuse proposals/groups/entries; Migration C only for missing provenance linkage. Preview impacted later floating-interest allocations, compensate/replay append-only preserving original transaction date and component totals. Provenance absent or unsupported monetary change => not ready. Restore child owns evidence, source evidence not required. Newly merged payment.restore.evidence.prepare/finalize already exist: reuse and verify, don't duplicate. New evidence works; original-file reuse only via explicit restore provenance link, never weaken tenant duplicate protection globally. Bind selected evidence to preview. Fix floating restore preview/execute parity. Test authorization/idempotency/restore with new evidence and source linkage.

### 6. REST, MCP, UI

Expose shared service contracts for draft/capture, item evidence prepare/finalize, extraction/review, resolve, preview, decision(reason/range/revision), split(selection/dependency), execute(literal confirmation/hash/key), cancel(reason/revision/key). Retain safe legacy interfaces but no guard bypass. Add missing restore REST linkage. Synchronize plugin version/manifest/skills/frozen contract/evals/validator.

Replace manual UUID batch editor with four steps: multi-select/drop/progress; OCR review + borrower/candidates; chronological per-contract preview + gaps/conflicts; explicit confirm/receipt. No auto-post; all relevant edits clear confirmation, ignore stale asynchronous responses, exact money and Bangkok date formatting, paired TH/EN. UI tests must be discovered by default Vitest (existing src batch tests are not). Split UI explicit about held vs selected items.

Statuses: draft, needs_user_confirmation, missing_evidence, chronology_conflict, needs_reconciliation, ready, posting (transient request only), posted, partially_blocked (no financial partial commit), cancelled. reversed/restored are append-only event projections, not rewrites of posted batch rows.

### 7. Verification and handoff

Run backend/scripts/test-disposable-postgres.sh serialized, backend bun run typecheck; frontend bun run test/lint/build; plugins/creditsync bun test and bun run validate. Browser QA only synthetic local tenant/slips. Migration upgrade/immutable trigger tests; exact journal identity/hash/order and append regression, no fixed row counts. Independent supervisor diff/test review at final HEAD. Do not claim skipped DB invariants verified. Report commits, clean/unexplained state, actual commands/results and remaining gates.

Acceptance: 07+08 chronological; shuffled 09/07/08 identical; 07+09 missing08 holds until new confirmed decision; known08draft never bypassed;120 splits75+45; ambiguity blocks; posted08 then07 requires reconciliation; multi-borrower one blocked means all unposted; failsecond rollback and third untouched; retry no duplicate; concurrent Web/MCP/batches don't overtake; reverse/restore new evidence; stale TTL/evidence/balance rejection; Bangkok midnight; DB blocks posted mutation/deletion.

Rollout is documentation only: additive migration first, new guarded write paths enabled together; rollback disables posting rather than restores unsafe writers or drops data. Actual case repair needs separately authorized inspect/preview/confirm/execute. Full task is NOT complete merely because prevention is implemented while reconciliation/UI/tests remain missing.
