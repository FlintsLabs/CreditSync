# CreditSync

## Borrower identity privacy

Borrower list cards mask Thai national IDs by default. The card's copy action intentionally copies the complete stored value for authorized owner workflows; use the borrower detail or edit flow when the full value must be viewed or updated. The list adapts its card columns to the available content width, so a narrow main panel keeps one full-width card rather than a cramped half-width column. Borrower detail headers use a compact profile avatar on small screens and expand modestly on larger layouts.

CreditSync is a mobile-first loan management system for lenders who need to track funding sources, borrower profiles, loan contracts, repayments, and closing balances in one place.

The stack is built around Bun + Elysia on the backend, React + Vite on the frontend, PostgreSQL for relational data, MinIO for file storage, and Dragonfly for Redis-compatible caching.

## What This Repo Does

CreditSync is designed for workflows like:

- Creating borrower profiles and storing their history
- Uploading ID card images and extracting text with OCR
- Creating loan agreements with daily, weekly, monthly, or floating interest logic
- Generating installment schedules before confirming a loan
- Capturing data-only or image-first repayments, reviewing matches, posting allocations, and reversing corrections
- Calculating closing balances for early payoff
- Tracking source-of-funds profiles and traceability between bank funding and downstream loans
- Receiving images from LINE webhooks and storing them for later processing

## Current Status

The repo already contains a working MVP foundation:

- Google sign-in and JWT-based session flow
- Multi-tenant backend model using `tenant_id`
- Borrower CRUD
- File upload to MinIO / S3-compatible storage
- OCR endpoint for uploaded ID-card-like images
- Loan calculation plus draft-review-activation flow
- Payment intake, evidence, review, grouped allocation, posting, and compensating reversal workflow
- Daily-loan renewal preview, confirmed execution, and compensating reversal workflow
- Legacy repayment-history reads remain available; repayment writes use the payment-intake workflow exclusively
- Closing summary calculation for loans
- LINE webhook ingestion for image uploads

Some screens are still mock/demo oriented and not fully wired to live backend data yet, especially:

- dashboard analytics
- fund detail dashboards
- graph-based portfolio visualization
- some deeper bank-funding traceability flows

## Core Features

### 1. Authentication and Access

- Google Sign-In for web login
- JWT auth between frontend and backend
- role model prepared for `owner`, `manager`, `collector`, and `viewer`
- multi-tenant data separation
- tenant admins (`owner`, `manager`) can see all tenant data, while `collector` and `viewer` accounts are scoped to records they own
- first Google login in a tenant becomes `owner`; later auto-created users default to `viewer`

### 2. Borrower Management

- create and edit borrower profiles
- search canonical names and confirmed aliases without auto-selecting ambiguous matches
- manage borrower aliases and view borrower portfolio summaries
- confirm or deactivate aliases and review borrower/alias audit revisions with request and correlation identifiers
- store phone, address, tags, notes, and map links
- attach ID card image
- OCR text extraction to help fill borrower data

### 3. Loan Management

- calculate repayment schedules before saving
- support `daily`, `weekly`, `monthly`, and `floating` repayment types
- create editable loan drafts, then activate them to lock terms and generate schedules exactly once
- use separate preview, draft-save, and activation confirmations in the web wizard
- preview installment breakdown
- calculate closing balance based on elapsed time and payments already received

### 4. Transaction Management

Daily-loan renewals use the authenticated `/loan-renewals` API:

- `POST /loan-renewals/preview` accepts `oldLoanPublicId`, `requestedPrincipal`, optional `waivedCharges`, and a required `waiverReason` when any charge is waived.
- `POST /loan-renewals/:id/execute` requires the persisted `previewHash`, `confirmed: true`, a non-blank `reason`, and an `Idempotency-Key` header.
- `POST /loan-renewals/:id/reverse` requires a non-blank `reason` and `Idempotency-Key` header. The web client retains each execution or reversal key while the same intent is retried and replaces it only when the preview or operator reason changes.

