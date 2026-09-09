# Production Loan Schema Reconciliation Design

## Context

CreditSync production can list existing loans but cannot create a new scheduled daily-loan draft. The application sends all columns represented by the current Drizzle `loans` schema, while the production table is missing some columns even though its Drizzle journal records migrations that should have introduced them. Production does contain the daily-entry columns from migration `0018`, so the rejected 7,500.00 THB, 75-day, zero-interest preview is valid; the failure is schema drift rather than invalid loan terms.

The borrower named `พี่น้ำ` already exists in production. No loan, schedule, or disbursement was created by the failed request.

## Goals

- Reconcile production to the current application schema through forward-only, repeatable DDL.
- Preserve the existing `preview -> draft -> activate` lifecycle, immutable activation schedule, command context, idempotency, and append-only audit history.
- Prove a 7,500.00 THB scheduled daily loan produces 75 installments of 100.00 THB, zero interest, and a 7,500.00 THB total.
- After activation, represent the actual 4,000.00 THB bank transfer as a separate disbursement event and retain the visible -3,500.00 THB variance from approved principal.
- Avoid attaching identity-card or bank-recipient identity automatically because the supplied images contain conflicting names.

## Non-goals

- Do not bypass services with direct financial inserts.
- Do not edit or delete posted financial records.
- Do not rewrite historical migration files or production journal rows.
- Do not infer that the old 3,500.00 THB balance was newly transferred.
- Do not broaden this change into a general migration-framework rewrite.

## Chosen Approach

Use a forward-only reconciliation migration backed by a schema-drift inventory and a production-shape test fixture. The migration adds only missing current-schema objects with guarded DDL, verifies compatible types/defaults before accepting an existing object, and fails closed on incompatible definitions. Existing migrations remain immutable.

This is preferred over a backend compatibility insert because creation is only the first consumer of the missing fields: activation, schedules, settlement, and later reads would continue to encounter drift. Direct SQL creation is rejected because it would bypass lifecycle and audit invariants.

## Architecture

### Schema inventory

A read-only script compares the current Drizzle schema requirements used by loan origination against `information_schema`, PostgreSQL constraints, indexes, triggers, and `drizzle.__drizzle_migrations`. It outputs object names and compatibility states only; it must not select borrower, identity, evidence, or transaction contents.

The script has two modes:

- `check`: exits non-zero when required objects are absent or incompatible.
- `report`: prints the same object-level findings for deployment evidence.

### Reconciliation migration

Add a new migration after the repository's current migration head. It must:

- add missing loan-origination columns, constraints, indexes, and supporting objects required by the current schema;
- use `ADD COLUMN IF NOT EXISTS` only where an existing compatible column is acceptable;
- validate the type, nullability, default, and constraint definition of pre-existing objects;
- avoid backfilling financial amounts from guesses;
- leave nullable feature metadata null on historical loans when no authoritative value exists;
- use `NOT VALID` followed by explicit validation where a constraint scan warrants it;
- abort before application deployment if any existing object is incompatible.

The migration must not alter production journal history. It is rehearsed against a production-shaped disposable database whose journal and missing-object pattern match production.

### Loan lifecycle verification

Integration coverage exercises the public service path:

1. Preview the daily terms.
2. Create the draft for the existing borrower.
3. Verify the draft audit record.
4. Activate with an idempotency key.
5. Verify 75 immutable schedule rows, each 100.00 THB principal and 0.00 THB interest.
6. Verify first due date 2026-08-17, final due date 2026-10-30, and remaining principal reaches 0.00 THB exactly.
7. Retry activation with the same key and verify the same result without duplicate schedule or audit effects.

All financial arithmetic remains decimal-string based and backend-owned.

### Disbursement workflow

After the repaired application is deployed and the loan is activated:

1. Create an editable disbursement draft with `grossAmount = 4000.00`, `loanAttributedAmount = 4000.00`, channel `bank_transfer`, and the transfer timestamp supported by the supplied slip.
2. Keep evidence optional. If attached later, use `prepare -> signed PUT -> finalize`; never attach a raw file ID.
3. List and inspect the draft. The summary must show approved principal 7,500.00 THB, net posted disbursement 0.00 THB before posting, and the draft event separately.
4. Present the intended post-state variance of -3,500.00 THB and obtain explicit confirmation after inspection.
5. Post with a unique idempotency key, then re-list and verify `netDisbursed = 4000.00`, `variance = -3500.00`, and `under_disbursed` status.

The variance is informational. It must not change principal, schedules, or the old-balance agreement.

## Failure Handling and Recovery

- The inventory or migration stops on incompatible existing definitions; deployment does not proceed.
- Take a database backup and record the current image digest before migration.
- DDL should run transactionally where PostgreSQL permits. A failed transaction leaves the prior schema intact.
- Application deployment occurs only after post-migration schema checks pass.
- Rollback means restoring the previous application image. Newly added nullable schema objects remain in place; no down migration drops data-bearing objects.
- If loan creation fails after borrower creation, reuse the existing borrower and the same idempotency keys. Never create a duplicate borrower or loan.
- If disbursement posting fails, retain the editable draft and inspect it before retrying with the same idempotency key.

## Testing and Deployment Gates

- Unit-test inventory classification for present, missing, and incompatible objects.
- Run the reconciliation twice against the production-shaped disposable database to prove repeatability.
- Run database-backed loan preview/draft/activation/idempotency tests.
- Run backend typecheck and the full disposable PostgreSQL suite relevant to migrations, loan applications, schedules, audits, and disbursements.
- Run frontend test, lint, and build as regression gates.
- Back up production, execute inventory, apply only the approved reconciliation, and execute inventory again.
- Verify expected columns and constraints through the production PostgreSQL container.
- Inspect backend migration/startup logs and confirm MCP health.
- Execute an authenticated preview before creating the real loan.
- Do not create synthetic financial records in production.

## Acceptance Criteria

- Production schema inventory reports no missing or incompatible loan-origination objects.
- Authenticated preview and draft creation return success for the approved terms.
- Activation creates exactly 75 immutable 100.00 THB zero-interest installments totaling 7,500.00 THB.
- The existing `พี่น้ำ` borrower is reused.
- The actual transfer is recorded independently as 4,000.00 THB only after post-draft confirmation.
- The posted disbursement summary retains a -3,500.00 THB under-disbursement variance.
- Every financial write has request/correlation context, actor/source, required idempotency keys, and append-only audit history.
- No identity-card number, QR payload, signed URL, bearer token, or raw evidence content appears in logs or commits.
