import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { McpToolName } from "../../../backend/src/mcp/server";

const BORROWER_A = "0198c481-3e2b-7000-8000-000000000011";
const BORROWER_B = "0198c481-3e2b-7000-8000-000000000012";
const ALIAS = "0198c481-3e2b-7000-8000-000000000013";
const INTAKE = "0198c481-3e2b-7000-8000-000000000021";
const ORIGINAL_INTAKE = "0198c481-3e2b-7000-8000-000000000022";
const EVIDENCE = "0198c481-3e2b-7000-8000-000000000023";
const EVIDENCE_FILE = "0198c481-3e2b-7000-8000-000000000025";
const PROPOSAL = "0198c481-3e2b-7000-8000-000000000024";
const LOAN_A = "0198c481-3e2b-7000-8000-000000000031";
const LOAN_B = "0198c481-3e2b-7000-8000-000000000032";
const LOAN_C = "0198c481-3e2b-7000-8000-000000000033";
const DRAFT = "0198c481-3e2b-7000-8000-000000000034";
const REPLACEMENT = "0198c481-3e2b-7000-8000-000000000035";
const REPLACEMENT_AUDIT = "0198c481-3e2b-7000-8000-000000000037";
const DUPLICATE_CANDIDATE = "0198c481-3e2b-7000-8000-000000000038";
const DUPLICATE_REVIEW = "0198c481-3e2b-7000-8000-000000000039";
const DUPLICATE_EXECUTION = "0198c481-3e2b-7000-8000-000000000040";
const CANCELLATION_PREVIEW = "0198c481-3e2b-7000-8000-000000000038";
const CANCELLATION_AUDIT = "0198c481-3e2b-7000-8000-000000000039";
const DISBURSEMENT = "0198c481-3e2b-7000-8000-000000000051";
const DISBURSEMENT_EVIDENCE = "0198c481-3e2b-7000-8000-000000000052";
const RENEWAL = "0198c481-3e2b-7000-8000-000000000041";
const RESTRUCTURE = "0198c481-3e2b-7000-8000-000000000071";
const WAIVER_PREVIEW = "0198c481-3e2b-7000-8000-000000000072";
const WAIVER = "0198c481-3e2b-7000-8000-000000000073";
const PREVIEW_HASH = `v1:${"a".repeat(64)}`;
const BALANCE_VERSION = `v1:${"b".repeat(64)}`;
const RATE_PREVIEW = "0198c481-3e2b-7000-8000-000000000061";
const SETTLEMENT = "0198c481-3e2b-7000-8000-000000000071";
const PAYMENT_EVIDENCE_BYTES = new TextEncoder().encode("payment-slip-fixture-bytes");
const DISBURSEMENT_EVIDENCE_BYTES = new TextEncoder().encode("disbursement-slip-fixture-bytes");
const FILE_HASH = createHash("sha256").update(PAYMENT_EVIDENCE_BYTES).digest("hex");
const CHATGPT_FILE = { download_url: "https://files.oaiusercontent.com/file-fixture", file_id: "file-fixture", mime_type: "image/jpeg", file_name: "slip.jpg" };
const SUPPLEMENT = "0198c481-3e2b-7000-8000-000000000026";
const DISBURSEMENT_FILE_HASH = createHash("sha256").update(DISBURSEMENT_EVIDENCE_BYTES).digest("hex");
const CHATGPT_PAYOUT_FILE_A = { download_url: "https://files.oaiusercontent.com/payout-fixture-a", file_id: "payout-file-a", mime_type: "image/jpeg", file_name: "payout-front.jpg" };
const CHATGPT_PAYOUT_FILE_B = { download_url: "https://files.oaiusercontent.com/payout-fixture-b", file_id: "payout-file-b", mime_type: "image/jpeg", file_name: "payout-receipt.jpg" };
const CHATGPT_PAYOUT_HASH_A = createHash("sha256").update("payout-file-a-bytes").digest("hex");
const CHATGPT_PAYOUT_HASH_B = createHash("sha256").update("payout-file-b-bytes").digest("hex");
const SETTLEMENT_BALANCE_VERSION = `v1:${"c".repeat(64)}`;
const SETTLEMENT_PREVIEW_HASH = `v1:${"d".repeat(64)}`;
const SETTLEMENT_EXPIRES_AT = "2026-08-15T06:15:00.000Z";
const INTERMEDIARY = "0198c481-3e2b-7000-8000-000000000081";
const INTERMEDIARY_B = "0198c481-3e2b-7000-8000-000000000082";
const INTERMEDIARY_ASSIGNMENT = "0198c481-3e2b-7000-8000-000000000083";
const INTERMEDIATED_GROUP = "0198c481-3e2b-7000-8000-000000000084";
const INTERMEDIATED_EVENTS = [
    "0198c481-3e2b-7000-8000-000000000085",
    "0198c481-3e2b-7000-8000-000000000086",
    "0198c481-3e2b-7000-8000-000000000087",
] as const;
const INTERMEDIATED_EVIDENCE = [
    "0198c481-3e2b-7000-8000-000000000088",
    "0198c481-3e2b-7000-8000-000000000089",
    "0198c481-3e2b-7000-8000-000000000090",
] as const;
const INTERMEDIATED_PREVIEW = "0198c481-3e2b-7000-8000-000000000091";
const INTERMEDIATED_EVIDENCE_FILES = [
    "0198c481-3e2b-7000-8000-000000000093",
    "0198c481-3e2b-7000-8000-000000000094",
    "0198c481-3e2b-7000-8000-000000000095",
] as const;
const INTERMEDIATED_WRONG_EVIDENCE = "0198c481-3e2b-7000-8000-000000000100";
const INTERMEDIATED_WRONG_EVIDENCE_FILE = "0198c481-3e2b-7000-8000-000000000101";
const INTERMEDIATED_AUDIT = "0198c481-3e2b-7000-8000-000000000096";
const INTERMEDIATED_CORRELATION = "0198c481-3e2b-7000-8000-000000000097";
const INTERMEDIATED_LOAN_DISBURSEMENT = "0198c481-3e2b-7000-8000-000000000098";
const INTERMEDIATED_ADVANCE_PROJECTION = "0198c481-3e2b-7000-8000-000000000099";
const COMMISSION_PARTICIPANT_A = "0198c481-3e2b-7000-8000-000000000401";
const COMMISSION_PARTICIPANT_B = "0198c481-3e2b-7000-8000-000000000402";
const COMMISSION_AUDIT = "0198c481-3e2b-7000-8000-000000000403";
const COMMISSION_CORRELATION = "0198c481-3e2b-7000-8000-000000000404";
const PAYMENT_A = "0198c481-3e2b-7000-8000-000000000405";
const PAYMENT_B = "0198c481-3e2b-7000-8000-000000000406";
const ATTRIBUTION_A = "0198c481-3e2b-7000-8000-000000000407";
const ATTRIBUTION_B = "0198c481-3e2b-7000-8000-000000000408";
const ATTRIBUTION_REVERSAL = "0198c481-3e2b-7000-8000-000000000409";
const DIAGNOSTIC_CORRELATION = "0198c481-3e2b-7000-8000-000000000501";

function commissionParticipant(publicId: string, intermediaryPublicId: string, rate: string) {
    return {
        publicId, loanPublicId: LOAN_A, intermediaryPublicId, previousParticipantPublicId: null,
        commissionRate: rate, role: "collector", note: null, effectiveFrom: "2026-08-16T00:00:00.000Z",
        effectiveTo: null, status: "active", auditPublicId: COMMISSION_AUDIT,
        correlationId: COMMISSION_CORRELATION, createdAt: "2026-08-16T00:00:00.000Z",
    };
}

function attribution(publicId: string, amount: string, sourceKind: "direct" | "intermediary", intermediaryPublicId: string | null, reversedAttributionPublicId: string | null = null) {
    return {
        publicId, paymentPublicId: PAYMENT_A, transactionPublicId: PAYMENT_A, sourceKind,
        intermediaryPublicId, amount, reason: reversedAttributionPublicId ? "Correct source attribution" : null,
        reversedAttributionPublicId, auditPublicId: COMMISSION_AUDIT,
        correlationId: COMMISSION_CORRELATION, createdAt: "2026-08-16T00:00:00.000Z",
    };
}

const commissionPreview = {
    loanPublicId: LOAN_A, paymentPublicIds: [PAYMENT_A, PAYMENT_B], interestAmount: "300.00",
    totalCommission: "90.00", participants: [{ participantPublicId: COMMISSION_PARTICIPANT_A,
        intermediaryPublicId: INTERMEDIARY, commissionRate: "30.00", commissionAmount: "90.00" }],
};

export type ToolCall = { name: McpToolName; arguments: Record<string, unknown> };
type ScriptedError = { code: string; message: string; retryable: boolean; reviewRequired: boolean; details: Record<string, unknown> };
type ScriptStep = ToolCall & { result?: Record<string, unknown>; error?: ScriptedError };
export type HarnessUploadEffect = {
    name: "evidence.put" | "disbursement-evidence.put" | "intermediated-evidence.put";
    uploadUrl: string;
    requiredHeaders: Record<string, string>;
    byteLength: number;
    sha256: string;
    bytesUnchanged: true;
};
export type HarnessSchemaValidators = {
    validateCall(name: McpToolName, args: Record<string, unknown>): void;
    validateOutput(name: McpToolName, data: Record<string, unknown>): void;
    validateError?(name: McpToolName, error: ScriptedError): void;
};
export type HarnessEvent =
    | { type: "tool"; name: McpToolName }
    | { type: "presentation"; name: "floating-settlement-preview"; data: Record<string, unknown> }
    | { type: "presentation"; name: "intermediated-disbursement-preview"; data: Record<string, unknown> }
    | { type: "presentation"; name: "loan-replacement-preview"; data: Record<string, unknown> }
    | { type: "presentation"; name: "scheduled-allocation-correction-preview"; data: Record<string, unknown> }
    | { type: "confirmation"; name: "floating-settlement" | "intermediated-disbursement" | "loan-replacement" | "scheduled-allocation-correction"; confirmed: boolean };

export type SameTaskRenewalExecutionContext = {
    provenance: "same_task_renewal_execute_result";
    retainedBorrowerPublicId: string;
    executeResult: {
        publicId: string;
        status: string;
        oldLoanPublicId: string;
        newLoanPublicId: string | null;
        [key: string]: unknown;
    };
};

export type HarnessResult = {
    calls: ToolCall[];
    effects: Array<string | HarnessUploadEffect>;
    events: HarnessEvent[];
    outcome: "completed" | "stopped";
    stopReason?: string;
    error?: { code: string; message: string; details: { downstreamEntryCount: number } };
    renewalContext?: SameTaskRenewalExecutionContext;
    inspectedLoanStates?: Array<{ publicId: string; status: string }>;
};

class ScriptedMcpError extends Error {
    constructor(readonly code: string, message: string, readonly details: Record<string, unknown>) {
        super(message);
    }
}

class ScriptedMcp {
    readonly calls: ToolCall[] = [];
    readonly effects: Array<string | HarnessUploadEffect> = [];
    readonly events: HarnessEvent[] = [];
    private cursor = 0;

    constructor(
        private readonly script: ScriptStep[],
        private readonly authorized = true,
        private readonly validators?: HarnessSchemaValidators,
    ) {}

    ensureAuthorized() {
        if (!this.authorized) throw new Error("UNAUTHORIZED");
    }

    effect(name: string) {
        this.effects.push(name);
    }

    uploadEvidence(input: {
        name: HarnessUploadEffect["name"];
        uploadUrl: string;
        requiredHeaders: Record<string, string>;
        bytes: Uint8Array;
        declaredSize: number;
        declaredSha256: string;
    }) {
        const originalBytes = Uint8Array.from(input.bytes);
        const actualSha256 = createHash("sha256").update(originalBytes).digest("hex");
        if (originalBytes.byteLength !== input.declaredSize || actualSha256 !== input.declaredSha256) {
            throw new Error("evidence fixture does not match its declared size and SHA-256");
        }
        const uploadedBytes = Uint8Array.from(originalBytes);
        if (!isDeepStrictEqual(uploadedBytes, originalBytes)) {
            throw new Error("evidence upload changed bytes");
        }
        this.effects.push({
            name: input.name,
            uploadUrl: input.uploadUrl,
            requiredHeaders: { ...input.requiredHeaders },
            byteLength: uploadedBytes.byteLength,
            sha256: createHash("sha256").update(uploadedBytes).digest("hex"),
            bytesUnchanged: true,
        });
    }

    presentFloatingSettlement(data: Record<string, unknown>) {
        this.events.push({ type: "presentation", name: "floating-settlement-preview", data });
    }

    recordFloatingSettlementConfirmation(confirmed: boolean) {
        this.events.push({ type: "confirmation", name: "floating-settlement", confirmed });
    }

    presentIntermediatedDisbursement(data: Record<string, unknown>) {
        this.events.push({ type: "presentation", name: "intermediated-disbursement-preview", data });
    }

    presentLoanReplacement(data: Record<string, unknown>) {
        this.events.push({ type: "presentation", name: "loan-replacement-preview", data });
    }

    recordLoanReplacementConfirmation(confirmed: boolean) {
        this.events.push({ type: "confirmation", name: "loan-replacement", confirmed });
    }

    recordIntermediatedDisbursementConfirmation(confirmed: boolean) {
        this.events.push({ type: "confirmation", name: "intermediated-disbursement", confirmed });
    }

    presentScheduledAllocationCorrection(data: Record<string, unknown>) {
        this.events.push({ type: "presentation", name: "scheduled-allocation-correction-preview", data });
    }

    recordScheduledAllocationCorrectionConfirmation(confirmed: boolean) {
        this.events.push({ type: "confirmation", name: "scheduled-allocation-correction", confirmed });
    }

    async call(name: McpToolName, args: Record<string, unknown>) {
        this.validators?.validateCall(name, args);
        const step = this.script[this.cursor++];
        if (!step) throw new Error(`unexpected MCP call ${name}`);
        if (step.name !== name || !isDeepStrictEqual(step.arguments, args)) {
            throw new Error(`MCP call mismatch at ${this.cursor}: expected ${step.name} ${JSON.stringify(step.arguments)}, received ${name} ${JSON.stringify(args)}`);
        }
        this.calls.push({ name, arguments: args });
        this.events.push({ type: "tool", name });
        if (step.error) {
            this.validators?.validateError?.(name, step.error);
            throw new ScriptedMcpError(step.error.code, step.error.message, step.error.details);
        }
        const result = name === "intake.get"
            ? {
                publicId: "0198c481-3e2b-7000-8000-000000000021",
                status: "fixture",
                repostOfIntakePublicId: null,
                repostedByIntakePublicId: null,
                evidence: [],
                latestProposal: null,
                cancellation: { allowed: false, stateHash: "c".repeat(64), blockedReason: null, batchPublicId: null },
                restoreCancellation: null,
                ...(step.result ?? {}),
            }
            : (step.result ?? {});
        this.validators?.validateOutput(name, result);
        return result;
    }

    assertComplete() {
        if (this.cursor !== this.script.length) {
            throw new Error(`scenario stopped before ${this.script[this.cursor]!.name} at step ${this.cursor + 1}`);
        }
    }
}

const intakeArgs = {
    amount: "500.00",
    receivedAt: "2026-08-10T10:00:00+07:00",
    payerName: "พล",
    bankReference: "BBL-680294",
    idempotencyKey: "capture-680294",
};
const noRepostLineage = { repostOfIntakePublicId: null, repostedByIntakePublicId: null };
const ALLOCATION_PREVIEW = "0198c481-3e2b-7000-8000-000000000411";
const ALLOCATION_CORRECTION = "0198c481-3e2b-7000-8000-000000000412";
const ALLOCATION_SOURCE_SCHEDULE = "0198c481-3e2b-7000-8000-000000000413";
const ALLOCATION_TARGET_SCHEDULE = "0198c481-3e2b-7000-8000-000000000414";
const ALLOCATION_SOURCE_TRANSACTION = "0198c481-3e2b-7000-8000-000000000415";
const ALLOCATION_REVERSAL_TRANSACTION = "0198c481-3e2b-7000-8000-000000000416";
const ALLOCATION_REPLACEMENT_TRANSACTION = "0198c481-3e2b-7000-8000-000000000417";

const resolverFixture = (status: string, extras: Record<string, unknown> = {}) => ({
    workflowId: "creditsync.synthetic", workflowVersion: "workflow-resolver-1.1.0", catalogVersion: "mcp-catalog-synthetic",
    policyRevision: "restore-cancellation-2026-09-21", observed: { state: "mutable", loanType: null, evidenceReady: false, restoreCancellationAllowed: null, restoreCancellationBlockedReason: null, restoreCancellationStateHash: null },
    status, nextSteps: [], blockers: [], prohibitedTools: [], reevaluateOn: "evidence_change", ...extras,
});

const allocationPreviewFixture = (status: "ready" | "blocked" = "ready") => ({
    publicId: ALLOCATION_PREVIEW, status, paymentIntakePublicId: INTAKE,
    transactionPublicId: ALLOCATION_SOURCE_TRANSACTION, loanPublicId: LOAN_A,
    source: { schedulePublicId: ALLOCATION_SOURCE_SCHEDULE, dueDate: "2026-09-06", before: { paidTotal: "200.00", paidPenalty: "0.00", remainingDue: "0.00", status: "paid" }, after: { paidTotal: "0.00", paidPenalty: "0.00", remainingDue: "200.00", status: "pending" } },
    target: { schedulePublicId: ALLOCATION_TARGET_SCHEDULE, dueDate: "2026-09-07", before: { paidTotal: "0.00", paidPenalty: "0.00", remainingDue: "200.00", status: "pending" }, after: { paidTotal: "200.00", paidPenalty: "0.00", remainingDue: "0.00", status: "paid" } },
    amount: "200.00", components: { principal: "173.92", interest: "26.08", fee: "0.00", penalty: "0.00" },
    netLoanVariance: { amount: "0.00", principal: "0.00", interest: "0.00", fee: "0.00", penalty: "0.00" },
    warnings: status === "blocked" ? [{ code: "PAYMENT_ALLOCATION_CORRECTION_DEPENDENCY", blockerPublicIds: [ALLOCATION_SOURCE_TRANSACTION] }] : [],
    previewHash: PREVIEW_HASH, expectedBalanceVersion: BALANCE_VERSION, expiresAt: "2026-09-08T12:00:00.000Z",
});
const allocationExecuteFixture = { correctionPublicId: ALLOCATION_CORRECTION, paymentIntakePublicId: INTAKE, sourceTransactionPublicId: ALLOCATION_SOURCE_TRANSACTION, compensatingTransactionPublicId: ALLOCATION_REVERSAL_TRANSACTION, replacementTransactionPublicId: ALLOCATION_REPLACEMENT_TRANSACTION, sourceSchedulePublicId: ALLOCATION_SOURCE_SCHEDULE, targetSchedulePublicId: ALLOCATION_TARGET_SCHEDULE, amount: "200.00", components: { principal: "173.92", interest: "26.08", fee: "0.00", penalty: "0.00" }, auditPublicId: "0198c481-3e2b-7000-8000-000000000418", correlationId: "0198c481-3e2b-7000-8000-000000000419" };

const allocations = [
    { borrowerPublicId: BORROWER_A, loanPublicId: LOAN_A, amount: "200.00" },
    { borrowerPublicId: BORROWER_A, loanPublicId: LOAN_B, amount: "150.00" },
    { borrowerPublicId: BORROWER_A, loanPublicId: LOAN_C, amount: "150.00" },
];
const partialAllocation = [{ borrowerPublicId: BORROWER_A, loanPublicId: LOAN_A, amount: "500.00" }];
const mismatchAllocations = [
    allocations[0],
    allocations[1],
    { borrowerPublicId: BORROWER_A, loanPublicId: LOAN_C, amount: "140.00" },
];

const replacementTerms = {
    interestRate: "0.00", termMonths: 1,
    repaymentType: "monthly", startDate: "2026-08-19",
};

async function restructureFlow(mcp: ScriptedMcp, confirmed = true) {
    const search = await mcp.call("borrower.search", { query: "พี่เกมส์" });
    if (search.resolution !== "unique") return { outcome: "stopped", stopReason: "ambiguous-borrower" } as const;
    await mcp.call("borrower.portfolio", { borrowerPublicId: BORROWER_A });
    const preview = await mcp.call("loan.restructure.preview", {
        oldLoanPublicId: LOAN_A, settlementDate: "2026-08-19", replacementTerms,
        additionalPrincipal: "1000.00", reason: "Owner requested a monthly replacement contract",
    });
    if (preview.cash && (preview.cash as { amount?: string }).amount !== "1000.00") {
        return { outcome: "stopped", stopReason: "unexpected-additional-cash" } as const;
    }
    if (!confirmed) return { outcome: "stopped", stopReason: "restructure-confirmation-required" } as const;
    try {
        await mcp.call("loan.restructure.execute", {
            restructurePublicId: preview.publicId, previewHash: preview.previewHash,
            expectedBalanceVersion: preview.oldBalanceVersion, confirmed: true,
            reason: "Owner confirmed the exact settlement and replacement",
            idempotencyKey: "restructure-execute-20260819-1",
        });
        return { outcome: "completed" } as const;
    } catch (error) {
        if (error instanceof ScriptedMcpError && /STALE|EXPIRED/u.test(error.code)) return { outcome: "stopped", stopReason: "stale-restructure-preview" } as const;
        throw error;
    }
}

function replacementPreviewResult() {
    return {
        publicId: REPLACEMENT,
        previewHash: PREVIEW_HASH,
        oldBalanceVersion: BALANCE_VERSION,
        replacementDraftVersion: BALANCE_VERSION,
        expiresAt: "2026-08-17T06:30:00.000Z",
        auditPublicId: REPLACEMENT_AUDIT,
        correlationId: REPLACEMENT_AUDIT,
        schemaVersion: 1,
        asOfDate: "2026-08-17",
        reason: "Correct contract start date while preserving the first due date",
        oldLoan: {
            loanPublicId: LOAN_A, statusBefore: "active", statusAfter: "replaced", principal: "36000.00",
            collectibleBefore: { principal: "36000.00", interest: "4200.00", fee: "0.00", penalty: "0.00", nextDueDate: "2026-07-13" },
            collectibleAfter: { principal: "0.00", interest: "0.00", fee: "0.00", penalty: "0.00", nextDueDate: null },
        },
        cash: { direction: "none", amount: "0.00" },
        correction: { principal: "36000.00", interest: "4200.00", fee: "0.00", penalty: "0.00" },
        replacement: {
            loanPublicId: DRAFT, statusBefore: "draft", statusAfter: "active", principal: "36000.00",
            interestRate: "0.00", repaymentType: "daily", termMonths: 7, totalInstallments: 200,
            installmentAmount: "300.00", startDate: "2026-07-11", firstDueDate: "2026-07-12",
            lastDueDate: "2027-01-27", totalRepayment: "60000.00", fundingSourceKind: "drawdown",
            fundingSourcePublicId: "0198c481-3e2b-7000-8000-000000000036",
            fundingSourceName: "TTB",
        },
        warnings: [{
            code: "OUTSTANDING_INTEREST_CORRECTED_TO_ZERO",
            details: { amount: "4200.00", correctedAmount: "0.00", collected: false, carriedForward: false },
        }],
    };
}

function replacementPortfolio(options: {
    borrowerPublicId?: string;
    oldLoanStatus?: "active" | "replaced";
    replacementDraftStatus?: "draft" | "active" | "cancelled";
} = {}) {
    return {
        borrower: { publicId: options.borrowerPublicId ?? BORROWER_A, name: "Replacement Borrower" },
        aliases: [],
        loans: [
            {
                publicId: LOAN_A,
                principal: "36000.00",
                interestRate: "0.00",
                repaymentType: "daily",
                status: options.oldLoanStatus ?? "active",
                replacementLineage: null,
                startDate: "2026-07-12",
            },
            {
                publicId: DRAFT,
                principal: "36000.00",
                interestRate: "0.00",
                repaymentType: "daily",
                status: options.replacementDraftStatus ?? "draft",
                replacementLineage: null,
                startDate: "2026-07-11",
            },
        ],
    };
}

function inspectedReplacementCandidates(portfolio: Record<string, unknown>, borrowerPublicId: string) {
    const borrower = portfolio.borrower as { publicId?: unknown } | undefined;
    const loans = portfolio.loans;
    // The portfolio itself is the authoritative borrower-owner scope. Never
    // select a loan merely because it was returned by a search or a stale UI.
    if (borrower?.publicId !== borrowerPublicId || !Array.isArray(loans)) return null;
    const candidates = loans.filter((loan): loan is Record<string, unknown> =>
        typeof loan === "object" && loan !== null && typeof (loan as { publicId?: unknown }).publicId === "string");
    const oldLoan = candidates.find((loan) => loan.status === "active" && loan.replacementLineage === null);
    const replacementDraft = candidates.find((loan) => loan.status === "draft" && loan.replacementLineage === null);
    if (!oldLoan || !replacementDraft || oldLoan.publicId === replacementDraft.publicId) return null;
    return {
        oldLoanPublicId: oldLoan.publicId as string,
        replacementDraftPublicId: replacementDraft.publicId as string,
    };
}

async function replacementFlow(mcp: ScriptedMcp, confirmed = true) {
    const search = await mcp.call("borrower.search", { query: "Replacement Borrower" });
    const borrowerPublicId = (search.candidates as Array<{ publicId?: unknown }> | undefined)?.[0]?.publicId;
    if (search.resolution !== "unique" || typeof borrowerPublicId !== "string") {
        return { outcome: "stopped", stopReason: "replacement-borrower-ambiguous" } as const;
    }
    const portfolio = await mcp.call("borrower.portfolio", { borrowerPublicId });
    const candidates = inspectedReplacementCandidates(portfolio, borrowerPublicId);
    if (!candidates) return { outcome: "stopped", stopReason: "replacement-portfolio-scope-invalid" } as const;
    let preview: Record<string, unknown>;
    try {
        preview = await mcp.call("loan.replacement.preview", {
            ...candidates,
            reason: "Correct contract start date while preserving the first due date",
        });
    } catch (error) {
        if (error instanceof ScriptedMcpError && /DOWNSTREAM|DRAFT/u.test(error.code)) {
            return { outcome: "stopped", stopReason: "replacement-downstream-activity" } as const;
        }
        throw error;
    }
    mcp.presentLoanReplacement(preview);
    mcp.recordLoanReplacementConfirmation(confirmed);
    if (!confirmed) return { outcome: "stopped", stopReason: "replacement-confirmation-required" } as const;
    try {
        await mcp.call("loan.replacement.execute", {
            replacementPublicId: preview.publicId,
            previewHash: preview.previewHash,
            expectedOldBalanceVersion: preview.oldBalanceVersion,
            expectedReplacementDraftVersion: preview.replacementDraftVersion,
            confirmed: true,
            reason: "Owner confirmed the exact fresh no-cash replacement proposal",
            idempotencyKey: "loan-replacement-execute-20260817-1",
        });
        return { outcome: "completed" } as const;
    } catch (error) {
        if (!(error instanceof ScriptedMcpError) || !/STALE|EXPIRED/u.test(error.code)) throw error;
        const refreshedPortfolio = await mcp.call("borrower.portfolio", { borrowerPublicId });
        const refreshedCandidates = inspectedReplacementCandidates(refreshedPortfolio, borrowerPublicId);
        if (!refreshedCandidates) return { outcome: "stopped", stopReason: "replacement-portfolio-scope-invalid" } as const;
        const fresh = await mcp.call("loan.replacement.preview", {
            ...refreshedCandidates,
            reason: "Correct contract start date while preserving the first due date",
        });
        mcp.presentLoanReplacement(fresh);
        mcp.recordLoanReplacementConfirmation(false);
        return { outcome: "stopped", stopReason: "fresh-replacement-confirmation-required" } as const;
    }
}

async function waiverFlow(mcp: ScriptedMcp, reason?: string) {
    await mcp.call("borrower.portfolio", { borrowerPublicId: BORROWER_A });
    if (!reason?.trim()) return { outcome: "stopped", stopReason: "waiver-reason-required" } as const;
    const preview = await mcp.call("loan.waiver.preview", { loanPublicId: LOAN_B, component: "interest", amount: "100.00", reason });
    await mcp.call("loan.waiver.execute", {
        previewPublicId: preview.publicId, previewHash: preview.previewHash,
        expectedBalanceVersion: preview.balanceVersion, confirmed: true, reason,
        idempotencyKey: "waiver-execute-20260819-1",
    });
    return { outcome: "completed" } as const;
}

async function paymentFlow(mcp: ScriptedMcp, options: {
    evidence?: boolean;
    explicitAllocations?: typeof allocations;
    preflight?: boolean;
}) {
    const intake = await mcp.call("intake.create", intakeArgs);
    if (intake.duplicate === true) {
        await mcp.call("intake.get", { paymentIntakePublicId: intake.publicId });
        return { outcome: "stopped", stopReason: "duplicate" } as const;
    }
    if (options.evidence) {
        try {
            const prepared = await mcp.call("evidence.prepare", {
                paymentIntakePublicId: INTAKE,
                mimeType: "image/jpeg",
                size: PAYMENT_EVIDENCE_BYTES.byteLength,
                sha256: FILE_HASH,
                evidenceType: "slip",
            });
            if (prepared.duplicate === true) {
                await mcp.call("intake.get", { paymentIntakePublicId: prepared.intakePublicId });
                return { outcome: "stopped", stopReason: "duplicate-evidence" } as const;
            }
            if (typeof prepared.uploadUrl !== "string" || !prepared.requiredHeaders) {
                return { outcome: "stopped", stopReason: "evidence-upload-unavailable" } as const;
            }
            mcp.uploadEvidence({
                name: "evidence.put",
                uploadUrl: prepared.uploadUrl,
                requiredHeaders: prepared.requiredHeaders as Record<string, string>,
                bytes: PAYMENT_EVIDENCE_BYTES,
                declaredSize: PAYMENT_EVIDENCE_BYTES.byteLength,
                declaredSha256: FILE_HASH,
            });
            const finalized = await mcp.call("evidence.finalize", {
                paymentIntakePublicId: INTAKE,
                evidencePublicId: prepared.publicId,
            });
            if (finalized.status !== "ready"
                || finalized.publicId !== prepared.publicId
                || (prepared.filePublicId !== undefined && finalized.filePublicId !== prepared.filePublicId)
                || (finalized.mimeType !== undefined && finalized.mimeType !== "image/jpeg")
                || (finalized.size !== undefined && finalized.size !== PAYMENT_EVIDENCE_BYTES.byteLength)
                || (finalized.sha256 !== undefined && finalized.sha256 !== FILE_HASH)) {
                return { outcome: "stopped", stopReason: "evidence-binding-mismatch" } as const;
            }
        } catch (error) {
            if (error instanceof ScriptedMcpError) return { outcome: "stopped", stopReason: "evidence-failure" } as const;
            throw error;
        }
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const proposal = await mcp.call("payment.preview", {
            paymentIntakePublicId: INTAKE,
            ...(options.explicitAllocations ? { allocations: options.explicitAllocations } : {}),
        });
        if (proposal.status === "stale") {
            await mcp.call("intake.get", { paymentIntakePublicId: INTAKE });
            continue;
        }
        if (proposal.status !== "ready") return { outcome: "stopped", stopReason: String(proposal.status) } as const;
        if (options.preflight) {
            try {
                const preflight = await mcp.call("payment.reconcile.preflight", { paymentIntakePublicId: INTAKE, proposalPublicId: proposal.publicId, reason: "Normal payment execution preflight" });
                if (preflight.status !== "ready_to_execute" || preflight.wouldWrite !== false || preflight.reviewRequired !== false) return { outcome: "stopped", stopReason: "payment-preflight-review-required" } as const;
            } catch (error) {
                if (error instanceof ScriptedMcpError) return { outcome: "stopped", stopReason: "payment-preflight-review-required" } as const;
                throw error;
            }
        }
        await mcp.call("payment.post", {
            paymentIntakePublicId: INTAKE,
            proposalPublicId: proposal.publicId,
        });
        return { outcome: "completed" } as const;
    }
    return { outcome: "stopped", stopReason: "stale" } as const;
}

