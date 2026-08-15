# Production Loan-Schema Reconciliation Runbook

This runbook covers the approved forward-only repair of production loan-origination schema drift. It is an operator procedure, not a migration script, and does not authorize production financial writes. Use it only with an approved maintenance window, a current rollback image, and an operator who can stop at every gate.

Repository conventions used here:

- infrastructure: `docker-compose.infra.yml` (`postgres`, `minio`, `dragonfly`, `tunnel`)
- application: `docker-compose.app.yml` (`backend`, `frontend`)
- shared network: `creditsync_runtime`
- production configuration: root `.env.production` (never print or commit it)
- checker/migrations: `backend` package scripts

Task 2's approved migration tag is `0038_production_loan_schema_reconciliation`. At this writing it is a future release artifact. Do not invent a hash, copy a migration into production, or claim that it is installed until the approved migration and metadata have been independently reviewed and shipped.

## Safety rules and stop conditions

Use task-specific variables for paths, containers, databases, and images. Do not use `HOME`, inline passwords, bearer tokens, identity-card values, QR payloads, signed URLs, or evidence contents. Keep output to object names, states, counts, and sanitized health/log lines; do not paste customer rows into tickets or chat.

Stop and preserve evidence if:

- backup fails, is empty/truncated, cannot be listed by `pg_restore`, or has no recorded checksum;
- isolated restore cannot start, restore, or connect;
- the checker reports an object outside the exact approved drift set, or reports an approved object as `incompatible` rather than `missing`;
- a migration errors, the migration log is ambiguous, or `drizzle.__drizzle_migrations` does not advance through the approved tag exactly once;
- a constraint-violation query returns any row, a preservation query changes a public ID/status/principal/accrual value, or counts/totals do not reconcile;
- catalog inspection is incompatible, backend/MCP/frontend health fails, or authenticated preview returns different terms;
- any borrower match is ambiguous, any financial value differs, an idempotency replay duplicates a record, or variance is not exactly `-3500.00`.

Never repair unexpected drift manually. Do not drop additive columns or down-migrate during application rollback. Financial corrections use the existing append-only compensating workflows after separate approval.

## 1. Capture a read-only release baseline

Run from the checked-out release worktree. Confirm the intended branch/image and Compose files:

```bash
set -eu
export CREDITSYNC_COMPOSE_ENV_FILE=.env.production
export CREDITSYNC_INFRA_COMPOSE_FILE=docker-compose.infra.yml
export CREDITSYNC_APP_COMPOSE_FILE=docker-compose.app.yml
export CREDITSYNC_EXPECTED_BACKEND_IMAGE='<approved-backend-image-before-release>'

git status --short --branch
git rev-parse HEAD
git log -1 --format='%H %cI %s'
docker compose --env-file "$CREDITSYNC_COMPOSE_ENV_FILE" -f "$CREDITSYNC_INFRA_COMPOSE_FILE" config --services
docker compose --env-file "$CREDITSYNC_COMPOSE_ENV_FILE" -f "$CREDITSYNC_APP_COMPOSE_FILE" config --services
docker inspect creditsync-backend-prod creditsync-frontend-prod creditsync-postgres-prod \
  --format '{{.Name}} image={{.Config.Image}} imageId={{.Image}} status={{.State.Status}} started={{.State.StartedAt}}'
docker image inspect "$CREDITSYNC_EXPECTED_BACKEND_IMAGE" --format '{{.RepoTags}} digest={{index .RepoDigests 0}}'
docker compose --env-file "$CREDITSYNC_COMPOSE_ENV_FILE" -f "$CREDITSYNC_APP_COMPOSE_FILE" logs --no-color --tail=80 backend \
  | sed -E 's/(Authorization:|Bearer )[[:space:]]*[^[:space:]]+/[REDACTED]/Ig'
```

Record Git SHA, image digest, container state, Compose files, UTC timestamp, and the schema report. If logs contain sensitive material, stop and protect the source rather than copying it.

Run the shipped read-only checker. It inspects PostgreSQL catalogs and the migration journal, not loan rows:

```bash
docker compose --env-file "$CREDITSYNC_COMPOSE_ENV_FILE" -f "$CREDITSYNC_APP_COMPOSE_FILE" exec -T backend \
  bun run schema:check:loan-origination
```

The backend's protected runtime must provide `DATABASE_URL`; never type or print the resolved URL. A non-zero checker exit is a gate failure.

## 2. Create and verify a recoverable PostgreSQL backup

The archive is written on the operator host, not in the PostgreSQL container. Compose supplies `POSTGRES_USER` and `POSTGRES_DB` inside the container, so no password is placed in the command line:

