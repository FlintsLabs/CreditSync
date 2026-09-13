import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Elysia } from "elysia";
import type { CommandContext } from "../services/command-context";
import { createMcpHttpPlugin, MCP_CATALOG_VERSION, MCP_TOOL_NAMES, type CreateMcpHttpPluginInput, type McpToolHandler } from "./server";
import { toolNamesForProfile } from "./tool-profiles";
import type { McpRuntimeConfig } from "./security";

const TOKEN = "modern-test-secret";
const BORROWER_ID = "0198c481-3e2b-7000-8000-000000000001";
const INTAKE_ID = "0198c481-3e2b-7000-8000-000000000002";
const apps: Array<{ stop(): Promise<unknown> | unknown }> = [];

afterEach(async () => {
    for (const app of apps.splice(0)) await app.stop();
});

function startModernServer(
    observed: { input?: Record<string, unknown>; captureInput?: Record<string, unknown>; captureIdempotency?: string; calls?: number },
    profiles: readonly ("full" | "core-read")[] = ["full"],
) {
    const handlers = Object.fromEntries(MCP_TOOL_NAMES.map((name) => [name, async (ctx: CommandContext, input: Record<string, unknown>) => {
        observed.calls = (observed.calls ?? 0) + 1;
        if (name === "borrower.search") observed.input = input;
        if (name === "payment.batch.capture") {
            observed.captureInput = input;
            observed.captureIdempotency = ctx.idempotencyKey;
            return { id: BORROWER_ID, publicId: BORROWER_ID, status: "draft", version: 1, borrowerPublicId: null, stateHash: "state", confirmationHash: null, confirmedVersion: null, notes: null,
                items: [{ clientItemKey: "item-1", paymentIntakePublicId: INTAKE_ID, batchItemPublicId: BORROWER_ID, status: "draft", duplicate: false }], latestPreview: null, postedAt: null,
                createdAt: "2026-08-10T00:00:00.000Z", updatedAt: "2026-08-10T00:00:00.000Z" };
        }
        return name === "borrower.search" ? { resolution: "none", matchType: null, candidates: [] } : { ok: true };
    }])) as Record<(typeof MCP_TOOL_NAMES)[number], McpToolHandler>;
    const input: CreateMcpHttpPluginInput = {
        config: {
            tokenHashes: [createHash("sha256").update(TOKEN).digest("hex")],
            allowedHosts: ["127.0.0.1"], tenantId: "modern-test-tenant", actorEmail: "modern@example.test",
            rateLimitMax: 100, rateLimitWindowSeconds: 60, allowedOrigins: [],
        } satisfies McpRuntimeConfig,
        handlers,
        resolvePrincipal: async ({ tenantId }) => ({ tenantId, actorUserId: 7 }),
        consumeRateLimit: async () => ({ allowed: true, remaining: 99, retryAfterSeconds: 0 }),
        findAuditPublicIds: async () => ["0198c481-3e2b-7000-8000-000000000003"],
        logger: () => undefined,
    };
    const app = new Elysia();
    for (const profile of profiles) {
        app.use(createMcpHttpPlugin({ ...input, profile }, profile === "full" ? "/mcp" : `/mcp/${profile}`));
    }
    const listening = app.listen({ hostname: "127.0.0.1", port: 0 });
    apps.push(listening);
    return `http://127.0.0.1:${listening.server!.port}`;
}

function modernEnvelope(method: string, extraParams: Record<string, unknown> = {}) {
    return {
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method,
        params: {
            ...extraParams,
            _meta: {
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                "io.modelcontextprotocol/clientInfo": { name: "raw-modern-test", version: "1.0.0" },
                "io.modelcontextprotocol/clientCapabilities": {},
            },
        },
    };
}

function encodedCursor(profile: string, catalogVersion: string, offset: number) {
    return Buffer.from(JSON.stringify({ profile, catalogVersion, offset }), "utf8").toString("base64url");
}

