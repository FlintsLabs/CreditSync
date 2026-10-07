# Floating daily accrual payments and visible receipt history

Date: 2026-10-07 (Asia/Bangkok)
Status: Approved by user on 2026-10-07; implementation authorized, no merge/push/deploy.

## User outcome

On Loan Detail > Accrue, an operator can record an actual payment against explicitly selected daily interest dates without leaving the table. A newer interest date can be paid while an older date remains unpaid; the older date can be collected later. The table explains which interest date was paid, when cash was actually received, and how much was received each time, without opening evidence.

Interest date, actual receipt timestamp, and recording timestamp are distinct. Clicking an interest row must never silently replace the actual receipt timestamp with that row's date. Actual historical receipts can be entered later, subject to backend provenance and penalty safety checks.

## Confirmed examples (synthetic, not production records)

Loan: floating daily, THB 4,000.00 principal, THB 80.00 interest/day, no penalties/fees in these examples.

1. Receipt 2026-10-01 pays interest 2026-10-01. Receipt 2026-10-03 pays interest 2026-10-02. The latter row says interest date 2 Oct, received 3 Oct; 3 Oct interest remains unpaid.
2. Receipt 2026-10-05 pays only interest 2026-10-05 while 2 Oct remains unpaid. Receipt 2026-10-07 later pays interest 2026-10-02. Each receipt retains its actual timestamp and targets; neither is redistributed to an older date automatically.
3. One THB 160.00 receipt explicitly targets 2 Oct and 4 Oct at THB 80.00 each. 3 Oct remains unpaid.
4. A selected THB 80.00 obligation receives THB 30.00 on 5 Oct and THB 50.00 on 7 Oct. Both receipt timestamps/amounts appear, paid is THB 80.00, remaining is THB 0.00.
5. Recording a genuine 3 Oct receipt after a 5 Oct receipt must be accepted when their targets are independent and the backend proves that no financial history needs rewriting. Unsafe overlap or downstream paid-penalty dependencies stop for review; never falsify receipt dates to pass a guard.

## Existing implementation evidence

- `frontend/src/pages/dashboard/loans/LoanAccrualsTab.tsx` renders accrual amounts/status only; no payment controls or receipt provenance.
- `frontend/src/pages/dashboard/loans/LoanRepaymentHistory.tsx` has intake capture, followed by separate review navigation.
- `backend/src/services/payment-service.ts` (`expandExplicit`, `stateHash`, `postPaymentKernel`, `planFloatingPaymentTargets`) currently receives loan-level amounts and chooses floating targets itself. Loan-level explicit allocation does not mean explicit interest-date allocation.
- `backend/src/services/floating-interest-service.ts` provides read-only as-of projections and transactional materialization. Its projected row identifiers are not public UUIDs; never submit those identifiers as financial targets.
- `backend/src/db/schema.ts` already keeps actual transaction timestamps, dated floating allocations, accrual links, reversal links, audit context, and public receipt identifiers.
- `backend/src/lib/floating-allocation-integrity.ts` resolves reversal lineage and detects over-allocation. Preserve its checks; skipping an unpaid date is not itself corruption.
- Historical posting/reversal guards in `payment-service.ts` protect later allocations and principal/penalty effects. A dedicated, tested interest-only branch is necessary; disabling those guards globally is prohibited.

## Scope and policy

- Selected-date posting is for active floating daily contracts with a supported authoritative interest policy. Use backend interest calculations; never create a synthetic scheduled repayment plan.
- This action explicitly pays selected daily interest only. Principal, carried charges, fees, and penalties are not silently settled or waived. Preview shows their remaining amounts separately so a successful interest receipt does not imply that all debt is settled. Preserve default policy ordering in every existing general payment path.
- Select one or more dates already accrued by the actual receipt's Bangkok date. Future receipt timestamps and targets not yet accrued at receipt time are rejected. Picking an older target after paying a newer one is supported.
- Every target has a positive two-decimal amount, bounded by its authoritative unpaid capacity. A partial payment is valid. Target dates are unique; their amounts sum exactly to the received amount. Excess requires changing the request or using the appropriate settlement flow, never automatic principal allocation.
- Validate both the requested historical state and current active allocation lineage. A historical cutoff must not hide a later allocation and permit double payment of a target.
- Preview uses projected dates without persisting accruals. Posting resolves real ledger records and materializes through the receipt date in the same transaction.
- Closed/replaced/cancelled contracts and reversed/fully paid rows do not offer this payment action. Existing weekly/monthly floating and scheduled-payment flows retain their current behavior.

## Operator flow

