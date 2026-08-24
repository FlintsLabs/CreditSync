# CreditSync Plugin 7.5.0

This private Codex plugin orchestrates the CreditSync MCP app for borrower and intermediary identity, payments, intermediary remittances and multi-leg disbursements, generalized floating-interest origination and settlement, effective-dated rate changes, direct loan disbursements, renewals, and append-only reversal.

## Package contract

- Plugin version: `7.5.0`
- MCP schema version: `1.0`
- 11 orchestration skills: `creditsync`, `manage-borrowers`, `reconcile-payments`, `reconcile-intermediary-remittances`, `manage-loans`, `manage-floating-interest-rates`, `settle-floating-loans`, `manage-disbursements`, `manage-intermediated-disbursements`, `renew-daily-loan`, `restructure-loan`
- App manifest: `.app.json`
- Remote endpoint: registered private app pointing to `https://<creditsync-host>/mcp`

The package does not contain an MCP URL, bearer token, `.mcp.json`, OAuth configuration, hooks, plugin UI, or funding mutation capability. It references a private registered app so credentials remain in Codex/server secret storage.

For two or more slips belonging to one resolved borrower, use `payment.batch.capture` once, then prepare/finalize the complete evidence set with `payment.batch.evidence.prepare-many` and `payment.batch.evidence.finalize-many`. Preview the complete allocation set once, stop on ambiguity or duplicates, obtain one explicit confirmation, execute with stable idempotency, and verify every posted item. Never continue a partial batch.

For settlement/restructure, resolve and inspect the borrower, call `loan.restructure.preview`, display every gross/waived/external-credit/net component plus replacement terms and cash, and execute only the exact hash/balance version after confirmation. The workflow supports both single-payment and floating-to-floating replacement contracts; floating previews snapshot projected interest and penalties through the settlement date. Additional principal is not a posted payout; any returned disbursement draft follows the separate disbursement lifecycle. Later interest/fee/penalty waivers use their own preview/confirmation flow and reason. Principal cannot be waived.

For an atomic scheduled-loan replacement, resolve and inspect the borrower, then call `loan.replacement.preview` for the active old-loan UUID and an existing funded replacement-draft UUID. Display its exact no-cash movement, correction components, old/replacement lineage, the nested named funding source, dates, expiry, hash, both versions, and every structured warning with its exact amount and correction semantics. Only an explicit human confirmation permits `loan.replacement.execute` with literal confirmation, the exact returned values, a reason, and a stable idempotency key. Never activate the draft or mutate statuses directly. Stale state or downstream activity stops the workflow; reversal is compensating-only and blocked by downstream activity.

For an actual loan disbursement, first inspect `loan.disbursement.list` and present its approved principal, net disbursed amount, and signed variance. The safe lifecycle is `loan.disbursement.draft` → optional `loan.disbursement.evidence.prepare` → unchanged-byte PUT with returned headers → `loan.disbursement.evidence.finalize` → explicit human confirmation → `loan.disbursement.post` → re-list/select the exact posted event before reversal. A prepare result with `status: ready` is already finalized and must not be PUT/finalized again; missing/expired upload data, checksum conflict, or finalize mismatch stops without posting. Keep the returned stable idempotency key for a retry of that same post only. A variance is a warning that must be shown, never conversation arithmetic or permission to alter the loan schedule. Disbursement posting records an append-only ledger event; it never mutates the approved schedule. Reversal requires a specific non-blank human reason and a different stable idempotency key, and creates a compensating ledger event rather than deleting history. Draft input deliberately rejects `evidenceFilePublicIds`; only finalized evidence can be linked to a draft.

For an actual payout routed through an intermediary, resolve exact borrower and intermediary identities, verify an active disbursement assignment, then create the group and its exact funding, borrower-payout, and advance-interest-return transfer events. Every supplied slip follows prepare → unchanged-byte PUT → finalize against its exact event, retaining and comparing the evidence/file UUID plus MIME, size, and SHA-256 at every boundary; an already-ready retry must match the same immutable metadata. Bank-account save, assignment create/end, and transfer-evidence prepare/finalize results each include the exact audit public UUID and correlation UUID; retain and report those identifiers without adding them to the corresponding REST response DTOs. Re-inspect the group and post only when every event role/reference/amount/payee and safe evidence identity matches, followed by a fresh `ready` preview with no warnings, evidence ready, retained balance `0.00`, and variance `0.00`, after explicit confirmation. Stale state, duplicate transfer, binding mismatch, missing evidence/assignment/confirmation, or unexplained retained balance stops the flow. General MCP group/list inspection returns normalized reference displays and safe per-event evidence status/count/public IDs/MIME types only; signed evidence access URLs, storage keys, and checksums remain excluded, while the prepare tool may return its short-lived upload URL.

For floating-loan settlement, inspect the portfolio and call `loan.settlement.preview` with the operator's Bangkok as-of date. Show every exact backend component, including accrued-not-due interest and already-paid `nonRefundableAdvanceInterest`, before asking for confirmation. Execute only the same settlement ID and preview hash with a reason and stable idempotency key. Stale state requires re-inspection, a fresh preview, and fresh confirmation; already-paid advance interest is never refunded or credited through settlement. Reversal requires the exact executed settlement ID, a separate reason and confirmation, and a new stable key; `loan.settlement.reverse` appends compensating negative history and stops on downstream activity.

