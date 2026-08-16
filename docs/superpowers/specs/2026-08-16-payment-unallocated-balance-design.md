# Payment Unallocated Balance Design

## Goal

Support a transfer whose amount exceeds the amount assigned to a loan installment. The full receipt remains accounted for, while the excess is held in a tenant-scoped, append-only balance that can be allocated later after a preview and explicit confirmation.

Example: a THB 190.00 receipt allocates THB 150.00 to the current installment and holds THB 40.00 for later allocation.

## Design

Add a `payment_unallocated_balances` ledger linked to the original payment intake. Each balance row records the original amount, current remaining amount, status (`held`, `partially_allocated`, `allocated`, or `reversed`), reason/note, and audit metadata. Later allocations are separate immutable rows linked to the balance and the resulting posted transaction/proposal. No posted intake or transaction is edited.

Payment preview will accept an allocation total less than or equal to the intake amount. A ready proposal is allowed only when the difference is explicitly represented as a held remainder; under-allocation without that explicit mode remains `needs_review`. Posting creates normal repayment transactions for the allocated portion and a held balance for the remainder in one database transaction. Existing exact-match and over-obligation protections remain unchanged.

Add a read endpoint/MCP operation to list held balances by borrower, loan, intake, and status. Add a preview operation for allocating a selected held balance to one or more explicit loan schedules, checking current balance, ownership, idempotency, and stale proposal state. A confirmed allocation posts compensating ledger entries and reduces the held remainder; it may not exceed the remaining balance or schedule obligation.

Reversal of the original payment reverses its repayment transactions and the associated held balance. Reversal of a later held-balance allocation creates a compensating allocation reversal and restores the held remainder. All writes retain request/correlation context, idempotency, and audit records.

## API and UI

- Extend payment preview/post results with `allocatedTotal`, `unallocatedTotal`, and held-balance public summaries.
- Add MCP schemas for listing held balances, previewing a held-balance allocation, and posting the confirmed allocation.
- Add Thai labels using “รายการกลับบัญชี” terminology and “ยอดพักรอจัดสรร”.
- Payment inbox and loan repayment history show the held amount separately from installment repayment; no amount is silently treated as a future installment.

## Migration and compatibility

Create a forward-only migration and Drizzle schema for the held-balance ledger. Existing posted intakes receive no synthetic held balances. Existing payment previews that allocate the full intake behave exactly as before.

## Verification

Cover service and database invariants for:

1. THB 190.00 receipt → THB 150.00 repayment + THB 40.00 held.
2. Held THB 40.00 is visible and can be allocated once, but not twice.
3. Partial held allocation leaves the exact remainder.
4. Over-allocation, stale proposals, duplicate idempotency keys, and wrong-owner access are rejected.
5. Original-payment and later-allocation reversals restore the correct held balance through compensating entries.
6. MCP/REST output contracts and frontend localization remain valid.

