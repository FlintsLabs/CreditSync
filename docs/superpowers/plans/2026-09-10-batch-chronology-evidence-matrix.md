# Batch chronology safety acceptance evidence

Updated: 2026-09-10 on `codex/batch-chronology-safety`.

| Acceptance area | Evidence | Result |
| --- | --- | --- |
| Chronological floating allocation, shuffled input, 75.00 + 45.00 | `backend/src/services/payment-batch-floating.integration.test.ts`; `backend/src/services/floating-allocation-reflow-service.test.ts` | Pass in focused disposable coverage |
| Whole-batch atomic rollback and untouched later item | `backend/src/services/payment-batch-atomic.integration.test.ts` | Pass in focused disposable coverage |
| Missing-day decision, ambiguity, stale preview, single-post bypass | `backend/src/services/payment-batch-atomic.integration.test.ts`; `backend/src/services/payment-chronology-guard.test.ts` | Pass in focused disposable coverage |
| Existing legacy temporal-reflow preview/execute | `backend/src/services/payment-reconciliation-reflow-service.test.ts` | Pass: 6 tests, 32 assertions in the latest isolated disposable run; includes two floating loans, multiple later transactions, exact 75.00 + 45.00 conservation, concurrent replay, stale state, and pending/rejected evidence exclusion |
| Reflow idempotency, concurrency, rollback, and append-only provenance | `backend/src/services/payment-reconciliation-reflow-service.test.ts`; `backend/src/services/payment-reconciliation-service.test.ts` | Pass: reflow 6/6 with concurrent exact replay; reconciliation 22/22 including intermediate-write rollback and two-loan barriered replay |
| Reverse/restore compensation provenance | `backend/src/services/payment-restore-floating.integration.test.ts`; `backend/src/services/payment-reconciliation-service.test.ts` | Pass: restore 8/8 and reconciliation 22/22, including child evidence binding, exact component split, stale evidence, capacity recheck, lock ordering, and unsupported penalty provenance fail-closed |
| Reflow migration, immutability, tenant FKs | `backend/src/db/payment-reconciliation-reflow-migration.test.ts` | Pass: 4 tests, 25 assertions in final disposable runner; 0070 replay plus 0071/0072 trigger/provenance parity |
| Reflow MCP closed schemas and plugin synchronization | `backend/src/mcp/server.ts`; `plugins/creditsync/references/mcp-tool-contract.json`; plugin tests/validator | Pass: plugin 10.0.0, 129 tools, 56 tests, validator green |
| Backend typecheck | `backend/package.json` `typecheck`; `.codex-task-logs/backend-typecheck.log` | Pass: `tsc --noEmit` |
| Frontend test/lint/build | `frontend/`; `.codex-task-logs/frontend-*-final.log` | Pass: Vitest 293/293, lint, and production build |
| Full backend disposable suite | `backend/scripts/test-disposable-postgres.sh`; `.codex-task-logs/backend-full-final-v5.log` | Pass: exit 0, 135 test files, 975 pass, 3 historical cache-only skips, 0 fail/timeouts; runner is serialized, resets disposable schemas, reapplies migrations, and starts a fresh Bun process per file. Skips remain explicitly non-acceptance and no financial DB invariant is certified by a skip. |
| Authenticated browser acceptance with synthetic tenant | `frontend/e2e/payment-batch-local.spec.ts`; `frontend/playwright.config.ts`; `.codex-task-logs/browser-qa/`; `.codex-task-logs/browser-qa-final.log` | Pass: 1 Playwright test in 3.9s on localhost:5183 with unchanged auth middleware, local synthetic JWT, mocked API/OCR boundary, and four final screenshots; not backend financial-write evidence |
| Actual bank-slip OCR accuracy | Only synthetic Tesseract.js/WASM runtime smoke exists | Remaining gap: runtime verified, bank-slip accuracy not certified |

This matrix records evidence without treating focused or synthetic checks as a
release-ready acceptance claim. No production repair or financial write was
performed.
