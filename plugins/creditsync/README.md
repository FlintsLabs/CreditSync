# CreditSync Plugin 2.1.0

This private Codex plugin orchestrates the CreditSync MCP app for borrower identity, optional payment and loan-disbursement evidence, matching and posting, loan preview/draft/activation, daily-loan renewal, and append-only reversal.

## Package contract

- Plugin version: `2.1.0`
- MCP schema version: `1.0`
- Skills: `creditsync`, `manage-borrowers`, `reconcile-payments`, `manage-loans`, `manage-disbursements`, `renew-daily-loan`
- App manifest: `.app.json`
- Remote endpoint: registered private app pointing to `https://<creditsync-host>/mcp`

The package does not contain an MCP URL, bearer token, `.mcp.json`, OAuth configuration, hooks, plugin UI, or funding mutation capability. It references a private registered app so credentials remain in Codex/server secret storage.

For an actual loan disbursement, first inspect `loan.disbursement.list` and present its approved principal, net disbursed amount, and signed variance. The safe lifecycle is `loan.disbursement.draft` → optional `loan.disbursement.evidence.prepare` → unchanged-byte PUT with returned headers → `loan.disbursement.evidence.finalize` → explicit human confirmation → `loan.disbursement.post` → re-list/select the exact posted event before reversal. A prepare result with `status: ready` is already finalized and must not be PUT/finalized again; missing/expired upload data, checksum conflict, or finalize mismatch stops without posting. Keep the returned stable idempotency key for a retry of that same post only. A variance is a warning that must be shown, never conversation arithmetic or permission to alter the loan schedule. Disbursement posting records an append-only ledger event; it never mutates the approved schedule. Reversal requires a specific non-blank human reason and a different stable idempotency key, and creates a compensating ledger event rather than deleting history. Draft input deliberately rejects `evidenceFilePublicIds`; only finalized evidence can be linked to a draft.

## Register before installation

1. Deploy CreditSync and verify authenticated `https://<creditsync-host>/mcp` access.
2. Register that HTTPS endpoint as a private Codex app and configure its bearer credential in the private connection, never in this repository.
3. Copy the returned technical ID beginning `plugin_asdk_app`.
4. Replace `plugin_asdk_app_REPLACE_AFTER_PRIVATE_REGISTRATION` in `.app.json` with that ID.
5. Run both validators:

```bash
bun run plugins/creditsync/scripts/validate.ts
python3 /home/flintstone/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py plugins/creditsync
```

The committed placeholder is deliberately non-runnable. Validation accepts either that documented placeholder or a syntactically valid registered `plugin_asdk_app_...` technical ID, while clearly reporting placeholder state as non-live. Local contract/eval validation does not claim that private registration or live authentication has succeeded.

## Repository marketplace

From a checkout of this repository, add the non-default local marketplace and install its plugin:

```bash
codex plugin marketplace add /absolute/path/to/CreditSync
codex plugin add creditsync@personal
```

Start a new Codex task after installation so plugin skills and the private app are discovered together. For an updated local build, use the plugin-creator cachebuster/reinstall workflow; do not hand-edit an installed marketplace snapshot.

## Operational behavior

- Inspect before every write and use backend previews instead of conversation arithmetic.
- A latest `ready` payment may be posted by the agent after its exact allocations are shown.
- `needs_review`, fuzzy identity, allocation mismatch, stale preview, and unresolved renewal charges stop for human input.
- Hard duplicates return the original intake and never create a second payment.
- Loan activation and every renewal show the backend result before explicit confirmation.
- Disbursement posting shows the exact draft, evidence status, current variance, and idempotency boundary before explicit confirmation; a disbursement reversal additionally requires a reason.
- Reversals require a reason and create compensating history rather than deletion. Renewal reversal uses same-task execute IDs plus the borrower ID retained before execution; `renewal.reverse`, not the limited portfolio view, performs the authoritative atomic downstream-activity check and may return only the backend message plus aggregate `downstreamEntryCount`.

See `references/` for matching, accounting invariants, error recovery, and the frozen full 26-tool metadata snapshot. The snapshot is generated through an authenticated local MCP SDK Client `tools/list` call. `evals/evals.json` and `evals/harness.ts` execute exact ordered/repeated tool calls, supported arguments, injected workflow states, external upload effects, and forbidden-write boundaries while remaining honest that no live private app was used.

Deployment, credential rotation, MinIO evidence, and recovery procedures are maintained in the root repository documentation:

- `docs/operations/agent-mcp-plugin.md`
- `docs/operations/backup-recovery.md`
