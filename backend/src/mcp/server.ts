import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { normalizeObjectSchema } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Elysia } from "elysia";
import { z } from "zod";
import type { CommandContext } from "../services/command-context";
import { DomainError } from "../services/domain-error";
import { authenticateBearer, hostIsAllowed, originIsAllowed, type McpRuntimeConfig } from "./security";
import { currentMcpDiagnosticSnapshot, recordMcpBreadcrumb, withMcpDiagnosticScope } from "./diagnostic-context";
import { presentMcpError, type OperationRecoveryPolicy } from "./error-presentation";
import { persistMcpDiagnosticBestEffort } from "../services/mcp-diagnostic-service";
import { mcpDiagnosticCategories, mcpDiagnosticStages, safeDiagnosticRuntimeCategories } from "../lib/mcp-diagnostic-types";
import { createModernMcpHandler, isLegacyRequest } from "./modern";
import { toolsForProfile, toolNamesForProfile } from "./tool-profiles";
import { MCP_TOOL_NAMES, type McpToolDefinition, type McpToolName, type ToolProfile } from "./catalog-types";
import { createHash } from "node:crypto";
import { decodeCatalogCursor, encodeCatalogCursor, MCP_PAGE_SIZE } from "./catalog-pagination";
import { WORKFLOW_VERSION } from "./workflow-registry";

export { MCP_TOOL_NAMES } from "./catalog-types";
export type { McpToolName, ToolProfile } from "./catalog-types";
export type McpToolHandler = (ctx: CommandContext, input: Record<string, unknown>) => Promise<unknown>;
export type McpMetric = Readonly<{
    event: "mcp_metric";
    metric: "request" | "rejection" | "evidence_stop";
    profile: ToolProfile;
    protocolEra: "legacy" | "modern" | "unknown";
    operationClass: "discovery" | "tool_call" | "other";
    statusClass: "2xx" | "4xx" | "5xx";
    durationMs?: number;
    responseBytes?: number;
    schemaCacheHit?: boolean;
    evidenceStopClass?: "validation" | "review_required" | "storage" | "retryable" | "unknown";
    rejectionReason?: "origin" | "host" | "bearer" | "protocol_version" | "method" | "name" | "envelope" | "rate_limit" | "infrastructure";
}>;

export interface CreateMcpHttpPluginInput {
    config: McpRuntimeConfig;
    handlers: Record<string, McpToolHandler>;
    preflightHandlers?: Partial<Record<string, McpToolHandler>>;
    resolvePrincipal: (input: { tenantId: string; actorEmail: string }) => Promise<{ tenantId: string; actorUserId: number }>;
    consumeRateLimit: (input: { key: string; max: number; windowSeconds: number }) => Promise<{
        allowed: boolean;
        remaining: number;
        retryAfterSeconds: number;
    }>;
    findAuditPublicIds: (input: {
        ctx: CommandContext;
        toolName: string;
        result: unknown;
    }) => Promise<string[]>;
    logger: (entry: Record<string, unknown>) => void;
    persistDiagnostic?: (input: Parameters<typeof persistMcpDiagnosticBestEffort>[0]) => Promise<void>;
    parseToolInput?: (toolName: string, input: unknown) => Promise<{ success: boolean; data?: Record<string, unknown> }>;
    /**
     * Test-only or isolated-adapter catalog injection. Production routes use
     * the immutable product catalog; conformance uses this to register named
     * no-side-effect fixture tools through the same HTTP and dispatch paths.
     */
    catalog?: readonly McpToolDefinition[];
    validateToolOutput?: (toolName: string, output: unknown) => { success: boolean; data?: Record<string, unknown> };
    /** Optional adapter-owned request policy. Production dispatch stays
     * tool-agnostic; isolated fixtures may enforce protocol capabilities. */
    validateToolRequest?: (input: {
        toolName: string;
        arguments: unknown;
        requestMeta?: Record<string, unknown>;
    }) => void | Promise<void>;
    profile?: ToolProfile;
    onMetric?: (metric: McpMetric) => void;
}

const uuid = z.uuid();
const writeAuditMetadata = {
    auditPublicId: uuid,
    correlationId: uuid,
};
const money = z.string().regex(/^(0|[1-9]\d*)\.\d{2}$/).max(32);
const signedMoney = z.string().regex(/^-?(0|[1-9]\d*)\.\d{2}$/).max(33);
const date = z.iso.date();
const dateTime = z.iso.datetime({ offset: true });
const shortText = z.string().trim().min(1).max(500);
// Keep the MCP schema JSON-representable; canonical control-character removal
// and post-normalization blank validation live in the shared service.
const cancellationReason = z.string().min(1).max(2000);
const optionalNullableText = z.string().trim().max(2_000).nullable().optional();
const correctionScheduleProjectionOutput = z.object({
    schedulePublicId: uuid,
    dueDate: date,
    before: z.object({ paidTotal: money, paidPenalty: money, remainingDue: money, status: z.string() }).strict(),
    after: z.object({ paidTotal: money, paidPenalty: money, remainingDue: money, status: z.string() }).strict(),
}).strict();
const correctionWarningOutput = z.object({ code: z.string().trim().min(1), blockerPublicIds: z.array(uuid).max(100).optional() }).strict();

const borrowerFields = {
    name: z.string().trim().min(1).max(300),
    idCardNumber: z.string().trim().max(100).nullable().optional(),
    phone: z.string().trim().max(100).nullable().optional(),
    address: z.string().trim().max(2_000).nullable().optional(),
    creditScore: z.number().int().min(0).max(1_000).nullable().optional(),
    notes: optionalNullableText,
    idCardImageUrl: z.url().nullable().optional(),
    tags: z.array(z.string().trim().min(1).max(100)).max(50).nullable().optional(),
    googleMapsUrl: z.url().nullable().optional(),
};

const floatingInterestRate = z.string().regex(/^\d+(?:\.\d{1,4})?$/).max(32);
const floatingInterestPolicy = z.object({
    periodUnit: z.enum(["day", "week", "month"]),
    periodLength: z.literal(1),
    rateMode: z.enum(["percent", "per_thousand"]),
    rate: floatingInterestRate,
    advanceInterestPeriods: z.union([z.literal(0), z.literal(1)]),
    advanceInterestRefundPolicy: z.literal("non_refundable"),
}).strict();
const floatingDailyInterest = z.object({
    mode: z.enum(["per_thousand", "percent"]),
    rate: z.string().regex(/^\d+(?:\.\d{1,4})?$/),
    firstDayTreatment: z.enum(["deduct", "start_next_day"]),
    accrualCycle: z.enum(["daily", "weekly", "monthly"]).optional(),
}).strict();
const singlePayment = z.union([
    z.object({
        dueDate: date,
        fixedAgreedInterest: money,
        interestPolicy: z.literal("fixed_only"),
        latePenalty: z.union([
            z.object({ mode: z.literal("none") }).strict(),
            z.object({ mode: z.literal("fixed_amount_per_day"), amountPerDay: money, graceDays: z.number().int().min(0).max(100_000) }).strict(),
        ]),
    }).strict(),
    z.object({
        dueDate: date,
        fixedAgreedInterest: money,
        interestPolicy: z.literal("greater_of_fixed_or_retroactive"),
        retroactiveInterest: z.object({
            rateType: z.enum(["percent_per_day", "per_thousand_per_day"]),
            rate: z.string().regex(/^\d+(?:\.\d{1,4})?$/),
        }).strict(),
        latePenalty: z.union([
            z.object({ mode: z.literal("none") }).strict(),
            z.object({ mode: z.literal("fixed_amount_per_day"), amountPerDay: money, graceDays: z.number().int().min(0).max(100_000) }).strict(),
        ]),
    }).strict(),
]);

const loanTerms = {
    principal: money,
    interestRate: money,
    termMonths: z.number().int().positive().max(1_200),
    repaymentType: z.enum(["daily", "weekly", "monthly", "floating", "single_payment"]),
    startDate: date,
    paymentStartDate: date.optional(),
    totalInstallments: z.number().int().positive().max(100_000).optional(),
    installmentAmount: money.optional(),
    scheduledInstallmentMode: z.enum(["rate_derived", "fixed_total"]).optional(),
    floatingInterestPolicy: floatingInterestPolicy.optional(),
    floatingDailyInterest: floatingDailyInterest.optional(),
    singlePayment: singlePayment.optional(),
    dailyEntry: z.object({
        durationUnit: z.enum(["days", "months"]),
        durationValue: z.number().int().positive().max(100_000),
        entryMode: z.enum(["daily_payment", "daily_interest"]),
        dailyPayment: money.optional(),
        interestInput: z.object({
            mode: z.enum(["percent", "fixed_amount", "per_thousand"]),
            value: z.string().regex(/^\d+(?:\.\d{1,4})?$/),
        }).strict().optional(),
    }).strict().optional(),
};
const replacementBase = {
    interestRate: money,
    termMonths: z.number().int().positive().max(1_200),
    startDate: date,
};
const publicReplacementTermsInput = z.discriminatedUnion("repaymentType", [
    z.object({
        ...replacementBase, repaymentType: z.literal("daily"), dailyEntry: loanTerms.dailyEntry.unwrap(),
        totalInstallments: z.number().int().positive().max(100_000).optional(), installmentAmount: money.optional(),
    }).strict(),
    z.object({
        ...replacementBase, repaymentType: z.literal("weekly"),
        totalInstallments: z.number().int().positive().max(100_000).optional(), installmentAmount: money.optional(), scheduledInstallmentMode: z.enum(["rate_derived", "fixed_total"]).optional(),
    }).strict(),
    z.object({
        ...replacementBase, repaymentType: z.literal("monthly"),
        totalInstallments: z.number().int().positive().max(100_000).optional(), installmentAmount: money.optional(), scheduledInstallmentMode: z.enum(["rate_derived", "fixed_total"]).optional(),
    }).strict(),
    z.object({
        ...replacementBase, repaymentType: z.literal("floating"),
        floatingInterestPolicy: floatingInterestPolicy.optional(), floatingDailyInterest: floatingDailyInterest.optional(),
    }).strict(),
    z.object({
        ...replacementBase, repaymentType: z.literal("single_payment"), singlePayment: loanTerms.singlePayment.unwrap(),
    }).strict(),
]);
const publicReplacementBase = { principal: money, ...replacementBase };
const publicReplacementTermsOutput = z.discriminatedUnion("repaymentType", [
    z.object({
        ...publicReplacementBase, repaymentType: z.literal("daily"),
        totalInstallments: z.number().int().positive().max(100_000).optional(),
        installmentAmount: money.optional(), dailyEntry: loanTerms.dailyEntry.unwrap(),
    }).strict(),
    z.object({
        ...publicReplacementBase, repaymentType: z.literal("weekly"),
        totalInstallments: z.number().int().positive().max(100_000).optional(), installmentAmount: money.optional(), scheduledInstallmentMode: z.enum(["rate_derived", "fixed_total"]).optional(),
    }).strict(),
    z.object({
        ...publicReplacementBase, repaymentType: z.literal("monthly"),
        totalInstallments: z.number().int().positive().max(100_000).optional(), installmentAmount: money.optional(), scheduledInstallmentMode: z.enum(["rate_derived", "fixed_total"]).optional(),
    }).strict(),
    z.object({
        ...publicReplacementBase, repaymentType: z.literal("floating"),
        floatingDailyInterest: loanTerms.floatingDailyInterest.unwrap(),
    }).strict(),
    z.object({
        ...publicReplacementBase, repaymentType: z.literal("single_payment"),
        singlePayment: loanTerms.singlePayment.unwrap(),
    }).strict(),
]);

const explicitAllocation = z.object({
    borrowerPublicId: uuid,
    loanPublicId: uuid,
    schedulePublicId: uuid.optional(),
    amount: money,
}).strict();
const reconciliationAllocation = z.object({
    borrowerPublicId: uuid,
    loanPublicId: uuid,
    schedulePublicId: uuid.optional(),
    amount: money,
    component: z.literal("interest"),
}).strict();
const reconciliationAllocationOutput = reconciliationAllocation.extend({ schedulePublicId: uuid.nullable().optional() }).strict();

