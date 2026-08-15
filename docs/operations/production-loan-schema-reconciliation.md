# Production loan-schema reconciliation runbook

This is a read-first, forward-only operator procedure for the approved `0038_production_loan_schema_reconciliation` release. It does not authorize production financial writes. Run it only during an approved maintenance window, with a protected rehearsal env file and an explicit stop decision at every gate.

Repository facts used below: `docker-compose.infra.yml` provides `postgres`, `minio`, `dragonfly`, and `tunnel`; `docker-compose.app.yml` provides build-only `backend` and `frontend`; the shared network is `creditsync_runtime`; and the checker is `cd backend && bun run schema:check:loan-origination`.

## Safety gates

Use only task-specific variables. Never use `HOME`, print an environment file, passwords, bearer tokens, identity values, QR payloads, signed URLs, evidence, or customer rows. Keep evidence to hashes, object states, counts, exact decimal totals, public operation IDs, and restricted local log files. Never paste raw logs into chat or committed evidence.

Stop and preserve evidence if a backup/restore/readiness check fails; a checker state is unexpected or `incompatible`; a migration or journal check fails; any constraint-violation query returns a row; any fingerprint changes; catalog/MCP/frontend health fails; a borrower match is ambiguous; terms, idempotency, or financial values differ; or the disbursement variance is not exactly `-3500.00`.

The approved pre-repair drift is exactly 16 missing nullable columns, 9 missing constraints, and 1 missing partial unique index. `loans_term_months_check` and `loans_one_funding_source_check` are compatible and must not be listed as missing.

## 1. Capture a read-only baseline

Run from the reviewed clean checkout. Capture exact image IDs from the fixed live container names; do not assume a Compose project or use legacy image-discovery commands.

```bash
set -eu
export CREDITSYNC_COMPOSE_ENV_FILE=/secure/creditsync/env/production.env
export CREDITSYNC_INFRA_COMPOSE_FILE=docker-compose.infra.yml
export CREDITSYNC_LOG_DIR=/secure/creditsync/reconciliation-logs
mkdir -p "$CREDITSYNC_LOG_DIR"
chmod 700 "$CREDITSYNC_LOG_DIR"
test -r "$CREDITSYNC_COMPOSE_ENV_FILE"

git status --short --branch
test -z "$(git status --porcelain)"
git rev-parse HEAD
git log -1 --format='%H %cI %s'
docker compose --env-file "$CREDITSYNC_COMPOSE_ENV_FILE" -f "$CREDITSYNC_INFRA_COMPOSE_FILE" config --services
docker inspect creditsync-backend-prod creditsync-frontend-prod creditsync-postgres-prod \
  --format '{{.Name}} image={{.Config.Image}} imageId={{.Image}} status={{.State.Status}} started={{.State.StartedAt}}'
export CREDITSYNC_BASELINE_CHECKER_OUT="$CREDITSYNC_LOG_DIR/baseline-checker.out"
export CREDITSYNC_BASELINE_CHECKER_ERR="$CREDITSYNC_LOG_DIR/baseline-checker.err"
docker logs creditsync-backend-prod > "$CREDITSYNC_LOG_DIR/baseline-backend.log" 2>&1
set +e
docker exec creditsync-backend-prod bun run schema:check:loan-origination \
  > "$CREDITSYNC_BASELINE_CHECKER_OUT" 2> "$CREDITSYNC_BASELINE_CHECKER_ERR"
CREDITSYNC_BASELINE_CHECKER_STATUS=$?
set -e
printf 'checker_exit=%s\n' "$CREDITSYNC_BASELINE_CHECKER_STATUS" > "$CREDITSYNC_LOG_DIR/baseline-checker-status.out"
chmod 600 "$CREDITSYNC_LOG_DIR"/*
```

Do not print the baseline output or diagnostics. The expected non-zero result
is compared against the restored copy in Section 4. The historical app
containers have different Compose projects, so all baseline runtime checks use
their exact validated names (`docker exec`, `docker inspect`, and `docker
logs`), never `compose exec`. The protected standalone deployment file in
Section 6 is the only app Compose file validated for deployment.

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