1. A keyboard-accessible Pay button on an unpaid row opens the existing style of modal and selects that interest date. Additional eligible dates can be selected there.
2. Show loan/borrower context, selected interest dates, actual receipt date/time in Bangkok, total received amount, per-date amounts, and optional note/reference. Default actual receipt time is now; it remains editable for genuine historical entry.
3. Review creates/resumes one idempotent intake and one versioned selected-date proposal. Display actual receipt timestamp, exact targets/components, total/variance, other outstanding debt, and backend blockers. No financial receipt is posted at this stage.
4. A separate explicit Confirm payment action posts only a current `ready`, zero-variance, warning-free proposal. Changing an amount/date/selection invalidates confirmation and requires a new preview. Duplicates and ambiguous receipts remain review cases.
5. After success, refresh authoritative detail and receipt history. Preserve the receipt identity if refresh fails; offer refresh/reopen, not another financial submission. Retry after a network interruption uses the same idempotency key and inspects the existing result.
6. Closing a dialog with an already-created intake must retain its public ID and offer continuing that draft. Never create a fresh intake on a simple re-open/retry. Cancelling an intake uses the existing explicit cancellation workflow.

## Visible history

Each row shows interest date/period, exact interest, net paid, remaining, and unpaid/partly paid/fully paid/reversed status. A separate receipt-history cell lists actual receipt date/time and amount for each allocation, with a link to the public payment record. It does not require evidence access.

Aggregate receipts are split per target using actual ledger allocation amounts. Do not repeat the full intake amount on each target. Reversed receipts remain visible with a reversed label, but are excluded from current paid totals. Resolve complete reversal lineage before applying an as-of cutoff.

Advance deduction at origination is labelled as an advance deduction, not an invented borrower receipt. Legacy paid balances lacking traceable receipt records show an explicit unavailable-history label; never invent a receipt timestamp from an accrual date or audit creation time.

Return only safe public IDs, two-decimal money, ISO timestamps, and date-only interest dates. Do not expose internal IDs, references, QR data, file contents, signed URLs, account identifiers, or bearer tokens in table data or logs. Thai/English copy must be added together; use Bangkok formatting independently of the browser timezone.

## Backend contract and persistence direction

Dedicated authenticated REST routes invoke application services directly. Existing frozen MCP inputs/outputs remain unchanged; do not expose this mode through a generic MCP schema by accident.

- `POST /loans/:id/accrual-payments/preview`: `amount`, `receivedAt`, `targets: [{ accrualDate, amount }]`, optional note/reference and existing draft intake UUID for re-preview. Require request/correlation IDs and a stable Idempotency-Key. Infer borrower from the authorized loan.
- `POST /loans/:id/accrual-payments/post`: intake UUID, proposal UUID, `confirmed: true`, Idempotency-Key. Inspect exact stored proposal targets; reject cross-loan proposals and stale state.
- Store versioned immutable target dates/amounts in a new tenant-scoped child table tied to the payment match allocation. Dates identify projected targets until posting resolves accrual UUIDs. Include target data and current relevant financial state in the proposal hash.
- Reuse existing intake, proposal lifecycle, audit, transaction, floating allocation, penalty reconciliation, rollup, cache invalidation, and reversal services. Add a narrowly scoped selected-interest branch to the posting kernel; do not build a second independent ledger or bypass evidence/duplicate/ownership checks.
- Add receipt metadata to the web accrual read model through a batched tenant/loan-scoped query. Existing MCP presenters must keep their frozen field shape.
- Selected-date proposals must also be recognised when reopened through existing review surfaces: preserve their target semantics, or clearly block generic re-post and direct the operator to the dedicated review. Never silently convert them to FIFO.

## Financial safety and acceptance

Posting locks the intake, proposal and loan, revalidates receipt/targets/capacity, writes one actual receipt transaction and exact immutable allocations, and returns audit/correlation IDs atomically. Stable retries produce no duplicate receipts or allocations.

Later-interest-before-earlier-interest works without consuming unselected dates. Disjoint historical interest receipts can be accepted only with a targeted safety proof. Existing backdated principal restrictions and downstream reversal restrictions remain. Penalty adjustments use append-only compensation; a conflict with already-paid penalty or immutable downstream provenance stops explicitly.

Test all five examples plus stale preview, concurrent partial payments, duplicate/idempotency conflicts, unauthorized tenants/portfolios, missing rate coverage, full advance deduction, reversed history, unknown legacy timestamps, timezone mismatch, no-evidence posting, pending evidence requirement, and failed post-success refresh.

No production financial writes, migration execution, deployment, push, or merge is authorized by the design confirmation. Those remain separate execution actions.