const isoDateTime = z.iso.datetime({ offset: true });
const nullableIsoDateTime = isoDateTime.nullable();
const warningSchema = z.record(z.string(), z.unknown());
const publicEntity = { id: uuid.optional(), publicId: uuid };
const borrowerOutput = z.object({
    ...publicEntity,
    name: z.string(),
    idCardNumber: z.string().nullable().optional(),
    phone: z.string().nullable().optional(),
    address: z.string().nullable().optional(),
    photoUrl: z.string().nullable().optional(),
    idCardImageUrl: z.string().nullable().optional(),
    creditScore: z.number().int().nullable().optional(),
    tags: z.array(z.string()).nullable().optional(),
    googleMapsUrl: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
    createdAt: nullableIsoDateTime.optional(),
    updatedAt: nullableIsoDateTime.optional(),
    cancellationMetadata: z.object({
        reason: z.string().nullable(), cancelledAt: nullableIsoDateTime, actorUserId: z.number().int().nullable(), auditPublicId: uuid.nullable(),
    }).optional(),
}).strict();
const replacementLineageEventOutput = z.object({
    replacementPublicId: uuid,
    loanPublicId: uuid.nullable(),
    status: z.enum(["executed", "reversed"]),
}).strict();
const replacementLineageOutput = z.object({
    replacementPublicId: uuid,
    status: z.enum(["executed", "reversed"]),
    replacedFromPublicId: uuid.nullable(),
    replacedToPublicId: uuid.nullable(),
    inbound: replacementLineageEventOutput.nullable(),
    outbound: replacementLineageEventOutput.nullable(),
}).strict();
const aliasOutput = z.object({
    ...publicEntity,
    alias: z.string(),
    normalizedAlias: z.string(),
    source: z.string(),
    status: z.string(),
    confirmedAt: nullableIsoDateTime.optional(),
    createdAt: nullableIsoDateTime.optional(),
    updatedAt: nullableIsoDateTime.optional(),
}).strict();
const intakeOutput = z.object({
    ...publicEntity,
    source: z.string().optional(),
    status: z.string(),
    amount: money.optional(),
    receivedAt: isoDateTime.optional(),
    payerName: z.string().nullable().optional(),
    bankReference: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
    warnings: z.array(warningSchema).optional(),
    postedAt: nullableIsoDateTime.optional(),
    createdAt: nullableIsoDateTime.optional(),
    updatedAt: nullableIsoDateTime.optional(),
    repostOfIntakePublicId: uuid.nullable(),
    repostedByIntakePublicId: uuid.nullable(),
    replacementOfIntakePublicId: uuid.nullable().optional(),
    replacedByIntakePublicId: uuid.nullable().optional(),
    replacementEligibility: z.object({ allowed: z.boolean(), stateHash: z.string().regex(/^[0-9a-f]{64}$/i), blockers: z.array(z.string()), blockerPublicIds: z.array(uuid).optional(), replacementPaymentIntakePublicId: uuid.nullable(), lineagePublicId: uuid.nullable().optional() }).nullable().optional(),
    cancellationMetadata: z.object({ reason: z.string().nullable(), cancelledAt: nullableIsoDateTime, auditPublicId: uuid.nullable(), actorPublicId: uuid.nullable() }).nullable().optional(),
}).strict();
const paymentEvidenceOutput = z.object({
    ...publicEntity,
    status: z.string(),
    mimeType: z.string(),
    size: z.number().int().nullable(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/i).nullable(),
    filePublicId: uuid.nullable(),
}).strict();
const paymentCancellationCapabilityOutput = z.object({
    allowed: z.boolean(),
    stateHash: z.string().regex(/^[0-9a-f]{64}$/i),
    blockedReason: z.string().nullable(),
    batchPublicId: uuid.nullable(),
}).strict();
const paymentRestoreCancellationCapabilityOutput = z.object({
    allowed: z.boolean(),
    stateHash: z.string().regex(/^[0-9a-f]{64}$/i),
    blockedReason: z.string().nullable(),
}).strict();
const paymentCancellationOutput = z.object({
    paymentIntakePublicId: uuid, status: z.literal("cancelled"), reason: z.string(), cancelledAt: isoDateTime,
    cancellationPublicId: uuid, auditPublicId: uuid, correlationId: uuid,
}).strict();
const proposalAllocationOutput = z.object({
    ...publicEntity,
    borrowerPublicId: uuid.optional(),
    loanPublicId: uuid.optional(),
    schedulePublicId: uuid.nullable().optional(),
    amount: money,
    matchReason: z.string().nullable().optional(),
}).strict();
const proposalOutput = z.object({
    ...publicEntity,
    version: z.number().int(),
    status: z.string(),
    warnings: z.array(warningSchema),
    totalAllocated: money,
    expiresAt: nullableIsoDateTime.optional(),
    allocations: z.array(proposalAllocationOutput),
}).strict();
const transactionOutput = z.object({
    ...publicEntity,
    amount: signedMoney,
    principalComponent: signedMoney,
    interestComponent: signedMoney,
    feeComponent: signedMoney,
    penaltyComponent: signedMoney,
    entryType: z.string(),
    postedAt: nullableIsoDateTime.optional(),
}).strict();
const temporalReflowPlanOutput = z.object({
    effectiveAfterDate: date,
    displacedTotal: money,
    replacementTotal: money,
    transactions: z.array(z.object({
        transactionPublicId: uuid,
        loanPublicId: uuid,
        effectiveDate: date,
        displacedAmount: money,
        before: z.array(z.object({ allocationPublicId: uuid, accrualPublicId: uuid, dueDate: date, amount: money }).strict()),
        after: z.array(z.object({ accrualPublicId: uuid, dueDate: date, amount: money }).strict()),
        conserved: z.literal(true),
    }).strict()),
}).strict();
const reconciliationPreviewOutput = z.object({
    ...publicEntity,
    status: z.enum(["ready", "executed", "expired"]),
    sourcePayment: z.record(z.string(), z.unknown()),
    currentAllocationSnapshot: z.array(z.record(z.string(), z.unknown())),
    proposedAllocation: z.array(reconciliationAllocationOutput),
    correction: z.object({ principal: signedMoney, interest: signedMoney, fee: signedMoney, penalty: signedMoney }).strict(),
    warnings: z.array(warningSchema),
    previewHash: z.string().regex(/^v1:[0-9a-f]{64}$/i),
    expectedBalanceVersion: z.string().regex(/^v1:[0-9a-f]{64}$/i),
    expiresAt: isoDateTime,
    historicalReconciliationGroupPublicIds: z.array(uuid),
    reason: z.string(),
    temporalReflowPlan: temporalReflowPlanOutput.optional(),
}).strict();
const restorePreviewOutput = reconciliationPreviewOutput.extend({
    proposedAllocation: z.array(reconciliationAllocationOutput.extend({
        component: z.enum(["principal", "interest", "fee", "penalty"]),
    }).strict()),
}).strict();
const reconciliationExecuteOutput = z.object({
    reconciliationPublicId: uuid,
    sourcePaymentPublicId: uuid,
    postedPaymentPublicId: uuid,
    compensatingTransactionPublicIds: z.array(uuid),
    correctedTransactionPublicIds: z.array(uuid).optional(),
    auditPublicIds: z.array(uuid),
    correlationId: uuid,
    reflowGroupPublicId: uuid.optional(),
}).strict();
const paymentExecutionPreflightOutput = z.object({
    status: z.enum(["ready_to_execute", "review_required", "blocked"]),
    wouldWrite: z.literal(false), sourcePaymentPublicId: uuid, affectedLoanPublicIds: z.array(uuid), exactAmount: money,
    proposedComponents: z.object({ principal: money, interest: money, fee: money, penalty: money }).strict(),
    allocationPlan: z.array(z.object({ loanPublicId: uuid, component: z.enum(["interest", "principal", "fee", "penalty"]), amount: money, accrualPublicIds: z.array(uuid).optional() }).strict()),
    checks: z.array(z.object({ name: z.string(), status: z.enum(["pass", "fail", "warning"]), code: z.string().optional() }).strict()),
    previewHash: z.string().regex(/^v1:[0-9a-f]{64}$/i), expectedBalanceVersion: z.string().regex(/^v1:[0-9a-f]{64}$/i), reviewRequired: z.boolean(),
    previewPersistence: z.object({ proposalPublicId: uuid, expiresAt: isoDateTime }).strict().optional(),
    warning: z.object({ code: z.string(), message: z.string() }).strict().optional(),
}).strict();
const paymentReconciliationReviewOutput = z.object({
    paymentIntakePublicId: uuid,
    beforeStatus: z.literal("ready"),
    afterStatus: z.literal("needs_review"),
    invalidatedProposalCount: z.number().int().nonnegative(),
    auditPublicId: uuid,
    correlationId: uuid.nullable(),
}).strict();
const paymentRestoreDraftOutput = z.object({
    sourcePaymentPublicId: uuid,
    restoreDraftPublicId: uuid,
    status: z.literal("draft"),
    auditPublicId: uuid.optional(),
    correlationId: uuid,
}).strict();
const paymentRestoreScheduleBackfillOutput = z.object({
    changed: z.boolean(),
    paymentIntakePublicId: uuid,
    schedulePublicId: uuid,
    auditPublicId: uuid,
    correlationId: uuid,
}).strict();
const loanPaymentHistoryItemOutput = intakeOutput.extend({
    originLoanPublicId: uuid.nullable(),
    latestAllocation: z.object({
        amount: money,
        proposalPublicId: uuid,
    }).strict().nullable(),
    postedComponents: z.object({
        principal: signedMoney,
        interest: signedMoney,
        fee: signedMoney,
        penalty: signedMoney,
    }).strict().nullable(),
}).strict();
const loanAccrualOutput = z.object({
    publicId: uuid,
    accrualDate: date,
    periodStartDate: date.nullable(),
    periodEndDate: date.nullable(),
    periodUnit: z.enum(["day", "week", "month"]).nullable(),
    periodDayIndex: z.number().int().nullable(),
    interestAmount: money,
    paidAmount: money,
    remainingAmount: money,
    status: z.string(),
}).strict();
const loanOutput = z.object({
    ...publicEntity,
    borrowerPublicId: uuid.nullable().optional(),
    bankLoanPublicId: uuid.nullable().optional(),
    bankProfilePublicId: uuid.nullable().optional(),
    principal: money,
    principalAmount: money,
    interestRate: money,
    singlePayment: singlePayment.nullable().optional(),
    floatingInterestPolicy: floatingInterestPolicy.nullable().optional(),
    floatingPayoutSummary: z.object({
        fullPeriodInterest: money,
        advanceInterest: money,
        netBorrowerPayout: money,
        periodDays: z.number().int().positive(),
        firstPeriodStartDate: date,
        firstPeriodDueDate: date,
    }).nullable().optional(),
    floatingDailyInterest: z.object({ mode: z.enum(["per_thousand", "percent"]), rate: z.string(), firstDayTreatment: z.enum(["deduct", "start_next_day"]) }).nullable().optional(),
    dailyEntry: z.object({
        durationUnit: z.enum(["days", "months"]), durationValue: z.number().int().positive(), entryMode: z.enum(["daily_payment", "daily_interest"]),
        dailyPayment: money.nullable(), interestInput: z.object({ mode: z.enum(["percent", "fixed_amount", "per_thousand"]), value: z.string() }).nullable(), flatDailyRatePercent: z.string(),
    }).nullable().optional(),
    dailyLoanCalculation: z.object({
        totalInstallments: z.number().int().positive(), installmentAmount: money, totalRepayment: money, totalInterest: money, dailyInterest: money,
        flatDailyRatePercent: z.string(), flatMonthlyRatePercent: z.string(), flatAnnualRatePercent: z.string(),
    }).nullable().optional(),
    repaymentType: z.enum(["daily", "weekly", "monthly", "floating", "single_payment"]),
    termMonths: z.number().int().nullable(),
    installmentAmount: money.nullable(),
    totalInstallments: z.number().int().nullable(),
    scheduledInstallmentMode: z.enum(["rate_derived", "fixed_total"]).nullable().optional(),
    startDate: date.nullable(),
    paymentStartDate: date.nullable().optional(),
    nextDueDate: date.nullable(),
    outstandingPrincipal: money,
    outstandingInterest: money,
    outstandingFees: money,
    status: z.string().nullable(),
    accruals: z.array(loanAccrualOutput).optional(),
    createdAt: nullableIsoDateTime.optional(),
    updatedAt: nullableIsoDateTime.optional(),
}).strict();
const scheduleOutput = z.object({
    installmentNo: z.number().int().positive(),
    dueDate: date,
    amount: money,
    principalComponent: money,
    interestComponent: money,
    remainingPrincipal: money,
}).strict();
const loanContractScheduleOutput = z.object({
    ...publicEntity,
    installmentNo: z.number().int().positive(),
    dueDate: date,
    scheduledPrincipal: money,
    scheduledInterest: money,
    scheduledFee: money,
    scheduledTotal: money,
    paidTotal: money,
    paidPenalty: money,
    overdueDays: z.number().int().nonnegative(),
    remainingDue: money,
    status: z.string(),
    createdAt: nullableIsoDateTime.optional(),
    updatedAt: nullableIsoDateTime.optional(),
}).strict();
const compositePageOutput = <T extends z.ZodTypeAny>(item: T) => z.object({
    items: z.array(item),
    limit: z.number().int().min(1).max(100),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
}).strict();
const compositeCursorInput = z.string().trim().min(1).max(4096);
const compositeCursorsInput = z.object({
    borrowerCandidates: compositeCursorInput.optional(),
    aliases: compositeCursorInput.optional(),
    loans: compositeCursorInput.optional(),
    allocations: compositeCursorInput.optional(),
    schedule: compositeCursorInput.optional(),
    history: compositeCursorInput.optional(),
    disbursements: compositeCursorInput.optional(),
    accruals: compositeCursorInput.optional(),
    allocationCursors: z.record(uuid, compositeCursorInput).optional(),
    scheduleCursors: z.record(uuid, compositeCursorInput).optional(),
    historyCursors: z.record(uuid, compositeCursorInput).optional(),
    accrualCursors: z.record(uuid, compositeCursorInput).optional(),
}).strict();
const compositePortfolioLoanOutput = z.object({
    ...publicEntity,
    principal: money,
    interestRate: money,
    repaymentType: z.string(),
    status: z.string().nullable(),
    replacementLineage: replacementLineageOutput.nullable(),
    startDate: date.nullable(),
    createdAt: nullableIsoDateTime.optional(),
}).strict();
const loanPaymentHealthOutput = z.object({
    status: z.enum(["current", "due_today", "overdue", "settled"]),
    dueTodayAmount: money,
    overdueAmount: money,
    overdueItemCount: z.number().int().nonnegative(),
    overdueObligationUnit: z.enum(["day", "week", "installment"]),
    overdueObligationCount: z.number().int().nonnegative(),
    maxOverdueDays: z.number().int().nonnegative(),
    accruingInterestAmount: money.optional(),
}).strict();
const compositeLoanOutput = loanOutput.omit({ accruals: true }).extend({ paymentHealth: loanPaymentHealthOutput.optional() }).strict();
const compositePaymentDetailOutput = intakeOutput.extend({
    evidence: z.array(paymentEvidenceOutput),
    cancellation: paymentCancellationCapabilityOutput,
    restoreCancellation: paymentRestoreCancellationCapabilityOutput.nullable(),
}).strict();
const compositeProposalOutput = proposalOutput.omit({ allocations: true }).extend({
    allocations: compositePageOutput(proposalAllocationOutput),
}).strict();
const compositeLoanContextOutput = z.object({
    loanPublicId: uuid,
    allocations: compositePageOutput(proposalAllocationOutput),
    loan: compositeLoanOutput,
    schedule: compositePageOutput(loanContractScheduleOutput).nullable(),
    history: compositePageOutput(loanPaymentHistoryItemOutput).nullable(),
    accruals: compositePageOutput(loanAccrualOutput).nullable(),
}).strict();
const disbursementEventOutput = z.object({
    ...publicEntity,
    grossAmount: money,
    loanAttributedAmount: money,
    channel: z.enum(["bank_transfer", "cash", "adjustment"]),
    status: z.enum(["draft", "posted", "reversed"]),
    restructurePublicId: uuid.nullable(),
    sourceBankProfilePublicId: uuid.nullable(),
    payeeHint: z.string().nullable(),
    note: z.string().nullable(),
    disbursedAt: nullableIsoDateTime,
    postedAt: nullableIsoDateTime,
    reversedAt: nullableIsoDateTime,
    evidenceFilePublicIds: z.array(uuid),
}).strict();
const disbursementSummaryOutput = z.object({
    approvedPrincipal: money,
    netDisbursed: money,
    variance: signedMoney,
    status: z.enum(["under_disbursed", "matched", "over_disbursed"]),
}).strict();
const disbursementEvidenceIntentOutput = z.object({
    ...publicEntity,
    filePublicId: uuid,
    status: z.literal("ready").optional(),
    objectKey: z.string().optional(),
    uploadUrl: z.url().optional(),
    expiresAt: nullableIsoDateTime.optional(),
    requiredHeaders: z.record(z.string(), z.string()).optional(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/i).optional(),
}).strict();
const chatgptDisbursementEvidenceOutput = z.object({
    publicId: uuid,
    filePublicId: uuid,
    status: z.literal("ready"),
    sha256: z.string().regex(/^[0-9a-f]{64}$/i),
    auditPublicId: uuid,
    correlationId: uuid,
}).strict();
const renewalSettlementPolicy = z.enum(["full_contract_interest", "accrued_to_date"]);
const renewalAdjustment = z.object({
    lineNo: z.number().int().positive(),
    kind: z.enum(["fee", "penalty", "other_charge", "waiver"]),
    amount: money,
    reason: z.string(),
}).strict();
const renewalPayment = z.object({
    transactionPublicId: uuid,
    paidAt: isoDateTime,
    amount: money,
    principal: money,
    interest: money,
    fee: money,
    penalty: money,
}).strict();
const renewalCompositionOutput = z.object({
    settlementPolicy: renewalSettlementPolicy,
    contractStartDate: date,
    contractDueDate: date,
    renewalDate: date,
    requestedPrincipal: money,
    originalPrincipal: money,
    totalScheduledAmount: money,
    contractualInterest: money,
    totalPaid: money,
    receivedPrincipal: money,
    receivedInterest: money,
    remainingContractInterest: money,
    accruedDueInterest: money,
    dueFees: money,
    duePenalties: money,
    recoveredBeforeAdjustments: money,
    manualCharges: money,
    manualWaivers: money,
    settlementAmount: money,
    cashDirection: z.enum(["payout", "collection", "none"]),
    cashAmount: money,
    payments: z.array(renewalPayment),
    adjustments: z.array(renewalAdjustment),
}).strict();
const renewalOutput = z.object({
    ...publicEntity,
    status: z.string(),
    settlementPolicy: renewalSettlementPolicy,
    renewalDate: date,
    paymentStartDate: date.nullable(),
    composition: renewalCompositionOutput,
    oldLoanPublicId: uuid,
    newLoanPublicId: uuid.nullable().optional(),
    previewHash: z.string().regex(/^v\d+:[0-9a-f]{64}$/i),
    hashVersion: z.string().optional(),
    principalPaid: money,
    outstandingPrincipal: money,
    dueInterest: money.optional(),
    dueFees: money.optional(),
    duePenalties: money.optional(),
    dueCharges: money,
    settlementAmount: money,
    waivedCharges: money,
    requestedPrincipal: money,
    cashDirection: z.enum(["payout", "collection", "none"]),
    cashAmount: money,
    waiverReason: z.string().nullable().optional(),
    reason: z.string().nullable().optional(),
    expiresAt: nullableIsoDateTime.optional(),
    executedAt: nullableIsoDateTime.optional(),
    reversedAt: nullableIsoDateTime.optional(),
    createdAt: nullableIsoDateTime.optional(),
    updatedAt: nullableIsoDateTime.optional(),
}).strict();
const evidenceIntentOutput = z.object({
    ...publicEntity,
    filePublicId: uuid.nullable().optional(),
    status: z.string().optional(),
    objectKey: z.string().optional(),
    uploadUrl: z.url().optional(),
    expiresAt: isoDateTime.optional(),
    requiredHeaders: z.record(z.string(), z.string()).optional(),
    duplicate: z.boolean().optional(),
    duplicateReason: z.string().nullable().optional(),
    warnings: z.array(warningSchema).optional(),
    intakePublicId: uuid.optional(),
}).strict();
const evidenceFinalOutput = z.object({
    ...publicEntity,
    status: z.string(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/i).nullable(),
    filePublicId: uuid.nullable(),
}).strict();
const restoreEvidenceIntentOutput = evidenceIntentOutput.extend({
    evidencePublicId: uuid,
    status: z.string(),
}).strict();
const restoreEvidenceFinalOutput = evidenceFinalOutput.extend({ evidencePublicId: uuid }).strict();
const fundingDrawdownOutput = z.object({
    publicId: uuid,
    amount: money,
    outstandingPrincipal: money.nullable(),
    outstandingInterest: money.nullable(),
    outstandingFees: money.nullable(),
    outstandingPenalties: money.nullable(),
    interestRate: money.nullable(),
    startDate: date.nullable(),
    termMonths: z.number().int().nullable(),
    status: z.string().nullable(),
}).strict();
const fundingProfileOutput = z.object({
    publicId: uuid,
    name: z.string(),
    type: z.string(),
    providerName: z.string().nullable(),
    status: z.string().nullable(),
    creditLimit: money.nullable(),
    accountingMode: z.string(),
    reinvestProfitMode: z.string(),
    drawdowns: z.array(fundingDrawdownOutput),
}).strict();
const interestRateValue = floatingInterestRate;
const versionHash = z.string().regex(/^v1:[0-9a-f]{64}$/i);
const settlementBalanceOutput = z.object({
    fixedInterestCandidate: money, retroactiveInterestCandidate: money, selectedInterest: money,
    selectedInterestBranch: z.enum(["fixed", "retroactive"]), interestDifference: money,
    exposureTrace: z.array(z.object({
        amount: money, fromDate: date, toDate: date, days: z.number().int().min(0),
        rateType: z.enum(["percent_per_day", "per_thousand_per_day"]).optional(),
        rate: z.string().optional(), unroundedInterest: z.string(), roundedInterest: money,
    }).strict()),
    lateDays: z.number().int().min(0),
    grossPrincipal: money, grossInterest: money, grossFees: money, grossPenalty: money, grossSettlement: money,
    waivedInterest: money, waivedFees: money, waivedPenalty: money,
    netInterest: money, netFees: money, netPenalty: money, externalSettlementCredits: money, netSettlement: signedMoney,
}).strict();
const restructurePreviewOutput = z.object({
    publicId: uuid, oldLoanPublicId: uuid, status: z.string(), settlementDate: date,
    oldBalanceVersion: versionHash, previewHash: versionHash, expiresAt: isoDateTime,
    balance: settlementBalanceOutput, replacementPrincipal: money,
    externalCreditAllocation: z.object({ penalty: money, fee: money, interest: money, principal: money, unallocated: money }).strict(),
    replacementTerms: publicReplacementTermsOutput,
    schedule: z.array(z.object({
        installmentNo: z.number().int().positive(), dueDate: date,
        scheduledPrincipal: money, scheduledInterest: money, scheduledFee: money,
        scheduledTotal: money, remainingDue: money,
    }).strict()),
    cash: z.object({ direction: z.enum(["payout", "collection", "none"]), amount: money }).strict(),
    reason: z.string(),
}).strict();
const restructureExecutionOutput = z.object({
    publicId: uuid, status: z.string(), oldLoanPublicId: uuid, newLoanPublicId: uuid.nullable(),
    disbursementDraftPublicId: uuid.nullable(), auditPublicIds: z.array(uuid), correlationId: uuid,
}).strict();
const waiverPreviewOutput = z.object({
    publicId: uuid, loanPublicId: uuid, restructurePublicId: uuid,
    component: z.enum(["interest", "fee", "penalty"]), amount: money,
    availableAmount: money, remainingAmount: money, reason: z.string(),
    previewHash: versionHash, balanceVersion: versionHash, expiresAt: isoDateTime,
}).strict();
const waiverExecutionOutput = z.object({
    publicId: uuid, status: z.enum(["executed", "reversed"]),
    component: z.enum(["interest", "fee", "penalty"]), amount: money, reason: z.string(),
    auditPublicId: uuid, correlationId: uuid, executedAt: isoDateTime, reversedAt: nullableIsoDateTime,
}).strict();
const interestRatePeriodOutput = z.object({
    publicId: uuid,
    effectiveDate: date,
    expiryDate: date.nullable(),
    rateType: z.enum(["percent", "per_thousand"]),
    rate: interestRateValue,
}).strict();
const interestRateTimelineOutput = z.object({
    loanPublicId: uuid,
    asOfDate: date,
    currentPeriod: interestRatePeriodOutput.nullable(),
    dailyInterestAtCurrentPrincipal: money.nullable(),
    nextChange: interestRatePeriodOutput.nullable(),
    earliestEditableDate: date,
    timeline: z.array(interestRatePeriodOutput),
    timelineVersion: z.string().regex(/^[0-9a-f]{64}$/i),
}).strict();
const settlementPreviewOutput = z.object({
    id: uuid,
    publicId: uuid,
    loanPublicId: uuid,
    status: z.enum(["ready", "expired", "executed"]),
    asOfDate: date,
    outstandingPrincipal: money,
    dueInterest: money,
    accruedNotDueInterest: money,
    outstandingFees: money,
    outstandingPenalties: money,
    nonRefundableAdvanceInterest: money,
    settlementTotal: money,
    balanceVersion: z.string().regex(/^v1:[0-9a-f]{64}$/i),
    previewHash: z.string().regex(/^v1:[0-9a-f]{64}$/i),
    hashVersion: z.literal("v1"),
    expiresAt: isoDateTime,
    executedAt: nullableIsoDateTime,
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
}).strict();
const settlementTransactionOutput = z.object({
    id: uuid,
    publicId: uuid,
    amount: money,
    principalComponent: money,
    interestComponent: money,
    feeComponent: money,
    penaltyComponent: money,
    type: z.literal("close_account"),
    entryType: z.literal("repayment"),
    transactionDate: isoDateTime,
    postedAt: isoDateTime,
}).strict();
const settlementReversalTransactionOutput = z.object({
    id: uuid,
    publicId: uuid,
    amount: signedMoney,
    principalComponent: signedMoney,
    interestComponent: signedMoney,
    feeComponent: signedMoney,
    penaltyComponent: signedMoney,
    type: z.literal("close_account"),
    entryType: z.literal("reversal"),
    transactionDate: isoDateTime,
    postedAt: isoDateTime,
}).strict();
const replacementCollectibleOutput = z.object({
    principal: money, interest: money, fee: money, penalty: money, nextDueDate: date.nullable(),
}).strict();
const replacementWarningOutput = z.discriminatedUnion("code", [
    z.object({
        code: z.literal("OUTSTANDING_INTEREST_CORRECTED_TO_ZERO"),
        details: z.object({
            amount: money,
            correctedAmount: z.literal("0.00"),
            collected: z.literal(false),
            carriedForward: z.literal(false),
        }).strict(),
    }).strict(),
    z.object({
        code: z.literal("OUTSTANDING_PENALTY_CORRECTED_TO_ZERO"),
        details: z.object({
            amount: money,
            correctedAmount: z.literal("0.00"),
            treatedAsBorrowerPayment: z.literal(false),
        }).strict(),
    }).strict(),
]);
const replacementPreviewOutput = z.object({
    publicId: uuid,
    previewHash: versionHash,
    oldBalanceVersion: versionHash,
    replacementDraftVersion: versionHash,
    expiresAt: isoDateTime,
    auditPublicId: uuid,
    correlationId: uuid,
    schemaVersion: z.literal(1),
    asOfDate: date,
    reason: shortText,
    oldLoan: z.object({
        loanPublicId: uuid,
        statusBefore: z.literal("active"),
        statusAfter: z.literal("replaced"),
        principal: money,
        collectibleBefore: replacementCollectibleOutput,
        collectibleAfter: z.object({
            principal: z.literal("0.00"), interest: z.literal("0.00"), fee: z.literal("0.00"),
            penalty: z.literal("0.00"), nextDueDate: z.null(),
        }).strict(),
    }).strict(),
    cash: z.object({ direction: z.literal("none"), amount: z.literal("0.00") }).strict(),
    correction: z.object({ principal: money, interest: money, fee: money, penalty: money }).strict(),
    replacement: z.object({
        loanPublicId: uuid,
        statusBefore: z.literal("draft"),
        statusAfter: z.literal("active"),
        principal: money,
        interestRate: money,
        repaymentType: z.enum(["daily", "weekly", "monthly"]),
        termMonths: z.number().int().positive(),
        totalInstallments: z.number().int().positive(),
        installmentAmount: money,
        startDate: date,
        firstDueDate: date,
        lastDueDate: date,
        totalRepayment: money,
        fundingSourceKind: z.enum(["drawdown", "own_capital"]),
        fundingSourcePublicId: uuid,
        fundingSourceName: z.string().min(1),
    }).strict(),
    warnings: z.array(replacementWarningOutput),
}).strict();
const replacementExecutionOutput = z.object({
    replacementPublicId: uuid,
    oldLoanPublicId: uuid,
    replacementLoanPublicId: uuid,
    status: z.literal("executed"),
    auditPublicId: uuid,
    correlationId: uuid,
}).strict();
const replacementReversalOutput = replacementExecutionOutput.extend({ status: z.literal("reversed") }).strict();

