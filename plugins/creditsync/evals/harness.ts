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
const FILE_HASH = "b".repeat(64);
const DISBURSEMENT_FILE_HASH = "c".repeat(64);

export type ToolCall = { name: McpToolName; arguments: Record<string, unknown> };
type ScriptedError = { code: string; message: string; details?: Record<string, unknown> };
type ScriptStep = ToolCall & { result?: Record<string, unknown>; error?: ScriptedError };

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
    private cursor = 0;

    constructor(private readonly script: ScriptStep[], private readonly authorized = true) {}

    ensureAuthorized() {
        if (!this.authorized) throw new Error("UNAUTHORIZED");
    }

    effect(name: string) {
        this.effects.push(name);
    }

    async call(name: McpToolName, args: Record<string, unknown>) {
        const step = this.script[this.cursor++];
        if (!step) throw new Error(`unexpected MCP call ${name}`);
        if (step.name !== name || !isDeepStrictEqual(step.arguments, args)) {
            throw new Error(`MCP call mismatch at ${this.cursor}: expected ${step.name} ${JSON.stringify(step.arguments)}, received ${name} ${JSON.stringify(args)}`);
        }
        this.calls.push({ name, arguments: args });
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
    await mcp.call("loan.activate", { loanPublicId: draft.publicId });
    return { outcome: "completed" } as const;
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
    const prepared = await mcp.call("loan.disbursement.evidence.prepare", {
        disbursementPublicId: draft.publicId as string,
        mimeType: "image/jpeg",
        size: 4096,
        sha256: DISBURSEMENT_FILE_HASH,
        originalName: "payout-slip.jpg",
    });
    mcp.effect("disbursement-evidence.put");
    await mcp.call("loan.disbursement.evidence.finalize", {
        disbursementPublicId: draft.publicId as string,
        evidencePublicId: prepared.publicId as string,
    });
    const current = await mcp.call("loan.disbursement.list", { loanPublicId: LOAN_A });
    if ((current.summary as { status: string }).status !== "matched") return { outcome: "stopped", stopReason: "variance-review-required" } as const;
    if (!options.postConfirmed) return { outcome: "stopped", stopReason: "disbursement-post-confirmation-required" } as const;
    await mcp.call("loan.disbursement.post", {
        disbursementPublicId: draft.publicId as string,
        idempotencyKey: "disbursement-post-20260810-1",
    });
    if (!options.reverseConfirmed) return { outcome: "completed" } as const;
    await mcp.call("loan.disbursement.reverse", {
        disbursementPublicId: draft.publicId as string,
        reason: "Owner confirmed duplicate payout record",
        idempotencyKey: "disbursement-reverse-20260810-1",
    });
    return { outcome: "completed" } as const;
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
            { name: "loan.activate", arguments: { loanPublicId: DRAFT } },
        ],
        run: loanActivation,
    },
    "disbursement-full-lifecycle": {
        script: [
            { name: "loan.disbursement.list", arguments: { loanPublicId: LOAN_A }, result: { summary: { approvedPrincipal: "2500.00", netDisbursed: "0.00", variance: "-2500.00", status: "under_disbursed" }, events: [] } },
            { name: "loan.disbursement.draft", arguments: disbursementDraftArgs, result: { publicId: DISBURSEMENT, status: "draft" } },
            { name: "loan.disbursement.evidence.prepare", arguments: { disbursementPublicId: DISBURSEMENT, mimeType: "image/jpeg", size: 4096, sha256: DISBURSEMENT_FILE_HASH, originalName: "payout-slip.jpg" }, result: { publicId: DISBURSEMENT_EVIDENCE, filePublicId: EVIDENCE } },
            { name: "loan.disbursement.evidence.finalize", arguments: { disbursementPublicId: DISBURSEMENT, evidencePublicId: DISBURSEMENT_EVIDENCE }, result: { publicId: DISBURSEMENT_EVIDENCE, filePublicId: EVIDENCE, status: "ready" } },
            { name: "loan.disbursement.list", arguments: { loanPublicId: LOAN_A }, result: { summary: { approvedPrincipal: "2500.00", netDisbursed: "2500.00", variance: "0.00", status: "matched" }, events: [{ publicId: DISBURSEMENT, status: "draft" }] } },
            { name: "loan.disbursement.post", arguments: { disbursementPublicId: DISBURSEMENT, idempotencyKey: "disbursement-post-20260810-1" }, result: { publicId: DISBURSEMENT, status: "posted", duplicate: false } },
            { name: "loan.disbursement.reverse", arguments: { disbursementPublicId: DISBURSEMENT, reason: "Owner confirmed duplicate payout record", idempotencyKey: "disbursement-reverse-20260810-1" }, result: { publicId: DISBURSEMENT, status: "reversed", duplicate: false } },
        ],
        run: (mcp) => disbursementLifecycle(mcp, { postConfirmed: true, reverseConfirmed: true }),
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
            { name: "loan.disbursement.evidence.prepare", arguments: { disbursementPublicId: DISBURSEMENT, mimeType: "image/jpeg", size: 4096, sha256: DISBURSEMENT_FILE_HASH, originalName: "payout-slip.jpg" }, result: { publicId: DISBURSEMENT_EVIDENCE, filePublicId: EVIDENCE } },
            { name: "loan.disbursement.evidence.finalize", arguments: { disbursementPublicId: DISBURSEMENT, evidencePublicId: DISBURSEMENT_EVIDENCE }, result: { publicId: DISBURSEMENT_EVIDENCE, filePublicId: EVIDENCE, status: "ready" } },
            { name: "loan.disbursement.list", arguments: { loanPublicId: LOAN_A }, result: { summary: { approvedPrincipal: "2500.00", netDisbursed: "2300.00", variance: "-200.00", status: "under_disbursed" }, events: [{ publicId: DISBURSEMENT, status: "draft" }] } },
        ],
        run: (mcp) => disbursementLifecycle(mcp),
    },
    "disbursement-missing-post-confirmation": {
        script: [
            { name: "loan.disbursement.list", arguments: { loanPublicId: LOAN_A }, result: { summary: { approvedPrincipal: "2500.00", netDisbursed: "0.00", variance: "-2500.00", status: "under_disbursed" }, events: [] } },
            { name: "loan.disbursement.draft", arguments: disbursementDraftArgs, result: { publicId: DISBURSEMENT, status: "draft" } },
            { name: "loan.disbursement.evidence.prepare", arguments: { disbursementPublicId: DISBURSEMENT, mimeType: "image/jpeg", size: 4096, sha256: DISBURSEMENT_FILE_HASH, originalName: "payout-slip.jpg" }, result: { publicId: DISBURSEMENT_EVIDENCE, filePublicId: EVIDENCE } },
            { name: "loan.disbursement.evidence.finalize", arguments: { disbursementPublicId: DISBURSEMENT, evidencePublicId: DISBURSEMENT_EVIDENCE }, result: { publicId: DISBURSEMENT_EVIDENCE, filePublicId: EVIDENCE, status: "ready" } },
            { name: "loan.disbursement.list", arguments: { loanPublicId: LOAN_A }, result: { summary: { approvedPrincipal: "2500.00", netDisbursed: "2500.00", variance: "0.00", status: "matched" }, events: [{ publicId: DISBURSEMENT, status: "draft" }] } },
        ],
        run: (mcp) => disbursementLifecycle(mcp),
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
    return { calls: mcp.calls, effects: mcp.effects, ...result };
}
