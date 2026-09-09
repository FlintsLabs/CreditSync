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

cd "$(dirname "$0")/.."
DATABASE_URL="$test_database_url" bun run migrate
# The suite shares one disposable database and many files reset overlapping tables.
# max-concurrency only limits tests inside a worker; --parallel=1 is required to
# prevent independent Bun workers from holding RowExclusiveLocks across resets.
DATABASE_URL="$test_database_url" TEST_DATABASE_URL="$test_database_url" bun test --max-concurrency=1 --parallel=1 "$@"