Renewal previews derive principal from posted, non-reversed transaction components. Execution locks and recomputes balances, due-day charges, penalties, and funding at execution time; previews become stale when any hashed state changes. Funding mutations and renewals serialize on the borrower loan before reading allocation state, and funding carry uses deterministic integer-cent largest-remainder allocation with tenant-safe renewal/group provenance. The outstanding-principal transfer is non-cash; only the net payout or collection is recorded as borrower cash. Reversal keys are operation-scoped, exact pre-execution loan state is restored, and reversal is blocked only by net active downstream transactions, adjustments, or funding before append-only compensations are written. Invalid `RENEWAL_PREVIEW_TTL_SECONDS` values fall back to 900 seconds.

- record repayments manually through payment intakes
- upload repayment slips
- link payment to a loan
- show repayment history
- create data-only payment intakes or prepare signed S3/MinIO evidence PUTs
- detect tenant-scoped operation, bank-reference, QR-payload, and evidence-hash duplicates without treating semantic similarity as a duplicate
- preview deterministic matches, review ambiguous matches, and split one intake across borrowers, loans, and schedules
- post schedule, loan, and fund effects atomically, then correct posted payments with append-only compensating reversals

The authenticated payment API is rooted at `/payment-intakes`. It exposes create/list/get and review-queue operations, `/:id/evidence/upload-intents`, `/:id/evidence/:evidenceId/finalize`, `/:id/match-preview`, `/:id/post`, `/:id/review`, and `/:id/reverse`. REST reversal requires a non-blank operator `reason`, which is preserved in the audit event. To preserve the frozen MCP schema-version 1.0 contract, `payment.reverse` continues to accept the legacy `{ paymentIntakePublicId }` input and uses a stable compatibility audit reason when the optional `reason` is absent; new MCP callers should provide it. All command IDs are UUIDs and all public money values are two-decimal strings. `GET /transactions` remains available for legacy repayment history, but `POST /transactions` returns `405 LEGACY_REPAYMENT_WRITE_DISABLED`; all repayment writes must use `/payment-intakes` so one Decimal allocator and one PostgreSQL lock order govern balances.

The web app exposes `/payments` as the human review inbox. It persists and shows semantic-duplicate warnings, requires an explicit warning acknowledgment, accepts optional signed evidence, edits any number of exact allocations across borrowers/loans/schedules, retains the previous proposal for a meaningful difference view, and requires a ready preview of the exact current editor revision before posting. Allocation edits are locked while previewing; every edit/add/remove/selection change invalidates the ready proposal, and stale responses are discarded. Reversal uses a separate reason-confirmation step. The manual repayment shortcut creates the intake and opens it in this review screen with the selected loan/schedule suggested; it never auto-posts or calls the disabled legacy write endpoint.

### 5. Funding and Traceability

- define funding sources / bank profiles
- model upstream bank borrowing and downstream borrower lending separately
- prepare data structure for ROI and traceability analysis

### 6. File and Bot Integration

- upload files into MinIO
- store file metadata in PostgreSQL
- receive image uploads from LINE webhook
- keep incoming bot files separated from normal user uploads

## Tech Stack

| Area | Technology |
| --- | --- |
| Runtime | Bun |
| Backend API | ElysiaJS |
| Frontend | React + Vite |
| Styling | Tailwind CSS |
| UI Components | shadcn/ui style components |
| Database | PostgreSQL |
| ORM | Drizzle ORM |
| Object Storage | MinIO / S3-compatible storage |
| OCR | Tesseract.js |
| Auth | Google Sign-In |
| Infra | Docker Compose, Kubernetes manifests, Cloudflare Tunnel, Dragonfly |

## Project Structure

