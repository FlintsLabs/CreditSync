# Personal Lending Control Center Roadmap

CreditSync is now being prioritized for a single-owner workflow: one person tracking borrower loans, bank funding, repayments, slips, and LINE bot uploads. This keeps the roadmap focused on correctness and daily operations instead of enterprise lending features.

## Phase 1 - Money Correctness

- Ensure every new loan starts with accurate outstanding principal, interest, fees, next due date, and status.
- Make repayment posting safe against duplicate submissions and concurrent updates.
- Add explicit void, reversal, and adjustment workflows for borrower repayments and fund repayments.
- Keep principal, interest, fee, and penalty allocation accurate for partial payments across multiple installments.

## Phase 2 - Daily Work Queue

- Make the dashboard answer three questions quickly: who is due today, who is overdue, and what must be paid back to funding sources.
- Keep the reconciliation page as the bot inbox for LINE uploads, slips, and manual evidence.
- Add quick actions from each due item to record payment, open borrower profile, open loan detail, and copy a collection message.
- Add filters for due today, overdue, missing slip, and unreconciled.

## Phase 3 - Bot Messaging

- Send a daily LINE summary to the owner with borrower due items, overdue items, pending uploads, and funding repayments due.
- Support inbound LINE images as pending uploads and keep them easy to match to borrower payments or fund repayments.
- Add simple bot commands for today's queue, overdue list, borrower lookup, and pending uploads.

## Phase 4 - Documents And Messages

- Generate copy-ready payoff messages from the closing summary.
- Generate basic loan agreement, receipt, repayment statement, and payoff summary documents.
- Store generated document versions with the borrower or loan.

## Phase 5 - Traceability And Export

- Keep bank funding allocations visible from each loan and funding source.
- Export borrowers, loans, schedules, repayments, funding allocations, and ledger entries to CSV or Excel.
- Add backup guidance for PostgreSQL data and object storage files.

## Deferred For Now

- Borrower self-service portal.
- Full underwriting and approval pipeline.
- KYC/AML provider integration.
- Payment gateway and autopay.
- Investor portal and multi-branch workflows.
- Enterprise-grade RBAC beyond the permissions needed for owner-only usage.
