import { cleanupExpiredMcpDiagnostics } from "../src/services/mcp-diagnostic-service";

const configured = Number(process.env.MCP_DIAGNOSTIC_CLEANUP_BATCH_SIZE ?? 1_000);
const batchSize = Math.min(Math.max(Number.isFinite(configured) ? Math.trunc(configured) : 1_000, 1), 10_000);
const drain = process.argv.includes("--drain");
const started = performance.now();
let deleted = 0;
do {
    const count = await cleanupExpiredMcpDiagnostics({ limit: batchSize });
    deleted += count;
    if (!drain || count < batchSize) break;
} while (true);
console.log(JSON.stringify({ event: "mcp_diagnostic_cleanup", deleted, durationMs: Math.round(performance.now() - started) }));
