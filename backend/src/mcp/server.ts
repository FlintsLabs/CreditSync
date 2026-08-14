import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Elysia } from "elysia";
import { z } from "zod";
import type { CommandContext } from "../services/command-context";
import { DomainError } from "../services/domain-error";
import { authenticateBearer, hostIsAllowed, type McpRuntimeConfig } from "./security";

export const MCP_TOOL_NAMES = [
    "borrower.search",
    "borrower.portfolio",
    "borrower.create",
    "borrower.update",
    "borrower.alias",
    "intake.get",
    "intake.list",
    "intake.create",
    "evidence.prepare",
    "evidence.finalize",
    "payment.preview",
    "payment.post",
    "payment.reverse",
    "loan.preview",
    "loan.draft",
    "loan.activate",
    "loan.interest-rate.list",
    "loan.interest-rate.preview",
    "loan.interest-rate.execute",
    "loan.settlement.preview",
    "loan.settlement.execute",
    "loan.disbursement.list",
    "loan.disbursement.draft",
    "loan.disbursement.update",
    "loan.disbursement.evidence.prepare",
    "loan.disbursement.evidence.finalize",
    "loan.disbursement.post",
    "loan.disbursement.reverse",
    "intermediary.search",
    "intermediary.create",
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
    "intermediary.collection.list",
    "intermediary.collection.create",
    "intermediary.remittance.get",
    "intermediary.remittance.create",
    "intermediary.remittance.allocations.save",
    "intermediary.remittance.preview",
    "intermediary.remittance.evidence.prepare",
    "intermediary.remittance.evidence.finalize",
    "intermediary.remittance.post",
    "renewal.preview",
    "renewal.execute",
    "renewal.reverse",
    "funding-source.list",
] as const;

export type McpToolName = (typeof MCP_TOOL_NAMES)[number];
export type McpToolHandler = (ctx: CommandContext, input: Record<string, unknown>) => Promise<unknown>;

export interface CreateMcpHttpPluginInput {
    config: McpRuntimeConfig;
    handlers: Record<McpToolName, McpToolHandler>;
    resolvePrincipal: (input: { tenantId: string; actorEmail: string }) => Promise<{ tenantId: string; actorUserId: number }>;
    consumeRateLimit: (input: { key: string; max: number; windowSeconds: number }) => Promise<{
        allowed: boolean;
        remaining: number;
        retryAfterSeconds: number;
    }>;
    findAuditPublicIds: (input: {
        ctx: CommandContext;
        toolName: McpToolName;
        result: unknown;
    }) => Promise<string[]>;
    logger: (entry: Record<string, unknown>) => void;
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
const optionalNullableText = z.string().trim().max(2_000).nullable().optional();

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
    periodUnit: z.enum(["day", "week"]),
    periodLength: z.literal(1),
    rateMode: z.enum(["percent", "per_thousand"]),
    rate: floatingInterestRate,
    advanceInterestPeriods: z.union([z.literal(0), z.literal(1)]),
    advanceInterestRefundPolicy: z.literal("non_refundable"),
}).strict();

const loanTerms = {
    principal: money,
    interestRate: money,
    termMonths: z.number().int().positive().max(1_200),
    repaymentType: z.enum(["daily", "weekly", "monthly", "floating"]),
    startDate: date,
    totalInstallments: z.number().int().positive().max(100_000).optional(),
    installmentAmount: money.optional(),
    floatingInterestPolicy: floatingInterestPolicy.optional(),
    dailyEntry: z.object({
        durationUnit: z.enum(["days", "months"]),
        durationValue: z.number().int().positive().max(100_000),
        entryMode: z.enum(["daily_payment", "daily_interest"]),
        dailyPayment: money.optional(),
        interestInput: z.object({
            mode: z.enum(["percent", "fixed_amount", "per_thousand"]),
            value: z.string().regex(/^\d+(?:\.\d{1,4})?$/),
        }).optional(),
    }).optional(),
};