```bash
set -eu
umask 077
export CREDITSYNC_BACKUP_PATH=/secure/creditsync-backups/creditsync-postgres-YYYYMMDD-HHMM.dump
export CREDITSYNC_BACKUP_PARTIAL_PATH="${CREDITSYNC_BACKUP_PATH}.partial"

test ! -e "$CREDITSYNC_BACKUP_PATH"
test ! -e "$CREDITSYNC_BACKUP_PARTIAL_PATH"
mkdir -p "$(dirname "$CREDITSYNC_BACKUP_PATH")"
docker compose --env-file "$CREDITSYNC_COMPOSE_ENV_FILE" -f "$CREDITSYNC_INFRA_COMPOSE_FILE" \
  exec -T postgres sh -eu -c \
  'pg_dump --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --format=custom --no-owner --file=-' \
  > "$CREDITSYNC_BACKUP_PARTIAL_PATH"
test -s "$CREDITSYNC_BACKUP_PARTIAL_PATH"
pg_restore --list "$CREDITSYNC_BACKUP_PARTIAL_PATH" > /dev/null
sha256sum "$CREDITSYNC_BACKUP_PARTIAL_PATH"
mv -- "$CREDITSYNC_BACKUP_PARTIAL_PATH" "$CREDITSYNC_BACKUP_PATH"
stat --format='path=%n bytes=%s mode=%a' "$CREDITSYNC_BACKUP_PATH"
sha256sum "$CREDITSYNC_BACKUP_PATH"
```

Copy the final archive and checksum to approved external storage. Verify the copy with `pg_restore --list` and `sha256sum -c` through the protected operator process. Do not delete the verified local copy until the external copy is independently readable. This procedure creates no container-side temporary dump.

## 3. Restore into an isolated disposable PostgreSQL instance

Use a new disposable container and a protected env file containing only temporary database settings. The env file is an operator placeholder and must not be committed:

```bash
set -eu
export CREDITSYNC_RESTORE_ENV_FILE=/secure/creditsync-rehearsal/postgres.env
export CREDITSYNC_RESTORE_CONTAINER=creditsync-postgres-rehearsal-YYYYMMDDHHMM
export CREDITSYNC_RESTORE_DB=creditsync_rehearsal
export CREDITSYNC_RESTORE_PORT=55432
test -r "$CREDITSYNC_RESTORE_ENV_FILE"

docker run --detach --rm --name "$CREDITSYNC_RESTORE_CONTAINER" \
  --env-file "$CREDITSYNC_RESTORE_ENV_FILE" \
  -e POSTGRES_DB="$CREDITSYNC_RESTORE_DB" \
  -p "127.0.0.1:${CREDITSYNC_RESTORE_PORT}:5432" postgres:18
trap 'docker rm --force "$CREDITSYNC_RESTORE_CONTAINER" >/dev/null 2>&1 || true' EXIT
until docker exec "$CREDITSYNC_RESTORE_CONTAINER" pg_isready -U "$POSTGRES_USER" -d "$CREDITSYNC_RESTORE_DB"; do sleep 2; done
docker cp "$CREDITSYNC_BACKUP_PATH" "$CREDITSYNC_RESTORE_CONTAINER:/tmp/restore.dump"
docker exec "$CREDITSYNC_RESTORE_CONTAINER" sh -eu -c \
  'pg_restore --clean --if-exists --no-owner --dbname="$POSTGRES_DB" /tmp/restore.dump'
```

Set the isolated URL only in the current process; do not echo it:

```bash
export CREDITSYNC_RESTORE_DATABASE_URL="postgresql://${CREDITSYNC_RESTORE_USER}:${CREDITSYNC_RESTORE_PASSWORD}@127.0.0.1:${CREDITSYNC_RESTORE_PORT}/${CREDITSYNC_RESTORE_DB}"
```

`CREDITSYNC_RESTORE_USER` and `CREDITSYNC_RESTORE_PASSWORD` come from the protected rehearsal env file. If required extensions/roles are unavailable, stop and fix the rehearsal environment rather than weakening restore commands.

## 4. Confirm the exact pre-migration drift

Against the restored copy, before applying repair:

```bash
cd backend
DATABASE_URL="$CREDITSYNC_RESTORE_DATABASE_URL" bun run schema:check:loan-origination
```

The report must contain exactly these 16 missing nullable columns, these 11 missing constraints, and this one missing partial unique index, with every other contract object `compatible`:

