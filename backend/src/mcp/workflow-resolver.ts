import { MCP_TOOL_NAMES, type ToolProfile } from "./catalog-types";
import { toolIsVisibleInProfile, workflowRule, WORKFLOW_POLICY_REVISION, WORKFLOW_VERSION, WORKFLOW_TOOL_INVENTORY, type WorkflowIntent } from "./workflow-registry";
import type { PaymentWorkflowBlocker } from "../services/payment-workflow-blockers";

const publicIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export type WorkflowTargetKind = "borrower" | "loan" | "payment_intake" | "loan_disbursement";

export type ResolverInput = Readonly<{
    intent: WorkflowIntent;
    profile: ToolProfile;
    target?: Readonly<{ kind: WorkflowTargetKind; publicId: string }>;
    attachments?: "none" | "present" | "unknown";
    expectedAttachmentCount?: number;
    knownWorkflowVersion?: string;
    knownCatalogVersion?: string;
    toolName?: string;
}>;

export type ResolverObservation = Readonly<{
    targetAvailable?: boolean;
    identityResolved?: boolean;
    state?: "unresolved" | "mutable" | "posted" | "cancelled" | "duplicate" | "reversed";
    loanType?: "scheduled" | "floating";
    evidenceRequired?: boolean;
    evidenceReady?: boolean;
    pendingEvidenceCount?: number;
    rejectedEvidenceCount?: number;
    supportedAttachmentTransport?: boolean;
    /** The bounded backend read saw more evidence rows than it can safely summarize. */
    evidenceOverflow?: boolean;
    restoreCancellationAllowed?: boolean;
    restoreCancellationBlockedReason?: string | null;
    restoreCancellationStateHash?: string | null;
    duplicateReviewRequired?: boolean;
    duplicateBlockerPublicIds?: readonly string[];
    identityDecisionRequired?: boolean;
    paymentBlockers?: readonly PaymentWorkflowBlocker[];
}>;

export type ResolverStep = Readonly<{
    toolName: string;
    arguments: Readonly<Record<string, string>>;
    requiredInputs: readonly string[];
    requiresConfirmation: boolean;
}>;

export type ResolverResult = Readonly<{
    workflowId: string;
    workflowVersion: string;
    catalogVersion: string;
    policyRevision: string;
    observed: Readonly<{ state: ResolverObservation["state"] | null; loanType: ResolverObservation["loanType"] | null; evidenceReady: boolean; restoreCancellationAllowed: boolean | null; restoreCancellationBlockedReason: string | null; restoreCancellationStateHash: string | null; paymentBlockers: readonly PaymentWorkflowBlocker[] }>;
    status: "needs_input" | "next_step" | "confirmation_required" | "blocked" | "refresh_required" | "connection_required";
    nextSteps: readonly ResolverStep[];
    blockers: readonly string[];
    prohibitedTools: readonly string[];
    reevaluateOn: "target_change" | "evidence_change" | "preview_expiry" | "version_change";
}>;

export type ResolverProfile = Readonly<{ profile: ToolProfile; catalogVersion: string; workflowVersion?: string }>;
type TargetArgumentKind = WorkflowTargetKind | "loan_for_disbursement";

const targetArguments: Readonly<Record<string, TargetArgumentKind>> = Object.freeze({
    "borrower.resolve-and-portfolio": "borrower", "loan.inspect-context": "loan", "payment.match-context": "payment_intake", "intake.get": "payment_intake",
    "payment.preview": "payment_intake", "payment.post": "payment_intake", "payment.replacement.inspect": "payment_intake", "payment.replacement.create": "payment_intake", "payment.replacement.duplicate-review.preview": "payment_intake", "payment.evidence-recovery.preview": "payment_intake", "payment.evidence-recovery.execute": "payment_intake", "evidence.prepare": "payment_intake", "evidence.finalize": "payment_intake", "evidence.import-chatgpt-file": "payment_intake",
    "payment.evidence-supplement.import-chatgpt-file": "payment_intake", "payment.evidence-supplement.record": "payment_intake", "loan.disbursement.list": "loan_for_disbursement",
    "loan.disbursement.draft": "loan", "loan.disbursement.evidence.prepare": "loan_disbursement", "loan.disbursement.evidence.finalize": "loan_disbursement", "loan.disbursement.evidence.import-chatgpt-file": "loan_disbursement",
    "loan.disbursement.post": "loan_disbursement", "loan.settlement.preview": "loan", "loan.activate": "loan", "loan.draft": "borrower", "renewal.preview": "loan", "payment.restore.cancel": "payment_intake",
});