const intermediaryBaseOutput = z.object({
    publicId: uuid,
    name: z.string(),
    aliases: z.array(z.string()),
    notes: z.string().nullable(),
    status: z.string(),
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
}).strict();
const intermediaryBankAccountOutput = z.object({
    publicId: uuid,
    bankCode: z.string().nullable(),
    bankName: z.string(),
    accountName: z.string(),
    maskedAccountNumber: z.string(),
    status: z.string(),
    note: z.string().nullable(),
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
}).strict();
const intermediaryAssignmentOutput = z.object({
    publicId: uuid,
    loanPublicId: uuid,
    intermediaryPublicId: uuid,
    borrowerPublicId: uuid.optional(),
    borrowerName: z.string().nullable().optional(),
    loanStatus: z.string().nullable().optional(),
    role: z.enum(["disbursement", "collection", "both"]),
    effectiveFrom: isoDateTime,
    effectiveTo: nullableIsoDateTime,
    status: z.enum(["active", "ended"]),
    note: z.string().nullable(),
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
}).strict();
const intermediaryManagedLoanOutput = z.object({
    publicId: uuid,
    borrowerPublicId: uuid,
    borrowerName: z.string(),
    principalAmount: money,
    outstandingPrincipal: money,
    outstandingInterest: money,
    outstandingFees: money,
    repaymentType: z.string(),
    startDate: date.nullable(),
    nextDueDate: date.nullable(),
    status: z.string().nullable(),
    roles: z.array(z.enum(["disbursement", "collection", "both"])),
    assignments: z.array(intermediaryAssignmentOutput),
}).strict();
const intermediatedGroupOutput = z.object({
    publicId: uuid,
    loanPublicId: uuid,
    intermediaryPublicId: uuid,
    expectedFunding: money,
    expectedBorrowerPayout: money,
    expectedAdvanceInterestReturn: money,
    retainedBalance: money,
    status: z.enum(["draft", "needs_review", "ready", "posted", "reversed"]),
    note: z.string().nullable(),
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
}).strict();
const intermediatedEventOutput = z.object({
    publicId: uuid,
    groupPublicId: uuid,
    intermediaryBankAccountPublicId: uuid.nullable(),
    reversedEventPublicId: uuid.nullable(),
    role: z.enum(["funding_to_intermediary", "borrower_net_payout", "advance_interest_return"]),
    channel: z.enum(["bank_transfer", "cash", "adjustment"]),
    amount: money,
    senderHint: z.string().nullable(),
    payeeHint: z.string().nullable(),
    bankReference: z.string().nullable(),
    transferredAt: isoDateTime,
    status: z.enum(["ready", "posted", "reversed"]),
    note: z.string().nullable(),
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
}).strict();
const intermediatedEventEvidenceOutput = z.object({
    status: z.enum(["none", "pending", "ready", "mixed"]),
    count: z.number().int().nonnegative(),
    items: z.array(z.object({
        publicId: uuid,
        filePublicId: uuid,
        status: z.enum(["pending", "ready"]),
        mimeType: z.enum(["image/jpeg", "image/png", "application/pdf"]),
    }).strict()),
}).strict();
const intermediatedInspectionEventOutput = intermediatedEventOutput.extend({
    evidence: intermediatedEventEvidenceOutput,
}).strict();
const intermediatedGroupInspectionOutput = intermediatedGroupOutput.extend({
    events: z.array(intermediatedInspectionEventOutput),
}).strict();
const intermediatedPreviewWarningOutput = z.object({
    code: z.string(),
    amount: money.optional(),
}).strict();
const intermediatedPreviewOutput = z.object({
    publicId: uuid,
    groupPublicId: uuid,
    version: z.number().int().positive(),
    status: z.enum(["needs_review", "ready", "stale", "expired", "executed"]),
    expectedFunding: money,
    actualFunding: money,
    expectedBorrowerPayout: money,
    actualBorrowerPayout: money,
    expectedAdvanceInterestReturn: money,
    actualAdvanceInterestReturn: money,
    retainedBalance: money,
    variance: signedMoney,
    evidenceReady: z.boolean(),
    warnings: z.array(intermediatedPreviewWarningOutput),
    previewHash: z.string().regex(/^[0-9a-f]{64}$/i),
    expiresAt: isoDateTime,
    createdAt: isoDateTime,
}).strict();
const intermediatedEvidenceOutput = z.object({
    publicId: uuid,
    filePublicId: uuid,
    status: z.enum(["pending", "ready"]),
    mimeType: z.enum(["image/jpeg", "image/png", "application/pdf"]),
    size: z.number().int().positive(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/i),
    originalName: z.string().nullable(),
    finalizedAt: nullableIsoDateTime,
    createdAt: isoDateTime,
}).strict();
const intermediatedCreateResultOutput = intermediatedGroupOutput.extend({
    auditPublicId: uuid,
    correlationId: uuid,
}).strict();
const intermediatedEventCreateResultOutput = intermediatedEventOutput.extend({
    auditPublicId: uuid,
    correlationId: uuid,
}).strict();
const intermediatedPreviewResultOutput = intermediatedPreviewOutput.extend({
    auditPublicId: uuid,
    correlationId: uuid,
}).strict();
const intermediatedPostOutput = intermediatedGroupOutput.extend({
    proposalPublicId: uuid,
    loanDisbursementPublicId: uuid,
    advanceInterestProjectionPublicId: uuid,
    fundingAmount: money,
    borrowerPayoutAmount: money,
    advanceInterestAmount: money,
    intermediaryHeldBalance: money,
    transferEventPublicIds: z.array(uuid).min(1),
    duplicate: z.boolean(),
    auditPublicId: uuid,
    correlationId: uuid,
}).strict();
const intermediatedReverseOutput = intermediatedGroupOutput.extend({
    reversedGroupPublicId: uuid,
    reversedLoanDisbursementPublicId: uuid,
    loanDisbursementPublicId: uuid,
    advanceInterestProjectionPublicId: uuid,
    fundingAmount: money,
    borrowerPayoutAmount: money,
    advanceInterestAmount: money,
    intermediaryHeldBalance: money,
    transferEventPublicIds: z.array(uuid).min(1),
    transferEvents: z.array(z.object({
        publicId: uuid,
        reversedEventPublicId: uuid,
    }).strict()).min(1),
    reversalReason: shortText,
    duplicate: z.boolean(),
    auditPublicId: uuid,
    correlationId: uuid,
}).strict();

const commissionRate = z.string().regex(/^(?:0|[1-9]\d{0,2})(?:\.\d{1,4})?$/).max(8);
const commissionParticipantOutput = z.object({
    publicId: uuid, loanPublicId: uuid, intermediaryPublicId: uuid,
    previousParticipantPublicId: uuid.nullable(), commissionRate, role: shortText,
    note: z.string().nullable(), effectiveFrom: isoDateTime, effectiveTo: isoDateTime.nullable(),
    status: z.enum(["active", "ended"]), auditPublicId: uuid, correlationId: uuid, createdAt: isoDateTime,
}).strict();
const commissionPreviewOutput = z.object({
    loanPublicId: uuid, paymentPublicIds: z.array(uuid).min(1), interestAmount: signedMoney,
    totalCommission: signedMoney,
    participants: z.array(z.object({
        participantPublicId: uuid, intermediaryPublicId: uuid, commissionRate, commissionAmount: signedMoney,
    }).strict()),
}).strict();
const paymentAttributionOutput = z.object({
    publicId: uuid, paymentPublicId: uuid, transactionPublicId: uuid.nullable(),
    sourceKind: z.enum(["direct", "intermediary"]), intermediaryPublicId: uuid.nullable(), amount: signedMoney,
    reason: z.string().nullable(), reversedAttributionPublicId: uuid.nullable(),
    auditPublicId: uuid, correlationId: uuid, createdAt: isoDateTime,
}).strict();

const batchWarningOutput = z.object({ code: z.string(), itemPublicId: uuid.optional(), message: z.string().optional() }).strict();
const batchAllocationOutput = z.object({ itemPublicId: uuid, borrowerPublicId: uuid.optional(), loanPublicId: uuid, schedulePublicId: uuid.nullable().optional(), amount: money, targetDueDate: date, intent: z.enum(["on_time", "advance", "backdated"]), matchSource: z.enum(["human_explicit", "unique_exact", "selected_candidate"]).optional(), calculatedComponents: z.object({ principal: money, interest: money, fee: money, penalty: money }).strict().optional() }).strict();
const batchLatestPreviewOutput = z.object({ id: uuid, version: z.number().int(), status: z.string(), previewHash: z.string(), confirmationHash: z.string(), warnings: z.array(batchWarningOutput), candidates: z.array(z.object({ allocations: z.array(batchAllocationOutput) }).strict()) }).strict();
const batchOutput = z.object({ id: uuid, publicId: uuid, status: z.string(), version: z.number().int(), borrowerPublicId: uuid.nullable().optional(), stateHash: z.string(), confirmationHash: z.string().nullable().optional(), confirmedVersion: z.number().int().nullable().optional(), notes: z.string().nullable().optional(), items: z.array(z.object({ id: uuid, publicId: uuid, itemOrder: z.number().int(), paymentIntakePublicId: uuid.nullable(), evidenceStatus: z.string().nullable() }).strict()), latestPreview: batchLatestPreviewOutput.nullable().optional(), postedAt: isoDateTime.nullable().optional(), createdAt: isoDateTime, updatedAt: isoDateTime }).strict();
const batchCaptureOutput = z.object({ id: uuid, publicId: uuid, status: z.string(), version: z.number().int(), borrowerPublicId: uuid.nullable().optional(), stateHash: z.string(), confirmationHash: z.string().nullable().optional(), confirmedVersion: z.number().int().nullable().optional(), notes: z.string().nullable().optional(), items: z.array(z.object({ clientItemKey: z.string(), paymentIntakePublicId: uuid, batchItemPublicId: uuid, status: z.string(), duplicate: z.boolean() }).strict()), latestPreview: z.unknown().nullable().optional(), postedAt: isoDateTime.nullable().optional(), createdAt: isoDateTime, updatedAt: isoDateTime }).strict();
const batchEvidencePrepareManyOutput = z.object({ batchPublicId: uuid, items: z.array(evidenceIntentOutput.extend({ batchItemPublicId: uuid, paymentIntakePublicId: uuid })) }).strict();
const batchEvidenceFinalizeManyOutput = z.object({ batchPublicId: uuid, allEvidenceReady: z.boolean(), items: z.array(evidenceFinalOutput.extend({ batchItemPublicId: uuid, paymentIntakePublicId: uuid })) }).strict();
const batchPreviewOutput = z.object({ id: uuid, publicId: uuid, batchPublicId: uuid, version: z.number().int(), status: z.string(), stateHash: z.string(), previewHash: z.string(), confirmationHash: z.string(), evidenceReady: z.boolean(), allocations: z.array(batchAllocationOutput), candidates: z.array(z.object({ allocations: z.array(batchAllocationOutput) }).strict()), warnings: z.array(batchWarningOutput) }).strict();
const batchStageOutput = z.object({ batchPublicId: uuid, status: z.string(), items: z.array(z.object({ publicId: uuid, clientItemKey: z.string(), status: z.string() }).strict()), auditPublicId: uuid, correlationId: uuid }).strict();
const stagingEvidencePrepareOutput = z.object({ evidencePublicId: uuid, stagingItemPublicId: uuid, status: z.string(), auditPublicId: uuid, correlationId: uuid, uploadUrl: z.url().optional(), expiresAt: isoDateTime.optional(), requiredHeaders: z.record(z.string(), z.string()).optional(), immutable: z.boolean().optional() }).strict();
const stagingEvidenceFinalizeOutput = z.object({ evidencePublicId: uuid, status: z.string(), sha256: z.string().regex(/^[0-9a-f]{64}$/i), auditPublicId: uuid, correlationId: uuid }).strict();
const stagingReviewOutput = z.object({ stagingItemPublicId: uuid, status: z.string(), paymentIntakePublicId: uuid, batchItemPublicId: uuid, receipt: z.object({ operationType: z.literal("staging.review"), operationKey: z.string() }).strict(), auditPublicId: uuid, correlationId: uuid }).strict();
const stagingEditOutput = z.object({ stagingItemPublicId: uuid, status: z.string(), revision: z.number().int(), auditPublicId: uuid, correlationId: uuid }).strict();
const batchDecisionOutput = z.object({ decisionPublicId: uuid, batchPublicId: uuid, revision: z.number().int(), action: z.literal("confirm_no_older_pending"), auditPublicId: uuid, correlationId: uuid }).strict();
const batchCancelOutput = z.object({ batchPublicId: uuid, status: z.literal("cancelled"), reason: z.string(), revision: z.number().int(), view: batchOutput, auditPublicId: uuid, correlationId: uuid }).strict();
const batchWorkspaceItemOutput = z.object({
    publicId: uuid, clientItemKey: z.string(), status: z.string(), revision: z.number().int(),
    amount: money.nullable(), receivedAt: isoDateTime.nullable(), payerName: z.string().nullable(),
    paymentIntakePublicId: uuid.nullable(), batchItemPublicId: uuid.nullable(),
    reviewedReason: z.string().nullable(), reviewedRangeFrom: date.nullable(), reviewedRangeTo: date.nullable(),
    evidence: z.object({ publicId: uuid, status: z.string(), mimeType: z.string(), declaredSize: z.number().int(), finalizedAt: isoDateTime.nullable() }).nullable(),
    evidenceStatus: z.string().nullable(),
}).strict();
const batchWorkspaceOutput = z.object({ batchPublicId: uuid, batch: batchOutput, items: z.array(batchWorkspaceItemOutput) }).strict();
const candidateComponentsOutput = z.object({ principal: money, interest: money, fee: money, penalty: money }).strict();
const candidateScheduleOutput = z.object({ publicId: uuid, dueDate: date, status: z.string(), remainingDue: money, components: candidateComponentsOutput }).strict();
const candidateContractOutput = z.object({ borrowerPublicId: uuid, borrowerName: z.string(), loanPublicId: uuid, repaymentType: z.string(), status: z.string(), eligible: z.boolean(), eligibilityCode: z.string().nullable(), principalAmount: money, outstandingPrincipal: money, interestRate: money, startDate: date.nullable(), nextDueDate: date.nullable(), dueComponents: candidateComponentsOutput.nullable(), proposalComponents: candidateComponentsOutput.nullable(), schedules: z.array(candidateScheduleOutput) }).strict();
const batchCandidatesOutput = z.object({ stagingItemPublicId: uuid, batchItemPublicId: uuid.nullable(), stagingRevision: z.number().int(), batchRevision: z.number().int(), amount: money, receivedAt: isoDateTime, businessDate: date, inputFingerprint: z.string(), borrowerResolution: z.enum(["none", "unique", "ambiguous", "candidates"]), matchType: z.enum(["canonical", "confirmed_alias", "fuzzy"]).nullable(), borrowerCandidates: z.array(z.object({ publicId: uuid, name: z.string(), matchType: z.enum(["canonical", "confirmed_alias", "fuzzy"]).nullable() }).strict()), contractCandidates: z.array(candidateContractOutput), candidateLimitReached: z.boolean(), reviewRequired: z.boolean() }).strict();
const batchExecutionOutput = z.object({ batchPublicId: uuid, status: z.literal("posted"), posted: z.array(z.object({ intakePublicId: uuid, transactionPublicIds: z.array(uuid) }).strict()).optional(), auditPublicIds: z.array(uuid), correlationId: uuid }).strict();
const fundingAllocationOutput = z.object({
    id: uuid, publicId: uuid, loanPublicId: uuid,
    bankProfilePublicId: uuid.nullable(), bankLoanPublicId: uuid.nullable(),
    allocatedAmount: signedMoney, allocationDate: date,
    allocationType: z.enum(["initial", "manual_adjustment", "reallocation_in", "reallocation_out"]),
    note: z.string().nullable(), createdAt: isoDateTime,
}).strict();
const fundingAllocationPreviewOutput = z.object({
    source: z.object({ bankProfilePublicId: uuid.nullable(), bankLoanPublicId: uuid.nullable(), remainingCapacity: money }).strict(),
    target: z.object({ loanPublicId: uuid, principalAmount: money, remainingUnfundedPrincipal: money }).strict(),
    requestedAmount: money,
    resultingFunding: z.object({ netAllocatedPrincipal: money, remainingGap: money, state: z.enum(["unfunded", "partially_funded", "fully_funded"]) }).strict(),
    warnings: z.array(z.string()),
}).strict();
const diagnosticBreadcrumbOutput = z.object({
    stage: z.enum([...mcpDiagnosticStages, "breadcrumbs_truncated"] as [string, ...string[]]), outcome: z.enum(["started", "succeeded", "failed", "rejected"]), elapsedMs: z.number().int().nonnegative().max(86_400_000),
    metadata: z.object({ runtimeCodeCategory: z.enum(safeDiagnosticRuntimeCategories).optional(), httpStatus: z.number().int().min(100).max(599).optional(), timeout: z.boolean().optional(), attempt: z.number().int().nonnegative().max(10_000).optional(), itemCount: z.number().int().nonnegative().max(10_000).optional() }).strict().optional(),
}).strict();
const diagnosticItemOutput = z.object({
    diagnosticPublicId: uuid, toolName: z.string(), correlationId: uuid, requestId: uuid,
    category: z.string(), failureClass: z.string(), errorCode: z.string(), terminalStage: z.string(),
    retryable: z.boolean(), reviewRequired: z.boolean(), upstreamStatus: z.number().int().nullable(),
    durationMs: z.number().int().nonnegative(), occurredAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
    breadcrumbs: z.array(diagnosticBreadcrumbOutput).max(20), summary: z.string(), recommendedNextCheck: z.string(),
}).strict();
const workflowResolverStepOutput = z.object({
    toolName: z.string().trim().min(1).max(120),
    arguments: z.record(z.string(), z.string()),
    requiredInputs: z.array(z.string().trim().min(1).max(120)).max(20),
    requiresConfirmation: z.boolean(),
}).strict();
const workflowResolverOutput = z.object({
    workflowId: z.string().trim().min(1).max(120),
    workflowVersion: z.string().trim().min(1).max(120),
    catalogVersion: z.string().trim().min(1).max(160),
    policyRevision: z.string().trim().min(1).max(160),
    observed: z.object({
        state: z.enum(["unresolved", "mutable", "posted", "cancelled", "duplicate", "reversed"]).nullable(),
        loanType: z.enum(["scheduled", "floating"]).nullable(),
        evidenceReady: z.boolean(),
        restoreCancellationAllowed: z.boolean().nullable(),
        restoreCancellationBlockedReason: z.string().nullable(),
        restoreCancellationStateHash: z.string().regex(/^[0-9a-f]{64}$/i).nullable(),
    }).strict(),
    status: z.enum(["needs_input", "next_step", "confirmation_required", "blocked", "refresh_required", "connection_required"]),
    nextSteps: z.array(workflowResolverStepOutput).max(3),
    blockers: z.array(z.string().trim().min(1).max(160)).max(8),
    prohibitedTools: z.array(z.string().trim().min(1).max(120)).max(8),
    reevaluateOn: z.enum(["target_change", "evidence_change", "preview_expiry", "version_change"]),
}).strict();
const workflowResolverInput = z.object({
    intent: z.enum(["inspect", "receive_payment", "close_loan", "originate_loan", "disburse_loan", "attach_evidence", "renew_loan", "intermediary_collection", "cancel_payment_restore", "tool_help"]),
    target: z.object({ kind: z.enum(["borrower", "loan", "payment_intake", "loan_disbursement"]), publicId: uuid }).strict().optional(),
    attachments: z.enum(["none", "present", "unknown"]).optional(),
    expectedAttachmentCount: z.number().int().min(1).max(20).optional(),
    knownWorkflowVersion: z.string().trim().min(1).max(120).optional(),
    knownCatalogVersion: z.string().trim().min(1).max(160).optional(),
    toolName: z.string().trim().min(1).max(120).optional(),
}).strict();

