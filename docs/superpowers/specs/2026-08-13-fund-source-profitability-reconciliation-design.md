# Fund Source Profitability and Reconciliation Design

## Status

Approved on 2026-08-13.

## Problem

The fund-source detail page reports deployed principal correctly but reports zero borrower revenue, realized spread, unrealized spread, surplus, deficit, and realized ROI for direct own-capital allocations. The settlement read model discovers funded loans only through bank-loan drawdowns. A capital-pool profile whose allocations have a `bankProfileId` but no `bankLoanId` therefore produces an empty loan set even though its contracts and repayments exist.

For the affected production source, six direct allocations total THB 21,500.00. Their 31 posted borrower payments total THB 3,800.00: THB 2,333.33 principal and THB 1,466.67 interest. The source ledger currently contains THB 510.00 of interest-income entries, leaving a THB 956.67 reconciliation difference. These historical financial records must remain immutable.

## Confirmed Business Rule

When a loan uses a funding source, that source recognizes all borrower payments attributable to its net funding share from the beginning of the loan, including payments posted before the allocation was linked in the application. Spoken descriptions such as multiple informal loan “วง” do not change the canonical contract or allocation records.

When a loan has multiple funding sources, every borrower-payment component is attributed proportionally to each source's net allocation. The backend owns this allocation and rounding. Principal recovery is cash recovery but not profit; interest, fees, and penalties are revenue.

## Selected Approach

Use contracts, posted borrower transactions, and net funding allocations as the authoritative profitability read model. Keep `fund_ledger_entries` as the append-only cash-ledger history and expose the difference between contract-attributed revenue and ledger-recorded revenue as an explicit read-only reconciliation metric.

This design does not synthesize historical financial entries, edit existing ledger rows, or silently force the two sources to agree. A future operator-authorized reconciliation command may append adjustments, but it is outside this change.

Alternatives rejected:

- Backfilling ledger entries automatically would risk duplicate recognition when allocations change or an operation is retried.
- Continuing to read only the ledger would require perfect historical backfills and would leave the profitability report incomplete whenever linkage happened after payment posting.

## Backend Architecture

### Allocation discovery

`getBankProfileSettlementSummary(tenantId, bankProfileId)` will load allocations by `bankProfileId` directly. This includes direct capital-pool allocations and drawdown-backed allocations. Drawdown queries remain responsible only for source borrowing costs and outstanding drawdown liabilities.

Allocation rows are reduced to a net amount per `(loanId, bankProfileId)` before transactions are joined. Zero or negative net shares do not recognize revenue. The denominator for a loan is the sum of all positive net source allocations for that loan, falling back to the loan principal only under an explicitly tested legacy condition. This prevents multiple adjustment rows from duplicating the same payment.

### Exact attribution

All money arithmetic and comparisons use `decimal.js`. For each loan and source:

```text
source share = positive source net allocation / total positive net allocations
source component = posted transaction component × source share
```

The attribution covers principal, interest, fees, and penalties. Reversed or compensating transactions follow the existing signed transaction semantics and therefore reduce the attributed totals without mutating the original row. Exact two-decimal public money strings are produced only at the API boundary; intermediate values retain decimal precision and use the project's established rounding policy.

### Settlement and profitability definitions

- Borrower revenue collected: attributed interest + fees + penalties.
- Borrower cash collected: attributed principal + interest + fees + penalties.
- Fund cost paid: drawdown interest + fees + VAT + penalties actually paid.
- Realized spread: borrower revenue collected minus fund cost paid.
- Unrealized spread: remaining contractual borrower revenue minus outstanding allocated fund cost.
- Deployed principal: positive net allocations for the profile.
- Net cash position: existing surplus balance minus deficit balance.
- Realized ROI: realized spread divided by deployed principal, or zero when deployed principal is zero.
- Opportunity cost: existing capital-pool calculation over positive allocations.
- Economic spread: realized spread minus accrued opportunity cost.

Principal recovery contributes to settlement cash position but never to realized spread or ROI numerator.

### Reconciliation projection

The profile response will include a read-only reconciliation object with exact two-decimal strings:

```ts
type FundRevenueReconciliation = {
  contractAttributedRevenue: string;
  ledgerRecordedRevenue: string;
  difference: string;
  status: "matched" | "needs_reconciliation";
};
```

`ledgerRecordedRevenue` includes source ledger revenue entry types according to an explicit allowlist, not a suffix heuristic. `difference` equals contract-attributed revenue minus ledger-recorded revenue. `matched` requires an exact zero Decimal difference. This projection never appends, edits, or deletes financial records.

## API and Frontend Presentation

The existing settlement-summary and profitability endpoints remain tenant-scoped and retain their current routes. Public money values touched by this change become two-decimal strings consistently. The frontend must not recalculate financial metrics.

The “Accumulated settlement position” card displays:

- realized spread;
- unrealized spread;
- surplus; and
- deficit.

The “Source profitability” card displays:

- borrower cash collected;
- fund cost paid;
- deployed principal;
- net cash position;
- realized ROI;
- opportunity cost; and
- economic spread.

A new read-only “Data reconciliation” section displays contract-attributed revenue, ledger-recorded revenue, the signed difference, and a localized semantic status badge. Thai and English translations are updated together. Positive, negative, warning, and matched states use semantic colors with text labels so color is not the only signal.

For the currently affected source, the expected values include THB 1,466.67 contract-attributed interest revenue, THB 510.00 ledger-recorded interest revenue, and THB 956.67 needing reconciliation.

## Error Handling and Safety

- Missing profiles continue to return not found without leaking another tenant's data.
- Loans with no positive allocation contribute no revenue and surface through testable diagnostics rather than division by zero.
- Invalid or non-decimal stored values fail explicitly; they are not coerced through JavaScript `Number`.
- Cache keys and invalidation must continue to prevent stale profile summaries after allocation or repayment writes.
- No implementation or deployment step creates production financial transactions for verification.
- Existing posted transactions, allocations, and ledger entries remain immutable. Any later accounting correction must be append-only, explicitly authorized, reasoned, audited, correlated, and idempotent.

## Verification Strategy

Unit tests cover exact allocation reduction and proportional attribution for one source, multiple sources, adjustment rows, signed reversals, fractions requiring rounding, and zero-positive-allocation cases.

Disposable-PostgreSQL integration tests prove that:

- a direct own-capital profile with no drawdown recognizes all historical posted payments;
- a drawdown-backed profile still recognizes payments and source costs;
- multiple allocation rows do not duplicate transactions;
- principal is included in borrower cash but excluded from profit;
- interest, fees, and penalties are included in revenue;
- reconciliation reports matched, under-recorded, and over-recorded ledgers exactly; and
- tenant isolation remains intact.

Frontend tests verify localized labels, exact money rendering, reconciliation statuses, semantic badge styles, and loading/error behavior without client-side accounting.

Before deployment, run backend disposable database suites and typecheck, frontend tests/lint/build, and any affected contract tests. Deploy backend and frontend using the production Compose files, then verify backend MCP health, public frontend HTTP health, container logs, and read-only production API values. The acceptance target for the affected source is contract-attributed interest revenue THB 1,466.67 and a reconciliation difference of THB 956.67, without creating a new financial record.

## Out of Scope

- Automatically appending historical ledger reconciliation entries.
- Editing or deleting posted transactions or ledger rows.
- Changing loan terms, schedules, principals, or allocation history to make reports agree.
- Building an operator reconciliation write workflow in this change.