```text
loans.interest_period_unit
loans.interest_period_length
loans.advance_interest_periods
loans.advance_interest_refund_policy
loans.interest_period_anchor_date
loans.single_payment_due_date
loans.single_payment_fixed_agreed_interest
loans.single_payment_interest_policy
loans.single_payment_retroactive_rate_type
loans.single_payment_retroactive_rate
loans.single_payment_late_penalty_mode
loans.single_payment_late_penalty_amount_per_day
loans.single_payment_late_penalty_grace_days
loans.floating_accrual_cycle
loans.activation_idempotency_key
loans.activation_result
loans.loans_term_months_check
loans.loans_one_funding_source_check
loans.loans_single_payment_terms_check
loans.loans_floating_accrual_cycle_check
loans.loans_single_payment_money_check
loans.loans_interest_period_unit_check
loans.loans_interest_period_length_check
loans.loans_advance_interest_periods_check
loans.loans_advance_interest_refund_policy_check
loans.loans_interest_period_policy_completeness_check
loans.loans_activation_command_completeness_check
loans.loans_tenant_activation_idempotency_unique
```

The first 16 names are columns, the next 11 are constraints, and the final name is the index. A present object with wrong type, nullability, definition, predicate, or index definition is `incompatible` and is a hard stop. Do not accept a merely similar report.

## 5. Apply and verify the repair on the restored copy

Only use the approved release checkout containing Task 1 and the reviewed future `0038_production_loan_schema_reconciliation` migration. Verify lineage before running it:

```bash
test -f backend/drizzle/0038_production_loan_schema_reconciliation.sql
test -f backend/drizzle/meta/0038_snapshot.json
rg -n '0038_production_loan_schema_reconciliation' backend/drizzle/meta/_journal.json
git diff -- backend/drizzle/0037_borrower_id_card_upload_intents.sql backend/drizzle/meta/0037_snapshot.json
```

The first two paths and journal entry are future release prerequisites, not claims about the current branch. The `0037` diff is user-owned work and must be reviewed separately.

Apply the complete ordered chain to the restored copy:

```bash
cd backend
DATABASE_URL="$CREDITSYNC_RESTORE_DATABASE_URL" bun run migrate
DATABASE_URL="$CREDITSYNC_RESTORE_DATABASE_URL" bun run schema:check:loan-origination
./scripts/test-disposable-postgres.sh
bun run typecheck
```

The disposable test script resets a shared database; run it serially. Before/after read-only queries must compare counts and exact Decimal string totals for active-loan principal, floating accruals, schedules, and posted ledgers, plus representative public IDs and statuses. Do not print full rows. Example aggregate checks:

```bash
psql "$CREDITSYNC_RESTORE_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -c "SELECT status, count(*) FROM loans GROUP BY status ORDER BY status" \
  -c "SELECT count(*) AS active_loans, coalesce(sum(principal_amount), 0) AS principal_total FROM loans WHERE status = 'active'" \
  -c "SELECT count(*) AS accrual_rows, coalesce(sum(accrued_amount), 0) AS accrual_total FROM floating_interest_accruals"
```

Run the approved constraint-violation queries from migration review before validation. Any violation, changed seeded principal/accrual/status/public ID, duplicate migration application, or checker mismatch is a stop. Do not backfill unknown historical floating policy metadata.

## 6. Production migration, then application replacement

Stop or route away production writers. Re-capture the baseline and make a fresh backup immediately before this section. Do not use `up --build` as the first migration action when the current image does not contain the approved migration.

Use a reviewed image containing the approved migration and immutable metadata; record its digest first:

```bash
export CREDITSYNC_APPROVED_BACKEND_IMAGE='<approved-backend-image-with-0038>'
export CREDITSYNC_PRODUCTION_MIGRATION_CONTAINER=creditsync-backend-schema-migrate-YYYYMMDDHHMM

docker run --rm --name "$CREDITSYNC_PRODUCTION_MIGRATION_CONTAINER" \
  --network creditsync_runtime --env-file .env.production \
  "$CREDITSYNC_APPROVED_BACKEND_IMAGE" bun run migrate
```

This is an operator placeholder and was intentionally not run for this documentation task. Do not continue on a non-zero result. Inspect the journal and catalog with protected credentials, using metadata only:

```bash
docker compose --env-file "$CREDITSYNC_COMPOSE_ENV_FILE" -f "$CREDITSYNC_INFRA_COMPOSE_FILE" \
  exec -T postgres sh -eu -c \
  'psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -X -v ON_ERROR_STOP=1 \
    -c "SELECT tag FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 3" \
    -c "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema = '\''public'\'' AND table_name = '\''loans'\'' AND column_name IN ('\''interest_period_unit'\'', '\''activation_result'\'') ORDER BY column_name" \
    -c "SELECT indexname FROM pg_indexes WHERE schemaname = '\''public'\'' AND indexname = '\''loans_tenant_activation_idempotency_unique'\''"'
```

Review migration logs for successful `0038` and no error/rollback. Then replace only app containers:

```bash
docker compose --env-file "$CREDITSYNC_COMPOSE_ENV_FILE" -f "$CREDITSYNC_APP_COMPOSE_FILE" up -d --no-deps backend
docker compose --env-file "$CREDITSYNC_COMPOSE_ENV_FILE" -f "$CREDITSYNC_APP_COMPOSE_FILE" up -d frontend
```

The backend command also runs `bun run migrate && bun run src/index.ts`; after the explicit migration this should be idempotent. Do not recreate infrastructure or expose PostgreSQL on a new public port.

## 7. Health and authenticated application verification

Check internal MCP health from the backend container and the public frontend on the configured host port. Deployment notes use `8088` for `FRONTEND_PORT`; use the protected actual value if different:

```bash
docker compose --env-file "$CREDITSYNC_COMPOSE_ENV_FILE" -f "$CREDITSYNC_APP_COMPOSE_FILE" exec -T backend \
  bun -e 'const response = await fetch("http://127.0.0.1:3000/mcp/health"); console.log(await response.text()); process.exit(response.ok ? 0 : 1)'
curl --fail --silent --show-error http://127.0.0.1:8088/ > /dev/null
docker compose --env-file "$CREDITSYNC_COMPOSE_ENV_FILE" -f "$CREDITSYNC_APP_COMPOSE_FILE" logs --no-color --tail=120 backend
```

Health must report only `status: ok`, service `creditsync-mcp`, schema version `1.0`; logs must be sanitized. Authenticated workflow uses the registered private MCP client or Web UI with protected credentials and non-secret request/correlation IDs.

Perform this inspect-first sequence, recording only public IDs and exact money/status results:

1. Search canonical names and confirmed aliases for `พี่น้ำ`; inspect every candidate and stop on ambiguity. Reuse the confirmed borrower; do not create a duplicate or attach identity-card data.
2. Call `loan.preview` for principal `7500.00`, interest `0.00`, daily repayment, 75 days/installments, `100.00` daily payment, and the approved Bangkok start date. Require 75 installments, `0.00` interest, first due date `2026-08-17`, and last due date `2026-10-30`.
3. Call `loan.draft` with the confirmed borrower public UUID. Inspect the draft and schedule before activation.
4. Call `loan.activate` with idempotency key `loan-p-nam-activate-20260816`, then replay it. Require exactly 75 schedule rows, each `100.00` principal and `0.00` interest, total principal `7500.00`.
5. Call `loan.disbursement.draft` with `grossAmount: "4000.00"`, `loanAttributedAmount: "4000.00"`, `channel: "bank_transfer"`, and the returned loan public UUID. Create only; do not post.
6. Call `loan.disbursement.list` and the registered detail/inspection operation; re-list the draft and show intended post-state: net disbursed `4000.00`, variance `-3500.00`, warning `under_disbursed`. Principal and schedules must be unchanged.
7. Pause for a new explicit human confirmation after inspecting this exact draft and variance. Loan confirmation cannot be reused for disbursement posting.
8. Only after that separate approval may the operator call `loan.disbursement.post` with a unique idempotency key, then re-list and verify `posted`, `under_disbursed`, `netDisbursed = "4000.00"`, and `variance = "-3500.00"`. Without confirmation, leave the draft unposted.

## 8. Application-image rollback

If the new image fails health or accounting verification, keep the repaired schema and roll back only to a previously deployed image compatible with additive columns. This repository's Compose file builds from source, so image pinning is an operator/deployment-system placeholder:

```bash
export CREDITSYNC_ROLLBACK_BACKEND_IMAGE='<previous-compatible-backend-image>'
# Use the deployment system's approved image-pinning/rollback mechanism here.
docker compose --env-file "$CREDITSYNC_COMPOSE_ENV_FILE" -f "$CREDITSYNC_APP_COMPOSE_FILE" up -d --no-deps backend frontend
docker compose --env-file "$CREDITSYNC_COMPOSE_ENV_FILE" -f "$CREDITSYNC_APP_COMPOSE_FILE" exec -T backend \
  bun -e 'const response = await fetch("http://127.0.0.1:3000/mcp/health"); console.log(await response.text()); process.exit(response.ok ? 0 : 1)'
```

Do not drop `0038` columns, constraints, or indexes and do not run a down migration. If the previous image cannot start with the additive schema, keep writes blocked and obtain a compatible image.

## Operator evidence and completion record

Attach only sanitized Git SHA, image digests, Compose service states, backup path/checksum, restore result, schema states, migration/log result, aggregate preservation totals, health responses, and public operation IDs. Never attach dumps, env files, bearer tokens, identity values, raw QR/evidence data, or full customer rows.
