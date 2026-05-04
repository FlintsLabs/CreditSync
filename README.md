# CreditSync

CreditSync is a multi-tenant, mobile-first loan and credit portfolio management system for small lending operations. The app combines borrower, loan, fund, transaction, analytics, file/OCR, LINE webhook, and AI tool workflows in one Bun-based TypeScript stack.

## Stack

| Area | Technology | Version |
| --- | --- | --- |
| Runtime | Bun | 1.3.3 |
| Backend API | Elysia | 1.4.28 |
| Backend middleware | `@elysiajs/cors`, `@elysiajs/jwt`, `@elysiajs/swagger` | 1.4.2, 1.4.2, 1.3.1 |
| ORM / database driver | Drizzle ORM, Drizzle Kit, postgres | 0.45.2, 0.31.10, 3.4.9 |
| Database | PostgreSQL | External service, not pinned in repo |
| Object storage | MinIO / S3-compatible storage, AWS SDK S3 client | External service, `@aws-sdk/client-s3` 3.1041.0 |
| Frontend | React, React DOM, Vite, TypeScript | 19.2.5, 19.2.5, 8.0.10, 6.0.3 |
| Styling | Tailwind CSS, `@tailwindcss/postcss`, PostCSS, Autoprefixer | 4.2.4, 4.2.4, 8.5.14, 10.5.0 |
| UI | shadcn-style local components, Radix UI, lucide-react, Recharts | local, Radix 1.1.x/2.1.x, 1.14.0, 3.8.1 |
| Integrations | Google Auth, React Google OAuth, LINE Messaging API, Tesseract OCR | 10.6.2, 0.13.5, 11.0.0, 7.0.0 |

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
