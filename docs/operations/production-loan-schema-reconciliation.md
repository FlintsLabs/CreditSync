# Production loan-schema reconciliation runbook

This is a read-first, forward-only operator procedure for the approved `0038_production_loan_schema_reconciliation` release. It does not authorize production financial writes. Run it only during an approved maintenance window, with a protected rehearsal env file and an explicit stop decision at every gate.

Repository facts used below: `docker-compose.infra.yml` provides `postgres`, `minio`, `dragonfly`, and `tunnel`; `docker-compose.app.yml` provides build-only `backend` and `frontend`; the shared network is `creditsync_runtime`; and the checker is `cd backend && bun run schema:check:loan-origination`.

## Safety gates

Use only task-specific variables. Never use `HOME`, print `.env.production`, passwords, bearer tokens, identity values, QR payloads, signed URLs, evidence, or customer rows. Keep evidence to hashes, object states, counts, exact decimal totals, public operation IDs, and sanitized logs.

Stop and preserve evidence if a backup/restore/readiness check fails; a checker state is unexpected or `incompatible`; a migration or journal check fails; any constraint-violation query returns a row; any fingerprint changes; catalog/MCP/frontend health fails; a borrower match is ambiguous; terms, idempotency, or financial values differ; or the disbursement variance is not exactly `-3500.00`.

The approved pre-repair drift is exactly 16 missing nullable columns, 9 missing constraints, and 1 missing partial unique index. `loans_term_months_check` and `loans_one_funding_source_check` are compatible and must not be listed as missing.

## 1. Capture a read-only baseline

Run from the reviewed clean checkout. The image refs below are discovered from the actual Compose project; do not invent registry tags.

```bash
set -eu
export CREDITSYNC_COMPOSE_ENV_FILE=.env.production
export CREDITSYNC_INFRA_COMPOSE_FILE=docker-compose.infra.yml
export CREDITSYNC_APP_COMPOSE_FILE=docker-compose.app.yml
export CREDITSYNC_EXPECTED_BACKEND_IMAGE='<reviewed-current-backend-image-ref>'

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

Run the checker and record its object-state output. A non-zero result is expected only when the exact approved pre-repair drift is being compared in Section 4; do not treat it as a successful compatibility check.

```bash
docker compose --env-file "$CREDITSYNC_COMPOSE_ENV_FILE" -f "$CREDITSYNC_APP_COMPOSE_FILE" exec -T backend \
  bun run schema:check:loan-origination
```

## 2. Create and verify a recoverable backup

The dump is streamed to the operator host. The only database variables expanded inside the container are its own environment variables.

```bash
set -eu
umask 077
export CREDITSYNC_BACKUP_PATH=/secure/creditsync-backups/creditsync-postgres-YYYYMMDD-HHMM.dump
export CREDITSYNC_BACKUP_PARTIAL_PATH="${CREDITSYNC_BACKUP_PATH}.partial"
test ! -e "$CREDITSYNC_BACKUP_PATH" && test ! -e "$CREDITSYNC_BACKUP_PARTIAL_PATH"
mkdir -p "$(dirname "$CREDITSYNC_BACKUP_PATH")"
docker compose --env-file "$CREDITSYNC_COMPOSE_ENV_FILE" -f "$CREDITSYNC_INFRA_COMPOSE_FILE" exec -T postgres sh -eu -c \
  'pg_dump --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --format=custom --no-owner --file=-' \
  > "$CREDITSYNC_BACKUP_PARTIAL_PATH"
