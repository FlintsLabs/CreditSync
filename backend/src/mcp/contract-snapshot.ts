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
    _meta?: Record<string, unknown>;
};

export type FrozenMcpContract = {
    schemaVersion: "1.0";
    sourceOfTruth: string;
    compatibility: string;
    tools: FrozenMcpTool[];
};

export type ToolListPage = {
    tools: FrozenMcpTool[];
    nextCursor?: string | null;
};

/** Collect a complete tools/list walk without treating an empty cursor as
 * terminal. This is shared by snapshot clients and deliberately rejects a
 * cyclic or duplicate page instead of silently producing an incomplete
 * contract. */
export async function collectToolListPages(
    fetchPage: (cursor?: string) => Promise<ToolListPage>,
): Promise<FrozenMcpTool[]> {
    const seenCursors = new Set<string>();
    const seenNames = new Set<string>();
    const collected: FrozenMcpTool[] = [];
    let cursor: string | undefined;
    for (;;) {
        const page = await fetchPage(cursor);
        if (!page || !Array.isArray(page.tools)) throw new Error("tools/list page has no tools array");
        for (const tool of page.tools) {
            if (!tool || typeof tool.name !== "string" || seenNames.has(tool.name)) {
                throw new Error(`tools/list contains a duplicate or invalid tool name: ${String(tool?.name)}`);
            }
            seenNames.add(tool.name);
            collected.push(tool);
        }
        const nextCursor = page.nextCursor;
        if (nextCursor === undefined || nextCursor === null) return collected;
        if (typeof nextCursor !== "string" || seenCursors.has(nextCursor)) {
            throw new Error("tools/list cursor repeated or malformed");
        }
        seenCursors.add(nextCursor);
        cursor = nextCursor;
    }
}

function canonicalValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalValue);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
}

function frozenOutputSchema(schema: Record<string, unknown>) {
    // The live transport also accepts the safe error envelope. The frozen
    // plugin contract remains the success schema so eval fixtures can validate
    // their operation data without coupling them to transport failures.
    const branches = schema.anyOf;
    if (Array.isArray(branches) && branches.length > 0 && branches[0] && typeof branches[0] === "object") {
        return { $schema: "http://json-schema.org/draft-07/schema#", ...(branches[0] as Record<string, unknown>) };
    }
    return schema;
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
            allowedOrigins: [],
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
        const tools = await collectToolListPages(async (cursor) => {
            const response = await client.listTools(cursor === undefined ? undefined : { cursor });
            return {
                tools: response.tools.map((tool) => ({
                    name: tool.name,
                    ...(tool.title ? { title: tool.title } : {}),
                    ...(tool.description ? { description: tool.description } : {}),
                    inputSchema: tool.inputSchema as Record<string, unknown>,
                    ...(tool.outputSchema ? { outputSchema: frozenOutputSchema(tool.outputSchema as Record<string, unknown>) } : {}),
                    ...(tool.annotations ? { annotations: tool.annotations as Record<string, unknown> } : {}),
                    ...(tool._meta ? { _meta: tool._meta as Record<string, unknown> } : {}),
                })),
                nextCursor: response.nextCursor,
            };
        });
        return {
            schemaVersion: "1.0",
            sourceOfTruth: "Local MCP SDK Client tools/list response from backend/src/mcp/server.ts",
            compatibility: "Tool names, full input/output schemas, descriptions, annotations, and file-parameter metadata are frozen for plugin 10.2.0; breaking changes require plugin 11.0.0.",
            tools,
        };
    } finally {
        await client.close().catch(() => undefined);
        await server.close().catch(() => undefined);
    }
}