```text
.
├── backend/              # Bun + Elysia API
│   ├── src/db/           # schema and database connection
│   ├── src/lib/          # calculator, OCR, storage helpers
│   ├── src/middleware/   # auth middleware
│   ├── src/modules/      # auth, borrowers, loans, files, transactions, webhook
│   └── src/services/     # shared borrower and loan-application commands
├── frontend/             # React + Vite app
│   ├── src/components/   # reusable UI components
│   ├── src/layouts/      # dashboard shell
│   ├── src/lib/          # api client, auth helpers, i18n
│   └── src/pages/        # landing, login, dashboard screens
├── docs/                 # ADRs and planning docs
├── plugins/creditsync/   # Private Codex plugin 1.0.0, skills, evals, and validation
├── k8s/                  # Kubernetes manifests
├── docker-compose.yml    # local development infra
├── docker-compose.infra.yml  # production-style infra including dragonfly cache
├── docker-compose.app.yml    # production-style app services
└── .env.production       # production-style Docker config
```

## Data Model Overview

The main entities in the current schema are:

- `users`
- `tenant_configs`
- `bank_profiles`
- `bank_loans`
- `borrowers`
- `loans`
- `transactions`
- `files`
- `bot_uploads`
- `bank_transactions`

This supports a traceability model where funding can originate from a bank profile / bank loan and then be linked to borrower loans and repayments.

## Local Development

### Prerequisites

- Bun 1.x
- Docker and Docker Compose
- PostgreSQL
- MinIO or another S3-compatible storage
- Google OAuth client ID

### 1. Start infrastructure

The simplest local path is:

```bash
docker compose up -d postgres minio
```

This uses [`docker-compose.yml`](./docker-compose.yml), which is kept specifically for local development.
It is intentionally separate from the production-style Docker files.

This repo exposes:

- PostgreSQL on `localhost:5433`
- MinIO API on `localhost:9000`
- MinIO Console on `localhost:9001`
- Dragonfly on `localhost:6381`

### 2. Configure environment

Use these files as the starting point:

- root example: [`.env.example`](./.env.example)
- backend local env: [`backend/.env`](./backend/.env)
- frontend local env: [`frontend/.env`](./frontend/.env)

Important variables include:

- `DATABASE_URL`
- `GOOGLE_CLIENT_ID`
- `JWT_SECRET`
- `DEFAULT_TENANT_ID`
- `S3_ENDPOINT`
- `S3_PUBLIC_URL`
- `S3_BUCKET`
- `FILE_URL_TTL_SECONDS`
- `EVIDENCE_UPLOAD_TTL_SECONDS`
- `EVIDENCE_MAX_BYTES`
- `PAYMENT_PREVIEW_TTL_SECONDS`
- `RENEWAL_PREVIEW_TTL_SECONDS`
- `STORAGE_PROVIDER`
- `CACHE_URL`
- `CACHE_TTL_SECONDS`
- `MCP_API_TOKEN_HASHES`
- `MCP_ALLOWED_HOSTS`
- `MCP_TENANT_ID`
- `MCP_ACTOR_EMAIL`
- `MCP_RATE_LIMIT_MAX`
- `MCP_RATE_LIMIT_WINDOW_SECONDS`
- `LINE_CHANNEL_SECRET`
- `LINE_CHANNEL_ACCESS_TOKEN`
- `LINE_TENANT_ID`
- `VITE_GOOGLE_CLIENT_ID`

For file access, CreditSync stores an internal file reference and resolves it to a time-limited signed URL when the API returns borrower images, uploaded files, and repayment slips. With the default S3-compatible setup, keep `S3_ENDPOINT` for server-side uploads and `S3_PUBLIC_URL` for the browser-reachable hostname used in presigned download links. In the bundled production setup, `S3_PUBLIC_URL` should point to the frontend domain with a `/files` prefix because Nginx proxies `/files/*` to MinIO. Payment evidence uses signed S3-compatible PUTs with signed MIME, size, SHA-256 checksum, tenant, and intake metadata; the signer-returned expiry is persisted exactly, and finalization checks that timestamp plus stored-object metadata under row locks. It never accepts a caller-provided fetch URL. `EVIDENCE_UPLOAD_TTL_SECONDS` defaults to `300`, `EVIDENCE_MAX_BYTES` to `20971520` (20 MiB), and both `PAYMENT_PREVIEW_TTL_SECONDS` and `RENEWAL_PREVIEW_TTL_SECONDS` default to `900`. The evidence-intent workflow requires `STORAGE_PROVIDER=s3`; existing Azure Blob file reads/uploads remain available outside this workflow.

