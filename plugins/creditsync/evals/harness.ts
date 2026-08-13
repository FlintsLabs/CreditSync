import { isDeepStrictEqual } from "node:util";
import type { McpToolName } from "../../../backend/src/mcp/server";

const BORROWER_A = "0198c481-3e2b-7000-8000-000000000011";
const BORROWER_B = "0198c481-3e2b-7000-8000-000000000012";
const ALIAS = "0198c481-3e2b-7000-8000-000000000013";
const INTAKE = "0198c481-3e2b-7000-8000-000000000021";
const ORIGINAL_INTAKE = "0198c481-3e2b-7000-8000-000000000022";
const EVIDENCE = "0198c481-3e2b-7000-8000-000000000023";
const PROPOSAL = "0198c481-3e2b-7000-8000-000000000024";
const LOAN_A = "0198c481-3e2b-7000-8000-000000000031";
const LOAN_B = "0198c481-3e2b-7000-8000-000000000032";
const LOAN_C = "0198c481-3e2b-7000-8000-000000000033";
const DRAFT = "0198c481-3e2b-7000-8000-000000000034";
const DISBURSEMENT = "0198c481-3e2b-7000-8000-000000000051";
const DISBURSEMENT_EVIDENCE = "0198c481-3e2b-7000-8000-000000000052";
const RENEWAL = "0198c481-3e2b-7000-8000-000000000041";
const PREVIEW_HASH = `v1:${"a".repeat(64)}`;
const RATE_PREVIEW = "0198c481-3e2b-7000-8000-000000000061";
const SETTLEMENT = "0198c481-3e2b-7000-8000-000000000071";
const FILE_HASH = "b".repeat(64);
const DISBURSEMENT_FILE_HASH = "c".repeat(64);
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

