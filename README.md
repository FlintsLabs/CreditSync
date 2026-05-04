# CreditSync

CreditSync is a multi-tenant, mobile-first loan and credit portfolio management system for small lending operations. The app combines borrower, loan, fund, transaction, analytics, file/OCR, LINE webhook, and AI tool workflows in one Bun-based TypeScript stack.

## Stack

| Area | Technology | Version |
| --- | --- | --- |
| Runtime | ![Bun](https://img.shields.io/badge/Bun-000000?style=flat&logo=bun&logoColor=white) Bun | 1.3.3 |
| Backend API | ![Elysia](https://img.shields.io/badge/ElysiaJS-FE5F50?style=flat&logo=bun&logoColor=white) Elysia | 1.4.28 |
| Backend middleware | ![Elysia](https://img.shields.io/badge/ElysiaJS-FE5F50?style=flat&logo=bun&logoColor=white) `@elysiajs/cors`, `@elysiajs/jwt`, `@elysiajs/swagger` | 1.4.2, 1.4.2, 1.3.1 |
| ORM / database driver | ![Drizzle](https://img.shields.io/badge/Drizzle_ORM-C5F74F?style=flat&logo=drizzle&logoColor=black) Drizzle ORM, Drizzle Kit, postgres | 0.45.2, 0.31.10, 3.4.9 |
| Database | ![PostgreSQL](https://img.shields.io/badge/PostgreSQL-316192?style=flat&logo=postgresql&logoColor=white) PostgreSQL | External service, not pinned in repo |
| Object storage | ![MinIO](https://img.shields.io/badge/MinIO-C72E49?style=flat&logo=minio&logoColor=white) MinIO / S3-compatible storage, AWS SDK S3 client | External service, `@aws-sdk/client-s3` 3.1041.0 |
| Frontend | ![React](https://img.shields.io/badge/React-20232A?style=flat&logo=react&logoColor=61DAFB) ![Vite](https://img.shields.io/badge/Vite-646CFF?style=flat&logo=vite&logoColor=white) ![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat&logo=typescript&logoColor=white) React, React DOM, Vite, TypeScript | 19.2.5, 19.2.5, 8.0.10, 6.0.3 |
| Styling | ![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-38B2AC?style=flat&logo=tailwind-css&logoColor=white) Tailwind CSS, `@tailwindcss/postcss`, PostCSS, Autoprefixer | 4.2.4, 4.2.4, 8.5.14, 10.5.0 |
| UI | ![Radix UI](https://img.shields.io/badge/Radix_UI-161618?style=flat&logo=radix-ui&logoColor=white) ![Recharts](https://img.shields.io/badge/Recharts-FF6384?style=flat) shadcn-style local components, Radix UI, lucide-react, Recharts | local, Radix 1.1.x/2.1.x, 1.14.0, 3.8.1 |
| Integrations | ![Google](https://img.shields.io/badge/Google_Auth-4285F4?style=flat&logo=google&logoColor=white) ![LINE](https://img.shields.io/badge/LINE-00C300?style=flat&logo=line&logoColor=white) Google Auth, React Google OAuth, LINE Messaging API, Tesseract OCR | 10.6.2, 0.13.5, 11.0.0, 7.0.0 |

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
