import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { fromJsonSchema } from "@modelcontextprotocol/server";
import { Elysia } from "elysia";
import { DomainError } from "../services/domain-error";
import type { CommandContext } from "../services/command-context";
import { advertisedMcpToolMetadata, createMcpHttpPlugin, MCP_CATALOG_VERSION, MCP_TOOL_NAMES, type McpToolHandler } from "./server";
import { TOOL_PROFILES, toolsForProfile, toolNamesForProfile } from "./tool-profiles";

const catalog = advertisedMcpToolMetadata();
const catalogByName = new Map(catalog.map((tool) => [tool.name, tool]));
const PROFILE_TEST_TOKEN = "profile-routing-test-token";
const PROFILE_TEST_UUID = "0198c481-3e2b-7000-8000-000000000001";
const PROFILE_TEST_HASH = `v1:${"a".repeat(64)}`;

type JsonSchema = Record<string, any>;

function schemaFixture(schema: JsonSchema, root = schema): any {
    if (schema.$ref) {
        const path = String(schema.$ref).replace(/^#\/$/u, "").split("/").filter(Boolean);
        let target: any = root;
        for (const part of path.slice(1)) target = target?.[part];
        return target ? schemaFixture(target, root) : {};
    }
    if (schema.const !== undefined) return schema.const;
    if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
    for (const branch of [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])]) {
        if (branch.type !== "null") return schemaFixture(branch, root);
    }
    if (Array.isArray(schema.allOf)) {
        return schema.allOf.reduce((value: any, branch: JsonSchema) => {
            const next = schemaFixture(branch, root);
            return value && next && typeof value === "object" && typeof next === "object" && !Array.isArray(value) && !Array.isArray(next)
                ? { ...value, ...next } : value ?? next;
        }, {});
    }
    const type = Array.isArray(schema.type) ? schema.type.find((candidate: string) => candidate !== "null") : schema.type;
    if (type === "object" || schema.properties) {
        const result: Record<string, unknown> = {};
        for (const name of schema.required ?? Object.keys(schema.properties ?? {})) {
            if (schema.properties?.[name]) result[name] = schemaFixture(schema.properties[name], root);
        }
        return result;
    }
    if (type === "array") return Array.from({ length: schema.minItems ?? 0 }, () => schemaFixture(schema.items ?? {}, root));
    if (type === "integer" || type === "number") return schema.minimum ?? 0;
    if (type === "boolean") return false;
    if (schema.format === "uuid") return PROFILE_TEST_UUID;
    if (schema.format === "date-time") return "2026-09-13T00:00:00.000Z";
    if (schema.format === "date") return "2026-09-13";
    if (schema.format === "uri" || schema.format === "uri-reference") return "https://files.example.test/synthetic";
    if (schema.format === "email") return "profile@example.test";
    if (typeof schema.pattern === "string" && schema.pattern.includes("{64}")) return "a".repeat(64);
    if (typeof schema.pattern === "string" && schema.pattern.includes("v1:")) return PROFILE_TEST_HASH;
    if (typeof schema.pattern === "string" && /\\d\{2\}/u.test(schema.pattern)) return "0.00";
    return "synthetic";
}

const outputFixtures: Map<string, any> = new Map(catalog.map((tool) => [tool.name as string, schemaFixture((tool.outputSchema as JsonSchema).properties?.data as JsonSchema | undefined ?? tool.outputSchema)]));

function outputFixture(name: string) {
    const fixture = outputFixtures.get(name);
    if (fixture === undefined) throw new Error(`No output fixture for ${name}`);
    return structuredClone(fixture);
}

function modernRequest(method: string, params: Record<string, unknown>) {
    return {
        jsonrpc: "2.0", id: crypto.randomUUID(), method,
        params: {
            ...params,
            _meta: {
                "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                "io.modelcontextprotocol/clientInfo": { name: "profile-routing-test", version: "1.0.0" },
                "io.modelcontextprotocol/clientCapabilities": {},
            },
        },
    };
}

