# CreditSync

CreditSync is a multi-tenant, mobile-first loan and credit portfolio management system for small lending operations. The app combines borrower, loan, fund, transaction, analytics, file/OCR, LINE webhook, and AI tool workflows in one Bun-based TypeScript stack.

## Stack

| Area | Technology |
| --- | --- |
| Runtime | Bun |
| Backend | Elysia 1.4, Drizzle ORM 0.45, PostgreSQL, MinIO/S3 |
| Frontend | React 19, Vite 8, TypeScript 6, Tailwind CSS 4 |
| UI | shadcn-style local components, Radix UI, lucide-react, Recharts |
| Integrations | Google Auth, LINE Messaging API, Tesseract OCR |

## Features

- Tenant-scoped borrowers, loans, bank funds, bank profiles, and transactions.
- JWT authentication and route-level authorization guard.
- Fund performance analytics via `GET /analytics/fund-performance`.
- AI tool registry and execution endpoint under `/ai-tools`.
- Mobile-first dashboard layout with bottom navigation and analytics tab.
- File upload, OCR extraction, and S3-compatible object storage support.
- LINE webhook ingestion path for bot-uploaded files.

## Project Structure

```text
backend/
  src/
    db/          Drizzle schema and database connection
    lib/         Shared calculator, OCR, and storage helpers
    middleware/  Authentication middleware
    modules/     Elysia route modules

frontend/
  src/
    components/  Shared UI components
    layouts/     Dashboard shell and navigation
    pages/       Dashboard, auth, borrowers, loans, funds, transactions
    lib/         API/auth utilities

docs/
  adr/           Architecture decisions
  implementation_plan.md
```

## Local Development

Install dependencies per app:

```bash
cd backend
bun install

cd ../frontend
bun install
```

Run the API:

```bash
cd backend
bun run dev
```

Run the frontend:

```bash
cd frontend
bun run dev
```

## Verification

```bash
cd backend
bun build src/index.ts --target=bun --outdir=/tmp/creditsync-backend-build

cd ../frontend
bun run lint
bun run build
```

## Dependency Updates

Bun is the primary package manager for this repo. Use `bun update --latest` inside `backend/` and `frontend/`, and keep `bun.lock` committed with the matching `package.json`. If `backend/package-lock.json` remains in the repo, sync it after backend dependency changes.

Last dependency refresh: 2026-05-05.
