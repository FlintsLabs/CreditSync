# Daily Renewal Full-Contract Interest Design

## Purpose

Extend the existing scheduled daily-loan renewal workflow so an operator can close an active loan, settle the old contract under an explicitly selected interest policy, return the borrower's eligible recovered cash, and create a fresh daily contract without rewriting posted history.

The default policy is `full_contract_interest`. It preserves the lender's full agreed interest on the old daily contract before calculating cash returned to the borrower. The existing behavior remains available as the explicit alternative `accrued_to_date`.

The same backend preview is authoritative for the Web UI, MCP, execution, audit history, and customer-facing summary image.

## Example and Accounting Meaning

For an old contract with principal `2000.00`, total scheduled collections `2400.00`, and 24 daily installments of `100.00`:

- Full-contract scheduled interest is `400.00`.
- Ten posted, non-reversed installments total `1000.00`.
- Under `full_contract_interest`, the recovered amount before other adjustments is `1000.00 - 400.00 = 600.00`.
- If the replacement principal is `2000.00` and there are no additional charges or waivers, the preview returns `cashDirection: "payout"` and `cashAmount: "600.00"`.
- The replacement contract starts a new 24-installment schedule of `100.00`; its interest is a separate new-contract obligation.

The ledger implementation must not relabel all prior receipts as principal. Existing repayment transactions retain their original principal/interest components. The renewal records a separate, explicit full-contract-interest settlement adjustment for the unreceived portion of old contractual interest so that cash movement reconciles without editing history.

## Scope

### Included

- Scheduled daily loans supported by the existing `renewal.preview`, `renewal.execute`, and `renewal.reverse` workflow.
- Operator-selectable settlement policy with `full_contract_interest` as the UI and MCP default.
- Backend-authoritative payment history and renewal composition.
- Structured manual charge and waiver lines.
- Manual Web UI preview, confirmation, execution, and reversal.
- Synchronized MCP contract, private CreditSync plugin guidance, and executable eval coverage.
- Deterministic preview/execution summary-image generation and download.
- Append-only audit and compensating reversal behavior.

### Excluded

- Editing or deleting posted repayments, schedules, renewals, or adjustments.
- Applying this policy automatically to floating, single-payment, weekly, or monthly contracts.
- Free-form overrides of principal paid, full contractual interest, interest received, or schedule totals.
- AI-generated financial text or arithmetic in the summary image.
- Automatically posting a renewal from image generation or image download.

## Settlement Policies

Define the closed enum:

```ts
type RenewalSettlementPolicy = "full_contract_interest" | "accrued_to_date";
```

Every preview request persists an explicit policy. REST and MCP schemas accept an optional `settlementPolicy`; omission resolves to `full_contract_interest` at the backend boundary and the resolved literal is persisted and returned. UI controls initialize to `full_contract_interest` but always send the selected literal.

### `full_contract_interest`

The backend derives:

```text
totalPaid = sum(amount of posted, non-reversed repayment transactions)
contractualInterest = sum(scheduledInterest across the immutable old schedule)
receivedInterest = sum(interestComponent of posted, non-reversed repayments)
remainingContractInterest = max(contractualInterest - receivedInterest, 0)
recoveredBeforeAdjustments = max(totalPaid - contractualInterest, 0)
```

`remainingContractInterest` is an explicit old-contract settlement charge. The calculation is based on exact posted transactions and the immutable activated schedule, using `decimal.js` and two-decimal serialization.

If `totalPaid < contractualInterest`, `recoveredBeforeAdjustments` is zero. The shortfall is not silently discarded: it contributes to the amount that must be collected or funded by the replacement principal through the normal cash-direction calculation.

### `accrued_to_date`

This preserves the current renewal behavior:

- `principalPaid` is the sum of posted, non-reversed principal components, bounded by old principal.
- `outstandingPrincipal` is old principal minus `principalPaid`.
- Only interest, fees, and penalties due through the Bangkok renewal date are settled.
- Future scheduled interest is not charged.

## Structured Manual Adjustments

Preview accepts zero or more ordered adjustment lines:

```ts
type RenewalManualAdjustment = {
    kind: "fee" | "penalty" | "other_charge" | "waiver";
    amount: string;
    reason: string;
};
```

Rules:

- `amount` is a positive two-decimal THB string.
- `reason` is required after trimming and is stored verbatim subject to normal length validation.
- `fee`, `penalty`, and `other_charge` increase the old-contract settlement amount.
- `waiver` reduces charges, never principal, and cannot exceed the sum of eligible interest, fee, penalty, and other-charge balances.
- Lines retain request order and receive immutable public UUIDs when executed.
- Operators cannot submit a negative amount or use a waiver as an untyped cash payout.
- The existing aggregate `waivedCharges` input is replaced through a compatibility adapter during one release: legacy callers map it to one `waiver` line with the supplied `waiverReason`. New UI and MCP contracts use structured lines only.

## Preview Composition

The preview returns a complete, presentation-ready composition. Public money values are two-decimal strings:

```ts
type RenewalComposition = {
    settlementPolicy: RenewalSettlementPolicy;
    oldLoanPublicId: string;
    contractStartDate: string;
    contractDueDate: string;
    renewalDate: string;
    requestedPrincipal: string;
    originalPrincipal: string;
    totalScheduledAmount: string;
    contractualInterest: string;
    totalPaid: string;
    receivedPrincipal: string;
    receivedInterest: string;
    remainingContractInterest: string;
    accruedDueInterest: string;
    dueFees: string;
    duePenalties: string;
    recoveredBeforeAdjustments: string;
    manualCharges: string;
    manualWaivers: string;
    settlementAmount: string;
    cashDirection: "payout" | "collection" | "none";
    cashAmount: string;
    payments: Array<{
        transactionPublicId: string;
        paidAt: string;
        amount: string;
        principal: string;
        interest: string;
        fee: string;
        penalty: string;
    }>;
    adjustments: Array<RenewalManualAdjustment & { lineNo: number }>;
};
```

For `full_contract_interest`, the cash result is derived from exact components equivalent to:

```text
cashNet = requestedPrincipal
          - oldOutstandingPrincipal
          - remainingContractInterest
          - dueFees
          - duePenalties
          - manualCharges
          + manualWaivers
```

The returned `recoveredBeforeAdjustments` makes the operator-facing `totalPaid - contractualInterest` interpretation explicit. The backend must prove conservation between old outstanding principal, settled charges, replacement principal, and cash movement; UI and MCP must not reproduce the formula.

The preview snapshot/hash includes the selected policy, complete immutable schedule, active repayments and reversals, ordered manual adjustment lines, calculated composition, requested replacement principal, funding state, Bangkok business date, and expiry. Any material change produces `STALE_RENEWAL_PREVIEW` and requires a new preview and confirmation.

## Persistence and Ledger

Extend `loan_renewals` with the resolved settlement policy and frozen composition fields needed for durable reads. Store manual lines in a tenant-scoped `loan_renewal_adjustment_lines` table with:

- public UUID;
- tenant and renewal foreign keys;
- line number;
- kind, amount, and reason;
- status `posted` or `reversed`;
- audit public UUID;
- actor/source, request ID, correlation ID, and idempotency key;
- created timestamp.

Database constraints enforce positive amounts, the closed kind/status enums, unique line order per renewal, tenant-safe foreign keys, and immutable posted/reversed records.

Execution appends:

- principal transfer into the replacement loan;
- full-contract-interest settlement when applicable;
- due charge settlements;
- one adjustment entry per manual charge or waiver;
- payout or collection movement;
- funding reallocation;
- immutable audit records.

The old loan becomes `renewed`; the new loan is independently active with a new immutable schedule. No original transaction or schedule is updated except the existing allowed lifecycle transition on the old loan.

Reversal appends exact compensating adjustments and restores the old/new lifecycle states only when the existing authoritative downstream-activity checks permit it. It never deletes adjustment lines or original evidence.

## Web UI

Extend the existing Loan Detail renewal panel rather than creating a separate renewal product.

Before preview, the operator can:

- enter replacement principal;
- choose settlement policy, defaulting to “คิดดอกเต็มสัญญาเดิม”;
- add, reorder, or remove draft manual adjustment rows;
- choose the adjustment kind;
- enter exact amount and mandatory reason.

After preview, the form becomes a read-only approval snapshot. The UI displays:

- old contract start and completion dates;
- each payment date and amount;
- total paid and its original stored allocation;
- full old-contract interest and interest already received;
- remaining full-contract interest charged by renewal;
- due fees and penalties;
- each manual charge/waiver and reason;
- recovered amount before adjustments;
- total deductions and waivers;
- exact payout, collection, or zero-cash result;
- replacement principal and new schedule summary;
- preview expiry and public UUID.

