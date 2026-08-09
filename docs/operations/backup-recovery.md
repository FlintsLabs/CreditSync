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

Use an authenticated MinIO Client (`mc`) profile to mirror the complete CreditSync bucket to a versioned/off-host destination. Keep object names and metadata; evidence finalization depends on both.

```bash
mc alias set creditsync-source https://<minio-host> <access-key> <secret-key>
mc mirror --preserve creditsync-source/creditsync-files /secure/creditsync-minio-YYYYMMDD-HHMM/
```

Do not use `--remove` in a backup command. Protect MinIO credentials from shell history and logs. Record a manifest and SHA-256 for the backup set.

## Restore rehearsal

Test every release backup in a disposable, isolated environment before treating it as recoverable:

1. Start an empty PostgreSQL instance and empty MinIO bucket with no Cloudflare or MCP ingress.
2. Restore the dump into an explicitly named disposable database with `pg_restore`.
3. Mirror MinIO objects from backup into the disposable bucket.
4. Run application migrations once, backend integration/MCP contract tests, and reconciliation queries.
5. Compare counts and money totals for posted/non-reversed transactions, schedule paid components, loan outstanding components, renewal cash/settlement, funding ledgers, audit logs, and evidence rows/objects.
6. Verify append-only audit triggers reject update/delete and evidence objects resolve only through signed access.

## Production recovery

Recovery is destructive to the selected target. Confirm the exact target database/container/bucket, stop the backend and all bot/MCP writers, and preserve a final incident snapshot before proceeding.

1. Restore into a new database/bucket first; never overwrite the only copy.
2. Run the restore rehearsal checks against that new target.
3. Point a stopped backend at the restored target, apply only compatible migrations, and repeat reconciliation.
4. Switch traffic only after owner approval; keep the previous target read-only until the retention window expires.
5. Rotate MCP bearer tokens and signed-storage credentials if the incident involved credential exposure.

Posted financial corrections after reopening must use supported compensating reversals/adjustments. Never manually update or delete transaction, renewal, or audit history as a recovery shortcut.
