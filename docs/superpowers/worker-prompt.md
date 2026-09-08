You are the implementation worker for the approved CreditSync task.

Repository/worktree: /home/flintstone/github/CreditSync-sync-loan-payment-health
Branch: codex/sync-loan-payment-health
Integration target: main (do not merge)
Approved spec: docs/superpowers/specs/2026-09-08-sync-loan-payment-health.md
Approved plan: docs/superpowers/plans/2026-09-08-sync-loan-payment-health.md

Implement only the approved scope. The root cause is already established: GET /loans returns a dynamic paymentHealth projection from floating accruals/allocations, while GET /loans/:id and the contract-facing read expose persisted loans.outstandingInterest. Unify the read model so Loans list and contract/detail expose the same current payment obligation. Preserve persisted ledger fields; do not mutate or backfill financial records. Do not post, reverse, activate, settle, deploy, or push.

Required workflow:
1. Follow TDD: add a focused failing regression test first and run it to confirm the expected failure.
2. Implement the smallest backend shared projection/read-model change. Keep exact decimal strings and Asia/Bangkok business-date behavior. Preserve scheduled-loan behavior.
3. Update frontend/detail and MCP contract-facing adapters only as needed so consumers show the same backend value; do not calculate money in the browser.
4. Run focused tests, backend disposable PostgreSQL tests, backend typecheck, and relevant frontend tests/lint/build. If a gate cannot run, report why.
5. Update CHANGELOG.md under a new explicit version/date heading before committing. Include README.md only if user-facing setup/workflow changes require it.
6. Review the final diff for unrelated changes and commit all implementation, tests, docs, and changelog together. Do not merge or push.

Financial/data-safety requirements:
- Money crossing interfaces remains two-decimal decimal strings; use decimal.js/FinancialDecimal, never JS floating point.
- Read paths must remain read-only and must not write financial records.
- Keep audit/immutability invariants intact.

Dirty-file ownership/scope exclusions:
- This worktree starts clean from main. Do not touch unrelated existing changes in the user's main worktree: backend/src/lib/floating-interest-policy.test.ts and docs/superpowers/plans/2026-09-08-weekly-floating-interest-regression-tests.md.
- Do not modify Docker deployment, production data, Google auth, Playwright, or unrelated UI.

When complete, report: commit hash, files changed, tests run/results, any blocker, and explicit statement that the branch is not merged/pushed/deployed.
