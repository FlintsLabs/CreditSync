# CreditSync Task List

## Review Handoff

Use this section when implementation is delegated to Gemini and final validation comes back here for review.

Owner tags:

- `Gemini implement` = delegate implementation or exploratory patching here first
- `Codex review` = final review, regression check, and integration sign-off here
- `Shared` = either side can push it forward, but final close still comes back for review

- [ ] Review P0 backend integrity. Owner: `Shared`
  - [x] allocation math and capacity validation. Owner: `Gemini implement` -> `Codex review`
  - [x] borrower schedule generation and repayment posting. Owner: `Gemini implement` -> `Codex review`
  - [x] bank repayment posting and outstanding rollup. Owner: `Gemini implement` -> `Codex review`
  - [x] settlement summary and rollover calculations. Owner: `Gemini implement` -> `Codex review`
  - [ ] audit log coverage for financial actions. Owner: `Codex review`
- [ ] Review dashboard operational visibility. Owner: `Shared`
  - [ ] due in / due out / net position summary. Owner: `Codex review`
  - [ ] borrower due queue quick actions. Owner: `Codex review`
  - [ ] fund due queue quick actions. Owner: `Codex review`
  - [ ] funding alerts and matching links. Owner: `Codex review`
  - [x] reconciliation status widgets. Owner: `Gemini implement` -> `Codex review`
- [ ] Review profitability layer. Owner: `Shared`
  - [x] dashboard profitability summary API. Owner: `Gemini implement` -> `Codex review`
  - [x] KPI cards wiring on dashboard. Owner: `Gemini implement` -> `Codex review`
  - [ ] realized vs unrealized spread math. Owner: `Codex review`
  - [ ] ROI and deployed principal interpretation. Owner: `Codex review`
- [ ] Review frontend UX consistency. Owner: `Codex review`
  - [ ] deep-link flows from dashboard queues. Owner: `Codex review`
  - [ ] empty states use real operational language. Owner: `Codex review`
  - [ ] no mock financial data remains on operational screens. Owner: `Codex review`
  - [x] mobile layout still usable after dashboard expansion. Owner: `Gemini implement` -> `Codex review`
- [ ] Review production run flow. Owner: `Codex review`
  - [ ] `npm run build`
  - [ ] `bun run src/index.ts`
  - [ ] `docker compose --env-file .env.production -f docker-compose.app.yml up --build -d`
  - [ ] swagger routes for new dashboard APIs

## Gemini Fix Queue

Use this queue for concrete follow-up patches from the latest review round.

- [x] Fix fund-detail deep-link locking. Owner: `Gemini implement` -> `Codex review`
  - [x] Update [FundDetail.tsx](/home/flintstone/github/CreditSync/frontend/src/pages/dashboard/funds/FundDetail.tsx) so `bankLoanId` and `scheduleId` from the URL auto-select only the initial target.
  - [x] After the initial auto-select, allow the user to click a different drawdown without the effect forcing the view back to the original deep-linked drawdown.
  - [x] Keep deep-link behavior working when opening from `Fund Due Queue`.
  - [x] Acceptance: opening `/dashboard/funds/:id?bankLoanId=...&scheduleId=...` preselects the target once, then manual drawdown switching remains stable.

- [x] Fix reconciliation source-of-truth mismatch. Owner: `Gemini implement` -> `Codex review`
  - [x] Update [dashboard.ts](/home/flintstone/github/CreditSync/backend/src/modules/dashboard.ts) so `unreconciledBankRepayments` is derived from the repayment flow actually used by the UI.
  - [x] Do not report a misleading `0` when `bank_loan_repayments` exist but no `bank_transactions` rows exist.
  - [x] If `bank_transactions` is meant to stay as a future raw-import layer, name the dashboard metric accordingly or separate the counts clearly.
  - [x] Acceptance: dashboard reconciliation widget reflects real fund repayment activity recorded through the current app flow.

- [x] Fix tenant profitability rollover handling. Owner: `Gemini implement` -> `Codex review`
  - [x] Update [fund-settlement.ts](/home/flintstone/github/CreditSync/backend/src/lib/fund-settlement.ts) so tenant-level profitability summary does not ignore rollover/capitalization/support effects when computing `netCashPosition` and `carryForwardAvailable`.
  - [x] Keep fund-level and tenant-level settlement logic consistent enough that the top-level dashboard does not materially contradict fund detail summaries.
  - [x] Acceptance: when rollover entries exist, dashboard profitability values change in the same direction expected from owner support / surplus transfer / capitalization entries.

## Gemini Delivery Notes

- [ ] Gemini provides a short change summary with touched files.
- [ ] Gemini states any assumptions about reconciliation semantics or rollover treatment.
- [ ] Gemini confirms `npm run build` passes after the patch.
- [ ] Gemini confirms `bun run src/index.ts` or docker app startup still works after the patch.