### 3. Install dependencies

```bash
cd backend && bun install
cd ../frontend && bun install
```

### 4. Run database migrations

```bash
cd backend
bun run migrate
```

### 5. Start backend

```bash
cd backend
bun run dev
```

Backend runs on:

```text
http://localhost:3000
```

Swagger is enabled by the Elysia Swagger plugin.

### 6. Start frontend

```bash
cd frontend
bun run dev
```

Frontend runs on:

```text
http://localhost:5173
```

The frontend uses `/api` as the API base path and expects Vite proxy configuration during development.

Protected app navigation now keeps the dashboard overview at `/dashboard`, while resource sections live at first-level routes such as `/funds/:id`, `/borrowers/:id`, and `/loans/:id`. URL-facing resource identifiers are moving to `uuidv7`-style public IDs, while internal numeric IDs remain in the database for joins and accounting logic.

Loan agreement creation is draft-first. `POST /api/loans` accepts a borrower and either an optional drawdown UUID (`bankLoanPublicId`) or an active own-capital profile UUID (`bankProfilePublicId`), never both, and returns a draft without schedules. Draft terms can be changed with `PUT /api/loans/:id`; `POST /api/loans/:id/activate` locks the terms, checks the selected source's signed remaining capacity, then creates schedules and exactly one initial funding allocation. Repeating activation is safe and returns the already-active agreement. The web wizard groups own capital, bank drawdowns, and unallocated loans; an existing personal source can be explicitly converted to an own-capital pool at its detail page, with a default non-cash 2.00% annual opportunity-cost rate.

Active or paid daily-loan detail pages include the renewal control. The operator sees recovered principal, old outstanding principal, separate due interest/fee/penalty components, aggregate charges, waivers, settlement, net payout or collection, and the full replacement schedule before checking an explicit confirmation. Execution and reversal use separate stable retry keys and show explicit empty, unavailable, failed, or populated audit states with localized action labels.

Loan-facing REST payloads use public UUIDs for loans, schedules, funding profiles, drawdowns, and allocations. Public money inputs and outputs use two-decimal strings (for example, `"500.00"`). This includes schedule and closing reads, allocation/profitability summaries, and funding allocation/reallocation mutations. Generated schedules conserve the exact principal-plus-interest obligation: each row's principal, interest, and fee components equal its scheduled total and remaining due, with any cent residual carried by the final installment. Schedule money remains Decimal-safe internally and does not pass through JavaScript `number`, including for values above the safe-integer range.

## Private Remote MCP

CreditSync serves a private stateless Streamable HTTP MCP endpoint at `/mcp` in the existing backend process. Each HTTP request gets a fresh MCP server and Web Standard transport; there are no server sessions or legacy SSE endpoints. The adapter invokes the same borrower, payment, loan, and renewal application services as the web API directly—it does not call CreditSync REST routes internally. The unauthenticated `GET /mcp/health` response contains only service status and schema version.

All MCP requests are bound to the server-side `MCP_TENANT_ID` and `MCP_ACTOR_EMAIL`. A client cannot submit or override tenant or actor identity. The configured actor must already exist in that tenant, and its normal CreditSync role/portfolio permissions still apply. Funding sources are list-only; the MCP surface has no generic SQL, arbitrary fetch, or funding mutation tool.

The frozen schema-version `1.0` tool names are:

```text
borrower.search       borrower.portfolio    borrower.create
borrower.update       borrower.alias        intake.get
intake.list           intake.create         evidence.prepare
evidence.finalize     payment.preview       payment.post
payment.reverse       loan.preview          loan.draft
loan.activate         renewal.preview       renewal.execute
renewal.reverse       funding-source.list
```

