# CreditSync

## Borrower identity privacy

Borrower list cards mask Thai national IDs by default. The card's copy action intentionally copies the complete stored value for authorized owner workflows; use the borrower detail or edit flow when the full value must be viewed or updated. The list adapts its card columns to the available content width, so a narrow main panel keeps one full-width card rather than a cramped half-width column. Borrower detail headers use a compact profile avatar on small screens and expand modestly on larger layouts.

CreditSync is a mobile-first loan management system for lenders who need to track funding sources, borrower profiles, loan contracts, repayments, and closing balances in one place.

The stack is built around Bun + Elysia on the backend, React + Vite on the frontend, PostgreSQL for relational data, MinIO for file storage, and Dragonfly for Redis-compatible caching.

## What This Repo Does

CreditSync is designed for workflows like:

- Creating borrower profiles and storing their history
- Uploading ID card images and extracting text with OCR
- Creating loan agreements with single-payment, daily, weekly, monthly, or floating interest logic
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
- Single-payment settlement/restructure preview, explicit confirmation, component waivers, replacement contracts, and compensating reversal workflow
- Owner/manager scheduled-loan replacement preview, confirmed execution, public lineage, and compensating reversal workflow
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

Account identity and tenant role are read-only values supplied by the authorized Google and tenant account. The protected `/settings` page provides immediate Thai/English language and Light/Dark/System appearance preferences for the current device; these preferences are not synchronized through the backend. Signing out removes the local CreditSync session while retaining display preferences.

### 2. Borrower Management

- create and edit borrower profiles
- search canonical names and confirmed aliases without auto-selecting ambiguous matches
- manage borrower aliases and view borrower portfolio summaries
- confirm or deactivate aliases and review borrower/alias audit revisions with request and correlation identifiers
- store phone, address, tags, notes, and map links
- attach ID card image
- OCR text extraction to help fill borrower data

### 3. Loan Management

- filter the Loan List between Active, Done, and All agreements while retaining search, status, funding, and sort controls
- calculate repayment schedules before saving
- support `single_payment`, `daily`, `weekly`, `monthly`, and `floating` repayment types
- preview and persist exact single-payment due dates, agreed fixed-interest floors, optional greater-of retroactive interest, and contracted late penalties before activation creates one immutable maturity row
- preserve legacy floating contracts as daily-accrual while allowing new floating terms to state an explicit `daily` or `weekly` accrual cycle; weekly preview exposes `fullPeriodInterest`, `firstPeriodStartDate`, `advanceInterestAmount`, `netDisbursement`, the inclusive `coveredStartDate`/`coveredEndDate`, the excluded `firstPeriodDueDate` and matching `nextAccrualDate`, plus `advanceInterestRefundPolicy: "non_refundable"`; for a 10 August anchor the covered dates are 10–16 August and the due/next-period boundary is 17 August
- accrue a weekly rate proportionally into immutable daily snapshots, make it normally payable only at the seven-day boundary anchored to `interestStartDate`, and charge it as one paid, non-refundable first period when `deduct` is selected; overdue floating penalties use an append-only dated due-group ledger, exact penalty/interest transaction allocations, compensating adjustments and reasoned reversals, and pure as-of closing/health projections that never rewrite financial history; migration creates an exact Bangkok cutover for every legacy floating loan, while backdated payments stop for reconciliation if they would overlap later immutable allocations
- manage effective-dated floating-interest periods from Loan Detail, including exact current daily interest, future scheduled changes, previewed automatic range splitting, and audited confirmation
- create editable loan drafts, then activate them to lock terms and generate schedules exactly once
- use separate preview, draft-save, and activation confirmations in the web wizard
- distinguish due-now and overdue scheduled or floating daily-interest obligations directly on the loan-agreement list before opening details
- show up to three borrower labels under each loan card name, using confirmed aliases first and borrower tags after, with a localized `+N` overflow when more labels exist
- search loan lists by borrower name, loan ID, aliases, and tags, including hidden overflow labels
- show the current loan agent (or localized unassigned state) on Loan List cards and include confirmed agent aliases in search
- scan exact Loan List financial summaries: non-paid cards keep outstanding and original principal together with backend-owned interest-received and paid-to-date totals, while paid cards show a checked completion state with original principal and interest received
- preview installment breakdown
- calculate floating closing obligations from current outstanding principal, unpaid due and accruing interest, outstanding fees, and applicable penalties while reporting payment history separately
- record actual borrower cash, bank-transfer, or adjustment disbursements independently of approved loan terms