## Gemini Follow-up Review Fixes

- [x] Fix missing schema import in reconciliation route. Owner: `Gemini implement` -> `Codex review`
  - [x] Update [dashboard.ts](/home/flintstone/github/CreditSync/backend/src/modules/dashboard.ts) to import every schema symbol used by `/dashboard/reconciliation-status`.
  - [x] Acceptance: calling `/dashboard/reconciliation-status` no longer risks a runtime `ReferenceError`.

- [x] Fix same-fund deep-link refresh behavior. Owner: `Gemini implement` -> `Codex review`
  - [x] Update [FundDetail.tsx](/home/flintstone/github/CreditSync/frontend/src/pages/dashboard/funds/FundDetail.tsx) so auto-select resets not only when `id` changes, but also when `bankLoanId` or `scheduleId` changes in the query string.
  - [x] Acceptance: navigating from one dashboard fund-queue item to another item under the same fund source preselects the new drawdown/schedule correctly.

- [x] Redefine bank reconciliation widget semantics. Owner: `Gemini implement` -> `Codex review`
  - [x] Update [dashboard.ts](/home/flintstone/github/CreditSync/backend/src/modules/dashboard.ts) so `unreconciledBankRepayments` is not a permanently-near-zero metric under the current UI flow.
  - [x] If needed, rename or split metrics so the dashboard distinguishes:
    - [x] recorded bank repayments in app flow
    - [x] pending raw bank imports
    - [x] true unreconciled bank repayment items
  - [x] Acceptance: the reconciliation widget communicates something operationally true under the current product, not a misleading always-zero count.

## Gemini Next Queue

Use this queue for the next implementation batch that should not overlap with the dashboard fixups and syntax cleanup already handled locally.

- [x] Add drawdown-level profitability API. Owner: `Gemini implement` -> `Codex review`
  - [x] Add a backend endpoint that returns profitability for a single drawdown using existing allocations, borrower transactions, bank repayments, and rollover effects where relevant.
  - [x] Include at least: borrower revenue collected, fund cost paid, realized spread, unrealized spread, deployed principal, outstanding cost, surplus/deficit balance.
  - [x] Reuse existing settlement math where possible instead of duplicating formulas ad hoc.
  - [x] Acceptance: a selected drawdown in the funds area can be backed by a single API response that explains its profit/cost position.

- [x] Add source-level profitability API. Owner: `Gemini implement` -> `Codex review`
  - [x] Add a backend endpoint for bank-profile/source profitability summary aggregated across all drawdowns under that source.
  - [x] Ensure the source-level result stays directionally consistent with tenant-level profitability and fund-detail settlement summary.
  - [x] Acceptance: a funding source can show aggregate spread, deployed principal, net cash, and carry-forward availability without recomputing in the frontend.

- [x] Add borrower-loan profitability API with weighted funding cost. Owner: `Gemini implement` -> `Codex review`
  - [x] Add a backend endpoint that calculates loan-level profitability using `loan_funding_allocations` as the matching source of truth.
  - [x] Support loans funded by multiple drawdowns and compute weighted cost from those allocations.
  - [x] Include at least: borrower revenue collected, allocated principal, estimated funding cost, realized spread, unrealized spread, and funding composition.
  - [x] Acceptance: a loan funded from multiple sources can show an explainable weighted-cost profitability breakdown.

- [x] Add allocation state summary API. Owner: `Gemini implement` -> `Codex review`
  - [x] Add backend-calculated allocation state for both loans and drawdowns:
    - [x] loan state: `unfunded`, `partially_funded`, `fully_funded`, `overfunded`
    - [x] drawdown state: `unallocated`, `partially_allocated`, `fully_allocated`, `overallocated`
  - [x] Return remaining gap / remaining capacity as explicit fields, not frontend-derived-only values.
  - [x] Acceptance: matching workspace and dashboards can consume a normalized allocation-state payload instead of recomputing status in multiple screens.

- [x] Expand audit coverage for financial actions. Owner: `Gemini implement` -> `Codex review`
  - [x] Verify and patch audit log writes for allocation create/reallocate, borrower repayment post, bank repayment post, rollover create, and drawdown update.
  - [x] Add any missing audit events rather than introducing a new audit model.
  - [x] Acceptance: core money-moving actions each emit an audit record with entity type, entity id, actor, action, and useful payload.

- [x] Gemini delivery notes for next queue. Owner: `Gemini implement`
  - [x] List touched files.
  - [x] State assumptions for weighted-cost profitability.
  - [x] Confirm `npm run build` passes if frontend changes are included.
  - [x] Confirm `bun run src/index.ts` still starts after backend changes.

## Project Roadmap

### Phase 1: Foundation & Infrastructure

