# Task 3 Report: REST, MCP, Plugin, and Web Union Contracts

## Outcome

Task 3 synchronizes the public union contract while keeping merge parent `5268363` authoritative for single-payment and restructure behavior and retaining generalized weekly-floating, settlement, intermediary assignment, and multi-leg disbursement behavior additively. No production system was accessed or deployed.

The authenticated MCP surface now advertises 63 exact frozen tools. Because this adds the main restructure and waiver tools to the feature branch contract and the plugin compatibility policy reserves additions for a new major, the private plugin is synchronized at `6.0.0` with ten skills, 19 positive eval cases, and 43 negative eval cases.

## RED evidence

- `backend bun test src/mcp/server.test.ts` initially failed while loading the server because the composed MCP loan terms omitted main's `floatingDailyInterest` and `singlePayment` schemas.
- `backend bun x tsc --noEmit` initially reported 20 diagnostics: two migration-test `RowList` typing gaps and 18 missing MCP schemas, imports, and service-adapter arguments.
- Plugin tests initially reported `40 pass`, `3 fail`: the frozen tool response differed from the actual authenticated `tools/list`, restructure eval catalog coverage was absent, and counts/version metadata were stale.
- Frontend Vitest initially reported `165 pass`, `5 fail`: exact locale parity, main restructure lineage/opening balances, the single-payment review disclosure, and legacy floating labels were missing from the composed UI.
- The first full frontend rerun reached `169 pass`, `1 fail` only because the settlement UI test exceeded its default five-second timeout under full parallel load; the assertions themselves passed when focused.

## Contract reconciliation

- Restored main single-payment, legacy floating, restructure preview/execute, waiver, version-hash, and opening-balance public schemas without removing generalized `floatingInterestPolicy` fields.
- Kept legacy and generalized floating preview projections distinct so compatibility projection does not erase weekly policy output.
- Adapted `loan.activate` to the main caller contract while continuing to accept an explicit branch idempotency key; missing keys receive the request UUID as command context rather than losing financial write context.
- Regenerated the frozen MCP contract from an authenticated runtime `tools/list` response and synchronized plugin manifest, validator, docs, eval catalog, and compatibility text once.
- Restored Loan Detail restructure/opening-balance surfaces and Loan Wizard single-payment disclosure while retaining settlement, weekly-interest, disbursement, and intermediary panels.
- Synchronized English and Thai locale keys, including plural forms and legacy accrual-cycle labels.
- Replaced the stale legacy floating closing-summary success expectations with the approved `409 FLOATING_SETTLEMENT_REQUIRED` regression, preserving preview/confirm/execute settlement as the only floating close path.

## GREEN evidence

Backend contract and database gate:

```bash
cd backend
scripts/test-disposable-postgres.sh \
  src/mcp/default.test.ts \
  src/modules/loan-closing-summary.test.ts \
  src/modules/loan-restructures.test.ts \
  src/modules/intermediated-disbursements.test.ts
bun test src/mcp/server.test.ts
bun x tsc --noEmit
```

Result: exit `0`; serialized database suites `18 pass`, `1 skip`, `0 fail`, 484 assertions; MCP suite `17 pass`, `0 fail`, 325 assertions; TypeScript typecheck passed.

Frontend gates:

```bash
cd frontend
bun run test
bun test
bun run lint
bun run build
```

Result: exit `0`; Vitest `170 pass`, Bun native tests `39 pass`, ESLint passed, and the Vite production build passed. Vite emitted only the existing advisory that the main minified chunk exceeds 500 kB.

Plugin gates:

```bash
cd plugins/creditsync
bun test
bun run validate
```

Result: exit `0`; `43 pass`, `0 fail`, 1,020 assertions. Validator confirmed plugin `6.0.0`, ten skills, 63 tools, no bundled MCP or secrets, and a non-live private-app placeholder.

Final hygiene: `git diff --check` passed.

## Remaining concerns

The serialized database gate retains one existing skipped cache-invalidation test. All financial and public-contract tests selected by Task 3 ran against disposable PostgreSQL; no newly changed financial invariant relies on the skipped case. The Vite chunk-size message is advisory and unrelated to this semantic integration.