Single-payment contracts keep principal, agreed interest, fees, and late penalties as separate exact components. A contract can use the agreed fixed interest only, or the greater of that fixed amount and retroactive interest calculated from actual posted-disbursement exposure; those two interest candidates are alternatives and are never added together. When contracted, the daily late penalty accrues concurrently after the due date and grace period. The localized wizard shows the authoritative one-row maturity preview before a draft is saved and activated.

Loan Detail can settle and restructure an eligible contract into a new `single_payment`, `daily`, `weekly`, `monthly`, or `floating` contract. The backend preview shows gross, waived, externally paid, and carried balances independently. Waiving interest, fees, or penalties requires a component-specific reason and preserves the forgiven amount in the append-only ledger; an external payment is different because it is allocated as real settlement value in `penalty -> fee -> interest -> principal` order. Outstanding principal plus optional newly approved principal becomes the replacement principal—carried interest, fees, and penalties are opening components and are not capitalized. Additional approved principal is not itself proof of cash sent: execution creates a linked disbursement draft whose normal evidence/post lifecycle remains authoritative for the payout.

Loan Detail keeps the existing agreement route and back navigation while separating Information, Agents, Payment History, and Repayment Schedule into accessible, localized tabs. Agent agreements are effective-dated in the Asia/Bangkok business timezone and confirmation-gated; posted payment sources remain `Unattributed` until explicitly assigned as direct or split among agents, and displayed total and per-schedule commissions come from backend-authoritative previews rather than client-side accounting.

Restructure is `preview -> review exact totals and cash direction -> explicit confirmation -> execute`. Preview expiry, a stale balance version/hash, an idempotency conflict, an unallocated external credit, or unexpected cash stops execution. A safely repeated request with the same key and payload returns the original result. Reversal writes compensating history and is blocked after downstream payments, posted payout events, later waivers/restructures/renewals, or other dependent records make reversal unsafe. Later eligible carried interest/fee/penalty can be waived through its own preview/confirmed execute/reverse workflow; principal cannot be waived.

Scheduled-loan replacement is available only to tenant owners and managers. It is `preview -> review exact backend balances, corrections, dates, named funding source, structured warnings, and no-cash amount -> explicit confirmation -> execute`; the client does not recalculate financial values. The Web renders Bangkok business dates and preview expiry as Gregorian `DD/MM/YYYY` in English and Thai and preserves the warning's exact amount and correction semantics. Preview expiry, stale balance/draft versions, or a nested backend `reviewRequired` blocker removes execution authority, displays any safe blocker public IDs, and requires a new preview. After execution, the original agreement is terminal `replaced` (shown in Done and All as **Closed — Replaced**, never Paid); durable query invalidation refreshes the Loan List plus both public loan details even across route navigation, and Loan Detail provides public source/replacement links. Reversal is a separate compensating command requiring its own non-blank reason, checkbox confirmation, and idempotency key; it remains subject to downstream safety checks. Once a safe reversal restores the old loan, its retained reversed lineage does not prevent a later fresh replacement preview.

The authenticated REST surface is mounted below `/api/loans`: list/inspect and preview use `/:loanId/restructures`, execution/reversal use `/restructures/:restructureId`, component waivers use `/:loanId/waivers` and `/waivers/:waiverId`, and durable early settlement uses `/:loanId/early-settlement/preview` followed by `/early-settlement/:previewId/execute`. Every financial execute/reverse request carries a non-blank reason and `Idempotency-Key`; execute also carries the exact confirmation/hash/version fields returned by preview. The Web workflow calls these adapters but renders only backend-calculated money and schedules.

### 4. Transaction Management

Daily-loan renewals use the authenticated `/loan-renewals` API:

- `POST /loan-renewals/preview` accepts `oldLoanPublicId`, `requestedPrincipal`, optional `waivedCharges`, and a required `waiverReason` when any charge is waived.
- `POST /loan-renewals/:id/execute` requires the persisted `previewHash`, `confirmed: true`, a non-blank `reason`, and an `Idempotency-Key` header.
- `POST /loan-renewals/:id/reverse` requires a non-blank `reason` and `Idempotency-Key` header. The web client retains each execution or reversal key while the same intent is retried and replaces it only when the preview or operator reason changes.

Renewal previews derive principal from posted, non-reversed transaction components. Execution locks and recomputes balances, due-day charges, penalties, and funding at execution time; previews become stale when any hashed state changes. Funding mutations and renewals serialize on the borrower loan before reading allocation state, and funding carry uses deterministic integer-cent largest-remainder allocation with tenant-safe renewal/group provenance. The outstanding-principal transfer is non-cash; only the net payout or collection is recorded as borrower cash. Reversal keys are operation-scoped, exact pre-execution loan state is restored, and reversal is blocked only by net active downstream transactions, adjustments, or funding before append-only compensations are written. Invalid `RENEWAL_PREVIEW_TTL_SECONDS` values fall back to 900 seconds.

- record repayments manually through payment intakes
- capture repayments from a loan detail with borrower-first contract filtering, then review allocation in Payment Inbox before posting
- upload repayment slips
- link payment to a loan
- show repayment history
- create data-only payment intakes or prepare signed S3/MinIO evidence PUTs
- detect tenant-scoped operation, bank-reference, QR-payload, and evidence-hash duplicates without treating semantic similarity as a duplicate
- preview deterministic matches, review ambiguous matches, and split one intake across borrowers, loans, and schedules
- post schedule, loan, and fund effects atomically, then correct posted payments with append-only compensating reversals
- stop floating-payment allocation when legacy daily-interest rows have an invalid zero-principal basis, and repair those rows through an idempotent append-only correction with adjustment and audit history

The authenticated payment API is rooted at `/payment-intakes`. It exposes create/list/get and review-queue operations, `/:id/evidence/upload-intents`, `/:id/evidence/:evidenceId/finalize`, `/:id/match-preview`, `/:id/post`, `/:id/review`, and `/:id/reverse`. REST reversal requires a non-blank operator `reason`, which is preserved in the audit event. To preserve the frozen MCP schema-version 1.0 contract, `payment.reverse` continues to accept the legacy `{ paymentIntakePublicId }` input and uses a stable compatibility audit reason when the optional `reason` is absent; new MCP callers should provide it. All command IDs are UUIDs and all public money values are two-decimal strings. `GET /transactions` remains available for legacy repayment history, but `POST /transactions` returns `405 LEGACY_REPAYMENT_WRITE_DISABLED`; all repayment writes must use `/payment-intakes` so one Decimal allocator and one PostgreSQL lock order govern balances.

Loan detail repayment history is available from `GET /loans/:loanPublicId/payment-intakes`. A quick capture records an optional `originLoanPublicId` on the intake, then opens Payment Inbox for allocation preview and posting; it never posts a repayment directly. Older payment records remain discoverable through their existing transaction or latest allocation links.

Payment Inbox presents incoming payments as a responsive flat list and loads 25 newest-first records per page. Operators can search payer names and filter by status or an inclusive Asia/Bangkok received-date range; changing a filter returns to the first page while refresh and payment actions retain the active view.

The authenticated loan-disbursement API is rooted at `/loans/:loanPublicId/disbursements`. It provides list, draft create/update, `/:disbursementId/evidence/upload-intents`, `/:disbursementId/evidence/:evidenceId/finalize`, `/:disbursementId/post`, and `/:disbursementId/reverse` operations. Gross transfer and loan-attributed amounts are exact two-decimal strings; grouped transfers require a note. Draft commands deliberately reject `evidenceFilePublicIds`: create the draft first, then prepare a signed evidence upload and finalize that evidence against the draft. Post and reverse require an `Idempotency-Key`, and reversal also requires a non-blank reason. Restructure-created additional-principal payouts expose an immutable nullable `restructurePublicId`; note edits never change that linkage, and the relation is preserved on posting and compensating reversal. These ledger events do not change approved principal, schedules, or funding allocations.

