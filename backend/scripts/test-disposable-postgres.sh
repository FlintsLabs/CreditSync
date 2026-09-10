#!/usr/bin/env bash
set -euo pipefail

container_name="creditsync-test-postgres-$$"
volume_name=""
database_name="creditsync_disbursement_test"
database_user="creditsync_test"
database_password="creditsync_test"

cleanup() {
  # The volume is created by this invocation and its generated name is retained
  # explicitly. This remains safe when docker run or postgres startup fails.
  docker rm --force --volumes "$container_name" >/dev/null 2>&1 || true
  if [ -n "$volume_name" ]; then
    docker volume rm "$volume_name" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

volume_name="$(docker volume create \
  --label "creditsync.test=disposable-postgres" \
  --label "creditsync.test.container=$container_name")"

docker run --detach --rm --name "$container_name" \
  --volume "$volume_name:/var/lib/postgresql" \
  --label "creditsync.test=disposable-postgres" \
  --label "creditsync.test.container=$container_name" \
  --env "POSTGRES_DB=$database_name" \
  --env "POSTGRES_USER=$database_user" \
  --env "POSTGRES_PASSWORD=$database_password" \
  --publish-all postgres:18 >/dev/null

ready_checks=0
for _ in {1..30}; do
  if docker exec "$container_name" pg_isready --username "$database_user" --dbname "$database_name" >/dev/null 2>&1; then
    ready_checks=$((ready_checks + 1))
    if [ "$ready_checks" -ge 2 ]; then
      break
    fi
  else
    ready_checks=0
  fi
  sleep 1
done

if ! docker exec "$container_name" pg_isready --username "$database_user" --dbname "$database_name" >/dev/null 2>&1; then
  echo "Disposable PostgreSQL did not become ready" >&2
  exit 1
fi

host_port="$(docker port "$container_name" 5432/tcp | awk -F: 'NR == 1 { print $NF }')"
test_database_url="postgres://$database_user:$database_password@127.0.0.1:$host_port/$database_name"

reset_schema() {
  docker exec "$container_name" psql --username "$database_user" --dbname "$database_name" --command \
    'DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;' >/dev/null
}

cd "$(dirname "$0")/.."
reset_schema
DATABASE_URL="$test_database_url" bun run migrate
BUN_DATABASE_URL="$test_database_url" bun -e 'import postgres from "postgres"; const sql = postgres(process.env.BUN_DATABASE_URL!); const rows = await sql`SELECT to_regclass('"'"'public.payment_batch_staging_items'"'"') AS table_name`; if (rows[0]?.table_name !== "payment_batch_staging_items") throw new Error(`Disposable migration baseline missing payment_batch_staging_items: ${rows[0]?.table_name ?? "null"}`); await sql.end();'
# Bun's --parallel=1 limits worker count but keeps every test file in one worker
# process. A timed-out concurrent DB test can therefore leave a transaction or
# pool connection alive for the next file, deadlocking its destructive fixture
# reset. Focused invocations retain the direct one-process behavior; the full
# suite gives every file a fresh process and reapplies the current migrations so
# disposable schema-mutating tests cannot leak state across files.
if [ "$#" -gt 0 ]; then
  BUN_RUNTIME_TRANSPILER_CACHE_PATH="/tmp/creditsync-bun-transpiler-$container_name" CREDITSYNC_TEST_DATABASE_URL="$test_database_url" DATABASE_URL="$test_database_url" TEST_DATABASE_URL="$test_database_url" bun test --max-concurrency=1 --isolate "$@"
  exit $?
fi

mapfile -t test_files < <(find src -type f -name '*.test.ts' -print | sort)
failed_files=0
for test_file in "${test_files[@]}"; do
  echo "\n=== disposable backend test: $test_file ==="
  test_file_path="$(realpath "$test_file")"
  if ! reset_schema; then
    echo "Disposable schema reset failed before $test_file" >&2
    failed_files=$((failed_files + 1))
    continue
  fi
  if ! DATABASE_URL="$test_database_url" bun run migrate >/dev/null; then
    echo "Migration baseline failed before $test_file" >&2
    failed_files=$((failed_files + 1))
    continue
  fi
  if ! BUN_RUNTIME_TRANSPILER_CACHE_PATH="/tmp/creditsync-bun-transpiler-$container_name" CREDITSYNC_TEST_DATABASE_URL="$test_database_url" DATABASE_URL="$test_database_url" TEST_DATABASE_URL="$test_database_url" bun test --max-concurrency=1 --isolate "$test_file_path"; then
    failed_files=$((failed_files + 1))
  fi
done

if [ "$failed_files" -gt 0 ]; then
  echo "Disposable backend suite failed in $failed_files test file(s)." >&2
  exit 1
fi