Changing any field discards the preview and requires a new one. Execution requires a second confirmation dialog that repeats policy, total deductions, and cash result. Thai and English translations are updated together.

## MCP and Plugin Contract

Keep the existing tool names:

- `renewal.preview`
- `renewal.execute`
- `renewal.reverse`

`renewal.preview` accepts `settlementPolicy` and structured `adjustments`; both inputs and outputs use closed schemas. Omitted policy resolves to `full_contract_interest`. `renewal.execute` continues to accept only the persisted renewal UUID, preview hash, explicit confirmation, reason, and idempotency context; it cannot change the policy or adjustment lines after preview.

MCP returns the full backend composition and payment history required for operator explanation. The CreditSync skill must state that the default charges full old-contract interest, require explicit presentation of both old and new contractual interest, and stop on ambiguity, stale state, missing reasons, unexpected collection, or missing confirmation.

Synchronize the frozen MCP snapshot, plugin version, tool reference, validator, and positive/negative eval fixtures. Evals prove omission defaults to full-contract interest and prove an explicit `accrued_to_date` selection is preserved.

## Deterministic Summary Image

Provide a backend endpoint for preview or executed renewal summary data and a frontend renderer/export action. The image is rendered deterministically from the returned composition; no generative AI performs financial arithmetic or writes text.

The image includes:

- borrower display name and masked contract UUID;
- “preview—not executed” or “renewal executed” status;
- preview/renewal public UUID and generated timestamp;
- old contract start and due dates;
- payment dates, amounts, and total paid;
- contractual interest, received interest, and additional interest deduction;
- fees, penalties, manual charges, waivers, and reasons;
- recovered amount before deductions;
- net payout/collection amount;
- replacement principal and schedule summary.

Do not include raw identity-card values, full bank account numbers, QR payloads, signed URLs, tokens, or evidence contents. Long payment histories use a summarized first/last-date plus total/count section in the image while the UI retains the complete table.

The export action does not execute the renewal. A preview image is visibly watermarked and becomes stale with its preview. An executed image is generated only from the persisted executed composition.

## Errors and Stop Conditions

Use stable domain errors for:

- unsupported loan type or lifecycle;
- invalid settlement policy;
- invalid adjustment kind, money, or reason;
- waiver exceeding eligible charges;
- cash collection not explicitly confirmed;
- insufficient funding allocation;
- stale or expired preview;
- changed schedule, payment, reversal, funding, or charge state;
- idempotency conflict;
- downstream activity blocking reversal;
- summary requested for an inaccessible or mismatched renewal.

No preview or image generation may post a financial record. Execution is atomic: any failed ledger, audit, funding, or image-independent step rolls back the entire renewal execution.

## Verification

Database-backed tests must prove:

- the `2000.00 / 100.00 × 24 / 10 payments` example returns `600.00` under the default full-interest policy;
- explicit `accrued_to_date` preserves the current result;
- reversed payments do not count;
- full interest comes from immutable schedule rows, not browser arithmetic;
- fees, penalties, other charges, and bounded waivers reconcile exactly;
- underpaid interest produces collection or reduced payout without a negative recovered value;
- all money remains exact beyond JavaScript safe integers;
- preview hashes become stale on every relevant state/input change;
- execution is atomic and idempotent;
- reversal is compensating and blocks on downstream activity;
- tenant/owner isolation and database immutability hold.

REST, MCP, UI, image, and plugin tests must prove:

- default and explicit policies round-trip;
- adjustment rows require kind, positive amount, and reason;
- UI uses backend composition and does not calculate cash;
- confirmation shows both old and new interest obligations;
- preview and executed images are visibly distinct and contain exact values;
- image export causes no financial write;
- frozen MCP/plugin schemas and evals remain synchronized;
- Thai and English copy remain consistent.

Run the complete backend disposable PostgreSQL suite and typecheck, frontend tests/lint/build, and plugin tests/validator before integration.

## Deployment Safety

Deploy schema and application changes through the existing production Docker workflow. Verify migrations, new constraints, backend MCP health, Web UI health, and plugin metadata. Do not create a production renewal as a deployment smoke test. The first real renewal still requires a fresh preview and explicit operator confirmation.