- [x] Analyze existing repository structure
- [x] Define tech stack: Bun, Elysia, React, Vite, Tailwind, PostgreSQL
- [x] Configure Cloudflare Tunnel baseline
- [x] Configure MinIO for local storage
- [x] Add `tenant_id` to tenant-scoped tables
- [x] Set up Google OAuth
- [ ] Configure Kubernetes manifests for local deployment

### Phase 2: Authentication & RBAC

- [x] Implement roles: owner, manager, collector, viewer
- [x] Add auth and tenant context middleware
- [x] Build frontend login page with Google Sign-In

### Phase 3: Fund Management & Dashboard

- [x] Backend bank profile and bank loan CRUD baseline
- [x] Frontend funds area baseline
- [ ] Build live fund performance dashboard backed by real data

### Phase 4: Borrower Profile & OCR

- [x] Backend borrower CRUD with S3 image upload
- [x] OCR service baseline
- [x] Frontend borrower registration flow with OCR assist

### Phase 5: Loan Engine & Calculation

- [x] Interest calculator for daily, weekly, monthly, floating
- [ ] Loan closing calculator polish and copy flow
- [x] Loan creation wizard

### Phase 6: Transactions & Automation

- [x] Transaction recording baseline with slip upload
- [ ] Slip matching workflow
- [ ] Webhook service for incoming slip images
- [ ] Traceability report from bank funding to borrower loan ROI

### Phase 7: Mobile-First UX Polish

- [x] Tailwind and shadcn-based UI baseline
- [ ] Mobile responsiveness review pass

### Phase 8: Operational Efficiency & Security

- [ ] Audit logs and activity history
- [ ] Notifications: due reminders and payment receipts
- [ ] Document generation: PDF contract and Excel export
- [ ] Smart slip verification queue

### Phase 9: Advanced Analytics & AI

- [ ] Cashflow forecasting
- [ ] AI credit scoring
- [ ] Geolocation tracking for field collectors

## Funds Workstream

## Goal

Turn the `Funds` area into a real operational workflow for managing funding sources, drawdowns from those sources, allocation into borrower loans, and downstream ROI/traceability.

The target user journey is:

1. Create a funding source.
2. Record a real drawdown or bank loan under that source.
3. Allocate that drawdown into borrower loans.
4. Track outstanding balance, repayment obligations, and utilization.
5. Review ROI and traceability from bank funding to downstream lending.

## Current Gaps

- `Funds` currently has basic source creation only.
- `Fund Detail` can create and list drawdowns, but there is no edit flow for fund sources yet.
- There is no flexible many-to-many allocation model between `bank_loans` and borrower `loans`.
- There is no bank repayment recording workflow in the UI.
- There is no borrower-side repayment schedule model that can drive expected inflow, overdue borrower queues, and true spread timing.
- Dashboard funding summary is intentionally simplified because mock data was removed.
- Performance chart and funding analytics are not backed by real data yet.
- Upstream repayment schedule exists, but there is no repayment posting flow against schedule rows yet.
- The current direct `loan -> bankLoanId` link is too rigid for loan-first, fund-first, and split-funding workflows.
- The system does not yet support capital pools whose available matching balance grows from retained profit.
- The system does not yet support explicit surplus / deficit carry-forward and re-funding across bank-backed sources.
- There is no audit trail for high-risk financial actions such as repayment posting, rollover, manual adjustment, and loan closure.
- There is no reconciliation workflow between uploaded slips, borrower transactions, bank repayments, and manual adjustments.
- Most financial statuses are still free-form text instead of tighter enums and lifecycle rules.

## UX Structure

### 1. Fund Source

Represents the source of capital:

- bank credit line
- personal capital
- investor capital

Should answer:

- Where does this money come from?
- What is the total limit?
- How much has already been used?
- Is it active, standby, or exhausted?

### 2. Drawdown / Bank Loan

Represents a real funding event from a source:

- amount borrowed
- start date
- interest rate
- term
- repayment type
- outstanding balance

Should answer:

- What obligation do we owe upstream?
- How much is still unpaid?
- What repayment schedule applies?

### 3. Allocation / Traceability

Represents how a drawdown is distributed into borrower loans.

Should answer:

- This bank drawdown funded which borrower loans?
- How much principal was allocated where?
- Is the downstream return covering upstream cost?
- Can a loan stay unfunded or partially funded until matching happens later?
- What is the weighted upstream cost when multiple sources fund the same loan?
- If the source is `เงินตัวเอง`, how much balance is available now after retained profit is added back?
- If bank repayments are paid before borrower collections arrive, what cumulative profit or deficit is being carried?

## Primary Screens

### Funds List

Must include:

- total available capital
- total utilized capital
- active sources count
- due soon summary
- filter by type
- filter by status
- CTA: `Add Fund Source`

### Create / Edit Fund Source

Fields:

- source name
- source type
- accounting mode
- provider or bank name
- reference/account label
- credit limit
- default interest hint
- reinvest profit mode
- note
- active status