test -s "$CREDITSYNC_BACKUP_PARTIAL_PATH"
pg_restore --list "$CREDITSYNC_BACKUP_PARTIAL_PATH" > /dev/null
sha256sum "$CREDITSYNC_BACKUP_PARTIAL_PATH"
mv -- "$CREDITSYNC_BACKUP_PARTIAL_PATH" "$CREDITSYNC_BACKUP_PATH"
stat --format='path=%n bytes=%s mode=%a' "$CREDITSYNC_BACKUP_PATH"
sha256sum "$CREDITSYNC_BACKUP_PATH"
```

Copy the archive and checksum through the protected external-storage process, then independently run `pg_restore --list` and `sha256sum -c` against the copy. Do not delete the verified local archive first.

## 3. Restore into an isolated disposable database

The protected rehearsal file must define `CREDITSYNC_REHEARSAL_DB_USER` and `CREDITSYNC_REHEARSAL_DB_PASSWORD`. It is shell-compatible, mode `600`, and is never printed. These are host variables; no container-only `POSTGRES_USER` is expanded on the host.

```bash
set -eu
export CREDITSYNC_RESTORE_ENV_FILE=/secure/creditsync-rehearsal/postgres.env
export CREDITSYNC_RESTORE_CONTAINER=creditsync-postgres-rehearsal-YYYYMMDDHHMM
export CREDITSYNC_RESTORE_DB=creditsync_rehearsal
export CREDITSYNC_RESTORE_PORT=55432
test -r "$CREDITSYNC_RESTORE_ENV_FILE"
set -a
. "$CREDITSYNC_RESTORE_ENV_FILE"
set +a
export CREDITSYNC_RESTORE_USER="${CREDITSYNC_REHEARSAL_DB_USER:?missing rehearsal user}"
export CREDITSYNC_RESTORE_PASSWORD="${CREDITSYNC_REHEARSAL_DB_PASSWORD:?missing rehearsal password}"
export CREDITSYNC_RESTORE_DATABASE_URL="postgresql://${CREDITSYNC_RESTORE_USER}:${CREDITSYNC_RESTORE_PASSWORD}@127.0.0.1:${CREDITSYNC_RESTORE_PORT}/${CREDITSYNC_RESTORE_DB}"

docker run --detach --rm --name "$CREDITSYNC_RESTORE_CONTAINER" \
  -e POSTGRES_USER="$CREDITSYNC_RESTORE_USER" \
  -e POSTGRES_PASSWORD="$CREDITSYNC_RESTORE_PASSWORD" \
  -e POSTGRES_DB="$CREDITSYNC_RESTORE_DB" \
  -p "127.0.0.1:${CREDITSYNC_RESTORE_PORT}:5432" postgres:18
trap 'docker rm --force "$CREDITSYNC_RESTORE_CONTAINER" >/dev/null 2>&1 || true' EXIT
for CREDITSYNC_RESTORE_ATTEMPT in $(seq 1 60); do
  if docker exec "$CREDITSYNC_RESTORE_CONTAINER" pg_isready -U "$CREDITSYNC_RESTORE_USER" -d "$CREDITSYNC_RESTORE_DB" >/dev/null 2>&1; then break; fi
  test "$CREDITSYNC_RESTORE_ATTEMPT" -lt 60 || { echo 'restore database readiness timeout' >&2; exit 1; }
  sleep 2
done
docker cp "$CREDITSYNC_BACKUP_PATH" "$CREDITSYNC_RESTORE_CONTAINER:/tmp/restore.dump"
docker exec "$CREDITSYNC_RESTORE_CONTAINER" sh -eu -c \
  'pg_restore --clean --if-exists --no-owner --dbname="$POSTGRES_DB" /tmp/restore.dump'
```

## 4. Prove the exact pre-repair drift

The checker intentionally exits `1` for this approved drift. Capture the exit status without `set -e`, extract only checker state lines, and compare the complete exact set. Any extra line, missing line, `compatible`/`incompatible` mismatch, or stderr output is a stop.

```bash
set -eu
export CREDITSYNC_DRIFT_DIR="$(mktemp -d /tmp/creditsync-schema-drift.XXXXXX)"
chmod 700 "$CREDITSYNC_DRIFT_DIR"
export CREDITSYNC_CHECKER_OUTPUT="$CREDITSYNC_DRIFT_DIR/checker.out"
export CREDITSYNC_CHECKER_ERROR="$CREDITSYNC_DRIFT_DIR/checker.err"
export CREDITSYNC_APPROVED_DRIFT="$CREDITSYNC_DRIFT_DIR/approved-missing.out"
export CREDITSYNC_OBSERVED_DRIFT="$CREDITSYNC_DRIFT_DIR/observed-missing.out"
cat > "$CREDITSYNC_APPROVED_DRIFT" <<'EOF'
loans.interest_period_unit: missing
loans.interest_period_length: missing
loans.advance_interest_periods: missing
loans.advance_interest_refund_policy: missing
loans.interest_period_anchor_date: missing
loans.single_payment_due_date: missing
loans.single_payment_fixed_agreed_interest: missing
loans.single_payment_interest_policy: missing
loans.single_payment_retroactive_rate_type: missing
loans.single_payment_retroactive_rate: missing
loans.single_payment_late_penalty_mode: missing
loans.single_payment_late_penalty_amount_per_day: missing
loans.single_payment_late_penalty_grace_days: missing
loans.floating_accrual_cycle: missing
loans.activation_idempotency_key: missing
loans.activation_result: missing
loans.loans_single_payment_terms_check: missing
loans.loans_floating_accrual_cycle_check: missing
loans.loans_single_payment_money_check: missing
loans.loans_interest_period_unit_check: missing
loans.loans_interest_period_length_check: missing
loans.loans_advance_interest_periods_check: missing
loans.loans_advance_interest_refund_policy_check: missing
loans.loans_interest_period_policy_completeness_check: missing
loans.loans_activation_command_completeness_check: missing
loans.loans_tenant_activation_idempotency_unique: missing
loans.loans_one_funding_source_check: compatible
loans.loans_term_months_check: compatible
EOF
sort -o "$CREDITSYNC_APPROVED_DRIFT" "$CREDITSYNC_APPROVED_DRIFT"
set +e
(cd backend && DATABASE_URL="$CREDITSYNC_RESTORE_DATABASE_URL" bun run schema:check:loan-origination) \
  > "$CREDITSYNC_CHECKER_OUTPUT" 2> "$CREDITSYNC_CHECKER_ERROR"
