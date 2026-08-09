import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { auditLogs, users } from "../db/schema";
import {
    addBorrowerAlias,
    confirmBorrowerAlias,
    createBorrower,
    deactivateBorrowerAlias,
    getBorrowerPortfolio,
    searchBorrowers,
    updateBorrower,
    type BorrowerInput,
    type BorrowerUpdateInput,
} from "../services/borrower-service";
import { DomainError } from "../services/domain-error";
import { listFundingSources } from "../services/funding-source-service";
import {
    activateLoan,
    createLoanDraft,
    previewLoan,
    type LoanDraftInput,
} from "../services/loan-application-service";
import {
    executeLoanRenewal,
    previewLoanRenewal,
    reverseLoanRenewal,
} from "../services/loan-renewal-service";
import {
    createPaymentIntake,
    finalizePaymentEvidence,
    getPaymentIntake,
    listPaymentIntakes,
    postPayment,
    preparePaymentEvidence,
    previewPaymentMatch,
    reversePayment,
    type CreatePaymentIntakeInput,
    type EvidenceStorageGateway,
    type ExplicitPaymentAllocation,
    type PrepareEvidenceInput,
} from "../services/payment-service";
import { createMcpRateLimiter } from "./rate-limit";
import { createMcpHttpPlugin, type McpToolHandler, type McpToolName } from "./server";
import { parseMcpRuntimeConfig } from "./security";

type ToolInput = Record<string, unknown>;

export interface DefaultMcpDependencies {
    evidenceGateway?: EvidenceStorageGateway;
}

function asString(input: ToolInput, field: string) {
    return input[field] as string;
}

export function createDefaultMcpToolHandlers(
    dependencies: DefaultMcpDependencies = {},
): Record<McpToolName, McpToolHandler> {
    return {
    "borrower.search": (ctx, input) => searchBorrowers(ctx, { query: asString(input, "query") }),
    "borrower.portfolio": (ctx, input) => getBorrowerPortfolio(ctx, asString(input, "borrowerPublicId")),
    "borrower.create": (ctx, input) => createBorrower(ctx, input as unknown as BorrowerInput),
    "borrower.update": (ctx, input) => updateBorrower(
        ctx,
        asString(input, "borrowerPublicId"),
        input.changes as BorrowerUpdateInput,
    ),
    "borrower.alias": async (ctx, input) => {
        if (input.action === "add") {
            return addBorrowerAlias(ctx, asString(input, "borrowerPublicId"), {
                alias: asString(input, "alias"),
                source: input.source as "manual" | "payment" | "import" | undefined,
            });
        }
        if (input.action === "confirm") return confirmBorrowerAlias(ctx, asString(input, "aliasPublicId"));
        return deactivateBorrowerAlias(ctx, asString(input, "aliasPublicId"));
    },
    "intake.get": (ctx, input) => getPaymentIntake(ctx, asString(input, "paymentIntakePublicId")),
    "intake.list": (ctx, input) => listPaymentIntakes(ctx, { status: input.status as string | undefined }),
    "intake.create": (ctx, input) => createPaymentIntake(ctx, input as unknown as CreatePaymentIntakeInput),
    "evidence.prepare": (ctx, input) => {
        const { paymentIntakePublicId, ...evidence } = input;
        return preparePaymentEvidence(
            ctx,
            String(paymentIntakePublicId),
            evidence as unknown as PrepareEvidenceInput,
            dependencies.evidenceGateway,
        );
    },
    "evidence.finalize": (ctx, input) => finalizePaymentEvidence(
        ctx,
        asString(input, "paymentIntakePublicId"),
        asString(input, "evidencePublicId"),
        dependencies.evidenceGateway,
    ),
    "payment.preview": (ctx, input) => previewPaymentMatch(
        ctx,
        asString(input, "paymentIntakePublicId"),
        { allocations: input.allocations as ExplicitPaymentAllocation[] | undefined },
    ),
    "payment.post": (ctx, input) => postPayment(
        ctx,
        asString(input, "paymentIntakePublicId"),
        { proposalPublicId: asString(input, "proposalPublicId") },
    ),
    "payment.reverse": (ctx, input) => reversePayment(ctx, asString(input, "paymentIntakePublicId")),
    "loan.preview": async (_ctx, input) => {
        try {
            return previewLoan(input as unknown as Parameters<typeof previewLoan>[0]);
        } catch {
            throw new DomainError("INVALID_LOAN_TERMS", "Loan terms are invalid", 400);
        }
    },
    "loan.draft": (ctx, input) => createLoanDraft(ctx, input as unknown as LoanDraftInput),
    "loan.activate": (ctx, input) => activateLoan(ctx, asString(input, "loanPublicId")),
    "renewal.preview": (ctx, input) => previewLoanRenewal(ctx, asString(input, "oldLoanPublicId"), {
        requestedPrincipal: asString(input, "requestedPrincipal"),
        waivedCharges: input.waivedCharges as string | undefined,
        waiverReason: (input.waiverReason as string | null | undefined) ?? undefined,
    }),
    "renewal.execute": (ctx, input) => executeLoanRenewal(ctx, asString(input, "renewalPublicId"), {
        previewHash: asString(input, "previewHash"),
        confirmed: input.confirmed as boolean,
        reason: asString(input, "reason"),
    }),
    "renewal.reverse": (ctx, input) => reverseLoanRenewal(ctx, asString(input, "renewalPublicId"), {
        reason: asString(input, "reason"),
    }),
    "funding-source.list": (ctx, input) => listFundingSources(ctx, {
        status: input.status as "active" | "closed" | "all" | undefined,
    }),
    };
}

