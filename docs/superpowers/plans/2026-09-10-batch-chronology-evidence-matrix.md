# Batch chronology safety acceptance evidence

Updated: 2026-09-10 on `codex/batch-chronology-safety`.

| Acceptance area | Evidence | Result |
| --- | --- | --- |
| Chronological floating allocation, shuffled input, 75.00 + 45.00 | `backend/src/services/payment-batch-floating.integration.test.ts`; `backend/src/services/floating-allocation-reflow-service.test.ts` | Pass in focused disposable coverage |
| Whole-batch atomic rollback and untouched later item | `backend/src/services/payment-batch-atomic.integration.test.ts` | Pass in focused disposable coverage |
| Missing-day decision, ambiguity, stale preview, single-post bypass | `backend/src/services/payment-batch-atomic.integration.test.ts`; `backend/src/services/payment-chronology-guard.test.ts` | Pass in focused disposable coverage |
| Existing legacy temporal-reflow preview/execute | `backend/src/services/payment-reconciliation-reflow-service.test.ts` | Pass: 4 tests, 43 assertions in isolated disposable DB; pending/rejected evidence is excluded from the bound snapshot |
| Reflow migration, immutability, tenant FKs | `backend/src/db/payment-reconciliation-reflow-migration.test.ts` | Pass: 4 tests, 43 assertions in isolated disposable DB |
| Reflow MCP closed schemas and plugin synchronization | `backend/src/mcp/server.ts`; `plugins/creditsync/references/mcp-tool-contract.json`; plugin tests/validator | Pass: plugin 10.0.0, 129 tools, 56 tests, validator green |
| Backend typecheck | `backend/package.json` `typecheck` | Pass after dependency installation |
| Frontend test/lint/build | `frontend/` | Lint/build pass; full test had one existing 10s timeout, isolated `loan-detail-settlement` rerun passed 5/5 |
| Full backend disposable suite | `backend/scripts/test-disposable-postgres.sh` | Not green on this host run: unrelated 5s timeout/deadlock cascade in existing intermediated-disbursement/floating-penalty tests; rerun was serialized and isolated, with failure retained in `.codex-task-logs/backend-full-final.log` |
| Authenticated browser acceptance with synthetic tenant | No scoped Playwright harness exists in this worktree; no production auth or credentials were used | Remaining gap: upload/OCR/manual review/chronology/confirm/receipt screenshots not captured |
| Actual bank-slip OCR accuracy | Only synthetic Tesseract.js/WASM runtime smoke exists | Remaining gap: runtime verified, bank-slip accuracy not certified |

This matrix records evidence without treating focused or synthetic checks as a
release-ready acceptance claim. No production repair or financial write was
performed.
