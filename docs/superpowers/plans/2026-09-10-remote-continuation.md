# CreditSync remote continuation — approved implementation handoff

You are the implementation worker taking over from a stopped macOS worker. Continue until the approved plan is genuinely implemented and verified, not merely until the next small checkpoint. Use gpt-5.6-luna with medium reasoning. Follow repository AGENTS.md, executing-plans and TDD; read the actual code before edits. If a named skill is unavailable, report it and follow the recorded plan directly rather than inventing skill instructions.

## Workspace and authority

- Host: flintstone@100.97.147.114, SSH port 2222.
- Repository: /home/flintstone/github/CreditSync.
- Isolated worktree: /home/flintstone/github/CreditSync/.worktrees/batch-chronology-safety.
- Branch: codex/batch-chronology-safety. Integration target main, but DO NOT merge.
- User authorized committing/pushing this feature branch and moving execution to this host. Commit finished, reviewed slices; push only this branch after verification. Never force push, amend, reset, rebase, delete worktrees, clean unrelated files, or rewrite migration history.
- No production deployment, live financial writes/repairs, real borrower queries, paid OCR, credential copying, or changes to other remote tasks/containers. Existing remote main/worktrees/sessions are out of scope.
- Main supervisor owns coordination. Do not launch nested tmux workers or change models silently. If Luna is unavailable, report the exact error and wait for supervisor fallback selection.

## Read first, completely

1. AGENTS.md and applicable nested instructions.
2. docs/superpowers/plans/2026-09-09-batch-chronology-safety.md.
3. docs/superpowers/plans/2026-09-09-batch-chronology-execution.md (historical checkpoints, not proof of completion).
4. docs/superpowers/specs/2026-09-07-floating-reconciliation-temporal-reflow-design.md.
5. docs/superpowers/plans/2026-09-07-floating-reconciliation-temporal-reflow.md and docs/superpowers/plans/2026-09-10-temporal-reflow-task5-delta.md. Old migration/version numbers in older plans are stale; derive latest metadata.

## State at handoff

- Local worker was interrupted deliberately. This handoff commit includes its dirty legacy repair implementation and contract changes, NOT a release-ready acceptance claim.
- Previous committed HEAD dbf4629 included local Tesseract.js/WASM runtime smoke and worker finally cleanup (3f42d75). System tesseract CLI is irrelevant. Synthetic runtime success is not bank-slip OCR accuracy.
- Earlier full backend run: 969 pass, 3 cache-only skips, 0 fail; frontend 293 tests passed, lint/build passed; plugin 9.6.0/127 tools passed. These results PREDATE current legacy-repair changes and cannot certify this HEAD.
- In-progress additions: backend/src/services/payment-reconciliation-reflow-service.ts and its test; MCP reflow repair preview/execute; plugin 10.0.0/129 tools, eval/skill/contract synchronization. Inspect them independently; do not trust comments or passing narrow tests.
- Additive migrations currently through 0072: staging/chronology and reflow proposal/group/entry provenance. Never modify already committed SQL. Financial records and original allocation rows are immutable; use append-only compensation/replay.
- Historical local logs remain on Mac under /tmp/creditsync-batch-resume.cs2Qp2 and .codex-task-logs; they are intentionally NOT in Git. Do not claim to have read them remotely. Generate fresh logs on this host.

## Ordered remaining work

1. Inspect current legacy repair implementation against approved design. Reuse actual accounting planner and existing reflow provenance. Validate source/loan/transaction/evidence lineage before planning; replay chronologically with projected state accumulated after each payment. Unsupported principal/fee/penalty or incomplete provenance must fail closed.
2. Complete real disposable DB coverage for repair preview/execute: no financial writes during preview; expiry/current-state/evidence binding; deterministic borrower locks; identical concurrent key exact receipt; payload conflict; one reflow per reconciliation; tenant/actor access; intermediate-write failure rollback of ledger/allocations/cache/status/audit; two-loan 75.00+45.00 and multiple later transactions; already automatically reflowed cases. Inspect/reverse/restore must follow compensation chains safely using existing workflows and child evidence. Do not create gratuitous new reverse/restore endpoints.
3. Verify actual MCP adapter serialization and closed schemas, safe public UUIDs, audit/correlation metadata, plugin manifest/version/frozen contract/skills/evals/validator together. MCP calls application services directly, never internal REST. Add README for changed public workflow and CHANGELOG before each commit.
4. Finish real browser acceptance using synthetic local tenant and unchanged application authentication middleware. A test-only JWT signed with a local disposable test secret is legitimate testing, not permission to weaken production auth. Build a scoped test harness if none exists. Isolated PostgreSQL/MinIO and localhost app only; do not copy production env/credentials or use real Google accounts. Exercise upload -> OCR/manual review -> resolve -> chronological preview -> explicit confirm -> receipt; shuffled dates, gap decision, ambiguous mapping, 75+45, stale responses, retries and split/cancel. Capture screenshots and verify displayed exact components. If OCR is mocked in a browser test, label it; separately smoke actual Tesseract.js.
5. Audit every acceptance scenario in the approved plan and write an evidence matrix: test/file/result or a concrete remaining gap. Do not equate absence of a service/harness with a blocker when implementing it is explicitly in scope.
6. Run all verification on final code, serialized for DB:
   - backend/: ./scripts/test-disposable-postgres.sh; bun run typecheck
   - frontend/: bun run test; bun run lint; bun run build
   - plugins/creditsync/: bun test; bun run validate
   - Real migration prefix upgrade, immutability, browser QA, and independent safety review.
   Install project dependencies with Bun/frozen lockfiles as needed. Do not run DB suites in parallel or reset any non-disposable DB. Use only runner-owned test resources; do not prune Docker or touch unrelated sessions.
7. Diagnose failures from logs/code before fixes. No blind timeouts, assertion weakening, or skips. Three historical cache skips require explicit reporting; skipped financial DB tests are not acceptance. Re-run full gates after fixes, not only isolated files.
8. Commit coherent verified work with CHANGELOG (and README when relevant), push this feature branch without force, and write final delivery report with HEAD, exact gates, paths, remaining gaps and no merge/deploy claim. Remain available for supervisor review.

## Non-negotiable financial/privacy rules

All public money is two-decimal strings using decimal.js, never Number for money. Bangkok business dates; no invented midnight from unknown times. Upload/OCR never posts. Whole batch atomic across borrowers. Known older pending slips and downstream floating collisions cannot be dismissed by warning acceptance. Bind confirmation to revision, evidence checksums, allocations/components, sequence, accounting state, decisions/reason and expiry. Every relevant edit invalidates preview. No raw slip/QR/account numbers/full references/signed URLs/tokens in logs. Synthetic fixtures only; never use real borrower names/UUIDs.

## Progress and stopping

Keep an accurate execution ledger and safe log files under .codex-task-logs (untracked). Continue authorized work rather than stopping at avoidable partial checkpoints. Stop for an actual user pause, missing authority, unavailable model/credentials, contradictory financial policy, or verified completion. Report concrete blockers and safe checks attempted; do not bypass them. Completion requires full plan and acceptance evidence, not a green build alone. The supervisor will independently review and may send corrections.
