# CreditSync Agent Notes

## Runtime Preference (Bun First)

This project is optimized for **Bun**. Agents should prefer using Bun for all development and operational tasks:

- Use `bun run src/index.ts` for the backend.
- Use `bun install` for dependency management in both `backend/` and `frontend/`.
- Use `bun test` for running the test suite.
- Use `bun x` (equivalent to `npx`) for one-off CLI tools.

## Docker Compose Layout
- `docker-compose.yml` is the local development infra file.
- `docker-compose.infra.yml` is the production-style infra file for `postgres`, `minio`, and `dragonfly`.
- `docker-compose.app.yml` is the production-style app file for `backend` and `frontend`.

## Environment Files

- Local development uses `backend/.env` and `frontend/.env`.
- Production-style Docker uses the root `.env.production`.
- Frontend Docker builds require `VITE_GOOGLE_CLIENT_ID` from `.env.production`.
- Backend cache uses `CACHE_URL` and optionally `CACHE_TTL_SECONDS`.

## Recommended Commands

- Start production-style infra:
  - `docker compose --env-file .env.production -f docker-compose.infra.yml up -d`
- Build and start production-style app:
  - `docker compose --env-file .env.production -f docker-compose.app.yml up --build -d`
- Rebuild only backend:
  - `docker compose --env-file .env.production -f docker-compose.app.yml up --build -d backend`
- Rebuild only frontend:
  - `docker compose --env-file .env.production -f docker-compose.app.yml up --build -d frontend`

## Networking

- The shared Docker network is `creditsync_runtime`.
- `docker-compose.infra.yml` creates the network.
- `docker-compose.app.yml` joins the existing external network, so infra should be started first.
- `dragonfly` is exposed on the shared network as both `cache` and `dragonfly`.

## Language Consistency

- Frontend text must follow the active system/app language setting.
- Do not mix hardcoded Thai and English strings within the same user flow or screen when a translation key should be used.
- Prefer updating `frontend/src/locales/en.json` and `frontend/src/locales/th.json` together when adding or changing user-facing copy.
- When formatting dates, numbers, or currency in the frontend, prefer using the active i18n language instead of the browser default when practical.

## Commit Discipline

- Every commit must update [`CHANGELOG.md`](./CHANGELOG.md).
- Every changelog entry must include an explicit project version and a short summary of the change set.
- If a commit adds or materially changes user-facing features, workflows, setup steps, or infrastructure expectations, update [`README.md`](./README.md) in the same commit.
- Keep changelog entries concise and grouped by added, changed, fixed, or infra where useful.
