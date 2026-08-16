# Loan Card Received Totals Design

## Goal

Make each Loan List card easier to scan with a status-aware principal and receipt summary:

- active and other non-paid loans keep outstanding and original principal on one responsive headline row, followed by interest received and total paid; and
- paid loans replace the zero outstanding-principal headline with a green check and `PAID`, followed only by original principal and interest received.

The approved active-loan presentation is:

```text
฿7,500.00  / เงินต้นตั้งต้น ฿7,500.00
ดอกเบี้ยรับแล้ว ฿0.00 · จ่ายแล้ว ฿0.00
```

The approved paid-loan presentation is:

```text
✓ PAID
เงินต้นตั้งต้น ฿10,000.00 · ดอกเบี้ยรับแล้ว ฿2,000.00
```

English uses the equivalent labels `Original principal`, `Interest received`, and `Paid to date`.

## Considered Approaches

### 1. Backend-owned receipt summary (selected)

Return exact `interestReceived` and `paidToDate` strings from the Loan List API. The backend aggregates immutable activation snapshots and posted signed transaction components in tenant scope. The frontend only formats and presents the values.

This keeps accounting rules in one place, avoids browser floating-point arithmetic, and gives all list consumers the same meaning.

### 2. Frontend aggregation from payment history

The Loan List could fetch payment history for every visible loan and calculate totals in the browser. This creates an N+1 request pattern, duplicates accounting logic, and risks stale or inconsistent totals, so it is rejected.

### 3. Display only the current interest balance

The existing loan row could expose outstanding interest and label it as interest. This does not answer the approved question—how much interest has already been received—and is rejected.

## Financial Definitions

All arithmetic uses `decimal.js` through the backend's financial decimal utilities. Public values remain two-decimal strings.

`interestReceived` is:

1. activation-time advance interest actually deducted from borrower payout (`loan_disbursements.first_day_interest_deducted`); plus
2. the signed `interest_component` of posted loan repayment transactions.

Posted compensating reversals are negative and therefore reduce the total. Draft, unmatched, unposted, or failed payment records do not count. Paid accrual snapshots are not summed because their paid cache may represent the same transaction allocation or the activation-time deduction and would double count receipts.

`paidToDate` is:

1. the same activation-time advance-interest deduction; plus
2. the signed sum of posted borrower-payment components: principal, interest, fee, and penalty.

This means deducted advance interest is included in both figures: it is interest received and also value already paid by the borrower. Actual disbursement gross/attributed variance does not change either receipt total. Values must not be inferred from principal reduction or schedule state.

Draft loans with no qualifying history return `0.00`. A correctly compensated history may return zero, but the public summary must never expose a negative cumulative receipt; an internally negative result is treated as a financial-invariant error rather than silently clamped.

## Backend Design

The authenticated Loan List route adds two fields to each row:

```ts
interestReceived: string;
paidToDate: string;
```

The route obtains totals with tenant-bound grouped reads for all visible loan IDs, not one query per card:

- one grouped activation-disbursement read for advance interest;
- one grouped posted-transaction read for signed payment components.

The transaction aggregate must include only borrower repayment and compensating reversal entries that are posted. It must not count loan funding, payout, allocation, settlement preview, or unrelated ledger activity. Loan access filtering remains authoritative before aggregation, so a caller cannot infer totals for an inaccessible loan.

The result mapper combines grouped decimal strings with exact financial decimal operations and serializes two decimals. Existing explicit loan projections remain explicit to preserve production mixed-lineage compatibility.

## Frontend Design

For active and other non-paid loans, the principal area becomes two rows:

1. A responsive flex row containing the large outstanding-principal value and the smaller `/ Original principal …` text. It stays on one line when space permits and wraps as a unit on narrow cards without clipping or horizontal scrolling.
2. A muted, tabular-number summary row containing `Interest received … · Paid to date …`. The separator is decorative; labels remain present in visible text for clarity.

For `paid` loans, the same area uses a distinct completed-state presentation:

1. A green success row with a circle-check icon and the localized `PAID` status. The icon is decorative because the visible status text carries the meaning.
2. A muted, tabular-number row containing only `Original principal … · Interest received …`.

Paid cards do not render the large `0.00` outstanding-principal value, the slash-prefixed original-principal treatment, or `Paid to date`. Their stored exact `paidToDate` value remains in the API contract for consistency and other consumers, but this card intentionally omits it because the paid status already communicates completion and the user requested a quieter historical summary.

Both values use `formatMoneyExact` with the active i18n language. No `Number`, browser-default locale, or frontend financial calculation is introduced. Thai and English locale files are updated together.

Receipt values appear for every loan status. Zero values remain visible when the applicable metric has no receipts, so users can distinguish “nothing received” from “data omitted.” The paid layout may be shorter than an active card; card height is content-driven and no placeholder is added for the omitted outstanding and paid-to-date values.

## Error and Compatibility Behavior

- If the Loan List request fails, the existing retryable list-level error remains unchanged.
- Missing aggregate rows default to exact `0.00`; malformed money from the backend remains a contract error and is not guessed in the UI.
- Existing filters, payment-health badges, sorting, card links, and mobile sidebar behavior remain unchanged.
- This feature is read-only. It does not create accruals, post payments, alter loan balances, or mutate financial history.

## Verification

Backend database-backed tests cover:

- advance interest only;
- posted repayment principal and interest;
- signed payment reversal;
- exclusion of draft/unposted and unrelated transactions;
- tenant/access isolation;
- exact values beyond JavaScript safe integer range; and
- zero defaults.

Frontend tests cover:

- outstanding and original principal sharing the responsive headline row;
- paid cards showing a localized `PAID` label with a circle-check icon;
- paid cards omitting the zero outstanding-principal headline and paid-to-date value;
- paid cards retaining exact original-principal and interest-received values;
- localized interest-received and paid-to-date labels;
- exact money rendering in Thai and English;
- stable zero-value rendering; and
- no regression to loading, error, and card navigation behavior.

Required gates are backend disposable PostgreSQL tests and typecheck, plus frontend tests, lint, and production build.

## Scope Exclusions

- No new sorting or filtering by receipt totals.
- No interest-outstanding or contractual-total-interest figure on the card.
- No tooltip, drill-down, payment-history redesign, or financial write.
- No change to the meaning of the large headline on non-paid cards: it remains outstanding principal.