describe("MCP catalog and profiles", () => {
    test("has one canonical definition for every current tool", () => {
        expect(MCP_TOOL_NAMES).toEqual(expect.arrayContaining([
            "loan.disbursement.evidence.import-chatgpt-file", "borrower.resolve-and-portfolio",
            "loan.inspect-context", "payment.match-context",
        ]));
        expect(new Set(MCP_TOOL_NAMES).size).toBe(MCP_TOOL_NAMES.length);
        expect(catalog).toHaveLength(MCP_TOOL_NAMES.length);
        expect(catalog.map((tool) => tool.name)).toEqual([...MCP_TOOL_NAMES]);
        expect(MCP_CATALOG_VERSION).toMatch(/^mcp-catalog-[0-9a-f]{16}$/);
    });

    test("profile snapshots are exact, closed, and cover the full catalog", () => {
        const union = new Set<string>();
        for (const [profile, names] of Object.entries(TOOL_PROFILES)) {
            expect(new Set(names).size).toBe(names.length);
            for (const name of names) {
                expect(catalogByName.has(name)).toBe(true);
                if (profile !== "full") union.add(name);
            }
            expect(toolsForProfile(profile as keyof typeof TOOL_PROFILES, catalog).map((tool) => tool.name)).toEqual([...names]);
            expect(toolNamesForProfile(profile as keyof typeof TOOL_PROFILES)).toEqual([...names]);
        }
        expect([...union].sort()).toEqual([...MCP_TOOL_NAMES].sort());
    });

    test("curated profiles contain the dependencies of their representative workflows", () => {
        const has = (profile: keyof typeof TOOL_PROFILES, ...names: string[]) => {
            const available = new Set<string>(toolNamesForProfile(profile));
            for (const name of names) expect(available.has(name)).toBe(true);
        };
        has("payments", "intake.get", "intake.create", "evidence.prepare", "evidence.finalize", "payment.preview", "payment.post", "payment.reverse");
        has("loans", "borrower.search", "loan.preview", "loan.draft", "loan.activate", "loan.disbursement.draft", "loan.disbursement.evidence.prepare", "loan.disbursement.evidence.finalize", "loan.disbursement.evidence.import-chatgpt-file");
        has("disbursements", "loan.disbursement.list", "loan.disbursement.draft", "loan.disbursement.evidence.prepare", "loan.disbursement.evidence.finalize", "loan.disbursement.post", "loan.disbursement.reverse", "intermediary.disbursement.preview", "intermediary.disbursement.post");
        has("admin", "system.error-diagnostic.get", "system.error-diagnostic.list", "funding-source.list", "funding-allocation.list", "loan.commission.list", "loan.commission.calculate");
        has("core-read", "borrower.search", "borrower.portfolio", "intake.get", "loan.contract.get", "loan.payment-history.list", "loan.disbursement.list", "system.error-diagnostic.list");
        has("disbursements", "intermediary.collection.list", "intermediary.collection.create", "intermediary.collection.cancel", "intermediary.remittance.get", "intermediary.remittance.create", "intermediary.remittance.allocations.save", "intermediary.remittance.preview", "intermediary.remittance.evidence.prepare", "intermediary.remittance.evidence.finalize", "intermediary.remittance.post");
    });

    test("replays valid representative workflows through all profiles, stops after evidence failure, and denies out-of-profile calls", async () => {
        const tokenHash = createHash("sha256").update(PROFILE_TEST_TOKEN).digest("hex");
        const buildApp = (failEvidence = false) => {
            const calls: string[] = [];
            const handlers = Object.fromEntries(MCP_TOOL_NAMES.map((name) => [name, (async () => {
                calls.push(name);
                if (failEvidence && name === "evidence.prepare") throw new DomainError("EVIDENCE_FIXTURE_FAILED", "Synthetic evidence failure", 422);
                return outputFixture(name);
            }) satisfies McpToolHandler])) as Record<string, McpToolHandler>;
            const app = new Elysia();
            for (const profile of ["core-read", "payments", "loans", "disbursements", "admin"] as const) {
                app.use(createMcpHttpPlugin({
                    config: { tokenHashes: [tokenHash], allowedHosts: ["profile.test"], tenantId: "profile-test-tenant", actorEmail: "profile@example.test", rateLimitMax: 100, rateLimitWindowSeconds: 60, allowedOrigins: [] },
                    profile, handlers,
                    resolvePrincipal: async ({ tenantId }) => ({ tenantId, actorUserId: 1 }),
                    consumeRateLimit: async () => ({ allowed: true, remaining: 99, retryAfterSeconds: 0 }),
                    findAuditPublicIds: async () => [PROFILE_TEST_UUID], logger: () => undefined,
                }, `/mcp/${profile}`));
            }
            return { app, calls };
        };
        const { app, calls } = buildApp();
        const replay = async (target: { app: Elysia; calls: string[] }, profile: keyof typeof TOOL_PROFILES, steps: Array<[string, Record<string, unknown>]>, stopOnError = false) => {
            for (const [name, params] of steps) {
                expect(toolNamesForProfile(profile)).toContain(name as any);
                const response = await target.app.handle(new Request(`http://profile.test/mcp/${profile}`, {
                    method: "POST",
                    headers: { host: "profile.test", authorization: `Bearer ${PROFILE_TEST_TOKEN}`, "content-type": "application/json", accept: "application/json", "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": name },
                    body: JSON.stringify(modernRequest("tools/call", { name, arguments: params })),
                }));
                const body = await response.json() as Record<string, any>;
                expect(response.status).toBe(200);
                if (stopOnError && body.result?.isError) break;
                expect(body.error).toBeUndefined();
                if (body.result?.isError) throw new Error(`schema-valid replay failed for ${profile}/${name}: ${JSON.stringify(body.result.structuredContent ?? body.result)}`);
                const metadata = catalogByName.get(name as (typeof MCP_TOOL_NAMES)[number])!;
                const expectedWire = {
                    schemaVersion: "1.0",
                    data: outputFixture(name),
                    ...(metadata.policy.requiresAudit && name !== "payment.allocation-correction.execute" ? { correlationId: PROFILE_TEST_UUID, auditPublicIds: [PROFILE_TEST_UUID] } : {}),
                };
                const validation = await fromJsonSchema(metadata.outputSchema)["~standard"].validate(expectedWire);
                expect(validation.issues, `${profile}/${name} output fixture must satisfy the advertised schema`).toBeUndefined();
            }
        };
        // Routing/workflow replay only: handlers and output fixtures are
        // synthetic, so this proves profile routing and declared dependencies,
        // not database service parity.
        await replay({ app, calls }, "core-read", [["borrower.search", { query: "synthetic" }], ["borrower.portfolio", { borrowerPublicId: PROFILE_TEST_UUID }], ["loan.contract.get", { loanPublicId: PROFILE_TEST_UUID }]]);
        await replay({ app, calls }, "payments", [["intake.get", { paymentIntakePublicId: PROFILE_TEST_UUID }], ["payment.match-context", { paymentIntakePublicId: PROFILE_TEST_UUID }], ["payment.preview", { paymentIntakePublicId: PROFILE_TEST_UUID }], ["payment.post", { paymentIntakePublicId: PROFILE_TEST_UUID, proposalPublicId: PROFILE_TEST_UUID }]]);
        await replay({ app, calls }, "loans", [["loan.contract.get", { loanPublicId: PROFILE_TEST_UUID }], ["loan.disbursement.draft", { loanPublicId: PROFILE_TEST_UUID, grossAmount: "100.00", loanAttributedAmount: "100.00", channel: "bank_transfer", disbursedAt: "2026-09-13T00:00:00.000Z" }], ["loan.disbursement.evidence.prepare", { disbursementPublicId: PROFILE_TEST_UUID, mimeType: "image/png", size: 100, sha256: "a".repeat(64) }], ["loan.disbursement.evidence.finalize", { disbursementPublicId: PROFILE_TEST_UUID, evidencePublicId: PROFILE_TEST_UUID }], ["loan.disbursement.post", { disbursementPublicId: PROFILE_TEST_UUID, idempotencyKey: "profile-disbursement-post-1" }]]);
        await replay({ app, calls }, "disbursements", [["intermediary.profile.get", { intermediaryPublicId: PROFILE_TEST_UUID }], ["intermediary.collection.list", { intermediaryPublicId: PROFILE_TEST_UUID }], ["intermediary.collection.cancel", { collectionPublicId: PROFILE_TEST_UUID, expectedStateHash: "a".repeat(64), reason: "synthetic test", idempotencyKey: "profile-collection-cancel-1" }], ["intermediary.remittance.create", { intermediaryPublicId: PROFILE_TEST_UUID, grossAmount: "100.00", receivedAt: "2026-09-13T00:00:00.000Z", idempotencyKey: "profile-remittance-create-1" }], ["intermediary.remittance.get", { remittancePublicId: PROFILE_TEST_UUID }], ["intermediary.remittance.allocations.save", { remittancePublicId: PROFILE_TEST_UUID, collectionPublicIds: [PROFILE_TEST_UUID] }], ["intermediary.remittance.preview", { remittancePublicId: PROFILE_TEST_UUID }], ["intermediary.remittance.post", { remittancePublicId: PROFILE_TEST_UUID, proposalPublicId: PROFILE_TEST_UUID, confirmed: true, idempotencyKey: "profile-remittance-post-1" }]]);
        await replay({ app, calls }, "admin", [["funding-source.list", { status: "active" }], ["funding-allocation.preview", { allocatedAmount: "100.00", allocationDate: "2026-09-13", loanPublicId: PROFILE_TEST_UUID, bankProfilePublicId: PROFILE_TEST_UUID }], ["funding-allocation.list", { loanPublicId: PROFILE_TEST_UUID }]]);
        expect(calls).toEqual([
            "borrower.search", "borrower.portfolio", "loan.contract.get", "intake.get", "payment.match-context", "payment.preview", "payment.post",
            "loan.contract.get", "loan.disbursement.draft", "loan.disbursement.evidence.prepare", "loan.disbursement.evidence.finalize", "loan.disbursement.post",
            "intermediary.profile.get", "intermediary.collection.list", "intermediary.collection.cancel", "intermediary.remittance.create", "intermediary.remittance.get", "intermediary.remittance.allocations.save", "intermediary.remittance.preview", "intermediary.remittance.post",
            "funding-source.list", "funding-allocation.preview", "funding-allocation.list",
        ]);

        const failure = buildApp(true);
        await replay(failure, "payments", [["evidence.prepare", { paymentIntakePublicId: PROFILE_TEST_UUID, mimeType: "image/png", size: 100, sha256: "a".repeat(64) }], ["payment.post", { paymentIntakePublicId: PROFILE_TEST_UUID, proposalPublicId: PROFILE_TEST_UUID }]], true);
        expect(failure.calls).toEqual(["evidence.prepare"]);
        expect(failure.calls).not.toContain("payment.post");

        const denied = await app.handle(new Request("http://profile.test/mcp/core-read", {
            method: "POST",
            headers: { host: "profile.test", authorization: `Bearer ${PROFILE_TEST_TOKEN}`, "content-type": "application/json", accept: "application/json", "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": "payment.post" },
            body: JSON.stringify(modernRequest("tools/call", { name: "payment.post", arguments: { paymentIntakePublicId: PROFILE_TEST_UUID, proposalPublicId: PROFILE_TEST_UUID } })),
        }));
        expect(denied.status).toBe(200);
        expect((await denied.json() as Record<string, any>).error?.code).toBe(-32602);
        expect(calls.filter((name) => name === "payment.post")).toHaveLength(1);
    });

    test("core-read cannot expose mutation or open-world imports", () => {
        for (const tool of toolsForProfile("core-read", catalog)) {
            expect(tool.annotations.readOnlyHint).toBe(true);
            expect(tool.annotations.destructiveHint).toBe(false);
            expect(tool.policy.kind).toBe("read_only");
            expect(tool.policy.requiresAudit).toBe(false);
            expect(tool.annotations.openWorldHint).toBe(false);
        }
        expect(toolNamesForProfile("core-read")).not.toContain("evidence.import-chatgpt-file");
        expect(toolNamesForProfile("core-read")).not.toContain("payment.post");
    });

    test("financial and external-import metadata remain explicit", () => {
        const financialNames = catalog.filter((tool) => tool.policy.requiresAudit).map((tool) => tool.name);
        expect(financialNames).toContain("payment.reconcile.reflow.execute");
        expect(financialNames).toContain("payment.allocation-correction.execute");
        for (const tool of catalog) {
            expect(tool.annotations.readOnlyHint && tool.annotations.destructiveHint).toBe(false);
            if (tool.policy.requiresAudit) {
                expect(tool.policy.kind).toBe("financial");
                expect(tool.annotations.destructiveHint).toBe(true);
                expect(tool.annotations.idempotentHint).toBe(true);
            }
        }
        for (const name of [
            "evidence.import-chatgpt-file",
            "loan.disbursement.evidence.import-chatgpt-file",
            "payment.evidence-supplement.import-chatgpt-file",
        ] as const) {
            const tool = catalogByName.get(name)!;
            expect(tool.annotations.openWorldHint).toBe(true);
            expect(tool.annotations.destructiveHint).toBe(true);
        }
    });
});