The checker intentionally exits `1` for this approved drift. Bun diagnostics
may be present on stderr; retain them in a restricted local file and do not
require stderr to be empty. Compare the complete stdout state set, not a
subset. The direct invocation is outside `set -e` so its expected exit cannot
abort the comparison.

```bash
set -eu
export CREDITSYNC_DRIFT_DIR="$(mktemp -d /tmp/creditsync-schema-drift.XXXXXX)"
chmod 700 "$CREDITSYNC_DRIFT_DIR"
export CREDITSYNC_CHECKER_OUTPUT="$CREDITSYNC_DRIFT_DIR/checker.out"
export CREDITSYNC_CHECKER_ERROR="$CREDITSYNC_DRIFT_DIR/checker.err"
export CREDITSYNC_APPROVED_DRIFT="$CREDITSYNC_DRIFT_DIR/approved-states.out"
export CREDITSYNC_OBSERVED_DRIFT="$CREDITSYNC_DRIFT_DIR/observed-states.out"
export CREDITSYNC_UNEXPECTED_STDOUT="$CREDITSYNC_DRIFT_DIR/unexpected-stdout.out"
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
chmod 600 "$CREDITSYNC_CHECKER_OUTPUT" "$CREDITSYNC_CHECKER_ERROR"
if grep -Ev '^loans\.[a-z0-9_]+: (missing|compatible|incompatible)$' "$CREDITSYNC_CHECKER_OUTPUT" > "$CREDITSYNC_UNEXPECTED_STDOUT"; then :; fi
test ! -s "$CREDITSYNC_UNEXPECTED_STDOUT"
sort "$CREDITSYNC_CHECKER_OUTPUT" > "$CREDITSYNC_OBSERVED_DRIFT"
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

Run the following executable read-only queries for every new constraint that
may be installed `NOT VALID`; require all nine counts to be zero before
continuation. `loans_term_months_check` and
`loans_one_funding_source_check` are compatible and are intentionally absent.

```bash
set -eu
export CREDITSYNC_CONSTRAINT_SQL="$CREDITSYNC_DRIFT_DIR/constraint-violations.sql"
export CREDITSYNC_CONSTRAINT_OUT="$CREDITSYNC_DRIFT_DIR/constraint-violations.out"
cat > "$CREDITSYNC_CONSTRAINT_SQL" <<'SQL'
SELECT 'loans_single_payment_terms_check', count(*) FROM loans WHERE NOT ((repayment_type <> 'single_payment' AND single_payment_due_date IS NULL AND single_payment_fixed_agreed_interest IS NULL AND single_payment_interest_policy IS NULL AND single_payment_retroactive_rate_type IS NULL AND single_payment_retroactive_rate IS NULL AND single_payment_late_penalty_mode IS NULL AND single_payment_late_penalty_amount_per_day IS NULL AND single_payment_late_penalty_grace_days IS NULL) OR (repayment_type = 'single_payment' AND start_date IS NOT NULL AND single_payment_due_date > start_date AND single_payment_fixed_agreed_interest IS NOT NULL AND ((single_payment_interest_policy = 'fixed_only' AND single_payment_retroactive_rate_type IS NULL AND single_payment_retroactive_rate IS NULL) OR (single_payment_interest_policy = 'greater_of_fixed_or_retroactive' AND single_payment_retroactive_rate_type IN ('percent_per_day', 'per_thousand_per_day') AND single_payment_retroactive_rate IS NOT NULL)) AND ((single_payment_late_penalty_mode = 'none' AND single_payment_late_penalty_amount_per_day IS NULL AND single_payment_late_penalty_grace_days IS NULL) OR (single_payment_late_penalty_mode = 'fixed_amount_per_day' AND single_payment_late_penalty_amount_per_day IS NOT NULL AND single_payment_late_penalty_grace_days >= 0))));
SELECT 'loans_floating_accrual_cycle_check', count(*) FROM loans WHERE NOT ((repayment_type = 'floating' AND floating_accrual_cycle IN ('daily', 'weekly')) OR (repayment_type <> 'floating' AND floating_accrual_cycle IS NULL));
SELECT 'loans_single_payment_money_check', count(*) FROM loans WHERE NOT ((single_payment_fixed_agreed_interest IS NULL OR (single_payment_fixed_agreed_interest >= 0 AND scale(single_payment_fixed_agreed_interest) <= 2)) AND (single_payment_retroactive_rate IS NULL OR (single_payment_retroactive_rate >= 0 AND scale(single_payment_retroactive_rate) <= 4)) AND (single_payment_late_penalty_amount_per_day IS NULL OR (single_payment_late_penalty_amount_per_day >= 0 AND scale(single_payment_late_penalty_amount_per_day) <= 2)));
SELECT 'loans_interest_period_unit_check', count(*) FROM loans WHERE NOT (interest_period_unit IS NULL OR interest_period_unit IN ('day', 'week'));
SELECT 'loans_interest_period_length_check', count(*) FROM loans WHERE NOT (interest_period_length IS NULL OR interest_period_length = 1);
SELECT 'loans_advance_interest_periods_check', count(*) FROM loans WHERE NOT (advance_interest_periods IS NULL OR advance_interest_periods IN (0, 1));
SELECT 'loans_advance_interest_refund_policy_check', count(*) FROM loans WHERE NOT (advance_interest_refund_policy IS NULL OR advance_interest_refund_policy = 'non_refundable');
SELECT 'loans_interest_period_policy_completeness_check', count(*) FROM loans WHERE NOT ((interest_period_unit IS NULL AND interest_period_length IS NULL AND advance_interest_periods IS NULL AND advance_interest_refund_policy IS NULL AND interest_period_anchor_date IS NULL) OR (interest_period_unit IS NOT NULL AND interest_period_length IS NOT NULL AND advance_interest_periods IS NOT NULL AND advance_interest_refund_policy IS NOT NULL AND interest_period_anchor_date IS NOT NULL));
SELECT 'loans_activation_command_completeness_check', count(*) FROM loans WHERE NOT ((activation_idempotency_key IS NULL AND activation_result IS NULL) OR (activation_idempotency_key IS NOT NULL AND activation_result IS NOT NULL));
SQL
psql "$CREDITSYNC_RESTORE_DATABASE_URL" -X -v ON_ERROR_STOP=1 -At -f "$CREDITSYNC_CONSTRAINT_SQL" > "$CREDITSYNC_CONSTRAINT_OUT"
test "$(wc -l < "$CREDITSYNC_CONSTRAINT_OUT")" -eq 9
awk -F'|' '$2 != "0" {bad=1} END {exit bad}' "$CREDITSYNC_CONSTRAINT_OUT"
```

Inspect every checker object, not only two columns and the index. Then run,
serially, the disposable database code gates:

```bash
./backend/scripts/test-disposable-postgres.sh
cd backend && bun run typecheck
cd ../frontend && bun test && bun run lint && bun run build
```

## 6. Validate production constraints before replacing app containers

Invoke this gate from Section 7 at its explicit `STOP HERE` marker, only after
the production migration, journal check, and reviewed-image checker have
passed. Run the same nine zero-violation checks
against the live database. The `VALIDATE CONSTRAINT` statements are safe when
a constraint is already validated, and all nine must succeed before app
replacement. Stop if any count is non-zero or any `convalidated` value is
false.

```bash
set -eu
export CREDITSYNC_PRODUCTION_CONSTRAINT_SQL="$CREDITSYNC_LOG_DIR/production-constraint-checks.sql"
export CREDITSYNC_PRODUCTION_CONSTRAINT_OUT="$CREDITSYNC_LOG_DIR/production-constraint-checks.out"
cat > "$CREDITSYNC_PRODUCTION_CONSTRAINT_SQL" <<'SQL'
SELECT 'loans_single_payment_terms_check', count(*) FROM loans WHERE NOT ((repayment_type <> 'single_payment' AND single_payment_due_date IS NULL AND single_payment_fixed_agreed_interest IS NULL AND single_payment_interest_policy IS NULL AND single_payment_retroactive_rate_type IS NULL AND single_payment_retroactive_rate IS NULL AND single_payment_late_penalty_mode IS NULL AND single_payment_late_penalty_amount_per_day IS NULL AND single_payment_late_penalty_grace_days IS NULL) OR (repayment_type = 'single_payment' AND start_date IS NOT NULL AND single_payment_due_date > start_date AND single_payment_fixed_agreed_interest IS NOT NULL AND ((single_payment_interest_policy = 'fixed_only' AND single_payment_retroactive_rate_type IS NULL AND single_payment_retroactive_rate IS NULL) OR (single_payment_interest_policy = 'greater_of_fixed_or_retroactive' AND single_payment_retroactive_rate_type IN ('percent_per_day', 'per_thousand_per_day') AND single_payment_retroactive_rate IS NOT NULL)) AND ((single_payment_late_penalty_mode = 'none' AND single_payment_late_penalty_amount_per_day IS NULL AND single_payment_late_penalty_grace_days IS NULL) OR (single_payment_late_penalty_mode = 'fixed_amount_per_day' AND single_payment_late_penalty_amount_per_day IS NOT NULL AND single_payment_late_penalty_grace_days >= 0))));
SELECT 'loans_floating_accrual_cycle_check', count(*) FROM loans WHERE NOT ((repayment_type = 'floating' AND floating_accrual_cycle IN ('daily', 'weekly')) OR (repayment_type <> 'floating' AND floating_accrual_cycle IS NULL));
SELECT 'loans_single_payment_money_check', count(*) FROM loans WHERE NOT ((single_payment_fixed_agreed_interest IS NULL OR (single_payment_fixed_agreed_interest >= 0 AND scale(single_payment_fixed_agreed_interest) <= 2)) AND (single_payment_retroactive_rate IS NULL OR (single_payment_retroactive_rate >= 0 AND scale(single_payment_retroactive_rate) <= 4)) AND (single_payment_late_penalty_amount_per_day IS NULL OR (single_payment_late_penalty_amount_per_day >= 0 AND scale(single_payment_late_penalty_amount_per_day) <= 2)));
SELECT 'loans_interest_period_unit_check', count(*) FROM loans WHERE NOT (interest_period_unit IS NULL OR interest_period_unit IN ('day', 'week'));
SELECT 'loans_interest_period_length_check', count(*) FROM loans WHERE NOT (interest_period_length IS NULL OR interest_period_length = 1);
SELECT 'loans_advance_interest_periods_check', count(*) FROM loans WHERE NOT (advance_interest_periods IS NULL OR advance_interest_periods IN (0, 1));
SELECT 'loans_advance_interest_refund_policy_check', count(*) FROM loans WHERE NOT (advance_interest_refund_policy IS NULL OR advance_interest_refund_policy = 'non_refundable');
SELECT 'loans_interest_period_policy_completeness_check', count(*) FROM loans WHERE NOT ((interest_period_unit IS NULL AND interest_period_length IS NULL AND advance_interest_periods IS NULL AND advance_interest_refund_policy IS NULL AND interest_period_anchor_date IS NULL) OR (interest_period_unit IS NOT NULL AND interest_period_length IS NOT NULL AND advance_interest_periods IS NOT NULL AND advance_interest_refund_policy IS NOT NULL AND interest_period_anchor_date IS NOT NULL));
SELECT 'loans_activation_command_completeness_check', count(*) FROM loans WHERE NOT ((activation_idempotency_key IS NULL AND activation_result IS NULL) OR (activation_idempotency_key IS NOT NULL AND activation_result IS NOT NULL));
SQL
docker exec -i creditsync-postgres-prod sh -eu -c \
  'psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -X -v ON_ERROR_STOP=1 -At -f -' \
  < "$CREDITSYNC_PRODUCTION_CONSTRAINT_SQL" > "$CREDITSYNC_PRODUCTION_CONSTRAINT_OUT"
