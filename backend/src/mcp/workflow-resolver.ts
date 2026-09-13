import { MCP_TOOL_NAMES, type ToolProfile } from "./catalog-types";
import { toolIsVisibleInProfile, workflowRule, WORKFLOW_POLICY_REVISION, WORKFLOW_VERSION, type WorkflowIntent } from "./workflow-registry";

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
    state?: "unresolved" | "mutable" | "posted";
    loanType?: "scheduled" | "floating";
    evidenceRequired?: boolean;
    evidenceReady?: boolean;
    pendingEvidenceCount?: number;
    rejectedEvidenceCount?: number;
    supportedAttachmentTransport?: boolean;
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
    observed: Readonly<{ state: ResolverObservation["state"] | null; loanType: ResolverObservation["loanType"] | null; evidenceReady: boolean }>;
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
    "payment.preview": "payment_intake", "payment.post": "payment_intake", "evidence.prepare": "payment_intake", "evidence.finalize": "payment_intake", "evidence.import-chatgpt-file": "payment_intake",
    "payment.evidence-supplement.import-chatgpt-file": "payment_intake", "payment.evidence-supplement.record": "payment_intake", "loan.disbursement.list": "loan_for_disbursement",
    "loan.disbursement.draft": "loan", "loan.disbursement.evidence.prepare": "loan_disbursement", "loan.disbursement.evidence.finalize": "loan_disbursement", "loan.disbursement.evidence.import-chatgpt-file": "loan_disbursement",
    "loan.disbursement.post": "loan_disbursement", "loan.settlement.preview": "loan", "loan.activate": "loan", "loan.draft": "borrower", "renewal.preview": "loan",
});

const requiredInputs: Readonly<Record<string, readonly string[]>> = Object.freeze({
    "evidence.prepare": ["mimeType", "size", "sha256"], "evidence.finalize": ["evidencePublicId"], "evidence.import-chatgpt-file": ["idempotencyKey", "chatgptFile"],
    "payment.evidence-supplement.import-chatgpt-file": ["idempotencyKey", "chatgptFile"], "payment.evidence-supplement.record": ["supplementPublicId", "confirmed", "reason", "idempotencyKey"],
    "loan.disbursement.evidence.prepare": ["mimeType", "size", "sha256"], "loan.disbursement.evidence.finalize": ["evidencePublicId"], "loan.disbursement.evidence.import-chatgpt-file": ["idempotencyKey", "chatgptFile"],
    "loan.disbursement.draft": ["grossAmount", "loanAttributedAmount", "channel", "disbursedAt"], "loan.preview": ["principal", "interestRate", "termMonths", "repaymentType", "startDate"],
    "loan.draft": ["principal", "interestRate", "termMonths", "repaymentType", "startDate"], "loan.activate": ["idempotencyKey"], "loan.settlement.preview": ["asOfDate"], "renewal.preview": ["requestedPrincipal"],
});

const financialTools = new Set([
    "intake.create", "evidence.prepare", "evidence.finalize", "evidence.import-chatgpt-file", "payment.preview", "payment.post", "loan.preview", "loan.draft", "loan.activate",
    "loan.disbursement.draft", "loan.disbursement.evidence.prepare", "loan.disbursement.evidence.finalize", "loan.disbursement.evidence.import-chatgpt-file", "loan.disbursement.post",
    "loan.settlement.preview", "loan.settlement.execute", "renewal.preview", "renewal.execute", "intermediary.collection.create", "intermediary.remittance.preview", "intermediary.remittance.post",
]);

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
        else arguments_[`${targetKind === "payment_intake" ? "paymentIntake" : targetKind === "loan_disbursement" ? "disbursement" : targetKind}PublicId`] = input.target.publicId;
    }
    return { toolName, arguments: arguments_, requiredInputs: inputs, requiresConfirmation };
}

function result(input: ResolverInput, profile: ResolverProfile, status: ResolverResult["status"], nextSteps: readonly (ResolverStep | null)[], blockers: readonly string[] = [], prohibitedTools: readonly string[] = []): ResolverResult {
    return {
        workflowId: `creditsync.${input.intent}`, workflowVersion: WORKFLOW_VERSION, catalogVersion: profile.catalogVersion, policyRevision: WORKFLOW_POLICY_REVISION,
        observed: { state: null, loanType: null, evidenceReady: false }, status, nextSteps: nextSteps.filter((value): value is ResolverStep => value !== null).slice(0, 3), blockers: blockers.slice(0, 8), prohibitedTools: prohibitedTools.slice(0, 8),
        reevaluateOn: input.intent === "tool_help" ? "version_change" : input.attachments && input.attachments !== "none" ? "evidence_change" : "target_change",
    };
}

function withObservation(value: ResolverResult, observation: ResolverObservation): ResolverResult {
    return { ...value, observed: { state: observation.state ?? null, loanType: observation.loanType ?? null, evidenceReady: observation.evidenceReady === true } };
}

function validTarget(input: ResolverInput) {
    return !!input.target && publicIdPattern.test(input.target.publicId) && ["borrower", "loan", "payment_intake", "loan_disbursement"].includes(input.target.kind);
}