async function paymentRestoreEvidenceFlow(mcp: ScriptedMcp) {
    const draft = await mcp.call("payment.restore.create", {
        paymentIntakePublicId: INTAKE,
        reason: "Restore corrected 08/09 payment after posting 07/09",
        idempotencyKey: "restore-draft-20260908-1",
    });
    const prepared = await mcp.call("payment.restore.evidence.prepare", {
        restoreDraftPublicId: draft.restoreDraftPublicId,
        mimeType: "image/jpeg",
        size: PAYMENT_EVIDENCE_BYTES.byteLength,
        sha256: FILE_HASH,
        originalName: "corrected-slip.jpg",
    });
    mcp.uploadEvidence({
        name: "evidence.put",
        uploadUrl: String(prepared.uploadUrl),
        requiredHeaders: prepared.requiredHeaders as Record<string, string>,
        bytes: PAYMENT_EVIDENCE_BYTES,
        declaredSize: PAYMENT_EVIDENCE_BYTES.byteLength,
        declaredSha256: FILE_HASH,
    });
    const finalized = await mcp.call("payment.restore.evidence.finalize", {
        restoreDraftPublicId: draft.restoreDraftPublicId,
        evidencePublicId: prepared.evidencePublicId,
    });
    if (finalized.status !== "ready" || finalized.evidencePublicId !== prepared.evidencePublicId || finalized.filePublicId !== prepared.filePublicId) {
        return { outcome: "stopped", stopReason: "restore-evidence-binding-mismatch" } as const;
    }
    return { outcome: "completed" } as const;
}

async function chatGptPaymentFlow(mcp: ScriptedMcp, retry = false) {
    await mcp.call("intake.create", intakeArgs);
    try {
        await mcp.call("evidence.import-chatgpt-file", { paymentIntakePublicId: INTAKE, idempotencyKey: "chatgpt-import-1", chatgptFile: CHATGPT_FILE });
        if (retry) await mcp.call("evidence.import-chatgpt-file", { paymentIntakePublicId: INTAKE, idempotencyKey: "chatgpt-import-1", chatgptFile: CHATGPT_FILE });
    } catch (error) {
        if (error instanceof ScriptedMcpError) return { outcome: "stopped", stopReason: "chatgpt-file-unavailable" } as const;
        throw error;
    }
    const proposal = await mcp.call("payment.preview", { paymentIntakePublicId: INTAKE });
    if (retry) return { outcome: "completed" } as const;
    await mcp.call("payment.reconcile.preflight", { paymentIntakePublicId: INTAKE, proposalPublicId: proposal.publicId, reason: "Normal payment execution preflight" });
    await mcp.call("payment.post", { paymentIntakePublicId: INTAKE, proposalPublicId: proposal.publicId });
    return { outcome: "completed" } as const;
}

async function createBorrowerAlias(mcp: ScriptedMcp) {
    const search = await mcp.call("borrower.search", { query: "นก (Nok)" });
    if (search.resolution !== "none") return { outcome: "stopped", stopReason: "existing-candidate" } as const;
    const borrower = await mcp.call("borrower.create", { name: "กนกพิชญ์ เลิศพรหมมกุล", phone: "0812345678" });
    await mcp.call("borrower.portfolio", { borrowerPublicId: borrower.publicId });
    const alias = await mcp.call("borrower.alias", {
        action: "add",
        borrowerPublicId: borrower.publicId,
        alias: "นก",
        source: "manual",
    });
    await mcp.call("borrower.alias", { action: "confirm", aliasPublicId: alias.publicId });
    return { outcome: "completed" } as const;
}

const loanTerms = {
    principal: "2500.00",
    interestRate: "14.00",
    termMonths: 1,
    repaymentType: "daily",
    startDate: "2026-08-11",
    totalInstallments: 15,
    installmentAmount: "190.00",
} as const;

const RENEWAL_COMPOSITION_FIELDS = {
    settlementPolicy: "full_contract_interest",
    renewalDate: "2026-08-10",
    paymentStartDate: "2026-08-11",
    composition: {
        settlementPolicy: "full_contract_interest",
        contractStartDate: "2026-08-01",
        contractDueDate: "2026-08-24",
        renewalDate: "2026-08-10",
        requestedPrincipal: "2000.00",
        originalPrincipal: "2000.00",
        totalScheduledAmount: "2400.00",
        contractualInterest: "400.00",
        totalPaid: "1000.00",
        receivedPrincipal: "833.33",
        receivedInterest: "166.67",
        remainingContractInterest: "233.33",
        accruedDueInterest: "0.00",
        dueFees: "0.00",
        duePenalties: "0.00",
        recoveredBeforeAdjustments: "600.00",
        manualCharges: "0.00",
        manualWaivers: "0.00",
        settlementAmount: "233.33",
        cashDirection: "payout",
        cashAmount: "600.00",
        payments: [],
        adjustments: [],
    },
} as const;

const EXECUTED_RENEWAL_RESULT = {
    ...RENEWAL_COMPOSITION_FIELDS,
    publicId: RENEWAL,
    status: "executed",
    oldLoanPublicId: LOAN_A,
    newLoanPublicId: LOAN_B,
    previewHash: PREVIEW_HASH,
    principalPaid: "833.33",
    outstandingPrincipal: "1166.67",
    dueCharges: "233.33",
    settlementAmount: "233.33",
    waivedCharges: "0.00",
    requestedPrincipal: "2000.00",
    cashDirection: "payout",
    cashAmount: "600.00",
} satisfies SameTaskRenewalExecutionContext["executeResult"];

const SAME_TASK_RENEWAL_CONTEXT: SameTaskRenewalExecutionContext = {
    provenance: "same_task_renewal_execute_result",
    retainedBorrowerPublicId: BORROWER_A,
    executeResult: EXECUTED_RENEWAL_RESULT,
};

const RENEWAL_PORTFOLIO = {
    borrower: { publicId: BORROWER_A, name: "fixture" },
    aliases: [],
    loans: [
        { publicId: LOAN_A, principal: "2500.00", interestRate: "14.00", repaymentType: "daily", status: "renewed", replacementLineage: null, startDate: "2026-07-01" },
        { publicId: LOAN_B, principal: "2500.00", interestRate: "14.00", repaymentType: "daily", status: "active", replacementLineage: null, startDate: "2026-08-11" }
    ]
};

async function loanActivation(mcp: ScriptedMcp) {
    const search = await mcp.call("borrower.search", { query: "กนกพิชญ์" });
    const borrowerPublicId = (search.candidates as Array<{ publicId: string }>)[0]!.publicId;
    await mcp.call("borrower.portfolio", { borrowerPublicId });
    await mcp.call("loan.preview", loanTerms);
    const draft = await mcp.call("loan.draft", { borrowerPublicId, ...loanTerms });
    await mcp.call("loan.activate", {
        loanPublicId: draft.publicId,
        idempotencyKey: "loan-activation-20260811-1",
    });
    return { outcome: "completed" } as const;
}

async function floatingSettlement(
    mcp: ScriptedMcp,
    options: { confirmed?: boolean; refundRequested?: boolean } = {},
) {
    await mcp.call("borrower.portfolio", { borrowerPublicId: BORROWER_A });
    const preview = await mcp.call("loan.settlement.preview", {
        loanPublicId: LOAN_A,
        asOfDate: "2026-08-15",
    });
    presentFloatingSettlementPreview(mcp, preview);
    if (options.refundRequested && preview.nonRefundableAdvanceInterest !== "0.00") {
        return { outcome: "stopped", stopReason: "advance-interest-non-refundable" } as const;
    }
    const confirmed = options.confirmed === true;
    mcp.recordFloatingSettlementConfirmation(confirmed);
    if (!confirmed) {
        return { outcome: "stopped", stopReason: "settlement-confirmation-required" } as const;
    }
    try {
        await mcp.call("loan.settlement.execute", {
            settlementPublicId: preview.publicId,
            previewHash: preview.previewHash,
            confirmed: true,
            reason: "Borrower confirmed the exact displayed close-out",
            idempotencyKey: "floating-settlement-20260815-1",
        });
        return { outcome: "completed" } as const;
    } catch (error) {
        if (!(error instanceof ScriptedMcpError) || error.code !== "STALE_SETTLEMENT_PREVIEW") throw error;
        await mcp.call("borrower.portfolio", { borrowerPublicId: BORROWER_A });
        const freshPreview = await mcp.call("loan.settlement.preview", {
            loanPublicId: LOAN_A,
            asOfDate: "2026-08-15",
        });
        presentFloatingSettlementPreview(mcp, freshPreview);
        mcp.recordFloatingSettlementConfirmation(false);
        return { outcome: "stopped", stopReason: "fresh-settlement-confirmation-required" } as const;
    }
}

function presentFloatingSettlementPreview(mcp: ScriptedMcp, preview: Record<string, unknown>) {
    mcp.presentFloatingSettlement({
        publicId: preview.publicId,
        outstandingPrincipal: preview.outstandingPrincipal,
        dueInterest: preview.dueInterest,
        accruedNotDueInterest: preview.accruedNotDueInterest,
        outstandingFees: preview.outstandingFees,
        outstandingPenalties: preview.outstandingPenalties,
        nonRefundableAdvanceInterest: preview.nonRefundableAdvanceInterest,
        settlementTotal: preview.settlementTotal,
        expiresAt: preview.expiresAt,
        balanceVersion: preview.balanceVersion,
        previewHash: preview.previewHash,
    });
}

const disbursementDraftArgs = {
    loanPublicId: LOAN_A,
    grossAmount: "2500.00",
    loanAttributedAmount: "2500.00",
    channel: "bank_transfer",
    disbursedAt: "2026-08-10T11:00:00+07:00",
    payeeHint: "Borrower verified payout account",
} as const;

async function disbursementLifecycle(mcp: ScriptedMcp, options: { postConfirmed?: boolean; reverseConfirmed?: boolean } = {}) {
    await mcp.call("loan.disbursement.list", { loanPublicId: LOAN_A });
    const draft = await mcp.call("loan.disbursement.draft", disbursementDraftArgs);
    const evidence = await disbursementEvidence(mcp, draft.publicId as string);
    if (evidence.outcome === "stopped") return evidence;
    const current = await mcp.call("loan.disbursement.list", { loanPublicId: LOAN_A });
    if ((current.summary as { status: string }).status !== "matched") return { outcome: "stopped", stopReason: "variance-review-required" } as const;
    if (!options.postConfirmed) return { outcome: "stopped", stopReason: "disbursement-post-confirmation-required" } as const;
    await mcp.call("loan.disbursement.post", {
        disbursementPublicId: draft.publicId as string,
        idempotencyKey: "disbursement-post-20260810-1",
    });
    if (!options.reverseConfirmed) return { outcome: "completed" } as const;
    const afterPost = await mcp.call("loan.disbursement.list", { loanPublicId: LOAN_A });
    const posted = (afterPost.events as Array<{ publicId: string; status: string }>).find(
        (event) => event.publicId === draft.publicId && event.status === "posted",
    );
    if (!posted) return { outcome: "stopped", stopReason: "disbursement-posted-event-not-found" } as const;
    await mcp.call("loan.disbursement.reverse", {
        disbursementPublicId: posted.publicId,
        reason: "Owner confirmed duplicate payout record",
        idempotencyKey: "disbursement-reverse-20260810-1",
    });
    return { outcome: "completed" } as const;
}

async function disbursementEvidence(mcp: ScriptedMcp, disbursementPublicId: string) {
    let prepared: Record<string, unknown>;
    try {
        prepared = await mcp.call("loan.disbursement.evidence.prepare", {
            disbursementPublicId,
            mimeType: "image/jpeg",
            size: DISBURSEMENT_EVIDENCE_BYTES.byteLength,
            sha256: DISBURSEMENT_FILE_HASH,
            originalName: "payout-slip.jpg",
        });
    } catch (error) {
        if (error instanceof ScriptedMcpError && error.code === "EVIDENCE_HASH_CONFLICT") {
            return { outcome: "stopped", stopReason: "disbursement-evidence-conflict" } as const;
        }
        throw error;
    }
    if (prepared.status === "ready") return { outcome: "completed", evidenceStatus: "ready" } as const;
    const expiresAt = typeof prepared.expiresAt === "string" ? Date.parse(prepared.expiresAt) : Number.NaN;
    if (typeof prepared.uploadUrl !== "string" || !prepared.requiredHeaders || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        return { outcome: "stopped", stopReason: "disbursement-evidence-upload-unavailable" } as const;
    }
    mcp.uploadEvidence({
        name: "disbursement-evidence.put",
        uploadUrl: prepared.uploadUrl,
        requiredHeaders: prepared.requiredHeaders as Record<string, string>,
        bytes: DISBURSEMENT_EVIDENCE_BYTES,
        declaredSize: DISBURSEMENT_EVIDENCE_BYTES.byteLength,
        declaredSha256: DISBURSEMENT_FILE_HASH,
    });
    try {
        await mcp.call("loan.disbursement.evidence.finalize", {
            disbursementPublicId,
            evidencePublicId: prepared.publicId as string,
        });
    } catch (error) {
        if (error instanceof ScriptedMcpError && ["EVIDENCE_MISMATCH", "EVIDENCE_NOT_FOUND", "EVIDENCE_NOT_ATTACHED"].includes(error.code)) {
            return { outcome: "stopped", stopReason: "disbursement-evidence-finalize-failed" } as const;
        }
        throw error;
    }
    return { outcome: "completed", evidenceStatus: "finalized" } as const;
}

async function disbursementIdempotencyConflict(mcp: ScriptedMcp) {
    const draft = await mcp.call("loan.disbursement.draft", disbursementDraftArgs);
    try {
        await mcp.call("loan.disbursement.post", {
            disbursementPublicId: draft.publicId as string,
            idempotencyKey: "disbursement-post-20260810-1",
        });
        return { outcome: "completed" } as const;
    } catch (error) {
        if (error instanceof ScriptedMcpError && error.code === "IDEMPOTENCY_KEY_CONFLICT") {
            return { outcome: "stopped", stopReason: "disbursement-idempotency-conflict" } as const;
        }
        throw error;
    }
}

function chatGptPayoutImportStep(file: typeof CHATGPT_PAYOUT_FILE_A, key: string, evidencePublicId: string, filePublicId: string, sha256: string): ScriptStep {
    return {
        name: "loan.disbursement.evidence.import-chatgpt-file",
        arguments: { disbursementPublicId: DISBURSEMENT, idempotencyKey: key, chatgptFile: file },
        result: { publicId: evidencePublicId, filePublicId, status: "ready", sha256, auditPublicId: COMMISSION_AUDIT, correlationId: COMMISSION_CORRELATION },
    };
}

function chatGptPayoutDraftStep(): ScriptStep {
    return {
        name: "loan.disbursement.draft",
        arguments: disbursementDraftArgs,
        result: {
            publicId: DISBURSEMENT, grossAmount: "2500.00", loanAttributedAmount: "2500.00", channel: "bank_transfer", status: "draft",
            restructurePublicId: null, sourceBankProfilePublicId: null, payeeHint: "Borrower verified payout account", note: null,
            disbursedAt: "2026-08-10T11:00:00+07:00", postedAt: null, reversedAt: null, evidenceFilePublicIds: [],
        },
    };
}

function chatGptPayoutListStep(evidenceFilePublicIds: string[], payeeHint = "Borrower verified payout account"): ScriptStep {
    return {
        name: "loan.disbursement.list",
        arguments: { loanPublicId: LOAN_A },
        result: {
            loanPublicId: LOAN_A,
            summary: { approvedPrincipal: "2500.00", netDisbursed: "2500.00", variance: "0.00", status: "matched" },
            events: [{ publicId: DISBURSEMENT, grossAmount: "2500.00", loanAttributedAmount: "2500.00", channel: "bank_transfer", status: "draft", restructurePublicId: null, sourceBankProfilePublicId: null, payeeHint, note: null, disbursedAt: "2026-08-10T11:00:00+07:00", postedAt: null, reversedAt: null, evidenceFilePublicIds }],
        },
    };
}

async function chatGptPayoutEvidenceFlow(mcp: ScriptedMcp, options: { retry?: boolean; post?: boolean; recipientMismatch?: boolean } = {}) {
    const draft = await mcp.call("loan.disbursement.draft", disbursementDraftArgs);
    const importArgs = { disbursementPublicId: draft.publicId as string, idempotencyKey: "payout-import-a", chatgptFile: CHATGPT_PAYOUT_FILE_A };
    try {
        await mcp.call("loan.disbursement.evidence.import-chatgpt-file", importArgs);
        if (options.retry) await mcp.call("loan.disbursement.evidence.import-chatgpt-file", importArgs);
        if (!options.retry) await mcp.call("loan.disbursement.evidence.import-chatgpt-file", { disbursementPublicId: draft.publicId as string, idempotencyKey: "payout-import-b", chatgptFile: CHATGPT_PAYOUT_FILE_B });
    } catch (error) {
        if (error instanceof ScriptedMcpError) return { outcome: "stopped", stopReason: "chatgpt-payout-evidence-review-required" } as const;
        throw error;
    }
    const inspected = await mcp.call("loan.disbursement.list", { loanPublicId: LOAN_A });
    const event = (inspected.events as Array<{ publicId?: unknown; evidenceFilePublicIds?: unknown; payeeHint?: unknown }>).find((candidate) => candidate.publicId === draft.publicId);
    if (!event || !Array.isArray(event.evidenceFilePublicIds) || event.evidenceFilePublicIds.length !== (options.retry ? 1 : 2)) {
        return { outcome: "stopped", stopReason: "chatgpt-payout-evidence-incomplete" } as const;
    }
    if (options.recipientMismatch || event.payeeHint !== "Borrower verified payout account") {
        return { outcome: "stopped", stopReason: "chatgpt-payout-recipient-review-required" } as const;
    }
    if (!options.post) return { outcome: "completed" } as const;
    await mcp.call("loan.disbursement.post", { disbursementPublicId: draft.publicId as string, idempotencyKey: "payout-post-after-evidence" });
    return { outcome: "completed" } as const;
}

async function renewalExecute(mcp: ScriptedMcp, operatorConfirmed = true, settlementPolicy?: "accrued_to_date") {
    await mcp.call("borrower.portfolio", { borrowerPublicId: BORROWER_A });
    const preview = await mcp.call("renewal.preview", { oldLoanPublicId: LOAN_A, requestedPrincipal: "2000.00", ...(settlementPolicy ? { settlementPolicy } : {}) });
    if (preview.cashDirection === "collection") return { outcome: "stopped", stopReason: "collection-acknowledgement-required" } as const;
    if (!operatorConfirmed) return { outcome: "stopped", stopReason: "confirmation-required" } as const;
    const executeResult = await mcp.call("renewal.execute", {
        renewalPublicId: preview.publicId,
        previewHash: preview.previewHash,
        confirmed: true,
        reason: "Owner confirmed the displayed renewal",
        idempotencyKey: "renewal-execute-20260810-1",
    });
    return {
        outcome: "completed",
        renewalContext: {
            provenance: "same_task_renewal_execute_result",
            retainedBorrowerPublicId: BORROWER_A,
            executeResult: executeResult as SameTaskRenewalExecutionContext["executeResult"],
        },
    } as const;
}

async function reverseRenewal(
    mcp: ScriptedMcp,
    context?: Partial<SameTaskRenewalExecutionContext> & {
        executeResult?: Partial<SameTaskRenewalExecutionContext["executeResult"]>;
    },
) {
    const executeResult = context?.executeResult;
    if (context?.provenance !== "same_task_renewal_execute_result" || !context.retainedBorrowerPublicId || !executeResult?.publicId || !executeResult.oldLoanPublicId || !executeResult.newLoanPublicId) {
        return { outcome: "stopped", stopReason: "use-web-renewal-detail" } as const;
    }
    const renewalContext = context as SameTaskRenewalExecutionContext;
    const portfolio = await mcp.call("borrower.portfolio", {
        borrowerPublicId: renewalContext.retainedBorrowerPublicId,
    });
    const relevantLoanIds = new Set([executeResult.oldLoanPublicId, executeResult.newLoanPublicId]);
    const inspectedLoanStates = (portfolio.loans as Array<{ publicId: string; status: string }>)
        .filter((loan) => relevantLoanIds.has(loan.publicId))
        .map((loan) => ({ publicId: loan.publicId, status: loan.status }));
    try {
        await mcp.call("renewal.reverse", {
            renewalPublicId: executeResult.publicId,
            reason: "Owner confirmed renewal reversal; backend must atomically check downstream activity",
            idempotencyKey: "renewal-reverse-20260810-1",
        });
        return { outcome: "completed", renewalContext, inspectedLoanStates } as const;
    } catch (error) {
        if (error instanceof ScriptedMcpError && error.code === "RENEWAL_REVERSE_BLOCKED") {
            const downstreamEntryCount = error.details.downstreamEntryCount;
            if (typeof downstreamEntryCount !== "number") throw error;
            return {
                outcome: "stopped",
                stopReason: "renewal-reverse-blocked",
                error: {
    code: error.code,
    message: error.message,
    details: { downstreamEntryCount },
    retryable: false,
    reviewRequired: false
},
                renewalContext,
                inspectedLoanStates,
            } as const;
        }
        throw error;
    }
}

const intermediarySearchQuery = "MCP exact intermediary";
const intermediatedGroupArgs = {
    loanPublicId: LOAN_A,
    intermediaryPublicId: INTERMEDIARY,
    retainedBalance: "0.00",
    note: "Exact three-leg disbursement",
    idempotencyKey: "intermediated-group-20260813-1",
};
const intermediatedEventSpecs = [
    {
        publicId: INTERMEDIATED_EVENTS[0],
        role: "funding_to_intermediary",
        amount: "5000.00",
        senderHint: "Owner funding account",
        payeeHint: "MCP exact intermediary",
        bankReference: "INTERMEDIATED-FUNDING-1",
    },
    {
        publicId: INTERMEDIATED_EVENTS[1],
        role: "borrower_net_payout",
        amount: "4400.00",
        senderHint: "MCP exact intermediary",
        payeeHint: "Exact borrower account",
        bankReference: "INTERMEDIATED-PAYOUT-1",
    },
    {
        publicId: INTERMEDIATED_EVENTS[2],
        role: "advance_interest_return",
        amount: "600.00",
        senderHint: "MCP exact intermediary",
        payeeHint: "Owner interest account",
        bankReference: "INTERMEDIATED-ADVANCE-1",
    },
] as const;
const INTERMEDIATED_EVIDENCE_BYTES = intermediatedEventSpecs.map((_, index) =>
    new TextEncoder().encode(`intermediated-slip-${index + 1}-fixture-bytes`));

function intermediatedIdentityScript(options: { ambiguous?: boolean; missingAssignment?: boolean } = {}): ScriptStep[] {
    const script: ScriptStep[] = [
        {
            name: "borrower.search",
            arguments: { query: "Exact borrower" },
            result: { resolution: "unique", matchType: "canonical", candidates: [{ publicId: BORROWER_A, name: "Exact borrower" }] },
        },
        {
            name: "borrower.portfolio",
            arguments: { borrowerPublicId: BORROWER_A },
            result: {
    borrower: { publicId: BORROWER_A, name: "Exact borrower" },
    aliases: [],
    loans: [{
            publicId: LOAN_A,
            principal: "5000.00",
            interestRate: "0.00",
            repaymentType: "floating",
            status: "active",
            replacementLineage: null,
            startDate: "2026-08-01"
        }]
},
        },
        {
            name: "intermediary.search",
            arguments: { query: intermediarySearchQuery },
            result: options.ambiguous
    ? { items: [intermediaryBaseResult(INTERMEDIARY, []), intermediaryBaseResult(INTERMEDIARY_B, [])] }
    : { items: [intermediaryBaseResult(INTERMEDIARY, ["MCP transfer agent"])] },
        },
    ];
    if (options.ambiguous) return script;
    script.push({
        name: "intermediary.profile.get",
        arguments: { intermediaryPublicId: INTERMEDIARY },
        result: {
    ...intermediaryBaseResult(INTERMEDIARY, ["MCP transfer agent"]),
    bankAccounts: [],
    assignments: options.missingAssignment ? [] : [{
            publicId: INTERMEDIARY_ASSIGNMENT,
            loanPublicId: LOAN_A,
            intermediaryPublicId: INTERMEDIARY,
            role: "disbursement",
            status: "active",
            effectiveFrom: "2026-08-01T00:00:00.000Z",
            effectiveTo: null,
            note: null,
            createdAt: "2026-08-01T00:00:00.000Z",
            updatedAt: "2026-08-01T00:00:00.000Z",
        }],
},
    });
    return script;
}

function intermediaryBaseResult(publicId: string, aliases: string[]) {
    return {
        publicId,
        name: intermediarySearchQuery,
        aliases,
        notes: null,
        status: "active",
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
    };
}

function intermediatedGroupResult(retainedBalance = "0.00") {
    return {
        publicId: INTERMEDIATED_GROUP,
        loanPublicId: LOAN_A,
        intermediaryPublicId: INTERMEDIARY,
        expectedFunding: "5000.00",
        expectedBorrowerPayout: retainedBalance === "0.00" ? "4400.00" : "4300.00",
        expectedAdvanceInterestReturn: "600.00",
        retainedBalance,
        status: "draft",
        note: "Exact three-leg disbursement",
        createdAt: "2026-08-13T01:00:00.000Z",
        updatedAt: "2026-08-13T01:00:00.000Z",
    };
}

function intermediatedGroupCreateStep(retainedBalance = "0.00"): ScriptStep {
    return {
        name: "intermediary.disbursement.create",
        arguments: { ...intermediatedGroupArgs, retainedBalance },
        result: {
    ...intermediatedGroupResult(retainedBalance),
    auditPublicId: INTERMEDIATED_AUDIT,
    correlationId: INTERMEDIATED_CORRELATION,
},
    };
}

function intermediatedEventArgs(index: number) {
    const spec = intermediatedEventSpecs[index]!;
    return {
        groupPublicId: INTERMEDIATED_GROUP,
        role: spec.role,
        channel: "bank_transfer",
        amount: spec.amount,
        transferredAt: `2026-08-13T0${index + 2}:00:00.000Z`,
        senderHint: spec.senderHint,
        payeeHint: spec.payeeHint,
        bankReference: spec.bankReference,
        idempotencyKey: `intermediated-event-20260813-${index + 1}`,
    };
}

function intermediatedEvidenceArgs(index: number) {
    const bytes = INTERMEDIATED_EVIDENCE_BYTES[index]!;
    return {
        groupPublicId: INTERMEDIATED_GROUP,
        eventPublicId: INTERMEDIATED_EVENTS[index]!,
        mimeType: "image/png",
        size: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        originalName: `intermediated-slip-${index + 1}.png`,
    };
}

function intermediatedEventResult(index: number) {
    const spec = intermediatedEventSpecs[index]!;
    return {
        ...spec,
        groupPublicId: INTERMEDIATED_GROUP,
        intermediaryBankAccountPublicId: null,
        reversedEventPublicId: null,
        channel: "bank_transfer",
        transferredAt: `2026-08-13T0${index + 2}:00:00.000Z`,
        status: "ready",
        note: null,
        createdAt: `2026-08-13T0${index + 2}:00:00.000Z`,
        updatedAt: `2026-08-13T0${index + 2}:00:00.000Z`,
    };
}

function intermediatedEvidenceResult(index: number, status: "pending" | "ready") {
    const args = intermediatedEvidenceArgs(index);
    return {
        publicId: INTERMEDIATED_EVIDENCE[index]!,
        filePublicId: INTERMEDIATED_EVIDENCE_FILES[index]!,
        status,
        mimeType: args.mimeType,
        size: args.size,
        sha256: args.sha256,
        originalName: args.originalName,
        finalizedAt: status === "ready" ? `2026-08-13T0${index + 2}:05:00.000Z` : null,
        createdAt: `2026-08-13T0${index + 2}:00:00.000Z`,
        auditPublicId: INTERMEDIATED_AUDIT,
        correlationId: INTERMEDIATED_CORRELATION,
    };
}

function intermediatedEventScript(index: number, options: { missingEvidence?: boolean; duplicate?: boolean } = {}): ScriptStep[] {
    const spec = intermediatedEventSpecs[index]!;
    if (options.duplicate) return [{
        name: "intermediary.disbursement.event.create",
        arguments: intermediatedEventArgs(index),
        error: { code: "DUPLICATE_BANK_REFERENCE", message: "Bank reference is already attached to another transfer event", retryable: false, reviewRequired: false, details: {} },
    }];
    return [
        {
            name: "intermediary.disbursement.event.create",
            arguments: intermediatedEventArgs(index),
            result: {
    ...intermediatedEventResult(index),
    auditPublicId: INTERMEDIATED_AUDIT,
    correlationId: INTERMEDIATED_CORRELATION,
},
        },
        {
            name: "intermediary.disbursement.evidence.prepare",
            arguments: intermediatedEvidenceArgs(index),
            result: options.missingEvidence ? intermediatedEvidenceResult(index, "pending") : {
    ...intermediatedEvidenceResult(index, "pending"),
    uploadUrl: `https://storage.example/intermediated-upload-${index + 1}`,
    requiredHeaders: { "content-type": "image/png" },
    expiresAt: "2099-01-01T00:00:00.000Z",
},
        },
        ...(options.missingEvidence ? [] : [{
            name: "intermediary.disbursement.evidence.finalize" as const,
            arguments: {
                groupPublicId: INTERMEDIATED_GROUP,
                eventPublicId: INTERMEDIATED_EVENTS[index]!,
                evidencePublicId: INTERMEDIATED_EVIDENCE[index]!,
            },
            result: intermediatedEvidenceResult(index, "ready"),
        }]),
    ];
}

function intermediatedPresentedEvents(options: {
    transferMismatch?: boolean;
    evidenceBindingMismatch?: boolean;
} = {}) {
    return intermediatedEventSpecs.map((_, index) => ({
        ...intermediatedEventResult(index),
        ...(options.transferMismatch && index === 1 ? {
            role: "funding_to_intermediary",
            amount: "4399.99",
            payeeHint: "Different unconfirmed payee",
            bankReference: "UNCONFIRMED-REFERENCE",
        } : {}),
        evidence: {
            status: "ready",
            count: 1,
            items: [{
                publicId: INTERMEDIATED_EVIDENCE[index]!,
                filePublicId: options.evidenceBindingMismatch && index === 1
                    ? INTERMEDIATED_WRONG_EVIDENCE_FILE
                    : INTERMEDIATED_EVIDENCE_FILES[index]!,
                status: "ready",
                mimeType: "image/png",
            }],
        },
    }));
}

function intermediatedDetailStep(options: {
    transferMismatch?: boolean;
    evidenceBindingMismatch?: boolean;
} = {}): ScriptStep {
    return {
        name: "intermediary.disbursement.get",
        arguments: { groupPublicId: INTERMEDIATED_GROUP },
        result: { ...intermediatedGroupResult(), events: intermediatedPresentedEvents(options), latestPreview: null },
    };
}

function intermediatedFinalizeBindingMismatchScript(field: "publicId" | "filePublicId"): ScriptStep[] {
    const eventScript = intermediatedEventScript(0);
    const finalize = eventScript.at(-1)!;
    return [
        ...intermediatedIdentityScript(),
        intermediatedGroupCreateStep(),
        ...eventScript.slice(0, -1),
        {
            ...finalize,
            result: {
                ...finalize.result,
                [field]: field === "publicId" ? INTERMEDIATED_WRONG_EVIDENCE : INTERMEDIATED_WRONG_EVIDENCE_FILE,
            },
        },
    ];
}

function intermediatedReadyMetadataMismatchScript(): ScriptStep[] {
    const eventScript = intermediatedEventScript(0);
    const prepare = eventScript[1]!;
    return [
        ...intermediatedIdentityScript(),
        intermediatedGroupCreateStep(),
        eventScript[0]!,
        {
            ...prepare,
            result: {
                ...intermediatedEvidenceResult(0, "ready"),
                sha256: "0".repeat(64),
            },
        },
    ];
}

