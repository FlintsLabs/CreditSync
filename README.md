# CreditSync

CreditSync is a mobile-first loan management system for lenders who need to track funding sources, borrower profiles, loan contracts, repayments, and closing balances in one place.

The stack is built around Bun + Elysia on the backend, React + Vite on the frontend, PostgreSQL for relational data, MinIO for file storage, and Dragonfly for Redis-compatible caching.

## What This Repo Does

CreditSync is designed for workflows like:

- Creating borrower profiles and storing their history
- Uploading ID card images and extracting text with OCR
- Creating loan agreements with daily, weekly, monthly, or floating interest logic
- Generating installment schedules before confirming a loan
- Recording repayments with optional slip upload
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
- Loan calculation service and loan creation flow
- Transaction recording with optional repayment slip upload
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

### 2. Borrower Management

- create and edit borrower profiles
- store phone, address, tags, notes, and map links
- attach ID card image
- OCR text extraction to help fill borrower data

### 3. Loan Management

- calculate repayment schedules before saving
- support `daily`, `weekly`, `monthly`, and `floating` repayment types
- create active loan agreements
- preview installment breakdown
- calculate closing balance based on elapsed time and payments already received

### 4. Transaction Management

- record repayments manually
- upload repayment slips
- link payment to a loan
- show repayment history

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
│   └── src/modules/      # auth, borrowers, loans, files, transactions, webhook
├── frontend/             # React + Vite app
│   ├── src/components/   # reusable UI components
│   ├── src/layouts/      # dashboard shell
│   ├── src/lib/          # api client, auth helpers, i18n
│   └── src/pages/        # landing, login, dashboard screens
├── docs/                 # ADRs and planning docs
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
- `CACHE_URL`
- `CACHE_TTL_SECONDS`
- `LINE_CHANNEL_SECRET`
- `LINE_CHANNEL_ACCESS_TOKEN`
- `LINE_TENANT_ID`
- `VITE_GOOGLE_CLIENT_ID`

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
- `CACHE_URL`
- `CACHE_TTL_SECONDS`

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

The frontend container serves the React app through Nginx and proxies `/api` to the backend container.

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

## Suggested Next Work

If the next goal is making this production-ready, the highest-value areas are:

- replace remaining mock dashboard data with live API data
- complete bank funding to borrower traceability screens
- add stronger RBAC enforcement per route
- add due-date reminders and notification workflows
- improve repayment matching for bulk transfers and slip verification
- harden secret handling and deployment configuration
