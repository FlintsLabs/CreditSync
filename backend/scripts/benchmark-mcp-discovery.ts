import { createHash } from "node:crypto";
import { Elysia } from "elysia";
import { createMcpHttpPlugin, MCP_TOOL_NAMES, legacyDiscoveryProjectionForBenchmark, mcpSchemaMetrics, type McpToolHandler, type ToolProfile } from "../src/mcp/server";
import type { CommandContext } from "../src/services/command-context";
import type { McpRuntimeConfig } from "../src/mcp/security";
import { toolNamesForProfile } from "../src/mcp/tool-profiles";

const token = "benchmark-only-token";
const handlers = Object.fromEntries(MCP_TOOL_NAMES.map((name) => [
    name,
    (async (_ctx: CommandContext, _input: Record<string, unknown>) => ({ ok: true })) satisfies McpToolHandler,
])) as Record<(typeof MCP_TOOL_NAMES)[number], McpToolHandler>;
const config: McpRuntimeConfig = {
    tokenHashes: [createHash("sha256").update(token).digest("hex")],
    allowedHosts: ["benchmark.local"],
    tenantId: "benchmark-tenant",
    actorEmail: "benchmark@example.test",
    rateLimitMax: 100_000,
    rateLimitWindowSeconds: 60,
    allowedOrigins: [],
};
const pluginInput = {
    config,
    handlers,
    resolvePrincipal: async ({ tenantId }) => ({ tenantId, actorUserId: 1 }),
    consumeRateLimit: async () => ({ allowed: true, remaining: 99_999, retryAfterSeconds: 0 }),
    findAuditPublicIds: async () => ["0198c481-3e2b-7000-8000-000000000001"],
    logger: () => undefined,
};
const profiles = ["full", "core-read", "payments", "loans", "disbursements", "admin"] as const satisfies readonly ToolProfile[];
const app = new Elysia().use(createMcpHttpPlugin(pluginInput));
for (const profile of profiles.slice(1)) app.use(createMcpHttpPlugin({ ...pluginInput, profile }, `/mcp/${profile}`));

function modernListBody(cursor?: string) {
    return {
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method: "tools/list",
        params: {
            ...(cursor === undefined ? {} : { cursor }),
            _meta: {
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                "io.modelcontextprotocol/clientInfo": { name: "creditsync-discovery-benchmark", version: "1.0.0" },
                "io.modelcontextprotocol/clientCapabilities": {},
            },
        },
    };
}

async function request(path: string, body: Record<string, unknown>, modern: boolean) {
    const headers: Record<string, string> = {
        host: "benchmark.local",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
    };
    if (modern) {
        headers["mcp-protocol-version"] = "2026-07-28";
        headers["mcp-method"] = "tools/list";
    }
    const response = await app.handle(new Request(`http://benchmark.local${path}`, {
        method: "POST", headers, body: JSON.stringify(body),
    }));
    const bytes = (await response.clone().arrayBuffer()).byteLength;
    return { response, bytes, body: await response.json() as Record<string, any> };
}

async function completeModernDiscovery(profile: ToolProfile) {
    let cursor: string | undefined;
    let pages = 0;
    let bytes = 0;
    let tools = 0;
    do {
        const result = await request(profile === "full" ? "/mcp" : `/mcp/${profile}`, modernListBody(cursor), true);
        if (result.response.status !== 200) throw new Error(`modern tools/list failed: ${result.response.status}`);
        pages += 1;
        bytes += result.bytes;
        tools += result.body.result.tools.length;
        cursor = result.body.result.nextCursor;
    } while (cursor !== undefined);
    return { pages, bytes, tools };
}

async function main() {
    const schemaProjection = profiles.map((profile) => {
        const uncachedStart = performance.now();
        const uncached = legacyDiscoveryProjectionForBenchmark(profile, true);
        const uncachedMs = performance.now() - uncachedStart;
        const cachedStart = performance.now();
        const cached = legacyDiscoveryProjectionForBenchmark(profile);
        const cachedMs = performance.now() - cachedStart;
        return {
            profile,
            uncachedMs: Math.round(uncachedMs * 100) / 100,
            cachedMs: Math.round(cachedMs * 100) / 100,
            uncachedBytes: Buffer.byteLength(JSON.stringify(uncached)),
            cachedBytes: Buffer.byteLength(JSON.stringify(cached)),
        };
    });
    const before = mcpSchemaMetrics();
    const discovery = [];
    for (const profile of profiles) {
        const coldStart = performance.now();
        const cold = await completeModernDiscovery(profile);
        const coldMs = performance.now() - coldStart;
        const warmStart = performance.now();
        const warm = await completeModernDiscovery(profile);
        const warmMs = performance.now() - warmStart;
        if (cold.tools !== warm.tools || cold.tools !== toolNamesForProfile(profile).length) throw new Error(`complete discovery did not collect the exact ${profile} profile`);
        discovery.push({ profile, coldMs: Math.round(coldMs * 100) / 100, warmMs: Math.round(warmMs * 100) / 100, cold, warm });
    }
    const legacy = await request("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, false);
    const after = mcpSchemaMetrics();
    if (after.schemaGenerationCount !== before.schemaGenerationCount) throw new Error("tools/list caused schema generation");
    console.log(JSON.stringify({
        catalogTools: MCP_TOOL_NAMES.length,
        modern: discovery,
        legacy: { status: legacy.response.status, bytes: legacy.bytes, tools: legacy.body.result?.tools?.length ?? null },
        schemaProjection,
        schemaGenerationCount: { before: before.schemaGenerationCount, after: after.schemaGenerationCount, perRequestDelta: after.schemaGenerationCount - before.schemaGenerationCount },
    }, null, 2));
}

await main();