Intermediary money is tracked as two linked ledgers. `/intermediary-collections` records the amount and time a borrower paid a collector without prematurely posting lender cash, while `/intermediary-remittances` records the gross transfer received from that collector. Operators explicitly select collections, preview an exact zero-balance proposal, optionally attach the remittance slip through `evidence/prepare` followed by direct signed PUT and `evidence/:evidenceId/finalize`, then post with confirmation and an idempotency key. Historical collections may reference an already-posted payment intake; CreditSync validates loan, timestamp, and exact amount and does not create a second repayment. The `/intermediaries` workspace provides canonical-name or confirmed-alias search, search-before-create review of both active and inactive exact candidates, exact managed-loan summaries linked to Loan Detail, assignment history, masked payment destinations, and unreconciled disbursement warnings. `GET /intermediaries/:id/held-balance` exposes the authenticated tenant-scoped exact funding, payout, advance-interest-return, disbursement-held, collection-held, and total-held projection used by that profile. Collection and remittance ledgers remain available at `/intermediaries/remittances`, including profile-scoped filtering.

Intermediary-routed loan payouts are a separate append-only ledger. After exact borrower/intermediary resolution and an active effective-dated disbursement assignment, CreditSync derives the contractual funding, borrower net payout, and advance-interest return targets from the immutable loan activation. Operators record each actual transfer and bind every supplied slip's evidence/file UUID plus immutable MIME, size, and SHA-256 across prepare, ready retry, finalize, and inspection. They may post only after inspected roles, references, amounts, payees, and evidence identities match, followed by a fresh explicitly confirmed proposal with ready evidence, no warnings, retained balance `0.00`, and variance `0.00`. Loan Detail and intermediary profiles show the three money-path roles, exact split transfers, safe transfer metadata, and one independently resolved `View slip` action per finalized evidence item; the confirmation remains disabled for expired or non-zero-variance proposals and any supplied evidence that is not ready. Confirmation and its idempotency key are bound to the exact proposal ID/hash; a stale or already-expired proposal is refreshed for review and must be explicitly confirmed again. After posting, the Web UI reloads authoritative group detail, actual loan disbursements, and intermediary held balance; a failed refresh is shown as a blocking warning so stale financial presentation is not treated as current. General MCP group/list inspection returns normalized reference displays and safe per-event evidence status/count/public IDs/MIME types; evidence viewing uses short-lived REST/Web UI access descriptors requested only when selected and discarded when the preview closes or unmounts, while MCP inspection excludes retrieval URLs, storage keys, and checksums.

The web app exposes `/payments` as the human review inbox. It persists and shows semantic-duplicate warnings, requires an explicit warning acknowledgment, accepts optional signed evidence, edits any number of exact allocations across borrowers/loans/schedules, retains the previous proposal for a meaningful difference view, and requires a ready preview of the exact current editor revision before posting. Allocation edits are locked while previewing; every edit/add/remove/selection change invalidates the ready proposal, and stale responses are discarded. Reversal uses a separate reason-confirmation step. The manual repayment shortcut creates the intake and opens it in this review screen with the selected loan/schedule suggested; it never auto-posts or calls the disabled legacy write endpoint.

### 5. Funding and Traceability

- define funding sources / bank profiles
- model upstream bank borrowing and downstream borrower lending separately
- prepare data structure for ROI and traceability analysis
- show each source's net borrower-loan allocations, including direct own-capital allocations and allocations routed through bank drawdowns

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
├── plugins/creditsync/   # Private Codex plugin 7.0.0, skills, evals, and validation
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

For the production loan-schema reconciliation procedure, including the exact 16-column/9-constraint/1-index drift gate, backup/restore rehearsal, reviewed-artifact deployment, full catalog/fingerprint verification, rollback rules, and the inspect-first daily-loan/disbursement workflow, use [the production reconciliation runbook](./docs/operations/production-loan-schema-reconciliation.md). It is an operator procedure: do not run its production mutation steps without the required approvals and stop conditions.

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