test "$(wc -l < "$CREDITSYNC_PRODUCTION_CONSTRAINT_OUT")" -eq 9
awk -F'|' '$2 != "0" {bad=1} END {exit bad}' "$CREDITSYNC_PRODUCTION_CONSTRAINT_OUT"
export CREDITSYNC_PRODUCTION_VALIDATION_SQL="$CREDITSYNC_LOG_DIR/production-constraint-validation.sql"
cat > "$CREDITSYNC_PRODUCTION_VALIDATION_SQL" <<'SQL'
ALTER TABLE loans VALIDATE CONSTRAINT loans_single_payment_terms_check;
   ALTER TABLE loans VALIDATE CONSTRAINT loans_floating_accrual_cycle_check;
   ALTER TABLE loans VALIDATE CONSTRAINT loans_single_payment_money_check;
   ALTER TABLE loans VALIDATE CONSTRAINT loans_interest_period_unit_check;
   ALTER TABLE loans VALIDATE CONSTRAINT loans_interest_period_length_check;
   ALTER TABLE loans VALIDATE CONSTRAINT loans_advance_interest_periods_check;
   ALTER TABLE loans VALIDATE CONSTRAINT loans_advance_interest_refund_policy_check;
   ALTER TABLE loans VALIDATE CONSTRAINT loans_interest_period_policy_completeness_check;
