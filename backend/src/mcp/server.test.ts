import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Elysia } from "elysia";
import { DomainError } from "../services/domain-error";
import type { CommandContext } from "../services/command-context";
import { createMcpHttpPlugin, MCP_TOOL_NAMES, type McpToolHandler } from "./server";
import type { McpRuntimeConfig } from "./security";

const TOKEN = "contract-secret";
const BORROWER_ID = "0198c481-3e2b-7000-8000-000000000001";
const INTAKE_ID = "0198c481-3e2b-7000-8000-000000000002";
const AUDIT_ID = "0198c481-3e2b-7000-8000-000000000003";

const runningApps: Array<{ stop(): Promise<unknown> | unknown }> = [];

afterEach(async () => {
    for (const app of runningApps.splice(0)) await app.stop();
});

function config(overrides: Partial<McpRuntimeConfig> = {}): McpRuntimeConfig {
    return {
        tokenHashes: [createHash("sha256").update(TOKEN).digest("hex")],
        allowedHosts: ["127.0.0.1"],
        tenantId: "tenant-fixed",
        actorEmail: "mcp-agent@example.test",
        rateLimitMax: 100,
        rateLimitWindowSeconds: 60,
        ...overrides,
    };
}

function handlers(input: Partial<Record<(typeof MCP_TOOL_NAMES)[number], McpToolHandler>>) {
    return Object.fromEntries(MCP_TOOL_NAMES.map((name) => [name, input[name] ?? (async () => ({ ok: true }))])) as Record<(typeof MCP_TOOL_NAMES)[number], McpToolHandler>;
}

function intakeFixture(status: "draft" | "posted" = "draft") {
    return {
        id: INTAKE_ID,
        publicId: INTAKE_ID,
        source: "mcp",
        status,
        amount: "100.00",
        receivedAt: "2026-08-10T00:00:00.000Z",
        payerName: null,
        bankReference: null,
        notes: null,
        postedAt: status === "posted" ? "2026-08-10T00:01:00.000Z" : null,
        createdAt: "2026-08-10T00:00:00.000Z",
        updatedAt: "2026-08-10T00:00:00.000Z",
    };
}

async function startServer(input: {
    toolHandlers?: Partial<Record<(typeof MCP_TOOL_NAMES)[number], McpToolHandler>>;
    runtimeConfig?: McpRuntimeConfig;
    logs?: Array<Record<string, unknown>>;
    auditPublicIds?: string[];
}) {
    const app = new Elysia().use(createMcpHttpPlugin({
        config: input.runtimeConfig ?? config(),
        handlers: handlers(input.toolHandlers ?? {}),
        resolvePrincipal: async ({ tenantId, actorEmail }) => {
            expect(tenantId).toBe("tenant-fixed");
            expect(actorEmail).toBe("mcp-agent@example.test");
            return { tenantId, actorUserId: 7 };
        },
        consumeRateLimit: async () => ({ allowed: true, remaining: 99, retryAfterSeconds: 0 }),
        findAuditPublicIds: async () => input.auditPublicIds ?? [AUDIT_ID],
        logger: (entry) => input.logs?.push(entry),
    })).listen({ hostname: "127.0.0.1", port: 0 });
    runningApps.push(app);
    return `http://127.0.0.1:${app.server!.port}`;
}

