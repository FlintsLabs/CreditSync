# CreditSync Agent Notes

## Runtime Preference (Bun First)

This project is optimized for **Bun**. Agents should prefer using Bun for all development and operational tasks:

- Use `bun run src/index.ts` for the backend.
- Use `bun install` for dependency management in both `backend/` and `frontend/`.
- Use `bun test` for running the test suite.
- Use `bun x` (equivalent to `npx`) for one-off CLI tools.

## Tmux Delegation and Model Routing

- The current task agent owns discovery, clarification, design, specification, and the detailed implementation plan using the model selected by the user for the current task.
- If the user explicitly requests tmux, delegate implementation through tmux whenever Codex CLI and tmux are available. Without an explicit request, use tmux automatically only for substantial implementation work such as multi-subsystem or multi-file changes, migrations, long verification suites, repeated implementation/review cycles, or work that should survive client disconnection. Keep short read-only checks, explanations, reviews, status requests, and narrow edits in the current task.
- Before delegation, obtain approval for the spec and detailed implementation plan. Start the worker from an appropriate isolated worktree and pass the repository/worktree path, branch and integration target, spec/plan paths, acceptance criteria, ordered steps, required verification gates, relevant financial/data-safety rules, dirty-file ownership, and explicit scope exclusions.
- Start implementation workers with Codex CLI model `gpt-5.3-codex-spark` using `--model`/`-m`. If Spark is unavailable, rejected, or exhausted, fall back to the model selected for the current task and report the fallback and reason to the user; do not silently choose an unrelated model.
- Name tmux sessions descriptively as `<project>-<short-task-name>`. Reuse a session only when its repository, worktree, branch, and objective match exactly. Report the session name, worktree, branch, active implementation model, fallback state, and whether it is safe for the client to disconnect.
- Delegation does not broaden authority. Production, destructive, external-write, credential, approval-gated, and other sensitive actions retain their existing authorization requirements. Never embed secrets in tmux commands, prompts, logs, specs, or plans.
- Supervise tmux work instead of treating it as fire-and-forget: inspect session output, Git state, commits, tests, and approval prompts; relay blockers with context; diagnose repeated unchanged waits; and forward additive scope updates or interrupt superseded objectives.
- Treat worker completion as untrusted until independently verified. Before reporting success, confirm the expected commits, no unexplained tracked changes, all required gates at the reported HEAD, preserved user changes, and requested target integration. When merge was requested, run `git merge-base --is-ancestor <feature> <target>` and do not say merged unless it succeeds. Distinguish branch completion, integration, push, and deployment in status reports.
- If tmux or Codex CLI is unavailable, report that limitation and continue locally only when consistent with the user's request. If the worker conflicts with unrelated state, stop it and preserve recoverable evidence before repair.

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

- Before creating any commit, update [`CHANGELOG.md`](./CHANGELOG.md) first, then stage and commit the changelog together with the code, documentation, configuration, or assets it describes. Do not create a follow-up changelog-only commit for changes that should have been recorded in the original commit.
- Every changelog entry must live under an explicit project version and date heading formatted as `## vX.Y.Z - YYYY-MM-DD`, with the newest release/date first.
- Within each version/date, group entries by change type using `### Added`, `### Changed`, `### Fixed`, or `### Infra`. Omit empty groups, place each entry in the best matching group, and consolidate closely related changes into one concise bullet instead of scattering duplicates across groups.
- Before committing, verify that the changelog version, date, change type, and summary accurately match the staged change set.
- If a commit adds or materially changes user-facing features, workflows, setup steps, or infrastructure expectations, update [`README.md`](./README.md) in the same commit.

## Product and Financial Domain Rules

- CreditSync is a private THB lending operation. Money crosses public interfaces as two-decimal decimal strings and must be calculated with `decimal.js`; never use JavaScript floating point or `Number` for financial values, comparisons, or formatting.
- Use the `Asia/Bangkok` business timezone. Keep ISO 8601 for timestamps and `YYYY-MM-DD` for due dates.
- Borrowers may be created and updated over time. Search canonical names and confirmed aliases before creating a borrower; aliases can be ambiguous and fuzzy matching is only a candidate-ranking aid, never an automatic financial decision.
- Keep identity-card images and payment slips optional. Do not repeat or log raw identity-card values, raw QR payloads, signed URLs, bearer tokens, or evidence contents.
- Active loan terms and posted financial records are immutable. Fix a financial record through an append-only compensating reversal/adjustment with a reason; do not edit or delete it.
- Every financial write needs command context, a request/correlation ID, actor/source, idempotency key where the operation supports it, and append-only audit history with useful before/after state.

