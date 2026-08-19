# Floating Loan Restructure Design

## Goal

Support an atomic `floating -> floating` restructure that preserves the old loan history, carries eligible outstanding components into a replacement loan, and creates an auditable additional-principal disbursement.

## Current limitation

`loan.restructure.preview` is routed through `computePreview()` in `backend/src/services/loan-restructure-service.ts`, which rejects every source loan except an active `single_payment` loan. The replacement-term normalizer and execution path already support creating a floating replacement, but the source-balance calculation and floating replacement payment allocation do not.

## Design

1. Reuse the floating settlement calculation as the source-of-truth for a floating source loan. The preview must accrue through the settlement date, include due and accrued-not-due interest, penalties, fees, non-refundable advance-interest history, and produce a balance version containing all relevant immutable state.
2. Keep the existing single-payment path unchanged. Add a source-type branch so floating preview computes the current principal and eligible carried components without using single-payment fixed/retroactive interest rules.
3. Preserve the existing restructure lifecycle: preview, explicit confirmation, atomic execute, old loan status `restructured`, active replacement loan, opening-balance components, rate-period row, and an editable disbursement draft for `additionalPrincipal`.
4. For floating replacements, make payment allocation aware of carried penalty, carried fee, and carried interest before allocating newly accrued floating interest and principal. New floating accruals remain represented by immutable accrual/allocation rows; carried components remain represented by opening-balance components.
5. Keep the public MCP shape unchanged where possible. Update descriptions, skills, evals, and tests to state that restructure supports floating sources as well as floating replacements.

## Financial behavior

For a 4,000.00 floating loan at 15 per-thousand per day with an additional principal of 1,000.00 and no carried charges, the preview shows replacement principal 5,000.00, new daily interest 75.00, and a 1,000.00 payout draft. Existing posted transactions are never edited or deleted.

If carried charges exist, the preview exposes them separately. They are carried into the replacement only through opening-balance components, unless an explicit external settlement credit or waiver is supplied. Principal is never waived.

## Safety and invariants

- Preview and execution use the exact balance version and preview hash; stale or expired previews stop without mutation.
- All money remains two-decimal decimal strings and calculations use `FinancialDecimal`/`decimal.js`.
- Execution is idempotent and append-only; reversal remains subject to downstream activity checks.
- Floating daily/weekly rate policy and first-day treatment are explicit replacement terms, never inferred from the old loan.

## Verification

Add service tests for floating-source preview, execution, carried-component payment allocation, stale preview, and reversal blockers. Run the disposable PostgreSQL service suites, backend typecheck, MCP/plugin contract tests, and the relevant payment/floating regression suites.