### Fund Detail

Sections:

- summary card
- active drawdowns
- allocated borrower loans
- funding activity
- quick actions

Quick actions:

- add drawdown
- edit fund source
- archive source

### Add Drawdown

Fields:

- parent fund source
- amount
- start date
- interest rate
- term months
- repayment type
- expected installment
- note

### Drawdown Detail

Sections:

- drawdown summary
- repayment schedule
- linked borrower loans
- outstanding balance
- bank repayment history

### Allocation View

Purpose:

- connect bank drawdowns to borrower loans
- show unallocated balance
- show allocated amounts per borrower loan
- support matching in either creation order
- support partial and split allocations
- support later reallocation with traceability

## Data / Schema Tasks

### Fund Source schema improvements

Review `bank_profiles` and add if needed:

- `provider_name`
- `reference_no`
- `status`
- `note`
- `accounting_mode`
- `reinvest_profit_mode`
- `currency` if multi-currency is possible later

### Drawdown schema improvements

Review `bank_loans` and add if needed:

- `installment_amount`
- `repayment_type`
- `end_date`
- `outstanding_balance`
- `closed_at`
- `note`

### Allocation schema

Add a linking table, e.g.:

- `loan_funding_allocations`

Suggested columns:

- `id`
- `tenant_id`
- `bank_loan_id`
- `loan_id`
- `allocated_amount`
- `allocation_date`
- `allocation_type`
- `note`
- `created_by_user_id`
- `created_at`

### Fund pool accounting schema

Add a ledger table, e.g.:

- `fund_ledger_entries`

Suggested columns:

- `id`
- `tenant_id`
- `bank_profile_id`
- `entry_date`
- `entry_type`
- `amount`
- `loan_id`
- `bank_loan_id`
- `transaction_id`
- `note`
- `created_by_user_id`
- `created_at`

### Borrower schedule and collection schema

Add borrower repayment schedule support, e.g.:

- `loan_schedules`

Suggested columns:

- `id`
- `tenant_id`
- `loan_id`
- `installment_no`
- `due_date`
- `scheduled_principal`
- `scheduled_interest`
- `scheduled_fee`
- `scheduled_total`
- `paid_total`
- `remaining_due`
- `status`
- `created_at`
- `updated_at`

### Settlement and rollover schema

Add explicit settlement and carry-forward support, e.g.:

- `fund_rollover_entries`

Suggested columns:

- `id`
- `tenant_id`
- `from_bank_profile_id`
- `from_bank_loan_id`
- `to_bank_profile_id`
- `to_bank_loan_id`
- `entry_type`
- `amount`
- `effective_date`
- `note`
- `created_by_user_id`
- `created_at`

### Audit and reconciliation schema

Add high-signal operational tracking, e.g.:

- `audit_logs`
- `reconciliation_entries`

Suggested coverage:

- repayment posted
- repayment edited or reversed
- rollover created
- allocation created or adjusted
- loan closed
- writeoff posted
- manual adjustment posted

### Bank repayment data

Review `bank_transactions` and add if needed:

- `slip_file_id`
- `status`
- `matched_by_user_id`
- `reference`

## API Tasks

### Fund Source APIs

- keep current create/list/detail/delete
- add update endpoint
- add archive/deactivate endpoint if soft status is preferred

### Drawdown APIs

- create drawdown under a fund source
- list drawdowns by fund source
- get drawdown detail
- update drawdown
- close drawdown

### Allocation APIs

- create allocation from bank loan to borrower loan
- list allocations by bank loan
- list allocations by borrower loan
- validate that allocated total cannot exceed drawdown amount
- support unmatched loans and unallocated drawdowns queues
- support reallocation or adjustment flows later

### Bank repayment APIs

- create bank repayment transaction
- list repayments by drawdown
- compute outstanding balance after repayments

### Borrower collection APIs

- generate borrower repayment schedule when a loan is created
- list borrower schedule by loan
- record borrower repayment against a schedule row
- compute overdue borrower installments
- compute expected inflow by day / week / month

### Summary APIs

- fund source summary
- drawdown summary
- due soon summary
- utilization summary
- ROI summary
- pool balance summary
- pool ledger summary
- surplus / deficit position summary
- carry-forward summary

### Rollover and settlement APIs

- compute realized spread by fund source
- compute realized spread by drawdown
- compute unrealized spread by fund source
- compute unrealized spread by drawdown
- create rollover entry
- list rollover entries by source
- list rollover entries by drawdown
- support surplus transfer into another source
- support owner-capital deficit support
- support refinance or re-fund from one drawdown into another
- validate that rollover amount cannot exceed carry-forward-available balance unless the action is explicit deficit support

### Audit and reconciliation APIs

- list audit log by entity
- list audit log by actor
- reconcile borrower transaction to uploaded slip
- reconcile bank repayment to uploaded slip
- list unreconciled borrower transactions
- list unreconciled bank repayments
- create manual reconciliation adjustment