function expectedTarget(intent: WorkflowIntent): WorkflowTargetKind | null {
    if (["receive_payment", "attach_evidence"].includes(intent)) return "payment_intake";
    if (["close_loan", "originate_loan", "renew_loan"].includes(intent)) return "loan";
    return intent === "disburse_loan" ? "loan_disbursement" : null;
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
        if (financialTools.has(input.toolName)) return withObservation(result(input, profile, "needs_input", [], ["TOOL_HELP_REQUIRES_WORKFLOW_RESOLUTION"], [input.toolName]), observation);
        return withObservation(result(input, profile, "next_step", [step(input.toolName, input, requiredInputs[input.toolName] ?? ["toolArguments"])]), observation);
    }
    const rule = workflowRule(input.intent);
    if (!rule.profiles.includes(profile.profile)) return withObservation(result(input, profile, "connection_required", [], ["WORKFLOW_REQUIRES_ANOTHER_CONNECTION"]), observation);
    if (!validTarget(input)) return withObservation(result(input, profile, "needs_input", [], ["EXACT_TARGET_REQUIRED"]), observation);
    if (expectedTarget(input.intent) && input.target!.kind !== expectedTarget(input.intent)) return withObservation(result(input, profile, "needs_input", [], ["TARGET_KIND_MISMATCH"]), observation);
    if (observation.targetAvailable === false) return withObservation(result(input, profile, "needs_input", [], ["TARGET_UNAVAILABLE"]), observation);
    if (observation.identityResolved === false) return withObservation(result(input, profile, "needs_input", [], ["IDENTITY_REQUIRES_REVIEW"]), observation);
    const attachments = input.attachments ?? "unknown";
    if (attachments === "unknown") return withObservation(result(input, profile, "needs_input", [], ["ATTACHMENT_AVAILABILITY_UNKNOWN"]), observation);
    if (input.expectedAttachmentCount !== undefined && (attachments !== "present" || !Number.isSafeInteger(input.expectedAttachmentCount) || input.expectedAttachmentCount < 1 || input.expectedAttachmentCount > 20)) return withObservation(result(input, profile, "needs_input", [], ["EXPECTED_ATTACHMENT_COUNT_REQUIRED"]), observation);
    if (input.intent === "inspect") {
        const inspectStep = input.target?.kind === "borrower" ? step("borrower.resolve-and-portfolio", input) : input.target?.kind === "loan" ? step("loan.inspect-context", input) : input.target?.kind === "payment_intake" ? step("intake.get", input) : null;
        return withObservation(result(input, profile, inspectStep ? "next_step" : "needs_input", [inspectStep], inspectStep ? [] : ["TARGET_REQUIRES_PARENT_READ"]), observation);
    }
    if (input.target!.kind === "payment_intake" && observation.state === "posted" && (input.intent === "receive_payment" || input.intent === "attach_evidence")) {
        const supplement = attachments === "present" ? step("payment.evidence-supplement.import-chatgpt-file", input, ["idempotencyKey", "chatgptFile"], true) : step("payment.evidence-supplement.record", input, undefined, true);
        return withObservation(result(input, profile, supplement ? "confirmation_required" : "connection_required", [supplement], ["POSTED_INTAKE_REQUIRES_SUPPLEMENT_WORKFLOW"]), observation);
    }
    if (input.intent === "close_loan" && observation.loanType === "floating" && attachments === "present" && observation.supportedAttachmentTransport === false) return withObservation(result(input, profile, "blocked", [], ["HUMAN_REVIEW_REQUIRED_FLOATING_ATTACHMENT_TRANSPORT"], ["loan.settlement.execute"]), observation);
    if (attachments === "present" && observation.supportedAttachmentTransport === false) return withObservation(result(input, profile, "blocked", [], ["HUMAN_REVIEW_REQUIRED_UNSUPPORTED_ATTACHMENT_TRANSPORT"], ["payment.post", "loan.settlement.execute", "renewal.execute", "intermediary.remittance.post"]), observation);
    if ((observation.pendingEvidenceCount ?? 0) > 0 || (observation.rejectedEvidenceCount ?? 0) > 0) return withObservation(result(input, profile, "blocked", [], ["EVIDENCE_REQUIRED_NOT_READY"], ["payment.post", "payment.batch.execute", "loan.activate", "loan.disbursement.post", "loan.settlement.execute", "renewal.execute"]), observation);
    if (attachments === "present") {
        const imported = attachmentStep(input);
        if (imported) return withObservation(result(input, profile, "next_step", [imported], observation.evidenceRequired === false ? ["EVIDENCE_DECLARATION_REQUIRED"] : []), observation);
    }
    if (observation.evidenceRequired === true && observation.evidenceReady !== true) return withObservation(result(input, profile, "blocked", [], ["EVIDENCE_REQUIRED_NOT_READY"], ["payment.post", "payment.batch.execute", "loan.activate", "loan.disbursement.post", "loan.settlement.execute", "renewal.execute"]), observation);
    if (input.intent === "close_loan") return withObservation(result(input, profile, "next_step", [step("loan.settlement.preview", input)]), observation);
    if (input.intent === "attach_evidence") return withObservation(result(input, profile, "next_step", [attachmentStep(input)], observation.evidenceRequired ? [] : ["EVIDENCE_DECLARATION_REQUIRED"]), observation);
    if (input.intent === "receive_payment") return withObservation(result(input, profile, "next_step", [step("payment.preview", input)], [], ["payment.post"]), observation);
    if (input.intent === "originate_loan") return withObservation(result(input, profile, "next_step", [step("loan.preview", input), step("loan.draft", input)]), observation);
    if (input.intent === "disburse_loan") {
        const draft = input.target?.kind === "loan" ? step("loan.disbursement.draft", input) : step("loan.disbursement.evidence.prepare", input);
        return withObservation(result(input, profile, draft ? "next_step" : "needs_input", [draft], draft ? [] : ["DISBURSEMENT_DRAFT_REQUIRED"], ["loan.disbursement.post"]), observation);
    }
    if (input.intent === "renew_loan") return withObservation(result(input, profile, "next_step", [step("renewal.preview", input)], [], ["renewal.execute"]), observation);
    if (input.intent === "intermediary_collection") return withObservation(result(input, profile, "next_step", [step("intermediary.collection.list", input)]), observation);
    return base();
}