In the authenticated layout, desktop users can collapse the sidebar to a 72px compact rail and expand it again. The sidebar header stays focused on the app mark and collapse control, while the account menu lives in the footer; theme and language preferences remain available on `/settings`. Icon navigation keeps localized tooltips and accessible names, and the preference is remembered in browser-local storage.

The tenant-admin dashboard is a Daily Command Center: it leads with exact cash due today, ranks only actionable exceptions by operational urgency, and shows compact borrower/fund repayment queues. Funding, reconciliation, and profitability remain available as secondary details. Each API-backed section loads and retries independently so one unavailable signal does not hide the rest of the operational picture.

Floating daily-interest arrears appear in the Dashboard as one borrower row per loan. The row aggregates exact interest payable, reports the number of overdue daily accruals and their maximum age, and opens repayment capture without inventing a fixed schedule.

Loan agreement creation is draft-first. `POST /api/loans` accepts a borrower and either an optional drawdown UUID (`bankLoanPublicId`) or an active own-capital profile UUID (`bankProfilePublicId`), never both, and returns a draft without schedules. Draft terms can be changed with `PUT /api/loans/:id`; `POST /api/loans/:id/activate` locks the terms, checks the selected source's signed remaining capacity, then creates schedules and exactly one initial funding allocation. Activation requires a stable idempotency key; an identical same-key retry returns the original result while a conflicting reuse stops. The web wizard groups own capital, bank drawdowns, and unallocated loans; an existing personal source can be explicitly converted to an own-capital pool at its detail page, with a default non-cash 2.00% annual opportunity-cost rate.

Funding-source detail pages expose `GET /api/bank-profiles/:id/funding-usage`. The page shows current net borrower-loan allocations for the source and can include settled loans for historical review. Own-capital pools use their credit limit less net allocations as available capital; they allocate directly to borrower loans and intentionally do not create bank-drawdown records. External-liability sources retain drawdown-based available credit while showing the borrower loans funded through their drawdowns.

Floating loans use an explicit one-day or one-week interest policy with a percentage or per-thousand rate and zero or one advance-interest period. The non-refundable advance treatment is explicit policy data. Daily accrual snapshots use Bangkok calendar dates and cumulative Decimal rounding, including daily projections within a weekly period; payments apply due accrued interest before principal, and an advance deduction is retained as immutable paid history.

Floating-loan close-out is previewed for an exact Bangkok as-of date. The preview separately shows outstanding principal, due interest, accrued-not-due interest, fees, penalties, already-paid non-refundable advance interest, and the new settlement total. Execution requires the exact current preview hash, explicit confirmation, reason, and stable idempotency key. A changed balance or later accrual makes the preview stale and requires a fresh preview and confirmation; settlement never refunds the already-paid advance amount or edits prior financial records.

In the Web loan wizard, choose **Floating**, then select a daily or weekly interest period, a percentage or per-thousand rate, and whether to deduct one non-refundable period in advance. The review step displays the backend-produced full-period interest, advance deduction, net borrower payout, and first-period dates before the operator saves the draft and explicitly activates it. Loan Detail repeats those backend-owned contract values and compares the contract net payout with the effective posted gross disbursement; a difference is shown as an informational warning only and never changes principal, interest, schedules, or payout history. Draft and reversed disbursements do not trigger that warning. Loan Detail also labels due interest separately from still-accruing interest and provides the settlement workflow: choose the Bangkok settlement date, preview every exact component, enter a reason, check the confirmation for that preview, and execute. If balances make the preview stale, the page automatically loads a fresh preview and clears confirmation so the operator must review and confirm the new amounts.

For a scheduled daily loan, the wizard can start from either the borrower’s proposed daily payment or a flat daily-interest term (% per day, baht per day, or baht per ฿1,000). Choose a duration in days or 30-day months; CreditSync derives the other value, displays flat daily/monthly/annual reference rates, and creates an exact schedule whose final row absorbs rounding differences.

