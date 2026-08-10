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
    loanSchedules,
    loans,
    paymentIntakes,
    transactions,
    users,
} from "../db/schema";
import type { EvidenceStorageGateway } from "../services/payment-service";
import type { DisbursementEvidenceStorageGateway } from "../services/loan-disbursement-service";
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

async function startDefaultServer(options?: { evidenceGateway?: EvidenceStorageGateway; disbursementEvidenceGateway?: DisbursementEvidenceStorageGateway }) {
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

describe("default MCP adapter integration", () => {
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
            arguments: { loanPublicId: draft!.publicId },
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
        await db.insert(users).values({
            tenantId: TENANT_ID,
            email: ACTOR_EMAIL,
            role: "owner",
        });
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
        const evidenceGateway: EvidenceStorageGateway = {
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
        };
        const { client, transport } = await startDefaultServer({ evidenceGateway, disbursementEvidenceGateway: evidenceGateway });
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
        await call("loan.activate", { loanPublicId });
        const disbursement = (await call("loan.disbursement.draft", {
            loanPublicId,
            grossAmount: "100.00",
            loanAttributedAmount: "100.00",
            channel: "cash",
            disbursedAt: "2026-08-10T00:00:00.000Z",
        })).data;
        const disbursementPublicId = String(disbursement.publicId);
        await call("loan.disbursement.list", { loanPublicId });
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
        await call("loan.disbursement.post", {
            disbursementPublicId,
            idempotencyKey: "mcp-all-tools-disbursement-post",
        });
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
        await call("intake.get", { paymentIntakePublicId: intakePublicId });
        await call("intake.list", { status: "draft" });
        const evidence = (await call("evidence.prepare", {
            paymentIntakePublicId: intakePublicId,
            mimeType: "image/png",
            size: 4,
            sha256: "a".repeat(64),
            evidenceType: "slip",
        })).data;
        await call("evidence.finalize", {
            paymentIntakePublicId: intakePublicId,
            evidencePublicId: evidence.publicId,
        });

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

        expect(called).toHaveLength(MCP_TOOL_NAMES.length);
        expect([...called].sort()).toEqual([...MCP_TOOL_NAMES].sort());
        expect(new Set(called).size).toBe(MCP_TOOL_NAMES.length);

        await client.close();
    });
});
