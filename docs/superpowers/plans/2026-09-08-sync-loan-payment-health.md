# Plan: sync loan payment-health projections

1. Add a failing integration regression test covering a floating loan whose persisted outstanding interest is stale while accruals show an overdue amount; assert list and contract/detail projections agree.
2. Extract/reuse a backend read helper that computes payment health once for the contract read path, preserving exact decimal strings and Bangkok date handling.
3. Add the shared projection to the contract/detail response and update frontend consumers to display the same current overdue value without recalculating money in the browser.
4. Run the focused regression test, backend disposable suite/typecheck, frontend tests/lint/build as applicable, and inspect the final diff for unrelated changes.
5. Commit the changelog with the implementation on the feature branch; do not merge, push, or deploy.