Loan detail shows these fixed daily terms separately from the repayment schedule. It also identifies a direct own-capital allocation as a capital-pool allocation rather than an unmatched bank drawdown. The Disbursements card records actual borrower payouts independently from the approved principal and schedule: save an editable draft, optionally use the signed evidence-upload/finalize flow, then post it. Posted rows are immutable; corrections use a reasoned compensating reversal and a new draft. A grouped transfer must record the gross transfer and the amount attributed to this loan, with an explanation when they differ.

Active or paid daily-loan detail pages include the renewal control. The operator sees recovered principal, old outstanding principal, separate due interest/fee/penalty components, aggregate charges, waivers, settlement, net payout or collection, and the full replacement schedule before checking an explicit confirmation. Execution and reversal use separate stable retry keys and show explicit empty, unavailable, failed, or populated audit states with localized action labels.

Loan-facing REST payloads use public UUIDs for loans, schedules, funding profiles, drawdowns, and allocations. Public money inputs and outputs use two-decimal strings (for example, `"500.00"`). This includes schedule and closing reads, allocation/profitability summaries, and funding allocation/reallocation mutations. Generated schedules conserve the exact principal-plus-interest obligation: each row's principal, interest, and fee components equal its scheduled total and remaining due, with any cent residual carried by the final installment. Schedule money remains Decimal-safe internally and does not pass through JavaScript `number`, including for values above the safe-integer range.

For an own-capital pool, the profile profitability response also reports `opportunityCostAccrued` and `economicSpread`. Opportunity cost is calculated from each positive allocation date through the current Bangkok calendar date at the profile's annual rate; it is analytical only and never creates a borrower charge, cash movement, or financial transaction.

## Private Remote MCP

CreditSync serves a private stateless Streamable HTTP MCP endpoint at `/mcp` in the existing backend process. Each HTTP request gets a fresh MCP server and Web Standard transport; there are no server sessions or legacy SSE endpoints. The adapter invokes the same borrower, payment, loan, and renewal application services as the web API directly—it does not call CreditSync REST routes internally. The unauthenticated `GET /mcp/health` response contains only service status and schema version.

All MCP requests are bound to the server-side `MCP_TENANT_ID` and `MCP_ACTOR_EMAIL`. A client cannot submit or override tenant or actor identity. The configured actor must already exist in that tenant, and its normal CreditSync role/portfolio permissions still apply. Funding sources are list-only; the MCP surface has no generic SQL, arbitrary fetch, or funding mutation tool.

The backend schema-version `1.0` exposes 75 frozen tools, including:

```text
borrower.search       borrower.portfolio    borrower.create
borrower.update       borrower.alias        intake.get
intake.list           intake.create         evidence.prepare
evidence.finalize     payment.preview       payment.post
payment.reverse       loan.preview          loan.draft
loan.activate         loan.interest-rate.list
loan.interest-rate.preview  loan.interest-rate.execute
loan.settlement.preview     loan.settlement.execute
loan.disbursement.list       loan.disbursement.draft
loan.disbursement.update
loan.disbursement.evidence.prepare  loan.disbursement.evidence.finalize
loan.disbursement.post       loan.disbursement.reverse
loan.commission-participant.list  loan.commission-participant.add
loan.commission-participant.update  loan.commission-participant.end
loan.commission.preview      loan.commission.list
loan.commission.calculate    loan.commission.reverse
payment.intermediary-attribution.create
payment.intermediary-attribution.list
payment.intermediary-attribution.reverse
intermediary.search          intermediary.create
intermediary.profile.get     intermediary.bank-account.save
intermediary.managed-loan.list
intermediary.assignment.create  intermediary.assignment.end
intermediary.disbursement.list  intermediary.disbursement.get
intermediary.disbursement.create
intermediary.disbursement.event.create
intermediary.disbursement.evidence.prepare
intermediary.disbursement.evidence.finalize
intermediary.disbursement.preview
intermediary.disbursement.post  intermediary.disbursement.reverse
intermediary.collection.list  intermediary.collection.create
intermediary.remittance.get   intermediary.remittance.create
intermediary.remittance.allocations.save
intermediary.remittance.preview
intermediary.remittance.evidence.prepare
intermediary.remittance.evidence.finalize
intermediary.remittance.post
renewal.preview       renewal.execute
renewal.reverse       funding-source.list
```