function intermediatedPreviewResult(publicId = INTERMEDIATED_PREVIEW) {
    return {
    publicId,
    groupPublicId: INTERMEDIATED_GROUP,
    version: 1,
    status: "ready",
    expectedFunding: "5000.00",
    actualFunding: "5000.00",
    expectedBorrowerPayout: "4400.00",
    actualBorrowerPayout: "4400.00",
    expectedAdvanceInterestReturn: "600.00",
    actualAdvanceInterestReturn: "600.00",
    retainedBalance: "0.00",
    variance: "0.00",
    evidenceReady: true,
    warnings: [],
    previewHash: "f".repeat(64),
    expiresAt: "2099-01-01T00:15:00.000Z",
    createdAt: "2026-08-13T05:00:00.000Z",
    auditPublicId: INTERMEDIATED_AUDIT,
    correlationId: INTERMEDIATED_CORRELATION
};
}

function intermediatedPreviewStep(publicId = INTERMEDIATED_PREVIEW): ScriptStep {
    return {
        name: "intermediary.disbursement.preview",
        arguments: { groupPublicId: INTERMEDIATED_GROUP },
        result: intermediatedPreviewResult(publicId),
    };
}

function fullIntermediatedDraftScript(): ScriptStep[] {
    return [
        ...intermediatedIdentityScript(),
        intermediatedGroupCreateStep(),
        ...intermediatedEventScript(0),
        ...intermediatedEventScript(1),
        ...intermediatedEventScript(2),
        intermediatedDetailStep(),
        intermediatedPreviewStep(),
    ];
}

function presentIntermediatedPreview(mcp: ScriptedMcp, preview: Record<string, unknown>) {
    mcp.presentIntermediatedDisbursement({
        publicId: preview.publicId,
        groupPublicId: preview.groupPublicId,
        expectedFunding: preview.expectedFunding,
        actualFunding: preview.actualFunding,
        expectedBorrowerPayout: preview.expectedBorrowerPayout,
        actualBorrowerPayout: preview.actualBorrowerPayout,
        expectedAdvanceInterestReturn: preview.expectedAdvanceInterestReturn,
        actualAdvanceInterestReturn: preview.actualAdvanceInterestReturn,
        retainedBalance: preview.retainedBalance,
        variance: preview.variance,
        evidenceReady: preview.evidenceReady,
        warnings: preview.warnings,
        expiresAt: preview.expiresAt,
    });
}

async function intermediatedDisbursementFlow(
    mcp: ScriptedMcp,
    options: { confirmed?: boolean; retainedBalance?: string } = {},
) {
    const borrowerSearch = await mcp.call("borrower.search", { query: "Exact borrower" });
    if (borrowerSearch.resolution !== "unique" || !Array.isArray(borrowerSearch.candidates) || borrowerSearch.candidates.length !== 1) {
        return { outcome: "stopped", stopReason: "intermediated-identity-ambiguous" } as const;
    }
    const borrowerPublicId = (borrowerSearch.candidates as Array<{ publicId: string }>)[0]!.publicId;
    const portfolio = await mcp.call("borrower.portfolio", { borrowerPublicId });
    if (!(portfolio.loans as Array<{ publicId: string; status: string }>).some((loan) => loan.publicId === LOAN_A && loan.status === "active")) {
        return { outcome: "stopped", stopReason: "intermediated-loan-not-active" } as const;
    }
    const intermediarySearch = await mcp.call("intermediary.search", { query: intermediarySearchQuery });
    const intermediaryCandidates = intermediarySearch.items as Array<{ publicId: string; name: string; aliases: string[] }>;
    const exactCandidates = intermediaryCandidates.filter((candidate) =>
        candidate.name === intermediarySearchQuery || candidate.aliases?.includes(intermediarySearchQuery));
    if (exactCandidates.length !== 1) {
        return { outcome: "stopped", stopReason: "intermediated-identity-ambiguous" } as const;
    }
    const intermediaryPublicId = exactCandidates[0]!.publicId;
    const profile = await mcp.call("intermediary.profile.get", { intermediaryPublicId });
    const assignments = profile.assignments as Array<{ loanPublicId: string; role: string; status: string }>;
    if (!assignments.some((assignment) => assignment.loanPublicId === LOAN_A
        && assignment.status === "active"
        && ["disbursement", "both"].includes(assignment.role))) {
        return { outcome: "stopped", stopReason: "intermediated-assignment-required" } as const;
    }
    const group = await mcp.call("intermediary.disbursement.create", {
        ...intermediatedGroupArgs,
        retainedBalance: options.retainedBalance ?? "0.00",
    });
    if (group.retainedBalance !== "0.00") {
        return { outcome: "stopped", stopReason: "intermediated-retained-balance-unexplained" } as const;
    }

    const evidenceBindings: Array<{
        eventPublicId: string;
        evidencePublicId: string;
        filePublicId: string;
        mimeType: string;
        size: number;
        sha256: string;
    }> = [];
    for (const [index, spec] of intermediatedEventSpecs.entries()) {
        let event: Record<string, unknown>;
        try {
            event = await mcp.call("intermediary.disbursement.event.create", intermediatedEventArgs(index));
        } catch (error) {
            if (error instanceof ScriptedMcpError && ["DUPLICATE_BANK_REFERENCE", "IDEMPOTENCY_KEY_CONFLICT"].includes(error.code)) {
                return { outcome: "stopped", stopReason: "intermediated-duplicate-transfer" } as const;
            }
            throw error;
        }
        if (event.publicId !== spec.publicId) return { outcome: "stopped", stopReason: "intermediated-transfer-mismatch" } as const;
        const evidenceArgs = intermediatedEvidenceArgs(index);
        let prepared: Record<string, unknown>;
        try {
            prepared = await mcp.call("intermediary.disbursement.evidence.prepare", evidenceArgs);
        } catch (error) {
            if (error instanceof ScriptedMcpError && error.code === "EVIDENCE_HASH_CONFLICT") {
                return { outcome: "stopped", stopReason: "intermediated-duplicate-transfer" } as const;
            }
            throw error;
        }
        if (typeof prepared.publicId !== "string"
            || typeof prepared.filePublicId !== "string"
            || prepared.mimeType !== evidenceArgs.mimeType
            || prepared.size !== evidenceArgs.size
            || prepared.sha256 !== evidenceArgs.sha256
            || !["pending", "ready"].includes(String(prepared.status))) {
            return { outcome: "stopped", stopReason: "intermediated-evidence-binding-mismatch" } as const;
        }
        const evidenceBinding = {
            eventPublicId: spec.publicId,
            evidencePublicId: prepared.publicId,
            filePublicId: prepared.filePublicId,
            mimeType: evidenceArgs.mimeType,
            size: evidenceArgs.size,
            sha256: evidenceArgs.sha256,
        };
        evidenceBindings.push(evidenceBinding);
        if (prepared.status === "ready") continue;
        const expiresAt = typeof prepared.expiresAt === "string" ? Date.parse(prepared.expiresAt) : Number.NaN;
        if (typeof prepared.uploadUrl !== "string" || !prepared.requiredHeaders || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
            return { outcome: "stopped", stopReason: "intermediated-evidence-required" } as const;
        }
        mcp.uploadEvidence({
            name: "intermediated-evidence.put",
            uploadUrl: prepared.uploadUrl,
            requiredHeaders: prepared.requiredHeaders as Record<string, string>,
            bytes: INTERMEDIATED_EVIDENCE_BYTES[index]!,
            declaredSize: evidenceArgs.size,
            declaredSha256: evidenceArgs.sha256,
        });
        const finalized = await mcp.call("intermediary.disbursement.evidence.finalize", {
            groupPublicId: INTERMEDIATED_GROUP,
            eventPublicId: spec.publicId,
            evidencePublicId: evidenceBinding.evidencePublicId,
        });
        if (finalized.status !== "ready"
            || finalized.publicId !== evidenceBinding.evidencePublicId
            || finalized.filePublicId !== evidenceBinding.filePublicId
            || finalized.mimeType !== evidenceBinding.mimeType
            || finalized.size !== evidenceBinding.size
            || finalized.sha256 !== evidenceBinding.sha256) {
            return { outcome: "stopped", stopReason: "intermediated-evidence-binding-mismatch" } as const;
        }
    }

    const detail = await mcp.call("intermediary.disbursement.get", { groupPublicId: INTERMEDIATED_GROUP });
    const events = detail.events as Array<{
        publicId: string;
        role: string;
        amount: string;
        payeeHint: string | null;
        bankReference: string | null;
        evidence: { status: string; count: number; items: Array<{
            publicId: string;
            filePublicId: string;
            status: string;
            mimeType: string;
        }> };
    }>;
    const inspectedTransferMismatch = events.length !== intermediatedEventSpecs.length || intermediatedEventSpecs.some((spec) => {
        const event = events.find((candidate) => candidate.publicId === spec.publicId);
        return !event
            || event.role !== spec.role
            || event.amount !== spec.amount
            || event.payeeHint !== spec.payeeHint
            || event.bankReference !== spec.bankReference;
    });
    if (inspectedTransferMismatch) {
        return { outcome: "stopped", stopReason: "intermediated-transfer-mismatch" } as const;
    }
    const inspectedEvidenceMismatch = intermediatedEventSpecs.some((spec, index) => {
        const event = events.find((candidate) => candidate.publicId === spec.publicId)!;
        const evidenceBinding = evidenceBindings[index];
        return !evidenceBinding
            || event.evidence.status !== "ready"
            || event.evidence.count !== 1
            || event.evidence.items.length !== 1
            || event.evidence.items[0]?.publicId !== evidenceBinding.evidencePublicId
            || event.evidence.items[0]?.filePublicId !== evidenceBinding.filePublicId
            || event.evidence.items[0]?.status !== "ready"
            || event.evidence.items[0]?.mimeType !== evidenceBinding.mimeType;
    });
    if (inspectedEvidenceMismatch) {
        return { outcome: "stopped", stopReason: "intermediated-evidence-binding-mismatch" } as const;
    }
    const preview = await mcp.call("intermediary.disbursement.preview", { groupPublicId: INTERMEDIATED_GROUP });
    if (preview.status !== "ready"
        || preview.variance !== "0.00"
        || preview.retainedBalance !== "0.00"
        || preview.evidenceReady !== true
        || (preview.warnings as unknown[]).length !== 0) {
        return { outcome: "stopped", stopReason: "intermediated-preview-needs-review" } as const;
    }
    presentIntermediatedPreview(mcp, preview);
    const confirmed = options.confirmed === true;
    mcp.recordIntermediatedDisbursementConfirmation(confirmed);
    if (!confirmed) return { outcome: "stopped", stopReason: "intermediated-confirmation-required" } as const;
    try {
        await mcp.call("intermediary.disbursement.post", {
            groupPublicId: INTERMEDIATED_GROUP,
            proposalPublicId: preview.publicId,
            confirmed: true,
            idempotencyKey: "intermediated-post-20260813-1",
        });
        return { outcome: "completed" } as const;
    } catch (error) {
        if (!(error instanceof ScriptedMcpError) || error.code !== "STALE_INTERMEDIATED_DISBURSEMENT_PROPOSAL") throw error;
        await mcp.call("intermediary.disbursement.get", { groupPublicId: INTERMEDIATED_GROUP });
        const fresh = await mcp.call("intermediary.disbursement.preview", { groupPublicId: INTERMEDIATED_GROUP });
        presentIntermediatedPreview(mcp, fresh);
        mcp.recordIntermediatedDisbursementConfirmation(false);
        return { outcome: "stopped", stopReason: "fresh-intermediated-confirmation-required" } as const;
    }
}

type Scenario = {
    script: ScriptStep[];
    authorized?: boolean;
    run: (mcp: ScriptedMcp) => Promise<Omit<HarnessResult, "calls" | "effects" | "events">>;
};

const batchItemFixture = { id: "0198c481-3e2b-7000-8000-000000000502", publicId: "0198c481-3e2b-7000-8000-000000000502", itemOrder: 1, paymentIntakePublicId: INTAKE, evidenceStatus: "ready" };
const batchFixture = (publicId: string) => ({ id: publicId, publicId, status: "draft", version: 1, borrowerPublicId: BORROWER_A, stateHash: "c".repeat(64), confirmationHash: null, confirmedVersion: null, notes: null, items: [batchItemFixture], latestPreview: null, postedAt: null, createdAt: "2026-08-23T00:00:00.000Z", updatedAt: "2026-08-23T00:00:00.000Z" });
const batchPreviewFixture = (batchPublicId: string) => ({ id: "0198c481-3e2b-7000-8000-000000000503", publicId: "0198c481-3e2b-7000-8000-000000000503", batchPublicId, version: 1, status: "ready", stateHash: "c".repeat(64), previewHash: "a".repeat(64), confirmationHash: "b".repeat(64), evidenceReady: true, allocations: [], candidates: [], warnings: [] });
const batchExecutionFixture = (batchPublicId: string) => ({ batchPublicId, status: "posted", posted: [], auditPublicIds: ["0198c481-3e2b-7000-8000-000000000511"], correlationId: "0198c481-3e2b-7000-8000-000000000512" });
const stagingWorkflowBatch = "0198c481-3e2b-7000-8000-000000000513";
const stagingWorkflowItem = "0198c481-3e2b-7000-8000-000000000514";
const stagingWorkflowBatchItem = "0198c481-3e2b-7000-8000-000000000515";
const stagingWorkflowEvidence = "0198c481-3e2b-7000-8000-000000000516";
const stagingWorkflowDecision = "0198c481-3e2b-7000-8000-000000000517";
const stagingWorkflowAudit = "0198c481-3e2b-7000-8000-000000000518";
const stagingWorkflowCorrelation = "0198c481-3e2b-7000-8000-000000000519";
const stagingWorkflowHash = "c".repeat(64);
const stagingWorkflowWorkspace = {
    batchPublicId: stagingWorkflowBatch,
    batch: {
        id: stagingWorkflowBatch, publicId: stagingWorkflowBatch, status: "draft", version: 1,
        stateHash: "c".repeat(64), confirmationHash: null, confirmedVersion: null,
        borrowerPublicId: BORROWER_A, items: [], latestPreview: null,
        createdAt: "2026-08-23T00:00:00.000Z", updatedAt: "2026-08-23T00:00:00.000Z",
    },
    items: [{
        publicId: stagingWorkflowItem, clientItemKey: "slip-1", status: "reviewed", revision: 1,
        amount: "120.00", receivedAt: "2026-08-23T04:00:00.000Z", payerName: "Synthetic payer",
        paymentIntakePublicId: INTAKE, batchItemPublicId: stagingWorkflowBatchItem,
        reviewedReason: "Human reviewed synthetic slip", reviewedRangeFrom: null, reviewedRangeTo: null,
        evidence: null, evidenceStatus: "ready",
    }],
};
const stagingWorkflowPreview = {
    id: "0198c481-3e2b-7000-8000-000000000520", publicId: "0198c481-3e2b-7000-8000-000000000520",
    batchPublicId: stagingWorkflowBatch, version: 1, status: "ready", stateHash: "c".repeat(64),
    previewHash: `v1:${stagingWorkflowHash}`, confirmationHash: `v1:${"d".repeat(64)}`,
    evidenceReady: true,
    allocations: [{ itemPublicId: stagingWorkflowItem, borrowerPublicId: BORROWER_A, loanPublicId: LOAN_A,
        schedulePublicId: null, amount: "120.00", targetDueDate: "2026-08-23", intent: "on_time", matchSource: "human_explicit" }],
    candidates: [], warnings: [],
};
const stagingWorkflowCandidates = {
    stagingItemPublicId: stagingWorkflowItem, batchItemPublicId: stagingWorkflowBatchItem, stagingRevision: 1, batchRevision: 1, inputFingerprint: `v1:${"e".repeat(64)}`, amount: "120.00",
    receivedAt: "2026-08-23T04:00:00.000Z", businessDate: "2026-08-23", borrowerResolution: "unique", matchType: "canonical",
    borrowerCandidates: [{ publicId: BORROWER_A, name: "Synthetic borrower", matchType: "canonical" }],
    contractCandidates: [{ borrowerPublicId: BORROWER_A, borrowerName: "Synthetic borrower", loanPublicId: LOAN_A, repaymentType: "daily", status: "active", eligible: true, eligibilityCode: null, principalAmount: "500.00", outstandingPrincipal: "500.00", interestRate: "0.00", startDate: "2026-08-01", nextDueDate: "2026-08-23", dueComponents: { principal: "120.00", interest: "0.00", fee: "0.00", penalty: "0.00" }, proposalComponents: { principal: "120.00", interest: "0.00", fee: "0.00", penalty: "0.00" }, schedules: [] }],
    candidateLimitReached: false, reviewRequired: false,
};

async function unfundedCancellationFlow(mcp: ScriptedMcp, execute = true) {
    const search = await mcp.call("borrower.search", { query: "Unfunded Borrower" });
    const borrowerPublicId = (search.candidates as Array<{ publicId?: unknown }> | undefined)?.[0]?.publicId;
    if (typeof borrowerPublicId !== "string") return { outcome: "stopped", stopReason: "cancellation-borrower-ambiguous" } as const;
    await mcp.call("borrower.portfolio", { borrowerPublicId });
    let preview: Record<string, unknown>;
    try {
        preview = await mcp.call("loan.cancel.preview", { loanPublicId: LOAN_A, reason: "Contract was never funded" });
    } catch (error) {
        if (error instanceof ScriptedMcpError) return { outcome: "stopped", stopReason: `cancellation-preview-${error.code}` } as const;
        throw error;
    }
    if (!execute) return { outcome: "stopped", stopReason: "cancellation-confirmation-required" } as const;
    await mcp.call("loan.cancel.execute", {
        previewPublicId: String(preview.publicId),
        previewHash: String(preview.previewHash),
        expectedBalanceVersion: String(preview.balanceVersion),
        confirmed: true,
        reason: "Contract was never funded",
        idempotencyKey: "loan-cancel-execute-20260825-1",
    });
    return { outcome: "completed" } as const;
}