const requiredInputs: Readonly<Record<string, readonly string[]>> = Object.freeze({
    "evidence.prepare": ["mimeType", "size", "sha256"], "evidence.finalize": ["evidencePublicId"], "evidence.import-chatgpt-file": ["idempotencyKey", "chatgptFile"],
    "payment.evidence-supplement.import-chatgpt-file": ["idempotencyKey", "chatgptFile"], "payment.evidence-supplement.record": ["supplementPublicId", "confirmed", "reason", "idempotencyKey"],
    "loan.disbursement.evidence.prepare": ["mimeType", "size", "sha256"], "loan.disbursement.evidence.finalize": ["evidencePublicId"], "loan.disbursement.evidence.import-chatgpt-file": ["idempotencyKey", "chatgptFile"],
    "loan.disbursement.draft": ["grossAmount", "loanAttributedAmount", "channel", "disbursedAt"], "loan.disbursement.post": ["idempotencyKey"],
    "loan.preview": ["principal", "interestRate", "termMonths", "repaymentType", "startDate"],
    "loan.draft": ["borrowerPublicId", "principal", "interestRate", "termMonths", "repaymentType", "startDate"], "loan.activate": ["idempotencyKey"], "loan.settlement.preview": ["asOfDate"], "renewal.preview": ["oldLoanPublicId", "requestedPrincipal"],
    "borrower.resolve-and-portfolio": ["query", "borrowerPublicId"], "loan.inspect-context": ["loanPublicId"], "payment.match-context": ["paymentIntakePublicId"], "intake.get": ["paymentIntakePublicId"], "payment.replacement.inspect": ["paymentIntakePublicId"], "payment.replacement.create": ["paymentIntakePublicId", "reason", "idempotencyKey", "expectedStateHash"], "payment.replacement.duplicate-review.preview": ["canonicalPaymentIntakePublicId", "candidatePaymentIntakePublicIds", "reason", "idempotencyKey"], "payment.evidence-recovery.preview": ["sourcePaymentIntakePublicId", "reason", "expectedCount", "reuseEvidence", "idempotencyKey"], "loan.disbursement.list": ["loanPublicId"],
    "payment.restore.cancel": ["expectedStateHash", "reason", "idempotencyKey"],
});

const targetArgumentFields: Readonly<Record<string, string>> = Object.freeze({
    "renewal.preview": "oldLoanPublicId",
    "payment.restore.cancel": "restoreDraftPublicId",
    "payment.replacement.duplicate-review.preview": "canonicalPaymentIntakePublicId", "payment.evidence-recovery.preview": "sourcePaymentIntakePublicId",
});

function step(toolName: string, input: ResolverInput, inputs: readonly string[] = requiredInputs[toolName] ?? [], requiresConfirmation = false): ResolverStep | null {
    if (!MCP_TOOL_NAMES.includes(toolName as never) || !toolIsVisibleInProfile(toolName, input.profile)) return null;
    const arguments_: Record<string, string> = {};
    const targetKind = targetArguments[toolName];
    if (targetKind) {
        if (!input.target) return null;
        if (targetKind === "loan_for_disbursement") {
            if (input.target.kind !== "loan") return null;
            arguments_.loanPublicId = input.target.publicId;
        } else if (input.target.kind !== targetKind) return null;
        else arguments_[targetArgumentFields[toolName] ?? `${targetKind === "payment_intake" ? "paymentIntake" : targetKind === "loan_disbursement" ? "disbursement" : targetKind}PublicId`] = input.target.publicId;
    }
    return { toolName, arguments: arguments_, requiredInputs: inputs, requiresConfirmation };
}

function identityDecisionStep(input: ResolverInput, participantPublicIds: readonly string[]) {
    if (!input.target || !MCP_TOOL_NAMES.includes("payment.identity-decision.preview" as never) || !toolIsVisibleInProfile("payment.identity-decision.preview", input.profile)) return null;
    return { toolName: "payment.identity-decision.preview", arguments: { participantPaymentIntakePublicIds: [input.target.publicId, ...participantPublicIds].join(",") }, requiredInputs: ["participantPaymentIntakePublicIds", "decision", "reason", "idempotencyKey"], requiresConfirmation: false } satisfies ResolverStep;
}