export const toolDataSchemas: Record<McpToolName, z.ZodType<Record<string, unknown>>> = {
    "borrower.search": z.object({
        resolution: z.enum(["none", "unique", "ambiguous", "candidates"]),
        matchType: z.enum(["canonical", "confirmed_alias", "fuzzy"]).nullable().optional(),
        candidates: z.array(borrowerOutput),
    }).strict(),
    "borrower.portfolio": z.object({
        borrower: borrowerOutput,
        aliases: z.array(aliasOutput),
        loans: z.array(z.object({
            ...publicEntity,
            principal: money,
            interestRate: money,
            repaymentType: z.string(),
            status: z.string().nullable(),
            replacementLineage: replacementLineageOutput.nullable(),
            startDate: date.nullable(),
            createdAt: nullableIsoDateTime.optional(),
        }).strict()),
    }).strict(),
    "borrower.resolve-and-portfolio": z.object({
        resolution: z.enum(["none", "unique", "ambiguous", "candidates"]),
        matchType: z.enum(["public_id", "canonical", "confirmed_alias", "fuzzy"]).nullable(),
        selectedBorrowerPublicId: uuid.nullable(),
        candidates: compositePageOutput(borrowerOutput),
        portfolio: z.object({
            borrower: borrowerOutput,
            aliases: compositePageOutput(aliasOutput),
            loans: compositePageOutput(compositePortfolioLoanOutput),
        }).strict().nullable(),
    }).strict(),
    "borrower.create": borrowerOutput,
    "borrower.update": borrowerOutput,
    "borrower.alias": aliasOutput,
    "intake.get": intakeOutput.extend({
        evidence: z.array(paymentEvidenceOutput),
        latestProposal: proposalOutput.nullable(),
        cancellation: paymentCancellationCapabilityOutput,
        restoreCancellation: paymentRestoreCancellationCapabilityOutput.nullable(),
    }).strict(),
    "payment.match-context": z.object({
        intake: compositePaymentDetailOutput,
        proposal: compositeProposalOutput.nullable(),
        borrowerResolution: z.object({
            resolution: z.enum(["none", "unique", "ambiguous", "candidates"]),
            matchType: z.enum(["canonical", "confirmed_alias", "fuzzy"]).nullable().optional(),
            candidates: compositePageOutput(borrowerOutput),
        }).strict(),
        allocations: compositePageOutput(proposalAllocationOutput),
        loanContexts: compositePageOutput(compositeLoanContextOutput).nullable(),
        view: z.enum(["summary", "schedule", "history"]),
    }).strict(),
    "intake.list": z.object({ items: z.array(intakeOutput) }).strict(),
    "intake.create": z.union([
        intakeOutput.extend({ duplicate: z.literal(false), duplicateReason: z.null(), warnings: z.array(warningSchema) }),
        z.object({ ...publicEntity, status: z.string(), duplicate: z.literal(true), duplicateReason: z.string(), warnings: z.array(warningSchema) }).strict(),
    ]),
    "evidence.prepare": evidenceIntentOutput,
    "evidence.finalize": evidenceFinalOutput,
    "evidence.import-chatgpt-file": evidenceFinalOutput.extend(writeAuditMetadata).strict(),
    "loan.disbursement.evidence.import-chatgpt-file": chatgptDisbursementEvidenceOutput,
    "payment.evidence-supplement.import-chatgpt-file": evidenceFinalOutput.extend(writeAuditMetadata).strict(),
    "payment.evidence-supplement.record": evidenceFinalOutput.extend(writeAuditMetadata).strict(),
    "payment.preview": proposalOutput,
    "payment.cancel": paymentCancellationOutput,
    "payment.restore.cancel": paymentCancellationOutput,
    "payment.replacement.inspect": z.object({ sourcePaymentIntakePublicId: uuid, allowed: z.boolean(), blockers: z.array(z.string()), blockerPublicIds: z.array(uuid).optional(), stateHash: z.string().regex(/^[0-9a-f]{64}$/i), replacementPaymentIntakePublicId: uuid.nullable(), lineagePublicId: uuid.nullable().optional() }).strict(),
    "payment.replacement.create": z.object({ sourcePaymentIntakePublicId: uuid, replacementPaymentIntakePublicId: uuid, status: z.literal("draft"), auditPublicId: uuid, correlationId: uuid, lineagePublicId: uuid }).strict(),
    "payment.replacement.duplicate-review.preview": z.object({ duplicateReviewPublicId: uuid, status: z.literal("previewed"), canonicalPaymentIntakePublicId: uuid, candidatePaymentIntakePublicIds: z.array(uuid).min(1), canonicalEvidenceCandidatePublicIds: z.array(uuid), previewHash: z.string().regex(/^[0-9a-f]{64}$/i), canonicalStateHash: z.string().regex(/^[0-9a-f]{64}$/i), evidenceHash: z.string().regex(/^[0-9a-f]{64}$/i), dependencyHash: z.string().regex(/^[0-9a-f]{64}$/i), expiresAt: isoDateTime, auditPublicId: uuid, correlationId: uuid }).strict(),
    "payment.replacement.duplicate-review.execute": z.object({ duplicateReviewPublicId: uuid, status: z.literal("executed"), auditPublicId: uuid, correlationId: uuid, executionPublicId: uuid }).strict(),
    "payment.post": intakeOutput.extend({ transactions: z.array(transactionOutput) }),
    "payment.reverse": intakeOutput.extend({ transactions: z.array(transactionOutput) }),
    "payment.reverse-with-accrual.preview": z.object({
        paymentIntakePublicId: uuid,
        receivedAt: nullableIsoDateTime,
        amount: money,
        originalTransactionPublicIds: z.array(uuid),
        loanPublicIds: z.array(uuid),
        throughDate: date,
        accrualPreview: z.array(z.object({
            loanPublicId: uuid,
            throughDate: date,
            missingAccrualCount: z.number().int().nonnegative(),
            missingAccrualAmount: money,
            existingDueInterest: money,
        }).strict()),
        interestAccrualMode: z.literal("ensure_due_through_payment_date"),
        previewHash: z.string().regex(/^v1:[0-9a-f]{64}$/i),
        expiresAt: isoDateTime,
    }).strict(),
    "payment.reverse-with-accrual.execute": intakeOutput.extend({
        transactions: z.array(transactionOutput),
        createdAccrualPublicIds: z.array(uuid),
        promotedAccrualPublicIds: z.array(uuid),
        auditPublicIds: z.array(uuid),
        correlationId: uuid,
    }),
    "payment.batch.create": batchOutput,
    "payment.batch.capture": batchCaptureOutput,
    "payment.batch.evidence.prepare-many": batchEvidencePrepareManyOutput,
    "payment.batch.evidence.finalize-many": batchEvidenceFinalizeManyOutput,
    "payment.batch.item.add": batchOutput,
    "payment.batch.evidence.prepare": evidenceIntentOutput,
    "payment.batch.evidence.finalize": evidenceFinalOutput,
    "payment.batch.get": batchOutput,
    "payment.batch.stage": batchStageOutput,
    "payment.batch.staging.evidence.prepare": stagingEvidencePrepareOutput,
    "payment.batch.staging.evidence.finalize": stagingEvidenceFinalizeOutput,
    "payment.batch.staging.extract": z.object({
        stagingItemPublicId: uuid,
        batchPublicId: uuid,
        stagingRevision: z.number().int().positive(),
        evidencePublicId: uuid,
        evidenceSha256: z.string().regex(/^[0-9a-f]{64}$/i),
        proposal: z.object({
            status: z.literal("needs_human_review"), reviewRequired: z.literal(true),
            amount: money.nullable(), transferredAt: nullableIsoDateTime, payerName: z.string().nullable(), receiverName: z.string().nullable(), fee: money.nullable(), referenceHash: z.string().regex(/^[0-9a-f]{64}$/i).nullable(), evidenceSha256: z.string().regex(/^[0-9a-f]{64}$/i),
        }).strict(),
        auditPublicId: uuid, correlationId: uuid,
    }).strict(),
    "payment.batch.workspace": batchWorkspaceOutput,
    "payment.batch.candidates": batchCandidatesOutput,
    "payment.batch.staging.review": stagingReviewOutput,
    "payment.batch.staging.edit": stagingEditOutput,
    "payment.batch.split": z.object({ sourceBatchPublicId: uuid, destinationBatchPublicId: uuid, dependencyPublicId: uuid, movedItemPublicIds: z.array(uuid) }).strict(),
    "payment.batch.decision": batchDecisionOutput,
    "payment.batch.cancel": batchCancelOutput,
    "payment.batch.preview": batchPreviewOutput,
    "payment.batch.execute": batchExecutionOutput,
    "payment.reconcile.preview": reconciliationPreviewOutput,
    "payment.reconcile.reflow.preview": z.object({ publicId: uuid, status: z.literal("ready"), reconciliationGroupPublicId: uuid, effectiveAfterDate: date, plan: temporalReflowPlanOutput, previewHash: z.string().regex(/^v1:[0-9a-f]{64}$/i), expectedBalanceVersion: z.string().regex(/^v1:[0-9a-f]{64}$/i), reason: z.string(), expiresAt: isoDateTime, warnings: z.array(z.never()) }).strict(),
    "payment.reconcile.reflow.execute": z.object({ reflowGroupPublicId: uuid, reconciliationGroupPublicId: uuid, compensatingTransactionPublicIds: z.array(uuid), correctedTransactionPublicIds: z.array(uuid), auditPublicIds: z.array(uuid), correlationId: uuid }).strict(),
    "payment.allocation-correction.preview": z.object({ publicId: uuid, status: z.enum(["ready", "blocked"]), paymentIntakePublicId: uuid, transactionPublicId: uuid, loanPublicId: uuid, source: correctionScheduleProjectionOutput, target: correctionScheduleProjectionOutput, amount: money, components: z.object({ principal: money, interest: money, fee: money, penalty: money }).strict(), netLoanVariance: z.object({ amount: signedMoney, principal: signedMoney, interest: signedMoney, fee: signedMoney, penalty: signedMoney }).strict(), warnings: z.array(correctionWarningOutput), previewHash: z.string().regex(/^v1:[0-9a-f]{64}$/i), expectedBalanceVersion: z.string().regex(/^v1:[0-9a-f]{64}$/i), expiresAt: isoDateTime }).strict(),
    "payment.allocation-correction.execute": z.object({ correctionPublicId: uuid, paymentIntakePublicId: uuid, sourceTransactionPublicId: uuid, compensatingTransactionPublicId: uuid, replacementTransactionPublicId: uuid, sourceSchedulePublicId: uuid, targetSchedulePublicId: uuid, amount: money, components: z.object({ principal: money, interest: money, fee: money, penalty: money }).strict(), auditPublicId: uuid, correlationId: uuid }).strict(),
    "payment.reconcile.preflight": paymentExecutionPreflightOutput,
    "payment.reconcile.mark-review": paymentReconciliationReviewOutput,
    "payment.reconcile.execute": reconciliationExecuteOutput,
    "payment.restore.create": paymentRestoreDraftOutput,
    "payment.restore.evidence.prepare": restoreEvidenceIntentOutput,
    "payment.restore.evidence.finalize": restoreEvidenceFinalOutput,
    "payment.restore.preview": restorePreviewOutput,
    "payment.restore.execute": reconciliationExecuteOutput,
    "payment.restore.schedule-backfill": paymentRestoreScheduleBackfillOutput,
    "loan.preview": z.union([
        z.object({
            terms: z.object({ ...loanTerms }).strict(),
            schedule: z.array(scheduleOutput),
            floatingDailyInterest: z.object({
                mode: z.enum(["per_thousand", "percent"]),
                rate: z.string().regex(/^\d+(?:\.\d{1,4})?$/),
                firstDayTreatment: z.enum(["deduct", "start_next_day"]),
            }).strict(),
            firstDayInterest: money,
            dailyInterestAtCurrentPrincipal: money,
            netDisbursement: money,
            nextInterestDate: date,
        }).strict(),
        z.object({
            terms: z.object({ ...loanTerms }).strict(),
            schedule: z.array(scheduleOutput),
            dailyLoanCalculation: z.object({
                totalInstallments: z.number().int().positive(), installmentAmount: money, totalRepayment: money, totalInterest: money, dailyInterest: money,
                flatDailyRatePercent: z.string(), flatMonthlyRatePercent: z.string(), flatAnnualRatePercent: z.string(),
            }).nullable(),
        }).strict(),
        z.object({
            terms: z.object({ ...loanTerms }).strict(),
            schedule: z.array(scheduleOutput),
            floatingInterestPolicy,
            floatingDailyInterest,
            fullPeriodInterest: money,
            advanceInterest: money,
            netBorrowerPayout: money,
            firstPeriodStartDate: date,
            firstPeriodDueDate: date,
            periodDays: z.union([z.literal(1), z.literal(7)]),
            advanceInterestAmount: money,
            netDisbursement: money,
            coveredStartDate: date.nullable(),
            coveredEndDate: date.nullable(),
            nextAccrualDate: date,
            advanceInterestRefundPolicy: z.literal("non_refundable"),
        }).strict(),
    ]),
    "loan.draft": loanOutput,
    "loan.draft.delete": z.object({ loanPublicId: uuid, status: z.literal("deleted"), auditPublicId: uuid, correlationId: uuid }).strict(),
    "loan.activate": loanOutput,
    "loan.interest-rate.list": interestRateTimelineOutput,
    "loan.interest-rate.preview": z.object({
        id: uuid,
        publicId: uuid,
        loanPublicId: uuid,
        request: z.object({
            effectiveDate: date,
            expiryDate: date.nullable(),
            rateType: z.enum(["percent", "per_thousand"]),
            rate: interestRateValue,
        }).strict(),
        beforeTimeline: z.array(interestRatePeriodOutput),
        afterTimeline: z.array(interestRatePeriodOutput),
        supersededPeriodPublicIds: z.array(uuid),
        warnings: z.array(warningSchema),
        timelineVersion: z.string().regex(/^[0-9a-f]{64}$/i),
        previewHash: z.string().regex(/^v1:[0-9a-f]{64}$/i),
        expiresAt: isoDateTime,
    }).strict(),
    "loan.interest-rate.execute": interestRateTimelineOutput.extend({
        auditPublicId: uuid,
        correlationId: uuid,
    }).strict(),
    "loan.settlement.preview": settlementPreviewOutput,
    "loan.settlement.execute": settlementPreviewOutput.extend({
        status: z.literal("executed"),
        transaction: settlementTransactionOutput,
        reason: shortText,
        auditPublicId: uuid,
        correlationId: uuid,
    }).strict(),
    "loan.settlement.reverse": z.object({
        settlementPublicId: uuid,
        status: z.literal("reversed"),
        transaction: settlementReversalTransactionOutput,
        reason: shortText,
        auditPublicId: uuid,
        correlationId: uuid,
    }).strict(),
    "loan.cancel.preview": z.object({
        id: uuid,
        publicId: uuid,
        loanPublicId: uuid,
        reason: shortText,
        eligibility: z.literal("unfunded"),
        before: z.object({
            status: z.string().nullable(),
            outstandingPrincipal: money,
            outstandingInterest: money,
            outstandingFees: money,
            nextDueDate: date.nullable(),
            postedPaymentCount: z.number().int().nonnegative(),
            postedDisbursementCount: z.number().int().nonnegative(),
            netDisbursed: money,
        }).strict(),
        balanceVersion: versionHash,
        previewHash: versionHash,
        status: z.literal("ready"),
        expiresAt: dateTime,
    }).strict(),
    "loan.cancel.execute": loanOutput.extend({
        auditPublicId: uuid,
        auditPublicIds: z.array(uuid).min(1),
        correlationId: uuid,
    }).strict(),
    "loan.replacement.preview": replacementPreviewOutput,
    "loan.replacement.execute": replacementExecutionOutput,
    "loan.replacement.reverse": replacementReversalOutput,
    "loan.disbursement.list": z.object({
        loanPublicId: uuid,
        summary: disbursementSummaryOutput,
        events: z.array(disbursementEventOutput),
    }).strict(),
    "loan.contract.get": loanOutput.extend({
        paymentHealth: loanPaymentHealthOutput.optional(),
        schedule: z.array(loanContractScheduleOutput),
    }).strict(),
    "loan.inspect-context": z.object({
        loan: compositeLoanOutput,
        view: z.enum(["summary", "schedule", "history"]),
        schedule: compositePageOutput(loanContractScheduleOutput).nullable(),
        history: compositePageOutput(loanPaymentHistoryItemOutput).nullable(),
        disbursements: compositePageOutput(disbursementEventOutput).nullable(),
        accruals: compositePageOutput(loanAccrualOutput).nullable(),
    }).strict(),
    "loan.payment-start-date.update": loanOutput.extend(writeAuditMetadata).strict(),
    "loan.payment-history.list": z.object({
        loanPublicId: uuid,
        items: z.array(loanPaymentHistoryItemOutput),
    }).strict(),
    "loan.disbursement.draft": disbursementEventOutput,
    "loan.disbursement.update": disbursementEventOutput,
    "loan.disbursement.evidence.prepare": disbursementEvidenceIntentOutput,
    "loan.disbursement.evidence.finalize": disbursementEvidenceIntentOutput,
    "loan.disbursement.post": disbursementEventOutput.extend({
        duplicate: z.boolean(), auditPublicId: uuid.nullable(), correlationId: uuid,
    }).strict(),
    "loan.disbursement.reverse": disbursementEventOutput.extend({
        reversedEventPublicId: uuid, duplicate: z.boolean(), auditPublicId: uuid.nullable(), correlationId: uuid,
    }).strict(),
    "loan.commission-participant.list": z.object({ items: z.array(commissionParticipantOutput) }).strict(),
    "loan.commission-participant.add": commissionParticipantOutput,
    "loan.commission-participant.update": commissionParticipantOutput,
    "loan.commission-participant.end": commissionParticipantOutput,
    "loan.commission.preview": commissionPreviewOutput,
    "loan.commission.list": commissionPreviewOutput,
    "loan.commission.calculate": commissionPreviewOutput,
    "loan.commission.reverse": commissionPreviewOutput,
    "payment.intermediary-attribution.create": paymentAttributionOutput,
    "payment.intermediary-attribution.list": z.object({ items: z.array(paymentAttributionOutput) }).strict(),
    "payment.intermediary-attribution.reverse": paymentAttributionOutput,
    "intermediary.search": z.object({ items: z.array(intermediaryBaseOutput) }).strict(),
    "intermediary.create": intermediaryBaseOutput,
    "intermediary.profile.get": intermediaryBaseOutput.extend({
        bankAccounts: z.array(intermediaryBankAccountOutput),
        assignments: z.array(intermediaryAssignmentOutput),
    }).strict(),
    "intermediary.bank-account.save": intermediaryBankAccountOutput.extend(writeAuditMetadata).strict(),
    "intermediary.managed-loan.list": z.object({ items: z.array(intermediaryManagedLoanOutput) }).strict(),
    "intermediary.assignment.create": intermediaryAssignmentOutput.extend(writeAuditMetadata).strict(),
    "intermediary.assignment.end": intermediaryAssignmentOutput.extend(writeAuditMetadata).strict(),
    "intermediary.disbursement.list": z.object({ items: z.array(intermediatedGroupInspectionOutput) }).strict(),
    "intermediary.disbursement.get": intermediatedGroupInspectionOutput.extend({
        latestPreview: intermediatedPreviewOutput.nullable(),
    }).strict(),
    "intermediary.disbursement.create": intermediatedCreateResultOutput,
    "intermediary.disbursement.event.create": intermediatedEventCreateResultOutput,
    "intermediary.disbursement.evidence.prepare": intermediatedEvidenceOutput.extend({
        uploadUrl: z.url().optional(),
        expiresAt: isoDateTime.optional(),
        requiredHeaders: z.record(z.string(), z.string()).optional(),
        ...writeAuditMetadata,
    }).strict(),
    "intermediary.disbursement.evidence.finalize": intermediatedEvidenceOutput.extend(writeAuditMetadata).strict(),
    "intermediary.disbursement.preview": intermediatedPreviewResultOutput,
    "intermediary.disbursement.post": intermediatedPostOutput,
    "intermediary.disbursement.reverse": intermediatedReverseOutput,
    "intermediary.collection.list": z.object({ items: z.array(z.record(z.string(), z.unknown())) }).strict(),
    "intermediary.collection.create": z.record(z.string(), z.unknown()),
    "intermediary.collection.cancel": z.record(z.string(), z.unknown()),
    "intermediary.remittance.get": z.record(z.string(), z.unknown()),
    "intermediary.remittance.create": z.record(z.string(), z.unknown()),
    "intermediary.remittance.allocations.save": z.record(z.string(), z.unknown()),
    "intermediary.remittance.preview": z.record(z.string(), z.unknown()),
    "intermediary.remittance.evidence.prepare": z.record(z.string(), z.unknown()),
    "intermediary.remittance.evidence.finalize": z.record(z.string(), z.unknown()),
    "intermediary.remittance.post": z.record(z.string(), z.unknown()),
    "renewal.preview": renewalOutput,
    "renewal.execute": renewalOutput,
    "renewal.reverse": renewalOutput,
    "loan.restructure.preview": restructurePreviewOutput,
    "loan.restructure.execute": restructureExecutionOutput,
    "loan.restructure.reverse": restructureExecutionOutput,
    "loan.waiver.preview": waiverPreviewOutput,
    "loan.waiver.execute": waiverExecutionOutput,
    "loan.waiver.reverse": waiverExecutionOutput,
    "funding-source.list": z.object({ profiles: z.array(fundingProfileOutput) }).strict(),
    "funding-allocation.preview": fundingAllocationPreviewOutput,
    "funding-allocation.create": fundingAllocationOutput.extend({ auditPublicId: uuid, correlationId: uuid }).strict(),
    "funding-allocation.list": z.object({ items: z.array(fundingAllocationOutput) }).strict(),
    "system.error-diagnostic.get": z.object({ correlationId: uuid, items: z.array(diagnosticItemOutput).max(100) }).strict(),
    "system.error-diagnostic.list": z.object({ items: z.array(diagnosticItemOutput).max(100), nextCursor: z.string().nullable() }).strict(),
    "workflow.resolve": workflowResolverOutput,
};