## Frontend Tasks

### Phase 1: Real Fund Workflow Foundation

- improve `Funds List` layout with KPI header
- add edit fund source flow
- add drawdown create form
- add drawdown list into `Fund Detail`
- add meaningful empty states for:
  - no funds
  - no drawdowns
  - no allocations
  - no bank repayments

### Phase 2: Traceability

- build allocation UI
- show linked borrower loans in `Fund Detail`
- show unallocated balance per drawdown
- highlight over-allocation and incomplete allocation
- show funding gap per borrower loan
- show weighted upstream cost per borrower loan
- support matching whether the borrower loan or fund drawdown was created first
- support matching from capital pools with live available balance

### Phase 3: Bank Repayment Operations

- add bank repayment entry form
- add repayment history table
- show next due payment
- show overdue repayment state

### Phase 3.5: Audit and Reconciliation

- add repayment audit timeline
- add reconciliation status badges
- show unreconciled transactions queue
- add manual reconciliation review screen

### Phase 4: Analytics

- restore funding chart only when real data exists
- add KPI cards for:
  - total utilized
  - total outstanding
  - expected collection vs bank due
  - ROI by source
- add dashboard summary widgets using real data only
- add realized vs unrealized spread widgets
- add deficit exposure widgets
- add carry-forward surplus widgets
- add rollover and refinance history views
- add source-to-source carry-forward action flow
- add drawdown settlement summary card

## UX Rules

- Never show sample financial data in production-facing screens.
- Prefer empty states over fake charts.
- Every empty state must tell the user the next action to take.
- Financial numbers should use consistent currency formatting.
- Status must always be visible as badges or labels.
- Destructive actions should ask for confirmation.
- Mobile-first layout must stack key actions before analytics.

## Suggested Implementation Order

### Phase 1

- schema changes for drawdown support
- drawdown APIs
- `Fund Detail` real drawdown creation and listing
- fund source edit flow

### Phase 2

- allocation table and allocation APIs
- allocation UI in drawdown detail
- source utilization summary based on real allocations

### Phase 3

- bank repayment transaction flow
- outstanding balance calculations
- due/overdue indicators

### Phase 4

- analytics endpoints
- real charts
- dashboard funding summary

### Phase 5

- borrower collection schedule engine
- surplus / deficit calculation rollups
- rollover entry APIs
- carry-forward and refinance UI
- source-level settlement analytics
- audit and reconciliation baseline

## Immediate Next Tasks

1. Add missing schema fields for `bank_loans` and create migration.
2. Add `bank_loan_allocations` table and migration.
3. Implement drawdown create/list/detail APIs.
4. Build `Add Drawdown` UI from `Fund Detail`.
5. Add edit fund source UI.
6. Replace remaining placeholder copy with real KPI or explicit empty states.
7. Add settlement rollups for realized / unrealized spread and surplus / deficit.
8. Add `fund_rollover_entries` table and rollover APIs.
9. Add rollover / refinance UI from fund and drawdown detail.
10. Add borrower repayment schedules and borrower due queue foundation.
11. Add audit log for financial actions.
12. Add reconciliation workflow for borrower and bank repayments.

## Priority Order

### P0: Must-have core financial integrity

- `loan_funding_allocations` as the real matching layer
- borrower repayment schedules
- bank-source settlement rollups
- `fund_rollover_entries`
- audit log for financial actions

### P1: Must-have operational visibility

- borrower due queue
- fund repayment due queue
- overdue and penalty handling
- reconciliation workflow
- dashboard KPI strip for due in / due out / net position

### P2: Strongly recommended lifecycle controls

- close / archive flows for fund sources and drawdowns
- writeoff and restructure support
- owner support and reserve tracking
- immutable adjustment history
- status enums and tighter lifecycle validation

### P3: Reporting and efficiency

- PDF / Excel export
- notifications and reminders
- profitability charts and carry-forward analytics
- cashflow forecasting
- mobile UX polish for operations

## Implementation Checklist

### Phase 1 Checklist: Fund Source and Drawdown Foundation

- [x] Add missing `bank_profiles` fields:
  - [x] `provider_name`
  - [x] `reference_no`
  - [x] `status`
  - [x] `note`
- [x] Add missing `bank_loans` fields:
  - [x] `repayment_cycle`
  - [x] `repayment_mode`
  - [x] `installment_amount`
  - [x] `total_installments`
  - [x] `outstanding_principal`
  - [x] `outstanding_interest`
  - [x] `outstanding_fees`
  - [x] `next_due_date`
  - [x] `closed_at`
  - [x] `note`
