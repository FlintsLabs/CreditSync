# CreditSync Plugin 2.5.0

This private Codex plugin orchestrates the CreditSync MCP app for borrower identity, payments, intermediary remittances, generalized floating-interest origination and settlement, effective-dated rate changes, loan disbursements, renewals, and append-only reversal.

## Package contract

- Plugin version: `2.5.0`
- MCP schema version: `1.0`
- Skills: `creditsync`, `manage-borrowers`, `reconcile-payments`, `reconcile-intermediary-remittances`, `manage-loans`, `manage-floating-interest-rates`, `settle-floating-loans`, `manage-disbursements`, `renew-daily-loan`
- App manifest: `.app.json`
- Remote endpoint: registered private app pointing to `https://<creditsync-host>/mcp`

The package does not contain an MCP URL, bearer token, `.mcp.json`, OAuth configuration, hooks, plugin UI, or funding mutation capability. It references a private registered app so credentials remain in Codex/server secret storage.

For an actual loan disbursement, first inspect `loan.disbursement.list` and present its approved principal, net disbursed amount, and signed variance. The safe lifecycle is `loan.disbursement.draft` → optional `loan.disbursement.evidence.prepare` → unchanged-byte PUT with returned headers → `loan.disbursement.evidence.finalize` → explicit human confirmation → `loan.disbursement.post` → re-list/select the exact posted event before reversal. A prepare result with `status: ready` is already finalized and must not be PUT/finalized again; missing/expired upload data, checksum conflict, or finalize mismatch stops without posting. Keep the returned stable idempotency key for a retry of that same post only. A variance is a warning that must be shown, never conversation arithmetic or permission to alter the loan schedule. Disbursement posting records an append-only ledger event; it never mutates the approved schedule. Reversal requires a specific non-blank human reason and a different stable idempotency key, and creates a compensating ledger event rather than deleting history. Draft input deliberately rejects `evidenceFilePublicIds`; only finalized evidence can be linked to a draft.

For floating-loan settlement, inspect the portfolio and call `loan.settlement.preview` with the operator's Bangkok as-of date. Show every exact backend component, including accrued-not-due interest and already-paid `nonRefundableAdvanceInterest`, before asking for confirmation. Execute only the same settlement ID and preview hash with a reason and stable idempotency key. Stale state requires re-inspection, a fresh preview, and fresh confirmation; already-paid advance interest is never refunded or credited through settlement.

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
- A latest `ready` payment may be posted by the agent after its exact allocations are shown.
- `needs_review`, fuzzy identity, allocation mismatch, stale preview, and unresolved renewal charges stop for human input.
- Hard duplicates return the original intake and never create a second payment.
- Loan activation sends a stable idempotency key, and activation and every renewal show the backend result before explicit confirmation.
- Floating origination preserves the backend's explicit day-or-week policy, including rate mode, rate, advance periods, and non-refundable treatment.
- Floating-interest changes follow list → preview → exact confirmation → idempotent execute; accrued dates and stale previews always stop the workflow.
- Floating-loan settlement follows portfolio inspect → preview → exact component display → explicit confirmation → idempotent execute; stale or non-refundable-refund requests stop without a write.
- Disbursement drafts support strict partial updates of editable metadata. Every update is followed by a re-list and fresh post confirmation; finalized evidence remains attached. Posting still shows the exact draft, evidence status, current variance, and idempotency boundary, while reversal additionally requires a reason.
- Reversals require a reason and create compensating history rather than deletion. Renewal reversal uses same-task execute IDs plus the borrower ID retained before execution; `renewal.reverse`, not the limited portfolio view, performs the authoritative atomic downstream-activity check and may return only the backend message plus aggregate `downstreamEntryCount`.

See `references/` for matching, accounting invariants, error recovery, and the frozen full 43-tool metadata snapshot. The snapshot is generated through an authenticated local MCP SDK Client `tools/list` call. `evals/evals.json` and `evals/harness.ts` execute exact ordered/repeated tool calls, supported arguments, injected workflow states, external upload effects, and forbidden-write boundaries while remaining honest that no live private app was used.

Deployment, credential rotation, MinIO evidence, and recovery procedures are maintained in the root repository documentation:

- `docs/operations/agent-mcp-plugin.md`
- `docs/operations/backup-recovery.md`
