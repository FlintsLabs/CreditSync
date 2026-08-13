# Single-Payment Settlement and Loan Restructure Design

## Purpose

CreditSync must support loans that are disbursed once and contractually repaid as one lump sum on an exact due date. It must also let an operator settle an existing loan into a replacement contract without rewriting posted financial history. The replacement contract may be another lump-sum loan, a daily, weekly, or monthly schedule, or a daily- or weekly-accruing floating loan.

This design keeps principal, interest, fees, penalties, waivers, external settlement credits, and additional cash advances separate. It preserves every posted record and uses preview, explicit confirmation, idempotent execution, append-only audit history, and compensating reversal.

## Product Decisions

- Add `single_payment` as a first-class repayment type with an exact `dueDate`.
- A single-payment contract records an agreed fixed-interest floor and may optionally compare that floor with retroactive interest calculated from actual posted disbursements.
- When the comparison policy applies, charge `max(fixedAgreedInterest, retroactiveInterest)` rather than adding both amounts.
- Retroactive interest continues through the settlement date. An explicitly contracted late penalty may accrue concurrently after the due date.
- If the activated contract has no late-penalty policy, no late penalty is charged.
- Settlement may waive carried interest, fees, or penalties partially or completely with an explicit reason. Principal reduction is outside this workflow and requires a separately controlled write-off or adjustment.
- Money received from a third party or another assistance channel is an external settlement payment, not a waiver.
- A restructure closes the old contract through append-only settlement records and creates a linked replacement contract. It never changes the old contract's immutable terms or posted ledger records.
- New-contract interest is calculated only on remaining old principal plus additional principal. Carried interest, fees, and penalties are never capitalized into the interest-bearing principal.
- Payment allocation order is penalties, fees, carried interest, due new interest, then principal.
- Unearned new-contract interest may be waived through an exact early-settlement preview; earned carried interest remains visible even when waived.

## Domain Model

### Repayment terms

Extend the repayment-type union to:

```ts
type RepaymentType =
  | "single_payment"
  | "daily"
  | "weekly"
  | "monthly"
  | "floating";
```

A single-payment contract adds closed, mutually validated terms:

```ts
type SinglePaymentTerms = {
  dueDate: string; // YYYY-MM-DD, later than startDate
  fixedAgreedInterest: string; // exact two-decimal amount
  interestPolicy: "fixed_only" | "greater_of_fixed_or_retroactive";
  retroactiveInterest?: {
    rateType: "percent_per_day" | "per_thousand_per_day";
    rate: string;
  };
  latePenalty:
    | { mode: "none" }
    | {
        mode: "fixed_amount_per_day";
        amountPerDay: string;
        graceDays: number;
      };
};
```

`greater_of_fixed_or_retroactive` requires `retroactiveInterest`. `fixed_only` forbids it. A late penalty can be collected only when its policy was part of the terms at activation.

Floating contracts gain an explicit accrual cycle:

```ts
type FloatingAccrualCycle = "daily" | "weekly";
```

Existing floating daily loans retain `daily` through a migration default and unchanged public behavior.

### Restructure aggregate

Add a tenant-scoped `loan_restructures` aggregate containing:

- public ID, old loan ID, and nullable new loan ID;
- settlement date and immutable old-balance version;
- gross carried principal, interest, fees, and penalties;
- waiver amounts and reasons per waivable component;
- external settlement credits;
- additional principal;
- net carried amounts and cash direction/amount;
- requested replacement terms;
- preview hash, expiry, status, execution/reversal timestamps;
- actor/source, correlation ID, idempotency context, and audit linkage.

Persist immutable `loan_opening_balance_components` for the replacement loan. Component kinds are:

```ts
type OpeningBalanceComponentKind =
  | "carried_principal"
  | "carried_interest"
  | "carried_fee"
  | "carried_penalty"
  | "additional_principal"
  | "new_contract_interest";
```

Every row stores its exact amount and source record. The sum is useful for presentation, but only `carried_principal + additional_principal` becomes replacement-loan principal.

### Status and lineage

Add `restructured` as a terminal old-loan status. The restructure aggregate is the authoritative old-to-new lineage. Both loan details expose safe public links without exposing internal IDs.

## Exact Calculation Rules

All money parsing, comparison, multiplication, rounding, and serialization use `decimal.js`. Public money values are two-decimal strings. Business dates use `Asia/Bangkok` and `YYYY-MM-DD`.

### Retroactive interest

Retroactive interest is calculated from actual posted disbursement history, not approved principal or draft payout metadata. For multiple disbursements, calculate each posted amount from its own business date. Posted principal repayments reduce the interest basis from their effective business dates. Reversed events do not contribute.

Conceptually:

```text
retroactiveInterest = sum(active principal exposure by day × contracted daily rate)
contractInterest = max(fixedAgreedInterest, retroactiveInterest)
```

The calculation result includes a trace of amount/date segments, day counts, rate, unrounded result, rounded result, selected branch, and the difference between the two candidates. The two interest candidates are alternatives and are never added together.

### Late penalty

When contracted, the late penalty begins after both the due date and configured grace period:

```text
lateDays = max(0, settlementDate - dueDate - graceDays)
latePenalty = lateDays × amountPerDay
```

Retroactive interest continues through the settlement date while the late penalty accrues for its eligible overdue days. They are separate components, both visible in preview and audit history. When no penalty was contracted, the amount is exactly `0.00` and cannot be introduced after activation.

### Settlement and waiver

The gross settlement is:

```text
outstandingPrincipal
+ contractInterest
+ outstandingFees
+ latePenalty
- postedPaymentsAndCredits
```

Preview then applies component-specific waivers:

```text
netSettlement =
  outstandingPrincipal
  + (contractInterest - waivedInterest)
  + (outstandingFees - waivedFees)
  + (latePenalty - waivedPenalty)
  - externalSettlementCredits
```

Each waiver is non-negative, cannot exceed its current component, requires a reason, and creates an append-only adjustment. Gross, waived, and net amounts remain queryable. An external payment records payer/source and normal payment allocation; it must not be represented as a waiver.

### Replacement principal and cash

```text
replacementPrincipal = outstandingPrincipal + additionalPrincipal
```

Carried interest, fees, and penalties remain non-principal opening components. Scheduled or floating interest on the replacement contract uses only `replacementPrincipal` as its basis.

Additional principal changes the approved replacement principal but is not proof of payout. Execution creates an editable disbursement draft for the additional amount. Evidence and posting continue through the existing disbursement workflow. The old carried principal does not create a new cash-payout event.

### Payment allocation and early settlement

Allocate posted replacement-loan payments in this order:

1. penalties;
2. fees;
3. carried interest;
4. due/earned new-contract interest;
5. principal.

Future new-contract interest remains unearned until its policy makes it due or accrued. An early-settlement preview shows earned interest, unearned contractual interest, proposed unearned-interest waiver, outstanding principal, and all carried balances. Execution records the waiver with reason `early_settlement_unearned_interest`; it does not mutate schedule history.

## Workflows

### Create and activate a single-payment loan

The existing `preview -> draft -> activate` lifecycle remains mandatory. Preview returns exact terms, a one-row maturity schedule, calculation policy, and warnings. Activation locks the terms and creates the immutable maturity obligation. Actual payout remains a separate posted disbursement event.

### Restructure

`loan.restructure.preview` accepts the old public loan ID, settlement date, component waivers and reasons, external settlement credits, additional principal, and complete replacement terms. The backend locks no records during preview, but it returns:

- exact old balance and balance version;
- gross, waived, credited, and net component breakdowns;
- retroactive-interest and late-penalty traces;
- replacement principal and contract calculations;
- schedule or floating policy;
- additional cash direction and amount;
- warnings, public preview ID/hash, and expiry.

The Web UI or agent displays the exact latest preview and obtains explicit human confirmation.

`loan.restructure.execute` accepts `confirmed: true`, preview public ID/hash, expected balance version, idempotency key, and reason. In one database transaction it:

1. locks and revalidates the old loan and every balance source;
2. rejects expired, stale, mismatched, duplicate-conflicting, or already-consumed previews;
3. creates append-only settlement, waiver, credit, and audit records;
4. changes the old loan to `restructured`;
5. creates and activates the replacement loan with immutable opening components;
6. creates an additional-principal disbursement draft when needed;
7. returns both public loan IDs, disbursement draft ID if applicable, audit public IDs, and correlation ID.

### Reversal

`loan.restructure.reverse` requires reason and idempotency key. It atomically checks for payments, posted/reversed disbursements, later restructures or renewals, rate changes, waivers, and other downstream financial records. If safe, it writes compensating records, restores the old loan through an audited transition, and neutralizes the replacement contract without deletion. If unsafe, it makes no changes and returns a stable error plus aggregate blocker counts.

### Later waiver

`loan.waiver.preview -> loan.waiver.execute` supports partial or full interest, fee, and penalty waiver after restructure. It uses current component versions, expiry, exact confirmation, idempotency, reason, and append-only entries. `loan.waiver.reverse` is compensating and downstream-aware. Principal is excluded from these tools.

## REST, MCP, and Plugin Contracts

REST and MCP share application services; MCP never calls REST internally. Extend the closed schemas for single-payment and floating-weekly terms. Add closed MCP tools for restructure preview/execute/reverse and waiver preview/execute/reverse.