- [x] Create migration for the new fund and drawdown fields.
- [x] Add backend validation for drawdown create payloads.
- [x] Add `PUT /bank-profiles/:id`.
- [x] Add `POST /bank-loans`.
- [x] Add `GET /bank-loans/:id`.
- [x] Add `GET /bank-loans/:id/schedule`.
- [x] Add `PUT /bank-loans/:id`.
- [ ] Add `POST /bank-loans/:id/close` or equivalent close action.
- [ ] Add frontend `Edit Fund Source` flow.
- [x] Add frontend `Add Drawdown` flow from `Fund Detail`.
- [x] Add drawdown list UI in `Fund Detail`.
- [x] Add repayment schedule UI in `Fund Detail`.
- [x] Add empty states:
  - [x] no fund sources
  - [x] no drawdowns on a source
  - [x] no funding activity

### Phase 2 Checklist: Allocation and Traceability

- [x] Create `loan_funding_allocations` table.
- [x] Add migration for `loan_funding_allocations`.
- [x] Add API to create allocation.
- [x] Add API to list allocations by drawdown.
- [x] Add API to list allocations by borrower loan.
- [x] Enforce allocation total <= drawdown principal.
- [x] Calculate borrower-loan funding state:
  - [x] unfunded
  - [x] partially funded
  - [x] fully funded
  - [x] overfunded
- [x] Calculate drawdown allocation state:
  - [x] unallocated
  - [x] partially allocated
  - [x] fully allocated
- [x] Show allocated amount and unallocated amount on drawdown detail.
- [x] Show linked borrower loans in `Fund Detail`.
- [ ] Add UI warning for over-allocation or missing allocation.
- [ ] Add `Needs Funding` queue for borrower loans.
- [ ] Add `Available Funds` queue for unallocated drawdowns.
- [x] Build matching workspace:
  - [x] select borrower loan
  - [x] select one or more drawdowns
  - [x] allocate partial amounts
  - [x] show remaining funding gap live
- [x] Add weighted upstream cost calculation per borrower loan.
- [ ] Stop treating `loans.bankLoanId` as source-of-truth for matching.
- [ ] Add capital-pool support:
  - [ ] add `accounting_mode` to fund sources
  - [ ] add `reinvest_profit_mode` to fund sources
  - [ ] create `fund_ledger_entries`
  - [ ] calculate pool current balance
  - [ ] calculate available-to-allocate balance
  - [ ] post pool outflow on match
  - [ ] post principal return and interest income back into the pool
  - [ ] support retained profit increasing future matchable balance

### Phase 3 Checklist: Upstream Repayment Management

- [x] Create `bank_loan_schedules` table.
- [x] Create `bank_loan_repayments` table.
- [x] Add migration for repayment schedule and repayment records.
- [x] Generate schedule rows when a drawdown is created.
- [x] Add API to fetch repayment schedule by drawdown.
- [x] Add API to record repayment against a schedule installment.
- [x] Add API to list repayments by drawdown.
- [x] Add API to compute overdue penalties.
- [x] Add API to compute outstanding upstream balance after repayment posting.
- [x] Build `Record Fund Repayment` form in `Fund Detail`.
- [x] Show repayment history table in drawdown detail.
- [x] Show next due payment in drawdown summary.

### Phase 4 Checklist: Operational Dashboard

- [x] Add API for borrower due queue.
- [x] Add API for fund repayment due queue.
- [x] Add API for top KPI strip:
  - [x] due from borrowers today
  - [x] due to funds today
  - [x] net position today
  - [x] overdue count
- [x] Add API for funding alerts:
  - [x] underfunded loans
  - [x] unallocated drawdowns
- [x] Add dashboard UI for the top KPI strip.
- [x] Add dashboard `Collections Due` queue.
- [x] Add dashboard `Fund Repayments Due` queue.
- [x] Add dashboard `Funding Alerts` panel.
- [x] Add quick actions from queue rows:
  - [x] record borrower payment
  - [x] record fund repayment
- [x] Add reconciliation status widgets:
  - [x] unreconciled borrower payments
  - [x] unreconciled bank repayments
  - [x] pending manual reviews

### Phase 5 Checklist: Profitability and Forecasting

- [x] Add API for source-level profitability.
- [x] Add API for drawdown-level profitability.
- [x] Add API for borrower-loan-level profitability using weighted allocation cost.
- [x] Add API for dashboard profitability summary.
- [x] Create `loan_schedules` table.
- [x] Add migration for `loan_schedules`.
- [x] Generate borrower repayment schedule when a borrower loan is created.
- [x] Add API to fetch borrower schedule by loan.
- [x] Add API to record borrower repayment against a borrower schedule installment.
- [x] Add API to compute borrower overdue state and expected inflow timing.
- [ ] Add API for capital-pool profitability and retained-profit growth.
- [ ] Add API for bank-source surplus / deficit position.
- [ ] Add API for carry-forward availability.
- [x] Add derived settlement rollup for each bank-backed source:
  - [ ] borrower principal collected
  - [ ] borrower interest collected
  - [ ] bank principal paid
  - [ ] bank interest paid
  - [ ] bank fees paid
  - [ ] bank VAT paid
  - [ ] realized spread
  - [ ] unrealized spread
  - [ ] surplus balance
  - [ ] deficit balance
