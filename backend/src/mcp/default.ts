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
    getLoanApplication,
    previewLoan,
    type LoanDraftInput,
} from "../services/loan-application-service";
import {
    executeLoanRenewal,
    previewLoanRenewal,
    reverseLoanRenewal,
} from "../services/loan-renewal-service";
import {
    executeLoanInterestRateChange,
    listLoanInterestRates,
    previewLoanInterestRateChange,
} from "../services/loan-interest-rate-service";
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
import {
    createDisbursementDraft,
    finalizeDisbursementEvidence,
    listLoanDisbursements,
    postDisbursement,
    prepareDisbursementEvidence,
    rejectDisbursementDraftEvidenceIds,
    reverseDisbursement,
    updateDisbursementDraft,
    type DisbursementEvidenceStorageGateway,
    type CreateDisbursementDraftInput,
    type PrepareDisbursementEvidenceInput,
    type UpdateDisbursementDraftInput,
} from "../services/loan-disbursement-service";
import {
    createIntermediary, createIntermediaryCollection, createIntermediaryRemittance,
    finalizeIntermediaryRemittanceEvidence, getIntermediaryRemittance, listIntermediaryCollections,
    postIntermediaryRemittance, prepareIntermediaryRemittanceEvidence, previewIntermediaryRemittance,
    saveRemittanceAllocations, searchIntermediaries, type IntermediaryRemittanceEvidenceGateway,
} from "../services/intermediary-service";

type ToolInput = Record<string, unknown>;

export interface DefaultMcpDependencies {
    evidenceGateway?: EvidenceStorageGateway;
    disbursementEvidenceGateway?: DisbursementEvidenceStorageGateway;
    intermediaryRemittanceEvidenceGateway?: IntermediaryRemittanceEvidenceGateway;
}

function asString(input: ToolInput, field: string) {
    return input[field] as string;
}

