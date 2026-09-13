import { createMcpHandler, fromJsonSchema, McpServer, ProtocolError, ProtocolErrorCode, isLegacyRequest } from "@modelcontextprotocol/server";
import type { CommandContext } from "../services/command-context";
import {
    executeMcpToolCall,
    type CreateMcpHttpPluginInput,
} from "./server";
import type { McpToolDefinition, McpToolName } from "./catalog-types";
import { toolsForProfile } from "./tool-profiles";
import { decodeCatalogCursor, encodeCatalogCursor, MCP_PAGE_SIZE } from "./catalog-pagination";

export const MODERN_PROTOCOL_VERSION = "2026-07-28" as const;
export const MODERN_CACHE_TTL_MS = 300_000;

function wireTool(tool: McpToolDefinition) {
    return {
        name: tool.name,
        title: tool.annotations.title,
        description: tool.description,
        inputSchema: structuredClone(tool.inputSchema),
        outputSchema: structuredClone(tool.outputSchema),
        annotations: structuredClone(tool.annotations),
        ...(tool._meta ? { _meta: structuredClone(tool._meta) } : {}),
    };
}

/** Build the official v2 serving entry. The legacy v1 transport remains at the
 * HTTP boundary; v2 owns modern envelope, version, resultType and cache wire
 * encoding. */
export function createModernMcpHandler(input: CreateMcpHttpPluginInput, ctx: CommandContext, catalog: readonly McpToolDefinition[], catalogVersion: string) {
    const profile = input.profile ?? "full";
    const tools = input.catalog ? [...catalog] : toolsForProfile(profile, catalog);
    return createMcpHandler(() => {
        const server = new McpServer({ name: "creditsync", version: "1.0.0" }, {
            capabilities: { tools: {} },
            instructions: "CreditSync private tenant-scoped financial workflow tools. Preview before posting financial changes.",
        });
        for (const metadata of tools) {
            const name = metadata.name as McpToolName;
            server.registerTool(name, {
                title: metadata.annotations.title,
                description: metadata.description,
                inputSchema: fromJsonSchema(metadata.inputSchema),
                annotations: metadata.annotations,
                ...(metadata._meta ? { _meta: metadata._meta } : {}),
            }, async () => ({ content: [{ type: "text", text: "" }] }));
        }
        // The product adapter does not expose a subscription stream or
        // list-changed notifications. Keep the advertised capability honest
        // after the SDK registers its default tool handler capability.
        server.server.registerCapabilities({ tools: { listChanged: false } });
        server.server.removeRequestHandler("tools/list");
        server.server.removeRequestHandler("tools/call");
        server.server.setRequestHandler("tools/list", (async (request: { params?: { cursor?: string } }) => {
            const offset = request.params?.cursor === undefined ? 0 : decodeCatalogCursor(profile, catalogVersion, request.params.cursor, tools.length);
            const page = tools.slice(offset, offset + MCP_PAGE_SIZE);
            const result: Record<string, unknown> = {
                tools: page.map(wireTool),
                ttlMs: MODERN_CACHE_TTL_MS,
                cacheScope: "public",
            };
            if (offset + page.length < tools.length) result.nextCursor = encodeCatalogCursor(profile, catalogVersion, offset + page.length);
            return result;
        }) as any);
        server.server.setRequestHandler("tools/call", (async (request: { params: { name: string; arguments?: unknown } }) => {
            const metadata = tools.find((tool) => tool.name === request.params.name);
            if (!metadata) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Tool ${request.params.name} not found`);
            const requestMeta = (request.params as { _meta?: Record<string, unknown> })._meta;
            await input.validateToolRequest?.({ toolName: metadata.name, arguments: request.params.arguments ?? {}, requestMeta });
            const parsed = await fromJsonSchema(metadata.inputSchema)["~standard"].validate(request.params.arguments ?? {});
            if (parsed.issues) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid arguments for tool ${metadata.name}`);
            return executeMcpToolCall(input, ctx, metadata.name, parsed.value);
        }) as any);
        return server;
    }, { legacy: "reject", responseMode: "json" });
}

export { isLegacyRequest };