async function rawRequest(baseUrl: string, body: Record<string, unknown>, headers: Record<string, string> = {}) {
    const method = body.method as string;
    const response = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${TOKEN}`,
            "Content-Type": "application/json",
            Accept: "application/json",
            "MCP-Protocol-Version": "2026-07-28",
            "Mcp-Method": method,
            ...(method === "tools/call" ? { "Mcp-Name": String((body.params as Record<string, unknown>).name) } : {}),
            ...headers,
        },
        body: JSON.stringify(body),
    });
    return { response, body: await response.json() as Record<string, any> };
}

describe("MCP 2026 transport adapter", () => {
    test("actual v2 client retains UUID, money, and idempotency arguments", async () => {
        const observed: { input?: Record<string, unknown>; captureInput?: Record<string, unknown>; captureIdempotency?: string } = {};
        const baseUrl = startModernServer(observed);
        const client = new Client({ name: "modern-client-test", version: "1.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
        const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } });
        await client.connect(transport);
        const discovery = await client.discover();
        expect(discovery.supportedVersions).toContain("2026-07-28");
        expect(discovery.capabilities.tools).toBeDefined();
        const listed = await client.listTools();
        expect(listed.tools.length).toBe(MCP_TOOL_NAMES.length);
        const result = await client.callTool({ name: "borrower.search", arguments: { query: "borrower" } });
        expect(result.isError).not.toBe(true);
        expect(observed.input).toEqual({ query: "borrower" });
        const capture = await client.callTool({ name: "payment.batch.capture", arguments: {
            borrowerPublicId: BORROWER_ID, notes: null, idempotencyKey: "capture-modern-1",
            items: [{ clientItemKey: "item-1", amount: "12.34", receivedAt: "2026-08-10T00:00:00.000Z", payerName: null, bankReference: null, intakeIdempotencyKey: "intake-modern-1" }],
        } });
        expect(capture.isError).not.toBe(true);
        expect(observed.captureInput).toEqual({ borrowerPublicId: BORROWER_ID, notes: null, items: [{ clientItemKey: "item-1", amount: "12.34", receivedAt: "2026-08-10T00:00:00.000Z", payerName: null, bankReference: null, intakeIdempotencyKey: "intake-modern-1" }] });
        expect(observed.captureIdempotency).toBe("capture-modern-1");
        await client.close();
    });

    test("legacy transport negotiates every SDK-supported protocol version", async () => {
        const baseUrl = startModernServer({});
        const supportedLegacyVersions = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"];
        for (const protocolVersion of supportedLegacyVersions) {
            const response = await fetch(`${baseUrl}/mcp`, {
                method: "POST",
                headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
                body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method: "initialize", params: {
                    protocolVersion, capabilities: {}, clientInfo: { name: "legacy-matrix-test", version: "1.0.0" },
                } }),
            });
            const body = await response.json() as Record<string, any>;
            expect(response.status).toBe(200);
            expect(body.result.protocolVersion).toBe(protocolVersion);
        }
    });

    test("v2 schema rejects invalid UUID/money/idempotency arguments before the service", async () => {
        const observed: { input?: Record<string, unknown>; calls?: number } = {};
        const baseUrl = startModernServer(observed);
        const client = new Client({ name: "modern-invalid-test", version: "1.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
        const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } });
        await client.connect(transport);
        await expect(client.callTool({ name: "borrower.portfolio", arguments: { borrowerPublicId: "not-a-uuid", amount: 1.25, idempotencyKey: "" } })).rejects.toThrow();
        expect(observed.calls ?? 0).toBe(0);
        await client.close();
    });

    test("raw modern pagination is opaque, bounded, profile-bound, and rejects unknown calls", async () => {
        const observed: { calls?: number } = {};
        const baseUrl = startModernServer(observed, ["full", "core-read"]);
        const first = await rawRequest(baseUrl, modernEnvelope("tools/list"));
        expect(first.response.status).toBe(200);
        expect(first.body.result.tools).toHaveLength(25);
        expect(first.body.result.resultType).toBe("complete");
        expect(first.body.result.ttlMs).toBe(300000);
        expect(first.body.result.cacheScope).toBe("public");
        expect(typeof first.body.result.nextCursor).toBe("string");

        const second = await rawRequest(baseUrl, modernEnvelope("tools/list", { cursor: first.body.result.nextCursor }));
        expect(second.body.result.tools).toHaveLength(25);
        expect(second.body.result.tools[0].name).not.toBe(first.body.result.tools[0].name);

        const emptyCursor = await rawRequest(baseUrl, modernEnvelope("tools/list", { cursor: "" }));
        expect(emptyCursor.body.error.code).toBe(-32602);

        const staleCursor = await rawRequest(baseUrl, modernEnvelope("tools/list", { cursor: encodedCursor("full", "mcp-catalog-stale", 25) }));
        expect(staleCursor.body.error.code).toBe(-32602);
        const outOfBoundsCursor = await rawRequest(baseUrl, modernEnvelope("tools/list", { cursor: encodedCursor("full", MCP_CATALOG_VERSION, MCP_TOOL_NAMES.length) }));
        expect(outOfBoundsCursor.body.error.code).toBe(-32602);

        const crossProfile = await fetch(`${baseUrl}/mcp/core-read`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${TOKEN}`,
                "Content-Type": "application/json",
                Accept: "application/json",
                "MCP-Protocol-Version": "2026-07-28",
                "Mcp-Method": "tools/list",
            },
            body: JSON.stringify(modernEnvelope("tools/list", { cursor: first.body.result.nextCursor })),
        });
        expect((await crossProfile.json() as Record<string, any>).error.code).toBe(-32602);

        const unknown = await rawRequest(baseUrl, modernEnvelope("tools/call", { name: "not-a-real-tool", arguments: {} }));
        expect(unknown.body.error.code).toBe(-32602);
        expect(observed.calls ?? 0).toBe(0);
    });

    test("legacy unknown calls are protocol errors and origin rejection precedes body parsing", async () => {
        const observed: { calls?: number } = {};
        const baseUrl = startModernServer(observed);
        const client = new Client({ name: "legacy-invalid-test", version: "1.0.0" });
        const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } });
        await client.connect(transport);
        await expect(client.callTool({ name: "not-a-real-tool", arguments: {} })).rejects.toThrow();
        await client.close();
        expect(observed.calls ?? 0).toBe(0);

        const origin = await fetch(`${baseUrl}/mcp`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${TOKEN}`,
                "Content-Type": "application/json",
                Origin: "https://not-allowed.example",
            },
            body: "{ definitely not json",
        });
        expect(origin.status).toBe(403);
        expect(await origin.json()).toMatchObject({ error: { code: "ORIGIN_NOT_ALLOWED" } });
    });

    test("legacy curated routes paginate while the full compatibility route remains unpaginated", async () => {
        const baseUrl = startModernServer({}, ["full", "core-read"]);
        const legacyRequest = async (path: string, cursor?: string) => {
            const response = await fetch(`${baseUrl}${path}`, {
                method: "POST",
                headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
                body: JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method: "tools/list", params: cursor === undefined ? {} : { cursor } }),
            });
            return { response, body: await response.json() as Record<string, any> };
        };
        const first = await legacyRequest("/mcp/core-read");
        expect(first.response.status).toBe(200);
        expect(first.body.result.tools).toHaveLength(25);
        expect(typeof first.body.result.nextCursor).toBe("string");
        const second = await legacyRequest("/mcp/core-read", first.body.result.nextCursor);
        expect(second.response.status).toBe(200);
        expect(second.body.result.tools.map((tool: { name: string }) => tool.name)).toEqual(toolNamesForProfile("core-read").slice(25));
        expect(second.body.result.nextCursor).toBeUndefined();

        const full = await legacyRequest("/mcp");
        expect(full.response.status).toBe(200);
        expect(full.body.result.tools).toHaveLength(MCP_TOOL_NAMES.length);
        expect(full.body.result.nextCursor).toBeUndefined();
    });

    test("modern envelope, version, and standard-header validation reject before dispatch", async () => {
        const observed: { calls?: number } = {};
        const baseUrl = startModernServer(observed);

        const noClientInfo = modernEnvelope("tools/list");
        delete (noClientInfo.params as Record<string, any>)._meta["io.modelcontextprotocol/clientInfo"];
        const optionalIdentity = await rawRequest(baseUrl, noClientInfo);
        expect(optionalIdentity.response.status).toBe(200);

        const malformedIdentity = modernEnvelope("tools/list");
        (malformedIdentity.params as Record<string, any>)._meta["io.modelcontextprotocol/clientInfo"] = "not-an-implementation";
        const malformed = await rawRequest(baseUrl, malformedIdentity);
        expect(malformed.response.status).toBe(400);
        expect(malformed.body.error.code).toBe(-32602);

        const missingEnvelope = await rawRequest(baseUrl, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
        expect(missingEnvelope.response.status).toBe(400);
        expect(missingEnvelope.body.error.code).toBe(-32602);

        const methodMismatch = await rawRequest(baseUrl, modernEnvelope("tools/list"), { "Mcp-Method": "tools/call" });
        expect(methodMismatch.response.status).toBe(400);
        expect(methodMismatch.body.error.code).toBe(-32020);

        const nameMismatch = await rawRequest(baseUrl, modernEnvelope("tools/call", { name: "borrower.search", arguments: { query: "ok" } }), { "Mcp-Name": "wrong-tool" });
        expect(nameMismatch.response.status).toBe(400);
        expect(nameMismatch.body.error.code).toBe(-32020);

        const unsupported = await rawRequest(baseUrl, modernEnvelope("tools/list"), { "MCP-Protocol-Version": "2099-01-01" });
        expect(unsupported.response.status).toBe(400);
        expect(unsupported.body.error).toBeDefined();
        expect(observed.calls ?? 0).toBe(0);
    });
});