CREDITSYNC_CHECKER_STATUS=$?
set -e
test "$CREDITSYNC_CHECKER_STATUS" -eq 1
test ! -s "$CREDITSYNC_CHECKER_ERROR"
sed -nE '/^loans\.[a-z0-9_]+: (missing|compatible|incompatible)$/p' "$CREDITSYNC_CHECKER_OUTPUT" \
  | sort > "$CREDITSYNC_OBSERVED_DRIFT"
! grep -q ': incompatible$' "$CREDITSYNC_OBSERVED_DRIFT"
cmp -s "$CREDITSYNC_APPROVED_DRIFT" "$CREDITSYNC_OBSERVED_DRIFT"
test "$(wc -l < "$CREDITSYNC_OBSERVED_DRIFT")" -eq 28
```

## 5. Fingerprint rows, rehearse the repair, and compare

Before migration, store only server-side hashes, counts, exact decimal totals, and a hash of representative public-ID/status/value tuples. This is separate from `backend/scripts/test-disposable-postgres.sh`, which resets a disposable database and does not verify rows restored from production.

```bash
set -eu
export CREDITSYNC_FINGERPRINT_BEFORE="$CREDITSYNC_DRIFT_DIR/fingerprint.before"
export CREDITSYNC_FINGERPRINT_AFTER="$CREDITSYNC_DRIFT_DIR/fingerprint.after"
export CREDITSYNC_FINGERPRINT_SQL="$CREDITSYNC_DRIFT_DIR/fingerprint.sql"
cat > "$CREDITSYNC_FINGERPRINT_SQL" <<'SQL'
SELECT 'loans', count(*), coalesce(sum(principal_amount), 0), md5(coalesce(string_agg(public_id::text || ':' || status || ':' || principal_amount::text || ':' || interest_rate::text, '|' ORDER BY public_id), '')) FROM loans;
SELECT 'loan_interest_accruals', count(*), coalesce(sum(interest_amount), 0), md5(coalesce(string_agg(public_id::text || ':' || status || ':' || interest_amount::text, '|' ORDER BY public_id), '')) FROM loan_interest_accruals;
SELECT 'loan_schedules', count(*), coalesce(sum(scheduled_total), 0), md5(coalesce(string_agg(public_id::text || ':' || status || ':' || scheduled_principal::text || ':' || scheduled_interest::text, '|' ORDER BY public_id), '')) FROM loan_schedules;
SELECT 'posted_loan_disbursement_events', count(*), coalesce(sum(loan_attributed_amount), 0), md5(coalesce(string_agg(public_id::text || ':' || status || ':' || loan_attributed_amount::text, '|' ORDER BY public_id), '')) FROM loan_disbursement_events WHERE status = 'posted';
SELECT 'fund_ledger_entries', count(*), coalesce(sum(amount), 0), md5(coalesce(string_agg(public_id::text || ':' || entry_type || ':' || amount::text, '|' ORDER BY public_id), '')) FROM fund_ledger_entries;
SQL
psql "$CREDITSYNC_RESTORE_DATABASE_URL" -X -v ON_ERROR_STOP=1 -At -f "$CREDITSYNC_FINGERPRINT_SQL" > "$CREDITSYNC_FINGERPRINT_BEFORE"