function paymentReversalReason(input: ToolInput) {
    return typeof input.reason === "string" && input.reason.trim()
        ? input.reason.trim()
        : "MCP 1.0 compatibility reversal";
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
    "intake.create": async (ctx, input) => {
        const result = await createPaymentIntake(ctx, input as unknown as CreatePaymentIntakeInput);
        if (!("originLoanPublicId" in result)) return result;
        const { originLoanPublicId: _originLoanPublicId, ...frozenResult } = result;
        return frozenResult;
    },
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
    "payment.reverse": (ctx, input) => reversePayment(ctx, asString(input, "paymentIntakePublicId"), {
        reason: paymentReversalReason(input),
    }),
    "loan.preview": async (_ctx, input) => {
        try {
            return previewLoan(input as unknown as Parameters<typeof previewLoan>[0]);
        } catch {
            throw new DomainError("INVALID_LOAN_TERMS", "Loan terms are invalid", 400);
        }
    },
    "loan.draft": (ctx, input) => createLoanDraft(ctx, input as unknown as LoanDraftInput),
    "loan.activate": (ctx, input) => activateLoan(ctx, asString(input, "loanPublicId"), {
        allowedRepaymentTypes: ["daily", "weekly", "monthly", "floating"],
    }),
    "loan.interest-rate.list": (ctx, input) => listLoanInterestRates(ctx, asString(input, "loanPublicId")),
    "loan.interest-rate.preview": (ctx, input) => previewLoanInterestRateChange(ctx, asString(input, "loanPublicId"), {
        effectiveDate: asString(input, "effectiveDate"),
        expiryDate: input.expiryDate as string | null,
        rateType: input.rateType as "percent" | "per_thousand",
        rate: asString(input, "rate"),
    }),
    "loan.interest-rate.execute": (ctx, input) => executeLoanInterestRateChange(ctx, asString(input, "loanPublicId"), {
        previewPublicId: asString(input, "previewPublicId"),
        previewHash: asString(input, "previewHash"),
        reason: asString(input, "reason"),
    }),
    "loan.disbursement.list": (ctx, input) => listLoanDisbursements(ctx, asString(input, "loanPublicId")),
    "loan.disbursement.draft": (ctx, input) => {
        const { loanPublicId, ...draft } = input;
        rejectDisbursementDraftEvidenceIds(draft);
        return createDisbursementDraft(ctx, String(loanPublicId), draft as unknown as CreateDisbursementDraftInput);
    },
    "loan.disbursement.update": (ctx, input) => updateDisbursementDraft(
        ctx,
        asString(input, "disbursementPublicId"),
        input.changes as UpdateDisbursementDraftInput,
    ),
    "loan.disbursement.evidence.prepare": (ctx, input) => {
        const { disbursementPublicId, ...evidence } = input;
        return prepareDisbursementEvidence(ctx, String(disbursementPublicId), evidence as unknown as PrepareDisbursementEvidenceInput, dependencies.disbursementEvidenceGateway);
    },
    "loan.disbursement.evidence.finalize": (ctx, input) => finalizeDisbursementEvidence(ctx, asString(input, "disbursementPublicId"), asString(input, "evidencePublicId"), dependencies.disbursementEvidenceGateway),
    "loan.disbursement.post": (ctx, input) => postDisbursement(ctx, asString(input, "disbursementPublicId")),
    "loan.disbursement.reverse": (ctx, input) => reverseDisbursement(ctx, asString(input, "disbursementPublicId"), asString(input, "reason")),
    "intermediary.search": async (ctx, input) => ({ items: await searchIntermediaries(ctx, asString(input, "query")) }),
    "intermediary.create": (ctx, input) => createIntermediary(ctx, input as { name: string; aliases?: string[]; notes?: string | null }),
    "intermediary.collection.list": async (ctx, input) => ({ items: await listIntermediaryCollections(ctx, { intermediaryPublicId: input.intermediaryPublicId as string | undefined, status: input.status as string | undefined }) }),
    "intermediary.collection.create": (ctx, input) => createIntermediaryCollection(ctx, input as any),
    "intermediary.remittance.get": (ctx, input) => getIntermediaryRemittance(ctx, asString(input, "remittancePublicId")),
    "intermediary.remittance.create": (ctx, input) => createIntermediaryRemittance(ctx, input as any),
    "intermediary.remittance.allocations.save": (ctx, input) => saveRemittanceAllocations(ctx, asString(input, "remittancePublicId"), { collectionPublicIds: input.collectionPublicIds as string[] }),
    "intermediary.remittance.preview": (ctx, input) => previewIntermediaryRemittance(ctx, asString(input, "remittancePublicId")),
    "intermediary.remittance.evidence.prepare": (ctx, input) => { const { remittancePublicId, ...evidence } = input; return prepareIntermediaryRemittanceEvidence(ctx, String(remittancePublicId), evidence as any, dependencies.intermediaryRemittanceEvidenceGateway); },
    "intermediary.remittance.evidence.finalize": (ctx, input) => finalizeIntermediaryRemittanceEvidence(ctx, asString(input, "remittancePublicId"), asString(input, "evidencePublicId"), dependencies.intermediaryRemittanceEvidenceGateway),
    "intermediary.remittance.post": (ctx, input) => postIntermediaryRemittance(ctx, asString(input, "remittancePublicId"), { proposalPublicId: asString(input, "proposalPublicId"), confirmed: input.confirmed as boolean }),
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
    "loan.interest-rate.execute": { entityType: "loan_interest_rate_timeline", action: "interest_rate_timeline_changed" },
    "loan.disbursement.post": { entityType: "loan_disbursement", action: "posted" },
    "loan.disbursement.reverse": { entityType: "loan_disbursement", action: "reversed" },
    "intermediary.remittance.post": { entityType: "intermediary_remittance", action: "posted" },
    "renewal.execute": { entityType: "loan_renewal", action: "executed" },
    "renewal.reverse": { entityType: "loan_renewal", action: "reversed" },
};

function resultPublicId(result: unknown) {
    if (!result || typeof result !== "object") return null;
    const record = result as Record<string, unknown>;
    const value = record.publicId ?? record.id ?? record.loanPublicId;
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
        preflightHandlers: {
            "loan.activate": async (ctx, input) => {
                const loan = await getLoanApplication(ctx, asString(input, "loanPublicId"));
                if (loan.repaymentType === "single_payment") {
                    throw new DomainError(
                        "MCP_LOAN_TYPE_UNSUPPORTED",
                        "Single-payment activation is not available through the frozen MCP contract",
                        409,
                    );
                }
            },
        },
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
