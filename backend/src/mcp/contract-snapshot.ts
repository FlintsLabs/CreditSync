import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
    createMcpProtocolServer,
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
 * Capture the public contract through an actual MCP initialize/tools-list
 * exchange. In-memory transport keeps contract validation independent of a
 * listening socket while exercising the same registered protocol server.
 */
export async function captureAdvertisedMcpContract(): Promise<FrozenMcpContract> {
    const input = {
        config: {
            tokenHashes: [CONTRACT_TOKEN],
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
    } satisfies Parameters<typeof createMcpProtocolServer>[0];
    const ctx = {
        tenantId: "contract-snapshot-tenant", actorUserId: 1, actorSource: "mcp" as const,
        requestId: crypto.randomUUID(), correlationId: crypto.randomUUID(),
    };
    const server = createMcpProtocolServer(input, ctx);
    const client = new Client({ name: "creditsync-plugin-contract", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    try {
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        const response = await client.listTools();
        return {
            schemaVersion: "1.0",
            sourceOfTruth: "Local MCP SDK Client tools/list response from backend/src/mcp/server.ts",
            compatibility: "Tool names, full input/output schemas, descriptions, and annotations are frozen for plugin 7.7.0; breaking changes require plugin 8.0.0.",
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
        await server.close().catch(() => undefined);
    }
}