test -f backend/drizzle/0038_production_loan_schema_reconciliation.sql
test -f backend/drizzle/meta/0038_snapshot.json
rg -n '0038_production_loan_schema_reconciliation' backend/drizzle/meta/_journal.json
export CREDITSYNC_0038_SHA256="$(sha256sum backend/drizzle/0038_production_loan_schema_reconciliation.sql | awk '{print $1}')"
export CREDITSYNC_EXPECTED_0038_CREATED_AT='<recorded-created-at-from-reviewed-rehearsal>'
cd backend
DATABASE_URL="$CREDITSYNC_RESTORE_DATABASE_URL" bun run migrate
cd ..
psql "$CREDITSYNC_RESTORE_DATABASE_URL" -X -v ON_ERROR_STOP=1 -At -c \
  "SELECT count(*), min(created_at), max(created_at) FROM drizzle.__drizzle_migrations WHERE hash = '$CREDITSYNC_0038_SHA256'" \
  > "$CREDITSYNC_DRIFT_DIR/0038-journal.out"
test "$(cut -d'|' -f1 "$CREDITSYNC_DRIFT_DIR/0038-journal.out")" -eq 1
test "$(cut -d'|' -f2 "$CREDITSYNC_DRIFT_DIR/0038-journal.out")" = "$CREDITSYNC_EXPECTED_0038_CREATED_AT"
test "$(cut -d'|' -f3 "$CREDITSYNC_DRIFT_DIR/0038-journal.out")" = "$CREDITSYNC_EXPECTED_0038_CREATED_AT"
DATABASE_URL="$CREDITSYNC_RESTORE_DATABASE_URL" bun run schema:check:loan-origination
psql "$CREDITSYNC_RESTORE_DATABASE_URL" -X -v ON_ERROR_STOP=1 -At -f "$CREDITSYNC_FINGERPRINT_SQL" > "$CREDITSYNC_FINGERPRINT_AFTER"
cmp -s "$CREDITSYNC_FINGERPRINT_BEFORE" "$CREDITSYNC_FINGERPRINT_AFTER"
```

Run the approved read-only constraint-violation queries from the migration review and require zero rows. Inspect every checker object, not only two columns and the index. Then run, serially, the disposable database code gates:

```bash
./backend/scripts/test-disposable-postgres.sh
cd backend && bun run typecheck
cd ../frontend && bun test && bun run lint && bun run build
```

## 6. Build, migrate production, and deploy the reviewed artifact

Compose is build-only, so first capture current service image IDs and exact Compose refs, tag those IDs as rollback artifacts, build from this reviewed clean checkout, and capture the new IDs. Verify the project and refs before using them.

```bash
set -eu
export CREDITSYNC_COMPOSE_PROJECT='creditsync-production'
export CREDITSYNC_ROLLBACK_BACKEND_TAG='creditsync-backend-rollback:YYYYMMDDHHMM'
export CREDITSYNC_ROLLBACK_FRONTEND_TAG='creditsync-frontend-rollback:YYYYMMDDHHMM'
export CREDITSYNC_APP_COMPOSE_ARGS="--project-name $CREDITSYNC_COMPOSE_PROJECT --env-file $CREDITSYNC_COMPOSE_ENV_FILE -f $CREDITSYNC_APP_COMPOSE_FILE"
docker compose $CREDITSYNC_APP_COMPOSE_ARGS config --services
export CREDITSYNC_BACKEND_COMPOSE_REF="$(docker compose $CREDITSYNC_APP_COMPOSE_ARGS images --format '{{.Repository}}:{{.Tag}}' backend)"
export CREDITSYNC_FRONTEND_COMPOSE_REF="$(docker compose $CREDITSYNC_APP_COMPOSE_ARGS images --format '{{.Repository}}:{{.Tag}}' frontend)"
test -n "$CREDITSYNC_BACKEND_COMPOSE_REF" && test -n "$CREDITSYNC_FRONTEND_COMPOSE_REF"
export CREDITSYNC_CURRENT_BACKEND_ID="$(docker compose $CREDITSYNC_APP_COMPOSE_ARGS images -q backend)"
export CREDITSYNC_CURRENT_FRONTEND_ID="$(docker compose $CREDITSYNC_APP_COMPOSE_ARGS images -q frontend)"
docker image inspect "$CREDITSYNC_BACKEND_COMPOSE_REF" "$CREDITSYNC_FRONTEND_COMPOSE_REF" \
  --format '{{.Id}} {{.RepoTags}}'