const explicitAllocation = z.object({
    borrowerPublicId: uuid,
    loanPublicId: uuid,
    schedulePublicId: uuid.optional(),
    amount: money,
}).strict();

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
const loanOutput = z.object({
    ...publicEntity,
    borrowerPublicId: uuid.nullable().optional(),
    bankLoanPublicId: uuid.nullable().optional(),
    bankProfilePublicId: uuid.nullable().optional(),
    principal: money,
    principalAmount: money,
    interestRate: money,
    floatingInterestPolicy: floatingInterestPolicy.nullable().optional(),
    floatingDailyInterest: z.object({ mode: z.enum(["per_thousand", "percent"]), rate: z.string(), firstDayTreatment: z.enum(["deduct", "start_next_day"]) }).nullable().optional(),
    dailyEntry: z.object({
        durationUnit: z.enum(["days", "months"]), durationValue: z.number().int().positive(), entryMode: z.enum(["daily_payment", "daily_interest"]),
        dailyPayment: money.nullable(), interestInput: z.object({ mode: z.enum(["percent", "fixed_amount", "per_thousand"]), value: z.string() }).nullable(), flatDailyRatePercent: z.string(),
    }).nullable().optional(),
    dailyLoanCalculation: z.object({
        totalInstallments: z.number().int().positive(), installmentAmount: money, totalRepayment: money, totalInterest: money, dailyInterest: money,
        flatDailyRatePercent: z.string(), flatMonthlyRatePercent: z.string(), flatAnnualRatePercent: z.string(),
    }).nullable().optional(),
    repaymentType: z.enum(["daily", "weekly", "monthly", "floating"]),
    termMonths: z.number().int().nullable(),
    installmentAmount: money.nullable(),
    totalInstallments: z.number().int().nullable(),
    startDate: date.nullable(),
    nextDueDate: date.nullable(),
    outstandingPrincipal: money,
    outstandingInterest: money,
    outstandingFees: money,
    status: z.string().nullable(),
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
const disbursementEventOutput = z.object({
    ...publicEntity,
    grossAmount: money,
    loanAttributedAmount: money,
    channel: z.enum(["bank_transfer", "cash", "adjustment"]),
    status: z.enum(["draft", "posted", "reversed"]),
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
const renewalOutput = z.object({
    ...publicEntity,
    status: z.string(),
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

const toolDataSchemas: Record<McpToolName, z.ZodType<Record<string, unknown>>> = {
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
            startDate: date.nullable(),
            createdAt: nullableIsoDateTime.optional(),
        }).strict()),
    }).strict(),
    "borrower.create": borrowerOutput,
    "borrower.update": borrowerOutput,
    "borrower.alias": aliasOutput,
    "intake.get": intakeOutput.extend({
        evidence: z.array(z.object({
            ...publicEntity,
            status: z.string(),
            mimeType: z.string(),
            size: z.number().int(),
            sha256: z.string().regex(/^[0-9a-f]{64}$/i).nullable(),
            filePublicId: uuid.nullable(),
        }).strict()),
        latestProposal: proposalOutput.nullable(),
    }),
    "intake.list": z.object({ items: z.array(intakeOutput) }).strict(),
    "intake.create": z.union([
        intakeOutput.extend({ duplicate: z.literal(false), duplicateReason: z.null(), warnings: z.array(warningSchema) }),
        z.object({ ...publicEntity, status: z.string(), duplicate: z.literal(true), duplicateReason: z.string(), warnings: z.array(warningSchema) }).strict(),
    ]),
    "evidence.prepare": evidenceIntentOutput,
    "evidence.finalize": evidenceFinalOutput,
    "payment.preview": proposalOutput,
    "payment.post": intakeOutput.extend({ transactions: z.array(transactionOutput) }),
    "payment.reverse": intakeOutput.extend({ transactions: z.array(transactionOutput) }),
    "loan.preview": z.union([
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
            fullPeriodInterest: money,
            advanceInterest: money,
            netBorrowerPayout: money,
            firstPeriodStartDate: date,
            firstPeriodDueDate: date,
            periodDays: z.union([z.literal(1), z.literal(7)]),
        }).strict(),
    ]),
    "loan.draft": loanOutput,
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
    "loan.disbursement.list": z.object({
        loanPublicId: uuid,
        summary: disbursementSummaryOutput,
        events: z.array(disbursementEventOutput),
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
    "funding-source.list": z.object({ profiles: z.array(fundingProfileOutput) }).strict(),
};

const toolInputSchemas: Record<McpToolName, z.ZodType<Record<string, unknown>>> = {
    "borrower.search": z.object({ query: shortText }).strict(),
    "borrower.portfolio": z.object({ borrowerPublicId: uuid }).strict(),
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
    "payment.preview": z.object({
        paymentIntakePublicId: uuid,
        allocations: z.array(explicitAllocation).max(1_000).optional(),
    }).strict(),
    "payment.post": z.object({ paymentIntakePublicId: uuid, proposalPublicId: uuid }).strict(),
    "payment.reverse": z.object({
        paymentIntakePublicId: uuid,
        reason: shortText.optional(),
    }).strict(),
    "loan.preview": z.object(loanTerms).strict(),
    "loan.draft": z.object({
        borrowerPublicId: uuid,
        bankLoanPublicId: uuid.nullable().optional(),
        bankProfilePublicId: uuid.nullable().optional(),
        ...loanTerms,
    }).strict(),
    "loan.activate": z.object({
        loanPublicId: uuid,
        idempotencyKey: z.string().trim().min(1).max(200),
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
    "loan.disbursement.list": z.object({ loanPublicId: uuid }).strict(),
    "loan.disbursement.draft": z.object({
        loanPublicId: uuid,
        grossAmount: money,
        loanAttributedAmount: money,
        channel: z.enum(["bank_transfer", "cash", "adjustment"]),
        sourceBankProfilePublicId: uuid.nullable().optional(),
        payeeHint: optionalNullableText,
        note: optionalNullableText,
        disbursedAt: dateTime,
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
        waivedCharges: money.optional(),
        waiverReason: optionalNullableText,
    }).strict(),
    "renewal.execute": z.object({
        renewalPublicId: uuid,
        previewHash: z.string().regex(/^v\d+:[0-9a-f]{64}$/i),
        confirmed: z.literal(true),
        reason: shortText,
        idempotencyKey: z.string().trim().min(1).max(200),
    }).strict(),
    "renewal.reverse": z.object({
        renewalPublicId: uuid,
        reason: shortText,
        idempotencyKey: z.string().trim().min(1).max(200),
    }).strict(),
    "funding-source.list": z.object({ status: z.enum(["active", "closed", "all"]).optional() }).strict(),
};

const safeErrorSchema = z.object({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
    reviewRequired: z.boolean(),
    details: z.record(z.string(), z.unknown()),
}).strict();

function advertisedOutputSchema(toolName: McpToolName) {
    return successOutputSchema(toolName);
}

function successOutputSchema(toolName: McpToolName) {
    if (financialTools.has(toolName)) {
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
    "borrower.search",
    "borrower.portfolio",
    "intake.get",
    "intake.list",
    "loan.preview",
    "loan.interest-rate.list",
    "loan.disbursement.list",
    "intermediary.search",
    "intermediary.profile.get",
    "intermediary.managed-loan.list",
    "intermediary.disbursement.list",
    "intermediary.disbursement.get",
    "intermediary.collection.list",
    "intermediary.remittance.get",
    "funding-source.list",
]);
const destructiveTools = new Set<McpToolName>([
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
const financialTools = new Set<McpToolName>([
    "payment.post",
    "payment.reverse",
    "loan.activate",
    "loan.interest-rate.execute",
    "loan.settlement.execute",
    "loan.disbursement.post",
    "loan.disbursement.reverse",
    "intermediary.disbursement.post",
    "intermediary.disbursement.reverse",
    "intermediary.remittance.post",
    "renewal.execute",
    "renewal.reverse",
]);
const idempotentTools = new Set<McpToolName>([
    ...readOnlyTools,
    "intake.create",
    "payment.post",
    "payment.reverse",
    "loan.activate",
    "loan.interest-rate.execute",
    "loan.settlement.execute",
    "loan.disbursement.post",
    "loan.disbursement.reverse",
    "intermediary.bank-account.save",
    "intermediary.assignment.create",
    "intermediary.assignment.end",
    "intermediary.disbursement.create",
    "intermediary.disbursement.event.create",
    "intermediary.disbursement.post",
    "intermediary.disbursement.reverse",
    "intermediary.collection.create",
    "intermediary.remittance.create",
    "intermediary.remittance.post",
    "renewal.execute",
    "renewal.reverse",
]);

const toolDescriptions: Record<McpToolName, string> = {
    "borrower.search": "Search accessible borrowers by canonical name or confirmed alias.",
    "borrower.portfolio": "Get one accessible borrower portfolio by public UUID.",
    "borrower.create": "Create a borrower in the configured MCP tenant.",
    "borrower.update": "Update an accessible borrower by public UUID.",
    "borrower.alias": "Add, confirm, or deactivate a borrower alias.",
    "intake.get": "Get a payment intake, evidence, and latest proposal.",
    "intake.list": "List accessible payment intakes, optionally by status.",
    "intake.create": "Create an idempotent payment intake from supplied payment data.",
    "evidence.prepare": "Prepare a signed upload for payment evidence.",
    "evidence.finalize": "Verify and finalize uploaded payment evidence.",
    "payment.preview": "Preview and persist a versioned payment match proposal.",
    "payment.post": "Post a ready payment proposal atomically.",
    "payment.reverse": "Reverse a posted payment with compensating entries.",
    "loan.preview": "Preview an exact loan schedule without persistence.",
    "loan.draft": "Create an editable loan draft.",
    "loan.activate": "Activate a loan draft idempotently and create its schedule.",
    "loan.interest-rate.list": "List the effective-dated floating-interest timeline and current exact daily interest.",
    "loan.interest-rate.preview": "Preview an effective-dated floating-interest change and automatic timeline split.",
    "loan.interest-rate.execute": "Execute an explicitly confirmed floating-interest preview idempotently.",
    "loan.settlement.preview": "Preview and persist an exact floating-loan close-out composition.",
    "loan.settlement.execute": "Execute an explicitly confirmed floating-loan close-out idempotently.",
    "loan.disbursement.list": "List actual loan disbursement events and variance read-only.",
    "loan.disbursement.draft": "Create an editable actual loan disbursement draft.",
    "loan.disbursement.update": "Update supplied fields on an editable actual loan disbursement draft.",
    "loan.disbursement.evidence.prepare": "Prepare a signed upload for loan disbursement evidence.",
    "loan.disbursement.evidence.finalize": "Verify and finalize loan disbursement evidence.",
    "loan.disbursement.post": "Post an actual loan disbursement idempotently.",
    "loan.disbursement.reverse": "Reverse a posted loan disbursement with a reason.",
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
    "intermediary.remittance.get": "Inspect a remittance, allocations, and exact remaining balance.",
    "intermediary.remittance.create": "Create an idempotent intermediary remittance draft.",
    "intermediary.remittance.allocations.save": "Select exact intermediary collections for a remittance.",
    "intermediary.remittance.preview": "Preview the exact remittance reconciliation before posting.",
    "intermediary.remittance.evidence.prepare": "Prepare a signed upload for remittance-slip evidence.",
    "intermediary.remittance.evidence.finalize": "Verify and finalize remittance-slip evidence.",
    "intermediary.remittance.post": "Post a balanced, explicitly confirmed intermediary remittance.",
    "renewal.preview": "Preview a daily-loan renewal from current balances.",
    "renewal.execute": "Execute a confirmed renewal idempotently.",
    "renewal.reverse": "Reverse an executed renewal with compensating records.",
    "funding-source.list": "List tenant funding profiles and drawdowns read-only.",
};

function titleFor(toolName: McpToolName) {
    return toolName.split(/[.-]/u).map((part) => `${part[0]!.toUpperCase()}${part.slice(1)}`).join(" ");
}

function completionText(toolName: McpToolName) {
    const words = toolName.replace(/[.-]/gu, " ");
    return `${words[0]!.toUpperCase()}${words.slice(1)} completed.`;
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
        return {
            code: error.code,
            message: error.message,
            retryable: error.status === 429 || error.status >= 500,
            reviewRequired: error.status === 409 || /(AMBIGUOUS|MISMATCH|REVIEW|STALE|NOT_LATEST|OUTPUT)/u.test(error.code),
            details: sanitizeDetails(error.details),
        };
    }
    return {
        code: "INTERNAL_ERROR",
        message: "The MCP tool could not complete the request",
        retryable: true,
        reviewRequired: false,
        details: {},
    };
}

function dataRecord(value: unknown): Record<string, unknown> {
    const json = JSON.parse(JSON.stringify(value)) as unknown;
    if (Array.isArray(json)) return { items: json };
    if (json && typeof json === "object") return json as Record<string, unknown>;
    return { value: json };
}

function createServer(input: CreateMcpHttpPluginInput, ctx: CommandContext) {
    const server = new McpServer({ name: "creditsync", version: "1.0.0" }, {
        capabilities: { tools: {} },
        instructions: "CreditSync private tenant-scoped financial workflow tools. Preview before posting financial changes.",
    });
    for (const toolName of MCP_TOOL_NAMES) {
        server.registerTool(toolName, {
            title: titleFor(toolName),
            description: toolDescriptions[toolName],
            inputSchema: toolInputSchemas[toolName],
            outputSchema: advertisedOutputSchema(toolName),
            annotations: {
                title: titleFor(toolName),
                readOnlyHint: readOnlyTools.has(toolName),
                destructiveHint: destructiveTools.has(toolName),
                idempotentHint: idempotentTools.has(toolName),
                openWorldHint: false,
            },
        }, async (rawInput) => {
            const parsed = rawInput as Record<string, unknown>;
            const idempotencyKey = typeof parsed.idempotencyKey === "string" ? parsed.idempotencyKey : undefined;
            const { idempotencyKey: _removed, ...handlerInput } = parsed;
            const toolContext: CommandContext = { ...ctx, idempotencyKey };
            try {
                const result = await input.handlers[toolName](toolContext, handlerInput);
                const auditPublicIds = financialTools.has(toolName)
                    ? await input.findAuditPublicIds({ ctx: toolContext, toolName, result })
                    : undefined;
                if (financialTools.has(toolName) && auditPublicIds?.length === 0) {
                    throw new DomainError(
                        "AUDIT_METADATA_UNAVAILABLE",
                        "The financial command completed without retrievable public audit metadata",
                        503,
                    );
                }
                const structuredContent = successOutputSchema(toolName).safeParse({
                    schemaVersion: "1.0",
                    data: dataRecord(result),
                    ...(financialTools.has(toolName) ? {
                        correlationId: toolContext.correlationId,
                        auditPublicIds: auditPublicIds ?? [],
                    } : {}),
                });
                if (!structuredContent.success) {
                    throw new DomainError(
                        "INVALID_TOOL_OUTPUT",
                        "The application service returned data outside the public MCP contract",
                        422,
                    );
                }
                return {
                    content: [{ type: "text" as const, text: completionText(toolName) }],
                    structuredContent: structuredContent.data,
                };
            } catch (error) {
                const safeError = safeToolError(error);
                input.logger({
                    event: "mcp_tool_error",
                    tool: toolName,
                    requestId: toolContext.requestId,
                    correlationId: toolContext.correlationId,
                    code: safeError.code,
                });
                const structuredContent = errorOutputSchema.parse({ schemaVersion: "1.0", error: safeError });
                return {
                    isError: true,
                    content: [{ type: "text" as const, text: `${safeError.code}: ${safeError.message}` }],
                    structuredContent,
                };
            }
        });
    }
    return server;
}

function httpError(status: number, code: string, message: string, retryable = false) {
    return Response.json({ error: { code, message, retryable, reviewRequired: false, details: {} } }, {
        status,
        headers: { "cache-control": "no-store" },
    });
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

export function createMcpHttpPlugin(input: CreateMcpHttpPluginInput) {
    return new Elysia({ name: "creditsync-mcp" })
        .get("/mcp/health", ({ request }) => {
            if (!hostIsAllowed(request.headers.get("host"), input.config.allowedHosts)) {
                return httpError(403, "HOST_NOT_ALLOWED", "Host is not allowed");
            }
            return Response.json({ status: "ok", service: "creditsync-mcp", schemaVersion: "1.0" }, {
                headers: { "cache-control": "no-store" },
            });
        })
        .all("/mcp", async ({ request }) => {
            const startedAt = performance.now();
            const requestIdValue = requestId(request.headers.get("x-request-id"));
            const correlationIdValue = requestId(request.headers.get("x-correlation-id"));
            if (!hostIsAllowed(request.headers.get("host"), input.config.allowedHosts)) {
                return withRequestHeaders(httpError(403, "HOST_NOT_ALLOWED", "Host is not allowed"), requestIdValue, correlationIdValue);
            }
            if (request.method !== "POST") {
                const response = httpError(405, "METHOD_NOT_ALLOWED", "Only MCP POST requests are supported");
                response.headers.set("allow", "POST");
                return withRequestHeaders(response, requestIdValue, correlationIdValue);
            }
            const auth = authenticateBearer(request.headers.get("authorization"), input.config.tokenHashes);
            if (!auth) {
                return withRequestHeaders(httpError(401, "UNAUTHORIZED", "Unauthorized"), requestIdValue, correlationIdValue);
            }
            const rate = await input.consumeRateLimit({
                key: `${input.config.tenantId}:${auth.tokenFingerprint}`,
                max: input.config.rateLimitMax,
                windowSeconds: input.config.rateLimitWindowSeconds,
            });
            if (!rate.allowed) {
                const response = httpError(429, "RATE_LIMITED", "MCP request rate limit exceeded", true);
                response.headers.set("retry-after", String(rate.retryAfterSeconds));
                return withRequestHeaders(response, requestIdValue, correlationIdValue);
            }
            try {
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
                const server = createServer(input, ctx);
                const transport = new WebStandardStreamableHTTPServerTransport({
                    sessionIdGenerator: undefined,
                    enableJsonResponse: true,
                });
                transport.onerror = () => input.logger({
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
                    input.logger({
                        event: "mcp_request",
                        method: request.method,
                        status: response.status,
                        requestId: requestIdValue,
                        correlationId: correlationIdValue,
                        durationMs: Math.round(performance.now() - startedAt),
                    });
                    return withRequestHeaders(response, requestIdValue, correlationIdValue);
                } finally {
                    await server.close().catch(() => undefined);
                }
            } catch {
                input.logger({
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