- [x] Create `fund_rollover_entries` table.
- [x] Add migration for `fund_rollover_entries`.
- [x] Add API to create rollover entries.
- [x] Add API to list rollover entries by source.
- [x] Add API to list rollover entries by drawdown.
- [ ] Support rollover entry types:
  - [ ] `surplus_transfer`
  - [ ] `deficit_support`
  - [ ] `refinance_in`
  - [ ] `refinance_out`
  - [ ] `capitalization`
  - [ ] `manual_adjustment`
- [ ] Validate carry-forward logic:
  - [ ] do not move more than available surplus unless explicitly posting deficit support
  - [ ] preserve explicit operator decisions separately from derived profitability
  - [ ] keep refinance and transfer history immutable
- [ ] Add UI to show source settlement position:
  - [ ] current surplus / deficit
  - [ ] cumulative realized spread
  - [ ] cumulative unrealized spread
  - [ ] carry-forward available
  - [ ] rollover history
- [ ] Add UI actions for settlement decisions:
  - [ ] retain surplus in same source
  - [ ] move surplus into another source
  - [ ] convert surplus into pool capital
  - [ ] support deficit from owner capital
  - [ ] refinance an old drawdown with a newer drawdown
- [ ] Add API for daily / weekly / monthly spread.
- [ ] Add API for cumulative profit vs cost.
- [ ] Add API for 30-day inflow vs outflow forecast.
- [x] Create `audit_logs` table or equivalent audit model.
- [x] Add audit entries for:
  - [x] bank repayment posting
  - [x] borrower repayment posting
  - [x] allocation creation / adjustment
  - [x] rollover creation
  - [ ] drawdown close
  - [ ] writeoff / restructure
- [x] Create reconciliation model for slips and transactions.
- [x] Add reconciliation APIs for borrower and bank payments.
- [ ] Add KPI cards:
  - [x] borrower revenue collected
  - [x] fund cost paid
  - [x] realized spread
  - [x] unrealized spread
  - [x] net cash position
  - [x] realized ROI %
  - [ ] fees + VAT
  - [ ] net profit
  - [ ] net margin %
  - [ ] pool current balance
  - [ ] retained profit
  - [ ] available to allocate
  - [ ] current surplus / deficit
  - [x] carry-forward available
  - [ ] cumulative owner support
  - [ ] refinance in / out total
- [ ] Add charts:
  - [ ] pool balance over time
  - [ ] cash in vs cash out for capital pools
  - [ ] capital efficiency
  - [ ] realized vs unrealized spread
  - [ ] surplus / deficit trend
  - [ ] re-fund flow chart
  - [ ] carry-forward by source
  - [ ] owner support vs recovered surplus
  - [ ] loan funding composition
  - [ ] drawdown deployment
  - [ ] weighted cost vs yield
  - [ ] profit vs cost trend
  - [ ] cumulative profitability
  - [ ] utilization vs cost rate
  - [ ] due burden forecast
- [ ] Restore dashboard charts only after live data wiring is complete.

## New UX Scenario: What The User Must Know Immediately After Login

### Core question

When the user enters the system, they should immediately know:

- which borrower repayments are due now
- which bank or fund repayments are due now
- how much cash must be collected today
- how much cash must be paid back upstream
- whether the current spread is profitable or not

This must not be hidden inside `Funds` only. It should start from the main dashboard.

## Dashboard UX Proposal

### Top Summary Strip

The first visible summary area should answer today's operational questions:

- `Due from Borrowers Today`
- `Due to Funds / Banks Today`
- `Net Position Today`
- `Overdue Items`

Behavior:

- green when expected collections are above upstream obligations
- red when upstream due is greater than expected collections
- amber when there are overdue items or missing repayment confirmations

### Priority Work Queue

Below the top summary, show a split work queue:

1. `Collections Due`
- borrower name
- loan name
- amount due
- due date
- status: due today / overdue / paid
- quick action: `Record Payment`

2. `Fund Repayments Due`
- fund source
- drawdown or bank loan name
- installment due
- fee
- VAT
- penalty if overdue
- total due now
- quick action: `Record Fund Repayment`

This queue should be sorted by urgency:

- overdue first
- due today second
- due in the next few days third

### Net Margin Snapshot

A compact section should show:

- collected from borrowers this period
- paid to banks/funds this period
- gross spread
- penalties paid
- fees paid
- net profit
- profit %

This gives the user a fast answer to:

- Are we making money right now?
- Is this month tighter than expected?

## Fund Repayment UX Proposal

### Drawdown Creation / Setup