export type ToolCall = { name: McpToolName; arguments: Record<string, unknown> };
type ScriptedError = { code: string; message: string; details?: Record<string, unknown> };
type ScriptStep = ToolCall & { result?: Record<string, unknown>; error?: ScriptedError };
export type HarnessEvent =
    | { type: "tool"; name: McpToolName }
    | { type: "presentation"; name: "floating-settlement-preview"; data: Record<string, unknown> }
    | { type: "presentation"; name: "intermediated-disbursement-preview"; data: Record<string, unknown> }
    | { type: "confirmation"; name: "floating-settlement" | "intermediated-disbursement"; confirmed: boolean };

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
    effects: string[];
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
    readonly effects: string[] = [];
    readonly events: HarnessEvent[] = [];
    private cursor = 0;

    constructor(private readonly script: ScriptStep[], private readonly authorized = true) {}

    ensureAuthorized() {
        if (!this.authorized) throw new Error("UNAUTHORIZED");
    }

    effect(name: string) {
        this.effects.push(name);
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

    recordIntermediatedDisbursementConfirmation(confirmed: boolean) {
        this.events.push({ type: "confirmation", name: "intermediated-disbursement", confirmed });
    }

    async call(name: McpToolName, args: Record<string, unknown>) {
        const step = this.script[this.cursor++];
        if (!step) throw new Error(`unexpected MCP call ${name}`);
        if (step.name !== name || !isDeepStrictEqual(step.arguments, args)) {
            throw new Error(`MCP call mismatch at ${this.cursor}: expected ${step.name} ${JSON.stringify(step.arguments)}, received ${name} ${JSON.stringify(args)}`);
        }
        this.calls.push({ name, arguments: args });
        this.events.push({ type: "tool", name });
        if (step.error) throw new ScriptedMcpError(step.error.code, step.error.message, step.error.details ?? {});
        return step.result ?? {};
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

async function paymentFlow(mcp: ScriptedMcp, options: {
    evidence?: boolean;
    explicitAllocations?: typeof allocations;
}) {
    const intake = await mcp.call("intake.create", intakeArgs);
    if (intake.duplicate === true) {
        await mcp.call("intake.get", { paymentIntakePublicId: intake.publicId });
        return { outcome: "stopped", stopReason: "duplicate" } as const;
    }
    if (options.evidence) {
        const prepared = await mcp.call("evidence.prepare", {
            paymentIntakePublicId: INTAKE,
            mimeType: "image/jpeg",
            size: 2048,
            sha256: FILE_HASH,
            evidenceType: "slip",
        });
        if (prepared.duplicate === true) {
            await mcp.call("intake.get", { paymentIntakePublicId: prepared.intakePublicId });
            return { outcome: "stopped", stopReason: "duplicate-evidence" } as const;
        }
        mcp.effect("evidence.put");
        await mcp.call("evidence.finalize", {
            paymentIntakePublicId: INTAKE,
            evidencePublicId: prepared.publicId,
        });
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
        await mcp.call("payment.post", {
            paymentIntakePublicId: INTAKE,
            proposalPublicId: proposal.publicId,
        });
        return { outcome: "completed" } as const;
    }
    return { outcome: "stopped", stopReason: "stale" } as const;
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

const EXECUTED_RENEWAL_RESULT = {
    publicId: RENEWAL,
    status: "executed",
    oldLoanPublicId: LOAN_A,
    newLoanPublicId: LOAN_B,
    previewHash: PREVIEW_HASH,
    principalPaid: "1666.70",
    outstandingPrincipal: "833.30",
    dueCharges: "0.00",
    settlementAmount: "833.30",
    waivedCharges: "0.00",
    requestedPrincipal: "2500.00",
    cashDirection: "payout",
    cashAmount: "1666.70",
} satisfies SameTaskRenewalExecutionContext["executeResult"];

const SAME_TASK_RENEWAL_CONTEXT: SameTaskRenewalExecutionContext = {
    provenance: "same_task_renewal_execute_result",
    retainedBorrowerPublicId: BORROWER_A,
    executeResult: EXECUTED_RENEWAL_RESULT,
};

const RENEWAL_PORTFOLIO = {
    borrower: { publicId: BORROWER_A },
    aliases: [],
    loans: [
        { publicId: LOAN_A, principal: "2500.00", interestRate: "14.00", repaymentType: "daily", status: "renewed", startDate: "2026-07-01" },
        { publicId: LOAN_B, principal: "2500.00", interestRate: "14.00", repaymentType: "daily", status: "active", startDate: "2026-08-11" },
    ],
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
            size: 4096,
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
    mcp.effect("disbursement-evidence.put");
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

async function renewalExecute(mcp: ScriptedMcp, operatorConfirmed = true) {
    await mcp.call("borrower.portfolio", { borrowerPublicId: BORROWER_A });
    const preview = await mcp.call("renewal.preview", { oldLoanPublicId: LOAN_A, requestedPrincipal: "2500.00" });
    if (preview.dueCharges !== "0.00") return { outcome: "stopped", stopReason: "unsettled-charges" } as const;
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
            result: { borrower: { publicId: BORROWER_A }, loans: [{ publicId: LOAN_A, status: "active" }] },
        },
        {
            name: "intermediary.search",
            arguments: { query: intermediarySearchQuery },
            result: options.ambiguous
                ? { items: [{ publicId: INTERMEDIARY, name: intermediarySearchQuery, aliases: [] }, { publicId: INTERMEDIARY_B, name: intermediarySearchQuery, aliases: [] }] }
                : { items: [{ publicId: INTERMEDIARY, name: intermediarySearchQuery, aliases: ["MCP transfer agent"] }] },
        },
    ];
    if (options.ambiguous) return script;
    script.push({
        name: "intermediary.profile.get",
        arguments: { intermediaryPublicId: INTERMEDIARY },
        result: {
            publicId: INTERMEDIARY,
            assignments: options.missingAssignment ? [] : [{
                publicId: INTERMEDIARY_ASSIGNMENT,
                loanPublicId: LOAN_A,
                intermediaryPublicId: INTERMEDIARY,
                role: "disbursement",
                status: "active",
                effectiveFrom: "2026-08-01T00:00:00.000Z",
                effectiveTo: null,
            }],
        },
    });
    return script;
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
    };
}

function intermediatedGroupCreateStep(retainedBalance = "0.00"): ScriptStep {
    return {
        name: "intermediary.disbursement.create",
        arguments: intermediatedGroupArgs,
        result: intermediatedGroupResult(retainedBalance),
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
    return {
        groupPublicId: INTERMEDIATED_GROUP,
        eventPublicId: INTERMEDIATED_EVENTS[index]!,
        mimeType: "image/png",
        size: 4096,
        sha256: String(index + 1).repeat(64),
        originalName: `intermediated-slip-${index + 1}.png`,
    };
}

function intermediatedEventScript(index: number, options: { missingEvidence?: boolean; duplicate?: boolean } = {}): ScriptStep[] {
    const spec = intermediatedEventSpecs[index]!;
    if (options.duplicate) return [{
        name: "intermediary.disbursement.event.create",
        arguments: intermediatedEventArgs(index),
        error: { code: "DUPLICATE_BANK_REFERENCE", message: "Bank reference is already attached to another transfer event" },
    }];
    return [
        {
            name: "intermediary.disbursement.event.create",
            arguments: intermediatedEventArgs(index),
            result: { ...spec, groupPublicId: INTERMEDIATED_GROUP, channel: "bank_transfer", status: "ready" },
        },
        {
            name: "intermediary.disbursement.evidence.prepare",
            arguments: intermediatedEvidenceArgs(index),
            result: options.missingEvidence ? {
                publicId: INTERMEDIATED_EVIDENCE[index],
                status: "pending",
            } : {
                publicId: INTERMEDIATED_EVIDENCE[index],
                status: "pending",
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
            result: { publicId: INTERMEDIATED_EVIDENCE[index], status: "ready" },
        }]),
    ];
}

function intermediatedPresentedEvents(payeeMismatch = false) {
    return intermediatedEventSpecs.map((spec, index) => ({
        ...spec,
        groupPublicId: INTERMEDIATED_GROUP,
        channel: "bank_transfer",
        status: "ready",
        ...(payeeMismatch && index === 1 ? { payeeHint: "Different unconfirmed payee" } : {}),
    }));
}

function intermediatedDetailStep(payeeMismatch = false): ScriptStep {
    return {
        name: "intermediary.disbursement.get",
        arguments: { groupPublicId: INTERMEDIATED_GROUP },
        result: { ...intermediatedGroupResult(), events: intermediatedPresentedEvents(payeeMismatch), latestPreview: null },
    };
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

async function intermediatedDisbursementFlow(mcp: ScriptedMcp, options: { confirmed?: boolean } = {}) {
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
    const group = await mcp.call("intermediary.disbursement.create", intermediatedGroupArgs);
    if (group.retainedBalance !== "0.00") {
        return { outcome: "stopped", stopReason: "intermediated-retained-balance-unexplained" } as const;
    }

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
        let prepared: Record<string, unknown>;
        try {
            prepared = await mcp.call("intermediary.disbursement.evidence.prepare", intermediatedEvidenceArgs(index));
        } catch (error) {
            if (error instanceof ScriptedMcpError && error.code === "EVIDENCE_HASH_CONFLICT") {
                return { outcome: "stopped", stopReason: "intermediated-duplicate-transfer" } as const;
            }
            throw error;
        }
        if (prepared.status === "ready") continue;
        const expiresAt = typeof prepared.expiresAt === "string" ? Date.parse(prepared.expiresAt) : Number.NaN;
        if (typeof prepared.uploadUrl !== "string" || !prepared.requiredHeaders || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
            return { outcome: "stopped", stopReason: "intermediated-evidence-required" } as const;
        }
        mcp.effect("intermediated-evidence.put");
        const finalized = await mcp.call("intermediary.disbursement.evidence.finalize", {
            groupPublicId: INTERMEDIATED_GROUP,
            eventPublicId: spec.publicId,
            evidencePublicId: prepared.publicId,
        });
        if (finalized.status !== "ready") return { outcome: "stopped", stopReason: "intermediated-evidence-required" } as const;
    }

    const detail = await mcp.call("intermediary.disbursement.get", { groupPublicId: INTERMEDIATED_GROUP });
    const events = detail.events as Array<{ publicId: string; amount: string; payeeHint: string | null }>;
    if (events.length !== intermediatedEventSpecs.length || intermediatedEventSpecs.some((spec) => {
        const event = events.find((candidate) => candidate.publicId === spec.publicId);
        return !event || event.amount !== spec.amount || event.payeeHint !== spec.payeeHint;
    })) {
        return { outcome: "stopped", stopReason: "intermediated-transfer-mismatch" } as const;
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
    const confirmed = options.confirmed !== false;
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
    run: (mcp: ScriptedMcp) => Promise<Omit<HarnessResult, "calls" | "effects">>;
};

const SCENARIOS: Record<string, Scenario> = {
    "borrower-create-alias": {
        script: [
            { name: "borrower.search", arguments: { query: "นก (Nok)" }, result: { resolution: "none" } },
            { name: "borrower.create", arguments: { name: "กนกพิชญ์ เลิศพรหมมกุล", phone: "0812345678" }, result: { publicId: BORROWER_A } },
            { name: "borrower.portfolio", arguments: { borrowerPublicId: BORROWER_A } },
            { name: "borrower.alias", arguments: { action: "add", borrowerPublicId: BORROWER_A, alias: "นก", source: "manual" }, result: { publicId: ALIAS } },
            { name: "borrower.alias", arguments: { action: "confirm", aliasPublicId: ALIAS } },
        ],
        run: createBorrowerAlias,
    },
    "payment-data-only": {
        script: [
            { name: "intake.create", arguments: intakeArgs, result: { publicId: INTAKE, duplicate: false } },
            { name: "payment.preview", arguments: { paymentIntakePublicId: INTAKE }, result: { publicId: PROPOSAL, status: "ready" } },
            { name: "payment.post", arguments: { paymentIntakePublicId: INTAKE, proposalPublicId: PROPOSAL } },
        ],
        run: (mcp) => paymentFlow(mcp, {}),
    },
    "payment-slip": {
        script: [
            { name: "intake.create", arguments: intakeArgs, result: { publicId: INTAKE, duplicate: false } },
            { name: "evidence.prepare", arguments: { paymentIntakePublicId: INTAKE, mimeType: "image/jpeg", size: 2048, sha256: FILE_HASH, evidenceType: "slip" }, result: { publicId: EVIDENCE, duplicate: false } },
            { name: "evidence.finalize", arguments: { paymentIntakePublicId: INTAKE, evidencePublicId: EVIDENCE } },
            { name: "payment.preview", arguments: { paymentIntakePublicId: INTAKE }, result: { publicId: PROPOSAL, status: "ready" } },
            { name: "payment.post", arguments: { paymentIntakePublicId: INTAKE, proposalPublicId: PROPOSAL } },
        ],
        run: (mcp) => paymentFlow(mcp, { evidence: true }),
    },
    "payment-stale-repreview": {
        script: [
            { name: "intake.create", arguments: intakeArgs, result: { publicId: INTAKE, duplicate: false } },
            { name: "payment.preview", arguments: { paymentIntakePublicId: INTAKE }, result: { status: "stale" } },
            { name: "intake.get", arguments: { paymentIntakePublicId: INTAKE } },
            { name: "payment.preview", arguments: { paymentIntakePublicId: INTAKE }, result: { publicId: PROPOSAL, status: "ready" } },
            { name: "payment.post", arguments: { paymentIntakePublicId: INTAKE, proposalPublicId: PROPOSAL } },
        ],
        run: (mcp) => paymentFlow(mcp, {}),
    },
    "payment-split-loans": {
        script: [
            { name: "borrower.portfolio", arguments: { borrowerPublicId: BORROWER_A } },
            { name: "intake.create", arguments: intakeArgs, result: { publicId: INTAKE, duplicate: false } },
            { name: "payment.preview", arguments: { paymentIntakePublicId: INTAKE, allocations }, result: { publicId: PROPOSAL, status: "ready" } },
            { name: "payment.post", arguments: { paymentIntakePublicId: INTAKE, proposalPublicId: PROPOSAL } },
        ],
        run: async (mcp) => { await mcp.call("borrower.portfolio", { borrowerPublicId: BORROWER_A }); return paymentFlow(mcp, { explicitAllocations: allocations }); },
    },
    "payment-split-borrowers-intermediary": {
        script: [
            { name: "borrower.search", arguments: { query: "พล" }, result: { resolution: "unique", candidates: [{ publicId: BORROWER_A }] } },
            { name: "borrower.portfolio", arguments: { borrowerPublicId: BORROWER_A } },
            { name: "borrower.search", arguments: { query: "ลอย" }, result: { resolution: "unique", candidates: [{ publicId: BORROWER_B }] } },
            { name: "borrower.portfolio", arguments: { borrowerPublicId: BORROWER_B } },
            { name: "intake.create", arguments: intakeArgs, result: { publicId: INTAKE, duplicate: false } },
            { name: "payment.preview", arguments: { paymentIntakePublicId: INTAKE, allocations: [allocations[0], { borrowerPublicId: BORROWER_B, loanPublicId: LOAN_B, amount: "300.00" }] }, result: { publicId: PROPOSAL, status: "needs_review" } },
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
            { name: "borrower.portfolio", arguments: { borrowerPublicId: BORROWER_A } },
            { name: "intake.create", arguments: intakeArgs, result: { publicId: INTAKE, duplicate: false } },
            { name: "payment.preview", arguments: { paymentIntakePublicId: INTAKE, allocations: partialAllocation }, result: { publicId: PROPOSAL, status: "ready" } },
            { name: "payment.post", arguments: { paymentIntakePublicId: INTAKE, proposalPublicId: PROPOSAL } },
        ],
        run: async (mcp) => { await mcp.call("borrower.portfolio", { borrowerPublicId: BORROWER_A }); return paymentFlow(mcp, { explicitAllocations: partialAllocation }); },
    },
    "loan-draft-activation": {
        script: [
            { name: "borrower.search", arguments: { query: "กนกพิชญ์" }, result: { resolution: "unique", candidates: [{ publicId: BORROWER_A }] } },
            { name: "borrower.portfolio", arguments: { borrowerPublicId: BORROWER_A } },
            { name: "loan.preview", arguments: loanTerms },
            { name: "loan.draft", arguments: { borrowerPublicId: BORROWER_A, ...loanTerms }, result: { publicId: DRAFT } },
            { name: "loan.activate", arguments: { loanPublicId: DRAFT, idempotencyKey: "loan-activation-20260811-1" } },
        ],
        run: loanActivation,
    },
    "floating-rate-scheduled-change": {
        script: [
            { name: "loan.interest-rate.list", arguments: { loanPublicId: LOAN_A }, result: { earliestEditableDate: "2026-08-12" } },
            { name: "loan.interest-rate.preview", arguments: { loanPublicId: LOAN_A, effectiveDate: "2026-09-01", expiryDate: null, rateType: "percent", rate: "1" }, result: { publicId: RATE_PREVIEW, previewHash: PREVIEW_HASH, expiresAt: "2026-08-11T10:15:00+07:00" } },
            { name: "loan.interest-rate.execute", arguments: { loanPublicId: LOAN_A, previewPublicId: RATE_PREVIEW, previewHash: PREVIEW_HASH, confirmed: true, reason: "Owner confirmed scheduled September rate", idempotencyKey: "rate-change-20260901-1" } },
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
            { name: "loan.interest-rate.list", arguments: { loanPublicId: LOAN_A }, result: { earliestEditableDate: "2026-08-12" } },
            { name: "loan.interest-rate.preview", arguments: { loanPublicId: LOAN_A, effectiveDate: "2026-09-01", expiryDate: null, rateType: "percent", rate: "1" }, result: { publicId: RATE_PREVIEW, previewHash: PREVIEW_HASH } },
        ],
        run: async (mcp) => {
            await mcp.call("loan.interest-rate.list", { loanPublicId: LOAN_A });
            await mcp.call("loan.interest-rate.preview", { loanPublicId: LOAN_A, effectiveDate: "2026-09-01", expiryDate: null, rateType: "percent", rate: "1" });
            return { outcome: "stopped", stopReason: "rate-change-confirmation-required" } as const;
        },
    },
    "floating-settlement-execute": {
        script: [
            { name: "borrower.portfolio", arguments: { borrowerPublicId: BORROWER_A }, result: { loans: [{ publicId: LOAN_A, repaymentType: "floating", status: "active" }] } },
            { name: "loan.settlement.preview", arguments: { loanPublicId: LOAN_A, asOfDate: "2026-08-15" }, result: { publicId: SETTLEMENT, previewHash: SETTLEMENT_PREVIEW_HASH, status: "ready", outstandingPrincipal: "5000.00", dueInterest: "25.00", accruedNotDueInterest: "17.14", outstandingFees: "10.00", outstandingPenalties: "5.00", nonRefundableAdvanceInterest: "600.00", settlementTotal: "5057.14", expiresAt: SETTLEMENT_EXPIRES_AT, balanceVersion: SETTLEMENT_BALANCE_VERSION } },
            { name: "loan.settlement.execute", arguments: { settlementPublicId: SETTLEMENT, previewHash: SETTLEMENT_PREVIEW_HASH, confirmed: true, reason: "Borrower confirmed the exact displayed close-out", idempotencyKey: "floating-settlement-20260815-1" }, result: { publicId: SETTLEMENT, status: "executed", settlementTotal: "5057.14" } },
        ],
        run: (mcp) => floatingSettlement(mcp, { confirmed: true }),
    },
    "floating-settlement-missing-confirmation": {
        script: [
            { name: "borrower.portfolio", arguments: { borrowerPublicId: BORROWER_A }, result: { loans: [{ publicId: LOAN_A, repaymentType: "floating", status: "active" }] } },
            { name: "loan.settlement.preview", arguments: { loanPublicId: LOAN_A, asOfDate: "2026-08-15" }, result: { publicId: SETTLEMENT, previewHash: SETTLEMENT_PREVIEW_HASH, status: "ready", outstandingPrincipal: "5000.00", dueInterest: "25.00", accruedNotDueInterest: "17.14", outstandingFees: "10.00", outstandingPenalties: "5.00", nonRefundableAdvanceInterest: "600.00", settlementTotal: "5057.14", expiresAt: SETTLEMENT_EXPIRES_AT, balanceVersion: SETTLEMENT_BALANCE_VERSION } },
        ],
        run: (mcp) => floatingSettlement(mcp),
    },
    "floating-settlement-stale-preview": {
        script: [
            { name: "borrower.portfolio", arguments: { borrowerPublicId: BORROWER_A }, result: { loans: [{ publicId: LOAN_A, repaymentType: "floating", status: "active" }] } },
            { name: "loan.settlement.preview", arguments: { loanPublicId: LOAN_A, asOfDate: "2026-08-15" }, result: { publicId: SETTLEMENT, previewHash: SETTLEMENT_PREVIEW_HASH, status: "ready", outstandingPrincipal: "5000.00", dueInterest: "25.00", accruedNotDueInterest: "17.14", outstandingFees: "10.00", outstandingPenalties: "5.00", nonRefundableAdvanceInterest: "600.00", settlementTotal: "5057.14", expiresAt: SETTLEMENT_EXPIRES_AT, balanceVersion: SETTLEMENT_BALANCE_VERSION } },
            { name: "loan.settlement.execute", arguments: { settlementPublicId: SETTLEMENT, previewHash: SETTLEMENT_PREVIEW_HASH, confirmed: true, reason: "Borrower confirmed the exact displayed close-out", idempotencyKey: "floating-settlement-20260815-1" }, error: { code: "STALE_SETTLEMENT_PREVIEW", message: "Loan settlement preview is stale" } },
            { name: "borrower.portfolio", arguments: { borrowerPublicId: BORROWER_A }, result: { loans: [{ publicId: LOAN_A, repaymentType: "floating", status: "active" }] } },
            { name: "loan.settlement.preview", arguments: { loanPublicId: LOAN_A, asOfDate: "2026-08-15" }, result: { publicId: "0198c481-3e2b-7000-8000-000000000072", previewHash: `v1:${"e".repeat(64)}`, status: "ready", outstandingPrincipal: "4900.00", dueInterest: "25.00", accruedNotDueInterest: "17.14", outstandingFees: "10.00", outstandingPenalties: "5.00", nonRefundableAdvanceInterest: "600.00", settlementTotal: "4957.14", expiresAt: "2026-08-15T06:20:00.000Z", balanceVersion: `v1:${"f".repeat(64)}` } },
        ],
        run: (mcp) => floatingSettlement(mcp, { confirmed: true }),
    },
    "floating-settlement-non-refundable-refund": {
        script: [
            { name: "borrower.portfolio", arguments: { borrowerPublicId: BORROWER_A }, result: { loans: [{ publicId: LOAN_A, repaymentType: "floating", status: "active" }] } },
            { name: "loan.settlement.preview", arguments: { loanPublicId: LOAN_A, asOfDate: "2026-08-15" }, result: { publicId: SETTLEMENT, previewHash: SETTLEMENT_PREVIEW_HASH, status: "ready", outstandingPrincipal: "5000.00", dueInterest: "25.00", accruedNotDueInterest: "17.14", outstandingFees: "10.00", outstandingPenalties: "5.00", nonRefundableAdvanceInterest: "600.00", settlementTotal: "5057.14", expiresAt: SETTLEMENT_EXPIRES_AT, balanceVersion: SETTLEMENT_BALANCE_VERSION } },
        ],
        run: (mcp) => floatingSettlement(mcp, { refundRequested: true }),
    },
    "disbursement-full-lifecycle": {
        script: [
            { name: "loan.disbursement.list", arguments: { loanPublicId: LOAN_A }, result: { summary: { approvedPrincipal: "2500.00", netDisbursed: "0.00", variance: "-2500.00", status: "under_disbursed" }, events: [] } },
            { name: "loan.disbursement.draft", arguments: disbursementDraftArgs, result: { publicId: DISBURSEMENT, status: "draft" } },
            { name: "loan.disbursement.evidence.prepare", arguments: { disbursementPublicId: DISBURSEMENT, mimeType: "image/jpeg", size: 4096, sha256: DISBURSEMENT_FILE_HASH, originalName: "payout-slip.jpg" }, result: { publicId: DISBURSEMENT_EVIDENCE, filePublicId: EVIDENCE, uploadUrl: "https://storage.example/upload", requiredHeaders: { "content-type": "image/jpeg" }, expiresAt: "2099-01-01T00:00:00+00:00" } },
            { name: "loan.disbursement.evidence.finalize", arguments: { disbursementPublicId: DISBURSEMENT, evidencePublicId: DISBURSEMENT_EVIDENCE }, result: { publicId: DISBURSEMENT_EVIDENCE, filePublicId: EVIDENCE, status: "ready" } },
            { name: "loan.disbursement.list", arguments: { loanPublicId: LOAN_A }, result: { summary: { approvedPrincipal: "2500.00", netDisbursed: "2500.00", variance: "0.00", status: "matched" }, events: [{ publicId: DISBURSEMENT, status: "draft" }] } },
            { name: "loan.disbursement.post", arguments: { disbursementPublicId: DISBURSEMENT, idempotencyKey: "disbursement-post-20260810-1" }, result: { publicId: DISBURSEMENT, status: "posted", duplicate: false } },
            { name: "loan.disbursement.list", arguments: { loanPublicId: LOAN_A }, result: { summary: { approvedPrincipal: "2500.00", netDisbursed: "2500.00", variance: "0.00", status: "matched" }, events: [{ publicId: DISBURSEMENT, status: "posted" }] } },
            { name: "loan.disbursement.reverse", arguments: { disbursementPublicId: DISBURSEMENT, reason: "Owner confirmed duplicate payout record", idempotencyKey: "disbursement-reverse-20260810-1" }, result: { publicId: DISBURSEMENT, status: "reversed", duplicate: false } },
        ],
        run: (mcp) => disbursementLifecycle(mcp, { postConfirmed: true, reverseConfirmed: true }),
    },
    "disbursement-draft-update": {
        script: [
            { name: "loan.disbursement.list", arguments: { loanPublicId: LOAN_A }, result: { summary: { approvedPrincipal: "4000.00", netDisbursed: "3940.00", variance: "-60.00", status: "under_disbursed" }, events: [{ publicId: DISBURSEMENT, status: "draft", grossAmount: "4000.00", loanAttributedAmount: "3940.00", evidenceFilePublicIds: [EVIDENCE] }] } },
            { name: "loan.disbursement.update", arguments: { disbursementPublicId: DISBURSEMENT, changes: { loanAttributedAmount: "4000.00", note: "Corrected attribution after owner review" } }, result: { publicId: DISBURSEMENT, status: "draft", grossAmount: "4000.00", loanAttributedAmount: "4000.00", evidenceFilePublicIds: [EVIDENCE] } },
            { name: "loan.disbursement.list", arguments: { loanPublicId: LOAN_A }, result: { summary: { approvedPrincipal: "4000.00", netDisbursed: "4000.00", variance: "0.00", status: "matched" }, events: [{ publicId: DISBURSEMENT, status: "draft", grossAmount: "4000.00", loanAttributedAmount: "4000.00", evidenceFilePublicIds: [EVIDENCE] }] } },
            { name: "loan.disbursement.post", arguments: { disbursementPublicId: DISBURSEMENT, idempotencyKey: "disbursement-post-after-update-1" }, result: { publicId: DISBURSEMENT, status: "posted", duplicate: false } },
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
            { name: "borrower.portfolio", arguments: { borrowerPublicId: BORROWER_A } },
            { name: "renewal.preview", arguments: { oldLoanPublicId: LOAN_A, requestedPrincipal: "2500.00" }, result: { publicId: RENEWAL, previewHash: PREVIEW_HASH, dueCharges: "0.00" } },
            { name: "renewal.execute", arguments: { renewalPublicId: RENEWAL, previewHash: PREVIEW_HASH, confirmed: true, reason: "Owner confirmed the displayed renewal", idempotencyKey: "renewal-execute-20260810-1" }, result: EXECUTED_RENEWAL_RESULT },
        ],
        run: (mcp) => renewalExecute(mcp),
    },
    "payment-reversal": {
        script: [
            { name: "intake.get", arguments: { paymentIntakePublicId: INTAKE }, result: { status: "posted" } },
            { name: "payment.reverse", arguments: { paymentIntakePublicId: INTAKE, reason: "Owner confirmed duplicate bank posting" } },
        ],
        run: async (mcp) => { await mcp.call("intake.get", { paymentIntakePublicId: INTAKE }); await mcp.call("payment.reverse", { paymentIntakePublicId: INTAKE, reason: "Owner confirmed duplicate bank posting" }); return { outcome: "completed" }; },
    },
    "renewal-reversal": {
        script: [
            { name: "borrower.portfolio", arguments: { borrowerPublicId: SAME_TASK_RENEWAL_CONTEXT.retainedBorrowerPublicId }, result: RENEWAL_PORTFOLIO },
            { name: "renewal.reverse", arguments: { renewalPublicId: SAME_TASK_RENEWAL_CONTEXT.executeResult.publicId, reason: "Owner confirmed renewal reversal; backend must atomically check downstream activity", idempotencyKey: "renewal-reverse-20260810-1" } },
        ],
        run: (mcp) => reverseRenewal(mcp, SAME_TASK_RENEWAL_CONTEXT),
    },
    "ambiguous-nickname": {
        script: [
            { name: "borrower.search", arguments: { query: "พี่พล" }, result: { resolution: "ambiguous", candidates: [{ publicId: BORROWER_A }, { publicId: BORROWER_B }] } },
            { name: "borrower.portfolio", arguments: { borrowerPublicId: BORROWER_A } },
            { name: "borrower.portfolio", arguments: { borrowerPublicId: BORROWER_B } },
        ],
        run: async (mcp) => { const found = await mcp.call("borrower.search", { query: "พี่พล" }); for (const candidate of found.candidates as Array<{ publicId: string }>) await mcp.call("borrower.portfolio", { borrowerPublicId: candidate.publicId }); return { outcome: "stopped", stopReason: "ambiguous-identity" }; },
    },
    "allocation-mismatch": {
        script: [{ name: "payment.preview", arguments: { paymentIntakePublicId: INTAKE, allocations: mismatchAllocations }, result: { status: "needs_review", difference: "10.00" } }],
        run: async (mcp) => { const preview = await mcp.call("payment.preview", { paymentIntakePublicId: INTAKE, allocations: mismatchAllocations }); return { outcome: "stopped", stopReason: String(preview.status) }; },
    },
    "duplicate-reference": {
        script: [
            { name: "intake.create", arguments: intakeArgs, result: { publicId: ORIGINAL_INTAKE, duplicate: true } },
            { name: "intake.get", arguments: { paymentIntakePublicId: ORIGINAL_INTAKE } },
        ],
        run: (mcp) => paymentFlow(mcp, {}),
    },
    "duplicate-evidence-hash": {
        script: [
            { name: "intake.create", arguments: intakeArgs, result: { publicId: INTAKE, duplicate: false } },
            { name: "evidence.prepare", arguments: { paymentIntakePublicId: INTAKE, mimeType: "image/jpeg", size: 2048, sha256: FILE_HASH, evidenceType: "slip" }, result: { publicId: EVIDENCE, duplicate: true, intakePublicId: ORIGINAL_INTAKE } },
            { name: "intake.get", arguments: { paymentIntakePublicId: ORIGINAL_INTAKE } },
        ],
        run: (mcp) => paymentFlow(mcp, { evidence: true }),
    },
    "active-loan-edit": {
        script: [{ name: "borrower.portfolio", arguments: { borrowerPublicId: BORROWER_A }, result: { loans: [{ publicId: LOAN_A, status: "active" }] } }],
        run: async (mcp) => { await mcp.call("borrower.portfolio", { borrowerPublicId: BORROWER_A }); return { outcome: "stopped", stopReason: "immutable-active-terms" }; },
    },
    "disbursement-variance-without-confirmation": {
        script: [
            { name: "loan.disbursement.list", arguments: { loanPublicId: LOAN_A }, result: { summary: { approvedPrincipal: "2500.00", netDisbursed: "0.00", variance: "-2500.00", status: "under_disbursed" }, events: [] } },
            { name: "loan.disbursement.draft", arguments: disbursementDraftArgs, result: { publicId: DISBURSEMENT, status: "draft" } },
            { name: "loan.disbursement.evidence.prepare", arguments: { disbursementPublicId: DISBURSEMENT, mimeType: "image/jpeg", size: 4096, sha256: DISBURSEMENT_FILE_HASH, originalName: "payout-slip.jpg" }, result: { publicId: DISBURSEMENT_EVIDENCE, filePublicId: EVIDENCE, uploadUrl: "https://storage.example/upload", requiredHeaders: { "content-type": "image/jpeg" }, expiresAt: "2099-01-01T00:00:00+00:00" } },
            { name: "loan.disbursement.evidence.finalize", arguments: { disbursementPublicId: DISBURSEMENT, evidencePublicId: DISBURSEMENT_EVIDENCE }, result: { publicId: DISBURSEMENT_EVIDENCE, filePublicId: EVIDENCE, status: "ready" } },
            { name: "loan.disbursement.list", arguments: { loanPublicId: LOAN_A }, result: { summary: { approvedPrincipal: "2500.00", netDisbursed: "2300.00", variance: "-200.00", status: "under_disbursed" }, events: [{ publicId: DISBURSEMENT, status: "draft" }] } },
        ],
        run: (mcp) => disbursementLifecycle(mcp),
    },
    "disbursement-missing-post-confirmation": {
        script: [
            { name: "loan.disbursement.list", arguments: { loanPublicId: LOAN_A }, result: { summary: { approvedPrincipal: "2500.00", netDisbursed: "0.00", variance: "-2500.00", status: "under_disbursed" }, events: [] } },
            { name: "loan.disbursement.draft", arguments: disbursementDraftArgs, result: { publicId: DISBURSEMENT, status: "draft" } },
            { name: "loan.disbursement.evidence.prepare", arguments: { disbursementPublicId: DISBURSEMENT, mimeType: "image/jpeg", size: 4096, sha256: DISBURSEMENT_FILE_HASH, originalName: "payout-slip.jpg" }, result: { publicId: DISBURSEMENT_EVIDENCE, filePublicId: EVIDENCE, uploadUrl: "https://storage.example/upload", requiredHeaders: { "content-type": "image/jpeg" }, expiresAt: "2099-01-01T00:00:00+00:00" } },
            { name: "loan.disbursement.evidence.finalize", arguments: { disbursementPublicId: DISBURSEMENT, evidencePublicId: DISBURSEMENT_EVIDENCE }, result: { publicId: DISBURSEMENT_EVIDENCE, filePublicId: EVIDENCE, status: "ready" } },
            { name: "loan.disbursement.list", arguments: { loanPublicId: LOAN_A }, result: { summary: { approvedPrincipal: "2500.00", netDisbursed: "2500.00", variance: "0.00", status: "matched" }, events: [{ publicId: DISBURSEMENT, status: "draft" }] } },
        ],
        run: (mcp) => disbursementLifecycle(mcp),
    },
    "disbursement-evidence-ready-retry": {
        script: [
            { name: "loan.disbursement.list", arguments: { loanPublicId: LOAN_A }, result: { summary: { approvedPrincipal: "2500.00", netDisbursed: "0.00", variance: "-2500.00", status: "under_disbursed" }, events: [] } },
            { name: "loan.disbursement.draft", arguments: disbursementDraftArgs, result: { publicId: DISBURSEMENT, status: "draft" } },
            { name: "loan.disbursement.evidence.prepare", arguments: { disbursementPublicId: DISBURSEMENT, mimeType: "image/jpeg", size: 4096, sha256: DISBURSEMENT_FILE_HASH, originalName: "payout-slip.jpg" }, result: { publicId: DISBURSEMENT_EVIDENCE, filePublicId: EVIDENCE, status: "ready" } },
            { name: "loan.disbursement.list", arguments: { loanPublicId: LOAN_A }, result: { summary: { approvedPrincipal: "2500.00", netDisbursed: "2500.00", variance: "0.00", status: "matched" }, events: [{ publicId: DISBURSEMENT, status: "draft" }] } },
            { name: "loan.disbursement.post", arguments: { disbursementPublicId: DISBURSEMENT, idempotencyKey: "disbursement-post-20260810-1" }, result: { publicId: DISBURSEMENT, status: "posted", duplicate: false } },
        ],
        run: (mcp) => disbursementLifecycle(mcp, { postConfirmed: true }),
    },
    "disbursement-evidence-expired-upload": {
        script: [
            { name: "loan.disbursement.list", arguments: { loanPublicId: LOAN_A }, result: { summary: { approvedPrincipal: "2500.00", netDisbursed: "0.00", variance: "-2500.00", status: "under_disbursed" }, events: [] } },
            { name: "loan.disbursement.draft", arguments: disbursementDraftArgs, result: { publicId: DISBURSEMENT, status: "draft" } },
            { name: "loan.disbursement.evidence.prepare", arguments: { disbursementPublicId: DISBURSEMENT, mimeType: "image/jpeg", size: 4096, sha256: DISBURSEMENT_FILE_HASH, originalName: "payout-slip.jpg" }, result: { publicId: DISBURSEMENT_EVIDENCE, filePublicId: EVIDENCE, uploadUrl: "https://storage.example/upload", requiredHeaders: { "content-type": "image/jpeg" }, expiresAt: "2000-01-01T00:00:00+00:00" } },
        ],
        run: (mcp) => disbursementLifecycle(mcp, { postConfirmed: true }),
    },
    "disbursement-evidence-finalize-mismatch": {
        script: [
            { name: "loan.disbursement.list", arguments: { loanPublicId: LOAN_A }, result: { summary: { approvedPrincipal: "2500.00", netDisbursed: "0.00", variance: "-2500.00", status: "under_disbursed" }, events: [] } },
            { name: "loan.disbursement.draft", arguments: disbursementDraftArgs, result: { publicId: DISBURSEMENT, status: "draft" } },
            { name: "loan.disbursement.evidence.prepare", arguments: { disbursementPublicId: DISBURSEMENT, mimeType: "image/jpeg", size: 4096, sha256: DISBURSEMENT_FILE_HASH, originalName: "payout-slip.jpg" }, result: { publicId: DISBURSEMENT_EVIDENCE, filePublicId: EVIDENCE, uploadUrl: "https://storage.example/upload", requiredHeaders: { "content-type": "image/jpeg" }, expiresAt: "2099-01-01T00:00:00+00:00" } },
            { name: "loan.disbursement.evidence.finalize", arguments: { disbursementPublicId: DISBURSEMENT, evidencePublicId: DISBURSEMENT_EVIDENCE }, error: { code: "EVIDENCE_MISMATCH", message: "Evidence checksum or metadata does not match" } },
        ],
        run: (mcp) => disbursementLifecycle(mcp, { postConfirmed: true }),
    },
    "disbursement-evidence-checksum-conflict": {
        script: [
            { name: "loan.disbursement.list", arguments: { loanPublicId: LOAN_A }, result: { summary: { approvedPrincipal: "2500.00", netDisbursed: "0.00", variance: "-2500.00", status: "under_disbursed" }, events: [] } },
            { name: "loan.disbursement.draft", arguments: disbursementDraftArgs, result: { publicId: DISBURSEMENT, status: "draft" } },
            { name: "loan.disbursement.evidence.prepare", arguments: { disbursementPublicId: DISBURSEMENT, mimeType: "image/jpeg", size: 4096, sha256: DISBURSEMENT_FILE_HASH, originalName: "payout-slip.jpg" }, error: { code: "EVIDENCE_HASH_CONFLICT", message: "Evidence checksum belongs to another disbursement" } },
        ],
        run: (mcp) => disbursementLifecycle(mcp, { postConfirmed: true }),
    },
    "disbursement-reversal-event-not-posted": {
        script: [
            { name: "loan.disbursement.list", arguments: { loanPublicId: LOAN_A }, result: { summary: { approvedPrincipal: "2500.00", netDisbursed: "0.00", variance: "-2500.00", status: "under_disbursed" }, events: [] } },
            { name: "loan.disbursement.draft", arguments: disbursementDraftArgs, result: { publicId: DISBURSEMENT, status: "draft" } },
            { name: "loan.disbursement.evidence.prepare", arguments: { disbursementPublicId: DISBURSEMENT, mimeType: "image/jpeg", size: 4096, sha256: DISBURSEMENT_FILE_HASH, originalName: "payout-slip.jpg" }, result: { publicId: DISBURSEMENT_EVIDENCE, filePublicId: EVIDENCE, status: "ready" } },
            { name: "loan.disbursement.list", arguments: { loanPublicId: LOAN_A }, result: { summary: { approvedPrincipal: "2500.00", netDisbursed: "2500.00", variance: "0.00", status: "matched" }, events: [{ publicId: DISBURSEMENT, status: "draft" }] } },
            { name: "loan.disbursement.post", arguments: { disbursementPublicId: DISBURSEMENT, idempotencyKey: "disbursement-post-20260810-1" }, result: { publicId: DISBURSEMENT, status: "posted", duplicate: false } },
            { name: "loan.disbursement.list", arguments: { loanPublicId: LOAN_A }, result: { summary: { approvedPrincipal: "2500.00", netDisbursed: "2500.00", variance: "0.00", status: "matched" }, events: [{ publicId: DISBURSEMENT, status: "draft" }] } },
        ],
        run: (mcp) => disbursementLifecycle(mcp, { postConfirmed: true, reverseConfirmed: true }),
    },
    "disbursement-idempotency-conflict": {
        script: [
            { name: "loan.disbursement.draft", arguments: disbursementDraftArgs, result: { publicId: DISBURSEMENT, status: "draft" } },
            { name: "loan.disbursement.post", arguments: { disbursementPublicId: DISBURSEMENT, idempotencyKey: "disbursement-post-20260810-1" }, error: { code: "IDEMPOTENCY_KEY_CONFLICT", message: "Idempotency-Key was already used for another disbursement post" } },
        ],
        run: disbursementIdempotencyConflict,
    },
    "disbursement-schedule-mutation": {
        script: [{ name: "loan.disbursement.list", arguments: { loanPublicId: LOAN_A }, result: { summary: { approvedPrincipal: "2500.00", netDisbursed: "2500.00", variance: "0.00", status: "matched" }, events: [] } }],
        run: async (mcp) => { await mcp.call("loan.disbursement.list", { loanPublicId: LOAN_A }); return { outcome: "stopped", stopReason: "disbursement-cannot-mutate-schedule" }; },
    },
    "disbursement-update-locked": {
        script: [{ name: "loan.disbursement.list", arguments: { loanPublicId: LOAN_A }, result: { events: [{ publicId: DISBURSEMENT, status: "posted" }] } }],
        run: async (mcp) => { await mcp.call("loan.disbursement.list", { loanPublicId: LOAN_A }); return { outcome: "stopped", stopReason: "disbursement-locked" } as const; },
    },
    "disbursement-update-unsupported-fields": {
        script: [{ name: "loan.disbursement.list", arguments: { loanPublicId: LOAN_A }, result: { events: [{ publicId: DISBURSEMENT, status: "draft" }] } }],
        run: async (mcp) => { await mcp.call("loan.disbursement.list", { loanPublicId: LOAN_A }); return { outcome: "stopped", stopReason: "disbursement-update-unsupported-fields" } as const; },
    },
    "renewal-unsettled-charges": {
        script: [
            { name: "borrower.portfolio", arguments: { borrowerPublicId: BORROWER_A } },
            { name: "renewal.preview", arguments: { oldLoanPublicId: LOAN_A, requestedPrincipal: "2500.00" }, result: { publicId: RENEWAL, previewHash: PREVIEW_HASH, dueCharges: "23.00" } },
        ],
        run: (mcp) => renewalExecute(mcp),
    },
    "renewal-missing-confirmation": {
        script: [
            { name: "borrower.portfolio", arguments: { borrowerPublicId: BORROWER_A } },
            { name: "renewal.preview", arguments: { oldLoanPublicId: LOAN_A, requestedPrincipal: "2500.00" }, result: { publicId: RENEWAL, previewHash: PREVIEW_HASH, dueCharges: "0.00" } },
        ],
        run: (mcp) => renewalExecute(mcp, false),
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
                result: { publicId: INTERMEDIATED_GROUP, status: "posted", duplicate: false },
            },
        ],
        run: (mcp) => intermediatedDisbursementFlow(mcp),
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
            intermediatedDetailStep(true),
        ],
        run: (mcp) => intermediatedDisbursementFlow(mcp),
    },
    "intermediated-disbursement-unexplained-retained-balance": {
        script: [
            ...intermediatedIdentityScript(),
            intermediatedGroupCreateStep("100.00"),
        ],
        run: (mcp) => intermediatedDisbursementFlow(mcp),
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
                },
            },
            intermediatedDetailStep(),
            intermediatedPreviewStep("0198c481-3e2b-7000-8000-000000000092"),
        ],
        run: (mcp) => intermediatedDisbursementFlow(mcp),
    },
    "intermediated-disbursement-missing-confirmation": {
        script: fullIntermediatedDraftScript(),
        run: (mcp) => intermediatedDisbursementFlow(mcp, { confirmed: false }),
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
};

export const EVAL_SCENARIO_IDS = Object.freeze(Object.keys(SCENARIOS));

export async function runEvalScenario(id: string): Promise<HarnessResult> {
    const scenario = SCENARIOS[id];
    if (!scenario) throw new Error(`unknown eval scenario ${id}`);
    const mcp = new ScriptedMcp(scenario.script, scenario.authorized);
    const result = await scenario.run(mcp);
    mcp.assertComplete();
    return { calls: mcp.calls, effects: mcp.effects, events: mcp.events, ...result };
}
