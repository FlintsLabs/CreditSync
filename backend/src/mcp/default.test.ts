import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { and, eq, sql } from "drizzle-orm";
import { Elysia } from "elysia";
import { db } from "../db";
import {
    bankLoans,
    bankProfiles,
    auditLogs,
    borrowers,
    loanFundingAllocations,
    loanDisbursementEvents,
    loanDisbursements,
    loanInterestRatePeriods,
    loanSchedules,
    loans,
    intermediaries,
    paymentIntakes,
    transactions,
    users,
} from "../db/schema";
import type { EvidenceStorageGateway } from "../services/payment-service";
import type { DisbursementEvidenceStorageGateway } from "../services/loan-disbursement-service";
import type { IntermediaryRemittanceEvidenceGateway } from "../services/intermediary-service";
import type { TransferEvidenceStorageGateway } from "../services/transfer-evidence-service";
import { createDefaultMcpHttpPlugin } from "./default";
import { MCP_TOOL_NAMES, type McpToolName } from "./server";

const integrationEnabled = Boolean(process.env.TEST_DATABASE_URL);
const integrationTest = integrationEnabled ? test : test.skip;
const TOKEN = "default-adapter-contract-token";
const TENANT_ID = "tenant-mcp-default-contract";
const ACTOR_EMAIL = "mcp-default@example.test";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const runningApps: Array<{ stop(): Promise<unknown> | unknown }> = [];

