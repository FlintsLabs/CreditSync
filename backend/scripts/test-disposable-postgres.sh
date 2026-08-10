#!/usr/bin/env bash
set -euo pipefail

container_name="creditsync-test-postgres-$$"
database_name="creditsync_disbursement_test"
database_user="creditsync_test"
database_password="creditsync_test"

cleanup() {
  docker rm --force "$container_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker run --detach --rm --name "$container_name" \
  --env "POSTGRES_DB=$database_name" \
  --env "POSTGRES_USER=$database_user" \
  --env "POSTGRES_PASSWORD=$database_password" \
  --publish-all postgres:18 >/dev/null

for _ in {1..30}; do
  if docker exec "$container_name" pg_isready --username "$database_user" --dbname "$database_name" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! docker exec "$container_name" pg_isready --username "$database_user" --dbname "$database_name" >/dev/null 2>&1; then
  echo "Disposable PostgreSQL did not become ready" >&2
  exit 1
fi

host_port="$(docker port "$container_name" 5432/tcp | awk -F: 'NR == 1 { print $NF }')"
test_database_url="postgres://$database_user:$database_password@127.0.0.1:$host_port/$database_name"

cd "$(dirname "$0")/.."
DATABASE_URL="$test_database_url" bun run migrate
DATABASE_URL="$test_database_url" TEST_DATABASE_URL="$test_database_url" bun test --max-concurrency=1 "$@"