export const toolInputSchemas: Record<McpToolName, z.ZodType<Record<string, unknown>>> = {
    "borrower.search": z.object({ query: shortText }).strict(),
    "borrower.portfolio": z.object({ borrowerPublicId: uuid }).strict(),
    "borrower.resolve-and-portfolio": z.object({
        query: shortText.optional(),
        borrowerPublicId: uuid.optional(),
        limit: z.number().int().min(1).max(100).optional(),
        cursors: compositeCursorsInput.optional(),
    }).strict().superRefine((value, ctx) => {
        if (Boolean(value.query) === Boolean(value.borrowerPublicId)) {
            ctx.addIssue({ code: "custom", message: "Exactly one of query or borrowerPublicId is required" });
        }
    }),
    "borrower.create": z.object(borrowerFields).strict(),
    "borrower.update": z.object({
        borrowerPublicId: uuid,
        changes: z.object(borrowerFields).partial().strict(),
    }).strict(),
    "borrower.alias": z.object({
        action: z.enum(["add", "confirm", "deactivate"]),
        borrowerPublicId: uuid.optional(),
        aliasPublicId: uuid.optional(),
        alias: z.string().trim().min(1).max(300).optional(),
        source: z.enum(["manual", "payment", "import"]).optional(),
    }).strict().superRefine((value, ctx) => {
        if (value.action === "add" && (!value.borrowerPublicId || !value.alias)) {
            ctx.addIssue({ code: "custom", message: "add requires borrowerPublicId and alias" });
        }
        if (value.action !== "add" && !value.aliasPublicId) {
            ctx.addIssue({ code: "custom", message: `${value.action} requires aliasPublicId` });
        }
    }),
    "intake.get": z.object({ paymentIntakePublicId: uuid }).strict(),
    "payment.match-context": z.object({
        paymentIntakePublicId: uuid,
        view: z.enum(["summary", "schedule", "history"]).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        cursors: compositeCursorsInput.optional(),
    }).strict(),
    "intake.list": z.object({
        status: z.enum(["draft", "needs_review", "ready", "posted", "reversed", "duplicate"]).optional(),
    }).strict(),
    "intake.create": z.object({
        amount: money,
        receivedAt: dateTime,
        payerName: optionalNullableText,
        bankReference: optionalNullableText,
        qrPayload: optionalNullableText,
        notes: optionalNullableText,
        attachmentRequirement: z.object({ expectedCount: z.number().int().min(1).max(20) }).strict().optional(),
        idempotencyKey: z.string().trim().min(1).max(200),
    }).strict(),
    "evidence.prepare": z.object({
        paymentIntakePublicId: uuid,
        mimeType: z.enum(["image/jpeg", "image/png", "application/pdf"]),
        size: z.number().int().positive(),
        sha256: z.string().regex(/^[0-9a-f]{64}$/i),
        evidenceType: z.enum(["slip", "qr"]).optional(),
    }).strict(),
    "evidence.finalize": z.object({ paymentIntakePublicId: uuid, evidencePublicId: uuid }).strict(),
    "evidence.import-chatgpt-file": z.object({
        paymentIntakePublicId: uuid,
        idempotencyKey: z.string().trim().min(1).max(200),
        chatgptFile: z.object({
            download_url: z.string().url(), file_id: z.string().min(1),
            mime_type: z.enum(["image/jpeg", "image/png", "application/pdf"]).optional(),
            file_name: z.string().max(500).optional(),
        }).strict(),
    }).strict(),
    "loan.disbursement.evidence.import-chatgpt-file": z.object({
        disbursementPublicId: uuid,
        idempotencyKey: z.string().trim().min(1).max(200),
        chatgptFile: z.object({
            download_url: z.url(),
            file_id: z.string().trim().min(1).max(500),
            mime_type: z.enum(["image/jpeg", "image/png", "application/pdf"]).optional(),
            file_name: z.string().trim().max(500).optional(),
        }).strict(),
    }).strict(),
    "payment.evidence-supplement.import-chatgpt-file": z.object({
        paymentIntakePublicId: uuid,
        idempotencyKey: z.string().trim().min(1).max(200),
        chatgptFile: z.object({
            download_url: z.string().url(), file_id: z.string().min(1),
            mime_type: z.enum(["image/jpeg", "image/png", "application/pdf"]).optional(),
            file_name: z.string().max(500).optional(),
        }).strict(),
    }).strict(),
    "payment.evidence-supplement.record": z.object({
        paymentIntakePublicId: uuid, supplementPublicId: uuid, confirmed: z.literal(true),
        reason: z.enum(["upload_channel_unavailable", "operator_omission", "evidence_recovered", "other"]),
        note: optionalNullableText, idempotencyKey: z.string().trim().min(1).max(200),
    }).strict().superRefine((value, ctx) => {
        if (value.reason === "other" && !value.note?.trim()) ctx.addIssue({ code: "custom", message: "reason other requires note" });
    }),
    "payment.preview": z.object({
        paymentIntakePublicId: uuid,
        allocations: z.array(explicitAllocation).max(1_000).optional(),
    }).strict(),
    "payment.cancel": z.object({ paymentIntakePublicId: uuid, reason: cancellationReason, idempotencyKey: z.string().trim().min(1).max(200), expectedStateHash: z.string().regex(/^[0-9a-f]{64}$/i) }).strict(),
    "payment.restore.cancel": z.object({ restoreDraftPublicId: uuid, expectedStateHash: z.string().regex(/^[0-9a-f]{64}$/i), reason: cancellationReason, idempotencyKey: z.string().trim().min(1).max(200) }).strict(),
    "payment.replacement.inspect": z.object({ paymentIntakePublicId: uuid }).strict(),
    "payment.replacement.create": z.object({ paymentIntakePublicId: uuid, reason: shortText, idempotencyKey: z.string().trim().min(1).max(200), expectedStateHash: z.string().regex(/^[0-9a-f]{64}$/i) }).strict(),
    "payment.replacement.duplicate-review.preview": z.object({ canonicalPaymentIntakePublicId: uuid, candidatePaymentIntakePublicIds: z.array(uuid).min(1).max(50), canonicalEvidenceCandidatePublicIds: z.array(uuid).max(50).optional(), reason: shortText, idempotencyKey: z.string().trim().min(1).max(200) }).strict(),
    "payment.replacement.duplicate-review.execute": z.object({ duplicateReviewPublicId: uuid, previewHash: z.string().regex(/^[0-9a-f]{64}$/i), confirmed: z.literal(true), reason: shortText, idempotencyKey: z.string().trim().min(1).max(200) }).strict(),
    "payment.post": z.object({ paymentIntakePublicId: uuid, proposalPublicId: uuid }).strict(),
    "payment.reverse": z.object({
        paymentIntakePublicId: uuid,
        reason: shortText.optional(),
    }).strict(),
    "payment.reverse-with-accrual.preview": z.object({ paymentIntakePublicId: uuid }).strict(),
    "payment.reverse-with-accrual.execute": z.object({
        paymentIntakePublicId: uuid,
        reason: shortText,
        interestAccrualMode: z.literal("ensure_due_through_payment_date"),
        previewHash: z.string().regex(/^v1:[0-9a-f]{64}$/i),
        confirmed: z.literal(true),
        idempotencyKey: z.string().trim().min(1).max(200),
    }).strict(),
    "payment.batch.create": z.object({ borrowerPublicId: uuid.nullable().optional(), notes: optionalNullableText, idempotencyKey: z.string().trim().min(1).max(200) }).strict(),
    "payment.batch.capture": z.object({ borrowerPublicId: uuid.nullable().optional(), notes: optionalNullableText, idempotencyKey: z.string().trim().min(1).max(200), items: z.array(z.object({ clientItemKey: z.string().trim().min(1).max(100), amount: money, receivedAt: dateTime, payerName: optionalNullableText, bankReference: optionalNullableText, intakeIdempotencyKey: z.string().trim().min(1).max(200) }).strict()).min(1).max(50) }).strict(),
    "payment.batch.evidence.prepare-many": z.object({ batchPublicId: uuid, items: z.array(z.object({ batchItemPublicId: uuid, paymentIntakePublicId: uuid, mimeType: z.enum(["image/jpeg", "image/png", "application/pdf"]), size: z.number().int().positive(), sha256: z.string().regex(/^[0-9a-f]{64}$/i), evidenceType: z.enum(["slip", "qr"]).optional() }).strict()).min(1).max(50) }).strict(),
    "payment.batch.evidence.finalize-many": z.object({ batchPublicId: uuid, items: z.array(z.object({ batchItemPublicId: uuid, paymentIntakePublicId: uuid, evidencePublicId: uuid }).strict()).min(1).max(50) }).strict(),
    "payment.batch.item.add": z.object({ batchPublicId: uuid, paymentIntakePublicId: uuid, itemOrder: z.number().int().positive() }).strict(),
    "payment.batch.evidence.prepare": z.object({ batchItemPublicId: uuid, paymentIntakePublicId: uuid, mimeType: z.enum(["image/jpeg", "image/png", "application/pdf"]), size: z.number().int().positive(), sha256: z.string().regex(/^[0-9a-f]{64}$/i), evidenceType: z.enum(["slip", "qr"]).optional() }).strict(),
    "payment.batch.evidence.finalize": z.object({ batchItemPublicId: uuid, paymentIntakePublicId: uuid, evidencePublicId: uuid }).strict(),
    "payment.batch.get": z.object({ batchPublicId: uuid }).strict(),
    "payment.batch.stage": z.object({ idempotencyKey: z.string().trim().min(1).max(200), borrowerPublicId: uuid.nullable().optional(), notes: optionalNullableText, items: z.array(z.object({ clientItemKey: z.string().trim().min(1).max(100), payerName: optionalNullableText, bankReference: optionalNullableText }).strict()).min(1).max(50) }).strict(),
    "payment.batch.staging.evidence.prepare": z.object({ stagingItemPublicId: uuid, mimeType: z.enum(["image/jpeg", "image/png", "application/pdf"]), size: z.number().int().positive(), sha256: z.string().regex(/^[0-9a-f]{64}$/i), originalName: optionalNullableText }).strict(),
    "payment.batch.staging.evidence.finalize": z.object({ stagingItemPublicId: uuid, evidencePublicId: uuid }).strict(),
    "payment.batch.staging.extract": z.object({ stagingItemPublicId: uuid, idempotencyKey: z.string().trim().min(1).max(200) }).strict(),
    "payment.batch.workspace": z.object({ batchPublicId: uuid }).strict(),
    "payment.batch.candidates": z.object({ stagingItemPublicId: uuid, borrowerQuery: shortText.optional(), amount: money.optional(), receivedAt: isoDateTime.optional() }).strict(),
    "payment.batch.staging.review": z.object({ stagingItemPublicId: uuid, amount: money, receivedAt: isoDateTime, intakeIdempotencyKey: z.string().trim().min(1).max(200), reviewedReason: optionalNullableText, reviewedRangeFrom: date.optional(), reviewedRangeTo: date.optional() }).strict(),
    "payment.batch.staging.edit": z.object({ stagingItemPublicId: uuid, expectedRevision: z.number().int().min(1), idempotencyKey: z.string().trim().min(1).max(200), reason: shortText, amount: money.optional(), receivedAt: isoDateTime.optional(), mapping: z.object({ borrowerPublicId: uuid.optional(), loanPublicId: uuid.optional(), schedulePublicId: uuid.optional() }).strict().nullable().optional() }).strict(),
    "payment.batch.split": z.object({ batchPublicId: uuid, selectedItemPublicIds: z.array(uuid).min(1).max(50), expectedSourceRevision: z.number().int().min(1), idempotencyKey: z.string().trim().min(1).max(200), reason: shortText }).strict(),
    "payment.batch.decision": z.object({ batchPublicId: uuid, previewPublicId: uuid, previewHash: z.string(), revision: z.number().int().min(0), action: z.literal("confirm_no_older_pending"), reason: shortText, fromDate: date, toDate: date, idempotencyKey: z.string().trim().min(1).max(200) }).strict(),
    "payment.batch.cancel": z.object({ batchPublicId: uuid, reason: shortText, revision: z.number().int().min(0), idempotencyKey: z.string().trim().min(1).max(200) }).strict(),
    "payment.batch.preview": z.object({ batchPublicId: uuid, borrowerPublicId: uuid, decisionPublicId: uuid.optional(), allocations: z.array(z.object({ itemPublicId: uuid, borrowerPublicId: uuid.optional(), loanPublicId: uuid, schedulePublicId: uuid.nullable().optional(), amount: money, targetDueDate: date, intent: z.enum(["on_time", "advance", "backdated"]) }).strict()).max(200).optional() }).strict(),
    "payment.batch.execute": z.object({ batchPublicId: uuid, previewPublicId: uuid, previewHash: z.string(), confirmationHash: z.string(), confirmed: z.literal(true), idempotencyKey: z.string().trim().min(1).max(200) }).strict(),
    "payment.reconcile.preview": z.object({
        paymentIntakePublicId: uuid,
        allocations: z.array(reconciliationAllocation).min(1).max(1_000),
        reason: shortText,
    }).strict(),
    "payment.reconcile.reflow.preview": z.object({ reconciliationPublicId: uuid, reason: shortText }).strict(),
    "payment.reconcile.reflow.execute": z.object({ reflowPreviewPublicId: uuid, previewHash: z.string().regex(/^v1:[0-9a-f]{64}$/i), expectedBalanceVersion: z.string().regex(/^v1:[0-9a-f]{64}$/i), confirmed: z.literal(true), reason: shortText, idempotencyKey: z.string().trim().min(1).max(200) }).strict(),
    "payment.allocation-correction.preview": z.object({ paymentIntakePublicId: uuid, transactionPublicId: uuid, targetSchedulePublicId: uuid, reason: shortText }).strict(),
    "payment.allocation-correction.execute": z.object({ correctionPreviewPublicId: uuid, previewHash: z.string().regex(/^v1:[0-9a-f]{64}$/i), expectedBalanceVersion: z.string().regex(/^v1:[0-9a-f]{64}$/i), confirmed: z.literal(true), reason: shortText, idempotencyKey: z.string().trim().min(1).max(200) }).strict(),
    "payment.reconcile.preflight": z.object({
        paymentIntakePublicId: uuid, allocations: z.array(reconciliationAllocation).min(1).max(1_000).optional(), proposalPublicId: uuid.optional(), reason: shortText,
    }).strict(),
    "payment.reconcile.mark-review": z.object({
        paymentIntakePublicId: uuid,
        expectedStatus: z.literal("ready"),
        reason: shortText,
        idempotencyKey: z.string().trim().min(1).max(200),
    }).strict(),
    "payment.restore.create": z.object({ paymentIntakePublicId: uuid, reason: shortText, idempotencyKey: z.string().trim().min(1).max(200) }).strict(),
    "payment.restore.evidence.prepare": z.object({
        restoreDraftPublicId: uuid,
        mimeType: z.enum(["image/jpeg", "image/png", "application/pdf"]),
        sha256: z.string().regex(/^[0-9a-f]{64}$/i),
        size: z.number().int().positive(),
        originalName: z.string().trim().max(500).nullable().optional(),
    }).strict(),
    "payment.restore.evidence.finalize": z.object({ restoreDraftPublicId: uuid, evidencePublicId: uuid }).strict(),
    "payment.restore.preview": z.object({ paymentIntakePublicId: uuid, reason: shortText }).strict(),
    "payment.restore.execute": z.object({
        restorePreviewPublicId: uuid,
        previewHash: z.string().regex(/^v1:[0-9a-f]{64}$/i),
        expectedBalanceVersion: z.string().regex(/^v1:[0-9a-f]{64}$/i),
        confirmed: z.literal(true),
        reason: shortText,
        idempotencyKey: z.string().trim().min(1).max(200),
    }).strict(),
    "payment.restore.schedule-backfill": z.object({ paymentIntakePublicId: uuid, reason: shortText, idempotencyKey: z.string().trim().min(1).max(200) }).strict(),
    "payment.reconcile.execute": z.object({
        reconciliationPreviewPublicId: uuid,
        previewHash: z.string().regex(/^v1:[0-9a-f]{64}$/i),
        expectedBalanceVersion: z.string().regex(/^v1:[0-9a-f]{64}$/i),
        confirmed: z.literal(true),
        reason: shortText,
        idempotencyKey: z.string().trim().min(1).max(200),
    }).strict(),
    "loan.preview": z.object(loanTerms).strict(),
    "loan.draft": z.object({
        borrowerPublicId: uuid,
        bankLoanPublicId: uuid.nullable().optional(),
        bankProfilePublicId: uuid.nullable().optional(),
        ...loanTerms,
    }).strict(),
    "loan.draft.delete": z.object({
        loanPublicId: uuid,
        confirmed: z.literal(true),
        reason: shortText,
        idempotencyKey: z.string().trim().min(1).max(200),
    }).strict(),
    "loan.activate": z.object({
        loanPublicId: uuid,
        idempotencyKey: z.string().trim().min(1).max(200).optional(),
    }).strict(),
    "loan.interest-rate.list": z.object({ loanPublicId: uuid }).strict(),
    "loan.interest-rate.preview": z.object({
        loanPublicId: uuid,
        effectiveDate: date,
        expiryDate: date.nullable(),
        rateType: z.enum(["percent", "per_thousand"]),
        rate: interestRateValue,
    }).strict(),
    "loan.interest-rate.execute": z.object({
        loanPublicId: uuid,
        previewPublicId: uuid,
        previewHash: z.string().regex(/^v1:[0-9a-f]{64}$/i),
        confirmed: z.literal(true),
        reason: shortText,
        idempotencyKey: z.string().trim().min(1).max(200),
    }).strict(),
    "loan.settlement.preview": z.object({
        loanPublicId: uuid,
        asOfDate: date,
    }).strict(),
    "loan.settlement.execute": z.object({
        settlementPublicId: uuid,
        previewHash: z.string().regex(/^v1:[0-9a-f]{64}$/i),
        confirmed: z.literal(true),
        reason: shortText,
        idempotencyKey: z.string().trim().min(1).max(200),
    }).strict(),
    "loan.settlement.reverse": z.object({
        settlementPublicId: uuid,
        reason: shortText,
        idempotencyKey: z.string().trim().min(1).max(200),
    }).strict(),
    "loan.cancel.preview": z.object({ loanPublicId: uuid, reason: shortText }).strict(),
    "loan.cancel.execute": z.object({
        previewPublicId: uuid,
        previewHash: versionHash,
        expectedBalanceVersion: versionHash,
        confirmed: z.literal(true),
        reason: shortText,
        idempotencyKey: z.string().trim().min(1).max(200),
    }).strict(),
    "loan.replacement.preview": z.object({
        oldLoanPublicId: uuid,
        replacementDraftPublicId: uuid,
        reason: shortText,
    }).strict(),
    "loan.replacement.execute": z.object({
        replacementPublicId: uuid,
        previewHash: versionHash,
        expectedOldBalanceVersion: versionHash,
        expectedReplacementDraftVersion: versionHash,
        confirmed: z.literal(true),
        reason: shortText,
        idempotencyKey: z.string().trim().min(1).max(200),
    }).strict(),
    "loan.replacement.reverse": z.object({
        replacementPublicId: uuid,
        confirmed: z.literal(true),
        reason: shortText,
        idempotencyKey: z.string().trim().min(1).max(200),
    }).strict(),
    "loan.disbursement.list": z.object({ loanPublicId: uuid }).strict(),
    "loan.contract.get": z.object({ loanPublicId: uuid }).strict(),
    "loan.inspect-context": z.object({
        loanPublicId: uuid,
        view: z.enum(["summary", "schedule", "history"]).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        cursors: compositeCursorsInput.optional(),
    }).strict(),
    "loan.payment-start-date.update": z.object({
        loanPublicId: uuid,
        paymentStartDate: date,
        reason: shortText,
        idempotencyKey: z.string().trim().min(1).max(200),
    }).strict(),
    "loan.payment-history.list": z.object({ loanPublicId: uuid }).strict(),
    "loan.disbursement.draft": z.object({
        loanPublicId: uuid,
        grossAmount: money,
        loanAttributedAmount: money,
        channel: z.enum(["bank_transfer", "cash", "adjustment"]),
        sourceBankProfilePublicId: uuid.nullable().optional(),
        payeeHint: optionalNullableText,
        note: optionalNullableText,
        disbursedAt: dateTime,
        attachmentRequirement: z.object({ expectedCount: z.number().int().min(1).max(20) }).strict().optional(),
        evidenceFilePublicIds: z.array(uuid).max(100).optional(),
    }).strict(),
    "loan.disbursement.update": z.object({
        disbursementPublicId: uuid,
        changes: z.object({
            grossAmount: money.optional(),
            loanAttributedAmount: money.optional(),
            channel: z.enum(["bank_transfer", "cash", "adjustment"]).optional(),
            sourceBankProfilePublicId: uuid.nullable().optional(),
            payeeHint: optionalNullableText,
            note: optionalNullableText,
            disbursedAt: dateTime.optional(),
        }).strict().refine((changes) => Object.keys(changes).length > 0, { message: "changes must contain at least one editable field" }),
    }).strict(),
    "loan.disbursement.evidence.prepare": z.object({
        disbursementPublicId: uuid,
        mimeType: z.enum(["image/jpeg", "image/png", "application/pdf"]),
        size: z.number().int().positive(),
        sha256: z.string().regex(/^[0-9a-f]{64}$/i),
        originalName: z.string().trim().max(500).nullable().optional(),
    }).strict(),
    "loan.disbursement.evidence.finalize": z.object({ disbursementPublicId: uuid, evidencePublicId: uuid }).strict(),
    "loan.disbursement.post": z.object({ disbursementPublicId: uuid, idempotencyKey: z.string().trim().min(1).max(200) }).strict(),
    "loan.disbursement.reverse": z.object({ disbursementPublicId: uuid, reason: shortText, idempotencyKey: z.string().trim().min(1).max(200) }).strict(),
    "loan.commission-participant.list": z.object({ loanPublicId: uuid }).strict(),
    "loan.commission-participant.add": z.object({
        loanPublicId: uuid, intermediaryPublicId: uuid, commissionRate, role: shortText,
        effectiveFrom: isoDateTime, note: optionalNullableText, confirmed: z.literal(true),
        idempotencyKey: z.string().trim().min(1).max(200),
    }).strict(),
    "loan.commission-participant.update": z.object({
        participantPublicId: uuid, commissionRate, role: shortText, effectiveFrom: isoDateTime,
        note: optionalNullableText, confirmed: z.literal(true), idempotencyKey: z.string().trim().min(1).max(200),
    }).strict(),
    "loan.commission-participant.end": z.object({
        participantPublicId: uuid, effectiveTo: isoDateTime, reason: shortText,
        confirmed: z.literal(true), idempotencyKey: z.string().trim().min(1).max(200),
    }).strict(),
    "loan.commission.preview": z.object({ loanPublicId: uuid, paymentPublicIds: z.array(uuid).min(1).max(1_000) }).strict(),
    "loan.commission.list": z.object({ loanPublicId: uuid, paymentPublicIds: z.array(uuid).min(1).max(1_000) }).strict(),
    "loan.commission.calculate": z.object({ loanPublicId: uuid, paymentPublicIds: z.array(uuid).min(1).max(1_000) }).strict(),
    "loan.commission.reverse": z.object({ loanPublicId: uuid, paymentPublicIds: z.array(uuid).min(1).max(1_000) }).strict(),
    "payment.intermediary-attribution.create": z.object({
        paymentPublicId: uuid, transactionPublicId: uuid.optional(), sourceKind: z.enum(["direct", "intermediary"]),
        intermediaryPublicId: uuid.optional(), amount: money, confirmed: z.literal(true),
        idempotencyKey: z.string().trim().min(1).max(200),
    }).strict().superRefine((value, ctx) => {
        if (value.sourceKind === "direct" && value.intermediaryPublicId) ctx.addIssue({ code: "custom", message: "direct attribution cannot include intermediaryPublicId" });
        if (value.sourceKind === "intermediary" && !value.intermediaryPublicId) ctx.addIssue({ code: "custom", message: "intermediary attribution requires intermediaryPublicId" });
    }),
    "payment.intermediary-attribution.list": z.object({ paymentPublicId: uuid }).strict(),
    "payment.intermediary-attribution.reverse": z.object({
        attributionPublicId: uuid, reason: shortText, confirmed: z.literal(true),
        idempotencyKey: z.string().trim().min(1).max(200),
    }).strict(),
    "intermediary.search": z.object({ query: shortText }).strict(),
    "intermediary.create": z.object({ name: shortText, aliases: z.array(shortText).optional(), notes: optionalNullableText }).strict(),
    "intermediary.profile.get": z.object({ intermediaryPublicId: uuid }).strict(),
    "intermediary.bank-account.save": z.object({
        intermediaryPublicId: uuid,
        bankCode: z.string().trim().regex(/^[A-Z][A-Z0-9]{1,19}$/),
        bankName: z.string().trim().min(1).max(200),
        accountName: z.string().trim().min(1).max(200),
        accountNumber: z.string().trim().min(5).max(64),
        note: z.string().trim().max(1_000).nullable().optional(),
        idempotencyKey: z.string().trim().min(1).max(200),
    }).strict(),
    "intermediary.managed-loan.list": z.object({
        intermediaryPublicId: uuid,
        role: z.enum(["disbursement", "collection", "all"]).optional(),
    }).strict(),
    "intermediary.assignment.create": z.object({
        loanPublicId: uuid,
        intermediaryPublicId: uuid,
        role: z.enum(["disbursement", "collection", "both"]),
        effectiveFrom: dateTime,
        note: z.string().trim().max(1_000).nullable().optional(),
        idempotencyKey: z.string().trim().min(1).max(200),
    }).strict(),
    "intermediary.assignment.end": z.object({
        assignmentPublicId: uuid,
        effectiveTo: dateTime,
        reason: z.string().trim().max(1_000).nullable().optional(),
        idempotencyKey: z.string().trim().min(1).max(200),
    }).strict(),
    "intermediary.disbursement.list": z.object({
        loanPublicId: uuid.optional(),
        intermediaryPublicId: uuid.optional(),
        status: z.enum(["draft", "needs_review", "ready", "posted", "reversed"]).optional(),
    }).strict(),
    "intermediary.disbursement.get": z.object({ groupPublicId: uuid }).strict(),
    "intermediary.disbursement.create": z.object({
        loanPublicId: uuid,
        intermediaryPublicId: uuid,
        retainedBalance: money,
        note: optionalNullableText,
        idempotencyKey: z.string().trim().min(1).max(200),
    }).strict(),
    "intermediary.disbursement.event.create": z.object({
        groupPublicId: uuid,
        role: z.enum(["funding_to_intermediary", "borrower_net_payout", "advance_interest_return"]),
        channel: z.enum(["bank_transfer", "cash", "adjustment"]),
        amount: money,
        transferredAt: dateTime,
        intermediaryBankAccountPublicId: uuid.nullable().optional(),
        senderHint: optionalNullableText,
        payeeHint: optionalNullableText,
        bankReference: optionalNullableText,
        note: optionalNullableText,
        idempotencyKey: z.string().trim().min(1).max(200),
    }).strict(),
    "intermediary.disbursement.evidence.prepare": z.object({
        groupPublicId: uuid,
        eventPublicId: uuid,
        mimeType: z.enum(["image/jpeg", "image/png", "application/pdf"]),
        size: z.number().int().positive(),
        sha256: z.string().regex(/^[0-9a-f]{64}$/i),
        originalName: z.string().trim().max(500).nullable().optional(),
    }).strict(),
    "intermediary.disbursement.evidence.finalize": z.object({
        groupPublicId: uuid,
        eventPublicId: uuid,
        evidencePublicId: uuid,
    }).strict(),
    "intermediary.disbursement.preview": z.object({ groupPublicId: uuid }).strict(),
    "intermediary.disbursement.post": z.object({
        groupPublicId: uuid,
        proposalPublicId: uuid,
        confirmed: z.literal(true),
        idempotencyKey: z.string().trim().min(1).max(200),
    }).strict(),
    "intermediary.disbursement.reverse": z.object({
        groupPublicId: uuid,
        reason: shortText,
        confirmed: z.literal(true),
        idempotencyKey: z.string().trim().min(1).max(200),
    }).strict(),
    "intermediary.collection.list": z.object({ intermediaryPublicId: uuid.optional(), status: z.string().optional() }).strict(),
    "intermediary.collection.create": z.object({ intermediaryPublicId: uuid, borrowerPublicId: uuid, loanPublicId: uuid, amount: money, borrowerPaidAt: dateTime, bankReference: optionalNullableText, note: optionalNullableText, paymentIntakePublicId: uuid.nullable().optional(), idempotencyKey: z.string().trim().min(1).max(200) }).strict(),
    "intermediary.collection.cancel": z.object({ collectionPublicId: uuid, expectedStateHash: z.string().regex(/^[0-9a-f]{64}$/iu), reason: z.string().trim().min(1).max(2000), idempotencyKey: z.string().trim().min(1).max(200) }).strict(),
    "intermediary.remittance.get": z.object({ remittancePublicId: uuid }).strict(),
    "intermediary.remittance.create": z.object({ intermediaryPublicId: uuid, grossAmount: money, receivedAt: dateTime, bankReference: optionalNullableText, destinationHint: optionalNullableText, note: optionalNullableText, idempotencyKey: z.string().trim().min(1).max(200) }).strict(),
    "intermediary.remittance.allocations.save": z.object({ remittancePublicId: uuid, collectionPublicIds: z.array(uuid).min(1) }).strict(),
    "intermediary.remittance.preview": z.object({ remittancePublicId: uuid }).strict(),
    "intermediary.remittance.evidence.prepare": z.object({ remittancePublicId: uuid, mimeType: z.enum(["image/jpeg", "image/png", "application/pdf"]), size: z.number().int().positive(), sha256: z.string().regex(/^[0-9a-f]{64}$/i), originalName: z.string().trim().max(500).nullable().optional() }).strict(),
    "intermediary.remittance.evidence.finalize": z.object({ remittancePublicId: uuid, evidencePublicId: uuid }).strict(),
    "intermediary.remittance.post": z.object({ remittancePublicId: uuid, proposalPublicId: uuid, confirmed: z.literal(true), idempotencyKey: z.string().trim().min(1).max(200) }).strict(),
    "renewal.preview": z.object({
        oldLoanPublicId: uuid,
        requestedPrincipal: money,
        renewalDate: date.optional(),
        paymentStartDate: date.optional(),
        settlementPolicy: renewalSettlementPolicy.optional(),
        adjustments: z.array(z.object({
            kind: z.enum(["fee", "penalty", "other_charge", "waiver"]),
            amount: money,
            reason: z.string().trim().min(1).max(500),
        }).strict()).max(50).optional(),
        waivedCharges: money.optional(),
        waiverReason: optionalNullableText,
    }).strict(),
    "renewal.execute": z.object({
        renewalPublicId: uuid,
        previewHash: z.string().regex(/^v\d+:[0-9a-f]{64}$/i),
        confirmed: z.literal(true),
        reason: shortText,
        confirmedCashDirection: z.literal("collection").optional(),
        idempotencyKey: z.string().trim().min(1).max(200),
    }).strict(),
    "renewal.reverse": z.object({
        renewalPublicId: uuid,
        reason: shortText,
        idempotencyKey: z.string().trim().min(1).max(200),
    }).strict(),
    "loan.restructure.preview": z.object({
        oldLoanPublicId: uuid,
        settlementDate: date,
        replacementTerms: publicReplacementTermsInput,
        waivers: z.object({
            interest: z.object({ amount: money, reason: shortText }).strict().optional(),
            fees: z.object({ amount: money, reason: shortText }).strict().optional(),
            penalty: z.object({ amount: money, reason: shortText }).strict().optional(),
        }).strict().optional(),
        externalSettlementCredit: z.object({ amount: money, payer: shortText, source: shortText }).strict().optional(),
        additionalPrincipal: money,
        reason: shortText,
    }).strict(),
    "loan.restructure.execute": z.object({
        restructurePublicId: uuid,
        previewHash: versionHash,
        expectedBalanceVersion: versionHash,
        confirmed: z.literal(true),
        reason: shortText,
        idempotencyKey: z.string().trim().min(1).max(200),
    }).strict(),
    "loan.restructure.reverse": z.object({
        restructurePublicId: uuid,
        reason: shortText,
        idempotencyKey: z.string().trim().min(1).max(200),
    }).strict(),
    "loan.waiver.preview": z.object({
        loanPublicId: uuid,
        component: z.enum(["interest", "fee", "penalty"]),
        amount: money,
        reason: shortText,
    }).strict(),
    "loan.waiver.execute": z.object({
        previewPublicId: uuid,
        previewHash: versionHash,
        expectedBalanceVersion: versionHash,
        confirmed: z.literal(true),
        reason: shortText,
        idempotencyKey: z.string().trim().min(1).max(200),
    }).strict(),
    "loan.waiver.reverse": z.object({
        waiverPublicId: uuid,
        reason: shortText,
        idempotencyKey: z.string().trim().min(1).max(200),
    }).strict(),
    "funding-source.list": z.object({ status: z.enum(["active", "closed", "all"]).optional() }).strict(),
    "funding-allocation.preview": z.object({
        allocatedAmount: money, allocationDate: date, loanPublicId: uuid,
        bankProfilePublicId: uuid.optional(), bankLoanPublicId: uuid.optional(),
        allocationType: z.enum(["initial", "manual_adjustment", "reallocation_in", "reallocation_out"]).optional(),
        note: optionalNullableText,
    }).strict().superRefine((value, ctx) => {
        if (!value.bankProfilePublicId && !value.bankLoanPublicId) ctx.addIssue({ code: "custom", message: "Either bankProfilePublicId or bankLoanPublicId is required" });
        if (value.bankProfilePublicId && value.bankLoanPublicId) ctx.addIssue({ code: "custom", message: "Only one funding source may be selected" });
    }),
    "funding-allocation.create": z.object({
        allocatedAmount: money, allocationDate: date, loanPublicId: uuid,
        bankProfilePublicId: uuid.optional(), bankLoanPublicId: uuid.optional(),
        allocationType: z.enum(["initial", "manual_adjustment", "reallocation_in", "reallocation_out"]).optional(),
        note: optionalNullableText,
    }).strict().superRefine((value, ctx) => {
        if (!value.bankProfilePublicId && !value.bankLoanPublicId) ctx.addIssue({ code: "custom", message: "Either bankProfilePublicId or bankLoanPublicId is required" });
        if (value.bankProfilePublicId && value.bankLoanPublicId) ctx.addIssue({ code: "custom", message: "Only one funding source may be selected" });
    }),
    "funding-allocation.list": z.object({ loanPublicId: uuid }).strict(),
    "system.error-diagnostic.get": z.object({ correlationId: uuid }).strict(),
    "system.error-diagnostic.list": z.object({
        correlationId: uuid.optional(), requestId: uuid.optional(), toolName: z.string().trim().min(1).max(120).optional(),
        errorCode: z.string().trim().min(1).max(160).optional(),
        category: z.enum(mcpDiagnosticCategories).optional(),
        from: z.iso.datetime({ offset: true }).optional(), to: z.iso.datetime({ offset: true }).optional(),
        cursor: z.string().trim().min(1).max(300).optional(), limit: z.number().int().min(1).max(100).optional(),
    }).strict(),
    "workflow.resolve": workflowResolverInput,
};