ALTER TABLE loans VALIDATE CONSTRAINT loans_activation_command_completeness_check;
SELECT conname, convalidated FROM pg_constraint WHERE conname IN ('loans_single_payment_terms_check','loans_floating_accrual_cycle_check','loans_single_payment_money_check','loans_interest_period_unit_check','loans_interest_period_length_check','loans_advance_interest_periods_check','loans_advance_interest_refund_policy_check','loans_interest_period_policy_completeness_check','loans_activation_command_completeness_check') ORDER BY conname;
SQL
docker exec -i creditsync-postgres-prod sh -eu -c \
  'psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -X -v ON_ERROR_STOP=1 -At -f -' \
  < "$CREDITSYNC_PRODUCTION_VALIDATION_SQL" \
  > "$CREDITSYNC_LOG_DIR/production-constraint-validation.out"
test "$(wc -l < "$CREDITSYNC_LOG_DIR/production-constraint-validation.out")" -eq 9
awk -F'|' '$2 != "t" {bad=1} END {exit bad}' "$CREDITSYNC_LOG_DIR/production-constraint-validation.out"
docker run --rm --name creditsync-backend-schema-check-post-migration-YYYYMMDDHHMM \
  --network creditsync_runtime --env-file "$CREDITSYNC_DEPLOY_ENV_FILE" \
  "$CREDITSYNC_REVIEWED_BACKEND_TAG" bun run schema:check:loan-origination