## Lending Workflows

- A new loan follows `preview -> draft -> activate`. Activation locks loan terms and creates any applicable immutable schedule.
- For scheduled daily loans, support an agreed fixed daily installment or an explicit flat daily-interest term (amount, percent, or per-thousand), with day/month duration. The backend owns calculations and rounding; UI/agents must not recreate the accounting calculation.
- A floating loan has no fixed schedule/term. Treat daily interest policy and first-day deduction as explicit policy data, not inferred behavior.
- Regular scheduled installments are the agreed amount. Do not silently treat overpayment as normal allocation; use an explicit settlement/close-out workflow when needed.
- Renewal/rollover must use `preview -> explicit human confirmation -> execute`. Paid principal determines any customer cash-out; outstanding charges must be settled or waived with a reason. Reversal is compensating and only permitted when downstream records allow it.

## Actual Loan Disbursements

- Approved principal/schedule/funding allocation and actual borrower payouts are separate concepts. The append-only `loan_disbursement_events` ledger is the source of truth for actual payout history.
- A disbursement has `grossAmount` (cash/transfer actually sent) and `loanAttributedAmount` (the portion assigned to this loan). They may differ for grouped transfers, cash top-ups, or under/over disbursement. The difference is a warning only: never mutate principal, interest, schedules, or funding allocation to make it disappear.
- Lifecycle: create editable `draft`; optionally prepare/upload/finalize evidence; `post` with idempotency key; reverse with an explicit reason and idempotency key. Posted and reversed records must be immutable at the database boundary.
- Evidence is optional but, when used, must follow `prepare -> direct signed PUT to MinIO -> finalize` before posting. Finalization checks tenant ownership, MIME/size, SHA-256, expiry, and storage metadata. Never attach a raw file ID directly to a draft.
- Show both gross transferred and attributed amount, and visibly mark grouped transfers, in the Web UI. Use exact decimal-string formatters even for values beyond JavaScript safe integers.
- A source profile is independent from a bank drawdown: direct own capital can fund a loan without a drawdown. Actual payout may have multiple entries and can be below/above approved principal; retain source/payee/note/evidence and audit history.

## MCP and Plugin Safety

- Remote MCP lives in the same backend process and calls application services directly; MCP must never call the product REST API internally.
- MCP accepts/returns public UUIDs and two-decimal money strings only. Keep tool schemas closed, return structured content plus readable summaries, and expose only safe public fields.
- Mark reads with `readOnlyHint`; mark financial post, activation, renewal, and reversal as destructive. Every write returns audit public ID and correlation ID.
- Agent orchestration must inspect before writing. It may post only a clearly valid `ready` payment/disbursement result; ambiguity, duplicate, stale state, mismatch, missing confirmation, or idempotency conflict must stop for human review.
- Disbursement agent workflow is: create draft, optionally prepare evidence, PUT only when a current signed URL is present, finalize, inspect/list the draft, show variance, obtain explicit confirmation, then post. On evidence `ready` retry, do not upload/finalize again. Before reversal, re-list and select the exact posted event, ask for reason/confirmation, then reverse.
- Keep the frozen MCP contract, plugin manifest/version, skills, eval scenarios, and validator synchronized whenever tools change. The current private CreditSync plugin is `2.1.0` and has six skills.

## Verification and Deployment

- Use `backend/scripts/test-disposable-postgres.sh` for database-backed backend suites. It intentionally serializes tests because they share a destructively reset disposable PostgreSQL database; do not make test files concurrently mutate that database.
- Before completing a financial feature, run backend disposable tests and typecheck, frontend test/lint/build, and plugin tests/validator as applicable. Treat a skipped DB test as insufficient for a newly changed financial invariant.
- Production backend is internal to Docker and may not publish port 3000 to the host. Check MCP health with `docker compose ... exec backend` against `http://127.0.0.1:3000/mcp/health`; check the public frontend at `http://127.0.0.1:8088/`.
- After a production migration, verify the expected tables/columns through the production PostgreSQL container, inspect backend logs for successful migrations, and avoid creating test financial records in a live tenant unless an explicitly authorized controlled test tenant exists.