const safeErrorSchema = z.object({
    code: z.string(),
    message: z.string(),
    suggestedAction: z.string(),
    retryable: z.boolean(),
    reviewRequired: z.boolean(),
    repreviewRequired: z.boolean().optional(),
    humanReviewRequired: z.boolean().optional(),
    details: z.object({
        paymentIntakePublicId: uuid, transactionPublicId: uuid, sourceRemaining: z.string(), availableFunding: z.string(), requestedPrincipal: z.string(),
        downstreamEntryCount: z.number(), accrualPublicId: uuid, accrualDate: z.string(), periodStartDate: z.string(), periodEndDate: z.string(), availableAmount: z.string(),
        currentVersion: z.number(), oldBalanceVersion: z.number(), status: z.string(), eventPublicId: uuid, transferredAt: z.string(), interestRatePreviewPublicId: uuid,
        earliestEditableDate: z.string(), field: z.string(), blockers: z.object({ rateChanges: z.number(), laterRenewals: z.number(), downstreamEntries: z.number() }).partial().strict(),
        blockerPublicIds: z.array(uuid).max(100), reviewRequired: z.boolean(), correctedAmount: z.string(), collected: z.boolean(), carriedForward: z.boolean(),
        treatedAsBorrowerPayment: z.boolean(), loanPublicId: uuid, throughDate: z.string(), requestedAmount: z.string(), allocationType: z.string(),
    }).partial().strict(),
    correlationId: uuid,
}).strict();

function advertisedOutputSchema(toolName: McpToolName) {
    return successOutputSchema(toolName);
}

export function transportOutputSchema(toolName: McpToolName) {
    return z.union([successOutputSchema(toolName), errorOutputSchema]);
}

function transportOutputJsonSchema(toolName: McpToolName) {
    const success = generatedJsonSchema(successOutputSchema(toolName));
    const error = generatedJsonSchema(errorOutputSchema);
    delete success.$schema;
    delete error.$schema;
    return {
        type: "object",
        properties: {
            ...((success.properties ?? {}) as Record<string, unknown>),
            ...((error.properties ?? {}) as Record<string, unknown>),
        },
        additionalProperties: false,
        anyOf: [success, error],
    };
}

function successOutputSchema(toolName: McpToolName) {
    // Allocation correction is financially mutating and must go through the
    // audit lookup/recovery gate, but its frozen legacy receipt already owns
    // auditPublicId/correlationId inside data. Keep that closed wire shape for
    // legacy clients while the policy remains financial for dispatch.
    if (financialEnvelopeTools.has(toolName)) {
        return z.object({
            schemaVersion: z.literal("1.0"),
            data: toolDataSchemas[toolName],
            correlationId: uuid,
            auditPublicIds: z.array(uuid).min(1),
        }).strict();
    }
    return z.object({
        schemaVersion: z.literal("1.0"),
        data: toolDataSchemas[toolName],
    }).strict();
}

const errorOutputSchema = z.object({
    schemaVersion: z.literal("1.0"),
    error: safeErrorSchema,
}).strict();

const readOnlyTools = new Set<McpToolName>([
    "system.error-diagnostic.get",
    "system.error-diagnostic.list",
    "borrower.search",
    "borrower.portfolio",
    "borrower.resolve-and-portfolio",
    "intake.get",
    "intake.list",
    "payment.replacement.inspect",
    "payment.batch.get",
    "payment.batch.workspace",
    "payment.batch.candidates",
    "loan.preview",
    "loan.cancel.preview",
    "loan.interest-rate.list",
    "loan.disbursement.list",
    "loan.contract.get",
    "loan.inspect-context",
    "loan.payment-history.list",
    "payment.match-context",
    "loan.commission-participant.list",
    "loan.commission.preview",
    "loan.commission.list",
    "loan.commission.calculate",
    "loan.commission.reverse",
    "payment.intermediary-attribution.list",
    "intermediary.search",
    "intermediary.profile.get",
    "intermediary.managed-loan.list",
    "intermediary.disbursement.list",
    "intermediary.disbursement.get",
    "intermediary.collection.list",
    "intermediary.remittance.get",
    "funding-source.list",
    "funding-allocation.preview",
    "funding-allocation.list",
    "payment.reverse-with-accrual.preview",
    "payment.reconcile.preflight",
    "workflow.resolve",
]);
const destructiveTools = new Set<McpToolName>([
    "borrower.update",
    "borrower.alias",
    "evidence.prepare",
    "evidence.finalize",
    "evidence.import-chatgpt-file",
    "loan.disbursement.evidence.import-chatgpt-file",
    "payment.evidence-supplement.import-chatgpt-file",
    "payment.evidence-supplement.record",
    "payment.preview",
    "payment.post",
    "payment.cancel",
    "payment.restore.cancel",
    "payment.replacement.create",
    "payment.replacement.duplicate-review.preview",
    "payment.replacement.duplicate-review.execute",
    "payment.reverse",
    "payment.batch.create",
    "payment.batch.capture",
    "payment.batch.evidence.prepare-many",
    "payment.batch.evidence.finalize-many",
    "payment.batch.item.add",
    "payment.batch.evidence.prepare",
    "payment.batch.evidence.finalize",
    "payment.batch.preview",
    "payment.reconcile.preview",
    "payment.reconcile.reflow.execute",
    "payment.allocation-correction.execute",
    "payment.reconcile.mark-review",
    "payment.reconcile.execute",
    "payment.restore.create",
    "payment.restore.evidence.prepare",
    "payment.restore.evidence.finalize",
    "payment.restore.preview",
    "payment.restore.execute",
    "payment.reverse-with-accrual.execute",
    "payment.restore.schedule-backfill",
    "payment.batch.execute",
    "payment.batch.stage",
    "payment.batch.staging.evidence.prepare",
    "payment.batch.staging.evidence.finalize",
    "payment.batch.staging.extract",
    "payment.batch.staging.review",
    "payment.batch.staging.edit",
    "payment.batch.split",
    "payment.batch.decision",
    "payment.batch.cancel",
    "loan.draft.delete",
    "loan.activate",
    "loan.payment-start-date.update",
    "loan.interest-rate.execute",
    "loan.settlement.execute",
    "loan.settlement.reverse",
    "loan.cancel.execute",
    "loan.replacement.execute",
    "loan.replacement.reverse",
    "loan.disbursement.update",
    "loan.disbursement.post",
    "loan.disbursement.reverse",
    "loan.commission-participant.add",
    "loan.commission-participant.update",
    "loan.commission-participant.end",
    "payment.intermediary-attribution.create",
    "payment.intermediary-attribution.reverse",
    "intermediary.bank-account.save",
    "intermediary.assignment.end",
    "intermediary.disbursement.evidence.prepare",
    "intermediary.disbursement.evidence.finalize",
    "intermediary.disbursement.post",
    "intermediary.disbursement.reverse",
    "intermediary.collection.cancel",
    "intermediary.remittance.post",
    "renewal.preview",
    "renewal.execute",
    "renewal.reverse",
    "loan.restructure.execute",
    "loan.restructure.reverse",
    "loan.waiver.execute",
    "loan.waiver.reverse",
    "funding-allocation.create",
]);
const financialTools = new Set<McpToolName>([
    "payment.replacement.duplicate-review.execute",
    "payment.replacement.create",
    "payment.post",
    "payment.reverse",
    "payment.reverse-with-accrual.execute",
    "payment.reconcile.execute",
    "payment.reconcile.reflow.execute",
    "payment.restore.execute",
    "payment.restore.schedule-backfill",
    "payment.restore.cancel",
    "payment.restore.create",
    "payment.batch.execute",
    "payment.allocation-correction.execute",
    "loan.activate",
    "loan.payment-start-date.update",
    "loan.interest-rate.execute",
    "loan.settlement.execute",
    "loan.settlement.reverse",
    "loan.cancel.execute",
    "loan.replacement.execute",
    "loan.replacement.reverse",
    "loan.disbursement.post",
    "loan.disbursement.reverse",
    "loan.commission-participant.add",
    "loan.commission-participant.update",
    "loan.commission-participant.end",
    "payment.intermediary-attribution.create",
    "payment.intermediary-attribution.reverse",
    "intermediary.disbursement.post",
    "intermediary.disbursement.reverse",
    "intermediary.collection.cancel",
    "intermediary.remittance.post",
    "renewal.execute",
    "renewal.reverse",
    "loan.restructure.execute",
    "loan.restructure.reverse",
    "loan.waiver.execute",
    "loan.waiver.reverse",
    "funding-allocation.create",
]);
const financialEnvelopeTools = new Set<McpToolName>([...financialTools].filter((toolName) => toolName !== "payment.allocation-correction.execute"));
const idempotentTools = new Set<McpToolName>([
    "system.error-diagnostic.get",
    "system.error-diagnostic.list",
    "workflow.resolve",
    ...[...readOnlyTools].filter((toolName) => toolName !== "loan.commission.reverse"),
    "intake.create",
    "evidence.import-chatgpt-file",
    "loan.disbursement.evidence.import-chatgpt-file",
    "payment.evidence-supplement.import-chatgpt-file",
    "payment.evidence-supplement.record",
    "payment.post",
    "payment.cancel",
    "payment.replacement.create",
    "payment.replacement.duplicate-review.preview",
    "payment.replacement.duplicate-review.execute",
    "payment.reverse",
    "payment.reverse-with-accrual.execute",
    "payment.reconcile.execute",
    "payment.reconcile.reflow.execute",
    "payment.allocation-correction.execute",
    "payment.reconcile.mark-review",
    "payment.restore.execute",
    "payment.restore.schedule-backfill",
    "payment.restore.cancel",
    "payment.restore.create",
    "payment.batch.execute",
    "loan.draft.delete",
    "loan.activate",
    "loan.payment-start-date.update",
    "loan.interest-rate.execute",
    "loan.settlement.execute",
    "loan.settlement.reverse",
    "loan.cancel.execute",
    "loan.replacement.execute",
    "loan.replacement.reverse",
    "loan.disbursement.post",
    "loan.disbursement.reverse",
    "loan.commission-participant.add",
    "loan.commission-participant.update",
    "loan.commission-participant.end",
    "payment.intermediary-attribution.create",
    "payment.intermediary-attribution.reverse",
    "intermediary.bank-account.save",
    "intermediary.assignment.create",
    "intermediary.assignment.end",
    "intermediary.disbursement.create",
    "intermediary.disbursement.event.create",
    "intermediary.disbursement.post",
    "intermediary.disbursement.reverse",
    "intermediary.collection.create",
    "intermediary.collection.cancel",
    "intermediary.remittance.create",
    "intermediary.remittance.post",
    "renewal.execute",
    "renewal.reverse",
    "loan.restructure.execute",
    "loan.restructure.reverse",
    "loan.waiver.execute",
    "loan.waiver.reverse",
    "funding-allocation.create",
]);
const openWorldTools = new Set<McpToolName>([
    "evidence.import-chatgpt-file",
    "loan.disbursement.evidence.import-chatgpt-file",
    "payment.evidence-supplement.import-chatgpt-file",
    // This confirmation-bound write records evidence originating outside the
    // MCP service, so retain the external-world annotation on the final link.
    "payment.evidence-supplement.record",
]);

