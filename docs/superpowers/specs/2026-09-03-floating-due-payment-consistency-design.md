# Floating Due Payment Consistency Design

## Goal

For a floating loan, the amount and components displayed as due must be the
same components that are posted after confirmation. A stale quote must stop
posting rather than silently redirecting cash into principal.

## Scope

- Make the payment-preview response expose an authoritative component quote
  for every floating allocation.
- Make payment posting validate that component quote against the locked,
  current financial state.
- Keep payment health and posting based on the same floating-accrual rules.
- Repair the public MCP schema for restore previews so a reversed payment can
  be restored through the evidence-backed workflow.

## Behaviour

The backend returns, for each floating allocation, exact decimal strings for
`principal`, `interest`, `fee`, and `penalty`. The sum is the allocation
amount. The proposal hash includes the components and the state hash includes
the floating accrual state.

On post, the backend recomputes components under the transaction locks. If
they differ from the approved proposal, the proposal becomes stale and no
financial transaction is written. It never posts a different component split.

The UI must present this returned split before the operator confirms. A
floating `due_today` amount is therefore either quoted as interest or rejected
as stale; it cannot be displayed as interest and posted as principal.

## Safety

- Monetary fields remain two-decimal strings and use `FinancialDecimal`.
- Posted records remain immutable; any correction is a compensating workflow.
- No existing financial records are rewritten by this change.

## Acceptance Criteria

1. A weekly floating loan with 600.00 due previews and posts
   `interest=600.00`, `principal=0.00`.
2. A changed floating component split makes the proposal stale before a
   transaction is created.
3. The loan-list due badge and payment quote agree for the same Bangkok date.
4. Restore previews pass their MCP output validator.
