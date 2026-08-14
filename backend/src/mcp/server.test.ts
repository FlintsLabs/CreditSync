import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Elysia } from "elysia";
import { DomainError } from "../services/domain-error";
import type { CommandContext } from "../services/command-context";
import { previewLoan } from "../services/loan-application-service";
import { createMcpHttpPlugin, MCP_TOOL_NAMES, type CreateMcpHttpPluginInput, type McpToolHandler } from "./server";
import type { McpRuntimeConfig } from "./security";

const TOKEN = "contract-secret";
const BORROWER_ID = "0198c481-3e2b-7000-8000-000000000001";
const INTAKE_ID = "0198c481-3e2b-7000-8000-000000000002";
const AUDIT_ID = "0198c481-3e2b-7000-8000-000000000003";
const DISBURSEMENT_ID = "0198c481-3e2b-7000-8000-000000000004";

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
    preflightHandlers?: Partial<Record<(typeof MCP_TOOL_NAMES)[number], McpToolHandler>>;
    runtimeConfig?: McpRuntimeConfig;
    logs?: Array<Record<string, unknown>>;
    auditPublicIds?: string[];
}) {
    const pluginInput: CreateMcpHttpPluginInput = {
        config: input.runtimeConfig ?? config(),
        handlers: handlers(input.toolHandlers ?? {}),
        preflightHandlers: input.preflightHandlers,
        resolvePrincipal: async ({ tenantId, actorEmail }) => {
            expect(tenantId).toBe("tenant-fixed");
            expect(actorEmail).toBe("mcp-agent@example.test");
            return { tenantId, actorUserId: 7 };
        },
        consumeRateLimit: async () => ({ allowed: true, remaining: 99, retryAfterSeconds: 0 }),
        findAuditPublicIds: async () => input.auditPublicIds ?? [AUDIT_ID],
        logger: (entry) => input.logs?.push(entry),
    };
    const app = new Elysia().use(createMcpHttpPlugin(pluginInput)).listen({ hostname: "127.0.0.1", port: 0 });
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
    // Break caught: floating previews return policy and net-disbursement fields that the strict MCP output contract rejects.
    test("returns a floating-loan preview through the public MCP contract", async () => {
        const baseUrl = await startServer({
            toolHandlers: {
                "loan.preview": async (_ctx, input) => {
                    const terms = input as unknown as Parameters<typeof previewLoan>[0];
                    return previewLoan(terms.principal === "5000.00"
                        ? { ...terms, floatingDailyInterest: { ...terms.floatingDailyInterest!, accrualCycle: "weekly" } }
                        : terms);
                },
            },
        });
        const { client, transport } = clientFor(baseUrl);
        await client.connect(transport);

        const result = await client.callTool({
            name: "loan.preview",
            arguments: {
                principal: "4000.00",
                interestRate: "0.00",
                termMonths: 1,
                repaymentType: "floating",
                startDate: "2026-08-06",
                floatingDailyInterest: {
                    mode: "per_thousand",
                    rate: "15.00",
                    firstDayTreatment: "deduct",
                },
            },
        });

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
            schemaVersion: "1.0",
            data: {
                floatingDailyInterest: { mode: "per_thousand", rate: "15.0000", firstDayTreatment: "deduct" },
                firstDayInterest: "60.00",
                dailyInterestAtCurrentPrincipal: "60.00",
                netDisbursement: "3940.00",
                nextInterestDate: "2026-08-06",
                schedule: [],
            },
        });

        const weekly = await client.callTool({
            name: "loan.preview",
            arguments: {
                principal: "5000.00",
                interestRate: "0.00",
                termMonths: 1,
                repaymentType: "floating",
                startDate: "2026-08-10",
                floatingDailyInterest: {
                    mode: "percent",
                    rate: "12.00",
                    firstDayTreatment: "deduct",
                },
            },
        });
        expect(weekly.isError).not.toBe(true);
        expect(weekly.structuredContent).toMatchObject({
            schemaVersion: "1.0",
            data: {
                floatingDailyInterest: { mode: "percent", rate: "12.0000", firstDayTreatment: "deduct" },
                firstDayInterest: "600.00",
                dailyInterestAtCurrentPrincipal: "600.00",
                netDisbursement: "4400.00",
                nextInterestDate: "2026-08-17",
                schedule: [],
            },
        });
        expect(weekly.structuredContent).not.toHaveProperty("data.fullPeriodInterest");
        expect(weekly.structuredContent).not.toHaveProperty("data.firstPeriodStartDate");
        expect(weekly.structuredContent).not.toHaveProperty("data.firstPeriodDueDate");
        expect(weekly.structuredContent).not.toHaveProperty("data.advanceInterestAmount");
        expect(weekly.structuredContent).not.toHaveProperty("data.nextAccrualDate");
        expect(weekly.structuredContent).not.toHaveProperty("data.advanceInterestRefundPolicy");
        await client.close();
    });

    // Break caught: a single-payment activation commits before the frozen MCP
    // output contract rejects the new repayment type as INVALID_TOOL_OUTPUT.
    test("rejects unsupported single-payment activation before invoking the financial handler", async () => {
        const state = { status: "draft", repaymentType: "single_payment" };
        let activationCalls = 0;
        const baseUrl = await startServer({
            preflightHandlers: {
                "loan.activate": async () => {
                    if (state.repaymentType === "single_payment") {
                        throw new DomainError(
                            "MCP_LOAN_TYPE_UNSUPPORTED",
                            "Single-payment activation is not available through the frozen MCP contract",
                            409,
                        );
                    }
                },
            },
            toolHandlers: {
                "loan.activate": async () => {
                    activationCalls += 1;
                    state.status = "active";
                    return {
                        id: BORROWER_ID,
                        publicId: BORROWER_ID,
                        borrowerPublicId: BORROWER_ID,
                        bankLoanPublicId: null,
                        bankProfilePublicId: null,
                        principal: "5000.00",
                        principalAmount: "5000.00",
                        interestRate: "0.00",
                        repaymentType: "single_payment",
                        termMonths: 1,
                        installmentAmount: null,
                        totalInstallments: null,
                        startDate: "2026-08-10",
                        nextDueDate: "2026-08-19",
                        outstandingPrincipal: "5000.00",
                        outstandingInterest: "500.00",
                        outstandingFees: "0.00",
                        status: "active",
                    };
                },
            },
        });
        const { client, transport } = clientFor(baseUrl);
        await client.connect(transport);

        const result = await client.callTool({ name: "loan.activate", arguments: { loanPublicId: BORROWER_ID } });

        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
            error: {
                code: "MCP_LOAN_TYPE_UNSUPPORTED",
                message: "Single-payment activation is not available through the frozen MCP contract",
            },
        });
        expect(activationCalls).toBe(0);
        expect(state.status).toBe("draft");
        await client.close();
    });

    test("advertises closed loan-disbursement tools with financial audit metadata", async () => {
        let observed: Record<string, unknown> | undefined;
        const baseUrl = await startServer({
            toolHandlers: {
                "loan.disbursement.draft": async (_ctx, input) => {
                    observed = input;
                    return {
                        id: DISBURSEMENT_ID, publicId: DISBURSEMENT_ID,
                        grossAmount: "100.00", loanAttributedAmount: "100.00",
                        channel: "cash", status: "draft", sourceBankProfilePublicId: BORROWER_ID, payeeHint: null, note: null,
                        disbursedAt: "2026-08-10T00:00:00.000Z", postedAt: null, reversedAt: null,
                        evidenceFilePublicIds: [],
                    };
                },
                "loan.disbursement.update": async (_ctx, input) => {
                    observed = input;
                    return {
                        id: DISBURSEMENT_ID, publicId: DISBURSEMENT_ID,
                        grossAmount: "100.00", loanAttributedAmount: "95.00",
                        channel: "cash", status: "draft", sourceBankProfilePublicId: BORROWER_ID, payeeHint: null, note: "Corrected attribution",
                        disbursedAt: "2026-08-10T00:00:00.000Z", postedAt: null, reversedAt: null,
                        evidenceFilePublicIds: [],
                    };
                },
                "loan.disbursement.post": async () => ({
                    id: DISBURSEMENT_ID, publicId: DISBURSEMENT_ID,
                    grossAmount: "100.00", loanAttributedAmount: "100.00",
                    channel: "cash", status: "posted", sourceBankProfilePublicId: BORROWER_ID, payeeHint: null, note: null,
                    disbursedAt: "2026-08-10T00:00:00.000Z", postedAt: "2026-08-10T00:01:00.000Z", reversedAt: null,
                    evidenceFilePublicIds: [], duplicate: false,
                    auditPublicId: AUDIT_ID, correlationId: AUDIT_ID,
                }),
            },
        });
        const { client, transport } = clientFor(baseUrl);
        await client.connect(transport);
        const listed = await client.listTools();
        const draftTool = listed.tools.find((tool) => tool.name === "loan.disbursement.draft");
        const updateTool = listed.tools.find((tool) => tool.name === "loan.disbursement.update");
        const postTool = listed.tools.find((tool) => tool.name === "loan.disbursement.post");
        expect(draftTool?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
        expect(updateTool?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false });
        expect(postTool?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false });
        const draft = await client.callTool({
            name: "loan.disbursement.draft",
            arguments: {
                loanPublicId: BORROWER_ID, grossAmount: "100.00", loanAttributedAmount: "100.00",
                channel: "cash", disbursedAt: "2026-08-10T00:00:00.000Z",
            },
        });
        expect(draft.isError).not.toBe(true);
        expect(draft.structuredContent).toMatchObject({ schemaVersion: "1.0", data: { publicId: DISBURSEMENT_ID, status: "draft", grossAmount: "100.00", sourceBankProfilePublicId: BORROWER_ID } });
        expect(observed).toMatchObject({ loanPublicId: BORROWER_ID, grossAmount: "100.00", loanAttributedAmount: "100.00", channel: "cash" });
        const malformed = await client.callTool({
            name: "loan.disbursement.draft",
            arguments: {
                loanPublicId: BORROWER_ID, grossAmount: "100", loanAttributedAmount: "100.00",
                channel: "wire", disbursedAt: "not-a-date",
            },
        });
        expect(malformed.isError).toBe(true);
        const updated = await client.callTool({
            name: "loan.disbursement.update",
            arguments: { disbursementPublicId: DISBURSEMENT_ID, changes: { loanAttributedAmount: "95.00", note: "Corrected attribution" } },
        });
        expect(updated.isError).not.toBe(true);
        expect(updated.structuredContent).toMatchObject({ schemaVersion: "1.0", data: { publicId: DISBURSEMENT_ID, status: "draft", loanAttributedAmount: "95.00" } });
        expect(observed).toEqual({ disbursementPublicId: DISBURSEMENT_ID, changes: { loanAttributedAmount: "95.00", note: "Corrected attribution" } });
        for (const changes of [
            {},
            { evidenceFilePublicIds: [BORROWER_ID] },
            { status: "posted" },
            { unknown: "value" },
        ]) {
            const rejected = await client.callTool({
                name: "loan.disbursement.update",
                arguments: { disbursementPublicId: DISBURSEMENT_ID, changes },
            });
            expect(rejected.isError).toBe(true);
        }
        const posted = await client.callTool({
            name: "loan.disbursement.post",
            arguments: { disbursementPublicId: DISBURSEMENT_ID, idempotencyKey: "post-disbursement-1" },
        });
        expect(posted.isError).not.toBe(true);
        expect(posted.structuredContent).toMatchObject({ schemaVersion: "1.0", data: { status: "posted" }, auditPublicIds: [AUDIT_ID] });
        await client.close();
    });

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
            "loan.interest-rate.execute",
            "loan.disbursement.update",
            "loan.disbursement.post",
            "loan.disbursement.reverse",
            "intermediary.remittance.post",
            "renewal.preview",
            "renewal.execute",
            "renewal.reverse",
            "loan.restructure.execute",
            "loan.restructure.reverse",
            "loan.waiver.execute",
            "loan.waiver.reverse",
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

    // Break caught: restructure/waiver tools are absent, loosely shaped, or advertise
    // financial writes as safe reads.
    test("advertises closed restructure and waiver confirmation contracts", async () => {
        const baseUrl = await startServer({});
        const { client, transport } = clientFor(baseUrl);
        await client.connect(transport);
        const listed = await client.listTools();
        const tools = new Map(listed.tools.map((tool) => [tool.name, tool]));

        for (const name of ["loan.restructure.preview", "loan.waiver.preview"]) {
            expect(tools.get(name)?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
        }
        for (const name of ["loan.restructure.execute", "loan.restructure.reverse", "loan.waiver.execute", "loan.waiver.reverse"]) {
            expect(tools.get(name)?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false });
        }

        const execute = tools.get("loan.restructure.execute")?.inputSchema as { required?: string[]; additionalProperties?: boolean };
        expect(execute.required?.sort()).toEqual([
            "confirmed", "expectedBalanceVersion", "idempotencyKey", "previewHash", "reason", "restructurePublicId",
        ]);
        expect(execute.additionalProperties).toBe(false);

        const unknown = await client.callTool({
            name: "loan.waiver.execute",
            arguments: {
                previewPublicId: BORROWER_ID,
                previewHash: `v1:${"a".repeat(64)}`,
                expectedBalanceVersion: `v1:${"b".repeat(64)}`,
                confirmed: true,
                reason: "Owner confirmed exact waiver",
                idempotencyKey: "waiver-execute-1",
                tenantId: "must-not-be-accepted",
            },
        });
        expect(unknown.isError).toBe(true);
        expect(unknown.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: "text" })]));
        await client.close();
    });

    // Break caught: arbitrary nested replacement-term fields can cross the public
    // output boundary and expose internal request material.
    test("rejects unknown nested replacement-term output fields", async () => {
        let handlerCalls = 0;
        const baseUrl = await startServer({
            toolHandlers: {
                "loan.restructure.preview": async () => {
                    handlerCalls += 1;
                    return ({
                    publicId: BORROWER_ID, oldLoanPublicId: INTAKE_ID, status: "preview",
                    settlementDate: "2026-08-19", oldBalanceVersion: `v1:${"a".repeat(64)}`,
                    previewHash: `v1:${"b".repeat(64)}`, expiresAt: "2026-08-19T12:00:00.000Z",
                    balance: {
                        fixedInterestCandidate: "100.00", retroactiveInterestCandidate: "0.00",
                        selectedInterest: "100.00", selectedInterestBranch: "fixed", interestDifference: "100.00",
                        exposureTrace: [], lateDays: 0, grossPrincipal: "1000.00", grossInterest: "100.00",
                        grossFees: "0.00", grossPenalty: "0.00", grossSettlement: "1100.00",
                        waivedInterest: "0.00", waivedFees: "0.00", waivedPenalty: "0.00",
                        netInterest: "100.00", netFees: "0.00", netPenalty: "0.00",
                        externalSettlementCredits: "0.00", netSettlement: "1100.00",
                    },
                    replacementPrincipal: "1000.00",
                    externalCreditAllocation: { penalty: "0.00", fee: "0.00", interest: "0.00", principal: "0.00", unallocated: "0.00" },
                    replacementTerms: {
                        principal: "1000.00", interestRate: "0.00", termMonths: 1,
                        repaymentType: "monthly", startDate: "2026-08-19",
                        unexpectedInternal: "must be rejected",
                    },
                    schedule: [], cash: { direction: "none", amount: "0.00" }, reason: "replace",
                    });
                },
            },
        });
        const { client, transport } = clientFor(baseUrl);
        await client.connect(transport);
        const invalidInput = await client.callTool({
            name: "loan.restructure.preview",
            arguments: {
                oldLoanPublicId: BORROWER_ID, settlementDate: "2026-08-19",
                replacementTerms: { interestRate: "0.00", termMonths: 1, repaymentType: "monthly", startDate: "2026-08-19", unexpectedInternal: true },
                additionalPrincipal: "0.00", reason: "replace",
            },
        });
        expect(invalidInput.isError).toBe(true);
        expect(handlerCalls).toBe(0);
        const result = await client.callTool({
            name: "loan.restructure.preview",
            arguments: {
                oldLoanPublicId: BORROWER_ID, settlementDate: "2026-08-19",
                replacementTerms: { interestRate: "0.00", termMonths: 1, repaymentType: "monthly", startDate: "2026-08-19" },
                additionalPrincipal: "0.00", reason: "replace",
            },
        });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({ error: { code: "INVALID_TOOL_OUTPUT" } });
        expect(handlerCalls).toBe(1);
        await client.close();
    });

    test("enforces repayment-type-specific replacement term inputs before the handler", async () => {
        let handlerCalls = 0;
        const baseUrl = await startServer({ toolHandlers: {
            "loan.restructure.preview": async () => {
                handlerCalls += 1;
                throw new DomainError("REACHED_HANDLER", "valid replacement terms reached handler", 409);
            },
        } });
        const { client, transport } = clientFor(baseUrl);
        await client.connect(transport);
        const request = (replacementTerms: Record<string, unknown>) => client.callTool({
            name: "loan.restructure.preview",
            arguments: { oldLoanPublicId: BORROWER_ID, settlementDate: "2026-08-19", replacementTerms, additionalPrincipal: "0.00", reason: "replace" },
        });
        const base = { interestRate: "0.00", termMonths: 1, startDate: "2026-08-19" };
        for (const invalid of [
            { ...base, repaymentType: "monthly", floatingDailyInterest: { mode: "percent", rate: "1", firstDayTreatment: "start_next_day" } },
            { ...base, repaymentType: "floating", floatingDailyInterest: { mode: "percent", rate: "1", firstDayTreatment: "start_next_day" }, singlePayment: { dueDate: "2026-09-19", fixedAgreedInterest: "100.00", interestPolicy: "fixed_only", latePenalty: { mode: "none" } } },
            { ...base, repaymentType: "single_payment", totalInstallments: 1, installmentAmount: "1100.00", singlePayment: { dueDate: "2026-09-19", fixedAgreedInterest: "100.00", interestPolicy: "fixed_only", latePenalty: { mode: "none" } } },
        ]) expect((await request(invalid)).isError).toBe(true);
        expect(handlerCalls).toBe(0);

        for (const invalidNested of [
            { ...base, repaymentType: "floating", floatingDailyInterest: { mode: "percent", rate: "1", firstDayTreatment: "start_next_day", unexpected: true } },
            { ...base, repaymentType: "daily", dailyEntry: { durationUnit: "days", durationValue: 10, entryMode: "daily_payment", dailyPayment: "110.00", unexpected: true } },
            { ...base, repaymentType: "daily", dailyEntry: { durationUnit: "days", durationValue: 10, entryMode: "daily_interest", interestInput: { mode: "percent", value: "1", unexpected: true } } },
        ]) expect((await request(invalidNested)).isError).toBe(true);
        expect(handlerCalls).toBe(0);

        const dailyEntry = { durationUnit: "days", durationValue: 10, entryMode: "daily_payment", dailyPayment: "110.00" };
        const valid = [
            { ...base, repaymentType: "daily", dailyEntry, totalInstallments: 10, installmentAmount: "110.00" },
            { ...base, repaymentType: "weekly", totalInstallments: 4, installmentAmount: "275.00" },
            { ...base, repaymentType: "monthly", totalInstallments: 1, installmentAmount: "1100.00" },
            { ...base, repaymentType: "floating", floatingDailyInterest: { mode: "percent", rate: "1", firstDayTreatment: "start_next_day" } },
            { ...base, repaymentType: "single_payment", singlePayment: { dueDate: "2026-09-19", fixedAgreedInterest: "100.00", interestPolicy: "fixed_only", latePenalty: { mode: "none" } } },
        ];
        for (const terms of valid) {
            const result = await request(terms);
            expect(result.structuredContent).toMatchObject({ error: { code: "REACHED_HANDLER" } });
        }
        expect(handlerCalls).toBe(5);
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

        const legacyReversed = await client.callTool({
            name: "payment.reverse",
            arguments: { paymentIntakePublicId: INTAKE_ID },
        });
        const reasonedReversed = await client.callTool({
            name: "payment.reverse",
            arguments: { paymentIntakePublicId: INTAKE_ID, reason: "Bank correction" },
        });
        const expectedReversalError = {
            schemaVersion: "1.0",
            error: {
                code: "REVERSAL_NOT_LATEST",
                message: "Reverse later payments first",
                retryable: false,
                reviewRequired: true,
                details: { paymentIntakePublicId: INTAKE_ID },
            },
        };
        expect(legacyReversed.isError).toBe(true);
        expect(legacyReversed.structuredContent).toEqual(expectedReversalError);
        expect(reasonedReversed.isError).toBe(true);
        expect(reasonedReversed.structuredContent).toEqual(expectedReversalError);
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
