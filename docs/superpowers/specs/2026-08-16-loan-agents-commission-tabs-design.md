# Loan Agents, Commission Attribution, and Detail Tabs

## Goal

Make each loan contract easy to manage when one or more intermediaries refer or support the borrower. The loan may be activated without an agent, agents may be added later, and posted payment history must remain immutable while source attribution and commission records can be added or reversed safely.

## Loan Detail navigation

Loan Detail uses four tabs with `Information` selected by default:

- **Information** — borrower, contract status, original/outstanding principal, received interest, paid-to-date, repayment terms, funding summary, and commission totals.
- **Agents** — the contract's commission participants and their effective-dated rates.
- **Payment History** — posted payments, allocation components, payment source attribution, and commission generated for each payment.
- **Repayment Schedule** — installment due dates, principal/interest split, payment state, and commission generated from collected interest.

Tabs preserve the current loan route and do not trigger unrelated requests. Each tab owns its loading, empty, and error state.

## Agent and commission contract

Agent participation is optional. A contract can have zero, one, or many commission participants. Each participant has an effective-dated immutable version containing:

- intermediary public ID and display name/alias;
- role or referral note;
- commission rate as an exact decimal percentage string;
- effective start and optional end date;
- active/ended status and audit context.

Updating a participant ends the previous version and appends a new version. It never edits a historical rate. The sum of rates for overlapping active participants must not exceed 100%.

Commission is calculated from interest actually collected in a posted payment period:

```text
commission = collected interest component × participant rate / 100
```

Principal, fees, and penalties are excluded by default. Commission calculation is a derived, append-only period result; reversals create compensating commission records rather than mutating a paid result.

## Payment source attribution

Payment source is independent from commission eligibility. A posted payment can be:

- direct/self-paid;
- attributed entirely to one intermediary;
- split across multiple intermediaries and/or direct payment.

Attributions store the payment/transaction reference, intermediary nullable for direct payment, exact attributed amount, reason, actor, idempotency key, and audit metadata. Attribution totals cannot exceed the payment amount. Existing posted payments remain unchanged; a later attribution or reversal appends a new record. The UI displays `Unattributed` until an operator assigns a source.

An intermediary assignment on the contract is a lookup/candidate source and never silently auto-attributes historical payments.

## MCP and REST contract

Add closed, tenant-scoped commands for:

- list/add/update/end loan commission participants;
- preview/list/calculate/reverse commission periods;
- create/list/reverse payment source attributions.

Updates use append-only compensating semantics, require command context, correlation ID, actor/source, idempotency where supported, and audit public IDs. Reads return public UUIDs and exact two-decimal money strings. Destructive writes require explicit confirmation in MCP workflows.

## Loan List integration

Loan List may show the current agent name/alias as a compact label, including on overdue cards. Missing assignment is valid and displays `Unassigned`. Search can match canonical agent name and confirmed alias. This display must not infer payment source or commission eligibility.

## Validation and edge cases

- No agent is required for draft, activation, or payment posting.
- Multiple participants may share a referral chain, but active rate totals cannot exceed 100%.
- Attribution can be entered after payment posting and can be split exactly in cents.
- Attribution and commission reversals require a reason and preserve before/after audit history.
- Bangkok business timezone and Decimal-only money/rate calculations remain authoritative.

## Verification

- database tests for tenant isolation, effective-date overlap, percentage bounds, exact commission math, attribution splits, idempotency, and compensating reversal;
- authenticated REST tests for loan detail tabs and Loan List agent summaries;
- MCP schema/validator/eval coverage for every new read and write tool;
- frontend tests for all four tabs, agent empty/loading/error states, source attribution display, locale parity, and exact money formatting;
- backend disposable tests, typecheck, frontend test/lint/build, and plugin validator before integration.