const auditTarget: Partial<Record<McpToolName, { entityType: string; action: string }>> = {
    "payment.post": { entityType: "payment_intake", action: "posted" },
    "payment.reverse": { entityType: "payment_intake", action: "reversed" },
    "loan.activate": { entityType: "loan", action: "activated" },
    "renewal.execute": { entityType: "loan_renewal", action: "executed" },
    "renewal.reverse": { entityType: "loan_renewal", action: "reversed" },
};

function resultPublicId(result: unknown) {
    if (!result || typeof result !== "object") return null;
    const record = result as Record<string, unknown>;
    const value = record.publicId ?? record.id;
    return typeof value === "string" ? value : null;
}

function structuredLog(entry: Record<string, unknown>) {
    console.log(JSON.stringify(entry));
}

export function createDefaultMcpHttpPlugin(
    env: Record<string, string | undefined> = process.env,
    dependencies: DefaultMcpDependencies = {},
) {
    const config = parseMcpRuntimeConfig(env);
    const limiter = createMcpRateLimiter({
        cacheUrl: env.CACHE_URL,
        onWarning: (code) => structuredLog({ event: "mcp_warning", code }),
    });
    return createMcpHttpPlugin({
        config,
        handlers: createDefaultMcpToolHandlers(dependencies),
        consumeRateLimit: (input) => limiter.consume(input),
        logger: structuredLog,
        resolvePrincipal: async ({ tenantId, actorEmail }) => {
            const actor = await db.query.users.findFirst({ where: and(
                eq(users.tenantId, tenantId),
                sql`lower(${users.email}) = ${actorEmail}`,
            ) });
            if (!actor) throw new DomainError("MCP_ACTOR_NOT_FOUND", "Configured MCP actor is not available", 503);
            return { tenantId: actor.tenantId, actorUserId: actor.id };
        },
        findAuditPublicIds: async ({ ctx, toolName, result }) => {
            const target = auditTarget[toolName];
            const entityId = resultPublicId(result);
            if (!target || !entityId) return [];
            const rows = await db.select({ publicId: auditLogs.publicId }).from(auditLogs).where(and(
                eq(auditLogs.tenantId, ctx.tenantId),
                eq(auditLogs.entityType, target.entityType),
                eq(auditLogs.entityId, entityId),
                eq(auditLogs.action, target.action),
            )).orderBy(desc(auditLogs.id)).limit(1);
            return rows.map((row) => row.publicId);
        },
    });
}
