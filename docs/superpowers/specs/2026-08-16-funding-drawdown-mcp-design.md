# Funding Drawdown and Loan Allocation MCP Design

**Status:** Approved by user for specification planning

**Goal:** Add a safe, Decimal-based REST and MCP workflow for creating a bank funding drawdown, generating its repayment schedule, and allocating the drawdown to an existing borrower loan without conflating bank liability, borrower payout, or loan terms.

## Context

CreditSync already stores funding profiles in `bank_profiles`, bank borrowings and their schedules in `bank_loans`/`bank_loan_schedules`, and source allocations in `loan_funding_allocations`. REST already exposes bank-loan creation and loan funding-allocation routes, but the MCP contract only exposes `funding-source.list` as a read-only tool. The current bank-loan route also performs scheduling with JavaScript `Number` arithmetic, which is unsuitable for financial values.

The target workflow is the TTB So fast case: create a 36,000.00 THB bank drawdown at 25.00% annual interest for 10 months, then allocate 36,000.00 THB to the already active 36,000.00 THB borrower loan. This funding operation must not modify the borrower loan's principal, repayment schedule, or interest terms. Actual borrower cash transfer remains a separate `loan_disbursements` ledger operation.

## Architecture

Create reusable application services for bank drawdowns and loan funding allocations. REST routes and MCP handlers call these services; neither interface owns financial calculations or persistence rules. Bank drawdowns use an explicit `draft -> active -> closed` lifecycle, while allocation is a separate append-only ledger write. A composite command performs drawdown activation and allocation atomically when the caller explicitly requests the linked operation.

The public MCP contract uses two-decimal decimal strings for all money, closed schemas, read-only hints for reads, destructive annotations for writes, idempotency keys for every write, and audit/correlation metadata on every successful write.

## Domain Boundaries

### Bank drawdown

`bank_loans` records money borrowed by the lending operation from a funding provider. It owns the provider rate, term, repayment cycle, schedule, outstanding bank liability, and funding-profile relationship.

### Loan funding allocation

`loan_funding_allocations` records how much of a bank drawdown funds a borrower loan. Allocation is capped by both the remaining drawdown capacity and the loan's unfunded principal. It does not change the borrower loan contract.

### Actual borrower disbursement

`loan_disbursements` records money actually sent to the borrower. It remains separate from approved principal, funding allocation, and bank drawdown amount. Grouped or partial transfers retain gross and loan-attributed amounts.

## Lifecycle

1. Inspect the funding profile and target loan.
2. Preview the bank drawdown terms and exact schedule.
3. Create an editable drawdown draft with an idempotency key.
4. Explicitly activate the draft, generating immutable schedule rows.
5. Preview the funding allocation against the active drawdown and target loan.
6. Create the append-only allocation with a separate idempotency key.
7. For the combined command, execute steps 3-6 in one transaction and return both ledgers.
8. If borrower cash was actually sent, record it separately through the existing loan-disbursement workflow.

All dates are ISO `YYYY-MM-DD` and interpreted in `Asia/Bangkok` for business-day behavior.

## Application Services

### `backend/src/services/bank-loan-service.ts`

Owns Decimal-based normalization, schedule generation, draft creation, activation, idempotency, status transitions, credit-limit validation, and bank-loan audit payloads.

Public service operations:

```ts
previewBankDrawdown(ctx, input): Promise<BankDrawdownPreview>
createBankDrawdownDraft(ctx, input): Promise<BankDrawdownDraft>
activateBankDrawdown(ctx, input): Promise<BankDrawdownActivationResult>
```

The service accepts money and rate values as strings. It uses `decimal.js`/`FinancialDecimal` for all calculations and returns serialized two-decimal strings.

### `backend/src/services/loan-funding-service.ts`

Owns target validation, remaining-capacity checks, append-only allocation creation, and allocation audit payloads.

Public service operations:

```ts
previewFundingAllocation(ctx, input): Promise<FundingAllocationPreview>
createFundingAllocation(ctx, input): Promise<FundingAllocationResult>
```

### Composite operation

Add a transaction-level service operation:

```ts
createAndAllocateBankDrawdown(ctx, input): Promise<DrawdownAllocationResult>
```

It locks the funding profile/drawdown and loan rows, creates or activates the drawdown, validates capacity, inserts the allocation, writes audit records, and commits only if every invariant succeeds. A failure in allocation must roll back the drawdown activation and allocation together.

## REST API Design

Refactor existing REST handlers to call the new services. Preserve existing read endpoints and compatibility behavior where required, but make new financial command inputs string-based at the service boundary.

Add or formalize these endpoints:

```text
POST /bank-loans/preview
POST /bank-loans/drafts
POST /bank-loans/:id/activate
POST /loans/:id/funding-allocations/preview
POST /loans/:id/funding-allocations
POST /funding-source/drawdown-and-allocate
```

The composite request must include the funding profile public ID, target loan public ID, amount, annual interest rate, start date, term, repayment cycle/mode, allocation amount/date, and idempotency key. The server must not infer the drawdown start date or allocation date from a borrower slip or loan start date.

## MCP Contract

Add these tool names to `MCP_TOOL_NAMES` and the handler/description/schema registries:

Read-only:

```text
funding-source.get
funding-source.drawdown.get
funding-source.drawdown.schedule
loan.funding-allocation.list
loan.funding-allocation.preview
funding-source.drawdown.preview
```

Destructive:

```text
funding-source.drawdown.draft
funding-source.drawdown.activate
loan.funding-allocation.create
funding-source.drawdown-and-allocate
```

The composite tool should accept this closed request shape:

```json
{
  "bankProfilePublicId": "uuid",
  "loanPublicId": "uuid",
  "amount": "36000.00",
  "interestRate": "25.00",
  "startDate": "2026-07-12",
  "termMonths": 10,
  "repaymentCycle": "monthly",
  "repaymentMode": "fixed_installment",
  "allocationAmount": "36000.00",
  "allocationDate": "2026-07-12",
  "idempotencyKey": "tenant-scoped-key"
}
```

Successful writes return the drawdown public ID, allocation public ID when applicable, schedule summary, resulting funding state, `auditPublicIds`, and `correlationId`. The tool must reject ambiguous profile/loan matches, inactive profiles, inactive loans, over-limit drawdowns, over-capacity allocations, invalid dates, duplicate idempotency keys with different payloads, and attempts to use actual-disbursement fields as funding-drawdown fields.

## Database Changes

Add a guarded migration that:

- permits `bank_loans.status = 'draft'`;
- adds tenant-scoped idempotency/request/correlation and actor fields needed for bank-loan commands;
- adds a tenant-scoped unique idempotency constraint;
- keeps bank-loan schedules immutable after activation except through existing append-only repayment/adjustment workflows;
- preserves tenant foreign keys and indexes for profile, status, due date, and allocation lookups.

The migration must not rewrite existing financial rows or infer missing historical funding relationships.

## Calculation Rules

Replace `backend/src/lib/bank-loan-schedule.ts` numeric arithmetic with Decimal arithmetic. The schedule generator must:

- calculate periodic rate from annual rate and repayment cycle;
- calculate fixed installment when one is not supplied;
- round each component to two decimals with the project rounding policy;
- force the final principal component to the exact remaining principal;
- return exact total interest, fees, VAT, total repayment, and remaining balance;
- preserve money as strings across REST, MCP, service, and persistence boundaries.

The borrower loan's schedule calculator remains authoritative for the borrower contract. Bank-loan schedule values are used only for the external liability and funding-source reporting.

## Authorization and Safety

- Tenant scope and tenant-admin/tenant-wide access are checked before funding operations.
- Inspect source profile and target loan before every write.
- Require explicit confirmation for activation and composite execution.
- Lock rows in a stable order to avoid concurrent over-allocation.
- Every write receives request ID, correlation ID, actor/source, idempotency key, and audit history.
- No raw account numbers, QR payloads, bearer tokens, or evidence contents enter notes, logs, or MCP responses.
- Actual disbursement evidence follows the existing prepare -> signed PUT -> finalize -> post workflow.

## Testing and Contract Synchronization

Backend tests must cover Decimal schedule calculations, final-rounding behavior, draft/activate transitions, idempotent retries, profile credit limits, drawdown capacity, loan unfunded capacity, allocation rollback, concurrent allocation locking, tenant authorization, and composite transaction rollback.

MCP tests must cover closed schemas, read-only/destructive annotations, structured output, audit/correlation fields, duplicate-key behavior, and rejection of cross-tenant or cross-loan allocations.

Update the frozen private CreditSync plugin manifest/version, tool registry, eleven-skill contract references, funding workflow skill, evaluation scenarios, and validator together. Run disposable PostgreSQL backend tests, typecheck, MCP/plugin tests, and the relevant frontend build/verification gates before completion.

## Explicit Non-Goals

- Do not automatically merge or close the existing borrower loans.
- Do not mutate borrower principal or borrower repayment schedules when funding is attached.
- Do not treat a bank drawdown as proof that cash was sent to the borrower.
- Do not infer missing dates, profile identity, or allocation amounts from slip OCR.
- Do not add a generic financial transaction engine outside the funding/drawdown scope.
