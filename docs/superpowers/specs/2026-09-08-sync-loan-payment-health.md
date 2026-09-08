# Sync loan payment-health projections

## Objective

Make the Loans list and loan contract/detail reads present the same current payment obligation for floating loans. The backend must remain the sole owner of financial calculations.

## Root cause evidence

- `GET /loans` returns a dynamic `paymentHealth` projection from floating accruals and allocations.
- `GET /loans/:id` and the contract read currently expose the persisted `loans.outstandingInterest` scalar without the same projection.
- The affected loan can therefore show an overdue amount in the list while the contract scalar remains `0.00`.

## Requirements

- Use one backend calculation/read model for current payment health across list, detail, and contract-facing reads.
- Preserve the persisted ledger fields and do not mutate or backfill financial records as part of this fix.
- Keep all money as exact decimal strings and use the Asia/Bangkok business date.
- Keep API/MCP public identifiers and existing write workflows unchanged unless an additive read field is required.
- Add regression coverage that fails before the fix when stored `outstandingInterest` differs from dynamically due floating interest.
- Do not post, reverse, activate, settle, or otherwise write financial records.

## Acceptance criteria

1. For a floating loan with current overdue accruals, Loans list and contract/detail reads expose the same overdue amount and overdue-day/count metadata.
2. For scheduled loans and loans with no overdue amount, existing behavior remains unchanged.
3. Existing financial ledger values remain unchanged by reads.
4. Focused backend tests, disposable database tests, backend typecheck, and relevant frontend checks pass.