const toolDescriptions: Record<McpToolName, string> = {
    "borrower.search": "Search accessible borrowers by canonical name or confirmed alias.",
    "borrower.portfolio": "Get one accessible borrower portfolio by public UUID.",
    "borrower.resolve-and-portfolio": "Resolve one borrower without auto-selecting ambiguity and return a bounded portfolio.",
    "borrower.create": "Create a borrower in the configured MCP tenant.",
    "borrower.update": "Update an accessible borrower by public UUID.",
    "borrower.alias": "Add, confirm, or deactivate a borrower alias.",
    "intake.get": "Get a payment intake, evidence, and latest proposal.",
    "payment.match-context": "Get a bounded, read-only payment matching context with borrower candidates and linked loan context.",
    "intake.list": "List accessible payment intakes, optionally by status.",
    "intake.create": "Create an idempotent payment intake from supplied payment data.",
    "evidence.prepare": "Prepare a signed upload for payment evidence.",
    "evidence.finalize": "Verify and finalize uploaded payment evidence.",
    "evidence.import-chatgpt-file": "Import one attached ChatGPT file as verified payment evidence.",
    "loan.disbursement.evidence.import-chatgpt-file": "Import one attached ChatGPT file as ready evidence for an exact loan disbursement draft.",
    "payment.evidence-supplement.import-chatgpt-file": "Import one attached ChatGPT file as ready supplemental evidence for an exact posted payment.",
    "payment.evidence-supplement.record": "Record ready supplemental evidence after explicit operator confirmation.",
    "payment.preview": "Preview and persist a versioned payment match proposal.",
    "payment.post": "Post a ready payment proposal atomically.",
    "payment.cancel": "Cancel an authorized unposted payment intake with an immutable receipt.",
    "payment.replacement.inspect": "Inspect whether an accessible cancelled payment can receive one append-only replacement draft.",
    "payment.replacement.create": "Create one audited draft replacement for an eligible cancelled payment without posting money.",
    "payment.replacement.duplicate-review.preview": "Preview and durably record an exact, tenant-scoped human review for cancelled semantic payment duplicates without changing money.",
    "payment.replacement.duplicate-review.execute": "Execute a confirmed, fresh, idempotent duplicate review that authorizes only its exact cancelled candidates for replacement lineage.",
    "payment.reverse": "Reverse a posted payment with compensating entries.",
    "payment.reverse-with-accrual.preview": "Preview reversing a floating-loan payment and materializing missing interest accruals through the original payment date.",
    "payment.reverse-with-accrual.execute": "Execute a confirmed atomic payment reversal with floating interest accrual materialization.",
    "payment.batch.create": "Create an editable atomic payment batch.",
    "payment.batch.capture": "Capture multiple payment intakes and batch items atomically.",
    "payment.batch.evidence.prepare-many": "Prepare evidence for multiple payment batch items.",
    "payment.batch.evidence.finalize-many": "Finalize evidence for multiple payment batch items.",
    "payment.batch.item.add": "Add one payment intake to an atomic batch.",
    "payment.batch.evidence.prepare": "Prepare evidence for a payment batch item.",
    "payment.batch.evidence.finalize": "Finalize evidence for a payment batch item.",
    "payment.batch.get": "Inspect an atomic payment batch and its latest preview.",
    "payment.batch.stage": "Create resumable payment-batch staging items without inventing amount or transfer time.",
    "payment.batch.staging.evidence.prepare": "Prepare upload-first evidence for one resumable staging item.",
    "payment.batch.staging.evidence.finalize": "Finalize upload-first evidence for one resumable staging item.",
    "payment.batch.staging.extract": "Extract review-only payment-slip candidates from finalized staging evidence using the local OCR pipeline.",
    "payment.batch.workspace": "Inspect resumable batch staging metadata and public evidence status.",
    "payment.batch.candidates": "Discover accessible named borrowers and backend-calculated contract candidates for one reviewed staging slip.",
    "payment.batch.staging.review": "Review one staged payment item and create its linked intake.",
    "payment.batch.staging.edit": "Edit one unposted staged payment item with revision and reason guards.",
    "payment.batch.split": "Move selected unposted batch membership atomically into a new batch.",
    "payment.batch.decision": "Record a revision-bound chronology review decision for a batch.",
    "payment.batch.cancel": "Cancel an unposted batch with a revision-bound idempotent command.",
    "payment.batch.preview": "Preview the complete atomic payment batch allocation.",
    "payment.batch.execute": "Execute one explicitly confirmed atomic payment batch.",
    "payment.reconcile.preview": "Preview an interest-only posting for a reviewed historical needs_review payment intake without reducing principal.",
    "payment.reconcile.reflow.preview": "Preview an append-only temporal repair for an existing executed reconciliation with complete floating-interest provenance.",
    "payment.reconcile.reflow.execute": "Execute a confirmed idempotent temporal repair for an existing reconciliation.",
    "payment.allocation-correction.preview": "Preview moving one posted scheduled repayment to another installment of the same active loan with exact component conservation.",
    "payment.allocation-correction.execute": "Execute a confirmed, idempotent append-only scheduled payment allocation correction.",
    "payment.reconcile.preflight": "Run a no-write execution feasibility check for an explicit payment reconciliation before confirmation.",
    "payment.reconcile.mark-review": "Move an eligible ready backdated floating payment into reconciliation review after explicit confirmation.",
    "payment.reconcile.execute": "Execute a confirmed, idempotent payment reconciliation with append-only provenance.",
    "payment.restore.preview": "Preview exact restoration of a fully reversed payment using its original principal and interest components.",
    "payment.restore.create": "Create one linked restore draft so new payment-slip evidence can be finalized before an exact restore preview.",
    "payment.restore.evidence.prepare": "Prepare a signed slip upload for one linked payment restore draft.",
    "payment.restore.evidence.finalize": "Verify and finalize uploaded slip evidence for one linked payment restore draft.",
    "payment.restore.execute": "Execute a confirmed, idempotent exact restoration of a reversed payment as a linked child intake.",
    "payment.restore.schedule-backfill": "Repair derived schedule aggregates for one verified posted exact-payment restore without creating a payment.",
    "payment.restore.cancel": "Cancel an eligible unposted restore draft with an immutable audited receipt without changing the reversed source or balances.",
    "loan.preview": "Preview an exact loan schedule without persistence.",
    "loan.draft": "Create an editable loan draft.",
    "loan.draft.delete": "Permanently delete an unactivated draft loan after dependency checks and audit logging.",
    "loan.activate": "Activate a loan draft idempotently and create its schedule.",
    "loan.interest-rate.list": "List the effective-dated floating-interest timeline and current exact daily interest.",
    "loan.interest-rate.preview": "Preview an effective-dated floating-interest change and automatic timeline split.",
    "loan.interest-rate.execute": "Execute an explicitly confirmed floating-interest preview idempotently.",
    "loan.settlement.preview": "Preview and persist an exact floating-loan close-out composition.",
    "loan.settlement.execute": "Execute an explicitly confirmed floating-loan close-out idempotently.",
    "loan.settlement.reverse": "Reverse an executed floating-loan settlement through exact append-only compensation.",
    "loan.cancel.preview": "Preview cancellation of an active loan with no actual disbursement and no remaining posted payments.",
    "loan.cancel.execute": "Execute an explicitly confirmed unfunded-loan cancellation idempotently.",
    "loan.replacement.preview": "Preview an atomic scheduled-loan replacement from an active loan into an existing funded draft.",
    "loan.replacement.execute": "Execute an explicitly confirmed fresh atomic loan replacement idempotently.",
    "loan.replacement.reverse": "Reverse an executed loan replacement only when authoritative downstream checks allow compensation.",
    "loan.disbursement.list": "List actual loan disbursement events and variance read-only.",
    "loan.contract.get": "Get complete accessible loan terms and repayment schedule read-only.",
    "loan.inspect-context": "Inspect one accessible loan with a bounded summary, schedule, or payment-history view.",
    "loan.payment-start-date.update": "Change the first repayment date while preserving posted payment history and auditing schedule amendments.",
    "loan.payment-history.list": "List payment intakes and posted components for one accessible loan read-only.",
    "loan.disbursement.draft": "Create an editable actual loan disbursement draft.",
    "loan.disbursement.update": "Update supplied fields on an editable actual loan disbursement draft.",
    "loan.disbursement.evidence.prepare": "Prepare a signed upload for loan disbursement evidence.",
    "loan.disbursement.evidence.finalize": "Verify and finalize loan disbursement evidence.",
    "loan.disbursement.post": "Post an actual loan disbursement idempotently.",
    "loan.disbursement.reverse": "Reverse a posted loan disbursement with a reason.",
    "loan.commission-participant.list": "List current effective-dated commission participants for an accessible loan.",
    "loan.commission-participant.add": "Add a confirmed effective-dated commission participant idempotently.",
    "loan.commission-participant.update": "End the current participant version and append a confirmed replacement version.",
    "loan.commission-participant.end": "End a commission participant through a confirmed immutable successor version.",
    "loan.commission.preview": "Preview exact commission derived only from posted payment interest components.",
    "loan.commission.list": "List exact derived commission for supplied posted payment public UUIDs.",
    "loan.commission.calculate": "Calculate exact derived commission for supplied posted payment public UUIDs.",
    "loan.commission.reverse": "Preview the exact compensating commission effect of supplied posted reversal payments read-only; this never writes financial records or returns audit identifiers.",
    "payment.intermediary-attribution.create": "Create a confirmed exact payment-source attribution idempotently.",
    "payment.intermediary-attribution.list": "List append-only payment-source attribution entries for one accessible payment.",
    "payment.intermediary-attribution.reverse": "Create a confirmed reasoned compensating attribution idempotently.",
    "intermediary.search": "Search active intermediaries before creating a new record.",
    "intermediary.create": "Create an intermediary after canonical-name review.",
    "intermediary.profile.get": "Inspect one intermediary profile, masked bank accounts, and assignment history.",
    "intermediary.bank-account.save": "Save an intermediary bank account and return only its masked public form.",
    "intermediary.managed-loan.list": "List active loans managed by an intermediary through effective assignments.",
    "intermediary.assignment.create": "Create an idempotent effective-dated loan intermediary assignment.",
    "intermediary.assignment.end": "End an intermediary assignment without deleting its history.",
    "intermediary.disbursement.list": "List intermediated disbursement groups by public filters.",
    "intermediary.disbursement.get": "Inspect one intermediated group, its transfer events, and latest reconciliation preview.",
    "intermediary.disbursement.create": "Create an exact intermediated disbursement group from persisted loan activation terms.",
    "intermediary.disbursement.event.create": "Create one immutable-ready cash transfer event within an intermediated group.",
    "intermediary.disbursement.evidence.prepare": "Prepare a signed upload for one transfer-event evidence item.",
    "intermediary.disbursement.evidence.finalize": "Verify and finalize one transfer-event evidence item.",
    "intermediary.disbursement.preview": "Persist an exact role-total, evidence-readiness, retained-balance, and variance preview.",
    "intermediary.disbursement.post": "Atomically post an exact balanced intermediated group after explicit confirmation.",
    "intermediary.disbursement.reverse": "Create a reasoned compensating reversal for one posted intermediated group.",
    "intermediary.collection.list": "List borrower payments held by an intermediary.",
    "intermediary.collection.create": "Record a borrower payment held by an intermediary without posting cash receipt twice.",
    "intermediary.collection.cancel": "Cancel an exact unposted intermediary collection with a current state hash and audit receipt.",
    "intermediary.remittance.get": "Inspect a remittance, allocations, and exact remaining balance.",
    "intermediary.remittance.create": "Create an idempotent intermediary remittance draft.",
    "intermediary.remittance.allocations.save": "Select exact intermediary collections for a remittance.",
    "intermediary.remittance.preview": "Preview the exact remittance reconciliation before posting.",
    "intermediary.remittance.evidence.prepare": "Prepare a signed upload for remittance-slip evidence.",
    "intermediary.remittance.evidence.finalize": "Verify and finalize remittance-slip evidence.",
    "intermediary.remittance.post": "Post a balanced, explicitly confirmed intermediary remittance.",
    "renewal.preview": "Preview a daily-loan renewal with backend-authoritative full-contract-interest composition by default.",
    "renewal.execute": "Execute an unchanged confirmed renewal idempotently, with explicit collection acknowledgement when required.",
    "renewal.reverse": "Reverse an executed renewal with compensating records.",
    "loan.restructure.preview": "Preview an exact single-payment or floating-loan settlement and replacement contract from current balances.",
    "loan.restructure.execute": "Execute an explicitly confirmed restructure preview idempotently.",
    "loan.restructure.reverse": "Reverse an executed restructure when the authoritative downstream checks allow it.",
    "loan.waiver.preview": "Preview an interest, fee, or penalty waiver against the current replacement-loan balance.",
    "loan.waiver.execute": "Execute an explicitly confirmed component waiver preview idempotently.",
    "loan.waiver.reverse": "Reverse an executed component waiver with a compensating record.",
    "funding-source.list": "List tenant funding profiles and drawdowns read-only.",
    "funding-allocation.preview": "Preview attaching an active funding profile or drawdown to an active loan.",
    "funding-allocation.create": "Create an idempotent append-only funding allocation for an active loan, including after activation.",
    "funding-allocation.list": "List append-only funding allocations for one loan read-only.",
    "system.error-diagnostic.get": "Inspect a safe tenant-scoped MCP diagnostic trace by correlation ID.",
    "system.error-diagnostic.list": "List recent safe tenant-scoped MCP diagnostics with bounded filters.",
    "workflow.resolve": "Read-only workflow guidance from current authorized state; it never confirms, authorizes, previews, or executes a financial operation.",
};

function titleFor(toolName: McpToolName) {
    return toolName.split(/[.-]/u).map((part) => `${part[0]!.toUpperCase()}${part.slice(1)}`).join(" ");
}

function completionText(toolName: McpToolName) {
    if (toolName === "loan.commission.reverse") return "Loan commission reversal preview completed.";
    const words = toolName.replace(/[.-]/gu, " ");
    return `${words[0]!.toUpperCase()}${words.slice(1)} completed.`;
}

function deepFreeze<T>(value: T): T {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    }
    return value;
}

let schemaGenerationCount = 0;
function generatedJsonSchema(schema: z.ZodType) {
    schemaGenerationCount += 1;
    return z.toJSONSchema(schema) as Record<string, unknown>;
}

const TOOL_CATALOG = deepFreeze(MCP_TOOL_NAMES.map((name) => ({
    name,
    description: toolDescriptions[name],
    inputSchema: generatedJsonSchema(toolInputSchemas[name]),
    outputSchema: generatedJsonSchema(advertisedOutputSchema(name)),
    annotations: {
        title: titleFor(name),
        readOnlyHint: readOnlyTools.has(name),
        destructiveHint: destructiveTools.has(name),
        idempotentHint: idempotentTools.has(name),
        openWorldHint: openWorldTools.has(name),
    },
    policy: {
        kind: financialTools.has(name) ? "financial" : readOnlyTools.has(name) ? "read_only" : "mutating",
        requiresAudit: financialTools.has(name),
    },
    ...(name === "evidence.import-chatgpt-file" || name === "loan.disbursement.evidence.import-chatgpt-file" || name === "payment.evidence-supplement.import-chatgpt-file"
        ? { _meta: { "openai/fileParams": ["chatgptFile"] } }
        : {}),
} satisfies McpToolDefinition))) as readonly McpToolDefinition[];
export { TOOL_CATALOG };

const LEGACY_TOOL_CATALOG = deepFreeze(TOOL_CATALOG.map((tool) => ({
    ...tool,
    inputSchema: toJsonSchemaCompat(normalizeObjectSchema(toolInputSchemas[tool.name])!, { strictUnions: true, pipeStrategy: "input" }) as Record<string, unknown>,
    outputSchema: transportOutputJsonSchema(tool.name),
})));

export const MCP_CATALOG_VERSION = `mcp-catalog-${createHash("sha256")
    .update(JSON.stringify(TOOL_CATALOG))
    .digest("hex")
    .slice(0, 16)}`;

export function modernCatalogVersion(catalog: readonly McpToolDefinition[] = TOOL_CATALOG) {
    return `mcp-catalog-${createHash("sha256").update(JSON.stringify(catalog)).digest("hex").slice(0, 16)}`;
}

export function mcpCatalogVersion() {
    return MCP_CATALOG_VERSION;
}

export function mcpSchemaMetrics() {
    return { schemaGenerationCount };
}

function cloneToolDefinition(tool: McpToolDefinition): McpToolDefinition {
    return structuredClone(tool);
}

function legacyToolsForProfile(profile: ToolProfile, catalog = LEGACY_TOOL_CATALOG) {
    return toolsForProfile(profile, catalog).map(cloneToolDefinition);
}

/** Benchmark-only projection comparison. Request handlers always use the
 * module-load cache; the uncached branch is intentionally callable only by the
 * local benchmark and is never used by tools/list. */
export function legacyDiscoveryProjectionForBenchmark(profile: ToolProfile = "full", uncached = false) {
    if (!uncached) return legacyToolsForProfile(profile);
    return toolsForProfile(profile, TOOL_CATALOG).map((tool) => ({
        ...tool,
        inputSchema: toJsonSchemaCompat(normalizeObjectSchema(toolInputSchemas[tool.name as McpToolName])!, { strictUnions: true, pipeStrategy: "input" }) as Record<string, unknown>,
        outputSchema: transportOutputJsonSchema(tool.name as McpToolName),
    }));
}

/** Test/validator view of the exact schemas and annotations used by registerTool. */
export function advertisedMcpToolMetadata() {
    // Keep the canonical catalog immutable while returning a caller-owned
    // projection for validators and SDK adapters.
    return TOOL_CATALOG.map(cloneToolDefinition);
}

/** Return the definitions selected by a profile from the same immutable
 * catalog used by the serving route. Snapshot generation must not infer
 * membership from a separate unchecked name list. */
export function advertisedMcpToolMetadataForProfile(profile: ToolProfile) {
    return toolsForProfile(profile, TOOL_CATALOG).map(cloneToolDefinition);
}

function sanitizeDetails(details: Record<string, unknown> | undefined): Record<string, unknown> {
    if (!details) return {};
    const deniedKey = /(name|email|alias|phone|card|address|qr|reference|url|token|secret|hash)/i;
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(details)) {
        if (deniedKey.test(key)) continue;
        if (value === null || typeof value === "boolean" || typeof value === "number") {
            sanitized[key] = value;
            continue;
        }
        if (typeof value === "string" && value.length <= 500) {
            sanitized[key] = value;
            continue;
        }
        if (Array.isArray(value) && value.length <= 100 && value.every((item) => ["string", "number", "boolean"].includes(typeof item))) {
            sanitized[key] = value;
        }
    }
    return sanitized;
}

function safeToolError(error: unknown) {
    if (error instanceof DomainError) {
        const isBatchError = error.code.startsWith("BATCH_");
        const repreviewRequired = ["BATCH_STATE_CHANGED_SEMANTICS_SAME", "BATCH_EXECUTION_CONFLICT"].includes(error.code);
        const humanReviewRequired = ["BATCH_NEEDS_REVIEW", "BATCH_DUPLICATE_EVIDENCE", "BATCH_ALLOCATION_MISMATCH", "BATCH_CONFIRMATION_STALE"].includes(error.code);
        return {
            code: error.code,
            message: error.message,
            retryable: error.status === 429 || error.status >= 500,
            reviewRequired: error.status === 409 || /(AMBIGUOUS|MISMATCH|REVIEW|STALE|NOT_LATEST|OUTPUT)/u.test(error.code),
            ...(isBatchError ? { repreviewRequired, humanReviewRequired } : {}),
            details: sanitizeDetails(error.details),
        };
    }
    return {
        code: "INTERNAL_ERROR",
        message: "The MCP tool could not complete the request",
        retryable: true,
        reviewRequired: false,
        repreviewRequired: false,
        humanReviewRequired: false,
        details: {},
    };
}

function dataRecord(value: unknown): Record<string, unknown> {
    const json = JSON.parse(JSON.stringify(value)) as unknown;
    if (Array.isArray(json)) return { items: json };
    if (json && typeof json === "object") return json as Record<string, unknown>;
    return { value: json };
}

export function frozenToolData(toolName: McpToolName, value: unknown): Record<string, unknown> {
    const data = dataRecord(value);
    if ([
        "loan.commission-participant.add",
        "loan.commission-participant.update",
        "loan.commission-participant.end",
    ].includes(toolName)) {
        const {
            intermediaryName: _intermediaryName,
            intermediaryAliases: _intermediaryAliases,
            ...contractParticipant
        } = data;
        return contractParticipant;
    }
    if (toolName === "loan.commission-participant.list" && Array.isArray(data.items)) {
        return {
            items: data.items.map((item) => {
                if (!item || typeof item !== "object" || Array.isArray(item)) return item;
                const {
                    intermediaryName: _intermediaryName,
                    intermediaryAliases: _intermediaryAliases,
                    ...contractParticipant
                } = item as Record<string, unknown>;
                return contractParticipant;
            }),
        };
    }
    if (toolName === "loan.disbursement.list") {
        const summary = data.summary;
        if (summary && typeof summary === "object" && !Array.isArray(summary)) {
            const { postedGrossAmount: _postedGrossAmount, postedEventCount: _postedEventCount, ...contractSummary } = summary as Record<string, unknown>;
            data.summary = contractSummary;
        }
        return data;
    }
    if (toolName !== "loan.preview" && toolName !== "loan.draft" && toolName !== "loan.activate") return data;
    const projectLoanFields = (record: Record<string, unknown>) => {
        const legacy = record;
        delete legacy.floatingPayoutSummary;
        const floating = legacy.floatingDailyInterest;
        if (floating && typeof floating === "object" && !Array.isArray(floating)) {
            const { accrualCycle: _accrualCycle, ...legacyFloating } = floating as Record<string, unknown>;
            legacy.floatingDailyInterest = legacyFloating;
        }
        return legacy;
    };
    const projected = projectLoanFields({ ...data });
    const projectedTerms = projected.terms && typeof projected.terms === "object" && !Array.isArray(projected.terms)
        ? projected.terms as Record<string, unknown>
        : undefined;
    const generalizedPreview = Boolean(projectedTerms?.floatingInterestPolicy);
    const dailyFloatingPreview = toolName === "loan.preview"
        && projected.periodDays === 1
        && typeof projected.dailyInterestAtCurrentPrincipal === "string";
    if (toolName === "loan.preview" && typeof projected.fullPeriodInterest === "string" && (!generalizedPreview || dailyFloatingPreview)) {
        if (!dailyFloatingPreview) {
            projected.firstDayInterest = projected.advanceInterestAmount;
            projected.dailyInterestAtCurrentPrincipal = projected.fullPeriodInterest;
            projected.nextInterestDate = projected.nextAccrualDate;
        }
        delete projected.fullPeriodInterest;
        delete projected.firstPeriodStartDate;
        delete projected.advanceInterestAmount;
        delete projected.coveredStartDate;
        delete projected.coveredEndDate;
        delete projected.firstPeriodDueDate;
        delete projected.nextAccrualDate;
        delete projected.periodDays;
        delete projected.advanceInterestRefundPolicy;
        if (dailyFloatingPreview) {
            delete projected.floatingInterestPolicy;
            delete projected.advanceInterest;
            delete projected.netBorrowerPayout;
        }
    }
    if (projected.terms && typeof projected.terms === "object" && !Array.isArray(projected.terms)) {
        projected.terms = projectLoanFields({ ...(projected.terms as Record<string, unknown>) });
    }
    return projected;
}

