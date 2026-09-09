# Production loan list schema compatibility implementation plan

1. Inspect the existing loan-list route, payment-health input requirements, frontend list rendering, translations, and relevant tests.
2. RED: add a backend regression test that exercises the list projection contract and fails because the current query expands unsupported columns.
3. GREEN: replace the full-table loan projection with the minimal explicit deployed-compatible projection; keep real list behavior and response formatting.
4. RED: add a frontend behavior test proving request failure produces an error state rather than the empty state.
5. GREEN: add explicit loading/error state, localized Thai/English copy, and a retry action with the smallest viable component change.
6. Run focused tests after each red/green cycle, then backend typecheck and full frontend test/lint/build.
7. Review the diff for scope, financial safety, exact-money preservation, and changelog discipline; commit once on `codex/prod-loans-schema-compat`.