Tool inputs use public UUIDs and two-decimal money strings. Results include concise text plus structured content with `schemaVersion: "1.0"`. Loan commission participants are effective-dated immutable versions; updates append a successor, while payment-source attribution corrections append reasoned compensating entries. Commission outputs are derived by backend services from posted interest components and never by MCP arithmetic; `loan.commission.reverse` is a read-only preview for posted reversal payments and never returns write audit metadata. Actual commission-participant and payment-attribution writes require explicit confirmation and stable idempotency keys and return safe audit/correlation identifiers. Disbursement drafts support strict non-empty PATCH updates to editable metadata; each update retains finalized evidence and requires a re-list plus fresh confirmation before posting. Payment posting/reversal, idempotent loan activation, floating-interest execution and settlement/reversal, renewal execution/reversal, direct and intermediary-routed disbursement post/reverse, intermediary remittance posting, single-payment restructuring, and component waivers follow explicit confirmation and audit boundaries. Settlement and intermediated-disbursement previews persist short-lived versioned command artifacts; execution accepts only the exact current preview. Intermediary bank-account save, assignment create/end, and transfer-evidence prepare/finalize MCP results also return their audit public UUID and correlation UUID while their existing REST DTOs remain unchanged. Tool failures use the stable shape `{code,message,retryable,reviewRequired,details}` without internal stack traces. The bundled Plugin `7.0.0` freezes the matching 75-tool backend contract.

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

The repository includes CreditSync Plugin `7.0.0` under [`plugins/creditsync`](./plugins/creditsync). It combines 11 orchestration skills with a private app reference to the HTTPS MCP endpoint; it does not bundle a local MCP process, URL, bearer token, OAuth, hooks, or plugin UI.

Before installation, register the deployed MCP endpoint as a private Codex app and replace the conspicuous `plugin_asdk_app_REPLACE_AFTER_PRIVATE_REGISTRATION` value in `plugins/creditsync/.app.json` with the returned `plugin_asdk_app...` technical ID. Then validate the package, add this Git repository as the marketplace that tracks `main`, and install the plugin:

```bash
bun test plugins/creditsync/tests/plugin-contract.test.ts
bun run plugins/creditsync/scripts/validate.ts
python3 /home/flintstone/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py plugins/creditsync
codex plugin marketplace add FlintsLabs/CreditSync --ref main
codex plugin add creditsync@creditsync-marketplace
```

The Git marketplace snapshot reads [`.agents/plugins/marketplace.json`](./.agents/plugins/marketplace.json), which resolves the plugin at `./plugins/creditsync` inside the same snapshot. After pushing a validated plugin change to `main`, refresh the snapshot and reinstall:

```bash
codex plugin marketplace upgrade creditsync-marketplace
codex plugin add creditsync@creditsync-marketplace
```

A push does not hot-reload the installed copy. Start a new Codex task after installation or reinstall so the updated skills and app are discovered. The committed app ID is intentionally a non-runnable registration placeholder, so static validation is not evidence of a live private-app connection.

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

Frontend verification uses both its Bun-native discovery gate and the configured Vitest suite:

```bash
cd frontend
bun test
bun run test
bun run lint
bun run build
```

`frontend/bunfig.toml` preloads the local Happy DOM and Testing Library matcher setup for Bun-native DOM tests; Vitest continues to use its separate jsdom configuration for the full frontend suite.

Database-backed service tests are opt-in and require `TEST_DATABASE_URL` to point to a disposable database. To create an isolated ephemeral PostgreSQL 18 container with a dynamically assigned host port, migrate it, run a focused test, and remove it automatically:

```bash
./backend/scripts/test-disposable-postgres.sh src/services/loan-disbursement-service.test.ts
```

The script deliberately does not use the local development database. To use a separately provisioned disposable database instead, set both `DATABASE_URL` and `TEST_DATABASE_URL` to that database before running `bun test`.

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
