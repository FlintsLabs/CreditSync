# MCP Loan Schedule Deferral Design

**Date:** 2026-10-06

**Status:** Draft for user review

## Goal

Expose CreditSync's existing scheduled-installment deferral operation through the private MCP server, so an operator can explicitly defer an eligible unpaid installment from an MCP client. Deferral changes the loan schedule; it does not record or post a payment.

## Approved product decisions

- Add one destructive command, `loan.schedule.defer`.
- Reuse the existing `deferLoanSchedule` application service. The MCP handler calls application services directly and must not call the REST route.
- Require an exact loan public UUID, schedule public UUID, non-blank reason, stable idempotency key, and `confirmed: true`. The MCP input object is closed (`additionalProperties: false`). Tenant, actor, request, and correlation context come from the authenticated MCP command context.
- Keep schedule inspection in `loan.contract.get` or `loan.inspect-context`; do not add a separate preview tool. Before calling the command, the agent must show the exact loan, installment due date, amount, reason, and expected replacement date, then obtain explicit human confirmation.
- The command applies only to an active, non-floating scheduled loan and a fully unpaid schedule row (`paidTotal = 0.00`, `remainingDue > 0`). The service must re-check eligibility under its existing transaction locks. Paid, partially paid, deferred, inaccessible, stale, or otherwise ineligible rows fail without a write.
- Preserve the source row and its contractual date and amounts as history, mark it `deferred`, and set its operational remaining due to `0.00`. Create one pending replacement row at the end of the schedule, one calendar day after the current tail, with the source row's contractual principal, interest, fee, and total.
- Return the loan and source/replacement schedule public IDs, source status, replacement installment number and date, replacement amount components as two-decimal strings, and audit/correlation metadata. The standard MCP financial envelope must include at least one audit public ID.
- Invalidate the same loan cache after a successful command. Idempotent replay of the same key and same loan/schedule/reason returns the original deferral; reuse for different inputs returns an idempotency conflict.

## MCP policy and discovery

Register the tool in the typed tool-name union, dispatcher, strict input/output schemas, descriptions, and MCP metadata. Classify it as destructive, financial, audited, and idempotent: `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: true`, and `openWorldHint: false`. Keep `confirmed` as the literal `true` in the schema. Financial audit metadata must be enforced by the common MCP dispatch wrapper.

Expose the tool in `full`, `loans`, and `payments` profiles. Do not add it to `core-read`, `disbursements`, or `admin`. Regenerate the frozen MCP tool contract and profile snapshots from the actual server tool list, update the catalog version, and bump the plugin manifest/contract from the current `11.0.0` to `11.1.0` for this additive tool. Do not hand-edit generated counts or infer version values from historical notes.

## Agent workflow and safety

1. Resolve the current financial workflow with `workflow.resolve` when beginning a new intent.
2. Inspect the exact loan and schedule using `loan.contract.get` or the schedule view of `loan.inspect-context`; confirm the contract is active and scheduled, and the selected row is fully unpaid.
3. Explain that deferral moves the installment to a new date and does not mark any transfer as paid. Show the source due date and amount, proposed reason, and the expected replacement date derived from the inspected schedule tail (the next calendar day) and unchanged amount components. Obtain explicit human confirmation. The command response then confirms the backend-created replacement date and amounts.
4. Call `loan.schedule.defer` with `confirmed: true` and a stable idempotency key, then report the returned source and replacement IDs, date, amount, and audit ID.
5. If the selected row became ineligible, state changed, replay conflicts, or audit metadata is missing, stop and request review. Never silently switch to another installment.

Payment workflows may surface the explicit deferral option for an unpaid installment, but must never invoke it automatically during slip matching, payment creation, batch preview, or posting. A deferral is not a payment record, does not allocate a transfer, and does not establish that money was received. Paid installments remain closed and are not deferred.

## Plugin documentation and evaluation

Update the loan-management guidance with the inspect → show exact change → explicit confirmation → defer workflow. Update payment-reconciliation guidance only to explain when a human-requested schedule deferral is available and that it is separate from payment recording. Keep the frozen plugin manifest, skill inventory, MCP profiles, MCP contract, and validator synchronized.

Add eval coverage for: eligible unpaid row; missing/false confirmation; missing reason or idempotency key; paid and partially paid row; floating, inactive, inaccessible, already deferred, and stale schedule; idempotent replay; conflicting key reuse; replacement at schedule tail with exact contractual component strings; audit metadata; and proof that payment workflows never trigger deferral automatically.

## Scope exclusions

- No new payment intake, collection, allocation, or posting behavior.
- No automatic deferral as a fallback when a payment is missing.
- No changes to schedule calculations, repayment terms, posted transactions, or the existing REST/UI deferral behavior.
- No bulk-deferral tool and no generic “move installment” command.

## Acceptance criteria for implementation

- An MCP client can discover and call `loan.schedule.defer` only with the strict required fields and literal `confirmed: true`.
- The MCP command uses the existing domain service and returns the replacement schedule details and required audit envelope.
- Existing service eligibility, transaction locking, idempotency, tenant access, and audit behavior remain authoritative; cache invalidation matches the REST command.
- Tool safety annotations, financial policy sets, profiles, frozen contract/catalog version, plugin guidance, and eval/validator fixtures all agree with the server schema.
- Backend disposable PostgreSQL tests and typecheck, frontend test/lint/build, and plugin validation are run for the completed implementation, as applicable to affected code.