docker image tag "$CREDITSYNC_CURRENT_BACKEND_ID" "$CREDITSYNC_ROLLBACK_BACKEND_TAG"
docker image tag "$CREDITSYNC_CURRENT_FRONTEND_ID" "$CREDITSYNC_ROLLBACK_FRONTEND_TAG"
docker compose $CREDITSYNC_APP_COMPOSE_ARGS build backend frontend
export CREDITSYNC_REVIEWED_BACKEND_ID="$(docker image inspect "$CREDITSYNC_BACKEND_COMPOSE_REF" --format '{{.Id}}')"
export CREDITSYNC_REVIEWED_FRONTEND_ID="$(docker image inspect "$CREDITSYNC_FRONTEND_COMPOSE_REF" --format '{{.Id}}')"
test -n "$CREDITSYNC_REVIEWED_BACKEND_ID" && test -n "$CREDITSYNC_REVIEWED_FRONTEND_ID"
docker image inspect "$CREDITSYNC_REVIEWED_BACKEND_ID" "$CREDITSYNC_REVIEWED_FRONTEND_ID" --format '{{.Id}} {{.RepoTags}}'
```

After a fresh backup and writer freeze, use the reviewed backend image ID for the one-off migration. Do not run this section during documentation review.

```bash
export CREDITSYNC_PRODUCTION_MIGRATION_CONTAINER=creditsync-backend-schema-migrate-YYYYMMDDHHMM
docker run --rm --name "$CREDITSYNC_PRODUCTION_MIGRATION_CONTAINER" \
  --network creditsync_runtime --env-file .env.production \
  "$CREDITSYNC_REVIEWED_BACKEND_ID" bun run migrate
```

Verify the journal using its actual columns (`id`, `hash`, `created_at`), never `tag`, and verify all contract objects:

```bash
docker compose --env-file "$CREDITSYNC_COMPOSE_ENV_FILE" -f "$CREDITSYNC_INFRA_COMPOSE_FILE" exec -T postgres sh -eu -c \
  -e "CREDITSYNC_0038_SHA256=$CREDITSYNC_0038_SHA256" \
  'psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -X -v ON_ERROR_STOP=1 \
    -c "SELECT count(*), min(created_at), max(created_at) FROM drizzle.__drizzle_migrations WHERE hash = '\''$CREDITSYNC_0038_SHA256'\''"' \
  > "$CREDITSYNC_DRIFT_DIR/production-0038-journal.out"
test "$(cut -d'|' -f1 "$CREDITSYNC_DRIFT_DIR/production-0038-journal.out")" -eq 1
test "$(cut -d'|' -f2 "$CREDITSYNC_DRIFT_DIR/production-0038-journal.out")" = "$CREDITSYNC_EXPECTED_0038_CREATED_AT"
test "$(cut -d'|' -f3 "$CREDITSYNC_DRIFT_DIR/production-0038-journal.out")" = "$CREDITSYNC_EXPECTED_0038_CREATED_AT"
docker compose $CREDITSYNC_APP_COMPOSE_ARGS exec -T backend bun run schema:check:loan-origination
docker compose $CREDITSYNC_APP_COMPOSE_ARGS up -d --no-build --force-recreate backend frontend
```

Sanitize and inspect startup logs; redact authorization/bearer material and stop rather than copying logs containing sensitive data:

```bash
docker compose $CREDITSYNC_APP_COMPOSE_ARGS logs --no-color --tail=120 backend \
  | sed -E 's/(Authorization:|Bearer )[[:space:]]*[^[:space:]]+/[REDACTED]/Ig'
```

## 7. Health and MCP application verification

```bash
docker compose $CREDITSYNC_APP_COMPOSE_ARGS exec -T backend \
  bun -e 'const r=await fetch("http://127.0.0.1:3000/mcp/health"); console.log(await r.text()); process.exit(r.ok?0:1)'
