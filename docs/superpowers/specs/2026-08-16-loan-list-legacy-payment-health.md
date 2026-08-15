# Loan-list legacy payment-health compatibility

Production stores legacy daily floating accruals without generalized period and penalty columns. The Loan List must calculate its read-only health summary from the legacy columns that exist: tenant/loan IDs, accrual date, interest amount, paid amount, and status.

The compatibility path applies only to the Loan List and floating loans. It must use an explicit Drizzle projection, never call accrual writers, never infer weekly periods, never modify financial data, and preserve exact decimal strings. Scheduled loans retain the existing payment-health path. The frontend error state remains as a truthful fallback.

Acceptance: authenticated production `GET /api/loans` returns 200; legacy floating rows produce daily due/overdue health; tenant filtering is retained; SQL contains no generalized accrual columns; tests/typecheck/frontend gates pass; no production migration runs.