```

## 7. Build, migrate production, and deploy the reviewed artifact

Compose is build-only. Capture image IDs from the exact fixed-name live
containers, tag those IDs as rollback artifacts before building, then build
deterministic reviewed tags from this clean checkout. A complete standalone
protected deployment file selects the images; it does not inherit the base
file's relative `.env.production` or depend on historical Compose ownership.

```bash
set -eu
export CREDITSYNC_ROLLBACK_BACKEND_TAG='creditsync-backend-rollback:YYYYMMDDHHMM'
export CREDITSYNC_ROLLBACK_FRONTEND_TAG='creditsync-frontend-rollback:YYYYMMDDHHMM'
export CREDITSYNC_REVIEWED_BACKEND_TAG='creditsync-backend-reviewed:YYYYMMDDHHMM'
export CREDITSYNC_REVIEWED_FRONTEND_TAG='creditsync-frontend-reviewed:YYYYMMDDHHMM'
export CREDITSYNC_BACKEND_IMAGE_TAG="$CREDITSYNC_REVIEWED_BACKEND_TAG"
export CREDITSYNC_FRONTEND_IMAGE_TAG="$CREDITSYNC_REVIEWED_FRONTEND_TAG"
export CREDITSYNC_DEPLOY_ENV_FILE=/secure/creditsync/env/production.env
export CREDITSYNC_DEPLOY_COMPOSE_FILE="$(mktemp /tmp/creditsync-app-deployment.XXXXXX.yml)"
chmod 600 "$CREDITSYNC_DEPLOY_COMPOSE_FILE"
set -a
. "$CREDITSYNC_DEPLOY_ENV_FILE"
set +a
export CREDITSYNC_VITE_GOOGLE_CLIENT_ID="${VITE_GOOGLE_CLIENT_ID:?missing frontend build argument}"
export CREDITSYNC_CURRENT_BACKEND_ID="$(docker inspect creditsync-backend-prod --format '{{.Image}}')"
export CREDITSYNC_CURRENT_FRONTEND_ID="$(docker inspect creditsync-frontend-prod --format '{{.Image}}')"
docker image inspect "$CREDITSYNC_CURRENT_BACKEND_ID" "$CREDITSYNC_CURRENT_FRONTEND_ID" --format '{{.Id}}'
docker image tag "$CREDITSYNC_CURRENT_BACKEND_ID" "$CREDITSYNC_ROLLBACK_BACKEND_TAG"
docker image tag "$CREDITSYNC_CURRENT_FRONTEND_ID" "$CREDITSYNC_ROLLBACK_FRONTEND_TAG"
docker build --pull=false --tag "$CREDITSYNC_REVIEWED_BACKEND_TAG" ./backend
docker build --pull=false --tag "$CREDITSYNC_REVIEWED_FRONTEND_TAG" \
  --build-arg "VITE_GOOGLE_CLIENT_ID=$CREDITSYNC_VITE_GOOGLE_CLIENT_ID" ./frontend
