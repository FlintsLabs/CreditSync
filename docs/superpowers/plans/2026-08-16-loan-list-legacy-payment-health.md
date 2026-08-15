# Loan-list legacy payment-health implementation plan

1. RED: add a SQL projection test proving the current floating list path selects unsupported generalized accrual columns.
2. RED: add service behavior coverage for exact legacy daily accrual health and tenant/loan filtering.
3. GREEN: add a read-only explicit legacy accrual projection/helper and route floating Loan List health through it; keep scheduled loans on the existing path.
4. Run focused backend tests, disposable PostgreSQL integration tests if required, and backend typecheck.
5. Run frontend tests, lint, and build unchanged as regression gates.
6. Update CHANGELOG under v0.3.14 / 2026-08-16, commit once, and report evidence for independent verification.