Reads and previews are non-destructive. Execute and reverse tools are destructive and return structured data plus readable summaries. Every write returns audit public IDs and correlation ID. Agents must inspect the borrower portfolio and source loan, preview, show exact component and cash movement, obtain explicit confirmation, and execute only the matching unexpired preview. Ambiguity, stale state, unexpected variance, waiver without reason, or idempotency conflict stops for human review.

Synchronize the frozen MCP contract, CreditSync plugin manifest/version, orchestration skills, references, eval harness, scenarios, tests, and validator whenever the tool surface changes.

## Web Experience

Add `single_payment` to the loan wizard with fields for due date, fixed agreed interest, optional greater-of retroactive policy, and optional contracted daily late penalty. Preview explains that fixed and retroactive interest are alternatives and identifies the selected amount.

Loan Detail gains a localized “Settle and restructure” wizard:

1. inspect the immutable old contract and current component balances;
2. choose component waivers and enter reasons;
3. record any external settlement credit with payer/source;
4. enter additional principal;
5. select complete replacement terms;
6. review schedule/floating policy, calculation traces, waiver totals, and actual cash movement;
7. explicitly confirm execution.

After execution, both loan details show “restructured from/to” lineage. The replacement detail separately displays carried principal, additional principal, carried interest, new interest, fees, penalties, waivers, and additional-disbursement status. All labels and messages are added to Thai and English locales together and use the active i18n language for dates and amounts.

## Validation and Failure Handling

- `dueDate` must be later than `startDate`.
- Every public money input is a valid non-negative two-decimal string; rates use their declared exact precision.
- Waivers and credits cannot exceed their eligible current components.
- Fixed-only and retroactive-comparison terms are mutually exclusive by schema validation.
- A penalty absent at activation remains unavailable for that contract.
- Replacement interest cannot use carried non-principal components as its basis.
- A preview is invalid after any relevant balance, payment, disbursement, rate, or policy change.
- Additional principal never becomes a posted payout implicitly.
- Execution is atomic and idempotent; partial settlement or partial replacement creation is forbidden.
- Database constraints and triggers protect posted, reversed, activated, settled, and restructured financial history from update/delete mutation.
- Configured rate and penalty policy limits must be validated at preview and activation. Deployment requires review against the lending operation's applicable legal and policy limits.

## Migration and Compatibility

Use additive nullable columns and new tables. Backfill existing floating contracts with the daily accrual cycle without changing existing accrual results. Existing daily, weekly, monthly, floating, renewal, payment, and disbursement contracts retain their public behavior. No historical loan is inferred to be single-payment or retroactive-interest merely from having one installment.

Production migration verification checks the new columns, tables, indexes, constraints, and triggers through the PostgreSQL container and confirms successful backend migration logs without creating live financial records.

## Testing and Verification

Testing is test-first and includes:

- exact single-payment preview and one-row maturity schedule;
- greater-of fixed versus retroactive interest on both branches and at equality;
- multiple and reversed disbursements, mid-period principal payments, day boundaries, and rounding;
- optional penalty, grace days, concurrent post-due interest and penalty, and no-policy rejection;
- partial/full waiver, over-waiver rejection, external settlement classification, and allocation priority;
- replacement-principal isolation from carried interest, fees, and penalties;
- every replacement repayment type, including floating weekly;
- stale preview, balance-version conflict, idempotent retry/conflict, transaction rollback, and downstream-blocked reversal;
- early settlement with earned and unearned new interest;
- database immutability and tenant isolation;
- REST validation and frozen route composition;
- strict MCP schemas, structured responses, plugin contract, skill, eval, and validator synchronization;
- localized accessible Web wizard, exact formatting beyond JavaScript safe integers, and responsive behavior.

Financial verification runs the disposable PostgreSQL suites and backend typecheck. Frontend verification runs tests, lint, and build. Plugin verification runs its tests and validator. A skipped database suite is insufficient for these invariants.

## Documentation and Release

Update README workflow documentation because the feature materially changes loan creation, settlement, restructure, waiver, and additional-disbursement expectations. Update the root and plugin changelogs under explicit versions/dates. Document MCP tool contracts, agent confirmation boundaries, operational migration checks, and the distinction between waiver and external settlement.

## Out of Scope

- Rewriting or deleting historical contracts or posted ledger entries.
- Automatically adding a late penalty that was absent from activated terms.
- Capitalizing carried interest, fees, or penalties into interest-bearing principal.
- Waiving principal through the normal waiver workflow.
- Treating an approved additional advance as proof of actual payout.
- Selecting a retroactive-interest policy only after default when it was absent from the activated contract.