cat > "$CREDITSYNC_DEPLOY_COMPOSE_FILE" <<YAML
services:
  backend:
    image: $CREDITSYNC_BACKEND_IMAGE_TAG
    container_name: creditsync-backend-prod
    restart: unless-stopped
    env_file:
      - $CREDITSYNC_DEPLOY_ENV_FILE
    environment:
      MCP_API_TOKEN_HASHES: \${MCP_API_TOKEN_HASHES}
      MCP_ALLOWED_HOSTS: \${MCP_ALLOWED_HOSTS}
      MCP_TENANT_ID: \${MCP_TENANT_ID}
      MCP_ACTOR_EMAIL: \${MCP_ACTOR_EMAIL}
      MCP_RATE_LIMIT_MAX: \${MCP_RATE_LIMIT_MAX:-60}
      MCP_RATE_LIMIT_WINDOW_SECONDS: \${MCP_RATE_LIMIT_WINDOW_SECONDS:-60}
    command: ["/bin/sh", "-lc", "bun run migrate && bun run src/index.ts"]
    networks:
      - creditsync_runtime
  frontend:
    image: $CREDITSYNC_FRONTEND_IMAGE_TAG
    container_name: creditsync-frontend-prod
    restart: unless-stopped
    depends_on:
      - backend
    ports:
      - "\${FRONTEND_PORT}:80"
    networks:
      - creditsync_runtime
networks:
  creditsync_runtime:
    external: true
    name: creditsync_runtime
