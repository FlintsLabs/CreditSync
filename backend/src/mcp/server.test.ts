import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Elysia } from "elysia";
import { DomainError } from "../services/domain-error";
import type { CommandContext } from "../services/command-context";
import { previewLoan } from "../services/loan-application-service";
import { parseMoney, serializeMoney } from "../lib/money";
import { loansRoute } from "../modules/loans";
import { normalizeMoney as normalizeFrontendMoney } from "../../../frontend/src/lib/workflow-api";
import { createMcpHttpPlugin, MCP_TOOL_NAMES, type McpToolHandler } from "./server";
import type { McpRuntimeConfig } from "./security";

const TOKEN = "contract-secret";
const BORROWER_ID = "0198c481-3e2b-7000-8000-000000000001";
const INTAKE_ID = "0198c481-3e2b-7000-8000-000000000002";
const AUDIT_ID = "0198c481-3e2b-7000-8000-000000000003";
const DISBURSEMENT_ID = "0198c481-3e2b-7000-8000-000000000004";
const SETTLEMENT_ID = "0198c481-3e2b-7000-8000-000000000005";
const TRANSACTION_ID = "0198c481-3e2b-7000-8000-000000000006";
const PREVIEW_HASH = `v1:${"a".repeat(64)}`;
const BALANCE_VERSION = `v1:${"b".repeat(64)}`;

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
    // Break caught: frontend, backend parsing, REST, and MCP enforce different public-money lengths or round the shared maximum.
    test("keeps every public boundary on the 32-character unsigned money contract", async () => {
        const maximum = "99999999999999999999999999999.99";
        const overflow = "100000000000000000000000000000.00";
        expect(normalizeFrontendMoney(maximum)).toBe(maximum);
        expect(() => normalizeFrontendMoney(overflow)).toThrow();
        expect(serializeMoney(parseMoney(maximum))).toBe(maximum);
        expect(() => parseMoney(overflow)).toThrow();

        const restApp = new Elysia().use(loansRoute);
        const requestBody = { principal: maximum, interestRate: "0.00", termMonths: 1, repaymentType: "monthly", startDate: "2026-08-10" };
        const restMaximum = await restApp.handle(new Request("http://localhost/loans/preview", {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(requestBody),
        }));
        expect(restMaximum.status).toBe(200);
        expect(await restMaximum.json()).toMatchObject({ terms: { principal: maximum }, schedule: [{ amount: maximum }] });
        const restOverflow = await restApp.handle(new Request("http://localhost/loans/preview", {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...requestBody, principal: overflow }),
        }));
        expect(restOverflow.status).toBe(422);

        const baseUrl = await startServer({ toolHandlers: { "loan.preview": async (_ctx, input) => previewLoan(input as unknown as Parameters<typeof previewLoan>[0]) } });
        const { client, transport } = clientFor(baseUrl);
        await client.connect(transport);
        const listed = await client.listTools();
        const previewTool = listed.tools.find((tool) => tool.name === "loan.preview");
        expect((previewTool?.inputSchema.properties?.principal as { maxLength?: number })?.maxLength).toBe(32);
        const disbursementListTool = listed.tools.find((tool) => tool.name === "loan.disbursement.list");
        const disbursementOutput = disbursementListTool?.outputSchema as {
            properties?: { data?: { properties?: { summary?: { properties?: { variance?: { maxLength?: number } } } } } };
        } | undefined;
        expect(disbursementOutput?.properties?.data?.properties?.summary?.properties?.variance?.maxLength).toBe(33);
        const mcpMaximum = await client.callTool({ name: "loan.preview", arguments: requestBody });
        expect(mcpMaximum.isError).not.toBe(true);
        expect(mcpMaximum.structuredContent).toMatchObject({ data: { terms: { principal: maximum }, schedule: [{ amount: maximum }] } });
        expect((await client.callTool({ name: "loan.preview", arguments: { ...requestBody, principal: overflow } })).isError).toBe(true);
        await client.close();
    });

    // Break caught: REST accidentally applies the 32-character money limit to a daily rate that MCP and the service accept.
    test("keeps a 33-digit daily percent rate in parity across service, REST, and MCP", async () => {
        const rate = "100000000000000000000000000000000";
        const requestBody = {
            principal: "0.01",
            interestRate: "0.00",
            termMonths: 1,
            repaymentType: "daily",
            startDate: "2026-08-10",
            dailyEntry: {
                durationUnit: "days",
                durationValue: 1,
                entryMode: "daily_interest",
                interestInput: { mode: "percent", value: rate },
            },
        } as const;
        const expectedSchedule = [{
            amount: "10000000000000000000000000000.01",
            principalComponent: "0.01",
            interestComponent: "10000000000000000000000000000.00",
            remainingPrincipal: "0.00",
        }];

        const servicePreview = previewLoan(requestBody);
        expect(servicePreview).toMatchObject({ schedule: expectedSchedule });

        const restApp = new Elysia().use(loansRoute);
        const restResponse = await restApp.handle(new Request("http://localhost/loans/preview", {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(requestBody),
        }));
        expect(restResponse.status).toBe(200);
        expect(await restResponse.json()).toMatchObject({ schedule: expectedSchedule });

        const baseUrl = await startServer({ toolHandlers: { "loan.preview": async (_ctx, input) => previewLoan(input as unknown as Parameters<typeof previewLoan>[0]) } });
        const { client, transport } = clientFor(baseUrl);
        await client.connect(transport);
        const previewTool = (await client.listTools()).tools.find((tool) => tool.name === "loan.preview");
        const previewInput = previewTool?.inputSchema as {
            properties?: {
                dailyEntry?: { properties?: { interestInput?: { properties?: { value?: { maxLength?: number } } } } };
                floatingInterestPolicy?: { properties?: { rate?: { maxLength?: number } } };
            };
        } | undefined;
        expect(previewInput?.properties?.dailyEntry?.properties?.interestInput?.properties?.value?.maxLength).toBeUndefined();
        expect(previewInput?.properties?.floatingInterestPolicy?.properties?.rate?.maxLength).toBe(32);
        const mcpResponse = await client.callTool({ name: "loan.preview", arguments: requestBody });
        expect(mcpResponse.isError).not.toBe(true);
        expect(mcpResponse.structuredContent).toMatchObject({ data: { schedule: expectedSchedule } });
        await client.close();
    });

    // Break caught: generalized weekly-policy input or output is rejected by the stale daily-only MCP contract.
    test("returns a generalized weekly floating-loan preview through the public MCP contract", async () => {
        const baseUrl = await startServer({
            toolHandlers: {
                "loan.preview": async (_ctx, input) => previewLoan(input as unknown as Parameters<typeof previewLoan>[0]),
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
                startDate: "2026-08-13",
                floatingInterestPolicy: {
                    periodUnit: "week",
                    periodLength: 1,
                    rateMode: "percent",
                    rate: "12",
                    advanceInterestPeriods: 1,
                    advanceInterestRefundPolicy: "non_refundable",
                },
            },
        });

        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
            schemaVersion: "1.0",
            data: {
                floatingInterestPolicy: {
                    periodUnit: "week",
                    periodLength: 1,
                    rateMode: "percent",
                    rate: "12.0000",
                    advanceInterestPeriods: 1,
                    advanceInterestRefundPolicy: "non_refundable",
                },
                fullPeriodInterest: "480.00",
                advanceInterest: "480.00",
                netBorrowerPayout: "3520.00",
                firstPeriodStartDate: "2026-08-13",
                firstPeriodDueDate: "2026-08-20",
                periodDays: 7,
                schedule: [],
            },
        });
        const legacy = await client.callTool({
            name: "loan.preview",
            arguments: {
                principal: "4000.00",
                interestRate: "0.00",
                termMonths: 1,
                repaymentType: "floating",
                startDate: "2026-08-13",
                floatingDailyInterest: { mode: "percent", rate: "12", firstDayTreatment: "deduct" },
            },
        });
        expect(legacy.isError).toBe(true);
        await client.close();
    });

    // Break caught: settlement tools are absent, accept refund overrides, or advertise execute as non-destructive/non-idempotent.
    test("advertises closed settlement preview and explicitly confirmed idempotent execute contracts", async () => {
        let observedContext: CommandContext | undefined;
        let observedInput: Record<string, unknown> | undefined;
        const preview = {
            id: SETTLEMENT_ID,
            publicId: SETTLEMENT_ID,
            loanPublicId: BORROWER_ID,
            status: "ready",
            asOfDate: "2026-08-15",
            outstandingPrincipal: "5000.00",
            dueInterest: "0.00",
            accruedNotDueInterest: "0.00",
            outstandingFees: "0.00",
            outstandingPenalties: "0.00",
            nonRefundableAdvanceInterest: "600.00",
            settlementTotal: "5000.00",
            balanceVersion: BALANCE_VERSION,
            previewHash: PREVIEW_HASH,
            hashVersion: "v1",
            expiresAt: "2026-08-15T06:15:00.000Z",
            executedAt: null,
            createdAt: "2026-08-15T06:00:00.000Z",
            updatedAt: "2026-08-15T06:00:00.000Z",
        };
        const baseUrl = await startServer({
            toolHandlers: {
                "loan.settlement.preview": async (_ctx, input) => {
                    observedInput = input;
                    return preview;
                },
                "loan.settlement.execute": async (ctx, input) => {
                    observedContext = ctx;
                    observedInput = input;
                    return {
                        ...preview,
                        status: "executed",
                        executedAt: "2026-08-15T06:05:00.000Z",
                        transaction: {
                            id: TRANSACTION_ID,
                            publicId: TRANSACTION_ID,
                            amount: "5000.00",
                            principalComponent: "5000.00",
                            interestComponent: "0.00",
                            feeComponent: "0.00",
                            penaltyComponent: "0.00",
                            type: "close_account",
                            entryType: "repayment",
                            transactionDate: "2026-08-15T05:00:00.000Z",
                            postedAt: "2026-08-15T06:05:00.000Z",
                        },
                        reason: "Borrower confirmed exact close-out",
                        auditPublicId: AUDIT_ID,
                        correlationId: AUDIT_ID,
                    };
                },
            },
        });
        const { client, transport } = clientFor(baseUrl);
        await client.connect(transport);
        const listed = await client.listTools();
        expect(listed.tools.find((tool) => tool.name === "loan.settlement.preview")?.annotations).toMatchObject({
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: false,
        });
        expect(listed.tools.find((tool) => tool.name === "loan.settlement.execute")?.annotations).toMatchObject({
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: true,
            openWorldHint: false,
        });

        const previewed = await client.callTool({
            name: "loan.settlement.preview",
            arguments: { loanPublicId: BORROWER_ID, asOfDate: "2026-08-15" },
        });
        expect(previewed.isError).not.toBe(true);
        expect(previewed.structuredContent).toMatchObject({
            schemaVersion: "1.0",
            data: {
                publicId: SETTLEMENT_ID,
                outstandingPrincipal: "5000.00",
                nonRefundableAdvanceInterest: "600.00",
                settlementTotal: "5000.00",
            },
        });
        expect(observedInput).toEqual({ loanPublicId: BORROWER_ID, asOfDate: "2026-08-15" });

        const unconfirmed = await client.callTool({
            name: "loan.settlement.execute",
            arguments: {
                settlementPublicId: SETTLEMENT_ID,
                previewHash: PREVIEW_HASH,
                confirmed: false,
                reason: "Borrower confirmed exact close-out",
                idempotencyKey: "settlement-execute-1",
            },
        });
        expect(unconfirmed.isError).toBe(true);
        const refundOverride = await client.callTool({
            name: "loan.settlement.execute",
            arguments: {
                settlementPublicId: SETTLEMENT_ID,
                previewHash: PREVIEW_HASH,
                confirmed: true,
                reason: "Borrower confirmed exact close-out",
                idempotencyKey: "settlement-execute-1",
                refundableAdvanceInterest: "600.00",
            },
        });
        expect(refundOverride.isError).toBe(true);

        const executed = await client.callTool({
            name: "loan.settlement.execute",
            arguments: {
                settlementPublicId: SETTLEMENT_ID,
                previewHash: PREVIEW_HASH,
                confirmed: true,
                reason: "Borrower confirmed exact close-out",
                idempotencyKey: "settlement-execute-1",
            },
        });
        expect(executed.isError).not.toBe(true);
        expect(executed.structuredContent).toMatchObject({
            schemaVersion: "1.0",
            data: { status: "executed", transaction: { publicId: TRANSACTION_ID, amount: "5000.00" } },
            auditPublicIds: [AUDIT_ID],
        });
        expect(observedInput).toEqual({
            settlementPublicId: SETTLEMENT_ID,
            previewHash: PREVIEW_HASH,
            confirmed: true,
            reason: "Borrower confirmed exact close-out",
        });
        expect(observedContext?.idempotencyKey).toBe("settlement-execute-1");
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

    // Break caught: intermediary profile/assignment and exact multi-leg disbursement tools are
    // absent, advertise open schemas, leak retrieval URLs through inspection, or allow posting
    // without the literal human confirmation required by the frozen public contract.
    test("advertises closed intermediary assignment and multi-leg disbursement contracts", async () => {
        const groupPublicId = "0198c481-3e2b-7000-8000-000000000081";
        const intermediaryPublicId = "0198c481-3e2b-7000-8000-000000000082";
        const assignmentPublicId = "0198c481-3e2b-7000-8000-000000000083";
        const eventPublicId = "0198c481-3e2b-7000-8000-000000000084";
        const proposalPublicId = "0198c481-3e2b-7000-8000-000000000085";
        const baseGroup = {
            publicId: groupPublicId,
            loanPublicId: BORROWER_ID,
            intermediaryPublicId,
            expectedFunding: "5000.00",
            expectedBorrowerPayout: "4400.00",
            expectedAdvanceInterestReturn: "600.00",
            retainedBalance: "0.00",
            status: "ready",
            note: null,
            createdAt: "2026-08-13T02:00:00.000Z",
            updatedAt: "2026-08-13T02:05:00.000Z",
        };
        const baseUrl = await startServer({
            toolHandlers: {
                "intermediary.profile.get": async () => ({
                    publicId: intermediaryPublicId,
                    name: "Exact intermediary",
                    aliases: ["Exact alias"],
                    notes: null,
                    status: "active",
                    createdAt: "2026-08-01T00:00:00.000Z",
                    updatedAt: "2026-08-01T00:00:00.000Z",
                    bankAccounts: [],
                    assignments: [{
                        publicId: assignmentPublicId,
                        loanPublicId: BORROWER_ID,
                        intermediaryPublicId,
                        borrowerPublicId: BORROWER_ID,
                        borrowerName: "Exact borrower",
                        loanStatus: "active",
                        role: "disbursement",
                        effectiveFrom: "2026-08-01T00:00:00.000Z",
                        effectiveTo: null,
                        status: "active",
                        note: null,
                        createdAt: "2026-08-01T00:00:00.000Z",
                        updatedAt: "2026-08-01T00:00:00.000Z",
                    }],
                }),
                "intermediary.disbursement.get": async () => ({
                    ...baseGroup,
                    events: [{
                        publicId: eventPublicId,
                        groupPublicId,
                        intermediaryBankAccountPublicId: null,
                        reversedEventPublicId: null,
                        role: "funding_to_intermediary",
                        channel: "bank_transfer",
                        amount: "5000.00",
                        senderHint: "Owner account",
                        payeeHint: "Exact intermediary",
                        bankReference: "SAFE-REFERENCE",
                        transferredAt: "2026-08-13T02:00:00.000Z",
                        status: "ready",
                        note: null,
                        createdAt: "2026-08-13T02:00:00.000Z",
                        updatedAt: "2026-08-13T02:00:00.000Z",
                    }],
                    latestPreview: null,
                }),
                "intermediary.disbursement.post": async () => ({
                    ...baseGroup,
                    status: "posted",
                    proposalPublicId,
                    loanDisbursementPublicId: DISBURSEMENT_ID,
                    advanceInterestProjectionPublicId: BORROWER_ID,
                    fundingAmount: "5000.00",
                    borrowerPayoutAmount: "4400.00",
                    advanceInterestAmount: "600.00",
                    intermediaryHeldBalance: "0.00",
                    transferEventPublicIds: [eventPublicId],
                    duplicate: false,
                    auditPublicId: AUDIT_ID,
                    correlationId: AUDIT_ID,
                }),
            } as any,
        });
        const { client, transport } = clientFor(baseUrl);
        await client.connect(transport);

        const listed = await client.listTools();
        const expectedNewTools = [
            "intermediary.profile.get",
            "intermediary.bank-account.save",
            "intermediary.managed-loan.list",
            "intermediary.assignment.create",
            "intermediary.assignment.end",
            "intermediary.disbursement.list",
            "intermediary.disbursement.get",
            "intermediary.disbursement.create",
            "intermediary.disbursement.event.create",
            "intermediary.disbursement.evidence.prepare",
            "intermediary.disbursement.evidence.finalize",
            "intermediary.disbursement.preview",
            "intermediary.disbursement.post",
            "intermediary.disbursement.reverse",
        ];
        expect(listed.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(expectedNewTools));
        for (const name of [
            "intermediary.profile.get",
            "intermediary.managed-loan.list",
            "intermediary.disbursement.list",
            "intermediary.disbursement.get",
        ]) {
            expect(listed.tools.find((tool) => tool.name === name)?.annotations).toMatchObject({
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
            });
        }
        for (const name of ["intermediary.disbursement.post", "intermediary.disbursement.reverse"]) {
            expect(listed.tools.find((tool) => tool.name === name)?.annotations).toMatchObject({
                readOnlyHint: false,
                destructiveHint: true,
                idempotentHint: true,
                openWorldHint: false,
            });
        }
        expect(listed.tools.find((tool) => tool.name === "intermediary.disbursement.create")?.inputSchema)
            .toMatchObject({ additionalProperties: false });

        const profile = await client.callTool({
            name: "intermediary.profile.get",
            arguments: { intermediaryPublicId },
        });
        expect(profile.isError).not.toBe(true);
        expect(profile.structuredContent).toMatchObject({
            schemaVersion: "1.0",
            data: { publicId: intermediaryPublicId, assignments: [{ publicId: assignmentPublicId }] },
        });

        const inspected = await client.callTool({
            name: "intermediary.disbursement.get",
            arguments: { groupPublicId },
        });
        expect(inspected.isError).not.toBe(true);
        expect(JSON.stringify(inspected.structuredContent)).not.toMatch(/uploadUrl|signedUrl|objectKey|bucket/u);

        const unknownField = await client.callTool({
            name: "intermediary.disbursement.get",
            arguments: { groupPublicId, includeSignedEvidenceUrls: true },
        });
        expect(unknownField.isError).toBe(true);
        const unconfirmed = await client.callTool({
            name: "intermediary.disbursement.post",
            arguments: { groupPublicId, proposalPublicId, confirmed: false, idempotencyKey: "group-post-1" },
        });
        expect(unconfirmed.isError).toBe(true);
        const posted = await client.callTool({
            name: "intermediary.disbursement.post",
            arguments: { groupPublicId, proposalPublicId, confirmed: true, idempotencyKey: "group-post-1" },
        });
        expect(posted.isError).not.toBe(true);
        expect(posted.structuredContent).toMatchObject({
            schemaVersion: "1.0",
            data: { publicId: groupPublicId, status: "posted", borrowerPayoutAmount: "4400.00" },
            auditPublicIds: [AUDIT_ID],
        });

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
            "loan.settlement.execute",
            "loan.disbursement.update",
            "loan.disbursement.post",
            "loan.disbursement.reverse",
            "intermediary.bank-account.save",
            "intermediary.assignment.end",
            "intermediary.disbursement.evidence.prepare",
            "intermediary.disbursement.evidence.finalize",
            "intermediary.disbursement.post",
            "intermediary.disbursement.reverse",
            "intermediary.remittance.post",
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