function clientFor(baseUrl: string, token = TOKEN) {
    const client = new Client({ name: "creditsync-contract-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    return { client, transport };
}

describe("CreditSync stateless MCP contract", () => {
    test("an actual MCP client initializes, lists every frozen tool, and calls shared handlers", async () => {
        let observedContext: CommandContext | undefined;
        const baseUrl = await startServer({
            toolHandlers: {
                "borrower.search": async (ctx, input) => {
                    observedContext = ctx;
                    return { resolution: "unique", candidates: [{ publicId: BORROWER_ID, name: String(input.query) }] };
                },
            },
        });
        const { client, transport } = clientFor(baseUrl);

        await client.connect(transport);
        expect(transport.sessionId).toBeUndefined();
        const listed = await client.listTools();
        expect(listed.tools.map((tool) => tool.name)).toEqual([...MCP_TOOL_NAMES]);
        expect(listed.tools.every((tool) => tool.outputSchema !== undefined)).toBe(true);
        expect(listed.tools.every((tool) => {
            const properties = tool.inputSchema.properties as Record<string, unknown> | undefined;
            return properties?.tenantId === undefined && properties?.actorEmail === undefined;
        })).toBe(true);
        expect(listed.tools.every((tool) => tool.annotations?.openWorldHint === false)).toBe(true);
        expect(listed.tools.every((tool) => {
            const properties = tool.outputSchema?.properties as Record<string, { const?: unknown }> | undefined;
            return properties?.schemaVersion?.const === "1.0";
        })).toBe(true);
        expect(listed.tools.find((tool) => tool.name === "borrower.search")?.annotations).toMatchObject({
            readOnlyHint: true,
            destructiveHint: false,
            openWorldHint: false,
        });
        const destructive = new Set([
            "borrower.update",
            "borrower.alias",
            "evidence.prepare",
            "evidence.finalize",
            "payment.preview",
            "payment.post",
            "payment.reverse",
            "loan.activate",
            "renewal.preview",
            "renewal.execute",
            "renewal.reverse",
        ]);
        expect(listed.tools.filter((tool) => tool.annotations?.destructiveHint).map((tool) => tool.name)).toEqual(
            MCP_TOOL_NAMES.filter((name) => destructive.has(name)),
        );

        const result = await client.callTool({ name: "borrower.search", arguments: { query: "Nok" } });
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
            schemaVersion: "1.0",
            data: { resolution: "unique" },
        });
        expect(result.content).toEqual([{ type: "text", text: "Borrower search completed." }]);
        expect(observedContext).toMatchObject({
            tenantId: "tenant-fixed",
            actorUserId: 7,
            actorSource: "mcp",
        });
        expect(observedContext?.requestId).toMatch(/^[0-9a-f-]{36}$/);
        expect(observedContext?.correlationId).toMatch(/^[0-9a-f-]{36}$/);

        await client.close();
    });

    test("requires bearer authentication and an allowlisted Host before parsing MCP payloads", async () => {
        const baseUrl = await startServer({});
        const initialize = {
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
                protocolVersion: "2025-06-18",
                capabilities: {},
                clientInfo: { name: "raw-contract", version: "1.0.0" },
            },
        };
        const noAuth = await fetch(`${baseUrl}/mcp`, {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
            body: JSON.stringify(initialize),
        });
        expect(noAuth.status).toBe(401);
        expect(await noAuth.json()).toEqual({
            error: { code: "UNAUTHORIZED", message: "Unauthorized", retryable: false, reviewRequired: false, details: {} },
        });

        const badHost = await fetch(`${baseUrl}/mcp`, {
            method: "POST",
            headers: {
                authorization: `Bearer ${TOKEN}`,
                host: "evil.example.test",
                "content-type": "application/json",
                accept: "application/json, text/event-stream",
            },
            body: JSON.stringify(initialize),
        });
        expect(badHost.status).toBe(403);
        expect(await badHost.json()).toMatchObject({ error: { code: "HOST_NOT_ALLOWED" } });
    });

    test("rejects unknown identity fields and malformed UUID or money inputs at the MCP schema boundary", async () => {
        const baseUrl = await startServer({});
        const { client, transport } = clientFor(baseUrl);
        await client.connect(transport);

        const identityInjection = await client.callTool({
            name: "borrower.search",
            arguments: { query: "Nok", tenantId: "tenant-attacker", actorEmail: "attacker@example.test" },
        });
        expect(identityInjection.isError).toBe(true);
        expect(identityInjection.content).toEqual([expect.objectContaining({ type: "text" })]);
        const malformedUuid = await client.callTool({
            name: "borrower.portfolio",
            arguments: { borrowerPublicId: "42" },
        });
        expect(malformedUuid.isError).toBe(true);
        const malformedMoney = await client.callTool({
            name: "intake.create",
            arguments: { amount: "10", receivedAt: "2026-08-10T00:00:00.000Z", idempotencyKey: "retry-1" },
        });
        expect(malformedMoney.isError).toBe(true);
        const negativeCommandMoney = await client.callTool({
            name: "intake.create",
            arguments: { amount: "-10.00", receivedAt: "2026-08-10T00:00:00.000Z", idempotencyKey: "retry-negative" },
        });
        expect(negativeCommandMoney.isError).toBe(true);
        const impossibleDate = await client.callTool({
            name: "loan.preview",
            arguments: {
                principal: "1000.00",
                interestRate: "10.00",
                termMonths: 1,
                repaymentType: "monthly",
                startDate: "2026-99-99",
            },
        });
        expect(impossibleDate.isError).toBe(true);

        await client.close();
    });

    test("passes idempotency keys only through command context and returns the same public result on retry", async () => {
        const seen = new Map<string, string>();
        const baseUrl = await startServer({
            toolHandlers: {
                "intake.create": async (ctx, input) => {
                    expect(input).not.toHaveProperty("idempotencyKey");
                    const key = ctx.idempotencyKey!;
                    const publicId = seen.get(key) ?? INTAKE_ID;
                    seen.set(key, publicId);
                    return {
                        ...intakeFixture(),
                        id: publicId,
                        publicId,
                        amount: input.amount,
                        duplicate: false,
                        duplicateReason: null,
                        warnings: [],
                    };
                },
            },
        });
        const { client, transport } = clientFor(baseUrl);
        await client.connect(transport);
        const args = {
            amount: "100.00",
            receivedAt: "2026-08-10T00:00:00.000Z",
            idempotencyKey: "payment-retry-001",
        };

        const first = await client.callTool({ name: "intake.create", arguments: args });
        const retry = await client.callTool({ name: "intake.create", arguments: args });
        expect(first.structuredContent).toMatchObject({ data: { publicId: INTAKE_ID } });
        expect(retry.structuredContent).toMatchObject({ data: { publicId: INTAKE_ID } });
        expect(seen.size).toBe(1);

        await client.close();
    });

    test("financial writes include public audit and correlation IDs and sanitize service failures", async () => {
        const logs: Array<Record<string, unknown>> = [];
        const baseUrl = await startServer({
            logs,
            toolHandlers: {
                "payment.post": async () => ({ ...intakeFixture("posted"), transactions: [] }),
                "payment.reverse": async () => {
                    throw new DomainError("REVERSAL_NOT_LATEST", "Reverse later payments first", 409, {
                        paymentIntakePublicId: INTAKE_ID,
                    });
                },
            },
        });
        const { client, transport } = clientFor(baseUrl);
        await client.connect(transport);

        const posted = await client.callTool({
            name: "payment.post",
            arguments: { paymentIntakePublicId: INTAKE_ID, proposalPublicId: BORROWER_ID },
        });
        expect(posted.structuredContent).toMatchObject({
            schemaVersion: "1.0",
            auditPublicIds: [AUDIT_ID],
        });
        expect((posted.structuredContent as Record<string, unknown>).correlationId).toMatch(/^[0-9a-f-]{36}$/);

        const reversed = await client.callTool({
            name: "payment.reverse",
            arguments: { paymentIntakePublicId: INTAKE_ID },
        });
        expect(reversed.isError).toBe(true);
        expect(reversed.structuredContent).toEqual({
            schemaVersion: "1.0",
            error: {
                code: "REVERSAL_NOT_LATEST",
                message: "Reverse later payments first",
                retryable: false,
                reviewRequired: true,
                details: { paymentIntakePublicId: INTAKE_ID },
            },
        });
        expect(JSON.stringify(logs)).not.toContain(TOKEN);
        expect(JSON.stringify(logs)).not.toContain("paymentIntakePublicId");

        await client.close();
    });

    test("does not report a financial write as successful when its public audit record is unavailable", async () => {
        const baseUrl = await startServer({
            auditPublicIds: [],
            toolHandlers: {
                "payment.post": async () => ({ ...intakeFixture("posted"), transactions: [] }),
            },
        });
        const { client, transport } = clientFor(baseUrl);
        await client.connect(transport);

        const result = await client.callTool({
            name: "payment.post",
            arguments: { paymentIntakePublicId: INTAKE_ID, proposalPublicId: BORROWER_ID },
        });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
            error: { code: "AUDIT_METADATA_UNAVAILABLE", retryable: true },
        });

        await client.close();
    });

    test("rejects a handler response that violates the public UUID output contract", async () => {
        const baseUrl = await startServer({
            toolHandlers: {
                "borrower.search": async () => ({
                    resolution: "unique",
                    matchType: "canonical",
                    candidates: [{ id: 42, publicId: 42, name: "Internal row leaked" }],
                }),
            },
        });
        const { client, transport } = clientFor(baseUrl);
        await client.connect(transport);

        const result = await client.callTool({ name: "borrower.search", arguments: { query: "Nok" } });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
            error: { code: "INVALID_TOOL_OUTPUT", retryable: false, reviewRequired: true },
        });

        await client.close();
    });

    test("exposes a non-sensitive health response without MCP credentials", async () => {
        const baseUrl = await startServer({});
        const response = await fetch(`${baseUrl}/mcp/health`);

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ status: "ok", service: "creditsync-mcp", schemaVersion: "1.0" });
    });
});