function result(input: ResolverInput, profile: ResolverProfile, status: ResolverResult["status"], nextSteps: readonly (ResolverStep | null)[], blockers: readonly string[] = [], prohibitedTools: readonly string[] = []): ResolverResult {
    return {
        workflowId: `creditsync.${input.intent}`, workflowVersion: WORKFLOW_VERSION, catalogVersion: profile.catalogVersion, policyRevision: WORKFLOW_POLICY_REVISION,
        observed: { state: null, loanType: null, evidenceReady: false, restoreCancellationAllowed: null, restoreCancellationBlockedReason: null, restoreCancellationStateHash: null, paymentBlockers: [] }, status, nextSteps: nextSteps.filter((value): value is ResolverStep => value !== null).slice(0, 3), blockers: blockers.slice(0, 8), prohibitedTools: prohibitedTools.slice(0, 8),
        reevaluateOn: input.intent === "tool_help" ? "version_change" : input.attachments && input.attachments !== "none" ? "evidence_change" : "target_change",
    };
}

function withObservation(value: ResolverResult, observation: ResolverObservation): ResolverResult {
    return { ...value, observed: { state: observation.state ?? null, loanType: observation.loanType ?? null, evidenceReady: observation.evidenceReady === true, restoreCancellationAllowed: observation.restoreCancellationAllowed ?? null, restoreCancellationBlockedReason: observation.restoreCancellationBlockedReason ?? null, restoreCancellationStateHash: observation.restoreCancellationStateHash ?? null, paymentBlockers: observation.paymentBlockers ?? [] } };
}

function validTarget(input: ResolverInput) {
    return !!input.target && publicIdPattern.test(input.target.publicId) && ["borrower", "loan", "payment_intake", "loan_disbursement"].includes(input.target.kind);
}

function expectedTarget(intent: WorkflowIntent): WorkflowTargetKind | null {
    if (intent === "receive_payment" || intent === "cancel_payment_restore") return "payment_intake";
    if (["close_loan", "renew_loan"].includes(intent)) return "loan";
    return null;
}

function attachmentStep(input: ResolverInput): ResolverStep | null {
    if (input.intent === "receive_payment" && input.target?.kind === "payment_intake") return step("evidence.import-chatgpt-file", input);
    if (input.intent === "disburse_loan" && input.target?.kind === "loan_disbursement") return step("loan.disbursement.evidence.import-chatgpt-file", input);
    if (input.intent === "attach_evidence" && input.target?.kind === "payment_intake") return step("evidence.prepare", input);
    if (input.intent === "attach_evidence" && input.target?.kind === "loan_disbursement") return step("loan.disbursement.evidence.prepare", input);
    return null;
}

