# MCP error diagnostics

CreditSync stores eligible MCP failures in `mcp_diagnostic_events` for 30 days. Records are tenant-scoped, contain only bounded safe breadcrumbs, and are readable through `system.error-diagnostic.get` or the filtered `system.error-diagnostic.list` tool by active tenant owners and managers.

When an MCP response includes a correlation ID, inspect that ID before retrying an unexpected, retryable, storage, network, cache, database, or external-service failure. A correlation ID never bypasses confirmation, duplicate, mismatch, stale-preview, idempotency, or human-review gates. Do not repeat a financial write with a new idempotency key.

Run the bounded daily retention job:

```sh
cd backend
bun run diagnostics:cleanup
```

The default deletes at most 1,000 expired rows. `--drain` is reserved for a controlled maintenance window and continues in bounded batches. The command emits only deletion count and duration. A missing diagnostic after a persistence timeout or failure does not prove the original command failed.

If persistence is unavailable, inspect structured container stdout events such as `mcp_diagnostic_persist_failed` using the normal deployment logging system. Do not mount a Docker socket or expose arbitrary SQL/log tools to MCP.