When creating a bank drawdown or fund drawdown, the UI should ask for repayment structure explicitly.

Required fields:

- principal amount
- start date
- term
- repayment cycle: daily / weekly / monthly / custom
- repayment mode: fixed installment / minimum due / interest only / custom
- fixed installment amount if applicable
- annual or monthly interest rate
- fee model
- VAT flag or VAT percent
- late penalty rule
- grace period

Optional fields:

- utilization fee
- processing fee
- recurring service fee
- note

### Fund Repayment Schedule View

Each drawdown detail page should show:

- original principal
- outstanding principal
- next due date
- next scheduled amount
- accumulated interest
- fees to date
- VAT to date
- penalties to date
- total paid
- installments paid vs total installments

Then a repayment table:

- installment number
- due date
- scheduled principal
- scheduled interest
- scheduled fee
- scheduled VAT
- scheduled total
- paid amount
- paid date
- overdue days
- penalty
- remaining due
- status

### Record Fund Repayment Flow

The repayment action should be extremely fast:

- open from dashboard queue or drawdown detail
- show current installment due
- allow user to edit actual paid amount
- allow partial payment
- allow late penalty
- allow fee and VAT override if real bank charge differs
- mark one or more installments as paid
- attach slip or note

Quick actions:

- `Pay Current Installment`
- `Pay Partial`
- `Pay Multiple Installments`
- `Mark as Paid with Penalty`

## Profitability UX Proposal

### The business logic to communicate clearly

The system should make the spread visible:

- upstream cost from banks/funds
- downstream revenue from borrower loans
- net profit after fees, VAT, and penalties

The user should be able to understand profitability by:

- fund source
- drawdown
- borrower loan
- time period

### KPI Cards

At minimum:

- `Borrower Interest Collected`
- `Fund Interest Paid`
- `Fees + VAT`
- `Net Profit`
- `Net Margin %`

### Charts

The charts should not be decorative. They must answer cost vs return clearly.

#### Chart 1: Profit vs Cost Trend

Line / area combo:

- borrower income line
- fund cost line
- net spread area

Time filters:

- daily
- weekly
- monthly

Purpose:

- show whether the lending spread stays positive over time

#### Chart 2: Cumulative Profitability

Cumulative lines:

- cumulative borrower collections
- cumulative bank/fund repayments
- cumulative net profit

Purpose:

- show when a drawdown has broken even

#### Chart 3: Fund Utilization and Cost Rate

Dual-axis chart:

- utilization % bar
- effective cost rate line
- effective return rate line

Purpose:

- show whether high utilization is still producing acceptable margin

#### Chart 4: Due Burden Forecast

30-day forward chart:

- expected borrower inflow
- scheduled fund outflow
- net position forecast

Purpose:

- alert the user before a liquidity squeeze happens

## Recommended Screen Layout

### Dashboard

1. Top KPI strip
- due from borrowers today
- due to funds today
- net position today
- overdue count

2. Immediate action queue
- borrower collections due
- fund repayments due

3. Profitability snapshot
- this week
- this month
- current active drawdowns

4. Charts
- profit vs cost
- forecast

### Fund Source Detail

1. Header summary
- source name
- available limit
- utilized
- next due
- status

2. Active drawdowns table

3. Upcoming repayments table

4. Allocated borrower loans

5. Profitability section
- source-level KPI
- source-level chart

### Drawdown Detail

1. Drawdown overview

2. Repayment schedule table

3. Record repayment CTA

4. Allocation traceability

5. Margin analytics

## Data Requirements Added By This Scenario

To support this UX well, the model likely needs:

- repayment cycle on `bank_loans`
- repayment mode on `bank_loans`
- installment amount
- fee model
- VAT amount or rate
- late penalty rule
- grace period
- total installments
- installments paid count
- next due date
- outstanding principal
- outstanding interest
- outstanding fees

And likely a dedicated repayment schedule / repayment record model for fund-side obligations.

Suggested new entities:

- `bank_loan_schedules`
- `bank_loan_repayments`

## API / Backend Additions For This Scenario

- generate fund repayment schedule from drawdown setup
- recalculate next due and overdue state
- record fund repayment against one or more schedule rows
- compute current outstanding cost
- compute net spread by period
- compute dashboard due queues
- compute forecasted inflow vs outflow

## Updated Implementation Priority

### Priority A: Operational Visibility

1. dashboard due summary
2. borrower due queue
3. fund repayment due queue
4. top KPI strip

### Priority B: Fund Repayment Management

1. drawdown form with repayment structure
2. generated repayment schedule
3. record fund repayment flow
4. overdue and penalty handling

### Priority C: Profitability

1. source-level profit calculation
2. drawdown-level profit calculation
3. net spread KPI
4. cost vs profit charts

### Priority D: Forecasting

1. 30-day expected inflow
2. 30-day expected outflow
3. liquidity risk flag