export function resolveWorkflowPolicy(input: ResolverInput, observation: ResolverObservation, profile: ResolverProfile): ResolverResult {
    const base = () => withObservation(result(input, profile, "needs_input", [], []), observation);
    const currentWorkflowVersion = profile.workflowVersion ?? WORKFLOW_VERSION;
    if (input.knownWorkflowVersion && input.knownWorkflowVersion !== currentWorkflowVersion) return withObservation(result(input, profile, "refresh_required", [], ["WORKFLOW_VERSION_STALE"]), observation);
    if (input.knownCatalogVersion && input.knownCatalogVersion !== profile.catalogVersion) return withObservation(result(input, profile, "refresh_required", [], ["CATALOG_VERSION_STALE"]), observation);
    if (input.profile !== profile.profile) return withObservation(result(input, profile, "connection_required", [], ["PROFILE_CONTEXT_MISMATCH"]), observation);
    if (input.intent === "tool_help") {
        if (!input.toolName || !MCP_TOOL_NAMES.includes(input.toolName as never)) return withObservation(result(input, profile, "needs_input", [], ["TOOL_NAME_REQUIRED"]), observation);
        if (!toolIsVisibleInProfile(input.toolName, profile.profile)) return withObservation(result(input, profile, "connection_required", [], ["TOOL_NOT_VISIBLE_ON_PROFILE"]), observation);
        const inventory = WORKFLOW_TOOL_INVENTORY[input.toolName as keyof typeof WORKFLOW_TOOL_INVENTORY];
        if (!inventory || inventory.workflow !== "inspect") return withObservation(result(input, profile, "needs_input", [], ["TOOL_HELP_REQUIRES_WORKFLOW_RESOLUTION"], [input.toolName]), observation);
        const targetRequired = targetArguments[input.toolName] !== undefined;
        if (targetRequired && (observation.targetAvailable !== true || observation.identityResolved !== true || (observation.state !== "mutable" && observation.state !== "posted"))) {
            return withObservation(result(input, profile, "needs_input", [], ["TARGET_REQUIRES_AUTHORITATIVE_READ"]), observation);
        }
        const helpInputs = input.toolName === "borrower.resolve-and-portfolio" && input.target?.kind === "borrower"
            ? []
            : requiredInputs[input.toolName] ?? [];
        const helpStep = step(input.toolName, input, helpInputs);
        return withObservation(result(input, profile, helpStep ? "next_step" : "needs_input", [helpStep], helpStep ? [] : ["EXACT_TARGET_REQUIRED"]), observation);
    }
    const rule = workflowRule(input.intent);
    if (!rule.profiles.includes(profile.profile)) return withObservation(result(input, profile, "connection_required", [], ["WORKFLOW_REQUIRES_ANOTHER_CONNECTION"]), observation);
    if (!validTarget(input)) return withObservation(result(input, profile, "needs_input", [], ["EXACT_TARGET_REQUIRED"]), observation);
    if (expectedTarget(input.intent) && input.target!.kind !== expectedTarget(input.intent)) return withObservation(result(input, profile, "needs_input", [], ["TARGET_KIND_MISMATCH"]), observation);
    if (input.intent === "originate_loan" && input.target!.kind !== "borrower" && input.target!.kind !== "loan") return withObservation(result(input, profile, "needs_input", [], ["TARGET_KIND_MISMATCH"]), observation);
    if (observation.targetAvailable !== true) return withObservation(result(input, profile, "needs_input", [], [observation.targetAvailable === false ? "TARGET_UNAVAILABLE" : "TARGET_AVAILABILITY_REQUIRES_AUTHORITATIVE_READ"]), observation);
    if (observation.identityResolved !== true) return withObservation(result(input, profile, "needs_input", [], [observation.identityResolved === false ? "IDENTITY_REQUIRES_REVIEW" : "IDENTITY_REQUIRES_AUTHORITATIVE_READ"]), observation);
    if (input.intent === "cancel_payment_restore") {
        if (input.target!.kind !== "payment_intake") return withObservation(result(input, profile, "needs_input", [], ["TARGET_KIND_MISMATCH"]), observation);
        if (observation.state !== "mutable") return withObservation(result(input, profile, "blocked", [], ["RESTORE_DRAFT_MUST_BE_UNPOSTED"], ["payment.restore.cancel"]), observation);
        if (observation.restoreCancellationAllowed !== true) return withObservation(result(input, profile, "blocked", [], [observation.restoreCancellationBlockedReason ?? "RESTORE_CANCELLATION_NOT_ALLOWED"], ["payment.restore.cancel"]), observation);
        if (!observation.restoreCancellationStateHash) return withObservation(result(input, profile, "refresh_required", [], ["RESTORE_CANCELLATION_STATE_HASH_REQUIRED"]), observation);
        const cancel = step("payment.restore.cancel", input, ["reason", "idempotencyKey"], true);
        if (!cancel) return withObservation(result(input, profile, "connection_required", [], ["RESTORE_CANCELLATION_TOOL_UNAVAILABLE"]), observation);
        return withObservation(result(input, profile, "confirmation_required", [{
            ...cancel,
            arguments: { restoreDraftPublicId: input.target!.publicId, expectedStateHash: observation.restoreCancellationStateHash },
        }], [], ["payment.restore.execute", "payment.cancel"]), observation);
    }
    if (observation.state !== "mutable" && observation.state !== "posted" && observation.state !== "cancelled") return withObservation(result(input, profile, "needs_input", [], [observation.state === "unresolved" ? "TARGET_STATE_UNRESOLVED" : "TARGET_STATE_REQUIRES_AUTHORITATIVE_READ"]), observation);
    const attachments = input.attachments ?? "unknown";
    if (attachments === "unknown") return withObservation(result(input, profile, "needs_input", [], ["ATTACHMENT_AVAILABILITY_UNKNOWN"]), observation);
    if (input.expectedAttachmentCount !== undefined && (attachments !== "present" || !Number.isSafeInteger(input.expectedAttachmentCount) || input.expectedAttachmentCount < 1 || input.expectedAttachmentCount > 20)) return withObservation(result(input, profile, "needs_input", [], ["EXPECTED_ATTACHMENT_COUNT_REQUIRED"]), observation);
    if (input.intent === "inspect") {
        const inspectStep = input.target?.kind === "borrower" ? step("borrower.resolve-and-portfolio", input, []) : input.target?.kind === "loan" ? step("loan.inspect-context", input) : input.target?.kind === "payment_intake" ? step("intake.get", input) : null;
        const restoreCancelStep = input.target?.kind === "payment_intake" && observation.restoreCancellationAllowed === true
            ? step("payment.restore.cancel", input, ["reason", "idempotencyKey"], true)
            : null;
        const restoreCancelNextStep = restoreCancelStep && observation.restoreCancellationStateHash
            ? { ...restoreCancelStep, arguments: { restoreDraftPublicId: input.target!.publicId, expectedStateHash: observation.restoreCancellationStateHash } }
            : null;
        return withObservation(result(input, profile, restoreCancelNextStep ? "confirmation_required" : inspectStep ? "next_step" : "needs_input", [inspectStep, restoreCancelNextStep], inspectStep ? [] : ["TARGET_REQUIRES_PARENT_READ"]), observation);
    }
    if (input.target!.kind === "payment_intake" && observation.state === "cancelled" && input.intent === "receive_payment") {
        if (observation.duplicateReviewRequired === true) {
            const identityStep = observation.identityDecisionRequired ? identityDecisionStep(input, observation.duplicateBlockerPublicIds ?? []) : null;
            return withObservation(result(input, profile, "next_step", [identityStep ?? step("payment.replacement.duplicate-review.preview", input)], ["PAYMENT_DUPLICATE_REQUIRES_REVIEW"], ["payment.post", "payment.replacement.create"]), observation);
        }
        if (observation.evidenceRequired === true && observation.evidenceReady !== true) return withObservation(result(input, profile, "next_step", [step("payment.evidence-recovery.preview", input)], ["PAYMENT_REPLACEMENT_EVIDENCE_NOT_READY"], ["payment.post", "payment.replacement.create"]), observation);
        return withObservation(result(input, profile, "next_step", [step("payment.replacement.inspect", input)], ["CANCELLED_PAYMENT_REQUIRES_REPLACEMENT_INSPECTION"], ["payment.post", "evidence.prepare", "evidence.finalize"]), observation);
    }
    if (input.target!.kind === "payment_intake" && observation.state === "posted" && (input.intent === "receive_payment" || input.intent === "attach_evidence")) {
        const supplement = attachments === "present" ? step("payment.evidence-supplement.import-chatgpt-file", input, ["idempotencyKey", "chatgptFile"], true) : step("payment.evidence-supplement.record", input, undefined, true);
        return withObservation(result(input, profile, supplement ? "confirmation_required" : "connection_required", [supplement], ["POSTED_INTAKE_REQUIRES_SUPPLEMENT_WORKFLOW"]), observation);
    }
    if (attachments === "present" && rule.attachmentTransport === "human_review") {
        const blocker = input.intent === "close_loan" && observation.loanType === "floating" && observation.supportedAttachmentTransport === false
            ? "HUMAN_REVIEW_REQUIRED_FLOATING_ATTACHMENT_TRANSPORT"
            : "HUMAN_REVIEW_REQUIRED_UNSUPPORTED_ATTACHMENT_TRANSPORT";
        return withObservation(result(input, profile, "blocked", [], [blocker], ["payment.post", "loan.settlement.execute", "renewal.execute", "intermediary.remittance.post"]), observation);
    }
    if (input.intent === "close_loan" && observation.loanType === "floating" && attachments === "present" && observation.supportedAttachmentTransport === false) return withObservation(result(input, profile, "blocked", [], ["HUMAN_REVIEW_REQUIRED_FLOATING_ATTACHMENT_TRANSPORT"], ["loan.settlement.execute"]), observation);
    if (attachments === "present" && observation.supportedAttachmentTransport === false) return withObservation(result(input, profile, "blocked", [], ["HUMAN_REVIEW_REQUIRED_UNSUPPORTED_ATTACHMENT_TRANSPORT"], ["payment.post", "loan.settlement.execute", "renewal.execute", "intermediary.remittance.post"]), observation);
    if (observation.evidenceOverflow === true) return withObservation(result(input, profile, "blocked", [], ["EVIDENCE_SUMMARY_OVERFLOW_REQUIRES_REVIEW"], ["payment.post", "payment.batch.execute", "loan.activate", "loan.disbursement.post", "loan.settlement.execute", "renewal.execute"]), observation);
    if ((observation.pendingEvidenceCount ?? 0) > 0 || (observation.rejectedEvidenceCount ?? 0) > 0) return withObservation(result(input, profile, "blocked", [], ["EVIDENCE_REQUIRED_NOT_READY"], ["payment.post", "payment.batch.execute", "loan.activate", "loan.disbursement.post", "loan.settlement.execute", "renewal.execute"]), observation);
    if (attachments === "present") {
        const imported = attachmentStep(input);
        if (imported) return withObservation(result(input, profile, "next_step", [imported], observation.evidenceRequired === false ? ["EVIDENCE_DECLARATION_REQUIRED"] : []), observation);
    }
    if (observation.evidenceRequired === true && observation.evidenceReady !== true) return withObservation(result(input, profile, "blocked", [], ["EVIDENCE_REQUIRED_NOT_READY"], ["payment.post", "payment.batch.execute", "loan.activate", "loan.disbursement.post", "loan.settlement.execute", "renewal.execute"]), observation);
    if (input.intent === "close_loan") {
        if (observation.loanType === "floating") return withObservation(result(input, profile, "next_step", [step("loan.settlement.preview", input)]), observation);
        return withObservation(result(input, profile, "next_step", [step("loan.inspect-context", input)], ["SCHEDULED_CLOSEOUT_REQUIRES_SUPPORTED_PAYMENT_PATH"], ["loan.settlement.preview", "loan.settlement.execute"]), observation);
    }
    if (input.intent === "attach_evidence") return withObservation(result(input, profile, "next_step", [attachmentStep(input)], observation.evidenceRequired ? [] : ["EVIDENCE_DECLARATION_REQUIRED"]), observation);
    if (input.intent === "receive_payment") return withObservation(result(input, profile, "next_step", [step("payment.preview", input)], [], ["payment.post"]), observation);
    if (input.intent === "originate_loan") {
        if (input.target!.kind === "loan") {
            return withObservation(result(input, profile, "confirmation_required", [step("loan.inspect-context", input), step("loan.activate", input, ["idempotencyKey"], true)], ["EXISTING_LOAN_REQUIRES_CURRENT_INSPECTION"], ["loan.draft"]), observation);
        }
        return withObservation(result(input, profile, "next_step", [step("loan.preview", input), step("loan.draft", input)]), observation);
    }
    if (input.intent === "disburse_loan") {
        if (input.target?.kind === "loan") {
            const draft = step("loan.disbursement.draft", input);
            return withObservation(result(input, profile, draft ? "next_step" : "needs_input", [draft], draft ? [] : ["DISBURSEMENT_DRAFT_REQUIRED"], ["loan.disbursement.post"]), observation);
        }
        if (input.target?.kind === "loan_disbursement" && attachments === "none") {
            const post = step("loan.disbursement.post", input, ["idempotencyKey"], true);
            return withObservation(result(input, profile, post ? "confirmation_required" : "needs_input", [post], post ? [] : ["DISBURSEMENT_POST_REQUIRES_EXACT_TARGET"], ["loan.disbursement.evidence.prepare"]), observation);
        }
        const imported = step("loan.disbursement.evidence.import-chatgpt-file", input);
        return withObservation(result(input, profile, imported ? "next_step" : "needs_input", [imported], imported ? [] : ["DISBURSEMENT_EVIDENCE_REQUIRED"], ["loan.disbursement.post"]), observation);
    }
    if (input.intent === "renew_loan") return withObservation(result(input, profile, "next_step", [step("renewal.preview", input)], [], ["renewal.execute"]), observation);
    if (input.intent === "intermediary_collection") return withObservation(result(input, profile, "next_step", [step("intermediary.collection.list", input)]), observation);
    return base();
}