YAML
docker compose --env-file "$CREDITSYNC_DEPLOY_ENV_FILE" -f "$CREDITSYNC_DEPLOY_COMPOSE_FILE" config --quiet
docker compose --env-file "$CREDITSYNC_DEPLOY_ENV_FILE" -f "$CREDITSYNC_DEPLOY_COMPOSE_FILE" config --images > "$CREDITSYNC_LOG_DIR/reviewed-compose-images.out"
grep -Fx "$CREDITSYNC_REVIEWED_BACKEND_TAG" "$CREDITSYNC_LOG_DIR/reviewed-compose-images.out"
grep -Fx "$CREDITSYNC_REVIEWED_FRONTEND_TAG" "$CREDITSYNC_LOG_DIR/reviewed-compose-images.out"
```

After a fresh backup and writer freeze, use the reviewed backend image tag for the one-off migration. Do not run this section during documentation review.

```bash
export CREDITSYNC_PRODUCTION_MIGRATION_CONTAINER=creditsync-backend-schema-migrate-YYYYMMDDHHMM
docker run --rm --name "$CREDITSYNC_PRODUCTION_MIGRATION_CONTAINER" \
  --network creditsync_runtime --env-file "$CREDITSYNC_DEPLOY_ENV_FILE" \
  "$CREDITSYNC_REVIEWED_BACKEND_TAG" bun run migrate
```

Verify the journal using its actual columns (`id`, `hash`, `created_at`), never `tag`, and verify all contract objects:

```bash
docker compose --env-file "$CREDITSYNC_DEPLOY_ENV_FILE" -f "$CREDITSYNC_INFRA_COMPOSE_FILE" \
  exec -T -e "CREDITSYNC_0038_SHA256=$CREDITSYNC_0038_SHA256" postgres sh -eu -c \
  'psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" -X -v ON_ERROR_STOP=1 -At \
    -c "SELECT count(*), min(created_at), max(created_at) FROM drizzle.__drizzle_migrations WHERE hash = '\''$CREDITSYNC_0038_SHA256'\''"' \
  > "$CREDITSYNC_LOG_DIR/production-0038-journal.out"
test "$(cut -d'|' -f1 "$CREDITSYNC_LOG_DIR/production-0038-journal.out")" -eq 1
test "$(cut -d'|' -f2 "$CREDITSYNC_LOG_DIR/production-0038-journal.out")" = "$CREDITSYNC_EXPECTED_0038_CREATED_AT"
test "$(cut -d'|' -f3 "$CREDITSYNC_LOG_DIR/production-0038-journal.out")" = "$CREDITSYNC_EXPECTED_0038_CREATED_AT"
# STOP HERE: execute Section 6 now. Return here only after every production
# constraint count is zero and every `convalidated` result is true.

docker compose --env-file "$CREDITSYNC_DEPLOY_ENV_FILE" -f "$CREDITSYNC_DEPLOY_COMPOSE_FILE" config --quiet
docker compose --env-file "$CREDITSYNC_DEPLOY_ENV_FILE" -f "$CREDITSYNC_DEPLOY_COMPOSE_FILE" config --images > "$CREDITSYNC_LOG_DIR/deploy-compose-images.out"
grep -Fx "$CREDITSYNC_REVIEWED_BACKEND_TAG" "$CREDITSYNC_LOG_DIR/deploy-compose-images.out"
grep -Fx "$CREDITSYNC_REVIEWED_FRONTEND_TAG" "$CREDITSYNC_LOG_DIR/deploy-compose-images.out"
docker inspect creditsync-backend-prod creditsync-frontend-prod --format '{{.Name}} imageId={{.Image}} status={{.State.Status}}' > "$CREDITSYNC_LOG_DIR/pre-stop-app-containers.out"
test "$(docker inspect creditsync-backend-prod --format '{{.Image}}')" = "$CREDITSYNC_CURRENT_BACKEND_ID"
test "$(docker inspect creditsync-frontend-prod --format '{{.Image}}')" = "$CREDITSYNC_CURRENT_FRONTEND_ID"
test "$(docker inspect creditsync-backend-prod --format '{{.State.Status}}')" = running
test "$(docker inspect creditsync-frontend-prod --format '{{.State.Status}}')" = running
docker stop creditsync-frontend-prod
docker stop creditsync-backend-prod
docker rm creditsync-frontend-prod
docker rm creditsync-backend-prod
docker compose --env-file "$CREDITSYNC_DEPLOY_ENV_FILE" -f "$CREDITSYNC_DEPLOY_COMPOSE_FILE" up -d --no-build backend frontend
```

Capture startup logs without emitting them. Inspect the restricted file only
locally; stop if it contains a token or other sensitive material. Do not rely
on a partial redaction regex.

```bash
set -eu
export CREDITSYNC_STARTUP_LOG="$CREDITSYNC_LOG_DIR/backend-startup.log"
docker compose --env-file "$CREDITSYNC_DEPLOY_ENV_FILE" -f "$CREDITSYNC_DEPLOY_COMPOSE_FILE" \
  logs --no-color --tail=120 backend > "$CREDITSYNC_STARTUP_LOG" 2>&1