Tool inputs use public UUIDs and two-decimal money strings. Results include concise text plus structured content with `schemaVersion: "1.0"`. Payment posting/reversal, loan activation, and renewal execution/reversal also return public correlation and audit IDs. Tool failures use the stable shape `{code,message,retryable,reviewRequired,details}` without internal stack traces.

### Configure and rotate the bearer token

Generate a high-entropy client token and calculate its SHA-256 hash locally. Keep the raw token only in the MCP client secret store; CreditSync receives only its hash:

```bash
umask 077
CREDITSYNC_MCP_TOKEN_FILE=/secure/operator/location/creditsync-mcp-token
openssl rand -hex 32 | tr -d '\n' > "$CREDITSYNC_MCP_TOKEN_FILE"
test "$(wc -c < "$CREDITSYNC_MCP_TOKEN_FILE")" -eq 64
sha256sum "$CREDITSYNC_MCP_TOKEN_FILE"
```

The no-newline write and 64-byte assertion ensure the digest covers the exact raw bearer bytes. Set the resulting 64-character digest in `MCP_API_TOKEN_HASHES`, set `MCP_ALLOWED_HOSTS` to the external request host (comma-separated, without a URL scheme), and configure the fixed tenant/actor. Load the raw file into the client secret without appending a newline, then connect to `https://your-credit-sync-host.example/mcp`.

For rotation, put the old and new hashes in `MCP_API_TOKEN_HASHES` separated by a comma, restart the backend, move clients to the new raw token, then remove the old hash and restart again. At most two unique hashes are accepted. Never commit the raw token, token hash, `.env`, or `.env.production`.

`MCP_RATE_LIMIT_MAX` defaults to 60 requests per `MCP_RATE_LIMIT_WINDOW_SECONDS` (also 60). Dragonfly is used when `CACHE_URL` is available; an in-process limiter remains active if the cache is unavailable. `/mcp` logs only sanitized event, tool, status, request/correlation ID, and timing fields—never authorization headers or tool arguments.

## Private CreditSync Plugin

The repository includes CreditSync Plugin `1.0.0` under [`plugins/creditsync`](./plugins/creditsync). It combines five orchestration skills with a private app reference to the HTTPS MCP endpoint; it does not bundle a local MCP process, URL, bearer token, OAuth, hooks, or plugin UI.

Before installation, register the deployed MCP endpoint as a private Codex app and replace the conspicuous `plugin_asdk_app_REPLACE_AFTER_PRIVATE_REGISTRATION` value in `plugins/creditsync/.app.json` with the returned `plugin_asdk_app...` technical ID. Then validate and install from the repository marketplace:

```bash
bun test plugins/creditsync/tests/plugin-contract.test.ts
bun run plugins/creditsync/scripts/validate.ts
python3 /home/flintstone/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py plugins/creditsync
codex plugin marketplace add /absolute/path/to/CreditSync
codex plugin add creditsync@personal
```

Start a new Codex task after installation. The committed app ID is intentionally a non-runnable registration placeholder, so static validation is not evidence of a live private-app connection.

See [`docs/operations/agent-mcp-plugin.md`](./docs/operations/agent-mcp-plugin.md) for Cloudflare, token rotation, MinIO evidence, private registration, and rollback, and [`docs/operations/backup-recovery.md`](./docs/operations/backup-recovery.md) for database/object backup and isolated restore verification.

### Dev vs Docker Quick Reference

| Scenario | Infra | Backend | Frontend |
| --- | --- | --- | --- |
| Local development | `docker compose up -d postgres minio` | `cd backend && bun run dev` | `cd frontend && bun run dev` |
| Production-style Docker | `docker compose --env-file .env.production -f docker-compose.infra.yml up -d` | `docker compose --env-file .env.production -f docker-compose.app.yml up --build -d backend` | `docker compose --env-file .env.production -f docker-compose.app.yml up --build -d frontend` |

Use `bun run dev` when you are actively developing features locally.
Use the split Docker files when you want production-like containers, Nginx proxying, or selective rebuilds for `frontend` and `backend`.