function isDisposableTestDatabase(value: string | undefined) {
    if (!value) return false;
    try {
        const databaseName = decodeURIComponent(new URL(value).pathname.replace(/^\//u, ""));
        return /(?:^|[_-])test(?:$|[_-])/iu.test(databaseName);
    } catch {
        return false;
    }
}

afterEach(async () => {
    for (const app of runningApps.splice(0)) await app.stop();
});

if (integrationEnabled) beforeEach(async () => {
    if (!isDisposableTestDatabase(process.env.DATABASE_URL)) {
        throw new Error("MCP integration tests require DATABASE_URL to name an explicit disposable test database");
    }
    await db.execute(sql`TRUNCATE TABLE
        audit_logs, fund_ledger_entries, loan_adjustments, loan_renewals,
        payment_match_allocations, payment_match_proposals, payment_evidence,
        transactions, payment_intakes, loan_funding_allocations, loan_schedules,
        loans, borrower_aliases, borrowers, bank_loan_schedules, bank_loans,
        bank_profiles, files, users
        RESTART IDENTITY CASCADE`);
});

function runtimeEnv() {
    return {
        MCP_API_TOKEN_HASHES: createHash("sha256").update(TOKEN).digest("hex"),
        MCP_ALLOWED_HOSTS: "127.0.0.1",
        MCP_TENANT_ID: TENANT_ID,
        MCP_ACTOR_EMAIL: ACTOR_EMAIL,
        MCP_RATE_LIMIT_MAX: "200",
        MCP_RATE_LIMIT_WINDOW_SECONDS: "60",
    };
}

async function startDefaultServer(options?: { evidenceGateway?: EvidenceStorageGateway; disbursementEvidenceGateway?: DisbursementEvidenceStorageGateway; intermediaryRemittanceEvidenceGateway?: IntermediaryRemittanceEvidenceGateway; transferEvidenceGateway?: TransferEvidenceStorageGateway }) {
    const app = new Elysia().use(createDefaultMcpHttpPlugin(runtimeEnv(), options)).listen({ hostname: "127.0.0.1", port: 0 });
    runningApps.push(app);
    const client = new Client({ name: "creditsync-default-adapter-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${app.server!.port}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    });
    await client.connect(transport);
    return { client, transport };
}

function resultData(result: Awaited<ReturnType<Client["callTool"]>>) {
    expect(result.isError).not.toBe(true);
    const structured = result.structuredContent as {
        schemaVersion: string;
        data: Record<string, unknown>;
        auditPublicIds?: string[];
        correlationId?: string;
    };
    expect(structured.schemaVersion).toBe("1.0");
    return structured;
}

function expectWriteAuditMetadata(data: Record<string, unknown>) {
    expect(data).toMatchObject({
        auditPublicId: expect.stringMatching(UUID_PATTERN),
        correlationId: expect.stringMatching(UUID_PATTERN),
    });
}

describe("default MCP adapter integration", () => {
    // Break caught: the real MCP adapter cannot complete the inspect-first borrower/intermediary
    // assignment -> exact group/events -> three finalized slips -> zero-variance preview ->
    // explicitly confirmed atomic post workflow through direct application-service calls.
    integrationTest("posts an exact three-slip intermediated disbursement through direct service handlers", async () => {
        const actor = await db.insert(users).values({
            tenantId: TENANT_ID,
            email: ACTOR_EMAIL,
            role: "owner",
        }).returning().then((rows) => rows[0]!);
        const borrower = await db.insert(borrowers).values({
            tenantId: TENANT_ID,
            ownerUserId: actor.id,
            name: "MCP exact borrower",
        }).returning().then((rows) => rows[0]!);
        const loan = await db.insert(loans).values({
            tenantId: TENANT_ID,
            ownerUserId: actor.id,
            borrowerId: borrower.id,
            principalAmount: "5000.00",
            outstandingPrincipal: "5000.00",
            outstandingInterest: "0.00",
            outstandingFees: "0.00",
            interestRate: "0.00",
            repaymentType: "floating",
            activationIdempotencyKey: "mcp-intermediated-activation",
            activationResult: {
                publicId: "00000000-0000-7000-8000-000000000001",
                principal: "5000.00",
                principalAmount: "5000.00",
                interestRate: "0.00",
                repaymentType: "floating",
                floatingInterestPolicy: {
                    periodUnit: "week",
                    periodLength: 1,
                    rateMode: "percent",
                    rate: "12.0000",
                    advanceInterestPeriods: 1,
                    advanceInterestRefundPolicy: "non_refundable",
                },
                status: "active",
            },
            status: "active",
        }).returning().then((rows) => rows[0]!);
        const intermediary = await db.insert(intermediaries).values({
            tenantId: TENANT_ID,
            ownerUserId: actor.id,
            name: "MCP exact intermediary",
            normalizedName: "mcp exact intermediary",
            aliases: ["MCP transfer agent"],
            createdByUserId: actor.id,
            updatedByUserId: actor.id,
        }).returning().then((rows) => rows[0]!);
        await db.insert(loanDisbursements).values({
            tenantId: TENANT_ID,
            loanId: loan.id,
            grossPrincipal: "5000.00",
            firstDayInterestDeducted: "600.00",
            netDisbursement: "4400.00",
            disbursedAt: new Date("2026-08-13T02:00:00.000Z"),
            createdByUserId: actor.id,
        });
        const preparedHeads = new Map<string, Awaited<ReturnType<TransferEvidenceStorageGateway["head"]>>>();
        const transferEvidenceGateway: TransferEvidenceStorageGateway = {
            preparePut: async (request) => {
                preparedHeads.set(request.key, {
                    exists: true,
                    contentType: request.contentType,
                    contentLength: request.contentLength,
                    checksumSha256: request.checksumSha256,
                    metadata: request.metadata,
                });
                return {
                    uploadUrl: `https://upload.example.test/${encodeURIComponent(request.key)}`,
                    expiresAt: new Date(Date.now() + 5 * 60_000),
                    requiredHeaders: { "content-type": request.contentType },
                };
            },
            head: async (key) => preparedHeads.get(key) ?? {
                exists: false,
                contentType: null,
                contentLength: null,
                checksumSha256: null,
                metadata: {},
            },
            createAccess: async () => ({
                url: "https://access.example.test/not-used-by-mcp",
                expiresAt: new Date(Date.now() + 5 * 60_000),
            }),
        };
        const { client } = await startDefaultServer({ transferEvidenceGateway });

        const borrowerSearch = resultData(await client.callTool({
            name: "borrower.search",
            arguments: { query: "MCP exact borrower" },
        })).data;
        expect(borrowerSearch).toMatchObject({
            resolution: "unique",
            matchType: "canonical",
            candidates: [{ publicId: borrower.publicId }],
        });
        const intermediarySearch = resultData(await client.callTool({
            name: "intermediary.search",
            arguments: { query: "MCP exact intermediary" },
        })).data;
        expect(intermediarySearch).toMatchObject({ items: [{ publicId: intermediary.publicId }] });

        const assignment = resultData(await client.callTool({
            name: "intermediary.assignment.create",
            arguments: {
                loanPublicId: loan.publicId,
                intermediaryPublicId: intermediary.publicId,
                role: "disbursement",
                effectiveFrom: "2026-08-01T00:00:00.000Z",
                idempotencyKey: "mcp-intermediated-assignment",
            },
        })).data;
        expectWriteAuditMetadata(assignment);
        const profile = resultData(await client.callTool({
            name: "intermediary.profile.get",
            arguments: { intermediaryPublicId: intermediary.publicId },
        })).data;
        expect(profile).toMatchObject({
            publicId: intermediary.publicId,
            assignments: [{ publicId: assignment.publicId, loanPublicId: loan.publicId, status: "active" }],
        });

        const group = resultData(await client.callTool({
            name: "intermediary.disbursement.create",
            arguments: {
                loanPublicId: loan.publicId,
                intermediaryPublicId: intermediary.publicId,
                retainedBalance: "0.00",
                idempotencyKey: "mcp-intermediated-group",
            },
        })).data;
        const eventSpecs = [
            ["funding_to_intermediary", "5000.00"],
            ["borrower_net_payout", "4400.00"],
            ["advance_interest_return", "600.00"],
        ] as const;
        const evidenceSpecs: Array<{ publicId: string; filePublicId: string }> = [];
        for (const [index, [role, amount]] of eventSpecs.entries()) {
            const event = resultData(await client.callTool({
                name: "intermediary.disbursement.event.create",
                arguments: {
                    groupPublicId: group.publicId,
                    role,
                    channel: "bank_transfer",
                    amount,
                    transferredAt: `2026-08-13T0${index + 2}:00:00.000Z`,
                    senderHint: index === 0 ? "Owner funding account" : "MCP exact intermediary",
                    payeeHint: index === 1 ? "MCP exact borrower" : "MCP exact intermediary",
                    bankReference: `MCP-INTERMEDIATED-${index + 1}`,
                    idempotencyKey: `mcp-intermediated-event-${index + 1}`,
                },
            })).data;
            const prepared = resultData(await client.callTool({
                name: "intermediary.disbursement.evidence.prepare",
                arguments: {
                    groupPublicId: group.publicId,
                    eventPublicId: event.publicId,
                    mimeType: "image/png",
                    size: 4,
                    sha256: String(index + 1).repeat(64),
                    originalName: `slip-${index + 1}.png`,
                },
            })).data;
            expectWriteAuditMetadata(prepared);
            expect(prepared.uploadUrl).toMatch(/^https:\/\/upload\.example\.test\//);
            evidenceSpecs.push({
                publicId: String(prepared.publicId),
                filePublicId: String(prepared.filePublicId),
            });
            const finalized = resultData(await client.callTool({
                name: "intermediary.disbursement.evidence.finalize",
                arguments: {
                    groupPublicId: group.publicId,
                    eventPublicId: event.publicId,
                    evidencePublicId: prepared.publicId,
                },
            })).data;
            expectWriteAuditMetadata(finalized);
            expect(finalized).toMatchObject({ publicId: prepared.publicId, status: "ready" });
        }

        const listed = resultData(await client.callTool({
            name: "intermediary.disbursement.list",
            arguments: { loanPublicId: loan.publicId, intermediaryPublicId: intermediary.publicId },
        })).data;
        const inspected = resultData(await client.callTool({
            name: "intermediary.disbursement.get",
            arguments: { groupPublicId: group.publicId },
        })).data;
        expect(inspected.events).toHaveLength(3);
        const expectedEvents = eventSpecs.map(([role, amount], index) => ({
            role,
            amount,
            payeeHint: index === 1 ? "MCP exact borrower" : "MCP exact intermediary",
            bankReference: `MCP-INTERMEDIATED-${index + 1}`,
            evidence: {
                status: "ready",
                count: 1,
                items: [{
                    ...evidenceSpecs[index]!,
                    status: "ready",
                    mimeType: "image/png",
                }],
            },
        }));
        expect(inspected.events).toEqual(expectedEvents.map((expected) => expect.objectContaining(expected)));
        expect(listed.items).toEqual([
            expect.objectContaining({
                publicId: group.publicId,
                events: expectedEvents.map((expected) => expect.objectContaining(expected)),
            }),
        ]);
        expect(JSON.stringify(inspected)).not.toMatch(/uploadUrl|signedUrl|objectKey|bucket/u);
        expect(JSON.stringify(inspected)).not.toMatch(/sha256|checksum|storage/u);
        const preview = resultData(await client.callTool({
            name: "intermediary.disbursement.preview",
            arguments: { groupPublicId: group.publicId },
        })).data;
        expect(preview).toMatchObject({
            status: "ready",
            actualFunding: "5000.00",
            actualBorrowerPayout: "4400.00",
            actualAdvanceInterestReturn: "600.00",
            retainedBalance: "0.00",
            variance: "0.00",
            evidenceReady: true,
            warnings: [],
        });
        expect((await client.callTool({
            name: "intermediary.disbursement.post",
            arguments: {
                groupPublicId: group.publicId,
                proposalPublicId: preview.publicId,
                confirmed: false,
                idempotencyKey: "mcp-intermediated-post",
            },
        })).isError).toBe(true);
        const posted = resultData(await client.callTool({
            name: "intermediary.disbursement.post",
            arguments: {
                groupPublicId: group.publicId,
                proposalPublicId: preview.publicId,
                confirmed: true,
                idempotencyKey: "mcp-intermediated-post",
            },
        }));
        expect(posted).toMatchObject({
            data: {
                publicId: group.publicId,
                status: "posted",
                fundingAmount: "5000.00",
                borrowerPayoutAmount: "4400.00",
                advanceInterestAmount: "600.00",
                intermediaryHeldBalance: "0.00",
            },
            auditPublicIds: [expect.stringMatching(UUID_PATTERN)],
            correlationId: expect.stringMatching(UUID_PATTERN),
        });

        await client.close();
    });

    // Break caught: the default adapter cannot originate a generalized weekly policy or close it through the settlement service.
    integrationTest("previews and executes an exact non-refundable weekly floating settlement idempotently", async () => {
        const actor = await db.insert(users).values({
            tenantId: TENANT_ID,
            email: ACTOR_EMAIL,
            role: "owner",
        }).returning().then((rows) => rows[0]!);
        const borrower = await db.insert(borrowers).values({
            tenantId: TENANT_ID,
            ownerUserId: actor.id,
            name: "MCP weekly settlement borrower",
        }).returning().then((rows) => rows[0]!);
        const { client } = await startDefaultServer();
        const terms = {
            principal: "5000.00",
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
        };

        const previewedLoan = resultData(await client.callTool({ name: "loan.preview", arguments: terms }));
        expect(previewedLoan.data).toMatchObject({
            floatingInterestPolicy: { periodUnit: "week", rate: "12.0000", advanceInterestPeriods: 1 },
            fullPeriodInterest: "600.00",
            advanceInterest: "600.00",
            netBorrowerPayout: "4400.00",
            periodDays: 7,
        });
        const draft = resultData(await client.callTool({
            name: "loan.draft",
            arguments: { borrowerPublicId: borrower.publicId, ...terms },
        })).data;
        expect(draft.publicId).toMatch(UUID_PATTERN);
        expect(draft).toMatchObject({
            status: "draft",
            floatingInterestPolicy: { periodUnit: "week", rate: "12.0000", advanceInterestRefundPolicy: "non_refundable" },
        });
        const loanPublicId = String(draft.publicId);
        const activationArgs = { loanPublicId, idempotencyKey: "mcp-weekly-activation-1" };
        const activated = resultData(await client.callTool({ name: "loan.activate", arguments: activationArgs }));
        const activationRetry = resultData(await client.callTool({ name: "loan.activate", arguments: activationArgs }));
        expect(activationRetry.data).toEqual(activated.data);

        const settlement = resultData(await client.callTool({
            name: "loan.settlement.preview",
            arguments: { loanPublicId, asOfDate: "2026-08-15" },
        })).data;
        expect(settlement).toMatchObject({
            status: "ready",
            asOfDate: "2026-08-15",
            outstandingPrincipal: "5000.00",
            dueInterest: "0.00",
            accruedNotDueInterest: "0.00",
            nonRefundableAdvanceInterest: "600.00",
            settlementTotal: "5000.00",
        });
        const executeArgs = {
            settlementPublicId: settlement.publicId,
            previewHash: settlement.previewHash,
            confirmed: true,
            reason: "Borrower confirmed exact weekly close-out",
            idempotencyKey: "mcp-weekly-settlement-1",
        };
        const executed = resultData(await client.callTool({ name: "loan.settlement.execute", arguments: executeArgs }));
        const executeRetry = resultData(await client.callTool({ name: "loan.settlement.execute", arguments: executeArgs }));
        expect(executeRetry.data).toEqual(executed.data);
        expect(executed).toMatchObject({
            data: {
                status: "executed",
                settlementTotal: "5000.00",
                nonRefundableAdvanceInterest: "600.00",
                transaction: { amount: "5000.00", principalComponent: "5000.00", interestComponent: "0.00" },
            },
            auditPublicIds: [expect.stringMatching(UUID_PATTERN)],
            correlationId: expect.stringMatching(UUID_PATTERN),
        });
        expect(await db.query.loans.findFirst({ where: eq(loans.publicId, loanPublicId) })).toMatchObject({
            status: "paid",
            outstandingPrincipal: "0.00",
        });
        expect((await db.select().from(transactions)).filter((row) => row.type === "close_account")).toHaveLength(1);
        await client.close();
    });

    integrationTest("lists, previews, and executes a confirmed floating interest-rate change", async () => {
        const actor = await db.insert(users).values({ tenantId: TENANT_ID, email: ACTOR_EMAIL, role: "owner" }).returning().then((rows) => rows[0]!);
        const borrower = await db.insert(borrowers).values({ tenantId: TENANT_ID, ownerUserId: actor.id, name: "MCP rate borrower" }).returning().then((rows) => rows[0]!);
        const loan = await db.insert(loans).values({
            tenantId: TENANT_ID, ownerUserId: actor.id, borrowerId: borrower.id,
            principalAmount: "1000.00", outstandingPrincipal: "1000.00", interestRate: "0.00",
            repaymentType: "floating", firstDayTreatment: "start_next_day", interestStartDate: "2026-08-01", status: "active",
        }).returning().then((rows) => rows[0]!);
        await db.insert(loanInterestRatePeriods).values({
            tenantId: TENANT_ID, loanId: loan.id, effectiveDate: "2026-08-01", expiryDate: null,
            rateType: "per_thousand", rate: "15.0000", createdByUserId: actor.id,
        });
        const { client } = await startDefaultServer();

        const listed = resultData(await client.callTool({
            name: "loan.interest-rate.list",
            arguments: { loanPublicId: loan.publicId },
        }));
        expect(listed.data).toMatchObject({ loanPublicId: loan.publicId, currentPeriod: { rate: "15.0000" }, dailyInterestAtCurrentPrincipal: "15.00" });

        const previewed = resultData(await client.callTool({
            name: "loan.interest-rate.preview",
            arguments: { loanPublicId: loan.publicId, effectiveDate: "2026-09-01", expiryDate: null, rateType: "percent", rate: "1" },
        }));
        const preview = previewed.data as { publicId: string; previewHash: string };
        const executed = resultData(await client.callTool({
            name: "loan.interest-rate.execute",
            arguments: {
                loanPublicId: loan.publicId, previewPublicId: preview.publicId, previewHash: preview.previewHash,
                confirmed: true, reason: "Owner approved future rate", idempotencyKey: "mcp-rate-change-1",
            },
        }));
        expect(executed.data).toMatchObject({ loanPublicId: loan.publicId, nextChange: { effectiveDate: "2026-09-01", rate: "1.0000" } });
        expect(executed.auditPublicIds).toHaveLength(1);
        expect(executed.correlationId).toMatch(UUID_PATTERN);
        await client.close();
    });

    integrationTest("rejects evidence IDs on disbursement draft so callers use prepare then finalize", async () => {
        const actor = await db.insert(users).values({ tenantId: TENANT_ID, email: ACTOR_EMAIL, role: "owner" }).returning().then((rows) => rows[0]!);
        const borrower = await db.insert(borrowers).values({ tenantId: TENANT_ID, ownerUserId: actor.id, name: "MCP evidence boundary borrower" }).returning().then((rows) => rows[0]!);
        const loan = await db.insert(loans).values({ tenantId: TENANT_ID, ownerUserId: actor.id, borrowerId: borrower.id, principalAmount: "100.00", interestRate: "0.00", repaymentType: "floating", outstandingPrincipal: "100.00", status: "active" }).returning().then((rows) => rows[0]!);
        const { client } = await startDefaultServer();
        const result = await client.callTool({
            name: "loan.disbursement.draft",
            arguments: {
                loanPublicId: loan.publicId, grossAmount: "100.00", loanAttributedAmount: "100.00",
                channel: "cash", disbursedAt: "2026-08-10T00:00:00.000Z",
                evidenceFilePublicIds: ["0198c481-3e2b-7000-8000-000000000098"],
            },
        });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({ schemaVersion: "1.0", error: { code: "EVIDENCE_ATTACH_AFTER_DRAFT" } });
        await client.close();
    });

    // Break caught: an already-overallocated source turns loan activation into INTERNAL_ERROR instead of a stable capacity rejection.
    integrationTest("returns stable zero remaining capacity and rolls back MCP activation on an overallocated drawdown", async () => {
        const actor = await db.insert(users).values({
            tenantId: TENANT_ID,
            email: ACTOR_EMAIL,
            role: "owner",
        }).returning().then((rows) => rows[0]!);
        const borrower = await db.insert(borrowers).values({
            tenantId: TENANT_ID,
            ownerUserId: actor.id,
            name: "MCP overallocated borrower",
        }).returning().then((rows) => rows[0]!);
        const profile = await db.insert(bankProfiles).values({
            tenantId: TENANT_ID,
            name: "MCP overallocated source",
            type: "bank",
        }).returning().then((rows) => rows[0]!);
        const drawdown = await db.insert(bankLoans).values({
            tenantId: TENANT_ID,
            bankProfileId: profile.id,
            amount: "100.00",
        }).returning().then((rows) => rows[0]!);
        const [existingLoan, draft] = await db.insert(loans).values([
            {
                tenantId: TENANT_ID, ownerUserId: actor.id, borrowerId: borrower.id,
                principalAmount: "120.00", interestRate: "0.00", repaymentType: "floating",
                outstandingPrincipal: "120.00", status: "active",
            },
            {
                tenantId: TENANT_ID, ownerUserId: actor.id, borrowerId: borrower.id, bankLoanId: drawdown.id,
                principalAmount: "10.00", interestRate: "0.00", repaymentType: "daily", termMonths: 1,
                totalInstallments: 1, installmentAmount: "10.00", startDate: "2026-08-10",
                outstandingPrincipal: "0.00", outstandingInterest: "0.00", outstandingFees: "0.00", status: "draft",
            },
        ]).returning();
        await db.insert(loanFundingAllocations).values({
            tenantId: TENANT_ID,
            bankProfileId: profile.id,
            bankLoanId: drawdown.id,
            loanId: existingLoan!.id,
            allocatedAmount: "120.00",
            allocationDate: "2026-08-10",
            allocationType: "initial",
            createdByUserId: actor.id,
        });
        const { client } = await startDefaultServer();

        const result = await client.callTool({
            name: "loan.activate",
            arguments: { loanPublicId: draft!.publicId, idempotencyKey: "mcp-overallocated-activation" },
        });

        expect(result.isError).toBe(true);
        expect(result.structuredContent).toEqual({
            schemaVersion: "1.0",
            error: {
                code: "ALLOCATION_EXCEEDS_DRAWDOWN",
                message: "Allocation exceeds remaining drawdown balance",
                retryable: false,
                reviewRequired: false,
                details: { sourceRemaining: "0.00" },
            },
        });
        expect(await db.query.loans.findFirst({ where: eq(loans.id, draft!.id) })).toMatchObject({
            status: "draft",
            outstandingPrincipal: "0.00",
            outstandingInterest: "0.00",
            nextDueDate: null,
        });
        expect(await db.select().from(loanSchedules).where(eq(loanSchedules.loanId, draft!.id))).toHaveLength(0);
        expect(await db.select().from(loanFundingAllocations).where(eq(loanFundingAllocations.loanId, draft!.id))).toHaveLength(0);
        expect(await db.select().from(auditLogs).where(and(
            eq(auditLogs.entityId, draft!.publicId),
            eq(auditLogs.action, "activated"),
        ))).toHaveLength(0);

        await client.close();
    });

    // Break caught: signed compensating ledger values are rejected after the reversal has already committed.
    integrationTest("returns a successful audited payment reversal and the same public result on retry", async () => {
        const actor = await db.insert(users).values({
            tenantId: TENANT_ID,
            email: ACTOR_EMAIL,
            role: "owner",
        }).returning().then((rows) => rows[0]!);
        const borrower = await db.insert(borrowers).values({
            tenantId: TENANT_ID,
            ownerUserId: actor.id,
            name: "MCP reversal borrower",
        }).returning().then((rows) => rows[0]!);
        const loan = await db.insert(loans).values({
            tenantId: TENANT_ID,
            ownerUserId: actor.id,
            borrowerId: borrower.id,
            principalAmount: "100.00",
            interestRate: "0.00",
            repaymentType: "daily",
            termMonths: 1,
            installmentAmount: "100.00",
            totalInstallments: 1,
            startDate: "2026-08-09",
            outstandingPrincipal: "100.00",
            outstandingInterest: "0.00",
            outstandingFees: "0.00",
            status: "active",
        }).returning().then((rows) => rows[0]!);
        const schedule = await db.insert(loanSchedules).values({
            tenantId: TENANT_ID,
            loanId: loan.id,
            installmentNo: 1,
            dueDate: "2026-08-10",
            scheduledPrincipal: "100.00",
            scheduledInterest: "0.00",
            scheduledFee: "0.00",
            scheduledTotal: "100.00",
            remainingDue: "100.00",
            status: "pending",
        }).returning().then((rows) => rows[0]!);
        const { client } = await startDefaultServer();

        const created = resultData(await client.callTool({
            name: "intake.create",
            arguments: {
                amount: "40.00",
                receivedAt: "2026-08-10T00:00:00.000Z",
                idempotencyKey: "mcp-real-reversal-intake",
            },
        })).data;
        const intakePublicId = String(created.publicId);
        const preview = resultData(await client.callTool({
            name: "payment.preview",
            arguments: {
                paymentIntakePublicId: intakePublicId,
                allocations: [{
                    borrowerPublicId: borrower.publicId,
                    loanPublicId: loan.publicId,
                    schedulePublicId: schedule.publicId,
                    amount: "40.00",
                }],
            },
        })).data;
        resultData(await client.callTool({
            name: "payment.post",
            arguments: { paymentIntakePublicId: intakePublicId, proposalPublicId: preview.publicId },
        }));

        const first = resultData(await client.callTool({
            name: "payment.reverse",
            arguments: { paymentIntakePublicId: intakePublicId },
        }));
        const retry = resultData(await client.callTool({
            name: "payment.reverse",
            arguments: { paymentIntakePublicId: intakePublicId, reason: "Correct duplicate transfer" },
        }));

        expect(first.data).toEqual(retry.data);
        expect(first.data).toMatchObject({ publicId: intakePublicId, status: "reversed" });
        expect(first.data.transactions).toEqual(expect.arrayContaining([
            expect.objectContaining({ entryType: "reversal", amount: "-40.00", principalComponent: "-40.00" }),
        ]));
        expect(first.auditPublicIds).toHaveLength(1);
        expect(retry.auditPublicIds).toEqual(first.auditPublicIds);
        expect(first.auditPublicIds?.[0]).toMatch(UUID_PATTERN);
        expect(first.correlationId).toMatch(UUID_PATTERN);
        expect(retry.correlationId).toMatch(UUID_PATTERN);
        expect(await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.publicId, intakePublicId) }))
            .toMatchObject({ status: "reversed" });
        expect(await db.select().from(transactions).where(eq(transactions.paymentIntakeId,
            (await db.query.paymentIntakes.findFirst({ where: eq(paymentIntakes.publicId, intakePublicId) }))!.id)))
            .toHaveLength(2);
        expect((await db.select().from(auditLogs)).find((entry) =>
            entry.entityId === intakePublicId && entry.action === "reversed")?.payload)
            .toMatchObject({ reason: "MCP 1.0 compatibility reversal" });

        await client.close();
    });

    // Break caught: a frozen tool delegates to the wrong shared service or its real presenter violates the advertised schema.
    integrationTest("successfully calls every frozen tool through the real default service adapter", async () => {
        const actor = await db.insert(users).values({
            tenantId: TENANT_ID,
            email: ACTOR_EMAIL,
            role: "owner",
        }).returning().then((rows) => rows[0]!);
        const profile = await db.insert(bankProfiles).values({
            tenantId: TENANT_ID,
            name: "MCP contract source",
            type: "bank",
            providerName: "Contract Bank",
            creditLimit: "1000.00",
        }).returning().then((rows) => rows[0]!);
        const drawdown = await db.insert(bankLoans).values({
            tenantId: TENANT_ID,
            bankProfileId: profile.id,
            amount: "1000.00",
            outstandingPrincipal: "1000.00",
            outstandingInterest: "0.00",
            outstandingFees: "0.00",
            outstandingPenalties: "0.00",
            interestRate: "0.00",
            startDate: "2026-08-01",
            termMonths: 12,
            status: "active",
        }).returning().then((rows) => rows[0]!);
        const preparedHeads = new Map<string, Awaited<ReturnType<EvidenceStorageGateway["head"]>>>();
        const evidenceGateway: EvidenceStorageGateway & TransferEvidenceStorageGateway = {
            preparePut: async (request) => {
                preparedHeads.set(request.key, {
                    exists: true,
                    contentType: request.contentType,
                    contentLength: request.contentLength,
                    checksumSha256: request.checksumSha256,
                    metadata: request.metadata,
                });
                return {
                    uploadUrl: `https://upload.example.test/${encodeURIComponent(request.key)}`,
                    expiresAt: new Date(Date.now() + 5 * 60_000),
                };
            },
            head: async (key) => preparedHeads.get(key) ?? {
                exists: false,
                contentType: null,
                contentLength: null,
                checksumSha256: null,
                metadata: {},
            },
            createAccess: async () => ({
                url: "https://access.example.test/not-used-by-mcp",
                expiresAt: new Date(Date.now() + 5 * 60_000),
            }),
        };
        const { client, transport } = await startDefaultServer({
            evidenceGateway,
            disbursementEvidenceGateway: evidenceGateway,
            intermediaryRemittanceEvidenceGateway: evidenceGateway,
            transferEvidenceGateway: evidenceGateway,
        });
        const listed = await client.listTools();
        expect(listed.tools.map((tool) => tool.name)).toEqual([...MCP_TOOL_NAMES]);
        const called: McpToolName[] = [];
        const call = async (name: McpToolName, args: Record<string, unknown>) => {
            const result = resultData(await client.callTool({ name, arguments: args }));
            called.push(name);
            expect(result.data).toBeObject();
            return result;
        };

        expect(transport.sessionId).toBeUndefined();
        const createdBorrower = (await call("borrower.create", { name: "MCP all-tools borrower" })).data;
        const borrowerPublicId = String(createdBorrower.publicId);
        await call("borrower.search", { query: "MCP all-tools borrower" });
        await call("borrower.update", { borrowerPublicId, changes: { notes: "updated by MCP contract" } });
        await call("borrower.alias", {
            action: "add",
            borrowerPublicId,
            alias: "MCP contract alias",
            source: "manual",
        });
        await call("borrower.portfolio", { borrowerPublicId });
        const borrower = await db.query.borrowers.findFirst({ where: eq(borrowers.publicId, borrowerPublicId) });
        const floatingLoan = await db.insert(loans).values({
            tenantId: TENANT_ID, ownerUserId: actor.id, borrowerId: borrower!.id,
            principalAmount: "1000.00", outstandingPrincipal: "1000.00", interestRate: "0.00",
            repaymentType: "floating", firstDayTreatment: "start_next_day", interestStartDate: "2026-08-01",
            interestPeriodUnit: "day", interestPeriodLength: 1, advanceInterestPeriods: 0,
            advanceInterestRefundPolicy: "non_refundable", interestPeriodAnchorDate: "2026-08-01",
            dailyInterestMode: "per_thousand", dailyInterestRate: "15.0000", status: "active",
        }).returning().then((rows) => rows[0]!);
        await db.insert(loanInterestRatePeriods).values({
            tenantId: TENANT_ID, loanId: floatingLoan.id, effectiveDate: "2026-08-01", expiryDate: null,
            rateType: "per_thousand", rate: "15.0000", createdByUserId: actor.id,
        });
        await call("loan.interest-rate.list", { loanPublicId: floatingLoan.publicId });
        const ratePreview = (await call("loan.interest-rate.preview", {
            loanPublicId: floatingLoan.publicId, effectiveDate: "2026-09-01", expiryDate: null,
            rateType: "percent", rate: "1",
        })).data;
        await call("loan.interest-rate.execute", {
            loanPublicId: floatingLoan.publicId, previewPublicId: ratePreview.publicId,
            previewHash: ratePreview.previewHash, confirmed: true, reason: "MCP all-tools rate change",
            idempotencyKey: "mcp-all-tools-rate-execute",
        });
        const settlementPreview = (await call("loan.settlement.preview", {
            loanPublicId: floatingLoan.publicId,
            asOfDate: "2026-08-10",
        })).data;
        await call("loan.settlement.execute", {
            settlementPublicId: settlementPreview.publicId,
            previewHash: settlementPreview.previewHash,
            confirmed: true,
            reason: "MCP all-tools floating settlement",
            idempotencyKey: "mcp-all-tools-settlement-execute",
        });

        const loanTerms = {
            principal: "100.00",
            interestRate: "0.00",
            termMonths: 1,
            repaymentType: "daily",
            startDate: "2026-08-09",
            totalInstallments: 1,
            installmentAmount: "100.00",
        };
        await call("loan.preview", loanTerms);
        const drafted = (await call("loan.draft", {
            borrowerPublicId,
            bankLoanPublicId: drawdown.publicId,
            ...loanTerms,
        })).data;
        const loanPublicId = String(drafted.publicId);
        await call("loan.activate", { loanPublicId, idempotencyKey: "mcp-all-tools-loan-activate" });
        const activatedLoan = (await db.query.loans.findFirst({ where: eq(loans.publicId, loanPublicId) }))!;
        await db.insert(loanDisbursements).values({
            tenantId: TENANT_ID,
            loanId: activatedLoan.id,
            grossPrincipal: "100.00",
            firstDayInterestDeducted: "0.00",
            netDisbursement: "100.00",
            createdByUserId: actor.id,
        });
        const disbursement = (await call("loan.disbursement.draft", {
            loanPublicId,
            grossAmount: "100.00",
            loanAttributedAmount: "100.00",
            channel: "cash",
            disbursedAt: "2026-08-10T00:00:00.000Z",
        })).data;
        const disbursementPublicId = String(disbursement.publicId);
        const disbursementEvidence = (await call("loan.disbursement.evidence.prepare", {
            disbursementPublicId,
            mimeType: "image/png",
            size: 4,
            sha256: "b".repeat(64),
        })).data;
        await call("loan.disbursement.evidence.finalize", {
            disbursementPublicId,
            evidencePublicId: disbursementEvidence.publicId,
        });
        const updatedDisbursement = (await call("loan.disbursement.update", {
            disbursementPublicId,
            changes: { loanAttributedAmount: "95.00", note: "Corrected attributed amount" },
        })).data;
        expect(updatedDisbursement).toMatchObject({
            publicId: disbursementPublicId,
            grossAmount: "100.00",
            loanAttributedAmount: "95.00",
            channel: "cash",
            note: "Corrected attributed amount",
            evidenceFilePublicIds: [disbursementEvidence.filePublicId],
        });
        const updateAudit = (await db.select().from(auditLogs)).find((entry) =>
            entry.entityId === disbursementPublicId && entry.action === "draft_updated");
        expect(updateAudit?.payload).toMatchObject({
            before: { grossAmount: "100.00", loanAttributedAmount: "100.00", channel: "cash" },
            after: { grossAmount: "100.00", loanAttributedAmount: "95.00", channel: "cash", note: "Corrected attributed amount" },
        });
        const refreshedDisbursements = (await call("loan.disbursement.list", { loanPublicId })).data;
        expect(refreshedDisbursements.events).toEqual(expect.arrayContaining([
            expect.objectContaining({ publicId: disbursementPublicId, loanAttributedAmount: "95.00", evidenceFilePublicIds: [disbursementEvidence.filePublicId] }),
        ]));
        await call("loan.disbursement.post", {
            disbursementPublicId,
            idempotencyKey: "mcp-all-tools-disbursement-post",
        });
        await expect(client.callTool({
            name: "loan.disbursement.update",
            arguments: { disbursementPublicId, changes: { note: "Must remain immutable" } },
        })).rejects.toThrow();
        expect(await db.query.loanDisbursementEvents.findFirst({ where: eq(loanDisbursementEvents.publicId, disbursementPublicId) }))
            .toMatchObject({ status: "posted", note: "Corrected attributed amount" });
        await call("loan.disbursement.reverse", {
            disbursementPublicId,
            reason: "MCP all-tools disbursement reversal",
            idempotencyKey: "mcp-all-tools-disbursement-reverse",
        });

        const intake = (await call("intake.create", {
            amount: "40.00",
            receivedAt: "2026-08-10T00:00:00.000Z",
            payerName: "MCP payer",
            idempotencyKey: "mcp-all-tools-intake",
        })).data;
        const intakePublicId = String(intake.publicId);
        await call("intake.list", { status: "draft" });
        const evidence = (await call("evidence.prepare", {
            paymentIntakePublicId: intakePublicId,
            mimeType: "image/png",
            size: 4,
            sha256: "a".repeat(64),
            evidenceType: "slip",
        })).data;
        const finalized = (await call("evidence.finalize", {
            paymentIntakePublicId: intakePublicId,
            evidencePublicId: evidence.publicId,
        })).data;
        const inspected = (await call("intake.get", { paymentIntakePublicId: intakePublicId })).data;
        expect(inspected.evidence).toEqual([
            expect.objectContaining({
                publicId: evidence.publicId,
                status: "ready",
                filePublicId: finalized.filePublicId,
            }),
        ]);

        const proposal = (await call("payment.preview", {
            paymentIntakePublicId: intakePublicId,
            allocations: [{ borrowerPublicId, loanPublicId, amount: "40.00" }],
        })).data;
        await call("payment.post", {
            paymentIntakePublicId: intakePublicId,
            proposalPublicId: proposal.publicId,
        });
        await call("payment.reverse", {
            paymentIntakePublicId: intakePublicId,
            reason: "Correct duplicate transfer",
        });

        await call("intermediary.search", { query: "MCP all-tools collector" });
        const intermediary = (await call("intermediary.create", { name: "MCP all-tools collector" })).data;
        const bankAccount = (await call("intermediary.bank-account.save", {
            intermediaryPublicId: intermediary.publicId,
            bankCode: "BBL",
            bankName: "Bangkok Bank",
            accountName: "MCP all-tools collector",
            accountNumber: "1234567890",
            idempotencyKey: "mcp-all-tools-intermediary-account",
        })).data;
        expectWriteAuditMetadata(bankAccount);
        const assignment = (await call("intermediary.assignment.create", {
            loanPublicId,
            intermediaryPublicId: intermediary.publicId,
            role: "disbursement",
            effectiveFrom: "2026-08-01T00:00:00.000Z",
            idempotencyKey: "mcp-all-tools-intermediary-assignment",
        })).data;
        expectWriteAuditMetadata(assignment);
        await call("intermediary.profile.get", { intermediaryPublicId: intermediary.publicId });
        await call("intermediary.managed-loan.list", { intermediaryPublicId: intermediary.publicId, role: "disbursement" });
        const group = (await call("intermediary.disbursement.create", {
            loanPublicId,
            intermediaryPublicId: intermediary.publicId,
            retainedBalance: "0.00",
            idempotencyKey: "mcp-all-tools-intermediated-group",
        })).data;
        expect(group).toMatchObject({
            expectedFunding: "100.00",
            expectedBorrowerPayout: "100.00",
            expectedAdvanceInterestReturn: "0.00",
        });
        expect(await db.query.loanDisbursements.findFirst({ where: eq(loanDisbursements.loanId, activatedLoan.id) }))
            .toMatchObject({ grossPrincipal: "100.00", firstDayInterestDeducted: "0.00", netDisbursement: "100.00" });
        const groupEvents: Array<Record<string, unknown>> = [];
        for (const [index, [role, amount]] of ([
            ["funding_to_intermediary", "100.00"],
            ["borrower_net_payout", "100.00"],
        ] as const).entries()) {
            groupEvents.push((await call("intermediary.disbursement.event.create", {
                groupPublicId: group.publicId,
                role,
                channel: "bank_transfer",
                amount,
                transferredAt: `2026-08-10T0${index + 3}:00:00.000Z`,
                bankReference: `MCP-ALL-TOOLS-GROUP-${index + 1}`,
                idempotencyKey: `mcp-all-tools-intermediated-event-${index + 1}`,
            })).data);
        }
        const transferEvidence = (await call("intermediary.disbursement.evidence.prepare", {
            groupPublicId: group.publicId,
            eventPublicId: groupEvents[0]!.publicId,
            mimeType: "image/png",
            size: 4,
            sha256: "e".repeat(64),
            originalName: "intermediated-funding.png",
        })).data;
        expectWriteAuditMetadata(transferEvidence);
        const finalizedTransferEvidence = (await call("intermediary.disbursement.evidence.finalize", {
            groupPublicId: group.publicId,
            eventPublicId: groupEvents[0]!.publicId,
            evidencePublicId: transferEvidence.publicId,
        })).data;
        expectWriteAuditMetadata(finalizedTransferEvidence);
        await call("intermediary.disbursement.list", { loanPublicId, intermediaryPublicId: intermediary.publicId });
        await call("intermediary.disbursement.get", { groupPublicId: group.publicId });
        const groupPreview = (await call("intermediary.disbursement.preview", { groupPublicId: group.publicId })).data;
        await call("intermediary.disbursement.post", {
            groupPublicId: group.publicId,
            proposalPublicId: groupPreview.publicId,
            confirmed: true,
            idempotencyKey: "mcp-all-tools-intermediated-post",
        });
        await call("intermediary.disbursement.reverse", {
            groupPublicId: group.publicId,
            reason: "MCP all-tools compensating group reversal",
            confirmed: true,
            idempotencyKey: "mcp-all-tools-intermediated-reverse",
        });
        const endedAssignment = (await call("intermediary.assignment.end", {
            assignmentPublicId: assignment.publicId,
            effectiveTo: "2026-08-11T00:00:00.000Z",
            reason: "MCP all-tools assignment complete",
            idempotencyKey: "mcp-all-tools-intermediary-assignment-end",
        })).data;
        expectWriteAuditMetadata(endedAssignment);
        const collection = (await call("intermediary.collection.create", {
            intermediaryPublicId: intermediary.publicId, borrowerPublicId, loanPublicId, amount: "40.00",
            borrowerPaidAt: "2026-08-10T01:00:00.000Z", bankReference: "MCP-COLLECTION-1",
            idempotencyKey: "mcp-all-tools-collection",
        })).data;
        await call("intermediary.collection.list", { intermediaryPublicId: intermediary.publicId, status: "pending_remittance" });
        const remittance = (await call("intermediary.remittance.create", {
            intermediaryPublicId: intermediary.publicId, grossAmount: "40.00", receivedAt: "2026-08-10T02:00:00.000Z",
            bankReference: "MCP-REMITTANCE-1", idempotencyKey: "mcp-all-tools-remittance",
        })).data;
        await call("intermediary.remittance.get", { remittancePublicId: remittance.publicId });
        const remittanceEvidence = (await call("intermediary.remittance.evidence.prepare", {
            remittancePublicId: remittance.publicId, mimeType: "image/png", size: 4, sha256: "d".repeat(64),
        })).data;
        await call("intermediary.remittance.evidence.finalize", { remittancePublicId: remittance.publicId, evidencePublicId: remittanceEvidence.publicId });
        await call("intermediary.remittance.allocations.save", { remittancePublicId: remittance.publicId, collectionPublicIds: [collection.publicId] });
        const remittancePreview = (await call("intermediary.remittance.preview", { remittancePublicId: remittance.publicId })).data;
        await call("intermediary.remittance.post", { remittancePublicId: remittance.publicId, proposalPublicId: remittancePreview.publicId, confirmed: true, idempotencyKey: "mcp-all-tools-remittance-post" });

        const renewal = (await call("renewal.preview", {
            oldLoanPublicId: loanPublicId,
            requestedPrincipal: "100.00",
        })).data;
        await call("renewal.execute", {
            renewalPublicId: renewal.publicId,
            previewHash: renewal.previewHash,
            confirmed: true,
            reason: "MCP all-tools contract",
            idempotencyKey: "mcp-all-tools-renewal-execute",
        });
        await call("renewal.reverse", {
            renewalPublicId: renewal.publicId,
            reason: "MCP all-tools contract reversal",
            idempotencyKey: "mcp-all-tools-renewal-reverse",
        });
        await call("funding-source.list", { status: "active" });

        expect([...new Set(called)].sort()).toEqual([...MCP_TOOL_NAMES].sort());
        expect(new Set(called).size).toBe(MCP_TOOL_NAMES.length);
        expect(called.filter((name) => name === "intermediary.disbursement.event.create")).toHaveLength(2);
        expect(called).toHaveLength(MCP_TOOL_NAMES.length + 1);

        await client.close();
    }, 10_000);
});