chmod 600 "$CREDITSYNC_STARTUP_LOG"
test -s "$CREDITSYNC_STARTUP_LOG"
```

## 8. Health and MCP application verification

```bash
docker exec creditsync-backend-prod \
  bun -e 'const r=await fetch("http://127.0.0.1:3000/mcp/health"); const body=await r.json(); if (!r.ok || body.status !== "ok" || body.service !== "creditsync-mcp" || body.schemaVersion !== "1.0") process.exit(1)'
curl --fail --silent --show-error http://127.0.0.1:8088/ > /dev/null
```

Health must be `status: ok`, service `creditsync-mcp`, schema version `1.0`. Use the registered authenticated MCP client. The frozen schema has no idempotency input for `loan.draft`; only commands whose schemas support it receive stable idempotency keys. The following strict JSON payloads are schema-bound templates; replace only returned public UUIDs and the ISO timestamp, never add credentials or identity data:

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

## 9. Roll back only application images

If the reviewed image fails health or accounting verification, retain the
additive schema and select the saved rollback tags through the same standalone
deployment file. Verify the resolved tags before recreation. Do not drop columns,
constraints, indexes, or run a down migration.

```bash
set -eu
export CREDITSYNC_BACKEND_IMAGE_TAG="$CREDITSYNC_ROLLBACK_BACKEND_TAG"
export CREDITSYNC_FRONTEND_IMAGE_TAG="$CREDITSYNC_ROLLBACK_FRONTEND_TAG"
sed -i "0,/^    image: .*$/s|^    image: .*|    image: $CREDITSYNC_BACKEND_IMAGE_TAG|" "$CREDITSYNC_DEPLOY_COMPOSE_FILE"
sed -i "0,/^    image: .*$/! s|^    image: .*|    image: $CREDITSYNC_FRONTEND_IMAGE_TAG|" "$CREDITSYNC_DEPLOY_COMPOSE_FILE"
docker compose --env-file "$CREDITSYNC_DEPLOY_ENV_FILE" -f "$CREDITSYNC_DEPLOY_COMPOSE_FILE" config --quiet
docker compose --env-file "$CREDITSYNC_DEPLOY_ENV_FILE" -f "$CREDITSYNC_DEPLOY_COMPOSE_FILE" config --images > "$CREDITSYNC_LOG_DIR/rollback-compose-images.out"
grep -Fx "$CREDITSYNC_ROLLBACK_BACKEND_TAG" "$CREDITSYNC_LOG_DIR/rollback-compose-images.out"
grep -Fx "$CREDITSYNC_ROLLBACK_FRONTEND_TAG" "$CREDITSYNC_LOG_DIR/rollback-compose-images.out"
docker stop creditsync-frontend-prod 2>/dev/null || true
docker stop creditsync-backend-prod 2>/dev/null || true
docker rm creditsync-frontend-prod 2>/dev/null || true
docker rm creditsync-backend-prod 2>/dev/null || true
docker compose --env-file "$CREDITSYNC_DEPLOY_ENV_FILE" -f "$CREDITSYNC_DEPLOY_COMPOSE_FILE" up -d --no-build backend frontend
```

Record only sanitized Git SHA, image IDs/digests, Compose states/refs, backup checksum/path, restore result, exact schema states, journal hash/timestamp result, fingerprint comparison, health responses, and public operation IDs. Never attach dumps, env files, tokens, identity values, evidence, or full rows.
