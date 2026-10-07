# Multi-contract payment entry — approved design

Date: 2026-10-07 (Asia/Bangkok)

The user approved the in-chat design with “ยืนยัน”. This document records that design and the implementation decisions required to preserve the existing financial workflow.

## Outcome

An operator records one receipt once, enters exact amounts for several contracts, optionally attaches multiple evidence files, then reviews the backend preview before explicitly posting. Each contract's posted history shows its own amount and opens the same receipt evidence. The operator can also open the receipt review to inspect its allocations.

## Receipt and allocation model

- One entry represents one actual receipt with one payer, amount, and Bangkok receipt time. Separate transfers or receipt times belong in separate receipts, using the existing batch workspace when appropriate.
- A receipt has one or more allocation rows. Each row selects a borrower, active contract, optional applicable installment, and a positive two-decimal amount.
- An entry opened from a contract preselects that contract in the first row without restricting additional rows to it. Borrower selection in a row filters its contracts.
- The payer is receipt-level data. Never silently infer that one borrower paid for another. Cross-borrower identity and duplicate warnings remain subject to the existing review workflow.
- With evidence, the operator enters the receipt/slip total and allocations must sum exactly to it. Without evidence, the displayed receipt total is the exact sum of entered rows.
- Scheduled loans use their authoritative installment choices. Floating loans have no fixed installment selector; the backend determines the interest/principal components.
- Repeated identical contract/installment rows are rejected; different unpaid installments of one scheduled contract are allowed.

## Screen and interaction

Keep the existing application's components, typography, Thai/English localization, and mobile layout conventions. Expand the narrow form into a task workspace: receipt information, editable allocation rows, optional evidence, and an exact total/difference summary. Use a table-like arrangement on desktop and stacked allocation cards on mobile.

Each amount has placeholder `0.00` and formats as `#,###.00` on blur using exact decimal formatters and the active app language. Editing one row never clears another row's amount. Async installment responses must not overwrite a row whose contract changed or was removed.

Evidence is optional. Accept JPEG, PNG, and PDF, up to 20 distinct supporting files for this receipt; the backend remains authoritative for size validation (default 20 MiB/file, configurable). Show each file's name/status, removal before submitting, and retry state. Multiple independent slips/transfers use the existing batch link; label the difference clearly. Do not run OCR or infer financial allocations from evidence.

The primary action is “ตรวจสอบการรับชำระ” / “Review payment”. Validate, create one intake, prepare/PUT/finalize selected evidence, persist the explicit allocation preview, and open the existing payment review with that intake selected. It must never post automatically. The review retains its current fresh-preview and explicit-confirmation controls.

Cancel returns to the originating contract when one was provided, otherwise the transaction list. Once an intake has been created, disclose that its unposted draft remains and provide an explicit way to open it; leaving the form does not reverse, delete, or financially cancel that record.

## Retry and financial boundaries

- Money uses `decimal.js` and exact string formatters, never `Number`/floating-point financial arithmetic. Public amounts are canonical two-decimal strings.
- Receipt date/time is entered and interpreted in `Asia/Bangkok`, including when the browser's timezone differs.
- Freeze the submitted receipt/allocation/file snapshot while requests are in flight and after intake creation. Resume the same intake on failure; do not silently create a replacement receipt.
- Supply a stable create idempotency key and request/correlation context. An idempotency replay is resumed only after inspecting the returned record and matching the submitted receipt snapshot; other duplicate reasons require review.
- Declare the selected evidence count when creating the intake. A failed selected upload must not degrade to a no-evidence payment. Ready files are not uploaded/finalized again on retry.
- A duplicate evidence response stops the workflow and points to review. Do not preview/post the other receipt as if it were the newly created one.
- Posted financial records and loan terms stay immutable. Calculations, allocation eligibility, warnings, posting, and reversals remain owned by the existing backend services.
- Do not log evidence contents, raw bank references, signed URLs, auth tokens, or secrets.

## History behavior

Reuse the existing evidence association through `transactions.paymentIntakeId`. Add a safe public receipt identifier to the transaction read DTO so contract histories can open `/payments?intake=<publicId>`. Shared evidence is stored once on the receipt, not independently uploaded for each contract. Keep each contract's displayed amount equal to its posted allocation, never the entire receipt total. Legacy transactions without an intake continue to display normally.

## Acceptance

1. One receipt split across two contracts produces exactly one intake, retains both explicit allocations in review, and never auto-posts.
2. A no-evidence receipt is supported and its total equals the exact allocation sum.
3. A receipt with several files cannot proceed through an incomplete evidence upload; retry reuses its existing intake and completed files.
4. A posted shared receipt appears in each participating contract's history with the contract amount and identical evidence public identifiers; opening either receipt link reaches the same review.
5. Floating and scheduled loans, stale async selection responses, duplicate detection, money precision, Bangkok time, Cancel, localization, and mobile/keyboard interaction are covered by verification.

## Scope

Existing React/Vite frontend and existing intake REST APIs; one additive transaction-read DTO field; focused regression tests and README/CHANGELOG updates. No migrations, new accounting rules, MCP/plugin contract changes, OCR, production financial writes, or unrelated refactors.
