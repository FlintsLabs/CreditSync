# CreditSync Agent, Remote MCP, and Private Plugin Operations

This guide covers the private owner-operated deployment. It does not configure public OAuth, public plugin submission, multi-tenant agent administration, server-side OCR, or MCP funding mutations.

## Architecture

The Elysia backend serves REST and stateless Streamable HTTP MCP in one process. `/mcp` constructs a server/transport per request and calls the same application services as REST; it never loops back through REST. Nginx proxies `/mcp` without buffering and Cloudflare Tunnel exposes the frontend host over HTTPS. PostgreSQL is the accounting source of truth, MinIO stores optional evidence, and Dragonfly supplies distributed rate limiting with an in-process safety fallback.

## Deployment checklist

1. Back up PostgreSQL and MinIO using `backup-recovery.md`.
2. Configure `.env.production` from `.env.example`. Required MCP settings are `MCP_API_TOKEN_HASHES`, `MCP_ALLOWED_HOSTS`, `MCP_TENANT_ID`, `MCP_ACTOR_EMAIL`, `MCP_RATE_LIMIT_MAX`, and `MCP_RATE_LIMIT_WINDOW_SECONDS`.
3. Ensure the fixed MCP actor already exists in the fixed tenant. A client cannot choose either identity.
4. Start infrastructure, then the application:

```bash
docker compose --env-file .env.production -f docker-compose.infra.yml up -d
docker compose --env-file .env.production -f docker-compose.app.yml up --build -d
```

5. Route the Cloudflare public hostname to `http://frontend:80` on `creditsync_runtime`. Set `MCP_ALLOWED_HOSTS` to that external hostname without scheme or path.
6. Verify `GET https://<host>/mcp/health` exposes status/schema only. Verify invalid bearer credentials fail and an authenticated MCP client can initialize/list the frozen 57 tools.
7. Review backend logs for request/correlation/tool/status/duration only. Raw authorization, tool payloads, QR values, slip contents, identity fields, and signed URLs must not appear.

## Bearer token creation and rotation

Generate the raw value on the client/operator machine. Store it only in the Codex private app secret. Put only its lowercase SHA-256 digest on the server:

```bash
umask 077
CREDITSYNC_MCP_TOKEN_FILE=/secure/operator/location/creditsync-mcp-token
openssl rand -hex 32 | tr -d '\n' > "$CREDITSYNC_MCP_TOKEN_FILE"
chmod 600 "$CREDITSYNC_MCP_TOKEN_FILE"
test "$(wc -c < "$CREDITSYNC_MCP_TOKEN_FILE")" -eq 64
sha256sum "$CREDITSYNC_MCP_TOKEN_FILE"
```

The `tr` plus 64-byte assertion ensures the server hashes exactly the raw token bytes and not a trailing line feed. Put the displayed digest on the server; load the raw file into the private app secret without adding a newline.

For rotation, configure old and new digests as the two comma-separated `MCP_API_TOKEN_HASHES`, redeploy the backend, update the private app secret, verify the new token, remove the old digest, and redeploy. The server accepts at most two unique hashes. Never print the raw token in CI output or commit a digest/environment file.

## Optional MinIO payment evidence

Evidence is not required to create or post a payment intake. For image-first capture, Codex extracts structured fields and QR data locally, creates the intake, computes file SHA-256, obtains a short-lived signed PUT with `evidence.prepare`, uploads unchanged bytes using its required headers, and calls `evidence.finalize`. CreditSync verifies stored metadata before linking evidence. It does not invoke OCR/AI and never accepts a caller-provided fetch URL.

Keep `STORAGE_PROVIDER=s3`, `S3_ENDPOINT` reachable by the backend, and `S3_PUBLIC_URL` reachable by the uploading client through `/files` where applicable. Limit `EVIDENCE_UPLOAD_TTL_SECONDS` and `EVIDENCE_MAX_BYTES`; do not log raw QR payloads or signed URLs.

## Private app and plugin installation

1. Register `https://<host>/mcp` as a private Codex app using bearer authentication.
2. Replace the conspicuous ID in `plugins/creditsync/.app.json` with the returned technical ID beginning `plugin_asdk_app`.
3. Validate:

```bash
bun test plugins/creditsync/tests
bun run plugins/creditsync/scripts/validate.ts
python3 /home/flintstone/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py plugins/creditsync
```

4. Add the repository marketplace and install:

```bash
codex plugin marketplace add /absolute/path/to/CreditSync
codex plugin add creditsync@personal
```

5. Start a new Codex task. Test borrower search first, then a disposable data-only intake before any production financial flow.

The committed placeholder cannot connect and must remain until private registration supplies a real ID. URL and secrets never belong in the plugin package.

## Release and operational rollback

Before rollout, preserve database/object backups and the previously deployed app image/plugin directory. Apply migrations before accepting writes, then run reconciliation totals and the MCP contract suite. If application health or accounting verification fails:

1. Disable Cloudflare `/mcp` ingress while leaving web/REST routes available. As a second kill switch, replace `MCP_API_TOKEN_HASHES` with the SHA-256 of one newly generated, valid token whose raw value is not distributed to any client. **Never leave `MCP_API_TOKEN_HASHES` empty**: empty/invalid configuration intentionally prevents the shared backend from starting and would also take REST offline.
2. Keep the database and object store intact; do not delete or edit posted records.
3. Roll the application image back only when it remains compatible with applied additive migrations.
4. If data restoration is required, stop all writers and follow the isolated restore procedure in `backup-recovery.md`.
5. Reconcile transaction, schedule, loan, renewal, and funding totals before reopening web/MCP writes.

Removing or reinstalling the plugin affects only Codex discovery. It does not roll back financial data.
