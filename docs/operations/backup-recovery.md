# CreditSync Backup and Recovery

Back up PostgreSQL and MinIO as one recovery point before migrations, releases, token/host changes that affect access, and any operational rollback. Dragonfly is a rebuildable cache and is not part of the accounting backup.

## PostgreSQL backup

Run `pg_dump` against the explicit CreditSync database and encrypt/copy the resulting file to storage outside the Docker host. The example writes a custom-format dump without embedding a password in the command line; supply credentials through the protected production environment or a `.pgpass` file.

```bash
docker exec creditsync-postgres-prod sh -lc \
  'pg_dump --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --format custom --no-owner --file /tmp/creditsync.dump'
docker cp creditsync-postgres-prod:/tmp/creditsync.dump ./creditsync-postgres-YYYYMMDD-HHMM.dump
```

Remove the container-side temporary file after verifying the copied dump. Record the application commit, migration list, UTC timestamp, database name, file size, and SHA-256 beside the backup. Do not place backups in Git.

## MinIO evidence backup

Use either tested server-side MinIO replication/versioning or a **quiesced storage-level snapshot**. A plain filesystem `mc mirror --preserve` copy is not sufficient here because it does not promise to retain arbitrary S3 user metadata; evidence recovery needs the `tenant` and `intake` metadata as well as the original bytes/checksum.

For the bundled single-node Docker deployment, first block public ingress and stop every evidence writer, then stop MinIO cleanly:

```bash
docker compose --env-file .env.production -f docker-compose.app.yml stop backend
docker compose --env-file .env.production -f docker-compose.infra.yml stop tunnel minio
docker inspect creditsync-minio-prod --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}'
```

Verify the returned volume is the exact MinIO `/data` mount, substitute that literal value below, and snapshot the whole stopped volume—not just bucket objects:

```bash
docker run --rm \
  -v <verified-minio-volume>:/source:ro \
  -v /secure/creditsync-backups:/backup \
  alpine:3.21 sh -c 'cd /source && tar --numeric-owner -czf /backup/creditsync-minio-YYYYMMDD-HHMM.tgz .'
sha256sum /secure/creditsync-backups/creditsync-minio-YYYYMMDD-HHMM.tgz
```

This captures MinIO's internal object metadata alongside object bytes. Record the exact MinIO image digest, verified volume name, archive digest, timestamp, and PostgreSQL backup that form the recovery point. Restart MinIO and the app only after the archive checksum has been recorded. These commands require no MinIO access key in shell history.

## Restore rehearsal

Test every release backup in a disposable, isolated environment before treating it as recoverable:

1. Start an empty PostgreSQL instance and a new empty MinIO volume with no Cloudflare or MCP ingress, using the recorded MinIO image version.
2. Restore the dump into an explicitly named disposable database with `pg_restore`.
3. With disposable MinIO stopped, extract the complete storage snapshot into its empty `/data` volume, preserve numeric ownership, and start MinIO only after extraction completes.
4. Run application migrations once, backend integration/MCP contract tests, and reconciliation queries.
5. Compare counts and money totals for posted/non-reversed transactions, schedule paid components, loan outstanding components, renewal cash/settlement, funding ledgers, audit logs, and evidence rows/objects.
6. For representative evidence rows, use an authenticated `mc stat --json` profile whose credentials are injected by the protected runtime (never written in command history) and confirm user metadata includes the exact `tenant` and `intake` values from PostgreSQL. Stream each object through `sha256sum` and compare it with `payment_evidence.sha256`; also confirm MIME type and byte count. Verify append-only audit triggers reject update/delete and evidence objects resolve only through signed access.

## Production recovery

Recovery is destructive to the selected target. Confirm the exact target database/container/bucket, stop the backend and all bot/MCP writers, and preserve a final incident snapshot before proceeding.

1. Restore into a new database/bucket first; never overwrite the only copy.
2. Run the restore rehearsal checks against that new target.
3. Point a stopped backend at the restored target, apply only compatible migrations, and repeat reconciliation.
4. Switch traffic only after owner approval; keep the previous target read-only until the retention window expires.
5. Rotate MCP bearer tokens and signed-storage credentials if the incident involved credential exposure.

Posted financial corrections after reopening must use supported compensating reversals/adjustments. Never manually update or delete transaction, renewal, or audit history as a recovery shortcut.