## Docker Deployment

### Which Compose File To Use

- [`docker-compose.yml`](./docker-compose.yml): local development infra only. Use this when you want Docker for `postgres` and `minio`, but still run `backend` and `frontend` with `bun run dev`.
- [`docker-compose.infra.yml`](./docker-compose.infra.yml): production-style infra. Use this for long-lived `postgres`, `minio`, and `dragonfly`.
- [`docker-compose.app.yml`](./docker-compose.app.yml): production-style app services. Use this to build and redeploy `backend` and `frontend` independently from infra.

For a production-style Docker setup, this repo separates infrastructure from application services:

- [`docker-compose.infra.yml`](./docker-compose.infra.yml) for `postgres`, `minio`, and `dragonfly`
- [`docker-compose.app.yml`](./docker-compose.app.yml) for `backend` and `frontend`
- [`.env.production`](./.env.production) for Docker production-style variables

### 1. Configure production variables

Fill in the real values in:

- [`.env.production`](./.env.production)

At minimum, update:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `VITE_GOOGLE_CLIENT_ID`
- `JWT_SECRET`
- `CORS_ORIGINS`
- `S3_PUBLIC_URL`
- `FILE_URL_TTL_SECONDS`
- `CACHE_URL`
- `CACHE_TTL_SECONDS`
- `MCP_API_TOKEN_HASHES`
- `MCP_ALLOWED_HOSTS`
- `MCP_TENANT_ID`
- `MCP_ACTOR_EMAIL`

### 2. Start infra once

```bash
docker compose --env-file .env.production -f docker-compose.infra.yml up -d
```

### 3. Build and start the app

```bash
docker compose --env-file .env.production -f docker-compose.app.yml up --build -d
```

This exposes:

- frontend on `http://localhost:8088`
- PostgreSQL on `localhost:5436`
- MinIO API on `localhost:9012`
- MinIO Console on `localhost:9013`
- Dragonfly on `localhost:6381`

The frontend container serves the React app through Nginx and proxies `/api` and `/mcp` to the backend container. The MCP proxy keeps authorization, protocol, request, and correlation headers, disables response/request buffering, and uses extended read/send timeouts.
When Cloudflare Tunnel is enabled in Docker, it should run on the shared `creditsync_runtime` network so hostnames like `frontend`, `backend`, and `minio` resolve directly inside the tunnel container.

### 4. Rebuild only what changed

Rebuild only backend:

```bash
docker compose --env-file .env.production -f docker-compose.app.yml up --build -d backend
```

Rebuild only frontend:

```bash
docker compose --env-file .env.production -f docker-compose.app.yml up --build -d frontend
```

## Testing

Backend tests can be run with:

```bash
cd backend
bun test
```

Current tests cover:

- OCR smoke test
- loan schedule calculation
- loan closing summary calculation

## Deployment Notes

This repo also includes:

- Dockerfiles for frontend and backend
- Kubernetes manifests under [`k8s/`](./k8s)
- Cloudflare Tunnel support for exposing services securely

If you deploy publicly, do not commit real secrets. Keep OAuth credentials, JWT secrets, tunnel tokens, and bot credentials in env files or secret management only.

## Documentation

Additional planning and architecture notes:

- [docs/implementation_plan.md](./docs/implementation_plan.md)
- [docs/adr/001-tech-stack.md](./docs/adr/001-tech-stack.md)
- [docs/adr/002-storage-strategy.md](./docs/adr/002-storage-strategy.md)
- [requirement.md](./requirement.md)
- [Agent/MCP/plugin operations](./docs/operations/agent-mcp-plugin.md)
- [Backup and recovery](./docs/operations/backup-recovery.md)

## Suggested Next Work

If the next goal is making this production-ready, the highest-value areas are:

- replace remaining mock dashboard data with live API data
- complete bank funding to borrower traceability screens
- add stronger RBAC enforcement per route
- add due-date reminders and notification workflows
- improve repayment matching for bulk transfers and slip verification
- harden secret handling and deployment configuration