For daily renewal, `renewal.preview` defaults to full old-contract interest and returns one authoritative composition with complete payments, received and remaining interest, structured reasoned adjustments, explicit `renewalDate` and `paymentStartDate`, and exact payout or collection. The two dates are independent Bangkok business dates; never infer that the first payment is the next day. An explicit `accrued_to_date` policy remains available. Present old-contract and replacement-contract interest separately, re-preview after every change, and never alter frozen terms during execute. Collection requires a separate `confirmedCashDirection: "collection"` acknowledgement; payout and zero-cash previews reject that field. Summary-image export is presentation-only and never executes a renewal.

## Register before installation

1. Deploy CreditSync and verify authenticated `https://<creditsync-host>/mcp` access.
2. Register that HTTPS endpoint as a private Codex app and configure its bearer credential in the private connection, never in this repository.
3. Copy the returned technical ID beginning `plugin_asdk_app`.
4. Replace `plugin_asdk_app_REPLACE_AFTER_PRIVATE_REGISTRATION` in `.app.json` with that ID.
5. Run both validators:

```bash
cd plugins/creditsync
bun test
bun run validate
cd ../..
python3 /home/flintstone/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py plugins/creditsync
```

The committed placeholder is deliberately non-runnable. Validation accepts either that documented placeholder or a syntactically valid registered `plugin_asdk_app_...` technical ID, while clearly reporting placeholder state as non-live. Local contract/eval validation does not claim that private registration or live authentication has succeeded.

## Git repository marketplace

Add the public Git repository as a non-default marketplace that tracks `main`, then install its plugin:

```bash
codex plugin marketplace add FlintsLabs/CreditSync --ref main
codex plugin add creditsync@creditsync-marketplace
```

Codex checks out a Git marketplace snapshot, reads `.agents/plugins/marketplace.json`, and resolves `./plugins/creditsync` inside that snapshot. After a validated plugin update is pushed to `main`, refresh and reinstall it:

```bash
codex plugin marketplace upgrade creditsync-marketplace
codex plugin add creditsync@creditsync-marketplace
```

Publishing to Git does not hot-reload an installed copy. Start a new Codex task after reinstalling so the updated skills and private app are discovered together. Do not hand-edit the installed marketplace snapshot.

## Operational behavior

- Inspect before every write and use backend previews instead of conversation arithmetic.
- When a payment request includes a supplied image, upload and finalize its unchanged slip evidence, verify `ready`, and complete that evidence step before `payment.preview` or `payment.post`; when no image is supplied, data-only payment capture remains supported.
- A latest `ready` payment may be posted by the agent after its exact allocations are shown.
- `needs_review`, fuzzy identity, allocation mismatch, stale preview, and unresolved renewal charges stop for human input.
- Hard duplicates return the original intake and never create a second payment.
- A fully reversed payment may be reposted only through `payment.reconcile.preview` and explicit confirmed execute when every original repayment has an exact compensating reversal and the source retains finalized ready evidence. The result identifies both the immutable reversed source and its new interest-only posted child; principal is never reduced and evidence is never copied.
- Loan activation sends a stable idempotency key, and activation and every renewal show the backend result before explicit confirmation.
- Floating origination preserves the backend's explicit day-or-week policy, including rate mode, rate, advance periods, and non-refundable treatment.
- Floating-interest changes follow list → preview → exact confirmation → idempotent execute; accrued dates and stale previews always stop the workflow.
- Floating-loan settlement follows portfolio inspect → preview → exact component display → explicit confirmation → idempotent execute. Its compensating reversal requires the exact retained settlement ID, reason, confirmation, and a separate idempotency key; stale, downstream-blocked, or non-refundable-refund requests stop without an unsafe write.
- Disbursement drafts support strict partial updates of editable metadata. Every update is followed by a re-list and fresh post confirmation; finalized evidence remains attached. Posting still shows the exact draft, evidence status, current variance, and idempotency boundary, while reversal additionally requires a reason.
- Intermediated disbursement follows exact identity and active-assignment checks → group and transfer events → per-event evidence → group inspection → zero-variance preview → explicit confirmation → idempotent post. Reversal first re-lists and inspects the exact posted group, then requires a separate reason and confirmation.
- Reversals require a reason and create compensating history rather than deletion. Renewal reversal uses same-task execute IDs plus the borrower ID retained before execution; `renewal.reverse`, not the limited portfolio view, performs the authoritative atomic downstream-activity check and may return only the backend message plus aggregate `downstreamEntryCount`.

See `references/` for matching, accounting invariants, error recovery, and the frozen full 84-tool metadata snapshot. The snapshot is generated through an authenticated local MCP SDK Client `tools/list` call. `evals/evals.json` and `evals/harness.ts` execute exact ordered/repeated tool calls, supported arguments, injected workflow states, external upload effects, and forbidden-write boundaries while remaining honest that no live private app was used.

Deployment, credential rotation, MinIO evidence, and recovery procedures are maintained in the root repository documentation:

- `docs/operations/agent-mcp-plugin.md`
- `docs/operations/backup-recovery.md`