curl --fail --silent --show-error http://127.0.0.1:8088/ > /dev/null
```

Health must be `status: ok`, service `creditsync-mcp`, schema version `1.0`. Use the registered authenticated MCP client. The following strict JSON payloads are schema-bound templates; replace only returned public UUIDs and the ISO timestamp, never add credentials or identity data:

```json
{"name":"loan.preview","arguments":{"principal":"7500.00","interestRate":"0.00","termMonths":1,"repaymentType":"daily","startDate":"2026-08-16","dailyEntry":{"durationUnit":"days","durationValue":75,"entryMode":"daily_payment","dailyPayment":"100.00"}}}
{"name":"loan.draft","arguments":{"borrowerPublicId":"<confirmed-borrower-public-uuid>","principal":"7500.00","interestRate":"0.00","termMonths":1,"repaymentType":"daily","startDate":"2026-08-16","dailyEntry":{"durationUnit":"days","durationValue":75,"entryMode":"daily_payment","dailyPayment":"100.00"}}}
{"name":"loan.activate","arguments":{"loanPublicId":"<draft-loan-public-uuid>","idempotencyKey":"loan-p-nam-activate-20260816"}}
{"name":"loan.disbursement.list","arguments":{"loanPublicId":"<activated-loan-public-uuid>"}}
{"name":"loan.disbursement.draft","arguments":{"loanPublicId":"<activated-loan-public-uuid>","grossAmount":"4000.00","loanAttributedAmount":"4000.00","channel":"bank_transfer","disbursedAt":"2026-08-16T00:00:00+07:00"}}
{"name":"loan.disbursement.list","arguments":{"loanPublicId":"<activated-loan-public-uuid>"}}
{"name":"loan.disbursement.post","arguments":{"disbursementPublicId":"<draft-disbursement-public-uuid>","idempotencyKey":"loan-p-nam-disbursement-post-20260816"}}
```

1. Search canonical names and confirmed aliases for `พี่น้ำ`; stop on ambiguity and reuse only the confirmed borrower.
2. Call `loan.preview`; require 75 installments, `0.00` interest, first due date `2026-08-17`, last due date `2026-10-30`. Preview supplies the schedule; it is not persisted yet.
3. After approval, call `loan.draft`, inspect the draft and preview schedule, then call `loan.activate` with the stable key and replay the identical request. Verify 75 persisted schedules, each `100.00` principal and `0.00` interest, total `7500.00`.
4. Call `loan.disbursement.draft` only with the required ISO `disbursedAt`. Call `loan.disbursement.list` to inspect the exact draft. Before posting, authoritative list truth remains `netDisbursed=0.00`, `variance=-7500.00`; separately label the inspected draft's intended post-state as `netDisbursed=4000.00`, `variance=-3500.00`, `under_disbursed`. Do not describe projected values as current list values.
5. Pause for a new explicit confirmation after showing that exact draft and intended variance. Only then call `loan.disbursement.post`, re-list, and verify `posted`, `under_disbursed`, `netDisbursed="4000.00"`, and `variance="-3500.00"`. Never mutate principal or schedules to remove the variance.

## 8. Roll back only application images

If the reviewed image fails health or accounting verification, retain the additive schema and retag the saved rollback IDs onto the exact Compose refs captured in Section 6, then recreate without building. Do not drop columns, constraints, indexes, or run a down migration.

```bash
set -eu
docker image tag "$CREDITSYNC_ROLLBACK_BACKEND_TAG" "$CREDITSYNC_BACKEND_COMPOSE_REF"
docker image tag "$CREDITSYNC_ROLLBACK_FRONTEND_TAG" "$CREDITSYNC_FRONTEND_COMPOSE_REF"
docker compose $CREDITSYNC_APP_COMPOSE_ARGS up -d --no-build --force-recreate backend frontend
docker compose $CREDITSYNC_APP_COMPOSE_ARGS exec -T backend \
  bun -e 'const r=await fetch("http://127.0.0.1:3000/mcp/health"); console.log(await r.text()); process.exit(r.ok?0:1)'
```

Record only sanitized Git SHA, image IDs/digests, Compose states/refs, backup checksum/path, restore result, exact schema states, journal hash/timestamp result, fingerprint comparison, health responses, and public operation IDs. Never attach dumps, env files, tokens, identity values, evidence, or full rows.