export function createMcpProtocolServer(input: CreateMcpHttpPluginInput, ctx: CommandContext) {
    const profile = input.profile ?? "full";
    const catalog = input.catalog ?? LEGACY_TOOL_CATALOG;
    const visibleTools = input.catalog ? catalog : toolsForProfile(profile, catalog);
    const catalogVersion = input.catalog ? `mcp-fixture-${createHash("sha256").update(JSON.stringify(catalog)).digest("hex").slice(0, 16)}` : MCP_CATALOG_VERSION;
    const server = new Server({ name: "creditsync", version: "1.0.0" }, {
        capabilities: { tools: {} },
        instructions: "CreditSync private tenant-scoped financial workflow tools. Call workflow.resolve at the start of a new financial intent and after stale state, evidence, or version changes; it is read-only guidance, not authorization or confirmation. Inspect and preview before posting financial changes.",
    });
    server.setRequestHandler(ListToolsRequestSchema, (request) => {
        const paginated = profile !== "full";
        const offset = paginated && request.params?.cursor !== undefined
            ? decodeCatalogCursor(profile, catalogVersion, request.params.cursor, visibleTools.length)
            : 0;
        const page = paginated ? visibleTools.slice(offset, offset + MCP_PAGE_SIZE) : visibleTools;
        return {
        tools: page.map((tool) => ({
            name: tool.name,
            title: tool.annotations.title,
            description: tool.description,
            inputSchema: tool.inputSchema,
            outputSchema: tool.outputSchema,
            annotations: tool.annotations,
            ...((tool as { _meta?: Record<string, unknown> })._meta ? { _meta: (tool as { _meta?: Record<string, unknown> })._meta } : {}),
        })),
        ...(paginated && offset + page.length < visibleTools.length
            ? { nextCursor: encodeCatalogCursor(profile, catalogVersion, offset + page.length) }
            : {}),
        };
    });
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const toolName = request.params.name as McpToolName;
        if (!visibleTools.some((tool) => tool.name === toolName)) {
            throw new McpError(ErrorCode.InvalidParams, `Tool ${request.params.name} not found`);
        }
        await input.validateToolRequest?.({ toolName, arguments: request.params.arguments ?? {} });
        return executeMcpToolCall(input, ctx, toolName, request.params.arguments ?? {});
    });
    return server;
}

/**
 * The application-level execution boundary shared by both protocol adapters.
 * The v2 SDK validates registered schemas outside callbacks, so its adapter
 * deliberately registers metadata-only handlers and delegates here. This
 * keeps validation, policy, diagnostics, audit requirements, and public
 * output validation identical across the legacy and modern transports.
 */
export async function executeMcpToolCall(
    input: CreateMcpHttpPluginInput,
    ctx: CommandContext,
    toolName: string,
    rawArguments: unknown,
) {
    const catalog = input.catalog ?? TOOL_CATALOG;
    const metadata = catalog.find((tool) => tool.name === toolName);
    const availableNames = new Set<string>(input.catalog ? catalog.map((tool) => tool.name) : toolNamesForProfile(input.profile ?? "full"));
    const toolContext = { ...ctx };
    const policy: OperationRecoveryPolicy = metadata?.policy.kind === "financial" || financialTools.has(toolName as McpToolName)
        ? "financial" : metadata?.policy.kind === "read_only" || readOnlyTools.has(toolName as McpToolName) ? "read_only" : "mutating";
    const requiresAudit = metadata?.policy.requiresAudit ?? financialTools.has(toolName as McpToolName);
    return withMcpDiagnosticScope(toolContext, toolName, async () => {
        try {
            if (!availableNames.has(toolName)) throw new DomainError("UNKNOWN_TOOL", "The requested MCP tool is not available", 400);
            recordMcpBreadcrumb({ stage: "validation", outcome: "started" });
            const parsedInput = await (input.parseToolInput ?? ((name, args) => toolInputSchemas[name as McpToolName].safeParseAsync(args) as Promise<{ success: boolean; data?: Record<string, unknown> }>))(toolName, rawArguments);
            if (!parsedInput.success) {
                recordMcpBreadcrumb({ stage: "validation", outcome: "failed" });
                throw new DomainError("INVALID_TOOL_ARGUMENTS", "The MCP tool arguments are invalid", 422);
            }
            recordMcpBreadcrumb({ stage: "validation", outcome: "succeeded" });
            const parsed = parsedInput.data as Record<string, unknown>;
            const idempotencyKey = typeof parsed.idempotencyKey === "string" ? parsed.idempotencyKey : undefined;
            const { idempotencyKey: _removed, ...handlerInput } = parsed;
            toolContext.idempotencyKey = idempotencyKey ?? (toolName === "loan.activate" ? `mcp:loan.activate:${String(handlerInput.loanPublicId)}` : undefined);
            recordMcpBreadcrumb({ stage: "preflight", outcome: "started" });
            await input.preflightHandlers?.[toolName]?.(toolContext, handlerInput);
            recordMcpBreadcrumb({ stage: "preflight", outcome: "succeeded" });
            recordMcpBreadcrumb({ stage: "handler", outcome: "started" });
            const handler = input.handlers[toolName];
            if (!handler) throw new DomainError("UNKNOWN_TOOL", "The requested MCP tool is not available", 400);
            const result = await handler(toolContext, toolName === "workflow.resolve"
                ? { ...handlerInput, __profile: input.profile ?? "full", __catalogVersion: input.catalog ? modernCatalogVersion(input.catalog) : MCP_CATALOG_VERSION, __workflowVersion: WORKFLOW_VERSION }
                : handlerInput);
            recordMcpBreadcrumb({ stage: "handler", outcome: "succeeded" });
            const auditPublicIds = requiresAudit ? await input.findAuditPublicIds({ ctx: toolContext, toolName, result }) : undefined;
            if (requiresAudit && auditPublicIds?.length === 0) throw new DomainError("AUDIT_METADATA_UNAVAILABLE", "The financial command completed without retrievable public audit metadata", 503);
            const publicData = input.catalog ? result : frozenToolData(toolName as McpToolName, result);
            const includeAuditEnvelope = requiresAudit && financialEnvelopeTools.has(toolName as McpToolName);
            const publicOutput = { schemaVersion: "1.0", data: publicData, ...(includeAuditEnvelope ? { correlationId: toolContext.correlationId, auditPublicIds: auditPublicIds ?? [] } : {}) };
            const structuredContent = input.validateToolOutput
                ? input.validateToolOutput(toolName, publicOutput)
                : successOutputSchema(toolName as McpToolName).safeParse(publicOutput);
            if (!structuredContent.success) throw new DomainError("INVALID_TOOL_OUTPUT", "The application service returned data outside the public MCP contract", 422);
            return { content: [{ type: "text" as const, text: completionText(toolName as McpToolName) }], structuredContent: structuredContent.data };
        } catch (error) {
            const snapshot = currentMcpDiagnosticSnapshot();
            const failedBreadcrumb = [...(snapshot?.breadcrumbs ?? [])].reverse().find((breadcrumb) => breadcrumb.outcome === "failed" || breadcrumb.outcome === "rejected");
            const activeBreadcrumb = [...(snapshot?.breadcrumbs ?? [])].reverse().find((breadcrumb) => breadcrumb.outcome === "started");
            const terminalStage = failedBreadcrumb?.stage ?? activeBreadcrumb?.stage ?? "handler";
            const presented = presentMcpError(error, toolContext.correlationId, policy, terminalStage);
            if (/(evidence|import-chatgpt-file)/iu.test(toolName)) {
                safeMcpMetric(input, {
                    event: "mcp_metric", metric: "evidence_stop", profile: input.profile ?? "full", protocolEra: "unknown",
                    operationClass: "tool_call", statusClass: presented.publicError.retryable ? "5xx" : "4xx",
                    evidenceStopClass: evidenceStopClass(presented.publicError.code, presented.publicError),
                });
            }
            if (presented.persist && snapshot && !toolName.startsWith("system.error-diagnostic.")) {
                const persist = input.persistDiagnostic ?? ((value: Parameters<typeof persistMcpDiagnosticBestEffort>[0]) => persistMcpDiagnosticBestEffort(value));
                let pending: Promise<void>;
                try {
                    pending = Promise.resolve(persist({ ctx: toolContext, toolName, publicError: presented.publicError, classification: presented.diagnostic, snapshot, logger: input.logger }));
                } catch {
                    pending = Promise.resolve();
                }
                pending.catch(() => undefined);
                await Promise.race([pending, new Promise<void>((resolve) => setTimeout(resolve, 500))]).catch(() => undefined);
            }
            try { input.logger({ event: "mcp_tool_error", tool: toolName, requestId: toolContext.requestId, correlationId: toolContext.correlationId, code: presented.publicError.code }); } catch { /* preserve error response */ }
            return { isError: true, content: [{ type: "text" as const, text: `${presented.publicError.code}: ${presented.publicError.message}` }], structuredContent: errorOutputSchema.parse({ schemaVersion: "1.0", error: presented.publicError }) };
        }
    });
}

function httpError(status: number, code: string, message: string, retryable = false) {
    return Response.json({ error: { code, message, retryable, reviewRequired: false, details: {} } }, {
        status,
        headers: { "cache-control": "no-store" },
    });
}

function safeMcpLogger(logger: (entry: Record<string, unknown>) => void, entry: Record<string, unknown>) {
    try { logger(entry); } catch { /* observability must not change the MCP outcome */ }
}

function statusClass(status: number): McpMetric["statusClass"] {
    return status >= 500 ? "5xx" : status >= 400 ? "4xx" : "2xx";
}

function operationClass(value: string | null): McpMetric["operationClass"] {
    return value === "tools/list" ? "discovery" : value === "tools/call" ? "tool_call" : "other";
}

type MetricRequestDetails = { method?: string; name?: string };

async function requestDetailsForMetric(request: Request, headerMethod: string | null): Promise<MetricRequestDetails> {
    try {
        const body = await request.clone().text();
        if (body.length > 1_000_000) return { method: headerMethod ?? undefined };
        const parsed = JSON.parse(body) as { method?: unknown; params?: { name?: unknown } };
        return {
            method: typeof parsed.method === "string" ? parsed.method : headerMethod ?? undefined,
            name: typeof parsed.params?.name === "string" ? parsed.params.name : undefined,
        };
    } catch {
        return { method: headerMethod ?? undefined };
    }
}

function responseHasJsonRpcError(bytes: ArrayBuffer | null) {
    if (!bytes) return false;
    try {
        const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { error?: unknown };
        return parsed.error !== undefined;
    } catch {
        return false;
    }
}

function rejectionReasonForMetric(request: Request, details: MetricRequestDetails, jsonRpcError: boolean, modern: boolean): McpMetric["rejectionReason"] {
    const headerMethod = request.headers.get("mcp-method");
    const headerName = request.headers.get("mcp-name");
    if (details.method && headerMethod && details.method !== headerMethod) return "method";
    if (details.name && headerName && details.name !== headerName) return "name";
    if (jsonRpcError && details.method === "unknown/method") return "method";
    if (jsonRpcError && details.method === "tools/call" && headerName && headerName !== details.name) return "name";
    if (modern && request.headers.get("mcp-protocol-version") !== "2026-07-28") return "protocol_version";
    return "envelope";
}

function safeMcpMetric(input: CreateMcpHttpPluginInput, metric: McpMetric) {
    try { input.onMetric?.(metric); } catch { /* observability must not change the MCP outcome */ }
}

function evidenceStopClass(code: string, error: { retryable: boolean; reviewRequired: boolean }): NonNullable<McpMetric["evidenceStopClass"]> {
    if (/(STORAGE|UPLOAD|DOWNLOAD|EVIDENCE)/u.test(code) && error.retryable) return "storage";
    if (error.reviewRequired || /(DUPLICATE|MISMATCH|REVIEW|STALE|UNAUTHORIZED)/u.test(code)) return "review_required";
    if (error.retryable) return "retryable";
    if (/(INVALID|MISSING|UNSUPPORTED|SIZE|MIME)/u.test(code)) return "validation";
    return "unknown";
}

const publicUuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requestId(value: string | null) {
    return value && publicUuidPattern.test(value) ? value : crypto.randomUUID();
}

function withRequestHeaders(response: Response, requestIdValue: string, correlationIdValue: string) {
    const headers = new Headers(response.headers);
    headers.set("x-request-id", requestIdValue);
    headers.set("x-correlation-id", correlationIdValue);
    headers.set("cache-control", "no-store");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function createMcpHttpPlugin(input: CreateMcpHttpPluginInput, endpoint = "/mcp") {
    return new Elysia({ name: "creditsync-mcp" })
        .get(`${endpoint}/health`, ({ request }) => {
            if (!hostIsAllowed(request.headers.get("host"), input.config.allowedHosts)) {
                return httpError(403, "HOST_NOT_ALLOWED", "Host is not allowed");
            }
            return Response.json({ status: "ok", service: "creditsync-mcp", schemaVersion: "1.0" }, {
                headers: { "cache-control": "no-store" },
            });
        })
        .all(endpoint, async ({ request }) => {
            const startedAt = performance.now();
            const requestIdValue = requestId(request.headers.get("x-request-id"));
            const correlationIdValue = requestId(request.headers.get("x-correlation-id"));
            if (!hostIsAllowed(request.headers.get("host"), input.config.allowedHosts)) {
                safeMcpMetric(input, { event: "mcp_metric", metric: "rejection", profile: input.profile ?? "full", protocolEra: "unknown", operationClass: operationClass(request.headers.get("mcp-method")), statusClass: "4xx", rejectionReason: "host" });
                return withRequestHeaders(httpError(403, "HOST_NOT_ALLOWED", "Host is not allowed"), requestIdValue, correlationIdValue);
            }
            if (!originIsAllowed(request.headers.get("origin"), input.config.allowedOrigins)) {
                safeMcpMetric(input, { event: "mcp_metric", metric: "rejection", profile: input.profile ?? "full", protocolEra: "unknown", operationClass: operationClass(request.headers.get("mcp-method")), statusClass: "4xx", rejectionReason: "origin" });
                return withRequestHeaders(httpError(403, "ORIGIN_NOT_ALLOWED", "Origin is not allowed"), requestIdValue, correlationIdValue);
            }
            if (request.method !== "POST") {
                safeMcpMetric(input, { event: "mcp_metric", metric: "rejection", profile: input.profile ?? "full", protocolEra: "unknown", operationClass: operationClass(request.headers.get("mcp-method")), statusClass: "4xx", rejectionReason: "method" });
                const response = httpError(405, "METHOD_NOT_ALLOWED", "Only MCP POST requests are supported");
                response.headers.set("allow", "POST");
                return withRequestHeaders(response, requestIdValue, correlationIdValue);
            }
            const auth = authenticateBearer(request.headers.get("authorization"), input.config.tokenHashes);
            if (!auth) {
                safeMcpMetric(input, { event: "mcp_metric", metric: "rejection", profile: input.profile ?? "full", protocolEra: "unknown", operationClass: operationClass(request.headers.get("mcp-method")), statusClass: "4xx", rejectionReason: "bearer" });
                return withRequestHeaders(httpError(401, "UNAUTHORIZED", "Unauthorized"), requestIdValue, correlationIdValue);
            }
            try {
                const rate = await input.consumeRateLimit({
                    key: `${input.config.tenantId}:${auth.tokenFingerprint}`,
                    max: input.config.rateLimitMax,
                    windowSeconds: input.config.rateLimitWindowSeconds,
                });
                if (!rate.allowed) {
                    safeMcpMetric(input, { event: "mcp_metric", metric: "rejection", profile: input.profile ?? "full", protocolEra: "unknown", operationClass: operationClass(request.headers.get("mcp-method")), statusClass: "4xx", rejectionReason: "rate_limit", durationMs: Math.round(performance.now() - startedAt) });
                    const response = httpError(429, "RATE_LIMITED", "MCP request rate limit exceeded", true);
                    response.headers.set("retry-after", String(rate.retryAfterSeconds));
                    return withRequestHeaders(response, requestIdValue, correlationIdValue);
                }
                const principal = await input.resolvePrincipal({
                    tenantId: input.config.tenantId,
                    actorEmail: input.config.actorEmail,
                });
                if (principal.tenantId !== input.config.tenantId) {
                    throw new Error("MCP principal tenant mismatch");
                }
                const ctx: CommandContext = {
                    tenantId: principal.tenantId,
                    actorUserId: principal.actorUserId,
                    actorSource: "mcp",
                    requestId: requestIdValue,
                    correlationId: correlationIdValue,
                };
                const modernCatalog = input.catalog ?? TOOL_CATALOG;
                const modernVersion = input.catalog ? `mcp-fixture-${createHash("sha256").update(JSON.stringify(modernCatalog)).digest("hex").slice(0, 16)}` : mcpCatalogVersion();
                const requestIsLegacy = await isLegacyRequest(request);
                const metricDetails = await requestDetailsForMetric(request, request.headers.get("mcp-method"));
                const modernHandler = createModernMcpHandler(input, ctx, modernCatalog, modernVersion);
                if (!requestIsLegacy) {
                    let keepModernHandlerOpen = false;
                    try {
                        const modernResponse = await modernHandler.fetch(request);
                        const streamingResponse = modernResponse.headers.get("content-type")?.includes("text/event-stream") === true;
                        // Discovery and JSON tool calls are finite by contract,
                        // so their exact wire bytes are safe to measure. Keep a
                        // streaming response live and avoid consuming its body
                        // before the client can receive its first frame.
                        const responseBuffer = streamingResponse ? null : await modernResponse.clone().arrayBuffer();
                        const responseBytes = responseBuffer?.byteLength;
                        const modernMethod = metricDetails.method;
                        const rpcError = responseHasJsonRpcError(responseBuffer);
                        const rejected = modernResponse.status >= 400 || rpcError;
                        safeMcpMetric(input, { event: "mcp_metric", metric: rejected ? "rejection" : "request", profile: input.profile ?? "full", protocolEra: "modern", operationClass: operationClass(modernMethod ?? null), statusClass: statusClass(modernResponse.status), durationMs: Math.round((performance.now() - startedAt) * 100) / 100, ...(responseBytes === undefined ? {} : { responseBytes }), ...(rejected ? { rejectionReason: rejectionReasonForMetric(request, metricDetails, rpcError, true) } : {}), ...(!rejected && modernMethod === "tools/list" ? { schemaCacheHit: true } : {}) });
                        safeMcpLogger(input.logger, {
                            event: "mcp_request",
                            method: request.method,
                            status: modernResponse.status,
                            requestId: requestIdValue,
                            correlationId: correlationIdValue,
                            protocolEra: "modern",
                            durationMs: Math.round(performance.now() - startedAt),
                            profile: input.profile ?? "full",
                            ...(responseBytes === undefined ? {} : { responseBytes }),
                        });
                        if (streamingResponse) {
                            keepModernHandlerOpen = true;
                            request.signal.addEventListener("abort", () => { void modernHandler.close().catch(() => undefined); }, { once: true });
                        }
                        return withRequestHeaders(modernResponse, requestIdValue, correlationIdValue);
                    } finally {
                        if (!keepModernHandlerOpen) await modernHandler.close().catch(() => undefined);
                    }
                }
                const server = createMcpProtocolServer(input, ctx);
                const transport = new WebStandardStreamableHTTPServerTransport({
                    sessionIdGenerator: undefined,
                    enableJsonResponse: true,
                });
                transport.onerror = () => safeMcpLogger(input.logger, {
                    event: "mcp_transport_error",
                    requestId: requestIdValue,
                    correlationId: correlationIdValue,
                });
                try {
                    await server.connect(transport);
                    const handled = await transport.handleRequest(request);
                    const body = handled.body ? await handled.arrayBuffer() : null;
                    const response = new Response(body, {
                        status: handled.status,
                        statusText: handled.statusText,
                        headers: handled.headers,
                    });
                    const legacyMethod = metricDetails.method;
                    const responseBytes = body?.byteLength ?? 0;
                    const rpcError = responseHasJsonRpcError(body);
                    const rejected = response.status >= 400 || rpcError;
                    safeMcpMetric(input, { event: "mcp_metric", metric: rejected ? "rejection" : "request", profile: input.profile ?? "full", protocolEra: "legacy", operationClass: operationClass(legacyMethod ?? null), statusClass: statusClass(response.status), durationMs: Math.round((performance.now() - startedAt) * 100) / 100, responseBytes, ...(rejected ? { rejectionReason: rejectionReasonForMetric(request, metricDetails, rpcError, false) } : {}), ...(!rejected && legacyMethod === "tools/list" ? { schemaCacheHit: true } : {}) });
                    safeMcpLogger(input.logger, {
                        event: "mcp_request",
                        method: request.method,
                        status: response.status,
                        requestId: requestIdValue,
                        correlationId: correlationIdValue,
                        durationMs: Math.round(performance.now() - startedAt),
                        profile: input.profile ?? "full",
                        protocolEra: "legacy",
                        responseBytes,
                    });
                    return withRequestHeaders(response, requestIdValue, correlationIdValue);
                } finally {
                    await server.close().catch(() => undefined);
                }
            } catch (error) {
                safeMcpMetric(input, { event: "mcp_metric", metric: "rejection", profile: input.profile ?? "full", protocolEra: "unknown", operationClass: operationClass(request.headers.get("mcp-method")), statusClass: "5xx", rejectionReason: "infrastructure", durationMs: Math.round(performance.now() - startedAt) });
                safeMcpLogger(input.logger, {
                    event: "mcp_request_failed",
                    method: request.method,
                    status: 503,
                    requestId: requestIdValue,
                    correlationId: correlationIdValue,
                    durationMs: Math.round(performance.now() - startedAt),
                });
                return withRequestHeaders(
                    httpError(503, "MCP_UNAVAILABLE", "MCP service is temporarily unavailable", true),
                    requestIdValue,
                    correlationIdValue,
                );
            }
        });
}