const SCENARIOS: Record<string, Scenario> = {
    "workflow-resolve-payment-guidance": {
        script: [{ name: "workflow.resolve", arguments: { intent: "receive_payment", target: { kind: "payment_intake", publicId: INTAKE }, attachments: "present", expectedAttachmentCount: 1 }, result: resolverFixture("next_step", { nextSteps: [{ toolName: "evidence.import-chatgpt-file", arguments: { paymentIntakePublicId: INTAKE }, requiredInputs: ["idempotencyKey", "chatgptFile"], requiresConfirmation: false }], prohibitedTools: ["payment.post"] }) }],
        run: async (mcp) => { await mcp.call("workflow.resolve", { intent: "receive_payment", target: { kind: "payment_intake", publicId: INTAKE }, attachments: "present", expectedAttachmentCount: 1 }); return { outcome: "completed" } as const; },
    },
    "workflow-resolve-payout-guidance": {
        script: [{ name: "workflow.resolve", arguments: { intent: "disburse_loan", target: { kind: "loan_disbursement", publicId: DISBURSEMENT }, attachments: "none" }, result: resolverFixture("next_step", { nextSteps: [{ toolName: "loan.disbursement.evidence.prepare", arguments: { disbursementPublicId: DISBURSEMENT }, requiredInputs: ["mimeType", "size", "sha256"], requiresConfirmation: false }], prohibitedTools: ["loan.disbursement.post"] }) }],
        run: async (mcp) => { await mcp.call("workflow.resolve", { intent: "disburse_loan", target: { kind: "loan_disbursement", publicId: DISBURSEMENT }, attachments: "none" }); return { outcome: "completed" } as const; },
    },
    "workflow-resolve-missing-file": {
        script: [{ name: "workflow.resolve", arguments: { intent: "receive_payment", target: { kind: "payment_intake", publicId: INTAKE }, attachments: "unknown" }, result: resolverFixture("needs_input", { blockers: ["ATTACHMENT_AVAILABILITY_UNKNOWN"] }) }],
        run: async (mcp) => { await mcp.call("workflow.resolve", { intent: "receive_payment", target: { kind: "payment_intake", publicId: INTAKE }, attachments: "unknown" }); return { outcome: "stopped", stopReason: "attachment-unavailable" } as const; },
    },
    "workflow-resolve-dns-unavailable": {
        script: [{ name: "workflow.resolve", arguments: { intent: "receive_payment", target: { kind: "payment_intake", publicId: INTAKE }, attachments: "present", expectedAttachmentCount: 1 }, result: resolverFixture("blocked", { blockers: ["HUMAN_REVIEW_REQUIRED_UNSUPPORTED_ATTACHMENT_TRANSPORT"], prohibitedTools: ["payment.post"] }) }],
        run: async (mcp) => { await mcp.call("workflow.resolve", { intent: "receive_payment", target: { kind: "payment_intake", publicId: INTAKE }, attachments: "present", expectedAttachmentCount: 1 }); return { outcome: "stopped", stopReason: "attachment-transport-unavailable" } as const; },
    },
    "workflow-resolve-prepare-without-resolve": {
        script: [],
        run: async () => ({ outcome: "stopped", stopReason: "resolver-required-before-prepare" } as const),
    },
    "workflow-resolve-post-without-resolve": {
        script: [],
        run: async () => ({ outcome: "stopped", stopReason: "resolver-required-before-post" } as const),
    },
    "workflow-resolve-two-files-one-ready": {
        script: [{ name: "workflow.resolve", arguments: { intent: "receive_payment", target: { kind: "payment_intake", publicId: INTAKE }, attachments: "present", expectedAttachmentCount: 2 }, result: resolverFixture("blocked", { blockers: ["EVIDENCE_REQUIRED_NOT_READY"], prohibitedTools: ["payment.post"] }) }],
        run: async (mcp) => { await mcp.call("workflow.resolve", { intent: "receive_payment", target: { kind: "payment_intake", publicId: INTAKE }, attachments: "present", expectedAttachmentCount: 2 }); return { outcome: "stopped", stopReason: "all-evidence-required" } as const; },
    },
    "workflow-resolve-stale-workflow": {
        script: [{ name: "workflow.resolve", arguments: { intent: "receive_payment", target: { kind: "payment_intake", publicId: INTAKE }, attachments: "none", knownWorkflowVersion: "workflow-resolver-old" }, result: resolverFixture("refresh_required", { blockers: ["WORKFLOW_VERSION_STALE"], reevaluateOn: "version_change" }) }],
        run: async (mcp) => { await mcp.call("workflow.resolve", { intent: "receive_payment", target: { kind: "payment_intake", publicId: INTAKE }, attachments: "none", knownWorkflowVersion: "workflow-resolver-old" }); return { outcome: "stopped", stopReason: "stale-workflow-version" } as const; },
    },
    "workflow-resolve-posted-pending": {
        script: [{ name: "workflow.resolve", arguments: { intent: "receive_payment", target: { kind: "payment_intake", publicId: INTAKE }, attachments: "none" }, result: resolverFixture("confirmation_required", { blockers: ["POSTED_INTAKE_REQUIRES_SUPPLEMENT_WORKFLOW"], nextSteps: [{ toolName: "payment.evidence-supplement.record", arguments: { paymentIntakePublicId: INTAKE }, requiredInputs: ["supplementPublicId", "confirmed", "reason", "idempotencyKey"], requiresConfirmation: true }], prohibitedTools: ["payment.post"] }) }],
        run: async (mcp) => { await mcp.call("workflow.resolve", { intent: "receive_payment", target: { kind: "payment_intake", publicId: INTAKE }, attachments: "none" }); return { outcome: "stopped", stopReason: "posted-supplement-only" } as const; },
    },
    "workflow-resolve-profile-missing-importer": {
        script: [{ name: "workflow.resolve", arguments: { intent: "receive_payment", target: { kind: "payment_intake", publicId: INTAKE }, attachments: "present", expectedAttachmentCount: 1 }, result: resolverFixture("connection_required", { blockers: ["WORKFLOW_REQUIRES_ANOTHER_CONNECTION"] }) }],
        run: async (mcp) => { await mcp.call("workflow.resolve", { intent: "receive_payment", target: { kind: "payment_intake", publicId: INTAKE }, attachments: "present", expectedAttachmentCount: 1 }); return { outcome: "stopped", stopReason: "profile-missing-importer" } as const; },
    },
    "workflow-resolve-unsupported-transport": {
        script: [{ name: "workflow.resolve", arguments: { intent: "close_loan", target: { kind: "loan", publicId: LOAN_A }, attachments: "present", expectedAttachmentCount: 1 }, result: resolverFixture("blocked", { blockers: ["HUMAN_REVIEW_REQUIRED_FLOATING_ATTACHMENT_TRANSPORT"], prohibitedTools: ["loan.settlement.execute"] }) }],
        run: async (mcp) => { await mcp.call("workflow.resolve", { intent: "close_loan", target: { kind: "loan", publicId: LOAN_A }, attachments: "present", expectedAttachmentCount: 1 }); return { outcome: "stopped", stopReason: "unsupported-transport-human-review" } as const; },
    },
    "loan-cancel-unfunded": {
        script: [
            { name: "borrower.search", arguments: { query: "Unfunded Borrower" }, result: { resolution: "unique", candidates: [{ publicId: BORROWER_A, name: "fixture" }] } },
            { name: "borrower.portfolio", arguments: { borrowerPublicId: BORROWER_A }, result: replacementPortfolio() },
            { name: "loan.cancel.preview", arguments: { loanPublicId: LOAN_A, reason: "Contract was never funded" }, result: { id: CANCELLATION_PREVIEW, publicId: CANCELLATION_PREVIEW, loanPublicId: LOAN_A, reason: "Contract was never funded", eligibility: "unfunded", before: { status: "active", outstandingPrincipal: "20000.00", outstandingInterest: "10000.00", outstandingFees: "0.00", nextDueDate: "2026-08-25", postedPaymentCount: 0, postedDisbursementCount: 0, netDisbursed: "0.00" }, balanceVersion: BALANCE_VERSION, previewHash: PREVIEW_HASH, status: "ready", expiresAt: "2026-08-25T07:00:00.000Z" } },
            { name: "loan.cancel.execute", arguments: { previewPublicId: CANCELLATION_PREVIEW, previewHash: PREVIEW_HASH, expectedBalanceVersion: BALANCE_VERSION, confirmed: true, reason: "Contract was never funded", idempotencyKey: "loan-cancel-execute-20260825-1" }, result: { publicId: LOAN_A, principal: "20000.00", principalAmount: "20000.00", interestRate: "10.00", repaymentType: "monthly", termMonths: 12, installmentAmount: "1750.00", totalInstallments: 12, startDate: "2026-08-01", nextDueDate: "2026-08-25", status: "cancelled", outstandingPrincipal: "0.00", outstandingInterest: "0.00", outstandingFees: "0.00", auditPublicId: CANCELLATION_AUDIT, auditPublicIds: [CANCELLATION_AUDIT], correlationId: CANCELLATION_AUDIT } },
        ],
        run: (mcp) => unfundedCancellationFlow(mcp),
    },
    "loan-cancel-funded-stop": {
        script: [
            { name: "borrower.search", arguments: { query: "Unfunded Borrower" }, result: { resolution: "unique", candidates: [{ publicId: BORROWER_A, name: "fixture" }] } },
            { name: "borrower.portfolio", arguments: { borrowerPublicId: BORROWER_A }, result: replacementPortfolio() },
            { name: "loan.cancel.preview", arguments: { loanPublicId: LOAN_A, reason: "Contract was never funded" }, error: { code: "LOAN_CANCEL_FUNDED", message: "Loan has actual disbursement history", retryable: false, reviewRequired: true, details: {} } },
        ],
        run: (mcp) => unfundedCancellationFlow(mcp),
    },
    "loan-cancel-posted-payment-stop": {
        script: [
            { name: "borrower.search", arguments: { query: "Unfunded Borrower" }, result: { resolution: "unique", candidates: [{ publicId: BORROWER_A, name: "fixture" }] } },
            { name: "borrower.portfolio", arguments: { borrowerPublicId: BORROWER_A }, result: replacementPortfolio() },
            { name: "loan.cancel.preview", arguments: { loanPublicId: LOAN_A, reason: "Contract was never funded" }, error: { code: "LOAN_CANCEL_POSTED_PAYMENT", message: "Loan has effective posted payment history", retryable: false, reviewRequired: true, details: {} } },
        ],
        run: (mcp) => unfundedCancellationFlow(mcp),
    },
    "loan-replacement-execute": {
        script: [
            { name: "borrower.search", arguments: { query: "Replacement Borrower" }, result: { resolution: "unique", candidates: [{ publicId: BORROWER_A, name: "fixture" }] } },
            { name: "borrower.portfolio", arguments: { borrowerPublicId: BORROWER_A }, result: replacementPortfolio() },
            { name: "loan.replacement.preview", arguments: { oldLoanPublicId: LOAN_A, replacementDraftPublicId: DRAFT, reason: "Correct contract start date while preserving the first due date" }, result: replacementPreviewResult() },
            { name: "loan.replacement.execute", arguments: { replacementPublicId: REPLACEMENT, previewHash: PREVIEW_HASH, expectedOldBalanceVersion: BALANCE_VERSION, expectedReplacementDraftVersion: BALANCE_VERSION, confirmed: true, reason: "Owner confirmed the exact fresh no-cash replacement proposal", idempotencyKey: "loan-replacement-execute-20260817-1" }, result: { replacementPublicId: REPLACEMENT, oldLoanPublicId: LOAN_A, replacementLoanPublicId: DRAFT, status: "executed", auditPublicId: REPLACEMENT_AUDIT, correlationId: REPLACEMENT_AUDIT } },
        ],
        run: (mcp) => replacementFlow(mcp),
    },
    "loan-replacement-missing-confirmation": {
        script: [
            { name: "borrower.search", arguments: { query: "Replacement Borrower" }, result: { resolution: "unique", candidates: [{ publicId: BORROWER_A, name: "fixture" }] } },
            { name: "borrower.portfolio", arguments: { borrowerPublicId: BORROWER_A }, result: replacementPortfolio() },
            { name: "loan.replacement.preview", arguments: { oldLoanPublicId: LOAN_A, replacementDraftPublicId: DRAFT, reason: "Correct contract start date while preserving the first due date" }, result: replacementPreviewResult() },
        ],
        run: (mcp) => replacementFlow(mcp, false),
    },
    "loan-replacement-stale-preview": {
        script: [
            { name: "borrower.search", arguments: { query: "Replacement Borrower" }, result: { resolution: "unique", candidates: [{ publicId: BORROWER_A, name: "fixture" }] } },
            { name: "borrower.portfolio", arguments: { borrowerPublicId: BORROWER_A }, result: replacementPortfolio() },
            { name: "loan.replacement.preview", arguments: { oldLoanPublicId: LOAN_A, replacementDraftPublicId: DRAFT, reason: "Correct contract start date while preserving the first due date" }, result: replacementPreviewResult() },
            { name: "loan.replacement.execute", arguments: { replacementPublicId: REPLACEMENT, previewHash: PREVIEW_HASH, expectedOldBalanceVersion: BALANCE_VERSION, expectedReplacementDraftVersion: BALANCE_VERSION, confirmed: true, reason: "Owner confirmed the exact fresh no-cash replacement proposal", idempotencyKey: "loan-replacement-execute-20260817-1" }, error: { code: "REPLACEMENT_PREVIEW_STALE", message: "Replacement state changed", retryable: false, reviewRequired: true, details: {} } },
            { name: "borrower.portfolio", arguments: { borrowerPublicId: BORROWER_A }, result: replacementPortfolio() },
            { name: "loan.replacement.preview", arguments: { oldLoanPublicId: LOAN_A, replacementDraftPublicId: DRAFT, reason: "Correct contract start date while preserving the first due date" }, result: replacementPreviewResult() },
        ],
        run: (mcp) => replacementFlow(mcp),
    },
    "loan-replacement-downstream-activity": {
        script: [
            { name: "borrower.search", arguments: { query: "Replacement Borrower" }, result: { resolution: "unique", candidates: [{ publicId: BORROWER_A, name: "fixture" }] } },
            { name: "borrower.portfolio", arguments: { borrowerPublicId: BORROWER_A }, result: replacementPortfolio() },
            { name: "loan.replacement.preview", arguments: { oldLoanPublicId: LOAN_A, replacementDraftPublicId: DRAFT, reason: "Correct contract start date while preserving the first due date" }, error: { code: "REPLACEMENT_DRAFT_DOWNSTREAM_ACTIVITY", message: "Replacement draft has downstream activity", retryable: false, reviewRequired: true, details: {} } },
        ],
        run: (mcp) => replacementFlow(mcp),
    },
    "loan-replacement-direct-status-mutation": {
        script: [
            { name: "borrower.search", arguments: { query: "Replacement Borrower" }, result: { resolution: "unique", candidates: [{ publicId: BORROWER_A, name: "fixture" }] } },
            { name: "borrower.portfolio", arguments: { borrowerPublicId: BORROWER_A }, result: replacementPortfolio() },
        ],
        run: async (mcp) => {
            const search = await mcp.call("borrower.search", { query: "Replacement Borrower" });
            const borrowerPublicId = (search.candidates as Array<{ publicId?: unknown }> | undefined)?.[0]?.publicId;
            if (typeof borrowerPublicId !== "string") return { outcome: "stopped", stopReason: "replacement-borrower-ambiguous" } as const;
            const portfolio = await mcp.call("borrower.portfolio", { borrowerPublicId });
            if (!inspectedReplacementCandidates(portfolio, borrowerPublicId)) {
                return { outcome: "stopped", stopReason: "replacement-portfolio-scope-invalid" } as const;
            }
            return { outcome: "stopped", stopReason: "replacement-direct-status-mutation-forbidden" } as const;
        },
    },
    "loan-replacement-portfolio-scope-mismatch": {
        script: [
            { name: "borrower.search", arguments: { query: "Replacement Borrower" }, result: { resolution: "unique", candidates: [{ publicId: BORROWER_A, name: "fixture" }] } },
            { name: "borrower.portfolio", arguments: { borrowerPublicId: BORROWER_A }, result: replacementPortfolio({ borrowerPublicId: BORROWER_B }) },
        ],
        run: (mcp) => replacementFlow(mcp),
    },
    "commission-no-agent-activation": {
        script: [{ name: "loan.commission-participant.list", arguments: { loanPublicId: LOAN_A }, result: { items: [] } }],
        run: async (mcp) => { await mcp.call("loan.commission-participant.list", { loanPublicId: LOAN_A }); return { outcome: "completed" } as const; },
    },
    "commission-add-after-payment": {
        script: [
            { name: "payment.intermediary-attribution.list", arguments: { paymentPublicId: PAYMENT_A }, result: { items: [] } },
            { name: "loan.commission-participant.add", arguments: { loanPublicId: LOAN_A, intermediaryPublicId: INTERMEDIARY, commissionRate: "30.00", role: "collector", effectiveFrom: "2026-08-16T00:00:00.000Z", confirmed: true, idempotencyKey: "commission-add-after-payment-1" }, result: commissionParticipant(COMMISSION_PARTICIPANT_A, INTERMEDIARY, "30.00") },
        ],
        run: async (mcp) => { await mcp.call("payment.intermediary-attribution.list", { paymentPublicId: PAYMENT_A }); await mcp.call("loan.commission-participant.add", { loanPublicId: LOAN_A, intermediaryPublicId: INTERMEDIARY, commissionRate: "30.00", role: "collector", effectiveFrom: "2026-08-16T00:00:00.000Z", confirmed: true, idempotencyKey: "commission-add-after-payment-1" }); return { outcome: "completed" } as const; },
    },
    "commission-two-agent-split": {
        script: [{ name: "loan.commission-participant.list", arguments: { loanPublicId: LOAN_A }, result: { items: [commissionParticipant(COMMISSION_PARTICIPANT_A, INTERMEDIARY, "30.00"), commissionParticipant(COMMISSION_PARTICIPANT_B, INTERMEDIARY_B, "20.00")] } }],
        run: async (mcp) => { await mcp.call("loan.commission-participant.list", { loanPublicId: LOAN_A }); return { outcome: "completed" } as const; },
    },
    "payment-direct-attribution": {
        script: [{ name: "payment.intermediary-attribution.create", arguments: { paymentPublicId: PAYMENT_A, sourceKind: "direct", amount: "20.00", confirmed: true, idempotencyKey: "direct-attribution-1" }, result: attribution(ATTRIBUTION_A, "20.00", "direct", null) }],
        run: async (mcp) => { await mcp.call("payment.intermediary-attribution.create", { paymentPublicId: PAYMENT_A, sourceKind: "direct", amount: "20.00", confirmed: true, idempotencyKey: "direct-attribution-1" }); return { outcome: "completed" } as const; },
    },
    "payment-multi-source-attribution": {
        script: [
            { name: "payment.intermediary-attribution.create", arguments: { paymentPublicId: PAYMENT_A, sourceKind: "direct", amount: "20.00", confirmed: true, idempotencyKey: "multi-direct-1" }, result: attribution(ATTRIBUTION_A, "20.00", "direct", null) },
            { name: "payment.intermediary-attribution.create", arguments: { paymentPublicId: PAYMENT_A, sourceKind: "intermediary", intermediaryPublicId: INTERMEDIARY, amount: "80.00", confirmed: true, idempotencyKey: "multi-agent-1" }, result: attribution(ATTRIBUTION_B, "80.00", "intermediary", INTERMEDIARY) },
        ],
        run: async (mcp) => { await mcp.call("payment.intermediary-attribution.create", { paymentPublicId: PAYMENT_A, sourceKind: "direct", amount: "20.00", confirmed: true, idempotencyKey: "multi-direct-1" }); await mcp.call("payment.intermediary-attribution.create", { paymentPublicId: PAYMENT_A, sourceKind: "intermediary", intermediaryPublicId: INTERMEDIARY, amount: "80.00", confirmed: true, idempotencyKey: "multi-agent-1" }); return { outcome: "completed" } as const; },
    },
    "commission-exact-preview": {
        script: [{ name: "loan.commission.preview", arguments: { loanPublicId: LOAN_A, paymentPublicIds: [PAYMENT_A, PAYMENT_B] }, result: commissionPreview }],
        run: async (mcp) => { await mcp.call("loan.commission.preview", { loanPublicId: LOAN_A, paymentPublicIds: [PAYMENT_A, PAYMENT_B] }); return { outcome: "completed" } as const; },
    },
    "commission-reversal-read-only-preview": {
        script: [{ name: "loan.commission.reverse", arguments: { loanPublicId: LOAN_A, paymentPublicIds: [PAYMENT_A, PAYMENT_B] }, result: commissionPreview }],
        run: async (mcp) => { await mcp.call("loan.commission.reverse", { loanPublicId: LOAN_A, paymentPublicIds: [PAYMENT_A, PAYMENT_B] }); return { outcome: "completed" } as const; },
    },
    "payment-attribution-idempotency-replay": {
        script: [
            { name: "payment.intermediary-attribution.create", arguments: { paymentPublicId: PAYMENT_A, sourceKind: "direct", amount: "20.00", confirmed: true, idempotencyKey: "replay-attribution-1" }, result: attribution(ATTRIBUTION_A, "20.00", "direct", null) },
            { name: "payment.intermediary-attribution.create", arguments: { paymentPublicId: PAYMENT_A, sourceKind: "direct", amount: "20.00", confirmed: true, idempotencyKey: "replay-attribution-1" }, result: attribution(ATTRIBUTION_A, "20.00", "direct", null) },
        ],
        run: async (mcp) => { const args = { paymentPublicId: PAYMENT_A, sourceKind: "direct", amount: "20.00", confirmed: true, idempotencyKey: "replay-attribution-1" }; await mcp.call("payment.intermediary-attribution.create", args); await mcp.call("payment.intermediary-attribution.create", args); return { outcome: "completed" } as const; },
    },
    "payment-attribution-compensating-reversal": {
        script: [
            { name: "payment.intermediary-attribution.create", arguments: { paymentPublicId: PAYMENT_A, sourceKind: "intermediary", intermediaryPublicId: INTERMEDIARY, amount: "40.00", confirmed: true, idempotencyKey: "reversal-create-1" }, result: attribution(ATTRIBUTION_A, "40.00", "intermediary", INTERMEDIARY) },
            { name: "payment.intermediary-attribution.reverse", arguments: { attributionPublicId: ATTRIBUTION_A, reason: "Correct source attribution", confirmed: true, idempotencyKey: "reversal-compensate-1" }, result: attribution(ATTRIBUTION_REVERSAL, "-40.00", "intermediary", INTERMEDIARY, ATTRIBUTION_A) },
        ],
        run: async (mcp) => { await mcp.call("payment.intermediary-attribution.create", { paymentPublicId: PAYMENT_A, sourceKind: "intermediary", intermediaryPublicId: INTERMEDIARY, amount: "40.00", confirmed: true, idempotencyKey: "reversal-create-1" }); await mcp.call("payment.intermediary-attribution.reverse", { attributionPublicId: ATTRIBUTION_A, reason: "Correct source attribution", confirmed: true, idempotencyKey: "reversal-compensate-1" }); return { outcome: "completed" } as const; },
    },
    "borrower-create-alias": {
        script: [
            { name: "borrower.search", arguments: { query: "นก (Nok)" }, result: { resolution: "none", candidates: [] } },
            { name: "borrower.create", arguments: { name: "กนกพิชญ์ เลิศพรหมมกุล", phone: "0812345678" }, result: { publicId: BORROWER_A, name: "fixture" } },
            { name: "borrower.portfolio", arguments: { borrowerPublicId: BORROWER_A }, result: { borrower: { publicId: "0198c481-3e2b-7000-8000-000000000200", name: "fixture" }, aliases: [], loans: [] } },
            { name: "borrower.alias", arguments: { action: "add", borrowerPublicId: BORROWER_A, alias: "นก", source: "manual" }, result: { publicId: ALIAS, alias: "fixture", normalizedAlias: "fixture", source: "fixture", status: "fixture" } },
            { name: "borrower.alias", arguments: { action: "confirm", aliasPublicId: ALIAS }, result: { publicId: "0198c481-3e2b-7000-8000-000000000201", alias: "fixture", normalizedAlias: "fixture", source: "fixture", status: "fixture" } },
        ],
        run: createBorrowerAlias,
    },
    "payment-data-only": {
        script: [
            { name: "intake.create", arguments: intakeArgs, result: { publicId: INTAKE, duplicate: false, status: "fixture", warnings: [], duplicateReason: null, ...noRepostLineage } },
            { name: "payment.preview", arguments: { paymentIntakePublicId: INTAKE }, result: { publicId: PROPOSAL, status: "ready", version: -9007199254740991, warnings: [], totalAllocated: "0.00", allocations: [] } },
            { name: "payment.post", arguments: { paymentIntakePublicId: INTAKE, proposalPublicId: PROPOSAL }, result: { publicId: "0198c481-3e2b-7000-8000-000000000202", status: "fixture", ...noRepostLineage, transactions: [] } },
        ],
        run: (mcp) => paymentFlow(mcp, {}),
    },
    "payment-batch-unique-exact": {
        script: [
            { name: "payment.batch.create", arguments: { idempotencyKey: "batch-unique-1" }, result: batchFixture("0198c481-3e2b-7000-8000-000000000501") },
            { name: "payment.batch.item.add", arguments: { batchPublicId: "0198c481-3e2b-7000-8000-000000000501", paymentIntakePublicId: INTAKE, itemOrder: 1 }, result: batchFixture("0198c481-3e2b-7000-8000-000000000501") },
            { name: "payment.batch.get", arguments: { batchPublicId: "0198c481-3e2b-7000-8000-000000000501" }, result: batchFixture("0198c481-3e2b-7000-8000-000000000501") },
            { name: "payment.batch.preview", arguments: { batchPublicId: "0198c481-3e2b-7000-8000-000000000501", borrowerPublicId: BORROWER_A }, result: batchPreviewFixture("0198c481-3e2b-7000-8000-000000000501") },
            { name: "payment.batch.execute", arguments: { batchPublicId: "0198c481-3e2b-7000-8000-000000000501", previewPublicId: "0198c481-3e2b-7000-8000-000000000503", previewHash: "a".repeat(64), confirmationHash: "b".repeat(64), confirmed: true, idempotencyKey: "batch-execute-1" }, result: batchExecutionFixture("0198c481-3e2b-7000-8000-000000000501") },
        ],
        run: async (mcp) => { await mcp.call("payment.batch.create", { idempotencyKey: "batch-unique-1" }); await mcp.call("payment.batch.item.add", { batchPublicId: "0198c481-3e2b-7000-8000-000000000501", paymentIntakePublicId: INTAKE, itemOrder: 1 }); await mcp.call("payment.batch.get", { batchPublicId: "0198c481-3e2b-7000-8000-000000000501" }); await mcp.call("payment.batch.preview", { batchPublicId: "0198c481-3e2b-7000-8000-000000000501", borrowerPublicId: BORROWER_A }); await mcp.call("payment.batch.execute", { batchPublicId: "0198c481-3e2b-7000-8000-000000000501", previewPublicId: "0198c481-3e2b-7000-8000-000000000503", previewHash: "a".repeat(64), confirmationHash: "b".repeat(64), confirmed: true, idempotencyKey: "batch-execute-1" }); return { outcome: "completed" } as const; },
    },
    "payment-batch-ambiguous-stops": {
        script: [{ name: "payment.batch.create", arguments: { idempotencyKey: "batch-ambiguous-1" }, result: batchFixture("0198c481-3e2b-7000-8000-000000000504") }, { name: "payment.batch.item.add", arguments: { batchPublicId: "0198c481-3e2b-7000-8000-000000000504", paymentIntakePublicId: INTAKE, itemOrder: 1 }, result: batchFixture("0198c481-3e2b-7000-8000-000000000504") }, { name: "payment.batch.preview", arguments: { batchPublicId: "0198c481-3e2b-7000-8000-000000000504", borrowerPublicId: BORROWER_A }, result: { ...batchPreviewFixture("0198c481-3e2b-7000-8000-000000000504"), status: "needs_review", warnings: [{ code: "AMBIGUOUS_ALLOCATION" }] } }],
        run: async (mcp) => { await mcp.call("payment.batch.create", { idempotencyKey: "batch-ambiguous-1" }); await mcp.call("payment.batch.item.add", { batchPublicId: "0198c481-3e2b-7000-8000-000000000504", paymentIntakePublicId: INTAKE, itemOrder: 1 }); await mcp.call("payment.batch.preview", { batchPublicId: "0198c481-3e2b-7000-8000-000000000504", borrowerPublicId: BORROWER_A }); return { outcome: "stopped", stopReason: "batch-human-review-required" } as const; },
    },
    "payment-batch-human-explicit-edit": {
        script: [{ name: "payment.batch.preview", arguments: { batchPublicId: "0198c481-3e2b-7000-8000-000000000506", borrowerPublicId: BORROWER_A, allocations: [{ itemPublicId: "0198c481-3e2b-7000-8000-000000000507", loanPublicId: LOAN_A, schedulePublicId: LOAN_A, amount: "50.00", targetDueDate: "2026-08-23", intent: "on_time" }] }, result: batchPreviewFixture("0198c481-3e2b-7000-8000-000000000506") }],
        run: async (mcp) => { await mcp.call("payment.batch.preview", { batchPublicId: "0198c481-3e2b-7000-8000-000000000506", borrowerPublicId: BORROWER_A, allocations: [{ itemPublicId: "0198c481-3e2b-7000-8000-000000000507", loanPublicId: LOAN_A, schedulePublicId: LOAN_A, amount: "50.00", targetDueDate: "2026-08-23", intent: "on_time" }] }); return { outcome: "completed" } as const; },
    },
    "payment-batch-duplicate-stops": { script: [{ name: "payment.batch.preview", arguments: { batchPublicId: "0198c481-3e2b-7000-8000-000000000508", borrowerPublicId: BORROWER_A }, result: { ...batchPreviewFixture("0198c481-3e2b-7000-8000-000000000508"), status: "needs_review", warnings: [{ code: "DUPLICATE_PAYMENT" }] } }], run: async (mcp) => { await mcp.call("payment.batch.preview", { batchPublicId: "0198c481-3e2b-7000-8000-000000000508", borrowerPublicId: BORROWER_A }); return { outcome: "stopped", stopReason: "batch-duplicate-human-review" } as const; } },
    "payment-batch-same-semantics-repreview": { script: [{ name: "payment.batch.get", arguments: { batchPublicId: "0198c481-3e2b-7000-8000-000000000509" }, result: { ...batchFixture("0198c481-3e2b-7000-8000-000000000509"), status: "preview_required" } }, { name: "payment.batch.preview", arguments: { batchPublicId: "0198c481-3e2b-7000-8000-000000000509", borrowerPublicId: BORROWER_A }, result: batchPreviewFixture("0198c481-3e2b-7000-8000-000000000509") }], run: async (mcp) => { await mcp.call("payment.batch.get", { batchPublicId: "0198c481-3e2b-7000-8000-000000000509" }); await mcp.call("payment.batch.preview", { batchPublicId: "0198c481-3e2b-7000-8000-000000000509", borrowerPublicId: BORROWER_A }); return { outcome: "stopped", stopReason: "batch-confirmation-required-after-repreview" } as const; } },
    "payment-batch-changed-semantics-requires-confirmation": { script: [{ name: "payment.batch.preview", arguments: { batchPublicId: "0198c481-3e2b-7000-8000-000000000510", borrowerPublicId: BORROWER_A }, result: { ...batchPreviewFixture("0198c481-3e2b-7000-8000-000000000510"), status: "needs_review", warnings: [{ code: "BATCH_STATE_CHANGED_SEMANTICS_SAME" }] } }], run: async (mcp) => { await mcp.call("payment.batch.preview", { batchPublicId: "0198c481-3e2b-7000-8000-000000000510", borrowerPublicId: BORROWER_A }); return { outcome: "stopped", stopReason: "batch-repreview-required" } as const; } },
    "payment-batch-resumable-staging": {
        script: [
            { name: "payment.batch.stage", arguments: { idempotencyKey: "staging-workflow-1", items: [{ clientItemKey: "slip-1", payerName: "Synthetic payer", bankReference: null }] }, result: { batchPublicId: stagingWorkflowBatch, status: "draft", items: [{ publicId: stagingWorkflowItem, clientItemKey: "slip-1", status: "staged" }], auditPublicId: stagingWorkflowAudit, correlationId: stagingWorkflowCorrelation } },
            { name: "payment.batch.workspace", arguments: { batchPublicId: stagingWorkflowBatch }, result: stagingWorkflowWorkspace },
            { name: "payment.batch.candidates", arguments: { stagingItemPublicId: stagingWorkflowItem, borrowerQuery: "Synthetic borrower" }, result: stagingWorkflowCandidates },
            { name: "payment.batch.staging.evidence.prepare", arguments: { stagingItemPublicId: stagingWorkflowItem, mimeType: "image/jpeg", size: PAYMENT_EVIDENCE_BYTES.byteLength, sha256: FILE_HASH }, result: { evidencePublicId: stagingWorkflowEvidence, stagingItemPublicId: stagingWorkflowItem, status: "pending", uploadUrl: "https://storage.example/staging-upload", expiresAt: "2026-08-23T05:00:00.000Z", requiredHeaders: {}, immutable: false, auditPublicId: stagingWorkflowAudit, correlationId: stagingWorkflowCorrelation } },
            { name: "payment.batch.staging.evidence.finalize", arguments: { stagingItemPublicId: stagingWorkflowItem, evidencePublicId: stagingWorkflowEvidence }, result: { evidencePublicId: stagingWorkflowEvidence, status: "ready", sha256: FILE_HASH, auditPublicId: stagingWorkflowAudit, correlationId: stagingWorkflowCorrelation } },
            { name: "payment.batch.staging.review", arguments: { stagingItemPublicId: stagingWorkflowItem, amount: "120.00", receivedAt: "2026-08-23T04:00:00.000Z", reviewedReason: "Human reviewed synthetic slip", intakeIdempotencyKey: "staging-intake-1" }, result: { stagingItemPublicId: stagingWorkflowItem, status: "reviewed", paymentIntakePublicId: INTAKE, batchItemPublicId: stagingWorkflowBatchItem, receipt: { operationType: "staging.review", operationKey: "staging-intake-1" }, auditPublicId: stagingWorkflowAudit, correlationId: stagingWorkflowCorrelation } },
            { name: "payment.batch.preview", arguments: { batchPublicId: stagingWorkflowBatch, borrowerPublicId: BORROWER_A, allocations: [{ itemPublicId: stagingWorkflowItem, borrowerPublicId: BORROWER_A, loanPublicId: LOAN_A, schedulePublicId: null, amount: "120.00", targetDueDate: "2026-08-23", intent: "on_time" }] }, result: stagingWorkflowPreview },
            { name: "payment.batch.decision", arguments: { batchPublicId: stagingWorkflowBatch, previewPublicId: stagingWorkflowPreview.publicId, previewHash: stagingWorkflowPreview.previewHash, revision: 1, action: "confirm_no_older_pending", reason: "Reviewed synthetic chronology", fromDate: "2026-08-23", toDate: "2026-08-23", idempotencyKey: "staging-decision-1" }, result: { decisionPublicId: stagingWorkflowDecision, batchPublicId: stagingWorkflowBatch, revision: 1, action: "confirm_no_older_pending", auditPublicId: stagingWorkflowAudit, correlationId: stagingWorkflowCorrelation } },
            { name: "payment.batch.preview", arguments: { batchPublicId: stagingWorkflowBatch, borrowerPublicId: BORROWER_A, decisionPublicId: stagingWorkflowDecision, allocations: [{ itemPublicId: stagingWorkflowItem, borrowerPublicId: BORROWER_A, loanPublicId: LOAN_A, schedulePublicId: null, amount: "120.00", targetDueDate: "2026-08-23", intent: "on_time" }] }, result: stagingWorkflowPreview },
            { name: "payment.batch.execute", arguments: { batchPublicId: stagingWorkflowBatch, previewPublicId: stagingWorkflowPreview.publicId, previewHash: stagingWorkflowPreview.previewHash, confirmationHash: stagingWorkflowPreview.confirmationHash, confirmed: true, idempotencyKey: "staging-execute-1" }, result: batchExecutionFixture(stagingWorkflowBatch) },
        ],
        run: async (mcp) => {
            for (const step of [
                ["payment.batch.stage", { idempotencyKey: "staging-workflow-1", items: [{ clientItemKey: "slip-1", payerName: "Synthetic payer", bankReference: null }] }],
                ["payment.batch.workspace", { batchPublicId: stagingWorkflowBatch }],
                ["payment.batch.candidates", { stagingItemPublicId: stagingWorkflowItem, borrowerQuery: "Synthetic borrower" }],
                ["payment.batch.staging.evidence.prepare", { stagingItemPublicId: stagingWorkflowItem, mimeType: "image/jpeg", size: PAYMENT_EVIDENCE_BYTES.byteLength, sha256: FILE_HASH }],
                ["payment.batch.staging.evidence.finalize", { stagingItemPublicId: stagingWorkflowItem, evidencePublicId: stagingWorkflowEvidence }],
                ["payment.batch.staging.review", { stagingItemPublicId: stagingWorkflowItem, amount: "120.00", receivedAt: "2026-08-23T04:00:00.000Z", reviewedReason: "Human reviewed synthetic slip", intakeIdempotencyKey: "staging-intake-1" }],
            ] as const) await mcp.call(step[0] as McpToolName, step[1]);
            await mcp.call("payment.batch.preview", { batchPublicId: stagingWorkflowBatch, borrowerPublicId: BORROWER_A, allocations: [{ itemPublicId: stagingWorkflowItem, borrowerPublicId: BORROWER_A, loanPublicId: LOAN_A, schedulePublicId: null, amount: "120.00", targetDueDate: "2026-08-23", intent: "on_time" }] });
            await mcp.call("payment.batch.decision", { batchPublicId: stagingWorkflowBatch, previewPublicId: stagingWorkflowPreview.publicId, previewHash: stagingWorkflowPreview.previewHash, revision: 1, action: "confirm_no_older_pending", reason: "Reviewed synthetic chronology", fromDate: "2026-08-23", toDate: "2026-08-23", idempotencyKey: "staging-decision-1" });
            await mcp.call("payment.batch.preview", { batchPublicId: stagingWorkflowBatch, borrowerPublicId: BORROWER_A, decisionPublicId: stagingWorkflowDecision, allocations: [{ itemPublicId: stagingWorkflowItem, borrowerPublicId: BORROWER_A, loanPublicId: LOAN_A, schedulePublicId: null, amount: "120.00", targetDueDate: "2026-08-23", intent: "on_time" }] });
            await mcp.call("payment.batch.execute", { batchPublicId: stagingWorkflowBatch, previewPublicId: stagingWorkflowPreview.publicId, previewHash: stagingWorkflowPreview.previewHash, confirmationHash: stagingWorkflowPreview.confirmationHash, confirmed: true, idempotencyKey: "staging-execute-1" });
            return { outcome: "completed" } as const;
        },
    },
    "payment-slip": {
        script: [
            { name: "intake.create", arguments: intakeArgs, result: { publicId: INTAKE, duplicate: false, status: "fixture", warnings: [], duplicateReason: null, ...noRepostLineage } },
            { name: "evidence.prepare", arguments: { paymentIntakePublicId: INTAKE, mimeType: "image/jpeg", size: PAYMENT_EVIDENCE_BYTES.byteLength, sha256: FILE_HASH, evidenceType: "slip" }, result: { publicId: EVIDENCE, filePublicId: EVIDENCE_FILE, duplicate: false, uploadUrl: "https://storage.example/payment-upload", requiredHeaders: {} } },
            { name: "evidence.finalize", arguments: { paymentIntakePublicId: INTAKE, evidencePublicId: EVIDENCE }, result: { publicId: EVIDENCE, status: "ready", sha256: FILE_HASH, filePublicId: EVIDENCE_FILE } },
            { name: "payment.preview", arguments: { paymentIntakePublicId: INTAKE }, result: { publicId: PROPOSAL, status: "ready", version: -9007199254740991, warnings: [], totalAllocated: "0.00", allocations: [] } },
            { name: "payment.reconcile.preflight", arguments: { paymentIntakePublicId: INTAKE, proposalPublicId: PROPOSAL, reason: "Normal payment execution preflight" }, result: { status: "ready_to_execute", wouldWrite: false, sourcePaymentPublicId: INTAKE, affectedLoanPublicIds: [LOAN_A], exactAmount: "300.00", proposedComponents: { principal: "0.00", interest: "0.00", fee: "0.00", penalty: "0.00" }, allocationPlan: [{ loanPublicId: LOAN_A, component: "principal", amount: "300.00" }], checks: [{ name: "source", status: "pass" }], previewHash: "v1:" + "a".repeat(64), expectedBalanceVersion: "v1:" + "b".repeat(64), reviewRequired: false } },
            { name: "payment.post", arguments: { paymentIntakePublicId: INTAKE, proposalPublicId: PROPOSAL }, result: { publicId: "0198c481-3e2b-7000-8000-000000000205", status: "fixture", ...noRepostLineage, transactions: [] } },
        ],
        run: (mcp) => paymentFlow(mcp, { evidence: true, preflight: true }),
    },
    "payment-restore-evidence": {
        script: [
            { name: "payment.restore.create", arguments: { paymentIntakePublicId: INTAKE, reason: "Restore corrected 08/09 payment after posting 07/09", idempotencyKey: "restore-draft-20260908-1" }, result: { sourcePaymentPublicId: INTAKE, restoreDraftPublicId: ORIGINAL_INTAKE, status: "draft", auditPublicId: COMMISSION_AUDIT, correlationId: COMMISSION_CORRELATION } },
            { name: "payment.restore.evidence.prepare", arguments: { restoreDraftPublicId: ORIGINAL_INTAKE, mimeType: "image/jpeg", size: PAYMENT_EVIDENCE_BYTES.byteLength, sha256: FILE_HASH, originalName: "corrected-slip.jpg" }, result: { publicId: EVIDENCE, evidencePublicId: EVIDENCE, filePublicId: EVIDENCE_FILE, status: "pending", uploadUrl: "https://storage.example/restore-upload", requiredHeaders: {} } },
            { name: "payment.restore.evidence.finalize", arguments: { restoreDraftPublicId: ORIGINAL_INTAKE, evidencePublicId: EVIDENCE }, result: { publicId: EVIDENCE, evidencePublicId: EVIDENCE, status: "ready", sha256: FILE_HASH, filePublicId: EVIDENCE_FILE } },
        ],
        run: paymentRestoreEvidenceFlow,
    },
    "payment-chatgpt-file-import": {
        script: [
            { name: "intake.create", arguments: intakeArgs, result: { publicId: INTAKE, duplicate: false, status: "fixture", warnings: [], duplicateReason: null, ...noRepostLineage } },
            { name: "evidence.import-chatgpt-file", arguments: { paymentIntakePublicId: INTAKE, idempotencyKey: "chatgpt-import-1", chatgptFile: CHATGPT_FILE }, result: { publicId: EVIDENCE, status: "ready", sha256: FILE_HASH, filePublicId: EVIDENCE_FILE, auditPublicId: COMMISSION_AUDIT, correlationId: COMMISSION_CORRELATION } },
            { name: "payment.preview", arguments: { paymentIntakePublicId: INTAKE }, result: { publicId: PROPOSAL, status: "ready", version: -9007199254740991, warnings: [], totalAllocated: "0.00", allocations: [] } },
            { name: "payment.reconcile.preflight", arguments: { paymentIntakePublicId: INTAKE, proposalPublicId: PROPOSAL, reason: "Normal payment execution preflight" }, result: { status: "ready_to_execute", wouldWrite: false, sourcePaymentPublicId: INTAKE, affectedLoanPublicIds: [LOAN_A], exactAmount: "300.00", proposedComponents: { principal: "0.00", interest: "0.00", fee: "0.00", penalty: "0.00" }, allocationPlan: [{ loanPublicId: LOAN_A, component: "principal", amount: "300.00" }], checks: [{ name: "source", status: "pass" }], previewHash: PREVIEW_HASH, expectedBalanceVersion: BALANCE_VERSION, reviewRequired: false } },
            { name: "payment.post", arguments: { paymentIntakePublicId: INTAKE, proposalPublicId: PROPOSAL }, result: { publicId: INTAKE, status: "posted", ...noRepostLineage, transactions: [] } },
        ], run: (mcp) => chatGptPaymentFlow(mcp),
    },
    "payment-chatgpt-file-retry": {
        script: [
            { name: "intake.create", arguments: intakeArgs, result: { publicId: INTAKE, duplicate: false, status: "fixture", warnings: [], duplicateReason: null, ...noRepostLineage } },
            ...[0, 1].map(() => ({ name: "evidence.import-chatgpt-file" as const, arguments: { paymentIntakePublicId: INTAKE, idempotencyKey: "chatgpt-import-1", chatgptFile: CHATGPT_FILE }, result: { publicId: EVIDENCE, status: "ready", sha256: FILE_HASH, filePublicId: EVIDENCE_FILE, auditPublicId: COMMISSION_AUDIT, correlationId: COMMISSION_CORRELATION } })),
            { name: "payment.preview", arguments: { paymentIntakePublicId: INTAKE }, result: { publicId: PROPOSAL, status: "ready", version: -9007199254740991, warnings: [], totalAllocated: "0.00", allocations: [] } },
        ], run: (mcp) => chatGptPaymentFlow(mcp, true),
    },
    "payment-chatgpt-file-unavailable": {
        script: [
            { name: "intake.create", arguments: intakeArgs, result: { publicId: INTAKE, duplicate: false, status: "fixture", warnings: [], duplicateReason: null, ...noRepostLineage } },
            { name: "evidence.import-chatgpt-file", arguments: { paymentIntakePublicId: INTAKE, idempotencyKey: "chatgpt-import-1", chatgptFile: CHATGPT_FILE }, error: { code: "CHATGPT_FILE_UNAVAILABLE", message: "Attached file is unavailable", retryable: true, reviewRequired: true, details: {} } },
        ], run: (mcp) => chatGptPaymentFlow(mcp),
    },
    "payment-late-evidence-confirmation": {
        script: [
            { name: "payment.evidence-supplement.import-chatgpt-file", arguments: { paymentIntakePublicId: INTAKE, idempotencyKey: "chatgpt-supplement-import-1", chatgptFile: CHATGPT_FILE }, result: { publicId: SUPPLEMENT, status: "ready", sha256: FILE_HASH, filePublicId: EVIDENCE_FILE, auditPublicId: COMMISSION_AUDIT, correlationId: COMMISSION_CORRELATION } },
            { name: "payment.evidence-supplement.record", arguments: { paymentIntakePublicId: INTAKE, supplementPublicId: SUPPLEMENT, confirmed: true, reason: "evidence_recovered", note: "Recovered after payment review", idempotencyKey: "chatgpt-supplement-record-1" }, result: { publicId: SUPPLEMENT, status: "recorded", sha256: FILE_HASH, filePublicId: EVIDENCE_FILE, auditPublicId: COMMISSION_AUDIT, correlationId: COMMISSION_CORRELATION } },
        ], run: async (mcp) => { await mcp.call("payment.evidence-supplement.import-chatgpt-file", { paymentIntakePublicId: INTAKE, idempotencyKey: "chatgpt-supplement-import-1", chatgptFile: CHATGPT_FILE }); await mcp.call("payment.evidence-supplement.record", { paymentIntakePublicId: INTAKE, supplementPublicId: SUPPLEMENT, confirmed: true, reason: "evidence_recovered", note: "Recovered after payment review", idempotencyKey: "chatgpt-supplement-record-1" }); return { outcome: "completed" } as const; },
    },
    "disbursement-chatgpt-file-import": {
        script: [
            chatGptPayoutDraftStep(),
            chatGptPayoutImportStep(CHATGPT_PAYOUT_FILE_A, "payout-import-a", DISBURSEMENT_EVIDENCE, EVIDENCE_FILE, CHATGPT_PAYOUT_HASH_A),
            chatGptPayoutImportStep(CHATGPT_PAYOUT_FILE_B, "payout-import-b", `${DISBURSEMENT_EVIDENCE.slice(0, -1)}3`, `${EVIDENCE_FILE.slice(0, -1)}4`, CHATGPT_PAYOUT_HASH_B),
            chatGptPayoutListStep([EVIDENCE_FILE, `${EVIDENCE_FILE.slice(0, -1)}4`]),
            { name: "loan.disbursement.post", arguments: { disbursementPublicId: DISBURSEMENT, idempotencyKey: "payout-post-after-evidence" }, result: { publicId: DISBURSEMENT, grossAmount: "2500.00", loanAttributedAmount: "2500.00", channel: "bank_transfer", status: "posted", restructurePublicId: null, sourceBankProfilePublicId: null, payeeHint: "Borrower verified payout account", note: null, disbursedAt: "2026-08-10T11:00:00+07:00", postedAt: "2026-08-10T11:00:00+07:00", reversedAt: null, evidenceFilePublicIds: [EVIDENCE_FILE, `${EVIDENCE_FILE.slice(0, -1)}4`], duplicate: false, auditPublicId: COMMISSION_AUDIT, correlationId: COMMISSION_CORRELATION } },
        ],
        run: (mcp) => chatGptPayoutEvidenceFlow(mcp, { post: true }),
    },
    "disbursement-chatgpt-file-retry": {
        script: [
            chatGptPayoutDraftStep(),
            chatGptPayoutImportStep(CHATGPT_PAYOUT_FILE_A, "payout-import-a", DISBURSEMENT_EVIDENCE, EVIDENCE_FILE, CHATGPT_PAYOUT_HASH_A),
            chatGptPayoutImportStep(CHATGPT_PAYOUT_FILE_A, "payout-import-a", DISBURSEMENT_EVIDENCE, EVIDENCE_FILE, CHATGPT_PAYOUT_HASH_A),
            chatGptPayoutListStep([EVIDENCE_FILE]),
        ],
        run: (mcp) => chatGptPayoutEvidenceFlow(mcp, { retry: true }),
    },
    "disbursement-chatgpt-file-unavailable": {
        script: [
            chatGptPayoutDraftStep(),
            { name: "loan.disbursement.evidence.import-chatgpt-file", arguments: { disbursementPublicId: DISBURSEMENT, idempotencyKey: "payout-import-a", chatgptFile: CHATGPT_PAYOUT_FILE_A }, error: { code: "CHATGPT_FILE_UNAVAILABLE", message: "Attached payout file is unavailable", retryable: true, reviewRequired: true, details: {} } },
        ],
        run: (mcp) => chatGptPayoutEvidenceFlow(mcp),
    },
    "disbursement-chatgpt-file-recipient-mismatch": {
        script: [
            chatGptPayoutDraftStep(),
            chatGptPayoutImportStep(CHATGPT_PAYOUT_FILE_A, "payout-import-a", DISBURSEMENT_EVIDENCE, EVIDENCE_FILE, CHATGPT_PAYOUT_HASH_A),
            chatGptPayoutImportStep(CHATGPT_PAYOUT_FILE_B, "payout-import-b", `${DISBURSEMENT_EVIDENCE.slice(0, -1)}3`, `${EVIDENCE_FILE.slice(0, -1)}4`, CHATGPT_PAYOUT_HASH_B),
            chatGptPayoutListStep([EVIDENCE_FILE, `${EVIDENCE_FILE.slice(0, -1)}4`], "Unverified recipient"),
        ],
        run: (mcp) => chatGptPayoutEvidenceFlow(mcp, { recipientMismatch: true }),
    },
    "payment-preflight-review-stops": {
        script: [
            { name: "intake.create", arguments: intakeArgs, result: { publicId: INTAKE, duplicate: false, status: "fixture", warnings: [], duplicateReason: null, ...noRepostLineage } },
            { name: "payment.preview", arguments: { paymentIntakePublicId: INTAKE }, result: { publicId: PROPOSAL, status: "ready", version: -9007199254740991, warnings: [], totalAllocated: "0.00", allocations: [] } },
            { name: "payment.reconcile.preflight", arguments: { paymentIntakePublicId: INTAKE, proposalPublicId: PROPOSAL, reason: "Normal payment execution preflight" }, error: { code: "PAYMENT_PREFLIGHT_REVIEW_REQUIRED", message: "Review required", retryable: false, reviewRequired: true, details: {} } },
        ],
        run: (mcp) => paymentFlow(mcp, { preflight: true }),
    },
    "payment-stale-repreview": {
        script: [
            { name: "intake.create", arguments: intakeArgs, result: { publicId: INTAKE, duplicate: false, status: "fixture", warnings: [], duplicateReason: null, ...noRepostLineage } },
            { name: "payment.preview", arguments: { paymentIntakePublicId: INTAKE }, result: { status: "stale", publicId: "0198c481-3e2b-7000-8000-000000000206", version: -9007199254740991, warnings: [], totalAllocated: "0.00", allocations: [] } },
            { name: "intake.get", arguments: { paymentIntakePublicId: INTAKE }, result: { publicId: "0198c481-3e2b-7000-8000-000000000207", status: "fixture", ...noRepostLineage, evidence: [], latestProposal: { publicId: "0198c481-3e2b-7000-8000-000000000208", version: -9007199254740991, status: "fixture", warnings: [], totalAllocated: "0.00", allocations: [] } } },
            { name: "payment.preview", arguments: { paymentIntakePublicId: INTAKE }, result: { publicId: PROPOSAL, status: "ready", version: -9007199254740991, warnings: [], totalAllocated: "0.00", allocations: [] } },
            { name: "payment.post", arguments: { paymentIntakePublicId: INTAKE, proposalPublicId: PROPOSAL }, result: { publicId: "0198c481-3e2b-7000-8000-000000000209", status: "fixture", ...noRepostLineage, transactions: [] } },
        ],
        run: (mcp) => paymentFlow(mcp, {}),
    },
    "payment-split-loans": {
        script: [
            { name: "borrower.portfolio", arguments: { borrowerPublicId: BORROWER_A }, result: { borrower: { publicId: "0198c481-3e2b-7000-8000-000000000210", name: "fixture" }, aliases: [], loans: [] } },
            { name: "intake.create", arguments: intakeArgs, result: { publicId: INTAKE, duplicate: false, status: "fixture", warnings: [], duplicateReason: null, ...noRepostLineage } },
            { name: "payment.preview", arguments: { paymentIntakePublicId: INTAKE, allocations }, result: { publicId: PROPOSAL, status: "ready", version: -9007199254740991, warnings: [], totalAllocated: "0.00", allocations: [] } },
            { name: "payment.post", arguments: { paymentIntakePublicId: INTAKE, proposalPublicId: PROPOSAL }, result: { publicId: "0198c481-3e2b-7000-8000-000000000211", status: "fixture", ...noRepostLineage, transactions: [] } },
        ],
        run: async (mcp) => { await mcp.call("borrower.portfolio", { borrowerPublicId: BORROWER_A }); return paymentFlow(mcp, { explicitAllocations: allocations }); },
    },
    "payment-split-borrowers-intermediary": {
        script: [
            { name: "borrower.search", arguments: { query: "พล" }, result: { resolution: "unique", candidates: [{ publicId: BORROWER_A, name: "fixture" }] } },
            { name: "borrower.portfolio", arguments: { borrowerPublicId: BORROWER_A }, result: { borrower: { publicId: "0198c481-3e2b-7000-8000-000000000212", name: "fixture" }, aliases: [], loans: [] } },
            { name: "borrower.search", arguments: { query: "ลอย" }, result: { resolution: "unique", candidates: [{ publicId: BORROWER_B, name: "fixture" }] } },
            { name: "borrower.portfolio", arguments: { borrowerPublicId: BORROWER_B }, result: { borrower: { publicId: "0198c481-3e2b-7000-8000-000000000213", name: "fixture" }, aliases: [], loans: [] } },
            { name: "intake.create", arguments: intakeArgs, result: { publicId: INTAKE, duplicate: false, status: "fixture", warnings: [], duplicateReason: null, ...noRepostLineage } },
            { name: "payment.preview", arguments: { paymentIntakePublicId: INTAKE, allocations: [allocations[0], { borrowerPublicId: BORROWER_B, loanPublicId: LOAN_B, amount: "300.00" }] }, result: { publicId: PROPOSAL, status: "needs_review", version: -9007199254740991, warnings: [], totalAllocated: "0.00", allocations: [] } },
        ],
        run: async (mcp) => {
            for (const query of ["พล", "ลอย"]) {
                const found = await mcp.call("borrower.search", { query });
                await mcp.call("borrower.portfolio", { borrowerPublicId: (found.candidates as Array<{ publicId: string }>)[0]!.publicId });
            }
            return paymentFlow(mcp, { explicitAllocations: [allocations[0], { borrowerPublicId: BORROWER_B, loanPublicId: LOAN_B, amount: "300.00" }] });
        },
    },
    "payment-partial": {
        script: [
            { name: "borrower.portfolio", arguments: { borrowerPublicId: BORROWER_A }, result: { borrower: { publicId: "0198c481-3e2b-7000-8000-000000000214", name: "fixture" }, aliases: [], loans: [] } },
            { name: "intake.create", arguments: intakeArgs, result: { publicId: INTAKE, duplicate: false, status: "fixture", warnings: [], duplicateReason: null, ...noRepostLineage } },
            { name: "payment.preview", arguments: { paymentIntakePublicId: INTAKE, allocations: partialAllocation }, result: { publicId: PROPOSAL, status: "ready", version: -9007199254740991, warnings: [], totalAllocated: "0.00", allocations: [] } },
            { name: "payment.post", arguments: { paymentIntakePublicId: INTAKE, proposalPublicId: PROPOSAL }, result: { publicId: "0198c481-3e2b-7000-8000-000000000215", status: "fixture", ...noRepostLineage, transactions: [] } },
        ],
        run: async (mcp) => { await mcp.call("borrower.portfolio", { borrowerPublicId: BORROWER_A }); return paymentFlow(mcp, { explicitAllocations: partialAllocation }); },
    },
    "loan-draft-activation": {
        script: [
            { name: "borrower.search", arguments: { query: "กนกพิชญ์" }, result: { resolution: "unique", candidates: [{ publicId: BORROWER_A, name: "fixture" }] } },
            { name: "borrower.portfolio", arguments: { borrowerPublicId: BORROWER_A }, result: { borrower: { publicId: "0198c481-3e2b-7000-8000-000000000216", name: "fixture" }, aliases: [], loans: [] } },
            { name: "loan.preview", arguments: loanTerms, result: { terms: { principal: "0.00", interestRate: "0.00", termMonths: 1, repaymentType: "daily", startDate: "2026-08-15" }, schedule: [], floatingDailyInterest: { mode: "per_thousand", rate: "0.00", firstDayTreatment: "deduct" }, firstDayInterest: "0.00", dailyInterestAtCurrentPrincipal: "0.00", netDisbursement: "0.00", nextInterestDate: "2026-08-15" } },
            { name: "loan.draft", arguments: { borrowerPublicId: BORROWER_A, ...loanTerms }, result: { publicId: DRAFT, principal: "0.00", principalAmount: "0.00", interestRate: "0.00", repaymentType: "daily", termMonths: -9007199254740991, installmentAmount: "0.00", totalInstallments: -9007199254740991, startDate: "2026-08-15", nextDueDate: "2026-08-15", outstandingPrincipal: "0.00", outstandingInterest: "0.00", outstandingFees: "0.00", status: "fixture" } },
            { name: "loan.activate", arguments: { loanPublicId: DRAFT, idempotencyKey: "loan-activation-20260811-1" }, result: { publicId: "0198c481-3e2b-7000-8000-000000000217", principal: "0.00", principalAmount: "0.00", interestRate: "0.00", repaymentType: "daily", termMonths: -9007199254740991, installmentAmount: "0.00", totalInstallments: -9007199254740991, startDate: "2026-08-15", nextDueDate: "2026-08-15", outstandingPrincipal: "0.00", outstandingInterest: "0.00", outstandingFees: "0.00", status: "fixture" } },
        ],
        run: loanActivation,
    },
    "floating-rate-scheduled-change": {
        script: [
            { name: "loan.interest-rate.list", arguments: { loanPublicId: LOAN_A }, result: { earliestEditableDate: "2026-08-12", loanPublicId: "0198c481-3e2b-7000-8000-000000000218", asOfDate: "2026-08-15", currentPeriod: { publicId: "0198c481-3e2b-7000-8000-000000000219", effectiveDate: "2026-08-15", expiryDate: "2026-08-15", rateType: "percent", rate: "0.00" }, dailyInterestAtCurrentPrincipal: "0.00", nextChange: { publicId: "0198c481-3e2b-7000-8000-000000000220", effectiveDate: "2026-08-15", expiryDate: "2026-08-15", rateType: "percent", rate: "0.00" }, timeline: [], timelineVersion: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } },
            { name: "loan.interest-rate.preview", arguments: { loanPublicId: LOAN_A, effectiveDate: "2026-09-01", expiryDate: null, rateType: "percent", rate: "1" }, result: { publicId: RATE_PREVIEW, previewHash: PREVIEW_HASH, expiresAt: "2026-08-11T10:15:00+07:00", id: "0198c481-3e2b-7000-8000-000000000221", loanPublicId: "0198c481-3e2b-7000-8000-000000000222", request: { effectiveDate: "2026-08-15", expiryDate: "2026-08-15", rateType: "percent", rate: "0.00" }, beforeTimeline: [], afterTimeline: [], supersededPeriodPublicIds: [], warnings: [], timelineVersion: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } },
            { name: "loan.interest-rate.execute", arguments: { loanPublicId: LOAN_A, previewPublicId: RATE_PREVIEW, previewHash: PREVIEW_HASH, confirmed: true, reason: "Owner confirmed scheduled September rate", idempotencyKey: "rate-change-20260901-1" }, result: { loanPublicId: "0198c481-3e2b-7000-8000-000000000223", asOfDate: "2026-08-15", currentPeriod: { publicId: "0198c481-3e2b-7000-8000-000000000224", effectiveDate: "2026-08-15", expiryDate: "2026-08-15", rateType: "percent", rate: "0.00" }, dailyInterestAtCurrentPrincipal: "0.00", nextChange: { publicId: "0198c481-3e2b-7000-8000-000000000225", effectiveDate: "2026-08-15", expiryDate: "2026-08-15", rateType: "percent", rate: "0.00" }, earliestEditableDate: "2026-08-15", timeline: [], timelineVersion: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", auditPublicId: "0198c481-3e2b-7000-8000-000000000226", correlationId: "0198c481-3e2b-7000-8000-000000000227" } },
        ],
        run: async (mcp) => {
            await mcp.call("loan.interest-rate.list", { loanPublicId: LOAN_A });
            const preview = await mcp.call("loan.interest-rate.preview", { loanPublicId: LOAN_A, effectiveDate: "2026-09-01", expiryDate: null, rateType: "percent", rate: "1" });
            await mcp.call("loan.interest-rate.execute", { loanPublicId: LOAN_A, previewPublicId: preview.publicId, previewHash: preview.previewHash, confirmed: true, reason: "Owner confirmed scheduled September rate", idempotencyKey: "rate-change-20260901-1" });
            return { outcome: "completed" } as const;
        },
    },
    "floating-rate-missing-confirmation": {
        script: [
            { name: "loan.interest-rate.list", arguments: { loanPublicId: LOAN_A }, result: { earliestEditableDate: "2026-08-12", loanPublicId: "0198c481-3e2b-7000-8000-000000000228", asOfDate: "2026-08-15", currentPeriod: { publicId: "0198c481-3e2b-7000-8000-000000000229", effectiveDate: "2026-08-15", expiryDate: "2026-08-15", rateType: "percent", rate: "0.00" }, dailyInterestAtCurrentPrincipal: "0.00", nextChange: { publicId: "0198c481-3e2b-7000-8000-000000000230", effectiveDate: "2026-08-15", expiryDate: "2026-08-15", rateType: "percent", rate: "0.00" }, timeline: [], timelineVersion: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } },
            { name: "loan.interest-rate.preview", arguments: { loanPublicId: LOAN_A, effectiveDate: "2026-09-01", expiryDate: null, rateType: "percent", rate: "1" }, result: { publicId: RATE_PREVIEW, previewHash: PREVIEW_HASH, id: "0198c481-3e2b-7000-8000-000000000231", loanPublicId: "0198c481-3e2b-7000-8000-000000000232", request: { effectiveDate: "2026-08-15", expiryDate: "2026-08-15", rateType: "percent", rate: "0.00" }, beforeTimeline: [], afterTimeline: [], supersededPeriodPublicIds: [], warnings: [], timelineVersion: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", expiresAt: "2026-08-15T06:30:00.000Z" } },
        ],
        run: async (mcp) => {
            await mcp.call("loan.interest-rate.list", { loanPublicId: LOAN_A });
            await mcp.call("loan.interest-rate.preview", { loanPublicId: LOAN_A, effectiveDate: "2026-09-01", expiryDate: null, rateType: "percent", rate: "1" });
            return { outcome: "stopped", stopReason: "rate-change-confirmation-required" } as const;
        },
    },
    "floating-settlement-execute": {
        script: [
            { name: "borrower.portfolio", arguments: { borrowerPublicId: BORROWER_A }, result: { loans: [{ publicId: LOAN_A, repaymentType: "floating", status: "active", replacementLineage: null, principal: "0.00", interestRate: "0.00", startDate: "2026-08-15" }], borrower: { publicId: "0198c481-3e2b-7000-8000-000000000233", name: "fixture" }, aliases: [] } },
            { name: "loan.settlement.preview", arguments: { loanPublicId: LOAN_A, asOfDate: "2026-08-15" }, result: { publicId: SETTLEMENT, previewHash: SETTLEMENT_PREVIEW_HASH, status: "ready", outstandingPrincipal: "5000.00", dueInterest: "25.00", accruedNotDueInterest: "17.14", outstandingFees: "10.00", outstandingPenalties: "5.00", nonRefundableAdvanceInterest: "600.00", settlementTotal: "5057.14", expiresAt: SETTLEMENT_EXPIRES_AT, balanceVersion: SETTLEMENT_BALANCE_VERSION, id: "0198c481-3e2b-7000-8000-000000000234", loanPublicId: "0198c481-3e2b-7000-8000-000000000235", asOfDate: "2026-08-15", hashVersion: "v1", executedAt: "2026-08-15T06:30:00.000Z", createdAt: "2026-08-15T06:30:00.000Z", updatedAt: "2026-08-15T06:30:00.000Z" } },
            { name: "loan.settlement.execute", arguments: { settlementPublicId: SETTLEMENT, previewHash: SETTLEMENT_PREVIEW_HASH, confirmed: true, reason: "Borrower confirmed the exact displayed close-out", idempotencyKey: "floating-settlement-20260815-1" }, result: { publicId: SETTLEMENT, status: "executed", settlementTotal: "5057.14", id: "0198c481-3e2b-7000-8000-000000000236", loanPublicId: "0198c481-3e2b-7000-8000-000000000237", asOfDate: "2026-08-15", outstandingPrincipal: "0.00", dueInterest: "0.00", accruedNotDueInterest: "0.00", outstandingFees: "0.00", outstandingPenalties: "0.00", nonRefundableAdvanceInterest: "0.00", balanceVersion: "v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", previewHash: "v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", hashVersion: "v1", expiresAt: "2026-08-15T06:30:00.000Z", executedAt: "2026-08-15T06:30:00.000Z", createdAt: "2026-08-15T06:30:00.000Z", updatedAt: "2026-08-15T06:30:00.000Z", transaction: { id: "0198c481-3e2b-7000-8000-000000000238", publicId: "0198c481-3e2b-7000-8000-000000000239", amount: "0.00", principalComponent: "0.00", interestComponent: "0.00", feeComponent: "0.00", penaltyComponent: "0.00", type: "close_account", entryType: "repayment", transactionDate: "2026-08-15T06:30:00.000Z", postedAt: "2026-08-15T06:30:00.000Z" }, reason: "fixture", auditPublicId: "0198c481-3e2b-7000-8000-000000000240", correlationId: "0198c481-3e2b-7000-8000-000000000241" } },
        ],
        run: (mcp) => floatingSettlement(mcp, { confirmed: true }),
    },
    "floating-settlement-missing-confirmation": {
        script: [
            { name: "borrower.portfolio", arguments: { borrowerPublicId: BORROWER_A }, result: { loans: [{ publicId: LOAN_A, repaymentType: "floating", status: "active", replacementLineage: null, principal: "0.00", interestRate: "0.00", startDate: "2026-08-15" }], borrower: { publicId: "0198c481-3e2b-7000-8000-000000000242", name: "fixture" }, aliases: [] } },
            { name: "loan.settlement.preview", arguments: { loanPublicId: LOAN_A, asOfDate: "2026-08-15" }, result: { publicId: SETTLEMENT, previewHash: SETTLEMENT_PREVIEW_HASH, status: "ready", outstandingPrincipal: "5000.00", dueInterest: "25.00", accruedNotDueInterest: "17.14", outstandingFees: "10.00", outstandingPenalties: "5.00", nonRefundableAdvanceInterest: "600.00", settlementTotal: "5057.14", expiresAt: SETTLEMENT_EXPIRES_AT, balanceVersion: SETTLEMENT_BALANCE_VERSION, id: "0198c481-3e2b-7000-8000-000000000243", loanPublicId: "0198c481-3e2b-7000-8000-000000000244", asOfDate: "2026-08-15", hashVersion: "v1", executedAt: "2026-08-15T06:30:00.000Z", createdAt: "2026-08-15T06:30:00.000Z", updatedAt: "2026-08-15T06:30:00.000Z" } },
        ],
        run: (mcp) => floatingSettlement(mcp),
    },
    "floating-settlement-stale-preview": {
        script: [
            { name: "borrower.portfolio", arguments: { borrowerPublicId: BORROWER_A }, result: { loans: [{ publicId: LOAN_A, repaymentType: "floating", status: "active", replacementLineage: null, principal: "0.00", interestRate: "0.00", startDate: "2026-08-15" }], borrower: { publicId: "0198c481-3e2b-7000-8000-000000000245", name: "fixture" }, aliases: [] } },
            { name: "loan.settlement.preview", arguments: { loanPublicId: LOAN_A, asOfDate: "2026-08-15" }, result: { publicId: SETTLEMENT, previewHash: SETTLEMENT_PREVIEW_HASH, status: "ready", outstandingPrincipal: "5000.00", dueInterest: "25.00", accruedNotDueInterest: "17.14", outstandingFees: "10.00", outstandingPenalties: "5.00", nonRefundableAdvanceInterest: "600.00", settlementTotal: "5057.14", expiresAt: SETTLEMENT_EXPIRES_AT, balanceVersion: SETTLEMENT_BALANCE_VERSION, id: "0198c481-3e2b-7000-8000-000000000246", loanPublicId: "0198c481-3e2b-7000-8000-000000000247", asOfDate: "2026-08-15", hashVersion: "v1", executedAt: "2026-08-15T06:30:00.000Z", createdAt: "2026-08-15T06:30:00.000Z", updatedAt: "2026-08-15T06:30:00.000Z" } },
            { name: "loan.settlement.execute", arguments: { settlementPublicId: SETTLEMENT, previewHash: SETTLEMENT_PREVIEW_HASH, confirmed: true, reason: "Borrower confirmed the exact displayed close-out", idempotencyKey: "floating-settlement-20260815-1" }, error: { code: "STALE_SETTLEMENT_PREVIEW", message: "Loan settlement preview is stale", retryable: false, reviewRequired: false, details: {} } },
            { name: "borrower.portfolio", arguments: { borrowerPublicId: BORROWER_A }, result: { loans: [{ publicId: LOAN_A, repaymentType: "floating", status: "active", replacementLineage: null, principal: "0.00", interestRate: "0.00", startDate: "2026-08-15" }], borrower: { publicId: "0198c481-3e2b-7000-8000-000000000248", name: "fixture" }, aliases: [] } },
            { name: "loan.settlement.preview", arguments: { loanPublicId: LOAN_A, asOfDate: "2026-08-15" }, result: { publicId: "0198c481-3e2b-7000-8000-000000000072", previewHash: `v1:${"e".repeat(64)}`, status: "ready", outstandingPrincipal: "4900.00", dueInterest: "25.00", accruedNotDueInterest: "17.14", outstandingFees: "10.00", outstandingPenalties: "5.00", nonRefundableAdvanceInterest: "600.00", settlementTotal: "4957.14", expiresAt: "2026-08-15T06:20:00.000Z", balanceVersion: `v1:${"f".repeat(64)}`, id: "0198c481-3e2b-7000-8000-000000000249", loanPublicId: "0198c481-3e2b-7000-8000-000000000250", asOfDate: "2026-08-15", hashVersion: "v1", executedAt: "2026-08-15T06:30:00.000Z", createdAt: "2026-08-15T06:30:00.000Z", updatedAt: "2026-08-15T06:30:00.000Z" } },
        ],
        run: (mcp) => floatingSettlement(mcp, { confirmed: true }),
    },
    "floating-settlement-non-refundable-refund": {
        script: [
            { name: "borrower.portfolio", arguments: { borrowerPublicId: BORROWER_A }, result: { loans: [{ publicId: LOAN_A, repaymentType: "floating", status: "active", replacementLineage: null, principal: "0.00", interestRate: "0.00", startDate: "2026-08-15" }], borrower: { publicId: "0198c481-3e2b-7000-8000-000000000251", name: "fixture" }, aliases: [] } },
            { name: "loan.settlement.preview", arguments: { loanPublicId: LOAN_A, asOfDate: "2026-08-15" }, result: { publicId: SETTLEMENT, previewHash: SETTLEMENT_PREVIEW_HASH, status: "ready", outstandingPrincipal: "5000.00", dueInterest: "25.00", accruedNotDueInterest: "17.14", outstandingFees: "10.00", outstandingPenalties: "5.00", nonRefundableAdvanceInterest: "600.00", settlementTotal: "5057.14", expiresAt: SETTLEMENT_EXPIRES_AT, balanceVersion: SETTLEMENT_BALANCE_VERSION, id: "0198c481-3e2b-7000-8000-000000000252", loanPublicId: "0198c481-3e2b-7000-8000-000000000253", asOfDate: "2026-08-15", hashVersion: "v1", executedAt: "2026-08-15T06:30:00.000Z", createdAt: "2026-08-15T06:30:00.000Z", updatedAt: "2026-08-15T06:30:00.000Z" } },
        ],
        run: (mcp) => floatingSettlement(mcp, { refundRequested: true }),
    },
    "floating-settlement-reverse": {
        script: [
            { name: "loan.settlement.reverse", arguments: { settlementPublicId: SETTLEMENT, reason: "Owner confirmed correction of duplicate close-out", idempotencyKey: "floating-settlement-reversal-20260815-1" }, result: { settlementPublicId: SETTLEMENT, status: "reversed", transaction: { id: "0198c481-3e2b-7000-8000-000000000073", publicId: "0198c481-3e2b-7000-8000-000000000073", amount: "-5057.14", principalComponent: "-5000.00", interestComponent: "-42.14", feeComponent: "-10.00", penaltyComponent: "-5.00", type: "close_account", entryType: "reversal", transactionDate: "2026-08-15T06:30:00.000Z", postedAt: "2026-08-15T06:30:00.000Z" }, reason: "Owner confirmed correction of duplicate close-out", auditPublicId: "0198c481-3e2b-7000-8000-000000000074", correlationId: "0198c481-3e2b-7000-8000-000000000075" } },
        ],
        run: async (mcp) => {
            await mcp.call("loan.settlement.reverse", { settlementPublicId: SETTLEMENT, reason: "Owner confirmed correction of duplicate close-out", idempotencyKey: "floating-settlement-reversal-20260815-1" });
            return { outcome: "completed" } as const;
        },
    },
    "disbursement-full-lifecycle": {
        script: [
            { name: "loan.disbursement.list", arguments: { loanPublicId: LOAN_A }, result: { summary: { approvedPrincipal: "2500.00", netDisbursed: "0.00", variance: "-2500.00", status: "under_disbursed" }, events: [], loanPublicId: "0198c481-3e2b-7000-8000-000000000254" } },
            { name: "loan.disbursement.draft", arguments: disbursementDraftArgs, result: { publicId: DISBURSEMENT, status: "draft", grossAmount: "0.00", loanAttributedAmount: "0.00", channel: "bank_transfer", restructurePublicId: "0198c481-3e2b-7000-8000-000000000255", sourceBankProfilePublicId: "0198c481-3e2b-7000-8000-000000000256", payeeHint: "fixture", note: "fixture", disbursedAt: "2026-08-15T06:30:00.000Z", postedAt: "2026-08-15T06:30:00.000Z", reversedAt: "2026-08-15T06:30:00.000Z", evidenceFilePublicIds: [] } },
            { name: "loan.disbursement.evidence.prepare", arguments: { disbursementPublicId: DISBURSEMENT, mimeType: "image/jpeg", size: DISBURSEMENT_EVIDENCE_BYTES.byteLength, sha256: DISBURSEMENT_FILE_HASH, originalName: "payout-slip.jpg" }, result: { publicId: DISBURSEMENT_EVIDENCE, filePublicId: EVIDENCE, uploadUrl: "https://storage.example/upload", requiredHeaders: { "content-type": "image/jpeg" }, expiresAt: "2099-01-01T00:00:00+00:00" } },
            { name: "loan.disbursement.evidence.finalize", arguments: { disbursementPublicId: DISBURSEMENT, evidencePublicId: DISBURSEMENT_EVIDENCE }, result: { publicId: DISBURSEMENT_EVIDENCE, filePublicId: EVIDENCE, status: "ready" } },
            { name: "loan.disbursement.list", arguments: { loanPublicId: LOAN_A }, result: { summary: { approvedPrincipal: "2500.00", netDisbursed: "2500.00", variance: "0.00", status: "matched" }, events: [{ publicId: DISBURSEMENT, status: "draft", grossAmount: "0.00", loanAttributedAmount: "0.00", channel: "bank_transfer", restructurePublicId: "0198c481-3e2b-7000-8000-000000000257", sourceBankProfilePublicId: "0198c481-3e2b-7000-8000-000000000258", payeeHint: "fixture", note: "fixture", disbursedAt: "2026-08-15T06:30:00.000Z", postedAt: "2026-08-15T06:30:00.000Z", reversedAt: "2026-08-15T06:30:00.000Z", evidenceFilePublicIds: [] }], loanPublicId: "0198c481-3e2b-7000-8000-000000000259" } },
            { name: "loan.disbursement.post", arguments: { disbursementPublicId: DISBURSEMENT, idempotencyKey: "disbursement-post-20260810-1" }, result: { publicId: DISBURSEMENT, status: "posted", duplicate: false, grossAmount: "0.00", loanAttributedAmount: "0.00", channel: "bank_transfer", restructurePublicId: "0198c481-3e2b-7000-8000-000000000260", sourceBankProfilePublicId: "0198c481-3e2b-7000-8000-000000000261", payeeHint: "fixture", note: "fixture", disbursedAt: "2026-08-15T06:30:00.000Z", postedAt: "2026-08-15T06:30:00.000Z", reversedAt: "2026-08-15T06:30:00.000Z", evidenceFilePublicIds: [], auditPublicId: "0198c481-3e2b-7000-8000-000000000262", correlationId: "0198c481-3e2b-7000-8000-000000000263" } },
            { name: "loan.disbursement.list", arguments: { loanPublicId: LOAN_A }, result: { summary: { approvedPrincipal: "2500.00", netDisbursed: "2500.00", variance: "0.00", status: "matched" }, events: [{ publicId: DISBURSEMENT, status: "posted", grossAmount: "0.00", loanAttributedAmount: "0.00", channel: "bank_transfer", restructurePublicId: "0198c481-3e2b-7000-8000-000000000264", sourceBankProfilePublicId: "0198c481-3e2b-7000-8000-000000000265", payeeHint: "fixture", note: "fixture", disbursedAt: "2026-08-15T06:30:00.000Z", postedAt: "2026-08-15T06:30:00.000Z", reversedAt: "2026-08-15T06:30:00.000Z", evidenceFilePublicIds: [] }], loanPublicId: "0198c481-3e2b-7000-8000-000000000266" } },
            { name: "loan.disbursement.reverse", arguments: { disbursementPublicId: DISBURSEMENT, reason: "Owner confirmed duplicate payout record", idempotencyKey: "disbursement-reverse-20260810-1" }, result: { publicId: DISBURSEMENT, status: "reversed", duplicate: false, grossAmount: "0.00", loanAttributedAmount: "0.00", channel: "bank_transfer", restructurePublicId: "0198c481-3e2b-7000-8000-000000000267", sourceBankProfilePublicId: "0198c481-3e2b-7000-8000-000000000268", payeeHint: "fixture", note: "fixture", disbursedAt: "2026-08-15T06:30:00.000Z", postedAt: "2026-08-15T06:30:00.000Z", reversedAt: "2026-08-15T06:30:00.000Z", evidenceFilePublicIds: [], reversedEventPublicId: "0198c481-3e2b-7000-8000-000000000269", auditPublicId: "0198c481-3e2b-7000-8000-000000000270", correlationId: "0198c481-3e2b-7000-8000-000000000271" } },
        ],
        run: (mcp) => disbursementLifecycle(mcp, { postConfirmed: true, reverseConfirmed: true }),
    },
    "disbursement-draft-update": {
        script: [
            { name: "loan.disbursement.list", arguments: { loanPublicId: LOAN_A }, result: { summary: { approvedPrincipal: "4000.00", netDisbursed: "3940.00", variance: "-60.00", status: "under_disbursed" }, events: [{ publicId: DISBURSEMENT, status: "draft", grossAmount: "4000.00", loanAttributedAmount: "3940.00", evidenceFilePublicIds: [EVIDENCE], channel: "bank_transfer", restructurePublicId: "0198c481-3e2b-7000-8000-000000000272", sourceBankProfilePublicId: "0198c481-3e2b-7000-8000-000000000273", payeeHint: "fixture", note: "fixture", disbursedAt: "2026-08-15T06:30:00.000Z", postedAt: "2026-08-15T06:30:00.000Z", reversedAt: "2026-08-15T06:30:00.000Z" }], loanPublicId: "0198c481-3e2b-7000-8000-000000000274" } },
            { name: "loan.disbursement.update", arguments: { disbursementPublicId: DISBURSEMENT, changes: { loanAttributedAmount: "4000.00", note: "Corrected attribution after owner review" } }, result: { publicId: DISBURSEMENT, status: "draft", grossAmount: "4000.00", loanAttributedAmount: "4000.00", evidenceFilePublicIds: [EVIDENCE], channel: "bank_transfer", restructurePublicId: "0198c481-3e2b-7000-8000-000000000275", sourceBankProfilePublicId: "0198c481-3e2b-7000-8000-000000000276", payeeHint: "fixture", note: "fixture", disbursedAt: "2026-08-15T06:30:00.000Z", postedAt: "2026-08-15T06:30:00.000Z", reversedAt: "2026-08-15T06:30:00.000Z" } },
            { name: "loan.disbursement.list", arguments: { loanPublicId: LOAN_A }, result: { summary: { approvedPrincipal: "4000.00", netDisbursed: "4000.00", variance: "0.00", status: "matched" }, events: [{ publicId: DISBURSEMENT, status: "draft", grossAmount: "4000.00", loanAttributedAmount: "4000.00", evidenceFilePublicIds: [EVIDENCE], channel: "bank_transfer", restructurePublicId: "0198c481-3e2b-7000-8000-000000000277", sourceBankProfilePublicId: "0198c481-3e2b-7000-8000-000000000278", payeeHint: "fixture", note: "fixture", disbursedAt: "2026-08-15T06:30:00.000Z", postedAt: "2026-08-15T06:30:00.000Z", reversedAt: "2026-08-15T06:30:00.000Z" }], loanPublicId: "0198c481-3e2b-7000-8000-000000000279" } },
            { name: "loan.disbursement.post", arguments: { disbursementPublicId: DISBURSEMENT, idempotencyKey: "disbursement-post-after-update-1" }, result: { publicId: DISBURSEMENT, status: "posted", duplicate: false, grossAmount: "0.00", loanAttributedAmount: "0.00", channel: "bank_transfer", restructurePublicId: "0198c481-3e2b-7000-8000-000000000280", sourceBankProfilePublicId: "0198c481-3e2b-7000-8000-000000000281", payeeHint: "fixture", note: "fixture", disbursedAt: "2026-08-15T06:30:00.000Z", postedAt: "2026-08-15T06:30:00.000Z", reversedAt: "2026-08-15T06:30:00.000Z", evidenceFilePublicIds: [], auditPublicId: "0198c481-3e2b-7000-8000-000000000282", correlationId: "0198c481-3e2b-7000-8000-000000000283" } },
        ],
        run: async (mcp) => {
            await mcp.call("loan.disbursement.list", { loanPublicId: LOAN_A });
            await mcp.call("loan.disbursement.update", { disbursementPublicId: DISBURSEMENT, changes: { loanAttributedAmount: "4000.00", note: "Corrected attribution after owner review" } });
            await mcp.call("loan.disbursement.list", { loanPublicId: LOAN_A });
            await mcp.call("loan.disbursement.post", { disbursementPublicId: DISBURSEMENT, idempotencyKey: "disbursement-post-after-update-1" });
            return { outcome: "completed" } as const;
        },
    },
    "renewal-execute": {
        script: [
            { name: "borrower.portfolio", arguments: { borrowerPublicId: BORROWER_A }, result: { borrower: { publicId: "0198c481-3e2b-7000-8000-000000000284", name: "fixture" }, aliases: [], loans: [] } },
            { name: "renewal.preview", arguments: { oldLoanPublicId: LOAN_A, requestedPrincipal: "2000.00" }, result: { ...RENEWAL_COMPOSITION_FIELDS, publicId: RENEWAL, previewHash: PREVIEW_HASH, dueCharges: "233.33", status: "fixture", oldLoanPublicId: "0198c481-3e2b-7000-8000-000000000285", principalPaid: "833.33", outstandingPrincipal: "1166.67", settlementAmount: "233.33", waivedCharges: "0.00", requestedPrincipal: "2000.00", cashDirection: "payout", cashAmount: "600.00" } },
            { name: "renewal.execute", arguments: { renewalPublicId: RENEWAL, previewHash: PREVIEW_HASH, confirmed: true, reason: "Owner confirmed the displayed renewal", idempotencyKey: "renewal-execute-20260810-1" }, result: EXECUTED_RENEWAL_RESULT },
        ],
        run: (mcp) => renewalExecute(mcp),
    },
    "renewal-accrued-policy": {
        script: [
            { name: "borrower.portfolio", arguments: { borrowerPublicId: BORROWER_A }, result: { borrower: { publicId: BORROWER_A, name: "fixture" }, aliases: [], loans: [] } },
            { name: "renewal.preview", arguments: { oldLoanPublicId: LOAN_A, requestedPrincipal: "2000.00", settlementPolicy: "accrued_to_date" }, result: { ...RENEWAL_COMPOSITION_FIELDS, settlementPolicy: "accrued_to_date", composition: { ...RENEWAL_COMPOSITION_FIELDS.composition, settlementPolicy: "accrued_to_date", settlementAmount: "0.00", cashAmount: "833.33" }, publicId: RENEWAL, previewHash: PREVIEW_HASH, dueCharges: "0.00", status: "fixture", oldLoanPublicId: LOAN_A, principalPaid: "833.33", outstandingPrincipal: "1166.67", settlementAmount: "0.00", waivedCharges: "0.00", requestedPrincipal: "2000.00", cashDirection: "payout", cashAmount: "833.33" } },
            { name: "renewal.execute", arguments: { renewalPublicId: RENEWAL, previewHash: PREVIEW_HASH, confirmed: true, reason: "Owner confirmed the displayed renewal", idempotencyKey: "renewal-execute-20260810-1" }, result: { ...EXECUTED_RENEWAL_RESULT, settlementPolicy: "accrued_to_date", composition: { ...RENEWAL_COMPOSITION_FIELDS.composition, settlementPolicy: "accrued_to_date", settlementAmount: "0.00", cashAmount: "833.33" }, cashAmount: "833.33", settlementAmount: "0.00" } },
        ],
        run: (mcp) => renewalExecute(mcp, true, "accrued_to_date"),
    },
    "renewal-independent-dates": {
        script: [
            { name: "borrower.portfolio", arguments: { borrowerPublicId: BORROWER_A }, result: { borrower: { publicId: BORROWER_A, name: "fixture" }, aliases: [], loans: [] } },
            { name: "renewal.preview", arguments: { oldLoanPublicId: LOAN_A, requestedPrincipal: "2000.00", renewalDate: "2026-08-22", paymentStartDate: "2026-08-24" }, result: { ...RENEWAL_COMPOSITION_FIELDS, renewalDate: "2026-08-22", paymentStartDate: "2026-08-24", composition: { ...RENEWAL_COMPOSITION_FIELDS.composition, renewalDate: "2026-08-22" }, publicId: RENEWAL, previewHash: PREVIEW_HASH, dueCharges: "233.33", status: "fixture", oldLoanPublicId: LOAN_A, principalPaid: "833.33", outstandingPrincipal: "1166.67", settlementAmount: "233.33", waivedCharges: "0.00", requestedPrincipal: "2000.00", cashDirection: "payout", cashAmount: "600.00" } },
            { name: "renewal.execute", arguments: { renewalPublicId: RENEWAL, previewHash: PREVIEW_HASH, confirmed: true, reason: "Owner confirmed the dated renewal", idempotencyKey: "renewal-independent-dates-1" }, result: { ...EXECUTED_RENEWAL_RESULT, renewalDate: "2026-08-22", paymentStartDate: "2026-08-24", composition: { ...EXECUTED_RENEWAL_RESULT.composition, renewalDate: "2026-08-22" } } },
        ],
        run: async (mcp) => {
            await mcp.call("borrower.portfolio", { borrowerPublicId: BORROWER_A });
            const preview = await mcp.call("renewal.preview", { oldLoanPublicId: LOAN_A, requestedPrincipal: "2000.00", renewalDate: "2026-08-22", paymentStartDate: "2026-08-24" });
            if (preview.renewalDate !== "2026-08-22" || preview.paymentStartDate !== "2026-08-24") return { outcome: "stopped", stopReason: "renewal-dates-not-preserved" } as const;
            await mcp.call("renewal.execute", { renewalPublicId: preview.publicId, previewHash: preview.previewHash, confirmed: true, reason: "Owner confirmed the dated renewal", idempotencyKey: "renewal-independent-dates-1" });
            return { outcome: "completed" } as const;
        },
    },
    "payment-reversal": {
        script: [
            { name: "intake.get", arguments: { paymentIntakePublicId: INTAKE }, result: { status: "posted", publicId: "0198c481-3e2b-7000-8000-000000000286", ...noRepostLineage, evidence: [], latestProposal: { publicId: "0198c481-3e2b-7000-8000-000000000287", version: -9007199254740991, status: "fixture", warnings: [], totalAllocated: "0.00", allocations: [] } } },
            { name: "payment.reverse", arguments: { paymentIntakePublicId: INTAKE, reason: "Owner confirmed duplicate bank posting" }, result: { publicId: "0198c481-3e2b-7000-8000-000000000288", status: "fixture", ...noRepostLineage, transactions: [] } },
        ],
        run: async (mcp) => { await mcp.call("intake.get", { paymentIntakePublicId: INTAKE }); await mcp.call("payment.reverse", { paymentIntakePublicId: INTAKE, reason: "Owner confirmed duplicate bank posting" }); return { outcome: "completed" }; },
    },
    "scheduled-allocation-correction-ready": {
        script: [
            { name: "intake.get", arguments: { paymentIntakePublicId: INTAKE }, result: { publicId: INTAKE, status: "posted", ...noRepostLineage, evidence: [], latestProposal: null } },
            { name: "payment.allocation-correction.preview", arguments: { paymentIntakePublicId: INTAKE, transactionPublicId: ALLOCATION_SOURCE_TRANSACTION, targetSchedulePublicId: ALLOCATION_TARGET_SCHEDULE, reason: "Move payment to received installment" }, result: allocationPreviewFixture() },
            { name: "payment.allocation-correction.execute", arguments: { correctionPreviewPublicId: ALLOCATION_PREVIEW, previewHash: PREVIEW_HASH, expectedBalanceVersion: BALANCE_VERSION, confirmed: true, reason: "Move payment to received installment", idempotencyKey: "allocation-eval-1" }, result: allocationExecuteFixture },
            { name: "intake.get", arguments: { paymentIntakePublicId: INTAKE }, result: { publicId: INTAKE, status: "posted", ...noRepostLineage, evidence: [], latestProposal: null } },
        ],
        run: async (mcp) => { await mcp.call("intake.get", { paymentIntakePublicId: INTAKE }); const preview = await mcp.call("payment.allocation-correction.preview", { paymentIntakePublicId: INTAKE, transactionPublicId: ALLOCATION_SOURCE_TRANSACTION, targetSchedulePublicId: ALLOCATION_TARGET_SCHEDULE, reason: "Move payment to received installment" }); if (preview.status !== "ready") return { outcome: "stopped", stopReason: "allocation-correction-not-ready" } as const; await mcp.call("payment.allocation-correction.execute", { correctionPreviewPublicId: preview.publicId, previewHash: preview.previewHash, expectedBalanceVersion: preview.expectedBalanceVersion, confirmed: true, reason: "Move payment to received installment", idempotencyKey: "allocation-eval-1" }); await mcp.call("intake.get", { paymentIntakePublicId: INTAKE }); return { outcome: "completed" } as const; },
    },
    "scheduled-allocation-correction-renewal-origin": {
        script: [
            { name: "intake.get", arguments: { paymentIntakePublicId: INTAKE }, result: { publicId: INTAKE, status: "posted", ...noRepostLineage, evidence: [], latestProposal: null } },
            { name: "payment.allocation-correction.preview", arguments: { paymentIntakePublicId: INTAKE, transactionPublicId: ALLOCATION_SOURCE_TRANSACTION, targetSchedulePublicId: ALLOCATION_TARGET_SCHEDULE, reason: "Move payment from renewal-created opening state" }, result: allocationPreviewFixture() },
            { name: "payment.allocation-correction.execute", arguments: { correctionPreviewPublicId: ALLOCATION_PREVIEW, previewHash: PREVIEW_HASH, expectedBalanceVersion: BALANCE_VERSION, confirmed: true, reason: "Move payment from renewal-created opening state", idempotencyKey: "allocation-renewal-origin-1" }, result: allocationExecuteFixture },
            { name: "intake.get", arguments: { paymentIntakePublicId: INTAKE }, result: { publicId: INTAKE, status: "posted", ...noRepostLineage, evidence: [], latestProposal: null } },
        ],
        run: async (mcp) => {
            await mcp.call("intake.get", { paymentIntakePublicId: INTAKE });
            const preview = await mcp.call("payment.allocation-correction.preview", { paymentIntakePublicId: INTAKE, transactionPublicId: ALLOCATION_SOURCE_TRANSACTION, targetSchedulePublicId: ALLOCATION_TARGET_SCHEDULE, reason: "Move payment from renewal-created opening state" });
            if (preview.status !== "ready" || preview.warnings?.length) return { outcome: "stopped", stopReason: "renewal-origin-correction-not-ready" } as const;
            mcp.presentScheduledAllocationCorrection(preview);
            mcp.recordScheduledAllocationCorrectionConfirmation(true);
            await mcp.call("payment.allocation-correction.execute", { correctionPreviewPublicId: preview.publicId, previewHash: preview.previewHash, expectedBalanceVersion: preview.expectedBalanceVersion, confirmed: true, reason: "Move payment from renewal-created opening state", idempotencyKey: "allocation-renewal-origin-1" });
            await mcp.call("intake.get", { paymentIntakePublicId: INTAKE });
            return { outcome: "completed" } as const;
        },
    },
    "scheduled-allocation-correction-blocker": {
        script: [
            { name: "intake.get", arguments: { paymentIntakePublicId: INTAKE }, result: { publicId: INTAKE, status: "posted", ...noRepostLineage, evidence: [], latestProposal: null } },
            { name: "payment.allocation-correction.preview", arguments: { paymentIntakePublicId: INTAKE, transactionPublicId: ALLOCATION_SOURCE_TRANSACTION, targetSchedulePublicId: ALLOCATION_TARGET_SCHEDULE, reason: "Blocked correction" }, result: allocationPreviewFixture("blocked") },
        ],
        run: async (mcp) => { await mcp.call("intake.get", { paymentIntakePublicId: INTAKE }); const preview = await mcp.call("payment.allocation-correction.preview", { paymentIntakePublicId: INTAKE, transactionPublicId: ALLOCATION_SOURCE_TRANSACTION, targetSchedulePublicId: ALLOCATION_TARGET_SCHEDULE, reason: "Blocked correction" }); return { outcome: "stopped", stopReason: preview.status === "blocked" ? "allocation-correction-blocked" : "allocation-correction-not-blocked" } as const; },
    },
    "scheduled-allocation-correction-stale": {
        script: [
            { name: "intake.get", arguments: { paymentIntakePublicId: INTAKE }, result: { publicId: INTAKE, status: "posted", ...noRepostLineage, evidence: [], latestProposal: null } },
            { name: "payment.allocation-correction.preview", arguments: { paymentIntakePublicId: INTAKE, transactionPublicId: ALLOCATION_SOURCE_TRANSACTION, targetSchedulePublicId: ALLOCATION_TARGET_SCHEDULE, reason: "Stale correction" }, result: allocationPreviewFixture() },
            { name: "payment.allocation-correction.execute", arguments: { correctionPreviewPublicId: ALLOCATION_PREVIEW, previewHash: PREVIEW_HASH, expectedBalanceVersion: BALANCE_VERSION, confirmed: true, reason: "Stale correction", idempotencyKey: "allocation-stale-1" }, error: { code: "STALE_CORRECTION_PREVIEW", message: "Correction preview is stale", retryable: false, reviewRequired: true, details: {} } },
            { name: "intake.get", arguments: { paymentIntakePublicId: INTAKE }, result: { publicId: INTAKE, status: "posted", ...noRepostLineage, evidence: [], latestProposal: null } },
            { name: "payment.allocation-correction.preview", arguments: { paymentIntakePublicId: INTAKE, transactionPublicId: ALLOCATION_SOURCE_TRANSACTION, targetSchedulePublicId: ALLOCATION_TARGET_SCHEDULE, reason: "Fresh correction" }, result: allocationPreviewFixture() },
        ],
        run: async (mcp) => { await mcp.call("intake.get", { paymentIntakePublicId: INTAKE }); const preview = await mcp.call("payment.allocation-correction.preview", { paymentIntakePublicId: INTAKE, transactionPublicId: ALLOCATION_SOURCE_TRANSACTION, targetSchedulePublicId: ALLOCATION_TARGET_SCHEDULE, reason: "Stale correction" }); try { await mcp.call("payment.allocation-correction.execute", { correctionPreviewPublicId: preview.publicId, previewHash: preview.previewHash, expectedBalanceVersion: preview.expectedBalanceVersion, confirmed: true, reason: "Stale correction", idempotencyKey: "allocation-stale-1" }); } catch (error) { if (!(error instanceof ScriptedMcpError) || error.code !== "STALE_CORRECTION_PREVIEW") throw error; await mcp.call("intake.get", { paymentIntakePublicId: INTAKE }); await mcp.call("payment.allocation-correction.preview", { paymentIntakePublicId: INTAKE, transactionPublicId: ALLOCATION_SOURCE_TRANSACTION, targetSchedulePublicId: ALLOCATION_TARGET_SCHEDULE, reason: "Fresh correction" }); return { outcome: "stopped", stopReason: "allocation-correction-fresh-confirmation-required" } as const; } return { outcome: "completed" } as const; },
    },
    "scheduled-allocation-correction-idempotent-retry": {
        script: [
            { name: "intake.get", arguments: { paymentIntakePublicId: INTAKE }, result: { publicId: INTAKE, status: "posted", ...noRepostLineage, evidence: [], latestProposal: null } },
            { name: "payment.allocation-correction.preview", arguments: { paymentIntakePublicId: INTAKE, transactionPublicId: ALLOCATION_SOURCE_TRANSACTION, targetSchedulePublicId: ALLOCATION_TARGET_SCHEDULE, reason: "Retry correction" }, result: allocationPreviewFixture() },
            { name: "payment.allocation-correction.execute", arguments: { correctionPreviewPublicId: ALLOCATION_PREVIEW, previewHash: PREVIEW_HASH, expectedBalanceVersion: BALANCE_VERSION, confirmed: true, reason: "Retry correction", idempotencyKey: "allocation-retry-1" }, result: allocationExecuteFixture },
            { name: "payment.allocation-correction.execute", arguments: { correctionPreviewPublicId: ALLOCATION_PREVIEW, previewHash: PREVIEW_HASH, expectedBalanceVersion: BALANCE_VERSION, confirmed: true, reason: "Retry correction", idempotencyKey: "allocation-retry-1" }, result: allocationExecuteFixture },
            { name: "intake.get", arguments: { paymentIntakePublicId: INTAKE }, result: { publicId: INTAKE, status: "posted", ...noRepostLineage, evidence: [], latestProposal: null } },
        ],
        run: async (mcp) => { await mcp.call("intake.get", { paymentIntakePublicId: INTAKE }); const preview = await mcp.call("payment.allocation-correction.preview", { paymentIntakePublicId: INTAKE, transactionPublicId: ALLOCATION_SOURCE_TRANSACTION, targetSchedulePublicId: ALLOCATION_TARGET_SCHEDULE, reason: "Retry correction" }); await mcp.call("payment.allocation-correction.execute", { correctionPreviewPublicId: preview.publicId, previewHash: preview.previewHash, expectedBalanceVersion: preview.expectedBalanceVersion, confirmed: true, reason: "Retry correction", idempotencyKey: "allocation-retry-1" }); await mcp.call("payment.allocation-correction.execute", { correctionPreviewPublicId: preview.publicId, previewHash: preview.previewHash, expectedBalanceVersion: preview.expectedBalanceVersion, confirmed: true, reason: "Retry correction", idempotencyKey: "allocation-retry-1" }); await mcp.call("intake.get", { paymentIntakePublicId: INTAKE }); return { outcome: "completed" } as const; },
    },
    "renewal-reversal": {
        script: [
            { name: "borrower.portfolio", arguments: { borrowerPublicId: SAME_TASK_RENEWAL_CONTEXT.retainedBorrowerPublicId }, result: RENEWAL_PORTFOLIO },
            { name: "renewal.reverse", arguments: { renewalPublicId: SAME_TASK_RENEWAL_CONTEXT.executeResult.publicId, reason: "Owner confirmed renewal reversal; backend must atomically check downstream activity", idempotencyKey: "renewal-reverse-20260810-1" }, result: { ...RENEWAL_COMPOSITION_FIELDS, publicId: "0198c481-3e2b-7000-8000-000000000289", status: "fixture", oldLoanPublicId: "0198c481-3e2b-7000-8000-000000000290", previewHash: "v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", principalPaid: "0.00", outstandingPrincipal: "0.00", dueCharges: "0.00", settlementAmount: "0.00", waivedCharges: "0.00", requestedPrincipal: "0.00", cashDirection: "payout", cashAmount: "0.00" } },
        ],
        run: (mcp) => reverseRenewal(mcp, SAME_TASK_RENEWAL_CONTEXT),
    },
    "ambiguous-nickname": {
        script: [
            { name: "borrower.search", arguments: { query: "พี่พล" }, result: { resolution: "ambiguous", candidates: [{ publicId: BORROWER_A, name: "fixture" }, { publicId: BORROWER_B, name: "fixture" }] } },
            { name: "borrower.portfolio", arguments: { borrowerPublicId: BORROWER_A }, result: { borrower: { publicId: "0198c481-3e2b-7000-8000-000000000291", name: "fixture" }, aliases: [], loans: [] } },
            { name: "borrower.portfolio", arguments: { borrowerPublicId: BORROWER_B }, result: { borrower: { publicId: "0198c481-3e2b-7000-8000-000000000292", name: "fixture" }, aliases: [], loans: [] } },
        ],
        run: async (mcp) => { const found = await mcp.call("borrower.search", { query: "พี่พล" }); for (const candidate of found.candidates as Array<{ publicId: string }>) await mcp.call("borrower.portfolio", { borrowerPublicId: candidate.publicId }); return { outcome: "stopped", stopReason: "ambiguous-identity" }; },
    },
    "allocation-mismatch": {
        script: [{ name: "payment.preview", arguments: { paymentIntakePublicId: INTAKE, allocations: mismatchAllocations }, result: { status: "needs_review", publicId: "0198c481-3e2b-7000-8000-000000000293", version: -9007199254740991, warnings: [], totalAllocated: "0.00", allocations: [] } }],
        run: async (mcp) => { const preview = await mcp.call("payment.preview", { paymentIntakePublicId: INTAKE, allocations: mismatchAllocations }); return { outcome: "stopped", stopReason: String(preview.status) }; },
    },
    "duplicate-reference": {
        script: [
            { name: "intake.create", arguments: intakeArgs, result: { publicId: ORIGINAL_INTAKE, duplicate: true, status: "fixture", duplicateReason: "fixture", warnings: [] } },
            { name: "intake.get", arguments: { paymentIntakePublicId: ORIGINAL_INTAKE }, result: { publicId: "0198c481-3e2b-7000-8000-000000000294", status: "fixture", ...noRepostLineage, evidence: [], latestProposal: { publicId: "0198c481-3e2b-7000-8000-000000000295", version: -9007199254740991, status: "fixture", warnings: [], totalAllocated: "0.00", allocations: [] } } },
        ],
        run: (mcp) => paymentFlow(mcp, {}),
    },
    "duplicate-evidence-hash": {
        script: [
            { name: "intake.create", arguments: intakeArgs, result: { publicId: INTAKE, duplicate: false, status: "fixture", warnings: [], duplicateReason: null, ...noRepostLineage } },
            { name: "evidence.prepare", arguments: { paymentIntakePublicId: INTAKE, mimeType: "image/jpeg", size: PAYMENT_EVIDENCE_BYTES.byteLength, sha256: FILE_HASH, evidenceType: "slip" }, result: { publicId: EVIDENCE, duplicate: true, intakePublicId: ORIGINAL_INTAKE } },
            { name: "intake.get", arguments: { paymentIntakePublicId: ORIGINAL_INTAKE }, result: { publicId: "0198c481-3e2b-7000-8000-000000000296", status: "fixture", ...noRepostLineage, evidence: [], latestProposal: { publicId: "0198c481-3e2b-7000-8000-000000000297", version: -9007199254740991, status: "fixture", warnings: [], totalAllocated: "0.00", allocations: [] } } },
        ],
        run: (mcp) => paymentFlow(mcp, { evidence: true }),
    },
    "payment-evidence-upload-unavailable": {
        script: [
            { name: "intake.create", arguments: intakeArgs, result: { publicId: INTAKE, duplicate: false, status: "fixture", warnings: [], duplicateReason: null, ...noRepostLineage } },
            { name: "evidence.prepare", arguments: { paymentIntakePublicId: INTAKE, mimeType: "image/jpeg", size: PAYMENT_EVIDENCE_BYTES.byteLength, sha256: FILE_HASH, evidenceType: "slip" }, result: { publicId: EVIDENCE, filePublicId: EVIDENCE_FILE, duplicate: false } },
        ],
        run: (mcp) => paymentFlow(mcp, { evidence: true }),
    },
    "payment-evidence-finalize-mismatch": {
        script: [
            { name: "intake.create", arguments: intakeArgs, result: { publicId: INTAKE, duplicate: false, status: "fixture", warnings: [], duplicateReason: null, ...noRepostLineage } },
            { name: "evidence.prepare", arguments: { paymentIntakePublicId: INTAKE, mimeType: "image/jpeg", size: PAYMENT_EVIDENCE_BYTES.byteLength, sha256: FILE_HASH, evidenceType: "slip" }, result: { publicId: EVIDENCE, filePublicId: EVIDENCE_FILE, duplicate: false, uploadUrl: "https://storage.example/payment-upload", requiredHeaders: {} } },
            { name: "evidence.finalize", arguments: { paymentIntakePublicId: INTAKE, evidencePublicId: EVIDENCE }, result: { publicId: EVIDENCE, status: "ready", sha256: FILE_HASH, filePublicId: ORIGINAL_INTAKE } },
        ],
        run: (mcp) => paymentFlow(mcp, { evidence: true }),
    },
    "active-loan-edit": {
        script: [{ name: "borrower.portfolio", arguments: { borrowerPublicId: BORROWER_A }, result: { loans: [{ publicId: LOAN_A, status: "active", replacementLineage: null, principal: "0.00", interestRate: "0.00", repaymentType: "fixture", startDate: "2026-08-15" }], borrower: { publicId: "0198c481-3e2b-7000-8000-000000000298", name: "fixture" }, aliases: [] } }],
        run: async (mcp) => { await mcp.call("borrower.portfolio", { borrowerPublicId: BORROWER_A }); return { outcome: "stopped", stopReason: "immutable-active-terms" }; },
    },
    "disbursement-variance-without-confirmation": {
        script: [
            { name: "loan.disbursement.list", arguments: { loanPublicId: LOAN_A }, result: { summary: { approvedPrincipal: "2500.00", netDisbursed: "0.00", variance: "-2500.00", status: "under_disbursed" }, events: [], loanPublicId: "0198c481-3e2b-7000-8000-000000000299" } },
            { name: "loan.disbursement.draft", arguments: disbursementDraftArgs, result: { publicId: DISBURSEMENT, status: "draft", grossAmount: "0.00", loanAttributedAmount: "0.00", channel: "bank_transfer", restructurePublicId: "0198c481-3e2b-7000-8000-000000000300", sourceBankProfilePublicId: "0198c481-3e2b-7000-8000-000000000301", payeeHint: "fixture", note: "fixture", disbursedAt: "2026-08-15T06:30:00.000Z", postedAt: "2026-08-15T06:30:00.000Z", reversedAt: "2026-08-15T06:30:00.000Z", evidenceFilePublicIds: [] } },
            { name: "loan.disbursement.evidence.prepare", arguments: { disbursementPublicId: DISBURSEMENT, mimeType: "image/jpeg", size: DISBURSEMENT_EVIDENCE_BYTES.byteLength, sha256: DISBURSEMENT_FILE_HASH, originalName: "payout-slip.jpg" }, result: { publicId: DISBURSEMENT_EVIDENCE, filePublicId: EVIDENCE, uploadUrl: "https://storage.example/upload", requiredHeaders: {}, expiresAt: "2099-01-01T00:00:00+00:00" } },
            { name: "loan.disbursement.evidence.finalize", arguments: { disbursementPublicId: DISBURSEMENT, evidencePublicId: DISBURSEMENT_EVIDENCE }, result: { publicId: DISBURSEMENT_EVIDENCE, filePublicId: EVIDENCE, status: "ready" } },
            { name: "loan.disbursement.list", arguments: { loanPublicId: LOAN_A }, result: { summary: { approvedPrincipal: "2500.00", netDisbursed: "2300.00", variance: "-200.00", status: "under_disbursed" }, events: [{ publicId: DISBURSEMENT, status: "draft", grossAmount: "0.00", loanAttributedAmount: "0.00", channel: "bank_transfer", restructurePublicId: "0198c481-3e2b-7000-8000-000000000302", sourceBankProfilePublicId: "0198c481-3e2b-7000-8000-000000000303", payeeHint: "fixture", note: "fixture", disbursedAt: "2026-08-15T06:30:00.000Z", postedAt: "2026-08-15T06:30:00.000Z", reversedAt: "2026-08-15T06:30:00.000Z", evidenceFilePublicIds: [] }], loanPublicId: "0198c481-3e2b-7000-8000-000000000304" } },
        ],
        run: (mcp) => disbursementLifecycle(mcp),
    },
    "disbursement-missing-post-confirmation": {
        script: [
            { name: "loan.disbursement.list", arguments: { loanPublicId: LOAN_A }, result: { summary: { approvedPrincipal: "2500.00", netDisbursed: "0.00", variance: "-2500.00", status: "under_disbursed" }, events: [], loanPublicId: "0198c481-3e2b-7000-8000-000000000305" } },
            { name: "loan.disbursement.draft", arguments: disbursementDraftArgs, result: { publicId: DISBURSEMENT, status: "draft", grossAmount: "0.00", loanAttributedAmount: "0.00", channel: "bank_transfer", restructurePublicId: "0198c481-3e2b-7000-8000-000000000306", sourceBankProfilePublicId: "0198c481-3e2b-7000-8000-000000000307", payeeHint: "fixture", note: "fixture", disbursedAt: "2026-08-15T06:30:00.000Z", postedAt: "2026-08-15T06:30:00.000Z", reversedAt: "2026-08-15T06:30:00.000Z", evidenceFilePublicIds: [] } },
            { name: "loan.disbursement.evidence.prepare", arguments: { disbursementPublicId: DISBURSEMENT, mimeType: "image/jpeg", size: DISBURSEMENT_EVIDENCE_BYTES.byteLength, sha256: DISBURSEMENT_FILE_HASH, originalName: "payout-slip.jpg" }, result: { publicId: DISBURSEMENT_EVIDENCE, filePublicId: EVIDENCE, uploadUrl: "https://storage.example/upload", requiredHeaders: {}, expiresAt: "2099-01-01T00:00:00+00:00" } },
            { name: "loan.disbursement.evidence.finalize", arguments: { disbursementPublicId: DISBURSEMENT, evidencePublicId: DISBURSEMENT_EVIDENCE }, result: { publicId: DISBURSEMENT_EVIDENCE, filePublicId: EVIDENCE, status: "ready" } },
            { name: "loan.disbursement.list", arguments: { loanPublicId: LOAN_A }, result: { summary: { approvedPrincipal: "2500.00", netDisbursed: "2500.00", variance: "0.00", status: "matched" }, events: [{ publicId: DISBURSEMENT, status: "draft", grossAmount: "0.00", loanAttributedAmount: "0.00", channel: "bank_transfer", restructurePublicId: "0198c481-3e2b-7000-8000-000000000308", sourceBankProfilePublicId: "0198c481-3e2b-7000-8000-000000000309", payeeHint: "fixture", note: "fixture", disbursedAt: "2026-08-15T06:30:00.000Z", postedAt: "2026-08-15T06:30:00.000Z", reversedAt: "2026-08-15T06:30:00.000Z", evidenceFilePublicIds: [] }], loanPublicId: "0198c481-3e2b-7000-8000-000000000310" } },
        ],
        run: (mcp) => disbursementLifecycle(mcp),
    },
    "disbursement-evidence-ready-retry": {
        script: [
            { name: "loan.disbursement.list", arguments: { loanPublicId: LOAN_A }, result: { summary: { approvedPrincipal: "2500.00", netDisbursed: "0.00", variance: "-2500.00", status: "under_disbursed" }, events: [], loanPublicId: "0198c481-3e2b-7000-8000-000000000311" } },
            { name: "loan.disbursement.draft", arguments: disbursementDraftArgs, result: { publicId: DISBURSEMENT, status: "draft", grossAmount: "0.00", loanAttributedAmount: "0.00", channel: "bank_transfer", restructurePublicId: "0198c481-3e2b-7000-8000-000000000312", sourceBankProfilePublicId: "0198c481-3e2b-7000-8000-000000000313", payeeHint: "fixture", note: "fixture", disbursedAt: "2026-08-15T06:30:00.000Z", postedAt: "2026-08-15T06:30:00.000Z", reversedAt: "2026-08-15T06:30:00.000Z", evidenceFilePublicIds: [] } },
            { name: "loan.disbursement.evidence.prepare", arguments: { disbursementPublicId: DISBURSEMENT, mimeType: "image/jpeg", size: DISBURSEMENT_EVIDENCE_BYTES.byteLength, sha256: DISBURSEMENT_FILE_HASH, originalName: "payout-slip.jpg" }, result: { publicId: DISBURSEMENT_EVIDENCE, filePublicId: EVIDENCE, status: "ready" } },
            { name: "loan.disbursement.list", arguments: { loanPublicId: LOAN_A }, result: { summary: { approvedPrincipal: "2500.00", netDisbursed: "2500.00", variance: "0.00", status: "matched" }, events: [{ publicId: DISBURSEMENT, status: "draft", grossAmount: "0.00", loanAttributedAmount: "0.00", channel: "bank_transfer", restructurePublicId: "0198c481-3e2b-7000-8000-000000000314", sourceBankProfilePublicId: "0198c481-3e2b-7000-8000-000000000315", payeeHint: "fixture", note: "fixture", disbursedAt: "2026-08-15T06:30:00.000Z", postedAt: "2026-08-15T06:30:00.000Z", reversedAt: "2026-08-15T06:30:00.000Z", evidenceFilePublicIds: [] }], loanPublicId: "0198c481-3e2b-7000-8000-000000000316" } },
            { name: "loan.disbursement.post", arguments: { disbursementPublicId: DISBURSEMENT, idempotencyKey: "disbursement-post-20260810-1" }, result: { publicId: DISBURSEMENT, status: "posted", duplicate: false, grossAmount: "0.00", loanAttributedAmount: "0.00", channel: "bank_transfer", restructurePublicId: "0198c481-3e2b-7000-8000-000000000317", sourceBankProfilePublicId: "0198c481-3e2b-7000-8000-000000000318", payeeHint: "fixture", note: "fixture", disbursedAt: "2026-08-15T06:30:00.000Z", postedAt: "2026-08-15T06:30:00.000Z", reversedAt: "2026-08-15T06:30:00.000Z", evidenceFilePublicIds: [], auditPublicId: "0198c481-3e2b-7000-8000-000000000319", correlationId: "0198c481-3e2b-7000-8000-000000000320" } },
        ],
        run: (mcp) => disbursementLifecycle(mcp, { postConfirmed: true }),
    },
    "disbursement-evidence-expired-upload": {
        script: [
            { name: "loan.disbursement.list", arguments: { loanPublicId: LOAN_A }, result: { summary: { approvedPrincipal: "2500.00", netDisbursed: "0.00", variance: "-2500.00", status: "under_disbursed" }, events: [], loanPublicId: "0198c481-3e2b-7000-8000-000000000321" } },
            { name: "loan.disbursement.draft", arguments: disbursementDraftArgs, result: { publicId: DISBURSEMENT, status: "draft", grossAmount: "0.00", loanAttributedAmount: "0.00", channel: "bank_transfer", restructurePublicId: "0198c481-3e2b-7000-8000-000000000322", sourceBankProfilePublicId: "0198c481-3e2b-7000-8000-000000000323", payeeHint: "fixture", note: "fixture", disbursedAt: "2026-08-15T06:30:00.000Z", postedAt: "2026-08-15T06:30:00.000Z", reversedAt: "2026-08-15T06:30:00.000Z", evidenceFilePublicIds: [] } },
            { name: "loan.disbursement.evidence.prepare", arguments: { disbursementPublicId: DISBURSEMENT, mimeType: "image/jpeg", size: DISBURSEMENT_EVIDENCE_BYTES.byteLength, sha256: DISBURSEMENT_FILE_HASH, originalName: "payout-slip.jpg" }, result: { publicId: DISBURSEMENT_EVIDENCE, filePublicId: EVIDENCE, uploadUrl: "https://storage.example/upload", requiredHeaders: {}, expiresAt: "2000-01-01T00:00:00+00:00" } },
        ],
        run: (mcp) => disbursementLifecycle(mcp, { postConfirmed: true }),
    },
    "disbursement-evidence-finalize-mismatch": {
        script: [
            { name: "loan.disbursement.list", arguments: { loanPublicId: LOAN_A }, result: { summary: { approvedPrincipal: "2500.00", netDisbursed: "0.00", variance: "-2500.00", status: "under_disbursed" }, events: [], loanPublicId: "0198c481-3e2b-7000-8000-000000000324" } },
            { name: "loan.disbursement.draft", arguments: disbursementDraftArgs, result: { publicId: DISBURSEMENT, status: "draft", grossAmount: "0.00", loanAttributedAmount: "0.00", channel: "bank_transfer", restructurePublicId: "0198c481-3e2b-7000-8000-000000000325", sourceBankProfilePublicId: "0198c481-3e2b-7000-8000-000000000326", payeeHint: "fixture", note: "fixture", disbursedAt: "2026-08-15T06:30:00.000Z", postedAt: "2026-08-15T06:30:00.000Z", reversedAt: "2026-08-15T06:30:00.000Z", evidenceFilePublicIds: [] } },
            { name: "loan.disbursement.evidence.prepare", arguments: { disbursementPublicId: DISBURSEMENT, mimeType: "image/jpeg", size: DISBURSEMENT_EVIDENCE_BYTES.byteLength, sha256: DISBURSEMENT_FILE_HASH, originalName: "payout-slip.jpg" }, result: { publicId: DISBURSEMENT_EVIDENCE, filePublicId: EVIDENCE, uploadUrl: "https://storage.example/upload", requiredHeaders: {}, expiresAt: "2099-01-01T00:00:00+00:00" } },
            { name: "loan.disbursement.evidence.finalize", arguments: { disbursementPublicId: DISBURSEMENT, evidencePublicId: DISBURSEMENT_EVIDENCE }, error: { code: "EVIDENCE_MISMATCH", message: "Evidence checksum or metadata does not match", retryable: false, reviewRequired: false, details: {} } },
        ],
        run: (mcp) => disbursementLifecycle(mcp, { postConfirmed: true }),
    },
    "disbursement-evidence-checksum-conflict": {
        script: [
            { name: "loan.disbursement.list", arguments: { loanPublicId: LOAN_A }, result: { summary: { approvedPrincipal: "2500.00", netDisbursed: "0.00", variance: "-2500.00", status: "under_disbursed" }, events: [], loanPublicId: "0198c481-3e2b-7000-8000-000000000327" } },
            { name: "loan.disbursement.draft", arguments: disbursementDraftArgs, result: { publicId: DISBURSEMENT, status: "draft", grossAmount: "0.00", loanAttributedAmount: "0.00", channel: "bank_transfer", restructurePublicId: "0198c481-3e2b-7000-8000-000000000328", sourceBankProfilePublicId: "0198c481-3e2b-7000-8000-000000000329", payeeHint: "fixture", note: "fixture", disbursedAt: "2026-08-15T06:30:00.000Z", postedAt: "2026-08-15T06:30:00.000Z", reversedAt: "2026-08-15T06:30:00.000Z", evidenceFilePublicIds: [] } },
            { name: "loan.disbursement.evidence.prepare", arguments: { disbursementPublicId: DISBURSEMENT, mimeType: "image/jpeg", size: DISBURSEMENT_EVIDENCE_BYTES.byteLength, sha256: DISBURSEMENT_FILE_HASH, originalName: "payout-slip.jpg" }, error: { code: "EVIDENCE_HASH_CONFLICT", message: "Evidence checksum belongs to another disbursement", retryable: false, reviewRequired: false, details: {} } },
        ],
        run: (mcp) => disbursementLifecycle(mcp, { postConfirmed: true }),
    },
    "disbursement-reversal-event-not-posted": {
        script: [
            { name: "loan.disbursement.list", arguments: { loanPublicId: LOAN_A }, result: { summary: { approvedPrincipal: "2500.00", netDisbursed: "0.00", variance: "-2500.00", status: "under_disbursed" }, events: [], loanPublicId: "0198c481-3e2b-7000-8000-000000000330" } },
            { name: "loan.disbursement.draft", arguments: disbursementDraftArgs, result: { publicId: DISBURSEMENT, status: "draft", grossAmount: "0.00", loanAttributedAmount: "0.00", channel: "bank_transfer", restructurePublicId: "0198c481-3e2b-7000-8000-000000000331", sourceBankProfilePublicId: "0198c481-3e2b-7000-8000-000000000332", payeeHint: "fixture", note: "fixture", disbursedAt: "2026-08-15T06:30:00.000Z", postedAt: "2026-08-15T06:30:00.000Z", reversedAt: "2026-08-15T06:30:00.000Z", evidenceFilePublicIds: [] } },
            { name: "loan.disbursement.evidence.prepare", arguments: { disbursementPublicId: DISBURSEMENT, mimeType: "image/jpeg", size: DISBURSEMENT_EVIDENCE_BYTES.byteLength, sha256: DISBURSEMENT_FILE_HASH, originalName: "payout-slip.jpg" }, result: { publicId: DISBURSEMENT_EVIDENCE, filePublicId: EVIDENCE, status: "ready" } },
            { name: "loan.disbursement.list", arguments: { loanPublicId: LOAN_A }, result: { summary: { approvedPrincipal: "2500.00", netDisbursed: "2500.00", variance: "0.00", status: "matched" }, events: [{ publicId: DISBURSEMENT, status: "draft", grossAmount: "0.00", loanAttributedAmount: "0.00", channel: "bank_transfer", restructurePublicId: "0198c481-3e2b-7000-8000-000000000333", sourceBankProfilePublicId: "0198c481-3e2b-7000-8000-000000000334", payeeHint: "fixture", note: "fixture", disbursedAt: "2026-08-15T06:30:00.000Z", postedAt: "2026-08-15T06:30:00.000Z", reversedAt: "2026-08-15T06:30:00.000Z", evidenceFilePublicIds: [] }], loanPublicId: "0198c481-3e2b-7000-8000-000000000335" } },
            { name: "loan.disbursement.post", arguments: { disbursementPublicId: DISBURSEMENT, idempotencyKey: "disbursement-post-20260810-1" }, result: { publicId: DISBURSEMENT, status: "posted", duplicate: false, grossAmount: "0.00", loanAttributedAmount: "0.00", channel: "bank_transfer", restructurePublicId: "0198c481-3e2b-7000-8000-000000000336", sourceBankProfilePublicId: "0198c481-3e2b-7000-8000-000000000337", payeeHint: "fixture", note: "fixture", disbursedAt: "2026-08-15T06:30:00.000Z", postedAt: "2026-08-15T06:30:00.000Z", reversedAt: "2026-08-15T06:30:00.000Z", evidenceFilePublicIds: [], auditPublicId: "0198c481-3e2b-7000-8000-000000000338", correlationId: "0198c481-3e2b-7000-8000-000000000339" } },
            { name: "loan.disbursement.list", arguments: { loanPublicId: LOAN_A }, result: { summary: { approvedPrincipal: "2500.00", netDisbursed: "2500.00", variance: "0.00", status: "matched" }, events: [{ publicId: DISBURSEMENT, status: "draft", grossAmount: "0.00", loanAttributedAmount: "0.00", channel: "bank_transfer", restructurePublicId: "0198c481-3e2b-7000-8000-000000000340", sourceBankProfilePublicId: "0198c481-3e2b-7000-8000-000000000341", payeeHint: "fixture", note: "fixture", disbursedAt: "2026-08-15T06:30:00.000Z", postedAt: "2026-08-15T06:30:00.000Z", reversedAt: "2026-08-15T06:30:00.000Z", evidenceFilePublicIds: [] }], loanPublicId: "0198c481-3e2b-7000-8000-000000000342" } },
        ],
        run: (mcp) => disbursementLifecycle(mcp, { postConfirmed: true, reverseConfirmed: true }),
    },
    "disbursement-idempotency-conflict": {
        script: [
            { name: "loan.disbursement.draft", arguments: disbursementDraftArgs, result: { publicId: DISBURSEMENT, status: "draft", grossAmount: "0.00", loanAttributedAmount: "0.00", channel: "bank_transfer", restructurePublicId: "0198c481-3e2b-7000-8000-000000000343", sourceBankProfilePublicId: "0198c481-3e2b-7000-8000-000000000344", payeeHint: "fixture", note: "fixture", disbursedAt: "2026-08-15T06:30:00.000Z", postedAt: "2026-08-15T06:30:00.000Z", reversedAt: "2026-08-15T06:30:00.000Z", evidenceFilePublicIds: [] } },
            { name: "loan.disbursement.post", arguments: { disbursementPublicId: DISBURSEMENT, idempotencyKey: "disbursement-post-20260810-1" }, error: { code: "IDEMPOTENCY_KEY_CONFLICT", message: "Idempotency-Key was already used for another disbursement post", retryable: false, reviewRequired: false, details: {} } },
        ],
        run: disbursementIdempotencyConflict,
    },
    "disbursement-schedule-mutation": {
        script: [{ name: "loan.disbursement.list", arguments: { loanPublicId: LOAN_A }, result: { summary: { approvedPrincipal: "2500.00", netDisbursed: "2500.00", variance: "0.00", status: "matched" }, events: [], loanPublicId: "0198c481-3e2b-7000-8000-000000000345" } }],
        run: async (mcp) => { await mcp.call("loan.disbursement.list", { loanPublicId: LOAN_A }); return { outcome: "stopped", stopReason: "disbursement-cannot-mutate-schedule" }; },
    },
    "disbursement-update-locked": {
        script: [{ name: "loan.disbursement.list", arguments: { loanPublicId: LOAN_A }, result: { events: [{ publicId: DISBURSEMENT, status: "posted", grossAmount: "0.00", loanAttributedAmount: "0.00", channel: "bank_transfer", restructurePublicId: "0198c481-3e2b-7000-8000-000000000346", sourceBankProfilePublicId: "0198c481-3e2b-7000-8000-000000000347", payeeHint: "fixture", note: "fixture", disbursedAt: "2026-08-15T06:30:00.000Z", postedAt: "2026-08-15T06:30:00.000Z", reversedAt: "2026-08-15T06:30:00.000Z", evidenceFilePublicIds: [] }], loanPublicId: "0198c481-3e2b-7000-8000-000000000348", summary: { approvedPrincipal: "0.00", netDisbursed: "0.00", variance: "0.00", status: "under_disbursed" } } }],
        run: async (mcp) => { await mcp.call("loan.disbursement.list", { loanPublicId: LOAN_A }); return { outcome: "stopped", stopReason: "disbursement-locked" } as const; },
    },
    "disbursement-update-unsupported-fields": {
        script: [{ name: "loan.disbursement.list", arguments: { loanPublicId: LOAN_A }, result: { events: [{ publicId: DISBURSEMENT, status: "draft", grossAmount: "0.00", loanAttributedAmount: "0.00", channel: "bank_transfer", restructurePublicId: "0198c481-3e2b-7000-8000-000000000349", sourceBankProfilePublicId: "0198c481-3e2b-7000-8000-000000000350", payeeHint: "fixture", note: "fixture", disbursedAt: "2026-08-15T06:30:00.000Z", postedAt: "2026-08-15T06:30:00.000Z", reversedAt: "2026-08-15T06:30:00.000Z", evidenceFilePublicIds: [] }], loanPublicId: "0198c481-3e2b-7000-8000-000000000351", summary: { approvedPrincipal: "0.00", netDisbursed: "0.00", variance: "0.00", status: "under_disbursed" } } }],
        run: async (mcp) => { await mcp.call("loan.disbursement.list", { loanPublicId: LOAN_A }); return { outcome: "stopped", stopReason: "disbursement-update-unsupported-fields" } as const; },
    },
    "renewal-unsettled-charges": {
        script: [
            { name: "borrower.portfolio", arguments: { borrowerPublicId: BORROWER_A }, result: { borrower: { publicId: "0198c481-3e2b-7000-8000-000000000352", name: "fixture" }, aliases: [], loans: [] } },
            { name: "renewal.preview", arguments: { oldLoanPublicId: LOAN_A, requestedPrincipal: "2000.00" }, result: { ...RENEWAL_COMPOSITION_FIELDS, publicId: RENEWAL, previewHash: PREVIEW_HASH, dueCharges: "300.00", status: "fixture", oldLoanPublicId: "0198c481-3e2b-7000-8000-000000000353", principalPaid: "0.00", outstandingPrincipal: "2000.00", settlementAmount: "300.00", waivedCharges: "0.00", requestedPrincipal: "2000.00", cashDirection: "collection", cashAmount: "300.00" } },
        ],
        run: (mcp) => renewalExecute(mcp),
    },
    "renewal-missing-confirmation": {
        script: [
            { name: "borrower.portfolio", arguments: { borrowerPublicId: BORROWER_A }, result: { borrower: { publicId: "0198c481-3e2b-7000-8000-000000000354", name: "fixture" }, aliases: [], loans: [] } },
            { name: "renewal.preview", arguments: { oldLoanPublicId: LOAN_A, requestedPrincipal: "2000.00" }, result: { ...RENEWAL_COMPOSITION_FIELDS, publicId: RENEWAL, previewHash: PREVIEW_HASH, dueCharges: "233.33", status: "fixture", oldLoanPublicId: "0198c481-3e2b-7000-8000-000000000355", principalPaid: "833.33", outstandingPrincipal: "1166.67", settlementAmount: "233.33", waivedCharges: "0.00", requestedPrincipal: "2000.00", cashDirection: "payout", cashAmount: "600.00" } },
        ],
        run: (mcp) => renewalExecute(mcp, false),
    },
    "renewal-date-mismatch": {
        script: [
            { name: "borrower.portfolio", arguments: { borrowerPublicId: BORROWER_A }, result: { borrower: { publicId: BORROWER_A, name: "fixture" }, aliases: [], loans: [] } },
            { name: "renewal.preview", arguments: { oldLoanPublicId: LOAN_A, requestedPrincipal: "2000.00", renewalDate: "2026-08-22", paymentStartDate: "2026-08-24" }, result: { ...RENEWAL_COMPOSITION_FIELDS, renewalDate: "2026-08-21", paymentStartDate: "2026-08-23", publicId: RENEWAL, previewHash: PREVIEW_HASH, status: "fixture", oldLoanPublicId: LOAN_A, principalPaid: "833.33", outstandingPrincipal: "1166.67", dueCharges: "233.33", settlementAmount: "233.33", waivedCharges: "0.00", requestedPrincipal: "2000.00", cashDirection: "payout", cashAmount: "600.00" } },
        ],
        run: async (mcp) => {
            await mcp.call("borrower.portfolio", { borrowerPublicId: BORROWER_A });
            const preview = await mcp.call("renewal.preview", { oldLoanPublicId: LOAN_A, requestedPrincipal: "2000.00", renewalDate: "2026-08-22", paymentStartDate: "2026-08-24" });
            return preview.renewalDate === "2026-08-22" && preview.paymentStartDate === "2026-08-24"
                ? { outcome: "completed" } as const
                : { outcome: "stopped", stopReason: "renewal-date-mismatch" } as const;
        },
    },
    "renewal-reversal-without-result": {
        script: [],
        run: (mcp) => reverseRenewal(mcp),
    },
    "renewal-reversal-without-borrower": {
        script: [],
        run: (mcp) => reverseRenewal(mcp, {
            provenance: "same_task_renewal_execute_result",
            executeResult: EXECUTED_RENEWAL_RESULT,
        }),
    },
    "renewal-reversal-blocked": {
        script: [
            { name: "borrower.portfolio", arguments: { borrowerPublicId: SAME_TASK_RENEWAL_CONTEXT.retainedBorrowerPublicId }, result: RENEWAL_PORTFOLIO },
            {
                name: "renewal.reverse",
                arguments: { renewalPublicId: SAME_TASK_RENEWAL_CONTEXT.executeResult.publicId, reason: "Owner confirmed renewal reversal; backend must atomically check downstream activity", idempotencyKey: "renewal-reverse-20260810-1" },
                error: {
    code: "RENEWAL_REVERSE_BLOCKED",
    message: "Reverse downstream replacement-loan entries first",
    details: { downstreamEntryCount: 3 },
    retryable: false,
    reviewRequired: false
},
            },
        ],
        run: (mcp) => reverseRenewal(mcp, SAME_TASK_RENEWAL_CONTEXT),
    },
    "intermediated-disbursement-full-lifecycle": {
        script: [
            ...fullIntermediatedDraftScript(),
            {
                name: "intermediary.disbursement.post",
                arguments: {
                    groupPublicId: INTERMEDIATED_GROUP,
                    proposalPublicId: INTERMEDIATED_PREVIEW,
                    confirmed: true,
                    idempotencyKey: "intermediated-post-20260813-1",
                },
                result: {
    ...intermediatedGroupResult(),
    status: "posted",
    updatedAt: "2026-08-13T05:01:00.000Z",
    proposalPublicId: INTERMEDIATED_PREVIEW,
    loanDisbursementPublicId: INTERMEDIATED_LOAN_DISBURSEMENT,
    advanceInterestProjectionPublicId: INTERMEDIATED_ADVANCE_PROJECTION,
    fundingAmount: "5000.00",
    borrowerPayoutAmount: "4400.00",
    advanceInterestAmount: "600.00",
    intermediaryHeldBalance: "0.00",
    transferEventPublicIds: [...INTERMEDIATED_EVENTS],
    duplicate: false,
    auditPublicId: INTERMEDIATED_AUDIT,
    correlationId: INTERMEDIATED_CORRELATION,
},
            },
        ],
        run: (mcp) => intermediatedDisbursementFlow(mcp, { confirmed: true }),
    },
    "intermediated-disbursement-ambiguous-identity": {
        script: intermediatedIdentityScript({ ambiguous: true }),
        run: (mcp) => intermediatedDisbursementFlow(mcp),
    },
    "intermediated-disbursement-missing-assignment": {
        script: intermediatedIdentityScript({ missingAssignment: true }),
        run: (mcp) => intermediatedDisbursementFlow(mcp),
    },
    "intermediated-disbursement-missing-evidence": {
        script: [
            ...intermediatedIdentityScript(),
            intermediatedGroupCreateStep(),
            ...intermediatedEventScript(0),
            ...intermediatedEventScript(1),
            ...intermediatedEventScript(2, { missingEvidence: true }),
        ],
        run: (mcp) => intermediatedDisbursementFlow(mcp),
    },
    "intermediated-disbursement-duplicate-transfer": {
        script: [
            ...intermediatedIdentityScript(),
            intermediatedGroupCreateStep(),
            ...intermediatedEventScript(0, { duplicate: true }),
        ],
        run: (mcp) => intermediatedDisbursementFlow(mcp),
    },
    "intermediated-disbursement-amount-payee-mismatch": {
        script: [
            ...intermediatedIdentityScript(),
            intermediatedGroupCreateStep(),
            ...intermediatedEventScript(0),
            ...intermediatedEventScript(1),
            ...intermediatedEventScript(2),
            intermediatedDetailStep({ transferMismatch: true }),
        ],
        run: (mcp) => intermediatedDisbursementFlow(mcp),
    },
    "intermediated-disbursement-finalize-evidence-id-mismatch": {
        script: intermediatedFinalizeBindingMismatchScript("publicId"),
        run: (mcp) => intermediatedDisbursementFlow(mcp),
    },
    "intermediated-disbursement-finalize-file-id-mismatch": {
        script: intermediatedFinalizeBindingMismatchScript("filePublicId"),
        run: (mcp) => intermediatedDisbursementFlow(mcp),
    },
    "intermediated-disbursement-ready-metadata-mismatch": {
        script: intermediatedReadyMetadataMismatchScript(),
        run: (mcp) => intermediatedDisbursementFlow(mcp),
    },
    "intermediated-disbursement-inspection-evidence-mismatch": {
        script: [
            ...intermediatedIdentityScript(),
            intermediatedGroupCreateStep(),
            ...intermediatedEventScript(0),
            ...intermediatedEventScript(1),
            ...intermediatedEventScript(2),
            intermediatedDetailStep({ evidenceBindingMismatch: true }),
        ],
        run: (mcp) => intermediatedDisbursementFlow(mcp),
    },
    "intermediated-disbursement-unexplained-retained-balance": {
        script: [
            ...intermediatedIdentityScript(),
            intermediatedGroupCreateStep("100.00"),
        ],
        run: (mcp) => intermediatedDisbursementFlow(mcp, { retainedBalance: "100.00" }),
    },
    "intermediated-disbursement-stale-preview": {
        script: [
            ...fullIntermediatedDraftScript(),
            {
                name: "intermediary.disbursement.post",
                arguments: {
                    groupPublicId: INTERMEDIATED_GROUP,
                    proposalPublicId: INTERMEDIATED_PREVIEW,
                    confirmed: true,
                    idempotencyKey: "intermediated-post-20260813-1",
                },
                error: {
    code: "STALE_INTERMEDIATED_DISBURSEMENT_PROPOSAL",
    message: "Intermediated disbursement proposal is stale",
    retryable: false,
    reviewRequired: false,
    details: {}
},
            },
            intermediatedDetailStep(),
            intermediatedPreviewStep("0198c481-3e2b-7000-8000-000000000092"),
        ],
        run: (mcp) => intermediatedDisbursementFlow(mcp, { confirmed: true }),
    },
    "intermediated-disbursement-missing-confirmation": {
        script: fullIntermediatedDraftScript(),
        run: (mcp) => intermediatedDisbursementFlow(mcp),
    },
    "unauthorized-access": {
        script: [],
        authorized: false,
        run: async (mcp) => {
            try {
                mcp.ensureAuthorized();
                return { outcome: "completed" } as const;
            } catch {
                return { outcome: "stopped", stopReason: "authorization-failed" } as const;
            }
        },
    },
    "restructure-execute": {
        script: [
            { name: "borrower.search", arguments: { query: "พี่เกมส์" }, result: { resolution: "unique", candidates: [] } },
            { name: "borrower.portfolio", arguments: { borrowerPublicId: BORROWER_A }, result: { borrower: { publicId: "0198c481-3e2b-7000-8000-000000000356", name: "fixture" }, aliases: [], loans: [] } },
            { name: "loan.restructure.preview", arguments: { oldLoanPublicId: LOAN_A, settlementDate: "2026-08-19", replacementTerms, additionalPrincipal: "1000.00", reason: "Owner requested a monthly replacement contract" }, result: { publicId: RESTRUCTURE, previewHash: PREVIEW_HASH, oldBalanceVersion: BALANCE_VERSION, cash: { direction: "payout", amount: "1000.00" }, oldLoanPublicId: "0198c481-3e2b-7000-8000-000000000357", status: "fixture", settlementDate: "2026-08-15", expiresAt: "2026-08-15T06:30:00.000Z", balance: { fixedInterestCandidate: "0.00", retroactiveInterestCandidate: "0.00", selectedInterest: "0.00", selectedInterestBranch: "fixed", interestDifference: "0.00", exposureTrace: [], lateDays: 0, grossPrincipal: "0.00", grossInterest: "0.00", grossFees: "0.00", grossPenalty: "0.00", grossSettlement: "0.00", waivedInterest: "0.00", waivedFees: "0.00", waivedPenalty: "0.00", netInterest: "0.00", netFees: "0.00", netPenalty: "0.00", externalSettlementCredits: "0.00", netSettlement: "0.00" }, replacementPrincipal: "0.00", externalCreditAllocation: { penalty: "0.00", fee: "0.00", interest: "0.00", principal: "0.00", unallocated: "0.00" }, replacementTerms: { principal: "0.00", interestRate: "0.00", termMonths: 1, startDate: "2026-08-15", repaymentType: "daily", dailyEntry: { durationUnit: "days", durationValue: 1, entryMode: "daily_payment" } }, schedule: [], reason: "fixture" } },
            { name: "loan.restructure.execute", arguments: { restructurePublicId: RESTRUCTURE, previewHash: PREVIEW_HASH, expectedBalanceVersion: BALANCE_VERSION, confirmed: true, reason: "Owner confirmed the exact settlement and replacement", idempotencyKey: "restructure-execute-20260819-1" }, result: { publicId: "0198c481-3e2b-7000-8000-000000000358", status: "fixture", oldLoanPublicId: "0198c481-3e2b-7000-8000-000000000359", newLoanPublicId: "0198c481-3e2b-7000-8000-000000000360", disbursementDraftPublicId: "0198c481-3e2b-7000-8000-000000000361", auditPublicIds: [], correlationId: "0198c481-3e2b-7000-8000-000000000362" } },
        ],
        run: (mcp) => restructureFlow(mcp),
    },
    "waiver-execute": {
        script: [
            { name: "borrower.portfolio", arguments: { borrowerPublicId: BORROWER_A }, result: { borrower: { publicId: "0198c481-3e2b-7000-8000-000000000363", name: "fixture" }, aliases: [], loans: [] } },
            { name: "loan.waiver.preview", arguments: { loanPublicId: LOAN_B, component: "interest", amount: "100.00", reason: "Owner approved hardship relief" }, result: { publicId: WAIVER_PREVIEW, previewHash: PREVIEW_HASH, balanceVersion: BALANCE_VERSION, loanPublicId: "0198c481-3e2b-7000-8000-000000000364", restructurePublicId: "0198c481-3e2b-7000-8000-000000000365", component: "interest", amount: "0.00", availableAmount: "0.00", remainingAmount: "0.00", reason: "fixture", expiresAt: "2026-08-15T06:30:00.000Z" } },
            { name: "loan.waiver.execute", arguments: { previewPublicId: WAIVER_PREVIEW, previewHash: PREVIEW_HASH, expectedBalanceVersion: BALANCE_VERSION, confirmed: true, reason: "Owner approved hardship relief", idempotencyKey: "waiver-execute-20260819-1" }, result: { publicId: WAIVER, status: "executed", component: "interest", amount: "0.00", reason: "fixture", auditPublicId: "0198c481-3e2b-7000-8000-000000000366", correlationId: "0198c481-3e2b-7000-8000-000000000367", executedAt: "2026-08-15T06:30:00.000Z", reversedAt: "2026-08-15T06:30:00.000Z" } },
        ],
        run: (mcp) => waiverFlow(mcp, "Owner approved hardship relief"),
    },
    "restructure-ambiguous-borrower": {
        script: [{ name: "borrower.search", arguments: { query: "พี่เกมส์" }, result: { resolution: "ambiguous", candidates: [] } }],
        run: (mcp) => restructureFlow(mcp),
    },
    "restructure-stale-preview": {
        script: [
            { name: "borrower.search", arguments: { query: "พี่เกมส์" }, result: { resolution: "unique", candidates: [] } },
            { name: "borrower.portfolio", arguments: { borrowerPublicId: BORROWER_A }, result: { borrower: { publicId: "0198c481-3e2b-7000-8000-000000000368", name: "fixture" }, aliases: [], loans: [] } },
            { name: "loan.restructure.preview", arguments: { oldLoanPublicId: LOAN_A, settlementDate: "2026-08-19", replacementTerms, additionalPrincipal: "1000.00", reason: "Owner requested a monthly replacement contract" }, result: { publicId: RESTRUCTURE, previewHash: PREVIEW_HASH, oldBalanceVersion: BALANCE_VERSION, cash: { direction: "payout", amount: "1000.00" }, oldLoanPublicId: "0198c481-3e2b-7000-8000-000000000369", status: "fixture", settlementDate: "2026-08-15", expiresAt: "2026-08-15T06:30:00.000Z", balance: { fixedInterestCandidate: "0.00", retroactiveInterestCandidate: "0.00", selectedInterest: "0.00", selectedInterestBranch: "fixed", interestDifference: "0.00", exposureTrace: [], lateDays: 0, grossPrincipal: "0.00", grossInterest: "0.00", grossFees: "0.00", grossPenalty: "0.00", grossSettlement: "0.00", waivedInterest: "0.00", waivedFees: "0.00", waivedPenalty: "0.00", netInterest: "0.00", netFees: "0.00", netPenalty: "0.00", externalSettlementCredits: "0.00", netSettlement: "0.00" }, replacementPrincipal: "0.00", externalCreditAllocation: { penalty: "0.00", fee: "0.00", interest: "0.00", principal: "0.00", unallocated: "0.00" }, replacementTerms: { principal: "0.00", interestRate: "0.00", termMonths: 1, startDate: "2026-08-15", repaymentType: "daily", dailyEntry: { durationUnit: "days", durationValue: 1, entryMode: "daily_payment" } }, schedule: [], reason: "fixture" } },
            { name: "loan.restructure.execute", arguments: { restructurePublicId: RESTRUCTURE, previewHash: PREVIEW_HASH, expectedBalanceVersion: BALANCE_VERSION, confirmed: true, reason: "Owner confirmed the exact settlement and replacement", idempotencyKey: "restructure-execute-20260819-1" }, error: { code: "STALE_RESTRUCTURE_PREVIEW", message: "Balances changed", retryable: false, reviewRequired: false, details: {} } },
        ],
        run: (mcp) => restructureFlow(mcp),
    },
    "restructure-missing-confirmation": {
        script: [
            { name: "borrower.search", arguments: { query: "พี่เกมส์" }, result: { resolution: "unique", candidates: [] } },
            { name: "borrower.portfolio", arguments: { borrowerPublicId: BORROWER_A }, result: { borrower: { publicId: "0198c481-3e2b-7000-8000-000000000370", name: "fixture" }, aliases: [], loans: [] } },
            { name: "loan.restructure.preview", arguments: { oldLoanPublicId: LOAN_A, settlementDate: "2026-08-19", replacementTerms, additionalPrincipal: "1000.00", reason: "Owner requested a monthly replacement contract" }, result: { publicId: RESTRUCTURE, previewHash: PREVIEW_HASH, oldBalanceVersion: BALANCE_VERSION, cash: { direction: "payout", amount: "1000.00" }, oldLoanPublicId: "0198c481-3e2b-7000-8000-000000000371", status: "fixture", settlementDate: "2026-08-15", expiresAt: "2026-08-15T06:30:00.000Z", balance: { fixedInterestCandidate: "0.00", retroactiveInterestCandidate: "0.00", selectedInterest: "0.00", selectedInterestBranch: "fixed", interestDifference: "0.00", exposureTrace: [], lateDays: 0, grossPrincipal: "0.00", grossInterest: "0.00", grossFees: "0.00", grossPenalty: "0.00", grossSettlement: "0.00", waivedInterest: "0.00", waivedFees: "0.00", waivedPenalty: "0.00", netInterest: "0.00", netFees: "0.00", netPenalty: "0.00", externalSettlementCredits: "0.00", netSettlement: "0.00" }, replacementPrincipal: "0.00", externalCreditAllocation: { penalty: "0.00", fee: "0.00", interest: "0.00", principal: "0.00", unallocated: "0.00" }, replacementTerms: { principal: "0.00", interestRate: "0.00", termMonths: 1, startDate: "2026-08-15", repaymentType: "daily", dailyEntry: { durationUnit: "days", durationValue: 1, entryMode: "daily_payment" } }, schedule: [], reason: "fixture" } },
        ],
        run: (mcp) => restructureFlow(mcp, false),
    },
    "restructure-unexpected-additional-cash": {
        script: [
            { name: "borrower.search", arguments: { query: "พี่เกมส์" }, result: { resolution: "unique", candidates: [] } },
            { name: "borrower.portfolio", arguments: { borrowerPublicId: BORROWER_A }, result: { borrower: { publicId: "0198c481-3e2b-7000-8000-000000000372", name: "fixture" }, aliases: [], loans: [] } },
            { name: "loan.restructure.preview", arguments: { oldLoanPublicId: LOAN_A, settlementDate: "2026-08-19", replacementTerms, additionalPrincipal: "1000.00", reason: "Owner requested a monthly replacement contract" }, result: { publicId: RESTRUCTURE, previewHash: PREVIEW_HASH, oldBalanceVersion: BALANCE_VERSION, cash: { direction: "payout", amount: "1200.00" }, oldLoanPublicId: "0198c481-3e2b-7000-8000-000000000373", status: "fixture", settlementDate: "2026-08-15", expiresAt: "2026-08-15T06:30:00.000Z", balance: { fixedInterestCandidate: "0.00", retroactiveInterestCandidate: "0.00", selectedInterest: "0.00", selectedInterestBranch: "fixed", interestDifference: "0.00", exposureTrace: [], lateDays: 0, grossPrincipal: "0.00", grossInterest: "0.00", grossFees: "0.00", grossPenalty: "0.00", grossSettlement: "0.00", waivedInterest: "0.00", waivedFees: "0.00", waivedPenalty: "0.00", netInterest: "0.00", netFees: "0.00", netPenalty: "0.00", externalSettlementCredits: "0.00", netSettlement: "0.00" }, replacementPrincipal: "0.00", externalCreditAllocation: { penalty: "0.00", fee: "0.00", interest: "0.00", principal: "0.00", unallocated: "0.00" }, replacementTerms: { principal: "0.00", interestRate: "0.00", termMonths: 1, startDate: "2026-08-15", repaymentType: "daily", dailyEntry: { durationUnit: "days", durationValue: 1, entryMode: "daily_payment" } }, schedule: [], reason: "fixture" } },
        ],
        run: (mcp) => restructureFlow(mcp),
    },
    "waiver-missing-reason": {
        script: [{ name: "borrower.portfolio", arguments: { borrowerPublicId: BORROWER_A }, result: { borrower: { publicId: "0198c481-3e2b-7000-8000-000000000374", name: "fixture" }, aliases: [], loans: [] } }],
        run: (mcp) => waiverFlow(mcp),
    },
    "restructure-unsafe-reversal": {
        script: [
            { name: "borrower.portfolio", arguments: { borrowerPublicId: BORROWER_A }, result: { borrower: { publicId: "0198c481-3e2b-7000-8000-000000000375", name: "fixture" }, aliases: [], loans: [] } },
            { name: "loan.restructure.reverse", arguments: { restructurePublicId: RESTRUCTURE, reason: "Owner requested reversal after review", idempotencyKey: "restructure-reverse-20260819-1" }, error: { code: "RESTRUCTURE_REVERSAL_BLOCKED", message: "Downstream activity exists", retryable: false, reviewRequired: false, details: {} } },
        ],
        run: async (mcp) => {
            await mcp.call("borrower.portfolio", { borrowerPublicId: BORROWER_A });
            try {
                await mcp.call("loan.restructure.reverse", { restructurePublicId: RESTRUCTURE, reason: "Owner requested reversal after review", idempotencyKey: "restructure-reverse-20260819-1" });
                return { outcome: "completed" } as const;
            } catch (error) {
                if (error instanceof ScriptedMcpError && error.code === "RESTRUCTURE_REVERSAL_BLOCKED") return { outcome: "stopped", stopReason: "unsafe-restructure-reversal" } as const;
                throw error;
            }
        },
    },
    "diagnostics-unexpected-followup": {
        script: [
            { name: "borrower.search", arguments: { query: "diagnostic fixture" }, error: { code: "INTERNAL_ERROR", message: "opaque upstream detail", retryable: true, reviewRequired: true, details: {} } },
            { name: "system.error-diagnostic.get", arguments: { correlationId: DIAGNOSTIC_CORRELATION }, result: { correlationId: DIAGNOSTIC_CORRELATION, items: [] } },
        ],
        run: async (mcp) => {
            try { await mcp.call("borrower.search", { query: "diagnostic fixture" }); } catch (error) {
                if (!(error instanceof ScriptedMcpError)) throw error;
                await mcp.call("system.error-diagnostic.get", { correlationId: DIAGNOSTIC_CORRELATION });
            }
            return { outcome: "stopped", stopReason: "diagnostic-inspected" } as const;
        },
    },
    "diagnostics-bounded-list": {
        script: [{ name: "system.error-diagnostic.list", arguments: { from: "2026-09-08T00:00:00.000Z", to: "2026-09-09T00:00:00.000Z", limit: 20 }, result: { items: [], nextCursor: null } }],
        run: async (mcp) => {
            await mcp.call("system.error-diagnostic.list", { from: "2026-09-08T00:00:00.000Z", to: "2026-09-09T00:00:00.000Z", limit: 20 });
            return { outcome: "completed" } as const;
        },
    },
    "diagnostics-denial-stops": {
        script: [{ name: "system.error-diagnostic.get", arguments: { correlationId: DIAGNOSTIC_CORRELATION }, error: { code: "DIAGNOSTIC_FORBIDDEN", message: "not allowed", retryable: false, reviewRequired: false, details: {} } }],
        run: async (mcp) => {
            try { await mcp.call("system.error-diagnostic.get", { correlationId: DIAGNOSTIC_CORRELATION }); } catch (error) {
                if (error instanceof ScriptedMcpError && error.code === "DIAGNOSTIC_FORBIDDEN") return { outcome: "stopped", stopReason: "diagnostic-forbidden" } as const;
                throw error;
            }
            return { outcome: "completed" } as const;
        },
    },
    "diagnostics-never-bypass-confirmation": {
        script: [{ name: "payment.post", arguments: { paymentIntakePublicId: INTAKE, proposalPublicId: PROPOSAL }, error: { code: "CONFIRMATION_REQUIRED", message: "confirm first", retryable: false, reviewRequired: true, details: {} } }],
        run: async (mcp) => {
            try { await mcp.call("payment.post", { paymentIntakePublicId: INTAKE, proposalPublicId: PROPOSAL }); } catch (error) {
                if (error instanceof ScriptedMcpError && error.code === "CONFIRMATION_REQUIRED") return { outcome: "stopped", stopReason: "confirmation-boundary" } as const;
                throw error;
            }
            return { outcome: "completed" } as const;
        },
    },
    "payment-reconcile-legacy-reflow-confirmation": {
        script: [
            { name: "payment.reconcile.reflow.preview", arguments: { reconciliationPublicId: ALLOCATION_PREVIEW, reason: "Repair legacy interest chronology" }, result: { publicId: ALLOCATION_CORRECTION, status: "ready", reconciliationGroupPublicId: ALLOCATION_PREVIEW, effectiveAfterDate: "2026-08-18", plan: { effectiveAfterDate: "2026-08-18", displacedTotal: "75.00", replacementTotal: "75.00", transactions: [] }, previewHash: PREVIEW_HASH, expectedBalanceVersion: BALANCE_VERSION, reason: "Repair legacy interest chronology", expiresAt: "2026-09-10T12:00:00.000Z", warnings: [] } },
            { name: "payment.reconcile.reflow.execute", arguments: { reflowPreviewPublicId: ALLOCATION_CORRECTION, previewHash: PREVIEW_HASH, expectedBalanceVersion: BALANCE_VERSION, confirmed: true, reason: "Repair legacy interest chronology", idempotencyKey: "legacy-reflow-1" }, result: { reflowGroupPublicId: ALLOCATION_CORRECTION, reconciliationGroupPublicId: ALLOCATION_PREVIEW, compensatingTransactionPublicIds: [ALLOCATION_REVERSAL_TRANSACTION], correctedTransactionPublicIds: [ALLOCATION_REPLACEMENT_TRANSACTION], auditPublicIds: [COMMISSION_AUDIT], correlationId: COMMISSION_CORRELATION } },
        ],
        run: async (mcp) => { const preview = await mcp.call("payment.reconcile.reflow.preview", { reconciliationPublicId: ALLOCATION_PREVIEW, reason: "Repair legacy interest chronology" }); await mcp.call("payment.reconcile.reflow.execute", { reflowPreviewPublicId: preview.publicId, previewHash: preview.previewHash, expectedBalanceVersion: preview.expectedBalanceVersion, confirmed: true, reason: preview.reason, idempotencyKey: "legacy-reflow-1" }); return { outcome: "completed" } as const; },
    },
    "payment-reconcile-legacy-reflow-stale-stops": {
        script: [{ name: "payment.reconcile.reflow.preview", arguments: { reconciliationPublicId: ALLOCATION_PREVIEW, reason: "Repair stale legacy chronology" }, result: { publicId: ALLOCATION_CORRECTION, status: "ready", reconciliationGroupPublicId: ALLOCATION_PREVIEW, effectiveAfterDate: "2026-08-18", plan: { effectiveAfterDate: "2026-08-18", displacedTotal: "75.00", replacementTotal: "75.00", transactions: [] }, previewHash: PREVIEW_HASH, expectedBalanceVersion: BALANCE_VERSION, reason: "Repair stale legacy chronology", expiresAt: "2026-09-10T12:00:00.000Z", warnings: [] } }, { name: "payment.reconcile.reflow.execute", arguments: { reflowPreviewPublicId: ALLOCATION_CORRECTION, previewHash: PREVIEW_HASH, expectedBalanceVersion: BALANCE_VERSION, confirmed: true, reason: "Repair stale legacy chronology", idempotencyKey: "legacy-reflow-stale" }, error: { code: "STALE_TEMPORAL_REFLOW_PREVIEW", message: "Temporal reflow preview is stale", retryable: false, reviewRequired: true, details: {} } }],
        run: async (mcp) => { const preview = await mcp.call("payment.reconcile.reflow.preview", { reconciliationPublicId: ALLOCATION_PREVIEW, reason: "Repair stale legacy chronology" }); try { await mcp.call("payment.reconcile.reflow.execute", { reflowPreviewPublicId: preview.publicId, previewHash: preview.previewHash, expectedBalanceVersion: preview.expectedBalanceVersion, confirmed: true, reason: preview.reason, idempotencyKey: "legacy-reflow-stale" }); } catch (error) { if (error instanceof ScriptedMcpError && error.code === "STALE_TEMPORAL_REFLOW_PREVIEW") return { outcome: "stopped", stopReason: "stale-reflow-preview" } as const; throw error; } return { outcome: "completed" } as const; },
    },
    "payment-intake-cancel-confirmed": {
        script: [
            { name: "intake.get", arguments: { paymentIntakePublicId: INTAKE }, result: { publicId: INTAKE, status: "ready", cancellation: { allowed: true, stateHash: "c".repeat(64), blockedReason: null, batchPublicId: null } } },
            { name: "payment.cancel", arguments: { paymentIntakePublicId: INTAKE, reason: "Entered in error", idempotencyKey: "cancel-1", expectedStateHash: "c".repeat(64) }, result: { paymentIntakePublicId: INTAKE, status: "cancelled", reason: "Entered in error", cancelledAt: "2026-09-11T00:00:00.000Z", cancellationPublicId: COMMISSION_AUDIT, auditPublicId: COMMISSION_AUDIT, correlationId: COMMISSION_CORRELATION } },
            { name: "intake.get", arguments: { paymentIntakePublicId: INTAKE }, result: { publicId: INTAKE, status: "cancelled" } },
        ],
        run: async (mcp) => { const detail = await mcp.call("intake.get", { paymentIntakePublicId: INTAKE }); await mcp.call("payment.cancel", { paymentIntakePublicId: INTAKE, reason: "Entered in error", idempotencyKey: "cancel-1", expectedStateHash: (detail.cancellation as { stateHash: string }).stateHash }); await mcp.call("intake.get", { paymentIntakePublicId: INTAKE }); return { outcome: "completed" } as const; },
    },
    "payment-intake-cancel-stale-stop": {
        script: [
            { name: "intake.get", arguments: { paymentIntakePublicId: INTAKE }, result: { publicId: INTAKE, status: "ready", cancellation: { allowed: true, stateHash: "c".repeat(64), blockedReason: null, batchPublicId: null } } },
            { name: "payment.cancel", arguments: { paymentIntakePublicId: INTAKE, reason: "Entered in error", idempotencyKey: "cancel-stale", expectedStateHash: "c".repeat(64) }, error: { code: "PAYMENT_CANCEL_STALE", message: "Payment intake changed", retryable: false, reviewRequired: true, details: {} } },
        ],
        run: async (mcp) => { const detail = await mcp.call("intake.get", { paymentIntakePublicId: INTAKE }); try { await mcp.call("payment.cancel", { paymentIntakePublicId: INTAKE, reason: "Entered in error", idempotencyKey: "cancel-stale", expectedStateHash: detail.cancellation.stateHash }); } catch (error) { if (error instanceof ScriptedMcpError && error.code === "PAYMENT_CANCEL_STALE") return { outcome: "stopped", stopReason: "stale-cancellation-state" } as const; throw error; } return { outcome: "completed" } as const; },
    },
    "cancelled-payment-replacement": {
        script: [
            { name: "intake.get", arguments: { paymentIntakePublicId: INTAKE }, result: { publicId: INTAKE, status: "cancelled", receivedAt: "2026-09-21T12:05:00.000Z", amount: "200.00", evidence: [], cancellation: { allowed: true, stateHash: "c".repeat(64), blockedReason: null, batchPublicId: null } } },
            { name: "payment.replacement.inspect", arguments: { paymentIntakePublicId: INTAKE }, result: { sourcePaymentIntakePublicId: INTAKE, allowed: true, blockers: [], stateHash: "c".repeat(64), replacementPaymentIntakePublicId: null, lineagePublicId: null } },
            { name: "payment.replacement.create", arguments: { paymentIntakePublicId: INTAKE, reason: "Correct contract mapping", idempotencyKey: "replacement-1", expectedStateHash: "c".repeat(64) }, result: { sourcePaymentIntakePublicId: INTAKE, replacementPaymentIntakePublicId: REPLACEMENT, status: "draft", auditPublicId: REPLACEMENT_AUDIT, correlationId: REPLACEMENT_AUDIT, lineagePublicId: REPLACEMENT_AUDIT } },
            { name: "payment.preview", arguments: { paymentIntakePublicId: REPLACEMENT, allocations: [{ borrowerPublicId: BORROWER_A, loanPublicId: LOAN_A, schedulePublicId: LOAN_B, amount: "100.00" }, { borrowerPublicId: BORROWER_A, loanPublicId: LOAN_A, schedulePublicId: LOAN_C, amount: "100.00" }] }, result: { publicId: PROPOSAL, version: 1, status: "ready", warnings: [], totalAllocated: "200.00", allocations: [{ publicId: PROPOSAL, amount: "100.00", borrowerPublicId: BORROWER_A, loanPublicId: LOAN_A, schedulePublicId: LOAN_B }, { publicId: REPLACEMENT_AUDIT, amount: "100.00", borrowerPublicId: BORROWER_A, loanPublicId: LOAN_A, schedulePublicId: LOAN_C }] } },
            { name: "payment.post", arguments: { paymentIntakePublicId: REPLACEMENT, proposalPublicId: PROPOSAL }, result: { publicId: REPLACEMENT, status: "posted", repostOfIntakePublicId: null, repostedByIntakePublicId: null, transactions: [{ publicId: REPLACEMENT_AUDIT, amount: "200.00", principalComponent: "200.00", interestComponent: "0.00", feeComponent: "0.00", penaltyComponent: "0.00", entryType: "payment", postedAt: "2026-09-21T12:05:00.000Z" }] } },
        ],
        run: async (mcp) => {
            await mcp.call("intake.get", { paymentIntakePublicId: INTAKE });
            const inspection = await mcp.call("payment.replacement.inspect", { paymentIntakePublicId: INTAKE });
            await mcp.call("payment.replacement.create", { paymentIntakePublicId: INTAKE, reason: "Correct contract mapping", idempotencyKey: "replacement-1", expectedStateHash: inspection.stateHash });
            const preview = await mcp.call("payment.preview", { paymentIntakePublicId: REPLACEMENT, allocations: [{ borrowerPublicId: BORROWER_A, loanPublicId: LOAN_A, schedulePublicId: LOAN_B, amount: "100.00" }, { borrowerPublicId: BORROWER_A, loanPublicId: LOAN_A, schedulePublicId: LOAN_C, amount: "100.00" }] });
            await mcp.call("payment.post", { paymentIntakePublicId: REPLACEMENT, proposalPublicId: preview.publicId });
            return { outcome: "completed" } as const;
        },
    },
    "cancelled-payment-duplicate-review": {
        script: [
            { name: "payment.replacement.inspect", arguments: { paymentIntakePublicId: INTAKE }, result: { sourcePaymentIntakePublicId: INTAKE, allowed: false, blockers: ["PAYMENT_DUPLICATE_REQUIRES_REVIEW"], blockerPublicIds: [DUPLICATE_CANDIDATE], stateHash: "c".repeat(64), replacementPaymentIntakePublicId: null, lineagePublicId: null } },
            { name: "payment.replacement.duplicate-review.preview", arguments: { canonicalPaymentIntakePublicId: INTAKE, candidatePaymentIntakePublicIds: [DUPLICATE_CANDIDATE], reason: "Owner confirmed these cancelled drafts represent one receipt", idempotencyKey: "duplicate-review-preview-1" }, result: { duplicateReviewPublicId: DUPLICATE_REVIEW, status: "previewed", canonicalPaymentIntakePublicId: INTAKE, candidatePaymentIntakePublicIds: [DUPLICATE_CANDIDATE], previewHash: "d".repeat(64), canonicalStateHash: "e".repeat(64), evidenceHash: "f".repeat(64), dependencyHash: "a".repeat(64), expiresAt: "2026-09-22T12:15:00.000Z", auditPublicId: DUPLICATE_REVIEW, correlationId: DUPLICATE_REVIEW } },
            { name: "payment.replacement.duplicate-review.execute", arguments: { duplicateReviewPublicId: DUPLICATE_REVIEW, previewHash: "d".repeat(64), confirmed: true, reason: "Owner confirmed these cancelled drafts represent one receipt", idempotencyKey: "duplicate-review-execute-1" }, result: { duplicateReviewPublicId: DUPLICATE_REVIEW, status: "executed", auditPublicId: DUPLICATE_EXECUTION, correlationId: DUPLICATE_EXECUTION, executionPublicId: DUPLICATE_EXECUTION } },
            { name: "payment.replacement.inspect", arguments: { paymentIntakePublicId: INTAKE }, result: { sourcePaymentIntakePublicId: INTAKE, allowed: true, blockers: [], stateHash: "c".repeat(64), replacementPaymentIntakePublicId: null, lineagePublicId: null } },
            { name: "payment.replacement.create", arguments: { paymentIntakePublicId: INTAKE, reason: "Correct contract mapping", idempotencyKey: "replacement-1", expectedStateHash: "c".repeat(64) }, result: { sourcePaymentIntakePublicId: INTAKE, replacementPaymentIntakePublicId: REPLACEMENT, status: "draft", auditPublicId: REPLACEMENT_AUDIT, correlationId: REPLACEMENT_AUDIT, lineagePublicId: REPLACEMENT_AUDIT } },
            { name: "payment.preview", arguments: { paymentIntakePublicId: REPLACEMENT, allocations: [{ borrowerPublicId: BORROWER_A, loanPublicId: LOAN_A, schedulePublicId: LOAN_B, amount: "100.00" }, { borrowerPublicId: BORROWER_A, loanPublicId: LOAN_A, schedulePublicId: LOAN_C, amount: "100.00" }] }, result: { publicId: PROPOSAL, version: 1, status: "ready", warnings: [], totalAllocated: "200.00", allocations: [] } },
            { name: "payment.post", arguments: { paymentIntakePublicId: REPLACEMENT, proposalPublicId: PROPOSAL }, result: { publicId: REPLACEMENT, status: "posted", repostOfIntakePublicId: null, repostedByIntakePublicId: null, transactions: [] } },
        ],
        run: async (mcp) => { const first = await mcp.call("payment.replacement.inspect", { paymentIntakePublicId: INTAKE }); await mcp.call("payment.replacement.duplicate-review.preview", { canonicalPaymentIntakePublicId: INTAKE, candidatePaymentIntakePublicIds: [DUPLICATE_CANDIDATE], reason: "Owner confirmed these cancelled drafts represent one receipt", idempotencyKey: "duplicate-review-preview-1" }); await mcp.call("payment.replacement.duplicate-review.execute", { duplicateReviewPublicId: DUPLICATE_REVIEW, previewHash: "d".repeat(64), confirmed: true, reason: "Owner confirmed these cancelled drafts represent one receipt", idempotencyKey: "duplicate-review-execute-1" }); await mcp.call("payment.replacement.inspect", { paymentIntakePublicId: INTAKE }); await mcp.call("payment.replacement.create", { paymentIntakePublicId: INTAKE, reason: "Correct contract mapping", idempotencyKey: "replacement-1", expectedStateHash: first.stateHash }); const preview = await mcp.call("payment.preview", { paymentIntakePublicId: REPLACEMENT, allocations: [{ borrowerPublicId: BORROWER_A, loanPublicId: LOAN_A, schedulePublicId: LOAN_B, amount: "100.00" }, { borrowerPublicId: BORROWER_A, loanPublicId: LOAN_A, schedulePublicId: LOAN_C, amount: "100.00" }] }); await mcp.call("payment.post", { paymentIntakePublicId: REPLACEMENT, proposalPublicId: preview.publicId }); return { outcome: "completed" } as const; },
    },
    "cancelled-payment-duplicate-review-stop": {
        script: [{ name: "payment.replacement.inspect", arguments: { paymentIntakePublicId: INTAKE }, result: { sourcePaymentIntakePublicId: INTAKE, allowed: false, blockers: ["PAYMENT_DUPLICATE_REQUIRES_REVIEW"], blockerPublicIds: [DUPLICATE_CANDIDATE], stateHash: "c".repeat(64), replacementPaymentIntakePublicId: null, lineagePublicId: null } }],
        run: async (mcp) => { const inspection = await mcp.call("payment.replacement.inspect", { paymentIntakePublicId: INTAKE }); return { outcome: "stopped", stopReason: inspection.blockers[0] } as const; },
    },
};

export const EVAL_SCENARIO_IDS = Object.freeze(Object.keys(SCENARIOS));

export async function runEvalScenario(id: string, validators?: HarnessSchemaValidators): Promise<HarnessResult> {
    const scenario = SCENARIOS[id];
    if (!scenario) throw new Error(`unknown eval scenario ${id}`);
    const mcp = new ScriptedMcp(scenario.script, scenario.authorized, validators);
    const result = await scenario.run(mcp);
    mcp.assertComplete();
    return { calls: mcp.calls, effects: mcp.effects, events: mcp.events, ...result };
}
