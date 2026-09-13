import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Elysia } from "elysia";
import { fromJsonSchema, ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";
import { createMcpHttpPlugin, type McpToolHandler } from "../src/mcp/server";
import type { CommandContext } from "../src/services/command-context";
import type { McpRuntimeConfig } from "../src/mcp/security";
import type { McpToolDefinition } from "../src/mcp/catalog-types";
import { evaluateConformanceResult } from "../src/mcp/conformance-result";

const CONFORMANCE_REVISION = "7169291ec0b68eb370fddcd9947313ab0d5e4156";
const CONFORMANCE_VERSION = "0.2.0-alpha.11";
const TOKEN = "conformance-fixture-token";
const SCENARIOS = [
    "tools-list",
    "tools-call-simple-text",
    "tools-call-error",
    "json-schema-2020-12",
    "http-header-validation",
    "server-stateless",
] as const;

const emptyObjectSchema = { type: "object", properties: {}, additionalProperties: false } as const;

const jsonSchemaFixture = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    $defs: { address: { $anchor: "addressDef", type: "object", properties: { street: { type: "string" }, city: { type: "string" } } } },
    properties: {
        name: { type: "string" }, address: { $ref: "#/$defs/address" },
        contactMethod: { type: "string", enum: ["phone", "email"] },
        phone: { type: "string" }, email: { type: "string" },
    },
    allOf: [{ anyOf: [{ required: ["phone"] }, { required: ["email"] }] }],
    if: { properties: { contactMethod: { const: "phone" } }, required: ["contactMethod"] },
    then: { required: ["phone"] }, else: { required: ["email"] }, additionalProperties: false,
} as const;

