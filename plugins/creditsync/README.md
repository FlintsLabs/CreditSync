# CreditSync Plugin 2.0.0

This private Codex plugin orchestrates the CreditSync MCP app for borrower identity, optional payment evidence, matching and posting, loan preview/draft/activation, daily-loan renewal, and append-only reversal.

## Package contract

- Plugin version: `2.0.0`
- MCP schema version: `1.0`
- Skills: `creditsync`, `manage-borrowers`, `reconcile-payments`, `manage-loans`, `renew-daily-loan`
- App manifest: `.app.json`
- Remote endpoint: registered private app pointing to `https://<creditsync-host>/mcp`

The package does not contain an MCP URL, bearer token, `.mcp.json`, OAuth configuration, hooks, plugin UI, or funding mutation capability. It references a private registered app so credentials remain in Codex/server secret storage.

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
- Reversals require a reason and create compensating history rather than deletion. Renewal reversal uses same-task execute IDs plus the borrower ID retained before execution; `renewal.reverse`, not the limited portfolio view, performs the authoritative atomic downstream-activity check and may return only the backend message plus aggregate `downstreamEntryCount`.

See `references/` for matching, accounting invariants, error recovery, and the frozen full 26-tool metadata snapshot. The snapshot is generated through an authenticated local MCP SDK Client `tools/list` call. `evals/evals.json` and `evals/harness.ts` execute exact ordered/repeated tool calls, supported arguments, injected workflow states, external upload effects, and forbidden-write boundaries while remaining honest that no live private app was used.

Deployment, credential rotation, MinIO evidence, and recovery procedures are maintained in the root repository documentation:

- `docs/operations/agent-mcp-plugin.md`
- `docs/operations/backup-recovery.md`
