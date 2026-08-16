# Task 3 fix report

Implemented the review fixes for funding allocation service/routes/schema/tests scope:

- Added tenant-scoped allocation idempotency key/request hash persistence and conflict/replay handling.
- Fixed profile-only preview source resolution and tenant-scoped profile lookup.
- Kept allocation reads loan-accessible while writes/previews remain tenant-admin protected.
- Enforced exact positive two-decimal public money input.
- Applied deterministic loan, drawdown, then profile row locking and preserved newest-first list ordering.

Verification was run with the focused funding tests and backend typecheck.
