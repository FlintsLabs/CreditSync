import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Elysia } from "elysia";
import {
    createMcpHttpPlugin,
    MCP_TOOL_NAMES,
    type McpToolHandler,
    type McpToolName,
} from "./server";

const CONTRACT_TOKEN = "creditsync-plugin-contract-snapshot";

export type FrozenMcpTool = {
    name: string;
    title?: string;
    description?: string;
    inputSchema: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
    annotations?: Record<string, unknown>;
};

export type FrozenMcpContract = {
    schemaVersion: "1.0";
    sourceOfTruth: string;
    compatibility: string;
    tools: FrozenMcpTool[];
};

function canonicalValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalValue);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
}

export function canonicalContractJson(contract: FrozenMcpContract) {
    return `${JSON.stringify(canonicalValue(contract), null, 2)}\n`;
}

function noopHandlers(): Record<McpToolName, McpToolHandler> {
    const result = {} as Record<McpToolName, McpToolHandler>;
    for (const name of MCP_TOOL_NAMES) result[name] = async () => ({ ok: true });
    return result;
}

/**
 * Capture the public contract through the same initialize/tools-list exchange a
 * remote client uses. This deliberately does not import private schema constants
 * from the server, so registration drift changes the committed snapshot.
 */
export async function captureAdvertisedMcpContract(): Promise<FrozenMcpContract> {
    const app = new Elysia().use(createMcpHttpPlugin({
        config: {
            tokenHashes: [createHash("sha256").update(CONTRACT_TOKEN).digest("hex")],
            allowedHosts: ["127.0.0.1"],
            tenantId: "contract-snapshot-tenant",
            actorEmail: "contract-snapshot@example.test",
            rateLimitMax: 100,
            rateLimitWindowSeconds: 60,
        },
        handlers: noopHandlers(),
        resolvePrincipal: async ({ tenantId }) => ({ tenantId, actorUserId: 1 }),
        consumeRateLimit: async () => ({ allowed: true, remaining: 99, retryAfterSeconds: 0 }),
        findAuditPublicIds: async () => ["0198c481-3e2b-7000-8000-000000000001"],
        logger: () => undefined,
    })).listen({ hostname: "127.0.0.1", port: 0 });
    const client = new Client({ name: "creditsync-plugin-contract", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${app.server!.port}/mcp`),
        { requestInit: { headers: { Authorization: `Bearer ${CONTRACT_TOKEN}` } } },
    );

    try {
        await client.connect(transport);
        const response = await client.listTools();
        return {
            schemaVersion: "1.0",
            sourceOfTruth: "Authenticated local MCP SDK Client tools/list response from backend/src/mcp/server.ts",
            compatibility: "Tool names, full input/output schemas, descriptions, and annotations are frozen for plugin 4.0.0; breaking changes require plugin 5.0.0.",
            tools: response.tools.map((tool) => ({
                name: tool.name,
                ...(tool.title ? { title: tool.title } : {}),
                ...(tool.description ? { description: tool.description } : {}),
                inputSchema: tool.inputSchema as Record<string, unknown>,
                ...(tool.outputSchema ? { outputSchema: tool.outputSchema as Record<string, unknown> } : {}),
                ...(tool.annotations ? { annotations: tool.annotations as Record<string, unknown> } : {}),
            })),
        };
    } finally {
        await client.close().catch(() => undefined);
        await app.stop();
    }
}