const conformanceTools: readonly McpToolDefinition<string>[] = [
    {
        name: "test_simple_text", description: "Conformance fixture simple text",
        inputSchema: emptyObjectSchema, outputSchema: { type: "object" },
        annotations: { title: "Simple Text", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        policy: { kind: "read_only", requiresAudit: false },
    },
    {
        name: "test_error_handling", description: "Conformance fixture intentional tool error",
        inputSchema: emptyObjectSchema, outputSchema: { type: "object" },
        annotations: { title: "Error Handling", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        policy: { kind: "read_only", requiresAudit: false },
    },
    {
        name: "json_schema_2020_12_tool", description: "Tool with JSON Schema 2020-12 features",
        inputSchema: jsonSchemaFixture, outputSchema: { type: "object" },
        annotations: { title: "JSON Schema 2020-12", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        policy: { kind: "read_only", requiresAudit: false },
    },
    {
        name: "test_missing_capability", description: "Conformance fixture requiring declared sampling capability",
        inputSchema: emptyObjectSchema, outputSchema: { type: "object" },
        annotations: { title: "Missing Capability", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        policy: { kind: "read_only", requiresAudit: false },
    },
    {
        name: "test_streaming_elicitation", description: "Conformance fixture response-stream probe",
        inputSchema: emptyObjectSchema, outputSchema: { type: "object" },
        annotations: { title: "Streaming Elicitation", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        policy: { kind: "read_only", requiresAudit: false },
    },
    {
        name: "test_logging_tool", description: "Conformance fixture logging suppression probe",
        inputSchema: emptyObjectSchema, outputSchema: { type: "object" },
        annotations: { title: "Logging Tool", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        policy: { kind: "read_only", requiresAudit: false },
    },
];

async function requiredConformanceRoot() {
    const root = process.env.MCP_CONFORMANCE_ROOT;
    if (!root || !root.startsWith("/")) {
        throw new Error("MCP_CONFORMANCE_ROOT must name an absolute checkout of the pinned official conformance repository");
    }
    const packagePath = join(root, "package.json");
    if (!existsSync(packagePath)) throw new Error(`MCP_CONFORMANCE_ROOT has no package.json: ${root}`);
    const packageJson = await Bun.file(packagePath).json() as { name?: string; version?: string };
    if (packageJson.name !== "@modelcontextprotocol/conformance" || packageJson.version !== CONFORMANCE_VERSION) {
        throw new Error(`conformance checkout package mismatch: expected @modelcontextprotocol/conformance@${CONFORMANCE_VERSION}`);
    }
    const revisionResult = Bun.spawnSync(["git", "-C", root, "rev-parse", "HEAD"]);
    const revision = new TextDecoder().decode(revisionResult.stdout).trim();
    if (revisionResult.exitCode !== 0 || revision !== CONFORMANCE_REVISION) {
        throw new Error(`conformance checkout revision mismatch: expected ${CONFORMANCE_REVISION}, got ${revision || "unavailable"}`);
    }
    return root;
}

const tokenHash = createHash("sha256").update(TOKEN).digest("hex");
const fixtureCalls: string[] = [];
const fixtureHandlers: Record<string, McpToolHandler> = {
    test_simple_text: async () => { fixtureCalls.push("test_simple_text"); return { message: "This is a simple text response for testing." }; },
    test_error_handling: async () => { fixtureCalls.push("test_error_handling"); throw new Error("This tool intentionally returns an error for testing"); },
    json_schema_2020_12_tool: async (_ctx, input) => { fixtureCalls.push("json_schema_2020_12_tool"); return { echoed: input }; },
    test_missing_capability: async () => { fixtureCalls.push("test_missing_capability"); return { accepted: true }; },
    test_streaming_elicitation: async () => { fixtureCalls.push("test_streaming_elicitation"); return { streamed: true }; },
    test_logging_tool: async () => { fixtureCalls.push("test_logging_tool"); return { logged: false }; },
};
const fixtureValidators = new Map(conformanceTools.map((tool) => [tool.name, fromJsonSchema(tool.inputSchema)]));
const config: McpRuntimeConfig = {
    tokenHashes: [tokenHash], allowedHosts: ["127.0.0.1", "localhost"], tenantId: "conformance-fixture-tenant",
    actorEmail: "conformance@example.test", rateLimitMax: 100_000, rateLimitWindowSeconds: 60, allowedOrigins: [],
};
const productApp = new Elysia().use(createMcpHttpPlugin({
    config, handlers: fixtureHandlers, catalog: conformanceTools,
    parseToolInput: async (name, input) => {
        const validator = fixtureValidators.get(name);
        if (!validator) return { success: false };
        const result = await validator["~standard"].validate(input ?? {});
        return result.issues ? { success: false } : { success: true, data: result.value as Record<string, unknown> };
    },
    validateToolOutput: (_name, output) => {
        if (!output || typeof output !== "object" || Array.isArray(output)) return { success: false };
        const data = (output as Record<string, unknown>).data;
        return data && typeof data === "object" && !Array.isArray(data)
            ? { success: true, data: data as Record<string, unknown> } : { success: false };
    },
    validateToolRequest: ({ toolName, requestMeta }) => {
        if (toolName !== "test_missing_capability") return;
        const clientCapabilities = requestMeta?.["io.modelcontextprotocol/clientCapabilities"];
        if (!clientCapabilities || typeof clientCapabilities !== "object" || !("sampling" in clientCapabilities)) {
            throw new ProtocolError(ProtocolErrorCode.MissingRequiredClientCapability, "Missing required client capability", { requiredCapabilities: { sampling: {} } });
        }
    },
    resolvePrincipal: async ({ tenantId }) => ({ tenantId, actorUserId: 1 }),
    consumeRateLimit: async () => ({ allowed: true, remaining: 99_999, retryAfterSeconds: 0 }),
    findAuditPublicIds: async () => [], logger: () => undefined,
}));

const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    // Authentication is the only fixture adaptation. Bodies, MCP names,
    // versions and responses pass unchanged through the product adapter.
    fetch: (request) => {
        const headers = new Headers(request.headers);
        headers.set("authorization", `Bearer ${TOKEN}`);
        return productApp.handle(new Request(request, { headers }));
    },
});

async function runScenario(root: string, scenario: string) {
    const args = ["run", "start", "server", "--url", `http://127.0.0.1:${server.port}/mcp`, "--scenario", scenario, "--spec-version", "2026-07-28", "--timeout", "30000"];
    const child = Bun.spawn(["bun", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    const exitCode = await child.exited;
    const evaluated = evaluateConformanceResult(stdout, exitCode);
    const failures = stdout.split("\n").filter((line) => /Error:|FAILURE/.test(line)).slice(-8);
    return {
        scenario, exitCode,
        ...evaluated,
        failures, stderr: exitCode === 0 ? undefined : stderr.slice(-4000),
    };
}

async function verifyFixtureDispatch() {
    const headers = {
        authorization: `Bearer ${TOKEN}`, "content-type": "application/json", accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": "json_schema_2020_12_tool",
    };
    const body = (args: unknown) => JSON.stringify({ jsonrpc: "2.0", id: crypto.randomUUID(), method: "tools/call", params: {
        name: "json_schema_2020_12_tool", arguments: args,
        _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "fixture", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} },
    } });
    const valid = await fetch(`http://127.0.0.1:${server.port}/mcp`, { method: "POST", headers, body: body({ name: "Ada", contactMethod: "email", email: "ada@example.test" }) });
    const validBody = await valid.json() as Record<string, any>;
    const callsAfterValid = fixtureCalls.length;
    const invalid = await fetch(`http://127.0.0.1:${server.port}/mcp`, { method: "POST", headers, body: body({ name: "Ada", contactMethod: "email" }) });
    const invalidBody = await invalid.json() as Record<string, any>;
    if (valid.status !== 200 || validBody.error || callsAfterValid !== 1) throw new Error(`valid JSON Schema fixture call did not dispatch through the shared adapter: status=${valid.status} body=${JSON.stringify(validBody)} calls=${callsAfterValid}`);
    if (invalidBody.error?.code !== -32602 || fixtureCalls.length !== callsAfterValid) throw new Error("invalid JSON Schema fixture call was not rejected before dispatch");
    return { validStatus: valid.status, invalidErrorCode: invalidBody.error?.code, calls: fixtureCalls.length };
}

const root = await requiredConformanceRoot();
try {
    const fixtureDispatch = await verifyFixtureDispatch();
    const results = [];
    for (const scenario of SCENARIOS) results.push(await runScenario(root, scenario));
    const failed = results.filter((result) => !result.passed);
    console.log(JSON.stringify({
        upstream: { revision: CONFORMANCE_REVISION, version: CONFORMANCE_VERSION, checkout: root },
        fixture: { tenant: "synthetic-only", adapter: "CreditSync Elysia boundary + shared dispatcher", catalogTools: conformanceTools.map((tool) => tool.name), noDatabaseSideEffects: true, dispatchCheck: fixtureDispatch },
        scenarios: results,
        summary: { scenarios: results.length, passedScenarios: results.length - failed.length, failedScenarios: failed.length, checks: results.reduce((sum, result) => sum + (result.checks?.denominator ?? 0), 0), passedChecks: results.reduce((sum, result) => sum + (result.checks?.passed ?? 0), 0), failedChecks: results.reduce((sum, result) => sum + (result.checks?.failed ?? 0), 0) },
    }, null, 2));
    if (failed.length > 0) process.exitCode = 1;
} finally {
    server.stop(true);
}
